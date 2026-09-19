import type { Sql } from "./db.js";
import { BudgetExceeded } from "./budget.js";
import { inc } from "./metrics.js";
import { logError } from "./secrets.js";

// ── Postgres job queue ────────────────────────────────────────────────────────
// Deferrable cognition (currently just 'extract') lives here instead of inline
// in handleMessage. Claims are UPDATE..RETURNING inside a single statement —
// FOR UPDATE SKIP LOCKED makes concurrent claims impossible and a crashed
// worker can't hold a claim (no locked_at needed). attempts >= 5 dead-letters
// by exclusion from the claim index; rows stay inspectable, never auto-deleted.
// The final failure fires jobs.dead_letter; scripts/requeue-dead-jobs.mjs
// re-drives them after a fix.

export interface Job {
  id: number;
  guild_id: string;
  type: string;
  payload: unknown;
  attempts: number;
}

export const MAX_JOB_ATTEMPTS = 5;

/** Permanent failure — the job can never succeed (e.g. unknown type, malformed
 * payload). Throwing this dead-letters immediately instead of burning retries. */
export class FatalJobError extends Error {}

// ── Guild pause / idle tracking ───────────────────────────────────────────────
// Module-level so callers without a worker handle (e.g. /server-build in
// commands.ts) can serialize against live extraction: ingest calls
// pipeline.process outside the queue, and interleaving with a worker's
// extract job would race the per-guild event ordering maxPerGuild protects.
const pausedGuilds = new Set<string>();
const guildInFlight = new Map<string, number>();
const guildIdleWaiters = new Map<string, Array<() => void>>();

/** Exclude a guild from new claims. Does not stop already-claimed jobs —
 * pair with waitForGuildIdle to fully drain before starting bulk work. */
export function pauseGuildClaims(guildId: string): void { pausedGuilds.add(guildId); }
export function resumeGuildClaims(guildId: string): void { pausedGuilds.delete(guildId); }

/** Resolves when the guild has no in-flight jobs, or after timeoutMs — a
 * wedged job must not hang a server build forever. */
export function waitForGuildIdle(guildId: string, timeoutMs: number): Promise<void> {
  if (!guildInFlight.get(guildId)) return Promise.resolve();
  return new Promise(resolve => {
    const wrapped = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => {
      const list = guildIdleWaiters.get(guildId);
      if (list) guildIdleWaiters.set(guildId, list.filter(w => w !== wrapped));
      resolve();
    }, timeoutMs);
    timer.unref();
    const waiters = guildIdleWaiters.get(guildId) ?? [];
    waiters.push(wrapped);
    guildIdleWaiters.set(guildId, waiters);
  });
}

/** Insert a job and nudge the worker via NOTIFY (a wake hint only — the 3s
 * poll is the resilient baseline, so a missed notification costs one poll).
 * run_after defaults to the DB's now(), not the client's — a few ms of clock
 * skew would otherwise make a fresh job briefly unclaimable. */
export async function enqueue(sql: Sql, guildId: string, type: string, payload: unknown, runAfter?: Date): Promise<number> {
  const rows = await sql<Array<{ id: number }>>`
    INSERT INTO jobs (guild_id, type, payload, run_after)
    VALUES (${guildId}, ${type}, ${sql.json(payload as never)}, COALESCE(${runAfter ?? null}::timestamptz, now()))
    RETURNING id
  `;
  await sql`SELECT pg_notify('jobs', ${String(rows[0].id)})`;
  return rows[0].id;
}

/** Lease a claimed job stays invisible for — extract jobs run in seconds;
 * a crashed worker's claims re-appear after this, so 10 minutes is a safe
 * bound that keeps "double-claim impossible" true even for sequential claims. */
const CLAIM_LEASE = "10 minutes";

/** Claim the oldest runnable job, excluding guilds already at their
 * concurrency cap. Claiming increments attempts (attempts counts *tries*, so
 * BudgetExceeded must un-burn one — a cap is not a fault) AND pushes
 * run_after out by the claim lease: the row leaves the runnable set until the
 * handler completes (delete), fails (run_after = backoff), or the process
 * dies (lease expires → claimable again). That's the SKIP-LOCKED-durable
 * version of "can't double-claim" — no locked_at column, no held transaction. */
export async function claimNext(sql: Sql, excludeGuilds: ReadonlySet<string>): Promise<Job | null> {
  const excluded = [...excludeGuilds];
  const rows = await sql<Job[]>`
    UPDATE jobs SET attempts = attempts + 1,
      run_after = now() + ${CLAIM_LEASE}::interval
    WHERE id = (
      SELECT id FROM jobs
      WHERE run_after <= now() AND attempts < ${MAX_JOB_ATTEMPTS}
        AND NOT (guild_id = ANY(${excluded}))
      ORDER BY run_after, id
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING id, guild_id, type, payload, attempts
  `;
  return rows[0] ?? null;
}

async function completeJob(sql: Sql, id: number): Promise<void> {
  await sql`DELETE FROM jobs WHERE id = ${id}`;
}

/** Next UTC midnight — the guild_usage counter resets on UTC day boundary,
 * so this is exactly when a capped guild can spend again. */
function nextUtcMidnight(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}

export interface WorkerDeps {
  sql: Sql;
  /** Per-type business logic lives in the caller — jobs.ts owns queue mechanics. */
  handle: (job: Job) => Promise<void>;
  maxInflight?: number;
  /** Per-guild concurrency — extract must stay serial per guild to preserve
   * pipeline/event ordering. */
  maxPerGuild?: number;
  pollMs?: number;
  onError?: (message: string, error: unknown) => void;
}

/**
 * Claim-and-dispatch loop. Wakes on LISTEN 'jobs' (enqueue's pg_notify) plus a
 * poll fallback for missed notifications. In-flight tracking is in-memory:
 * global cap + per-guild serial cap; at-cap guilds join the claim exclusion
 * set so other guilds aren't starved behind a busy one.
 */
export function startWorker(deps: WorkerDeps): { stop: () => Promise<void> } {
  const sql = deps.sql;
  const maxInflight = deps.maxInflight ?? 8;
  const maxPerGuild = deps.maxPerGuild ?? 1;
  const pollMs = deps.pollMs ?? 3000;
  const onError = deps.onError ?? ((m: string, e: unknown) => logError(m, e));
  // Per-guild counts live in module-scope guildInFlight (shared across workers
  // in the same process and observable by waitForGuildIdle); the global cap
  // stays per-worker.
  let inFlight = 0;
  let stopped = false;
  let unlisten: (() => Promise<void>) | undefined;
  const drainWaiters: Array<() => void> = [];

  async function runJob(job: Job): Promise<void> {
    try {
      await deps.handle(job);
      await completeJob(sql, job.id);
      inc("jobs.completed");
    } catch (error) {
      if (error instanceof FatalJobError) {
        // Permanent failure — park the row out of the claim set immediately;
        // it stays inspectable like any other dead letter.
        await sql`UPDATE jobs SET attempts = ${MAX_JOB_ATTEMPTS} WHERE id = ${job.id}`;
        inc("jobs.dead_letter");
        onError(`job ${job.id} (${job.type}) dead-lettered: ${error.message}`, error);
      } else if (error instanceof BudgetExceeded) {
        // Cap is not a fault: un-burn the claim attempt and park the job until
        // the UTC-day counter resets. No log spam — this is expected flow.
        await sql`UPDATE jobs SET attempts = attempts - 1, run_after = ${nextUtcMidnight()} WHERE id = ${job.id}`;
        inc("jobs.budget_rescheduled");
      } else {
        // Backoff requeues BEHIND fresh jobs (run_after ordering) — a poisoned
        // message can't head-of-line-block its guild's queue.
        const delayMs = Math.min(2 ** job.attempts, 30) * 60_000;
        await sql`UPDATE jobs SET run_after = now() + ${delayMs} * interval '1 millisecond' WHERE id = ${job.id}`;
        inc("jobs.retry");
        if (job.attempts >= MAX_JOB_ATTEMPTS) {
          // The claim just burned the last attempt — this row has left the
          // runnable set for good. Surface it: silent dead-letters are the
          // failure mode nobody notices for weeks.
          inc("jobs.dead_letter");
          onError(`job ${job.id} (${job.type}) dead-lettered after ${job.attempts} attempts`, error);
        } else {
          onError(`job ${job.id} (${job.type}) failed — attempt ${job.attempts}/${MAX_JOB_ATTEMPTS}`, error);
        }
      }
    }
  }

  // Claims must serialize: a second tick starting while the first awaits
  // claimNext would compute the exclusion set BEFORE the first's claim lands
  // in inFlightByGuild — both could then claim same-guild jobs concurrently,
  // breaking per-guild serial. The mutex plus retick covers the gap between
  // a tick exiting and a freed slot needing a fresh claim.
  let claiming = false;
  let retick = false;
  async function tick(): Promise<void> {
    if (claiming) { retick = true; return; }
    claiming = true;
    try {
      while (!stopped && inFlight < maxInflight) {
        const atCap = new Set([...guildInFlight].filter(([, n]) => n >= maxPerGuild).map(([g]) => g));
        for (const g of pausedGuilds) atCap.add(g);
        let job: Job | null;
        try {
          job = await claimNext(sql, atCap);
        } catch (error) {
          onError("job claim failed", error);
          return; // poll retries — a DB blip must not kill the loop
        }
        if (!job) return;
        inFlight++;
        guildInFlight.set(job.guild_id, (guildInFlight.get(job.guild_id) ?? 0) + 1);
        void runJob(job).finally(() => {
          inFlight--;
          const left = (guildInFlight.get(job.guild_id) ?? 1) - 1;
          if (left > 0) {
            guildInFlight.set(job.guild_id, left);
          } else {
            guildInFlight.delete(job.guild_id);
            guildIdleWaiters.get(job.guild_id)?.forEach(r => r());
            guildIdleWaiters.delete(job.guild_id);
          }
          if (stopped && inFlight === 0) drainWaiters.splice(0).forEach(r => r());
          else void tick(); // freed capacity — claim again immediately
        });
      }
    } finally {
      claiming = false;
      if (retick) { retick = false; void tick(); }
    }
  }

  // LISTEN is a wake hint; failure must not take the poll down with it.
  void sql.listen("jobs", () => { void tick(); })
    .then(req => { unlisten = () => req.unlisten(); })
    .catch(error => onError("LISTEN jobs failed — poll fallback only", error));
  const interval = setInterval(() => { void tick(); }, pollMs);
  interval.unref();

  return {
    stop: async () => {
      stopped = true;
      clearInterval(interval);
      await unlisten?.().catch(() => {});
      if (inFlight === 0) return;
      // Finish in-flight, claim nothing new.
      await new Promise<void>(r => drainWaiters.push(r));
    },
  };
}
