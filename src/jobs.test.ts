import "dotenv/config";
import assert from "node:assert/strict";
import test from "node:test";
import { makeTestSql, makeStore } from "./test-helpers.js";
import { enqueue, claimNext, startWorker, MAX_JOB_ATTEMPTS, FatalJobError, pauseGuildClaims, resumeGuildClaims, waitForGuildIdle, type Job } from "./jobs.js";
import { BudgetExceeded, meteredClient } from "./budget.js";
import { metricsSnapshot } from "./metrics.js";
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
      // "Next UTC midnight" can be minutes away — asserting a minimum distance
      // flakes between 23:00–24:00 UTC. Check the semantics instead: exactly a
      // UTC midnight, within the next day (small negative tolerance in case the
      // assert itself runs just past midnight).
      const runAt = new Date(capped.run_after).getTime();
      assert.equal(runAt % 86_400_000, 0, "run_after must land exactly on a UTC midnight");
      const msToRun = runAt - Date.now();
      assert.ok(msToRun > -60_000 && msToRun <= 24 * 60 * 60_000, "capped job reschedules to next UTC midnight");
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

test("FatalJobError dead-letters immediately instead of retrying", async () => {
  const sql = makeTestSql();
  try {
    await makeStore(sql);
    const deadBefore = metricsSnapshot().counts["jobs.dead_letter"] ?? 0;
    const worker = startWorker({
      sql: sql as any,
      pollMs: 20,
      handle: async () => { throw new FatalJobError("unknown job type: bogus"); },
    });
    try {
      const id = await enqueue(sql as any, "g1", "bogus", { n: 1 });
      await new Promise(r => setTimeout(r, 200));
      const [row] = await sql<Array<{ attempts: number }>>`SELECT attempts FROM jobs WHERE id = ${id}`;
      assert.equal(row?.attempts, MAX_JOB_ATTEMPTS, "fatal failure must dead-letter in one shot");
      assert.equal(metricsSnapshot().counts["jobs.dead_letter"], deadBefore + 1);
    } finally { await worker.stop(); }
  } finally { await sql.end(); }
});

test("a transient failure on the last attempt surfaces as dead-lettered", async () => {
  const sql = makeTestSql();
  try {
    await makeStore(sql);
    const deadBefore = metricsSnapshot().counts["jobs.dead_letter"] ?? 0;
    // Seed the row at attempt 4 BEFORE the worker starts — enqueue's NOTIFY
    // can otherwise let the worker claim first, and the failing handler's
    // backoff would park it out of reach of the UPDATE.
    const id = await enqueue(sql as any, "g1", "extract", { n: 1 });
    await sql`UPDATE jobs SET attempts = ${MAX_JOB_ATTEMPTS - 1} WHERE id = ${id}`;
    const worker = startWorker({
      sql: sql as any,
      pollMs: 20,
      handle: async () => { throw new Error("boom"); },
    });
    try {
      await new Promise(r => setTimeout(r, 200));
      const [row] = await sql<Array<{ attempts: number }>>`SELECT attempts FROM jobs WHERE id = ${id}`;
      assert.equal(row?.attempts, MAX_JOB_ATTEMPTS);
      assert.equal(metricsSnapshot().counts["jobs.dead_letter"], deadBefore + 1, "final-attempt failure must metric the dead letter");
    } finally { await worker.stop(); }
  } finally { await sql.end(); }
});

test("paused guilds are excluded from claims until resumed; waitForGuildIdle drains", async () => {
  const sql = makeTestSql();
  try {
    await makeStore(sql);
    pauseGuildClaims("g-p");
    try {
      const done: string[] = [];
      const worker = startWorker({ sql: sql as any, pollMs: 20, handle: async job => { done.push(job.guild_id); } });
      try {
        await enqueue(sql as any, "g-p", "extract", { n: 1 });
        await enqueue(sql as any, "g-q", "extract", { n: 2 });
        await new Promise(r => setTimeout(r, 200));
        assert.deepEqual(done, ["g-q"], "paused guild's jobs must not be claimed");
        const [{ attempts }] = await sql<Array<{ attempts: number }>>`SELECT attempts FROM jobs WHERE guild_id = 'g-p'`;
        assert.equal(attempts, 0);
        resumeGuildClaims("g-p");
        await new Promise(r => setTimeout(r, 200));
        assert.deepEqual(done.sort(), ["g-p", "g-q"], "resumed guild's jobs drain normally");
      } finally { await worker.stop(); }
    } finally { resumeGuildClaims("g-p"); }
  } finally { await sql.end(); }
});

test("waitForGuildIdle resolves on drain, not before; timeout bounds the wait", async () => {
  const sql = makeTestSql();
  try {
    await makeStore(sql);
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    let claimed = false;
    const worker = startWorker({ sql: sql as any, pollMs: 20, handle: async () => { claimed = true; await gate; } });
    try {
      await enqueue(sql as any, "g-w", "extract", { n: 1 });
      while (!claimed) await new Promise(r => setTimeout(r, 10));
      let idle = false;
      void waitForGuildIdle("g-w", 5000).then(() => { idle = true; });
      await waitForGuildIdle("g-w", 30); // bounded — resolves even though the job is still gated
      await new Promise(r => setTimeout(r, 50));
      assert.equal(idle, false, "idle must not resolve while a job runs");
      release();
      await new Promise(r => setTimeout(r, 100));
      assert.equal(idle, true, "idle resolves once the job drains");
    } finally { await worker.stop(); }
  } finally { await sql.end(); }
});

test("repairQueuedMarks: live job keeps 'queued', dead job → 'dead', no job → 'durable'", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    await sql`
      INSERT INTO messages (id, guild_id, channel_id, author_id, author_name, content, created_at, triage_result)
      VALUES ('m1','g1','c1','u1','Ann','hello',now(),'queued'),
             ('m2','g1','c1','u1','Ann','hi',now(),'queued'),
             ('m3','g1','c1','u1','Ann','yo',now(),'queued'),
             ('m4','g1','c1','u1','Ann','marked durable, mark write lost',now(),'durable')
    `;
    await enqueue(sql as any, "g1", "extract", { event: { messageId: "m1" } });
    const deadId = await enqueue(sql as any, "g1", "extract", { event: { messageId: "m2" } });
    await sql`UPDATE jobs SET attempts = ${MAX_JOB_ATTEMPTS} WHERE id = ${deadId}`;
    await enqueue(sql as any, "g1", "extract", { event: { messageId: "m4" } }); // live job, stale 'durable' mark
    const res = await store.repairQueuedMarks("g1");
    assert.deepEqual(res, { rejoined: 1, dead: 1, requeued: 1 });
    const rows = await sql<Array<{ id: string; triage_result: string }>>`SELECT id, triage_result FROM messages ORDER BY id`;
    assert.deepEqual(rows.map(r => [r.id, r.triage_result]), [
      ["m1", "queued"], ["m2", "dead"], ["m3", "durable"], ["m4", "queued"],
    ]);
  } finally { await sql.end(); }
});

test("listUninspectedMessages picks up stranded durable marks at any age", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    // A 'durable' mark days past the sweep window — orphaned work must not be
    // hidden by created_at; NULL marks stay windowed to bound the scan.
    await sql`
      INSERT INTO messages (id, guild_id, channel_id, author_id, author_name, content, created_at, triage_result)
      VALUES ('old-durable','g1','c1','u1','Ann','stuck', now() - interval '10 days', 'durable'),
             ('old-null','g1','c1','u1','Ann','too old to triage', now() - interval '10 days', NULL),
             ('new-null','g1','c1','u1','Ann','fresh', now(), NULL),
             ('dead-mark','g1','c1','u1','Ann','terminal', now(), 'dead')
    `;
    const rows = await store.listUninspectedMessages("g1", new Date(Date.now() - 2 * 60 * 60_000), "bot-id");
    assert.deepEqual(rows.map(r => r.id).sort(), ["new-null", "old-durable"]);
  } finally { await sql.end(); }
});

test("queueStats reports pending, dead, and oldest pending age", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    await enqueue(sql as any, "g1", "extract", { n: 1 });
    const deadId = await enqueue(sql as any, "g1", "extract", { n: 2 });
    await sql`UPDATE jobs SET attempts = ${MAX_JOB_ATTEMPTS} WHERE id = ${deadId}`;
    const stats = await store.queueStats("g1");
    assert.equal(stats.pending, 1);
    assert.equal(stats.dead, 1);
    assert.ok(stats.oldestPendingAt && Math.abs(Date.now() - stats.oldestPendingAt.getTime()) < 60_000);
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

test("pruneDerivedData drops guild_usage rows older than 30 days, keeps recent", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    await store.chargeLlmCall("g-prune", 5);
    await sql`INSERT INTO guild_usage (guild_id, day, llm_calls) VALUES ('g-prune', (now() AT TIME ZONE 'UTC')::date - 40, 7)`;
    const pruned = await store.pruneDerivedData("g-prune");
    assert.equal(pruned.usage, 1);
    const rows = await sql`SELECT day::text AS d, llm_calls FROM guild_usage WHERE guild_id = 'g-prune'`;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].llm_calls, 1, "today's counter survives");
  } finally { await sql.end(); }
});

test("pruneDerivedData scrubs verbatim evidence columns at the retention window, keeps the audit row", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    await store.recordMessage({
      guildId: "g-ev", channelId: "c", messageId: "m-ev", authorId: "u1",
      authorName: "Alice", content: "words", createdAt: new Date(), mentionsBot: false,
    });
    const saved = await store.saveMemory(
      { guildId: "g-ev", channelId: "c", messageId: "m-ev", authorId: "u1", authorName: "Alice", content: "words", createdAt: new Date(), mentionsBot: false },
      { subjectId: "u1", kind: "person_fact", content: "fact", reason: "r", evidenceType: "explicit_fact", effect: "support" },
    );
    // saveMemory writes the citing evidence row — give it verbatim text.
    const [evid] = await sql`
      UPDATE memory_evidence SET quote = 'verbatim quote', message_content_snapshot = 'full snapshot'
      WHERE memory_id = ${saved.id} RETURNING id`;
    // Fresh evidence is inside the window — verbatim text must survive.
    const fresh = await store.pruneDerivedData("g-ev", 90, 30);
    assert.equal(fresh.evidence, 0);
    // Age the evidence past the verbatim window — the words go, the row stays.
    await sql`UPDATE memory_evidence SET created_at = now() - interval '40 days' WHERE id = ${evid.id}`;
    const pruned = await store.pruneDerivedData("g-ev", 90, 30);
    assert.equal(pruned.evidence, 1);
    const [row] = await sql`SELECT quote, message_content_snapshot, reason FROM memory_evidence WHERE id = ${evid.id}`;
    assert.equal(row.quote, "");
    assert.equal(row.message_content_snapshot, "");
    assert.equal(row.reason, "r", "audit metadata is retained");
  } finally { await sql.end(); }
});
