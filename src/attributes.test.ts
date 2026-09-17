import assert from "node:assert/strict";
import test from "node:test";
import {
  KNOWN_FIELDS, SINGULAR_FIELDS, contentPolarity, deriveAttributeStatus,
  extractDeterministic, normalizeValue,
} from "./attributes.js";

// ── Pure-function coverage for the attribute pipeline — DB-free per the
// entity-resolution.test.ts precedent. Diff/cascade behaviour lives in
// profiles.test.ts against the real test database. ──────────────────────────

test("normalizeValue folds case and whitespace into the unique key", () => {
  assert.equal(normalizeValue("  Dry  Humor "), "dry humor");
  assert.equal(normalizeValue("GMT + 1"), "gmt + 1");
  assert.equal(normalizeValue("\tFoo\nBar"), "foo bar");
});

test("deriveAttributeStatus: superseded_by is the only asserted input", () => {
  assert.equal(deriveAttributeStatus(5, ["active"]), "superseded");
  assert.equal(deriveAttributeStatus(5, []), "superseded");
  // Even with live evidence, an asserted supersession wins — a singular field
  // moved on while its memories are still true.
  assert.equal(deriveAttributeStatus(9, ["active", "contested"]), "superseded");
});

test("deriveAttributeStatus: empty or all-forgotten provenance → forgotten", () => {
  assert.equal(deriveAttributeStatus(null, []), "forgotten");
  assert.equal(deriveAttributeStatus(null, ["forgotten"]), "forgotten");
});

test("deriveAttributeStatus: contested outranks active", () => {
  assert.equal(deriveAttributeStatus(null, ["active", "contested"]), "contested");
  assert.equal(deriveAttributeStatus(null, ["contested", "forgotten"]), "contested");
});

test("deriveAttributeStatus: any live citation keeps the row active", () => {
  assert.equal(deriveAttributeStatus(null, ["active"]), "active");
  assert.equal(deriveAttributeStatus(null, ["forgotten", "active"]), "active");
  assert.equal(deriveAttributeStatus(null, ["superseded", "active"]), "active");
});

test("deriveAttributeStatus: the dead-mix and candidate holes the spec missed", () => {
  // {forgotten + superseded}: neither "all forgotten" nor "all superseded" —
  // must not fall through to active.
  assert.notEqual(deriveAttributeStatus(null, ["forgotten", "superseded"]), "active");
  assert.equal(deriveAttributeStatus(null, ["forgotten", "superseded"]), "superseded");
  // Candidate-only and quarantined-only provenance can't support a live facet.
  assert.equal(deriveAttributeStatus(null, ["candidate"]), "forgotten");
  assert.equal(deriveAttributeStatus(null, ["quarantined"]), "forgotten");
  // All-superseded → superseded (the facet was replaced, not deleted).
  assert.equal(deriveAttributeStatus(null, ["superseded", "superseded"]), "superseded");
});

test("SINGULAR_FIELDS classification covers the eight-field cap", () => {
  for (const f of ["pronouns", "timezone", "location", "occupation", "birthday"]) {
    assert.ok(SINGULAR_FIELDS.has(f), f);
  }
  for (const f of ["trait", "interest", "skill"]) {
    assert.ok(KNOWN_FIELDS.has(f) && !SINGULAR_FIELDS.has(f), f);
  }
  assert.equal(KNOWN_FIELDS.size, 8);
  // Fields deliberately not modelled here.
  for (const f of ["preferred_name", "relationship", "preference"]) {
    assert.ok(!KNOWN_FIELDS.has(f), f);
  }
});

test("extractDeterministic: person_fact patterns", () => {
  const fields = (content: string) =>
    extractDeterministic({ id: 1, kind: "person_fact", content }).map(p => `${p.field}=${p.value}`);
  assert.ok(fields("Lives in Leeds").includes("location=Leeds"));
  assert.ok(fields("My timezone is GMT+1").some(f => f.startsWith("timezone=")));
  assert.ok(fields("Pronouns are she/her").includes("pronouns=she/her"));
  assert.ok(fields("Works as a nurse").includes("occupation=a nurse"));
  assert.ok(fields("Birthday is March 4th").includes("birthday=March 4th"));
  // Bare copula must NOT produce an occupation — sensitive self-descriptions
  // aren't jobs.
  assert.equal(fields("Is a Muslim").length, 0);
  assert.equal(fields("Has a cat named Jinx").length, 0);
});

test("extractDeterministic: person_preference maps to interest, negatives keep polarity", () => {
  const pos = extractDeterministic({ id: 1, kind: "person_preference", content: "Loves horror films" });
  assert.deepEqual(pos.map(p => p.field), ["interest"]);
  assert.equal(pos[0].value, "horror films");

  const neg = extractDeterministic({ id: 1, kind: "person_preference", content: "Dislikes horror films" });
  assert.deepEqual(neg.map(p => p.field), ["interest"]);
  // Full clause retained so contentPolarity can tell it apart from the positive.
  assert.equal(neg[0].value, "Dislikes horror films");
  assert.notEqual(contentPolarity(neg[0].value), contentPolarity(pos[0].value));
});

test("extractDeterministic: episodes and lore produce nothing", () => {
  assert.equal(extractDeterministic({ id: 1, kind: "episode", content: "Lives in Leeds" }).length, 0);
  assert.equal(extractDeterministic({ id: 1, kind: "server_lore", content: "Works as a nurse" }).length, 0);
});

test("contentPolarity: opposite pairs disagree, neutral is positive", () => {
  assert.equal(contentPolarity("likes horror films"), 1);
  assert.equal(contentPolarity("dislikes horror films"), -1);
  assert.equal(contentPolarity("isn't ready"), -1);
  assert.equal(contentPolarity("is ready"), 1);
  assert.equal(contentPolarity("some neutral statement"), 1);
});
