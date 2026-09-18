import "dotenv/config";
import assert from "node:assert/strict";
import test from "node:test";
import { config } from "./config.js";
import { decryptSecret, encryptSecret, errorText, maskKey, redactSecrets, registerSecret, validateLlmKey } from "./secrets.js";

// config is parsed at import; masterKey() reads it lazily per call so tests
// can point it at a fixture passphrase.
const MASTER = "test-master-passphrase";
config.keyEncryptionSecret = MASTER;

test("encrypt/decrypt roundtrips a key", () => {
  const blob = encryptSecret("gsk_live_abc123");
  assert.equal(decryptSecret(blob), "gsk_live_abc123");
});

test("two encryptions of the same plaintext differ (random IV)", () => {
  assert.notDeepEqual(encryptSecret("same-key"), encryptSecret("same-key"));
});

test("decrypt throws under the wrong master key", () => {
  const blob = encryptSecret("gsk_live_abc123");
  config.keyEncryptionSecret = "a-different-passphrase";
  try {
    assert.throws(() => decryptSecret(blob));
  } finally { config.keyEncryptionSecret = MASTER; }
});

test("decrypt throws on a tampered ciphertext byte", () => {
  const blob = encryptSecret("gsk_live_abc123");
  blob[blob.length - 20] ^= 0xff;
  assert.throws(() => decryptSecret(blob));
});

test("encrypt throws helpfully when the master secret is unset", () => {
  const saved = config.keyEncryptionSecret;
  config.keyEncryptionSecret = undefined;
  try {
    assert.throws(() => encryptSecret("x"), /KEY_ENCRYPTION_SECRET/);
  } finally { config.keyEncryptionSecret = saved; }
});

test("maskKey shows only the last 4 chars", () => {
  assert.equal(maskKey("gsk_live_abc123"), "…c123");
  assert.equal(maskKey("abcd"), "…abcd");
});

test("redactSecrets scrubs key occurrences from log text", () => {
  const log = `Request failed: Authorization: Bearer gsk_live_abc123 at https://api.groq.com`;
  assert.equal(redactSecrets(log, ["gsk_live_abc123"]), "Request failed: Authorization: Bearer *** at https://api.groq.com");
  // Short/undefined secrets are skipped — scrubbing "ab" would mangle prose.
  assert.equal(redactSecrets("abc", ["ab", undefined]), "abc");
});

test("redactSecrets strips registered secrets without an explicit list", () => {
  registerSecret("gsk_registered_secret_12345");
  assert.equal(redactSecrets("call failed for gsk_registered_secret_12345"), "call failed for ***");
});

test("redactSecrets strips auth-header-shaped tokens it never registered", () => {
  // SDK error objects serialize request config — the bearer token inside must
  // be scrubbed even when the exact secret isn't in the registry.
  assert.match(redactSecrets(`"headers":{"authorization":"Bearer sk-live-token-xyz"}`), /Bearer \*\*\*/);
  assert.match(redactSecrets(`api_key=gsk_live_abcdefghijk`), /api_key=\*\*\*/);
});

test("errorText serializes an SDK-style error and scrubs its request config", () => {
  registerSecret("gsk_the_real_key_99999");
  const sdkErr = Object.assign(new Error("401 Unauthorized"), {
    status: 401,
    config: { headers: { authorization: "Bearer gsk_the_real_key_99999" }, baseURL: "https://api.groq.com/openai/v1" },
  });
  const out = errorText(sdkErr);
  assert.ok(!out.includes("gsk_the_real_key_99999"), `leaked key in: ${out}`);
  assert.match(out, /401 Unauthorized/);            // message survives
  assert.match(out, /api\.groq\.com/);              // non-secret context survives
});

// ── validateLlmKey ────────────────────────────────────────────────────────────

const fakeFetch = (status: number) => (async () => ({ ok: status >= 200 && status < 300, status })) as unknown as typeof fetch;

test("validateLlmKey: 200 → ok, 401/403 → invalid, other → unreachable", async () => {
  assert.deepEqual(await validateLlmKey("k", "https://x/v1", fakeFetch(200)), { ok: true });
  assert.deepEqual(await validateLlmKey("k", "https://x/v1", fakeFetch(401)), { ok: false, status: 401 });
  assert.deepEqual(await validateLlmKey("k", "https://x/v1", fakeFetch(403)), { ok: false, status: 403 });
  assert.deepEqual(await validateLlmKey("k", "https://x/v1", fakeFetch(500)), { ok: false, unreachable: true });
});

test("validateLlmKey: network failure → unreachable (stored unverified, not rejected)", async () => {
  const dead = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
  assert.deepEqual(await validateLlmKey("k", "https://x/v1", dead), { ok: false, unreachable: true });
});
