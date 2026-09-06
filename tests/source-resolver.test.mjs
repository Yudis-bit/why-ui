import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { SourceResolver } from "../dist/daemon/source-resolver.js";
async function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "why-ui-resolver-"));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "Button.tsx"), '<button id="pay">Pay</button>\n');
  t.after(() => {
    const resolved = fs.realpathSync(root);
    assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir())); assert.ok(path.basename(resolved).startsWith("why-ui-resolver-"));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return { root, resolver: new SourceResolver(root) };
}
for (const input of ["src/Button.tsx", "webpack://app/./src/Button.tsx", "webpack-internal:///(app-pages-browser)/./src/Button.tsx", "turbopack:///[project]/src/Button.tsx", "http://127.0.0.1:5173/src/Button.tsx"]) {
  test(`resolves confined development path ${input}`, async t => {
    const { root, resolver } = await workspace(t);
    assert.equal(await resolver.localFile(input), await fs.promises.realpath(path.join(root, "src", "Button.tsx")));
  });
}
test("absolute and Vite fs paths require workspace containment", async t => {
  const { root, resolver } = await workspace(t);
  const file = path.join(root, "src", "Button.tsx");
  assert.equal(await resolver.localFile(file), await fs.promises.realpath(file));
  assert.equal(await resolver.localFile(`/@fs/${file}`), await fs.promises.realpath(file));
  for (const input of ["../outside.tsx", "src/../../outside.tsx", "%2e%2e/outside.tsx", "file:///etc/passwd", "https://user:pass@127.0.0.1/src/Button.tsx"]) assert.equal(await resolver.localFile(input), undefined);
});
test("symlink escape is rejected", async t => {
  const { root, resolver } = await workspace(t);
  const outside = await workspace(t);
  fs.symlinkSync(outside.root, path.join(root, "escape"), "junction");
  assert.equal(await resolver.localFile("escape/src/Button.tsx"), undefined);
});
test("a configured workspace alias resolves sources while retaining realpath confinement", async t => {
  const { root } = await workspace(t);
  const holder = await workspace(t), outside = await workspace(t);
  const alias = path.join(holder.root, "workspace-alias");
  fs.symlinkSync(root, alias, "junction");
  fs.symlinkSync(outside.root, path.join(root, "escape"), "junction");
  const resolver = new SourceResolver(alias);
  const expected = await fs.promises.realpath(path.join(root, "src", "Button.tsx"));
  assert.equal(await resolver.localFile(path.join(alias, "src", "Button.tsx")), expected);
  assert.equal(await resolver.localFile(`/@fs/${path.join(alias, "src", "Button.tsx")}`), expected);
  assert.equal(await resolver.localFile(path.join(alias, "escape", "src", "Button.tsx")), undefined);
  assert.equal(await resolver.localFile(path.join(outside.root, "src", "Button.tsx")), undefined);
});
test("inline source map symbolicates to an existing local source", async t => {
  const { root, resolver } = await workspace(t);
  const map = { version: 3, sources: ["src/Button.tsx"], names: [], mappings: "AAAA" };
  fs.writeFileSync(path.join(root, "app.js"), `button();\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify(map)).toString("base64")}`);
  const result = await resolver.symbolicate(path.join(root, "app.js"), 1, 1);
  assert.equal(result.status, "MAPPED"); assert.deepEqual(result.references[0], { file: "src/Button.tsx", line: 1, column: 1, scope: "component-owner", certainty: "symbolicated" });
});
test("malicious map sources and missing maps are UNMAPPED", async t => {
  const { root, resolver } = await workspace(t);
  fs.writeFileSync(path.join(root, "app.js"), "button();");
  assert.equal((await resolver.symbolicate(path.join(root, "app.js"), 1, 1)).status, "UNMAPPED");
  const map = { version: 3, sources: ["../../outside.tsx"], names: [], mappings: "AAAA" };
  fs.appendFileSync(path.join(root, "app.js"), `\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify(map)).toString("base64")}`);
  const escaped = await new SourceResolver(root).symbolicate(path.join(root, "app.js"), 1, 1);
  assert.equal(escaped.status, "UNMAPPED");
  assert.match(escaped.reason, /outside/);
  assert.equal((await resolver.symbolicate("http://169.254.169.254/latest.js", 1, 1, "http://169.254.169.254/")).status, "UNMAPPED");
});
test("static correlation is heuristic and ambiguous matches remain UNMAPPED", async t => {
  const { root, resolver } = await workspace(t);
  const node = { id: "pay", tagName: "button" };
  assert.equal((await resolver.resolveNode(node)).references[0].certainty, "heuristic");
  fs.writeFileSync(path.join(root, "src", "Other.tsx"), '<button id="pay">Pay</button>');
  assert.equal((await resolver.resolveNode(node)).status, "UNMAPPED");
  assert.equal((await resolver.resolveNode({ tagName: "div" })).status, "UNMAPPED");
});


test("source requests strip credentials data and reject redirects and foreign origins", async t => {
  const { resolver } = await workspace(t), requests = [];
  const map = JSON.stringify({ version:3, sources:["src/Button.tsx"], names:[], mappings:"AAAA" });
  const server = http.createServer((req, res) => {
    requests.push({ url:req.url, cookie:req.headers.cookie, authorization:req.headers.authorization });
    if (req.url === "/redirect.js") { res.writeHead(302, { Location:"/bundle.js" }); res.end(); }
    else res.end(req.url === "/bundle.js.map" ? map : "button();\n//# sourceMappingURL=bundle.js.map");
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await resolver.symbolicate(`${url}/bundle.js?token=PRIVATE_QUERY#private`, 1, 1, url)).status, "MAPPED");
  assert.deepEqual(requests, [{url:"/bundle.js",cookie:undefined,authorization:undefined},{url:"/bundle.js.map",cookie:undefined,authorization:undefined}]);
  assert.equal((await resolver.symbolicate(`${url}/redirect.js`, 1, 1, url)).status, "UNMAPPED"); assert.equal(requests.length, 3);
  assert.equal((await resolver.symbolicate(`${url}/foreign.js`, 1, 1, "http://127.0.0.1:1/")).status, "UNMAPPED"); assert.equal(requests.length, 3);
  assert.equal((await resolver.symbolicate(url.replace("http://", "http://user:pass@") + "/credentials.js", 1, 1, url)).status, "UNMAPPED"); assert.equal(requests.length, 3);
});
test("nested or excessive source maps degrade to UNMAPPED before decoding", async t => {
  const { root } = await workspace(t);
  let map = { version:3, sources:["src/Button.tsx"], names:[], mappings:"AAAA" };
  for (let i=0;i<8;i++) map = {version:3,sections:[{offset:{line:0,column:0},map}]};
  fs.writeFileSync(path.join(root, "nested.js"), `button();\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify(map)).toString("base64")}`);
  assert.equal((await new SourceResolver(root).symbolicate(path.join(root, "nested.js"), 1, 1)).status, "UNMAPPED");
});
test("a skipped large source cannot make static correlation falsely unique", async t => {
  const { root, resolver } = await workspace(t);
  fs.writeFileSync(path.join(root, "src/Huge.tsx"), " ".repeat(512*1024) + '<button id="pay">Duplicate</button>');
  assert.equal((await resolver.resolveNode({id:"pay",tagName:"button"})).status, "UNMAPPED");
});
test("the source index reports truncation instead of asserting uniqueness", async t => {
  const { root, resolver } = await workspace(t);
  for (let i=0;i<205;i++) fs.writeFileSync(path.join(root, "src", `file${i}.tsx`), "export {};");
  assert.equal((await resolver.sourceFiles()).length, 200); assert.equal(resolver.isIndexComplete, false);
  assert.equal((await resolver.resolveNode({id:"pay",tagName:"button"})).status, "UNMAPPED");
});
