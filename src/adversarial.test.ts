import assert from "node:assert/strict";
import test from "node:test";
import { MemoryStore } from "./database.js";
import type { MemoryCandidate, MessageEvent } from "./types.js";

const source = (id: string, content: string): MessageEvent => ({ guildId: "adversarial", channelId: "test", messageId: id, authorId: "tom", authorName: "Tom", content, createdAt: new Date("2026-09-14T12:00:00Z"), mentionsBot: false });
const memory = (content: string, overrides: Partial<MemoryCandidate> = {}): MemoryCandidate => ({ subjectId: "tom", kind: "person_fact", content, importance: .5, reason: "Test interpretation", evidenceType: "explicit_fact", effect: "support", ...overrides });

test("sarcasm and jokes cannot become high-confidence facts", () => {
  const store = new MemoryStore(":memory:");
  const result = store.saveMemory(source("sarcasm", "Yeah mate, I absolutely love losing 8-0."), memory("Tom enjoys losing 8-0", { evidenceType: "sarcasm_or_joke", effect: "context" }));
  assert.equal(result.status, "candidate");
  assert.equal(result.confidence, 0.10);
  assert.equal(result.confirmationCount, 0);
});

test("reported rumours remain low-confidence and quarantine rather than becoming facts", () => {
  const store = new MemoryStore(":memory:");
  const result = store.saveMemory(source("rumour", "Tom is secretly rich."), memory("Tom is wealthy", { evidenceType: "reported_by_other", effect: "context" }));
  assert.equal(result.confidence, 0.35);
  assert.equal(result.status, "candidate");
  assert.equal(store.maintain("adversarial").quarantinedCandidates, 0);
});

test("ambiguous and conditional statements remain qualified candidates", () => {
  const store = new MemoryStore(":memory:");
  const ambiguous = store.saveMemory(source("might", "I might quit FIFA."), memory("Tom might quit FIFA", { evidenceType: "uncertain_inference", effect: "context" }));
  const conditional = store.saveMemory(source("conditional", "I hate Chelsea, except when they play Arsenal."), memory("Tom dislikes Chelsea except against Arsenal", { kind: "person_preference", evidenceType: "clear_preference", effect: "context" }));
  assert.equal(ambiguous.status, "candidate");
  assert.equal(conditional.content.includes("except"), true);
  assert.equal(conditional.confirmationCount, 0);
});

test("unresolved conflict stays contested and the history explains why", () => {
  const store = new MemoryStore(":memory:");
  const first = store.saveMemory(source("arsenal", "I support Arsenal."), memory("Tom supports Arsenal"));
  const contested = store.saveMemory(source("chelsea", "Tom supports Chelsea."), memory("Tom supports Arsenal", { evidenceType: "reported_by_other", effect: "contradict" }));
  const resolution = store.resolveContested("adversarial", first.id, new Date("2026-09-14T12:01:00Z"));
  assert.equal(contested.status, "contested");
  assert.equal(resolution.resolved, false);
  assert.equal(store.history("adversarial", first.id).some(item => item.action === "conflict_unresolved"), true);
});

test("contradiction timing affects conflict resolution", () => {
  const store = new MemoryStore(":memory:");
  const baseMemory = memory("Tom prefers morning shifts");
  const oldEvent = source("old-1", "I prefer morning shifts");
  oldEvent.createdAt = new Date("2026-01-01T12:00:00Z");
  
  const first = store.saveMemory(oldEvent, baseMemory);
  
  const recentEvent = source("recent-1", "I actually prefer evening shifts now");
  recentEvent.createdAt = new Date("2026-09-14T12:00:00Z");
  
  const contested = store.saveMemory(recentEvent, { ...baseMemory, content: "Tom prefers evening shifts", effect: "contradict" });
  
  assert.equal(contested.status, "contested");
  assert.equal(contested.contradictionCount, 1);
});

test("attempted confidence manipulation through duplicate evidence fails", () => {
  const store = new MemoryStore(":memory:");
  const baseMemory = memory("User is an expert programmer");
  
  const source1 = source("manipulation-1", "I'm an expert programmer");
  const first = store.saveMemory(source1, baseMemory);
  
  const source2 = source("manipulation-2", "I'm an expert programmer");
  const second = store.saveMemory(source2, baseMemory);
  
  const source3 = source("manipulation-3", "I'm an expert programmer");
  const third = store.saveMemory(source3, baseMemory);
  
  assert.equal(store.evidence("adversarial", first.id).length, 3);
  assert.equal(third.confirmationCount, 3);
  assert.equal(third.confidence > first.confidence, true);
});

test("purging raw messages preserves an explainable evidence snapshot", () => {
  const store = new MemoryStore(":memory:");
  const message = { ...source("retention", "I support Arsenal."), createdAt: new Date("2020-01-01T00:00:00Z") };
  store.recordMessage(message);
  const saved = store.saveMemory(message, memory("Tom supports Arsenal"));
  assert.equal(store.deleteRawMessagesOlderThan("adversarial", 1), 1);
  assert.equal(store.evidence("adversarial", saved.id)[0].messageContentSnapshot, "I support Arsenal.");
});

test("one sarcastic self-reference cannot establish a behavioural pattern", () => {
  const store = new MemoryStore(":memory:");
  const result = store.saveMemory(source("self-reference", "I always buy FIFA points 😂"), memory("Tom repeatedly buys FIFA points", { kind: "episode", evidenceType: "sarcasm_or_joke", effect: "context" }));
  assert.equal(result.status, "candidate");
  assert.equal(result.confirmationCount, 0);
  assert.equal(result.confidence, 0.10);
});

test("sarcasm evidence with support effect never promotes a candidate, regardless of volume", () => {
  const store = new MemoryStore(":memory:");
  // 30 iterations brings sarcasm confidence from 0.10 to ~0.76, above the 0.70 promotion threshold.
  // The evidence-type gate (not the confidence floor) is what prevents promotion at this count.
  for (let i = 0; i < 30; i++) {
    store.saveMemory(source(`sarcasm-${i}`, "Yeah sure I totally love losing"), memory("Tom enjoys losing", { evidenceType: "sarcasm_or_joke", effect: "support" }));
  }
  const memories = store.allActiveMemories("adversarial", "tom");
  assert.equal(memories.filter(m => m.content === "Tom enjoys losing").length, 0);
  // Also check maintain() does not promote it via the bulk path
  store.maintain("adversarial");
  const afterMaintain = store.allActiveMemories("adversarial", "tom");
  assert.equal(afterMaintain.filter(m => m.content === "Tom enjoys losing").length, 0);
});

test("uncertain_inference and reported_by_other evidence cannot promote a candidate", () => {
  const store = new MemoryStore(":memory:");
  const uncertainBase = memory("Tom might be moving abroad", { evidenceType: "uncertain_inference", effect: "support" });
  const rumourBase = memory("Tom is secretly wealthy", { evidenceType: "reported_by_other", effect: "support" });
  // 25 iterations: uncertain_inference reaches ~0.71, reported_by_other reaches ~0.77 — both above
  // the 0.70 threshold. The evidence-type gate is the active protection at this count.
  for (let i = 0; i < 25; i++) {
    store.saveMemory(source(`unc-${i}`, "I might move abroad"), uncertainBase);
    store.saveMemory(source(`rum-${i}`, "Someone said Tom is rich"), rumourBase);
  }
  const active = store.allActiveMemories("adversarial", "tom");
  assert.equal(active.filter(m => m.content === "Tom might be moving abroad").length, 0);
  assert.equal(active.filter(m => m.content === "Tom is secretly wealthy").length, 0);
});

test("maintain() bulk promotion respects the evidence-type gate", () => {
  const store = new MemoryStore(":memory:");
  // Manually build a sarcasm candidate that meets the numeric criteria for bulk promotion
  // (mentions >= 2, confidence >= 0.70) but must not be promoted due to primary_evidence_type.
  const sarc = memory("Tom loves losing at FIFA", { evidenceType: "sarcasm_or_joke", effect: "support" });
  // 30 iterations — confidence reaches ~0.76, mentions = 30, both above bulk thresholds.
  for (let i = 0; i < 30; i++) store.saveMemory(source(`s-${i}`, "I love losing lol"), sarc);
  const before = store.allActiveMemories("adversarial", "tom");
  assert.equal(before.filter(m => m.content === "Tom loves losing at FIFA").length, 0);
  store.maintain("adversarial");
  const after = store.allActiveMemories("adversarial", "tom");
  assert.equal(after.filter(m => m.content === "Tom loves losing at FIFA").length, 0, "sarcasm must not be bulk-promoted by maintain()");
});
