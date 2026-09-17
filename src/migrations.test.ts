import "dotenv/config";
import assert from "node:assert/strict";
import test from "node:test";
import postgres from "postgres";
import { runMigrations, getMigrationVersion } from "./migrations.js";

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
  await sql`DROP TABLE IF EXISTS schema_migrations, profiles, relationships, relationship_observations, members, event_memories, event_messages, event_participants, events, behavioral_patterns, memory_history, memory_evidence, server_settings, memories, messages CASCADE`;
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
    assert.equal(version, 7);
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
    assert.equal(await getMigrationVersion(sql as any), 7);
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
