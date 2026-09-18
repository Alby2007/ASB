import "dotenv/config";
import assert from "node:assert/strict";
import test from "node:test";
import type postgres from "postgres";
import type { Guild } from "discord.js";
import { makeTestSql, makeStore } from "./test-helpers.js";
import { announceIfNeeded, handleGuildDelete } from "./guild-lifecycle.js";

// ── Consent posture: dormant defaults, announcement idempotency, kick-purge ──

test("settings() on a fresh guild returns dormant defaults; explicit values persist", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const fresh = await store.settings("g-fresh");
    assert.equal(fresh.memoryEnabled, 0);
    assert.equal(fresh.replyEnabled, 0);
    assert.equal(fresh.announcedAt, null);

    // An admin resuming flips both — and the explicit values stick.
    await store.setPaused("g-fresh", false);
    const resumed = await store.settings("g-fresh");
    assert.equal(resumed.memoryEnabled, 1);
    assert.equal(resumed.replyEnabled, 1);
  } finally { await sql.end(); }
});

test("markAnnounced stamps announced_at and reports row existence", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    assert.equal(await store.markAnnounced("g-none"), false, "no settings row → nothing stamped");
    await store.settings("g-marked"); // creates the row
    assert.equal(await store.markAnnounced("g-marked"), true);
    assert.ok((await store.settings("g-marked")).announcedAt);
  } finally { await sql.end(); }
});

/** Insert one row into every guild-scoped table so purge coverage is total. */
async function seedGuild(sql: ReturnType<typeof postgres>, g: string) {
  const mid = `${g}-m1`;
  await sql`INSERT INTO messages (id, guild_id, channel_id, author_id, author_name, content, created_at) VALUES (${mid}, ${g}, 'c1', 'u1', 'Alice', 'hi', now())`;
  await sql`INSERT INTO members (guild_id, user_id, known_names, first_seen_at, last_seen_at) VALUES (${g}, 'u1', '{Alice}', now(), now())`;
  await sql`INSERT INTO server_settings (guild_id, memory_enabled, reply_enabled) VALUES (${g}, 1, 1)`;
  await sql`INSERT INTO guild_keys (guild_id, key_enc, key_hint) VALUES (${g}, ${Buffer.from([1, 2, 3])}, '…hint')`;
  const [mem] = await sql`INSERT INTO memories (guild_id, subject_id, kind, content, confidence, importance) VALUES (${g}, 'u1', 'fact', 'likes tea', 0.9, 0.5) RETURNING id`;
  const [ev] = await sql`INSERT INTO events (guild_id, channel_id, occurred_at) VALUES (${g}, 'c1', now()) RETURNING id`;
  const [evid] = await sql`INSERT INTO memory_evidence (memory_id, message_id, author_id, quote, reason, explicitness, observed_at) VALUES (${mem.id}, ${mid}, 'u1', 'q', 'r', 0.9, now()) RETURNING id`;
  await sql`INSERT INTO memory_history (memory_id, action, evidence_id) VALUES (${mem.id}, 'created', ${evid.id})`;
  await sql`INSERT INTO event_messages (event_id, message_id) VALUES (${ev.id}, ${mid})`;
  await sql`INSERT INTO event_memories (event_id, memory_id) VALUES (${ev.id}, ${mem.id})`;
  await sql`INSERT INTO event_participants (event_id, user_id, user_name) VALUES (${ev.id}, 'u1', 'Alice')`;
  await sql`INSERT INTO profiles (guild_id, subject_id) VALUES (${g}, 'u1')`;
  await sql`INSERT INTO profile_attributes (guild_id, subject_id, field, value, value_norm, confidence, status) VALUES (${g}, 'u1', 'f', 'v', 'v', 0.9, 'active')`;
  await sql`INSERT INTO relationship_observations (guild_id, subject_id, other_id, message_id, nature) VALUES (${g}, 'u1', 'u2', ${mid}, 'friend')`;
  await sql`INSERT INTO relationships (guild_id, subject_id, other_id) VALUES (${g}, 'u1', 'u2')`;
  await sql`INSERT INTO behavioral_patterns (guild_id, subject_id, description) VALUES (${g}, 'u1', 'early riser')`;
  await sql`INSERT INTO alias_candidates (guild_id, user_id, name, source) VALUES (${g}, 'u1', 'Al', 'observed')`;
  await sql`INSERT INTO unresolved_names (guild_id, name, message_id) VALUES (${g}, 'Bob', ${mid})`;
}

/** Row counts across every guild-scoped table, including junction tables
 * reached through their parents (they carry no guild_id). */
async function guildRowTotal(sql: ReturnType<typeof postgres>, g: string): Promise<number> {
  const scoped = ["messages", "members", "server_settings", "guild_keys", "memories", "events", "profiles",
    "profile_attributes", "relationship_observations", "relationships", "behavioral_patterns", "alias_candidates", "unresolved_names"];
  let total = 0;
  for (const t of scoped) {
    const [r] = await sql`SELECT count(*)::int AS c FROM ${sql(t)} WHERE guild_id = ${g}`;
    total += r.c;
  }
  const [j] = await sql`SELECT
    (SELECT count(*)::int FROM memory_history WHERE memory_id IN (SELECT id FROM memories WHERE guild_id = ${g}))
    + (SELECT count(*)::int FROM memory_evidence WHERE memory_id IN (SELECT id FROM memories WHERE guild_id = ${g}))
    + (SELECT count(*)::int FROM event_messages WHERE event_id IN (SELECT id FROM events WHERE guild_id = ${g}))
    + (SELECT count(*)::int FROM event_memories WHERE event_id IN (SELECT id FROM events WHERE guild_id = ${g}))
    + (SELECT count(*)::int FROM event_participants WHERE event_id IN (SELECT id FROM events WHERE guild_id = ${g})) AS c`;
  return total + j.c;
}

test("purgeGuild removes every row for the guild and leaves other guilds intact", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    await seedGuild(sql, "g-purged");
    await seedGuild(sql, "g-kept");
    assert.ok(await guildRowTotal(sql, "g-purged") > 15, "seed should cover every table");
    const keptBefore = await guildRowTotal(sql, "g-kept");
    await store.purgeGuild("g-purged");
    assert.equal(await guildRowTotal(sql, "g-purged"), 0, "every row for the purged guild must be gone");
    assert.equal(await guildRowTotal(sql, "g-kept"), keptBefore, "other guild must be fully intact");
  } finally { await sql.end(); }
});

// ── announceIfNeeded ─────────────────────────────────────────────────────────

function stubGuild(opts: { id?: string; channel?: unknown } = {}) {
  const sent: unknown[] = [];
  const channel = opts.channel === undefined
    ? { type: 0, send: async (m: unknown) => { sent.push(m); } }
    : opts.channel;
  const guild = {
    id: opts.id ?? "g-announce",
    name: "Test Guild",
    systemChannel: channel,
    members: { me: null },
    channels: { cache: { find: () => undefined } },
  } as unknown as Guild;
  return { guild, sent };
}

test("announceIfNeeded posts once, stamps, and no-ops on repeat", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const { guild, sent } = stubGuild();
    assert.equal(await announceIfNeeded(guild, store), true);
    assert.equal(sent.length, 1, "disclosure card should post exactly once");
    assert.ok((await store.settings("g-announce")).announcedAt, "announce should stamp announced_at");

    // Second call — e.g. GuildCreate firing again on reconnect — must not repost.
    const { guild: again, sent: sent2 } = stubGuild();
    assert.equal(await announceIfNeeded(again, store), false);
    assert.equal(sent2.length, 0);
  } finally { await sql.end(); }
});

test("announceIfNeeded leaves announced_at NULL when no send succeeds", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    // Send throws → error propagates, no stamp (next GuildCreate retries).
    const failing = { type: 0, send: async () => { throw new Error("missing access"); } };
    const { guild } = stubGuild({ id: "g-nosend", channel: failing });
    await assert.rejects(announceIfNeeded(guild, store));
    assert.equal((await store.settings("g-nosend")).announcedAt, null);

    // No channel at all → returns false, no stamp, no throw.
    const { guild: none } = stubGuild({ id: "g-nochan", channel: null });
    assert.equal(await announceIfNeeded(none, store), false);
    assert.equal((await store.settings("g-nochan")).announcedAt, null);
  } finally { await sql.end(); }
});

// ── handleGuildDelete ────────────────────────────────────────────────────────

test("handleGuildDelete never purges an unavailable guild; a real kick purges", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    await seedGuild(sql, "g-outage");
    assert.equal(await handleGuildDelete({ id: "g-outage", name: "Outage", unavailable: true }, store), false);
    assert.ok(await guildRowTotal(sql, "g-outage") > 0, "outage must not delete anything");

    await seedGuild(sql, "g-kicked");
    assert.equal(await handleGuildDelete({ id: "g-kicked", name: "Kicked" }, store), true);
    assert.equal(await guildRowTotal(sql, "g-kicked"), 0);
  } finally { await sql.end(); }
});
