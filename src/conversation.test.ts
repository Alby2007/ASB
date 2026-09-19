import assert from "node:assert/strict";
import test from "node:test";
import { ConversationTracker } from "./conversation.js";

// Conversation lifecycle: addressed opens, leave/exit closes, expiry is
// per-user and measured from each person's last ADDRESSED message — bot
// replies never extend anyone (that's what lets the bot drop out mid-chatter).

let now = 1_000_000;
const convo = new ConversationTracker(120_000, () => now);
const KEY = "g:c";
const advance = (ms: number) => { now += ms; };

test("addressed opens the conversation; a second addressed user joins it", () => {
  assert.equal(convo.isOpen(KEY), false);
  assert.equal(convo.addressed(KEY, "alice"), true, "first participant opens");
  assert.equal(convo.isOpen(KEY), true);
  assert.equal(convo.isParticipant(KEY, "alice"), true);
  assert.equal(convo.isParticipant(KEY, "bob"), false);

  advance(30_000);
  assert.equal(convo.addressed(KEY, "bob"), false, "already open — no second open event");
  assert.equal(convo.isParticipant(KEY, "bob"), true);
  assert.deepEqual(convo.participants(KEY).sort(), ["alice", "bob"]);
});

test("participants expire independently from their own last addressed message", () => {
  // alice addressed at t=0, bob at t=30s → alice lapses first.
  advance(95_000); // alice at 125s, bob at 95s
  assert.equal(convo.isParticipant(KEY, "alice"), false);
  assert.equal(convo.isParticipant(KEY, "bob"), true);
  assert.equal(convo.isOpen(KEY), true, "convo stays open while anyone remains");
});

test("noteReply records pacing but never extends a participant", () => {
  convo.noteReply(KEY);
  assert.equal(convo.lastSpokeAt(KEY), now);
  advance(30_000); // bob now at 125s despite the bot having just spoken
  assert.equal(convo.isParticipant(KEY, "bob"), false);
  assert.equal(convo.isOpen(KEY), false, "last participant expiring closes the convo");
});

test("re-addressing refreshes the TTL and reopens a closed convo", () => {
  assert.equal(convo.addressed(KEY, "carol"), true, "closed convo reopens");
  advance(119_000);
  assert.equal(convo.isParticipant(KEY, "carol"), true);
  convo.addressed(KEY, "carol"); // addressed again inside the window
  advance(30_000);
  assert.equal(convo.isParticipant(KEY, "carol"), true, "TTL refreshed from the new message");
});

test("leave removes only that participant; close() empties everyone", () => {
  convo.addressed(KEY, "dave");
  assert.equal(convo.leave(KEY, "dave"), true, "removing a live participant reports true");
  assert.equal(convo.leave(KEY, "dave"), false, "a second leave is a no-op — no double-counted exits");
  assert.equal(convo.leave(KEY, "nobody"), false, "a non-participant leave reports false");
  assert.equal(convo.isParticipant(KEY, "dave"), false);
  assert.equal(convo.isParticipant(KEY, "carol"), true);
  assert.equal(convo.isOpen(KEY), true);

  convo.close(KEY);
  assert.equal(convo.isOpen(KEY), false);
  assert.deepEqual(convo.participants(KEY), []);
});

test("share-of-voice is channel pacing — it survives the convo closing", () => {
  const K2 = "g:c2";
  assert.equal(convo.botShare(K2), 0);
  convo.noteMessage(K2, false);
  convo.noteMessage(K2, false);
  convo.noteReply(K2); // bot message
  assert.ok(Math.abs(convo.botShare(K2) - 1 / 3) < 0.001);

  convo.addressed(K2, "erin");
  convo.leave(K2, "erin");           // convo closes…
  assert.equal(convo.isOpen(K2), false);
  assert.ok(convo.botShare(K2) > 0, "…but the channel's voice window persists");

  convo.noteMessage(K2, false);
  assert.ok(Math.abs(convo.botShare(K2) - 1 / 4) < 0.001);

  // The window is bounded at 10 messages — old traffic falls out.
  for (let i = 0; i < 12; i++) convo.noteMessage(K2, false);
  assert.equal(convo.botShare(K2), 0);
  convo.noteReply(K2);
  assert.equal(convo.botShare(K2), 0.1);
});

test("unknown keys and users are simply not participants", () => {
  assert.equal(convo.isParticipant("other:chan", "carol"), false);
  assert.equal(convo.isOpen("other:chan"), false);
  assert.equal(convo.lastSpokeAt("other:chan"), undefined);
});

// ── bystanderVoices: the share-of-voice floor only exists when non-participants
// are speaking ───────────────────────────────────────────────────────────────

test("bystanderVoices: a solo 1:1 ping-pong has no floor to protect", () => {
  const K = "g:solo";
  convo.addressed(K, "alice");                    // alice enrolls
  convo.noteMessage(K, false, "alice");           // her messages…
  convo.noteReply(K);                             // …ping-pong with the bot…
  convo.noteMessage(K, false, "alice");
  convo.noteReply(K);
  assert.ok(convo.botShare(K) >= 0.4, "bot share is structurally high in a 1:1");
  assert.equal(convo.bystanderVoices(K), 0, "the only human voice IS the participant — no bystanders");
});

test("bystanderVoices: a non-participant voice on the floor counts", () => {
  const K = "g:floor";
  convo.addressed(K, "alice");
  convo.noteMessage(K, false, "alice");
  convo.noteMessage(K, false, "bob");             // bob speaks without joining
  convo.noteReply(K);
  assert.equal(convo.bystanderVoices(K), 1, "bob is a bystander — the floor exists");
  convo.noteMessage(K, false, "carol");
  assert.equal(convo.bystanderVoices(K), 2, "distinct bystanders count once each");
  convo.noteMessage(K, false, "bob");             // same bystander again
  assert.equal(convo.bystanderVoices(K), 2, "repeats don't inflate the count");
});

test("bystanderVoices: two addressed humans chatting with the bot are still no floor", () => {
  const K = "g:trio";
  convo.addressed(K, "alice");
  convo.addressed(K, "bob");                      // both join the convo
  convo.noteMessage(K, false, "alice");
  convo.noteMessage(K, false, "bob");
  convo.noteReply(K);
  assert.equal(convo.bystanderVoices(K), 0, "participants aren't bystanders even when there are two");
});

test("bystanderVoices: an expired participant's messages become bystander traffic", () => {
  const K = "g:lapsed";
  convo.addressed(K, "alice");
  convo.noteMessage(K, false, "alice");
  convo.noteReply(K);
  assert.equal(convo.bystanderVoices(K), 0);
  advance(130_000);                               // alice's TTL lapses
  assert.equal(convo.bystanderVoices(K), 1, "she decayed out — her recent messages are floor traffic now");
});
