import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { unzipSync } from 'fflate';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { expect } from '@playwright/test';
import { extensionBrowser, removeTemp } from '../e2e/helpers.mjs';
import { sourceFixture } from '../source-fixture.mjs';

let root, bin, extensionPath;
const version = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'why-ui-package-'));
  if (!process.env.npm_execpath) throw new Error('Run npm run test:package.');
  execFileSync(process.execPath, [process.env.npm_execpath, 'install', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', root, path.resolve(`release/why-ui-${version}.tgz`)], { cwd: root, windowsHide: true, timeout: 120000, stdio: 'pipe' });
  bin = path.join(root, 'node_modules/why-ui/bin/why-ui.js');
  extensionPath = path.join(root, 'unpacked-extension'); fs.mkdirSync(extensionPath);
  const files = unzipSync(fs.readFileSync(`release/why-ui-extension-v${version}.zip`));
  for (const [name, content] of Object.entries(files)) {
    assert.ok(/^[a-z.-]+$/.test(name)); fs.writeFileSync(path.join(extensionPath, name), content);
  }
});
after(() => removeTemp(root));
test('tarball CLI help and version work outside the source tree', () => {
  const run = args => execFileSync(process.execPath, [bin, ...args], { cwd: root, encoding: 'utf8', windowsHide: true });
  assert.match(run(['--help']), /why-ui doctor/); assert.equal(run(['--version']).trim(), version);
});
test('installed doctor finds the packaged extension without creating credentials', () => {
  const config = path.join(root, 'doctor-config');
  const result = JSON.parse(execFileSync(process.execPath, [bin, 'doctor', '--json', '--port', '0', '--config-dir', config], { cwd: root, encoding: 'utf8', windowsHide: true }));
  assert.equal(result.ok, true); assert.equal(result.pairing, 'missing');
  assert.ok(result.extensionPath.startsWith(root)); assert.equal(fs.existsSync(config), false);
});
test('release archive checksums and the unpacked production manifest are valid', () => {
  for (const line of fs.readFileSync('release/SHA256SUMS.txt', 'utf8').trim().split('\n')) {
    const [expected, name] = line.split('  ');
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join('release', name))).digest('hex'), expected);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(extensionPath, 'manifest.json'), 'utf8'));
  assert.equal(manifest.version, version); assert.deepEqual(manifest.permissions, ['activeTab', 'scripting', 'storage']);
});
test('installed MCP plus the release extension inspect, map source and verify a real patch', { timeout: 60000 }, async () => {
  const fixture = await sourceFixture();
  const transport = new StdioClientTransport({ command: process.execPath, args: [bin, 'mcp', '--port', '0', '--config-dir', path.join(root, 'auth'), '--workspace', fixture.root], cwd: root, stderr: 'pipe' });
  const client = new Client({ name: 'why-ui-package-smoke', version });
  let logs = '', extension;
  transport.stderr.on('data', chunk => { logs = (logs + chunk).slice(-8192); });
  try {
    await client.connect(transport);
    await expect.poll(() => /[a-f0-9]{8}(?:-[a-f0-9]{8}){3}/.test(logs)).toBe(true);
    const token = logs.match(/[a-f0-9]{8}(?:-[a-f0-9]{8}){3}/)[0];
    const port = Number(logs.match(/127\.0\.0\.1:(\d+)/)[1]);
    extension = await extensionBrowser(port, token, { extensionPath });
    const page = await extension.context.newPage(); await page.goto(fixture.url);
    await page.waitForFunction(() => window.fixtureReady === 'broken'); await extension.arm(page);
    await expect.poll(async () => (await client.callTool({ name: 'inspect_interaction', arguments: {} })).structuredContent.error?.code).toBe('NO_POINTER_CAPTURED');
    await page.mouse.move(200, 150);
    const inspection = (await client.callTool({ name: 'inspect_interaction', arguments: { target: { selector: '#payment' } } })).structuredContent;
    assert.equal(inspection.ok, true); assert.equal(inspection.result.primaryBlocker.node.id, 'backdrop');
    assert.equal(inspection.result.sources.primaryBlocker.references[0].file, 'src/Payment.jsx');
    await fixture.patch('good');
    const verified = (await client.callTool({ name: 'verify_fix', arguments: { inspectionId: inspection.result.inspectionId, stabilizationTimeoutMs: 10000 } })).structuredContent;
    assert.equal(verified.result.status, 'VERIFIED_PASS');
    const secret = JSON.parse(fs.readFileSync(path.join(root, 'auth/auth.json'), 'utf8')).deviceSecret;
    assert.ok(!logs.includes(secret));
  } finally { await extension?.context.close(); await client.close(); await fixture.close(); }
});
