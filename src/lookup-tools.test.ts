import "dotenv/config";
import assert from "node:assert/strict";
import test from "node:test";
import { makeTestSql, makeStore } from "./test-helpers.js";
import { executeLookupTool, buildPairContext, type ToolCtx } from "./lookup-tools.js";
import { executeTool, replyToolDefs } from "./tools.js";
import type { MemoryStore } from "./database.js";
import type { EventStore } from "./events.js";
import type { ProfileStore } from "./profiles.js";
import type { MessageEvent } from "./types.js";

function msg(content: string, overrides: Partial<MessageEvent> = {}): MessageEvent {
  return {
    guildId: "g1", channelId: "c1", messageId: `m-${Math.random().toString(36).slice(2)}`,
    authorId: "u-author", authorName: "Alice",
    content, createdAt: new Date(), mentionsBot: false,
    ...overrides,
  };
}

// ── executeLookupTool with stub ctx ───────────────────────────────────────────

function stubCtx(overrides: Partial<ToolCtx> = {}): ToolCtx {
  return {
    guildId: "g1",
    store: {} as MemoryStore,
    eventStore: {} as EventStore,
    profileStore: {} as ProfileStore,
    resolveName: () => undefined,
    ...overrides,
  };
}

test("lookup_person: unknown name and missing args are friendly errors", async () => {
  const ctx = stubCtx({ resolveName: n => (n === "alice" ? "u1" : undefined) });
  assert.match(await executeLookupTool("lookup_person", { name: "nobody" }, ctx), /no member known as "nobody"/);
  assert.match(await executeLookupTool("lookup_person", {}, ctx), /missing name/);
});

test("lookup_person renders profile + active attributes only", async () => {
  const ctx = stubCtx({
    resolveName: () => "u1",
    profileStore: {
      getProfile: async () => ({ displayName: "Alice", summary: "Regular.", facets: {} }),
    } as unknown as ProfileStore,
    store: {
      getMember: async () => ({ optedIn: true, optedOut: false }),
      attributesFor: async () => [
        { field: "location", value: "Leeds", confidence: 0.9, status: "active" },
        { field: "interest", value: "stale thing", confidence: 0.9, status: "contested" },
      ],
      displayNameFor: async () => "Alice",
    } as unknown as MemoryStore,
  });
  const out = await executeLookupTool("lookup_person", { name: "alice" }, ctx);
  assert.match(out, /- Alice: Regular\. — location: Leeds \(high\)/);
  assert.doesNotMatch(out, /stale thing/); // contested never surfaces
});

test("lookup_person: member with neither profile nor attributes", async () => {
  const ctx = stubCtx({
    resolveName: () => "u1",
    profileStore: { getProfile: async () => undefined } as unknown as ProfileStore,
    store: {
      getMember: async () => ({ optedIn: true, optedOut: false }),
      attributesFor: async () => [], displayNameFor: async () => "Alice",
    } as unknown as MemoryStore,
  });
  assert.match(await executeLookupTool("lookup_person", { name: "alice" }, ctx), /no profile or attributes/);
});

test("lookup_person refuses members who never opted in", async () => {
  const ctx = stubCtx({
    resolveName: () => "u1",
    store: { getMember: async () => ({ optedIn: false, optedOut: false }) } as unknown as MemoryStore,
  });
  assert.match(await executeLookupTool("lookup_person", { name: "alice" }, ctx), /hasn't opted in/);
});

test("lookup_relationship renders the shared pair context", async () => {
  const ctx = stubCtx({
    resolveName: n => ({ alice: "u1", bob: "u2" } as Record<string, string>)[n],
    store: {
      getMember: async () => ({ optedIn: true, optedOut: false }),
      pairwiseContext: async () => ({
        ab: { summary: "rival", valence: -0.3, observationCount: 4 },
        ba: undefined,
        observations: [{ fromId: "u1", toId: "u2", nature: "rival", valence: -0.3, reason: "mocked his deck", createdAt: "2026-09-12T00:00:00Z" }],
        claimsAboutA: [], claimsAboutB: [],
      }),
      displayNameFor: async (_g: string, id: string) => (id === "u1" ? "Alice" : "Bob"),
    } as unknown as MemoryStore,
    eventStore: { sharedEvents: async () => [] } as unknown as EventStore,
  });
  const out = await executeLookupTool("lookup_relationship", { person_a: "alice", person_b: "bob" }, ctx);
  assert.match(out, /Alice ↔ Bob/);
  assert.match(out, /Alice says about Bob: "rival"/);
  assert.match(await executeLookupTool("lookup_relationship", { person_a: "alice", person_b: "ghost" }, ctx), /no member known as "ghost"/);
});

test("lookup_relationship: zero-signal pair reports no dynamic", async () => {
  const ctx = stubCtx({
    resolveName: () => "u1",
    store: {
      getMember: async () => ({ optedIn: true, optedOut: false }),
      pairwiseContext: async () => ({ ab: undefined, ba: undefined, observations: [], claimsAboutA: [], claimsAboutB: [] }),
      displayNameFor: async () => "X",
    } as unknown as MemoryStore,
    eventStore: { sharedEvents: async () => [] } as unknown as EventStore,
  });
  assert.match(await executeLookupTool("lookup_relationship", { person_a: "a", person_b: "b" }, ctx), /no recorded dynamic/);
});

test("lookup_relationship refuses when neither party consented; one consenting side suffices", async () => {
  const pairwiseContext = async () => ({
    ab: { summary: "friendly", valence: 0.5, observationCount: 2 },
    ba: undefined, observations: [], claimsAboutA: [], claimsAboutB: [],
  });
  const mk = (getMember: (id: string) => Promise<{ optedIn: boolean; optedOut: boolean }>) => stubCtx({
    resolveName: n => ({ alice: "u1", bob: "u2" } as Record<string, string>)[n],
    store: {
      getMember: (_g: string, id: string) => getMember(id),
      pairwiseContext, displayNameFor: async (_g: string, id: string) => (id === "u1" ? "Alice" : "Bob"),
    } as unknown as MemoryStore,
    eventStore: { sharedEvents: async () => [] } as unknown as EventStore,
  });
  // Both non-consenting → refusal.
  const denied = await executeLookupTool("lookup_relationship", { person_a: "alice", person_b: "bob" },
    mk(async () => ({ optedIn: false, optedOut: false })));
  assert.match(denied, /haven't opted in/);
  // Explicit opt-out on one side + never-consented other side → still refused.
  const denied2 = await executeLookupTool("lookup_relationship", { person_a: "alice", person_b: "bob" },
    mk(async id => (id === "u1" ? { optedIn: false, optedOut: true } : { optedIn: false, optedOut: false })));
  assert.match(denied2, /haven't opted in/);
  // Only Bob opted in → the pair is shared data (persistence uses the same rule).
  const allowed = await executeLookupTool("lookup_relationship", { person_a: "alice", person_b: "bob" },
    mk(async id => (id === "u2" ? { optedIn: true, optedOut: false } : { optedIn: false, optedOut: false })));
  assert.match(allowed, /Alice ↔ Bob/);
});

test("search_memories: guild-wide and subject-scoped paths", async () => {
  const ctx = stubCtx({
    resolveName: n => (n === "alice" ? "u1" : undefined),
    store: {
      getMember: async () => ({ optedIn: true, optedOut: false }),
      searchMemories: async () => [
        { subjectId: "u1", content: "Lives in Leeds", confidence: 0.9 },
        { subjectId: "u2", content: "Moved near Leeds", confidence: 0.6 },
      ],
      listMemories: async () => ({ memories: [{ content: "Lives in Leeds", confidence: 0.9 }], total: 1, page: 1 }),
      displayNameFor: async (_g: string, id: string) => (id === "u1" ? "Alice" : "Bob"),
    } as unknown as MemoryStore,
  });
  const wide = await executeLookupTool("search_memories", { query: "leeds" }, ctx);
  assert.match(wide, /\[Alice\] Lives in Leeds/);
  assert.match(wide, /\[Bob\] Moved near Leeds/);
  const scoped = await executeLookupTool("search_memories", { query: "leeds", subject: "alice" }, ctx);
  assert.match(scoped, /\[Alice\] Lives in Leeds/);
  assert.match(await executeLookupTool("search_memories", { query: "x", subject: "ghost" }, ctx), /no member known as "ghost"/);
});

test("lookup_event renders title, summary, participants", async () => {
  const ctx = stubCtx({
    eventStore: {
      searchEvents: async () => [{
        id: 7, title: "The Pineapple War", summary: "it escalated", significance: 0.9, tier: "event",
        occurredAt: new Date("2026-08-01"), participants: [
          { userId: "u1", userName: "Alice", role: "subject" },
          { userId: "u2", userName: "Bob", role: "antagonist" },
        ],
      }],
    } as unknown as EventStore,
  });
  const out = await executeLookupTool("lookup_event", { title: "pineapple" }, ctx);
  assert.match(out, /The Pineapple War \(Aug 1\) — it escalated\. Participants: Alice \(subject\), Bob \(antagonist\)/);
  assert.match(await executeLookupTool("lookup_event", {}, ctx), /missing title/);
});

// ── executeTool routing ───────────────────────────────────────────────────────

test("executeTool routes lookup names and refuses them without ctx", async () => {
  assert.match(await executeTool("lookup_person", '{"name":"x"}'), /lookup tools unavailable/);
  assert.match(await executeTool("lookup_person", '{"name":"x"}', stubCtx({ resolveName: () => undefined })), /no member known as "x"/);
  assert.match(await executeTool("bogus_tool", "{}"), /unknown tool/);
});

test("replyToolDefs exposes all six tools with required args", () => {
  const names = replyToolDefs.map(t => t.function.name);
  assert.deepEqual(names.sort(), ["lookup_event", "lookup_person", "lookup_relationship", "search_memories", "visit_url", "web_search"].sort());
  const rel = replyToolDefs.find(t => t.function.name === "lookup_relationship")!;
  assert.deepEqual(rel.function.parameters.required, ["person_a", "person_b"]);
});

// ── DB-backed: buildPairContext + the two new queries ─────────────────────────

test("searchMemories is guild-wide, active-only, importance-ordered", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    for (const id of ["u1", "u2", "u3"]) await store.setMemberOptIn("g1", id, true);
    const a = await store.saveMemory(msg("x", { authorId: "u1" }), { subjectId: "u1", kind: "person_fact", content: "Lives in Leeds", reason: "t", evidenceType: "explicit_fact", effect: "support" });
    const b = await store.saveMemory(msg("y", { authorId: "u2" }), { subjectId: "u2", kind: "person_fact", content: "Visits Leeds markets", reason: "t", evidenceType: "explicit_fact", effect: "support" });
    const c = await store.saveMemory(msg("z", { authorId: "u3" }), { subjectId: "u3", kind: "person_fact", content: "Leeds is rainy", reason: "t", evidenceType: "explicit_fact", effect: "support" });
    await store.confirm("g1", a.id); await store.confirm("g1", b.id);
    // c stays candidate → invisible to the tool
    const hits = await store.searchMemories("g1", "leeds");
    assert.equal(hits.length, 2);
    assert.deepEqual(hits.map(h => h.subjectId).sort(), ["u1", "u2"]);
    assert.equal(await (await store.searchMemories("g1", "nonexistent-term")).length, 0);
  } finally { await sql.end(); }
});

test("searchMemories hides active memories for non-consenting subjects", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    // A straggler row — saved and confirmed before consent was revoked/never given.
    const m = await store.saveMemory(msg("x", { authorId: "u1" }), { subjectId: "u1", kind: "person_fact", content: "Lives in Leeds", reason: "t", evidenceType: "explicit_fact", effect: "support" });
    await store.confirm("g1", m.id);
    assert.equal((await store.searchMemories("g1", "leeds")).length, 0);
    await store.setMemberOptIn("g1", "u1", true);
    assert.equal((await store.searchMemories("g1", "leeds")).length, 1);
  } finally { await sql.end(); }
});

test("searchMemories kinds filter excludes person facts at the query level", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    await store.setMemberOptIn("g1", "u2", true);
    const lore = await store.saveMemory(msg("x", { authorId: "u1" }), { subjectId: "server", kind: "server_lore", content: "The Leeds meetup is on Thursday", reason: "t", evidenceType: "explicit_fact", effect: "support" });
    const person = await store.saveMemory(msg("y", { authorId: "u2" }), { subjectId: "u2", kind: "person_fact", content: "Bob's timezone is Leeds GMT+1", reason: "t", evidenceType: "explicit_fact", effect: "support" });
    const pref = await store.saveMemory(msg("z", { authorId: "u2" }), { subjectId: "u2", kind: "person_preference", content: "Bob prefers Leeds pubs", reason: "t", evidenceType: "clear_preference", effect: "support" });
    await store.confirm("g1", lore.id); await store.confirm("g1", person.id); await store.confirm("g1", pref.id);
    // Unrestricted search still sees everything (the reply-tool path).
    assert.equal((await store.searchMemories("g1", "leeds")).length, 3);
    // Proactive grounding passes kinds=['server_lore'] — personal data can
    // never slip through a post-fetch filter into an unprompted answer.
    const scoped = await store.searchMemories("g1", "leeds", 5, ["server_lore"]);
    assert.equal(scoped.length, 1);
    assert.equal(scoped[0].content, "The Leeds meetup is on Thursday");
  } finally { await sql.end(); }
});

test("searchEvents matches titles and hydrates participants", async () => {
  const sql = makeTestSql();
  try {
    const { eventStore } = await makeStore(sql);
    await eventStore.createEvent({
      guildId: "g1", channelId: "c1", title: "The Pineapple War", summary: "escalated", significance: 0.9, tier: "event",
      occurredAt: new Date("2026-08-01"),
      participants: [{ userId: "u1", userName: "Alice", role: "subject" }, { userId: "u2", userName: "Bob", role: "antagonist" }],
    });
    await eventStore.createEvent({
      guildId: "g1", channelId: "c1", title: "candidate-title", summary: "x", significance: 0.9, tier: "candidate",
      occurredAt: new Date("2026-08-02"), participants: [],
    });
    const hits = await eventStore.searchEvents("g1", "pineapple");
    assert.equal(hits.length, 1);
    assert.equal(hits[0].participants.length, 2);
    assert.equal((await eventStore.searchEvents("g1", "candidate-title")).length, 0); // tier filter
  } finally { await sql.end(); }
});

test("buildPairContext shares the reply-prompt assembly for tools", async () => {
  const sql = makeTestSql();
  try {
    const { store, eventStore } = await makeStore(sql);
    await store.recordMessage(msg("hi", { authorId: "u1", authorName: "Alice" }));
    await store.recordMessage(msg("hi", { authorId: "u2", authorName: "Bob" }));
    await store.setMemberOptIn("g1", "u1", true);
    await store.setMemberOptIn("g1", "u2", true);
    await store.recordRelationship("g1", "u1", "u2", "m1", "u1", "antagonizes", -0.5, "mocked them");
    await sql`UPDATE relationship_observations SET verdict = 'literal' WHERE guild_id = 'g1'`;
    await store.recomputeEdges("g1");

    const pc = await buildPairContext(store, eventStore, "g1", "u1", "u2");
    assert.ok(pc);
    assert.equal(pc.aName, "Alice");
    assert.equal(pc.bName, "Bob");
    assert.equal(pc.aToB?.summary, "antagonizes");
    assert.equal(pc.bToA, undefined);
    assert.equal(pc.reasons[0].fromName, "Alice"); // asserting side resolves to its name
  } finally { await sql.end(); }
});
