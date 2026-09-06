import * as fs from "node:fs/promises";
import * as crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { SourceResolver, type InspectionSources } from "./source-resolver.js";
import type { BrowserSession, InteractionInspectionResult, TargetIdentityBaseline } from "../types.js";

export interface WorkspaceRevision {
  head: string | null;
  fingerprint: string;
  files: Array<{ file: string; hash: string | null; modifiedMs: number | null }>;
  complete: boolean;
}
export interface InspectionBaseline {
  session: BrowserSession;
  sources: InspectionSources;
  revision: WorkspaceRevision;
  anchor: { u: number; v: number } | null;
}
const run = promisify(execFile);
export class WorkspaceObserver {
  private readonly resolver: SourceResolver;
  constructor(workspace: string) { this.resolver = new SourceResolver(workspace); }
  async capture(relevant?: string[]): Promise<WorkspaceRevision> {
    const root = await this.resolver.root;
    let head: string | null = null;
    try { head = (await run("git", ["rev-parse", "HEAD"], { cwd: root, timeout: 1000, windowsHide: true })).stdout.trim(); } catch {}
    let complete = true, bytes = 0;
    const files: WorkspaceRevision["files"] = [];
    let selected: string[];
    try { selected = relevant?.length ? relevant : await this.resolver.sourceFiles(); }
    catch { selected = []; complete = false; }
    if (!relevant?.length && !this.resolver.isIndexComplete) complete = false;
    if (selected.length > 200) complete = false;
    for (const input of [...new Set(selected)].sort().slice(0, 200)) {
      const absolute = await this.resolver.localFile(input);
      if (!absolute) { files.push({ file: input, hash: null, modifiedMs: null }); continue; }
      const file = (await this.resolver.reference(absolute, "workspace", "runtime-derived")).file;
      try {
        const stat = await fs.stat(absolute);
        if (stat.size > 512 * 1024 || bytes + stat.size > 8 * 1024 * 1024) { complete = false; continue; }
        bytes += stat.size;
        const hash = crypto.createHash("sha256").update(await fs.readFile(absolute)).digest("hex");
        files.push({ file, hash, modifiedMs: stat.mtimeMs });
      } catch { complete = false; }
    }
    const fingerprint = crypto.createHash("sha256").update(JSON.stringify(files.map(({ file, hash }) => [file, hash]))).digest("hex");
    return { head, fingerprint, files, complete };
  }
  async baseline(result: InteractionInspectionResult, session: BrowserSession, sources: InspectionSources): Promise<InspectionBaseline> {
    const relevant = [...sources.target.references, ...sources.primaryBlocker.references, ...sources.ancestors, ...sources.css].map(r => r.file);
    const rect = result.target.interactionTarget.rect;
    const u = (result.pointer.clientX - rect.left) / rect.width, v = (result.pointer.clientY - rect.top) / rect.height;
    const anchor = [u, v].every(Number.isFinite) && u >= 0 && u <= 1 && v >= 0 && v <= 1 ? { u, v } : null;
    return { session, sources, revision: await this.capture(relevant), anchor };
  }
}
/** Only browser-visible changes count. Capture IDs and timestamps do not. */
export function runtimeSignature(result: InteractionInspectionResult): string {
  return JSON.stringify({ target: result.target.interactionTarget, computed: result.target.computed,
    state: result.target.state, surface: result.interactionSurface,
    blockers: result.blockers.map(b => ({ node: b.node, computed: b.computed })) });
}
export function runtimeChanged(baseline: InteractionInspectionResult, current: InteractionInspectionResult): boolean {
  return Boolean(baseline.runtime && current.runtime && (baseline.runtime.documentId !== current.runtime.documentId || current.runtime.revision > baseline.runtime.revision)) ||
    runtimeSignature(baseline) !== runtimeSignature(current);
}
export function targetIdentity(result: InteractionInspectionResult): TargetIdentityBaseline {
  return { node: result.target.interactionTarget, pointer: result.pointer,
    ...(result.primaryBlocker ? { blocker: result.primaryBlocker.node } : {}),
    ...(result.target.react ? { react: result.target.react } : {}),
    ...(result.runtime ? { documentId: result.runtime.documentId } : {}),
    ...(result.runtimeTargetId ? { runtimeTargetId: result.runtimeTargetId } : {}) };
}
