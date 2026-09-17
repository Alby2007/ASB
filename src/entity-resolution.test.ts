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
  const map = alias([["Starz", "u-starz"]]);
  assert.equal(resolveSubject({ subjectId: "unknown", subjectName: "Starz" }, map, msg("Starz is a Muslim")), "u-starz");
  assert.equal(resolveSubject({ subjectName: "starz" }, map, msg("x")), "u-starz");
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
  const map = alias([["al", "u-al"], ["alby", "u-alby"], ["tom", "u-tom"]]);
  // "al" must not match inside "alby"
  assert.deepEqual(findMentionedUsers("alby won again", map), ["u-alby"]);
  assert.deepEqual(findMentionedUsers("al and tom are here", map).sort(), ["u-al", "u-tom"]);
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
  assert.deepEqual(aliasKeyVariants("paarthurnax").sort(),
    ["paar", "paart", "paarth", "paarthu", "paarthur", "paarthurn", "paarthurna", "paarthurnax"].sort());
  // Multi-token: full name + each long token + first-token prefixes
  assert.deepEqual(aliasKeyVariants("Starz is a Muslim").sort(),
    ["Starz is a Muslim", "Starz", "Muslim", "Star"].sort());
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
