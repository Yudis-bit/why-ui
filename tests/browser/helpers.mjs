import { test as base, expect } from "@playwright/test";
import Ajv from "ajv";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { sensorMainWorld } from "../../dist/sensor-main-world.js";
import { inspectInteractionTool } from "../../dist/mcp-schema.js";

const validate = new Ajv({ strict: true, allErrors: true }).compile(inspectInteractionTool.outputSchema);
const bundles = new Map();
const lastAudits = new WeakMap();

// Uses Playwright's own runner and page fixture. No browser protocol client or transport.
export const test = base.extend({
  observationGuard: [async ({ page }, use) => {
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await use();
    expect(errors, "Fixture/page execution must not throw").toEqual([]);
    if (lastAudits.has(page)) await assertNoSideEffects(page);
  }, { auto: true }],
});
export { expect };

async function reactBundle(version) {
  if (!bundles.has(version)) {
    const entry = fileURLToPath(new URL(`./fixtures/${version}/app.jsx`, import.meta.url));
    bundles.set(version, build({
      entryPoints: [entry], bundle: true, write: false, format: "iife", platform: "browser",
      target: "es2022", jsx: "automatic", jsxDev: true,
      define: { "process.env.NODE_ENV": '"development"' },
      // This is a test fixture build, not source instrumentation of the application.
      sourcemap: false, minify: false, logLevel: "silent",
    }).then(result => result.outputFiles[0].text));
  }
  return bundles.get(version);
}

/** Static fixture delivery only. No application server, daemon, or external requests. */
export async function openFixture(page, { html = '<button id="target">Pay now</button>', css = "", react, scenario = "basic" } = {}) {
  await page.route("**/*", route => route.fulfill({
    status: 200, contentType: "text/html",
    body: `<!doctype html><html><head><meta charset="utf-8"><style>
      html, body { margin: 0; min-height: 800px; font-family: Arial, sans-serif; }
      button, #target { position: absolute; left: 100px; top: 100px; width: 200px; height: 100px;
        border: 0; padding: 0; border-radius: 0; box-sizing: border-box; background: #cde; color: #123; }
      svg { width: 48px; height: 48px; }
      ${css}
      </style></head><body>${react ? '<div id="root"></div>' : html}</body></html>`,
  }));
  await page.goto("http://why-ui-fixture.test/");
  if (react) {
    await page.evaluate(value => { window.__fixtureScenario = value; }, scenario);
    await page.addScriptTag({ content: await reactBundle(react) });
    await page.waitForFunction(() => window.__reactFixture?.ready === true);
  }
  // Inject the ACTUAL compiled production function; no copied helpers or causal logic.
  // Script insertion happens during fixture setup, before the observational audit.
  await page.addScriptTag({ content: `Object.defineProperty(window, "__whyUiBrowserTestSensor", {
    value: (${sensorMainWorld.toString()}), configurable: true
  });` });
  await page.evaluate(() => {
    const counters = { click: 0, focus: 0, blur: 0, pointermove: 0, trustedPointermove: 0 };
    for (const name of ["click", "focus", "blur"]) window.addEventListener(name, () => { counters[name]++; }, true);
    window.addEventListener("pointermove", event => {
      counters.pointermove++;
      if (event.isTrusted) counters.trustedPointermove++;
    }, { passive: true, capture: true });
    const observer = new MutationObserver(() => {});
    const observe = root => {
      observer.observe(root, { subtree: true, attributes: true, childList: true, characterData: true });
      for (const node of root.querySelectorAll("*")) if (node.shadowRoot) observe(node.shadowRoot);
    };
    observe(document);
    // Full fixture snapshots are test-only. The production sensor never traverses this way.
    const snapshot = root => Array.from(root.children ?? []).flatMap(node => [
      { node, attributes: Array.from(node.attributes, attr => [attr.name, attr.value]), text: node.nodeType === 3 ? node.textContent : null },
      ...snapshot(node), ...(node.shadowRoot ? snapshot(node.shadowRoot) : []),
    ]);
    window.__fixtureAudit = { counters, observer, snapshot };
  });
}

export async function invokeSensor(page, request) {
  const observed = await page.evaluate(request => {
    const audit = window.__fixtureAudit;
    audit.observer.takeRecords(); // Discard only fixture setup/animation mutations before this call.
    const before = audit.snapshot(document);
    const focusBefore = document.activeElement;
    const countsBefore = { ...audit.counters };
    const started = performance.now();
    const response = window.__whyUiBrowserTestSensor(request);
    const durationMs = performance.now() - started;
    // JSON serialization occurs inside Chromium BEFORE the Playwright serialization boundary.
    const json = JSON.stringify(response);
    const after = audit.snapshot(document);
    const unchanged = before.length === after.length && before.every((entry, index) =>
      entry.node === after[index].node && JSON.stringify(entry.attributes) === JSON.stringify(after[index].attributes));
    return { json, durationMs, audit: {
      unchanged, mutations: audit.observer.takeRecords().length,
      focusUnchanged: document.activeElement === focusBefore,
      activation: ["click", "focus", "blur"].map(name => audit.counters[name] - countsBefore[name]),
      totalActivation: ["click", "focus", "blur"].map(name => audit.counters[name]),
    } };
  }, request);
  lastAudits.set(page, { ...observed.audit, durationMs: observed.durationMs });
  expect(observed.json, "Sensor must return JSON data").toBeTruthy();
  const response = JSON.parse(observed.json);
  if (request.operation === "inspect") {
    expect(validate(response), JSON.stringify(validate.errors)).toBe(true);
  }
  await assertNoSideEffects(page);
  return response;
}

export async function installSensor(page) {
  const response = await invokeSensor(page, { operation: "install" });
  expect(response).toEqual({ ok: true, result: { installed: true } });
}

export async function movePointerToTarget(page, selector = "#target", { u = 0.5, v = 0.5 } = {}) {
  const rect = await page.locator(selector).boundingBox();
  expect(rect, `Expected rendered geometry for ${selector}`).not.toBeNull();
  const point = { x: rect.x + rect.width * u, y: rect.y + rect.height * v };
  await page.mouse.move(point.x, point.y);
  expect(await page.evaluate(() => window.__fixtureAudit.counters.trustedPointermove)).toBeGreaterThan(0);
  return point;
}

export async function inspect(page, options = {}) {
  const response = await invokeSensor(page, { operation: "inspect", options });
  expect(response.ok, JSON.stringify(response)).toBe(true);
  return response.result;
}

/** Sensor-only elapsed time measured inside Chromium, excluding fixture audit overhead. */
export function inspectionDurationMs(page) {
  return lastAudits.get(page)?.durationMs;
}

export async function assertNoSideEffects(page) {
  const audit = lastAudits.get(page);
  expect(audit).toBeDefined();
  expect(audit.unchanged, "Sensor added/replaced nodes or changed attributes").toBe(true);
  expect(audit.mutations, "Sensor caused DOM mutation").toBe(0);
  expect(audit.focusUnchanged, "Sensor changed focus").toBe(true);
  expect(audit.activation, "Sensor activated the fixture").toEqual([0, 0, 0]);
  expect(audit.totalActivation, "Browser suite must not activate the fixture").toEqual([0, 0, 0]);
}
