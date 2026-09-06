import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { createRequire } from "node:module";
import { build } from "esbuild";
export async function sourceFixture({ react = "react19", sourceMap = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "why-ui-source-"));
  const sourceDir = path.join(root, "src"); const publicDir = path.join(root, "public");
  fs.mkdirSync(sourceDir); fs.mkdirSync(publicDir);
  const require = createRequire(new URL(`./browser/fixtures/${react}/package.json`, import.meta.url));
  const styles = `.payment { position:absolute; left:100px; top:100px; width:200px; height:100px; border:0; padding:0; border-radius:0; }
.backdrop { position:absolute; left:100px; top:100px; width:200px; height:100px; background:#888; z-index:10; }
.replacement { position:fixed; left:100px; top:100px; width:200px; height:100px; z-index:20; }`;
  function source(mode) { return `import * as React from "react";
import { createRoot } from "react-dom/client";
import styles from "./styles.module.css";
export function PaymentButton() {
  return <button id="payment" aria-label="Pay invoice" className={styles.payment}>Pay invoice</button>;
}
export function ModalBackdrop() {
  return <div id="backdrop" className={styles.backdrop} />;
}
export function NewBlocker() {
  return <div id="replacement" className={styles.replacement} />;
}
function App() {
  React.useLayoutEffect(() => { window.fixtureReady = ${JSON.stringify(mode)}; }, []);
  return <> <PaymentButton /> ${mode === "ambiguous" ? "<PaymentButton />" : ""} ${mode === "broken" ? "<ModalBackdrop />" : mode === "bad" ? "<NewBlocker />" : ""} </>;
}
createRoot(document.getElementById("root")).render(<App />);`; }
  const clients = new Set();
  async function patch(mode) {
    fs.writeFileSync(path.join(sourceDir, "Payment.jsx"), source(mode));
    fs.writeFileSync(path.join(sourceDir, "styles.module.css"), styles + (mode === "good" ? "\n.payment { left:350px; top:220px; width:240px; }" : ""));
    await build({ absWorkingDir: root, entryPoints: ["src/Payment.jsx"], outfile: "public/app.js", bundle: true,
      format: "iife", platform: "browser", target: "es2022", jsx: "automatic", jsxDev: true,
      alias: { "react": require.resolve("react"), "react/jsx-dev-runtime": require.resolve("react/jsx-dev-runtime"), "react-dom/client": require.resolve("react-dom/client") },
      define: { "process.env.NODE_ENV": '"development"' }, sourcemap: sourceMap ? "linked" : false, logLevel: "silent" });
    for (const response of clients) response.write("data: reload\n\n");
  }
  await patch("broken");
  const server = http.createServer((request, response) => {
    if (request.url === "/events") {
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" }); response.write(": ready\n\n");
      clients.add(response); request.on("close", () => clients.delete(response)); return;
    }
    const name = (request.url ?? "/").split("?")[0].slice(1);
    if (!name) {
      response.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
      response.end('<!doctype html><html><head><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script src="/app.js"></script><script>new EventSource("/events").onmessage=()=>location.reload()</script></body></html>'); return;
    }
    if (!["app.js", "app.js.map", "app.css", "app.css.map"].includes(name) || !fs.existsSync(path.join(publicDir, name))) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { "content-type": name.endsWith(".css") ? "text/css" : name.endsWith(".map") ? "application/json" : "text/javascript", "cache-control": "no-store" });
    response.end(fs.readFileSync(path.join(publicDir, name)));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return { root, patch, url: `http://127.0.0.1:${server.address().port}/`, async close() {
    for (const response of clients) response.end(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    const resolved = fs.realpathSync(root);
    if (path.dirname(resolved) !== fs.realpathSync(os.tmpdir()) || !path.basename(resolved).startsWith("why-ui-source-")) throw new Error("Unsafe fixture cleanup");
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } };
}
