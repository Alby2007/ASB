import assert from "node:assert/strict";
import test from "node:test";
import { aliasKeyVariants, demangleMentions, findMentionedUsers, resolveSubject, scrubMentions, type AliasMap } from "./entity-resolution.js";
import type { MessageEvent } from "./types.js";

// Pure-function tests only — this file imports nothing that transitively reaches
// db.ts, so it runs without DATABASE_URL/TEST_DATABASE_URL configured.

function msg(content: string, overrides: Partial<MessageEvent> = {}): MessageEvent {
  return {
    guildId: "g1", channelId: "c1", messageId: `m-${Math.random().toString(36).slice(2)}`,
    authorId: "u-author", authorName: "Alice",
    content, createdAt: new Date(), mentionsBot: false,
    ...overrides,
  };
}

function alias(entries: Array<[string, string]>): AliasMap {
  return new Map(entries.map(([k, v]) => [k.toLowerCase(), v]));
}

test("resolveSubject passes through <@ID> mentions and raw IDs", () => {
  const event = msg("hi");
  assert.equal(resolveSubject({ subjectId: "<@123456789012345>" }, alias([]), event), "123456789012345");
  assert.equal(resolveSubject({ subjectId: "123456789012345" }, alias([]), event), "123456789012345");
});

test("resolveSubject resolves a written name via the alias map", () => {
  const map = alias([["Nova", "u-nova"]]);
  assert.equal(resolveSubject({ subjectId: "unknown", subjectName: "Nova" }, map, msg("Nova is a Buddhist")), "u-nova");
  assert.equal(resolveSubject({ subjectName: "nova" }, map, msg("x")), "u-nova");
});

test("resolveSubject resolves self-referential names to the author", () => {
  assert.equal(resolveSubject({ subjectName: "alice" }, alias([]), msg("i love tea")), "u-author");
});

test("resolveSubject returns unknown for unresolvable names and preserves server", () => {
  const map = alias([["Tom", "u-tom"]]);
  assert.equal(resolveSubject({ subjectId: "unknown", subjectName: "Nobody" }, map, msg("x")), "unknown");
  assert.equal(resolveSubject({ subjectId: "server" }, map, msg("x")), "server");
});

test("findMentionedUsers matches longest names first and respects word boundaries", () => {
  const map = alias([["ri", "u-ri"], ["riley", "u-riley"], ["tom", "u-tom"]]);
  // "ri" must not match inside "riley"
  assert.deepEqual(findMentionedUsers("riley won again", map), ["u-riley"]);
  assert.deepEqual(findMentionedUsers("ri and tom are here", map).sort(), ["u-ri", "u-tom"]);
  assert.deepEqual(findMentionedUsers("nobody mentioned", map), []);
});

test("findMentionedUsers: a longer alias wins over a different user's prefix-word alias", () => {
  // "al" is one member's nickname; "al smith" is a different member's name.
  // The combined pattern consumes the longest match at each position, so only
  // Al Smith is flagged — the text almost certainly refers to them, not also
  // to whoever happens to be nicknamed "al".
  const map = alias([["al", "u-al"], ["al smith", "u-alsmith"]]);
  assert.deepEqual(findMentionedUsers("al smith is here", map), ["u-alsmith"]);
  // A standalone "al" elsewhere in the text still resolves to the nickname owner.
  assert.deepEqual(findMentionedUsers("al smith and al talked", map).sort(), ["u-al", "u-alsmith"]);
});

test("aliasKeyVariants expands nicknames: tokens ≥4 and first-token prefixes ≥4", () => {
  assert.deepEqual(aliasKeyVariants("zephyrine").sort(),
    ["zeph", "zephy", "zephyr", "zephyri", "zephyrin", "zephyrine"].sort());
  // Multi-token: full name + each long token + first-token prefixes
  assert.deepEqual(aliasKeyVariants("Nova is a Buddhist").sort(),
    ["Nova is a Buddhist", "Nova", "Buddhist"].sort());
  // Short names get no variants
  assert.deepEqual(aliasKeyVariants("al"), ["al"]);
  assert.deepEqual(aliasKeyVariants("  "), []);
});

// ── Mention sanitization ──────────────────────────────────────────────────────

test("demangleMentions resolves <@id> tokens to display names for prompt context", () => {
  const names = new Map([["123", "Alice"], ["999", "ASB"]]);
  assert.equal(demangleMentions("<@123> told <@999> hi", names), "@Alice told @ASB hi");
  assert.equal(demangleMentions("<@!123> legacy nick format", names), "@Alice legacy nick format");
  assert.equal(demangleMentions("hi <@456>", names), "hi @member"); // unresolved id
});

test("scrubMentions maps known ids to plain @Name and strips hallucinated ids", () => {
  const names = new Map([["123", "Alice"]]);
  assert.equal(scrubMentions("Hey <@123>!", names), "Hey @Alice!");
  // A fabricated snowflake resolves to nothing — strip it, don't ping a stranger.
  assert.equal(scrubMentions("Hey <@1549171765056638>! Glad you're here", names), "Hey! Glad you're here");
  assert.equal(scrubMentions("plain text stays", names), "plain text stays");
});

test("scrubMentions defuses mass-ping vectors in model output", () => {
  const names = new Map([["123", "Alice"]]);
  // @everyone/@here lose the @ so they can't ping even without allowedMentions.
  assert.equal(scrubMentions("hey @everyone look", names), "hey everyone look");
  assert.equal(scrubMentions("ping @here now", names), "ping here now");
  // Role mentions are stripped entirely — the bot has no business pinging roles.
  assert.equal(scrubMentions("hi <@&987654321> folks", names), "hi folks");
  assert.equal(scrubMentions("<@&123>", names), "");
  // Mixed with real mentions — user mentions still render as plain names.
  assert.equal(scrubMentions("yo <@123> and @everyone", names), "yo @Alice and everyone");
});
