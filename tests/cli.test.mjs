import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadOrCreateDeviceSecret, updatePairedOrigin, resetDevicePairing } from "../dist/daemon/pairing.js";
const exec = promisify(execFile), bin = path.resolve("bin/why-ui.js");
function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "why-ui-cli-"));
  t.after(() => { const resolved=fs.realpathSync(dir); assert.equal(path.dirname(resolved),fs.realpathSync(os.tmpdir())); assert.ok(path.basename(resolved).startsWith("why-ui-cli-")); fs.rmSync(resolved,{recursive:true,force:true}); });
  return dir;
}
test("CLI help and version are usable without auth or browser state", async () => {
  const help = await exec(process.execPath, [bin, "--help"]); assert.match(help.stdout, /why-ui pair/); assert.equal(help.stderr, "");
  assert.equal((await exec(process.execPath, [bin, "--version"])).stdout.trim(), "0.1.0");
});
test("CLI rejects unknown options, invalid ports and missing workspace", async t => {
  const dir=temp(t);
  for (const args of [["mcp","--unknown"],["mcp","--port","9876secret"],["mcp","--workspace",path.join(dir,"missing")],["mcp","--port"],["mcp","--reset"]]) {
    await assert.rejects(exec(process.execPath,[bin,...args]), error => error.code === 1 && error.stdout === "" && !error.stderr.includes("9876secret"));
  }
});
test("MCP EOF closes the loopback listener and stdout stays protocol-only", async t => {
  const dir=temp(t), child=spawn(process.execPath,[bin,"mcp","--port","0","--config-dir",dir],{windowsHide:true,stdio:["pipe","pipe","pipe"]});
  const closed=once(child,"exit"); let stdout="",stderr="";
  child.stdout.on("data",chunk=>stdout+=chunk); child.stderr.on("data",chunk=>stderr+=chunk);
  const timeout=setTimeout(()=>child.kill(),8000); timeout.unref(); t.after(()=>{clearTimeout(timeout); if(child.exitCode===null) child.kill();});
  while (!stderr.includes("Bridge listening")) { if(child.exitCode!==null) assert.fail("Daemon failed to start"); await new Promise(resolve=>setTimeout(resolve,20)); }
  child.stdin.end(); assert.equal((await closed)[0],0); assert.equal(stdout,"");
  const auth=JSON.parse(fs.readFileSync(path.join(dir,"auth.json"),"utf8")); assert.equal(stderr.includes(auth.deviceSecret),false);
});
test("explicit pairing reset rotates the secret and removes origin binding", t => {
  const dir=temp(t), original=loadOrCreateDeviceSecret(dir); updatePairedOrigin(dir,"chrome-extension://abcdefghijklmnopabcdefghijklmnop");
  resetDevicePairing(dir); const current=loadOrCreateDeviceSecret(dir);
  assert.notEqual(current.secret,original.secret); assert.equal(current.pairedOrigin,undefined);
  assert.deepEqual(fs.readdirSync(dir),["auth.json"]);
  if(process.platform!=="win32") assert.equal(fs.statSync(path.join(dir,"auth.json")).mode & 0o777,0o600);
});
