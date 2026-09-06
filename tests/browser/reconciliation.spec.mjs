import { test, expect } from "@playwright/test";
import Ajv from "ajv";
import { sensorMainWorld } from "../../dist/sensor-main-world.js";
import { sensorVerifyResponseSchema } from "../../dist/mcp-schema.js";
import { targetIdentity } from "../../dist/daemon/workspace.js";
import { sourceFixture } from "../source-fixture.mjs";
const validate = new Ajv({ strict: true }).compile(sensorVerifyResponseSchema);
let fixture;
test.beforeEach(async ({ page }) => {
  fixture = await sourceFixture(); await page.goto(fixture.url); await page.waitForFunction(() => window.fixtureReady);
  await page.evaluate(sensorMainWorld, { operation: "install" }); await page.mouse.move(200, 150);
});
test.afterEach(async () => { await fixture.close(); });
async function baseline(page) { return (await page.evaluate(sensorMainWorld, { operation: "inspect", options: { targetSelector: "#payment" } })).result; }
async function verify(page, baseline) {
  const result = await page.evaluate(sensorMainWorld, { operation: "verify", baseline: targetIdentity(baseline) });
  expect(validate(result), JSON.stringify(validate.errors)).toBe(true); return result.result;
}
test("retained runtime DOM identity is EXACT after same-document reflow", async ({ page }) => {
  const original = await baseline(page);
  await page.evaluate(() => { document.getElementById("payment").style.left = "350px"; });
  const current = await verify(page, original);
  expect(current.reconciliation.status).toBe("EXACT");
  expect(current.inspection.target.interactionTarget.rect.left).toBe(350);
});
test("reload reacquires MATCHED identity and fresh surface without another pointer event", async ({ page }) => {
  const original = await baseline(page); await fixture.patch("good"); await page.waitForFunction(() => window.fixtureReady === "good");
  const current = await verify(page, original);
  expect(current.reconciliation.status).toBe("MATCHED"); expect(current.inspection.interactionSurface.reachableRatio).toBe(1);
  expect(current.inspection.target.interactionTarget.rect.left).toBe(350);
});
test("near-equal targets remain AMBIGUOUS despite nth-of-type differences", async ({ page }) => {
  const original = await baseline(page); await fixture.patch("ambiguous"); await page.waitForFunction(() => window.fixtureReady === "ambiguous");
  const current = await verify(page, original);
  expect(current.reconciliation.status).toBe("AMBIGUOUS"); expect(current.reconciliation.candidateCount).toBe(2);
  expect(current.inspection).toBeUndefined();
});
test("removed target remains NOT_FOUND without guessing a different element", async ({ page }) => {
  const original = await baseline(page); await page.evaluate(() => { document.getElementById("payment").remove(); });
  const current = await verify(page, original);
  expect(current.reconciliation.status).toBe("NOT_FOUND"); expect(current.inspection).toBeUndefined();
});
