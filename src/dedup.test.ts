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
    // The contents need enough trigram overlap to reach the fuzzy-match path;
    // "loves pizza"/"hates pizza" alone scores ~0.55, below the 0.6 threshold.
    const first = await store.saveMemory(ev("I really love pineapple pizza", "m1"), candidate("User really loves pineapple pizza"));
    // LLM mislabels the effect; the polarity check on the fuzzy match must force contradict.
    const second = await store.saveMemory(ev("I really hate pineapple pizza", "m2"), candidate("User really hates pineapple pizza", { effect: "support" }));
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

// ── Semantic dedup (LLM maintenance pass) ────────────────────────────────────

test("mergeDuplicate moves evidence, supersedes the dup, and keeps canonical status", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    // Lexically disjoint content so the trigram fast-path leaves both rows.
    const canon = await store.saveMemory(ev("I'm allergic to peanuts", "m1"), candidate("User is allergic to peanuts", { kind: "person_fact", evidenceType: "explicit_fact" }));
    const dup = await store.saveMemory(ev("I can't eat nuts", "m2"), candidate("User can't eat nuts", { kind: "person_fact", evidenceType: "explicit_fact" }));
    assert.notEqual(canon.id, dup.id);
    assert.equal(canon.status, "candidate");

    assert.equal(await store.mergeDuplicate("test-guild", canon.id, dup.id, "same allergy"), true);
    const canonAfter = (await store.getMemory("test-guild", canon.id))!;
    const dupAfter = (await store.getMemory("test-guild", dup.id))!;
    // Merging is not promotion — a candidate canonical stays candidate
    assert.equal(canonAfter.status, "candidate");
    assert.equal(canonAfter.confirmationCount, 2);
    assert.equal(dupAfter.status, "superseded");
    assert.equal(dupAfter.supersededBy, canon.id);
    assert.equal((await store.evidence("test-guild", canon.id)).length, 2);
    const actions = (await store.history("test-guild", dup.id)).map(h => h.action);
    assert.ok(actions.includes("dedup_merged"));
    // Idempotent — the dup is no longer live
    assert.equal(await store.mergeDuplicate("test-guild", canon.id, dup.id, "again"), false);
  } finally { await sql.end(); }
});

test("mergeDuplicate leaves colliding evidence on the superseded row", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    // Same source message m1 is evidence for both rows → collision on merge.
    // The row can't move (unique key) and can't be deleted (memory_history
    // references it) — it stays on the superseded memory for audit.
    const a = await store.saveMemory(ev("peanuts", "m1"), candidate("User is allergic to peanuts", { kind: "person_fact", evidenceType: "explicit_fact" }));
    const b = await store.saveMemory(ev("peanuts", "m1"), candidate("User can't eat nuts", { kind: "person_fact", evidenceType: "explicit_fact" }));
    assert.notEqual(a.id, b.id);
    assert.equal(await store.mergeDuplicate("test-guild", a.id, b.id, "same allergy"), true);
    assert.equal((await store.evidence("test-guild", a.id)).length, 1);
    assert.equal((await store.evidence("test-guild", b.id)).length, 1);
  } finally { await sql.end(); }
});

test("applyDedupGroups merges valid groups and rejects invalid ones", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const save = (content: string, overrides: Partial<MemoryCandidate> = {}) =>
      store.saveMemory(ev(content, `m-${Math.random()}`), candidate(content, { kind: "person_fact", evidenceType: "explicit_fact", ...overrides }));

    // Valid: same subject+kind, one active — active wins as canonical
    const active = await save("User is allergic to peanuts");
    await store.confirm("test-guild", active.id);
    const dup = await save("User can't eat nuts");
    const r1 = await store.applyDedupGroups("test-guild", [{ ids: [active.id, dup.id], reason: "same allergy" }]);
    assert.equal(r1.merged, 1);
    assert.equal((await store.getMemory("test-guild", dup.id))?.supersededBy, active.id);

    // Cross-subject group → skipped
    const s2a = await save("User likes tea", { subjectId: "other-user" });
    const s2b = await save("User likes herbal tea");
    const r2 = await store.applyDedupGroups("test-guild", [{ ids: [s2a.id, s2b.id], reason: "cross-subject" }]);
    assert.equal(r2.merged, 0);
    assert.equal(r2.skipped, 1);

    // Cross-kind group → skipped
    const k2 = await save("User likes cats", { kind: "person_preference" });
    const r3 = await store.applyDedupGroups("test-guild", [{ ids: [s2b.id, k2.id], reason: "cross-kind" }]);
    assert.equal(r3.merged, 0);
    assert.equal(r3.skipped, 1);

    // Singleton → skipped; dead-status member poisons the whole group → skipped
    const dead = await save("User likes dogs");
    await store.forget("test-guild", dead.id);
    const live = await save("User likes puppies");
    const r4 = await store.applyDedupGroups("test-guild", [
      { ids: [live.id], reason: "singleton" },
      { ids: [dead.id, live.id], reason: "mixed status" },
    ]);
    assert.equal(r4.merged, 0);
    assert.equal(r4.skipped, 2);
    assert.equal((await store.getMemory("test-guild", live.id))?.status, "candidate");
  } finally { await sql.end(); }
});

test("listDedupCandidates returns only resolved subjects with live non-episode rows", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    await store.saveMemory(ev("a1", "m1"), candidate("User is allergic to peanuts", { kind: "person_fact", evidenceType: "explicit_fact" }));
    await store.saveMemory(ev("a2", "m2"), candidate("User can't eat nuts", { kind: "person_fact", evidenceType: "explicit_fact" }));
    // unknown subject — excluded even with two rows
    await store.saveMemory(ev("b1", "m3"), candidate("Sage likes pizza", { subjectId: "unknown", subjectName: "Sage" }));
    await store.saveMemory(ev("b2", "m4"), candidate("Sage loves pizza", { subjectId: "unknown", subjectName: "Sage" }));
    // episodes — excluded
    await store.saveMemory(ev("c1", "m5"), candidate("User went for a run", { kind: "episode" }));
    await store.saveMemory(ev("c2", "m6"), candidate("User went for a jog", { kind: "episode" }));
    // solo member — excluded
    await store.saveMemory(ev("d1", "m7"), candidate("User has a cat", { subjectId: "solo-user", kind: "person_fact", evidenceType: "explicit_fact" }));
    // forgotten — excluded
    const f = await store.saveMemory(ev("e1", "m8"), candidate("User likes dogs", { kind: "person_fact", evidenceType: "explicit_fact" }));
    await store.forget("test-guild", f.id);

    const members = await store.listDedupCandidates("test-guild");
    assert.equal(members.length, 1);
    assert.equal(members[0].subjectId, "test-user");
    const contents = members[0].memories.map(m => m.content).sort();
    assert.deepEqual(contents, ["User can't eat nuts", "User is allergic to peanuts"].sort());
  } finally { await sql.end(); }
});
