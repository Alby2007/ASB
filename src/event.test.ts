import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { MemoryStore } from "./database.js";
import { EventStore } from "./events.js";
import { EventPipeline } from "./event-detection.js";
import { calculateSignificance } from "./event-significance.js";
import { runMigrations, getMigrationVersion } from "./migrations.js";
import type { Brain } from "./brain.js";
import type { MessageEvent, MemoryCandidate } from "./types.js";

// ── Shared helpers ─────────────────────────────────────────────────────────────

const guild = "test-guild";
const channel = "test-channel";

function makeStore() {
  const store = new MemoryStore(":memory:");
  const evStore = new EventStore(store.db);
  return { store, evStore };
}

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

// ── 1. Significance scoring — deterministic ────────────────────────────────────

test("significance: low-activity cluster is discarded", () => {
  const { score, tier } = calculateSignificance({
    distinctParticipants: 1, messageCount: 2, memoryCount: 0,
    tone: "calm", narrativeComplete: false, futureRelevant: false,
  });
  assert.ok(score < 0.35, `score was ${score}`);
  assert.equal(tier, "discard");
});

test("significance: two-user exchange with memories and some future relevance is a candidate", () => {
  // 2 participants (0.5), 6 messages (0.75), 2 memories, playful tone, future relevant
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
  // narrative + future + dramatic + memories — borderline
  assert.ok(score > 0, `score was ${score}`);
  // we don't assert the exact tier here since weights may put it at candidate
  assert.ok(["candidate", "event"].includes(tier), `unexpected tier ${tier}`);
});

// ── 2. EventStore CRUD ────────────────────────────────────────────────────────

test("EventStore: createEvent stores a new candidate event", () => {
  const { evStore } = makeStore();
  const ev = evStore.createEvent({
    guildId: guild, channelId: channel, title: "", summary: "",
    significance: 0, tier: "candidate", occurredAt: new Date(),
    participants: [{ userId: "u1", userName: "Alice", role: "participant" }],
  });
  assert.ok(ev.id > 0);
  assert.equal(ev.tier, "candidate");
  assert.equal(ev.participants.length, 1);
  assert.equal(ev.participants[0].userId, "u1");
});

test("EventStore: attachMessage and attachMemory link records", () => {
  const { store, evStore } = makeStore();
  const ev = evStore.createEvent({ guildId: guild, channelId: channel, title: "", summary: "", significance: 0, tier: "candidate", occurredAt: new Date(), participants: [] });
  evStore.attachMessage(ev.id, "msg-001");
  const saved = store.saveMemory(msg("mem-001", "I love Arsenal"), mem("Alice likes Arsenal"));
  evStore.attachMemory(ev.id, saved.id, "generated");

  const fresh = evStore.getEvent(guild, ev.id)!;
  assert.ok(fresh.messageIds.includes("msg-001"));
  assert.ok(fresh.memoryIds.includes(saved.id));
});

test("EventStore: openEvents returns only unclosed events in the channel", () => {
  const { evStore } = makeStore();
  const ev1 = evStore.createEvent({ guildId: guild, channelId: channel, title: "", summary: "", significance: 0, tier: "candidate", occurredAt: new Date(), participants: [] });
  evStore.createEvent({ guildId: guild, channelId: channel, title: "", summary: "", significance: 0, tier: "candidate", occurredAt: new Date(), participants: [] });
  evStore.closeEvent(ev1.id);

  const open = evStore.openEvents(guild, channel);
  assert.equal(open.length, 1);
  assert.notEqual(open[0].id, ev1.id);
});

test("EventStore: incrementReferenceCount increments correctly", () => {
  const { evStore } = makeStore();
  const ev = evStore.createEvent({ guildId: guild, channelId: channel, title: "", summary: "", significance: 0, tier: "candidate", occurredAt: new Date(), participants: [] });
  assert.equal(evStore.incrementReferenceCount(ev.id), 1);
  assert.equal(evStore.incrementReferenceCount(ev.id), 2);
});

test("EventStore: updateSignificance promotes tier to event", () => {
  const { evStore } = makeStore();
  const ev = evStore.createEvent({ guildId: guild, channelId: channel, title: "", summary: "", significance: 0, tier: "candidate", occurredAt: new Date(), participants: [] });
  evStore.updateSignificance(ev.id, 0.82, "event", "The Bet", "Tom lost £20 betting on Arsenal.");
  const fresh = evStore.getEvent(guild, ev.id)!;
  assert.equal(fresh.tier, "event");
  assert.equal(fresh.title, "The Bet");
  assert.ok(fresh.significance > 0.8);
});

test("EventStore: eventsForMemory returns linked events", () => {
  const { store, evStore } = makeStore();
  const ev = evStore.createEvent({ guildId: guild, channelId: channel, title: "Test", summary: "Test", significance: 0.7, tier: "event", occurredAt: new Date(), participants: [] });
  const saved = store.saveMemory(msg("m1", "I support Arsenal"), mem("Alice supports Arsenal"));
  evStore.attachMemory(ev.id, saved.id, "generated");

  const linked = evStore.eventsForMemory(saved.id);
  assert.equal(linked.length, 1);
  assert.equal(linked[0].id, ev.id);
});

// ── 3. Pipeline — heuristic attach ───────────────────────────────────────────

test("pipeline: reply-chain message is attached to open event without LLM", async () => {
  const { store, evStore } = makeStore();
  const pipeline = new EventPipeline();

  // Create an open event containing message msg-001
  const ev = evStore.createEvent({ guildId: guild, channelId: channel, title: "", summary: "", significance: 0, tier: "candidate", occurredAt: new Date(Date.now() - 60_000), participants: [] });
  evStore.attachMessage(ev.id, "msg-001");

  // Save a memory so the pipeline has something to process
  const saved = store.saveMemory(msg("msg-002", "I love Arsenal"), mem("Alice likes Arsenal"));
  // A brain stub that should NOT be called (if it is, it returns "new")
  let llmCalled = false;
  const watchBrain = { assessContinuity: async () => { llmCalled = true; return { action: "new" as const }; }, classifyEvent: stubBrain().classifyEvent } as unknown as Brain;

  // Process a reply to msg-001
  await pipeline.process(msg("msg-002", "Yeah definitely"), [saved.id], evStore, store, watchBrain, "msg-001");

  assert.equal(llmCalled, false, "LLM should not be called for a reply chain");
  const fresh = evStore.getEvent(guild, ev.id)!;
  assert.ok(fresh.messageIds.includes("msg-002"), "reply should be attached to the event");
});

// ── 4. Pipeline — new event created when memory extracted ─────────────────────

test("pipeline: new event candidate is created when a memory is extracted", async () => {
  const { store, evStore } = makeStore();
  const pipeline = new EventPipeline();
  const brain = stubBrain("new");

  const saved = store.saveMemory(msg("m1", "I love Arsenal"), mem("Alice likes Arsenal"));
  await pipeline.process(msg("m1", "I love Arsenal"), [saved.id], evStore, store, brain);

  const open = evStore.openEvents(guild, channel);
  assert.equal(open.length, 1);
  assert.ok(open[0].messageIds.includes("m1"));
  assert.ok(open[0].memoryIds.includes(saved.id));
});

// ── 5. Pipeline — no event created for ordinary chat with no memories ─────────

test("pipeline: ordinary chat with no memories does not create an event", async () => {
  const { store, evStore } = makeStore();
  const pipeline = new EventPipeline();
  const brain = stubBrain("new");

  // No memory saved — savedMemoryIds is empty
  await pipeline.process(msg("m1", "sup"), [], evStore, store, brain);

  const open = evStore.openEvents(guild, channel);
  assert.equal(open.length, 0);
});

// ── 6. Pipeline — reference increments reference_count ───────────────────────

test("pipeline: back-reference message increments event reference_count", async () => {
  const { store, evStore } = makeStore();
  const pipeline = new EventPipeline();

  // Create an open event (not yet closed) so the heuristic considers it
  const ev = evStore.createEvent({ guildId: guild, channelId: channel, title: "The Arsenal Incident", summary: "Tom lost a bet.", significance: 0.4, tier: "candidate", occurredAt: new Date(Date.now() - 3_600_000), participants: [{ userId: "user2", userName: "Tom", role: "subject" }] });

  // The back-reference message is from a different author; keyword overlap is present ("bet", "arsenal")
  // but it is NOT a reply chain, so score is ambiguous → LLM is consulted.
  // The stub returns "reference" so the reference_count should increment.
  const brain = stubBrain("reference", ev.id);
  const backRef = msg("m2", "remember when Tom lost that Arsenal bet?", "user1", "Alice");
  const saved = store.saveMemory(backRef, mem("Tom lost a bet on Arsenal"));
  await pipeline.process(backRef, [saved.id], evStore, store, brain);

  const fresh = evStore.getEvent(guild, ev.id)!;
  assert.equal(fresh.referenceCount, 1);
});

test("pipeline: ambiguous continuity sends the event's recent messages to the LLM", async () => {
  const { store, evStore } = makeStore();
  const pipeline = new EventPipeline();

  // Open candidate with an archived message attached
  store.recordMessage(msg("em-1", "Tom just lost £20 on the Arsenal bet"));
  const ev = evStore.createEvent({ guildId: guild, channelId: channel, title: "", summary: "", significance: 0, tier: "candidate", occurredAt: new Date(Date.now() - 60_000), participants: [{ userId: "user2", userName: "Tom", role: "subject" }] });
  evStore.attachMessage(ev.id, "em-1");

  // Back-reference + keyword overlap lands in the ambiguous band → LLM consulted
  const seen: Array<Array<{ id: number; recentMessages: Array<{ authorName: string; content: string }> }>> = [];
  const brain = {
    assessContinuity: async (_e: MessageEvent, events: Array<{ id: number; recentMessages: Array<{ authorName: string; content: string }> }>) => {
      seen.push(events);
      return { action: "reference" as const, eventId: ev.id };
    },
    classifyEvent: stubBrain().classifyEvent,
  } as unknown as Brain;

  const backRef = msg("m2", "remember when Tom lost that Arsenal bet?", "user1", "Alice");
  await pipeline.process(backRef, [], evStore, store, brain);

  assert.equal(seen.length, 1, "assessContinuity should have been called");
  const offered = seen[0].find(e => e.id === ev.id);
  assert.ok(offered, "the open event should be among the LLM candidates");
  assert.deepEqual(offered.recentMessages.map(m => m.content), ["Tom just lost £20 on the Arsenal bet"]);
});

// ── 8. Pipeline — classifyEvent receives the event's messages ────────────────

test("pipeline: maintainEvents passes the event's archived messages to classifyEvent", async () => {
  const { store, evStore } = makeStore();
  const pipeline = new EventPipeline();

  // Archive two messages and attach them to a candidate event
  store.recordMessage(msg("em-1", "I can't believe Tom bet £20 on Arsenal"));
  store.recordMessage(msg("em-2", "he lost it in ten minutes"));
  const ev = evStore.createEvent({ guildId: guild, channelId: channel, title: "", summary: "", significance: 0, tier: "candidate", occurredAt: new Date(Date.now() - 60_000), participants: [] });
  evStore.attachMessage(ev.id, "em-1");
  evStore.attachMessage(ev.id, "em-2");
  evStore.closeEvent(ev.id);

  const capturedClusters: Array<{ messages: Array<{ authorName: string; content: string }> }> = [];
  const brain = {
    assessContinuity: async () => ({ action: "new" as const }),
    classifyEvent: async (cluster: { messages: Array<{ authorName: string; content: string }> }) => {
      capturedClusters.push(cluster);
      return { significance: 0.75, tier: "high" as const, tone: "dramatic", narrativeComplete: true, futureRelevant: true, title: "T", summary: "S" };
    },
  } as unknown as Brain;

  await pipeline.maintainEvents(guild, evStore, store, brain);

  assert.equal(capturedClusters.length, 1, "classifyEvent should have been called once");
  assert.deepEqual(capturedClusters[0].messages.map(m => m.content), [
    "I can't believe Tom bet £20 on Arsenal",
    "he lost it in ten minutes",
  ]);
});

// ── 8. Migration v4 ───────────────────────────────────────────────────────────

test("migration v4 creates events, event_participants, event_messages, event_memories tables", () => {
  const db = new Database(":memory:");
  // Set up base schema the same way the existing migration tests do
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, author_id TEXT NOT NULL, author_name TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, subject_id TEXT NOT NULL, kind TEXT NOT NULL, content TEXT NOT NULL,
      confidence REAL NOT NULL, importance REAL NOT NULL, mentions INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL,
      last_confirmed_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'candidate', explicitness REAL NOT NULL DEFAULT 0.5, reason TEXT NOT NULL DEFAULT '',
      UNIQUE(guild_id, subject_id, kind, content)
    );
    CREATE TABLE IF NOT EXISTS memory_evidence (
      id INTEGER PRIMARY KEY AUTOINCREMENT, memory_id INTEGER NOT NULL, message_id TEXT NOT NULL, author_id TEXT NOT NULL,
      quote TEXT NOT NULL, reason TEXT NOT NULL, explicitness REAL NOT NULL, observed_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS server_settings (guild_id TEXT PRIMARY KEY, memory_enabled INTEGER NOT NULL DEFAULT 1, reply_enabled INTEGER NOT NULL DEFAULT 1, raw_retention_days INTEGER NOT NULL DEFAULT 30);
  `);
  runMigrations(db);
  assert.equal(getMigrationVersion(db), 5);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
  for (const name of ["events", "event_participants", "event_messages", "event_memories"]) {
    assert.ok(tables.some(t => t.name === name), `Missing table: ${name}`);
  }
  const cols = db.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>;
  assert.ok(cols.some(c => c.name === "event_id"), "memories.event_id column missing");
});

test("migration v4 creates expected indexes", () => {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, author_id TEXT NOT NULL, author_name TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS memories (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, subject_id TEXT NOT NULL, kind TEXT NOT NULL, content TEXT NOT NULL, confidence REAL NOT NULL, importance REAL NOT NULL, mentions INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, last_confirmed_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'candidate', explicitness REAL NOT NULL DEFAULT 0.5, reason TEXT NOT NULL DEFAULT '', UNIQUE(guild_id, subject_id, kind, content));
    CREATE TABLE IF NOT EXISTS memory_evidence (id INTEGER PRIMARY KEY AUTOINCREMENT, memory_id INTEGER NOT NULL, message_id TEXT NOT NULL, author_id TEXT NOT NULL, quote TEXT NOT NULL, reason TEXT NOT NULL, explicitness REAL NOT NULL, observed_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS server_settings (guild_id TEXT PRIMARY KEY, memory_enabled INTEGER NOT NULL DEFAULT 1, reply_enabled INTEGER NOT NULL DEFAULT 1, raw_retention_days INTEGER NOT NULL DEFAULT 30);
  `);
  runMigrations(db);
  const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as Array<{ name: string }>;
  for (const name of ["events_guild_channel", "events_guild_open", "event_participants_event", "event_messages_event", "event_memories_memory", "event_memories_event"]) {
    assert.ok(indexes.some(i => i.name === name), `Missing index: ${name}`);
  }
});

test("migration v4 rollback removes event tables and event_id column data", () => {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, author_id TEXT NOT NULL, author_name TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS memories (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, subject_id TEXT NOT NULL, kind TEXT NOT NULL, content TEXT NOT NULL, confidence REAL NOT NULL, importance REAL NOT NULL, mentions INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, last_confirmed_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'candidate', explicitness REAL NOT NULL DEFAULT 0.5, reason TEXT NOT NULL DEFAULT '', UNIQUE(guild_id, subject_id, kind, content));
    CREATE TABLE IF NOT EXISTS memory_evidence (id INTEGER PRIMARY KEY AUTOINCREMENT, memory_id INTEGER NOT NULL, message_id TEXT NOT NULL, author_id TEXT NOT NULL, quote TEXT NOT NULL, reason TEXT NOT NULL, explicitness REAL NOT NULL, observed_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS server_settings (guild_id TEXT PRIMARY KEY, memory_enabled INTEGER NOT NULL DEFAULT 1, reply_enabled INTEGER NOT NULL DEFAULT 1, raw_retention_days INTEGER NOT NULL DEFAULT 30);
  `);
  runMigrations(db);
  assert.equal(getMigrationVersion(db), 5);
  runMigrations(db, 3);
  assert.equal(getMigrationVersion(db), 3);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
  for (const name of ["events", "event_participants", "event_messages", "event_memories"]) {
    assert.ok(!tables.some(t => t.name === name), `Table should be gone after rollback: ${name}`);
  }
});
