import "dotenv/config";
import assert from "node:assert/strict";
import test from "node:test";
import { makeTestSql, makeStore } from "./test-helpers.js";
import { buildAliasMap, resolveSubject } from "./entity-resolution.js";
import { contestCue, detectSelfNaming } from "./perception.js";
import { runContestCheck } from "./contest.js";
import { ProfileStore } from "./profiles.js";
import type { Brain } from "./brain.js";
import type { MessageEvent, ProfileSynthesis } from "./types.js";

function msg(content: string, overrides: Partial<MessageEvent> = {}): MessageEvent {
  return {
    guildId: "g1", channelId: "c1", messageId: `m-${Math.random().toString(36).slice(2)}`,
    authorId: "u-author", authorName: "Alice",
    content, createdAt: new Date(), mentionsBot: false,
    ...overrides,
  };
}

// ── Member registry ───────────────────────────────────────────────────────────

test("recordMessage upserts members: names accumulate and message_count increments", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    await store.recordMessage(msg("one", { authorId: "u1", authorName: "Alice" }));
    await store.recordMessage(msg("two", { authorId: "u1", authorName: "Alice" }));
    await store.recordMessage(msg("three", { authorId: "u1", authorName: "Al" }));
    const member = await store.getMember("g1", "u1");
    assert.ok(member);
    assert.equal(member.messageCount, 3);
    assert.deepEqual(member.knownNames.sort(), ["Al", "Alice"]);
  } finally { await sql.end(); }
});

test("recordMessage persists reply_to_id", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    await store.recordMessage(msg("original", { messageId: "m-orig" }));
    await store.recordMessage(msg("reply", { messageId: "m-reply" }), "m-orig");
    const rows = await sql<Array<{ reply_to_id: string | null }>>`SELECT reply_to_id FROM messages WHERE id = 'm-reply'`;
    assert.equal(rows[0].reply_to_id, "m-orig");
  } finally { await sql.end(); }
});

// ── Alias map from the database ───────────────────────────────────────────────

test("buildAliasMap maps known_names to user IDs", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    await store.recordMessage(msg("hi", { authorId: "u1", authorName: "Starz" }));
    await store.recordMessage(msg("hi", { authorId: "u2", authorName: "Tom" }));
    const map = await buildAliasMap("g1", store);
    assert.equal(map.get("starz"), "u1");
    assert.equal(map.get("tom"), "u2");
    assert.equal(map.get("u1"), "u1");
  } finally { await sql.end(); }
});

test("buildAliasMap drops ambiguous names shared by multiple users", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    await store.recordMessage(msg("hi", { authorId: "u1", authorName: "Sam" }));
    await store.recordMessage(msg("hi", { authorId: "u2", authorName: "Sam" }));
    const map = await buildAliasMap("g1", store);
    assert.equal(map.get("sam"), undefined);
    assert.equal(resolveSubject({ subjectName: "Sam" }, map, msg("Sam did a thing")), "unknown");
  } finally { await sql.end(); }
});

// ── Relationships ─────────────────────────────────────────────────────────────

test("recordRelationship is idempotent per message and rolls up edges", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    // Same (subject, other, message) twice → one observation
    assert.equal(await store.recordRelationship("g1", "u1", "u2", "m1", "close friends", 0.8), true);
    assert.equal(await store.recordRelationship("g1", "u1", "u2", "m1", "close friends", 0.8), false);
    // Second message → count 2, running-average valence
    await store.recordRelationship("g1", "u1", "u2", "m2", "close friends", 0.4);
    const edges = await store.relationshipsFor("g1", "u1");
    assert.equal(edges.length, 1);
    assert.equal(edges[0].observationCount, 2);
    assert.ok(Math.abs(edges[0].valence! - 0.6) < 1e-9, `valence was ${edges[0].valence}`);
    // Visible from the other side too
    assert.equal((await store.relationshipsFor("g1", "u2")).length, 1);
    // Self/unknown/server pairs are rejected
    assert.equal(await store.recordRelationship("g1", "u1", "u1", "m3", "x", 0), false);
    assert.equal(await store.recordRelationship("g1", "u1", "unknown", "m4", "x", 0), false);
  } finally { await sql.end(); }
});

// ── Profile synthesis ─────────────────────────────────────────────────────────

function stubBrain(calls: { profile: number; section: number; sections: Record<string, number> }, sectionResult?: Record<string, unknown>): Brain {
  return {
    synthesizeProfile: async (): Promise<ProfileSynthesis> => {
      calls.profile++;
      return { bio: "A test bio.", traits: ["witty"], interests: ["cricket"], notableRelationships: [], roleInServer: "regular" };
    },
    synthesizeDossierSection: async (section: string): Promise<Record<string, unknown>> => {
      calls.section++;
      calls.sections[section] = (calls.sections[section] ?? 0) + 1;
      return sectionResult ?? { prose: "Test prose about this member.", items: [], quirks: [] };
    },
  } as unknown as Brain;
}

test("buildProfiles builds a card and skips the LLM call when inputs are unchanged", async () => {
  const sql = makeTestSql();
  try {
    const { store, eventStore } = await makeStore(sql);
    const profileStore = new ProfileStore(sql as any);
    for (let i = 0; i < 5; i++) await store.recordMessage(msg(`msg ${i}`, { authorId: "u1", authorName: "Alice" }));

    const calls = { profile: 0, section: 0, sections: {} as Record<string, number> };
    const brain = stubBrain(calls);
    const first = await profileStore.buildProfiles("g1", brain, store, eventStore);
    assert.equal(first.built, 1);
    assert.equal(calls.profile, 1);

    const profile = await profileStore.getProfile("g1", "u1");
    assert.ok(profile);
    assert.equal(profile.summary, "A test bio.");
    assert.deepEqual(profile.facets.traits, ["witty"]);

    // Second run: identical inputs → source_hash match → no LLM call
    const second = await profileStore.buildProfiles("g1", brain, store, eventStore);
    assert.equal(second.built, 0);
    assert.equal(second.unchanged, 1);
    assert.equal(calls.profile, 1);

    // New activity changes the fingerprint → rebuild
    await store.recordMessage(msg("new activity", { authorId: "u1", authorName: "Alice" }));
    const third = await profileStore.buildProfiles("g1", brain, store, eventStore);
    assert.equal(third.built, 1);
    assert.equal(calls.profile, 2);
  } finally { await sql.end(); }
});

test("buildProfiles skips opted-out members and deletes their existing profile", async () => {
  const sql = makeTestSql();
  try {
    const { store, eventStore } = await makeStore(sql);
    const profileStore = new ProfileStore(sql as any);
    for (let i = 0; i < 5; i++) await store.recordMessage(msg(`msg ${i}`, { authorId: "u1", authorName: "Alice" }));

    const brain = stubBrain({ profile: 0, section: 0, sections: {} });
    await profileStore.buildProfiles("g1", brain, store, eventStore);
    assert.ok(await profileStore.getProfile("g1", "u1"));

    await store.setMemberOptOut("g1", "u1", true);
    const result = await profileStore.buildProfiles("g1", brain, store, eventStore);
    assert.equal(result.built, 0);
    assert.equal(await profileStore.getProfile("g1", "u1"), undefined);
  } finally { await sql.end(); }
});

test("saveMemory persists the extracted subject name even when unresolved", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const event = msg("Starz is a Muslim");
    const saved = await store.saveMemory(event, {
      subjectId: "unknown", subjectName: "Starz", kind: "person_fact",
      content: "Starz is a Muslim", reason: "test", evidenceType: "reported_by_other", effect: "context",
    });
    assert.equal(saved.subjectId, "unknown");
    assert.equal(saved.subjectName, "Starz");
  } finally { await sql.end(); }
});

// ── Sincerity verification ────────────────────────────────────────────────────

test("applyVerification promotes literal self-reports, flags jokes, leaves third-party claims", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    // Self-report: subject == evidence author
    const self = await store.saveMemory(msg("I have a cat named Jinx"), {
      subjectId: "u-author", kind: "person_fact", content: "Has a cat named Jinx",
      reason: "test", evidenceType: "explicit_fact", effect: "support",
    });
    assert.equal(self.status, "candidate");
    assert.equal(await store.applyVerification(self.id, "literal", "sincere self-report"), "promoted");
    assert.equal((await store.getMemory("g1", self.id))!.status, "active");

    // Joke: flagged → confidence reset, evidence type flipped, stays candidate
    const joke = await store.saveMemory(msg("I love losing 8-0"), {
      subjectId: "u-author", kind: "person_preference", content: "Loves losing 8-0",
      reason: "test", evidenceType: "clear_preference", effect: "support",
    });
    assert.equal(await store.applyVerification(joke.id, "joke", "sarcasm"), "flagged");
    const flagged = await store.getMemory("g1", joke.id);
    assert.equal(flagged!.confidence, 0.10);
    assert.equal(flagged!.primaryEvidenceType, "sarcasm_or_joke");
    assert.equal(flagged!.status, "candidate");

    // Third-party literal: stays candidate (corroboration still required)
    const thirdParty = await store.saveMemory(msg("Starz is a Muslim"), {
      subjectId: "u-other", subjectName: "Starz", kind: "person_fact", content: "Starz is a Muslim",
      reason: "test", evidenceType: "explicit_fact", effect: "support",
    });
    assert.equal(await store.applyVerification(thirdParty.id, "literal", "reads literal"), "unchanged");
    assert.equal((await store.getMemory("g1", thirdParty.id))!.status, "candidate");

    // Misattributed: pasted/quoted text about someone else → forgotten outright
    const pasted = await store.saveMemory(msg("I am Sage, a dragon lover"), {
      subjectId: "u-author", kind: "person_fact", content: "Sage is a dragon lover",
      reason: "test", evidenceType: "explicit_fact", effect: "support",
    });
    assert.equal(await store.applyVerification(pasted.id, "misattributed", "pasted bio of another member"), "rejected");
    assert.equal((await store.getMemory("g1", pasted.id))!.status, "forgotten");
  } finally { await sql.end(); }
});

// ── Provenance guards ─────────────────────────────────────────────────────────

test("detectSelfNaming flags capitalized third-person names only", () => {
  // The motivating case: pasted "I am <other person>" bio text
  assert.equal(detectSelfNaming("I am Sage, a dragon lover, mother of the group", ["BIG MOMMA", "tinyriot11"]), "Sage");
  assert.equal(detectSelfNaming("I'm Paarthurnax and I love dragons", ["Alice"]), "Paarthurnax");
  // Genuine self-reports and lowercase predicates don't fire
  assert.equal(detectSelfNaming("i am depressed", ["Alice"]), undefined);
  assert.equal(detectSelfNaming("i am so cooked rn", ["Alice"]), undefined);
  // Capitalized stopwords don't fire
  assert.equal(detectSelfNaming("I am Not going", ["Alice"]), undefined);
  // Naming yourself is fine
  assert.equal(detectSelfNaming("I am Alice, deal with it", ["alice"]), undefined);
  assert.equal(detectSelfNaming("just a normal message", ["Alice"]), undefined);
});

test("contestCue catches denials and corrections, ignores chatter", () => {
  assert.ok(contestCue("I didn't mention low iron once"));
  assert.ok(contestCue("I think you have me confused for another person"));
  assert.ok(contestCue("Correction: I did say that"));
  assert.ok(contestCue("you're wrong, I never said that"));
  assert.ok(!contestCue("lol nice one"));
  assert.ok(!contestCue("what do you think about xzrtsll"));
});

// ── Contest detection ─────────────────────────────────────────────────────────

test("runContestCheck attaches contradict evidence and contests the memory", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const mem = await store.saveMemory(msg("my iron always be low"), {
      subjectId: "u-author", kind: "person_fact", content: "has low iron",
      reason: "test", evidenceType: "explicit_fact", effect: "support",
    });
    await store.confirm("g1", mem.id);

    const brain = {
      detectContest: async () => [{ memoryId: mem.id, relation: "contests" as const, reason: "subject denies it" }],
    } as unknown as Brain;
    const denial = msg("<@bot-1> I didn't mention low iron once", { mentionsBot: true });
    const r = await runContestCheck(denial, brain, store, "bot-1");
    assert.equal(r.contests, 1);
    const after = await store.getMemory("g1", mem.id);
    assert.equal(after!.status, "contested");
    assert.equal(after!.contradictionCount, 1);

    // Not addressed to the bot → no check runs
    const r2 = await runContestCheck(msg("I didn't mention low iron"), brain, store, "bot-1");
    assert.equal(r2.contests, 0);
  } finally { await sql.end(); }
});

test("a confirm relation on a contested memory resolves it back to active", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const mem = await store.saveMemory(msg("my iron always be low"), {
      subjectId: "u-author", kind: "person_fact", content: "has low iron",
      reason: "test", evidenceType: "explicit_fact", effect: "support",
    });
    await store.confirm("g1", mem.id); // active @ 0.9
    // Contest it
    await store.attachEvidence(mem.id, msg("I never said that"), "correction", "contradict", "denial");
    assert.equal((await store.getMemory("g1", mem.id))!.status, "contested");
    // Self-correction confirming the original claim → support evidence → resolveContested restores
    const brain = {
      detectContest: async () => [{ memoryId: mem.id, relation: "confirms" as const, reason: "admits they said it" }],
    } as unknown as Brain;
    const r = await runContestCheck(msg("<@bot-1> Correction: I did say it", { mentionsBot: true }), brain, store, "bot-1");
    assert.equal(r.confirms, 1);
    assert.equal((await store.getMemory("g1", mem.id))!.status, "active");
  } finally { await sql.end(); }
});

test("subject confirming their own contested memory adjudicates it even with negative net score", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const mem = await store.saveMemory(msg("my iron always be low"), {
      subjectId: "u-author", kind: "person_fact", content: "has low iron",
      reason: "test", evidenceType: "explicit_fact", effect: "support",
    });
    await store.confirm("g1", mem.id);
    // Two denials outweigh the original support — net_score stays negative
    await store.attachEvidence(mem.id, msg("wtf I never said that"), "correction", "contradict", "denial");
    await store.attachEvidence(mem.id, msg("you have me confused"), "correction", "contradict", "denial");
    const contested = await store.getMemory("g1", mem.id);
    assert.equal(contested!.status, "contested");
    const r0 = await store.resolveContested("g1", mem.id);
    assert.equal(r0.resolved, false);

    // But the subject's own confirmation is decisive
    const brain = {
      detectContest: async () => [{ memoryId: mem.id, relation: "confirms" as const, reason: "subject admits it" }],
    } as unknown as Brain;
    await runContestCheck(msg("<@bot-1> Correction: I did say it actually", { mentionsBot: true }), brain, store, "bot-1");
    const after = await store.getMemory("g1", mem.id);
    assert.equal(after!.status, "active");
    const hist = await store.history("g1", mem.id);
    assert.ok(hist.some(h => h.action === "subject_confirmed"));
  } finally { await sql.end(); }
});

// ── Dossier sections ──────────────────────────────────────────────────────────

test("buildProfiles builds the voice section and skips unchanged sections on re-run", async () => {
  const sql = makeTestSql();
  try {
    const { store, eventStore } = await makeStore(sql);
    const profileStore = new ProfileStore(sql as any);
    // ≥50 messages makes the member dossier-eligible and voice-buildable (≥20 msgs, ≥10 samples)
    for (let i = 0; i < 50; i++) await store.recordMessage(msg(`message number ${i} hello there`, { authorId: "u1", authorName: "Alice" }));

    const calls = { profile: 0, section: 0, sections: {} as Record<string, number> };
    const brain = stubBrain(calls);
    const first = await profileStore.buildProfiles("g1", brain, store, eventStore);
    assert.equal(first.built, 1);
    assert.equal(calls.profile, 1);
    assert.equal(calls.sections.voice, 1);

    const profile = await profileStore.getProfile("g1", "u1");
    const voice = profile!.facets.dossier?.sections.voice;
    assert.ok(voice);
    assert.equal((voice.data as { prose?: string }).prose, "Test prose about this member.");
    assert.equal((voice.data as { stats?: { sampleSize: number } }).stats!.sampleSize > 0, true);

    // Second run: nothing changed → no calls at all
    const second = await profileStore.buildProfiles("g1", brain, store, eventStore);
    assert.equal(second.built, 0);
    assert.equal(calls.profile, 1);
    assert.equal(calls.sections.voice, 1);
  } finally { await sql.end(); }
});

test("dossier items keep only citations to real input memory IDs", async () => {
  const sql = makeTestSql();
  try {
    const { store, eventStore } = await makeStore(sql);
    const profileStore = new ProfileStore(sql as any);
    await store.recordMessage(msg("hi", { authorId: "u1", authorName: "Alice" }));
    // 3 active person_fact memories → dossier eligible, life_situation buildable
    const ids: number[] = [];
    for (const c of ["Has a cat", "Lives in Texas", "Works nights"]) {
      const m = await store.saveMemory(msg("x"), {
        subjectId: "u1", kind: "person_fact", content: c, reason: "t", evidenceType: "explicit_fact", effect: "support",
      });
      await store.confirm("g1", m.id);
      ids.push(m.id);
    }

    const brain = stubBrain(
      { profile: 0, section: 0, sections: {} },
      { items: [{ text: "Lives in Texas", source_ids: [ids[1], 99999] }, { text: "Invented", source_ids: [424242] }] }
    );
    await profileStore.buildProfiles("g1", brain, store, eventStore);

    const profile = await profileStore.getProfile("g1", "u1");
    const life = profile!.facets.dossier?.sections.life_situation;
    assert.ok(life);
    const items = (life.data as { items: Array<{ text: string; source_ids: number[] }> }).items;
    assert.deepEqual(items[0].source_ids, [ids[1]]);
    assert.deepEqual(items[1].source_ids, []);
  } finally { await sql.end(); }
});

// ── Relationship edges ────────────────────────────────────────────────────────

test("mergedEdges collapses directed edges into one counterparty view", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    // A→B and B→A are stored as separate directed edges…
    await store.recordRelationship("g1", "u1", "u2", "m1", "close friends", 0.8, "said so");
    await store.recordRelationship("g1", "u2", "u1", "m2", "trusts them", 0.4, "returned it");
    const edges = await store.mergedEdges("g1", "u1");
    // …but surface as one merged edge with summed counts + weighted valence
    assert.equal(edges.length, 1);
    assert.equal(edges[0].otherId, "u2");
    assert.equal(edges[0].observationCount, 2);
    assert.ok(Math.abs(edges[0].valence! - 0.6) < 1e-9);
    assert.deepEqual(edges[0].natures.sort(), ["close friends", "trusts them"]);
  } finally { await sql.end(); }
});

test("interactionPairs counts mentions and name-refs once per message per pair", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const aliases = new Map([["bob", "u2"]]);
    await store.recordMessage(msg("hey <@u2> bob you around", { authorId: "u1", messageId: "m1" }));
    await store.recordMessage(msg("bob check this", { authorId: "u1", messageId: "m2" }));
    await store.recordMessage(msg("hi alice", { authorId: "u2", messageId: "m3" }));
    await store.recordMessage(msg("talking to myself <@u1>", { authorId: "u1", messageId: "m4" }));
    const pairs = await store.interactionPairs("g1", aliases);
    const u1u2 = pairs.find(p => (p.aId === "u1" && p.bId === "u2") || (p.aId === "u2" && p.bId === "u1"));
    // m1 (mention+name, deduped), m2 (name-ref) → 2; m3 "alice" isn't an alias → no
    assert.equal(u1u2?.count, 2);
    // self-mentions never form a pair
    assert.ok(!pairs.some(p => p.aId === p.bId));
  } finally { await sql.end(); }
});

test("relationshipObservationsFor returns both directions with labels", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    await store.recordRelationship("g1", "u1", "u2", "m1", "antagonizes", -0.5, "mocked them");
    await store.recordRelationship("g1", "u2", "u1", "m2", "defends", 0.7, "stood up for them");
    const obs = await store.relationshipObservationsFor("g1", "u1");
    assert.equal(obs.length, 2);
    const byDir = Object.fromEntries(obs.map(o => [o.direction, o]));
    assert.equal(byDir.member_subject.nature, "antagonizes");
    assert.equal(byDir.member_other.nature, "defends");
    assert.equal(byDir.member_other.otherId, "u2");
  } finally { await sql.end(); }
});

test("recomputeEdges excludes joke-verdict observations", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    await store.recordRelationship("g1", "u1", "u2", "m1", "dating", 0.9, "joke ship");
    await store.recordRelationship("g1", "u1", "u2", "m2", "close friends", 0.8, "real signal");
    assert.equal((await store.relationshipsFor("g1", "u1")).length, 1);

    // Mark the first observation a joke → recompute drops its contribution
    const [obs] = await sql<Array<{ id: number }>>`SELECT id FROM relationship_observations WHERE message_id = 'm1'`;
    await store.setObservationVerdict(obs.id, "joke");
    const edgeCount = await store.recomputeEdges("g1");
    assert.equal(edgeCount, 1);
    const edge = (await store.relationshipsFor("g1", "u1"))[0];
    assert.equal(edge.observationCount, 1);
    assert.equal(edge.summary, "close friends");
    assert.equal(edge.valence, 0.8);

    // Joking the remaining observation empties the edge entirely
    const [obs2] = await sql<Array<{ id: number }>>`SELECT id FROM relationship_observations WHERE message_id = 'm2'`;
    await store.setObservationVerdict(obs2.id, "joke");
    await store.recomputeEdges("g1");
    assert.equal((await store.relationshipsFor("g1", "u1")).length, 0);
  } finally { await sql.end(); }
});
