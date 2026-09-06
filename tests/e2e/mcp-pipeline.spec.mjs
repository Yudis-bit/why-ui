import { test, expect } from "@playwright/test";
import { harness, openFixture } from "./helpers.mjs";
let h;
test.beforeEach(async () => { h = await harness(); });
test.afterEach(async () => { await h.close(); });
test("disconnected MCP request terminates with BRIDGE_NOT_CONNECTED", async () => {
  expect((await h.inspect()).error.code).toBe("BRIDGE_NOT_CONNECTED");
});
test("paired real worker without an armed tab returns TAB_NOT_CONNECTED", async () => {
  await h.launch(); expect((await h.inspect()).error.code).toBe("TAB_NOT_CONNECTED");
});
test("real action grants activeTab; no movement returns NO_POINTER_CAPTURED", async () => {
  const page = await openFixture(await h.launch()); await h.arm(page);
  expect((await h.inspect()).error.code).toBe("NO_POINTER_CAPTURED");
  const manifest = await h.worker.evaluate(() => chrome.runtime.getManifest());
  expect(manifest.permissions).toEqual(["activeTab", "scripting", "storage"]); expect(manifest.host_permissions).toBeUndefined();
});
test("partial occlusion without a hint crosses the complete extension and MCP path", async () => {
  const page = await openFixture(await h.launch(), { html: '<button id="target">Pay now</button><div id="overlay"></div>',
    css: '#overlay { position:absolute; left:250px; top:100px; width:50px; height:100px; z-index:2; }' });
  await h.arm(page); await page.mouse.move(200, 150);
  const r = await h.inspect(); expect(r.ok).toBe(true);
  expect(r.result.diagnosis.cause).toBe("PARTIAL_FOREIGN_OCCLUSION"); expect(r.result.primaryBlocker.node.id).toBe("overlay");
  expect(r.result.interactionSurface.reachableSamples).toBeGreaterThan(0); expect(r.result.interactionSurface.blockedSamples).toBeGreaterThan(0);
  expect(h.daemon.bridgeServer.inspectionStore.has(r.result.inspectionId)).toBe(true);
  expect(r.result.interactionSurface.samples).toBeUndefined(); expect(r.result.blockers).toBeUndefined();
  expect(r.result.causalExplanation.evidence[0]).toContain("elementsFromPoint");
  expect(JSON.stringify(r).length).toBeLessThan(16_000);
  const tools = (await h.client.listTools()).tools;
  expect(tools.map(t => t.name)).toEqual(["inspect_interaction", "verify_fix"]);
  expect(tools.every(t => t.outputSchema && t.annotations.readOnlyHint)).toBe(true);
});
test("full occlusion uses explicit MCP identity and never guesses beneath the overlay", async () => {
  const page = await openFixture(await h.launch(), { html: '<button id="target">Pay now</button><div id="overlay"></div>',
    css: '#overlay { position:absolute; left:100px; top:100px; width:200px; height:100px; z-index:2; }' });
  await h.arm(page); await page.mouse.move(200, 150);
  expect((await h.inspect()).result.target.interactionTarget.id).toBe("overlay");
  const r = await h.inspect({ target: { selector: "#target" } });
  expect(r.result.diagnosis.cause).toBe("FOREIGN_OCCLUSION"); expect(r.result.primaryBlocker.node.id).toBe("overlay");
});
test("privacy sentinels never cross the runtime, MCP or log boundary", async () => {
  const sentinel = "PRIVATE_SENTINEL_DO_NOT_LEAK";
  const page = await openFixture(await h.launch(), { html: `<button id="target">Pay</button><input type="password" value="${sentinel}"><textarea>${sentinel}</textarea><div contenteditable>${sentinel}</div>` });
  await page.evaluate(s => { localStorage.setItem("private", s); sessionStorage.setItem("private", s); }, sentinel);
  await h.arm(page); await page.mouse.move(200, 150);
  const r = await h.inspect(); expect(r.ok).toBe(true);
  expect(JSON.stringify({ r, logs: h.logs })).not.toContain(sentinel);
});
test("invalid page-influenced sensor payload is rejected by canonical daemon schema", async () => {
  const page = await openFixture(await h.launch()); await h.arm(page); await page.mouse.move(200, 150);
  await page.evaluate(() => { crypto.randomUUID = () => "x".repeat(1025); });
  expect((await h.inspect()).error.code).toBe("INVALID_SENSOR_PAYLOAD");
  expect(h.daemon.bridgeServer.inspectionStore.size).toBe(0);
});
test("disconnect during an actual pending MAIN request settles MCP without hooks", async () => {
  const page = await openFixture(await h.launch()); await h.arm(page); await page.mouse.move(200, 150);
  const pageCdp = await h.context.newCDPSession(page); await pageCdp.send("Debugger.enable"); await pageCdp.send("Debugger.pause");
  try {
    const request = h.inspect(); await expect.poll(() => h.daemon.bridgeServer.pendingCount).toBe(1);
    for (const ws of h.daemon.bridgeServer.wss.clients) ws.terminate();
    expect((await request).error.code).toBe("BRIDGE_NOT_CONNECTED"); expect(h.daemon.bridgeServer.pendingCount).toBe(0);
  } finally { await pageCdp.send("Debugger.resume"); await pageCdp.detach(); }
});
test("worker heartbeat survives over 30 seconds idle and automatically reauthenticates", async () => {
  const page = await openFixture(await h.launch()); await h.arm(page); await page.mouse.move(200, 150);
  const initial = h.logs.filter(x => x.event === "auth_success").length;
  await new Promise(r => setTimeout(r, 31_000)); // Deliberate lifecycle test, not application readiness.
  expect(h.daemon.bridgeServer.isConnected()).toBe(true);
  for (const ws of h.daemon.bridgeServer.wss.clients) ws.terminate();
  await expect.poll(() => h.logs.filter(x => x.event === "auth_success").length).toBeGreaterThan(initial);
  await expect.poll(() => h.daemon.bridgeServer.getActiveSession()).not.toBeNull();
  expect((await h.inspect()).ok).toBe(true);
});
test("stopped service worker restarts from the extension UI and restores the armed session", async () => {
  const page = await openFixture(await h.launch()); await h.arm(page); await page.mouse.move(200, 150);
  const initial = h.logs.filter(x => x.event === "auth_success").length;
  const workerUrl = h.worker.url();
  const control = await h.context.newCDPSession(page);
  const versions = new Map();
  control.on("ServiceWorker.workerVersionUpdated", ({ versions: updates }) => updates.forEach(v => versions.set(v.versionId, v)));
  await control.send("ServiceWorker.enable");
  await expect.poll(() => [...versions.values()].some(v => v.scriptURL === workerUrl && v.runningStatus === "running")).toBe(true);
  const version = [...versions.values()].find(v => v.scriptURL === workerUrl && v.runningStatus === "running");
  await control.send("ServiceWorker.stopWorker", { versionId: version.versionId });
  await expect.poll(() => h.daemon.bridgeServer.isConnected()).toBe(false);
  const settings = await h.context.newPage(); await settings.goto(new URL("popup.html", workerUrl).href);
  await expect.poll(() => h.logs.filter(x => x.event === "auth_success").length).toBeGreaterThan(initial);
  await expect.poll(() => h.daemon.bridgeServer.getActiveSession()).not.toBeNull();
  await settings.close(); await page.bringToFront();
  expect((await h.inspect()).ok).toBe(true);
  await control.detach();
});


test("user disarm removes the sensor and forgetting pairing disconnects the daemon", async () => {
  const page=await openFixture(await h.launch()); await h.arm(page); await page.mouse.move(200,150);
  expect((await h.inspect()).ok).toBe(true);
  const settings=await h.context.newPage(); await settings.goto(new URL("popup.html",h.worker.url()).href);
  await settings.getByRole("button",{name:"Disarm",exact:true}).click();
  await expect.poll(()=>h.daemon.bridgeServer.getActiveSession()).toBeNull();
  expect(await page.evaluate(()=>Object.prototype.hasOwnProperty.call(window,Symbol.for("why-ui.sensor.main-world.v1")))).toBe(false);
  expect((await h.inspect()).error.code).toBe("TAB_NOT_CONNECTED");
  await settings.getByRole("button",{name:"Forget pairing"}).click();
  await expect.poll(()=>h.daemon.bridgeServer.isConnected()).toBe(false); await expect(settings.locator("#pair")).toBeVisible();
});
