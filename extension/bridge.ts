import { BRIDGE_PROTOCOL_VERSION, isBridgeEnvelope, isBridgePayload, getReconnectDelay, type BridgeMessage, type BridgeMessageType, type InspectRequestPayload, type VerifyRequestPayload } from "../src/bridge-protocol.js";
function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}
export async function computeHmacSha256(secret: string, nonce: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", hexToBytes(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signed = await crypto.subtle.sign("HMAC", key, hexToBytes(nonce));
  return Array.from(new Uint8Array(signed), b => b.toString(16).padStart(2, "0")).join("");
}
export interface BridgeClientHandlers {
  onAuthenticated?: () => void | Promise<void>;
  onInspectRequest?: (id: string, payload: InspectRequestPayload, sessionId: string | undefined) => Promise<void>;
  onVerifyRequest?: (id: string, payload: VerifyRequestPayload, sessionId: string | undefined) => Promise<void>;
}
export class ExtensionBridgeClient {
  private ws: WebSocket | null = null;
  private authenticated = false;
  private sessionToken: string | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private deadline: ReturnType<typeof setTimeout> | undefined;
  private reconnectAttempt = 0;
  private generation = 0;
  private explicitlyClosed = false;
  private sentSequence = 0;
  private receivedSequence = -1;
  private lastReceived = 0;
  private handshakeId = "";
  private stage: "PAIR_OK" | "CHALLENGE" | "AUTH_OK" | "READY" = "CHALLENGE";
  private issue: string | undefined;
  constructor(private readonly handlers: BridgeClientHandlers = {}) {}
  isAuthenticated(): boolean { return this.authenticated && this.ws?.readyState === WebSocket.OPEN; }
  getIssue(): string | undefined { return this.issue; }
  async connect(): Promise<void> {
    const generation = ++this.generation;
    this.explicitlyClosed = false;
    clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined;
    clearInterval(this.heartbeatTimer); clearTimeout(this.deadline);
    this.authenticated = false; this.sessionToken = undefined;
    this.issue = undefined;
    const old = this.ws; this.ws = null; old?.close();
    const storage = await chrome.storage.local.get(["bridgePort", "deviceSecret", "pairingToken"]);
    if (generation !== this.generation || (!storage.deviceSecret && !storage.pairingToken)) return;
    const port = storage.bridgePort ?? 9876;
    if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) return;
    const socket = new WebSocket(`ws://127.0.0.1:${port}`); this.ws = socket;
    this.deadline = setTimeout(() => socket.close(), 10_000);
    socket.onopen = () => {
      if (socket !== this.ws) return;
      this.handshakeId = crypto.randomUUID();
      if (storage.pairingToken) {
        this.stage = "PAIR_OK";
        this.send("PAIR", { pairingToken: storage.pairingToken, extensionId: chrome.runtime.id }, this.handshakeId);
      } else {
        this.stage = "CHALLENGE";
        this.send("HELLO", { extensionVersion: "0.1.0", extensionId: chrome.runtime.id }, this.handshakeId);
      }
    };
    socket.onmessage = async event => {
      if (socket !== this.ws) return;
      try {
        if (typeof event.data !== "string" || event.data.length > 512 * 1024) { socket.close(4400, "Invalid size"); return; }
        const message: unknown = JSON.parse(event.data);
        if (!isBridgeEnvelope(message) || !isBridgePayload(message.type, message.payload)) { socket.close(4400, "Invalid message"); return; }
        const p = message.payload as Record<string, any>;
        if (!this.authenticated && message.type === "ERROR") {
          this.issue = storage.deviceSecret ? "Authentication failed. Run why-ui pair --reset, then forget this pairing and pair again." : "Pairing failed or expired. Restart why-ui pair for a fresh token.";
          this.explicitlyClosed = true; await chrome.storage.local.remove("pairingToken");
          socket.close(); return;
        }
        if (!this.authenticated) {
          if (message.id !== this.handshakeId || message.type !== this.stage) { socket.close(); return; }
          if (message.type === "PAIR_OK") {
            await chrome.storage.local.set({ deviceSecret: p.deviceSecret });
            await chrome.storage.local.remove("pairingToken");
            if (socket !== this.ws) return;
            this.stage = "CHALLENGE";
            this.send("HELLO", { extensionVersion: "0.1.0", extensionId: chrome.runtime.id }, this.handshakeId);
          } else if (message.type === "CHALLENGE") {
            const latest = await chrome.storage.local.get("deviceSecret");
            if (typeof latest.deviceSecret !== "string" || !/^[a-f0-9]{64}$/.test(latest.deviceSecret)) { socket.close(); return; }
            const hmac = await computeHmacSha256(latest.deviceSecret, p.nonce);
            if (socket !== this.ws) return;
            this.stage = "AUTH_OK"; this.send("AUTH", { hmac }, this.handshakeId);
          } else if (message.type === "AUTH_OK") {
            this.sessionToken = p.sessionToken; this.authenticated = true; this.stage = "READY";
            this.issue = undefined;
            this.sentSequence = 0; this.receivedSequence = -1; this.lastReceived = Date.now(); this.reconnectAttempt = 0;
            clearTimeout(this.deadline);
            this.heartbeatTimer = setInterval(() => {
              if (Date.now() - this.lastReceived > 45_000) socket.close();
              else this.send("PING", { timestamp: Date.now() });
            }, 20_000);
            await this.handlers.onAuthenticated?.();
          }
          return;
        }
        if (message.sessionToken !== this.sessionToken || message.sequence === undefined || message.sequence <= this.receivedSequence) { socket.close(); return; }
        this.receivedSequence = message.sequence; this.lastReceived = Date.now();
        if (message.type === "ERROR") { socket.close(); return; }
        if (message.type === "PING") this.send("PONG", { timestamp: Date.now() }, message.id);
        else if (message.type === "INSPECT_REQUEST") await this.handlers.onInspectRequest?.(message.id, message.payload as InspectRequestPayload, message.sessionId);
        else if (message.type === "VERIFY_REQUEST") await this.handlers.onVerifyRequest?.(message.id, message.payload as VerifyRequestPayload, message.sessionId);
        else if (message.type !== "PONG") socket.close(4400, "Unexpected message");
      } catch { socket.close(); }
    };
    socket.onclose = () => {
      if (this.ws !== socket) return;
      clearTimeout(this.deadline); clearInterval(this.heartbeatTimer);
      this.authenticated = false; this.sessionToken = undefined; this.ws = null;
      if (!this.explicitlyClosed) {
        this.reconnectTimer = setTimeout(() => void this.connect(), getReconnectDelay(this.reconnectAttempt++));
      }
    };
    socket.onerror = () => socket.close();
  }
  send(type: BridgeMessageType, payload: unknown, id: string = crypto.randomUUID(), sessionId?: string): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    if (this.ws.bufferedAmount > 512 * 1024) { this.ws.close(); return; }
    const message: BridgeMessage = { protocol: BRIDGE_PROTOCOL_VERSION, id, type, sessionId, payload };
    if (this.authenticated) { message.sessionToken = this.sessionToken; message.sequence = this.sentSequence++; }
    this.ws.send(JSON.stringify(message));
  }
  disconnect(): void {
    ++this.generation; this.explicitlyClosed = true;
    clearTimeout(this.reconnectTimer); clearInterval(this.heartbeatTimer); clearTimeout(this.deadline);
    const old = this.ws; this.ws = null; old?.close(); this.authenticated = false; this.sessionToken = undefined;
  }
}
