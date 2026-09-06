import {
  COMPUTED_STYLE_PROPERTIES,
  INTERACTION_CAUSES,
  PAINT_CAUSES,
  REACT_PROVENANCE,
  RECONCILIATION_SIGNALS,
  RECONCILIATION_STATUSES,
  SAMPLE_CLASSIFICATIONS,
  SELECTION_ANCHOR_STATUSES,
  VERIFICATION_STATUSES,
  WHY_UI_ERROR_CODES,
} from "./types.js";

export type {
  InspectInteractionRequest,
  InspectInteractionResponse,
  VerifyFixRequest,
  VerifyFixResponse,
  VerificationResult,
  VerificationStatus,
} from "./types.js";

// Registration contracts only, not executable tool handlers. Plain JSON Schema (draft
// 2020-12 compatible); no SDK or validator is needed at runtime.
// References below form an acyclic graph. Each tool carries only the definitions it uses.
const text = (maxLength = 512) => ({ type: "string", maxLength } as const);
const number = { type: "number" } as const;
const nonnegative = { type: "number", minimum: 0 } as const;
const ratio = { type: "number", minimum: 0, maximum: 1 } as const;
const boolean = { type: "boolean" } as const;
const count = { type: "integer", minimum: 0, maximum: 128 } as const;
const ref = (name: string) => ({ $ref: `#/$defs/${name}` });
const nullable = (schema: object) => ({ anyOf: [schema, { type: "null" }] });
const array = (items: object, maxItems: number) => ({ type: "array", items, maxItems } as const);
const object = <T extends Record<string, object>>(properties: T, required: readonly string[]) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
} as const);

const commonDefinitions = {
  error: object({
    code: { type: "string", enum: WHY_UI_ERROR_CODES },
    message: { ...text(), description: "Optional safe diagnostic; never a raw browser exception or page contents." },
  }, ["code"]),
  rect: object({
    x: number, y: number, width: nonnegative, height: nonnegative,
    top: number, right: number, bottom: number, left: number,
  }, ["x", "y", "width", "height", "top", "right", "bottom", "left"]),
  node: object({
    tagName: text(64),
    id: text(160),
    classes: array(text(64), 6),
    role: text(64),
    name: { ...text(160), description: "Sanitized label hint, not a complete accessible-name computation." },
    textPreview: { ...text(160), description: "Short sanitized text; excludes editable and form contents." },
    selectorHint: {
      ...text(1024),
      description: "Diagnostic selector hint, not guaranteed unique or suitable for reacquisition; >>> denotes an open shadow boundary.",
    },
    attributes: object({
      type: text(160), role: text(160), "aria-disabled": text(160), "aria-hidden": text(160),
      disabled: text(160), hidden: text(160), inert: text(160), tabindex: text(160), contenteditable: text(160),
    }, []),
    rect: ref("rect"),
    domPath: array(object({
      tagName: text(64), id: text(160), classes: array(text(64), 6),
      nthOfType: { type: "integer", minimum: 1 },
    }, ["tagName"]), 8),
  }, ["tagName", "selectorHint", "rect", "domPath"]),
};

const causalDefinitions = {
  stackingContext: object({ node: ref("node"), triggers: array(object({ property: text(64), value: text(256) }, ["property", "value"]), 32) }, ["node", "triggers"]),
  causality: object({ cause: { type: "string", enum: PAINT_CAUSES }, evidence: array(text(), 8),
    targetContext: ref("stackingContext"), blockerContext: ref("stackingContext"), constrainingStackingContext: ref("stackingContext"),
  }, ["cause", "evidence"]),
};

const inspectionDefinitions = {
  ...commonDefinitions,
  computed: object(
    Object.fromEntries(COMPUTED_STYLE_PROPERTIES.map((property) => [property, text()])),
    COMPUTED_STYLE_PROPERTIES,
  ),
  state: object({
    disabled: boolean, inert: boolean, ariaDisabled: boolean, hidden: boolean,
  }, ["disabled", "inert", "ariaDisabled", "hidden"]),
  nodeEvidence: object({
    node: ref("node"), computed: ref("computed"), state: ref("state"), react: ref("react"), css: array(ref("cssDeclaration"), 8),
    paint: ref("paint"),
  }, ["node", "computed", "state"]),
  paint: object({
    topLayer: { type: "string", enum: ["modal", "popover", "fullscreen"] },
    pseudoElementOrigin: boolean, uncertain3D: boolean,
    extraTriggers: array(object({ property: { type: "string", enum: ["translate", "rotate", "scale", "backdrop-filter", "mask-image"] }, value: text(256) }, ["property", "value"]), 5),
  }, []),
  cssDeclaration: object({
    property: { type: "string", enum: COMPUTED_STYLE_PROPERTIES }, value: text(256), selector: text(256),
    stylesheet: text(1024), certainty: { const: "runtime-derived", type: "string" },
  }, ["property", "value", "selector", "certainty"]),
  react: {
    ...object({
      detected: boolean,
      provenance: { ...array({ type: "string", enum: REACT_PROVENANCE }, REACT_PROVENANCE.length), minItems: 1, uniqueItems: true },
      version: text(64),
      componentName: text(256),
      ownerChain: array(text(256), 16),
      source: object({
        file: text(1024),
        line: { type: "integer", minimum: 1 },
        column: { type: "integer", minimum: 0 },
        scope: { type: "string", enum: ["host-jsx", "component-owner", "component-definition", "candidate"] },
        certainty: { type: "string", enum: ["exact", "runtime-derived", "symbolication-needed", "heuristic"] },
        provenance: { type: "string", enum: REACT_PROVENANCE },
      }, ["scope", "certainty", "provenance"]),
      sources: array(ref("reactSource"), 8),
      reactKey: nullable(text(256)),
    }, ["detected"]),
    description: "Optional unstable React-internal evidence. Every detected result declares provenance; source hints are not necessarily the cause of the interaction failure.",
    allOf: [{ if: { properties: { detected: { const: true } } }, then: { properties: { provenance: {} }, required: ["provenance"] } }],
  },
  reactSource: object({
    file: text(1024), line: { type: "integer", minimum: 1 }, column: { type: "integer", minimum: 0 },
    scope: { type: "string", enum: ["host-jsx", "component-owner", "component-definition", "candidate"] },
    certainty: { type: "string", enum: ["exact", "runtime-derived", "symbolication-needed", "heuristic"] },
    provenance: { type: "string", enum: REACT_PROVENANCE },
  }, ["scope", "certainty", "provenance"]),
  point: object({ x: number, y: number }, ["x", "y"]),
  sample: {
    ...object({
      x: number, y: number,
      classification: {
        type: "string", enum: SAMPLE_CLASSIFICATIONS,
        description: "unresolved means bounded traversal or unavailable shadow evidence prevents classification; never infer a foreign blocker from it.",
      },
      weight: { ...ratio, description: "Fraction of sampled client-rect area represented by this point." },
      blockerIndex: { type: "integer", minimum: 0, maximum: 15, description: "Index into the coverage-ranked blockers array; omitted if that blocker was truncated from the bounded output." },
      cell: object({ left: number, top: number, right: number, bottom: number }, ["left", "top", "right", "bottom"]),
    }, ["x", "y", "classification", "weight"]),
    allOf: [{
      if: { properties: { classification: { enum: ["reachable", "outside-target-shape", "outside-viewport", "unresolved"] } } },
      then: { properties: { blockerIndex: false } },
    }],
  },
  surface: object({
    totalSamples: count, reachableSamples: count, blockedSamples: count, outsideSamples: count,
    reachableRatio: ratio, blockedRatio: ratio,
    eligibleSamples: { ...count, description: "Samples hitting the target family. Zero means unknown reachability, never proof of a healthy target." },
    sampledClientRects: count,
    clientRectsTruncated: boolean,
    samples: array(ref("sample"), 128),
  }, ["totalSamples", "reachableSamples", "blockedSamples", "outsideSamples", "reachableRatio", "blockedRatio", "eligibleSamples", "sampledClientRects", "clientRectsTruncated", "samples"]),
  blocker: object({
    node: ref("node"), computed: ref("computed"), state: ref("state"),
    paint: ref("paint"),
    blockedSamples: { ...count, minimum: 1 },
    blockedRatio: ratio,
    representativePoint: ref("point"),
    ancestors: {
      ...array(ref("nodeEvidence"), 12),
      description: "Bounded ancestor CSS/state evidence; populated for the primary blocker, possibly empty for other blockers to limit runtime reads.",
    },
    react: ref("react"),
    css: array(ref("cssDeclaration"), 8),
  }, ["node", "computed", "state", "blockedSamples", "blockedRatio", "representativePoint", "ancestors"]),
  inspection: object({
    runtime: object({ documentId: text(128), revision: { type: "integer", minimum: 0 }, readyState: { type: "string", enum: ["loading", "interactive", "complete"] } }, ["documentId", "revision", "readyState"]),
    runtimeTargetId: text(128),
    schemaVersion: { const: "why-ui/interaction@1", type: "string" },
    inspectionId: { ...text(128), minLength: 1 },
    capturedAt: nonnegative,
    pointer: object({
      clientX: number, clientY: number, pageX: number, pageY: number,
      pointerType: text(32), timestamp: nonnegative,
    }, ["clientX", "clientY", "pageX", "pageY", "pointerType", "timestamp"]),
    viewport: object({
      width: nonnegative, height: nonnegative,
      devicePixelRatio: { type: "number", exclusiveMinimum: 0 }, scrollX: number, scrollY: number,
    }, ["width", "height", "devicePixelRatio", "scrollX", "scrollY"]),
    target: object({
      rawHit: nullable(ref("node")), interactionTarget: ref("node"),
      selectionMethod: { type: "string", enum: ["pointer-hit", "selector-hint", "reconciled"] },
      computed: ref("computed"), state: ref("state"),
      paint: ref("paint"),
      ancestors: array(ref("nodeEvidence"), 12), react: ref("react"),
      css: array(ref("cssDeclaration"), 8),
    }, ["rawHit", "interactionTarget", "selectionMethod", "computed", "state", "ancestors"]),
    interactionSurface: {
      ...ref("surface"),
      description: "Browser hit-test evidence. Ratios estimate area among eligible samples and are not exact pixel coverage.",
    },
    blockers: array(ref("blocker"), 16),
    primaryBlocker: ref("blocker"),
    diagnosis: object({
      cause: { type: "string", enum: INTERACTION_CAUSES },
      evidence: array(text(), 32),
    }, ["cause", "evidence"]),
    limitations: array(text(), 32),
  }, ["schemaVersion", "inspectionId", "capturedAt", "pointer", "viewport", "target", "interactionSurface", "blockers", "diagnosis", "limitations"]),
};

const verificationDefinitions = {
  ...commonDefinitions,
  ...causalDefinitions,
  reconciliation: {
    ...object({
      status: { type: "string", enum: RECONCILIATION_STATUSES },
      candidateCount: { type: "integer", minimum: 0, description: "Number of surviving candidates after deterministic identity matching." },
      signals: array(object({
        signal: { type: "string", enum: RECONCILIATION_SIGNALS },
        matched: boolean,
        evidence: { ...text(), description: "Safe bounded explanation without raw user-entered values." },
      }, ["signal", "matched"]), RECONCILIATION_SIGNALS.length),
      target: ref("node"),
    }, ["status", "candidateCount", "signals"]),
    allOf: [
      {
        if: { properties: { status: { enum: ["EXACT", "MATCHED"] } } },
        then: { properties: { candidateCount: { const: 1 }, target: {} }, required: ["target"] },
      },
      {
        if: { properties: { status: { const: "AMBIGUOUS" } } },
        then: { properties: { candidateCount: { type: "integer", minimum: 2 }, target: false } },
      },
      {
        if: { properties: { status: { const: "NOT_FOUND" } } },
        then: { properties: { candidateCount: { const: 0 }, target: false } },
      },
    ],
  },
  surfaceSummary: object({
    reachableSamples: count, blockedSamples: count, outsideShapeSamples: count,
    reachableRatio: ratio, blockedRatio: ratio,
    primaryBlocker: nullable(ref("node")),
  }, ["reachableRatio", "blockedRatio", "primaryBlocker"]),
  safeCore: {
    ...object({
      exists: boolean,
      approximateAreaPx2: nonnegative,
      minimumClearancePx: nonnegative,
      reachableRatio: ratio,
    }, ["exists", "reachableRatio"]),
    allOf: [{
      if: { properties: { exists: { const: true } } },
      then: {
        properties: {
          approximateAreaPx2: { type: "number", exclusiveMinimum: 0 },
          minimumClearancePx: { type: "number", exclusiveMinimum: 0 },
          reachableRatio: { type: "number", exclusiveMinimum: 0 },
        },
      },
    }],
  },
  verification: {
    ...object({
      inspectionId: { ...text(128), minLength: 1, description: "Immutable baseline inspection identifier; verification never overwrites the baseline." },
      lifecycle: object({ sourceChanged: boolean, runtimeChanged: boolean, stableObservations: { type: "integer", minimum: 0 } }, ["sourceChanged", "runtimeChanged", "stableObservations"]),
      verificationId: { ...text(128), minLength: 1 },
      causalExplanation: ref("causality"),
      status: { type: "string", enum: VERIFICATION_STATUSES },
      reconciliation: ref("reconciliation"),
      baseline: ref("surfaceSummary"),
      current: {
        ...nullable(ref("surfaceSummary")),
        description: "Fresh geometry and hit tests after deterministic target reacquisition and layout stabilization; null while unavailable.",
      },
      originalBlockerPresent: { ...nullable(boolean), description: "Deterministically identified original blocker presence; null when unknown." },
      selectionAnchor: {
        type: "string", enum: SELECTION_ANCHOR_STATUSES,
        description: "The old normalized UV point is only a continuity hint. INVALIDATED_BY_REFLOW is compatible with VERIFIED_PASS when the new surface is healthy.",
      },
      reprojectedAnchor: object({ u: ratio, v: ratio, x: number, y: number }, ["u", "v", "x", "y"]),
      safeCore: {
        ...ref("safeCore"),
        description: "Sample-derived reachable interior area and clearance estimates, not exact polygons. A single reachable pixel is insufficient proof of a fix.",
      },
      reasons: { ...array(text(), 32), minItems: 1 },
    }, ["inspectionId", "verificationId", "status", "reconciliation", "baseline", "current", "originalBlockerPresent", "selectionAnchor", "safeCore", "reasons"]),
    allOf: [
      {
        if: { properties: { current: { type: "null" } } },
        then: { properties: { safeCore: { type: "object", properties: { exists: { const: false } } } } },
      },
      {
        if: { properties: { reconciliation: { type: "object", properties: { status: { enum: ["AMBIGUOUS", "NOT_FOUND"] } } } } },
        then: {
          properties: {
            status: { const: "VERIFY_INCONCLUSIVE" }, current: { type: "null" }, originalBlockerPresent: { type: "null" },
            safeCore: { type: "object", properties: { exists: { const: false } } },
          },
        },
      },
      {
        if: { properties: { status: { enum: ["VERIFIED_PASS", "VERIFIED_FAIL"] } } },
        then: {
          properties: {
            reconciliation: { type: "object", properties: { status: { enum: ["EXACT", "MATCHED"] } } },
            current: ref("surfaceSummary"),
          },
        },
      },
      {
        if: { properties: { status: { const: "VERIFIED_PASS" } } },
        then: { properties: { safeCore: { type: "object", properties: { exists: { const: true } } } } },
      },
    ],
  },
};

function responseSchema(resultDefinition: string, definitions: Record<string, object>) {
  return {
    ...object({ ok: boolean, result: ref(resultDefinition), error: ref("error") }, ["ok"]),
    oneOf: [
      { properties: { ok: { const: true }, result: {}, error: false }, required: ["result"] },
      { properties: { ok: { const: false }, error: {}, result: false }, required: ["error"] },
    ],
    $defs: definitions,
  };
}

/** Internal browser verification capture. The daemon validates it before using any evidence. */
export const sensorVerifyResponseSchema = responseSchema("verifyCapture", {
  ...inspectionDefinitions,
  reconciliation: verificationDefinitions.reconciliation,
  verifyCapture: {
    ...object({ reconciliation: ref("reconciliation"), inspection: ref("inspection"), originalBlockerPresent: nullable(boolean) }, ["reconciliation"]),
    allOf: [
      { if: { properties: { reconciliation: { type: "object", properties: { status: { enum: ["EXACT", "MATCHED"] } } } } },
        then: { properties: { inspection: {} }, required: ["inspection"] } },
      { if: { properties: { reconciliation: { type: "object", properties: { status: { enum: ["AMBIGUOUS", "NOT_FOUND"] } } } } },
        then: { properties: { inspection: false } } },
    ],
  },
});

const maxSamples = {
  type: "integer", minimum: 9, maximum: 128, default: 64,
  description: "Maximum browser hit-test samples used to estimate interaction reachability.",
} as const;

export const inspectInteractionTool = {
  name: "inspect_interaction",
  description: "Inspect the UI under the user's captured pointer position and return deterministic browser-runtime reachability, blocker, CSS and ancestor evidence. Runtime hit-testing is authoritative; React/source metadata is optional, best-effort enrichment with explicit provenance. Do not assume the selected target's source file is the culprit: inspect blocker and ancestor evidence before patching. Inspection is observational and never activates or modifies the application.",
  inputSchema: object({
    target: object({ selector: { ...text(1024), minLength: 1, description: "Explicit unique CSS selector for a known target hidden beneath an overlay. Never infer it from the blocker." } }, ["selector"]),
    tabId: {
      type: "integer", minimum: 0,
      description: "Optional browser tab identifier. If omitted, use the currently armed why-ui tab/session.",
    },
    maxSamples,
    includeReactMetadata: { type: "boolean", default: true, description: "Attempt best-effort React Fiber/source metadata enrichment." },
  }, []),
  outputSchema: responseSchema("inspection", inspectionDefinitions),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
} as const;

/** The public MCP view is a compact projection of the separately validated sensor contract. */
export const inspectInteractionMcpOutputSchema = responseSchema("inspectionSlice", {
  ...commonDefinitions, ...causalDefinitions,
  computed: inspectionDefinitions.computed, state: inspectionDefinitions.state,
  sourceReference: object({ file: text(1024), line: { type: "integer", minimum: 1 }, column: { type: "integer", minimum: 0 },
    scope: text(64), certainty: { type: "string", enum: ["exact", "runtime-derived", "symbolicated", "heuristic"] }, property: text(64),
  }, ["file", "scope", "certainty"]),
  sourceResolution: object({ status: { type: "string", enum: ["MAPPED", "UNMAPPED"] }, references: array(ref("sourceReference"), 8), reason: text() }, ["status", "references"]),
  sources: object({ target: ref("sourceResolution"), primaryBlocker: ref("sourceResolution"), ancestors: array(ref("sourceReference"), 6), css: array(ref("sourceReference"), 16) }, ["target", "primaryBlocker", "ancestors", "css"]),
  inspectionSlice: object({
    schemaVersion: { type: "string", const: "why-ui/inspection@1" }, inspectionId: { ...text(128), minLength: 1 }, capturedAt: nonnegative,
    target: object({ interactionTarget: ref("node"), selectionMethod: inspectionDefinitions.inspection.properties.target.properties.selectionMethod,
      computed: ref("computed"), state: ref("state") }, ["interactionTarget", "selectionMethod", "computed", "state"]),
    primaryBlocker: nullable(object({ node: ref("node"), computed: ref("computed"), state: ref("state"), blockedSamples: count, blockedRatio: ratio }, ["node", "computed", "state", "blockedSamples", "blockedRatio"])),
    interactionSurface: object({ totalSamples: count, reachableSamples: count, blockedSamples: count, outsideShapeSamples: count,
      unresolvedSamples: count, outsideViewportSamples: count, reachableRatio: ratio, blockedRatio: ratio, eligibleSamples: count,
    }, ["totalSamples", "reachableSamples", "blockedSamples", "outsideShapeSamples", "unresolvedSamples", "outsideViewportSamples", "reachableRatio", "blockedRatio", "eligibleSamples"]),
    diagnosis: inspectionDefinitions.inspection.properties.diagnosis, causalExplanation: ref("causality"), sources: ref("sources"), limitations: array(text(), 32),
  }, ["schemaVersion", "inspectionId", "capturedAt", "target", "primaryBlocker", "interactionSurface", "diagnosis", "causalExplanation", "sources", "limitations"]),
});

/**
 * The daemon retains immutable baselines and implements this verification contract.
 * Reacquire by deterministic identity signals, wait for stable layout within the timeout,
 * reconstruct fresh client rects and hit-test samples, and evaluate a sufficiently reachable
 * safe core. Never call click(), synthesize events, focus, or scroll the application.
 * Ambiguous identity or unavailable/still-changing geometry is inconclusive. Reflow can
 * invalidate the old UV anchor without failing a healthy reconstructed interaction surface.
 * Thresholds and a timeout cannot themselves manufacture proof of success or failure.
 */
export const verifyFixTool = {
  name: "verify_fix",
  description: "Observationally verify a fix against an immutable inspection baseline after code changes/HMR. Deterministically reacquire the original target using runtime/source identity, owner, React key, tag, role, accessible name, stable ID/classes and ancestry/text fingerprints; never use an LLM to guess identity. AMBIGUOUS or NOT_FOUND identity means VERIFY_INCONCLUSIVE. Rebuild geometry and browser hit tests after layout stabilizes, and require a sufficiently reachable safe core rather than one clickable pixel. The old UV anchor is only a continuity hint: INVALIDATED_BY_REFLOW may still yield VERIFIED_PASS. Distinguish VERIFIED_PASS, VERIFIED_FAIL and VERIFY_INCONCLUSIVE; timeout or insufficient evidence is inconclusive. Never click, dispatch interaction events, focus, scroll, or otherwise activate the application.",
  inputSchema: object({
    inspectionId: {
      type: "string", minLength: 1, maxLength: 128,
      description: "The immutable baseline inspection identifier returned by inspect_interaction.",
    },
    maxSamples,
    stabilizationTimeoutMs: {
      type: "integer", minimum: 100, maximum: 10000, default: 3000,
      description: "Maximum time allowed for target reacquisition and post-HMR layout stabilization.",
    },
  }, ["inspectionId"]),
  outputSchema: responseSchema("verification", verificationDefinitions),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
} as const;
