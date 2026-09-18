import "dotenv/config";
import assert from "node:assert/strict";
import test from "node:test";
import { makeTestSql, makeStore } from "./test-helpers.js";
import { buildAliasMap, resolveSubject } from "./entity-resolution.js";
import { contestCue, detectSelfNaming } from "./perception.js";
import { runContestCheck } from "./contest.js";
import { ProfileStore } from "./profiles.js";
import { applyProposals, listAttributes } from "./attributes.js";
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

test("re-archiving the same message does not double-count message_count", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const ev = msg("hello", { messageId: "m-dup", authorId: "u1" });
    await store.recordMessage(ev);
    await store.recordMessage(ev); // re-ingest hits the PK conflict
    const member = await store.getMember("g1", "u1");
    assert.equal(member?.messageCount, 1);
    // The reply edge still backfills on the repeat archive.
    await store.recordMessage(ev, "m-orig");
    const rows = await sql<Array<{ reply_to_id: string | null }>>`SELECT reply_to_id FROM messages WHERE id = 'm-dup'`;
    assert.equal(rows[0].reply_to_id, "m-orig");
    assert.equal((await store.getMember("g1", "u1"))?.messageCount, 1);
  } finally { await sql.end(); }
});

test("recordMessage trackMember=false archives the row without a member entry", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    await store.recordMessage(msg("skyrim rant", { authorId: "bot-1", authorName: "paarthbot" }), undefined, false);
    assert.equal(await store.getMember("g1", "bot-1"), undefined);
    // ...but the transcript carries it — references resolve, context shows it.
    const ctx = await store.recentContext("g1", "c1");
    assert.equal(ctx.some(x => x.authorId === "bot-1" && x.content === "skyrim rant"), true);
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

test("recordRelationship is idempotent per message; edges roll up only after literal verdicts", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    // Same (subject, other, message) twice → one observation
    assert.equal(await store.recordRelationship("g1", "u1", "u2", "m1", "close friends", 0.8), true);
    assert.equal(await store.recordRelationship("g1", "u1", "u2", "m1", "close friends", 0.8), false);
    await store.recordRelationship("g1", "u1", "u2", "m2", "close friends", 0.4);
    // Unverified observations never surface as an edge
    assert.deepEqual(await store.relationshipsFor("g1", "u1"), []);
    // Literal verdicts + recompute → edge with stats over literal observations
    await sql`UPDATE relationship_observations SET verdict = 'literal' WHERE guild_id = 'g1'`;
    await store.recomputeEdges("g1");
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

function stubBrain(
  calls: { profile: number; section: number; sections: Record<string, number>; extract: number },
  sectionResult?: Record<string, unknown>,
  extractResult?: Array<{ field: string; value: string; memoryIds: number[]; replaces?: string }>,
): Brain {
  return {
    synthesizeProfile: async (): Promise<ProfileSynthesis> => {
      calls.profile++;
      return { bio: "Alice is a regular member who keeps the conversation moving.", roleInServer: "regular" };
    },
    extractAttributes: async () => {
      calls.extract++;
      return extractResult ?? [];
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

    const calls = { profile: 0, section: 0, sections: {} as Record<string, number>, extract: 0 };
    const brain = stubBrain(calls);
    const first = await profileStore.buildProfiles("g1", brain, store, eventStore);
    assert.equal(first.built, 1);
    assert.equal(calls.profile, 1);

    const profile = await profileStore.getProfile("g1", "u1");
    assert.ok(profile);
    assert.equal(profile.summary, "Alice is a regular member who keeps the conversation moving.");
    assert.deepEqual(profile.facets.traits, []); // no attributes yet — facets render from the structured set

    // Second run: identical inputs → source_hash match → no LLM call
    const second = await profileStore.buildProfiles("g1", brain, store, eventStore);
    assert.equal(second.built, 0);
    assert.equal(second.unchanged, 1);
    assert.equal(calls.profile, 1);

    // Chatter alone is not a semantic change — nothing re-renders.
    await store.recordMessage(msg("new activity", { authorId: "u1", authorName: "Alice" }));
    const churn = await profileStore.buildProfiles("g1", brain, store, eventStore);
    assert.equal(churn.built, 0);
    assert.equal(calls.profile, 1);

    // A new memory that yields an attribute changes the render inputs → rebuild.
    await activeFact(store, "Lives in Leeds");
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

    const brain = stubBrain({ profile: 0, section: 0, sections: {}, extract: 0 });
    await profileStore.buildProfiles("g1", brain, store, eventStore);
    assert.ok(await profileStore.getProfile("g1", "u1"));

    await store.setMemberOptOut("g1", "u1", true);
    const result = await profileStore.buildProfiles("g1", brain, store, eventStore);
    assert.equal(result.built, 0);
    assert.equal(await profileStore.getProfile("g1", "u1"), undefined);
  } finally { await sql.end(); }
});

test("setMemberOptOut upserts a row for never-posted members, forgetAllFor clears their memories", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    // No member row exists yet — opt-out must still stick.
    await store.setMemberOptOut("g1", "u-lurker", true);
    assert.equal((await store.getMember("g1", "u-lurker"))?.optedOut, true);

    const m1 = await store.saveMemory(msg("x"), { subjectId: "u1", kind: "person_fact", content: "Fact one", reason: "t", evidenceType: "explicit_fact", effect: "support" });
    const m2 = await store.saveMemory(msg("y"), { subjectId: "u1", kind: "person_fact", content: "Fact two", reason: "t", evidenceType: "explicit_fact", effect: "support" });
    const other = await store.saveMemory(msg("z"), { subjectId: "u2", kind: "person_fact", content: "Other user's fact", reason: "t", evidenceType: "explicit_fact", effect: "support" });
    assert.equal(await store.forgetAllFor("g1", "u1"), 2);
    assert.equal((await store.getMemory("g1", m1.id))!.status, "forgotten");
    assert.equal((await store.getMemory("g1", m2.id))!.status, "forgotten");
    assert.equal((await store.getMemory("g1", other.id))!.status, "candidate"); // untouched

    // Opt-in flips the flag back; forgotten memories stay forgotten.
    await store.setMemberOptOut("g1", "u-lurker", false);
    assert.equal((await store.getMember("g1", "u-lurker"))?.optedOut, false);
    assert.equal((await store.getMemory("g1", m1.id))!.status, "forgotten");
  } finally { await sql.end(); }
});

test("forgetRelationshipsFor deletes observations and edges on both sides of the subject", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    // Both directions need coverage: u1 as subject in one edge, as other in another.
    await store.recordRelationship("g1", "u1", "u2", "m1", "close friends", 0.8, "t");
    await store.recordRelationship("g1", "u3", "u1", "m2", "rivals", -0.5, "t");
    await store.recordRelationship("g1", "u2", "u3", "m3", "siblings", 0.9, "t"); // control — u1 not involved
    await sql`UPDATE relationship_observations SET verdict = 'literal' WHERE guild_id = 'g1'`;
    await store.recomputeEdges("g1");

    assert.equal(await store.forgetRelationshipsFor("g1", "u1"), 2);
    assert.deepEqual(await store.relationshipsFor("g1", "u1"), []);
    // Control edge untouched; recomputeEdges has nothing to rebuild u1's data from.
    const remaining = await store.relationshipsFor("g1", "u2");
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].otherId, "u3");
    await store.recomputeEdges("g1");
    assert.deepEqual(await store.relationshipsFor("g1", "u1"), []);
  } finally { await sql.end(); }
});

test("relevantMemories surfaces promotable-type candidates but keeps weak evidence gated", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const active = await store.saveMemory(msg("x"), { subjectId: "u1", kind: "person_fact", content: "Lives in Leeds", reason: "t", evidenceType: "explicit_fact", effect: "support" });
    await store.confirm("g1", active.id);
    await store.saveMemory(msg("y"), { subjectId: "u1", kind: "person_preference", content: "Wants to be called Alby", reason: "t", evidenceType: "clear_preference", effect: "support" });
    await store.saveMemory(msg("z"), { subjectId: "u1", kind: "person_fact", content: "Is a great guy lol", reason: "t", evidenceType: "sarcasm_or_joke", effect: "support" });

    const contents = (await store.relevantMemories("g1", "u1")).map(m => m.content);
    assert.ok(contents.includes("Lives in Leeds"));
    assert.ok(contents.includes("Wants to be called Alby")); // fresh preference reaches replies pre-verification
    assert.ok(!contents.includes("Is a great guy lol"));      // sarcasm stays gated
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

    const calls = { profile: 0, section: 0, sections: {} as Record<string, number>, extract: 0 };
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
      { profile: 0, section: 0, sections: {}, extract: 0 },
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
    await sql`UPDATE relationship_observations SET verdict = 'literal' WHERE guild_id = 'g1'`;
    await store.recomputeEdges("g1");
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
    // Only literal-verdicted observations are surfaced
    assert.equal((await store.relationshipObservationsFor("g1", "u1")).length, 0);
    await sql`UPDATE relationship_observations SET verdict = 'literal' WHERE guild_id = 'g1'`;
    const obs = await store.relationshipObservationsFor("g1", "u1");
    assert.equal(obs.length, 2);
    const byDir = Object.fromEntries(obs.map(o => [o.direction, o]));
    assert.equal(byDir.member_subject.nature, "antagonizes");
    assert.equal(byDir.member_other.nature, "defends");
    assert.equal(byDir.member_other.otherId, "u2");
  } finally { await sql.end(); }
});

test("recomputeEdges builds edges only from literal-verdicted observations", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    await store.recordRelationship("g1", "u1", "u2", "m1", "dating", 0.9, "joke ship");
    await store.recordRelationship("g1", "u1", "u2", "m2", "close friends", 0.8, "real signal");
    await store.recordRelationship("g1", "u1", "u2", "m3", "flirts", 0.5, "ambiguous bit");
    // Nothing is visible while all observations are unverified
    await store.recomputeEdges("g1");
    assert.equal((await store.relationshipsFor("g1", "u1")).length, 0);

    // joke + literal + unclear → edge aggregates the literal observation alone
    const obs = await sql<Array<{ id: number; message_id: string }>>`SELECT id, message_id FROM relationship_observations WHERE guild_id = 'g1'`;
    const idOf = (mid: string) => obs.find(o => o.message_id === mid)!.id;
    await store.setObservationVerdict(idOf("m1"), "joke");
    await store.setObservationVerdict(idOf("m2"), "literal");
    await store.setObservationVerdict(idOf("m3"), "unclear");
    const edgeCount = await store.recomputeEdges("g1");
    assert.equal(edgeCount, 1);
    const edge = (await store.relationshipsFor("g1", "u1"))[0];
    assert.equal(edge.observationCount, 1);
    assert.equal(edge.summary, "close friends");
    assert.equal(edge.valence, 0.8);

    // Joking the remaining literal observation empties the edge entirely
    await store.setObservationVerdict(idOf("m2"), "joke");
    await store.recomputeEdges("g1");
    assert.equal((await store.relationshipsFor("g1", "u1")).length, 0);
  } finally { await sql.end(); }
});

// ── Structured attributes ─────────────────────────────────────────────────────

async function activeFact(store: Awaited<ReturnType<typeof makeStore>>["store"], content: string, subjectId = "u1", kind: "person_fact" | "person_preference" | "server_lore" | "episode" = "person_fact") {
  const m = await store.saveMemory(msg("x"), { subjectId, kind, content, reason: "t", evidenceType: "explicit_fact", effect: "support" });
  await store.confirm("g1", m.id);
  return m;
}

test("deterministic extraction inside buildProfiles produces a location attribute", async () => {
  const sql = makeTestSql();
  try {
    const { store, eventStore } = await makeStore(sql);
    const profileStore = new ProfileStore(sql as any);
    for (let i = 0; i < 5; i++) await store.recordMessage(msg(`msg ${i}`, { authorId: "u1", authorName: "Alice" }));
    const m = await activeFact(store, "Lives in Leeds");

    const brain = stubBrain({ profile: 0, section: 0, sections: {}, extract: 0 });
    await profileStore.buildProfiles("g1", brain, store, eventStore);

    const attrs = await listAttributes(sql, "g1", "u1");
    const loc = attrs.find(a => a.field === "location");
    assert.equal(loc?.value, "Leeds");
    assert.equal(loc?.status, "active");
    assert.deepEqual(loc?.memoryIds, [m.id]);
    // The facet renders into the profile card too.
    const profile = await profileStore.getProfile("g1", "u1");
    assert.ok(profile);
  } finally { await sql.end(); }
});

test("unchanged inputs produce zero attribute writes — the real continuity test", async () => {
  const sql = makeTestSql();
  try {
    const { store, eventStore } = await makeStore(sql);
    const profileStore = new ProfileStore(sql as any);
    for (let i = 0; i < 5; i++) await store.recordMessage(msg(`msg ${i}`, { authorId: "u1", authorName: "Alice" }));
    await activeFact(store, "Lives in Leeds");
    await activeFact(store, "Loves horror films", "u1", "person_preference");

    const calls = { profile: 0, section: 0, sections: {} as Record<string, number>, extract: 0 };
    const brain = stubBrain(calls);
    await profileStore.buildProfiles("g1", brain, store, eventStore);
    const before = await sql`SELECT * FROM profile_attributes WHERE guild_id = 'g1' ORDER BY id`;
    assert.ok(before.length >= 2);

    // Second run on identical inputs: same rows, byte-for-byte on the columns
    // that carry meaning (status, provenance, confidence).
    await profileStore.buildProfiles("g1", brain, store, eventStore);
    const after = await sql`SELECT * FROM profile_attributes WHERE guild_id = 'g1' ORDER BY id`;
    assert.deepEqual(
      after.map(r => ({ id: r.id, status: r.status, memory_ids: r.memory_ids, confidence: r.confidence })),
      before.map(r => ({ id: r.id, status: r.status, memory_ids: r.memory_ids, confidence: r.confidence })),
    );
    // And the render didn't fire again either.
    assert.equal(calls.profile, 1);
    assert.equal(calls.extract, 1);
  } finally { await sql.end(); }
});

test("a paraphrased value folds into the existing row instead of creating a sibling", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    // Distinct contents — saveMemory's trigram dedup would fold near-identical
    // strings into one row, and the point here is two separate citations.
    const m1 = await activeFact(store, "Likes horror films", "u1", "person_preference");
    const m2 = await activeFact(store, "Goes fishing most weekends", "u1", "person_fact");
    await applyProposals(sql, "g1", "u1", [{ field: "interest", value: "likes horror films", memoryIds: [m1.id] }]);
    await applyProposals(sql, "g1", "u1", [{ field: "interest", value: "loves horror films", memoryIds: [m2.id] }]);
    const attrs = (await listAttributes(sql, "g1", "u1")).filter(a => a.field === "interest");
    assert.equal(attrs.length, 1);
    assert.deepEqual(attrs[0].memoryIds.slice().sort(), [m1.id, m2.id].sort());
  } finally { await sql.end(); }
});

test("opposite-polarity values never fold — likes vs dislikes stay two rows", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const m1 = await activeFact(store, "Likes horror films", "u1", "person_preference");
    const m2 = await activeFact(store, "Dislikes horror films", "u1", "person_preference");
    await applyProposals(sql, "g1", "u1", [{ field: "interest", value: "likes horror films", memoryIds: [m1.id] }]);
    await applyProposals(sql, "g1", "u1", [{ field: "interest", value: "dislikes horror films", memoryIds: [m2.id] }]);
    const attrs = (await listAttributes(sql, "g1", "u1")).filter(a => a.field === "interest");
    assert.equal(attrs.length, 2);
  } finally { await sql.end(); }
});

test("uncited and candidate-only LLM proposals are dropped, not stored", async () => {
  const sql = makeTestSql();
  try {
    const { store, eventStore } = await makeStore(sql);
    const profileStore = new ProfileStore(sql as any);
    for (let i = 0; i < 5; i++) await store.recordMessage(msg(`msg ${i}`, { authorId: "u1", authorName: "Alice" }));
    const real = await activeFact(store, "Likes fishing");
    // A candidate-only memory — never confirmed.
    const candidate = await store.saveMemory(msg("y"), { subjectId: "u1", kind: "person_fact", content: "Is secretly a dragon", reason: "t", evidenceType: "uncertain_inference", effect: "context" });

    const brain = stubBrain(
      { profile: 0, section: 0, sections: {}, extract: 0 },
      undefined,
      [
        { field: "trait", value: "uncited invention", memoryIds: [999999] },       // id not in input → dropped
        { field: "trait", value: "candidate-only", memoryIds: [candidate.id] },     // no active citation → dropped
        { field: "trait", value: "competitive", memoryIds: [real.id, 999999] },     // valid cite survives filtering
      ],
    );
    await profileStore.buildProfiles("g1", brain, store, eventStore);
    const attrs = await listAttributes(sql, "g1", "u1");
    const traits = attrs.filter(a => a.field === "trait");
    assert.equal(traits.length, 1);
    assert.equal(traits[0].value, "competitive");
    assert.deepEqual(traits[0].memoryIds, [real.id]);
  } finally { await sql.end(); }
});

test("singular field: a new timezone supersedes the prior one; interest accumulates", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const m1 = await activeFact(store, "timezone is GMT");
    const m2 = await activeFact(store, "currently on eastern time");
    const m3 = await activeFact(store, "Likes chess", "u1", "person_preference");
    const m4 = await activeFact(store, "Likes go", "u1", "person_preference");
    await applyProposals(sql, "g1", "u1", [{ field: "timezone", value: "GMT", memoryIds: [m1.id] }]);
    await applyProposals(sql, "g1", "u1", [{ field: "timezone", value: "EST", memoryIds: [m2.id] }]);
    await applyProposals(sql, "g1", "u1", [{ field: "interest", value: "chess", memoryIds: [m3.id] }]);
    await applyProposals(sql, "g1", "u1", [{ field: "interest", value: "go", memoryIds: [m4.id] }]);

    const attrs = await listAttributes(sql, "g1", "u1");
    const gmt = attrs.find(a => a.value === "GMT")!;
    const est = attrs.find(a => a.value === "EST")!;
    assert.equal(gmt.status, "superseded");
    assert.equal(gmt.supersededBy, est.id);
    assert.equal(est.status, "active");
    // Multi-valued fields accumulate side by side.
    assert.equal(attrs.filter(a => a.field === "interest").length, 2);
  } finally { await sql.end(); }
});

test("forget on a sole-cited memory flips the attribute to forgotten in the same call", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const m = await activeFact(store, "Lives in Leeds");
    await applyProposals(sql, "g1", "u1", [{ field: "location", value: "Leeds", memoryIds: [m.id] }]);
    await store.forget("g1", m.id);
    const attrs = await listAttributes(sql, "g1", "u1");
    assert.equal(attrs.length, 1);
    assert.equal(attrs[0].status, "forgotten");
    assert.deepEqual(attrs[0].memoryIds, []);
  } finally { await sql.end(); }
});

test("support on an active memory raises the citing attribute's confidence in the same call", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const m = await activeFact(store, "Lives in Leeds");
    await applyProposals(sql, "g1", "u1", [{ field: "location", value: "Leeds", memoryIds: [m.id] }]);
    const before = (await listAttributes(sql, "g1", "u1"))[0].confidence;

    // New support evidence: status stays active but confidence rises. The
    // attribute's derived confidence must follow without a status transition.
    const reinforced = await store.saveMemory(msg("I still live in Leeds"), {
      subjectId: "u1", kind: "person_fact", content: "Lives in Leeds",
      reason: "repeated", evidenceType: "explicit_fact", effect: "support",
    });
    assert.equal(reinforced!.status, "active");
    assert.ok(reinforced!.confidence > m.confidence);

    const after = (await listAttributes(sql, "g1", "u1"))[0];
    assert.equal(after.status, "active");
    assert.ok(after.confidence > before, `attribute confidence ${after.confidence} should exceed ${before}`);
  } finally { await sql.end(); }
});

test("supersede transfers provenance to the canonical memory and dedupes ids", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const m1 = await activeFact(store, "Has a cat");
    const m2 = await activeFact(store, "Her cat is called Jinx");
    // Attribute already cites BOTH memories — after transfer, m2 appears once.
    await applyProposals(sql, "g1", "u1", [{ field: "trait", value: "cat owner", memoryIds: [m1.id, m2.id] }]);
    await store.supersede("g1", m1.id, m2.id);
    const attrs = await listAttributes(sql, "g1", "u1");
    assert.deepEqual(attrs[0].memoryIds, [m2.id]);
    assert.equal(attrs[0].status, "active");
  } finally { await sql.end(); }
});

test("mergeDuplicate transfers attribute provenance like a supersede", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const m1 = await activeFact(store, "Has a cat");
    const m2 = await activeFact(store, "Adopted a second kitten yesterday");
    await applyProposals(sql, "g1", "u1", [{ field: "trait", value: "cat owner", memoryIds: [m1.id] }]);
    assert.equal(await store.mergeDuplicate("g1", m2.id, m1.id, "dup"), true);
    const attrs = await listAttributes(sql, "g1", "u1");
    assert.deepEqual(attrs[0].memoryIds, [m2.id]);
    assert.equal(attrs[0].status, "active");
  } finally { await sql.end(); }
});

test("mixed dead provenance never renders active; re-citation revives a superseded row", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const m1 = await activeFact(store, "timezone is GMT");
    const m2 = await activeFact(store, "currently on eastern time");
    const m3 = await activeFact(store, "moved back to GMT");
    await applyProposals(sql, "g1", "u1", [{ field: "timezone", value: "GMT", memoryIds: [m1.id] }]);
    await applyProposals(sql, "g1", "u1", [{ field: "timezone", value: "EST", memoryIds: [m2.id] }]);
    let attrs = await listAttributes(sql, "g1", "u1");
    assert.equal(attrs.find(a => a.value === "GMT")!.status, "superseded");

    // Forget the superseding evidence → EST's provenance dies, row forgets.
    await store.forget("g1", m2.id);
    attrs = await listAttributes(sql, "g1", "u1");
    assert.equal(attrs.find(a => a.value === "EST")!.status, "forgotten");

    // Re-citing GMT revives the superseded row — no UNIQUE violation.
    await applyProposals(sql, "g1", "u1", [{ field: "timezone", value: "GMT", memoryIds: [m3.id] }]);
    attrs = await listAttributes(sql, "g1", "u1");
    const gmt = attrs.find(a => a.value === "GMT")!;
    assert.equal(gmt.status, "active");
    assert.deepEqual(gmt.memoryIds.slice().sort(), [m1.id, m3.id].sort());
    assert.equal(attrs.filter(a => a.field === "timezone").length, 2); // revived + forgotten, no third row
  } finally { await sql.end(); }
});

test("opt-out deletes attribute rows alongside the profile", async () => {
  const sql = makeTestSql();
  try {
    const { store, eventStore } = await makeStore(sql);
    const profileStore = new ProfileStore(sql as any);
    for (let i = 0; i < 5; i++) await store.recordMessage(msg(`msg ${i}`, { authorId: "u1", authorName: "Alice" }));
    await activeFact(store, "Lives in Leeds");
    await profileStore.buildProfiles("g1", stubBrain({ profile: 0, section: 0, sections: {}, extract: 0 }), store, eventStore);
    assert.ok((await listAttributes(sql, "g1", "u1")).length > 0);

    await store.setMemberOptOut("g1", "u1", true);
    await profileStore.buildProfiles("g1", stubBrain({ profile: 0, section: 0, sections: {}, extract: 0 }), store, eventStore);
    assert.equal((await listAttributes(sql, "g1", "u1")).length, 0);
  } finally { await sql.end(); }
});

test("exportSubject includes derived attributes", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const m = await activeFact(store, "Lives in Leeds");
    await applyProposals(sql, "g1", "u1", [{ field: "location", value: "Leeds", memoryIds: [m.id] }]);
    const data = await store.exportSubject("g1", "u1");
    assert.ok(Array.isArray(data.memories) && data.memories.length > 0);
    assert.equal(data.attributes[0].field, "location");
    assert.equal(data.attributes[0].value, "Leeds");
  } finally { await sql.end(); }
});

test("LLM extraction is gated: fires on first build, quiet when unchanged", async () => {
  const sql = makeTestSql();
  try {
    const { store, eventStore } = await makeStore(sql);
    const profileStore = new ProfileStore(sql as any);
    for (let i = 0; i < 5; i++) await store.recordMessage(msg(`msg ${i}`, { authorId: "u1", authorName: "Alice" }));
    await activeFact(store, "Lives in Leeds");

    const calls = { profile: 0, section: 0, sections: {} as Record<string, number>, extract: 0 };
    const brain = stubBrain(calls);
    await profileStore.buildProfiles("g1", brain, store, eventStore);
    assert.equal(calls.extract, 1); // neverExtracted gate fires once

    await profileStore.buildProfiles("g1", brain, store, eventStore);
    assert.equal(calls.extract, 1); // unchanged → no re-extraction

    await activeFact(store, "Works as a nurse");
    await profileStore.buildProfiles("g1", brain, store, eventStore);
    assert.equal(calls.extract, 2); // changed fingerprint → extraction fires again
  } finally { await sql.end(); }
});

test("attributesForSubjects batches by subject and honors the status filter", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const m1 = await activeFact(store, "Lives in Leeds", "u1");
    const m2 = await activeFact(store, "Plays competitive Tekken", "u1");
    const m3 = await activeFact(store, "Works night shifts", "u2");
    await applyProposals(sql, "g1", "u1", [{ field: "location", value: "Leeds", memoryIds: [m1.id] }]);
    await applyProposals(sql, "g1", "u1", [{ field: "skill", value: "Tekken", memoryIds: [m2.id] }]);
    await applyProposals(sql, "g1", "u2", [{ field: "occupation", value: "night shifts", memoryIds: [m3.id] }]);
    // A contested row must stay invisible under the active filter.
    await sql`UPDATE profile_attributes SET status = 'contested' WHERE field = 'skill'`;

    const active = await store.attributesForSubjects("g1", ["u1", "u2", "u-ghost"], { status: "active" });
    assert.deepEqual(active.get("u1")!.map(a => a.field), ["location"]);
    assert.deepEqual(active.get("u2")!.map(a => a.field), ["occupation"]);
    assert.equal(active.has("u-ghost"), false);

    const all = await store.attributesForSubjects("g1", ["u1"]);
    assert.deepEqual(all.get("u1")!.map(a => a.field).sort(), ["location", "skill"]);

    assert.equal((await store.attributesForSubjects("g1", [])).size, 0);
  } finally { await sql.end(); }
});
