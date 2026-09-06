import type { InteractionInspectionResult, InteractionSample, SafeCoreResult } from "../types.js";

type Cell = NonNullable<InteractionSample["cell"]>;
const overlap = (a: number, b: number, c: number, d: number): number => Math.min(b, d) - Math.max(a, c);
const touches = (a: Cell, b: Cell): boolean =>
  ((Math.abs(a.right - b.left) < 0.01 || Math.abs(b.right - a.left) < 0.01) && overlap(a.top, a.bottom, b.top, b.bottom) > 0.01) ||
  ((Math.abs(a.bottom - b.top) < 0.01 || Math.abs(b.bottom - a.top) < 0.01) && overlap(a.left, a.right, b.left, b.right) > 0.01);

/** Conservative sampled interior estimate. It is not an exact polygon or pixel guarantee. */
export function safeCore(inspection: InteractionInspectionResult): SafeCoreResult {
  const surface = inspection.interactionSurface;
  const empty: SafeCoreResult = { exists: false, approximateAreaPx2: 0, minimumClearancePx: 0, reachableRatio: surface.reachableRatio };
  if (surface.clientRectsTruncated || surface.samples.length > 128 || surface.samples.some(s => !s.cell || s.classification === "unresolved")) return empty;
  const samples = surface.samples;
  const reachable = samples.filter(s => s.classification === "reachable" && s.cell);
  // Reject overlapping fragment interiors: their cell adjacency is not a reliable surface union.
  if (samples.some((a, i) => samples.slice(i + 1).some(b => overlap(a.cell!.left, a.cell!.right, b.cell!.left, b.cell!.right) > 0.01 &&
      overlap(a.cell!.top, a.cell!.bottom, b.cell!.top, b.cell!.bottom) > 0.01))) return empty;
  const bounds = inspection.target.interactionTarget.rect;
  const interior = reachable.map(sample => {
    const cell = sample.cell!;
    const neighbours = reachable.filter(other => other !== sample && touches(cell, other.cell!));
    // Erode one sampled boundary ring on all four sides. A reachable isolated point never suffices.
    const enclosed = neighbours.some(s => Math.abs(s.cell!.right - cell.left) < 0.01) && neighbours.some(s => Math.abs(s.cell!.left - cell.right) < 0.01) &&
      neighbours.some(s => Math.abs(s.cell!.bottom - cell.top) < 0.01) && neighbours.some(s => Math.abs(s.cell!.top - cell.bottom) < 0.01);
    let clearance = Math.min(sample.x - bounds.left, bounds.right - sample.x, sample.y - bounds.top, bounds.bottom - sample.y);
    for (const other of samples.filter(s => s.classification !== "reachable")) {
      const c = other.cell!;
      const dx = Math.max(c.left - sample.x, 0, sample.x - c.right), dy = Math.max(c.top - sample.y, 0, sample.y - c.bottom);
      clearance = Math.min(clearance, Math.hypot(dx, dy));
    }
    return { sample, clearance, enclosed };
  }).filter(c => c.enclosed && c.clearance >= 4);
  const unseen = new Set(interior); let largest: typeof interior = [];
  while (unseen.size) {
    const first = unseen.values().next().value!; unseen.delete(first); const component = [first];
    for (let i = 0; i < component.length; i++) {
      for (const candidate of unseen) if (touches(component[i]!.sample.cell!, candidate.sample.cell!)) { unseen.delete(candidate); component.push(candidate); }
    }
    const area = (group: typeof interior): number => group.reduce((sum, c) => sum + (c.sample.cell!.right - c.sample.cell!.left) * (c.sample.cell!.bottom - c.sample.cell!.top), 0);
    if (area(component) > area(largest)) largest = component;
  }
  const approximateAreaPx2 = largest.reduce((sum, c) => sum + (c.sample.cell!.right - c.sample.cell!.left) * (c.sample.cell!.bottom - c.sample.cell!.top), 0);
  const minimumClearancePx = largest.length ? Math.min(...largest.map(c => c.clearance)) : 0;
  return { exists: largest.length >= 4 && approximateAreaPx2 >= 64 && minimumClearancePx >= 4, approximateAreaPx2, minimumClearancePx, reachableRatio: surface.reachableRatio };
}
