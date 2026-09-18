import { createHash } from "node:crypto";
import type { Sql } from "./db.js";
import type { AttributeProposal, AttributeStatus, MemoryStatus, ProfileAttribute } from "./types.js";

// ── Polarity (moved from database.ts — both modules need it) ──────────────────
// Product of polarity-charged tokens; neutral content returns +1. A rephrased
// value landing on the opposite side of an antonym/negation pair contradicts
// the matched row and must never fold into it.
export const POLARITY_WORDS: Record<string, 1 | -1> = {
  love: 1, loves: 1, loved: 1, loving: 1,
  hate: -1, hates: -1, hated: -1, hating: -1,
  like: 1, likes: 1, liked: 1,
  dislike: -1, dislikes: -1, disliked: -1,
  enjoy: 1, enjoys: 1, enjoyed: 1,
  prefer: 1, prefers: 1, preferred: 1,
  want: 1, wants: 1, wanted: 1,
  support: 1, supports: 1, supported: 1, supporting: 1,
  oppose: -1, opposes: -1, opposed: -1,
  against: -1,
  can: 1, cant: -1, cannot: -1, "can't": -1,
  do: 1, does: 1, dont: -1, "don't": -1, doesnt: -1, "doesn't": -1, didnt: -1, "didn't": -1,
  will: 1, wont: -1, "won't": -1,
  is: 1, am: 1, are: 1, was: 1, were: 1,
  isnt: -1, "isn't": -1, arent: -1, "aren't": -1, wasnt: -1, "wasn't": -1, werent: -1, "weren't": -1,
  never: -1, not: -1, no: -1,
};

/** Product of polarity-charged tokens; neutral content returns +1. */
export function contentPolarity(content: string): 1 | -1 {
  let polarity: 1 | -1 = 1;
  for (const token of content.toLowerCase().match(/[a-z']+/g) ?? []) {
    const p = POLARITY_WORDS[token];
    if (p) polarity = (polarity * p) as 1 | -1;
  }
  return polarity;
}

// ── Field taxonomy ───────────────────────────────────────────────────────────
// Capped at eight. Singular fields hold one live value; new values supersede.
// Multi-valued fields accumulate. Deliberately absent: preferred_name (owned
// by known_names), relationships (owned by edges), preference (folded into
// interest), and any open-ended field — a closed set keeps facets enumerable.

export const SINGULAR_FIELDS = new Set(["pronouns", "timezone", "location", "occupation", "birthday"]);
export const MULTI_FIELDS = new Set(["trait", "interest", "skill"]);
export const KNOWN_FIELDS = new Set([...SINGULAR_FIELDS, ...MULTI_FIELDS]);

const TRIGRAM_FOLD_THRESHOLD = 0.6;
const TRIGRAM_NEAR_MISS_THRESHOLD = 0.4;

// ── Pure functions ────────────────────────────────────────────────────────────

/** Unique-key normalisation: case/whitespace variants can't produce siblings. */
export function normalizeValue(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Attribute status is a pure function of superseded_by + cited-memory statuses
 * — never set independently. superseded_by is the only asserted input: a row
 * can be superseded while its evidence is still live (singular-field change,
 * LLM `replaces`). Memory vocabulary is reused; 'candidate'-only and
 * quarantined-only provenance resolve to 'forgotten' — nothing renders a facet
 * that no live memory supports.
 */
export function deriveAttributeStatus(supersededBy: number | null, citedStatuses: MemoryStatus[]): AttributeStatus {
  if (supersededBy != null) return "superseded";
  if (citedStatuses.length === 0) return "forgotten";
  if (citedStatuses.includes("contested")) return "contested";
  if (citedStatuses.includes("active")) return "active";
  if (citedStatuses.includes("superseded")) return "superseded";
  return "forgotten";
}

// ── Deterministic extractors ─────────────────────────────────────────────────
// Conservative patterns on memory content — misses leave fields absent, which
// is never wrong. "Is a Muslim" must not become an occupation, so bare
// copula patterns are deliberately excluded.

const DETERMINISTIC_PATTERNS: Array<{ field: string; pattern: RegExp; group?: number }> = [
  { field: "timezone",  pattern: /\b(?:time ?zone|tz)\s*(?:is|=|:)?\s*([a-z]{2,5}(?:\s*[+-]\s*\d{1,2})?|gmt|utc)\b/i },
  { field: "timezone",  pattern: /\b(?:in|is)\s+(gmt|utc)\s*([+-]\s*\d{1,2})?\b/i },
  { field: "pronouns",  pattern: /\b(?:pronouns?\s*(?:are|is|:)|goes by|uses?)\s*(he\/him|she\/her|they\/them|he|she|they)\b/i },
  { field: "location",  pattern: /\b(?:[Ll]iv(?:es?|ed?)|[Ii]s|[Bb]ased|[Mm]oved|[Ll]ocated)\s+(?:in|from|to)\s+([A-Z][A-Za-z' .-]{1,40})/ },
  { field: "occupation", pattern: /\b(?:works? as|works? in|job is|occupation is|studies|studying)\s+([a-z][a-z '/-]{1,50})/i },
  { field: "birthday",  pattern: /\b(?:birthday|b-?day|born on)\s*(?:is|on|:)?\s*([a-z]+ \d{1,2}(?:st|nd|rd|th)?|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)/i },
];

const POSITIVE_PREF = /^(?:loves?|likes?|enjoys?|is into|really into|big fan of)\s+(.{2,60})/i;
const NEGATIVE_PREF = /^(?:hates?|dislikes?|can't stand|cannot stand|despises?)\s+(.{2,60})/i;

/**
 * Derive attribute proposals from a single active memory's content. Only
 * person_fact / person_preference kinds map to facets — episodes are events,
 * server_lore isn't person-scoped.
 */
export function extractDeterministic(memory: { id: number; kind: string; content: string }): AttributeProposal[] {
  const out: AttributeProposal[] = [];
  if (memory.kind === "person_fact") {
    for (const { field, pattern } of DETERMINISTIC_PATTERNS) {
      const m = memory.content.match(pattern);
      if (m?.[1]) {
        const value = m[2] ? `${m[1]}${m[2]}`.replace(/\s+/g, "") : m[1].trim();
        if (value.length >= 2) out.push({ field, value, memoryIds: [memory.id] });
      }
    }
  } else if (memory.kind === "person_preference") {
    const pos = memory.content.match(POSITIVE_PREF);
    if (pos?.[1]) out.push({ field: "interest", value: pos[1].trim().replace(/[.!]+$/, ""), memoryIds: [memory.id] });
    else {
      // Negative preferences keep the full clause — polarity lives in the value.
      const neg = memory.content.match(NEGATIVE_PREF);
      if (neg) out.push({ field: "interest", value: memory.content.trim().replace(/[.!]+$/, ""), memoryIds: [memory.id] });
    }
  }
  return out;
}

// ── Row mapping ───────────────────────────────────────────────────────────────

type AttributeRow = {
  id: number | string; guild_id: string; subject_id: string;
  field: string; value: string; value_norm: string;
  confidence: number; memory_ids: Array<number | string>;
  status: string; superseded_by: number | string | null;
  first_seen_at: Date | string; last_seen_at: Date | string;
};

function rowToAttribute(r: AttributeRow): ProfileAttribute {
  const ts = (d: Date | string) => (d instanceof Date ? d.toISOString() : d);
  return {
    id: Number(r.id), guildId: r.guild_id, subjectId: r.subject_id,
    field: r.field, value: r.value, valueNorm: r.value_norm,
    confidence: r.confidence, memoryIds: r.memory_ids.map(Number),
    status: r.status as AttributeStatus,
    supersededBy: r.superseded_by == null ? null : Number(r.superseded_by),
    firstSeenAt: ts(r.first_seen_at), lastSeenAt: ts(r.last_seen_at),
  };
}

// ── Status/confidence recompute ───────────────────────────────────────────────

/** Recompute one row's status + confidence from its live cited memories. */
async function recomputeRow(sql: Sql, rowId: number, memoryIds: number[], supersededBy: number | null): Promise<void> {
  const mems = memoryIds.length
    ? await sql<Array<{ id: number | string; status: string; confidence: number }>>`
        SELECT id, status, confidence FROM memories WHERE id = ANY(${memoryIds})
      `
    : [];
  const status = deriveAttributeStatus(supersededBy, mems.map(m => m.status as MemoryStatus));
  const live = mems.filter(m => m.status === "active" || m.status === "contested");
  const confidence = live.length ? Math.max(...live.map(m => m.confidence)) : 0;
  await sql`
    UPDATE profile_attributes
    SET status = ${status}, confidence = ${confidence}, superseded_by = ${supersededBy},
        memory_ids = ${memoryIds}, last_seen_at = NOW()
    WHERE id = ${rowId}
  `;
}

// ── The upsert-diff — the continuity mechanism ───────────────────────────────
// For each proposal: exact match (any status) → fold near-dup (polarity-gated)
// → insert. Singular fields supersede sibling live rows. `replaces` supersedes
// the named row. Rows are only written when something actually changed — an
// unchanged proposal is a no-op, which is what makes "same memories → zero
// writes" hold.

export async function applyProposals(
  sql: Sql,
  guildId: string,
  subjectId: string,
  proposals: AttributeProposal[]
): Promise<{ inserted: number; folded: number; revived: number; superseded: number }> {
  // One transaction per call — a mid-loop failure must not leave a
  // half-applied proposal set behind.
  return await sql.begin(async tx => applyProposalsTx(tx, guildId, subjectId, proposals));
}

async function applyProposalsTx(
  sql: Sql,
  guildId: string,
  subjectId: string,
  proposals: AttributeProposal[]
): Promise<{ inserted: number; folded: number; revived: number; superseded: number }> {
  let inserted = 0, folded = 0, revived = 0, superseded = 0;

  for (const proposal of proposals) {
    if (!KNOWN_FIELDS.has(proposal.field)) continue;
    const valueNorm = normalizeValue(proposal.value);
    if (valueNorm.length < 2) continue;
    const ids = [...new Set(proposal.memoryIds)];
    if (ids.length === 0) continue;

    let targetId: number;

    // 1. Exact match on the unique key — any status (re-citation revives).
    const exact = await sql<AttributeRow[]>`
      SELECT * FROM profile_attributes
      WHERE guild_id = ${guildId} AND subject_id = ${subjectId}
        AND field = ${proposal.field} AND value_norm = ${valueNorm}
    `;

    if (exact[0]) {
      const row = exact[0];
      targetId = Number(row.id);
      const merged = [...new Set([...row.memory_ids.map(Number), ...ids])];
      const wasDead = row.superseded_by != null || row.status !== "active";
      const changed = merged.length !== row.memory_ids.length || row.superseded_by != null;
      if (changed) {
        await recomputeRow(sql, targetId, merged, null);
        if (wasDead) revived++;
      }
      // No change → no write. Continuity requires this to be a no-op.
    } else {
      // 2. Trigram fold within (guild, subject, field) — polarity-gated, any status.
      const sim = await sql<Array<{ id: number | string; sim: number; value: string }>>`
        SELECT id, value, similarity(value_norm, ${valueNorm}) AS sim
        FROM profile_attributes
        WHERE guild_id = ${guildId} AND subject_id = ${subjectId} AND field = ${proposal.field}
        ORDER BY sim DESC, id ASC
        LIMIT 1
      `;
      const near = sim[0];
      const polarityOk = near ? contentPolarity(near.value) === contentPolarity(proposal.value) : false;

      if (near && near.sim >= TRIGRAM_FOLD_THRESHOLD && polarityOk) {
        targetId = Number(near.id);
        const rows = await sql<AttributeRow[]>`SELECT * FROM profile_attributes WHERE id = ${targetId}`;
        const merged = [...new Set([...rows[0].memory_ids.map(Number), ...ids])];
        await recomputeRow(sql, targetId, merged, null);
        folded++;
        if (rows[0].status !== "active" || rows[0].superseded_by != null) revived++;
      } else {
        if (near && near.sim >= TRIGRAM_NEAR_MISS_THRESHOLD && ids[0]) {
          // Threshold-tuning audit, same idea as dedup_near_miss.
          await sql`
            INSERT INTO memory_history (memory_id, action, details_json)
            VALUES (${ids[0]}, 'attr_near_miss', ${JSON.stringify({ similarity: near.sim, existingAttributeId: Number(near.id), proposedValue: proposal.value, existingValue: near.value })})
          `;
        }
        // 3. Insert — compute status/confidence from cited memories up front;
        // dead-on-arrival proposals (e.g. candidate-only) are not stored.
        const mems = await sql<Array<{ status: string; confidence: number }>>`
          SELECT status, confidence FROM memories WHERE id = ANY(${ids})
        `;
        const status = deriveAttributeStatus(null, mems.map(m => m.status as MemoryStatus));
        if (status === "forgotten" || status === "superseded") continue; // dead-on-arrival — don't store
        const live = mems.filter(m => m.status === "active" || m.status === "contested");
        const confidence = live.length ? Math.max(...live.map(m => m.confidence)) : 0;
        const ins = await sql<[{ id: number | string }]>`
          INSERT INTO profile_attributes (guild_id, subject_id, field, value, value_norm, confidence, memory_ids, status)
          VALUES (${guildId}, ${subjectId}, ${proposal.field}, ${proposal.value.trim()}, ${valueNorm}, ${confidence}, ${ids}, ${status})
          RETURNING id
        `;
        targetId = Number(ins[0].id);
        inserted++;
      }
    }

    // 4. Explicit replacement (multi-valued fields): the LLM says this label
    // supersedes an existing one — mark it via superseded_by.
    if (proposal.replaces) {
      const repNorm = normalizeValue(proposal.replaces);
      const rep = await sql`
        UPDATE profile_attributes
        SET superseded_by = ${targetId}, status = 'superseded', last_seen_at = NOW()
        WHERE guild_id = ${guildId} AND subject_id = ${subjectId}
          AND field = ${proposal.field} AND value_norm = ${repNorm} AND id != ${targetId}
      `;
      superseded += rep.count;
    }

    // 5. Singular fields hold one live value — every other live row in the
    // field is superseded by the row that just landed.
    if (SINGULAR_FIELDS.has(proposal.field)) {
      const sup = await sql`
        UPDATE profile_attributes
        SET superseded_by = ${targetId}, status = 'superseded', last_seen_at = NOW()
        WHERE guild_id = ${guildId} AND subject_id = ${subjectId}
          AND field = ${proposal.field} AND id != ${targetId}
          AND status IN ('active', 'contested')
      `;
      superseded += sup.count;
    }
  }

  return { inserted, folded, revived, superseded };
}

// ── Cascades — the write-path side of provenance ─────────────────────────────

/**
 * Memory statuses changed: strip dead citations (forgotten/superseded — live
 * status changes keep their citation and only recompute), then recompute
 * confidence + status per row. Called inside the mutation's transaction.
 */
export async function recomputeForMemories(sql: Sql, guildId: string, memoryIds: number[]): Promise<void> {
  if (memoryIds.length === 0) return;
  const rows = await sql<AttributeRow[]>`
    SELECT * FROM profile_attributes WHERE guild_id = ${guildId} AND memory_ids && ${memoryIds}
  `;
  for (const row of rows) {
    const cited = row.memory_ids.map(Number).filter(id => memoryIds.includes(id));
    if (!cited.length) continue;
    const statuses = await sql<Array<{ id: number | string; status: string }>>`
      SELECT id, status FROM memories WHERE id = ANY(${cited})
    `;
    const dead = new Set(statuses.filter(s => s.status === "forgotten" || s.status === "superseded").map(s => Number(s.id)));
    const surviving = row.memory_ids.map(Number).filter(id => !dead.has(id));
    await recomputeRow(sql, Number(row.id), surviving, row.superseded_by == null ? null : Number(row.superseded_by));
  }
}

/**
 * A memory was superseded by/merged into a canonical row: citing attributes
 * swap the dead id for the canonical one (set-union — the canonical may
 * already be cited), then recompute.
 */
export async function transferProvenance(sql: Sql, guildId: string, fromId: number, toId: number): Promise<void> {
  const rows = await sql<AttributeRow[]>`
    SELECT * FROM profile_attributes WHERE guild_id = ${guildId} AND ${fromId} = ANY(memory_ids)
  `;
  for (const row of rows) {
    const merged = [...new Set([...row.memory_ids.map(Number).filter(id => id !== fromId), toId])];
    await recomputeRow(sql, Number(row.id), merged, row.superseded_by == null ? null : Number(row.superseded_by));
  }
}

// ── Reads ─────────────────────────────────────────────────────────────────────

export async function listAttributes(sql: Sql, guildId: string, subjectId: string, opts: { status?: AttributeStatus } = {}): Promise<ProfileAttribute[]> {
  const rows = opts.status
    ? await sql<AttributeRow[]>`SELECT * FROM profile_attributes WHERE guild_id = ${guildId} AND subject_id = ${subjectId} AND status = ${opts.status} ORDER BY field, id`
    : await sql<AttributeRow[]>`SELECT * FROM profile_attributes WHERE guild_id = ${guildId} AND subject_id = ${subjectId} ORDER BY field, id`;
  return rows.map(rowToAttribute);
}

/** Batch variant of listAttributes keyed by subject — the reply path fetches
 * facets for every in-prompt person in one round trip. */
export async function listAttributesForSubjects(sql: Sql, guildId: string, subjectIds: string[], opts: { status?: AttributeStatus } = {}): Promise<Map<string, ProfileAttribute[]>> {
  const out = new Map<string, ProfileAttribute[]>();
  if (subjectIds.length === 0) return out;
  const rows = opts.status
    ? await sql<AttributeRow[]>`SELECT * FROM profile_attributes WHERE guild_id = ${guildId} AND subject_id = ANY(${subjectIds}) AND status = ${opts.status} ORDER BY subject_id, field, id`
    : await sql<AttributeRow[]>`SELECT * FROM profile_attributes WHERE guild_id = ${guildId} AND subject_id = ANY(${subjectIds}) ORDER BY subject_id, field, id`;
  for (const r of rows) {
    const attr = rowToAttribute(r);
    const list = out.get(attr.subjectId);
    if (list) list.push(attr); else out.set(attr.subjectId, [attr]);
  }
  return out;
}

/** Guild-wide contested rows — the admin triage surface: a stored facet whose
 * evidence is currently disputed. */
export async function listContestedAttributes(sql: Sql, guildId: string, limit = 10): Promise<ProfileAttribute[]> {
  const rows = await sql<AttributeRow[]>`
    SELECT * FROM profile_attributes
    WHERE guild_id = ${guildId} AND status = 'contested'
    ORDER BY last_seen_at DESC LIMIT ${limit}
  `;
  return rows.map(rowToAttribute);
}

/**
 * Fingerprint of the render inputs: the live attribute set plus the context
 * that feeds the bio (stats, patterns, edges, events). Raw activity churn
 * (message counts, timestamps) is deliberately excluded — a bio re-renders
 * when something *means* something changed, not on every message.
 */
export function attributeHash(attrs: ProfileAttribute[], context: string[]): string {
  const parts = [
    ...attrs
      .filter(a => a.status === "active")
      .map(a => `a:${a.field}:${a.valueNorm}:${a.status}:${a.confidence.toFixed(3)}:${[...a.memoryIds].sort((x, y) => x - y).join(",")}`),
    ...context,
  ].sort();
  return createHash("sha256").update(parts.join("|")).digest("hex");
}

/** Opt-out purge: attributes are pure derived data — deleted, not forgotten. */
export async function deleteForSubject(sql: Sql, guildId: string, subjectId: string): Promise<number> {
  const result = await sql`DELETE FROM profile_attributes WHERE guild_id = ${guildId} AND subject_id = ${subjectId}`;
  return result.count;
}
