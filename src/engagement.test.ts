import assert from "node:assert/strict";
import { EngagementTracker } from "./engagement.js";

let now = 1_000_000;
const tracker = new EngagementTracker(120_000, () => now);
const KEY = "g:c";

function advance(ms: number) {
  now += ms;
}

// Trigger enrolls the participant.
tracker.noteTrigger(KEY, "alice");
assert.equal(tracker.isEngaged(KEY, "alice"), true);
assert.equal(tracker.isEngaged(KEY, "bob"), false);

// A second trigger enrolls independently — multi-party coexistence.
advance(30_000);
tracker.noteTrigger(KEY, "bob");
assert.equal(tracker.isEngaged(KEY, "alice"), true);
assert.equal(tracker.isEngaged(KEY, "bob"), true);

// Participants expire independently: alice's TTL (set 30s before bob's) lapses first.
advance(95_000); // alice at 125s, bob at 95s
assert.equal(tracker.isEngaged(KEY, "alice"), false);
assert.equal(tracker.isEngaged(KEY, "bob"), true);

// noteReply records pacing but does NOT extend participants — this is what lets
// the bot drop out while people keep talking.
tracker.noteReply(KEY);
assert.equal(tracker.lastSpokeAt(KEY), now);
advance(30_000); // bob now at 125s despite the recent bot reply
assert.equal(tracker.isEngaged(KEY, "bob"), false);

// Re-addressing refreshes the TTL.
tracker.noteTrigger(KEY, "carol");
advance(119_000);
assert.equal(tracker.isEngaged(KEY, "carol"), true);
tracker.noteTrigger(KEY, "carol"); // addressed again inside the window
advance(30_000);
assert.equal(tracker.isEngaged(KEY, "carol"), true);

// Dismiss removes only that participant; others stay engaged.
tracker.noteTrigger(KEY, "dave");
tracker.dismiss(KEY, "dave");
assert.equal(tracker.isEngaged(KEY, "dave"), false);
assert.equal(tracker.isEngaged(KEY, "carol"), true);

// Unknown keys/users are simply not engaged.
assert.equal(tracker.isEngaged("other:chan", "carol"), false);
assert.equal(tracker.lastSpokeAt("other:chan"), undefined);

console.log("engagement.test.ts: all tests passed");
