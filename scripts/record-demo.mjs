import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { sourceFixture } from '../tests/source-fixture.mjs';
import { harness, removeTemp } from '../tests/e2e/helpers.mjs';

const fixture = await sourceFixture({ demo: true });
const frames = fs.mkdtempSync(path.join(os.tmpdir(), 'why-ui-demo-'));
let h, recording, stop = false;
const delay = ms => new Promise(r => setTimeout(r, ms)); // Presentation pacing only.
try {
  h = await harness({ workspace: fixture.root });
  const page = await (await h.launch()).newPage(); await page.setViewportSize({ width: 960, height: 600 });
  await page.goto(fixture.url); await page.waitForFunction(() => window.fixtureReady === 'broken');
  await h.arm(page); await page.mouse.move(175, 315);
  recording = (async () => {
    let frame = 0;
    while (!stop) {
      const began = Date.now();
      await page.screenshot({ path: path.join(frames, `${String(frame++).padStart(4, '0')}.png`) });
      await delay(Math.max(0, 250 - (Date.now() - began)));
    }
  })();
  const show = async (phase, evidence) => page.evaluate(({ phase, evidence }) => {
    document.querySelector('#phase').textContent = phase;
    document.querySelector('#evidence').textContent = evidence;
  }, { phase, evidence });
  await show('Why can’t I click this?', 'inspect_interaction\n{ "target": { "selector": "#payment" } }\n\nExplicit identity: the target is fully covered.');
  await delay(1600);
  const inspection = await h.client.callTool({ name: 'inspect_interaction', arguments: { target: { selector: '#payment' } } });
  assert.equal(inspection.structuredContent.result.primaryBlocker.node.id, 'backdrop');
  await show('The browser proves the blocker.', inspection.content[0].text.replace(/\ninspectionId:.*/, ''));
  await delay(4200);
  const before = fs.readFileSync(path.join(fixture.root, 'src/Payment.jsx'), 'utf8');
  await show('Source edit, then rebuild / reload.', 'src/Payment.jsx\n\nRemove the stale ModalBackdrop render.\n\nThe scripted patch also moves and resizes the button.\nOld geometry will not decide the result.');
  await delay(1700);
  await fixture.patch('good');
  const after = fs.readFileSync(path.join(fixture.root, 'src/Payment.jsx'), 'utf8');
  assert.notEqual(before, after);
  await page.waitForFunction(() => window.fixtureReady === 'good');
  await show('Fresh runtime. Fresh geometry.', 'verify_fix\n\nReconcile the target.\nResample the interaction surface.\nRequire a meaningful Safe Core.');
  const verified = await h.client.callTool({ name: 'verify_fix', arguments: { inspectionId: inspection.structuredContent.result.inspectionId, stabilizationTimeoutMs: 10000 } });
  assert.equal(verified.structuredContent.result.status, 'VERIFIED_PASS');
  await show('Independently verified.', verified.content[0].text.replace(/\ninspectionId:.*/, ''));
  await delay(6000); stop = true; await recording;
  fs.mkdirSync('docs/media', { recursive: true });
  fs.writeFileSync('docs/media/demo-evidence.json', JSON.stringify({ capturedAt: new Date().toISOString(), browser: page.context().browser().version(), inspection: inspection.structuredContent, verification: verified.structuredContent }, null, 2));
  await page.screenshot({ path: 'docs/media/demo-poster.png' });
  execFileSync(process.platform === 'win32' ? 'python' : 'python3', ['scripts/encode-demo.py', frames, 'docs/media/demo.gif'], { stdio: 'inherit', windowsHide: true });
  console.log('Recorded actual browser frames and MCP evidence in docs/media.');
} finally { stop = true; await recording; await h?.close(); await fixture.close(); removeTemp(frames); }
