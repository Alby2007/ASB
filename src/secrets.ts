import { createHash, createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { config } from "./config.js";

/**
 * At-rest encryption for per-guild LLM keys (BYOK). AES-256-GCM with a random
 * IV per write; the master key is SHA-256 of KEY_ENCRYPTION_SECRET so any
 * passphrase works — no format foot-gun. Blobs are `iv ‖ ciphertext ‖ tag`.
 *
 * decrypt throws on auth-tag failure — that's the tamper/wrong-master-key
 * signal; callers (brains.ts) translate it to "guild dormant" + a metric.
 */

const IV_LEN = 12;
const TAG_LEN = 16;

function masterKey(): Buffer {
  if (!config.keyEncryptionSecret) {
    throw new Error("KEY_ENCRYPTION_SECRET is not configured — set it in the environment to use per-guild keys");
  }
  return createHash("sha256").update(config.keyEncryptionSecret).digest();
}

export function encryptSecret(plaintext: string): Buffer {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", masterKey(), iv);
  return Buffer.concat([iv, cipher.update(plaintext, "utf8"), cipher.final(), cipher.getAuthTag()]);
}

export function decryptSecret(blob: Buffer): string {
  if (blob.length < IV_LEN + TAG_LEN) throw new Error("encrypted secret is too short");
  const iv = blob.subarray(0, IV_LEN);
  const tag = blob.subarray(blob.length - TAG_LEN);
  const ciphertext = blob.subarray(IV_LEN, blob.length - TAG_LEN);
  const decipher = createDecipheriv("aes-256-gcm", masterKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

/** Last-4 display hint — "…abcd". Never show more of a key than this. */
export function maskKey(key: string): string {
  return `…${key.slice(-4)}`;
}

// ── Secret registry + safe error logging ──────────────────────────────────────
// Every credential the process handles is registered (Brain registers API keys
// on construction; index.ts registers the Discord token / DB URL / master
// secret at boot). redactSecrets scrubs all of them plus Bearer-style auth
// headers out of arbitrary text — SDK error objects can echo the full request
// config, including the Authorization header, into logs.

const registeredSecrets = new Set<string>();

export function registerSecret(secret: string | undefined | null): void {
  if (secret && secret.length >= 8) registeredSecrets.add(secret);
}

/** Bearer/other auth headers captured inside serialized SDK error objects. */
const AUTH_HEADER_RE = /((?:authorization|api[_-]?key|token)["':\s=]+(?:bearer\s+)?)[A-Za-z0-9_\-\.\/+=]{8,}/gi;

/** Scrub registered secrets and auth-header-shaped tokens out of text before
 * it hits logs. */
export function redactSecrets(text: string, secrets: Array<string | undefined> = []): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 8) out = out.split(s).join("***");
  for (const s of registeredSecrets) out = out.split(s).join("***");
  return out.replace(AUTH_HEADER_RE, "$1***");
}

/** Serialize an error with stack + enumerable/own props (where SDK errors hide
 * the request config), then redact every known secret out of it. */
export function errorText(err: unknown): string {
  let text: string;
  try {
    const base = err instanceof Error ? (err.stack ?? err.message) : String(err);
    let extra = "";
    if (err && typeof err === "object") {
      try { extra = JSON.stringify(err); } catch { /* circular — base only */ }
    }
    text = extra && extra !== "{}" ? `${base}\n${extra}` : base;
  } catch {
    text = "unprintable error";
  }
  return redactSecrets(text);
}

/** console.error with secrets stripped — use for ANY error that could carry
 * request config, response bodies, or env-derived values. */
export function logError(prefix: string, err: unknown): void {
  console.error(prefix, errorText(err));
}

export type KeyValidation =
  | { ok: true }
  | { ok: false; status: number }
  | { ok: false; unreachable: true };

/** Live-check a candidate LLM key against the provider's /models endpoint.
 * 401/403 → definitively invalid (don't store); anything else failing →
 * unreachable (store unvalidated, retry on first use). fetch injectable for tests. */
export async function validateLlmKey(
  key: string, baseUrl: string, fetchImpl: typeof fetch = fetch
): Promise<KeyValidation> {
  try {
    const res = await fetchImpl(`${baseUrl.replace(/\/$/, "")}/models`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) return { ok: true };
    if (res.status === 401 || res.status === 403) return { ok: false, status: res.status };
    return { ok: false, unreachable: true };
  } catch {
    return { ok: false, unreachable: true };
  }
}
