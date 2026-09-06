import { chromium, expect } from "@playwright/test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { startWhyUiDaemon } from "../../dist/daemon/cli.js";
export function removeTemp(dir) {
  if (!dir || !fs.existsSync(dir)) return;
  const resolved = fs.realpathSync(dir);
  if (path.dirname(resolved) !== fs.realpathSync(os.tmpdir()) || !path.basename(resolved).startsWith("why-ui-")) throw new Error("Unsafe test cleanup path");
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
/** Drives the production extension UI; browser protocol is test-driver infrastructure only. */
export async function extensionBrowser(port, pairingToken, { pairOnly = false } = {}) {
  const extPath = path.resolve("dist/extension");
  const context = await chromium.launchPersistentContext("", { channel: "chromium", headless: true,
    args: [`--disable-extensions-except=${extPath}`, `--load-extension=${extPath}`, "--enable-unsafe-extension-debugging"], viewport: { width: 1280, height: 800 } });
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
    const extensionId = new URL(worker.url()).host, cdp = await context.browser().newBrowserCDPSession();
    const settings = await context.newPage(); await settings.goto(`chrome-extension://${extensionId}/popup.html`);
    await settings.locator("#port").fill(String(port)); await settings.locator("#token").fill(pairingToken);
    await settings.getByRole("button", { name: "Pair extension" }).click();
    if (pairOnly) await expect(settings.locator("#pair")).toBeHidden();
    else await expect(settings.locator("#status")).toContainText("Connected");
    await settings.close();
    return { context, worker, cdp, async arm(page) {
      await page.bringToFront();
      const { targetInfos } = await cdp.send("Target.getTargets", { filter: [{ type: "tab", exclude: false }] });
      const tab = targetInfos.find(t => t.url === page.url()); expect(tab).toBeTruthy();
      await cdp.send("Extensions.triggerAction", { id: extensionId, targetId: tab.targetId });
    } };
  } catch (error) { await context.close(); throw error; }
}
export async function harness(options = {}) {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "why-ui-config-"));
  const logs = [];
  const daemon = await startWhyUiDaemon({ port: 0, configDir, onLog: entry => logs.push(entry), ...options });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await daemon.mcpServer.connect(serverTransport);
  const client = new Client({ name: "why-ui-e2e", version: "0.1.0" }); await client.connect(clientTransport);
  let context, worker, cdp, extension;
  return {
    daemon, client, logs,
    get context() { return context; }, get worker() { return worker; }, get cdp() { return cdp; },
    async launch() {
      extension = await extensionBrowser(daemon.port, daemon.pairingToken);
      ({ context, worker, cdp } = extension);
      await expect.poll(() => daemon.bridgeServer.isConnected()).toBe(true);
      return context;
    },
    async arm(page) {
      // Test driver invokes the real Chrome toolbar action. Chrome grants activeTab;
      // production onClicked injects the production MAIN-world sensor. No worker hooks.
      await extension.arm(page);
      await expect.poll(() => daemon.bridgeServer.getActiveSession()).not.toBeNull();
    },
    async inspect(args = {}) { return (await client.callTool({ name: "inspect_interaction", arguments: args })).structuredContent; },
    async verify(args) { return (await client.callTool({ name: "verify_fix", arguments: args })).structuredContent; },
    async close() { await client.close(); await context?.close(); await daemon.close(); removeTemp(configDir); },
  };
}
export async function openFixture(context, { html = '<button id="target">Pay now</button>', css = "" } = {}) {
  const page = await context.newPage();
  await page.route("**/*", r => r.fulfill({ contentType: "text/html", body: `<!doctype html><style>
    body { margin: 0; } #target { position:absolute; left:100px; top:100px; width:200px; height:100px; padding:0; border:0; border-radius:0; } ${css}
    </style>${html}` }));
  await page.goto("http://why-ui-fixture.test/"); return page;
}
