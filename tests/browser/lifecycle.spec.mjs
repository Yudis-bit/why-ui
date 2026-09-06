import { test, expect } from "@playwright/test";
import { sensorMainWorld } from "../../dist/sensor-main-world.js";
import { runtimeChanged, runtimeSignature, WorkspaceObserver } from "../../dist/daemon/workspace.js";
import { sourceFixture } from "../source-fixture.mjs";
async function inspect(page) {
  return (await page.evaluate(sensorMainWorld, { operation: "inspect", options: { targetSelector: "#payment" } })).result;
}
test("real file patch rebuilds and reloads; browser document and geometry are fresh", async ({ page }) => {
  const fixture = await sourceFixture();
  try {
    await page.goto(fixture.url); await page.waitForFunction(() => window.fixtureReady === "broken");
    await page.evaluate(sensorMainWorld, { operation: "install" }); await page.mouse.move(200, 150);
    const baseline = await inspect(page), observer = new WorkspaceObserver(fixture.root);
    const revision = await observer.capture(["src/Payment.jsx", "src/styles.module.css"]);
    await fixture.patch("good"); await page.waitForFunction(() => window.fixtureReady === "good");
    await page.evaluate(sensorMainWorld, { operation: "install" }); await page.mouse.move(450, 250);
    const current = await inspect(page);
    expect(runtimeChanged(baseline, current)).toBe(true);
    expect(current.runtime.documentId).not.toBe(baseline.runtime.documentId);
    expect(current.target.interactionTarget.rect.left).toBe(350);
    expect((await observer.capture(revision.files.map(f => f.file))).fingerprint).not.toBe(revision.fingerprint);
  } finally { await fixture.close(); }
});
test("same-document mutation is observed without retaining mutation contents", async ({ page }) => {
  const fixture = await sourceFixture();
  try {
    await page.goto(fixture.url); await page.waitForFunction(() => window.fixtureReady);
    await page.evaluate(sensorMainWorld, { operation: "install" }); await page.mouse.move(200, 150);
    const first = await inspect(page), repeated = await inspect(page);
    expect(runtimeSignature(repeated)).toBe(runtimeSignature(first));
    await page.evaluate(() => { document.getElementById("backdrop").style.pointerEvents = "none"; });
    const current = await inspect(page);
    expect(current.runtime.documentId).toBe(first.runtime.documentId);
    expect(current.runtime.revision).toBeGreaterThan(first.runtime.revision);
    expect(runtimeChanged(first, current)).toBe(true);
    expect(current.interactionSurface.blockedSamples).toBe(0);
  } finally { await fixture.close(); }
});
