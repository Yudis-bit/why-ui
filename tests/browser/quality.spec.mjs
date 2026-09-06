import {
  test, expect, openFixture, installSensor, movePointerToTarget, inspect,
  invokeSensor, inspectionDurationMs,
} from "./helpers.mjs";

test("inspection before movement returns NO_POINTER_CAPTURED", async ({ page }) => {
  await openFixture(page);
  await installSensor(page);
  const response = await invokeSensor(page, { operation: "inspect" });
  expect(response).toMatchObject({ ok: false, error: { code: "NO_POINTER_CAPTURED" } });
  expect(await page.evaluate(() => window.__fixtureAudit.counters.trustedPointermove)).toBe(0);
});

test("a captured coordinate outside a resized viewport returns NO_TARGET_AT_POINT", async ({ page }) => {
  await openFixture(page);
  await installSensor(page);
  await page.mouse.move(1200, 750);
  const baseline = await inspect(page);
  expect(baseline.pointer.clientX).toBe(1200);
  // A real viewport resize leaves the captured historical coordinate outside the page.
  // Do not fabricate a pointer, clear the DOM, or override elementsFromPoint.
  await page.setViewportSize({ width: 320, height: 240 });
  expect(await page.evaluate(() => document.elementsFromPoint(1200, 750).length)).toBe(0);
  const response = await invokeSensor(page, { operation: "inspect" });
  expect(response).toMatchObject({ ok: false, error: { code: "NO_TARGET_AT_POINT" } });
});

test("form values, editable text, storage, and document HTML never enter serialized payloads", async ({ page }) => {
  const secrets = ["SECRET_VALUE_SHOULD_NOT_LEAK", "PRIVATE_TEXT_SHOULD_NOT_LEAK",
    "SECRET_STORAGE_SHOULD_NOT_LEAK", "SECRET_SESSION_SHOULD_NOT_LEAK", "SECRET_EDIT_SHOULD_NOT_LEAK"];
  await openFixture(page, {
    html: `<button id="target">Pay now</button>
      <input id="private-input" value="${secrets[0]}">
      <textarea id="private-area">${secrets[1]}</textarea>
      <div id="private-edit" contenteditable="true">${secrets[4]}</div>`,
    css: '#private-input, #private-area, #private-edit { position:absolute; left:100px; top:350px; } #private-area { top:400px; } #private-edit { top:480px; }',
  });
  await page.evaluate(([local, session]) => {
    localStorage.setItem("private", local);
    sessionStorage.setItem("private", session);
  }, [secrets[2], secrets[3]]);
  await installSensor(page);
  for (const selector of ["#target", "#private-input", "#private-area", "#private-edit"]) {
    await movePointerToTarget(page, selector);
    const result = await inspect(page, { targetSelector: selector });
    const serialized = JSON.stringify(result);
    for (const secret of secrets) expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("<!doctype");
    expect(serialized).not.toContain("<html");
    expect(serialized).not.toContain("<textarea");
  }
});

test("dynamic layout is recaptured from fresh real geometry with an explicit snapshot limitation", async ({ page }) => {
  await openFixture(page, {
    html: `<button id="target">Pay now</button><script>
      window.moveFixture = () => new Promise(resolve => {
        requestAnimationFrame(() => {
          const target = document.getElementById('target');
          target.style.left = '450px';
          target.style.width = '260px';
          requestAnimationFrame(resolve);
        });
      });
    </script>`,
  });
  await installSensor(page);
  await movePointerToTarget(page);
  const baseline = await inspect(page);
  await page.evaluate(() => window.moveFixture());
  await movePointerToTarget(page);
  const current = await inspect(page, { targetSelector: "#target" });
  expect(current.inspectionId).not.toBe(baseline.inspectionId);
  expect(current.target.interactionTarget.rect.x).toBeGreaterThan(baseline.target.interactionTarget.rect.x + 300);
  expect(current.target.interactionTarget.rect.width).toBe(260);
  expect(current.interactionSurface.samples.every(sample => sample.x >= 450 && sample.x <= 710)).toBe(true);
  expect(current.interactionSurface.reachableRatio).toBeGreaterThan(0.9);
  expect(current.limitations.join(" ")).toContain("not an atomic browser snapshot");
  expect(baseline.target.interactionTarget.rect.x).toBe(100);
});

test("repeated installation keeps inspection observational in the same document", async ({ page }) => {
  await openFixture(page);
  await installSensor(page);
  await installSensor(page);
  await movePointerToTarget(page);
  const first = await inspect(page);
  const second = await inspect(page);
  expect(second.interactionSurface.reachableRatio).toBeGreaterThan(0.9);
  expect(second.inspectionId).not.toBe(first.inspectionId);
  const disposed = await invokeSensor(page, { operation: "dispose" });
  expect(disposed).toEqual({ ok: true, result: { installed: false } });
  await installSensor(page);
  expect(await invokeSensor(page, { operation: "inspect" })).toMatchObject({ ok: false, error: { code: "NO_POINTER_CAPTURED" } });
});

test("moderately populated DOM inspection stays within a generous interactive budget", async ({ page, browser }, testInfo) => {
  const nodes = Array.from({ length: 900 }, (_, index) => `<span class="population">Item ${index}</span>`).join("");
  await openFixture(page, {
    html: `<button id="target">Pay now</button><section id="population">${nodes}</section>`,
    css: '#population { position:absolute; top:300px; display:grid; grid-template-columns:repeat(30, 30px); font-size:8px; }',
  });
  await installSensor(page);
  await movePointerToTarget(page);
  const result = await inspect(page);
  const durationMs = inspectionDurationMs(page);
  expect(result.interactionSurface.reachableRatio).toBeGreaterThan(0.9);
  expect(result.interactionSurface.totalSamples).toBeLessThanOrEqual(64);
  // Smoke budget, not a benchmark or a sub-frame latency claim. Timing excludes test audits.
  expect(durationMs).toBeLessThan(5000);
  const measurements = { chromium: browser.version(), nodes: 900, durationMs, samples: result.interactionSurface.totalSamples };
  console.log("Chromium performance smoke:", JSON.stringify(measurements));
  await testInfo.attach("browser-performance-smoke", { body: JSON.stringify(measurements), contentType: "application/json" });
});
