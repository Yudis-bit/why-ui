import type { BrowserSession, SensorInspectionOptions, SensorResponse, TargetIdentityBaseline, WhyUiErrorCode } from "./types.js";
import { REACT_PROVENANCE, WHY_UI_ERROR_CODES } from "./types.js";

export const BRIDGE_PROTOCOL_VERSION = "why-ui/bridge@1" as const;

export const BRIDGE_MESSAGE_TYPES = [
  "PAIR", "PAIR_OK",
  "HELLO", "CHALLENGE", "AUTH", "AUTH_OK",
  "ARMED", "DISARMED",
  "INSPECT_REQUEST", "INSPECT_RESULT",
  "VERIFY_REQUEST", "VERIFY_RESULT",
  "ERROR",
  "PING", "PONG",
] as const;

export type BridgeMessageType = (typeof BRIDGE_MESSAGE_TYPES)[number];

export interface BridgeMessage<T = unknown> {
  protocol: typeof BRIDGE_PROTOCOL_VERSION;
  id: string;
  type: BridgeMessageType;
  sessionId?: string | undefined;
  sequence?: number | undefined;
  sessionToken?: string | undefined;
  payload: T;
}

export interface PairPayload {
  pairingToken: string;
  extensionId?: string | undefined;
}

export interface PairOkPayload {
  deviceSecret: string;
}

export interface HelloPayload {
  extensionVersion: string;
  extensionId?: string | undefined;
}

export interface ChallengePayload {
  nonce: string;
}

export interface AuthPayload {
  hmac: string;
}

export interface AuthOkPayload {
  sessionToken: string;
}

export interface ArmedPayload {
  session: BrowserSession;
}

export interface DisarmedPayload {
  sessionId?: string | undefined;
}

export interface InspectRequestPayload {
  options?: SensorInspectionOptions | undefined;
}
export interface VerifyRequestPayload {
  baseline: TargetIdentityBaseline;
  options?: SensorInspectionOptions;
}

export type InspectResultPayload = SensorResponse;

export interface BridgeErrorPayload {
  code: WhyUiErrorCode;
  message: string;
}

export interface HeartbeatPayload {
  timestamp: number;
}

export const RECONNECT_BACKOFF_DELAYS = [250, 500, 1000, 2000, 5000] as const;

export function getReconnectDelay(attempt: number): number {
  const index = Math.max(0, Math.min(attempt, RECONNECT_BACKOFF_DELAYS.length - 1));
  return RECONNECT_BACKOFF_DELAYS[index] ?? 5000;
}

export function isBridgeEnvelope(value: unknown): value is BridgeMessage<unknown> {
  if (typeof value !== "object" || value === null) return false;
  const msg = value as Record<string, unknown>;
  if (Object.keys(msg).some(key => !["protocol", "id", "type", "sessionId", "sessionToken", "sequence", "payload"].includes(key))) return false;
  if (msg.protocol !== BRIDGE_PROTOCOL_VERSION) return false;
  if (typeof msg.id !== "string" || msg.id.length === 0 || msg.id.length > 128) return false;
  if (typeof msg.type !== "string" || !BRIDGE_MESSAGE_TYPES.includes(msg.type as BridgeMessageType)) return false;
  if (msg.sessionId !== undefined && (typeof msg.sessionId !== "string" || msg.sessionId.length > 128)) return false;
  if (msg.sequence !== undefined && (!Number.isSafeInteger(msg.sequence) || (msg.sequence as number) < 0)) return false;
  if (msg.sessionToken !== undefined && (typeof msg.sessionToken !== "string" || !/^[a-f0-9]{64}$/.test(msg.sessionToken))) return false;
  if (!("payload" in msg)) return false;
  return true;
}

export const EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/;
const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const fields = (v: unknown, keys: string[]): v is Record<string, unknown> => record(v) && Object.keys(v).every(k => keys.includes(k));
const bounded = (v: unknown, max = 128): v is string => typeof v === "string" && v.length > 0 && v.length <= max;
const hex = (v: unknown): boolean => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const string = (v: unknown, max: number): boolean => typeof v === "string" && v.length <= max;
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const strings = (v: unknown, items: number, length: number): boolean => Array.isArray(v) && v.length <= items && v.every(item => string(item, length));
const sourceHint = (v: unknown): boolean => fields(v, ["file", "line", "column", "scope", "certainty", "provenance"]) &&
  (v.file === undefined || string(v.file, 1024)) && (v.line === undefined || (Number.isSafeInteger(v.line) && (v.line as number) >= 1)) &&
  (v.column === undefined || (Number.isSafeInteger(v.column) && (v.column as number) >= 0)) &&
  ["host-jsx", "component-owner", "component-definition", "candidate"].includes(String(v.scope)) &&
  ["exact", "runtime-derived", "symbolication-needed", "heuristic"].includes(String(v.certainty)) && REACT_PROVENANCE.includes(v.provenance as typeof REACT_PROVENANCE[number]);
function nodeIdentity(v: unknown): boolean {
  if (!fields(v, ["tagName", "id", "classes", "role", "name", "textPreview", "selectorHint", "attributes", "rect", "domPath"]) ||
    !bounded(v.tagName, 64) || !bounded(v.selectorHint, 1024) || !fields(v.rect, ["x", "y", "width", "height", "top", "right", "bottom", "left"]) ||
    !["x", "y", "width", "height", "top", "right", "bottom", "left"].every(k => finite((v.rect as Record<string, unknown>)[k])) ||
    (v.rect.width as number) < 0 || (v.rect.height as number) < 0) return false;
  for (const key of ["id", "name", "textPreview"]) if (v[key] !== undefined && !string(v[key], 160)) return false;
  if ((v.role !== undefined && !string(v.role, 64)) || (v.classes !== undefined && !strings(v.classes, 6, 64))) return false;
  if (v.attributes !== undefined && (!fields(v.attributes, ["type", "role", "aria-disabled", "aria-hidden", "disabled", "hidden", "inert", "tabindex", "contenteditable"]) || !Object.values(v.attributes).every(item => string(item, 160)))) return false;
  return Array.isArray(v.domPath) && v.domPath.length <= 8 && v.domPath.every(p => fields(p, ["tagName", "id", "classes", "nthOfType"]) && bounded(p.tagName, 64) &&
    (p.id === undefined || string(p.id, 160)) && (p.classes === undefined || strings(p.classes, 6, 64)) &&
    (p.nthOfType === undefined || (Number.isSafeInteger(p.nthOfType) && (p.nthOfType as number) >= 1)));
}
function reactIdentity(v: unknown): boolean {
  if (!fields(v, ["detected", "provenance", "version", "componentName", "ownerChain", "source", "sources", "reactKey"]) || typeof v.detected !== "boolean") return false;
  return (v.provenance === undefined ? !v.detected : Array.isArray(v.provenance) && v.provenance.length > 0 && v.provenance.length <= REACT_PROVENANCE.length && new Set(v.provenance).size === v.provenance.length && v.provenance.every(p => REACT_PROVENANCE.includes(p))) &&
    (v.version === undefined || string(v.version, 64)) && (v.componentName === undefined || string(v.componentName, 256)) &&
    (v.ownerChain === undefined || strings(v.ownerChain, 16, 256)) && (v.source === undefined || sourceHint(v.source)) &&
    (v.sources === undefined || (Array.isArray(v.sources) && v.sources.length <= 8 && v.sources.every(sourceHint))) &&
    (v.reactKey === undefined || v.reactKey === null || string(v.reactKey, 256));
}
export function isBrowserSession(v: unknown): v is BrowserSession {
  return fields(v, ["sessionId", "tabId", "frameId", "url", "armedAt"]) && bounded(v.sessionId) &&
    Number.isSafeInteger(v.tabId) && (v.tabId as number) >= 0 &&
    (v.frameId === undefined || v.frameId === 0) &&
    (v.url === undefined || (bounded(v.url, 2048) && /^https?:\/\//.test(v.url))) &&
    typeof v.armedAt === "number" && Number.isFinite(v.armedAt) && v.armedAt >= 0;
}
/** The browser evidence payload is additionally checked against the canonical schema by the daemon. */
export function isBridgePayload(type: BridgeMessageType, p: unknown): boolean {
  switch (type) {
    case "PAIR": return fields(p, ["pairingToken", "extensionId"]) && typeof p.pairingToken === "string" && /^[a-f0-9]{8}(-[a-f0-9]{8}){3}$/.test(p.pairingToken) && (p.extensionId === undefined || EXTENSION_ORIGIN.test(`chrome-extension://${p.extensionId}`));
    case "HELLO": return fields(p, ["extensionVersion", "extensionId"]) && bounded(p.extensionVersion, 32) && (p.extensionId === undefined || EXTENSION_ORIGIN.test(`chrome-extension://${p.extensionId}`));
    case "PAIR_OK": return fields(p, ["deviceSecret"]) && hex(p.deviceSecret);
    case "CHALLENGE": return fields(p, ["nonce"]) && hex(p.nonce);
    case "AUTH": return fields(p, ["hmac"]) && hex(p.hmac);
    case "AUTH_OK": return fields(p, ["sessionToken"]) && hex(p.sessionToken);
    case "ARMED": return fields(p, ["session"]) && isBrowserSession(p.session);
    case "DISARMED": return fields(p, []);
    case "PING": case "PONG": return fields(p, ["timestamp"]) && finite(p.timestamp) && p.timestamp >= 0;
    case "INSPECT_REQUEST": return fields(p, ["options"]) && (p.options === undefined || (fields(p.options, ["maxSamples", "includeReactMetadata", "targetSelector"]) &&
      (p.options.maxSamples === undefined || (Number.isInteger(p.options.maxSamples) && (p.options.maxSamples as number) >= 9 && (p.options.maxSamples as number) <= 128)) &&
      (p.options.includeReactMetadata === undefined || typeof p.options.includeReactMetadata === "boolean") &&
      (p.options.targetSelector === undefined || bounded(p.options.targetSelector, 1024))));
    case "INSPECT_RESULT": case "VERIFY_RESULT": return record(p);
    case "VERIFY_REQUEST": {
      if (!fields(p, ["baseline", "options"]) || !isBridgePayload("INSPECT_REQUEST", p.options === undefined ? {} : { options: p.options })) return false;
      const b = p.baseline;
      if (!fields(b, ["node", "react", "documentId", "runtimeTargetId", "pointer", "blocker"]) || !nodeIdentity(b.node) ||
        (b.blocker !== undefined && !nodeIdentity(b.blocker)) || (b.react !== undefined && !reactIdentity(b.react))) return false;
      if (!fields(b.pointer, ["clientX", "clientY", "pageX", "pageY", "pointerType", "timestamp"]) || !bounded(b.pointer.pointerType, 32)) return false;
      const pointer = b.pointer;
      return ["clientX", "clientY", "pageX", "pageY", "timestamp"].every(k => typeof pointer[k] === "number" && Number.isFinite(pointer[k])) &&
        (pointer.timestamp as number) >= 0 &&
        (b.documentId === undefined || bounded(b.documentId)) && (b.runtimeTargetId === undefined || bounded(b.runtimeTargetId));
    }
    case "ERROR": return fields(p, ["code", "message"]) && WHY_UI_ERROR_CODES.includes(p.code as WhyUiErrorCode) && (p.message === undefined || bounded(p.message, 512));
  }
}

export function serializeBridgeMessage<T>(message: BridgeMessage<T>): string {
  return JSON.stringify(message);
}

export function parseBridgeMessage(raw: string): BridgeMessage<unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isBridgeEnvelope(parsed)) return parsed;
    return null;
  } catch {
    return null;
  }
}
