import { test } from "node:test";
import assert from "node:assert/strict";
import { contextTriggers } from "../dist/daemon/causality.js";
test("all simultaneous supported context triggers are retained", () => {
  const computed = { position:"fixed", "z-index":"10", opacity:"0.99", transform:"matrix(1,0,0,1,0,0)", filter:"blur(0px)", perspective:"500px", isolation:"isolate", contain:"paint layout", "will-change":"transform, opacity", "mix-blend-mode":"multiply", "clip-path":"inset(0px)" };
  const triggers = contextTriggers({ node: { tagName: "div" }, computed });
  assert.deepEqual(triggers.map(t => t.property), ["position", "z-index", "opacity", "transform", "filter", "perspective", "clip-path", "isolation", "contain", "mix-blend-mode", "will-change"]);
});
test("static z-index needs a flex or grid parent", () => {
  const item = { node: { tagName:"div" }, computed: { position:"static", "z-index":"3", opacity:"1", transform:"none", filter:"none", perspective:"none", "clip-path":"none", isolation:"auto", contain:"none", "mix-blend-mode":"normal", "will-change":"auto" } };
  assert.deepEqual(contextTriggers(item), []);
  assert.deepEqual(contextTriggers(item, { computed: { display:"grid" } }), [{ property:"parent-display", value:"grid" }, { property:"z-index", value:"3" }]);
});
