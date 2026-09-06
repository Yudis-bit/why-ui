import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { doctor } from '../dist/daemon/doctor.js';
import { loadOrCreateDeviceSecret, updatePairedOrigin } from '../dist/daemon/pairing.js';

function config(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'why-ui-doctor-'));
  t.after(() => {
    const real = fs.realpathSync(dir);
    assert.equal(path.dirname(real), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(real).startsWith('why-ui-doctor-'));
    fs.rmSync(real, { recursive: true, force: true });
  });
  return dir;
}
test('doctor checks a fresh installation without creating auth state', async t => {
  const dir = config(t), result = await doctor(process.cwd(), 0, dir);
  assert.equal(result.ok, true); assert.equal(result.pairing, 'missing');
  assert.equal(result.browserSession, 'UNKNOWN'); assert.equal(result.mcpConfiguration, 'NOT_CHECKED');
  assert.equal(fs.existsSync(path.join(dir, 'auth.json')), false);
});
test('doctor never emits stored credentials and corrupt pairing fails closed', async t => {
  const dir = config(t), { secret } = loadOrCreateDeviceSecret(dir);
  updatePairedOrigin(dir, 'chrome-extension://abcdefghijklmnopabcdefghijklmnop');
  const paired = await doctor(process.cwd(), 0, dir);
  assert.equal(paired.pairing, 'paired'); assert.ok(!JSON.stringify(paired).includes(secret));
  fs.writeFileSync(path.join(dir, 'auth.json'), secret);
  const invalid = await doctor(process.cwd(), 0, dir);
  assert.equal(invalid.ok, false); assert.equal(invalid.pairing, 'invalid');
  assert.ok(!JSON.stringify(invalid).includes(secret));
});
test('doctor does not misidentify an unrelated TCP listener as an authenticated daemon', async t => {
  const dir = config(t), server = net.createServer(socket => socket.end());
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => server.close(r)));
  const result = await doctor(process.cwd(), server.address().port, dir);
  assert.equal(result.portStatus, 'accepts-tcp'); assert.equal(result.browserSession, 'UNKNOWN');
  assert.match(result.limitation, /does not prove daemon identity/);
});
