import * as fs from "node:fs";
import * as path from "node:path";
import { build } from "esbuild";

const rootDir = process.cwd();
const outDir = path.join(rootDir, "dist", "extension");

fs.mkdirSync(outDir, { recursive: true });

// Copy manifest.json
const manifestSrc = path.join(rootDir, "extension", "manifest.json");
const manifestDest = path.join(outDir, "manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestSrc, "utf8"));
const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8"));
if (manifest.version !== pkg.version) throw new Error("Extension and package versions must match.");
fs.copyFileSync(manifestSrc, manifestDest);
for (const file of ["popup.html", "popup.css"]) fs.copyFileSync(path.join(rootDir, "extension", file), path.join(outDir, file));

// Bundle service worker using esbuild
await build({
  entryPoints: [path.join(rootDir, "extension", "service-worker.ts"), path.join(rootDir, "extension", "popup.ts")],
  bundle: true,
  outdir: outDir,
  format: "esm",
  platform: "browser",
  target: "es2022",
  sourcemap: false,
  minify: false,
});

console.log("Extension successfully built to dist/extension/");
