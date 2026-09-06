import * as crypto from "node:crypto";
import { setTimeout as pollAfter } from "node:timers/promises";
import type { InteractionInspectionResult, VerificationResult, VerificationSurfaceSummary, VerifyFixRequest, VerifyFixResponse } from "../types.js";
import type { BridgeServer } from "./bridge-server.js";
import { WorkspaceObserver, runtimeChanged, runtimeSignature, targetIdentity } from "./workspace.js";
import { safeCore } from "./safe-core.js";
import { explainCausality } from "./causality.js";

export function surfaceSummary(result: InteractionInspectionResult): VerificationSurfaceSummary {
  const surface = result.interactionSurface;
  return { reachableSamples: surface.reachableSamples, blockedSamples: surface.blockedSamples,
    outsideShapeSamples: surface.samples.filter(s => s.classification === "outside-target-shape").length,
    reachableRatio: surface.reachableRatio, blockedRatio: surface.blockedRatio, primaryBlocker: result.primaryBlocker?.node ?? null };
}
export class VerificationService {
  private active = 0;
  private readonly workspace: WorkspaceObserver;
  constructor(private readonly bridge: BridgeServer) { this.workspace = new WorkspaceObserver(bridge.workspace); }
  async verify(request: VerifyFixRequest): Promise<VerifyFixResponse> {
    if (this.active >= 4) return { ok: false, error: { code: "REQUEST_TIMEOUT", message: "Verification capacity reached." } };
    this.active++;
    try { return await this.run(request); }
    finally { this.active--; }
  }
  private async run(request: VerifyFixRequest): Promise<VerifyFixResponse> {
    const baseline = this.bridge.inspectionStore.get(request.inspectionId), metadata = this.bridge.inspectionStore.baseline(request.inspectionId);
    if (!baseline || !metadata) return { ok: false, error: { code: "INVALID_OPTIONS", message: "Baseline not found or evicted. Call inspect_interaction again." } };
    const result: VerificationResult = { inspectionId: request.inspectionId, verificationId: crypto.randomUUID(), status: "VERIFY_INCONCLUSIVE",
      reconciliation: { status: "NOT_FOUND", candidateCount: 0, signals: [] }, baseline: surfaceSummary(baseline), current: null,
      originalBlockerPresent: null, selectionAnchor: "UNAVAILABLE", safeCore: { exists: false, reachableRatio: 0 },
      reasons: ["No source patch was observed within the readiness deadline."], lifecycle: { sourceChanged: false, runtimeChanged: false, stableObservations: 0 } };
    if (baseline.diagnosis.cause === "UNKNOWN") { result.reasons = ["The baseline did not establish a supported failure condition."]; return { ok: true, result }; }
    if (!metadata.revision.complete) { result.reasons = ["The baseline workspace snapshot exceeded a resource bound."]; return { ok: true, result }; }
    const deadline = Date.now() + (request.stabilizationTimeoutMs ?? 3000);
    let previous = "", stable = 0;
    while (Date.now() < deadline) {
      const session = this.bridge.getActiveSession();
      if (!session || session.sessionId !== metadata.session.sessionId || session.tabId !== metadata.session.tabId) {
        result.reasons = ["The baseline tab is no longer armed or its bridge disconnected."]; break;
      }
      const revision = await this.workspace.capture(metadata.revision.files.map(file => file.file));
      const sourceChanged = revision.complete && revision.fingerprint !== metadata.revision.fingerprint;
      result.lifecycle!.sourceChanged = sourceChanged;
      if (!sourceChanged) { await pollAfter(Math.max(1, Math.min(100, deadline - Date.now()))); continue; }
      const response = await this.bridge.sendVerifyRequest(targetIdentity(baseline), request.maxSamples ?? 64, Math.max(1, deadline - Date.now()));
      if (!response.ok || !("reconciliation" in response.result)) {
        result.reasons = [!response.ok ? `Fresh browser evidence unavailable: ${response.error.code}.` : "Unexpected verification capture."];
        if (!response.ok && ["BRIDGE_NOT_CONNECTED", "INVALID_SENSOR_PAYLOAD", "TAB_NOT_CONNECTED"].includes(response.error.code)) break;
        stable = 0; previous = "";
      } else {
        const capture = response.result, current = capture.inspection;
        result.reconciliation = capture.reconciliation;
        if (!current) {
          result.current = null; result.originalBlockerPresent = null;
          result.reasons = [capture.reconciliation.status === "AMBIGUOUS" ? "Multiple target candidates remain within the identity margin." : "The original target cannot be reacquired."];
          stable = 0; previous = "";
        } else {
          const changed = runtimeChanged(baseline, current);
          result.lifecycle!.runtimeChanged = changed;
          const signature = `${revision.fingerprint}\n${runtimeSignature(current)}`;
          stable = changed && current.runtime?.readyState !== "loading" ? (signature === previous ? stable + 1 : 1) : 0;
          previous = signature; result.lifecycle!.stableObservations = stable;
          result.reasons = [changed ? "The post-patch surface has not stabilized within the deadline." : "Source changed, but no browser runtime update was observed."];
          if (stable >= 3) {
            result.current = surfaceSummary(current); result.originalBlockerPresent = capture.originalBlockerPresent ?? null;
            result.safeCore = safeCore(current);
            result.causalExplanation = explainCausality(current);
            if (metadata.anchor) {
              const { u, v } = metadata.anchor, rect = current.target.interactionTarget.rect;
              result.reprojectedAnchor = { u, v, x: rect.left + u * rect.width, y: rect.top + v * rect.height };
              const old = baseline.target.interactionTarget.rect;
              result.selectionAnchor = ["left", "top", "width", "height"].some(key => Math.abs(rect[key as keyof typeof rect] - old[key as keyof typeof old]) > 0.5)
                ? "INVALIDATED_BY_REFLOW" : "VALID";
            }
            if (current.interactionSurface.blockedSamples > 0 || current.diagnosis.cause !== "UNKNOWN") {
              result.status = "VERIFIED_FAIL";
              result.reasons = [current.interactionSurface.blockedSamples > 0 ? "Fresh browser hits still prove foreign occlusion; current.primaryBlocker identifies the remaining blocker." : `Fresh runtime evidence still proves ${current.diagnosis.cause}.`];
            } else if (current.target.state.disabled || current.target.state.inert || current.target.state.ariaDisabled || current.target.state.hidden) {
              result.reasons = ["Target state does not establish an enabled interaction surface."];
            } else if (!result.safeCore.exists) {
              result.reasons = ["Fresh samples do not establish a sufficiently large connected safe interior."];
            } else {
              result.status = "VERIFIED_PASS";
              result.reasons = ["The target reconciled, the source and browser changed, three fresh surfaces stabilized, and no sampled blocker remains. A connected sampled safe interior exceeds 64 px² with at least 4 px clearance."];
            }
            return { ok: true, result };
          }
        }
      }
      await pollAfter(Math.max(1, Math.min(100, deadline - Date.now())));
    }
    return { ok: true, result };
  }
}
