import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { BridgeServer, type BridgeServerOptions } from "./bridge-server.js";
import { createMcpServer } from "./mcp-server.js";
import { resetDevicePairing } from "./pairing.js";
import { doctor, formatDoctor } from "./doctor.js";

export interface DaemonInstance {
  bridgeServer: BridgeServer;
  mcpServer: ReturnType<typeof createMcpServer>;
  port: number;
  /** Empty once a persistent extension pairing exists. Never contains the device secret. */
  pairingToken: string;
  close: () => Promise<void>;
}
export async function startWhyUiDaemon(options: BridgeServerOptions = {}): Promise<DaemonInstance> {
  const bridgeServer = new BridgeServer(options);
  try {
    const port = await bridgeServer.start();
    const pairingToken = bridgeServer.getPairedOrigin() ? "" : bridgeServer.pairingManager.generatePairingToken();
    const mcpServer = createMcpServer(bridgeServer);
    let closing: Promise<void> | undefined;
    const close = (): Promise<void> => closing ??= (async () => {
      await bridgeServer.close(); await mcpServer.close();
    })();
    return { bridgeServer, mcpServer, port, pairingToken, close };
  } catch (error) { await bridgeServer.close(); throw error; }
}
const HELP = `why-ui 0.1.0 — Runtime evidence for coding agents.

Usage:
  why-ui pair [--port 9876] [--reset]
  why-ui mcp [--workspace <directory>] [--port 9876]
  why-ui doctor [--workspace <directory>] [--port 9876] [--json]

Commands:
  pair          Show a one-time token; exit after the extension authenticates.
  mcp           Serve MCP on stdin/stdout and the extension on loopback.
  doctor        Check local installation, pairing state and TCP reachability.

Options:
  --workspace   Source workspace (default: current directory).
  --port        Loopback port, 1–65535; 0 chooses an available port.
  --config-dir  Auth directory (default: ~/.why-ui or WHY_UI_CONFIG_DIR).
  --reset       Rotate saved pairing; pair command only. Stop other daemons first.
  --help        Print this help.
  --version     Print the version.
  --json        Machine-readable doctor output; doctor command only.

WHY_UI_BRIDGE_PORT sets the default port. Explicit options take precedence.
Pairing tokens and lifecycle messages go to stderr; MCP stdout is protocol only.
`;
export async function runCli(argv = process.argv.slice(2)): Promise<void> {
  if (!argv.length || argv.includes("--help") || argv.includes("-h")) { process.stdout.write(HELP); return; }
  if (argv.length === 1 && ["--version", "-v"].includes(argv[0]!)) { process.stdout.write("0.1.0\n"); return; }
  const command = argv[0];
  if (command !== "mcp" && command !== "pair" && command !== "doctor") throw new Error("Unknown command. Run why-ui --help.");
  let json = false;
  let portText = process.env.WHY_UI_BRIDGE_PORT ?? "9876", workspace = process.cwd(), configDir: string | undefined, reset = false;
  const seen = new Set<string>();
  for (let index = 1; index < argv.length; index++) {
    const arg = argv[index]!;
    if (seen.has(arg)) throw new Error("Duplicate option. Run why-ui --help.");
    seen.add(arg);
    if (arg === "--reset") { reset = true; continue; }
    if (arg === "--json") { json = true; continue; }
    if (!["--port", "--workspace", "--config-dir"].includes(arg) || !argv[index + 1] || argv[index + 1]!.startsWith("--")) throw new Error("Unknown option or missing value. Run why-ui --help.");
    const value = argv[++index]!;
    if (arg === "--port") portText = value;
    else if (arg === "--workspace") workspace = value;
    else configDir = path.resolve(value);
  }
  if (reset && command !== "pair") throw new Error("--reset is available only with why-ui pair.");
  if (json && command !== "doctor") throw new Error("--json is available only with why-ui doctor.");
  if (!/^\d{1,5}$/.test(portText) || Number(portText) > 65535) throw new Error("Port must be an integer between 0 and 65535.");
  try {
    workspace = fs.realpathSync(path.resolve(workspace));
    if (!fs.statSync(workspace).isDirectory()) throw new Error();
  } catch { throw new Error("Workspace must be an existing local directory."); }
  if (command === "doctor") {
    const result = await doctor(workspace, Number(portText), configDir);
    process.stdout.write(json ? JSON.stringify(result) + "\n" : formatDoctor(result));
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (reset) resetDevicePairing(configDir);
  let paired: (() => void) | undefined;
  const log = (message: string) => process.stderr.write(`[why-ui] ${message}\n`);
  const options: BridgeServerOptions = { port: Number(portText), workspace, configDir, onLog: entry => {
    if (entry.event === "auth_success") { log("Extension connected; no tab armed."); paired?.(); }
    else if (entry.event === "tab_armed") log("Tab armed.");
    else if (entry.event === "tab_disarmed") log("No tab armed.");
    else if (entry.event === "bridge_disconnected") log("Extension disconnected; waiting for reconnect.");
  } };
  const daemon = await startWhyUiDaemon(options);
  log(`Bridge listening at ws://127.0.0.1:${daemon.port}`);
  let stopping = false, expiry: NodeJS.Timeout | undefined;
  const shutdown = async (code = 0): Promise<void> => {
    if (stopping) return;
    stopping = true; clearTimeout(expiry);
    process.off("SIGINT", stop); process.off("SIGTERM", stop); process.stdin.off("end", stop);
    process.exitCode = code;
    await daemon.close();
  };
  const stop = () => { void shutdown(); };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  if (daemon.pairingToken) {
    log(`Pair the extension within two minutes:\n${daemon.pairingToken}`);
    expiry = setTimeout(() => {
      if (daemon.bridgeServer.getPairedOrigin()) return;
      log("Pairing expired. Restart why-ui pair for a fresh token.");
      if (command === "pair") void shutdown(1);
    }, 120_000);
    expiry.unref();
  } else log("Pairing saved; waiting for the extension.");
  if (command === "pair") {
    if (!daemon.pairingToken) { log("Already paired. Configure your agent to run why-ui mcp."); await shutdown(); return; }
    paired = () => { log("Pairing complete. Configure your agent to run why-ui mcp."); void shutdown(); };
  } else {
    const transport = new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 1024 * 1024 });
    daemon.mcpServer.onclose = stop;
    daemon.mcpServer.onerror = () => { log("Invalid MCP transport message."); };
    process.stdin.once("end", stop);
    try { await daemon.mcpServer.connect(transport); }
    catch { await shutdown(1); throw new Error("Cannot start MCP stdio transport."); }
  }
}
