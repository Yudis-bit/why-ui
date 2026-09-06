import type { CausalExplanation, InteractionInspectionResult, RuntimeNodeEvidence, StackingContextEvidence } from "../types.js";

/** Explains a captured winner. This does not predict paint order or replace browser hits. */
export function contextTriggers(item: RuntimeNodeEvidence, parent?: RuntimeNodeEvidence): StackingContextEvidence["triggers"] {
  const s = item.computed, triggers: StackingContextEvidence["triggers"] = [];
  const add = (property: string, value = s[property as keyof typeof s]) => triggers.push({ property, value });
  if (item.node.tagName === "html") add("root", "document");
  if (["fixed", "sticky"].includes(s.position)) add("position");
  if (s["z-index"] !== "auto" && (s.position !== "static" || /^(inline-)?(flex|grid)$/.test(parent?.computed.display ?? ""))) {
    if (s.position === "static") add("parent-display", parent!.computed.display);
    else if (!["fixed", "sticky"].includes(s.position)) add("position");
    add("z-index");
  }
  if (Number.isFinite(Number(s.opacity)) && Number(s.opacity) < 1) add("opacity");
  for (const key of ["transform", "filter", "perspective", "clip-path"] as const) if (s[key] && s[key] !== "none") add(key);
  if (s.isolation === "isolate") add("isolation");
  if (/(^|\s)(layout|paint|strict|content)(\s|$)/.test(s.contain)) add("contain");
  if (s["mix-blend-mode"] !== "normal") add("mix-blend-mode");
  if (s["will-change"].split(/,\s*/).some(v => ["opacity", "transform", "filter", "perspective", "clip-path", "mask", "mask-image", "isolation", "mix-blend-mode", "translate", "rotate", "scale", "backdrop-filter"].includes(v))) add("will-change");
  if (item.paint?.topLayer) add("top-layer", item.paint.topLayer);
  triggers.push(...(item.paint?.extraTriggers ?? []));
  return triggers;
}

export function explainCausality(inspection: InteractionInspectionResult): CausalExplanation {
  const result: CausalExplanation = { cause: "UNKNOWN_PAINT_CAUSE", evidence: [] };
  const blocker = inspection.primaryBlocker;
  if (!blocker || inspection.interactionSurface.blockedSamples === 0) {
    result.evidence.push("No foreign hit was established; no paint-order cause is claimed."); return result;
  }
  result.evidence.push("Browser elementsFromPoint placed the primary blocker ahead of the target family at captured samples.");
  const target: RuntimeNodeEvidence = { node: inspection.target.interactionTarget, computed: inspection.target.computed,
    state: inspection.target.state, ...(inspection.target.paint ? { paint: inspection.target.paint } : {}) };
  const targetChain = [...inspection.target.ancestors].reverse().concat(target);
  const blockerChain = [...blocker.ancestors].reverse().concat(blocker);
  const contexts = (chain: RuntimeNodeEvidence[]) => chain.flatMap((item, index) => {
    const triggers = contextTriggers(item, chain[index - 1]);
    return triggers.length ? [{ node: item.node, triggers, index }] : [];
  });
  const tc = contexts(targetChain), bc = contexts(blockerChain);
  const compact = (value: typeof tc[number]): StackingContextEvidence => ({ node: value.node, triggers: value.triggers });
  const top = bc.find(c => c.triggers.some(t => t.property === "top-layer"));
  if (top && !tc.some(c => c.triggers.some(t => t.property === "top-layer"))) {
    result.cause = "TOP_LAYER"; result.blockerContext = compact(top);
    result.evidence.push("The blocker belongs to a browser-reported top-layer element."); return result;
  }
  if (blocker.paint?.pseudoElementOrigin) {
    result.cause = "PSEUDO_ELEMENT_ORIGIN";
    result.evidence.push("A hit outside an empty origin element's box coincides with an active generated pseudo-element. The browser returns its origin element."); return result;
  }
  if (targetChain[0]?.node.tagName !== "html" || blockerChain[0]?.node.tagName !== "html" ||
    [...targetChain, ...blockerChain].some(item => item.paint?.uncertain3D)) {
    result.evidence.push("The context chain is incomplete or involves 3D transforms; the paint cause remains unknown."); return result;
  }
  let common = -1;
  for (let i = 0; i < Math.min(targetChain.length, blockerChain.length); i++) {
    const a = targetChain[i]!.node, b = blockerChain[i]!.node;
    if (a.selectorHint !== b.selectorHint || JSON.stringify(a.domPath) !== JSON.stringify(b.domPath)) break;
    common = i;
  }
  if (common < 0) return result;
  const targetBranch = tc.find(c => c.index > common), blockerBranch = bc.find(c => c.index > common);
  const shared = tc.filter(c => c.index <= common).at(-1);
  if (targetBranch) result.targetContext = compact(targetBranch);
  else if (shared) result.targetContext = compact(shared);
  if (blockerBranch) result.blockerContext = compact(blockerBranch);
  else if (shared) result.blockerContext = compact(shared);
  if (targetBranch && targetBranch.index < targetChain.length - 1) {
    result.cause = "STACKING_CONTEXT_TRAP";
    result.constrainingStackingContext = compact(targetBranch);
    result.evidence.push("The target is constrained by an ancestor stacking context. Its local z-index cannot cross that context; all captured triggers are reported.");
  } else if (targetBranch && blockerBranch) {
    const z = (value: typeof tc[number]) => value.triggers.find(t => t.property === "z-index")?.value;
    const tz = z(targetBranch), bz = z(blockerBranch);
    if (tz !== undefined && bz !== undefined && /^-?\d+$/.test(tz) && /^-?\d+$/.test(bz) && Number(bz) > Number(tz)) {
      result.cause = "DIRECT_Z_INDEX";
      result.evidence.push("The competing contexts share a parent context and the observed winner has the greater numeric z-index.");
    }
  } else if (!targetBranch && !blockerBranch && shared) {
    result.cause = "SAME_CONTEXT_PAINT_ORDER";
    result.evidence.push("Both elements participate in the same captured stacking context. The browser establishes the winner; detailed paint phases are not reconstructed.");
  }
  return result;
}
