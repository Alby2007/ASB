import { createHash, createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { config } from "./config.js";

/**
 * At-rest encryption for per-guild LLM keys (BYOK). AES-256-GCM with a random
 * IV per write; the master key is SHA-256 of KEY_ENCRYPTION_SECRET so any
 * passphrase works — no format foot-gun. Blobs are `iv ‖ tag ‖ ciphertext`.
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

/** Belt-and-braces: scrub known secrets out of text before it hits logs —
 * SDK error objects can echo request config including the bearer token. */
export function redactSecrets(text: string, secrets: Array<string | undefined>): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 8) out = out.split(s).join("***");
  }
  return out;
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
