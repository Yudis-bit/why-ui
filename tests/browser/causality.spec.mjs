import { test, expect, openFixture, installSensor, movePointerToTarget, inspect } from "./helpers.mjs";
import { explainCausality } from "../../dist/daemon/causality.js";

async function capture(page, fixture) {
  await openFixture(page, fixture); await installSensor(page); await movePointerToTarget(page);
  const result = await inspect(page, { targetSelector: "#target" });
  expect(result.primaryBlocker.node.id).toBe("blocker");
  return { result, cause: explainCausality(result) };
}
test("ancestor trap reports both opacity and transform triggers", async ({ page }) => {
  const { cause } = await capture(page, { html: '<div id="card"><button id="target">Pay</button></div><header id="blocker"></header>',
    css: '#card { position:absolute; left:0; top:0; opacity:.99; transform:translateZ(0); } #target { z-index:9999; } #blocker { position:sticky; top:0; margin-top:100px; margin-left:100px; width:200px; height:100px; z-index:10; }' });
  expect(cause.cause).toBe("STACKING_CONTEXT_TRAP"); expect(cause.constrainingStackingContext.node.id).toBe("card");
  expect(cause.constrainingStackingContext.triggers.map(t => t.property)).toEqual(expect.arrayContaining(["opacity", "transform"]));
  expect(cause.blockerContext.triggers).toEqual(expect.arrayContaining([{ property: "position", value: "sticky" }, { property: "z-index", value: "10" }]));
});
test("direct numeric z-index explanation follows real browser hits", async ({ page }) => {
  const { cause } = await capture(page, { html: '<button id="target">Pay</button><div id="blocker"></div>',
    css: '#target { z-index:2; } #blocker { position:absolute; left:100px; top:100px; width:200px; height:100px; z-index:3; }' });
  expect(cause.cause).toBe("DIRECT_Z_INDEX");
});
test("same context leaves detailed paint phases to the browser", async ({ page }) => {
  const { cause } = await capture(page, { html: '<button id="target">Pay</button><div id="blocker"></div>',
    css: '#blocker { position:absolute; left:100px; top:100px; width:200px; height:100px; }' });
  expect(cause.cause).toBe("SAME_CONTEXT_PAINT_ORDER");
});
test("open popover provides top-layer evidence", async ({ page }) => {
  await openFixture(page, { html: '<button id="target">Pay</button><div id="blocker" popover="manual"></div>',
    css: '#blocker { position:fixed; inset:auto; margin:0; padding:0; border:0; left:100px; top:100px; width:200px; height:100px; }' });
  await page.locator("#blocker").evaluate(e => e.showPopover()); await installSensor(page); await movePointerToTarget(page);
  const result = await inspect(page, { targetSelector: "#target" });
  expect(result.primaryBlocker.node.id).toBe("blocker"); expect(explainCausality(result).cause).toBe("TOP_LAYER");
});
test("generated pseudo hit reports its origin without collecting content", async ({ page }) => {
  const { result, cause } = await capture(page, { html: '<button id="target">Pay</button><div id="blocker"></div>',
    css: '#blocker { width:0; height:0; } #blocker::before { content:"PRIVATE_PSEUDO_CONTENT"; position:fixed; left:100px; top:100px; width:200px; height:100px; }' });
  expect(cause.cause).toBe("PSEUDO_ELEMENT_ORIGIN"); expect(JSON.stringify(result)).not.toContain("PRIVATE_PSEUDO_CONTENT");
});
test("preserve-3d degrades to unknown paint cause while retaining blocker truth", async ({ page }) => {
  const { cause } = await capture(page, { html: '<div style="transform-style:preserve-3d"><button id="target">Pay</button><div id="blocker"></div></div>',
    css: '#blocker { position:absolute; left:100px; top:100px; width:200px; height:100px; transform:translateZ(1px); }' });
  expect(cause.cause).toBe("UNKNOWN_PAINT_CAUSE");
});
