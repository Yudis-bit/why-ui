import type { InteractionInspectionResult } from "../types.js";
import type { InspectionSources } from "./source-resolver.js";
import { explainCausality } from "./causality.js";

export function inspectionSlice(result: InteractionInspectionResult, sources: InspectionSources) {
  const s = result.interactionSurface, blocker = result.primaryBlocker;
  return {
    schemaVersion: "why-ui/inspection@1", inspectionId: result.inspectionId, capturedAt: result.capturedAt,
    target: { interactionTarget: result.target.interactionTarget, selectionMethod: result.target.selectionMethod,
      computed: result.target.computed, state: result.target.state },
    primaryBlocker: blocker ? { node: blocker.node, computed: blocker.computed, state: blocker.state,
      blockedSamples: blocker.blockedSamples, blockedRatio: blocker.blockedRatio } : null,
    interactionSurface: { totalSamples: s.totalSamples, reachableSamples: s.reachableSamples, blockedSamples: s.blockedSamples,
      outsideShapeSamples: s.samples.filter(p => p.classification === "outside-target-shape").length,
      unresolvedSamples: s.samples.filter(p => p.classification === "unresolved").length,
      outsideViewportSamples: s.samples.filter(p => p.classification === "outside-viewport").length,
      reachableRatio: s.reachableRatio, blockedRatio: s.blockedRatio, eligibleSamples: s.eligibleSamples },
    diagnosis: result.diagnosis, causalExplanation: explainCausality(result), sources, limitations: result.limitations,
  };
}
