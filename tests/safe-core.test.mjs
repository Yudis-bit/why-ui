import test from "node:test";
import assert from "node:assert/strict";
import { safeCore } from "../dist/daemon/safe-core.js";
function surface(size = 80, classify = () => "reachable") {
  const step = size / 8, samples = [];
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) samples.push({ x: (x + 0.5) * step, y: (y + 0.5) * step,
    classification: classify(x, y), weight: 1 / 64, cell: { left: x * step, right: (x + 1) * step, top: y * step, bottom: (y + 1) * step } });
  return { target: { interactionTarget: { rect: { left: 0, right: size, top: 0, bottom: size } } }, interactionSurface: { samples,
    reachableRatio: samples.filter(s => s.classification === "reachable").length / 64, clientRectsTruncated: false } };
}
test("safe core erodes the boundary ring of a connected reachable surface", () => {
  const core = safeCore(surface()); assert.equal(core.exists, true); assert.equal(core.approximateAreaPx2, 3600); assert.equal(core.minimumClearancePx, 15);
});
test("isolated reachable pixels and thin strips are insufficient", () => {
  assert.equal(safeCore(surface(8)).exists, false);
  assert.equal(safeCore(surface(80, (x, y) => x === 3 && y === 3 ? "reachable" : "blocked")).exists, false);
  assert.equal(safeCore(surface(80, x => x === 3 ? "reachable" : "blocked")).exists, false);
});
test("uncertain samples and overlapping fragments cannot create a safe core", () => {
  assert.equal(safeCore(surface(80, x => x === 7 ? "unresolved" : "reachable")).exists, false);
  const overlap = surface(); overlap.interactionSurface.samples.push(overlap.interactionSurface.samples[0]);
  assert.equal(safeCore(overlap).exists, false);
});
test("partial coverage can leave a meaningful safe core without claiming occlusion is fixed", () => {
  const core = safeCore(surface(80, x => x < 5 ? "reachable" : "blocked"));
  assert.equal(core.exists, true); assert.ok(core.reachableRatio < 1);
});
