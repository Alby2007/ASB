import assert from "node:assert/strict";
import test from "node:test";
import type { MemoryCandidate, MessageEvent } from "./types.js";
import { makeTestSql, makeStore } from "./test-helpers.js";

const source = (id: string, content: string): MessageEvent => ({ guildId: "adversarial", channelId: "test", messageId: id, authorId: "tom", authorName: "Tom", content, createdAt: new Date("2026-09-14T12:00:00Z"), mentionsBot: false });
const memory = (content: string, overrides: Partial<MemoryCandidate> = {}): MemoryCandidate => ({ subjectId: "tom", kind: "person_fact", content, importance: .5, reason: "Test interpretation", evidenceType: "explicit_fact", effect: "support", ...overrides });

test("sarcasm and jokes cannot become high-confidence facts", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const result = await store.saveMemory(source("sarcasm", "Yeah mate, I absolutely love losing 8-0."), memory("Tom enjoys losing 8-0", { evidenceType: "sarcasm_or_joke", effect: "context" }));
    assert.equal(result.status, "candidate");
    assert.equal(result.confidence, 0.10);
    assert.equal(result.confirmationCount, 0);
  } finally { await sql.end(); }
});

test("reported rumours remain low-confidence and quarantine rather than becoming facts", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const result = await store.saveMemory(source("rumour", "Tom is secretly rich."), memory("Tom is wealthy", { evidenceType: "reported_by_other", effect: "context" }));
    assert.equal(result.confidence, 0.35);
    assert.equal(result.status, "candidate");
    assert.equal((await store.maintain("adversarial")).quarantinedCandidates, 0);
  } finally { await sql.end(); }
});

test("ambiguous and conditional statements remain qualified candidates", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const ambiguous = await store.saveMemory(source("might", "I might quit FIFA."), memory("Tom might quit FIFA", { evidenceType: "uncertain_inference", effect: "context" }));
    const conditional = await store.saveMemory(source("conditional", "I hate Chelsea, except when they play Arsenal."), memory("Tom dislikes Chelsea except against Arsenal", { kind: "person_preference", evidenceType: "clear_preference", effect: "context" }));
    assert.equal(ambiguous.status, "candidate");
    assert.equal(conditional.content.includes("except"), true);
    assert.equal(conditional.confirmationCount, 0);
  } finally { await sql.end(); }
});

test("unresolved conflict stays contested and the history explains why", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const first = await store.saveMemory(source("arsenal", "I support Arsenal."), memory("Tom supports Arsenal"));
    const contested = await store.saveMemory(source("chelsea", "Tom supports Chelsea."), memory("Tom supports Arsenal", { evidenceType: "reported_by_other", effect: "contradict" }));
    const resolution = await store.resolveContested("adversarial", first.id, new Date("2026-09-14T12:01:00Z"));
    assert.equal(contested.status, "contested");
    assert.equal(resolution.resolved, false);
    assert.ok((await store.history("adversarial", first.id)).some((item: { action: string }) => item.action === "conflict_unresolved"));
  } finally { await sql.end(); }
});

test("contradiction timing affects conflict resolution", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const baseMemory = memory("Tom prefers morning shifts");
    const oldEvent = source("old-1", "I prefer morning shifts");
    oldEvent.createdAt = new Date("2026-01-01T12:00:00Z");
    await store.saveMemory(oldEvent, baseMemory);
    const recentEvent = source("recent-1", "I actually prefer evening shifts now");
    recentEvent.createdAt = new Date("2026-09-14T12:00:00Z");
    const contested = await store.saveMemory(recentEvent, { ...baseMemory, content: "Tom prefers evening shifts", effect: "contradict" });
    assert.equal(contested.status, "contested");
    assert.equal(contested.contradictionCount, 1);
  } finally { await sql.end(); }
});

test("attempted confidence manipulation through duplicate evidence fails", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const baseMemory = memory("User is an expert programmer");
    const first = await store.saveMemory(source("manipulation-1", "I'm an expert programmer"), baseMemory);
    const second = await store.saveMemory(source("manipulation-2", "I'm an expert programmer"), baseMemory);
    const third = await store.saveMemory(source("manipulation-3", "I'm an expert programmer"), baseMemory);
    assert.equal((await store.evidence("adversarial", first.id)).length, 3);
    assert.equal(third.confirmationCount, 3);
    assert.equal(third.confidence > first.confidence, true);
    // Suppress unused warning
    void second;
  } finally { await sql.end(); }
});

test("purging raw messages preserves an explainable evidence snapshot", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const message = { ...source("retention", "I support Arsenal."), createdAt: new Date("2020-01-01T00:00:00Z") };
    await store.recordMessage(message);
    const saved = await store.saveMemory(message, memory("Tom supports Arsenal"));
    assert.equal(await store.deleteRawMessagesOlderThan("adversarial", 1), 1);
    assert.equal((await store.evidence("adversarial", saved.id))[0].messageContentSnapshot, "I support Arsenal.");
  } finally { await sql.end(); }
});

test("one sarcastic self-reference cannot establish a behavioural pattern", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const result = await store.saveMemory(source("self-reference", "I always buy FIFA points 😂"), memory("Tom repeatedly buys FIFA points", { kind: "episode", evidenceType: "sarcasm_or_joke", effect: "context" }));
    assert.equal(result.status, "candidate");
    assert.equal(result.confirmationCount, 0);
    assert.equal(result.confidence, 0.10);
  } finally { await sql.end(); }
});

test("sarcasm evidence with support effect never promotes a candidate, regardless of volume", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    for (let i = 0; i < 30; i++) {
      await store.saveMemory(source(`sarcasm-${i}`, "Yeah sure I totally love losing"), memory("Tom enjoys losing", { evidenceType: "sarcasm_or_joke", effect: "support" }));
    }
    const memories = await store.allActiveMemories("adversarial", "tom");
    assert.equal(memories.filter((m: { content: string }) => m.content === "Tom enjoys losing").length, 0);
    await store.maintain("adversarial");
    const afterMaintain = await store.allActiveMemories("adversarial", "tom");
    assert.equal(afterMaintain.filter((m: { content: string }) => m.content === "Tom enjoys losing").length, 0);
  } finally { await sql.end(); }
});

test("uncertain_inference and reported_by_other evidence cannot promote a candidate", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const uncertainBase = memory("Tom might be moving abroad", { evidenceType: "uncertain_inference", effect: "support" });
    const rumourBase = memory("Tom is secretly wealthy", { evidenceType: "reported_by_other", effect: "support" });
    for (let i = 0; i < 25; i++) {
      await store.saveMemory(source(`unc-${i}`, "I might move abroad"), uncertainBase);
      await store.saveMemory(source(`rum-${i}`, "Someone said Tom is rich"), rumourBase);
    }
    const active = await store.allActiveMemories("adversarial", "tom");
    assert.equal(active.filter((m: { content: string }) => m.content === "Tom might be moving abroad").length, 0);
    assert.equal(active.filter((m: { content: string }) => m.content === "Tom is secretly wealthy").length, 0);
  } finally { await sql.end(); }
});

test("maintain() bulk promotion respects the evidence-type gate", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const sarc = memory("Tom loves losing at FIFA", { evidenceType: "sarcasm_or_joke", effect: "support" });
    for (let i = 0; i < 30; i++) await store.saveMemory(source(`s-${i}`, "I love losing lol"), sarc);
    const before = await store.allActiveMemories("adversarial", "tom");
    assert.equal(before.filter((m: { content: string }) => m.content === "Tom loves losing at FIFA").length, 0);
    await store.maintain("adversarial");
    const after = await store.allActiveMemories("adversarial", "tom");
    assert.equal(after.filter((m: { content: string }) => m.content === "Tom loves losing at FIFA").length, 0, "sarcasm must not be bulk-promoted by maintain()");
  } finally { await sql.end(); }
});
