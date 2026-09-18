/**
 * Shared helpers for test files.
 * Requires TEST_DATABASE_URL to point at a Postgres DB used exclusively for tests.
 */
import "dotenv/config";
import postgres from "postgres";
import { MemoryStore } from "./database.js";
import { EventStore } from "./events.js";

export function makeTestSql() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL is required to run tests");
  // Suppress NOTICE messages (e.g. "relation already exists, skipping") from migration DDL.
  return postgres(url, { max: 3, onnotice: () => {} });
}

/** Truncate all data tables while preserving schema and migration tracking. */
export async function clearData(sql: ReturnType<typeof postgres>) {
  // Truncate data tables only — schema_migrations is NOT truncated so runMigrations stays idempotent.
  // Use CASCADE to handle FK constraints; RESTART IDENTITY resets sequences.
  await sql`TRUNCATE TABLE profile_attributes, profiles, relationships, relationship_observations, members, event_memories, event_messages, event_participants, events, behavioral_patterns, memory_history, memory_evidence, server_settings, memories, messages, guild_keys, unresolved_names, alias_candidates, jobs, guild_usage RESTART IDENTITY CASCADE`;
}

/** Create a MemoryStore + EventStore pair backed by the given sql connection and wipe all data. */
export async function makeStore(sql: ReturnType<typeof postgres>) {
  // MemoryStore.create() runs migrations (idempotent) and returns an instance.
  const store = await MemoryStore.create(sql as any);
  await clearData(sql);
  const eventStore = new EventStore(sql as any);
  return { store, eventStore };
}
