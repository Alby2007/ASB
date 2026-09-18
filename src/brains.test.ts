import "dotenv/config";
import assert from "node:assert/strict";
import test from "node:test";
import { config } from "./config.js";
import { createBrainResolver } from "./brains.js";
import { encryptSecret } from "./secrets.js";

config.keyEncryptionSecret = "test-master-passphrase";

const ENV = { envKey: "env-key", envModel: "env-model", envBaseUrl: "https://env/v1" };
const enc = (key: string) => encryptSecret(key);
const row = (key: string, baseUrl: string | null = null) => ({ keyEnc: enc(key), baseUrl });

function resolver(getKey: (g: string) => Promise<{ keyEnc: Buffer; baseUrl: string | null } | null>, requireGuildKeys = false) {
  return createBrainResolver({ getKey, ...ENV, requireGuildKeys });
}

test("guild key beats the env fallback", async () => {
  let calls = 0;
  const { brainFor } = resolver(async () => { calls++; return row("guild-key"); });
  const brain = await brainFor("g1");
  assert.ok(brain);
  // Second resolution is a cache hit — no second getKey call.
  assert.equal(await brainFor("g1"), brain);
  assert.equal(calls, 1);
});

test("no guild key → env fallback", async () => {
  const { brainFor } = resolver(async () => null);
  assert.ok(await brainFor("g1"));
});

test("requireGuildKeys blocks the env fallback → dormant", async () => {
  const { brainFor } = resolver(async () => null, true);
  assert.equal(await brainFor("g1"), null);
  // requireGuildKeys doesn't block a real guild key — only the env fallback.
  const keyed = resolver(async () => row("guild-key"), true);
  assert.ok(await keyed.brainFor("g1"));
});

test("undecryptable row → null (dormant), not a crash", async () => {
  const bad = Buffer.from("not-a-valid-gcm-blob-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  const { brainFor } = resolver(async () => ({ keyEnc: bad, baseUrl: null }));
  assert.equal(await brainFor("g1"), null);
});

test("unverified guild row revalidates once and marks validated on success", async () => {
  const marked: string[] = [];
  const seen: Array<{ key: string; baseUrl: string }> = [];
  const { brainFor } = createBrainResolver({
    getKey: async () => ({ ...row("guild-key", "https://guild.example/v1"), validatedAt: null }),
    ...ENV, requireGuildKeys: false,
    markValidated: async g => { marked.push(g); },
    revalidate: async (key, baseUrl) => { seen.push({ key, baseUrl }); return true; },
  });
  await brainFor("g1");
  await new Promise(r => setTimeout(r, 0)); // flush the fire-and-forget revalidate chain
  assert.deepEqual(seen, [{ key: "guild-key", baseUrl: "https://guild.example/v1" }]);
  assert.deepEqual(marked, ["g1"]);
});

test("already-validated rows skip revalidation; failed revalidation doesn't mark", async () => {
  const marked: string[] = [];
  let revalidateCalls = 0;
  const validated = createBrainResolver({
    getKey: async () => ({ ...row("guild-key"), validatedAt: "2026-01-01T00:00:00Z" }),
    ...ENV, requireGuildKeys: false,
    markValidated: async g => { marked.push(g); },
    revalidate: async () => { revalidateCalls++; return true; },
  });
  await validated.brainFor("g1");
  await new Promise(r => setTimeout(r, 0));
  assert.equal(revalidateCalls, 0);

  const failing = createBrainResolver({
    getKey: async () => ({ ...row("guild-key"), validatedAt: null }),
    ...ENV, requireGuildKeys: false,
    markValidated: async g => { marked.push(g); },
    revalidate: async () => false,
  });
  await failing.brainFor("g2");
  await new Promise(r => setTimeout(r, 0));
  assert.deepEqual(marked, []);
});

test("invalidate forces re-resolution (key rotation)", async () => {
  let current: { keyEnc: Buffer; baseUrl: string | null } | null = row("key-v1");
  const { brainFor, invalidate } = resolver(async () => current);
  const first = await brainFor("g1");
  current = row("key-v2");
  assert.equal(await brainFor("g1"), first); // cached
  invalidate("g1");
  const second = await brainFor("g1");
  assert.ok(second);
  assert.notEqual(second, first);
});
