import assert from "node:assert/strict";
import test from "node:test";
import { Brain, type LlmClient } from "./brain.js";
import type { MessageEvent } from "./types.js";

const brain = new Brain("test-key", "test-model");

// Fake LlmClient: canned responses.create output_text + chat.completions
// choices. Captures params so tests can assert model/prompt plumbing.
function stubClient(opts: { outputText?: string; chatContent?: string } = {}) {
  const calls: { responses: any[]; chat: any[] } = { responses: [], chat: [] };
  const client: LlmClient = {
    responses: { create: async (p: any) => { calls.responses.push(p); return { output_text: opts.outputText ?? "{}" }; } },
    chat: { completions: { create: async (p: any) => { calls.chat.push(p); return { choices: [{ message: { content: opts.chatContent ?? "{}" } }] }; } } },
  };
  return { client, calls };
}

function msg(content: string, mentionsBot = false): MessageEvent {
  return {
    guildId: "g", channelId: "c", messageId: "m1",
    authorId: "u1", authorName: "Alice",
    content, createdAt: new Date(), mentionsBot,
  };
}

test("decide: direct mention speaks even when the bot spoke recently", () => {
  const decision = brain.decide(msg("@asb what do you think?", true), 30_000, false, 0.9);
  assert.equal(decision.shouldSpeak, true);
  assert.ok(decision.score >= 0.7, `score was ${decision.score}`);
});

test("decide: recency penalty decays proportionally for non-mention messages", () => {
  const fresh = brain.decide(msg("hello?"), Infinity, false, 0);
  const recent = brain.decide(msg("hello?"), 30_000, false, 0);
  const fading = brain.decide(msg("hello?"), 110_000, false, 0);
  assert.ok(recent.score < fading.score && fading.score < fresh.score);
  assert.ok(recent.reasons.includes("bot spoke recently"));
});

test("decide: elapsed beyond the window carries no penalty (guard can never invert)", () => {
  const beyond = brain.decide(msg("hello?"), 120_000, false, 0);
  const never = brain.decide(msg("hello?"), Infinity, false, 0);
  assert.equal(beyond.score, never.score);
  assert.ok(!beyond.reasons.includes("bot spoke recently"));
});

test("decide: engaged tier lifts in-conversation messages without mention weight", () => {
  const engaged = brain.decide(msg("lol nice"), 200_000, true, 0);
  const stranger = brain.decide(msg("lol nice"), 200_000, false, 0);
  assert.ok(engaged.score > stranger.score);
  assert.ok(engaged.reasons.includes("in conversation"));
  assert.equal(engaged.shouldSpeak, true); // 0.05 + 0.70 = 0.75
});

test("decide: engaged pacing is share-of-voice — floor share damps, time doesn't", () => {
  const lowShare = brain.decide(msg("lol nice"), 5_000, true, 0.2);
  assert.equal(lowShare.shouldSpeak, true); // 0.75 — engaged replies even seconds after speaking
  const highShare = brain.decide(msg("lol nice"), 5_000, true, 0.5);
  assert.equal(highShare.shouldSpeak, false); // 0.50 — holding the floor, takes a turn off
  assert.ok(highShare.reasons.includes("holding the floor"));
  const question = brain.decide(msg("wait what?"), 5_000, true, 0.5);
  assert.equal(question.shouldSpeak, false); // 0.60 — floor share beats the question bonus
});

test("decide: strangers stay suppressed for the full 120s window", () => {
  const strangerLate = brain.decide(msg("lol nice"), 110_000, false, 0);
  assert.ok(strangerLate.score < 0.7);
  assert.ok(strangerLate.reasons.includes("bot spoke recently"));
});

test("decide: unmentioned chatter stays below the speak threshold", () => {
  const decision = brain.decide(msg("lol nice"), Infinity, false, 0);
  assert.equal(decision.shouldSpeak, false);
});

test("decide: lowering the threshold enables unsolicited replies", () => {
  const decision = brain.decide(msg("hello?"), Infinity, false, 0, 0.1);
  assert.equal(decision.shouldSpeak, true);
});

test("extractMemories: parses candidates + relationships from injected client", async () => {
  const { client, calls } = stubClient({
    outputText: JSON.stringify({
      memories: [{
        subjectId: "u1", subjectName: "Alice", kind: "person_fact",
        content: "Alice lives in Leeds", reason: "stated directly",
        evidenceType: "explicit_fact", effect: "support",
      }],
      relationships: [{ subjectName: "", otherName: "Bob", nature: "close friends", valence: 0.8, reason: "talk daily" }],
    }),
  });
  const b = new Brain("k", "m", undefined, client);
  const result = await b.extractMemories(msg("I live in Leeds and Bob is my best friend"));
  assert.equal(result.memories.length, 1);
  assert.equal(result.memories[0].content, "Alice lives in Leeds");
  assert.equal(result.relationships[0].nature, "close friends");
  assert.equal(calls.responses[0].model, "m");
  assert.match(calls.responses[0].input, /Author ID: u1/);
});

test("extractMemories: empty model output yields empty arrays, not a crash", async () => {
  const { client } = stubClient({ outputText: "{}" });
  const result = await new Brain("k", "m", undefined, client).extractMemories(msg("lol"));
  assert.deepEqual(result, { memories: [], relationships: [] });
});

test("detectContest: drops relations that cite memory ids outside the candidate set", async () => {
  const { client } = stubClient({
    chatContent: JSON.stringify({
      results: [
        { memoryId: 7, relation: "contests", reason: "denies it" },
        { memoryId: 999, relation: "confirms", reason: "hallucinated id" },
      ],
    }),
  });
  const b = new Brain("k", "m", undefined, client);
  const out = await b.detectContest(msg("that's not true", true), [
    { id: 7, content: "Alice hates cats", status: "active" },
  ]);
  assert.deepEqual(out, [{ memoryId: 7, relation: "contests", reason: "denies it" }]);
});

test("verifyMemoriesBatch: omitted items fall back to unclear", async () => {
  const { client } = stubClient({
    chatContent: JSON.stringify({ results: [{ index: 0, verdict: "literal", reason: "sincere" }] }),
  });
  const b = new Brain("k", "m", undefined, client);
  const out = await b.verifyMemoriesBatch([
    { memoryId: 1, authorName: "Alice", claim: "A", sourceMessage: "src A" },
    { memoryId: 2, authorName: "Bob", claim: "B", sourceMessage: "src B" },
  ], "verify-model");
  assert.deepEqual(out.get(1), { verdict: "literal", reason: "sincere" });
  assert.deepEqual(out.get(2), { verdict: "unclear", reason: "omitted by model" });
});
