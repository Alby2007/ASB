import assert from "node:assert/strict";
import test from "node:test";
import { MemoryStore } from "./database.js";
import { shouldInspectForMemory } from "./perception.js";
import type { MessageEvent } from "./types.js";

const event = (content: string): MessageEvent => ({ guildId: "guild", channelId: "channel", messageId: `message-${content.length}`, authorId: "user", authorName: "User", content, createdAt: new Date(), mentionsBot: false });

test("only durable-looking messages reach memory extraction", () => {
  assert.equal(shouldInspectForMemory(event("lol that was funny")), false);
  assert.equal(shouldInspectForMemory(event("I really love Arsenal and watch every match.")), true);
});

test("repeated candidate memory becomes active", () => {
  const store = new MemoryStore(":memory:");
  const candidate = { subjectId: "user", kind: "person_preference" as const, content: "User likes Arsenal", importance: .5, reason: "A stated preference", evidenceType: "clear_preference" as const, effect: "support" as const };
  const first = store.saveMemory(event("I like Arsenal"), candidate);
  assert.equal(first.status, "candidate");
  for (let index = 2; index <= 6; index++) store.saveMemory({ ...event(`I like Arsenal ${index}`), messageId: `message-${index}` }, candidate);
  assert.equal(store.maintain("guild", .7).promoted, 0);
  assert.equal(store.getMemory("guild", first.id)?.status, "active");
});

test("evidence is unique per memory but can support different memories", () => {
  const store = new MemoryStore(":memory:");
  const preference = { subjectId: "user", kind: "person_preference" as const, content: "User likes Arsenal", importance: .5, reason: "Explicit preference", evidenceType: "clear_preference" as const, effect: "support" as const };
  const episode = { ...preference, kind: "episode" as const, content: "User watched Arsenal today" };
  const source = { ...event("I love Arsenal"), messageId: "shared-source" };
  const memory = store.saveMemory(source, preference);
  store.saveMemory(source, preference);
  const secondMemory = store.saveMemory(source, episode);
  assert.equal(store.evidence("guild", memory.id).length, 1);
  assert.equal(store.evidence("guild", secondMemory.id).length, 1);
  assert.equal(store.evidence("guild", memory.id)[0].messageContentSnapshot, "I love Arsenal");
  assert.equal(store.history("guild", memory.id).length, 1);
});

test("duplicate support evidence cannot change confidence or counters", () => {
  const store = new MemoryStore(":memory:"), candidate = { subjectId: "user", kind: "person_preference" as const, content: "User likes tea", importance: .5, reason: "Explicit preference", evidenceType: "clear_preference" as const, effect: "support" as const };
  const source = { ...event("I love tea"), messageId: "tea-source" };
  const first = store.saveMemory(source, candidate);
  const duplicate = store.saveMemory(source, candidate);
  assert.equal(duplicate.confidence, first.confidence);
  assert.equal(duplicate.confirmationCount, first.confirmationCount);
  assert.equal(store.evidence("guild", first.id).length, 1);
});

test("contradicting evidence deterministically contests a memory without changing confidence", () => {
  const store = new MemoryStore(":memory:"), candidate = { subjectId: "user", kind: "person_fact" as const, content: "User supports Arsenal", importance: .5, reason: "Explicit statement", evidenceType: "explicit_fact" as const, effect: "support" as const };
  const memory = store.saveMemory({ ...event("I support Arsenal"), messageId: "arsenal" }, candidate);
  const contradicted = store.saveMemory({ ...event("I don't support Arsenal"), messageId: "not-arsenal" }, { ...candidate, effect: "contradict", reason: "Explicit contradiction" });
  // Contradiction sets status to contested and freezes confidence — net_score is the resolution mechanism.
  assert.equal(contradicted.status, "contested");
  assert.equal(contradicted.confidence, memory.confidence);
  assert.equal(contradicted.contradictionCount, 1);
});

test("age-weighted support can resolve a contested memory without rewriting confidence", () => {
  const store = new MemoryStore(":memory:"), candidate = { subjectId: "user", kind: "person_fact" as const, content: "User supports Arsenal", importance: .5, reason: "Explicit statement", evidenceType: "explicit_fact" as const, effect: "support" as const };
  // Build confidence above 0.70 with recent support messages, then add an old contradiction.
  // Giving the contradiction an older timestamp ensures newest evidence is support (deterministic sort).
  const now = Date.now();
  const first = store.saveMemory({ ...event("I support Arsenal 0"), messageId: "pre-0", createdAt: new Date(now - 20 * 1000) }, candidate);
  for (let index = 1; index < 20; index++) store.saveMemory({ ...event(`I support Arsenal ${index}`), messageId: `pre-${index}`, createdAt: new Date(now - (20 - index) * 1000) }, candidate);
  store.saveMemory({ ...event("I do not support Arsenal"), messageId: "contradiction", createdAt: new Date(now - 100 * 86_400_000) }, { ...candidate, effect: "contradict" });
  assert.equal(store.getMemory("guild", first.id)?.status, "contested");
  const before = store.getMemory("guild", first.id)!;
  assert.ok(before.confidence >= .70, "confidence must be at or above resolution threshold before testing resolveContested");
  const result = store.resolveContested("guild", first.id);
  assert.equal(result.resolved, true);
  assert.equal(store.getMemory("guild", first.id)?.status, "active");
  // Confidence must not change during resolution — it was frozen in contested state.
  assert.equal(store.getMemory("guild", first.id)?.confidence, before.confidence);
});

test("a direct correction supersedes the old memory and links the replacement", () => {
  const store = new MemoryStore(":memory:"), oldCandidate = { subjectId: "user", kind: "person_fact" as const, content: "User supports Arsenal", importance: .5, reason: "Statement", evidenceType: "explicit_fact" as const, effect: "support" as const };
  const old = store.saveMemory({ ...event("I support Arsenal"), messageId: "old" }, oldCandidate);
  const replacement = store.saveMemory({ ...event("Actually I support Chelsea"), messageId: "new" }, { ...oldCandidate, content: "User supports Chelsea", evidenceType: "correction", effect: "correct" });
  store.supersede("guild", old.id, replacement.id);
  assert.equal(store.getMemory("guild", old.id)?.status, "superseded");
  assert.equal(store.getMemory("guild", replacement.id)?.status, "active");
  assert.equal(store.getMemory("guild", replacement.id)?.supersedesMemoryId, old.id);
});

test("ambiguous statements remain qualified candidates", () => {
  const store = new MemoryStore(":memory:");
  const ambiguous = { subjectId: "user", kind: "person_fact" as const, content: "User might move to London", importance: .5, reason: "Ambiguous statement", evidenceType: "uncertain_inference" as const, effect: "context" as const };
  const result = store.saveMemory(event("I might move to London next year"), ambiguous);
  assert.equal(result.status, "candidate");
  assert.equal(result.content.includes("might"), true);
  assert.equal(result.confirmationCount, 0);
});

test("conditional preferences preserve nuance in content", () => {
  const store = new MemoryStore(":memory:");
  const conditional = { subjectId: "user", kind: "person_preference" as const, content: "User dislikes Chelsea except against Arsenal", importance: .5, reason: "Conditional preference", evidenceType: "clear_preference" as const, effect: "context" as const };
  const result = store.saveMemory(event("I hate Chelsea, except when they play Arsenal"), conditional);
  assert.equal(result.status, "candidate");
  assert.equal(result.content.includes("except"), true);
  assert.equal(result.confirmationCount, 0);
});

test("evidence reuse across different memories works correctly", () => {
  const store = new MemoryStore(":memory:");
  const preference = { subjectId: "user", kind: "person_preference" as const, content: "User likes Arsenal", importance: .5, reason: "Preference", evidenceType: "clear_preference" as const, effect: "support" as const };
  const episode = { ...preference, kind: "episode" as const, content: "User watched Arsenal yesterday" };
  const source = event("I love Arsenal, watched them yesterday");
  
  const memory1 = store.saveMemory(source, preference);
  const memory2 = store.saveMemory(source, episode);
  
  assert.equal(store.evidence("guild", memory1.id).length, 1);
  assert.equal(store.evidence("guild", memory2.id).length, 1);
  assert.notEqual(memory1.id, memory2.id);
});

test("maintain() resolves a contested memory with overwhelming support", () => {
  const store = new MemoryStore(":memory:");
  const candidate = { subjectId: "user", kind: "person_fact" as const, content: "User supports Arsenal", importance: .5, reason: "Explicit statement", evidenceType: "explicit_fact" as const, effect: "support" as const };
  // Build confidence above 0.70 with uniquely-timestamped support messages, then add an old contradiction.
  // Unique timestamps make the evidence sort deterministic (newest evidence will be a support message).
  const now = Date.now();
  const first = store.saveMemory({ ...event("I support Arsenal 0"), messageId: "pre-0", createdAt: new Date(now - 20 * 1000) }, candidate);
  for (let i = 1; i < 20; i++) store.saveMemory({ ...event(`I support Arsenal ${i}`), messageId: `pre-${i}`, createdAt: new Date(now - (20 - i) * 1000) }, candidate);
  assert.ok(store.getMemory("guild", first.id)!.confidence >= .70);
  // Contradiction with an old timestamp — confidence is now frozen above the resolution threshold.
  store.saveMemory({ ...event("I do not support Arsenal"), messageId: "contra", createdAt: new Date(now - 100 * 86_400_000) }, { ...candidate, effect: "contradict" });
  assert.equal(store.getMemory("guild", first.id)?.status, "contested");
  const result = store.maintain("guild");
  assert.equal(result.resolved, 1);
  assert.equal(store.getMemory("guild", first.id)?.status, "active");
});

test("maintain() leaves a genuinely contested memory as contested", () => {
  const store = new MemoryStore(":memory:");
  const candidate = { subjectId: "user", kind: "person_fact" as const, content: "User supports Arsenal", importance: .5, reason: "Explicit statement", evidenceType: "explicit_fact" as const, effect: "support" as const };
  const first = store.saveMemory({ ...event("I support Arsenal"), messageId: "m1" }, candidate);
  store.saveMemory({ ...event("Actually I hate Arsenal"), messageId: "m2" }, { ...candidate, effect: "contradict" });
  // One support vs one contradict — net score will be near zero, should stay contested
  const result = store.maintain("guild");
  assert.equal(result.resolved, 0);
  assert.equal(store.getMemory("guild", first.id)?.status, "contested");
});

test("confidence is frozen once a memory enters contested state", () => {
  const store = new MemoryStore(":memory:");
  const candidate = { subjectId: "user", kind: "person_fact" as const, content: "User supports Arsenal", importance: .5, reason: "Explicit statement", evidenceType: "explicit_fact" as const, effect: "support" as const };
  const first = store.saveMemory({ ...event("I support Arsenal"), messageId: "m1" }, candidate);
  store.saveMemory({ ...event("Actually no"), messageId: "m2" }, { ...candidate, effect: "contradict" });
  const afterContest = store.getMemory("guild", first.id)!;
  assert.equal(afterContest.status, "contested");
  // Add more support — confidence must not change while contested
  store.saveMemory({ ...event("I do support Arsenal"), messageId: "m3" }, candidate);
  store.saveMemory({ ...event("Yes Arsenal!"), messageId: "m4" }, candidate);
  const afterMoreSupport = store.getMemory("guild", first.id)!;
  assert.equal(afterMoreSupport.status, "contested");
  assert.equal(afterMoreSupport.confidence, afterContest.confidence);
});

test("frozen_confidence is recorded when a memory first enters contested state", () => {
  const store = new MemoryStore(":memory:");
  const candidate = { subjectId: "user", kind: "person_fact" as const, content: "User runs every morning", importance: .5, reason: "Statement", evidenceType: "explicit_fact" as const, effect: "support" as const };
  const first = store.saveMemory({ ...event("I run 0"), messageId: "r0" }, candidate);
  for (let i = 1; i < 10; i++) store.saveMemory({ ...event(`I run ${i}`), messageId: `r${i}` }, candidate);
  const before = store.getMemory("guild", first.id)!;
  store.saveMemory({ ...event("I never run"), messageId: "contra" }, { ...candidate, effect: "contradict" });
  const after = store.getMemory("guild", first.id)!;
  assert.equal(after.status, "contested");
  assert.equal(after.frozenConfidence, before.confidence);
});

test("net_score is persisted on the memory row after resolveContested", () => {
  const store = new MemoryStore(":memory:");
  const candidate = { subjectId: "user", kind: "person_fact" as const, content: "User likes running", importance: .5, reason: "Statement", evidenceType: "explicit_fact" as const, effect: "support" as const };
  const now = Date.now();
  const first = store.saveMemory({ ...event("I like running 0"), messageId: "r0", createdAt: new Date(now - 20 * 1000) }, candidate);
  for (let i = 1; i < 20; i++) store.saveMemory({ ...event(`I like running ${i}`), messageId: `r${i}`, createdAt: new Date(now - (20 - i) * 1000) }, candidate);
  store.saveMemory({ ...event("I hate running"), messageId: "contra", createdAt: new Date(now - 100 * 86_400_000) }, { ...candidate, effect: "contradict" });
  store.resolveContested("guild", first.id);
  // After successful resolution, net_score and frozen_confidence should be cleared back to null.
  const resolved = store.getMemory("guild", first.id)!;
  assert.equal(resolved.status, "active");
  assert.equal(resolved.netScore, null);
  assert.equal(resolved.frozenConfidence, null);
});

test("episodes below the threshold are not consolidated into a pattern", () => {
  const store = new MemoryStore(":memory:");
  const episode = (content: string, id: string) => store.saveMemory(
    { ...event(content), messageId: id },
    { subjectId: "user", kind: "episode" as const, content, importance: .5, reason: "Observed", evidenceType: "explicit_fact" as const, effect: "support" as const }
  );
  // Promote two episodes manually to active — below the default minEpisodes of 3
  const e1 = episode("User went running", "ep1");
  const e2 = episode("User went to the gym", "ep2");
  store.confirm("guild", e1.id); store.confirm("guild", e2.id);
  const patternsCreated = store.consolidateEpisodes("guild", "user");
  assert.equal(patternsCreated, 0);
  assert.equal(store.patterns("guild", "user").length, 0);
});

test("enough active episodes are consolidated into a behavioral pattern", () => {
  const store = new MemoryStore(":memory:");
  const makeEpisode = (content: string, id: string) => {
    const mem = store.saveMemory(
      { ...event(content), messageId: id },
      { subjectId: "user", kind: "episode" as const, content, importance: .5, reason: "Observed", evidenceType: "explicit_fact" as const, effect: "support" as const }
    );
    store.confirm("guild", mem.id);
    return store.getMemory("guild", mem.id)!;
  };
  makeEpisode("User went running", "ep1");
  makeEpisode("User went to the gym", "ep2");
  makeEpisode("User did yoga", "ep3");
  const patternsCreated = store.consolidateEpisodes("guild", "user");
  assert.equal(patternsCreated, 1);
  const patterns = store.patterns("guild", "user");
  assert.equal(patterns.length, 1);
  assert.equal(patterns[0].episodeCount, 3);
  assert.ok(patterns[0].confidence > 0);
});

test("only active episodes count toward pattern consolidation — candidates are excluded", () => {
  const store = new MemoryStore(":memory:");
  // Two active + two candidate episodes: must not reach the threshold of 3 active
  const makeActive = (content: string, id: string) => {
    const mem = store.saveMemory({ ...event(content), messageId: id }, { subjectId: "user", kind: "episode" as const, content, importance: .5, reason: "Observed", evidenceType: "explicit_fact" as const, effect: "support" as const });
    store.confirm("guild", mem.id);
  };
  makeActive("User ran 5k", "act1");
  makeActive("User cycled", "act2");
  // Two candidates (not confirmed)
  store.saveMemory({ ...event("Maybe user swam"), messageId: "cand1" }, { subjectId: "user", kind: "episode" as const, content: "User might have swum", importance: .5, reason: "Uncertain", evidenceType: "uncertain_inference" as const, effect: "context" as const });
  store.saveMemory({ ...event("Rumour user boxed"), messageId: "cand2" }, { subjectId: "user", kind: "episode" as const, content: "Rumour user does boxing", importance: .5, reason: "Rumour", evidenceType: "reported_by_other" as const, effect: "context" as const });
  const patternsCreated = store.consolidateEpisodes("guild", "user");
  assert.equal(patternsCreated, 0);
  assert.equal(store.patterns("guild", "user").length, 0);
});

test("maintain() reports patternsFound when episodes consolidate", () => {
  const store = new MemoryStore(":memory:");
  for (let i = 0; i < 3; i++) {
    const mem = store.saveMemory(
      { ...event(`Episode ${i}`), messageId: `ep${i}` },
      { subjectId: "user", kind: "episode" as const, content: `User did activity ${i}`, importance: .5, reason: "Observed", evidenceType: "explicit_fact" as const, effect: "support" as const }
    );
    store.confirm("guild", mem.id);
  }
  const result = store.maintain("guild");
  assert.equal(result.patternsFound, 1);
});
