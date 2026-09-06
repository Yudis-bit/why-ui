import * as crypto from "node:crypto";
import type { IncomingMessage } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { Ajv, type ValidateFunction } from "ajv";
import { inspectInteractionTool, sensorVerifyResponseSchema } from "../mcp-schema.js";
import { BRIDGE_PROTOCOL_VERSION, EXTENSION_ORIGIN, isBridgeEnvelope, isBridgePayload, type BridgeMessage, type BridgeMessageType } from "../bridge-protocol.js";
import type { BrowserSession, SensorInspectionOptions, SensorResponse, TargetIdentityBaseline, WhyUiError } from "../types.js";
import { InspectionStore } from "./inspection-store.js";
import { PairingManager, generateNonce, generateSessionToken, loadOrCreateDeviceSecret, updatePairedOrigin, verifyHmacSha256 } from "./pairing.js";

export interface BridgeServerOptions {
  port?: number | undefined;
  configDir?: string | undefined;
  workspace?: string | undefined;
  maxInspections?: number | undefined;
  pairingTimeoutMs?: number | undefined;
  requestTimeoutMs?: number | undefined;
  onLog?: ((entry: Record<string, unknown>) => void) | undefined;
}
interface SocketState {
  ws: WebSocket; origin: string; authenticated: boolean;
  sessionToken?: string; challengeNonce?: string;
  receivedSequence: number; sentSequence: number; lastMessage: number;
  deadline: NodeJS.Timeout;
}
interface PendingRequest {
  resolve: (response: SensorResponse) => void;
  timer: NodeJS.Timeout; sessionId: string; state: SocketState;
  resultType: "INSPECT_RESULT" | "VERIFY_RESULT";
}
export function sanitizeUrlForLog(url?: string): string {
  try { const u = new URL(url ?? ""); return `${u.protocol}//${u.host}${u.pathname}`; }
  catch { return ""; }
}
export class BridgeServer {
  public readonly port: number;
  public readonly pairingManager: PairingManager;
  public readonly inspectionStore: InspectionStore;
  public readonly workspace: string;
  private readonly configDir: string | undefined;
  private readonly deviceSecret: string;
  private pairedOrigin: string | undefined;
  private readonly requestTimeoutMs: number;
  private readonly onLog: BridgeServerOptions["onLog"];
  private wss: WebSocketServer | null = null;
  private activeClient: SocketState | null = null;
  private activeSession: BrowserSession | null = null;
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private readonly validateOutput: ValidateFunction;
  private readonly validateVerifyOutput: ValidateFunction;
  private healthTimer: NodeJS.Timeout | undefined;

  constructor(options: BridgeServerOptions = {}) {
    this.port = options.port ?? 0;
    this.configDir = options.configDir;
    this.workspace = options.workspace ?? process.cwd();
    this.requestTimeoutMs = Math.max(1, Math.min(15_000, options.requestTimeoutMs ?? 10_000));
    this.onLog = options.onLog;
    this.pairingManager = new PairingManager(options.pairingTimeoutMs);
    this.inspectionStore = new InspectionStore(options.maxInspections ?? 100);
    const loaded = loadOrCreateDeviceSecret(this.configDir);
    this.deviceSecret = loaded.secret;
    this.pairedOrigin = loaded.pairedOrigin;
    this.validateOutput = new Ajv({ strict: true, allErrors: false }).compile(inspectInteractionTool.outputSchema);
    this.validateVerifyOutput = new Ajv({ strict: true, allErrors: false }).compile(sensorVerifyResponseSchema);
  }
  private log(event: string, details: Record<string, unknown> = {}): void {
    this.onLog?.({ event, timestamp: Date.now(), ...details });
  }
  getPairedOrigin(): string | undefined { return this.pairedOrigin; }
  getActiveSession(): BrowserSession | null { return this.activeSession ? structuredClone(this.activeSession) : null; }
  get pendingCount(): number { return this.pendingRequests.size; }
  isConnected(): boolean { return !!this.activeClient?.authenticated && this.activeClient.ws.readyState === WebSocket.OPEN; }
  async start(): Promise<number> {
    if (this.wss) throw new Error("Bridge already started.");
    return new Promise((resolve, reject) => {
      this.wss = new WebSocketServer({ host: "127.0.0.1", port: this.port, maxPayload: 512 * 1024, perMessageDeflate: false });
      this.wss.once("listening", () => {
        const addr = this.wss!.address();
        const port = typeof addr === "object" && addr ? addr.port : this.port;
        this.log("server_started", { port, host: "127.0.0.1" });
        this.healthTimer = setInterval(() => {
          if (this.activeClient && Date.now() - this.activeClient.lastMessage > 50_000) this.activeClient.ws.terminate();
        }, 10_000);
        this.healthTimer.unref();
        resolve(port);
      });
      this.wss.on("error", () => reject(new Error("Cannot bind why-ui loopback bridge; check the port.")));
      this.wss.on("connection", (ws, req) => this.handleConnection(ws, req));
    });
  }
  private handleConnection(ws: WebSocket, req: IncomingMessage): void {
    ws.on("error", () => ws.terminate());
    const origin = req.headers.origin;
    if (!origin || !EXTENSION_ORIGIN.test(origin) || (this.pairedOrigin && origin !== this.pairedOrigin)) {
      ws.close(4403, "Forbidden Origin"); return;
    }
    if ((this.wss?.clients.size ?? 0) > 4) { ws.terminate(); return; }
    const state: SocketState = { ws, origin, authenticated: false, receivedSequence: -1, sentSequence: 0,
      lastMessage: Date.now(), deadline: setTimeout(() => ws.terminate(), 10_000) };
    ws.on("message", (data, binary) => {
      if (binary) { ws.close(4400, "Text messages required"); return; }
      try { this.handleMessage(state, JSON.parse(data.toString()) as unknown); }
      catch { this.sendError(state, "invalid", "INVALID_OPTIONS", "Invalid bridge message."); ws.close(4400, "Invalid message"); }
    });
    ws.on("close", () => {
      clearTimeout(state.deadline);
      if (this.activeClient === state) {
        this.activeClient = null; this.activeSession = null;
        this.rejectAllPending({ code: "BRIDGE_NOT_CONNECTED", message: "Extension bridge disconnected." });
        this.log("bridge_disconnected");
      }
    });
  }
  private handleMessage(state: SocketState, value: unknown): void {
    if (!isBridgeEnvelope(value) || !isBridgePayload(value.type, value.payload)) throw new Error("Invalid message");
    const { id, type, payload } = value;
    const p = payload as Record<string, any>;
    // Recheck binding on every handshake: two sockets may have opened before pairing.
    if (this.pairedOrigin && this.pairedOrigin !== state.origin) { state.ws.close(4403, "Origin mismatch"); return; }
    if (!state.authenticated) {
      if ((p.extensionId !== undefined) && state.origin !== `chrome-extension://${p.extensionId}`) throw new Error("Identity mismatch");
      if (type === "PAIR") {
        if (this.pairedOrigin || !this.pairingManager.validateAndConsume(p.pairingToken)) {
          this.sendError(state, id, "BRIDGE_AUTH_FAILED", "Pairing token is invalid, expired, or used.");
          state.ws.close(4403, "Pairing rejected"); return;
        }
        try { updatePairedOrigin(this.configDir, state.origin); }
        catch { this.sendError(state, id, "BRIDGE_AUTH_FAILED", "Cannot persist pairing."); state.ws.close(); return; }
        this.pairedOrigin = state.origin;
        this.send(state, "PAIR_OK", { deviceSecret: this.deviceSecret }, id);
        this.log("pairing_success"); return;
      }
      if (type === "HELLO" && this.pairedOrigin === state.origin && !state.challengeNonce) {
        state.challengeNonce = generateNonce();
        this.send(state, "CHALLENGE", { nonce: state.challengeNonce }, id); return;
      }
      if (type === "AUTH" && state.challengeNonce && this.pairedOrigin === state.origin && verifyHmacSha256(this.deviceSecret, state.challengeNonce, p.hmac)) {
        delete state.challengeNonce;
        state.sessionToken = generateSessionToken(); state.authenticated = true;
        clearTimeout(state.deadline);
        // Unauthenticated connections never supersede a live authenticated client.
        const old = this.activeClient;
        this.rejectAllPending({ code: "BRIDGE_NOT_CONNECTED", message: "Bridge reauthenticated." });
        this.activeClient = state; this.activeSession = null;
        old?.ws.close(4409, "Reauthenticated");
        this.send(state, "AUTH_OK", { sessionToken: state.sessionToken }, id);
        this.log("auth_success"); return;
      }
      this.sendError(state, id, "BRIDGE_AUTH_FAILED", "Authentication required or challenge failed.");
      state.ws.close(4401, "Authentication failed"); return;
    }
    if (state !== this.activeClient || value.sessionToken !== state.sessionToken || value.sequence === undefined || value.sequence <= state.receivedSequence) {
      state.ws.close(4401, "Invalid session"); return;
    }
    state.receivedSequence = value.sequence; state.lastMessage = Date.now();
    switch (type) {
      case "ARMED": {
        this.rejectAllPending({ code: "TAB_NOT_CONNECTED", message: "Armed tab changed." });
        this.activeSession = { ...p.session, ...(p.session.url ? { url: sanitizeUrlForLog(p.session.url) } : {}) };
        this.log("tab_armed", { tabId: p.session.tabId }); return;
      }
      case "DISARMED":
        this.activeSession = null;
        this.rejectAllPending({ code: "TAB_NOT_CONNECTED", message: "Tab disarmed." });
        this.log("tab_disarmed"); return;
      case "PING": this.send(state, "PONG", { timestamp: Date.now() }, id); return;
      case "PONG": return;
      case "INSPECT_RESULT": case "VERIFY_RESULT": {
        const pending = this.pendingRequests.get(id);
        if (!pending || pending.state !== state || pending.sessionId !== value.sessionId || pending.resultType !== type) return;
        clearTimeout(pending.timer); this.pendingRequests.delete(id);
        if (!(type === "INSPECT_RESULT" ? this.validateOutput : this.validateVerifyOutput)(payload)) {
          pending.resolve({ ok: false, error: { code: "INVALID_SENSOR_PAYLOAD", message: "Browser result failed canonical schema validation." } }); return;
        }
        const response = payload as SensorResponse;
        if (response.ok && "inspectionId" in response.result) {
          response.result.inspectionId = crypto.randomUUID(); // The daemon owns baseline identifiers.
          this.inspectionStore.set(response.result.inspectionId, response.result);
        } else if (!response.ok) {
          // Page-visible APIs can throw; never propagate an untrusted error string.
          delete response.error.message;
        }
        pending.resolve(response); return;
      }
      default: this.sendError(state, id, "INVALID_OPTIONS", "Unexpected bridge message."); state.ws.close(4400, "Unexpected message");
    }
  }
  async sendInspectRequest(options?: SensorInspectionOptions): Promise<SensorResponse> {
    return this.sendRequest("INSPECT_REQUEST", options === undefined ? {} : { options });
  }
  async sendVerifyRequest(baseline: TargetIdentityBaseline, maxSamples = 64, timeoutMs = this.requestTimeoutMs): Promise<SensorResponse> {
    return this.sendRequest("VERIFY_REQUEST", { baseline, options: { maxSamples } }, timeoutMs);
  }
  private async sendRequest(type: "INSPECT_REQUEST" | "VERIFY_REQUEST", payload: unknown, timeoutMs = this.requestTimeoutMs): Promise<SensorResponse> {
    const state = this.activeClient, session = this.activeSession;
    if (!this.isConnected() || !state) return { ok: false, error: { code: "BRIDGE_NOT_CONNECTED", message: "No authenticated extension connected." } };
    if (!session) return { ok: false, error: { code: "TAB_NOT_CONNECTED", message: "Arm the current tab using the extension action." } };
    if (this.pendingRequests.size >= 16) return { ok: false, error: { code: "REQUEST_TIMEOUT", message: "Browser request capacity reached." } };
    if (!isBridgePayload(type, payload)) return { ok: false, error: { code: "INVALID_OPTIONS", message: "Invalid browser request." } };
    const id = crypto.randomUUID();
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        resolve({ ok: false, error: { code: "REQUEST_TIMEOUT", message: "Browser request timed out." } });
      }, Math.max(1, Math.min(this.requestTimeoutMs, timeoutMs)));
      this.pendingRequests.set(id, { resolve, timer, sessionId: session.sessionId, state, resultType: type === "INSPECT_REQUEST" ? "INSPECT_RESULT" : "VERIFY_RESULT" });
      this.send(state, type, payload, id, session.sessionId);
    });
  }
  private send(state: SocketState, type: BridgeMessageType, payload: unknown, id: string, sessionId?: string): void {
    if (state.ws.readyState !== WebSocket.OPEN) return;
    if (state.ws.bufferedAmount > 512 * 1024) { state.ws.terminate(); return; }
    const message: BridgeMessage = { protocol: BRIDGE_PROTOCOL_VERSION, id, type, payload, sessionId };
    if (state.authenticated && type !== "AUTH_OK") {
      message.sessionToken = state.sessionToken; message.sequence = state.sentSequence++;
    }
    state.ws.send(JSON.stringify(message));
  }
  private sendError(state: SocketState, id: string, code: WhyUiError["code"], message: string): void {
    this.send(state, "ERROR", { code, message }, id);
  }
  private rejectAllPending(error: WhyUiError): void {
    for (const pending of this.pendingRequests.values()) { clearTimeout(pending.timer); pending.resolve({ ok: false, error }); }
    this.pendingRequests.clear();
  }
  async close(): Promise<void> {
    clearInterval(this.healthTimer);
    this.rejectAllPending({ code: "BRIDGE_NOT_CONNECTED", message: "Bridge stopped." });
    this.activeClient = null; this.activeSession = null;
    if (this.wss) {
      for (const ws of this.wss.clients) ws.terminate();
      await new Promise<void>(resolve => this.wss!.close(() => resolve())); this.wss = null;
    }
  }
}
