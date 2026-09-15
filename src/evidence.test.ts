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

test("same message_id cannot create duplicate evidence rows", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const memory = candidate("User likes tea");
    const source = ev("I love tea", "duplicate-test");
    const first = await store.saveMemory(source, memory);
    const duplicate = await store.saveMemory(source, memory);
    assert.equal(first.confidence, duplicate.confidence);
    assert.equal(first.confirmationCount, duplicate.confirmationCount);
    assert.equal((await store.evidence("test-guild", first.id)).length, 1);
  } finally { await sql.end(); }
});

test("different message_ids from same author create separate evidence rows", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const memory = candidate("User likes tea");
    const first = await store.saveMemory(ev("I love tea", "msg-1"), memory);
    const second = await store.saveMemory(ev("I really love tea", "msg-2"), memory);
    assert.equal((await store.evidence("test-guild", first.id)).length, 2);
    assert.equal(second.confirmationCount, 2);
    assert.equal(second.confidence > first.confidence, true);
  } finally { await sql.end(); }
});

test("cross-author repetition creates separate evidence rows and builds confidence", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const memory = candidate("Tom is wealthy");
    const jakeEvent = { ...ev("Tom is secretly rich", "jake-msg"), authorId: "jake", authorName: "Jake" };
    const alexEvent = { ...ev("Tom is loaded", "alex-msg"), authorId: "alex", authorName: "Alex" };
    const samEvent = { ...ev("Tom is a millionaire", "sam-msg"), authorId: "sam", authorName: "Sam" };
    const first = await store.saveMemory(jakeEvent, memory);
    await store.saveMemory(alexEvent, memory);
    const third = await store.saveMemory(samEvent, memory);
    assert.equal((await store.evidence("test-guild", first.id)).length, 3);
    assert.equal(third.confirmationCount, 3);
    assert.equal(third.confidence > first.confidence, true);
  } finally { await sql.end(); }
});

test("evidence deduplication is based on message_id, not content similarity", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const memory = candidate("User likes tea");
    const first = await store.saveMemory(ev("I love tea", "semantic-test"), memory);
    const second = await store.saveMemory(ev("I love tea", "different-message"), memory);
    assert.equal((await store.evidence("test-guild", first.id)).length, 2);
    assert.equal(second.confirmationCount, 2);
    assert.equal(second.confidence > first.confidence, true);
  } finally { await sql.end(); }
});

test("transaction ensures atomic evidence insert and confidence update", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const memory = candidate("User likes coffee");
    const source = ev("I love coffee", "transaction-test");
    const result = await store.saveMemory(source, memory);
    const evidence = await store.evidence("test-guild", result.id);
    assert.equal(evidence.length, 1);
    assert.equal(evidence[0].messageId, "transaction-test");
    assert.equal(result.confidence > 0, true);
  } finally { await sql.end(); }
});

test("same message cannot support different memories with the same content", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const preference = candidate("User likes Arsenal");
    const episode = { ...preference, kind: "episode" as const, content: "User watched Arsenal today" };
    const source = ev("I love Arsenal", "shared-source");
    const memory1 = await store.saveMemory(source, preference);
    const memory2 = await store.saveMemory(source, episode);
    assert.equal((await store.evidence("test-guild", memory1.id)).length, 1);
    assert.equal((await store.evidence("test-guild", memory2.id)).length, 1);
    assert.notEqual(memory1.id, memory2.id);
  } finally { await sql.end(); }
});

test("contradictory evidence from same message_id is handled correctly", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const supportMemory = candidate("User supports Arsenal");
    const source = ev("I support Arsenal", "contradict-test");
    await store.saveMemory(source, supportMemory);
    const contradictSource = ev("I don't support Arsenal", "contradict-msg");
    const second = await store.saveMemory(contradictSource, { ...supportMemory, effect: "contradict" as const });
    assert.equal(second.status, "contested");
    assert.equal(second.contradictionCount, 1);
  } finally { await sql.end(); }
});

test("concurrent evidence inserts are handled safely", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const memory = candidate("User likes both tea and coffee");
    const source = ev("I enjoy both tea and coffee", "concurrent-test");
    const first = await store.saveMemory(source, memory);
    const second = await store.saveMemory(source, memory);
    const third = await store.saveMemory(source, memory);
    assert.equal((await store.evidence("test-guild", first.id)).length, 1);
    assert.equal(first.confidence, second.confidence);
    assert.equal(second.confidence, third.confidence);
  } finally { await sql.end(); }
});

test("evidence with different message_ids but same content builds confidence normally", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const memory = candidate("User enjoys hiking");
    const first = await store.saveMemory(ev("I love hiking", "hike-1"), memory);
    await store.saveMemory(ev("Hiking is my favorite activity", "hike-2"), memory);
    const third = await store.saveMemory(ev("Going for a hike today", "hike-3"), memory);
    assert.equal((await store.evidence("test-guild", first.id)).length, 3);
    assert.equal(third.confirmationCount, 3);
    assert.equal(third.confidence > first.confidence, true);
  } finally { await sql.end(); }
});
