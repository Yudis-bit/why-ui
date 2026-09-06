import assert from "node:assert/strict";
import test from "node:test";
import Ajv from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import { inspectInteractionTool, verifyFixTool } from "../dist/mcp-schema.js";
import { COMPUTED_STYLE_PROPERTIES, WHY_UI_ERROR_CODES } from "../dist/types.js";

const ajv = new Ajv({ strict: true, allErrors: true });
const inspectInput = ajv.compile(inspectInteractionTool.inputSchema);
const inspectOutput = ajv.compile(inspectInteractionTool.outputSchema);
const verifyInput = ajv.compile(verifyFixTool.inputSchema);
const verifyOutput = ajv.compile(verifyFixTool.outputSchema);
const valid = (validate, payload) => assert.equal(validate(payload), true, JSON.stringify(validate.errors));
const invalid = (validate, payload) => assert.equal(validate(payload), false);

function node(id = "save") {
  return {
    tagName: "button", id, selectorHint: `button#${id}`,
    rect: { x: 10, y: 20, width: 80, height: 40, top: 20, right: 90, bottom: 60, left: 10 },
    domPath: [{ tagName: "button", id }],
  };
}

function inspection() {
  return {
    schemaVersion: "why-ui/interaction@1", inspectionId: "baseline-1", capturedAt: 1000,
    pointer: { clientX: 30, clientY: 30, pageX: 30, pageY: 30, pointerType: "mouse", timestamp: 999 },
    viewport: { width: 1280, height: 720, devicePixelRatio: 1, scrollX: 0, scrollY: 0 },
    target: {
      rawHit: node(), interactionTarget: node(), selectionMethod: "pointer-hit",
      computed: Object.fromEntries(COMPUTED_STYLE_PROPERTIES.map((property) => [property, ""])),
      state: { disabled: false, inert: false, ariaDisabled: false, hidden: false },
      ancestors: [], react: { detected: false },
    },
    interactionSurface: {
      totalSamples: 1, reachableSamples: 1, blockedSamples: 0, outsideSamples: 0,
      reachableRatio: 1, blockedRatio: 0, eligibleSamples: 1, sampledClientRects: 1,
      clientRectsTruncated: false,
      samples: [{ x: 30, y: 30, classification: "reachable", weight: 1 }],
    },
    blockers: [], diagnosis: { cause: "UNKNOWN", evidence: ["Sample reached the target family."] }, limitations: [],
  };
}

function verification() {
  return {
    inspectionId: "baseline-1", verificationId: "verification-1", status: "VERIFIED_PASS",
    reconciliation: {
      status: "MATCHED", candidateCount: 1,
      signals: [{ signal: "stable-id", matched: true, evidence: "A unique stable ID matched." }], target: node(),
    },
    baseline: { reachableRatio: 0.25, blockedRatio: 0.75, primaryBlocker: node("overlay") },
    current: { reachableRatio: 1, blockedRatio: 0, primaryBlocker: null },
    originalBlockerPresent: false,
    selectionAnchor: "INVALIDATED_BY_REFLOW",
    safeCore: { exists: true, approximateAreaPx2: 1800, minimumClearancePx: 12, reachableRatio: 1 },
    reasons: ["Fresh samples show a reachable interior after reflow."],
  };
}

test("both tool schemas compile strictly and survive JSON registration", () => {
  const modernAjv = new Ajv2020({ strict: true, allErrors: true });
  for (const tool of [inspectInteractionTool, verifyFixTool]) {
    const decoded = JSON.parse(JSON.stringify(tool));
    assert.equal(decoded.name, tool.name);
    assert.equal(decoded.annotations.readOnlyHint, true);
    assert.equal(decoded.inputSchema.additionalProperties, false);
    assert.equal(decoded.outputSchema.additionalProperties, false);
    assert.equal(ajv.validateSchema(decoded.inputSchema), true);
    assert.equal(ajv.validateSchema(decoded.outputSchema), true);
    modernAjv.compile(decoded.inputSchema);
    modernAjv.compile(decoded.outputSchema);
  }
});

test("inspect input permits an armed session and defines bounded optional defaults", () => {
  const request = {};
  valid(inspectInput, request);
  assert.deepEqual(request, {}, "JSON Schema defaults are annotations, not required client fields");
  valid(inspectInput, { tabId: 0, maxSamples: 9, includeReactMetadata: false });
  valid(inspectInput, { maxSamples: 128 });
  for (const request of [
    { tabId: -1 }, { tabId: 0.5 }, { maxSamples: 8 }, { maxSamples: 129 },
    { maxSamples: 9.5 }, { includeReactMetadata: "true" }, { targetSelector: "button" }, { extra: true },
  ]) invalid(inspectInput, request);
  assert.equal(inspectInteractionTool.inputSchema.properties.maxSamples.default, 64);
  assert.equal(inspectInteractionTool.inputSchema.properties.includeReactMetadata.default, true);
});

test("verify input requires the baseline and bounds samples and stabilization", () => {
  valid(verifyInput, { inspectionId: "baseline-1" });
  valid(verifyInput, { inspectionId: "baseline-1", maxSamples: 9, stabilizationTimeoutMs: 100 });
  valid(verifyInput, { inspectionId: "baseline-1", maxSamples: 128, stabilizationTimeoutMs: 10000 });
  for (const request of [
    {}, { inspectionId: "" }, { inspectionId: 1 },
    { inspectionId: "x", maxSamples: 8 }, { inspectionId: "x", maxSamples: 129 },
    { inspectionId: "x", stabilizationTimeoutMs: 99 }, { inspectionId: "x", stabilizationTimeoutMs: 10001 },
    { inspectionId: "x", stabilizationTimeoutMs: 100.5 }, { inspectionId: "x", tabId: 1 },
  ]) invalid(verifyInput, request);
  assert.equal(verifyFixTool.inputSchema.properties.stabilizationTimeoutMs.default, 3000);
});

test("inspection contract accepts non-React runtime facts and explicit error envelopes", () => {
  valid(inspectOutput, { ok: true, result: inspection() });
  for (const code of WHY_UI_ERROR_CODES) {
    for (const validate of [inspectOutput, verifyOutput]) valid(validate, { ok: false, error: { code } });
  }
  for (const validate of [inspectOutput, verifyOutput]) {
    invalid(validate, { ok: true });
    invalid(validate, { ok: false, error: { code: "SOME_BROWSER_EXCEPTION" } });
    invalid(validate, { ok: false, error: { code: "INTERNAL_SENSOR_ERROR", stack: "private source" } });
    invalid(validate, { ok: false, error: { code: "NO_POINTER_CAPTURED" }, result: {} });
  }
  invalid(inspectOutput, { ok: true, result: inspection(), error: { code: "NO_POINTER_CAPTURED" } });
});

test("inspection accepts partial occlusion and explicitly sourced React evidence", () => {
  const result = inspection();
  const blocker = {
    node: node("overlay"), computed: result.target.computed, state: result.target.state,
    blockedSamples: 1, blockedRatio: 0.5, representativePoint: { x: 70, y: 30 }, ancestors: [],
    react: {
      detected: true, provenance: ["dom-fiber-property", "fiber-debug-stack"], componentName: "Backdrop",
      source: { file: "src/Backdrop.tsx", line: 10, column: 4, scope: "candidate", certainty: "symbolication-needed", provenance: "fiber-debug-stack" },
    },
  };
  result.blockers = [blocker];
  result.primaryBlocker = blocker;
  result.interactionSurface.totalSamples = 2;
  result.interactionSurface.eligibleSamples = 2;
  result.interactionSurface.blockedSamples = 1;
  result.interactionSurface.reachableRatio = 0.5;
  result.interactionSurface.blockedRatio = 0.5;
  result.interactionSurface.samples = [
    { x: 30, y: 30, classification: "reachable", weight: 0.5 },
    { x: 70, y: 30, classification: "blocked", weight: 0.5, blockerIndex: 0 },
  ];
  result.diagnosis.cause = "PARTIAL_FOREIGN_OCCLUSION";
  valid(inspectOutput, JSON.parse(JSON.stringify({ ok: true, result })));
  delete blocker.react.provenance;
  invalid(inspectOutput, { ok: true, result });
});

test("strict output rejects sensitive attribute fields, unbounded strings and invalid ratios", () => {
  const cases = [
    (result) => { result.target.interactionTarget.attributes = { value: "secret" }; },
    (result) => { result.target.interactionTarget.attributes = { href: "https://example.test?token=secret" }; },
    (result) => { result.target.interactionTarget.textPreview = "x".repeat(161); },
    (result) => { result.interactionSurface.reachableRatio = 1.1; },
    (result) => { result.target.computed["background-image"] = "url(secret)"; },
    (result) => { result.interactionSurface.samples[0].classification = "probably-reachable"; },
    (result) => { result.target.react = { detected: true }; },
  ];
  for (const mutate of cases) {
    const result = inspection();
    mutate(result);
    invalid(inspectOutput, { ok: true, result });
  }
});

test("reflow-invalidated UV anchor remains compatible with verified pass", () => {
  const result = verification();
  valid(verifyOutput, { ok: true, result });
  result.reprojectedAnchor = { u: 0.95, v: 0.95, x: 86, y: 58 };
  valid(verifyOutput, JSON.parse(JSON.stringify({ ok: true, result })));
  result.status = "VERIFIED_FAIL";
  result.safeCore.exists = false;
  result.current = { reachableRatio: 0, blockedRatio: 1, primaryBlocker: node("overlay") };
  result.originalBlockerPresent = true;
  result.reasons = ["The deterministically reacquired target remains blocked."];
  valid(verifyOutput, { ok: true, result });
});

test("ambiguous and missing targets are inconclusive, never forced into pass or fail", () => {
  for (const [status, candidateCount] of [["AMBIGUOUS", 2], ["NOT_FOUND", 0]]) {
    const result = verification();
    result.status = "VERIFY_INCONCLUSIVE";
    result.reconciliation = { status, candidateCount, signals: [] };
    result.current = null;
    result.originalBlockerPresent = null;
    result.selectionAnchor = "UNAVAILABLE";
    result.safeCore = { exists: false, reachableRatio: 0 };
    result.reasons = ["Target identity is unavailable or ambiguous."];
    valid(verifyOutput, { ok: true, result });
    for (const outcome of ["VERIFIED_PASS", "VERIFIED_FAIL"]) {
      invalid(verifyOutput, { ok: true, result: { ...result, status: outcome } });
    }
    invalid(verifyOutput, { ok: true, result: { ...result, current: verification().current } });
    invalid(verifyOutput, { ok: true, result: { ...result, originalBlockerPresent: false } });
  }
});

test("pass requires unique target reconciliation, a fresh surface and a safe core", () => {
  const cases = [
    (result) => { result.reconciliation.candidateCount = 2; },
    (result) => { delete result.reconciliation.target; },
    (result) => { result.current = null; },
    (result) => { result.safeCore.exists = false; },
    (result) => { result.safeCore.reachableRatio = 0; },
    (result) => { result.safeCore.approximateAreaPx2 = 0; },
    (result) => { result.safeCore.minimumClearancePx = 0; },
    (result) => { result.status = "PASS"; },
    (result) => { result.reconciliation.signals[0].signal = "llm-confidence"; },
    (result) => { result.selectionAnchor = "REFLOW_FAILED"; },
  ];
  for (const mutate of cases) {
    const result = verification();
    mutate(result);
    invalid(verifyOutput, { ok: true, result });
  }
  const timedOut = verification();
  timedOut.status = "VERIFY_INCONCLUSIVE";
  timedOut.current = null;
  timedOut.originalBlockerPresent = null;
  timedOut.safeCore = { exists: false, reachableRatio: 0 };
  timedOut.reasons = ["Layout did not stabilize before the deadline."];
  valid(verifyOutput, { ok: true, result: timedOut });
  timedOut.safeCore.exists = true;
  timedOut.safeCore.reachableRatio = 1;
  invalid(verifyOutput, { ok: true, result: timedOut });
});
