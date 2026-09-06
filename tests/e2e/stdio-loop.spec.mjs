import { test, expect } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { sourceFixture } from "../source-fixture.mjs";
import { extensionBrowser, removeTemp } from "./helpers.mjs";

test("CLI stdio → real extension → local source patch → VERIFIED_PASS", async () => {
  const fixture = await sourceFixture({ react: "react18" });
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "why-ui-stdio-"));
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.resolve("bin/why-ui.js"), "mcp", "--port", "0", "--config-dir", configDir, "--workspace", fixture.root], stderr: "pipe" });
  const client = new Client({ name: "why-ui-stdio-e2e", version: "0.1.0" });
  let stderr = "", extension; const errors = [];
  transport.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-8192); });
  client.onerror = error => errors.push(error);
  try {
    await client.connect(transport);
    const token = stderr.match(/\b[a-f0-9]{8}(?:-[a-f0-9]{8}){3}\b/)?.[0];
    const port = Number(stderr.match(/ws:\/\/127\.0\.0\.1:(\d+)/)?.[1]);
    expect(Boolean(token) && port > 0).toBe(true);
    extension = await extensionBrowser(port, token);
    const page = await extension.context.newPage(); await page.goto(fixture.url); await page.waitForFunction(() => window.fixtureReady === "broken");
    await extension.arm(page);
    await expect.poll(async () => {
      const value = (await client.callTool({ name: "inspect_interaction", arguments: {} })).structuredContent;
      return value.error?.code;
    }).toBe("NO_POINTER_CAPTURED");
    await page.mouse.move(200, 150);
    const inspection = (await client.callTool({ name: "inspect_interaction", arguments: { target: { selector: "#payment" } } })).structuredContent;
    expect(inspection.ok).toBe(true); expect(inspection.result.primaryBlocker.node.id).toBe("backdrop");
    expect(inspection.result.sources.primaryBlocker.references[0].file).toBe("src/Payment.jsx");
    await fixture.patch("good");
    const verified = (await client.callTool({ name: "verify_fix", arguments: { inspectionId: inspection.result.inspectionId, stabilizationTimeoutMs: 10000 } })).structuredContent;
    expect(verified.ok).toBe(true); expect(verified.result.status).toBe("VERIFIED_PASS");
    expect(verified.result.safeCore.exists).toBe(true); expect(errors).toEqual([]);
    const { deviceSecret } = JSON.parse(fs.readFileSync(path.join(configDir, "auth.json"), "utf8"));
    expect(stderr.includes(deviceSecret)).toBe(false);
  } finally { await extension?.context.close(); await client.close(); await fixture.close(); removeTemp(configDir); }
});


test("first-time pair command exits and the agent's MCP process reuses authentication", async () => {
  const fixture=await sourceFixture(), configDir=fs.mkdtempSync(path.join(os.tmpdir(),"why-ui-pair-"));
  const child=spawn(process.execPath,[path.resolve("bin/why-ui.js"),"pair","--port","0","--config-dir",configDir],{windowsHide:true,stdio:["pipe","pipe","pipe"]});
  let stderr="", stdout="", extension, client; const closed=once(child,"exit");
  child.stderr.on("data",chunk=>stderr+=chunk); child.stdout.on("data",chunk=>stdout+=chunk);
  try {
    await expect.poll(()=>Boolean(stderr.match(/\b[a-f0-9]{8}(?:-[a-f0-9]{8}){3}\b/))).toBe(true);
    const token=stderr.match(/\b[a-f0-9]{8}(?:-[a-f0-9]{8}){3}\b/)[0], port=Number(stderr.match(/ws:\/\/127\.0\.0\.1:(\d+)/)[1]);
    extension=await extensionBrowser(port,token,{pairOnly:true});
    expect((await closed)[0]).toBe(0); expect(stdout).toBe("");
    const transport=new StdioClientTransport({command:process.execPath,args:[path.resolve("bin/why-ui.js"),"mcp","--port",String(port),"--config-dir",configDir,"--workspace",fixture.root],stderr:"pipe"});
    let mcpLogs=""; transport.stderr.on("data",chunk=>mcpLogs+=chunk);
    client=new Client({name:"paired-agent",version:"0.1.0"}); await client.connect(transport);
    await expect.poll(()=>mcpLogs.includes("Extension connected")).toBe(true);
    expect(mcpLogs).not.toMatch(/\b[a-f0-9]{8}(?:-[a-f0-9]{8}){3}\b/);
    const page=await extension.context.newPage(); await page.goto(fixture.url); await page.waitForFunction(()=>window.fixtureReady);
    await extension.arm(page);
    await expect.poll(()=>mcpLogs.includes("Tab armed")).toBe(true); await page.mouse.move(200,150);
    const response=(await client.callTool({name:"inspect_interaction",arguments:{target:{selector:"#payment"}}})).structuredContent;
    expect(response.ok).toBe(true); expect(response.result.primaryBlocker.node.id).toBe("backdrop");
  } finally { if(child.exitCode===null) {child.kill(); await closed;} await extension?.context.close(); await client?.close(); await fixture.close(); removeTemp(configDir); }
});
