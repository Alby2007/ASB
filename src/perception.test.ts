import assert from "node:assert/strict";
import test from "node:test";
import { detectDismissal, detectNamingRequest, detectSelfNaming, detectWakeWord, roomAddressCue, shouldInspectForMemory } from "./perception.js";
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

// ── detectWakeWord ────────────────────────────────────────────────────────────

const NAMES = ["asb", "artificialserverbeing", "Artificial Server Being", "person larper"];

test("detectWakeWord fires on the bot's names in any case", () => {
  assert.ok(detectWakeWord("asb what do you think", NAMES));
  assert.ok(detectWakeWord("ASB wdyt", NAMES));
  assert.ok(detectWakeWord("hey Artificial Server Being, look at this", NAMES));
  assert.ok(detectWakeWord("person larper get over here", NAMES));
  assert.ok(detectWakeWord("artificialserverbeing!", NAMES));
});

test("detectWakeWord respects word boundaries and length minimums", () => {
  assert.equal(detectWakeWord("the asbestos was bad", NAMES), false);        // "asb" inside a word
  assert.equal(detectWakeWord("hasbeen doing this", NAMES), false);          // trailing "asb" fragment
  assert.equal(detectWakeWord("ai are you there", ["ai"]), false);           // under min length
  assert.equal(detectWakeWord("regular chat message", NAMES), false);
  assert.equal(detectWakeWord("", NAMES), false);
  assert.equal(detectWakeWord("asb hi", [undefined, null, "", "asb"]), true); // empty names ignored
  assert.equal(detectWakeWord("asb hi", [undefined, null, ""]), false);      // no valid names at all
});

test("detectWakeWord escapes regex-special characters in names", () => {
  assert.ok(detectWakeWord("hey a.b.c what's up", ["a.b.c"]));
  assert.equal(detectWakeWord("hey axbxc what's up", ["a.b.c"]), false);      // dot is literal, not wildcard
});

// ── detectDismissal ───────────────────────────────────────────────────────────
// Call-site gated on mentionsBot, so hits only need to be plausible dismissals.

test("detectDismissal catches explicit dismissals", () => {
  assert.ok(detectDismissal("shut up person larper"));
  assert.ok(detectDismissal("ok stfu"));
  assert.ok(detectDismissal("fuck off bot"));
  assert.ok(detectDismissal("alright we're done here"));
  assert.ok(detectDismissal("nobody asked"));
  assert.ok(detectDismissal("go away"));
  assert.ok(detectDismissal("stop talking to me"));
});

test("detectDismissal ignores ordinary conversation", () => {
  assert.equal(detectDismissal("what do you think?"), false);
  assert.equal(detectDismissal("lol nice"), false);
  assert.equal(detectDismissal("can you help me with this"), false);
  assert.equal(detectDismissal("I haven't had enough coffee"), false); // bare "enough" isn't a cue
});

test("detectDismissal catches soft and meta dismissals", () => {
  assert.ok(detectDismissal("Okay bro shush now"));                        // unaddressed while engaged
  assert.ok(detectDismissal("Let's end this here"));
  assert.ok(detectDismissal("You don't have to reply to it anymore"));     // meta-instruction
  assert.ok(detectDismissal("stop replying"));
  assert.ok(detectDismissal("let's move on"));
  assert.ok(detectDismissal("we're done"));
});

// ── roomAddressCue ────────────────────────────────────────────────────────────

test("roomAddressCue catches messages aimed at the room, not the bot", () => {
  assert.ok(roomAddressCue("Did anyone see that btw 🤭🤭🤭"));
  assert.ok(roomAddressCue("does anyone know what time it is"));
  assert.ok(roomAddressCue("you guys are crazy"));
  assert.ok(roomAddressCue("who else saw that"));
  assert.ok(roomAddressCue("anyone else get the reference"));
  assert.ok(roomAddressCue("thanks everyone"));
  assert.ok(roomAddressCue("y'all hear this?"));
});

test("roomAddressCue leaves bot-directed engaged messages alone", () => {
  assert.equal(roomAddressCue("Why don't you get a life"), false);
  assert.equal(roomAddressCue("He's so fucking annoying"), false);          // about the bot ≠ aimed at the room
  assert.equal(roomAddressCue("Bro just do it"), false);
  assert.equal(roomAddressCue("that's not what I said"), false);
  assert.equal(roomAddressCue("lol nice"), false);
});
