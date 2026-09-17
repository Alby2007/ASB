import assert from "node:assert/strict";
import test from "node:test";
import { detectNamingRequest, detectSelfNaming, shouldInspectForMemory } from "./perception.js";
import type { MessageEvent } from "./types.js";

function msg(content: string, overrides: Partial<MessageEvent> = {}): MessageEvent {
  return {
    guildId: "g1", channelId: "c1", messageId: `m${Math.random().toString(36).slice(2)}`,
    authorId: "u1", authorName: "Alice", content, createdAt: new Date(), mentionsBot: false,
    ...overrides,
  };
}

// ── shouldInspectForMemory ────────────────────────────────────────────────────

test("naming and preference phrasings pass the durable-signal gate", () => {
  for (const content of [
    "Can you just call me Alby from now on",
    "my name is Albert actually",
    "i go by Alby most places",
    "don't call me Albert please",
    "my pronouns are they/them",
    "that reminds me of the time we went to Leeds",
    "i can't stand licorice honestly",
  ]) {
    assert.ok(shouldInspectForMemory(msg(content)), `expected inspectable: ${content}`);
  }
});

test("bot-addressed messages always pass the gate; ordinary chatter still doesn't", () => {
  assert.ok(shouldInspectForMemory(msg("<@999> hey what's up", { mentionsBot: true })));
  assert.equal(shouldInspectForMemory(msg("lol nice one")), false);
  assert.equal(shouldInspectForMemory(msg("ok")), false); // length bound still applies
});

// ── detectNamingRequest ───────────────────────────────────────────────────────

test("detectNamingRequest extracts names from explicit requests", () => {
  assert.equal(detectNamingRequest("can you just call me Alby from now on", ["Alice"]), "Alby");
  assert.equal(detectNamingRequest("my name is Albert", []), "Albert");
  assert.equal(detectNamingRequest("i go by Alby most places", []), "Alby");
  assert.equal(detectNamingRequest("you can call me Alby", []), "Alby");
  assert.equal(detectNamingRequest("Call me Alby", []), "Alby");
});

test("detectNamingRequest ignores lowercase non-names, stopwords, and the author's own names", () => {
  assert.equal(detectNamingRequest("call me later", []), undefined);
  assert.equal(detectNamingRequest("call me paranoid but", []), undefined);
  assert.equal(detectNamingRequest("call me back in five", []), undefined);
  assert.equal(detectNamingRequest("call me ALBY", []), undefined); // all-caps = emphasis
  assert.equal(detectNamingRequest("call me Alice", ["Alice"]), undefined); // already a known name
});

test("detectSelfNaming still catches pasted-bio self-naming", () => {
  assert.equal(detectSelfNaming("I am Sage, a dragon lover", ["tinyriot"]), "Sage");
  assert.equal(detectSelfNaming("i am tired today", []), undefined);
});
