import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AnyMap, originalPositionFor, type SectionedSourceMapInput } from "@jridgewell/trace-mapping";
import type { CssDeclarationCandidate, InteractionInspectionResult, ReactRuntimeMetadata, ReactSourceHint, RuntimeNodeDescriptor } from "../types.js";

export interface SourceReference {
  file: string; line?: number; column?: number;
  scope: string;
  certainty: "exact" | "runtime-derived" | "symbolicated" | "heuristic";
  property?: string;
}
export interface SourceResolution {
  status: "MAPPED" | "UNMAPPED";
  references: SourceReference[];
  reason?: string;
}
export interface InspectionSources {
  target: SourceResolution;
  primaryBlocker: SourceResolution;
  ancestors: SourceReference[];
  css: SourceReference[];
}
const unmapped = (reason = "No supported local source evidence."): SourceResolution => ({ status: "UNMAPPED", references: [], reason });
const mapped = (reference: SourceReference): SourceResolution => ({ status: "MAPPED", references: [reference] });
const MAX_ASSET = 2 * 1024 * 1024;
const SOURCE_EXT = /\.(?:[cm]?[jt]sx?|css|scss|sass|less|html)$/i;
const OMIT_DIRS = new Set(["node_modules", "dist", "build", "coverage", "test-results", "playwright-report", "vendor"]);
const inside = (root: string, file: string): boolean => {
  const rel = path.relative(root, file);
  return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
};
const escapeRegExp = (v: string): string => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function boundedSourceMap(value: unknown, depth = 0, budget = { maps: 0, sources: 0 }): boolean {
  if (!value || typeof value !== "object" || depth > 4 || ++budget.maps > 32) return false;
  const map = value as Record<string, unknown>;
  if (map.version !== 3) return false;
  if (Array.isArray(map.sections)) return map.sections.length <= 32 && map.sections.every(section =>
    section && typeof section === "object" && !section.url && boundedSourceMap(section.map, depth + 1, budget));
  if (!Array.isArray(map.sources) || typeof map.mappings !== "string" || map.mappings.length > MAX_ASSET) return false;
  budget.sources += map.sources.length;
  return budget.sources <= 4096 && map.sources.every(source => typeof source === "string" && source.length <= 4096);
}

/** All runtime paths, including source-map sources, pass both lexical and realpath checks. */
export class SourceResolver {
  readonly root: Promise<string>;
  private readonly workspacePath: string;
  private readonly assets = new Map<string, Promise<{ body: string; url: string } | undefined>>();
  private indexComplete = true;
  private deadline = Infinity;
  get isIndexComplete(): boolean { return this.indexComplete; }
  constructor(workspace: string) {
    this.workspacePath = path.resolve(workspace);
    this.root = fs.realpath(this.workspacePath);
  }
  async localFile(input: string, relativeTo?: string): Promise<string | undefined> {
    try {
      if (!input || input.length > 4096 || /[\u0000-\u001f]/.test(input)) return undefined;
      let value = decodeURIComponent(input.split(/[?#]/, 1)[0]!).replace(/\\/g, "/");
      const root = await this.root;
      if (value.startsWith("file://")) value = fileURLToPath(value);
      else if (/^https?:\/\//.test(value)) {
        const url = new URL(value);
        if (url.username || url.password) return undefined;
        value = decodeURIComponent(url.pathname);
        if (value.startsWith("/@fs/")) value = value.slice(5);
        else value = value.replace(/^\/+/, "");
      } else if (/^(?:webpack(?:-internal)?|turbopack|vite):\/\//.test(value)) {
        value = value.replace(/^[^:]+:\/\/[^/]*\//, "").replace(/^\/+/, "")
          .replace(/^\((?:app-pages-browser|rsc|ssr)\)\//, "").replace(/^\[project\]\//, "").replace(/^\.\//, "");
      } else if (value.startsWith("/@fs/")) value = value.slice(5);
      if (/^[a-z]+:/i.test(value) && !/^[a-z]:[\\/]/i.test(value)) return undefined;
      // Runtime paths are not allowed to use traversal, even if normalization could land inside.
      if (value.split(/[\\/]/).includes("..")) return undefined;
      const file = path.resolve(relativeTo ?? root, value);
      // A configured workspace may use a junction or Windows short-name alias.
      // Admit that lexical spelling too, then require the canonical destination
      // to remain inside the canonical workspace before any file content read.
      if (!inside(root, file) && !inside(this.workspacePath, file)) return undefined;
      const real = await fs.realpath(file);
      if (!inside(root, real) || !(await fs.stat(real)).isFile()) return undefined;
      return real;
    } catch { return undefined; }
  }
  async reference(file: string, scope: string, certainty: SourceReference["certainty"], line?: number, column?: number): Promise<SourceReference> {
    const ref: SourceReference = { file: path.relative(await this.root, file).split(path.sep).join("/"), scope, certainty };
    if (line !== undefined && Number.isSafeInteger(line) && line > 0) ref.line = line;
    if (column !== undefined && Number.isSafeInteger(column) && column >= 0) ref.column = column;
    return ref;
  }
  /** Source assets only, never general URLs. No credentials, cookies, redirects, query, or remote hosts. */
  private asset(input: string, pageUrl?: string): Promise<{ body: string; url: string } | undefined> {
    const key = `${pageUrl ?? ""}\n${input}`;
    if (!this.assets.has(key)) {
      if (this.assets.size >= 16) this.assets.delete(this.assets.keys().next().value!);
      this.assets.set(key, this.readAsset(input, pageUrl));
    }
    return this.assets.get(key)!;
  }
  private async readAsset(input: string, pageUrl?: string): Promise<{ body: string; url: string } | undefined> {
    if (Date.now() >= this.deadline) return undefined;
    const file = await this.localFile(input);
    if (file) {
      const stat = await fs.stat(file);
      if (stat.size > MAX_ASSET || !/\.(?:[cm]?[jt]sx?|css|map)$/i.test(file)) return undefined;
      return { body: await fs.readFile(file, "utf8"), url: pathToFileURL(file).href };
    }
    try {
      const url = new URL(input), page = new URL(pageUrl ?? "");
      if (url.origin !== page.origin || !["http:", "https:"].includes(url.protocol) ||
          !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username || url.password ||
          !/\.(?:[cm]?[jt]sx?|css|map)$/i.test(url.pathname)) return undefined;
      url.search = ""; url.hash = "";
      // Avoid DNS resolution for the localhost alias.
      if (url.hostname === "localhost") url.hostname = "127.0.0.1";
      const response = await fetch(url, { redirect: "error", credentials: "omit", signal: AbortSignal.timeout(Math.max(1, Math.min(1200, this.deadline - Date.now()))) });
      if (!response.ok || Number(response.headers.get("content-length")) > MAX_ASSET || !response.body) { await response.body?.cancel(); return undefined; }
      const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
      try {
        while (true) {
          const chunk = await reader.read(); if (chunk.done) break;
          length += chunk.value.length;
          if (length > MAX_ASSET) { await reader.cancel(); return undefined; }
          chunks.push(chunk.value);
        }
      } finally { reader.releaseLock(); }
      return { body: Buffer.concat(chunks).toString("utf8"), url: input.split(/[?#]/, 1)[0]! };
    } catch { return undefined; }
  }
  async symbolicate(file: string, line: number, column: number, pageUrl?: string, scope = "component-owner"): Promise<SourceResolution> {
    try {
      const generated = await this.asset(file, pageUrl);
      if (!generated) return unmapped("Generated asset is unavailable or outside the allowed local origin.");
      const links = [...generated.body.matchAll(/[#@]\s*sourceMappingURL=([^\s*]+)/g)];
      const link = links.at(-1)?.[1];
      if (!link) return unmapped("Source map is missing.");
      let mapBody: string, mapUrl = generated.url;
      if (/^data:application\/json(?:;charset=[^;,]+)?;base64,/.test(link)) {
        mapBody = Buffer.from(link.slice(link.indexOf(",") + 1), "base64").toString("utf8");
      } else {
        mapUrl = new URL(link, generated.url).href;
        const map = await this.asset(mapUrl, pageUrl); if (!map) return unmapped("Source map is unavailable or disallowed.");
        mapBody = map.body;
      }
      if (mapBody.length > MAX_ASSET) return unmapped("Source map exceeds the size bound.");
      const parsed = JSON.parse(mapBody) as Record<string, unknown>;
      if (!boundedSourceMap(parsed)) return unmapped("Source map structure or resource bound exceeded.");
      const map = AnyMap(parsed as unknown as SectionedSourceMapInput, mapUrl);
      if (map.sources.length > 4096) return unmapped("Source map source bound exceeded.");
      const original = originalPositionFor(map, { line, column: Math.max(0, column - 1) });
      if (!original.source || original.line === null || original.column === null) return unmapped("No mapping exists at the generated frame.");
      // Maps may legitimately contain ../ relative to a generated file. Resolve those
      // with URL semantics first, then enforce workspace containment on the result.
      const local = await this.localFile(original.source);
      if (!local || !SOURCE_EXT.test(local) || local.split(path.sep).includes("node_modules")) return unmapped("Mapped source is absent or outside the workspace.");
      return mapped(await this.reference(local, scope, "symbolicated", original.line, original.column + 1));
    } catch { return unmapped("Source map could not be decoded safely."); }
  }
  async resolveHint(hint: ReactSourceHint, pageUrl?: string): Promise<SourceResolution> {
    if (!hint.file) return unmapped();
    if (hint.certainty === "symbolication-needed" && hint.line) {
      const result = await this.symbolicate(hint.file, hint.line, hint.column ?? 1, pageUrl, hint.scope);
      if (result.status === "MAPPED") return result;
      // A virtual original-source path identifies a file, but generated line numbers do not identify source lines.
      if (!/^(?:webpack(?:-internal)?|turbopack|vite):\/\//.test(hint.file)) return result;
      const file = await this.localFile(hint.file);
      return file ? mapped(await this.reference(file, hint.scope, "runtime-derived")) : result;
    }
    const file = await this.localFile(hint.file);
    if (!file || !SOURCE_EXT.test(file) || file.split(path.sep).includes("node_modules")) return unmapped();
    return mapped(await this.reference(file, hint.scope, hint.certainty === "heuristic" ? "heuristic" : "runtime-derived", hint.line, hint.column));
  }
  /** A bounded source index, rebuilt per diagnosis so edits cannot leave stale matches. */
  async sourceFiles(): Promise<string[]> {
    const root = await this.root, result: string[] = [], queue = [root]; let examined = 0;
    while (queue.length && examined < 2000 && result.length < 200 && Date.now() < this.deadline) {
      const dir = queue.shift()!;
      const entries = [];
      for await (const entry of await fs.opendir(dir)) {
        entries.push(entry);
        if (entries.length + examined >= 2000 || Date.now() >= this.deadline) break;
      }
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (++examined >= 2000 || result.length >= 200) break;
        if (entry.name.startsWith(".") || OMIT_DIRS.has(entry.name) || entry.isSymbolicLink()) continue;
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) queue.push(file);
        else if (entry.isFile() && SOURCE_EXT.test(entry.name)) result.push(file);
      }
    }
    this.indexComplete = !queue.length && examined < 2000 && result.length < 200 && Date.now() < this.deadline;
    return result;
  }
  private async correlate(node: RuntimeNodeDescriptor, react?: ReactRuntimeMetadata): Promise<SourceResolution> {
    const candidates: SourceReference[] = []; let bytes = 0;
    const patterns: RegExp[] = [];
    if (node.id) patterns.push(new RegExp(`\\bid\\s*=\\s*["']${escapeRegExp(node.id)}["']`, "g"));
    if (react?.componentName) patterns.push(new RegExp(`\\b(?:function|class|const)\\s+${escapeRegExp(react.componentName)}\\b`, "g"));
    if (!patterns.length && node.classes?.length) patterns.push(new RegExp(`\\bclass(?:Name)?\\s*=\\s*["'][^"']*\\b${escapeRegExp(node.classes[0]!)}(?=[\\s"'])`, "g"));
    if (!patterns.length) return unmapped();
    const files = await this.sourceFiles();
    if (!this.indexComplete) return unmapped("Source index bound exceeded; uniqueness cannot be established.");
    for (const file of files) {
      const stat = await fs.stat(file);
      if (Date.now() >= this.deadline || stat.size > 512 * 1024 || bytes + stat.size > 8 * MAX_ASSET) return unmapped("Source scan bound exceeded; uniqueness cannot be established.");
      bytes += stat.size; const body = await fs.readFile(file, "utf8");
      const offsets = new Set<number>();
      // Prefer the explicit id over a component-name fallback within a file.
      for (const pattern of patterns) {
        for (const match of body.matchAll(pattern)) { offsets.add(match.index); if (offsets.size > 1) break; }
        if (offsets.size) break;
      }
      for (const offset of offsets) {
        const before = body.slice(0, offset); candidates.push(await this.reference(file, "static-correlation", "heuristic", before.split("\n").length, offset - before.lastIndexOf("\n")));
      }
      if (candidates.length > 1) return unmapped("Static source correlation is ambiguous.");
    }
    return candidates[0] ? mapped(candidates[0]) : unmapped();
  }
  async resolveNode(node: RuntimeNodeDescriptor, react?: ReactRuntimeMetadata, pageUrl?: string): Promise<SourceResolution> {
    this.assets.clear();
    const hints = [...(react?.source ? [react.source] : []), ...(react?.sources ?? [])].slice(0, 9);
    hints.sort((a, b) => Number(a.certainty === "symbolication-needed") - Number(b.certainty === "symbolication-needed"));
    for (const hint of hints) {
      const result = await this.resolveHint(hint, pageUrl); if (result.status === "MAPPED") return result;
    }
    return this.correlate(node, react);
  }
  async resolveCss(candidate: CssDeclarationCandidate, pageUrl?: string): Promise<SourceResolution> {
    if (!candidate.stylesheet) return unmapped("Inline declaration has no independent stylesheet source.");
    const asset = await this.asset(candidate.stylesheet, pageUrl);
    if (!asset) return unmapped();
    const selector = candidate.selector.trim();
    const offset = asset.body.indexOf(selector);
    if (offset < 0 || asset.body.indexOf(selector, offset + selector.length) >= 0) return unmapped("CSS selector location is ambiguous.");
    const end = asset.body.indexOf("}", offset), property = asset.body.indexOf(`${candidate.property}:`, offset);
    if (property < 0 || end < property) return unmapped();
    const before = asset.body.slice(0, property), line = before.split("\n").length, column = property - before.lastIndexOf("\n");
    let result = await this.symbolicate(candidate.stylesheet, line, column, pageUrl, "css-declaration-candidate");
    if (result.status === "UNMAPPED") {
      const local = await this.localFile(candidate.stylesheet);
      if (local) result = mapped(await this.reference(local, "css-declaration-candidate", "runtime-derived", line, column));
    }
    for (const reference of result.references) reference.property = candidate.property;
    return result;
  }
  async inspect(result: InteractionInspectionResult, pageUrl?: string): Promise<InspectionSources> {
    this.deadline = Date.now() + 3000;
    this.assets.clear();
    try { return await this.inspectSources(result, pageUrl); }
    catch { return { target: unmapped("Local source lookup is unavailable."), primaryBlocker: unmapped("Local source lookup is unavailable."), ancestors: [], css: [] }; }
  }
  private async inspectSources(result: InteractionInspectionResult, pageUrl?: string): Promise<InspectionSources> {
    const target = await this.resolveNode(result.target.interactionTarget, result.target.react, pageUrl);
    const primaryBlocker = result.primaryBlocker ? await this.resolveNode(result.primaryBlocker.node, result.primaryBlocker.react, pageUrl) : unmapped("No primary blocker.");
    const ancestors: SourceReference[] = [], css: SourceReference[] = [];
    for (const ancestor of [...result.target.ancestors.slice(0, 3), ...(result.primaryBlocker?.ancestors.slice(0, 3) ?? [])]) {
      if (ancestor.react?.source) ancestors.push(...(await this.resolveHint(ancestor.react.source, pageUrl)).references);
    }
    for (const candidate of [...(result.primaryBlocker?.css ?? []), ...(result.target.css ?? [])].slice(0, 8)) {
      css.push(...(await this.resolveCss(candidate, pageUrl)).references);
    }
    return { target, primaryBlocker, ancestors: ancestors.slice(0, 6), css: css.slice(0, 8) };
  }
}
