import "dotenv/config";
import assert from "node:assert/strict";
import test from "node:test";
import { makeTestSql, makeStore } from "./test-helpers.js";
import { enqueue, claimNext, startWorker, MAX_JOB_ATTEMPTS, type Job } from "./jobs.js";
import { BudgetExceeded, meteredClient } from "./budget.js";
import type { LlmClient } from "./brain.js";

// ── Job queue + budget ───────────────────────────────────────────────────────

test("enqueue inserts a runnable job; claimNext honors run_after ordering", async () => {
  const sql = makeTestSql();
  try {
    await makeStore(sql);
    const later = new Date(Date.now() + 60 * 60_000);
    await enqueue(sql as any, "g1", "extract", { n: 1 }, later);
    await enqueue(sql as any, "g1", "extract", { n: 2 });

    // The future-dated job must not come first.
    const first = await claimNext(sql as any, new Set());
    assert.equal((first!.payload as any).n, 2);
    // Second claim finds nothing runnable (the other job is future-dated).
    assert.equal(await claimNext(sql as any, new Set()), null);
  } finally { await sql.end(); }
});

test("claimNext skips at-cap guilds and never double-claims", async () => {
  const sql = makeTestSql();
  try {
    await makeStore(sql);
    await enqueue(sql as any, "g-busy", "extract", { n: 1 });
    await enqueue(sql as any, "g-free", "extract", { n: 2 });

    // Excluding g-busy routes the claim to g-free.
    const claimed = await claimNext(sql as any, new Set(["g-busy"]));
    assert.equal(claimed!.guild_id, "g-free");

    // Two concurrent claims over one remaining job — SKIP LOCKED means the
    // loser sees the row as claimed and moves on.
    const [a, b] = await Promise.all([claimNext(sql as any, new Set()), claimNext(sql as any, new Set())]);
    const winners = [a, b].filter(Boolean);
    assert.equal(winners.length, 1, "exactly one claim may win a single pending job");
    assert.equal(winners[0]!.guild_id, "g-busy");
  } finally { await sql.end(); }
});

test("jobs at MAX_JOB_ATTEMPTS dead-letter — unclaimable but still inspectable", async () => {
  const sql = makeTestSql();
  try {
    await makeStore(sql);
    const id = await enqueue(sql as any, "g1", "extract", { n: 1 });
    await sql`UPDATE jobs SET attempts = ${MAX_JOB_ATTEMPTS} WHERE id = ${id}`;
    assert.equal(await claimNext(sql as any, new Set()), null, "dead-lettered job must not claim");
    const [row] = await sql`SELECT id FROM jobs WHERE id = ${id}`;
    assert.ok(row, "dead-lettered rows stay inspectable — nothing deletes them");
  } finally { await sql.end(); }
});

test("worker drains jobs, retries failures with backoff, and reschedules BudgetExceeded to UTC midnight without burning attempts", async () => {
  const sql = makeTestSql();
  try {
    await makeStore(sql);
    const handled: string[] = [];
    const worker = startWorker({
      sql: sql as any,
      pollMs: 20,
      handle: async (job: Job) => {
        handled.push(`${job.guild_id}:${(job.payload as any).n}`);
        if ((job.payload as any).n === "fail") throw new Error("boom");
        if ((job.payload as any).n === "capped") throw new BudgetExceeded(job.guild_id, 10);
      },
    });
    try {
      await enqueue(sql as any, "g1", "extract", { n: "ok" });
      await enqueue(sql as any, "g1", "extract", { n: "fail" });
      await enqueue(sql as any, "g1", "extract", { n: "capped" });
      await new Promise(r => setTimeout(r, 400));

      // ok deleted; fail rescheduled (attempts=1, run_after in the future);
      // capped rescheduled to midnight with attempts un-burned back to 0.
      const rows = await sql<Array<{ payload: { n: string }; attempts: number; run_after: Date }>>`SELECT payload, attempts, run_after FROM jobs ORDER BY id`;
      assert.equal(rows.length, 2, "the successful job should be gone");
      const failed = rows.find(r => r.payload.n === "fail")!;
      assert.equal(failed.attempts, 1);
      assert.ok(new Date(failed.run_after).getTime() > Date.now(), "failure must push run_after forward");
      const capped = rows.find(r => r.payload.n === "capped")!;
      assert.equal(capped.attempts, 0, "BudgetExceeded must not burn an attempt");
      const msToRun = new Date(capped.run_after).getTime() - Date.now();
      assert.ok(msToRun > 60 * 60_000 && msToRun <= 24 * 60 * 60_000, "capped job reschedules to next UTC midnight");
    } finally { await worker.stop(); }
  } finally { await sql.end(); }
});

test("worker enforces per-guild serial execution and parallelizes across guilds", async () => {
  const sql = makeTestSql();
  try {
    await makeStore(sql);
    let concurrentA = 0, maxConcurrentA = 0;
    const done: string[] = [];
    const worker = startWorker({
      sql: sql as any,
      pollMs: 20,
      maxPerGuild: 1,
      handle: async (job: Job) => {
        if (job.guild_id === "g-a") {
          concurrentA++;
          maxConcurrentA = Math.max(maxConcurrentA, concurrentA);
          await new Promise(r => setTimeout(r, 60));
          concurrentA--;
        }
        done.push(job.guild_id);
      },
    });
    try {
      // Three jobs for g-a and one for g-b — g-b must not queue behind g-a.
      await enqueue(sql as any, "g-a", "extract", { n: 1 });
      await enqueue(sql as any, "g-a", "extract", { n: 2 });
      await enqueue(sql as any, "g-a", "extract", { n: 3 });
      await enqueue(sql as any, "g-b", "extract", { n: 4 });
      await new Promise(r => setTimeout(r, 600));
      assert.equal(maxConcurrentA, 1, "extract jobs must run serially within a guild");
      assert.deepEqual(done.sort(), ["g-a", "g-a", "g-a", "g-b"]);
      const [{ c }] = await sql<Array<{ c: number }>>`SELECT count(*)::int AS c FROM jobs`;
      assert.equal(c, 0, "all jobs drained");
    } finally { await worker.stop(); }
  } finally { await sql.end(); }
});

// ── Budget metering ──────────────────────────────────────────────────────────

test("meteredClient charges every call and throws BudgetExceeded at the cap", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    let calls = 0;
    const inner: LlmClient = {
      responses: { create: async () => { calls++; return { output_text: "{}" }; } },
      chat: { completions: { create: async () => { calls++; return {}; } } },
    };
    const metered = meteredClient(inner, { guildId: "g-cap", store, getCap: async () => 3 });

    await metered.responses.create({});
    await metered.responses.create({});
    await metered.chat.completions.create({});
    assert.equal(calls, 3);
    assert.equal(await store.usageToday("g-cap"), 3, "both call shapes charge the same counter");

    await assert.rejects(metered.responses.create({}), BudgetExceeded);
    assert.equal(calls, 3, "a capped call must never reach the inner client");
    assert.equal(await store.usageToday("g-cap"), 3, "a capped call must not charge");
  } finally { await sql.end(); }
});

test("cap=0 blocks immediately; usage is per-guild", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const inner: LlmClient = {
      responses: { create: async () => ({}) }, chat: { completions: { create: async () => ({}) } },
    };
    const zero = meteredClient(inner, { guildId: "g-zero", store, getCap: async () => 0 });
    await assert.rejects(zero.responses.create({}), BudgetExceeded);
    assert.equal(await store.usageToday("g-zero"), 0);

    // A different guild's cap is unaffected.
    const other = meteredClient(inner, { guildId: "g-other", store, getCap: async () => 10 });
    await other.responses.create({});
    assert.equal(await store.usageToday("g-other"), 1);
    assert.equal(await store.usageToday("g-zero"), 0, "counters are per-guild");
  } finally { await sql.end(); }
});

test("guild_usage counter resets across the UTC day boundary", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    // Spend today's budget, then fake the day forward by rewriting the row —
    // a fresh charge lands on a new day row and succeeds.
    await store.chargeLlmCall("g-day", 1);
    await assert.rejects(
      meteredClient({ responses: { create: async () => ({}) }, chat: { completions: { create: async () => ({}) } } }, { guildId: "g-day", store, getCap: async () => 1 }).responses.create({}),
      BudgetExceeded,
    );
    await sql`UPDATE guild_usage SET day = day - 1 WHERE guild_id = 'g-day'`; // yesterday's spend doesn't count
    const r = await store.chargeLlmCall("g-day", 1);
    assert.equal(r.ok, true, "a new UTC day gets a fresh counter");
    assert.equal(await store.usageToday("g-day"), 1);
  } finally { await sql.end(); }
});
