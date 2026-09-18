import type { RuntimeNodeDescriptor, VerificationResult } from "../types.js";
import type { inspectionSlice } from "./mcp-result.js";
import type { SourceResolution } from "./source-resolver.js";
const clean = (value: string) => value.replace(/[\u0000-\u001f\u007f]/g, " ");
const percent = (value: number) => `${Math.round(value * 100)}%`;
const node = (value: RuntimeNodeDescriptor) => clean(`${value.tagName}${value.id ? `#${value.id}` : ""}`);
function source(value: SourceResolution): string {
  const ref = value.references[0];
  return ref ? clean(`${ref.file}${ref.line ? `:${ref.line}` : ""} [${ref.certainty}]`) : "UNMAPPED";
}
export function formatInspection(value: ReturnType<typeof inspectionSlice>): string {
  return ["TARGET", node(value.target.interactionTarget), source(value.sources.target), "",
    `${percent(value.interactionSurface.blockedRatio)} BLOCKED · ${percent(value.interactionSurface.reachableRatio)} REACHABLE (sampled)`, "",
    "CULPRIT", value.primaryBlocker ? node(value.primaryBlocker.node) : "No proven foreign blocker",
    ...(value.primaryBlocker ? [source(value.sources.primaryBlocker)] : []), "",
    "WHY", value.diagnosis.cause, value.causalExplanation.cause,
    ...value.limitations.slice(0, 2).map(clean), "", `inspectionId: ${value.inspectionId}`].join("\n");
}
export function formatVerification(value: VerificationResult): string {
  return [value.status,
    `blocked   ${percent(value.baseline.blockedRatio)} → ${value.current ? percent(value.current.blockedRatio) : "UNKNOWN"}`,
    `reachable ${percent(value.baseline.reachableRatio)} → ${value.current ? percent(value.current.reachableRatio) : "UNKNOWN"}`,
    "Ratios are sampled estimates.", `Target: ${value.reconciliation.status}`,
    `Safe Core: ${value.safeCore.exists ? "established" : "not established"}`,
    ...value.reasons.map(clean), `inspectionId: ${value.inspectionId}`].join("\n");
}
