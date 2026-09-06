import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { once } from "node:events";
import assert from "node:assert/strict";
import test from "node:test";
import * as crypto from "node:crypto";
import { WebSocket } from "ws";
import {
  isBridgeEnvelope,
  isBridgePayload,
  parseBridgeMessage,
  serializeBridgeMessage,
  getReconnectDelay,
  RECONNECT_BACKOFF_DELAYS,
} from "../dist/bridge-protocol.js";
import { PairingManager, computeHmacSha256, verifyHmacSha256, loadOrCreateDeviceSecret } from "../dist/daemon/pairing.js";
import { InspectionStore } from "../dist/daemon/inspection-store.js";
import { BridgeServer } from "../dist/daemon/bridge-server.js";

test("bridge envelope validation accepts valid envelopes and rejects malformed ones", () => {
  const valid = {
    protocol: "why-ui/bridge@1",
    id: "req_123",
    type: "HELLO",
    payload: { extensionVersion: "0.1.0" },
  };
  assert.equal(isBridgeEnvelope(valid), true);
  assert.equal(isBridgeEnvelope({ ...valid, sessionId: "session_1" }), true);
  assert.equal(isBridgeEnvelope({ ...valid, sequence: 1 }), true);

  // Rejected variants
  assert.equal(isBridgeEnvelope(null), false);
  assert.equal(isBridgeEnvelope({}), false);
  assert.equal(isBridgeEnvelope({ ...valid, protocol: "why-ui/bridge@2" }), false);
  assert.equal(isBridgeEnvelope({ ...valid, id: "" }), false);
  assert.equal(isBridgeEnvelope({ ...valid, type: "UNKNOWN_TYPE" }), false);
  assert.equal(isBridgeEnvelope({ ...valid, sequence: -1 }), false);
  assert.equal(isBridgeEnvelope({ ...valid, sequence: 1.5 }), false);

  assert.notEqual(parseBridgeMessage(serializeBridgeMessage(valid)), null);
  assert.equal(parseBridgeMessage("not json"), null);
  assert.equal(parseBridgeMessage(JSON.stringify({ protocol: "bad" })), null);
});

test("pairing token generation, validation, expiry, and single-use enforcement", async () => {
  const manager = new PairingManager(50); // 50ms expiry for test
  const token = manager.generatePairingToken();
  assert.match(token, /^[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{8}$/);

  // Valid on first use
  assert.equal(manager.validateAndConsume(token), true);

  // Re-use rejection (single-use)
  assert.equal(manager.validateAndConsume(token), false);

  // Expired token rejection
  const expiredManager = new PairingManager(10);
  const expiredToken = expiredManager.generatePairingToken();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(expiredManager.validateAndConsume(expiredToken), false);
});

test("HMAC challenge generation and verification works with timingSafeEqual", () => {
  const secret = crypto.randomBytes(32).toString("hex");
  const nonce = crypto.randomBytes(32).toString("hex");
  const hmac = computeHmacSha256(secret, nonce);

  assert.equal(verifyHmacSha256(secret, nonce, hmac), true);

  // Wrong secret
  const wrongSecret = crypto.randomBytes(32).toString("hex");
  assert.equal(verifyHmacSha256(wrongSecret, nonce, hmac), false);

  // Wrong nonce
  const wrongNonce = crypto.randomBytes(32).toString("hex");
  assert.equal(verifyHmacSha256(secret, wrongNonce, hmac), false);

  // Mutated HMAC
  const tamperedHmac = (hmac[0] === "0" ? "1" : "0") + hmac.slice(1);
  assert.equal(verifyHmacSha256(secret, nonce, tamperedHmac), false);
});

test("inspection store stores results and enforces deterministic insertion-order eviction", () => {
  const store = new InspectionStore(3); // max 3
  assert.equal(store.size, 0);

  const makeResult = (id) => ({
    schemaVersion: "why-ui/interaction@1",
    inspectionId: id,
    capturedAt: Date.now(),
    pointer: { clientX: 10, clientY: 10, pageX: 10, pageY: 10, pointerType: "mouse", timestamp: 1 },
    viewport: { width: 800, height: 600, devicePixelRatio: 1, scrollX: 0, scrollY: 0 },
    target: {
      rawHit: null,
      interactionTarget: { tagName: "button", selectorHint: "button", rect: { x: 0, y: 0, width: 10, height: 10, top: 0, right: 10, bottom: 10, left: 0 }, domPath: [] },
      selectionMethod: "pointer-hit",
      computed: {},
      state: { disabled: false, inert: false, ariaDisabled: false, hidden: false },
      ancestors: [],
    },
    interactionSurface: {
      totalSamples: 1, reachableSamples: 1, blockedSamples: 0, outsideSamples: 0,
      reachableRatio: 1, blockedRatio: 0, eligibleSamples: 1, sampledClientRects: 1,
      clientRectsTruncated: false, samples: [],
    },
    blockers: [],
    diagnosis: { cause: "UNKNOWN", evidence: [] },
    limitations: [],
  });

  store.set("insp_1", makeResult("insp_1"));
  store.set("insp_2", makeResult("insp_2"));
  store.set("insp_3", makeResult("insp_3"));
  assert.equal(store.size, 3);
  assert.equal(store.has("insp_1"), true);

  // Adding 4th should evict the oldest ("insp_1")
  store.set("insp_4", makeResult("insp_4"));
  assert.equal(store.size, 3);
  assert.equal(store.has("insp_1"), false);
  assert.equal(store.has("insp_2"), true);
  assert.equal(store.has("insp_4"), true);
});

const origin = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
async function start(t, options = {}) {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "why-ui-unit-"));
  const server = new BridgeServer({ port: 0, configDir, ...options }); const port = await server.start();
  t.after(async () => {
    await server.close();
    const resolved = fs.realpathSync(configDir);
    assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir())); assert.ok(path.basename(resolved).startsWith("why-ui-unit-"));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return { server, port, configDir };
}
async function connect(port, originHeader = origin) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin: originHeader }); await once(ws, "open");
  return ws;
}
async function authenticated(t, options) {
  const h = await start(t, options); const ws = await connect(h.port); let sessionToken, sequence = 0;
  const send = (type, payload, id = crypto.randomUUID()) => ws.send(JSON.stringify({ protocol: "why-ui/bridge@1", type, id, payload,
    ...(sessionToken ? { sessionToken, sequence: sequence++, sessionId: "s1" } : {}) }));
  const ask = async (type, payload) => { const response = once(ws, "message"); send(type, payload); return JSON.parse((await response)[0].toString()); };
  const pairingToken = h.server.pairingManager.generatePairingToken();
  const pair = await ask("PAIR", { pairingToken }); assert.equal(pair.type, "PAIR_OK");
  const challenge = await ask("HELLO", { extensionVersion: "0.1.0" }); assert.equal(challenge.type, "CHALLENGE");
  const auth = await ask("AUTH", { hmac: computeHmacSha256(pair.payload.deviceSecret, challenge.payload.nonce) });
  assert.equal(auth.type, "AUTH_OK"); sessionToken = auth.payload.sessionToken;
  async function arm() { send("ARMED", { session: { sessionId: "s1", tabId: 1, armedAt: Date.now() } }); await ask("PING", { timestamp: Date.now() }); }
  return { ...h, ws, send, ask, arm, sessionToken, pairingToken, secret: pair.payload.deviceSecret };
}
for (const badOrigin of ["https://site.example", "null", "chrome-extension://invalid", "chrome-extension://abcdefghijklmnopabcdefghijklmnop.evil"]) {
  test(`origin rejected: ${badOrigin}`, async t => {
    const { port } = await start(t); const ws = await connect(port, badOrigin); assert.equal((await once(ws, "close"))[0], 4403);
  });
}
test("pairing persists exact origin and restrictive secret file; HMAC arms a session", async t => {
  const h = await authenticated(t); await h.arm();
  assert.equal(h.server.getPairedOrigin(), origin); assert.equal(h.server.getActiveSession().tabId, 1);
  const auth = JSON.parse(fs.readFileSync(path.join(h.configDir, "auth.json"), "utf8")); assert.equal(auth.pairedOrigin, origin);
  assert.match(auth.deviceSecret, /^[a-f0-9]{64}$/);
  if (process.platform !== "win32") assert.equal(fs.statSync(path.join(h.configDir, "auth.json")).mode & 0o777, 0o600);
});
test("unrelated paired extension is rejected even with a syntactically valid origin", async t => {
  const h = await authenticated(t); const ws = await connect(h.port, "chrome-extension://pppppppppppppppppppppppppppppppp");
  assert.equal((await once(ws, "close"))[0], 4403); assert.equal(h.server.isConnected(), true);
});
test("unauthenticated same-origin socket cannot supersede an authenticated client", async t => {
  const h = await authenticated(t); await h.arm(); const ws = await connect(h.port); ws.close(); await once(ws, "close");
  assert.equal(h.server.isConnected(), true); assert.equal(h.server.getActiveSession().tabId, 1);
});
test("session token is enforced on privileged messages", async t => {
  const h = await authenticated(t); const closed = once(h.ws, "close");
  h.ws.send(JSON.stringify({ protocol: "why-ui/bridge@1", id: "bad", type: "PING", payload: { timestamp: 1 }, sequence: 0, sessionToken: "0".repeat(64) }));
  assert.equal((await closed)[0], 4401);
});
test("session sequence rejects replay", async t => {
  const h = await authenticated(t); await h.ask("PING", { timestamp: 1 }); const closed = once(h.ws, "close");
  h.ws.send(JSON.stringify({ protocol: "why-ui/bridge@1", id: "replay", type: "PING", payload: { timestamp: 1 }, sequence: 0, sessionToken: h.sessionToken }));
  assert.equal((await closed)[0], 4401);
});
test("unknown or malformed messages cannot arm a tab", async t => {
  const h = await authenticated(t); const response = await h.ask("ARMED", { session: { tabId: 1, sessionId: "s1" }, private: "sentinel" });
  assert.equal(response.type, "ERROR"); assert.equal(h.server.getActiveSession(), null);
});
test("loopback binding, no tab, correlation, timeout and disconnect cleanup", async t => {
  const h = await authenticated(t, { requestTimeoutMs: 80 });
  assert.equal(h.server.wss.address().address, "127.0.0.1");
  assert.equal((await h.server.sendInspectRequest()).error.code, "TAB_NOT_CONNECTED"); await h.arm();
  h.ws.on("message", raw => { const msg = JSON.parse(raw.toString()); if (msg.type === "INSPECT_REQUEST") h.send("INSPECT_RESULT", { ok: false, error: { code: "NO_POINTER_CAPTURED" } }, msg.id); });
  assert.equal((await h.server.sendInspectRequest()).error.code, "NO_POINTER_CAPTURED");
  h.ws.removeAllListeners("message"); assert.equal((await h.server.sendInspectRequest()).error.code, "REQUEST_TIMEOUT");
  assert.equal(h.server.pendingCount, 0);
  const pending = h.server.sendInspectRequest(); h.ws.close(); assert.equal((await pending).error.code, "BRIDGE_NOT_CONNECTED"); assert.equal(h.server.pendingCount, 0);
});
test("request correlation rejects unrelated IDs and session IDs", async t => {
  const h = await authenticated(t, { requestTimeoutMs: 50 }); await h.arm();
  h.ws.on("message", raw => { const msg = JSON.parse(raw.toString()); if (msg.type === "INSPECT_REQUEST") h.send("INSPECT_RESULT", { ok: false, error: { code: "NO_POINTER_CAPTURED" } }, "unrelated"); });
  assert.equal((await h.server.sendInspectRequest()).error.code, "REQUEST_TIMEOUT");
});
test("canonical browser payload validation rejects unknown data", async t => {
  const h = await authenticated(t); await h.arm();
  h.ws.on("message", raw => { const msg = JSON.parse(raw.toString()); if (msg.type === "INSPECT_REQUEST") h.send("INSPECT_RESULT", { ok: true, result: { private: "sentinel" } }, msg.id); });
  assert.equal((await h.server.sendInspectRequest()).error.code, "INVALID_SENSOR_PAYLOAD"); assert.equal(h.server.inspectionStore.size, 0);
});
test("pending request capacity is bounded and every disconnect settles", async t => {
  const h = await authenticated(t); await h.arm(); const pending = Array.from({ length: 16 }, () => h.server.sendInspectRequest());
  assert.equal(h.server.pendingCount, 16); assert.equal((await h.server.sendInspectRequest()).error.code, "REQUEST_TIMEOUT");
  h.ws.terminate(); assert.ok((await Promise.all(pending)).every(r => r.error.code === "BRIDGE_NOT_CONNECTED")); assert.equal(h.server.pendingCount, 0);
});
test("malformed HMAC encodings cannot be accepted as hex prefixes", () => {
  const secret = crypto.randomBytes(32).toString("hex"), nonce = crypto.randomBytes(32).toString("hex");
  const hmac = computeHmacSha256(secret, nonce); assert.equal(verifyHmacSha256(secret, nonce, hmac + "garbage"), false);
});
test("reconnect backoff is bounded", () => {
  assert.deepEqual(RECONNECT_BACKOFF_DELAYS, [250, 500, 1000, 2000, 5000]);
  assert.deepEqual([0, 1, 2, 3, 4, 100].map(getReconnectDelay), [250, 500, 1000, 2000, 5000, 5000]);
});


test("corrupt auth state fails closed without exposing file contents", async t => {
  const h = await start(t); const authFile = path.join(h.configDir, "auth.json");
  fs.writeFileSync(authFile, '{"deviceSecret":"PRIVATE_AUTH_SENTINEL"');
  assert.throws(() => loadOrCreateDeviceSecret(h.configDir), error => !error.message.includes("PRIVATE_AUTH_SENTINEL") && /Invalid why-ui auth state/.test(error.message));
  assert.ok(fs.readFileSync(authFile, "utf8").includes("PRIVATE_AUTH_SENTINEL"));
});
test("invalid TTL cannot disable expiry and callers cannot alter pairing state", () => {
  for (const ttl of [NaN, Infinity, 1_000_000]) {
    const manager = new PairingManager(ttl); manager.generatePairingToken();
    const state = manager.getActivePairing(); assert.ok(state.expiresAt > Date.now() && state.expiresAt <= Date.now() + 120_000);
    state.expiresAt = Infinity; assert.ok(Number.isFinite(manager.getActivePairing().expiresAt));
  }
});
test("Origin binding is rechecked on sockets opened before pairing", async t => {
  const h = await start(t), first = await connect(h.port), second = await connect(h.port, "chrome-extension://pppppppppppppppppppppppppppppppp");
  const received = once(first, "message");
  first.send(JSON.stringify({ protocol:"why-ui/bridge@1", id:"pair", type:"PAIR", payload:{pairingToken:h.server.pairingManager.generatePairingToken()} }));
  assert.equal(JSON.parse((await received)[0]).type, "PAIR_OK");
  const closed = once(second, "close");
  second.send(JSON.stringify({ protocol:"why-ui/bridge@1", id:"hello", type:"HELLO", payload:{extensionVersion:"0.1.0"} }));
  assert.equal((await closed)[0], 4403);
});
test("a used pairing token cannot provision a second connection", async t => {
  const h = await authenticated(t), ws = await connect(h.port); const received = once(ws, "message");
  ws.send(JSON.stringify({ protocol:"why-ui/bridge@1", id:"pair-again", type:"PAIR", payload:{pairingToken:h.pairingToken} }));
  assert.equal(JSON.parse((await received)[0]).payload.code, "BRIDGE_AUTH_FAILED"); assert.equal(h.server.isConnected(), true);
});
test("expired pairing cannot cross the physical bridge", async t => {
  const h = await start(t, { pairingTimeoutMs: 5 }), token = h.server.pairingManager.generatePairingToken();
  await new Promise(resolve => setTimeout(resolve, 10)); const ws = await connect(h.port), received = once(ws, "message");
  ws.send(JSON.stringify({ protocol:"why-ui/bridge@1", id:"expired", type:"PAIR", payload:{pairingToken:token} }));
  assert.equal(JSON.parse((await received)[0]).payload.code, "BRIDGE_AUTH_FAILED"); assert.equal(h.server.getPairedOrigin(), undefined);
});
test("a response to another nonce cannot authenticate or replace the live worker", async t => {
  const h = await authenticated(t), ws = await connect(h.port);
  let received = once(ws, "message");
  ws.send(JSON.stringify({ protocol:"why-ui/bridge@1", id:"hello", type:"HELLO", payload:{extensionVersion:"0.1.0"} }));
  assert.equal(JSON.parse((await received)[0]).type, "CHALLENGE"); received = once(ws, "message");
  ws.send(JSON.stringify({ protocol:"why-ui/bridge@1", id:"auth", type:"AUTH", payload:{hmac:computeHmacSha256(h.secret, "0".repeat(64))} }));
  assert.equal(JSON.parse((await received)[0]).payload.code, "BRIDGE_AUTH_FAILED"); assert.equal(h.server.isConnected(), true);
});
test("verification identities reject unknown nested fields and malformed geometry", () => {
  const baseline = { node: { tagName:"button", selectorHint:"#pay", domPath:[{tagName:"button"}], rect:{x:0,y:0,left:0,top:0,right:100,bottom:50,width:100,height:50} }, pointer:{clientX:10,clientY:10,pageX:10,pageY:10,timestamp:1,pointerType:"mouse"} };
  assert.equal(isBridgePayload("VERIFY_REQUEST", { baseline }), true);
  for (const mutate of [b => b.node.private = "sentinel", b => b.node.rect.width = -1, b => b.node.domPath[0].private = "sentinel", b => b.react = {detected:true, props:{value:"sentinel"}}, b => b.blocker = {tagName:"div"}]) {
    const changed = structuredClone(baseline); mutate(changed); assert.equal(isBridgePayload("VERIFY_REQUEST", {baseline:changed}), false);
  }
});
