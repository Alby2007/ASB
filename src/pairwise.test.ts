import "dotenv/config";
import assert from "node:assert/strict";
import test from "node:test";
import { makeTestSql, makeStore } from "./test-helpers.js";
import { formatPairContext } from "./brain.js";
import type { MessageEvent, PairContext } from "./types.js";

function msg(content: string, overrides: Partial<MessageEvent> = {}): MessageEvent {
  return {
    guildId: "g1", channelId: "c1", messageId: `m-${Math.random().toString(36).slice(2)}`,
    authorId: "u-author", authorName: "Alice",
    content, createdAt: new Date(), mentionsBot: false,
    ...overrides,
  };
}

// ── pairwiseContext ───────────────────────────────────────────────────────────

test("pairwiseContext keeps edge directions on the correct sides", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    // u1 asserts about u2; u2 asserts about u1 — stored as separate directed edges
    await store.recordRelationship("g1", "u1", "u2", "m1", "antagonizes", -0.5, "mocked her takes");
    await store.recordRelationship("g1", "u2", "u1", "m2", "defends", 0.7, "stood up for them");
    await sql`UPDATE relationship_observations SET verdict = 'literal' WHERE guild_id = 'g1'`;
    await store.recomputeEdges("g1");

    const pc = await store.pairwiseContext("g1", "u1", "u2");
    assert.equal(pc.ab?.subjectId, "u1");
    assert.equal(pc.ab?.otherId, "u2");
    assert.equal(pc.ab?.summary, "antagonizes");
    assert.equal(pc.ba?.subjectId, "u2");
    assert.equal(pc.ba?.summary, "defends");

    // Order of arguments must not matter for which edge lands where
    const rev = await store.pairwiseContext("g1", "u2", "u1");
    assert.equal(rev.ab?.subjectId, "u2");
    assert.equal(rev.ab?.summary, "defends");
    assert.equal(rev.ba?.subjectId, "u1");
  } finally { await sql.end(); }
});

test("pairwiseContext surfaces only literal-verdicted observations", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    await store.recordRelationship("g1", "u1", "u2", "m1", "antagonizes", -0.5, "mocked them");
    await store.recordRelationship("g1", "u1", "u2", "m2", "flirts", 0.4, "ambiguous bit");
    await store.recordRelationship("g1", "u1", "u2", "m3", "dating", 0.9, "joke ship");
    // Unverified → invisible
    assert.equal((await store.pairwiseContext("g1", "u1", "u2")).observations.length, 0);

    const obs = await sql<Array<{ id: number; message_id: string }>>`SELECT id, message_id FROM relationship_observations WHERE guild_id = 'g1'`;
    const idOf = (mid: string) => obs.find(o => o.message_id === mid)!.id;
    await store.setObservationVerdict(idOf("m1"), "literal");
    await store.setObservationVerdict(idOf("m2"), "unclear");
    await store.setObservationVerdict(idOf("m3"), "joke");

    const pc = await store.pairwiseContext("g1", "u1", "u2");
    assert.equal(pc.observations.length, 1);
    assert.equal(pc.observations[0].fromId, "u1");
    assert.equal(pc.observations[0].toId, "u2");
    assert.equal(pc.observations[0].reason, "mocked them");
  } finally { await sql.end(); }
});

test("pairwiseContext claims are active memories about one side authored by the other", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    // u2 writes a memory about u1 (evidence author u2)
    const m = await store.saveMemory(msg("Alice is stubborn", { authorId: "u2", authorName: "Bob" }), {
      subjectId: "u1", kind: "person_fact", content: "Is stubborn", reason: "t", evidenceType: "reported_by_other", effect: "support",
    });
    // Candidate (unconfirmed) → invisible
    let pc = await store.pairwiseContext("g1", "u1", "u2");
    assert.equal(pc.claimsAboutA.length, 0);

    await store.confirm("g1", m.id);
    pc = await store.pairwiseContext("g1", "u1", "u2");
    assert.deepEqual(pc.claimsAboutA, ["Is stubborn"]);
    assert.equal(pc.claimsAboutB.length, 0);

    // A self-authored memory about u1 is not a pair claim (author = subject)
    const self = await store.saveMemory(msg("I have a cat named Jinx", { authorId: "u1", authorName: "Alice" }), {
      subjectId: "u1", kind: "person_fact", content: "Has a cat named Jinx", reason: "t", evidenceType: "explicit_fact", effect: "support",
    });
    await store.confirm("g1", self.id);
    pc = await store.pairwiseContext("g1", "u1", "u2");
    assert.equal(pc.claimsAboutA.length, 1); // only the u2-authored one

    // Forgetting the claim drops it
    await store.forget("g1", m.id);
    pc = await store.pairwiseContext("g1", "u1", "u2");
    assert.equal(pc.claimsAboutA.length, 0);
  } finally { await sql.end(); }
});

test("opt-out erases pairwise edge and observation data", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    await store.recordRelationship("g1", "u1", "u2", "m1", "close friends", 0.8, "said so");
    await sql`UPDATE relationship_observations SET verdict = 'literal' WHERE guild_id = 'g1'`;
    await store.recomputeEdges("g1");
    assert.ok((await store.pairwiseContext("g1", "u1", "u2")).ab);

    await store.forgetRelationshipsFor("g1", "u1");
    const pc = await store.pairwiseContext("g1", "u1", "u2");
    assert.equal(pc.ab, undefined);
    assert.equal(pc.ba, undefined);
    assert.equal(pc.observations.length, 0);
  } finally { await sql.end(); }
});

test("sharedEvents returns only both-participant events with roles per side", async () => {
  const sql = makeTestSql();
  try {
    const { eventStore } = await makeStore(sql);
    await eventStore.createEvent({
      guildId: "g1", channelId: "c1", title: "The Pineapple War", summary: "arg", significance: 0.9, tier: "event",
      occurredAt: new Date("2026-08-01"),
      participants: [
        { userId: "u1", userName: "Alice", role: "subject" },
        { userId: "u2", userName: "Bob", role: "antagonist" },
      ],
    });
    await eventStore.createEvent({
      guildId: "g1", channelId: "c1", title: "Solo Night", summary: "x", significance: 0.95, tier: "event",
      occurredAt: new Date("2026-09-01"),
      participants: [{ userId: "u1", userName: "Alice", role: "subject" }],
    });

    const shared = await eventStore.sharedEvents("g1", "u1", "u2");
    assert.equal(shared.length, 1);
    assert.equal(shared[0].title, "The Pineapple War");
    assert.equal(shared[0].roleA, "subject");   // u1's role on the aId side
    assert.equal(shared[0].roleB, "antagonist"); // u2's role on the bId side

    // Swapped argument order flips the role sides symmetrically
    const rev = await eventStore.sharedEvents("g1", "u2", "u1");
    assert.equal(rev[0].roleA, "antagonist");
    assert.equal(rev[0].roleB, "subject");
  } finally { await sql.end(); }
});

// ── formatPairContext (pure) ──────────────────────────────────────────────────

test("formatPairContext renders directions, claims attribution, and events", () => {
  const ctx: PairContext = {
    aName: "Alice", bName: "Bob",
    aToB: { summary: "antagonizes", valence: -0.5, observationCount: 4 },
    bToA: { summary: "close friends", valence: 0.8, observationCount: 7 },
    reasons: [{ fromName: "Bob", reason: "mocked her takes", at: "2026-09-12T00:00:00Z" }],
    claimsAboutA: ["is stubborn"],
    claimsAboutB: [],
    sharedEvents: ["The Pineapple War (Aug 2026)"],
  };
  const line = formatPairContext(ctx);
  assert.match(line, /Alice ↔ Bob/);
  assert.match(line, /Alice says about Bob: "antagonizes"/);
  assert.match(line, /Bob says about Alice: "close friends"/);
  assert.match(line, /Bob: "mocked her takes" \(Sep 12\)/);
  // Claims attributed to the assertor, never stated as facts about the subject
  assert.match(line, /Bob claimed about Alice: "is stubborn"/);
  assert.doesNotMatch(line, /Alice claimed about Bob/);
  assert.match(line, /shared events: The Pineapple War \(Aug 2026\)/);
});

test("formatPairContext omits absent sections", () => {
  const ctx: PairContext = {
    aName: "Alice", bName: "Bob",
    reasons: [], claimsAboutA: [], claimsAboutB: [], sharedEvents: [],
  };
  const line = formatPairContext(ctx);
  assert.equal(line, "- Alice ↔ Bob: ");
  // A claims-only pair still renders (theory of mind without an edge)
  const claimsOnly = formatPairContext({ ...ctx, claimsAboutA: ["plays valorant"] });
  assert.match(claimsOnly, /Bob claimed about Alice: "plays valorant"/);
});
