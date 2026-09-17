import assert from "node:assert/strict";
import test from "node:test";
import type { MemoryCandidate, MessageEvent } from "./types.js";
import { makeTestSql, makeStore } from "./test-helpers.js";

const ev = (content: string, messageId?: string): MessageEvent => ({
  guildId: "test-guild",
  channelId: "test-channel",
  messageId: messageId ?? `msg-${Math.random()}`,
  authorId: "test-user",
  authorName: "TestUser",
  content,
  createdAt: new Date(),
  mentionsBot: false,
});

const candidate = (content: string, overrides: Partial<MemoryCandidate> = {}): MemoryCandidate => ({
  subjectId: "test-user",
  kind: "person_preference" as const,
  content,
  importance: 0.5,
  reason: "Test",
  evidenceType: "clear_preference" as const,
  effect: "support" as const,
  ...overrides,
});

test("near-duplicate phrasing reinforces one memory instead of creating a second", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const first = await store.saveMemory(ev("I like pizza", "m1"), candidate("User likes pizza"));
    const second = await store.saveMemory(ev("I love pizza", "m2"), candidate("User loves pizza"));
    assert.equal(second.id, first.id);
    assert.equal(second.confirmationCount, 2);
    assert.equal((await store.evidence("test-guild", first.id)).length, 2);
    const history = await store.history("test-guild", first.id);
    const dedup = history.find(h => h.action === "dedup_matched");
    assert.ok(dedup, "expected a dedup_matched history entry");
    assert.match(dedup.detailsJson, /"similarity"/);
  } finally { await sql.end(); }
});

test("clearly different content still creates separate memories", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const first = await store.saveMemory(ev("I like pizza", "m1"), candidate("User likes pizza"));
    const second = await store.saveMemory(ev("I work as a carpenter", "m2"), candidate("User works as a carpenter", { kind: "person_fact" }));
    assert.notEqual(second.id, first.id);
  } finally { await sql.end(); }
});

test("paraphrases with little trigram overlap are not merged by the fast path", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const first = await store.saveMemory(ev("I'm allergic to peanuts", "m1"), candidate("User is allergic to peanuts", { kind: "person_fact" }));
    const second = await store.saveMemory(ev("I can't eat nuts", "m2"), candidate("User can't eat nuts", { kind: "person_fact" }));
    assert.notEqual(second.id, first.id);
  } finally { await sql.end(); }
});

test("episodes are never fuzzy-merged — recurrences must stay separate rows", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const ep = (content: string) => candidate(content, { kind: "episode" });
    const first = await store.saveMemory(ev("went for a run", "m1"), ep("User went for a run"));
    const second = await store.saveMemory(ev("went for a run again", "m2"), ep("User went for a run today"));
    assert.notEqual(second.id, first.id);
  } finally { await sql.end(); }
});

test("unknown subjects are never fuzzy-merged across different people", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const first = await store.saveMemory(ev("Sage likes pizza", "m1"), candidate("Sage likes pizza", { subjectId: "unknown", subjectName: "Sage" }));
    const second = await store.saveMemory(ev("Rin likes pizza", "m2"), candidate("Rin likes pizza", { subjectId: "unknown", subjectName: "Rin" }));
    assert.notEqual(second.id, first.id);
  } finally { await sql.end(); }
});

test("a forgotten memory is not resurrected by a near-duplicate", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const first = await store.saveMemory(ev("I like pizza", "m1"), candidate("User likes pizza"));
    await store.forget("test-guild", first.id);
    const second = await store.saveMemory(ev("I love pizza", "m2"), candidate("User loves pizza"));
    assert.notEqual(second.id, first.id);
    assert.equal((await store.getMemory("test-guild", first.id))?.status, "forgotten");
  } finally { await sql.end(); }
});

test("corrections always create their own row so supersede() can link them", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const first = await store.saveMemory(ev("I support Arsenal", "m1"), candidate("User supports Arsenal"));
    const replacement = await store.saveMemory(ev("Actually I support Chelsea", "m2"), candidate("User supports Chelsea", { evidenceType: "correction", effect: "correct" }));
    assert.notEqual(replacement.id, first.id);
    await store.supersede("test-guild", first.id, replacement.id);
    assert.equal((await store.getMemory("test-guild", first.id))?.status, "superseded");
    assert.equal((await store.getMemory("test-guild", replacement.id))?.status, "active");
  } finally { await sql.end(); }
});

test("opposite-polarity fuzzy match forces contradict even when the LLM says support", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const first = await store.saveMemory(ev("I love pizza", "m1"), candidate("User loves pizza"));
    // LLM mislabels the effect; the polarity check on the fuzzy match must force contradict.
    const second = await store.saveMemory(ev("I hate pizza", "m2"), candidate("User hates pizza", { effect: "support" }));
    assert.equal(second.id, first.id);
    assert.equal(second.status, "contested");
    assert.equal(second.contradictionCount, 1);
  } finally { await sql.end(); }
});

test("negation flip (can → can't) on a fuzzy match forces contradict", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const first = await store.saveMemory(ev("I can eat nuts", "m1"), candidate("User can eat nuts", { kind: "person_fact", evidenceType: "explicit_fact" }));
    const second = await store.saveMemory(ev("I can't eat nuts", "m2"), candidate("User can't eat nuts", { kind: "person_fact", evidenceType: "explicit_fact", effect: "support" }));
    assert.equal(second.id, first.id);
    assert.equal(second.status, "contested");
  } finally { await sql.end(); }
});

test("non-promotable evidence types cannot ride the fuzzy fast-path", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const first = await store.saveMemory(ev("I love pizza", "m1"), candidate("User loves pizza"));
    const joke = await store.saveMemory(ev("yeah I totally love pizza lol", "m2"), candidate("User really loves pizza", { evidenceType: "sarcasm_or_joke" }));
    assert.notEqual(joke.id, first.id);
    assert.equal((await store.evidence("test-guild", first.id)).length, 1);
  } finally { await sql.end(); }
});

test("replayed message after a fuzzy match stays idempotent", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const first = await store.saveMemory(ev("I like pizza", "m1"), candidate("User likes pizza"));
    const source = ev("I love pizza", "m2");
    const second = await store.saveMemory(source, candidate("User loves pizza"));
    const replay = await store.saveMemory(source, candidate("User loves pizza"));
    assert.equal(second.id, first.id);
    assert.equal(replay.id, first.id);
    assert.equal(replay.confirmationCount, 2);
    assert.equal((await store.evidence("test-guild", first.id)).length, 2);
  } finally { await sql.end(); }
});
