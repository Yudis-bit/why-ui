import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EXTENSION_ORIGIN } from "../bridge-protocol.js";

export interface StoredAuth {
  deviceSecret: string;
  pairedOrigin?: string | undefined;
  pairedAt?: number | undefined;
}

export interface PairingState {
  token: string;
  expiresAt: number;
  consumed: boolean;
}

export function getDefaultConfigDir(): string {
  return process.env.WHY_UI_CONFIG_DIR || path.join(os.homedir(), ".why-ui");
}

function readAuth(authFile: string): StoredAuth {
  try {
    const stat = fs.lstatSync(authFile);
    if (!stat.isFile() || stat.size > 4096) throw new Error();
    const data: unknown = JSON.parse(fs.readFileSync(authFile, "utf8"));
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error();
    const value = data as StoredAuth;
    if (typeof value.deviceSecret !== "string" || !/^[a-f0-9]{64}$/.test(value.deviceSecret) ||
      (value.pairedOrigin !== undefined && (typeof value.pairedOrigin !== "string" || !EXTENSION_ORIGIN.test(value.pairedOrigin)))) throw new Error();
    return value;
  } catch { throw new Error("Invalid why-ui auth state. Move auth.json aside to pair again."); }
}

/** Read-only onboarding status; never creates auth state or returns credentials. */
export function readPairingStatus(customDir?: string): "missing" | "unpaired" | "paired" | "invalid" {
  const file = path.join(customDir ?? getDefaultConfigDir(), "auth.json");
  if (!fs.existsSync(file)) return "missing";
  try { return readAuth(file).pairedOrigin ? "paired" : "unpaired"; }
  catch { return "invalid"; }
}

export function loadOrCreateDeviceSecret(customDir?: string): { secret: string; pairedOrigin?: string | undefined; configPath: string } {
  const dir = customDir ?? getDefaultConfigDir();
  const authFile = path.join(dir, "auth.json");

  if (fs.existsSync(authFile)) {
    const data = readAuth(authFile);
    if (process.platform !== "win32") fs.chmodSync(authFile, 0o600);
    return { secret: data.deviceSecret, pairedOrigin: data.pairedOrigin, configPath: authFile };
  }

  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const secret = crypto.randomBytes(32).toString("hex");
  const data: StoredAuth = { deviceSecret: secret };
  fs.writeFileSync(authFile, JSON.stringify(data, null, 2), { encoding: "utf8", mode: 0o600, flag: "wx" });
  return { secret, configPath: authFile };
}

export function updatePairedOrigin(configDir: string | undefined, origin: string): void {
  const dir = configDir ?? getDefaultConfigDir();
  const authFile = path.join(dir, "auth.json");
    if (!EXTENSION_ORIGIN.test(origin)) throw new Error("Invalid extension origin.");
    const data = readAuth(authFile);
    data.pairedOrigin = origin;
    data.pairedAt = Date.now();
    fs.writeFileSync(authFile, JSON.stringify(data, null, 2), { encoding: "utf8", mode: 0o600 });
    if (process.platform !== "win32") fs.chmodSync(authFile, 0o600);
}

/** Explicit local CLI recovery; never available over the bridge or MCP. */
export function resetDevicePairing(customDir?: string): void {
  const dir = path.resolve(customDir ?? getDefaultConfigDir());
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const authFile = path.join(dir, "auth.json"), temporary = path.join(dir, `.auth-${crypto.randomBytes(8).toString("hex")}.tmp`);
  if (fs.existsSync(authFile) && !fs.lstatSync(authFile).isFile()) throw new Error("Auth state must be a regular file.");
  try {
    fs.writeFileSync(temporary, JSON.stringify({ deviceSecret: crypto.randomBytes(32).toString("hex") }), { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, authFile);
    if (process.platform !== "win32") fs.chmodSync(authFile, 0o600);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}

export class PairingManager {
  private activePairing: PairingState | null = null;
  private pairingTimeoutMs = 120_000; // 2 minutes

  constructor(timeoutMs?: number) {
    if (timeoutMs !== undefined && Number.isFinite(timeoutMs)) this.pairingTimeoutMs = Math.max(1, Math.min(120_000, Math.floor(timeoutMs)));
  }

  generatePairingToken(): string {
    const raw = crypto.randomBytes(16);
    // Four groups preserve all 128 random bits.
    const hex = raw.toString("hex");
    const token = `${hex.slice(0, 8)}-${hex.slice(8, 16)}-${hex.slice(16, 24)}-${hex.slice(24, 32)}`;
    this.activePairing = {
      token,
      expiresAt: Date.now() + this.pairingTimeoutMs,
      consumed: false,
    };
    return token;
  }

  getActivePairing(): PairingState | null {
    if (!this.activePairing) return null;
    if (Date.now() >= this.activePairing.expiresAt || this.activePairing.consumed) {
      this.activePairing = null;
      return null;
    }
    return { ...this.activePairing };
  }

  validateAndConsume(candidate: string): boolean {
    if (!this.activePairing) return false;
    if (Date.now() >= this.activePairing.expiresAt) {
      this.activePairing = null;
      return false;
    }
    if (this.activePairing.consumed) return false;

    // Constant time comparison for token
    const expectedBuf = Buffer.from(this.activePairing.token, "utf8");
    const candidateBuf = Buffer.from(candidate, "utf8");
    if (expectedBuf.length !== candidateBuf.length) return false;

    const matched = crypto.timingSafeEqual(expectedBuf, candidateBuf);
    if (matched) {
      this.activePairing = null;
      return true;
    }
    return false;
  }
}

export function generateNonce(): string {
  return crypto.randomBytes(32).toString("hex");
}

export function computeHmacSha256(secretHex: string, nonceHex: string): string {
  return crypto.createHmac("sha256", Buffer.from(secretHex, "hex")).update(Buffer.from(nonceHex, "hex")).digest("hex");
}

export function verifyHmacSha256(secretHex: string, nonceHex: string, receivedHmacHex: string): boolean {
  try {
    if (![secretHex, nonceHex, receivedHmacHex].every(v => /^[a-f0-9]{64}$/.test(v))) return false;
    const expected = computeHmacSha256(secretHex, nonceHex);
    const expectedBuf = Buffer.from(expected, "hex");
    const receivedBuf = Buffer.from(receivedHmacHex, "hex");
    if (expectedBuf.length !== receivedBuf.length) return false;
    return crypto.timingSafeEqual(expectedBuf, receivedBuf);
  } catch {
    return false;
  }
}

export function generateSessionToken(): string {
  return crypto.randomBytes(32).toString("hex");
}
