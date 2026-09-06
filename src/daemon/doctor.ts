import * as fs from "node:fs";
import * as net from "node:net";
import { fileURLToPath } from "node:url";
import { readPairingStatus } from "./pairing.js";

export async function doctor(workspace: string, port: number, configDir?: string) {
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  const nodeSupported = major > 22 || (major === 22 && minor >= 13);
  const extensionPath = fileURLToPath(new URL("../extension/", import.meta.url));
  const extensionBuilt = ["manifest.json", "service-worker.js", "popup.js", "popup.html", "popup.css"]
    .every(file => fs.existsSync(new URL(`../extension/${file}`, import.meta.url)));
  const pairing = readPairingStatus(configDir);
  const portStatus = port === 0 ? "not-probed" : await new Promise<"accepts-tcp" | "unreachable">((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const finish = (result: "accepts-tcp" | "unreachable") => { socket.destroy(); resolve(result); };
    socket.setTimeout(750, () => finish("unreachable"));
    socket.once("connect", () => finish("accepts-tcp")); socket.once("error", () => finish("unreachable"));
  });
  return { ok: nodeSupported && extensionBuilt && pairing !== "invalid", node: process.versions.node,
    nodeSupported, workspace, extensionBuilt, extensionPath, pairing, port, portStatus,
    browserSession: "UNKNOWN", mcpConfiguration: "NOT_CHECKED",
    next: pairing === "paired" ? "Start your agent's why-ui mcp connection, arm the tab, and move the pointer."
      : "Run why-ui pair, open extension Options, and enter the one-time token.",
    limitation: "A TCP listener does not prove daemon identity, authentication, or an armed browser session. Check the extension badge and your agent's MCP status." };
}

export function formatDoctor(result: Awaited<ReturnType<typeof doctor>>): string {
  return [
    `${result.nodeSupported ? "OK" : "ERROR"} Node ${result.node} (requires 22.13+)`,
    `OK Workspace: ${result.workspace}`,
    `${result.extensionBuilt ? "OK" : "ERROR"} Extension: ${result.extensionPath}`,
    `Pairing: ${result.pairing}`,
    `127.0.0.1:${result.port}: ${result.portStatus} (TCP only)`,
    result.limitation, result.next,
  ].join("\n") + "\n";
}
