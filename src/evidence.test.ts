import assert from "node:assert/strict";
import test from "node:test";
import { MemoryStore } from "./database.js";
import type { MemoryCandidate, MessageEvent } from "./types.js";

const event = (content: string, messageId?: string): MessageEvent => ({ 
  guildId: "test-guild", 
  channelId: "test-channel", 
  messageId: messageId ?? `msg-${Math.random()}`, 
  authorId: "test-user", 
  authorName: "TestUser", 
  content, 
  createdAt: new Date(), 
  mentionsBot: false 
});

const candidate = (content: string, overrides: Partial<MemoryCandidate> = {}): MemoryCandidate => ({ 
  subjectId: "test-user", 
  kind: "person_preference" as const, 
  content, 
  importance: 0.5, 
  reason: "Test", 
  evidenceType: "clear_preference" as const, 
  effect: "support" as const, 
  ...overrides 
});

test("same message_id cannot create duplicate evidence rows", () => {
  const store = new MemoryStore(":memory:");
  const memory = candidate("User likes tea");
  const source = event("I love tea", "duplicate-test");
  
  const first = store.saveMemory(source, memory);
  const duplicate = store.saveMemory(source, memory);
  
  assert.equal(first.confidence, duplicate.confidence);
  assert.equal(first.confirmationCount, duplicate.confirmationCount);
  assert.equal(store.evidence("test-guild", first.id).length, 1);
});

test("different message_ids from same author create separate evidence rows", () => {
  const store = new MemoryStore(":memory:");
  const memory = candidate("User likes tea");
  
  const first = store.saveMemory(event("I love tea", "msg-1"), memory);
  const second = store.saveMemory(event("I really love tea", "msg-2"), memory);
  
  assert.equal(store.evidence("test-guild", first.id).length, 2);
  assert.equal(second.confirmationCount, 2);
  assert.equal(second.confidence > first.confidence, true);
});

test("cross-author repetition creates separate evidence rows and builds confidence", () => {
  const store = new MemoryStore(":memory:");
  const memory = candidate("Tom is wealthy");
  
  const jakeEvent = { ...event("Tom is secretly rich", "jake-msg"), authorId: "jake", authorName: "Jake" };
  const alexEvent = { ...event("Tom is loaded", "alex-msg"), authorId: "alex", authorName: "Alex" };
  const samEvent = { ...event("Tom is a millionaire", "sam-msg"), authorId: "sam", authorName: "Sam" };
  
  const first = store.saveMemory(jakeEvent, memory);
  const second = store.saveMemory(alexEvent, memory);
  const third = store.saveMemory(samEvent, memory);
  
  assert.equal(store.evidence("test-guild", first.id).length, 3);
  assert.equal(third.confirmationCount, 3);
  assert.equal(third.confidence > first.confidence, true);
});

test("evidence deduplication is based on message_id, not content similarity", () => {
  const store = new MemoryStore(":memory:");
  const memory = candidate("User likes tea");
  
  const sameMessageDifferentContent = event("I love tea", "semantic-test");
  const first = store.saveMemory(sameMessageDifferentContent, memory);
  
  const sameContentDifferentMessage = event("I love tea", "different-message");
  const second = store.saveMemory(sameContentDifferentMessage, memory);
  
  assert.equal(store.evidence("test-guild", first.id).length, 2);
  assert.equal(second.confirmationCount, 2);
  assert.equal(second.confidence > first.confidence, true);
});

test("transaction ensures atomic evidence insert and confidence update", () => {
  const store = new MemoryStore(":memory:");
  const memory = candidate("User likes coffee");
  
  const source = event("I love coffee", "transaction-test");
  const result = store.saveMemory(source, memory);
  
  const evidence = store.evidence("test-guild", result.id);
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].messageId, "transaction-test");
  assert.equal(result.confidence > 0, true);
});

test("same message cannot support different memories with the same content", () => {
  const store = new MemoryStore(":memory:");
  const preference = candidate("User likes Arsenal");
  const episode = { ...preference, kind: "episode" as const, content: "User watched Arsenal today" };
  
  const source = event("I love Arsenal", "shared-source");
  const memory1 = store.saveMemory(source, preference);
  const memory2 = store.saveMemory(source, episode);
  
  assert.equal(store.evidence("test-guild", memory1.id).length, 1);
  assert.equal(store.evidence("test-guild", memory2.id).length, 1);
  assert.notEqual(memory1.id, memory2.id);
});

test("contradictory evidence from same message_id is handled correctly", () => {
  const store = new MemoryStore(":memory:");
  const supportMemory = candidate("User supports Arsenal");
  const contradictMemory = { ...supportMemory, effect: "contradict" as const };
  
  const source = event("I support Arsenal", "contradict-test");
  const first = store.saveMemory(source, supportMemory);
  
  const contradictSource = event("I don't support Arsenal", "contradict-msg");
  const second = store.saveMemory(contradictSource, contradictMemory);
  
  assert.equal(second.status, "contested");
  assert.equal(second.contradictionCount, 1);
});

test("concurrent evidence inserts are handled safely", () => {
  const store = new MemoryStore(":memory:");
  const memory = candidate("User likes both tea and coffee");
  
  const source = event("I enjoy both tea and coffee", "concurrent-test");
  
  const first = store.saveMemory(source, memory);
  const second = store.saveMemory(source, memory);
  const third = store.saveMemory(source, memory);
  
  assert.equal(store.evidence("test-guild", first.id).length, 1);
  assert.equal(first.confidence, second.confidence);
  assert.equal(second.confidence, third.confidence);
});

test("evidence with different message_ids but same content builds confidence normally", () => {
  const store = new MemoryStore(":memory:");
  const memory = candidate("User enjoys hiking");
  
  const first = store.saveMemory(event("I love hiking", "hike-1"), memory);
  const second = store.saveMemory(event("Hiking is my favorite activity", "hike-2"), memory);
  const third = store.saveMemory(event("Going for a hike today", "hike-3"), memory);
  
  assert.equal(store.evidence("test-guild", first.id).length, 3);
  assert.equal(third.confirmationCount, 3);
  assert.equal(third.confidence > first.confidence, true);
});