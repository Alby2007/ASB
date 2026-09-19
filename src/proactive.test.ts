import assert from "node:assert/strict";
import { ProactiveScheduler } from "./proactive.js";

let now = 1_000_000;
const scheduled: Array<{ key: string; messageId: string; runAfter: Date }> = [];

const scheduler = new ProactiveScheduler({
  delayMs: 90_000,
  dailyCap: 3,
  responseWindowMs: 600_000,
  backoffMs: 21_600_000,
  baseMinConfidence: 0.6,
  backoffMinConfidence: 0.85,
  schedule: (key, messageId, runAfter) => scheduled.push({ key, messageId, runAfter }),
  now: () => now,
});

const KEY = "g:c";
function advance(ms: number) { now += ms; }

// ── arm → schedules a durable fire at now + delayMs ──────────────────────────
scheduler.arm(KEY, "m1");
assert.equal(scheduler.isPendingQuestion(KEY, "m1"), true);
assert.deepEqual(scheduled.map(s => [s.key, s.messageId]), [[KEY, "m1"]]);
assert.equal(scheduled[0]!.runAfter.getTime(), now + 90_000, "run_after IS the debounce timer");
// The job firing releases the armed entry.
assert.equal(scheduler.release(KEY, "m1"), true);
assert.equal(scheduler.isPendingQuestion(KEY, "m1"), false);
assert.equal(scheduler.release(KEY, "m1"), false, "already released — a replayed job no-ops");

// ── any follow-up cancels; the armed job fires later and no-ops ──────────────
scheduler.arm(KEY, "m2");
assert.equal(scheduler.cancelPending(KEY), true); // a follow-up message arrived
assert.equal(scheduler.release(KEY, "m2"), false, "cancelled arm must not release");

// a reaction on a DIFFERENT message doesn't cancel the pending question
scheduler.arm(KEY, "m3");
assert.equal(scheduler.cancelPending(KEY, "other-msg"), false);
assert.equal(scheduler.isPendingQuestion(KEY, "m3"), true);
assert.equal(scheduler.cancelPending(KEY, "m3"), true); // reaction on the question itself
assert.equal(scheduler.release(KEY, "m3"), false);

// ── a newer arm replaces the old pending question; the stale job no-ops ──────
scheduler.arm(KEY, "m5");
scheduler.arm(KEY, "m6"); // replaces m5
assert.equal(scheduler.release(KEY, "m5"), false, "stale job for replaced question must not fire");
assert.equal(scheduler.release(KEY, "m6"), true);

// ── restore: a 'proactive-fire' row that survived a restart is armed again ───
scheduler.restore("g:c2", "m9", now);
assert.equal(scheduler.isPendingQuestion("g:c2", "m9"), true);
assert.equal(scheduler.release("g:c2", "m9"), true, "restored arm fires normally");
// a newer arm already in the map wins over a stale row
scheduler.arm("g:c3", "fresh");
scheduler.restore("g:c3", "stale-row", now);
assert.equal(scheduler.isPendingQuestion("g:c3", "fresh"), true);
assert.equal(scheduler.release("g:c3", "stale-row"), false);

// ── daily cap: plant more qualifying fires than the cap ──────────────────────
const capped = new ProactiveScheduler({
  delayMs: 90_000, dailyCap: 2, responseWindowMs: 600_000, backoffMs: 21_600_000,
  baseMinConfidence: 0.6, backoffMinConfidence: 0.85,
  now: () => now,
});
capped.recordFire(KEY); capped.recordFire(KEY);
assert.equal(capped.allow(KEY).allowed, false); // cap reached — 3rd is blocked

// ── backoff: an ignored proactive reply raises the floor ─────────────────────
const back = new ProactiveScheduler({
  delayMs: 90_000, dailyCap: 3, responseWindowMs: 600_000, backoffMs: 21_600_000,
  baseMinConfidence: 0.6, backoffMinConfidence: 0.85,
  now: () => now,
});
back.noteSent(KEY, "p1");
assert.equal(back.allow(KEY).minConfidence, 0.6);           // still baseline within window
advance(700_000);                                            // past responseWindowMs
assert.equal(back.allow(KEY).minConfidence, 0.85);          // ignored → elevated floor
// elevated floor decays after backoffMs
advance(21_700_000);
assert.equal(back.allow(KEY).minConfidence, 0.6);
// engagement resets the streak
back.noteSent(KEY, "p2");
assert.equal(back.observeEngagement("p2"), true);
assert.equal(back.isProactiveTarget("p2"), true);
assert.equal(back.isProactiveTarget("random"), false);
assert.equal(back.allow(KEY).minConfidence, 0.6);

// ── daily counter resets on day rollover ─────────────────────────────────────
const day = new ProactiveScheduler({
  delayMs: 90_000, dailyCap: 1, responseWindowMs: 600_000, backoffMs: 21_600_000,
  baseMinConfidence: 0.6, backoffMinConfidence: 0.85,
  now: () => now,
});
day.recordFire(KEY);
assert.equal(day.allow(KEY).allowed, false);
advance(86_400_000);
assert.equal(day.allow(KEY).allowed, true);

console.log("proactive.test.ts: all tests passed");
