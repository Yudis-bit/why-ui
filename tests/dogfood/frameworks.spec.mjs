import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { harness, removeTemp } from '../e2e/helpers.mjs';

for (const framework of ['vite', 'next']) test(`${framework}: real development server, React source and native HMR → VERIFIED_PASS`, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `why-ui-dogfood-${framework}-`));
  let child, h, logs = '';
  try {
    fs.cpSync(path.resolve('tests/dogfood', framework), root, { recursive: true, filter: file => !file.split(path.sep).includes('node_modules') && !file.split(path.sep).includes('.next') });
    if (!process.env.npm_execpath) throw new Error('Run through npm run test:dogfood.');
    execFileSync(process.execPath, [process.env.npm_execpath, 'ci', '--no-audit', '--no-fund'], { cwd: root, windowsHide: true, timeout: 120_000, stdio: 'pipe' });
    const reservation = net.createServer(); await new Promise(r => reservation.listen(0, '127.0.0.1', r));
    const port = reservation.address().port; await new Promise(r => reservation.close(r));
    const args = framework === 'vite' ? ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort']
      : ['node_modules/next/dist/bin/next', 'dev', '--turbopack', '--hostname', '127.0.0.1', '--port', String(port)];
    child = spawn(process.execPath, args, { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' } });
    child.stdout.on('data', c => { logs = (logs + c).slice(-16000); }); child.stderr.on('data', c => { logs = (logs + c).slice(-16000); });
    const url = `http://127.0.0.1:${port}`;
    await expect.poll(async () => { try { return (await fetch(url, { signal: AbortSignal.timeout(2000) })).ok; } catch { return false; } }, { timeout: 90000 }).toBe(true);
    h = await harness({ workspace: root });
    const page = await (await h.launch()).newPage(); await page.goto(url);
    await expect(page.locator('#checkout')).toBeVisible();
    await expect.poll(() => page.locator('#checkout').evaluate(el => Object.keys(el).some(k => k.startsWith('__reactFiber$')))).toBe(true);
    await h.arm(page); await page.mouse.move(130, 200);
    const inspection = await h.inspect();
    expect(inspection.ok).toBe(true); expect(inspection.result.target.interactionTarget.id).toBe('checkout');
    expect(inspection.result.primaryBlocker.node.id).toBe('backdrop');
    expect(inspection.result.diagnosis.cause).toBe('PARTIAL_FOREIGN_OCCLUSION');
    const source = framework === 'vite' ? 'src/Checkout.jsx' : 'app/page.jsx';
    expect(inspection.result.sources.target.references.some(r => r.file === source)).toBe(true);
    expect(inspection.result.sources.primaryBlocker.references.some(r => r.file === source)).toBe(true);
    const before = await page.evaluate(() => performance.timeOrigin);
    const file = path.join(root, source); fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('const blocked = true;', 'const blocked = false;'));
    const verified = await h.verify({ inspectionId: inspection.result.inspectionId, stabilizationTimeoutMs: 10000 });
    expect(verified.ok).toBe(true); expect(verified.result.status).toBe('VERIFIED_PASS');
    expect(verified.result.safeCore.exists).toBe(true);
    expect(await page.evaluate(() => performance.timeOrigin)).toBe(before);
    console.log('Framework dogfood:', JSON.stringify({ framework, source: inspection.result.sources, cause: inspection.result.causalExplanation.cause, status: verified.result.status, sameDocumentHmr: true }));
  } catch (error) { console.error(logs.replaceAll(root, '<temporary-app>')); throw error; }
  finally {
    await h?.close();
    if (child && child.exitCode === null) {
      const closed = once(child, 'exit');
      if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      else child.kill('SIGTERM');
      await closed;
    }
    removeTemp(root);
  }
});
