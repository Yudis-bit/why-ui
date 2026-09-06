/** All public results contain JSON data only; DOM/Fiber identities stay in the sensor. */
export const WHY_UI_ERROR_CODES = [
  "NO_POINTER_CAPTURED", "NO_TARGET_AT_POINT", "TAB_NOT_CONNECTED",
  "SENSOR_NOT_AVAILABLE", "TARGET_NOT_FOUND", "TARGET_AMBIGUOUS",
  "RUNTIME_CHANGED_DURING_CAPTURE", "UNSUPPORTED_RUNTIME", "INVALID_OPTIONS",
  "INTERNAL_SENSOR_ERROR",
  "BRIDGE_NOT_CONNECTED", "BRIDGE_AUTH_FAILED", "REQUEST_TIMEOUT",
  "INVALID_SENSOR_PAYLOAD", "INTERNAL_BRIDGE_ERROR",
] as const;
export type WhyUiErrorCode = (typeof WHY_UI_ERROR_CODES)[number];
export interface WhyUiError { code: WhyUiErrorCode; message?: string }
export type RuntimeResponse<T> = { ok: true; result: T } | { ok: false; error: WhyUiError };

export interface BrowserSession {
  sessionId: string;
  tabId: number;
  frameId?: number;
  url?: string;
  armedAt: number;
}

export interface RuntimeRect {
  x: number; y: number; width: number; height: number;
  top: number; right: number; bottom: number; left: number;
}
export interface RuntimeNodePathSegment {
  tagName: string; id?: string; classes?: string[]; nthOfType?: number;
}
export interface RuntimeNodeDescriptor {
  tagName: string; id?: string; classes?: string[]; role?: string;
  /** A bounded label hint, not a complete accessible-name computation. */
  name?: string;
  textPreview?: string;
  /** Diagnostic hint only. Shadow boundaries use ` >>> `, which is not CSS syntax. */
  selectorHint: string;
  attributes?: Record<string, string>;
  rect: RuntimeRect;
  domPath: RuntimeNodePathSegment[];
}
export const COMPUTED_STYLE_PROPERTIES = [
  "display", "visibility", "opacity", "pointer-events", "position", "z-index",
  "transform", "filter", "perspective", "isolation", "contain", "will-change",
  "mix-blend-mode", "clip-path", "overflow", "overflow-x", "overflow-y",
  "content-visibility",
] as const;
export type RelevantComputedStyles = Record<(typeof COMPUTED_STYLE_PROPERTIES)[number], string>;
export interface RuntimeElementState {
  /** Includes native disabled inheritance, such as a disabled fieldset. */
  disabled: boolean;
  /** Includes composed ancestors. */
  inert: boolean;
  ariaDisabled: boolean;
  /** Computed display:none/content-visibility:hidden, including bounded ancestors.
   * The hidden attribute is retained separately as evidence; CSS can override it.
   */
  hidden: boolean;
}
export interface RuntimeNodeEvidence {
  node: RuntimeNodeDescriptor;
  computed: RelevantComputedStyles;
  state: RuntimeElementState;
  react?: ReactRuntimeMetadata;
  css?: CssDeclarationCandidate[];
  paint?: RuntimePaintEvidence;
}
export interface RuntimePaintEvidence {
  topLayer?: "modal" | "popover" | "fullscreen";
  pseudoElementOrigin?: boolean;
  /** Extra context triggers outside the core computed-style whitelist. */
  extraTriggers?: Array<{ property: string; value: string }>;
  uncertain3D?: boolean;
}
export const PAINT_CAUSES = ["DIRECT_Z_INDEX", "STACKING_CONTEXT_TRAP", "SAME_CONTEXT_PAINT_ORDER",
  "TOP_LAYER", "PSEUDO_ELEMENT_ORIGIN", "UNKNOWN_PAINT_CAUSE"] as const;
export interface StackingContextEvidence {
  node: RuntimeNodeDescriptor;
  triggers: Array<{ property: string; value: string }>;
}
export interface CausalExplanation {
  cause: (typeof PAINT_CAUSES)[number];
  evidence: string[];
  targetContext?: StackingContextEvidence;
  blockerContext?: StackingContextEvidence;
  constrainingStackingContext?: StackingContextEvidence;
}
export interface CssDeclarationCandidate {
  property: string;
  value: string;
  selector: string;
  stylesheet?: string;
  /** CSSOM proves a matching declaration, not that it won the cascade. */
  certainty: "runtime-derived";
}
export const REACT_PROVENANCE = [
  "dom-fiber-property", "devtools-hook", "fiber-debug-source", "fiber-debug-stack",
  "fiber-debug-owner", "fiber-return-chain", "fiber-type",
] as const;
export type ReactProvenance = (typeof REACT_PROVENANCE)[number];
export interface ReactSourceHint {
  file?: string; line?: number; column?: number;
  scope: "host-jsx" | "component-owner" | "component-definition" | "candidate";
  certainty: "exact" | "runtime-derived" | "symbolication-needed" | "heuristic";
  provenance: ReactProvenance;
}
export interface ReactRuntimeMetadata {
  detected: boolean;
  provenance?: ReactProvenance[];
  version?: string;
  componentName?: string;
  ownerChain?: string[];
  source?: ReactSourceHint;
  sources?: ReactSourceHint[];
  reactKey?: string | null;
}
export interface CapturedPointer {
  clientX: number; clientY: number; pageX: number; pageY: number;
  pointerType: string; timestamp: number;
}
export const SAMPLE_CLASSIFICATIONS = [
  "reachable", "blocked", "outside-target-shape", "outside-viewport", "unresolved",
] as const;
/** unresolved denotes exhausted ancestry/hit-stack bounds or unavailable shadow evidence. */
export type SampleClassification = (typeof SAMPLE_CLASSIFICATIONS)[number];
export interface InteractionSample {
  x: number; y: number;
  classification: SampleClassification;
  /** Fraction of sampled client-rect area represented by this point. */
  weight: number;
  /** Index into the coverage-ranked blockers array. */
  blockerIndex?: number;
  cell?: { left: number; top: number; right: number; bottom: number };
}
export interface InteractionSurface {
  /** outsideSamples includes unresolved points; inspect per-sample classifications. */
  totalSamples: number; reachableSamples: number; blockedSamples: number; outsideSamples: number;
  /** Area-weighted estimates conditional on samples that hit the target family. */
  reachableRatio: number; blockedRatio: number;
  /** Zero eligible samples means unknown reachability, not a healthy surface. */
  eligibleSamples: number;
  sampledClientRects: number;
  clientRectsTruncated: boolean;
  samples: InteractionSample[];
}
export interface InteractionBlocker extends RuntimeNodeEvidence {
  blockedSamples: number;
  /** Same denominator as interactionSurface.blockedRatio. */
  blockedRatio: number;
  representativePoint: { x: number; y: number };
  ancestors: RuntimeNodeEvidence[];
  react?: ReactRuntimeMetadata;
}
export const INTERACTION_CAUSES = [
  "TARGET_DISABLED", "TARGET_INERT", "TARGET_POINTER_EVENTS_NONE", "TARGET_HIDDEN",
  "TARGET_ZERO_GEOMETRY", "FOREIGN_OCCLUSION", "PARTIAL_FOREIGN_OCCLUSION",
  "OUTSIDE_VIEWPORT", "UNKNOWN",
] as const;
export type InteractionCause = (typeof INTERACTION_CAUSES)[number];
export interface InteractionInspectionResult {
  runtime?: RuntimeRevision;
  runtimeTargetId?: string;
  schemaVersion: "why-ui/interaction@1";
  inspectionId: string;
  capturedAt: number;
  pointer: CapturedPointer;
  viewport: { width: number; height: number; devicePixelRatio: number; scrollX: number; scrollY: number };
  target: {
    /** Null is possible for an explicit selector hint whose pointer hits nothing. */
    rawHit: RuntimeNodeDescriptor | null;
    interactionTarget: RuntimeNodeDescriptor;
    selectionMethod: "pointer-hit" | "selector-hint" | "reconciled";
    computed: RelevantComputedStyles;
    state: RuntimeElementState;
    ancestors: RuntimeNodeEvidence[];
    react?: ReactRuntimeMetadata;
    css?: CssDeclarationCandidate[];
    paint?: RuntimePaintEvidence;
  };
  interactionSurface: InteractionSurface;
  blockers: InteractionBlocker[];
  primaryBlocker?: InteractionBlocker;
  diagnosis: { cause: InteractionCause; evidence: string[] };
  limitations: string[];
}
export interface InspectInteractionRequest {
  /** Explicit prior identity for an otherwise hidden target. */
  target?: { selector: string };
  tabId?: number;
  maxSamples?: number;
  includeReactMetadata?: boolean;
}
export interface RuntimeRevision {
  documentId: string;
  revision: number;
  readyState: "loading" | "interactive" | "complete";
}
export interface SensorInspectionOptions {
  maxSamples?: number;
  includeReactMetadata?: boolean;
  /** Sensor-only hint for a previously identified target; must match exactly one element.
   * Never inferred from a foreign overlay. Ordinary CSS selectors, light DOM only.
   */
  targetSelector?: string;
}
export type SensorRequest =
  | { operation: "install" }
  | { operation: "inspect"; options?: SensorInspectionOptions }
  | { operation: "verify"; baseline: TargetIdentityBaseline; options?: SensorInspectionOptions }
  | { operation: "dispose" };
export type SensorResponse = RuntimeResponse<
  InteractionInspectionResult | { installed: boolean } | SensorVerificationCapture
>;
export interface TargetIdentityBaseline {
  node: RuntimeNodeDescriptor;
  react?: ReactRuntimeMetadata;
  documentId?: string;
  runtimeTargetId?: string;
  pointer: CapturedPointer;
  blocker?: RuntimeNodeDescriptor;
}
export interface SensorVerificationCapture {
  reconciliation: TargetReconciliationResult;
  inspection?: InteractionInspectionResult;
  originalBlockerPresent?: boolean | null;
}

export const VERIFICATION_STATUSES = ["VERIFIED_PASS", "VERIFIED_FAIL", "VERIFY_INCONCLUSIVE"] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];
export const RECONCILIATION_STATUSES = ["EXACT", "MATCHED", "AMBIGUOUS", "NOT_FOUND"] as const;
export const RECONCILIATION_SIGNALS = [
  "source-runtime-identity", "component-owner", "react-key", "tag", "role",
  "accessible-name", "stable-id", "stable-classes", "ancestry-fingerprint", "text-fingerprint",
  "relative-structure",
] as const;
export interface TargetReconciliationResult {
  status: (typeof RECONCILIATION_STATUSES)[number];
  candidateCount: number;
  signals: Array<{
    signal: (typeof RECONCILIATION_SIGNALS)[number];
    matched: boolean;
    /** Bounded explanation; omit raw user text/values. */
    evidence?: string;
  }>;
  target?: RuntimeNodeDescriptor;
}
export const SELECTION_ANCHOR_STATUSES = ["VALID", "INVALIDATED_BY_REFLOW", "UNAVAILABLE"] as const;
export interface SafeCoreResult {
  /** Sample-derived contiguous interior estimate, not exact polygon geometry. */
  exists: boolean;
  approximateAreaPx2?: number;
  minimumClearancePx?: number;
  reachableRatio: number;
}
export interface VerificationSurfaceSummary {
  reachableSamples?: number;
  blockedSamples?: number;
  outsideShapeSamples?: number;
  reachableRatio: number;
  blockedRatio: number;
  primaryBlocker: RuntimeNodeDescriptor | null;
}
export interface VerifyFixRequest {
  inspectionId: string;
  maxSamples?: number;
  stabilizationTimeoutMs?: number;
}
export interface VerificationResult {
  causalExplanation?: CausalExplanation;
  lifecycle?: { sourceChanged: boolean; runtimeChanged: boolean; stableObservations: number };
  inspectionId: string;
  verificationId: string;
  status: VerificationStatus;
  reconciliation: TargetReconciliationResult;
  baseline: VerificationSurfaceSummary;
  /** Null until identity and fresh geometry have been established. */
  current: VerificationSurfaceSummary | null;
  /** Null when identity/evidence is insufficient. Never guess blocker identity. */
  originalBlockerPresent: boolean | null;
  selectionAnchor: (typeof SELECTION_ANCHOR_STATUSES)[number];
  /** UV is a continuity hint only, never the primary pass/fail assertion. */
  reprojectedAnchor?: { u: number; v: number; x: number; y: number };
  safeCore: SafeCoreResult;
  reasons: string[];
}
export type InspectInteractionResponse = RuntimeResponse<InteractionInspectionResult>;
export type VerifyFixResponse = RuntimeResponse<VerificationResult>;
