import {
  test, expect, openFixture, installSensor, movePointerToTarget, inspect,
  assertNoSideEffects,
} from "./helpers.mjs";

// These reads report scalar observations from the actual fixture runtime, never
// traverse a Fiber tree or substitute for production React enrichment.
async function runtimeFacts(page) {
  return page.evaluate(() => {
    const target = document.getElementById("target");
    const fiberKey = Object.getOwnPropertyNames(target).find(key =>
      /^__(?:reactFiber|reactInternalInstance)\$/.test(key));
    const fiber = fiberKey ? target[fiberKey] : undefined;
    return {
      version: window.__reactFixture.version,
      hostFiberPresent: Boolean(fiber),
      debugSourceAvailable: Boolean(fiber?._debugSource),
      debugStackAvailable: Boolean(fiber?._debugStack),
      debugOwnerAvailable: Boolean(fiber?._debugOwner),
    };
  });
}

async function attachMetadata(testInfo, facts, result) {
  await testInfo.attach("react-runtime-facts", {
    body: JSON.stringify({
      ...facts,
      targetMetadata: result.target.react,
      blockerMetadata: result.primaryBlocker?.react,
    }, null, 2),
    contentType: "application/json",
  });
}

for (const runtime of ["react18", "react19"]) {
  test.describe(`${runtime} actual development runtime`, () => {
    test("native target has bounded, serializable React enrichment", async ({ page }, testInfo) => {
      await openFixture(page, { react: runtime });
      await installSensor(page);
      await movePointerToTarget(page);
      const facts = await runtimeFacts(page);
      const result = await inspect(page);
      expect(facts.version).toMatch(runtime === "react18" ? /^18\./ : /^19\./);
      expect(facts.hostFiberPresent).toBe(true);
      expect(result.target.interactionTarget.id).toBe("target");
      expect(result.interactionSurface.reachableRatio).toBeGreaterThan(0.95);
      expect(result.target.react.detected).toBe(true);
      expect(result.target.react.provenance).toContain("dom-fiber-property");
      if (result.target.react.ownerChain) {
        expect(result.target.react.ownerChain.length).toBeLessThanOrEqual(16);
        expect(result.target.react.ownerChain).toContain("PaymentButton");
      }
      const source = result.target.react.source;
      if (source?.provenance === "fiber-debug-stack") {
        expect(source.scope).toBe("candidate");
        expect(source.certainty).toBe("symbolication-needed");
      }
      if (source?.provenance === "fiber-debug-source") {
        expect(source.certainty).toBe("runtime-derived");
      }
      await attachMetadata(testInfo, facts, result);
      await assertNoSideEffects(page);
    });

    test("SVG child selects the button and its relevant owner", async ({ page }, testInfo) => {
      await openFixture(page, { react: runtime, scenario: "svg" });
      await installSensor(page);
      await movePointerToTarget(page, "#payment-path");
      const result = await inspect(page);
      expect(["path", "svg"]).toContain(result.target.rawHit.tagName);
      expect(result.target.interactionTarget.tagName).toBe("button");
      expect(result.target.interactionTarget.id).toBe("target");
      expect(result.interactionSurface.reachableSamples).toBeGreaterThan(1);
      expect(result.interactionSurface.blockedSamples).toBe(0);
      expect(result.target.react.detected).toBe(true);
      expect(result.target.react.ownerChain).toContain("PaymentButton");
      await attachMetadata(testInfo, await runtimeFacts(page), result);
      await assertNoSideEffects(page);
    });

    test("overlay preserves separate target and blocker component owners", async ({ page }, testInfo) => {
      await openFixture(page, { react: runtime, scenario: "overlay" });
      await installSensor(page);
      await movePointerToTarget(page);
      // Prior identity is explicit: the pointer itself hits the foreign backdrop.
      const result = await inspect(page, { targetSelector: "#target" });
      expect(result.target.rawHit.id).toBe("overlay");
      expect(result.diagnosis.cause).toBe("FOREIGN_OCCLUSION");
      expect(result.interactionSurface.blockedRatio).toBeGreaterThan(0.95);
      expect(result.primaryBlocker.node.id).toBe("overlay");
      expect(result.target.react.detected).toBe(true);
      expect(result.target.react.ownerChain).toContain("CheckoutButton");
      expect(result.primaryBlocker.react.detected).toBe(true);
      expect(result.primaryBlocker.react.ownerChain).toContain("ModalBackdrop");
      await attachMetadata(testInfo, await runtimeFacts(page), result);
      await assertNoSideEffects(page);
    });

    test("a throwing real host Fiber reference cannot break hit testing", async ({ page }) => {
      await openFixture(page, { react: runtime });
      await installSensor(page);
      await movePointerToTarget(page);
      expect((await inspect(page)).target.react.detected).toBe(true);
      // Fault injection touches only the discovered React-internal reference.
      // Browser layout, coordinates, DOM structure and hit testing remain real.
      const replaced = await page.evaluate(() => {
        const target = document.getElementById("target");
        const key = Object.getOwnPropertyNames(target).find(name =>
          /^__(?:reactFiber|reactInternalInstance)\$/.test(name));
        if (!key) return false;
        target[key] = new Proxy(target[key], {
          get() { throw new Error("Fixture-only inaccessible Fiber field"); },
        });
        return true;
      });
      expect(replaced).toBe(true);
      const result = await inspect(page);
      expect(result.target.react).toEqual({ detected: false });
      expect(result.target.interactionTarget.id).toBe("target");
      expect(result.interactionSurface.reachableRatio).toBeGreaterThan(0.95);
      expect(result.diagnosis.cause).toBe("UNKNOWN");
      await assertNoSideEffects(page);
    });
  });
}

test("React 19 modern debug stack is attempted defensively without _debugSource", async ({ page }, testInfo) => {
  await openFixture(page, { react: "react19" });
  await installSensor(page);
  await movePointerToTarget(page);
  const facts = await runtimeFacts(page);
  expect(facts.debugSourceAvailable).toBe(false);
  const observed = await page.evaluate(() => {
    const target = document.getElementById("target");
    const key = Object.getOwnPropertyNames(target).find(name => /^__reactFiber\$/.test(name));
    if (!key) return false;
    const fiber = target[key];
    const original = fiber._debugStack;
    window.__debugStackReads = 0;
    Object.defineProperty(fiber, "_debugStack", {
      configurable: true,
      get() {
        window.__debugStackReads++;
        return original;
      },
    });
    return true;
  });
  expect(observed).toBe(true);
  const result = await inspect(page);
  expect(await page.evaluate(() => window.__debugStackReads)).toBeGreaterThan(0);
  expect(result.target.react.detected).toBe(true);
  expect(result.target.react.ownerChain).toContain("PaymentButton");
  if (result.target.react.source?.provenance === "fiber-debug-stack") {
    expect(result.target.react.source.certainty).toBe("symbolication-needed");
    expect(result.target.react.source.scope).toBe("candidate");
  }
  await attachMetadata(testInfo, facts, result);
  await assertNoSideEffects(page);
});

test("metadata can be omitted without changing real React target reachability", async ({ page }) => {
  await openFixture(page, { react: "react19" });
  await installSensor(page);
  await movePointerToTarget(page);
  const result = await inspect(page, { includeReactMetadata: false });
  expect(result.target).not.toHaveProperty("react");
  expect(result.interactionSurface.reachableRatio).toBeGreaterThan(0.95);
  expect(result.diagnosis.cause).toBe("UNKNOWN");
  await assertNoSideEffects(page);
});
