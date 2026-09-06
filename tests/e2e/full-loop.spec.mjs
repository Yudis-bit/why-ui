import { test, expect } from "@playwright/test";
import { harness } from "./helpers.mjs";
import { sourceFixture } from "../source-fixture.mjs";
let h, fixture, page, baseline;
test.beforeEach(async () => {
  fixture = await sourceFixture({ react: "react19" }); h = await harness({ workspace: fixture.root });
  const context = await h.launch();
  await context.addInitScript(() => {
    window.activationCalls = 0;
    for (const method of ["click", "focus", "blur"]) {
      const original = HTMLElement.prototype[method];
      HTMLElement.prototype[method] = function(...args) { window.activationCalls++; return original.apply(this, args); };
    }
  });
  page = await context.newPage(); await page.goto(fixture.url); await page.waitForFunction(() => window.fixtureReady === "broken");
  await h.arm(page); await page.mouse.move(200, 150);
  const response = await h.inspect({ target: { selector: "#payment" } });
  expect(response.ok, JSON.stringify(response)).toBe(true); baseline = response.result;
  expect(baseline.diagnosis.cause).toBe("FOREIGN_OCCLUSION"); expect(baseline.primaryBlocker.node.id).toBe("backdrop");
  expect(baseline.sources.primaryBlocker.references[0]).toMatchObject({ file: "src/Payment.jsx", line: 8, certainty: "symbolicated" });
  expect(await page.evaluate(() => window.activationCalls)).toBe(0);
});
test.afterEach(async () => { await h?.close(); await fixture?.close(); });
test("MCP inspect → real source patch → rebuild/reload → independent VERIFIED_PASS", async () => {
  await fixture.patch("good"); // Changes actual local JSX/CSS, rebuilds with esbuild and notifies the page over SSE.
  const response = await h.verify({ inspectionId: baseline.inspectionId, stabilizationTimeoutMs: 10000 });
  expect(response.ok, JSON.stringify(response)).toBe(true);
  expect(response.result.status, JSON.stringify(response.result)).toBe("VERIFIED_PASS");
  expect(response.result.reconciliation.status).toBe("MATCHED");
  expect(response.result.current.blockedSamples).toBe(0); expect(response.result.current.reachableSamples).toBeGreaterThan(1);
  expect(response.result.safeCore.exists).toBe(true); expect(response.result.safeCore.approximateAreaPx2).toBeGreaterThanOrEqual(64);
  expect(response.result.selectionAnchor).toBe("INVALIDATED_BY_REFLOW");
  expect(response.result.lifecycle).toMatchObject({ sourceChanged: true, runtimeChanged: true, stableObservations: 3 });
  expect(h.daemon.bridgeServer.inspectionStore.get(baseline.inspectionId).diagnosis.cause).toBe("FOREIGN_OCCLUSION");
  expect(await page.evaluate(() => window.activationCalls)).toBe(0);
});
test("bad source patch removes the old blocker but creates a new blocker → VERIFIED_FAIL", async () => {
  await fixture.patch("bad");
  const response = await h.verify({ inspectionId: baseline.inspectionId, stabilizationTimeoutMs: 10000 });
  expect(response.ok, JSON.stringify(response)).toBe(true); expect(response.result.status).toBe("VERIFIED_FAIL");
  expect(response.result.originalBlockerPresent).toBe(false); expect(response.result.current.primaryBlocker.id).toBe("replacement");
  expect(response.result.current.blockedSamples).toBeGreaterThan(0); expect(await page.evaluate(() => window.activationCalls)).toBe(0);
});
test("source patch creates indistinguishable targets → VERIFY_INCONCLUSIVE", async () => {
  await fixture.patch("ambiguous");
  const response = await h.verify({ inspectionId: baseline.inspectionId, stabilizationTimeoutMs: 1500 });
  expect(response.ok, JSON.stringify(response)).toBe(true); expect(response.result.status).toBe("VERIFY_INCONCLUSIVE");
  expect(response.result.reconciliation.status).toBe("AMBIGUOUS"); expect(response.result.current).toBeNull();
});
test("no source patch cannot be declared a verified fix", async () => {
  const response = await h.verify({ inspectionId: baseline.inspectionId, stabilizationTimeoutMs: 200 });
  expect(response.result.status).toBe("VERIFY_INCONCLUSIVE"); expect(response.result.lifecycle.sourceChanged).toBe(false);
});
