import assert from "node:assert/strict";
import { ProactiveScheduler } from "./proactive.js";

let now = 1_000_000;
const fired: string[] = [];
const timers = new Map<() => void, number>();

const scheduler = new ProactiveScheduler({
  delayMs: 90_000,
  dailyCap: 3,
  responseWindowMs: 600_000,
  backoffMs: 21_600_000,
  baseMinConfidence: 0.6,
  backoffMinConfidence: 0.85,
  onFire: (key, messageId) => fired.push(`${key}:${messageId}`),
  setTimeoutFn: (fn, _ms) => { timers.set(fn, now); return fn as unknown as ReturnType<typeof setTimeout>; },
  clearTimeoutFn: (t) => { timers.delete(t as unknown as () => void); },
  now: () => now,
});

const KEY = "g:c";
function runTimers() { for (const fn of [...timers.keys()]) { timers.delete(fn); fn(); } }
function advance(ms: number) { now += ms; }

// ── arm → fire after delay ────────────────────────────────────────────────────
scheduler.arm(KEY, "m1");
assert.equal(scheduler.isPendingQuestion(KEY, "m1"), true);
runTimers();
assert.deepEqual(fired, [`${KEY}:m1`]);
assert.equal(scheduler.isPendingQuestion(KEY, "m1"), false);

// ── any follow-up cancels (message path passes no id) ────────────────────────
scheduler.arm(KEY, "m2");
assert.equal(scheduler.cancelPending(KEY), true); // a follow-up message arrived
runTimers();
assert.deepEqual(fired, [`${KEY}:m1`]); // nothing new fired

// a reaction on a DIFFERENT message doesn't cancel the pending question
scheduler.arm(KEY, "m3");
assert.equal(scheduler.cancelPending(KEY, "other-msg"), false);
assert.equal(scheduler.isPendingQuestion(KEY, "m3"), true);
assert.equal(scheduler.cancelPending(KEY, "m3"), true); // reaction on the question itself

// cancelPending with the question's own id (reaction case)
scheduler.arm(KEY, "m4");
assert.equal(scheduler.cancelPending(KEY, "m4"), true);

// ── a newer arm replaces the old pending question ────────────────────────────
scheduler.arm(KEY, "m5");
scheduler.arm(KEY, "m6"); // replaces m5 — its timer is cleared
runTimers();
assert.deepEqual(fired, [`${KEY}:m1`, `${KEY}:m6`]);

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
