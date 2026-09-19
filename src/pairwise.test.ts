import "dotenv/config";
import assert from "node:assert/strict";
import test from "node:test";
import { makeTestSql, makeStore } from "./test-helpers.js";
import { formatPairContext, formatReplyProfile } from "./brain.js";
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
    await store.setMemberOptIn("g1", "u1", true);
    await store.setMemberOptIn("g1", "u2", true);
    // u1 asserts about u2; u2 asserts about u1 — stored as separate directed edges
    await store.recordRelationship("g1", "u1", "u2", "m1", "u1", "antagonizes", -0.5, "mocked her takes");
    await store.recordRelationship("g1", "u2", "u1", "m2", "u2", "defends", 0.7, "stood up for them");
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
    await store.setMemberOptIn("g1", "u1", true);
    await store.setMemberOptIn("g1", "u2", true);
    await store.recordRelationship("g1", "u1", "u2", "m1", "u1", "antagonizes", -0.5, "mocked them");
    await store.recordRelationship("g1", "u1", "u2", "m2", "u1", "flirts", 0.4, "ambiguous bit");
    await store.recordRelationship("g1", "u1", "u2", "m3", "u1", "dating", 0.9, "joke ship");
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
    await store.setMemberOptIn("g1", "u1", true);
    await store.setMemberOptIn("g1", "u2", true);
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
    await store.setMemberOptIn("g1", "u1", true);
    await store.setMemberOptIn("g1", "u2", true);
    await store.recordRelationship("g1", "u1", "u2", "m1", "u1", "close friends", 0.8, "said so");
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
    aToB: { summary: "antagonizes", valence: -0.5, observationCount: 4, partyCount: 2, trend: null, lastObservedAt: null, inferred: false },
    bToA: { summary: "close friends", valence: 0.8, observationCount: 7, partyCount: 7, trend: null, lastObservedAt: null, inferred: false },
    behavioralCount: 0,
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

test("formatPairContext renders confidence tiers, trend, secondhand, staleness", () => {
  const edge = (over: object) => ({
    summary: "close friends", valence: 0.8, observationCount: 1,
    partyCount: 1, trend: null, lastObservedAt: null, inferred: false, ...over,
  });
  const base: PairContext = {
    aName: "Alice", bName: "Bob", behavioralCount: 0,
    reasons: [], claimsAboutA: [], claimsAboutB: [], sharedEvents: [],
  };
  assert.match(formatPairContext({ ...base, aToB: edge({ observationCount: 1 }) }), /claimed once/);
  assert.match(formatPairContext({ ...base, aToB: edge({ observationCount: 3 }) }), /described a few times/);
  assert.match(formatPairContext({ ...base, aToB: edge({ observationCount: 6 }) }), /well-established/);
  // Gossip-only edge flagged
  assert.match(formatPairContext({ ...base, aToB: edge({ partyCount: 0 }) }), /all secondhand/);
  // Trend surfaces
  assert.match(formatPairContext({ ...base, aToB: edge({ trend: "warming" }) }), /lately warming/);
  // Stale edge annotated
  const stale = new Date(Date.now() - 90 * 86_400_000).toISOString();
  assert.match(formatPairContext({ ...base, aToB: edge({ lastObservedAt: stale }) }), /not recently observed/);
});

test("formatPairContext renders inferred edges as contact frequency, never a claim", () => {
  const ctx: PairContext = {
    aName: "Alice", bName: "Bob", behavioralCount: 42,
    aToB: { summary: "", valence: null, observationCount: 0, partyCount: 0, trend: null, lastObservedAt: null, inferred: true },
    reasons: [], claimsAboutA: [], claimsAboutB: [], sharedEvents: [],
  };
  const line = formatPairContext(ctx);
  assert.match(line, /frequent interaction \(42 times in 90d\) — dynamic not recorded/);
  // No nature, no valence, no "says about" — frequency can't launder into a claim
  assert.doesNotMatch(line, /says about/);
  assert.doesNotMatch(line, /valence/);
  // Claimed edge + behavioral stamp shows corroboration, not the disclaimer
  const claimed = formatPairContext({
    ...ctx,
    aToB: { summary: "close friends", valence: 0.8, observationCount: 3, partyCount: 2, trend: null, lastObservedAt: null, inferred: false },
  });
  assert.match(claimed, /also interact frequently \(42 times in 90d\)/);
});

test("formatPairContext omits absent sections", () => {
  const ctx: PairContext = {
    aName: "Alice", bName: "Bob", behavioralCount: 0,
    reasons: [], claimsAboutA: [], claimsAboutB: [], sharedEvents: [],
  };
  const line = formatPairContext(ctx);
  assert.equal(line, "- Alice ↔ Bob: ");
  // A claims-only pair still renders (theory of mind without an edge)
  const claimsOnly = formatPairContext({ ...ctx, claimsAboutA: ["plays valorant"] });
  assert.match(claimsOnly, /Bob claimed about Alice: "plays valorant"/);
});

// ── formatReplyProfile (pure) ─────────────────────────────────────────────────

test("formatReplyProfile renders attributes with confidence buckets and field labels", () => {
  const line = formatReplyProfile({
    name: "Alice", summary: "Regular.",
    attributes: [
      { field: "location", value: "Leeds", confidence: 0.9 },
      { field: "interest", value: "horror films", confidence: 0.85 },
      { field: "interest", value: "tekken", confidence: 0.5 },
      { field: "trait", value: "competitive", confidence: 0.6 },
    ],
  });
  // Singular field labeled; multi-valued pluralized and confidence-sorted
  assert.match(line, /- Alice: Regular\. — /);
  assert.match(line, /location: Leeds \(high\)/);
  assert.match(line, /interests: horror films \(high\), tekken \(low\)/);
  assert.match(line, /trait: competitive \(medium\)/);
  // Fields render alphabetical: interest < location < trait
  assert.ok(line.indexOf("interests") < line.indexOf("location") && line.indexOf("location") < line.indexOf("trait:"));
});

test("formatReplyProfile falls back to flat traits when no attributes exist", () => {
  assert.equal(
    formatReplyProfile({ name: "Bob", summary: "Lurker.", traits: ["quiet"] }),
    "- Bob: Lurker. (traits: quiet)"
  );
  assert.equal(
    formatReplyProfile({ name: "Bob", summary: "", attributes: [] }),
    "- Bob"
  );
  // Empty summary + attributes → no dangling colon
  const attrsOnly = formatReplyProfile({
    name: "Bob", summary: "",
    attributes: [{ field: "pronouns", value: "they/them", confidence: 0.95 }],
  });
  assert.equal(attrsOnly, "- Bob — pronouns: they/them (high)");
});

test("pairwiseContext hides pairs where neither side consented", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    await store.recordRelationship("g1", "u1", "u2", "m1", "u1", "close friends", 0.8, "said so");
    await sql`UPDATE relationship_observations SET verdict = 'literal' WHERE guild_id = 'g1'`;
    await store.recomputeEdges("g1");

    // No opt-ins → the pair is invisible even though the edge exists.
    let pc = await store.pairwiseContext("g1", "u1", "u2");
    assert.equal(pc.ab, undefined);
    assert.equal(pc.observations.length, 0);

    // Subject-consent: one side opting in is enough to surface it.
    await store.setMemberOptIn("g1", "u2", true);
    pc = await store.pairwiseContext("g1", "u1", "u2");
    assert.ok(pc.ab);
  } finally { await sql.end(); }
});

// ── recomputeEdges: weighting, trend, behavioral fusion ──────────────────────

test("edge valence weights party-authored observations over third-party gossip", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    // One party-authored claim (+0.9, weight 2) vs two third-party claims (-0.6, weight 1 each).
    await store.recordRelationship("g1", "u1", "u2", "m1", "u1", "close friends", 0.9, "she's my best friend");
    await store.recordRelationship("g1", "u1", "u2", "m2", "u3", "barely talk", -0.6, "never seen them together");
    await store.recordRelationship("g1", "u1", "u2", "m3", "u4", "distant", -0.6, "seems cold");
    await sql`UPDATE relationship_observations SET verdict = 'literal' WHERE guild_id = 'g1'`;
    await store.recomputeEdges("g1");

    const edge = (await store.relationshipsFor("g1", "u1"))[0];
    // Weighted: (0.9*2 - 0.6 - 0.6) / 4 = 0.15 — vs unweighted avg of 0.1.
    // The pair's own words pulled the aggregate up.
    assert.ok(edge.valence != null && Math.abs(edge.valence - 0.15) < 1e-6, `valence was ${edge.valence}`);
    assert.equal(edge.partyCount, 1);
    assert.equal(edge.observationCount, 3);
  } finally { await sql.end(); }
});

test("edge summary is the modal nature over the recent window, not the latest", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    await store.recordRelationship("g1", "u1", "u2", "m1", "u1", "close friends", 0.8, "a");
    await store.recordRelationship("g1", "u1", "u2", "m2", "u1", "close friends", 0.7, "b");
    await store.recordRelationship("g1", "u1", "u2", "m3", "u1", "rivals", -0.5, "one-off spat");
    await sql`UPDATE relationship_observations SET verdict = 'literal' WHERE guild_id = 'g1'`;
    // Make the rivals claim the most recent — latest-nature would show "rivals",
    // mode still shows "close friends" (2 of 3).
    await sql`UPDATE relationship_observations SET created_at = now() + interval '1 hour' WHERE message_id = 'm3'`;
    await store.recomputeEdges("g1");

    const edge = (await store.relationshipsFor("g1", "u1"))[0];
    assert.equal(edge.summary, "close friends");
  } finally { await sql.end(); }
});

test("edge trend marks warming and cooling against the all-time average", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    // u1→u2: hostile history, recent warmth. u3→u4: warm history, recent hostility.
    for (let i = 0; i < 4; i++) await store.recordRelationship("g1", "u1", "u2", `w-old${i}`, "u1", "rivals", -0.8, "old");
    for (let i = 0; i < 4; i++) await store.recordRelationship("g1", "u1", "u2", `w-new${i}`, "u1", "close friends", 0.9, "new");
    for (let i = 0; i < 4; i++) await store.recordRelationship("g1", "u3", "u4", `c-old${i}`, "u3", "close friends", 0.9, "old");
    for (let i = 0; i < 4; i++) await store.recordRelationship("g1", "u3", "u4", `c-new${i}`, "u3", "hostile", -0.9, "new");
    await sql`UPDATE relationship_observations SET verdict = 'literal' WHERE guild_id = 'g1'`;
    await sql`UPDATE relationship_observations SET created_at = created_at - interval '30 days' WHERE message_id LIKE '%-old%'`;
    await store.recomputeEdges("g1");

    const warm = (await store.relationshipsFor("g1", "u1")).find(e => e.otherId === "u2");
    const cool = (await store.relationshipsFor("g1", "u3")).find(e => e.otherId === "u4");
    assert.equal(warm?.trend, "warming");
    assert.equal(cool?.trend, "cooling");

    // Under 3 observations: no trend, no matter how big the swing.
    await store.recordRelationship("g1", "u5", "u6", "s1", "u5", "rivals", -0.9, "a");
    await store.recordRelationship("g1", "u5", "u6", "s2", "u5", "close friends", 0.9, "b");
    await sql`UPDATE relationship_observations SET verdict = 'literal' WHERE message_id IN ('s1', 's2')`;
    await store.recomputeEdges("g1");
    assert.equal((await store.relationshipsFor("g1", "u5"))[0].trend, null);
  } finally { await sql.end(); }
});

test("interactions stamp behavioral_count and materialize inferred edges", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    await store.setMemberOptIn("g1", "u1", true);
    await store.setMemberOptIn("g1", "u3", true);
    // Claimed edge u1↔u2 + heavy-contact unclaimed pair u3↔u4 + thin pair u5↔u6.
    await store.recordRelationship("g1", "u1", "u2", "m1", "u1", "close friends", 0.8, "t");
    await sql`UPDATE relationship_observations SET verdict = 'literal' WHERE guild_id = 'g1'`;
    const edgeCount = await store.recomputeEdges("g1", [
      { aId: "u1", bId: "u2", count: 12 },
      { aId: "u3", bId: "u4", count: 9 },
      { aId: "u5", bId: "u6", count: 4 },
    ]);
    assert.equal(edgeCount, 3); // 1 claimed + 2 symmetric inferred

    const claimed = (await store.relationshipsFor("g1", "u1"))[0];
    assert.equal(claimed.behavioralCount, 12);
    assert.equal(claimed.inferred, false);

    const inferredEdge = (await store.relationshipsFor("g1", "u3")).find(e => e.otherId === "u4");
    assert.equal(inferredEdge?.inferred, true);
    assert.equal(inferredEdge?.behavioralCount, 9);
    assert.equal(inferredEdge?.observationCount, 0);
    assert.equal(inferredEdge?.summary, "");
    // Symmetric — both directions exist so either side's reads see it.
    assert.ok((await store.relationshipsFor("g1", "u4")).some(e => e.otherId === "u3" && e.inferred));
    // Under the floor (4 < 5): nothing.
    assert.equal((await store.relationshipsFor("g1", "u5")).length, 0);
    // Pairwise surfaces the contact frequency without consent re-check issues.
    const pc = await store.pairwiseContext("g1", "u3", "u4");
    assert.equal(pc.behavioralCount, 9);
  } finally { await sql.end(); }
});

test("inferred edges require at least one consented party", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    // Neither side consented → no inferred edge despite heavy contact.
    await store.recomputeEdges("g1", [{ aId: "u1", bId: "u2", count: 20 }]);
    assert.equal((await store.relationshipsFor("g1", "u1")).length, 0);
    await store.setMemberOptIn("g1", "u1", true);
    await store.recomputeEdges("g1", [{ aId: "u1", bId: "u2", count: 20 }]);
    // Symmetric inferred rows — u1 sees the pair from both directions.
    assert.equal((await store.relationshipsFor("g1", "u1")).length, 2);
  } finally { await sql.end(); }
});

test("recordWindowObservation feeds edges without a verification pass", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    await store.setMemberOptIn("g1", "u1", true);
    // Confident window read → literal verdict, symmetric rows, feeds edges.
    await store.recordWindowObservation("g1", "u1", "u2", "mw1", "collaborates", 0.6, "ship code together every week", true);
    await store.recomputeEdges("g1");
    // Symmetric rows → u1 sees the pair from both directions.
    const edges = await store.relationshipsFor("g1", "u1");
    assert.equal(edges.length, 2);
    assert.equal(edges.find(e => e.subjectId === "u1")?.summary, "collaborates");
    assert.equal(edges.find(e => e.subjectId === "u2")?.otherId, "u1");
    // System-asserted: author_id NULL → partyCount 0 (honest "all secondhand").
    assert.equal(edges[0].partyCount, 0);
    const obs = await store.relationshipObservationsFor("g1", "u1");
    assert.equal(obs[0].source, "pair_window");

    // Unconfident run → unclear marker: no edge feed, but the throttle timestamp lands.
    await store.recordWindowObservation("g1", "u3", "u4", "mw2", "", 0, "too thin to judge", false);
    assert.ok(await store.lastPairWindowAt("g1", "u3", "u4"));
    await store.recomputeEdges("g1");
    assert.equal((await store.relationshipsFor("g1", "u3")).length, 0);
  } finally { await sql.end(); }
});

test("pairExchanges returns only messages where one party addressed the other", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const aliases = new Map([["bob", "u2"], ["alice", "u1"]]);
    await store.recordMessage(msg("hey <@u2> check this", { authorId: "u1", authorName: "Alice", messageId: "e1" }));
    await store.recordMessage(msg("bob you around?", { authorId: "u1", authorName: "Alice", messageId: "e2" }));
    await store.recordMessage(msg("alice nice one", { authorId: "u2", authorName: "Bob", messageId: "e3" }));
    await store.recordMessage(msg("talking about nothing", { authorId: "u1", authorName: "Alice", messageId: "e4" }));
    await store.recordMessage(msg("hi <@u1>", { authorId: "u3", authorName: "Carol", messageId: "e5" }));

    const ex = await store.pairExchanges("g1", "u1", "u2", aliases);
    assert.deepEqual(ex.map(e => e.id), ["e1", "e2", "e3"]); // oldest-first
    assert.equal(ex[0].authorName, "Alice");
    // e4 doesn't address u2; e5 isn't authored by a party.
    assert.ok(!ex.some(e => e.id === "e4" || e.id === "e5"));
  } finally { await sql.end(); }
});

test("relationshipNatureVocab returns the guild's established labels", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    await store.recordRelationship("g1", "u1", "u2", "m1", "u1", "close friends", 0.8, "a");
    await store.recordRelationship("g1", "u1", "u3", "m2", "u1", "close friends", 0.7, "b");
    await store.recordRelationship("g1", "u1", "u4", "m3", "u1", "rivals", -0.5, "c");
    await sql`UPDATE relationship_observations SET verdict = 'literal' WHERE guild_id = 'g1' AND message_id IN ('m1','m2')`;
    const vocab = await store.relationshipNatureVocab("g1");
    // Only literal observations feed the vocabulary — "rivals" stays unverified.
    assert.deepEqual(vocab, ["close friends"]);
  } finally { await sql.end(); }
});
