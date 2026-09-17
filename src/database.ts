import type { EvidenceEffect, EvidenceType, Member, MemoryCandidate, MemoryStatus, MessageEvent, RelationshipEdge, VerificationVerdict } from "./types.js";
import { sql as defaultSql, type Sql } from "./db.js";
import { runMigrations } from "./migrations.js";
import { findMentionedUsers } from "./entity-resolution.js";
import { calculateInitialConfidence, updateConfidence, calculateDefaultImportance, calculateDefaultExplicitness } from "./confidence.js";

export type Memory = Omit<MemoryCandidate, "confidence" | "importance" | "explicitness"> & {
  // DB columns are NOT NULL, so these are always present on a persisted Memory.
  confidence: number;
  importance: number;
  explicitness: number;
  id: number; guildId: string; status: MemoryStatus; mentions: number;
  createdAt: string; updatedAt: string; lastConfirmedAt: string; lastContradictedAt: string | null;
  confirmationCount: number; contradictionCount: number; supersededBy: number | null; supersedesMemoryId: number | null;
  // Phase 1C additions (nullable — populated once contested or pattern-linked).
  netScore: number | null; frozenConfidence: number | null; patternId: number | null;
  // The evidence type of the first piece of evidence that created this memory. Used by the bulk
  // promotion path in maintain() to enforce the same gate as the per-insert promotableTypes check.
  primaryEvidenceType: string;
  // v0.2 — nullable FK to the event this memory was generated from or linked to.
  eventId: number | null;
  // v0.2 — display name of the subject at the time the memory was created.
  subjectName: string;
};
export type BehavioralPattern = { id: number; guildId: string; subjectId: string; description: string; episodeCount: number; confidence: number; createdAt: string; updatedAt: string; status: string };
export type MemoryEvidence = { id: number; memoryId: number; messageId: string; authorId: string; quote: string; reason: string; explicitness: number; observedAt: string; evidenceType: string; effect: string; messageContentSnapshot: string; messageTimestamp: string; createdAt: string };
export type MemoryHistory = { id: number; memoryId: number; action: string; previousConfidence: number | null; newConfidence: number | null; previousStatus: MemoryStatus | null; newStatus: MemoryStatus | null; evidenceId: number | null; detailsJson: string; createdAt: string };

// ── Row types returned by Postgres ────────────────────────────────────────────

type MemoryRow = {
  id: number; guild_id: string; subject_id: string; subject_name: string;
  kind: string; content: string; confidence: number; importance: number;
  mentions: number; confirmation_count: number; contradiction_count: number;
  created_at: Date | string; updated_at: Date | string;
  last_confirmed_at: Date | string; last_contradicted_at: Date | string | null;
  status: string; superseded_by: number | null; supersedes_memory_id: number | null;
  explicitness: number; reason: string; net_score: number | null;
  frozen_confidence: number | null; pattern_id: number | null;
  primary_evidence_type: string; event_id: number | null;
};

type EvidenceRow = {
  id: number; memory_id: number; message_id: string; author_id: string;
  quote: string; reason: string; explicitness: number;
  observed_at: Date | string; evidence_type: string; effect: string;
  message_content_snapshot: string; message_timestamp: Date | string; created_at: Date | string;
};

type HistoryRow = {
  id: number; memory_id: number; action: string;
  previous_confidence: number | null; new_confidence: number | null;
  previous_status: string | null; new_status: string | null;
  evidence_id: number | null; details_json: string; created_at: Date | string;
};

type MessageRow = {
  id: string; guild_id: string; channel_id: string; author_id: string;
  author_name: string; content: string; created_at: Date | string;
};

type SettingsRow = { guild_id: string; memory_enabled: number; reply_enabled: number; raw_retention_days: number };

type MemberRow = {
  guild_id: string; user_id: string; known_names: string[];
  first_seen_at: Date | string; last_seen_at: Date | string;
  message_count: number; opted_out: number;
};

type RelationshipRow = {
  id: number; guild_id: string; subject_id: string; other_id: string;
  summary: string; valence: number | null; observation_count: number;
  last_observed_at: Date | string | null; updated_at: Date | string;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function ts(d: Date | string): string {
  return d instanceof Date ? d.toISOString() : d;
}

function rowToMember(r: MemberRow): Member {
  return {
    guildId: r.guild_id, userId: r.user_id, knownNames: r.known_names ?? [],
    firstSeenAt: ts(r.first_seen_at), lastSeenAt: ts(r.last_seen_at),
    messageCount: Number(r.message_count), optedOut: Number(r.opted_out) === 1,
  };
}

function rowToMemory(r: MemoryRow): Memory {
  return {
    id: Number(r.id), guildId: r.guild_id, subjectId: r.subject_id, subjectName: r.subject_name,
    kind: r.kind as Memory["kind"], content: r.content, confidence: Number(r.confidence),
    importance: Number(r.importance), explicitness: Number(r.explicitness),
    mentions: Number(r.mentions), confirmationCount: Number(r.confirmation_count),
    contradictionCount: Number(r.contradiction_count),
    createdAt: ts(r.created_at), updatedAt: ts(r.updated_at),
    lastConfirmedAt: ts(r.last_confirmed_at),
    lastContradictedAt: r.last_contradicted_at ? ts(r.last_contradicted_at) : null,
    status: r.status as MemoryStatus,
    supersededBy: r.superseded_by != null ? Number(r.superseded_by) : null,
    supersedesMemoryId: r.supersedes_memory_id != null ? Number(r.supersedes_memory_id) : null,
    netScore: r.net_score != null ? Number(r.net_score) : null,
    frozenConfidence: r.frozen_confidence != null ? Number(r.frozen_confidence) : null,
    patternId: r.pattern_id != null ? Number(r.pattern_id) : null,
    primaryEvidenceType: r.primary_evidence_type,
    eventId: r.event_id != null ? Number(r.event_id) : null,
    reason: r.reason,
  };
}

// ── MemoryStore ───────────────────────────────────────────────────────────────

// pg_trgm similarity thresholds for near-duplicate dedup in saveMemory().
// ≥ MATCH: evidence attaches to the existing row. ≥ NEAR_MISS (but < MATCH): the
// new row is still created and a dedup_near_miss history entry records the score
// for threshold tuning.
const TRIGRAM_MATCH_THRESHOLD = 0.6;
const TRIGRAM_NEAR_MISS_THRESHOLD = 0.4;

// Only high-quality evidence types may promote a candidate to active — or ride the
// fuzzy-dedup fast-path. Sarcasm, rumour, and uncertain inferences are excluded
// regardless of confidence.
const PROMOTABLE_EVIDENCE_TYPES: EvidenceType[] = ["explicit_fact", "clear_preference", "correction"];

// Cheap polarity check for fuzzy-matched memories: a rephrased extraction whose
// content lands on the opposite side of an antonym/negation pair is a
// contradiction of the matched row, whatever effect the LLM labelled it.
const POLARITY_WORDS: Record<string, 1 | -1> = {
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
function contentPolarity(content: string): 1 | -1 {
  let polarity: 1 | -1 = 1;
  for (const token of content.toLowerCase().match(/[a-z']+/g) ?? []) {
    const p = POLARITY_WORDS[token];
    if (p) polarity = (polarity * p) as 1 | -1;
  }
  return polarity;
}

export class MemoryStore {
  private constructor(private sql: Sql) {}

  static async create(sql: Sql = defaultSql): Promise<MemoryStore> {
    await runMigrations(sql);
    return new MemoryStore(sql);
  }

  // ── Settings ───────────────────────────────────────────────────────────────

  private async ensureSettings(guildId: string, retentionDays = 30): Promise<void> {
    await this.sql`
      INSERT INTO server_settings (guild_id, raw_retention_days) VALUES (${guildId}, ${retentionDays})
      ON CONFLICT (guild_id) DO NOTHING
    `;
  }

  // settings() runs on every message, so it's cached per guild; setPaused is the
  // only writer and invalidates. The TTL bounds staleness from out-of-band edits.
  private settingsCache = new Map<string, { value: { guildId: string; memoryEnabled: number; replyEnabled: number; rawRetentionDays: number }; at: number }>();

  async settings(guildId: string, defaultRetentionDays = 30): Promise<{ guildId: string; memoryEnabled: number; replyEnabled: number; rawRetentionDays: number }> {
    const cached = this.settingsCache.get(guildId);
    if (cached && Date.now() - cached.at < 60_000) return cached.value;
    await this.ensureSettings(guildId, defaultRetentionDays);
    const rows = await this.sql<SettingsRow[]>`SELECT guild_id, memory_enabled, reply_enabled, raw_retention_days FROM server_settings WHERE guild_id = ${guildId}`;
    const r = rows[0];
    const value = { guildId: r.guild_id, memoryEnabled: Number(r.memory_enabled), replyEnabled: Number(r.reply_enabled), rawRetentionDays: Number(r.raw_retention_days) };
    this.settingsCache.set(guildId, { value, at: Date.now() });
    return value;
  }

  async setPaused(guildId: string, paused: boolean, defaultRetentionDays = 30): Promise<void> {
    await this.ensureSettings(guildId, defaultRetentionDays);
    const v = paused ? 0 : 1;
    await this.sql`UPDATE server_settings SET memory_enabled = ${v}, reply_enabled = ${v} WHERE guild_id = ${guildId}`;
    this.settingsCache.delete(guildId);
  }

  // ── Messages ───────────────────────────────────────────────────────────────

  async recordMessage(event: MessageEvent, replyToId?: string): Promise<void> {
    await this.sql`
      INSERT INTO messages (id, guild_id, channel_id, author_id, author_name, content, created_at, reply_to_id)
      VALUES (${event.messageId}, ${event.guildId}, ${event.channelId}, ${event.authorId}, ${event.authorName}, ${event.content}, ${event.createdAt.toISOString()}, ${replyToId ?? null})
      ON CONFLICT (id) DO UPDATE SET reply_to_id = COALESCE(messages.reply_to_id, EXCLUDED.reply_to_id)
    `;
    await this.upsertMember(event.guildId, event.authorId, event.authorName, event.createdAt);
  }

  // ── Members ────────────────────────────────────────────────────────────────
  // The members table is the member registry: one row per (guild, user) tracking every
  // display name observed, message counts, and first/last activity. It backs the
  // entity-resolution alias map and per-chatter profiles.

  async upsertMember(guildId: string, userId: string, displayName: string, at: Date): Promise<void> {
    await this.sql`
      INSERT INTO members (guild_id, user_id, known_names, first_seen_at, last_seen_at, message_count)
      VALUES (${guildId}, ${userId}, ${[displayName]}, ${at.toISOString()}, ${at.toISOString()}, 1)
      ON CONFLICT (guild_id, user_id) DO UPDATE SET
        known_names   = CASE WHEN ${displayName} = ANY(members.known_names) THEN members.known_names ELSE array_append(members.known_names, ${displayName}) END,
        first_seen_at = LEAST(members.first_seen_at, EXCLUDED.first_seen_at),
        last_seen_at  = GREATEST(members.last_seen_at, EXCLUDED.last_seen_at),
        message_count = members.message_count + 1
    `;
  }

  async getMember(guildId: string, userId: string): Promise<Member | undefined> {
    const rows = await this.sql<MemberRow[]>`SELECT * FROM members WHERE guild_id = ${guildId} AND user_id = ${userId}`;
    return rows[0] ? rowToMember(rows[0]) : undefined;
  }

  async listMembers(guildId: string): Promise<Member[]> {
    const rows = await this.sql<MemberRow[]>`SELECT * FROM members WHERE guild_id = ${guildId} ORDER BY message_count DESC`;
    return rows.map(rowToMember);
  }

  /** Fallback for rows archived before the members table existed (pre-v7). */
  async listAuthorNames(guildId: string): Promise<Array<{ authorId: string; authorName: string }>> {
    const rows = await this.sql<Array<{ author_id: string; author_name: string }>>`
      SELECT DISTINCT author_id, author_name FROM messages WHERE guild_id = ${guildId}
    `;
    return rows.map(r => ({ authorId: r.author_id, authorName: r.author_name }));
  }

  async setMemberOptOut(guildId: string, userId: string, optedOut: boolean): Promise<void> {
    // Upsert: a member who has never posted has no row yet, and opt-out must
    // still stick for when they do.
    await this.sql`
      INSERT INTO members (guild_id, user_id, known_names, first_seen_at, last_seen_at, message_count, opted_out)
      VALUES (${guildId}, ${userId}, '{}', NOW(), NOW(), 0, ${optedOut ? 1 : 0})
      ON CONFLICT (guild_id, user_id) DO UPDATE SET opted_out = ${optedOut ? 1 : 0}
    `;
  }

  /** Learn a new name for a member from evidence (self-naming, manual /alias).
   * Records provenance in alias_candidates and applies it to known_names so the
   * alias map resolves it from then on. Idempotent per evidence message. */
  async learnAlias(guildId: string, userId: string, name: string, source: string, messageId: string): Promise<boolean> {
    const clean = name.trim();
    if (!clean) return false;
    return await this.sql.begin(async sql => {
      const inserted = await sql`
        INSERT INTO alias_candidates (guild_id, user_id, name, source, evidence_message_id)
        VALUES (${guildId}, ${userId}, ${clean}, ${source}, ${messageId})
        ON CONFLICT (guild_id, user_id, name, evidence_message_id) DO NOTHING
        RETURNING id
      `;
      if (inserted.length === 0) return false;
      await sql`
        UPDATE members SET known_names = array_append(known_names, ${clean})
        WHERE guild_id = ${guildId} AND user_id = ${userId}
          AND NOT (LOWER(${clean}) = ANY(SELECT LOWER(x) FROM unnest(known_names) x))
      `;
      return true;
    });
  }

  /** Log a name that failed entity resolution — the discovery surface for
   * aliases self-naming can't catch and recurring non-member entities. */
  async logUnresolvedName(guildId: string, name: string, messageId: string): Promise<void> {
    const clean = name.trim();
    if (!clean) return;
    await this.sql`
      INSERT INTO unresolved_names (guild_id, name, message_id)
      VALUES (${guildId}, ${clean}, ${messageId})
      ON CONFLICT (guild_id, name, message_id) DO NOTHING
    `;
  }

  /** Unresolved names by frequency — candidates for alias learning or
   * external-entity modeling. */
  async unresolvedNames(guildId: string, limit = 30): Promise<Array<{ name: string; count: number }>> {
    const rows = await this.sql<Array<{ name: string; c: number }>>`
      SELECT name, COUNT(*)::int AS c FROM unresolved_names
      WHERE guild_id = ${guildId}
      GROUP BY name ORDER BY c DESC, name LIMIT ${limit}
    `;
    return rows.map(r => ({ name: r.name, count: r.c }));
  }

  /** Best current display name for a user: latest known name, else most recent message author_name. */
  async displayNameFor(guildId: string, userId: string): Promise<string> {
    const member = await this.getMember(guildId, userId);
    if (member && member.knownNames.length > 0) return member.knownNames[member.knownNames.length - 1];
    const rows = await this.sql<Array<{ author_name: string }>>`
      SELECT author_name FROM messages WHERE guild_id = ${guildId} AND author_id = ${userId} ORDER BY created_at DESC LIMIT 1
    `;
    return rows[0]?.author_name ?? userId;
  }

  // ── Relationships ──────────────────────────────────────────────────────────
  // Relationship assertions are stored as idempotent observations keyed by
  // (subject_id, other_id, message_id); each new observation rolls up into a
  // durable edge in `relationships` with a running-average valence.

  async recordRelationship(guildId: string, subjectId: string, otherId: string, messageId: string, nature: string, valence: number | null, reason = ""): Promise<boolean> {
    if (subjectId === otherId || subjectId === "unknown" || otherId === "unknown" || subjectId === "server" || otherId === "server") return false;
    return await this.sql.begin(async sql => {
      const inserted = await sql`
        INSERT INTO relationship_observations (guild_id, subject_id, other_id, message_id, nature, valence, reason)
        VALUES (${guildId}, ${subjectId}, ${otherId}, ${messageId}, ${nature}, ${valence}, ${reason})
        ON CONFLICT (subject_id, other_id, message_id) DO NOTHING
        RETURNING id
      `;
      if (inserted.length === 0) return false;
      await sql`
        INSERT INTO relationships (guild_id, subject_id, other_id, summary, valence, observation_count, last_observed_at, updated_at)
        VALUES (${guildId}, ${subjectId}, ${otherId}, ${nature}, ${valence}, 1, NOW(), NOW())
        ON CONFLICT (guild_id, subject_id, other_id) DO UPDATE SET
          summary           = EXCLUDED.summary,
          observation_count = relationships.observation_count + 1,
          valence           = CASE
            WHEN relationships.valence IS NULL THEN EXCLUDED.valence
            WHEN EXCLUDED.valence IS NULL THEN relationships.valence
            ELSE relationships.valence + (EXCLUDED.valence - relationships.valence) / (relationships.observation_count + 1)
          END,
          last_observed_at  = NOW(),
          updated_at        = NOW()
      `;
      return true;
    });
  }

  /** All edges where the subject is either side of the relationship, strongest first. */
  async relationshipsFor(guildId: string, subjectId: string): Promise<RelationshipEdge[]> {
    const rows = await this.sql<RelationshipRow[]>`
      SELECT id, guild_id, subject_id, other_id, summary, valence, observation_count, last_observed_at, updated_at
      FROM relationships
      WHERE guild_id = ${guildId} AND (subject_id = ${subjectId} OR other_id = ${subjectId})
      ORDER BY observation_count DESC
    `;
    return rows.map(r => ({
      id: Number(r.id), guildId: r.guild_id, subjectId: r.subject_id, otherId: r.other_id,
      summary: r.summary, valence: r.valence != null ? Number(r.valence) : null,
      observationCount: Number(r.observation_count),
      lastObservedAt: r.last_observed_at ? ts(r.last_observed_at) : null,
      updatedAt: ts(r.updated_at),
    }));
  }

  // ── Sincerity verification ─────────────────────────────────────────────────
  // Extraction can mislabel edgy humor as explicit_fact/clear_preference. A
  // second-pass LLM judgment against the stored source message gates promotion:
  // jokes are re-classified sarcasm_or_joke, verified literal self-reports go
  // active, and third-party literals stay candidate pending corroboration.

  /** Candidate memories with promotable evidence types, joined to their first source message.
   * Carries the author's known names and the messages preceding the source so the
   * verifier can spot pasted/quoted text and jokes that only read literal in isolation. */
  async listVerifiableCandidates(guildId: string, limit = 200): Promise<Array<{
    memoryId: number; subjectId: string; kind: Memory["kind"]; content: string;
    evidenceType: string; selfReport: boolean; authorName: string; authorNames: string[];
    sourceMessage: string; contextBefore: Array<{ authorName: string; content: string }>;
  }>> {
    const rows = await this.sql<Array<{
      memory_id: number; subject_id: string; kind: string; content: string;
      primary_evidence_type: string; self_report: boolean;
      author_name: string | null; author_names: string[] | null; source_message: string;
      channel_id: string | null; msg_created_at: Date | string | null;
    }>>`
      SELECT m.id AS memory_id, m.subject_id, m.kind, m.content, m.primary_evidence_type,
             (m.subject_id = e.author_id) AS self_report,
             msg.author_name, mem.known_names AS author_names,
             e.message_content_snapshot AS source_message,
             msg.channel_id, msg.created_at AS msg_created_at
      FROM memories m
      JOIN LATERAL (
        SELECT ev.author_id, ev.message_id, ev.message_content_snapshot
        FROM memory_evidence ev WHERE ev.memory_id = m.id ORDER BY ev.id LIMIT 1
      ) e ON true
      LEFT JOIN messages msg ON msg.id = e.message_id
      LEFT JOIN members mem ON mem.guild_id = m.guild_id AND mem.user_id = e.author_id
      WHERE m.guild_id = ${guildId} AND m.status = 'candidate'
        AND m.primary_evidence_type IN ('explicit_fact', 'clear_preference', 'correction')
      ORDER BY m.id
      LIMIT ${limit}
    `;
    return await Promise.all(rows.map(async r => {
      let contextBefore: Array<{ authorName: string; content: string }> = [];
      if (r.channel_id && r.msg_created_at) {
        const ctx = await this.sql<Array<{ author_name: string; content: string }>>`
          SELECT author_name, content FROM messages
          WHERE guild_id = ${guildId} AND channel_id = ${r.channel_id} AND created_at < ${r.msg_created_at}
          ORDER BY created_at DESC LIMIT 5
        `;
        contextBefore = ctx.reverse().map(c => ({ authorName: c.author_name, content: c.content }));
      }
      return {
        memoryId: Number(r.memory_id), subjectId: r.subject_id, kind: r.kind as Memory["kind"],
        content: r.content, evidenceType: r.primary_evidence_type, selfReport: r.self_report,
        authorName: r.author_name ?? r.subject_id, authorNames: r.author_names ?? [],
        sourceMessage: r.source_message, contextBefore,
      };
    }));
  }

  /**
   * Apply one verification verdict to a candidate memory.
   * - joke → evidence re-classified sarcasm_or_joke, confidence reset to 0.10
   * - misattributed → forgotten (the source text was quoting/describing someone else)
   * - literal + self-report + promotable type → promoted to active
   * - literal + third-party, or unclear → unchanged
   * Returns "promoted" | "flagged" | "rejected" | "unchanged".
   */
  async applyVerification(memoryId: number, verdict: VerificationVerdict, reason: string): Promise<"promoted" | "flagged" | "rejected" | "unchanged"> {
    return await this.sql.begin(async sql => {
      const rows = await sql<MemoryRow[]>`SELECT * FROM memories WHERE id = ${memoryId}`;
      const mem = rows[0] ? rowToMemory(rows[0]) : undefined;
      if (!mem || mem.status !== "candidate") return "unchanged";

      if (verdict === "misattributed") {
        await sql`UPDATE memories SET status = 'forgotten', updated_at = NOW() WHERE id = ${memoryId}`;
        await this._logHistory(sql, memoryId, "misattributed", mem.confidence, mem.confidence, "candidate", "forgotten", null, { reason });
        return "rejected";
      }

      if (verdict === "joke") {
        const jokeConfidence = calculateInitialConfidence("sarcasm_or_joke");
        await sql`UPDATE memories SET primary_evidence_type = 'sarcasm_or_joke', confidence = ${jokeConfidence}, updated_at = NOW() WHERE id = ${memoryId}`;
        await sql`UPDATE memory_evidence SET evidence_type = 'sarcasm_or_joke' WHERE memory_id = ${memoryId}`;
        await this._logHistory(sql, memoryId, "flagged_joke", mem.confidence, jokeConfidence, "candidate", "candidate", null, { reason });
        return "flagged";
      }

      if (verdict === "literal") {
        const promotableTypes: EvidenceType[] = ["explicit_fact", "clear_preference", "correction"];
        const ev = await sql<[{ author_id: string }]>`
          SELECT author_id FROM memory_evidence WHERE memory_id = ${memoryId} ORDER BY id LIMIT 1
        `;
        const selfReport = ev[0]?.author_id === mem.subjectId;
        if (selfReport && promotableTypes.includes(mem.primaryEvidenceType as EvidenceType)) {
          await sql`UPDATE memories SET status = 'active', last_confirmed_at = NOW(), updated_at = NOW() WHERE id = ${memoryId}`;
          await this._logHistory(sql, memoryId, "verified_active", mem.confidence, mem.confidence, "candidate", "active", null, { reason });
          return "promoted";
        }
        await this._logHistory(sql, memoryId, "verified_literal", mem.confidence, mem.confidence, "candidate", "candidate", null, { reason });
      }
      return "unchanged";
    });
  }

  // ── Dossier inputs ─────────────────────────────────────────────────────────

  /** Up to 60 raw messages for voice analysis: 30 most recent + 30 random older ones. */
  async sampleMessages(guildId: string, authorId: string): Promise<Array<{ content: string; createdAt: string }>> {
    const recent = await this.sql<Array<{ content: string; created_at: Date | string }>>`
      SELECT content, created_at FROM messages
      WHERE guild_id = ${guildId} AND author_id = ${authorId} AND length(content) > 0
      ORDER BY created_at DESC LIMIT 30
    `;
    const random = await this.sql<Array<{ content: string; created_at: Date | string }>>`
      SELECT content, created_at FROM messages
      WHERE guild_id = ${guildId} AND author_id = ${authorId} AND length(content) > 0
      ORDER BY random() LIMIT 30
    `;
    const seen = new Set<string>();
    const out: Array<{ content: string; createdAt: string }> = [];
    for (const r of [...recent, ...random]) {
      const key = r.content + ts(r.created_at);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ content: r.content, createdAt: ts(r.created_at) });
    }
    return out;
  }

  /** Raw relationship observations (with reasons) involving a member — either as
   * the asserting side ("member_subject") or the observed side ("member_other").
   * otherId is always the counterparty. Dossier relationship_map input. */
  async relationshipObservationsFor(guildId: string, subjectId: string): Promise<Array<{
    otherId: string; nature: string; valence: number | null; reason: string;
    direction: "member_subject" | "member_other"; createdAt: string;
  }>> {
    const rows = await this.sql<Array<{
      subject_id: string; other_id: string; nature: string; valence: number | null; reason: string; created_at: Date | string;
    }>>`
      SELECT subject_id, other_id, nature, valence, reason, created_at FROM relationship_observations
      WHERE guild_id = ${guildId} AND (subject_id = ${subjectId} OR other_id = ${subjectId})
        AND verdict IS DISTINCT FROM 'joke'
      ORDER BY created_at DESC
    `;
    return rows.map(r => ({
      otherId: r.subject_id === subjectId ? r.other_id : r.subject_id,
      nature: r.nature,
      valence: r.valence != null ? Number(r.valence) : null,
      reason: r.reason,
      direction: r.subject_id === subjectId ? "member_subject" as const : "member_other" as const,
      createdAt: ts(r.created_at),
    }));
  }

  /** Memories about a subject asserted by someone else — the community-attributed
   * claims that feed the dossier reputation section. */
  async thirdPartyClaims(guildId: string, subjectId: string): Promise<Array<{
    memoryId: number; content: string; kind: Memory["kind"]; confidence: number; status: MemoryStatus; evidenceType: string;
  }>> {
    const rows = await this.sql<Array<{
      id: number; content: string; kind: string; confidence: number; status: string; primary_evidence_type: string;
    }>>`
      SELECT DISTINCT m.id, m.content, m.kind, m.confidence, m.status, m.primary_evidence_type
      FROM memories m
      JOIN memory_evidence e ON e.memory_id = m.id
      WHERE m.guild_id = ${guildId} AND m.subject_id = ${subjectId}
        AND e.author_id <> m.subject_id
        AND m.status IN ('active', 'candidate')
      ORDER BY m.confidence DESC
    `;
    return rows.map(r => ({
      memoryId: Number(r.id), content: r.content, kind: r.kind as Memory["kind"],
      confidence: Number(r.confidence), status: r.status as MemoryStatus,
      evidenceType: r.primary_evidence_type,
    }));
  }

  // ── Interaction graph ──────────────────────────────────────────────────────
  // Deterministic "who addresses whom" topology from the raw archive — <@ID>
  // mentions plus written name-references. Distinct from LLM-asserted edges:
  // this measures frequency of contact, not claimed dynamics. reply_to_id is
  // unpopulated in the archive, so mentions are the signal we have.

  /** Undirected pairs keyed (min,max) — mention and name-ref both count once per message per pair. */
  async interactionPairs(
    guildId: string,
    aliasMap: Map<string, string>,
    excludeIds: string[] = []
  ): Promise<Array<{ aId: string; bId: string; count: number; firstAt: string; lastAt: string }>> {
    const rows = await this.sql<Array<{ author_id: string; content: string; created_at: Date | string }>>`
      SELECT author_id, content, created_at FROM messages
      WHERE guild_id = ${guildId} AND length(content) > 0
      ORDER BY created_at
    `;
    const skip = new Set(excludeIds);
    const pairs = new Map<string, { aId: string; bId: string; count: number; firstAt: string; lastAt: string }>();
    for (const r of rows) {
      if (skip.has(r.author_id)) continue;
      const targets = new Set<string>();
      for (const m of r.content.matchAll(/<@!?(\d{5,25})>/g)) targets.add(m[1]);
      for (const id of findMentionedUsers(r.content, aliasMap)) targets.add(id);
      targets.delete(r.author_id);
      for (const t of targets) {
        if (skip.has(t)) continue;
        const [a, b] = r.author_id < t ? [r.author_id, t] : [t, r.author_id];
        const key = `${a}|${b}`;
        const at = ts(r.created_at);
        const cur = pairs.get(key);
        if (cur) { cur.count++; cur.lastAt = at; }
        else pairs.set(key, { aId: a, bId: b, count: 1, firstAt: at, lastAt: at });
      }
    }
    return [...pairs.values()].sort((x, y) => y.count - x.count);
  }

  // ── Edge merging + observation verification ────────────────────────────────
  // Edges are stored directed (subject_id → other_id), so the same pair observed
  // from both sides fragments the observation count. mergedEdges groups by
  // counterparty for surfacing; the directed rows stay authoritative.

  /** Edges involving subjectId, merged by counterparty: counts summed, valence
   * observation-weighted, natures unioned (latest first). */
  async mergedEdges(guildId: string, subjectId: string): Promise<Array<{
    otherId: string; summary: string; natures: string[];
    valence: number | null; observationCount: number; lastObservedAt: string | null;
  }>> {
    const edges = await this.relationshipsFor(guildId, subjectId);
    const byOther = new Map<string, RelationshipEdge[]>();
    for (const e of edges) {
      const other = e.subjectId === subjectId ? e.otherId : e.subjectId;
      const list = byOther.get(other);
      if (list) list.push(e); else byOther.set(other, [e]);
    }
    return [...byOther.entries()].map(([otherId, list]) => {
      const total = list.reduce((s, e) => s + e.observationCount, 0);
      const scored = list.filter(e => e.valence != null && e.observationCount > 0);
      const valence = scored.length
        ? scored.reduce((s, e) => s + e.valence! * e.observationCount, 0) / scored.reduce((s, e) => s + e.observationCount, 0)
        : null;
      const byRecency = [...list].sort((a, b) => (b.lastObservedAt ?? "").localeCompare(a.lastObservedAt ?? ""));
      return {
        otherId,
        summary: byRecency[0].summary,
        natures: [...new Set(byRecency.map(e => e.summary).filter(Boolean))],
        valence, observationCount: total, lastObservedAt: byRecency[0].lastObservedAt,
      };
    }).sort((a, b) => b.observationCount - a.observationCount);
  }

  /** Unverified observations joined to their source message + author names +
   * preceding context — input for verifyRelationshipsBatch. */
  async listUnverifiedObservations(guildId: string, limit = 50): Promise<Array<{
    observationId: number; subjectId: string; otherId: string; nature: string;
    authorName: string; authorNames: string[]; sourceMessage: string;
    contextBefore: Array<{ authorName: string; content: string }>;
  }>> {
    const rows = await this.sql<Array<{
      id: number; subject_id: string; other_id: string; nature: string;
      author_name: string | null; author_names: string[] | null; source_message: string;
      channel_id: string | null; msg_created_at: Date | string | null;
    }>>`
      SELECT o.id, o.subject_id, o.other_id, o.nature,
             msg.author_name, mem.known_names AS author_names,
             msg.content AS source_message, msg.channel_id, msg.created_at AS msg_created_at
      FROM relationship_observations o
      JOIN messages msg ON msg.id = o.message_id
      LEFT JOIN members mem ON mem.guild_id = o.guild_id AND mem.user_id = msg.author_id
      WHERE o.guild_id = ${guildId} AND o.verdict IS NULL
      ORDER BY o.id LIMIT ${limit}
    `;
    return await Promise.all(rows.map(async r => {
      let contextBefore: Array<{ authorName: string; content: string }> = [];
      if (r.channel_id && r.msg_created_at) {
        const ctx = await this.sql<Array<{ author_name: string; content: string }>>`
          SELECT author_name, content FROM messages
          WHERE guild_id = ${guildId} AND channel_id = ${r.channel_id} AND created_at < ${r.msg_created_at}
          ORDER BY created_at DESC LIMIT 5
        `;
        contextBefore = ctx.reverse().map(c => ({ authorName: c.author_name, content: c.content }));
      }
      return {
        observationId: Number(r.id), subjectId: r.subject_id, otherId: r.other_id,
        nature: r.nature, authorName: r.author_name ?? r.subject_id,
        authorNames: r.author_names ?? [], sourceMessage: r.source_message, contextBefore,
      };
    }));
  }

  async setObservationVerdict(observationId: number, verdict: string): Promise<void> {
    await this.sql`UPDATE relationship_observations SET verdict = ${verdict} WHERE id = ${observationId}`;
  }

  /** Rebuild the durable edges from non-joke observations. Delete + re-aggregate
   * in one transaction; returns the edge count. */
  async recomputeEdges(guildId: string): Promise<number> {
    return await this.sql.begin(async sql => {
      await sql`DELETE FROM relationships WHERE guild_id = ${guildId}`;
      const inserted = await sql`
        INSERT INTO relationships (guild_id, subject_id, other_id, summary, valence, observation_count, last_observed_at, updated_at)
        SELECT guild_id, subject_id, other_id,
               (array_agg(nature ORDER BY created_at DESC))[1],
               AVG(valence),
               COUNT(*)::int,
               MAX(created_at), NOW()
        FROM relationship_observations
        WHERE guild_id = ${guildId} AND verdict IS DISTINCT FROM 'joke'
        GROUP BY guild_id, subject_id, other_id
        RETURNING id
      `;
      return inserted.length;
    });
  }

  async getMessage(messageId: string): Promise<{ id: string; guildId: string; channelId: string; authorId: string; authorName: string; content: string; createdAt: string } | undefined> {
    const rows = await this.sql<MessageRow[]>`SELECT id, guild_id, channel_id, author_id, author_name, content, created_at FROM messages WHERE id = ${messageId}`;
    if (!rows[0]) return undefined;
    const r = rows[0];
    return { id: r.id, guildId: r.guild_id, channelId: r.channel_id, authorId: r.author_id, authorName: r.author_name, content: r.content, createdAt: ts(r.created_at) };
  }

  async hasEvidence(messageId: string): Promise<boolean> {
    const rows = await this.sql<[{ c: number }]>`SELECT COUNT(*)::int as c FROM memory_evidence WHERE message_id = ${messageId}`;
    return rows[0].c > 0;
  }

  /** Returns triage_result for each given message id. Missing rows and NULLs are absent from the map. */
  async getTriageResults(messageIds: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (messageIds.length === 0) return out;
    const rows = await this.sql<Array<{ id: string; triage_result: string | null }>>`
      SELECT id, triage_result FROM messages WHERE id = ANY(${messageIds}) AND triage_result IS NOT NULL
    `;
    for (const r of rows) if (r.triage_result) out.set(r.id, r.triage_result);
    return out;
  }

  async setTriageResults(results: Array<{ id: string; result: string }>): Promise<void> {
    if (results.length === 0) return;
    await this.sql.begin(async sql => {
      for (const r of results) {
        await sql`UPDATE messages SET triage_result = ${r.result} WHERE id = ${r.id}`;
      }
    });
  }

  /** Recent messages the pipeline never classified — no triage mark and no
   * evidence row. The periodic sweep re-examines these: regex-passed ones get
   * extracted directly, the rest go through LLM triage. Note: `messages` has
   * no bot flag, so other bots' messages are included — bounded noise. */
  async listUninspectedMessages(guildId: string, since: Date, excludeAuthorId: string, limit = 500): Promise<Array<{ id: string; channelId: string; authorId: string; authorName: string; content: string; createdAt: Date | string; replyToId: string | null; triageResult: string | null }>> {
    const rows = await this.sql<Array<{ id: string; channel_id: string; author_id: string; author_name: string; content: string; created_at: Date | string; reply_to_id: string | null; triage_result: string | null }>>`
      SELECT m.id, m.channel_id, m.author_id, m.author_name, m.content, m.created_at, m.reply_to_id, m.triage_result
      FROM messages m
      WHERE m.guild_id = ${guildId} AND m.created_at > ${since.toISOString()}
        AND (m.triage_result IS NULL OR m.triage_result = 'durable')
        AND m.author_id <> ${excludeAuthorId}
        AND m.content <> ''
        AND NOT EXISTS (SELECT 1 FROM memory_evidence e WHERE e.message_id = m.id)
      ORDER BY m.created_at ASC LIMIT ${limit}
    `;
    return rows.map(r => ({ id: r.id, channelId: r.channel_id, authorId: r.author_id, authorName: r.author_name, content: r.content, createdAt: r.created_at, replyToId: r.reply_to_id, triageResult: r.triage_result }));
  }

  // ── Core memory persistence ────────────────────────────────────────────────
  // Phase 1 authoritative update: the LLM supplies language interpretation only. Confidence,
  // lifecycle, counters, and history are all determined here after an idempotent evidence insert.

  async saveMemory(event: MessageEvent, memory: MemoryCandidate, candidateThreshold = 0.7): Promise<Memory> {
    const evidenceType = memory.evidenceType ?? "uncertain_inference";
    const effect = memory.effect ?? "context";

    return await this.sql.begin(async sql => {
      // Upsert the memory row (idempotent on the unique content key).
      const existing = await sql<MemoryRow[]>`
        SELECT id FROM memories WHERE guild_id = ${event.guildId} AND subject_id = ${memory.subjectId} AND kind = ${memory.kind} AND content = ${memory.content}
      `;

      // Near-duplicate fast-path: when the exact key misses, fall back to a pg_trgm
      // similarity lookup in the same (guild, subject, kind) scope so rephrased
      // extractions reinforce one row instead of splitting confirmations.
      // Excluded:
      //  - effect 'correct': a replacement must create its own row for supersede() to link.
      //  - kind 'episode': recurring events must accumulate as separate rows for
      //    pattern consolidation.
      //  - subject 'unknown': similarity across different unresolved people would
      //    merge distinct memories.
      //  - non-promotable evidence types: the fast-path is gated the same way
      //    promotion is, so a joke/rumour extraction can't nudge a look-alike row.
      //  - contested/superseded/forgotten targets: a forgotten memory must not be
      //    resurrected by a near-duplicate.
      let trigramMatch: { id: number; score: number; content: string } | null = null;
      let nearMiss: { id: number; score: number } | null = null;
      if (!existing[0] && effect !== "correct" && memory.kind !== "episode" && memory.subjectId !== "unknown" && PROMOTABLE_EVIDENCE_TYPES.includes(evidenceType)) {
        const simRows = await sql<Array<{ id: number; sim: number; content: string }>>`
          SELECT id, similarity(content, ${memory.content}) AS sim, content
          FROM memories
          WHERE guild_id = ${event.guildId}
            AND subject_id = ${memory.subjectId}
            AND kind = ${memory.kind}
            AND status IN ('candidate', 'active', 'quarantined')
            AND content % ${memory.content}
          ORDER BY sim DESC, id ASC
          LIMIT 1
        `;
        const top = simRows[0] ? { id: Number(simRows[0].id), score: Number(simRows[0].sim), content: simRows[0].content } : null;
        if (top && top.score >= TRIGRAM_MATCH_THRESHOLD) trigramMatch = top;
        else if (top && top.score >= TRIGRAM_NEAR_MISS_THRESHOLD) nearMiss = top;
      }

      // Fuzzy matches don't get to trust the LLM's effect blindly: opposite
      // polarity between the two contents means this is a contradiction of the
      // matched row. Exact matches skip this — same string can't flip polarity.
      let effectiveEffect = effect;
      if (trigramMatch && contentPolarity(trigramMatch.content) !== contentPolarity(memory.content)) {
        effectiveEffect = "contradict";
      }

      const matchedId = existing[0] ? Number(existing[0].id) : trigramMatch?.id ?? null;
      if (!matchedId) {
        const initialConfidence = calculateInitialConfidence(evidenceType);
        const importance = memory.importance ?? calculateDefaultImportance(memory.kind);
        const explicitness = memory.explicitness ?? calculateDefaultExplicitness(evidenceType);
        // Persist the extracted name even when the subject couldn't be resolved to an ID —
        // it enables later re-attribution of `unknown` memories.
        const subjectName = memory.subjectName || (memory.subjectId === event.authorId ? event.authorName : "");
        await sql`
          INSERT INTO memories (guild_id, subject_id, subject_name, kind, content, confidence, importance, mentions, confirmation_count, created_at, updated_at, last_confirmed_at, status, explicitness, reason, primary_evidence_type)
          VALUES (${event.guildId}, ${memory.subjectId}, ${subjectName}, ${memory.kind}, ${memory.content}, ${initialConfidence}, ${importance}, 0, 0, NOW(), NOW(), NOW(), 'candidate', ${explicitness}, ${memory.reason}, ${evidenceType})
          ON CONFLICT (guild_id, subject_id, kind, content) DO NOTHING
        `;
      }

      const savedRows = matchedId
        ? await sql<MemoryRow[]>`SELECT * FROM memories WHERE id = ${matchedId}`
        : await sql<MemoryRow[]>`
            SELECT * FROM memories WHERE guild_id = ${event.guildId} AND subject_id = ${memory.subjectId} AND kind = ${memory.kind} AND content = ${memory.content}
          `;
      const saved = rowToMemory(savedRows[0]);
      const applied = await this._applyEvidence(sql, saved, event, evidenceType, effectiveEffect, memory.reason, memory.explicitness, candidateThreshold);

      // Audit trail for the fuzzy path — real scores are what lets the threshold
      // be tuned with data instead of guesswork.
      if (trigramMatch && applied) {
        await this._logHistory(sql, saved.id, "dedup_matched", saved.confidence, applied.confidence, saved.status, applied.status, null, { similarity: trigramMatch.score, incomingContent: memory.content, effect, appliedEffect: effectiveEffect });
      }
      if (nearMiss) {
        await this._logHistory(sql, saved.id, "dedup_near_miss", null, null, null, null, null, { similarity: nearMiss.score, existingMemoryId: nearMiss.id });
      }
      return applied ?? saved;
    }) as Memory;
  }

  /**
   * Attach a new evidence event to an existing memory — used when a message
   * contests or confirms an already-stored claim (e.g. the subject telling the
   * bot "I never said that"). Idempotent on (memory_id, message_id); returns
   * undefined when the message was already evidence for this memory.
   */
  async attachEvidence(memoryId: number, event: MessageEvent, evidenceType: EvidenceType, effect: EvidenceEffect, reason: string, candidateThreshold = 0.7): Promise<Memory | undefined> {
    return await this.sql.begin(async sql => {
      const rows = await sql<MemoryRow[]>`SELECT * FROM memories WHERE id = ${memoryId}`;
      const saved = rows[0] ? rowToMemory(rows[0]) : undefined;
      if (!saved) return undefined;
      return await this._applyEvidence(sql, saved, event, evidenceType, effect, reason, undefined, candidateThreshold);
    }) as Memory | undefined;
  }

  /**
   * Insert an evidence row for `saved` and apply the deterministic lifecycle
   * transitions (support bumps confidence, contradict contests, correct logs).
   * Returns the updated memory, or undefined when the evidence was a duplicate.
   */
  private async _applyEvidence(
    sql: Sql, saved: Memory, event: MessageEvent,
    evidenceType: EvidenceType, effect: EvidenceEffect, reason: string,
    explicitness: number | undefined, candidateThreshold: number
  ): Promise<Memory | undefined> {
    const evidenceExplicitness = explicitness ?? calculateDefaultExplicitness(evidenceType);
    // Idempotent evidence insert — same (memory_id, message_id) is ignored.
    const insertedEvidence = await sql`
      INSERT INTO memory_evidence (memory_id, message_id, author_id, quote, reason, explicitness, observed_at, evidence_type, effect, message_content_snapshot, message_timestamp, created_at)
      VALUES (${saved.id}, ${event.messageId}, ${event.authorId}, ${event.content.slice(0, 1000)}, ${reason}, ${evidenceExplicitness}, ${event.createdAt.toISOString()}, ${evidenceType}, ${effect}, ${event.content.slice(0, 1000)}, ${event.createdAt.toISOString()}, NOW())
      ON CONFLICT (memory_id, message_id) DO NOTHING
      RETURNING id
    `;
    if (insertedEvidence.length === 0) return undefined;

    const evidenceId = Number(insertedEvidence[0].id);
    const previousConfidence = saved.confidence;
    const previousStatus = saved.status;
    // Confidence is frozen the moment a memory enters contested state and remains frozen while contested.
    // net_score is the sole arbiter of conflict resolution; confidence must not be changed by either
    // supporting or contradicting evidence during this period so the two signals stay independent.
    const isContested = saved.status === "contested";
    let confidence = saved.confidence;
    let status = saved.status;
    let confirmations = saved.confirmationCount;
    let contradictions = saved.contradictionCount;
    let action = "context";

    if (effect === "support") {
      if (!isContested) confidence = updateConfidence(confidence, "support");
      confirmations++;
      action = "support";
    }
    if (effect === "contradict") {
      contradictions++;
      status = "contested";
      action = "contradict";
      // Write frozen_confidence the first time a memory enters contested state.
      if (saved.status !== "contested") {
        await sql`UPDATE memories SET frozen_confidence = ${saved.confidence} WHERE id = ${saved.id}`;
      }
    }
    if (effect === "correct") { action = "correction_evidence"; }

    // Only high-quality evidence types may promote a candidate to active. Sarcasm, rumour, and
    // uncertain inferences are explicitly excluded regardless of how high confidence grows.
    if (status === "candidate" && effect === "support" && confidence >= candidateThreshold && PROMOTABLE_EVIDENCE_TYPES.includes(evidenceType)) {
      status = "active";
      action = "promote";
    }

    await sql`
      UPDATE memories SET
        confidence = ${confidence},
        confirmation_count = ${confirmations},
        mentions = ${confirmations},
        contradiction_count = ${contradictions},
        status = ${status},
        updated_at = NOW(),
        last_confirmed_at = CASE WHEN ${effect} = 'support' THEN NOW() ELSE last_confirmed_at END,
        last_contradicted_at = CASE WHEN ${effect} = 'contradict' THEN NOW() ELSE last_contradicted_at END
      WHERE id = ${saved.id}
    `;

    await this._logHistory(sql, saved.id, action, previousConfidence, confidence, previousStatus, status, evidenceId, { evidenceType, effect, sourceMessageId: event.messageId });

    const finalRows = await sql<MemoryRow[]>`SELECT * FROM memories WHERE guild_id = ${event.guildId} AND id = ${saved.id}`;
    return rowToMemory(finalRows[0]);
  }

  // ── Reads ──────────────────────────────────────────────────────────────────

  async getMemory(guildId: string, id: number): Promise<Memory | undefined> {
    const rows = await this.sql<MemoryRow[]>`SELECT * FROM memories WHERE guild_id = ${guildId} AND id = ${id}`;
    return rows[0] ? rowToMemory(rows[0]) : undefined;
  }

  async listMemories(guildId: string, subjectId: string, options: { search?: string; page?: number; status?: MemoryStatus } = {}): Promise<{ memories: Memory[]; total: number; page: number }> {
    const page = Math.max(1, options.page ?? 1);
    const status = options.status ?? "active";
    const offset = (page - 1) * 8;

    let countResult: [{ count: number }];
    let rows: MemoryRow[];

    if (options.search) {
      const search = `%${options.search}%`;
      countResult = await this.sql<[{ count: number }]>`SELECT COUNT(*)::int as count FROM memories WHERE guild_id = ${guildId} AND subject_id = ${subjectId} AND status = ${status} AND content ILIKE ${search}`;
      rows = await this.sql<MemoryRow[]>`SELECT * FROM memories WHERE guild_id = ${guildId} AND subject_id = ${subjectId} AND status = ${status} AND content ILIKE ${search} ORDER BY importance * confidence DESC, last_confirmed_at DESC LIMIT 8 OFFSET ${offset}`;
    } else {
      countResult = await this.sql<[{ count: number }]>`SELECT COUNT(*)::int as count FROM memories WHERE guild_id = ${guildId} AND subject_id = ${subjectId} AND status = ${status}`;
      rows = await this.sql<MemoryRow[]>`SELECT * FROM memories WHERE guild_id = ${guildId} AND subject_id = ${subjectId} AND status = ${status} ORDER BY importance * confidence DESC, last_confirmed_at DESC LIMIT 8 OFFSET ${offset}`;
    }

    return { memories: rows.map(rowToMemory), total: Number(countResult[0].count), page };
  }

  async relevantMemories(guildId: string, subjectId: string, limit = 8): Promise<Memory[]> {
    // Candidates with promotable primary evidence are included so fresh direct
    // self-reports ("call me Alby") reach replies before nightly verification
    // promotes them; sarcasm/joke/uncertain candidates stay gated out. The reply
    // prompt annotates each memory's confidence so the model can weigh them.
    const rows = await this.sql<MemoryRow[]>`
      SELECT * FROM memories WHERE guild_id = ${guildId}
        AND (status = 'active' OR (status = 'candidate' AND primary_evidence_type IN ('explicit_fact', 'clear_preference', 'correction')))
        AND (subject_id = ${subjectId} OR subject_id = 'server')
      ORDER BY importance * confidence DESC, last_confirmed_at DESC LIMIT ${limit}
    `;
    return rows.map(rowToMemory);
  }

  async allActiveMemories(guildId: string, subjectId: string): Promise<Memory[]> {
    const rows = await this.sql<MemoryRow[]>`
      SELECT * FROM memories WHERE guild_id = ${guildId} AND subject_id = ${subjectId} AND status = 'active'
      ORDER BY importance * confidence DESC, last_confirmed_at DESC
    `;
    return rows.map(rowToMemory);
  }

  /** Memories about a subject that a denial/correction message could target —
   * active + contested first, then candidates the subject might have seen surfaced. */
  async contestableMemories(guildId: string, subjectId: string, limit = 15): Promise<Memory[]> {
    const rows = await this.sql<MemoryRow[]>`
      SELECT * FROM memories WHERE guild_id = ${guildId} AND subject_id = ${subjectId}
        AND status IN ('active', 'contested', 'candidate')
      ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'contested' THEN 1 ELSE 2 END,
               importance * confidence DESC, last_confirmed_at DESC
      LIMIT ${limit}
    `;
    return rows.map(rowToMemory);
  }

  async evidence(guildId: string, memoryId: number): Promise<MemoryEvidence[]> {
    const rows = await this.sql<EvidenceRow[]>`
      SELECT e.id, e.memory_id, e.message_id, e.author_id, e.quote, e.reason, e.explicitness,
             e.observed_at, e.evidence_type, e.effect, e.message_content_snapshot, e.message_timestamp, e.created_at
      FROM memory_evidence e JOIN memories m ON m.id = e.memory_id
      WHERE m.guild_id = ${guildId} AND m.id = ${memoryId}
      ORDER BY e.observed_at DESC
    `;
    return rows.map(r => ({
      id: Number(r.id), memoryId: Number(r.memory_id), messageId: r.message_id, authorId: r.author_id,
      quote: r.quote, reason: r.reason, explicitness: Number(r.explicitness),
      observedAt: ts(r.observed_at), evidenceType: r.evidence_type, effect: r.effect,
      messageContentSnapshot: r.message_content_snapshot, messageTimestamp: ts(r.message_timestamp), createdAt: ts(r.created_at),
    }));
  }

  async history(guildId: string, memoryId: number): Promise<MemoryHistory[]> {
    const rows = await this.sql<HistoryRow[]>`
      SELECT h.id, h.memory_id, h.action, h.previous_confidence, h.new_confidence,
             h.previous_status, h.new_status, h.evidence_id, h.details_json, h.created_at
      FROM memory_history h JOIN memories m ON m.id = h.memory_id
      WHERE m.guild_id = ${guildId} AND m.id = ${memoryId}
      ORDER BY h.created_at DESC
    `;
    return rows.map(r => ({
      id: Number(r.id), memoryId: Number(r.memory_id), action: r.action,
      previousConfidence: r.previous_confidence != null ? Number(r.previous_confidence) : null,
      newConfidence: r.new_confidence != null ? Number(r.new_confidence) : null,
      previousStatus: r.previous_status as MemoryStatus | null,
      newStatus: r.new_status as MemoryStatus | null,
      evidenceId: r.evidence_id != null ? Number(r.evidence_id) : null,
      detailsJson: r.details_json, createdAt: ts(r.created_at),
    }));
  }

  async logHistory(memoryId: number, action: string, previousConfidence: number | null, newConfidence: number | null, previousStatus: MemoryStatus | null, newStatus: MemoryStatus | null, evidenceId: number | null, details: Record<string, unknown> = {}): Promise<void> {
    await this._logHistory(this.sql, memoryId, action, previousConfidence, newConfidence, previousStatus, newStatus, evidenceId, details);
  }

  private async _logHistory(sql: Sql, memoryId: number, action: string, previousConfidence: number | null, newConfidence: number | null, previousStatus: MemoryStatus | null, newStatus: MemoryStatus | null, evidenceId: number | null, details: Record<string, unknown> = {}): Promise<void> {
    await sql`
      INSERT INTO memory_history (memory_id, action, previous_confidence, new_confidence, previous_status, new_status, evidence_id, details_json)
      VALUES (${memoryId}, ${action}, ${previousConfidence}, ${newConfidence}, ${previousStatus}, ${newStatus}, ${evidenceId}, ${JSON.stringify(details)})
    `;
  }

  // ── Mutations ──────────────────────────────────────────────────────────────

  async forget(guildId: string, id: number): Promise<number> {
    const result = await this.sql`UPDATE memories SET status = 'forgotten' WHERE guild_id = ${guildId} AND id = ${id} AND status != 'forgotten'`;
    return result.count;
  }

  /** Opt-out bulk forget: every live memory about a subject → forgotten. */
  async forgetAllFor(guildId: string, subjectId: string): Promise<number> {
    const result = await this.sql`
      UPDATE memories SET status = 'forgotten', updated_at = NOW()
      WHERE guild_id = ${guildId} AND subject_id = ${subjectId} AND status != 'forgotten'
    `;
    return result.count;
  }

  async confirm(guildId: string, id: number): Promise<number> {
    const result = await this.sql`
      UPDATE memories SET status = 'active', confidence = GREATEST(confidence, 0.9), last_confirmed_at = NOW()
      WHERE guild_id = ${guildId} AND id = ${id} AND status = 'candidate'
    `;
    return result.count;
  }

  async supersede(guildId: string, oldId: number, replacementId: number): Promise<void> {
    const old = await this.getMemory(guildId, oldId);
    const replacement = await this.getMemory(guildId, replacementId);
    if (!old || !replacement) return;
    await this.sql`UPDATE memories SET status = 'superseded', superseded_by = ${replacementId}, updated_at = NOW() WHERE guild_id = ${guildId} AND id = ${oldId}`;
    await this.sql`UPDATE memories SET supersedes_memory_id = ${oldId}, status = 'active', updated_at = NOW() WHERE guild_id = ${guildId} AND id = ${replacementId}`;
    await this.logHistory(oldId, "superseded", old.confidence, old.confidence, old.status, "superseded", null, { replacementId });
    await this.logHistory(replacementId, "correction_activated", replacement.confidence, replacement.confidence, replacement.status, "active", null, { supersedesMemoryId: oldId });
  }

  async resolveContested(guildId: string, memoryId: number, now = new Date()): Promise<{ resolved: boolean; netScore: number }> {
    const memory = await this.getMemory(guildId, memoryId);
    if (!memory || memory.status !== "contested") return { resolved: false, netScore: 0 };
    const evRows = await this.evidence(guildId, memoryId);
    const ev = evRows.filter(item => item.effect === "support" || item.effect === "contradict");
    const weight = (timestamp: string) => Math.pow(0.5, Math.max(0, now.getTime() - new Date(timestamp).getTime()) / 86_400_000 / 90);
    const supportScore = ev.filter(item => item.effect === "support").reduce((sum, item) => sum + weight(item.messageTimestamp), 0);
    const contradictionScore = ev.filter(item => item.effect === "contradict").reduce((sum, item) => sum + weight(item.messageTimestamp), 0);
    const netScore = supportScore - contradictionScore;
    const newest = [...ev].sort((a, b) => b.messageTimestamp.localeCompare(a.messageTimestamp))[0];
    // Always persist the current net_score so the DB reflects the latest resolution signal.
    await this.sql`UPDATE memories SET net_score = ${netScore} WHERE guild_id = ${guildId} AND id = ${memoryId}`;
    if (memory.confidence >= 0.70 && netScore >= 0.50 && newest?.effect !== "contradict") {
      // Resolution: restore to active and clear the conflict tracking columns.
      await this.sql`UPDATE memories SET status = 'active', frozen_confidence = NULL, net_score = NULL, updated_at = NOW() WHERE guild_id = ${guildId} AND id = ${memoryId}`;
      await this.logHistory(memoryId, "conflict_resolved", memory.confidence, memory.confidence, "contested", "active", null, { supportScore, contradictionScore, netScore });
      return { resolved: true, netScore };
    }
    await this.logHistory(memoryId, "conflict_unresolved", memory.confidence, memory.confidence, "contested", "contested", null, { supportScore, contradictionScore, netScore });
    return { resolved: false, netScore };
  }

  /** The subject of a contested memory affirms it themselves — decisive: resolves
   * to active regardless of net_score, since the person described is the authority
   * on their own facts. Only called when ordinary resolution can't settle it. */
  async subjectConfirm(guildId: string, memoryId: number): Promise<void> {
    const memory = await this.getMemory(guildId, memoryId);
    if (!memory || memory.status !== "contested") return;
    await this.sql`UPDATE memories SET status = 'active', frozen_confidence = NULL, net_score = NULL, updated_at = NOW() WHERE guild_id = ${guildId} AND id = ${memoryId}`;
    await this.logHistory(memoryId, "subject_confirmed", memory.confidence, memory.confidence, "contested", "active", null, {});
  }

  // ── Context helpers ────────────────────────────────────────────────────────

  async recentContext(guildId: string, channelId: string, limit = 12): Promise<Array<{ authorName: string; content: string; createdAt: string }>> {
    const rows = await this.sql<MessageRow[]>`
      SELECT author_name, content, created_at FROM messages
      WHERE guild_id = ${guildId} AND channel_id = ${channelId}
      ORDER BY created_at DESC LIMIT ${limit}
    `;
    return rows.reverse().map(r => ({ authorName: r.author_name, content: r.content, createdAt: ts(r.created_at) }));
  }

  async messagesByIds(messageIds: string[]): Promise<Array<{ authorName: string; content: string; createdAt: string }>> {
    if (messageIds.length === 0) return [];
    const rows = await this.sql<MessageRow[]>`
      SELECT author_name, content, created_at FROM messages WHERE id = ANY(${messageIds}) ORDER BY created_at ASC
    `;
    return rows.map(r => ({ authorName: r.author_name, content: r.content, createdAt: ts(r.created_at) }));
  }

  async deleteRawMessagesOlderThan(guildId: string, days: number): Promise<number> {
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    const result = await this.sql`DELETE FROM messages WHERE guild_id = ${guildId} AND created_at < ${cutoff}`;
    return result.count;
  }

  // Derived-data retention. Only `messages` aged out via raw retention, leaving
  // the append-only tables unbounded; this caps them at 90 days:
  // - memory_history: audit trail — old entries lose tuning value anyway.
  // - unresolved_names / alias_candidates: discovery surfaces — a name that still
  //   matters recurs and writes a fresh row, so aged rows carry no unique signal.
  // - candidate-tier events that have closed (discarded or timed out): never
  //   surfaced anywhere. Promoted 'event' rows are the feature and are kept.
  // Child tables have no cascade, so they're deleted first. memory_evidence is
  // deliberately not pruned — evidence is retained for inspectability even on
  // forgotten memories, and its size tracks live memory count.
  async pruneDerivedData(guildId: string, olderThanDays = 90): Promise<{ history: number; names: number; aliases: number; events: number }> {
    const cutoff = new Date(Date.now() - olderThanDays * 86_400_000).toISOString();
    const staleEvents = this.sql`SELECT id FROM events WHERE guild_id = ${guildId} AND tier = 'candidate' AND closed_at IS NOT NULL AND occurred_at < ${cutoff}`;
    const history = await this.sql`
      DELETE FROM memory_history WHERE created_at < ${cutoff}
      AND memory_id IN (SELECT id FROM memories WHERE guild_id = ${guildId})
    `;
    const names = await this.sql`DELETE FROM unresolved_names WHERE guild_id = ${guildId} AND created_at < ${cutoff}`;
    const aliases = await this.sql`DELETE FROM alias_candidates WHERE guild_id = ${guildId} AND created_at < ${cutoff}`;
    await this.sql`DELETE FROM event_participants WHERE event_id IN (${staleEvents})`;
    await this.sql`DELETE FROM event_messages WHERE event_id IN (${staleEvents})`;
    await this.sql`DELETE FROM event_memories WHERE event_id IN (${staleEvents})`;
    const events = await this.sql`DELETE FROM events WHERE id IN (${staleEvents})`;
    return { history: history.count, names: names.count, aliases: aliases.count, events: events.count };
  }

  // Admin triage view: the last N memories written for the guild across all
  // subjects, with the best display label we have (member name > extracted
  // subject name > raw id).
  async recentMemories(guildId: string, limit = 15): Promise<Array<Memory & { subjectLabel: string }>> {
    const rows = await this.sql<Array<MemoryRow & { subject_label: string }>>`
      SELECT m.*, COALESCE(NULLIF(mb.known_names[1], ''), NULLIF(m.subject_name, ''), m.subject_id) AS subject_label
      FROM memories m
      LEFT JOIN members mb ON mb.guild_id = m.guild_id AND mb.user_id = m.subject_id
      WHERE m.guild_id = ${guildId}
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT ${limit}
    `;
    return rows.map(r => ({ ...rowToMemory(r), subjectLabel: r.subject_label }));
  }

  // ── Episode consolidation ──────────────────────────────────────────────────
  // Consolidate active episodes for a subject into behavioral_patterns rows.
  // Only active-status episodes count toward pattern formation — candidates and quarantined
  // episodes must not influence whether a pattern is recognised.
  //
  // If the subject already has an active pattern, unlinked episodes are appended to it (the
  // episode_count and confidence are refreshed) rather than creating a second pattern row.
  // This prevents unbounded pattern accumulation across maintenance runs.

  async consolidateEpisodes(guildId: string, subjectId: string, minEpisodes = 3): Promise<number> {
    const unlinked = await this.sql<Array<{ id: number; content: string; confidence: number }>>`
      SELECT id, content, confidence FROM memories
      WHERE guild_id = ${guildId} AND subject_id = ${subjectId} AND kind = 'episode' AND status = 'active' AND pattern_id IS NULL
      ORDER BY confidence DESC
    `;
    if (unlinked.length < minEpisodes) return 0;
    const ids = unlinked.map(e => Number(e.id));
    const avgConfidence = unlinked.reduce((sum, e) => sum + Number(e.confidence), 0) / unlinked.length;

    const existingPattern = await this.sql<Array<{ id: number; episode_count: number }>>`
      SELECT id, episode_count FROM behavioral_patterns WHERE guild_id = ${guildId} AND subject_id = ${subjectId} AND status = 'active' ORDER BY id LIMIT 1
    `;

    let patternId: number;
    if (existingPattern[0]) {
      const newCount = Number(existingPattern[0].episode_count) + unlinked.length;
      await this.sql`UPDATE behavioral_patterns SET episode_count = ${newCount}, confidence = ${avgConfidence}, updated_at = NOW() WHERE id = ${existingPattern[0].id}`;
      patternId = Number(existingPattern[0].id);
    } else {
      // TODO(Phase 1D): synthesise a human-readable description via LLM rather than copying the episode content verbatim.
      const description = unlinked[0].content;
      const inserted = await this.sql`
        INSERT INTO behavioral_patterns (guild_id, subject_id, description, episode_count, confidence)
        VALUES (${guildId}, ${subjectId}, ${description}, ${unlinked.length}, ${avgConfidence})
        RETURNING id
      `;
      patternId = Number(inserted[0].id);
    }
    await this.sql`UPDATE memories SET pattern_id = ${patternId} WHERE id = ANY(${ids})`;
    return 1;
  }

  async patterns(guildId: string, subjectId: string): Promise<BehavioralPattern[]> {
    const rows = await this.sql<Array<{ id: number; guild_id: string; subject_id: string; description: string; episode_count: number; confidence: number; created_at: Date | string; updated_at: Date | string; status: string }>>`
      SELECT id, guild_id, subject_id, description, episode_count, confidence, created_at, updated_at, status
      FROM behavioral_patterns WHERE guild_id = ${guildId} AND subject_id = ${subjectId} AND status = 'active'
      ORDER BY confidence DESC
    `;
    return rows.map(r => ({
      id: Number(r.id), guildId: r.guild_id, subjectId: r.subject_id, description: r.description,
      episodeCount: Number(r.episode_count), confidence: Number(r.confidence),
      createdAt: ts(r.created_at), updatedAt: ts(r.updated_at), status: r.status,
    }));
  }

  async maintain(guildId: string, candidateThreshold = 0.7): Promise<{ promoted: number; quarantinedCandidates: number; quarantinedActive: number; resolved: number; patternsFound: number }> {
    const candidateCutoff = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const staleCutoff = new Date(Date.now() - 90 * 86_400_000).toISOString();

    // The primary_evidence_type gate mirrors the per-insert promotableTypes allowlist so that
    // sarcasm, rumour, and uncertain-inference memories cannot be promoted by bulk maintenance
    // even if their confidence and mention counts happen to satisfy the numeric thresholds.
    const promotedResult = await this.sql`
      UPDATE memories SET status = 'active' WHERE guild_id = ${guildId} AND status = 'candidate'
      AND mentions >= 2 AND confidence >= ${candidateThreshold}
      AND primary_evidence_type IN ('explicit_fact', 'clear_preference', 'correction')
    `;
    const quarantinedCandidatesResult = await this.sql`
      UPDATE memories SET status = 'quarantined' WHERE guild_id = ${guildId} AND status = 'candidate' AND last_confirmed_at < ${candidateCutoff}
    `;
    const quarantinedActiveResult = await this.sql`
      UPDATE memories SET status = 'quarantined' WHERE guild_id = ${guildId} AND status = 'active' AND confidence < 0.75 AND last_confirmed_at < ${staleCutoff}
    `;

    // Attempt to resolve all contested memories in this guild via age-weighted net score.
    const contestedRows = await this.sql<Array<{ id: number }>>`SELECT id FROM memories WHERE guild_id = ${guildId} AND status = 'contested'`;
    let resolved = 0;
    for (const row of contestedRows) {
      const result = await this.resolveContested(guildId, Number(row.id));
      if (result.resolved) resolved++;
    }

    // Consolidate episodes into behavioral patterns per subject.
    const subjectRows = await this.sql<Array<{ subject_id: string }>>`
      SELECT DISTINCT subject_id FROM memories WHERE guild_id = ${guildId} AND kind = 'episode' AND status = 'active' AND pattern_id IS NULL
    `;
    let patternsFound = 0;
    for (const row of subjectRows) {
      patternsFound += await this.consolidateEpisodes(guildId, row.subject_id);
    }

    return {
      promoted: promotedResult.count,
      quarantinedCandidates: quarantinedCandidatesResult.count,
      quarantinedActive: quarantinedActiveResult.count,
      resolved,
      patternsFound,
    };
  }

  // ── Admin ──────────────────────────────────────────────────────────────────

  async stats(guildId: string): Promise<{ messages: number; memories: number; lore: number }> {
    const [messages, memories, lore] = await Promise.all([
      this.sql<[{ count: number }]>`SELECT COUNT(*)::int as count FROM messages WHERE guild_id = ${guildId}`,
      this.sql<[{ count: number }]>`SELECT COUNT(*)::int as count FROM memories WHERE guild_id = ${guildId} AND status = 'active'`,
      this.sql<[{ count: number }]>`SELECT COUNT(*)::int as count FROM memories WHERE guild_id = ${guildId} AND status = 'active' AND kind = 'server_lore'`,
    ]);
    return { messages: messages[0].count, memories: memories[0].count, lore: lore[0].count };
  }

  async exportSubject(guildId: string, subjectId: string): Promise<Array<Memory & { evidence: MemoryEvidence[] }>> {
    const rows = await this.sql<MemoryRow[]>`SELECT * FROM memories WHERE guild_id = ${guildId} AND subject_id = ${subjectId} ORDER BY id`;
    return Promise.all(rows.map(async r => {
      const mem = rowToMemory(r);
      return { ...mem, evidence: await this.evidence(guildId, mem.id) };
    }));
  }
}
