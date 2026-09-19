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

// ── proposeGroundedAnswer ─────────────────────────────────────────────────────

test("proposeGroundedAnswer returns an answer when context answers and clears the floor", async () => {
  const { client } = stubClient({ outputText: JSON.stringify({ answers: true, appropriate: true, answer: "thursday at 9", confidence: 0.9 }) });
  const b = new Brain("k", "m", undefined, client);
  const r = await b.proposeGroundedAnswer("when are we meeting?", ["lore: the trip is thursday 9pm"], 0.6);
  assert.deepEqual(r, { answer: "thursday at 9", confidence: 0.9 });
});

test("proposeGroundedAnswer returns null when context doesn't answer or it's inappropriate", async () => {
  const { client } = stubClient({ outputText: JSON.stringify({ answers: false, appropriate: true, answer: "", confidence: 0.9 }) });
  const b = new Brain("k", "m", undefined, client);
  assert.equal(await b.proposeGroundedAnswer("when?", ["unrelated lore"], 0.6), null);
  const { client: c2 } = stubClient({ outputText: JSON.stringify({ answers: true, appropriate: false, answer: "x", confidence: 0.9 }) });
  const b2 = new Brain("k", "m", undefined, c2);
  assert.equal(await b2.proposeGroundedAnswer("when?", ["answers but shouldn't volunteer"], 0.6), null);
});

test("proposeGroundedAnswer enforces the caller's confidence floor (backoff)", async () => {
  const { client } = stubClient({ outputText: JSON.stringify({ answers: true, appropriate: true, answer: "thursday", confidence: 0.7 }) });
  const b = new Brain("k", "m", undefined, client);
  assert.ok(await b.proposeGroundedAnswer("when?", ["lore"], 0.6));   // baseline floor passes
  assert.equal(await b.proposeGroundedAnswer("when?", ["lore"], 0.85), null); // elevated floor blocks
});

// ── reply contract: { text, end_conversation } ────────────────────────────────

test("reply: parses {text, end_conversation} via strict json_schema on the plain path", async () => {
  const { client, calls } = stubClient({
    outputText: JSON.stringify({ text: "later then", end_conversation: true }),
  });
  const b = new Brain("k", "m", undefined, client);
  const r = await b.reply(msg("ok cool thanks that's all"), [], []);
  assert.deepEqual(r, { text: "later then", endConversation: true });
  assert.equal(calls.responses[0].text.format.type, "json_schema");
  assert.deepEqual(calls.responses[0].text.format.schema.required, ["text", "end_conversation"]);
});

test("reply: unparseable structured output goes silent rather than leaking internals", async () => {
  // The salvage ladder's floor is empty text — a structured-path response that
  // can't be salvaged is suppressed (the caller's `if (clean)` skips the send)
  // because raw model output may contain draft text, think blocks, or schema
  // internals that must never reach the channel.
  const { client } = stubClient({ outputText: "just a plain answer" });
  const b = new Brain("k", "m", undefined, client);
  const r = await b.reply(msg("hello"), [], []);
  assert.equal(r.text, "");
  assert.equal(r.endConversation, false);
});

test("reply: think-wrapped JSON is salvaged — think block stripped, JSON parsed", async () => {
  const { client } = stubClient({
    outputText: `<think>draft reasoning with end_conversation: true in it</think>{"text":"the real answer","end_conversation":false}`,
  });
  const b = new Brain("k", "m", undefined, client);
  const r = await b.reply(msg("hi"), [], []);
  assert.equal(r.text, "the real answer");
  assert.equal(r.endConversation, false, "the schema's own flag wins over the think-block draft");
});

test("reply: schema-ish invalid JSON is salvaged via the quoted text field", async () => {
  const { client } = stubClient({ outputText: `{"text": "salvaged answer", end_conversation: false}` });
  const b = new Brain("k", "m", undefined, client);
  const r = await b.reply(msg("hi"), [], []);
  assert.equal(r.text, "salvaged answer");
  assert.equal(r.endConversation, false);
});

test("reply: unclosed-draft + </think> + final answer shape yields the tail", async () => {
  // The observed leak shape: draft prose with the field name inline, a close
  // tag, then the actual reply — the post-think tail is the answer.
  const { client } = stubClient({
    outputText: `let me think about this, end_conversation: false probably </think> the actual reply`,
  });
  const b = new Brain("k", "m", undefined, client);
  const r = await b.reply(msg("hi"), [], []);
  assert.equal(r.text, "the actual reply");
  assert.equal(r.endConversation, false);
});

test("reply: tool-path early answer degrades to endConversation=false", async () => {
  // tools + response_format can't combine — a round that answers with plain
  // content and no tool_calls exits unstructured, which must not fake an exit.
  const client: LlmClient = {
    responses: { create: async () => ({ output_text: "{}" }) },
    chat: { completions: { create: async () => ({ choices: [{ message: { content: "the answer", tool_calls: [] } }] }) } },
  };
  const b = new Brain("k", "m", undefined, client);
  const r = await b.reply(msg("question"), [], [], [], [], "m", true);
  assert.equal(r.text, "the answer");
  assert.equal(r.endConversation, false);
});

test("reply: tool-loop exhaustion gets the schema on the final forced call", async () => {
  // Every round emits a tool_call; the final no-tools call carries
  // response_format, so the exit signal survives a tool-heavy exchange.
  let round = 0;
  const client: LlmClient = {
    responses: { create: async () => ({ output_text: "{}" }) },
    chat: { completions: { create: async (p: any) => {
      round++;
      if (p.response_format) return { choices: [{ message: { content: JSON.stringify({ text: "done", end_conversation: true }) } }] };
      // An unknown tool name keeps executeTool off the network — it returns an
      // error string, the loop continues, and the final forced call is what
      // this test actually exercises.
      return { choices: [{ message: { content: null, tool_calls: [{ id: `t${round}`, type: "function", function: { name: "nope_tool", arguments: "{}" } }] } }] };
    } } },
  };
  const b = new Brain("k", "m", undefined, client);
  const r = await b.reply(msg("look it up"), [], [], [], [], "m", true);
  assert.equal(r.text, "done");
  assert.equal(r.endConversation, true);
});

test("reply: compound retries unstructured when response_format is rejected, then remembers", async () => {
  // Groq may reject response_format alongside compound_custom — the retry
  // keeps built-in tools and loses only the exit signal; the flag flips so
  // later replies skip the doomed schema'd call instead of paying for it.
  let calls = 0;
  const client: LlmClient = {
    responses: { create: async () => ({ output_text: "{}" }) },
    chat: { completions: { create: async (p: any) => {
      calls++;
      if (p.response_format) throw new Error("unsupported response_format");
      return { choices: [{ message: { content: "compound answer" } }] };
    } } },
  };
  const b = new Brain("k", "m", undefined, client);
  const r1 = await b.reply(msg("hi"), [], [], [], [], "groq/compound-mini");
  assert.equal(r1.text, "compound answer");
  assert.equal(r1.endConversation, false);
  assert.equal(calls, 2); // schema'd attempt + unstructured retry
  const r2 = await b.reply(msg("hi again"), [], [], [], [], "groq/compound-mini");
  assert.equal(r2.text, "compound answer");
  assert.equal(calls, 3, "the unsupported flag is remembered — no wasted retry");
});
