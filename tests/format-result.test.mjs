import test from 'node:test';
import assert from 'node:assert/strict';
import { formatInspection, formatVerification } from '../dist/daemon/format-result.js';
test('human inspection keeps heuristic certainty and strips terminal control characters', () => {
  const reference = { status: 'MAPPED', references: [{ file: 'src/Checkout.jsx', line: 7, certainty: 'heuristic' }] };
  const text = formatInspection({ target: { interactionTarget: { tagName: 'button', id: 'pay\u001b[31m' } }, sources: { target: reference }, primaryBlocker: null,
    interactionSurface: { blockedRatio: 0, reachableRatio: 1 }, diagnosis: { cause: 'UNKNOWN' }, causalExplanation: { cause: 'UNKNOWN_PAINT_CAUSE' }, limitations: [], inspectionId: 'baseline' });
  assert.match(text, /\[heuristic\]/); assert.match(text, /sampled/); assert.ok(!text.includes('\u001b')); assert.match(text, /UNKNOWN_PAINT_CAUSE/);
});
test('inconclusive verification cannot display a fabricated zero blockage or pass', () => {
  const text = formatVerification({ status: 'VERIFY_INCONCLUSIVE', baseline: { blockedRatio: 1, reachableRatio: 0 }, current: null,
    reconciliation: { status: 'AMBIGUOUS' }, safeCore: { exists: false }, reasons: ['Identity is ambiguous.'], inspectionId: 'baseline' });
  assert.match(text, /100% → UNKNOWN/); assert.match(text, /VERIFY_INCONCLUSIVE/); assert.doesNotMatch(text, /VERIFIED_PASS/);
});
