import "dotenv/config";
import assert from "node:assert/strict";
import test from "node:test";
import postgres from "postgres";
import { runMigrations, getMigrationVersion, LATEST_MIGRATION_VERSION } from "./migrations.js";

// ── Test DB connection ─────────────────────────────────────────────────────────
// Tests require TEST_DATABASE_URL to be set to a Postgres DB.
// Each test gets a fresh schema by dropping all tables first.

function makeTestSql() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL is required for migration tests");
  return postgres(url, { max: 3, onnotice: () => {} });
}

/** Drop all project tables so each test starts fresh. */
async function resetSchema(sql: ReturnType<typeof postgres>) {
  await sql`DROP TABLE IF EXISTS schema_migrations, profiles, profile_attributes, relationships, relationship_observations, members, event_memories, event_messages, event_participants, events, behavioral_patterns, memory_history, memory_evidence, server_settings, memories, messages CASCADE`;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test("migrations create schema_migrations table", async () => {
  const sql = makeTestSql();
  try {
    await resetSchema(sql);
    await runMigrations(sql as any);
    const rows = await sql`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name='schema_migrations'`;
    assert.equal(rows.length, 1);
  } finally { await sql.end(); }
});

test("migrations are applied in order", async () => {
  const sql = makeTestSql();
  try {
    await resetSchema(sql);
    await runMigrations(sql as any);
    const version = await getMigrationVersion(sql as any);
    assert.equal(version, LATEST_MIGRATION_VERSION);
  } finally { await sql.end(); }
});

test("migrations are idempotent", async () => {
  const sql = makeTestSql();
  try {
    await resetSchema(sql);
    await runMigrations(sql as any);
    const firstVersion = await getMigrationVersion(sql as any);
    await runMigrations(sql as any);
    const secondVersion = await getMigrationVersion(sql as any);
    assert.equal(firstVersion, secondVersion);
  } finally { await sql.end(); }
});

test("migration adds expected columns to memories table", async () => {
  const sql = makeTestSql();
  try {
    await resetSchema(sql);
    await runMigrations(sql as any);
    const rows = await sql<Array<{ column_name: string }>>`SELECT column_name FROM information_schema.columns WHERE table_name='memories'`;
    const cols = rows.map(r => r.column_name);
    for (const col of ["confirmation_count", "contradiction_count", "updated_at", "last_contradicted_at", "supersedes_memory_id"]) {
      assert.ok(cols.includes(col), `Missing column: ${col}`);
    }
  } finally { await sql.end(); }
});

test("migration adds expected columns to memory_evidence table", async () => {
  const sql = makeTestSql();
  try {
    await resetSchema(sql);
    await runMigrations(sql as any);
    const rows = await sql<Array<{ column_name: string }>>`SELECT column_name FROM information_schema.columns WHERE table_name='memory_evidence'`;
    const cols = rows.map(r => r.column_name);
    for (const col of ["evidence_type", "effect", "message_content_snapshot", "message_timestamp", "created_at"]) {
      assert.ok(cols.includes(col), `Missing column: ${col}`);
    }
  } finally { await sql.end(); }
});

test("migration creates memory_history table", async () => {
  const sql = makeTestSql();
  try {
    await resetSchema(sql);
    await runMigrations(sql as any);
    const rows = await sql`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name='memory_history'`;
    assert.equal(rows.length, 1);
  } finally { await sql.end(); }
});

test("migration creates expected indexes", async () => {
  const sql = makeTestSql();
  try {
    await resetSchema(sql);
    await runMigrations(sql as any);
    const rows = await sql<Array<{ indexname: string }>>`SELECT indexname FROM pg_indexes WHERE schemaname='public'`;
    const names = rows.map(r => r.indexname);
    assert.ok(names.includes("memory_history_lookup"), "Missing index: memory_history_lookup");
  } finally { await sql.end(); }
});

test("migration version tracking works correctly", async () => {
  const sql = makeTestSql();
  try {
    await resetSchema(sql);
    await runMigrations(sql as any, 1);
    assert.equal(await getMigrationVersion(sql as any), 1);
    const rows = await sql<Array<{ version: number }>>`SELECT version FROM schema_migrations ORDER BY version`;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].version, 1);
  } finally { await sql.end(); }
});

test("migration v2 adds net_score, frozen_confidence, and pattern_id columns to memories", async () => {
  const sql = makeTestSql();
  try {
    await resetSchema(sql);
    await runMigrations(sql as any);
    const rows = await sql<Array<{ column_name: string }>>`SELECT column_name FROM information_schema.columns WHERE table_name='memories'`;
    const cols = rows.map(r => r.column_name);
    for (const col of ["net_score", "frozen_confidence", "pattern_id"]) {
      assert.ok(cols.includes(col), `Missing column: ${col}`);
    }
  } finally { await sql.end(); }
});

test("migration v2 creates behavioral_patterns table with expected columns", async () => {
  const sql = makeTestSql();
  try {
    await resetSchema(sql);
    await runMigrations(sql as any);
    const tables = await sql`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name='behavioral_patterns'`;
    assert.equal(tables.length, 1);
    const rows = await sql<Array<{ column_name: string }>>`SELECT column_name FROM information_schema.columns WHERE table_name='behavioral_patterns'`;
    const cols = rows.map(r => r.column_name);
    for (const col of ["guild_id", "subject_id", "description", "episode_count", "confidence", "status"]) {
      assert.ok(cols.includes(col), `Missing column: ${col}`);
    }
  } finally { await sql.end(); }
});

test("migration v2 creates patterns_lookup index", async () => {
  const sql = makeTestSql();
  try {
    await resetSchema(sql);
    await runMigrations(sql as any);
    const rows = await sql<Array<{ indexname: string }>>`SELECT indexname FROM pg_indexes WHERE schemaname='public'`;
    assert.ok(rows.some(r => r.indexname === "patterns_lookup"), "Missing index: patterns_lookup");
  } finally { await sql.end(); }
});

test("migrations can be applied incrementally", async () => {
  const sql = makeTestSql();
  try {
    await resetSchema(sql);
    await runMigrations(sql as any, 1);
    assert.equal(await getMigrationVersion(sql as any), 1);
    await runMigrations(sql as any, 2);
    assert.equal(await getMigrationVersion(sql as any), 2);
    await runMigrations(sql as any, 3);
    assert.equal(await getMigrationVersion(sql as any), 3);
  } finally { await sql.end(); }
});

test("rolling back to v1 removes behavioral_patterns table and index", async () => {
  const sql = makeTestSql();
  try {
    await resetSchema(sql);
    await runMigrations(sql as any);
    assert.equal(await getMigrationVersion(sql as any), LATEST_MIGRATION_VERSION);
    await runMigrations(sql as any, 1);
    assert.equal(await getMigrationVersion(sql as any), 1);
    const tables = await sql`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name='behavioral_patterns'`;
    assert.equal(tables.length, 0, "behavioral_patterns should be gone after rollback");
  } finally { await sql.end(); }
});

test("migration v3 adds primary_evidence_type column to memories", async () => {
  const sql = makeTestSql();
  try {
    await resetSchema(sql);
    await runMigrations(sql as any);
    const rows = await sql<Array<{ column_name: string }>>`SELECT column_name FROM information_schema.columns WHERE table_name='memories'`;
    assert.ok(rows.some(r => r.column_name === "primary_evidence_type"), "Missing column: primary_evidence_type");
  } finally { await sql.end(); }
});

test("migration v4 creates events, event_participants, event_messages, event_memories tables", async () => {
  const sql = makeTestSql();
  try {
    await resetSchema(sql);
    await runMigrations(sql as any);
    const rows = await sql<Array<{ table_name: string }>>`SELECT table_name FROM information_schema.tables WHERE table_schema='public'`;
    const names = rows.map(r => r.table_name);
    for (const name of ["events", "event_participants", "event_messages", "event_memories"]) {
      assert.ok(names.includes(name), `Missing table: ${name}`);
    }
    const cols = await sql<Array<{ column_name: string }>>`SELECT column_name FROM information_schema.columns WHERE table_name='memories'`;
    assert.ok(cols.some(c => c.column_name === "event_id"), "memories.event_id column missing");
  } finally { await sql.end(); }
});

test("migration v4 creates expected indexes", async () => {
  const sql = makeTestSql();
  try {
    await resetSchema(sql);
    await runMigrations(sql as any);
    const rows = await sql<Array<{ indexname: string }>>`SELECT indexname FROM pg_indexes WHERE schemaname='public'`;
    const names = rows.map(r => r.indexname);
    for (const name of ["events_guild_channel", "events_guild_open", "event_participants_event", "event_messages_event", "event_memories_memory", "event_memories_event"]) {
      assert.ok(names.includes(name), `Missing index: ${name}`);
    }
  } finally { await sql.end(); }
});

test("migration v7 creates members, relationship_observations, relationships, profiles tables and reply_to_id column", async () => {
  const sql = makeTestSql();
  try {
    await resetSchema(sql);
    await runMigrations(sql as any);
    const rows = await sql<Array<{ table_name: string }>>`SELECT table_name FROM information_schema.tables WHERE table_schema='public'`;
    const names = rows.map(r => r.table_name);
    for (const name of ["members", "relationship_observations", "relationships", "profiles"]) {
      assert.ok(names.includes(name), `Missing table: ${name}`);
    }
    const cols = await sql<Array<{ column_name: string }>>`SELECT column_name FROM information_schema.columns WHERE table_name='messages'`;
    assert.ok(cols.some(c => c.column_name === "reply_to_id"), "messages.reply_to_id column missing");
    const memberCols = await sql<Array<{ column_name: string }>>`SELECT column_name FROM information_schema.columns WHERE table_name='members'`;
    const mcols = memberCols.map(r => r.column_name);
    for (const col of ["guild_id", "user_id", "known_names", "first_seen_at", "last_seen_at", "message_count", "opted_out"]) {
      assert.ok(mcols.includes(col), `Missing members column: ${col}`);
    }
  } finally { await sql.end(); }
});

test("migration v12 creates profile_attributes + profiles.attr_hash, rolls back cleanly", async () => {
  const sql = makeTestSql();
  try {
    await resetSchema(sql);
    await runMigrations(sql as any);
    const cols = await sql<Array<{ column_name: string }>>`SELECT column_name FROM information_schema.columns WHERE table_name='profile_attributes'`;
    const names = cols.map(c => c.column_name);
    for (const col of ["guild_id", "subject_id", "field", "value", "value_norm", "confidence", "memory_ids", "status", "superseded_by", "first_seen_at", "last_seen_at"]) {
      assert.ok(names.includes(col), `Missing column: ${col}`);
    }
    const profileCols = await sql<Array<{ column_name: string }>>`SELECT column_name FROM information_schema.columns WHERE table_name='profiles'`;
    assert.ok(profileCols.some(c => c.column_name === "attr_hash"), "profiles.attr_hash missing");
    // Create-only: no rows are written by the migration itself.
    const count = await sql<[{ n: number }]>`SELECT COUNT(*)::int AS n FROM profile_attributes`;
    assert.equal(count[0].n, 0);

    await runMigrations(sql as any, 11);
    const tables = await sql<Array<{ table_name: string }>>`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name='profile_attributes'`;
    assert.equal(tables.length, 0, "profile_attributes should be dropped on rollback");
    const remaining = await sql<Array<{ column_name: string }>>`SELECT column_name FROM information_schema.columns WHERE table_name='profiles' AND column_name='attr_hash'`;
    assert.equal(remaining.length, 0, "attr_hash should be dropped on rollback");
  } finally { await sql.end(); }
});

test("migration v14 adds members.opted_in, rolls back cleanly", async () => {
  const sql = makeTestSql();
  try {
    await resetSchema(sql);
    await runMigrations(sql as any);
    const cols = await sql<Array<{ column_name: string }>>`SELECT column_name FROM information_schema.columns WHERE table_name='members'`;
    assert.ok(cols.some(c => c.column_name === "opted_in"), "members.opted_in missing");

    await runMigrations(sql as any, 13);
    const remaining = await sql<Array<{ column_name: string }>>`SELECT column_name FROM information_schema.columns WHERE table_name='members' AND column_name='opted_in'`;
    assert.equal(remaining.length, 0, "opted_in should be dropped on rollback");
  } finally { await sql.end(); }
});

test("migration v15 creates guild_keys, rolls back cleanly", async () => {
  const sql = makeTestSql();
  try {
    await resetSchema(sql);
    await runMigrations(sql as any);
    const cols = await sql<Array<{ column_name: string }>>`SELECT column_name FROM information_schema.columns WHERE table_name='guild_keys'`;
    const names = cols.map(c => c.column_name);
    for (const col of ["key_enc", "key_hint", "base_url", "validated_at", "created_at", "updated_at"]) {
      assert.ok(names.includes(col), `guild_keys.${col} missing`);
    }
    // No plaintext key column may exist — ciphertext only.
    assert.ok(!names.includes("api_key") && !names.includes("key"), "no plaintext key column");

    await runMigrations(sql as any, 14);
    const tables = await sql<Array<{ table_name: string }>>`SELECT table_name FROM information_schema.tables WHERE table_name='guild_keys'`;
    assert.equal(tables.length, 0, "guild_keys should be dropped on rollback");
  } finally { await sql.end(); }
});

test("migration v16 flips observe defaults to dormant and adds announced_at", async () => {
  const sql = makeTestSql();
  try {
    await resetSchema(sql);
    await runMigrations(sql as any);
    const defaults = await sql<Array<{ column_name: string; column_default: string | null }>>`
      SELECT column_name, column_default FROM information_schema.columns
      WHERE table_name = 'server_settings' AND column_name IN ('memory_enabled', 'reply_enabled', 'announced_at')
    `;
    const byName = Object.fromEntries(defaults.map(d => [d.column_name, d.column_default]));
    assert.equal(byName.memory_enabled, "0", "memory_enabled should default to dormant");
    assert.equal(byName.reply_enabled, "0", "reply_enabled should default to dormant");
    assert.ok("announced_at" in byName, "announced_at column missing");

    // Existing rows keep their explicit values — only the DEFAULT changed.
    await sql`INSERT INTO server_settings (guild_id, memory_enabled, reply_enabled) VALUES ('g-explicit', 1, 1)`;
    const kept = await sql`SELECT memory_enabled, reply_enabled FROM server_settings WHERE guild_id = 'g-explicit'`;
    assert.equal(Number(kept[0].memory_enabled), 1);
    assert.equal(Number(kept[0].reply_enabled), 1);

    await runMigrations(sql as any, 15);
    const rolled = await sql<Array<{ column_name: string; column_default: string | null }>>`
      SELECT column_name, column_default FROM information_schema.columns
      WHERE table_name = 'server_settings' AND column_name IN ('memory_enabled', 'announced_at')
    `;
    const rb = Object.fromEntries(rolled.map(d => [d.column_name, d.column_default]));
    assert.equal(rb.memory_enabled, "1", "rollback should restore the observe-by-default default");
    assert.ok(!("announced_at" in rb), "announced_at should be dropped on rollback");
  } finally { await sql.end(); }
});
