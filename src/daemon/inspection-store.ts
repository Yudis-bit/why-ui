import type { InteractionInspectionResult } from "../types.js";

import type { InspectionBaseline } from "./workspace.js";

export class InspectionStore {
  private readonly maxEntries: number;
  private readonly store = new Map<string, InteractionInspectionResult>();
  private readonly baselines = new Map<string, InspectionBaseline>();

  constructor(maxEntries = 100) {
    this.maxEntries = Math.max(1, Math.min(100, Math.floor(maxEntries) || 100));
  }

  set(inspectionId: string, result: InteractionInspectionResult): void {
    if (this.store.has(inspectionId)) {
      this.store.delete(inspectionId);
      this.baselines.delete(inspectionId);
    } else if (this.store.size >= this.maxEntries) {
      // Evict oldest entry (first key in insertion order)
      const oldestKey = this.store.keys().next().value;
      if (oldestKey !== undefined) {
        this.store.delete(oldestKey);
        this.baselines.delete(oldestKey);
      }
    }
    this.store.set(inspectionId, structuredClone(result));
  }

  get(inspectionId: string): InteractionInspectionResult | undefined {
    const value = this.store.get(inspectionId);
    return value ? structuredClone(value) : undefined;
  }

  has(inspectionId: string): boolean {
    return this.store.has(inspectionId);
  }

  delete(inspectionId: string): boolean {
    this.baselines.delete(inspectionId);
    return this.store.delete(inspectionId);
  }

  clear(): void {
    this.store.clear();
    this.baselines.clear();
  }

  get size(): number {
    return this.store.size;
  }
  setBaseline(inspectionId: string, baseline: InspectionBaseline): void {
    if (this.store.has(inspectionId) && !this.baselines.has(inspectionId)) this.baselines.set(inspectionId, structuredClone(baseline));
  }
  baseline(inspectionId: string): InspectionBaseline | undefined {
    const value = this.baselines.get(inspectionId);
    return value ? structuredClone(value) : undefined;
  }
}
