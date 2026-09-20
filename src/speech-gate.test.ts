import assert from "node:assert/strict";
import test from "node:test";
import { Brain } from "./brain.js";
import { ConversationTracker } from "./conversation.js";
import { ReplyThrottle } from "./reply-throttle.js";
import { evaluateSpeechTurn, type SpeechVerdict } from "./speech-gate.js";
import type { MessageEvent } from "./types.js";

// ── Transcript-replay harness ─────────────────────────────────────────────────
// Scripted conversation turns flow through the REAL speech gate — the same
// evaluateSpeechTurn handleMessage calls — plus the same post-decision wiring
// (throttle consume → send → noteReply). Unit tests cover units; this catches
// the bug class that keeps escaping them: heuristic × real conversational
// shape (the 1:1 share-of-voice misfire shipped exactly that way).

const BOT = "bot1";

type Turn = {
  author?: string;
  content: string;
  /** Explicit @-mention / reply-to-bot / wake word — detection lives upstream. */
  mentionsBot?: boolean;
  repliedToOtherUser?: boolean;
  mentionsOtherUsers?: boolean;
  /** Advance the clock before this turn (default 5s between turns). */
  advanceMs?: number;
};

type Outcome = { spoke: boolean; verdict?: SpeechVerdict };

function makeHarness(opts?: { throttleCapacity?: number; engagement?: boolean; throttleRefillMs?: number }) {
  let now = 1_000_000;
  const convo = new ConversationTracker(120_000, () => now);
  const throttle = new ReplyThrottle({
    capacity: opts?.throttleCapacity ?? 4,
    refillMs: opts?.throttleRefillMs ?? 30_000,
    now: () => now,
  });
  const brain = new Brain("test-key", "test-model");
  const decide = (e: MessageEvent, ms: number, eng: boolean, share: number) =>
    brain.decide(e, ms, eng, share, 0.7);
  const KEY = "g1:c1";
  let seq = 0;
  return {
    convo,
    throttle,
    /** Play one human message through the gate; a `spoke` result records the
     * bot's reply in the voice window exactly like index.ts's noteReply. */
    play(turn: Turn): Outcome {
      now += turn.advanceMs ?? 5_000;
      const event: MessageEvent = {
        guildId: "g1", channelId: "c1", messageId: `m${++seq}`,
        authorId: turn.author ?? "u1", authorName: "U",
        content: turn.content, createdAt: new Date(now),
        mentionsBot: turn.mentionsBot ?? false,
      };
      const verdict = evaluateSpeechTurn(
        { event, botId: BOT, repliedToOtherUser: turn.repliedToOtherUser, mentionsOtherUsers: turn.mentionsOtherUsers },
        convo, decide, { engagement: opts?.engagement ?? true, now: () => now },
      );
      // Mirror index.ts: decide → per-user throttle → send → noteReply.
      const spoke = verdict.decision.shouldSpeak && throttle.consume("g1", event.authorId);
      if (spoke) convo.noteReply(KEY);
      return { spoke, verdict };
    },
  };
}

// The 1:1 ping-pong regression: in a pure two-party exchange the bot is ~50%
// of channel traffic forever — share-of-voice must NOT suppress follow-ups
// when no bystander exists. Turns advance at a natural ~25s pace — inside the
// 30s refill rate and comfortably inside the 120s participation TTL (30s
// strides would land turn 5 exactly on the expiry boundary, which is a
// different, also-correct silence). Faster-than-refill bursts throttle by
// design — see the throttle test below.
test("1:1 conversation keeps replying — share-of-voice never fires without bystanders", () => {
  const h = makeHarness();
  const turns = [
    { content: "hey asb", mentionsBot: true },
    { content: "oh so you remember my insults now too", advanceMs: 25_000 },
    { content: "that's fair honestly", advanceMs: 25_000 },
    { content: "anyway what do you think", advanceMs: 25_000 },
    { content: "one more thing", advanceMs: 25_000 },
  ];
  const spoke = turns.map(t => h.play(t).spoke);
  assert.deepEqual(spoke, turns.map(() => true), "every turn in a 1:1 must be answered");
});

// With a bystander on the floor the penalty DOES apply — and it ebbs back in
// as the bot's share dilutes rather than hard-cutting the conversation.
test("share-of-voice suppresses engaged turns only while a bystander shares the floor", () => {
  const h = makeHarness();
  assert.equal(h.play({ content: "hey asb", mentionsBot: true }).spoke, true);
  assert.equal(h.play({ author: "u2", content: "hey what's up" }).spoke, false); // bystander, stranger-tier
  assert.equal(h.play({ content: "nice one" }).spoke, true);   // share 1/3 ≈ 0.33 — under the bar
  assert.equal(h.play({ content: "hmm ok" }).spoke, true);     // share 2/6 ≈ 0.33 — just under
  const suppressed = h.play({ content: "still here" });        // share 3/8 = 0.375 — over the bar
  assert.equal(suppressed.spoke, false);
  assert.equal(suppressed.verdict!.engaged, true, "still a participant — it's pacing, not a leave");
  assert.ok(suppressed.verdict!.share >= 0.35);
  // It ebbs back: silent turns add no bot voices, so the share dilutes.
  assert.equal(h.play({ content: "and now?" }).spoke, true);
});

test("unaddressed dismissal drops the participant to stranger tier silently", () => {
  const h = makeHarness();
  h.play({ content: "hey asb", mentionsBot: true });
  const d = h.play({ content: "shush" });
  assert.equal(d.verdict!.dismissed, true);
  assert.equal(d.spoke, false, "unaddressed dismissal exits silently");
  assert.equal(h.convo.isParticipant("g1:c1", "u1"), false);
  assert.equal(h.play({ content: "ok one more thing" }).spoke, false, "back to stranger tier");
});

// The deterministic override: an addressed dismissal still earns the terminal
// ack (decide says speak — the flag is unreachable by the model's
// end_conversation, so dismissal ALWAYS wins), then the user is out.
test("addressed dismissal gets one terminal ack then drops out — regex beats any model preference", () => {
  const h = makeHarness();
  h.play({ content: "hey asb", mentionsBot: true });
  const d = h.play({ content: "shut up asb", mentionsBot: true });
  assert.equal(d.verdict!.dismissed, true);
  assert.equal(d.spoke, true, "addressed dismissal earns the terminal ack");
  assert.equal(h.convo.isParticipant("g1:c1", "u1"), false, "removed despite the reply");
  assert.equal(h.play({ content: "wait actually" }).spoke, false);
});

test("per-user throttle: a burst is free, then replies suppress until refill", () => {
  const h = makeHarness({ throttleCapacity: 2, throttleRefillMs: 45_000 });
  assert.equal(h.play({ content: "asb 1", mentionsBot: true }).spoke, true);
  assert.equal(h.play({ content: "asb 2", mentionsBot: true }).spoke, true);
  const throttled = h.play({ content: "asb 3", mentionsBot: true });
  assert.equal(throttled.verdict!.decision.shouldSpeak, true, "decide still wants to speak — the budget blocks it");
  assert.equal(throttled.spoke, false);
  assert.equal(h.play({ content: "asb 4", mentionsBot: true }).spoke, false);
  assert.equal(h.play({ content: "asb again", mentionsBot: true, advanceMs: 45_000 }).spoke, true, "refill restores one reply");
});

// A decided reply that never reaches the channel (empty model output, leak
// drop, send error) must not burn the member's burst — otherwise failed
// generations cascade into suppressing the NEXT addressed message.
test("a failed send refunds the throttle token — silence isn't speech", () => {
  const h = makeHarness({ throttleCapacity: 2, throttleRefillMs: 45_000 });
  assert.equal(h.play({ content: "asb 1", mentionsBot: true }).spoke, true);
  assert.equal(h.play({ content: "asb 2", mentionsBot: true }).spoke, true);
  // Third decided reply fails mid-generation — handleMessage refunds.
  const failed = h.play({ content: "asb 3", mentionsBot: true });
  assert.equal(failed.verdict!.decision.shouldSpeak, true);
  assert.equal(failed.spoke, false, "bucket empty without the fix path");
  h.throttle.refund("g1", "u1");
  // Fourth message replies instead of being suppressed by the dead send.
  const spoke = h.throttle.consume("g1", "u1");
  assert.equal(spoke, true, "refunded token lets the next addressed message through");
});

// The model's end_conversation maps to convo.leave — the NEXT turn is then
// judged as a stranger. Item-4 coverage: the flag only removes participation;
// it can't silence a fresh mention, and dismissal still overrides everything.
test("a model exit drops the participant; a later mention reopens normally", () => {
  const h = makeHarness();
  h.play({ content: "hey asb", mentionsBot: true });
  // Simulate the reply returning end_conversation=true — handleMessage calls
  // convo.leave on the flag, same call the harness makes here.
  h.convo.leave("g1:c1", "u1");
  assert.equal(h.convo.isOpen("g1:c1"), false);
  assert.equal(h.play({ content: "did you see that thing" }).spoke, false, "exited — judged as stranger");
  assert.equal(h.play({ content: "asb one more", mentionsBot: true }).spoke, true, "mention still always answered");
});

test("engaged but room-aimed messages don't earn the conversation bonus", () => {
  const h = makeHarness();
  assert.equal(h.play({ content: "hey asb", mentionsBot: true }).spoke, true);
  const room = h.play({ content: "did you guys see that" });
  assert.equal(room.verdict!.engaged, false, "room-aimed turn loses the bonus");
  assert.equal(room.spoke, false);
  assert.equal(h.convo.isParticipant("g1:c1", "u1"), true, "participation itself is untouched");
  // Replying to another human — same demotion.
  const reply = h.play({ content: "yeah that was wild", repliedToOtherUser: true });
  assert.equal(reply.verdict!.engaged, false);
  assert.equal(reply.spoke, false);
});

test("ENGAGEMENT=0: every non-addressed message is a stranger — no enrollment", () => {
  const h = makeHarness({ engagement: false });
  assert.equal(h.play({ content: "hey asb", mentionsBot: true }).spoke, true);
  assert.equal(h.play({ content: "ok thanks" }).spoke, false, "address-only mode — no follow-up bonus");
});

test("TTL expiry returns an engaged user to stranger tier", () => {
  const h = makeHarness();
  h.play({ content: "hey asb", mentionsBot: true });
  const late = h.play({ content: "back from lunch", advanceMs: 130_000 });
  assert.equal(late.verdict!.engaged, false, "120s TTL elapsed — no longer a participant");
  assert.equal(late.spoke, false);
});
