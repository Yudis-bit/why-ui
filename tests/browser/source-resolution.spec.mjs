import { test, expect } from "@playwright/test";
import { sensorMainWorld } from "../../dist/sensor-main-world.js";
import { SourceResolver } from "../../dist/daemon/source-resolver.js";
import { sourceFixture } from "../source-fixture.mjs";
for (const react of ["react18", "react19"]) {
  test(`${react} real host and blocker resolve into local JSX with source maps`, async ({ page }) => {
    const fixture = await sourceFixture({ react });
    try {
      await page.goto(fixture.url); await page.waitForFunction(() => window.fixtureReady === "broken");
      await page.evaluate(sensorMainWorld, { operation: "install" }); await page.mouse.move(200, 150);
      const observed = await page.evaluate(sensorMainWorld, { operation: "inspect", options: { targetSelector: "#payment" } });
      expect(observed.ok).toBe(true); expect(observed.result.diagnosis.cause).toBe("FOREIGN_OCCLUSION");
      const sources = await new SourceResolver(fixture.root).inspect(observed.result, fixture.url);
      expect(sources.target.status, JSON.stringify({ metadata: observed.result.target.react, sources })).toBe("MAPPED");
      expect(sources.target.references[0].file).toBe("src/Payment.jsx");
      expect(sources.primaryBlocker.references[0].file).toBe("src/Payment.jsx");
      expect(sources.primaryBlocker.references[0].certainty).toBe(react === "react18" ? "runtime-derived" : "symbolicated");
      expect(sources.primaryBlocker.references[0].line).toBe(8);
      expect(sources.css.some(ref => ref.file === "src/styles.module.css" && ref.certainty === "symbolicated")).toBe(true);
    } finally { await fixture.close(); }
  });
}
test("generated React 19 frame without a map degrades honestly", async ({ page }) => {
  const fixture = await sourceFixture({ sourceMap: false });
  try {
    await page.goto(fixture.url); await page.waitForFunction(() => window.fixtureReady);
    await page.evaluate(sensorMainWorld, { operation: "install" }); await page.mouse.move(200, 150);
    const observed = await page.evaluate(sensorMainWorld, { operation: "inspect", options: { targetSelector: "#payment" } });
    const resolver = new SourceResolver(fixture.root);
    expect((await resolver.resolveHint(observed.result.target.react.source, fixture.url)).status).toBe("UNMAPPED");
    const candidate = await resolver.resolveNode(observed.result.target.interactionTarget, observed.result.target.react, fixture.url);
    expect(candidate.references.every(ref => ref.certainty === "heuristic")).toBe(true);
  } finally { await fixture.close(); }
});
test("plain DOM works without React and absent source remains UNMAPPED", async ({ page }) => {
  const fixture = await sourceFixture();
  try {
    await page.goto(fixture.url); await page.waitForFunction(() => window.fixtureReady);
    await page.evaluate(() => { document.body.replaceChildren(Object.assign(document.createElement("button"), { id: "unmapped-plain" })); });
    await page.evaluate(sensorMainWorld, { operation: "install" }); await page.mouse.move(10, 10);
    const observed = await page.evaluate(sensorMainWorld, { operation: "inspect", options: { targetSelector: "#unmapped-plain" } });
    expect(observed.ok).toBe(true); expect(observed.result.target.react.detected).toBe(false);
    expect((await new SourceResolver(fixture.root).inspect(observed.result, fixture.url)).target.status).toBe("UNMAPPED");
  } finally { await fixture.close(); }
});
