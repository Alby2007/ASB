import "dotenv/config";
import assert from "node:assert/strict";
import test from "node:test";
import { makeTestSql, makeStore } from "./test-helpers.js";
import { persistExtraction } from "./persist-extraction.js";
import type { MemoryStore } from "./database.js";
import type { ExtractionResult, MessageEvent } from "./types.js";

function msg(overrides: Partial<MessageEvent> = {}): MessageEvent {
  return {
    guildId: "g1", channelId: "c1", messageId: `m-${Math.random().toString(36).slice(2)}`,
    authorId: "u-author", authorName: "Carol",
    content: "test message", createdAt: new Date(), mentionsBot: false,
    ...overrides,
  };
}

const ALIASES = new Map([["alice", "u1"], ["bob", "u2"]]);

/** Same predicate shape the live/sweep/ingest callers build. */
async function consentFor(store: MemoryStore, guildId = "g1") {
  const members = await store.listMembers(guildId);
  const optedIn = new Set(members.filter(m => m.optedIn && !m.optedOut).map(m => m.userId));
  return (id: string) => id === "unknown" || id === "server" || optedIn.has(id);
}

const memOf = (subjectName: string, content = "likes cats") => ({
  subjectId: "unknown", subjectName, kind: "person_fact" as const,
  content, reason: "t", evidenceType: "explicit_fact" as const, effect: "support" as const,
});

test("person memories persist only for opted-in subjects", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    await store.setMemberOptIn("g1", "u1", true);
    const isConsented = await consentFor(store);
    const result: ExtractionResult = {
      memories: [memOf("alice", "opted-in fact"), memOf("bob", "non-consented fact")],
      relationships: [],
    };
    const { savedIds } = await persistExtraction(result, msg(), { store, aliases: ALIASES, isConsented });
    assert.equal(savedIds.length, 1);
    const rows = await sql<Array<{ subject_id: string; content: string }>>`SELECT subject_id, content FROM memories WHERE guild_id = 'g1'`;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].subject_id, "u1");
    assert.equal(rows[0].content, "opted-in fact");
  } finally { await sql.end(); }
});

test("server lore is consent-exempt; opted-out beats opted-in", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    // Both flags set — opt-out always wins.
    await store.setMemberOptIn("g1", "u1", true);
    await store.setMemberOptOut("g1", "u1", true);
    const isConsented = await consentFor(store);
    const result: ExtractionResult = {
      memories: [
        { subjectId: "server", kind: "server_lore", content: "meetup thursday", reason: "t", evidenceType: "explicit_fact", effect: "support" },
        memOf("alice", "should never land"),
      ],
      relationships: [],
    };
    const { savedIds } = await persistExtraction(result, msg(), { store, aliases: ALIASES, isConsented });
    assert.equal(savedIds.length, 1);
    const rows = await sql<Array<{ subject_id: string }>>`SELECT subject_id FROM memories WHERE guild_id = 'g1'`;
    assert.deepEqual(rows.map(r => r.subject_id), ["server"]);
  } finally { await sql.end(); }
});

test("relationships use subject-consent — either opted-in party is enough", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const rel = { subjectName: "alice", otherName: "bob", nature: "close friends", valence: 0.8, reason: "said so" };

    // Neither consented → no observation.
    let isConsented = await consentFor(store);
    let out = await persistExtraction({ memories: [], relationships: [rel] }, msg(), { store, aliases: ALIASES, isConsented });
    assert.equal(out.relationshipsRecorded, 0);

    // One side opts in → the observation persists.
    await store.setMemberOptIn("g1", "u2", true);
    isConsented = await consentFor(store);
    out = await persistExtraction({ memories: [], relationships: [rel] }, msg(), { store, aliases: ALIASES, isConsented });
    assert.equal(out.relationshipsRecorded, 1);
    const rows = await sql<Array<{ subject_id: string; other_id: string; author_id: string }>>`SELECT subject_id, other_id, author_id FROM relationship_observations WHERE guild_id = 'g1'`;
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0].subject_id, rows[0].other_id], ["u1", "u2"]);
    assert.equal(rows[0].author_id, "u-author", "the assertor is recorded — opt-out must find their authored claims");
  } finally { await sql.end(); }
});
