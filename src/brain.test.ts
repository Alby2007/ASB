import assert from "node:assert/strict";
import test from "node:test";
import { Brain } from "./brain.js";
import type { MessageEvent } from "./types.js";

const brain = new Brain("test-key", "test-model");

function msg(content: string, mentionsBot = false): MessageEvent {
  return {
    guildId: "g", channelId: "c", messageId: "m1",
    authorId: "u1", authorName: "Alice",
    content, createdAt: new Date(), mentionsBot,
  };
}

test("decide: direct mention speaks even when the bot spoke recently", () => {
  const decision = brain.decide(msg("@asb what do you think?", true), 1);
  assert.equal(decision.shouldSpeak, true);
  assert.ok(decision.score >= 0.7, `score was ${decision.score}`);
});

test("decide: recency penalty still applies to non-mention messages", () => {
  const fresh = brain.decide(msg("hello?"), 0);
  const recent = brain.decide(msg("hello?"), 1);
  assert.ok(recent.score < fresh.score);
  assert.ok(recent.reasons.includes("bot spoke recently"));
});

test("decide: unmentioned chatter stays below the speak threshold", () => {
  const decision = brain.decide(msg("lol nice"), 0);
  assert.equal(decision.shouldSpeak, false);
});

test("decide: lowering the threshold enables unsolicited replies", () => {
  const decision = brain.decide(msg("hello?"), 0, 0.1);
  assert.equal(decision.shouldSpeak, true);
});
