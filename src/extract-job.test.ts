import "dotenv/config";
import assert from "node:assert/strict";
import test from "node:test";
import { makeTestSql, makeStore } from "./test-helpers.js";
import { runExtractJob, type ExtractJobDeps, type ExtractJobPayload } from "./extract-job.js";
import { enqueue } from "./jobs.js";
import type { Brain } from "./brain.js";
import type { MessageEvent } from "./types.js";

// ── Extract-job regression ───────────────────────────────────────────────────
// The live path's contract: a durable message lands as triage='queued', the
// worker drains the job, and the row ends 'extracted' with derived data
// persisted under the same consent rules the old inline path used.

function payloadFor(event: Partial<MessageEvent> & { guildId: string; messageId: string }): ExtractJobPayload {
  return {
    event: {
      channelId: "c1", authorId: "u1", authorName: "Alice", content: "I love hiking",
      createdAt: new Date().toISOString(), mentionsBot: false, ...event,
    } as ExtractJobPayload["event"],
  };
}

function stubDeps(store: any, eventStore: any, brain: Partial<Brain> | null): ExtractJobDeps {
  return {
    store,
    brainFor: async () => brain as Brain | null,
    eventStore,
    pipeline: { process: async () => false } as any, // LLM-free stub — ordering is what matters
    botId: "bot-1",
    visionModel: undefined,
    contestModel: "m",
    imageMaxBytes: 1024,
    getAliases: async () => new Map([["alice", "u1"]]),
    invalidateLookups: () => {},
  };
}

test("queued message drains to 'extracted' with consented memories persisted", async () => {
  const sql = makeTestSql();
  try {
    const { store, eventStore } = await makeStore(sql);
    await store.settings("g1");
    await store.setPaused("g1", false);
    await store.setMemberOptIn("g1", "u1", true);
    const event = { guildId: "g1", channelId: "c1", messageId: "m-durable", authorId: "u1", authorName: "Alice", content: "I love hiking", createdAt: new Date(), mentionsBot: false };
    await store.recordMessage(event as MessageEvent, undefined, true);
    await store.setTriageResults([{ id: "m-durable", result: "queued" }]);

    const brain: Partial<Brain> = {
      extractMemories: async () => ({
        memories: [{ subjectId: "u1", subjectName: "Alice", kind: "person_preference", content: "loves hiking", reason: "stated", evidenceType: "explicit_fact", effect: "support" }],
        relationships: [],
      }),
    };
    await runExtractJob(payloadFor(event), stubDeps(store, eventStore, brain));

    const marks = await store.getTriageResults(["m-durable"]);
    assert.equal(marks.get("m-durable"), "extracted", "the job must write the terminal mark");
    // Fresh extractions land as candidates — nightly verification promotes.
    const mems = await store.listMemories("g1", "u1", { status: "candidate" });
    assert.equal(mems.memories.length, 1);
    assert.equal(mems.memories[0].content, "loves hiking");
  } finally { await sql.end(); }
});

test("non-consented subjects persist nothing; dormant guilds drop the job", async () => {
  const sql = makeTestSql();
  try {
    const { store, eventStore } = await makeStore(sql);
    await store.settings("g2");
    // u1 is NOT opted in — derived data must not persist even though the LLM proposed it.
    const event = { guildId: "g2", channelId: "c1", messageId: "m-nc", authorId: "u1", authorName: "Alice", content: "I love hiking", createdAt: new Date(), mentionsBot: false };
    await store.recordMessage(event as MessageEvent, undefined, true);

    const brain: Partial<Brain> = {
      extractMemories: async () => ({
        memories: [{ subjectId: "u1", subjectName: "Alice", kind: "person_fact", content: "loves hiking", reason: "r", evidenceType: "explicit_fact", effect: "support" }],
        relationships: [],
      }),
    };
    await runExtractJob(payloadFor(event), stubDeps(store, eventStore, brain));
    const mems = await store.listMemories("g2", "u1", {});
    assert.equal(mems.memories.length, 0, "non-consented member data must not persist");

    // Dormant guild (brainFor → null): the job drops without throwing and the
    // row keeps its 'queued' mark — bounded loss, matching the sweep's contract.
    await store.setTriageResults([{ id: "m-nc", result: "queued" }]);
    await runExtractJob(payloadFor(event), stubDeps(store, eventStore, null));
    const marks = await store.getTriageResults(["m-nc"]);
    assert.equal(marks.get("m-nc"), "queued");
  } finally { await sql.end(); }
});

test("a failing job leaves the row claimable; BudgetExceeded propagates for reschedule", async () => {
  const sql = makeTestSql();
  try {
    const { store, eventStore } = await makeStore(sql);
    const { BudgetExceeded } = await import("./budget.js");
    const event = { guildId: "g3", channelId: "c1", messageId: "m-cap", authorId: "u1", authorName: "Alice", content: "hi", createdAt: new Date(), mentionsBot: false };
    await store.recordMessage(event as MessageEvent, undefined, true);

    const capped: Partial<Brain> = {
      extractMemories: async () => { throw new BudgetExceeded("g3", 10); },
    };
    await assert.rejects(
      runExtractJob(payloadFor(event), stubDeps(store, eventStore, capped)),
      BudgetExceeded,
      "BudgetExceeded must reach the worker — it reschedules, not retries");
  } finally { await sql.end(); }
});

test("enqueue → claim → runExtractJob is the end-to-end drain path", async () => {
  const sql = makeTestSql();
  try {
    const { store, eventStore } = await makeStore(sql);
    await store.settings("g4");
    await store.setMemberOptIn("g4", "u1", true);
    const event = { guildId: "g4", channelId: "c1", messageId: "m-e2e", authorId: "u1", authorName: "Alice", content: "I love hiking", createdAt: new Date(), mentionsBot: false };
    await store.recordMessage(event as MessageEvent, undefined, true);

    const payload = payloadFor(event);
    const id = await enqueue(sql as any, "g4", "extract", payload);
    const { claimNext } = await import("./jobs.js");
    const job = (await claimNext(sql as any, new Set()))!;
    assert.equal(job.id, id);
    const brain: Partial<Brain> = { extractMemories: async () => ({ memories: [], relationships: [] }) };
    await runExtractJob(job.payload as ExtractJobPayload, stubDeps(store, eventStore, brain));
    await sql`DELETE FROM jobs WHERE id = ${job.id}`;
    const marks = await store.getTriageResults(["m-e2e"]);
    assert.equal(marks.get("m-e2e"), "extracted", "empty extraction still writes the terminal mark");
  } finally { await sql.end(); }
});
