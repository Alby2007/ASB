/**
 * Shared helpers for test files.
 * Requires TEST_DATABASE_URL to point at a Postgres DB used exclusively for tests.
 */
import postgres from "postgres";
import { MemoryStore } from "./database.js";
import { EventStore } from "./events.js";

export function makeTestSql() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL is required to run tests");
  return postgres(url, { max: 3 });
}

/** Truncate all data tables while preserving schema — fast reset between tests. */
export async function clearData(sql: ReturnType<typeof postgres>) {
  // Truncate in reverse-dependency order to avoid FK violations.
  await sql`TRUNCATE TABLE event_memories, event_messages, event_participants, events, behavioral_patterns, memory_history, memory_evidence, server_settings, memories, messages RESTART IDENTITY CASCADE`;
}

/** Create a MemoryStore + EventStore pair backed by the given sql connection and wipe all data. */
export async function makeStore(sql: ReturnType<typeof postgres>) {
  // MemoryStore.create() runs migrations (idempotent) and returns an instance.
  const store = await MemoryStore.create(sql as any);
  await clearData(sql);
  const eventStore = new EventStore(sql as any);
  return { store, eventStore };
}
