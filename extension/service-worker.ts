import { sensorMainWorld } from "../src/sensor-main-world.js";
import type { BrowserSession, SensorResponse, SensorRequest } from "../src/types.js";
import { isBrowserSession } from "../src/bridge-protocol.js";
import { ExtensionBridgeClient } from "./bridge.js";
let activeSession: BrowserSession | null = null;
let operationGeneration = 0;
let activeCaptures = 0;
const restored = chrome.storage.session.get("activeSession").then(data => {
  if (isBrowserSession(data.activeSession)) activeSession = data.activeSession;
});
const bridge = new ExtensionBridgeClient({
  onAuthenticated: async () => {
    await restored;
    if (activeSession) {
      try { await chrome.tabs.get(activeSession.tabId); bridge.send("ARMED", { session: activeSession }); }
      catch { await disarmTab(); }
    }
  },
  onInspectRequest: (id, payload, sessionId) => executeRequest(id, sessionId,
    { operation: "inspect", ...(payload.options ? { options: payload.options } : {}) }),
  onVerifyRequest: (id, payload, sessionId) => executeRequest(id, sessionId,
    { operation: "verify", baseline: payload.baseline, ...(payload.options ? { options: payload.options } : {}) }),
});
async function executeRequest(id: string, sessionId: string | undefined, request: SensorRequest): Promise<void> {
  const session = activeSession;
  const type = request.operation === "verify" ? "VERIFY_RESULT" : "INSPECT_RESULT";
  if (!session || session.sessionId !== sessionId) {
    bridge.send(type, { ok: false, error: { code: "TAB_NOT_CONNECTED" } }, id, sessionId); return;
  }
  // executeScript cannot cancel a frozen MAIN world. Keep its outstanding work
  // bounded even when daemon requests have already timed out or reauthenticated.
  if (activeCaptures >= 16) { bridge.send(type, { ok: false, error: { code: "REQUEST_TIMEOUT" } }, id, sessionId); return; }
  activeCaptures++;
  try {
    const injections = await chrome.scripting.executeScript({ target: { tabId: session.tabId }, world: "MAIN", func: sensorMainWorld, args: [request] });
    const result = injections[0]?.result as SensorResponse | undefined;
    if (activeSession?.sessionId !== sessionId) return;
    bridge.send(type, result ?? { ok: false, error: { code: "SENSOR_NOT_AVAILABLE" } }, id, sessionId);
  } catch {
    bridge.send(type, { ok: false, error: { code: "SENSOR_NOT_AVAILABLE", message: "Cannot inspect this document; re-arm the tab." } }, id, sessionId);
  } finally { activeCaptures--; }
}
async function disarmTab(): Promise<void> {
  ++operationGeneration;
  const old = activeSession; activeSession = null;
  await chrome.storage.session.remove("activeSession");
  if (old) {
    try { await chrome.scripting.executeScript({ target: { tabId: old.tabId }, world: "MAIN", func: sensorMainWorld, args: [{ operation: "dispose" }] }); } catch {}
    try { await chrome.action.setBadgeText({ tabId: old.tabId, text: "" }); } catch {}
  }
  if (bridge.isAuthenticated()) bridge.send("DISARMED", {});
}
async function armTab(tab?: chrome.tabs.Tab): Promise<boolean> {
  await restored;
  const chosen = tab ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (chosen?.id === undefined || !chosen.url || !/^https?:\/\//.test(chosen.url)) return false;
  await disarmTab();
  const generation = ++operationGeneration;
  try {
    const results = await chrome.scripting.executeScript({ target: { tabId: chosen.id }, world: "MAIN", func: sensorMainWorld, args: [{ operation: "install" }] });
    if (!results[0]?.result?.ok || generation !== operationGeneration) return false;
    const url = new URL(chosen.url);
    activeSession = { sessionId: crypto.randomUUID(), tabId: chosen.id, frameId: 0, url: `${url.protocol}//${url.host}${url.pathname}`.slice(0, 2048), armedAt: Date.now() };
    await chrome.storage.session.set({ activeSession });
    await chrome.action.setBadgeText({ tabId: chosen.id, text: "ON" });
    if (bridge.isAuthenticated()) bridge.send("ARMED", { session: activeSession });
    return true;
  } catch { return false; }
}
chrome.action.onClicked.addListener(tab => {
  void chrome.storage.local.get("deviceSecret").then(async data => {
    if (!data.deviceSecret) await chrome.runtime.openOptionsPage();
    else await armTab(tab);
  });
});
chrome.commands.onCommand.addListener(command => { if (command === "arm-tab") void armTab(); });
chrome.tabs.onRemoved.addListener(id => { if (activeSession?.tabId === id) void disarmTab(); });
chrome.tabs.onUpdated.addListener((id, change) => {
  if (activeSession?.tabId !== id || !change.url) return;
  try { if (new URL(change.url).origin !== new URL(activeSession.url!).origin) void disarmTab(); } catch { void disarmTab(); }
});
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  // Only the bundled extension UI can request lifecycle changes. No content scripts or external messaging.
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(`chrome-extension://${chrome.runtime.id}/popup.html`)) return false;
  void (async () => {
    await restored;
    switch (message?.type) {
      case "GET_STATUS": {
        const settings = await chrome.storage.local.get(["deviceSecret", "bridgePort"]);
        return { authenticated: bridge.isAuthenticated(), session: activeSession, paired: Boolean(settings.deviceSecret), port: settings.bridgePort ?? 9876, issue: bridge.getIssue() };
      }
      case "DISARM_TAB": await disarmTab(); return { ok: true };
      case "RECONNECT_BRIDGE":
        if (message.port !== undefined) {
          if (!Number.isInteger(message.port) || message.port < 1 || message.port > 65535) return { ok: false };
          await chrome.storage.local.set({ bridgePort: message.port });
        }
        await bridge.connect(); return { ok: true };
      case "FORGET_PAIRING":
        await disarmTab(); bridge.disconnect();
        await chrome.storage.local.remove(["deviceSecret", "pairingToken"]); return { ok: true };
      case "PAIR_TOKEN":
        if (typeof message.token !== "string" || !/^[a-f0-9]{8}(-[a-f0-9]{8}){3}$/.test(message.token) || !Number.isInteger(message.port) || message.port < 1 || message.port > 65535) return { ok: false };
        await chrome.storage.local.set({ pairingToken: message.token, bridgePort: message.port });
        await bridge.connect(); return { ok: true };
      default: return { ok: false };
    }
  })().then(reply).catch(() => reply({ ok: false }));
  return true;
});
void chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
void restored.then(() => bridge.connect());
