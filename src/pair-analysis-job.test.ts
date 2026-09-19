import "dotenv/config";
import assert from "node:assert/strict";
import test from "node:test";
import { makeTestSql, makeStore } from "./test-helpers.js";
import { runPairAnalysisJob, type PairAnalysisDeps } from "./pair-analysis-job.js";
import type { Brain } from "./brain.js";
import type { MessageEvent } from "./types.js";

function msg(content: string, overrides: Partial<MessageEvent> = {}): MessageEvent {
  return {
    guildId: "g1", channelId: "c1", messageId: `m-${Math.random().toString(36).slice(2)}`,
    authorId: "u1", authorName: "Alice",
    content, createdAt: new Date(), mentionsBot: false,
    ...overrides,
  };
}

function deps(store: any, analysis: { confident: boolean; nature: string; valence: number; reason: string }, brain: Brain | null = null): PairAnalysisDeps {
  const stub = brain ?? ({
    analyzePairWindow: async () => analysis,
  } as unknown as Brain);
  return {
    store,
    brainFor: async () => stub,
    getAliases: async () => new Map([["bob", "u2"], ["alice", "u1"]]),
    botId: "bot1",
    analysisModel: "test-model",
  };
}

async function seedExchanges(store: any, n = 6) {
  for (let i = 0; i < n; i++) {
    const from = i % 2 === 0 ? { authorId: "u1", authorName: "Alice", to: "<@u2>" } : { authorId: "u2", authorName: "Bob", to: "<@u1>" };
    await store.recordMessage(msg(`${from.to} ping ${i}`, { authorId: from.authorId, authorName: from.authorName, messageId: `ex${i}` }));
  }
}

test("confident analysis writes a symmetric literal observation pair", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    await store.setMemberOptIn("g1", "u1", true);
    await store.setMemberOptIn("g1", "u2", true);
    await seedExchanges(store);

    await runPairAnalysisJob("g1", { aId: "u1", bId: "u2" },
      deps(store, { confident: true, nature: "collaborates", valence: 0.7, reason: "builds together" }));

    const obs = await sql<Array<{ subject_id: string; other_id: string; verdict: string; source: string; author_id: string | null }>>`
      SELECT subject_id, other_id, verdict, source, author_id FROM relationship_observations WHERE guild_id = 'g1' ORDER BY subject_id`;
    assert.equal(obs.length, 2); // both directions
    assert.ok(obs.every(o => o.verdict === "literal" && o.source === "pair_window" && o.author_id === null));
    // Feeds edges on the next recompute — no separate verification pass needed.
    await store.recomputeEdges("g1");
    const edges = await store.relationshipsFor("g1", "u1");
    assert.equal(edges.length, 2); // symmetric window rows → both directions
    assert.equal(edges.find(e => e.subjectId === "u1")?.summary, "collaborates");
  } finally { await sql.end(); }
});

test("unconfident analysis writes only an unclear marker — no edge feed", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    await store.setMemberOptIn("g1", "u1", true);
    await store.setMemberOptIn("g1", "u2", true);
    await seedExchanges(store);

    await runPairAnalysisJob("g1", { aId: "u1", bId: "u2" },
      deps(store, { confident: false, nature: "", valence: 0, reason: "too thin" }));

    const obs = await sql<Array<{ verdict: string }>>`SELECT verdict FROM relationship_observations WHERE guild_id = 'g1'`;
    assert.ok(obs.every(o => o.verdict === "unclear"));
    // The marker still advances lastPairWindowAt — the pair won't re-analyze for 7d.
    assert.ok(await store.lastPairWindowAt("g1", "u1", "u2"));
    await store.recomputeEdges("g1");
    assert.equal((await store.relationshipsFor("g1", "u1")).length, 0);
  } finally { await sql.end(); }
});

test("both-party consent is required — one non-consenting side drops the job", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    await store.setMemberOptIn("g1", "u1", true);
    // u2 never consented — the either-party write rule is NOT enough here:
    // the job reads both people's exchanges.
    await seedExchanges(store);

    await runPairAnalysisJob("g1", { aId: "u1", bId: "u2" },
      deps(store, { confident: true, nature: "friends", valence: 0.5, reason: "x" }));

    const obs = await sql`SELECT 1 FROM relationship_observations WHERE guild_id = 'g1'`;
    assert.equal(obs.length, 0);
  } finally { await sql.end(); }
});

test("thin window and dormant guild both drop without writing", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    await store.setMemberOptIn("g1", "u1", true);
    await store.setMemberOptIn("g1", "u2", true);
    // No exchanges seeded → under the 5-message floor.
    await runPairAnalysisJob("g1", { aId: "u1", bId: "u2" },
      deps(store, { confident: true, nature: "friends", valence: 0.5, reason: "x" }));
    // Dormant (brainFor null) → dropped too.
    await seedExchanges(store);
    await runPairAnalysisJob("g1", { aId: "u1", bId: "u2" },
      { ...deps(store, { confident: true, nature: "friends", valence: 0.5, reason: "x" }), brainFor: async () => null });

    const obs = await sql`SELECT 1 FROM relationship_observations WHERE guild_id = 'g1'`;
    assert.equal(obs.length, 0);
  } finally { await sql.end(); }
});

test("malformed payload drops without touching the store", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    await runPairAnalysisJob("g1", { aId: "u1" }, deps(store, { confident: true, nature: "x", valence: 0, reason: "x" }));
    await runPairAnalysisJob("g1", { aId: "u1", bId: "u1" }, deps(store, { confident: true, nature: "x", valence: 0, reason: "x" }));
    const obs = await sql`SELECT 1 FROM relationship_observations WHERE guild_id = 'g1'`;
    assert.equal(obs.length, 0);
  } finally { await sql.end(); }
});
