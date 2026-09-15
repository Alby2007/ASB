import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { runMigrations, getMigrationVersion } from "./migrations.js";

function setupBaseSchema(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, author_id TEXT NOT NULL, author_name TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, subject_id TEXT NOT NULL, kind TEXT NOT NULL, content TEXT NOT NULL,
      confidence REAL NOT NULL, importance REAL NOT NULL, mentions INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, 
      last_confirmed_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'candidate', explicitness REAL NOT NULL DEFAULT 0.5, reason TEXT NOT NULL DEFAULT '',
      UNIQUE(guild_id, subject_id, kind, content)
    );
    CREATE TABLE IF NOT EXISTS memory_evidence (
      id INTEGER PRIMARY KEY AUTOINCREMENT, memory_id INTEGER NOT NULL, message_id TEXT NOT NULL, author_id TEXT NOT NULL,
      quote TEXT NOT NULL, reason TEXT NOT NULL, explicitness REAL NOT NULL, observed_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS server_settings (guild_id TEXT PRIMARY KEY, memory_enabled INTEGER NOT NULL DEFAULT 1, reply_enabled INTEGER NOT NULL DEFAULT 1, raw_retention_days INTEGER NOT NULL DEFAULT 30);
  `);
}

test("migrations create schema_migrations table", () => {
  const db = new Database(":memory:");
  setupBaseSchema(db);
  runMigrations(db);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
  assert(tables.some(t => t.name === "schema_migrations"));
});

test("migrations are applied in order", () => {
  const db = new Database(":memory:");
  setupBaseSchema(db);
  runMigrations(db);
  const version = getMigrationVersion(db);
  assert.equal(version, 5);
});

test("migrations are idempotent", () => {
  const db = new Database(":memory:");
  setupBaseSchema(db);
  runMigrations(db);
  const firstVersion = getMigrationVersion(db);
  runMigrations(db);
  const secondVersion = getMigrationVersion(db);
  assert.equal(firstVersion, secondVersion);
});

test("migration adds expected columns to memories table", () => {
  const db = new Database(":memory:");
  setupBaseSchema(db);
  runMigrations(db);
  const columns = db.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>;
  assert(columns.some(c => c.name === "confirmation_count"));
  assert(columns.some(c => c.name === "contradiction_count"));
  assert(columns.some(c => c.name === "updated_at"));
  assert(columns.some(c => c.name === "last_contradicted_at"));
  assert(columns.some(c => c.name === "supersedes_memory_id"));
});

test("migration adds expected columns to memory_evidence table", () => {
  const db = new Database(":memory:");
  setupBaseSchema(db);
  runMigrations(db);
  const columns = db.prepare("PRAGMA table_info(memory_evidence)").all() as Array<{ name: string }>;
  assert(columns.some(c => c.name === "evidence_type"));
  assert(columns.some(c => c.name === "effect"));
  assert(columns.some(c => c.name === "message_content_snapshot"));
  assert(columns.some(c => c.name === "message_timestamp"));
  assert(columns.some(c => c.name === "created_at"));
});

test("migration creates memory_history table", () => {
  const db = new Database(":memory:");
  setupBaseSchema(db);
  runMigrations(db);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
  assert(tables.some(t => t.name === "memory_history"));
});

test("migration creates expected indexes", () => {
  const db = new Database(":memory:");
  setupBaseSchema(db);
  runMigrations(db);
  const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as Array<{ name: string }>;
  assert(indexes.some(i => i.name === "memory_history_lookup"));
});

test("migration updates existing data correctly", () => {
  const db = new Database(":memory:");
  setupBaseSchema(db);
  db.exec(`
    INSERT INTO memories (guild_id, subject_id, kind, content, confidence, importance, mentions, created_at, last_confirmed_at, status, explicitness, reason) 
    VALUES ('guild1', 'user1', 'person_fact', 'Test memory', 0.5, 0.5, 2, '2026-01-01', '2026-01-01', 'candidate', 0.5, 'test');
    INSERT INTO memory_evidence (memory_id, message_id, author_id, quote, reason, explicitness, observed_at) 
    VALUES (1, 'msg1', 'user1', 'test quote', 'test reason', 0.5, '2026-01-01');
  `);
  
  runMigrations(db);
  
  const memory = db.prepare("SELECT confirmation_count, contradiction_count, updated_at FROM memories WHERE id=1").get() as { confirmation_count: number; contradiction_count: number; updated_at: string };
  assert.equal(memory.confirmation_count, 2);
  assert.equal(memory.updated_at, "2026-01-01");
  
  const evidence = db.prepare("SELECT evidence_type, effect, message_content_snapshot, message_timestamp, created_at FROM memory_evidence WHERE id=1").get() as { evidence_type: string; effect: string; message_content_snapshot: string; message_timestamp: string; created_at: string };
  assert.equal(evidence.evidence_type, "uncertain_inference");
  assert.equal(evidence.effect, "context");
  assert.equal(evidence.message_content_snapshot, "test quote");
  assert.equal(evidence.message_timestamp, "2026-01-01");
  assert.equal(evidence.created_at, "2026-01-01");
});

test("migration version tracking works correctly", () => {
  const db = new Database(":memory:");
  setupBaseSchema(db);
  runMigrations(db, 1);
  assert.equal(getMigrationVersion(db), 1);
  
  const migrations = db.prepare("SELECT version, applied_at FROM schema_migrations ORDER BY version").all() as Array<{ version: number; applied_at: string }>;
  assert.equal(migrations.length, 1);
  assert.equal(migrations[0].version, 1);
  assert(migrations[0].applied_at);
});

test("migration v2 adds net_score, frozen_confidence, and pattern_id columns to memories", () => {
  const db = new Database(":memory:");
  setupBaseSchema(db);
  runMigrations(db);
  const columns = db.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>;
  assert(columns.some(c => c.name === "net_score"));
  assert(columns.some(c => c.name === "frozen_confidence"));
  assert(columns.some(c => c.name === "pattern_id"));
});

test("migration v2 creates behavioral_patterns table with expected columns", () => {
  const db = new Database(":memory:");
  setupBaseSchema(db);
  runMigrations(db);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
  assert(tables.some(t => t.name === "behavioral_patterns"));
  const columns = db.prepare("PRAGMA table_info(behavioral_patterns)").all() as Array<{ name: string }>;
  for (const col of ["guild_id", "subject_id", "description", "episode_count", "confidence", "status"]) {
    assert(columns.some(c => c.name === col), `Missing column: ${col}`);
  }
});

test("migration v2 creates patterns_lookup index", () => {
  const db = new Database(":memory:");
  setupBaseSchema(db);
  runMigrations(db);
  const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as Array<{ name: string }>;
  assert(indexes.some(i => i.name === "patterns_lookup"));
});

test("migrations can be applied incrementally", () => {
  const db = new Database(":memory:");
  setupBaseSchema(db);
  runMigrations(db, 1);
  assert.equal(getMigrationVersion(db), 1);
  runMigrations(db, 2);
  assert.equal(getMigrationVersion(db), 2);
  runMigrations(db, 3);
  assert.equal(getMigrationVersion(db), 3);
});

test("rolling back to v1 removes behavioral_patterns table and index", () => {
  const db = new Database(":memory:");
  setupBaseSchema(db);
  runMigrations(db);
  assert.equal(getMigrationVersion(db), 5);
  runMigrations(db, 1);
  assert.equal(getMigrationVersion(db), 1);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
  assert(!tables.some(t => t.name === "behavioral_patterns"));
});

test("migration v3 adds primary_evidence_type column to memories", () => {
  const db = new Database(":memory:");
  setupBaseSchema(db);
  runMigrations(db);
  const columns = db.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>;
  assert(columns.some(c => c.name === "primary_evidence_type"));
});

test("migration v3 defaults primary_evidence_type to uncertain_inference for existing rows", () => {
  const db = new Database(":memory:");
  setupBaseSchema(db);
  runMigrations(db, 2);
  // Insert a row without the column (simulates pre-v3 data)
  db.prepare("INSERT INTO memories (guild_id, subject_id, kind, content, confidence, importance, mentions, confirmation_count, created_at, updated_at, last_confirmed_at, status, explicitness, reason) VALUES ('g','u','person_fact','old memory',0.6,0.5,1,0,datetime('now'),datetime('now'),datetime('now'),'candidate',0.9,'test')").run();
  runMigrations(db, 3);
  const row = db.prepare("SELECT primary_evidence_type FROM memories WHERE content='old memory'").get() as { primary_evidence_type: string };
  assert.equal(row.primary_evidence_type, "uncertain_inference");
});