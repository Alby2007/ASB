import assert from "node:assert/strict";
import test from "node:test";
import { EventStore } from "./events.js";
import { EventPipeline } from "./event-detection.js";
import { calculateSignificance } from "./event-significance.js";
import type { Brain } from "./brain.js";
import type { MessageEvent, MemoryCandidate } from "./types.js";
import { makeTestSql, makeStore } from "./test-helpers.js";

// ── Shared helpers ─────────────────────────────────────────────────────────────

const guild = "test-guild";
const channel = "test-channel";

function msg(id: string, content: string, authorId = "user1", authorName = "Alice"): MessageEvent {
  return { guildId: guild, channelId: channel, messageId: id, authorId, authorName, content, createdAt: new Date(), mentionsBot: false };
}

function mem(content: string): MemoryCandidate {
  return { subjectId: "user1", kind: "person_fact", content, reason: "Test", evidenceType: "explicit_fact", effect: "support" };
}

/** Minimal Brain stub — returns a configurable ContinuityDecision. */
function stubBrain(continuityAction: "attach" | "new" | "reference" | "bridge" = "new", eventId = 0): Brain {
  return {
    assessContinuity: async () => {
      if (continuityAction === "attach") return { action: "attach", eventId };
      if (continuityAction === "reference") return { action: "reference", eventId };
      if (continuityAction === "bridge") return { action: "bridge", eventIds: [eventId] };
      return { action: "new" };
    },
    classifyEvent: async () => ({
      significance: 0.75, tier: "high" as const, tone: "argumentative",
      narrativeComplete: true, futureRelevant: true,
      title: "The Arsenal Debate", summary: "Users argued about Arsenal for 10 minutes.",
    }),
  } as unknown as Brain;
}

// ── 1. Significance scoring — deterministic (no DB needed) ────────────────────

test("significance: low-activity cluster is discarded", () => {
  const { score, tier } = calculateSignificance({
    distinctParticipants: 1, messageCount: 2, memoryCount: 0,
    tone: "calm", narrativeComplete: false, futureRelevant: false,
  });
  assert.ok(score < 0.35, `score was ${score}`);
  assert.equal(tier, "discard");
});

test("significance: two-user exchange with memories and some future relevance is a candidate", () => {
  const { score, tier } = calculateSignificance({
    distinctParticipants: 2, messageCount: 6, memoryCount: 2,
    tone: "playful", narrativeComplete: false, futureRelevant: true,
  });
  assert.ok(score >= 0.35, `score was ${score}`);
  assert.ok(score < 0.60, `score was ${score}`);
  assert.equal(tier, "candidate");
});

test("significance: multi-user argument with full narrative is promoted to event", () => {
  const { score, tier } = calculateSignificance({
    distinctParticipants: 3, messageCount: 12, memoryCount: 4,
    tone: "argumentative", narrativeComplete: true, futureRelevant: true,
  });
  assert.ok(score >= 0.60, `score was ${score}`);
  assert.equal(tier, "event");
});

test("significance: dramatic single-user post with future relevance can reach event tier", () => {
  const { score, tier } = calculateSignificance({
    distinctParticipants: 1, messageCount: 1, memoryCount: 3,
    tone: "dramatic", narrativeComplete: true, futureRelevant: true,
  });
  assert.ok(score > 0, `score was ${score}`);
  assert.ok(["candidate", "event"].includes(tier), `unexpected tier ${tier}`);
});

// ── 2. EventStore CRUD ────────────────────────────────────────────────────────

test("EventStore: createEvent stores a new candidate event", async () => {
  const sql = makeTestSql();
  try {
    const { eventStore } = await makeStore(sql);
    const ev = await eventStore.createEvent({
      guildId: guild, channelId: channel, title: "", summary: "",
      significance: 0, tier: "candidate", occurredAt: new Date(),
      participants: [{ userId: "u1", userName: "Alice", role: "participant" }],
    });
    assert.ok(ev.id > 0);
    assert.equal(ev.tier, "candidate");
    assert.equal(ev.participants.length, 1);
    assert.equal(ev.participants[0].userId, "u1");
  } finally { await sql.end(); }
});

test("EventStore: attachMessage and attachMemory link records", async () => {
  const sql = makeTestSql();
  try {
    const { store, eventStore } = await makeStore(sql);
    const ev = await eventStore.createEvent({ guildId: guild, channelId: channel, title: "", summary: "", significance: 0, tier: "candidate", occurredAt: new Date(), participants: [] });
    await eventStore.attachMessage(guild, ev.id, "msg-001");
    const saved = await store.saveMemory(msg("mem-001", "I love Arsenal"), mem("Alice likes Arsenal"));
    await eventStore.attachMemory(guild, ev.id, saved.id, "generated");
    const fresh = (await eventStore.getEvent(guild, ev.id))!;
    assert.ok(fresh.messageIds.includes("msg-001"));
    assert.ok(fresh.memoryIds.includes(saved.id));
  } finally { await sql.end(); }
});

test("EventStore: openEvents returns only unclosed events in the channel", async () => {
  const sql = makeTestSql();
  try {
    const { eventStore } = await makeStore(sql);
    const ev1 = await eventStore.createEvent({ guildId: guild, channelId: channel, title: "", summary: "", significance: 0, tier: "candidate", occurredAt: new Date(), participants: [] });
    await eventStore.createEvent({ guildId: guild, channelId: channel, title: "", summary: "", significance: 0, tier: "candidate", occurredAt: new Date(), participants: [] });
    await eventStore.closeEvent(guild, ev1.id);
    const open = await eventStore.openEvents(guild, channel);
    assert.equal(open.length, 1);
    assert.notEqual(open[0].id, ev1.id);
  } finally { await sql.end(); }
});

test("EventStore: incrementReferenceCount increments correctly", async () => {
  const sql = makeTestSql();
  try {
    const { eventStore } = await makeStore(sql);
    const ev = await eventStore.createEvent({ guildId: guild, channelId: channel, title: "", summary: "", significance: 0, tier: "candidate", occurredAt: new Date(), participants: [] });
    assert.equal(await eventStore.incrementReferenceCount(guild, ev.id), 1);
    assert.equal(await eventStore.incrementReferenceCount(guild, ev.id), 2);
  } finally { await sql.end(); }
});

test("EventStore: updateSignificance promotes tier to event", async () => {
  const sql = makeTestSql();
  try {
    const { eventStore } = await makeStore(sql);
    const ev = await eventStore.createEvent({ guildId: guild, channelId: channel, title: "", summary: "", significance: 0, tier: "candidate", occurredAt: new Date(), participants: [] });
    await eventStore.updateSignificance(guild, ev.id, 0.82, "event", "The Bet", "Tom lost £20 betting on Arsenal.");
    const fresh = (await eventStore.getEvent(guild, ev.id))!;
    assert.equal(fresh.tier, "event");
    assert.equal(fresh.title, "The Bet");
    assert.ok(fresh.significance > 0.8);
  } finally { await sql.end(); }
});

test("EventStore: eventsForMemory returns linked events", async () => {
  const sql = makeTestSql();
  try {
    const { store, eventStore } = await makeStore(sql);
    const ev = await eventStore.createEvent({ guildId: guild, channelId: channel, title: "Test", summary: "Test", significance: 0.7, tier: "event", occurredAt: new Date(), participants: [] });
    const saved = await store.saveMemory(msg("m1", "I support Arsenal"), mem("Alice supports Arsenal"));
    await eventStore.attachMemory(guild, ev.id, saved.id, "generated");
    const linked = await eventStore.eventsForMemory(guild, saved.id);
    assert.equal(linked.length, 1);
    assert.equal(linked[0].id, ev.id);
  } finally { await sql.end(); }
});

// ── 3. Pipeline — heuristic attach ───────────────────────────────────────────

test("pipeline: reply-chain message is attached to open event without LLM", async () => {
  const sql = makeTestSql();
  try {
    const { store, eventStore } = await makeStore(sql);
    const pipeline = new EventPipeline();
    const ev = await eventStore.createEvent({ guildId: guild, channelId: channel, title: "", summary: "", significance: 0, tier: "candidate", occurredAt: new Date(Date.now() - 60_000), participants: [] });
    await eventStore.attachMessage(guild, ev.id, "msg-001");
    const saved = await store.saveMemory(msg("msg-002", "I love Arsenal"), mem("Alice likes Arsenal"));
    let llmCalled = false;
    const watchBrain = { assessContinuity: async () => { llmCalled = true; return { action: "new" as const }; }, classifyEvent: stubBrain().classifyEvent } as unknown as Brain;
    await pipeline.process(msg("msg-002", "Yeah definitely"), [saved.id], eventStore, store, watchBrain, "msg-001");
    assert.equal(llmCalled, false, "LLM should not be called for a reply chain");
    const fresh = (await eventStore.getEvent(guild, ev.id))!;
    assert.ok(fresh.messageIds.includes("msg-002"), "reply should be attached to the event");
  } finally { await sql.end(); }
});

// ── 4. Pipeline — new event created when memory extracted ─────────────────────

test("pipeline: new event candidate is created when a memory is extracted", async () => {
  const sql = makeTestSql();
  try {
    const { store, eventStore } = await makeStore(sql);
    const pipeline = new EventPipeline();
    const brain = stubBrain("new");
    const saved = await store.saveMemory(msg("m1", "I love Arsenal"), mem("Alice likes Arsenal"));
    await pipeline.process(msg("m1", "I love Arsenal"), [saved.id], eventStore, store, brain);
    const open = await eventStore.openEvents(guild, channel);
    assert.equal(open.length, 1);
    assert.ok(open[0].messageIds.includes("m1"));
    assert.ok(open[0].memoryIds.includes(saved.id));
  } finally { await sql.end(); }
});

// ── 5. Pipeline — no event created for ordinary chat with no memories ─────────

test("pipeline: ordinary chat with no memories does not create an event", async () => {
  const sql = makeTestSql();
  try {
    const { store, eventStore } = await makeStore(sql);
    const pipeline = new EventPipeline();
    const brain = stubBrain("new");
    await pipeline.process(msg("m1", "sup"), [], eventStore, store, brain);
    const open = await eventStore.openEvents(guild, channel);
    assert.equal(open.length, 0);
  } finally { await sql.end(); }
});

// ── 6. Pipeline — reference increments reference_count ───────────────────────

test("pipeline: back-reference message increments event reference_count", async () => {
  const sql = makeTestSql();
  try {
    const { store, eventStore } = await makeStore(sql);
    const pipeline = new EventPipeline();
    const ev = await eventStore.createEvent({ guildId: guild, channelId: channel, title: "The Arsenal Incident", summary: "Tom lost a bet.", significance: 0.4, tier: "candidate", occurredAt: new Date(Date.now() - 3_600_000), participants: [{ userId: "user2", userName: "Tom", role: "subject" }] });
    const brain = stubBrain("reference", ev.id);
    const backRef = msg("m2", "remember when Tom lost that Arsenal bet?", "user1", "Alice");
    const saved = await store.saveMemory(backRef, mem("Tom lost a bet on Arsenal"));
    await pipeline.process(backRef, [saved.id], eventStore, store, brain);
    const fresh = (await eventStore.getEvent(guild, ev.id))!;
    assert.equal(fresh.referenceCount, 1);
  } finally { await sql.end(); }
});

test("pipeline: ambiguous continuity sends the event's recent messages to the LLM", async () => {
  const sql = makeTestSql();
  try {
    const { store, eventStore } = await makeStore(sql);
    const pipeline = new EventPipeline();
    await store.recordMessage(msg("em-1", "Tom just lost £20 on the Arsenal bet"));
    const ev = await eventStore.createEvent({ guildId: guild, channelId: channel, title: "", summary: "", significance: 0, tier: "candidate", occurredAt: new Date(Date.now() - 60_000), participants: [{ userId: "user2", userName: "Tom", role: "subject" }] });
    await eventStore.attachMessage(guild, ev.id, "em-1");
    const seen: Array<Array<{ id: number; recentMessages: Array<{ authorName: string; content: string }> }>> = [];
    const brain = {
      assessContinuity: async (_e: MessageEvent, events: Array<{ id: number; recentMessages: Array<{ authorName: string; content: string }> }>) => {
        seen.push(events);
        return { action: "reference" as const, eventId: ev.id };
      },
      classifyEvent: stubBrain().classifyEvent,
    } as unknown as Brain;
    const backRef = msg("m2", "remember when Tom lost that Arsenal bet?", "user1", "Alice");
    await pipeline.process(backRef, [], eventStore, store, brain);
    assert.equal(seen.length, 1, "assessContinuity should have been called");
    const offered = seen[0].find(e => e.id === ev.id);
    assert.ok(offered, "the open event should be among the LLM candidates");
    assert.deepEqual(offered.recentMessages.map(m => m.content), ["Tom just lost £20 on the Arsenal bet"]);
  } finally { await sql.end(); }
});

// ── 7. Cross-tenant isolation — LLM-chosen IDs and guild predicates ───────────

test("pipeline: LLM-chosen event ID outside the candidate set degrades to new", async () => {
  const sql = makeTestSql();
  try {
    const { store, eventStore } = await makeStore(sql);
    const pipeline = new EventPipeline();
    const ev = await eventStore.createEvent({ guildId: guild, channelId: channel, title: "", summary: "", significance: 0, tier: "candidate", occurredAt: new Date(Date.now() - 60_000), participants: [{ userId: "user2", userName: "Tom", role: "subject" }] });
    const foreign = await eventStore.createEvent({ guildId: "other-guild", channelId: channel, title: "", summary: "", significance: 0, tier: "candidate", occurredAt: new Date(), participants: [] });
    // Brain answers with an event ID never among its candidates (hallucinated serial).
    const brain = {
      assessContinuity: async () => ({ action: "attach" as const, eventId: foreign.id }),
      classifyEvent: stubBrain().classifyEvent,
    } as unknown as Brain;
    // Participant + keyword overlap with the open event → ambiguous → LLM path.
    const m = msg("m-x", "remember when Tom did the Arsenal thing again");
    const saved = await store.saveMemory(m, mem("Tom did it again"));
    await pipeline.process(m, [saved.id], eventStore, store, brain);
    const foreignFresh = (await eventStore.getEvent("other-guild", foreign.id))!;
    assert.equal(foreignFresh.messageIds.length, 0, "foreign event must not receive the message");
    assert.equal(foreignFresh.memoryIds.length, 0, "foreign event must not receive the memory");
    const localFresh = (await eventStore.getEvent(guild, ev.id))!;
    assert.equal(localFresh.messageIds.length, 0, "candidate event should not attach either — degrades to new");
  } finally { await sql.end(); }
});

test("pipeline: bridge decision keeps only candidate IDs", async () => {
  const sql = makeTestSql();
  try {
    const { store, eventStore } = await makeStore(sql);
    const pipeline = new EventPipeline();
    const ev1 = await eventStore.createEvent({ guildId: guild, channelId: channel, title: "", summary: "", significance: 0, tier: "candidate", occurredAt: new Date(Date.now() - 60_000), participants: [{ userId: "user2", userName: "Tom", role: "subject" }] });
    const foreign = await eventStore.createEvent({ guildId: "other-guild", channelId: channel, title: "", summary: "", significance: 0, tier: "candidate", occurredAt: new Date(), participants: [] });
    // Bridge spanning a valid candidate and a foreign id → single survivor → attach.
    const brain = {
      assessContinuity: async () => ({ action: "bridge" as const, eventIds: [ev1.id, foreign.id] }),
      classifyEvent: stubBrain().classifyEvent,
    } as unknown as Brain;
    const m = msg("m-b", "remember when Tom did the Arsenal thing again");
    await pipeline.process(m, [], eventStore, store, brain);
    const foreignFresh = (await eventStore.getEvent("other-guild", foreign.id))!;
    assert.equal(foreignFresh.referenceCount, 0, "foreign event must not gain a reference");
    assert.equal(foreignFresh.messageIds.length, 0, "foreign event must not receive the message");
  } finally { await sql.end(); }
});

test("EventStore: writes with the wrong guildId are no-ops", async () => {
  const sql = makeTestSql();
  try {
    const { store, eventStore } = await makeStore(sql);
    const ev = await eventStore.createEvent({ guildId: "other-guild", channelId: channel, title: "", summary: "", significance: 0, tier: "candidate", occurredAt: new Date(), participants: [] });
    const saved = await store.saveMemory(msg("m-g", "I love Arsenal"), mem("Alice likes Arsenal"));
    await eventStore.attachMessage(guild, ev.id, "m-g");
    await eventStore.attachMemory(guild, ev.id, saved.id);
    await eventStore.addParticipant(guild, ev.id, "u9", "Mallory");
    assert.equal(await eventStore.incrementReferenceCount(guild, ev.id), 0);
    await eventStore.closeEvent(guild, ev.id);
    const fresh = (await eventStore.getEvent("other-guild", ev.id))!;
    assert.equal(fresh.messageIds.length, 0);
    assert.equal(fresh.memoryIds.length, 0);
    assert.equal(fresh.participants.length, 0);
    assert.equal(fresh.referenceCount, 0);
    assert.equal(fresh.closedAt, null);
    // memories.event_id must not point at a foreign event either
    const row = await store.getMemory(guild, saved.id);
    assert.equal(row?.eventId, null);
  } finally { await sql.end(); }
});

test("MemoryStore: messagesByIds and getMessage never cross guilds", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    await store.recordMessage(msg("m-same", "same guild message"));
    await store.recordMessage({ ...msg("m-foreign", "foreign guild message"), guildId: "other-guild" });
    const rows = await store.messagesByIds(guild, ["m-same", "m-foreign"]);
    assert.deepEqual(rows.map(r => r.content), ["same guild message"]);
    assert.equal(await store.getMessage(guild, "m-foreign"), undefined);
    assert.ok(await store.getMessage("other-guild", "m-foreign"));
  } finally { await sql.end(); }
});

// ── 8. Pipeline — classifyEvent receives the event's messages ────────────────

test("pipeline: maintainEvents passes the event's archived messages to classifyEvent", async () => {
  const sql = makeTestSql();
  try {
    const { store, eventStore } = await makeStore(sql);
    const pipeline = new EventPipeline();
    await store.recordMessage(msg("em-1", "I can't believe Tom bet £20 on Arsenal"));
    await store.recordMessage(msg("em-2", "he lost it in ten minutes"));
    const ev = await eventStore.createEvent({ guildId: guild, channelId: channel, title: "", summary: "", significance: 0, tier: "candidate", occurredAt: new Date(Date.now() - 60_000), participants: [] });
    await eventStore.attachMessage(guild, ev.id, "em-1");
    await eventStore.attachMessage(guild, ev.id, "em-2");
    await eventStore.closeEvent(guild, ev.id);
    const capturedClusters: Array<{ messages: Array<{ authorName: string; content: string }> }> = [];
    const brain = {
      assessContinuity: async () => ({ action: "new" as const }),
      classifyEvent: async (cluster: { messages: Array<{ authorName: string; content: string }> }) => {
        capturedClusters.push(cluster);
        return { significance: 0.75, tier: "high" as const, tone: "dramatic", narrativeComplete: true, futureRelevant: true, title: "T", summary: "S" };
      },
    } as unknown as Brain;
    await pipeline.maintainEvents(guild, eventStore, store, brain);
    assert.equal(capturedClusters.length, 1, "classifyEvent should have been called once");
    assert.deepEqual(capturedClusters[0].messages.map((m: { content: string }) => m.content), [
      "I can't believe Tom bet £20 on Arsenal",
      "he lost it in ten minutes",
    ]);
  } finally { await sql.end(); }
});

test("maintainEvents drains the whole candidate backlog and honors the re-score cap", async () => {
  const sql = makeTestSql();
  try {
    const { store, eventStore } = await makeStore(sql);
    const pipeline = new EventPipeline();
    // 12 closed candidates — the old LIMIT-8 pass would strand four of them.
    for (let i = 0; i < 12; i++) {
      await store.recordMessage(msg(`mb-${i}`, `backlog message ${i}`));
      const ev = await eventStore.createEvent({ guildId: guild, channelId: channel, title: "", summary: "", significance: 0, tier: "candidate", occurredAt: new Date(Date.now() - 60_000), participants: [] });
      await eventStore.attachMessage(guild, ev.id, `mb-${i}`);
      await eventStore.closeEvent(guild, ev.id);
    }
    // One already-at-cap row must not cost another LLM call.
    await store.recordMessage(msg("mb-cap", "capped message"));
    const capped = await eventStore.createEvent({ guildId: guild, channelId: channel, title: "", summary: "", significance: 0, tier: "candidate", occurredAt: new Date(Date.now() - 60_000), participants: [] });
    await eventStore.attachMessage(guild, capped.id, "mb-cap");
    await eventStore.closeEvent(guild, capped.id);
    await sql`UPDATE events SET classifications = 3 WHERE id = ${capped.id}`;
    // And an open candidate is never classified.
    const open = await eventStore.createEvent({ guildId: guild, channelId: channel, title: "", summary: "", significance: 0, tier: "candidate", occurredAt: new Date(), participants: [] });

    let calls = 0;
    const brain = {
      classifyEvent: async () => { calls++; return { significance: 0, tier: "low" as const, tone: "calm", narrativeComplete: false, futureRelevant: false, title: "", summary: "" }; },
    } as unknown as Brain;
    const result = await pipeline.maintainEvents(guild, eventStore, store, brain);
    assert.equal(calls, 12, "every unscored closed candidate gets exactly one pass");
    assert.equal(result.discarded, 12);

    // A discard stays candidate-tier but its classification was counted — it
    // re-enters the work list only until the cap, never forever.
    const rows = await sql<Array<{ id: number; classifications: number }>>`SELECT id, classifications FROM events WHERE guild_id = ${guild} AND tier = 'candidate' AND closed_at IS NOT NULL`;
    assert.ok(rows.every(r => r.classifications >= 1));
    const cappedRow = await eventStore.getEvent(guild, capped.id);
    assert.equal(cappedRow!.classifications, 3, "the at-cap row was not touched");
    const openRow = await eventStore.getEvent(guild, open.id);
    assert.equal(openRow!.classifications, 0, "open candidates are never classified");
  } finally { await sql.end(); }
});
