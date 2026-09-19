import type { AttributeStatus, EvidenceEffect, EvidenceType, Member, MemoryCandidate, MemoryStatus, MessageEvent, ProfileAttribute, RelationshipEdge, VerificationVerdict } from "./types.js";
import { sql as defaultSql, type Sql } from "./db.js";
import { runMigrations } from "./migrations.js";
import { findMentionedUsers } from "./entity-resolution.js";
import { calculateInitialConfidence, updateConfidence, calculateDefaultImportance, calculateDefaultExplicitness } from "./confidence.js";
import { contentPolarity, listAttributes, listAttributesForSubjects, listContestedAttributes, recomputeForMemories, transferProvenance } from "./attributes.js";

/** Cap on members.known_names — unbounded growth would inflate the alias map
 * and every per-message regex built from it. Oldest names are evicted. */
const MAX_KNOWN_NAMES = 32;

/** Escape ILIKE wildcards in user/model-controlled query fragments — a bare
 * "%" would enumerate every row (bounded by LIMIT, but still a loose read). */
export const escapeLike = (s: string) => s.replace(/[\\%_]/g, c => `\\${c}`);

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

type SettingsRow = { guild_id: string; memory_enabled: number; reply_enabled: number; proactive_enabled: number; raw_retention_days: number; announced_at: Date | string | null; ignored_channels: string[] | null; llm_daily_cap: number };

/** Public settings shape — server_settings projected to camelCase. */
export type Settings = { guildId: string; memoryEnabled: number; replyEnabled: number; proactiveEnabled: number; rawRetentionDays: number; announcedAt: string | null; ignoredChannels: string[]; llmDailyCap: number };

type MemberRow = {
  guild_id: string; user_id: string; known_names: string[];
  first_seen_at: Date | string; last_seen_at: Date | string;
  message_count: number; opted_out: number; opted_in: number;
};

type RelationshipRow = {
  id: number; guild_id: string; subject_id: string; other_id: string;
  summary: string; valence: number | null; observation_count: number;
  last_observed_at: Date | string | null; updated_at: Date | string;
  behavioral_count: number; party_count: number; trend: string | null; inferred: number;
};

function rowToEdge(r: RelationshipRow): RelationshipEdge {
  return {
    id: Number(r.id), guildId: r.guild_id, subjectId: r.subject_id, otherId: r.other_id,
    summary: r.summary, valence: r.valence != null ? Number(r.valence) : null,
    observationCount: Number(r.observation_count),
    lastObservedAt: r.last_observed_at ? ts(r.last_observed_at) : null,
    updatedAt: ts(r.updated_at),
    behavioralCount: Number(r.behavioral_count), partyCount: Number(r.party_count),
    trend: r.trend, inferred: !!r.inferred,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function ts(d: Date | string): string {
  return d instanceof Date ? d.toISOString() : d;
}

function rowToMember(r: MemberRow): Member {
  return {
    guildId: r.guild_id, userId: r.user_id, knownNames: r.known_names ?? [],
    firstSeenAt: ts(r.first_seen_at), lastSeenAt: ts(r.last_seen_at),
    messageCount: Number(r.message_count), optedOut: Number(r.opted_out) === 1,
    optedIn: Number(r.opted_in ?? 0) === 1,
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
  private settingsCache = new Map<string, { value: Settings; at: number }>();

  async settings(guildId: string, defaultRetentionDays = 30): Promise<Settings> {
    const cached = this.settingsCache.get(guildId);
    if (cached && Date.now() - cached.at < 60_000) return cached.value;
    await this.ensureSettings(guildId, defaultRetentionDays);
    const rows = await this.sql<SettingsRow[]>`SELECT guild_id, memory_enabled, reply_enabled, proactive_enabled, raw_retention_days, announced_at, ignored_channels, llm_daily_cap FROM server_settings WHERE guild_id = ${guildId}`;
    const r = rows[0];
    const value = { guildId: r.guild_id, memoryEnabled: Number(r.memory_enabled), replyEnabled: Number(r.reply_enabled), proactiveEnabled: Number(r.proactive_enabled), rawRetentionDays: Number(r.raw_retention_days), announcedAt: r.announced_at ? ts(r.announced_at) : null, ignoredChannels: r.ignored_channels ?? [], llmDailyCap: Number(r.llm_daily_cap) };
    this.settingsCache.set(guildId, { value, at: Date.now() });
    return value;
  }

  /** Stamp the join disclosure as delivered. Returns false when the settings
   * row doesn't exist — the caller retries on the next GuildCreate. */
  async markAnnounced(guildId: string): Promise<boolean> {
    const rows = await this.sql`UPDATE server_settings SET announced_at = now() WHERE guild_id = ${guildId} RETURNING guild_id`;
    this.settingsCache.delete(guildId);
    return rows.length > 0;
  }

  async setPaused(guildId: string, paused: boolean, defaultRetentionDays = 30): Promise<void> {
    await this.ensureSettings(guildId, defaultRetentionDays);
    const v = paused ? 0 : 1;
    await this.sql`UPDATE server_settings SET memory_enabled = ${v}, reply_enabled = ${v} WHERE guild_id = ${guildId}`;
    this.settingsCache.delete(guildId);
  }

  /** Per-server proactive opt-in — independent of memory/reply pause. */
  async setProactive(guildId: string, enabled: boolean, defaultRetentionDays = 30): Promise<void> {
    await this.ensureSettings(guildId, defaultRetentionDays);
    await this.sql`UPDATE server_settings SET proactive_enabled = ${enabled ? 1 : 0} WHERE guild_id = ${guildId}`;
    this.settingsCache.delete(guildId);
  }

  /** Channels the bot treats as fully invisible — no archive, replies, or
   * member writes there, and server-build scans skip them. */
  async setIgnoredChannels(guildId: string, channelIds: string[], defaultRetentionDays = 30): Promise<void> {
    await this.ensureSettings(guildId, defaultRetentionDays);
    await this.sql`UPDATE server_settings SET ignored_channels = ${channelIds} WHERE guild_id = ${guildId}`;
    this.settingsCache.delete(guildId);
  }

  /** Per-guild daily LLM-call bound — enforced by the metered client in
   * brains.ts against guild_usage, for every key source (guild or env). */
  async setDailyCap(guildId: string, cap: number, defaultRetentionDays = 30): Promise<void> {
    await this.ensureSettings(guildId, defaultRetentionDays);
    await this.sql`UPDATE server_settings SET llm_daily_cap = ${cap} WHERE guild_id = ${guildId}`;
    this.settingsCache.delete(guildId);
  }

  /** Atomic per-guild daily LLM-call charge. The INSERT..ON CONFLICT takes the
   * (guild_id, day) row lock, so concurrent charges serialize — the counter can
   * never overshoot the cap. Days are UTC so the BudgetExceeded reschedule
   * (next UTC midnight) matches the counter reset. Returns ok=false without
   * incrementing when the guild is already at/over cap. */
  async chargeLlmCall(guildId: string, cap: number): Promise<{ ok: boolean; used: number; cap: number }> {
    if (cap <= 0) return { ok: false, used: 0, cap };
    const rows = await this.sql<Array<{ llm_calls: number }>>`
      INSERT INTO guild_usage (guild_id, day, llm_calls)
      VALUES (${guildId}, (now() AT TIME ZONE 'UTC')::date, 1)
      ON CONFLICT (guild_id, day) DO UPDATE SET llm_calls = guild_usage.llm_calls + 1
      WHERE guild_usage.llm_calls < ${cap}
      RETURNING llm_calls
    `;
    return rows.length ? { ok: true, used: rows[0].llm_calls, cap } : { ok: false, used: cap, cap };
  }

  async usageToday(guildId: string): Promise<number> {
    const rows = await this.sql<Array<{ llm_calls: number }>>`
      SELECT llm_calls FROM guild_usage WHERE guild_id = ${guildId} AND day = (now() AT TIME ZONE 'UTC')::date
    `;
    return rows[0]?.llm_calls ?? 0;
  }

  /** Queue visibility for /status — pending work, dead-lettered rows
   * (attempts >= 5: excluded from claiming but kept inspectable), and the
   * oldest pending job's age so a draining-but-stale queue is visible. */
  async queueStats(guildId: string): Promise<{ pending: number; dead: number; oldestPendingAt: Date | null }> {
    const rows = await this.sql<Array<{ pending: number; dead: number; oldest: Date | string | null }>>`
      SELECT count(*) FILTER (WHERE attempts < 5)::int AS pending,
             count(*) FILTER (WHERE attempts >= 5)::int AS dead,
             min(created_at) FILTER (WHERE attempts < 5) AS oldest
      FROM jobs WHERE guild_id = ${guildId}
    `;
    const r = rows[0];
    return { pending: r?.pending ?? 0, dead: r?.dead ?? 0, oldestPendingAt: r?.oldest ? new Date(r.oldest) : null };
  }

  /** Reconcile triage marks against job reality. 'queued'/'durable'/'regex'
   * only mean "extraction was requested" — the mark is the source of truth the
   * sweep reads, the job row is the source of truth for whether work exists.
   * Three corrections:
   *   1. any extraction-marked message with a live job → 'queued' (canonical;
   *      also dedupes the enqueue-succeeded-but-mark-write-failed window)
   *   2. 'queued' whose only jobs are dead-lettered → 'dead': terminal for the
   *      sweep, still reachable by /profile-build's <> 'extracted' scan, and
   *      overwritten by 'extracted' if the job is later re-driven
   *   3. 'queued' with no job at all (dormant-drop, crash windows) → 'durable'
   *      so the sweep re-enqueues it — listUninspectedMessages reads
   *      durable/regex marks at any age, so no window can strand them */
  async repairQueuedMarks(guildId: string): Promise<{ rejoined: number; dead: number; requeued: number }> {
    return this.sql.begin(async sql => {
      const joined = await sql<Array<{ n: number }>>`
        WITH upd AS (
          UPDATE messages m SET triage_result = 'queued'
          WHERE m.guild_id = ${guildId} AND m.triage_result IN ('durable', 'regex')
            AND EXISTS (
              SELECT 1 FROM jobs j
              WHERE j.guild_id = m.guild_id AND j.attempts < 5
                AND j.payload->'event'->>'messageId' = m.id
            )
          RETURNING 1
        ) SELECT count(*)::int AS n FROM upd
      `;
      const deadRows = await sql<Array<{ n: number }>>`
        WITH upd AS (
          UPDATE messages m SET triage_result = 'dead'
          WHERE m.guild_id = ${guildId} AND m.triage_result = 'queued'
            AND NOT EXISTS (
              SELECT 1 FROM jobs j
              WHERE j.guild_id = m.guild_id AND j.attempts < 5
                AND j.payload->'event'->>'messageId' = m.id
            )
            AND EXISTS (
              SELECT 1 FROM jobs j
              WHERE j.guild_id = m.guild_id AND j.attempts >= 5
                AND j.payload->'event'->>'messageId' = m.id
            )
          RETURNING 1
        ) SELECT count(*)::int AS n FROM upd
      `;
      const requeueRows = await sql<Array<{ n: number }>>`
        WITH upd AS (
          UPDATE messages m SET triage_result = 'durable'
          WHERE m.guild_id = ${guildId} AND m.triage_result = 'queued'
            AND NOT EXISTS (
              SELECT 1 FROM jobs j
              WHERE j.guild_id = m.guild_id
                AND j.payload->'event'->>'messageId' = m.id
            )
          RETURNING 1
        ) SELECT count(*)::int AS n FROM upd
      `;
      return { rejoined: joined[0]?.n ?? 0, dead: deadRows[0]?.n ?? 0, requeued: requeueRows[0]?.n ?? 0 };
    });
  }

  // ── Guild LLM keys (BYOK) ────────────────────────────────────────────────────
  // key_enc is AES-256-GCM ciphertext (secrets.ts) — never log or return it to
  // Discord. key_hint (last-4) is the only plaintext remnant, for masked display.

  async getGuildKey(guildId: string): Promise<{ keyEnc: Buffer; keyHint: string; baseUrl: string | null; validatedAt: string | null } | null> {
    const rows = await this.sql<Array<{ key_enc: Buffer; key_hint: string; base_url: string | null; validated_at: Date | string | null }>>`
      SELECT key_enc, key_hint, base_url, validated_at FROM guild_keys WHERE guild_id = ${guildId}
    `;
    const r = rows[0];
    return r ? { keyEnc: r.key_enc, keyHint: r.key_hint, baseUrl: r.base_url, validatedAt: r.validated_at ? ts(r.validated_at) : null } : null;
  }

  async upsertGuildKey(guildId: string, key: { keyEnc: Buffer; keyHint: string; baseUrl: string | null; validatedAt: string | null }): Promise<void> {
    await this.sql`
      INSERT INTO guild_keys (guild_id, key_enc, key_hint, base_url, validated_at)
      VALUES (${guildId}, ${key.keyEnc}, ${key.keyHint}, ${key.baseUrl}, ${key.validatedAt})
      ON CONFLICT (guild_id) DO UPDATE
      SET key_enc = ${key.keyEnc}, key_hint = ${key.keyHint}, base_url = ${key.baseUrl},
          validated_at = ${key.validatedAt}, updated_at = now()
    `;
  }

  /** Mark a stored key live-verified — set after the first successful use. */
  async markGuildKeyValidated(guildId: string): Promise<void> {
    await this.sql`UPDATE guild_keys SET validated_at = now() WHERE guild_id = ${guildId} AND validated_at IS NULL`;
  }

  async deleteGuildKey(guildId: string): Promise<void> {
    await this.sql`DELETE FROM guild_keys WHERE guild_id = ${guildId}`;
  }

  /** Kick-purge: delete EVERY row belonging to a guild, in FK-dependency
   * order, in one transaction. Called on GuildDelete (bot kicked/removed) —
   * "kick the bot, your data goes with it." memory_history, the event junction
   * tables, and memory_evidence carry no guild_id — they delete through their
   * parent keys. Junction/history deletes match on EITHER parent's guild so
   * legacy cross-guild links can't strand an FK. memories.event_id,
   * memory_evidence.message_id, memories.superseded_by and
   * profile_attributes.memory_ids are unfenced — no ordering hazard. */
  async purgeGuild(guildId: string): Promise<void> {
    await this.sql.begin(async tx => {
      // Children of memories/events first (no guild_id on these tables).
      await tx`DELETE FROM memory_history WHERE memory_id IN (SELECT id FROM memories WHERE guild_id = ${guildId})
        OR evidence_id IN (SELECT id FROM memory_evidence WHERE memory_id IN (SELECT id FROM memories WHERE guild_id = ${guildId}))`;
      await tx`DELETE FROM event_memories WHERE event_id IN (SELECT id FROM events WHERE guild_id = ${guildId})
        OR memory_id IN (SELECT id FROM memories WHERE guild_id = ${guildId})`;
      await tx`DELETE FROM event_participants WHERE event_id IN (SELECT id FROM events WHERE guild_id = ${guildId})`;
      await tx`DELETE FROM event_messages WHERE event_id IN (SELECT id FROM events WHERE guild_id = ${guildId})`;
      await tx`DELETE FROM memory_evidence WHERE memory_id IN (SELECT id FROM memories WHERE guild_id = ${guildId})`;
      // Parents, then every guild-scoped table.
      await tx`DELETE FROM memories WHERE guild_id = ${guildId}`;
      await tx`DELETE FROM events WHERE guild_id = ${guildId}`;
      await tx`DELETE FROM profile_attributes WHERE guild_id = ${guildId}`;
      await tx`DELETE FROM profiles WHERE guild_id = ${guildId}`;
      await tx`DELETE FROM relationship_observations WHERE guild_id = ${guildId}`;
      await tx`DELETE FROM relationships WHERE guild_id = ${guildId}`;
      await tx`DELETE FROM behavioral_patterns WHERE guild_id = ${guildId}`;
      await tx`DELETE FROM alias_candidates WHERE guild_id = ${guildId}`;
      await tx`DELETE FROM unresolved_names WHERE guild_id = ${guildId}`;
      await tx`DELETE FROM members WHERE guild_id = ${guildId}`;
      await tx`DELETE FROM messages WHERE guild_id = ${guildId}`;
      await tx`DELETE FROM guild_keys WHERE guild_id = ${guildId}`;
      // Queued jobs and usage counters are guild-scoped too — a kicked guild
      // leaves nothing behind, including pending work.
      await tx`DELETE FROM jobs WHERE guild_id = ${guildId}`;
      await tx`DELETE FROM guild_usage WHERE guild_id = ${guildId}`;
      await tx`DELETE FROM server_settings WHERE guild_id = ${guildId}`;
    });
    this.settingsCache.delete(guildId);
  }

  /** Guild ids present in guild-scoped tables but absent from the given set —
   * zombies left when an in-flight write races a kick-purge and re-inserts a
   * row after it commits: a maintenance tick's ensureSettings/setMemberOptIn,
   * or an extract job claimed before the purge that lands memories, events,
   * relationship observations, or attributes afterward. Caller is
   * responsible for passing a populated cache — an empty set is treated as
   * "cache not ready" and returns nothing. */
  async guildsNotIn(guildIds: string[]): Promise<string[]> {
    if (!guildIds.length) return [];
    const rows = await this.sql<{ guild_id: string }[]>`
      SELECT guild_id FROM server_settings WHERE NOT (guild_id = ANY(${guildIds}))
      UNION SELECT guild_id FROM members WHERE NOT (guild_id = ANY(${guildIds}))
      UNION SELECT guild_id FROM memories WHERE NOT (guild_id = ANY(${guildIds}))
      UNION SELECT guild_id FROM events WHERE NOT (guild_id = ANY(${guildIds}))
      UNION SELECT guild_id FROM relationship_observations WHERE NOT (guild_id = ANY(${guildIds}))
      UNION SELECT guild_id FROM profile_attributes WHERE NOT (guild_id = ANY(${guildIds}))
      UNION SELECT guild_id FROM jobs WHERE NOT (guild_id = ANY(${guildIds}))`;
    return rows.map(r => r.guild_id);
  }

  // ── Messages ───────────────────────────────────────────────────────────────

  async recordMessage(event: MessageEvent, replyToId?: string, trackMember = true, authorIsBot = false): Promise<void> {
    // Insert-only dedup: a conflict means the message was already archived
    // (re-ingest), so member stats must not double-count. Name/seen-at merges
    // still run — they're idempotent by construction.
    const inserted = await this.sql`
      INSERT INTO messages (id, guild_id, channel_id, author_id, author_name, content, created_at, reply_to_id, author_is_bot)
      VALUES (${event.messageId}, ${event.guildId}, ${event.channelId}, ${event.authorId}, ${event.authorName}, ${event.content}, ${event.createdAt.toISOString()}, ${replyToId ?? null}, ${authorIsBot})
      ON CONFLICT (id) DO NOTHING
    `;
    if (inserted.count === 0 && replyToId) {
      // Pre-existing rows can still gain a reply edge on re-ingest.
      await this.sql`UPDATE messages SET reply_to_id = ${replyToId} WHERE id = ${event.messageId} AND reply_to_id IS NULL`;
    }
    // Bot-authored rows are archive-only context — no member registry entry,
    // so bots never accrue message_count or become profile-eligible.
    if (trackMember) await this.upsertMember(event.guildId, event.authorId, event.authorName, event.createdAt, inserted.count > 0);
  }

  /** Edited message — update the archive row only. Evidence snapshots keep the
   * extraction-time text on purpose: rewriting them would falsify the record
   * of what the memory was actually derived from. */
  async updateMessageContent(guildId: string, messageId: string, content: string): Promise<void> {
    await this.sql`UPDATE messages SET content = ${content} WHERE guild_id = ${guildId} AND id = ${messageId}`;
  }

  /** Deleted message — remove the raw row so sweeps and context never see it
   * again, and scrub the verbatim text columns on any evidence it produced.
   * Evidence metadata (type, effect, reason) stays: the audit trail keeps the
   * "why" without keeping the deleted words. */
  async deleteMessage(guildId: string, messageId: string): Promise<void> {
    await this.sql.begin(async sql => {
      await sql`DELETE FROM messages WHERE guild_id = ${guildId} AND id = ${messageId}`;
      await sql`UPDATE memory_evidence SET quote = '', message_content_snapshot = '' WHERE message_id = ${messageId}`;
    });
  }

  // ── Members ────────────────────────────────────────────────────────────────
  // The members table is the member registry: one row per (guild, user) tracking every
  // display name observed, message counts, and first/last activity. It backs the
  // entity-resolution alias map and per-chatter profiles.

  async upsertMember(guildId: string, userId: string, displayName: string, at: Date, countMessage = true): Promise<void> {
    const inc = countMessage ? 1 : 0;
    await this.sql`
      INSERT INTO members (guild_id, user_id, known_names, first_seen_at, last_seen_at, message_count)
      VALUES (${guildId}, ${userId}, ${[displayName]}, ${at.toISOString()}, ${at.toISOString()}, ${inc})
      ON CONFLICT (guild_id, user_id) DO UPDATE SET
        known_names   = CASE
          WHEN ${displayName} = ANY(members.known_names) THEN members.known_names
          WHEN cardinality(members.known_names) >= ${MAX_KNOWN_NAMES}
            THEN array_append(members.known_names[2:cardinality(members.known_names)], ${displayName})
          ELSE array_append(members.known_names, ${displayName})
        END,
        first_seen_at = LEAST(members.first_seen_at, EXCLUDED.first_seen_at),
        last_seen_at  = GREATEST(members.last_seen_at, EXCLUDED.last_seen_at),
        message_count = members.message_count + ${inc}
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
    // still stick for when they do. Opting out also revokes opt-in — the
    // opt-out flag always wins.
    await this.sql`
      INSERT INTO members (guild_id, user_id, known_names, first_seen_at, last_seen_at, message_count, opted_out, opted_in)
      VALUES (${guildId}, ${userId}, '{}', NOW(), NOW(), 0, ${optedOut ? 1 : 0}, 0)
      ON CONFLICT (guild_id, user_id) DO UPDATE
      SET opted_out = ${optedOut ? 1 : 0}, opted_in = CASE WHEN ${optedOut} THEN 0 ELSE members.opted_in END
    `;
  }

  async setMemberOptIn(guildId: string, userId: string, optedIn: boolean): Promise<void> {
    // Upsert like setMemberOptOut — a member can opt in before ever posting.
    // Opting in never clears opted_out; derived data requires opted_in=1 AND
    // opted_out=0, so an opted-out member stays protected even if both flags
    // end up set.
    await this.sql`
      INSERT INTO members (guild_id, user_id, known_names, first_seen_at, last_seen_at, message_count, opted_in)
      VALUES (${guildId}, ${userId}, '{}', NOW(), NOW(), 0, ${optedIn ? 1 : 0})
      ON CONFLICT (guild_id, user_id) DO UPDATE SET opted_in = ${optedIn ? 1 : 0}
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
        UPDATE members SET known_names = CASE
          WHEN cardinality(known_names) >= ${MAX_KNOWN_NAMES}
            THEN array_append(known_names[2:cardinality(known_names)], ${clean})
          ELSE array_append(known_names, ${clean})
        END
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

  /** Bulk displayNameFor — at most two queries for any batch size: one member
   * lookup plus a DISTINCT ON fallback scan for ids with no known names. */
  async displayNamesFor(guildId: string, userIds: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (!userIds.length) return out;
    const members = await this.sql<Array<{ user_id: string; known_names: string[] }>>`
      SELECT user_id, known_names FROM members WHERE guild_id = ${guildId} AND user_id = ANY(${userIds})
    `;
    const missing: string[] = [];
    for (const id of userIds) {
      const m = members.find(r => r.user_id === id);
      if (m && m.known_names.length) out.set(id, m.known_names[m.known_names.length - 1]);
      else missing.push(id);
    }
    if (missing.length) {
      const rows = await this.sql<Array<{ author_id: string; author_name: string }>>`
        SELECT DISTINCT ON (author_id) author_id, author_name FROM messages
        WHERE guild_id = ${guildId} AND author_id = ANY(${missing})
        ORDER BY author_id, created_at DESC
      `;
      for (const r of rows) out.set(r.author_id, r.author_name);
    }
    for (const id of userIds) if (!out.has(id)) out.set(id, id);
    return out;
  }

  // ── Relationships ──────────────────────────────────────────────────────────
  // Relationship assertions are stored as idempotent observations keyed by
  // (subject_id, other_id, message_id). Observations carry a sincerity verdict;
  // the `relationships` edge table is fully derived — rebuilt by
  // recomputeEdges() from 'literal'-verdicted observations only, so an
  // unverified assertion never surfaces in profiles or dossiers. Edges
  // materialize at the next maintenance pass, not at record time.

  // authorId is the assertor — the member whose message the claim came from.
  // Stored because the subject/other pair alone can't tell self-report from
  // third-party assertion, and opt-out must erase a member's authored claims
  // even when the message itself is gone.
  async recordRelationship(guildId: string, subjectId: string, otherId: string, messageId: string, authorId: string, nature: string, valence: number | null, reason = ""): Promise<boolean> {
    if (subjectId === otherId || subjectId === "unknown" || otherId === "unknown" || subjectId === "server" || otherId === "server") return false;
    const inserted = await this.sql`
      INSERT INTO relationship_observations (guild_id, subject_id, other_id, message_id, author_id, nature, valence, reason)
      VALUES (${guildId}, ${subjectId}, ${otherId}, ${messageId}, ${authorId}, ${nature}, ${valence}, ${reason})
      ON CONFLICT (subject_id, other_id, message_id) DO NOTHING
      RETURNING id
    `;
    return inserted.length > 0;
  }

  /** All edges where the subject is either side of the relationship — claimed
   * edges first by depth, then behavior-only (inferred) edges by contact
   * frequency. */
  async relationshipsFor(guildId: string, subjectId: string): Promise<RelationshipEdge[]> {
    const rows = await this.sql<RelationshipRow[]>`
      SELECT id, guild_id, subject_id, other_id, summary, valence, observation_count,
             last_observed_at, updated_at, behavioral_count, party_count, trend, inferred
      FROM relationships
      WHERE guild_id = ${guildId} AND (subject_id = ${subjectId} OR other_id = ${subjectId})
      ORDER BY inferred ASC, observation_count DESC, behavioral_count DESC
    `;
    return rows.map(rowToEdge);
  }

  // ── Sincerity verification ─────────────────────────────────────────────────
  // Extraction can mislabel edgy humor as explicit_fact/clear_preference. A
  // second-pass LLM judgment against the stored source message gates promotion:
  // jokes are re-classified sarcasm_or_joke, verified literal self-reports go
  // active, and third-party literals stay candidate pending corroboration.

  /** Per-row "preceding context" in one round trip: for each (channel, ts)
   * anchor the LATERAL grabs the 5 messages before it, keyed back to the row
   * index. Replaces a per-row query in the verification list functions. */
  private async _contextBefore(guildId: string, anchors: Array<{ ix: number; channelId: string; createdAt: Date | string }>): Promise<Map<number, Array<{ authorName: string; content: string }>>> {
    const out = new Map<number, Array<{ authorName: string; content: string }>>();
    if (!anchors.length) return out;
    const rows = await this.sql<Array<{ ix: number; author_name: string; content: string; created_at: Date | string }>>`
      SELECT t.ix, m.author_name, m.content, m.created_at
      FROM unnest(${anchors.map(a => a.ix)}::int[], ${anchors.map(a => a.channelId)}::text[], ${anchors.map(a => new Date(a.createdAt).toISOString())}::timestamptz[]) AS t(ix, channel_id, ts)
      JOIN LATERAL (
        SELECT author_name, content, created_at FROM messages
        WHERE guild_id = ${guildId} AND channel_id = t.channel_id AND created_at < t.ts
        ORDER BY created_at DESC LIMIT 5
      ) m ON true
      ORDER BY t.ix, m.created_at DESC
    `;
    for (const r of rows) {
      const list = out.get(r.ix) ?? [];
      list.unshift({ authorName: r.author_name, content: r.content });
      out.set(r.ix, list);
    }
    return out;
  }

  /** Candidate memories with promotable evidence types, joined to their first source message.
   * Carries the author's known names and the messages preceding the source so the
   * verifier can spot pasted/quoted text and jokes that only read literal in isolation. */
  async listVerifiableCandidates(guildId: string, limit = 200, subjectId?: string): Promise<Array<{
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
        ${subjectId ? this.sql`AND m.subject_id = ${subjectId}` : this.sql``}
      ORDER BY m.id
      LIMIT ${limit}
    `;
    const ctxMap = await this._contextBefore(guildId, rows.flatMap((r, i) =>
      r.channel_id && r.msg_created_at ? [{ ix: i, channelId: r.channel_id, createdAt: r.msg_created_at }] : []));
    return rows.map((r, i) => ({
      memoryId: Number(r.memory_id), subjectId: r.subject_id, kind: r.kind as Memory["kind"],
      content: r.content, evidenceType: r.primary_evidence_type, selfReport: r.self_report,
      authorName: r.author_name ?? r.subject_id, authorNames: r.author_names ?? [],
      sourceMessage: r.source_message, contextBefore: ctxMap.get(i) ?? [],
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
        await recomputeForMemories(sql, mem.guildId, [memoryId]);
        await this._logHistory(sql, memoryId, "misattributed", mem.confidence, mem.confidence, "candidate", "forgotten", null, { reason });
        return "rejected";
      }

      if (verdict === "joke") {
        const jokeConfidence = calculateInitialConfidence("sarcasm_or_joke");
        await sql`UPDATE memories SET primary_evidence_type = 'sarcasm_or_joke', confidence = ${jokeConfidence}, updated_at = NOW() WHERE id = ${memoryId}`;
        await sql`UPDATE memory_evidence SET evidence_type = 'sarcasm_or_joke' WHERE memory_id = ${memoryId}`;
        await recomputeForMemories(sql, mem.guildId, [memoryId]);
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
          await recomputeForMemories(sql, mem.guildId, [memoryId]);
          await this._logHistory(sql, memoryId, "verified_active", mem.confidence, mem.confidence, "candidate", "active", null, { reason });
          return "promoted";
        }
        await this._logHistory(sql, memoryId, "verified_literal", mem.confidence, mem.confidence, "candidate", "candidate", null, { reason });
      }
      return "unchanged";
    });
  }

  // ── Dossier inputs ─────────────────────────────────────────────────────────

  /** Up to 60 raw messages for voice analysis — most recent, deterministic so
   * the section hash only changes when the member actually posts again. */
  async sampleMessages(guildId: string, authorId: string): Promise<Array<{ content: string; createdAt: string }>> {
    const rows = await this.sql<Array<{ content: string; created_at: Date | string }>>`
      SELECT content, created_at FROM messages
      WHERE guild_id = ${guildId} AND author_id = ${authorId} AND length(content) > 0
      ORDER BY created_at DESC LIMIT 60
    `;
    return rows.map(r => ({ content: r.content, createdAt: ts(r.created_at) }));
  }

  /** Literal-verdicted relationship observations (with reasons) involving a
   * member — either as the asserting side ("member_subject") or the observed
   * side ("member_other"). otherId is always the counterparty. Dossier
   * relationship_map input; unverified assertions stay invisible here too. */
  async relationshipObservationsFor(guildId: string, subjectId: string): Promise<Array<{
    otherId: string; nature: string; valence: number | null; reason: string;
    direction: "member_subject" | "member_other"; source: string; createdAt: string;
  }>> {
    const rows = await this.sql<Array<{
      subject_id: string; other_id: string; nature: string; valence: number | null; reason: string; source: string; created_at: Date | string;
    }>>`
      SELECT subject_id, other_id, nature, valence, reason, source, created_at FROM relationship_observations
      WHERE guild_id = ${guildId} AND (subject_id = ${subjectId} OR other_id = ${subjectId})
        AND verdict = 'literal'
      ORDER BY created_at DESC
    `;
    return rows.map(r => ({
      otherId: r.subject_id === subjectId ? r.other_id : r.subject_id,
      nature: r.nature,
      valence: r.valence != null ? Number(r.valence) : null,
      reason: r.reason,
      direction: r.subject_id === subjectId ? "member_subject" as const : "member_other" as const,
      source: r.source,
      createdAt: ts(r.created_at),
    }));
  }

  /** Everything the graph knows about one ordered pair: directed edges both
   * ways, recent literal observations (subject_id is the asserting side), and
   * the active memories each has authored about the other. Reply-path input —
   * pairwise theory of mind distinct from either member's standalone profile. */
  async pairwiseContext(guildId: string, aId: string, bId: string): Promise<{
    ab?: RelationshipEdge;
    ba?: RelationshipEdge;
    observations: Array<{ fromId: string; toId: string; nature: string; valence: number | null; reason: string; source: string; createdAt: string }>;
    claimsAboutA: string[];   // active memories about aId authored by bId
    claimsAboutB: string[];   // active memories about bId authored by aId
    /** Undirected 90d interaction count — from whichever edge rows carry the
     *  stamp (claimed or inferred). Zero when the pair never registered. */
    behavioralCount: number;
  }> {
    // Subject-consent: pair context only renders when at least one side opted
    // in — an edge between two non-consenting members can't be formed now, and
    // a straggler from before consent enforcement stays hidden.
    const consentRows = await this.sql<Array<{ user_id: string }>>`
      SELECT user_id FROM members
      WHERE guild_id = ${guildId} AND opted_in = 1 AND opted_out = 0
        AND user_id IN (${aId}, ${bId})
    `;
    if (!consentRows.length) return { observations: [], claimsAboutA: [], claimsAboutB: [], behavioralCount: 0 };
    const edgeRows = await this.sql<RelationshipRow[]>`
      SELECT id, guild_id, subject_id, other_id, summary, valence, observation_count,
             last_observed_at, updated_at, behavioral_count, party_count, trend, inferred
      FROM relationships
      WHERE guild_id = ${guildId}
        AND ((subject_id = ${aId} AND other_id = ${bId}) OR (subject_id = ${bId} AND other_id = ${aId}))
    `;

    const obsRows = await this.sql<Array<{
      subject_id: string; other_id: string; nature: string; valence: number | null; reason: string; source: string; created_at: Date | string;
    }>>`
      SELECT subject_id, other_id, nature, valence, reason, source, created_at FROM relationship_observations
      WHERE guild_id = ${guildId} AND verdict = 'literal'
        AND ((subject_id = ${aId} AND other_id = ${bId}) OR (subject_id = ${bId} AND other_id = ${aId}))
      ORDER BY created_at DESC LIMIT 5
    `;

    const claimRows = await this.sql<Array<{ subject_id: string; content: string; confidence: number }>>`
      SELECT DISTINCT m.subject_id, m.content, m.confidence
      FROM memories m
      JOIN memory_evidence e ON e.memory_id = m.id
      WHERE m.guild_id = ${guildId} AND m.status = 'active'
        AND ((m.subject_id = ${aId} AND e.author_id = ${bId}) OR (m.subject_id = ${bId} AND e.author_id = ${aId}))
      ORDER BY m.subject_id, m.confidence DESC LIMIT 8
    `;

    const ab = edgeRows.find(r => r.subject_id === aId);
    const ba = edgeRows.find(r => r.subject_id === bId);
    return {
      ab: ab ? rowToEdge(ab) : undefined,
      ba: ba ? rowToEdge(ba) : undefined,
      behavioralCount: edgeRows.reduce((m, r) => Math.max(m, Number(r.behavioral_count)), 0),
      observations: obsRows.map(r => ({
        fromId: r.subject_id, toId: r.other_id, nature: r.nature,
        valence: r.valence != null ? Number(r.valence) : null,
        reason: r.reason, source: r.source, createdAt: ts(r.created_at),
      })),
      claimsAboutA: claimRows.filter(r => r.subject_id === aId).slice(0, 3).map(r => r.content),
      claimsAboutB: claimRows.filter(r => r.subject_id === bId).slice(0, 3).map(r => r.content),
    };
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
    // Bounded to 90 days — the interaction graph is a recency signal anyway,
    // and this is the one query that reads the entire archive otherwise.
    const rows = await this.sql<Array<{ author_id: string; content: string; created_at: Date | string }>>`
      SELECT author_id, content, created_at FROM messages
      WHERE guild_id = ${guildId} AND length(content) > 0
        AND created_at > NOW() - interval '90 days'
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
   * observation-weighted, natures unioned (latest first). behavioralCount is
   * the undirected interaction stamp (max across directions — same number);
   * trend comes from the most recently observed edge. */
  async mergedEdges(guildId: string, subjectId: string): Promise<Array<{
    otherId: string; summary: string; natures: string[];
    valence: number | null; observationCount: number; lastObservedAt: string | null;
    behavioralCount: number; trend: string | null; inferred: boolean;
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
        behavioralCount: list.reduce((m, e) => Math.max(m, e.behavioralCount), 0),
        trend: byRecency[0].trend,
        inferred: list.every(e => e.inferred),
      };
    }).sort((a, b) => b.observationCount - a.observationCount || b.behavioralCount - a.behavioralCount);
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
      LEFT JOIN members mem ON mem.guild_id = o.guild_id AND mem.user_id = COALESCE(o.author_id, msg.author_id)
      WHERE o.guild_id = ${guildId} AND o.verdict IS NULL
      ORDER BY o.id LIMIT ${limit}
    `;
    const ctxMap = await this._contextBefore(guildId, rows.flatMap((r, i) =>
      r.channel_id && r.msg_created_at ? [{ ix: i, channelId: r.channel_id, createdAt: r.msg_created_at }] : []));
    return rows.map((r, i) => ({
      observationId: Number(r.id), subjectId: r.subject_id, otherId: r.other_id,
      nature: r.nature, authorName: r.author_name ?? r.subject_id,
      authorNames: r.author_names ?? [], sourceMessage: r.source_message, contextBefore: ctxMap.get(i) ?? [],
    }));
  }

  async setObservationVerdict(observationId: number, verdict: string): Promise<void> {
    await this.sql`UPDATE relationship_observations SET verdict = ${verdict} WHERE id = ${observationId}`;
  }

  /** Rebuild the durable edges from literal-verdicted observations only —
   * unverified, unclear, misattributed, and joke rows never form or feed an
   * edge (pair_window rows arrive pre-verdicted, so they flow through here
   * like any literal). Aggregation: valence is the *weighted* average of the
   * five most recent observations — a claim authored by an edge party weighs
   * double a third party's, so a pair's own words outweigh gossip. summary is
   * the modal nature over the same window (latest-nature flip-flops under
   * contradiction); trend compares recent-vs-alltime weighted valence.
   *
   * `interactions` is the deterministic 90d interaction graph (from
   * interactionPairs): stamped onto claimed edges as behavioral_count, and
   * pairs with frequent contact but no claims materialize as inferred edges —
   * rows that render as contact frequency, never as a relationship claim.
   * This is the sole writer to `relationships`. Delete + re-aggregate in one
   * transaction; returns the edge count. */
  async recomputeEdges(
    guildId: string,
    interactions: Array<{ aId: string; bId: string; count: number }> = []
  ): Promise<number> {
    return await this.sql.begin(async sql => {
      await sql`DELETE FROM relationships WHERE guild_id = ${guildId}`;
      const inserted = await sql`
        INSERT INTO relationships (guild_id, subject_id, other_id, summary, valence, observation_count, party_count, trend, behavioral_count, inferred, last_observed_at, updated_at)
        SELECT guild_id, subject_id, other_id,
               COALESCE(summary, ''), recent_val, n, party_n,
               CASE WHEN n >= 3 AND recent_val - all_val >= 0.2 THEN 'warming'
                    WHEN n >= 3 AND recent_val - all_val <= -0.2 THEN 'cooling' END,
               0, 0, last_at, NOW()
        FROM (
          SELECT guild_id, subject_id, other_id,
                 MODE() WITHIN GROUP (ORDER BY nature) FILTER (WHERE rn <= 5) AS summary,
                 SUM(valence * w) FILTER (WHERE rn <= 5 AND valence IS NOT NULL)
                   / NULLIF(SUM(w) FILTER (WHERE rn <= 5 AND valence IS NOT NULL), 0) AS recent_val,
                 SUM(valence * w) FILTER (WHERE valence IS NOT NULL)
                   / NULLIF(SUM(w) FILTER (WHERE valence IS NOT NULL), 0) AS all_val,
                 COUNT(*)::int AS n,
                 COUNT(*) FILTER (WHERE author_id IN (subject_id, other_id))::int AS party_n,
                 MAX(created_at) AS last_at
          FROM (
            SELECT *, CASE WHEN author_id IN (subject_id, other_id) THEN 2 ELSE 1 END AS w,
                   ROW_NUMBER() OVER (PARTITION BY guild_id, subject_id, other_id ORDER BY created_at DESC) rn
            FROM relationship_observations
            WHERE guild_id = ${guildId} AND verdict = 'literal'
          ) lit
          GROUP BY guild_id, subject_id, other_id
        ) agg
        RETURNING id
      `;
      let total = inserted.length;
      if (interactions.length) {
        const aIds = interactions.map(p => p.aId);
        const bIds = interactions.map(p => p.bId);
        const cnts = interactions.map(p => p.count);
        // The interaction stamp is undirected — write it on both directions
        // of any claimed edge so readers see it from either side.
        await sql`
          UPDATE relationships r SET behavioral_count = v.cnt
          FROM (SELECT * FROM unnest(${aIds}::text[], ${bIds}::text[], ${cnts}::int[])) AS v(a_id, b_id, cnt)
          WHERE r.guild_id = ${guildId}
            AND ((r.subject_id = v.a_id AND r.other_id = v.b_id)
              OR (r.subject_id = v.b_id AND r.other_id = v.a_id))
        `;
        // Inferred edges: frequent contact, zero claims. Both directions so
        // directional reads see the pair symmetrically. Subject-consent at
        // write — at least one party opted in, same rule as observations.
        const inferred = await sql`
          INSERT INTO relationships (guild_id, subject_id, other_id, summary, valence, observation_count, party_count, behavioral_count, inferred, last_observed_at, updated_at)
          SELECT ${guildId}, v.a_id, v.b_id, '', NULL::double precision, 0, 0, v.cnt, 1, NULL::timestamptz, NOW()
          FROM (SELECT * FROM unnest(${aIds}::text[], ${bIds}::text[], ${cnts}::int[])) AS v(a_id, b_id, cnt)
          WHERE v.cnt >= 5
            AND NOT EXISTS (
              SELECT 1 FROM relationships r WHERE r.guild_id = ${guildId}
                AND ((r.subject_id = v.a_id AND r.other_id = v.b_id)
                  OR (r.subject_id = v.b_id AND r.other_id = v.a_id)))
            AND EXISTS (
              SELECT 1 FROM members m WHERE m.guild_id = ${guildId}
                AND m.user_id IN (v.a_id, v.b_id) AND m.opted_in = 1 AND m.opted_out = 0)
          UNION ALL
          SELECT ${guildId}, v.b_id, v.a_id, '', NULL::double precision, 0, 0, v.cnt, 1, NULL::timestamptz, NOW()
          FROM (SELECT * FROM unnest(${aIds}::text[], ${bIds}::text[], ${cnts}::int[])) AS v(a_id, b_id, cnt)
          WHERE v.cnt >= 5
            AND NOT EXISTS (
              SELECT 1 FROM relationships r WHERE r.guild_id = ${guildId}
                AND ((r.subject_id = v.a_id AND r.other_id = v.b_id)
                  OR (r.subject_id = v.b_id AND r.other_id = v.a_id)))
            AND EXISTS (
              SELECT 1 FROM members m WHERE m.guild_id = ${guildId}
                AND m.user_id IN (v.a_id, v.b_id) AND m.opted_in = 1 AND m.opted_out = 0)
          RETURNING id
        `;
        total += inferred.length;
      }
      return total;
    });
  }

  /** Exchange-window fetch for the pair-analysis job: messages authored by
   * either party that address the other — <@id> mention or written name-ref
   * (the same signal interactionPairs counts). 90d-bounded, capped, returned
   * oldest-first for prompt readability. */
  async pairExchanges(
    guildId: string, aId: string, bId: string,
    aliasMap: Map<string, string>, limit = 40
  ): Promise<Array<{ id: string; authorId: string; authorName: string; content: string; createdAt: string }>> {
    const rows = await this.sql<Array<{ id: string; author_id: string; author_name: string; content: string; created_at: Date | string }>>`
      SELECT id, author_id, author_name, content, created_at FROM messages
      WHERE guild_id = ${guildId} AND author_id IN (${aId}, ${bId})
        AND length(content) > 0 AND created_at > NOW() - interval '90 days'
      ORDER BY created_at DESC LIMIT 500
    `;
    const exchanges: Array<{ id: string; authorId: string; authorName: string; content: string; createdAt: string }> = [];
    for (const r of rows) {
      const other = r.author_id === aId ? bId : aId;
      const mentioned = r.content.includes(`<@${other}>`) || r.content.includes(`<@!${other}>`)
        || findMentionedUsers(r.content, aliasMap).includes(other);
      if (mentioned) exchanges.push({ id: r.id, authorId: r.author_id, authorName: r.author_name, content: r.content, createdAt: ts(r.created_at) });
      if (exchanges.length >= limit) break;
    }
    return exchanges.reverse();
  }

  /** Last pair-window analysis for a pair — any verdict counts (unconfident
   * runs write 'unclear' markers so the timestamp still throttles retries). */
  async lastPairWindowAt(guildId: string, aId: string, bId: string): Promise<string | null> {
    const rows = await this.sql<Array<{ last_at: Date | string | null }>>`
      SELECT MAX(created_at) AS last_at FROM relationship_observations
      WHERE guild_id = ${guildId} AND source = 'pair_window'
        AND ((subject_id = ${aId} AND other_id = ${bId}) OR (subject_id = ${bId} AND other_id = ${aId}))
    `;
    return rows[0]?.last_at ? ts(rows[0].last_at) : null;
  }

  /** Persist a pair-window analysis as a symmetric observation pair. The
   * analysis IS the verification — confident reads land verdict='literal'
   * (edges feed immediately), unconfident runs land 'unclear' markers (no
   * edge feed, auto-pruned at 90d, and the row's timestamp throttles
   * re-analysis via lastPairWindowAt). author_id stays NULL: the system is
   * the assertor — opt-out deletion matches on edge parties regardless. */
  async recordWindowObservation(
    guildId: string, aId: string, bId: string, messageId: string,
    nature: string, valence: number | null, reason: string, confident: boolean
  ): Promise<void> {
    const verdict = confident ? "literal" : "unclear";
    await this.sql`
      INSERT INTO relationship_observations (guild_id, subject_id, other_id, message_id, author_id, nature, valence, reason, verdict, source)
      VALUES (${guildId}, ${aId}, ${bId}, ${messageId}, NULL, ${nature}, ${valence}, ${reason}, ${verdict}, 'pair_window'),
             (${guildId}, ${bId}, ${aId}, ${messageId}, NULL, ${nature}, ${valence}, ${reason}, ${verdict}, 'pair_window')
      ON CONFLICT (subject_id, other_id, message_id) DO NOTHING
    `;
  }

  /** Established nature labels for the extraction prompt — reuse keeps the
   * vocabulary coherent ("close friends" once, not a synonym zoo). */
  async relationshipNatureVocab(guildId: string, limit = 20): Promise<string[]> {
    const rows = await this.sql<Array<{ nature: string }>>`
      SELECT nature, COUNT(*) AS c FROM relationship_observations
      WHERE guild_id = ${guildId} AND verdict = 'literal'
      GROUP BY nature ORDER BY c DESC LIMIT ${limit}
    `;
    return rows.map(r => r.nature);
  }

  async getMessage(guildId: string, messageId: string): Promise<{ id: string; guildId: string; channelId: string; authorId: string; authorName: string; content: string; createdAt: string; authorIsBot: boolean } | undefined> {
    const rows = await this.sql<Array<MessageRow & { author_is_bot: boolean }>>`SELECT id, guild_id, channel_id, author_id, author_name, content, created_at, author_is_bot FROM messages WHERE guild_id = ${guildId} AND id = ${messageId}`;
    if (!rows[0]) return undefined;
    const r = rows[0];
    return { id: r.id, guildId: r.guild_id, channelId: r.channel_id, authorId: r.author_id, authorName: r.author_name, content: r.content, createdAt: ts(r.created_at), authorIsBot: r.author_is_bot };
  }

  async hasEvidence(messageId: string): Promise<boolean> {
    const rows = await this.sql<[{ c: number }]>`SELECT COUNT(*)::int as c FROM memory_evidence WHERE message_id = ${messageId}`;
    return rows[0].c > 0;
  }

  /** The targeted corpus for one member's /profile-build scan: messages they
   * authored, messages referencing them (mention markup or any known name),
   * and messages replying to theirs — bounded to the retention window and
   * capped, newest-first by the cap then chronological for extraction. */
  async messagesAboutSubject(
    guildId: string, userId: string, names: string[], since: Date, limit = 1000
  ): Promise<Array<{ id: string; channelId: string; authorId: string; authorName: string; content: string; createdAt: string; replyToContent?: string }>> {
    const patterns = [
      ...names.map(n => `%${escapeLike(n)}%`),
      `%<@${userId}>%`, `%<@!${userId}>%`,
    ];
    const rows = await this.sql<Array<{
      id: string; channel_id: string; author_id: string; author_name: string; content: string;
      created_at: Date | string; ref_author_name: string | null; ref_content: string | null;
    }>>`
      SELECT m.id, m.channel_id, m.author_id, m.author_name, m.content, m.created_at,
             ref.author_name AS ref_author_name, ref.content AS ref_content
      FROM messages m
      LEFT JOIN messages ref ON ref.id = m.reply_to_id AND ref.guild_id = m.guild_id
      WHERE m.guild_id = ${guildId} AND m.created_at > ${since.toISOString()}
        AND m.content <> ''
        AND (m.triage_result IS NULL OR m.triage_result <> 'extracted')
        AND (
          m.author_id = ${userId}
          OR m.content ILIKE ANY(${patterns})
          OR m.reply_to_id IN (SELECT id FROM messages WHERE guild_id = ${guildId} AND author_id = ${userId})
        )
      ORDER BY m.created_at DESC LIMIT ${limit}
    `;
    // DESC+LIMIT keeps the newest window; flip back to chronological so the
    // extraction pass (alias learning, reply context) reads them in order.
    return rows.reverse().map(r => ({
      id: r.id, channelId: r.channel_id, authorId: r.author_id, authorName: r.author_name,
      content: r.content, createdAt: ts(r.created_at),
      replyToContent: r.ref_author_name ? `${r.ref_author_name}: ${r.ref_content}` : undefined,
    }));
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

  /** Recent messages the pipeline never classified, plus orphaned extraction
   * marks at ANY age: 'durable'/'regex' only ever mean "requested but not yet
   * extracted", and a live job would have flipped the mark to 'queued' (the
   * sweep's repairQueuedMarks pass does that reconciliation first) — so one
   * of these with no evidence row is definitively stranded work, and the 2h
   * sweep window must not hide it. Note: `messages` has no bot flag, so other
   * bots' messages are included — bounded noise. */
  async listUninspectedMessages(guildId: string, since: Date, excludeAuthorId: string, limit = 500): Promise<Array<{ id: string; channelId: string; authorId: string; authorName: string; content: string; createdAt: Date | string; replyToId: string | null; triageResult: string | null }>> {
    const rows = await this.sql<Array<{ id: string; channel_id: string; author_id: string; author_name: string; content: string; created_at: Date | string; reply_to_id: string | null; triage_result: string | null }>>`
      SELECT m.id, m.channel_id, m.author_id, m.author_name, m.content, m.created_at, m.reply_to_id, m.triage_result
      FROM messages m
      WHERE m.guild_id = ${guildId}
        AND (
          m.triage_result IN ('durable', 'regex')
          OR (m.triage_result IS NULL AND m.created_at > ${since.toISOString()})
        )
        AND m.author_id <> ${excludeAuthorId}
        AND NOT m.author_is_bot
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
      let nearMiss: { id: number; score: number; content: string } | null = null;
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
        await this._logHistory(sql, saved.id, "dedup_near_miss", null, null, null, null, null, { similarity: nearMiss.score, existingMemoryId: nearMiss.id, incomingContent: memory.content, existingContent: nearMiss.content });
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

    // Recompute when EITHER status or confidence moved — support on an
    // already-active memory changes no status, but the attribute's derived
    // confidence must still track the underlying memory's.
    if (status !== previousStatus || confidence !== previousConfidence) await recomputeForMemories(sql, event.guildId, [saved.id]);
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
      const search = `%${escapeLike(options.search)}%`;
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
    // self-reports ("call me Riley") reach replies before nightly verification
    // promotes them; sarcasm/joke/uncertain candidates stay gated out. The reply
    // prompt annotates each memory's confidence so the model can weigh them.
    const rows = await this.sql<MemoryRow[]>`
      SELECT * FROM memories WHERE guild_id = ${guildId}
        AND (status = 'active' OR (status = 'candidate' AND primary_evidence_type IN ('explicit_fact', 'clear_preference', 'correction')))
        AND (subject_id = 'server' OR (subject_id = ${subjectId}
          AND subject_id IN (SELECT user_id FROM members WHERE guild_id = ${guildId} AND opted_in = 1 AND opted_out = 0)))
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
    return await this.sql.begin(async sql => {
      const result = await sql`UPDATE memories SET status = 'forgotten' WHERE guild_id = ${guildId} AND id = ${id} AND status != 'forgotten'`;
      if (result.count) await recomputeForMemories(sql, guildId, [id]);
      return result.count;
    });
  }

  /** Opt-out bulk forget: every live memory about a subject → forgotten. */
  async forgetAllFor(guildId: string, subjectId: string): Promise<number> {
    return await this.sql.begin(async sql => {
      const rows = await sql<Array<{ id: number }>>`
        UPDATE memories SET status = 'forgotten', updated_at = NOW()
        WHERE guild_id = ${guildId} AND subject_id = ${subjectId} AND status != 'forgotten'
        RETURNING id
      `;
      await recomputeForMemories(sql, guildId, rows.map(r => r.id));
      return rows.length;
    });
  }

  /** Hard-delete every relationship observation and edge involving a subject —
   * as either edge party or as the assertor. Unlike memories (soft-forgotten
   * for inspectability), these tables have no status column or inspection
   * surface, so opt-out deletes. Edges are removed eagerly rather than waiting
   * on recomputeEdges — a guild-wide rebuild for one opt-out would be wasteful
   * and would leave a stale edge visible until the next maintenance run.
   * Returns the observation count (edges aggregate many observations). */
  async forgetRelationshipsFor(guildId: string, subjectId: string): Promise<number> {
    return await this.sql.begin(async sql => {
      const gone = await sql<Array<{ subject_id: string; other_id: string }>>`
        DELETE FROM relationship_observations
        WHERE guild_id = ${guildId} AND (subject_id = ${subjectId} OR other_id = ${subjectId} OR author_id = ${subjectId})
        RETURNING subject_id, other_id
      `;
      await sql`
        DELETE FROM relationships
        WHERE guild_id = ${guildId} AND (subject_id = ${subjectId} OR other_id = ${subjectId})
      `;
      // An edge fed by a now-deleted observation keeps its stale aggregate
      // (count, valence, summary) until the next recompute — drop every edge
      // that consumed a deleted row instead. Surviving literal observations
      // rebuild it on the next maintenance pass.
      if (gone.length) {
        const pairs = [...new Set(gone.map(g => `${g.subject_id}|${g.other_id}`))];
        await sql`
          DELETE FROM relationships r
          WHERE r.guild_id = ${guildId}
            AND (r.subject_id || '|' || r.other_id) = ANY(${pairs})
        `;
      }
      return gone.length;
    });
  }

  async confirm(guildId: string, id: number): Promise<number> {
    return await this.sql.begin(async sql => {
      const result = await sql`
        UPDATE memories SET status = 'active', confidence = GREATEST(confidence, 0.9), last_confirmed_at = NOW()
        WHERE guild_id = ${guildId} AND id = ${id} AND status = 'candidate'
      `;
      if (result.count) await recomputeForMemories(sql, guildId, [id]);
      return result.count;
    });
  }

  async supersede(guildId: string, oldId: number, replacementId: number): Promise<void> {
    const old = await this.getMemory(guildId, oldId);
    const replacement = await this.getMemory(guildId, replacementId);
    if (!old || !replacement) return;
    await this.sql.begin(async sql => {
      await sql`UPDATE memories SET status = 'superseded', superseded_by = ${replacementId}, updated_at = NOW() WHERE guild_id = ${guildId} AND id = ${oldId}`;
      await sql`UPDATE memories SET supersedes_memory_id = ${oldId}, status = 'active', updated_at = NOW() WHERE guild_id = ${guildId} AND id = ${replacementId}`;
      // Provenance transfers, not strips: attributes citing the superseded
      // memory now cite the canonical replacement.
      await transferProvenance(sql, guildId, oldId, replacementId);
      await recomputeForMemories(sql, guildId, [replacementId]);
      await this._logHistory(sql, oldId, "superseded", old.confidence, old.confidence, old.status, "superseded", null, { replacementId });
      await this._logHistory(sql, replacementId, "correction_activated", replacement.confidence, replacement.confidence, replacement.status, "active", null, { supersedesMemoryId: oldId });
    });
  }

  // ── Semantic dedup ─────────────────────────────────────────────────────────
  // The trigram fast-path in saveMemory() catches lexically-similar rephrasings;
  // the maintenance pass below catches semantic duplicates with no trigram
  // overlap ("allergic to peanuts" / "can't eat nuts") by handing each member's
  // memory list to the LLM. The LLM proposes groups; applyDedupGroups() enforces
  // the guards and merges. Same-subject merges only — unresolved names could be
  // different people, and 'episode' rows accumulate by design.

  /** Per-member memory lists for the dedup LLM pass: live rows on resolved
   * subjects only, grouped by subject. Bounded per member and per run. */
  async listDedupCandidates(guildId: string, maxMembers = 50, maxPerMember = 30): Promise<Array<{
    subjectId: string; label: string; memories: Array<{ memoryId: number; kind: string; status: string; content: string }>;
  }>> {
    const rows = await this.sql<Array<{ id: number | string; subject_id: string; kind: string; status: string; content: string }>>`
      SELECT id, subject_id, kind, status, content FROM memories
      WHERE guild_id = ${guildId}
        AND status IN ('candidate', 'active')
        AND kind != 'episode'
        AND subject_id != 'unknown'
      ORDER BY subject_id, id
    `;
    const bySubject = new Map<string, Array<{ id: number | string; subject_id: string; kind: string; status: string; content: string }>>();
    for (const r of rows) {
      const list = bySubject.get(r.subject_id) ?? [];
      list.push(r);
      bySubject.set(r.subject_id, list);
    }
    const members = [...bySubject.entries()]
      .filter(([, list]) => list.length >= 2)          // nothing to dedup solo
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, maxMembers);
    return await Promise.all(members.map(async ([subjectId, list]) => ({
      subjectId,
      label: await this.displayNameFor(guildId, subjectId),
      memories: list.slice(0, maxPerMember).map(r => ({ memoryId: Number(r.id), kind: r.kind, status: r.status, content: r.content })),
    })));
  }

  /** Merge a duplicate memory into its canonical row: the dup's evidence moves
   * over, except rows colliding on message_id, which stay on the superseded
   * dup — memory_history.evidence_id references them (FK, no cascade) and the
   * dup's audit trail stays complete. Counters are recounted from evidence,
   * and the dup becomes 'superseded' with a link back. Canonical
   * status/confidence are untouched — a merge must not launder promotion.
   * Idempotent: a dup no longer candidate/active is a no-op. */
  async mergeDuplicate(guildId: string, canonicalId: number, dupId: number, reason = ""): Promise<boolean> {
    if (canonicalId === dupId) return false;
    return await this.sql.begin(async sql => {
      const rows = await sql<Array<{ id: number | string; status: string }>>`
        SELECT id, status FROM memories WHERE guild_id = ${guildId} AND id IN (${canonicalId}, ${dupId})
      `;
      const canon = rows.find(r => Number(r.id) === canonicalId);
      const dup = rows.find(r => Number(r.id) === dupId);
      if (!canon || !dup) return false;
      if (canon.status !== "candidate" && canon.status !== "active") return false;
      if (dup.status !== "candidate" && dup.status !== "active") return false;

      await sql`
        UPDATE memory_evidence ev SET memory_id = ${canonicalId}
        WHERE ev.memory_id = ${dupId}
          AND NOT EXISTS (SELECT 1 FROM memory_evidence e WHERE e.memory_id = ${canonicalId} AND e.message_id = ev.message_id)
      `;
      await sql`
        UPDATE memories SET
          confirmation_count = (SELECT COUNT(*)::int FROM memory_evidence WHERE memory_id = ${canonicalId} AND effect = 'support'),
          mentions           = (SELECT COUNT(*)::int FROM memory_evidence WHERE memory_id = ${canonicalId} AND effect = 'support'),
          contradiction_count = (SELECT COUNT(*)::int FROM memory_evidence WHERE memory_id = ${canonicalId} AND effect = 'contradict'),
          updated_at = NOW()
        WHERE id = ${canonicalId}
      `;
      await sql`UPDATE memories SET status = 'superseded', superseded_by = ${canonicalId}, updated_at = NOW() WHERE id = ${dupId}`;
      // A merge is a supersede for provenance purposes: attributes citing the
      // dup transfer their citation to the canonical row.
      await transferProvenance(sql, guildId, dupId, canonicalId);
      await this._logHistory(sql, canonicalId, "dedup_merged", null, null, null, null, null, { mergedMemoryId: dupId, reason });
      await this._logHistory(sql, dupId, "dedup_merged", null, null, dup.status, "superseded", null, { mergedInto: canonicalId, reason });
      return true;
    });
  }

  /** Apply LLM-proposed duplicate groups with guards: every id must share the
   * same (subject_id, kind) and be candidate/active; singletons and
   * cross-member/kind groups are dropped. Canonical = active over candidate,
   * then higher confidence, then lowest id. Returns merge/skip counts. */
  async applyDedupGroups(guildId: string, groups: Array<{ ids: number[]; reason: string }>, maxMerges = 30): Promise<{ merged: number; skipped: number }> {
    let merged = 0, skipped = 0;
    for (const g of groups) {
      if (merged >= maxMerges) break;
      const ids = [...new Set(g.ids)];
      if (ids.length < 2) { skipped++; continue; }
      const rows = await this.sql<Array<{ id: number | string; subject_id: string; kind: string; status: string; confidence: number }>>`
        SELECT id, subject_id, kind, status, confidence FROM memories
        WHERE guild_id = ${guildId} AND id IN ${this.sql(ids)}
      `;
      const live = rows.filter(r => (r.status === "candidate" || r.status === "active") && r.kind !== "episode" && r.subject_id !== "unknown");
      if (live.length !== ids.length || new Set(live.map(r => r.subject_id)).size !== 1 || new Set(live.map(r => r.kind)).size !== 1) {
        skipped++;
        continue;
      }
      live.sort((a, b) =>
        (b.status === "active" ? 1 : 0) - (a.status === "active" ? 1 : 0)
        || b.confidence - a.confidence
        || Number(a.id) - Number(b.id)
      );
      const canonicalId = Number(live[0].id);
      for (const dup of live.slice(1)) {
        if (merged >= maxMerges) break;
        if (await this.mergeDuplicate(guildId, canonicalId, Number(dup.id), g.reason)) merged++;
        else skipped++;
      }
    }
    return { merged, skipped };
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
      // Resolution: support won, but the promotion gate still applies — a
      // memory whose primary evidence could never promote (rumour, sarcasm,
      // uncertain inference) resolves to candidate, not active. Otherwise a
      // weak-evidence candidate could launder itself into an active fact via
      // contradict → contested → resolve. Candidates reap via stale-quarantine.
      const promotable = PROMOTABLE_EVIDENCE_TYPES.includes(memory.primaryEvidenceType as EvidenceType);
      const target: MemoryStatus = promotable ? "active" : "candidate";
      await this.sql`UPDATE memories SET status = ${target}, frozen_confidence = NULL, net_score = NULL, updated_at = NOW() WHERE guild_id = ${guildId} AND id = ${memoryId}`;
      await recomputeForMemories(this.sql, guildId, [memoryId]);
      await this.logHistory(memoryId, "conflict_resolved", memory.confidence, memory.confidence, "contested", target, null, { supportScore, contradictionScore, netScore, promotable });
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
    await recomputeForMemories(this.sql, guildId, [memoryId]);
    await this.logHistory(memoryId, "subject_confirmed", memory.confidence, memory.confidence, "contested", "active", null, {});
  }

  // ── Context helpers ────────────────────────────────────────────────────────

  /** Recent channel transcript with reply edges resolved — "call her a bitch"
   * only makes sense if the model can see it was a reply to a specific line.
   * Bot-authored rows carry authorId so the reply path can render them as
   * "you:" and member→bot reply edges resolve instead of dangling. */
  async recentContext(guildId: string, channelId: string, limit = 25): Promise<Array<{ authorName: string; authorId: string; content: string; createdAt: string; replyToAuthorId?: string; replyToAuthor?: string; replyToSnippet?: string }>> {
    const rows = await this.sql<Array<{ author_name: string; author_id: string; content: string; created_at: string; reply_to_author_id: string | null; reply_to_author: string | null; reply_to_snippet: string | null }>>`
      SELECT m.author_name, m.author_id, m.content, m.created_at,
             ref.author_id AS reply_to_author_id, ref.author_name AS reply_to_author,
             LEFT(ref.content, 80) AS reply_to_snippet
      FROM messages m
      LEFT JOIN messages ref ON ref.id = m.reply_to_id
      WHERE m.guild_id = ${guildId} AND m.channel_id = ${channelId}
      ORDER BY m.created_at DESC LIMIT ${limit}
    `;
    return rows.reverse().map(r => ({
      authorName: r.author_name, authorId: r.author_id, content: r.content, createdAt: ts(r.created_at),
      ...(r.reply_to_author ? { replyToAuthorId: r.reply_to_author_id ?? undefined, replyToAuthor: r.reply_to_author, replyToSnippet: r.reply_to_snippet ?? "" } : {}),
    }));
  }

  async messagesByIds(guildId: string, messageIds: string[]): Promise<Array<{ authorName: string; content: string; createdAt: string }>> {
    if (messageIds.length === 0) return [];
    const rows = await this.sql<MessageRow[]>`
      SELECT author_name, content, created_at FROM messages WHERE guild_id = ${guildId} AND id = ANY(${messageIds}) ORDER BY created_at ASC
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
  // Child tables have no cascade, so they're deleted first. memory_evidence
  // ROWS are deliberately kept — the audit trail (type, effect, reason) is
  // retained for inspectability even on forgotten memories — but their
  // verbatim text columns expire with the raw-message retention window,
  // otherwise a deleted message's words would persist inside evidence.
  async pruneDerivedData(guildId: string, olderThanDays = 90, verbatimDays?: number): Promise<{ history: number; names: number; aliases: number; events: number; usage: number; evidence: number; observations: number }> {
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
    // guild_usage is operational state, not derived data — 30 days of history
    // is enough for /status-style review; without this it grows ~365
    // rows/guild/year forever.
    const usage = await this.sql`DELETE FROM guild_usage WHERE guild_id = ${guildId} AND day < (now() AT TIME ZONE 'UTC')::date - 30`;
    // Two classes of dead observation: a NULL-verdict row whose source message
    // is gone can never be verified (listUnverifiedObservations JOINs
    // messages), and a non-literal verdict never feeds an edge. Both are
    // permanent dead weight — prune them. Literal rows survive a dead source:
    // the rendered verdict is the derived truth, same stance as evidence
    // metadata outliving its scrubbed quote.
    const deadSource = await this.sql`
      DELETE FROM relationship_observations
      WHERE guild_id = ${guildId} AND verdict IS NULL
        AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.id = message_id AND m.guild_id = ${guildId})
    `;
    const deadVerdict = await this.sql`
      DELETE FROM relationship_observations
      WHERE guild_id = ${guildId} AND verdict IN ('joke', 'unclear', 'misattributed') AND created_at < ${cutoff}
    `;
    let evidence = { count: 0 };
    if (verbatimDays !== undefined) {
      const vcutoff = new Date(Date.now() - verbatimDays * 86_400_000).toISOString();
      evidence = await this.sql`
        UPDATE memory_evidence SET quote = '', message_content_snapshot = ''
        WHERE created_at < ${vcutoff} AND (quote <> '' OR message_content_snapshot <> '')
        AND memory_id IN (SELECT id FROM memories WHERE guild_id = ${guildId})
      `;
    }
    return { history: history.count, names: names.count, aliases: aliases.count, events: events.count, usage: usage.count, evidence: evidence.count, observations: deadSource.count + deadVerdict.count };
  }

  /** Opt-out scrub: blank the verbatim text columns on every evidence row
   * citing this subject's memories — immediately, not at retention expiry.
   * Metadata (type, effect, reason, observed_at) stays for the audit trail. */
  async scrubEvidenceFor(guildId: string, subjectId: string): Promise<number> {
    const result = await this.sql`
      UPDATE memory_evidence SET quote = '', message_content_snapshot = ''
      WHERE (quote <> '' OR message_content_snapshot <> '')
      AND memory_id IN (SELECT id FROM memories WHERE guild_id = ${guildId} AND subject_id = ${subjectId})
    `;
    return result.count;
  }

  /** Hard-delete a subject's attribute rows — derived data about an opted-out
   * member shouldn't linger even in a non-active status. */
  async deleteAttributesFor(guildId: string, subjectId: string): Promise<number> {
    const result = await this.sql`DELETE FROM profile_attributes WHERE guild_id = ${guildId} AND subject_id = ${subjectId}`;
    return result.count;
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

  /** Guild-wide active-memory text search — the search_memories lookup tool.
   * Importance-weighted, bounded; only 'active' rows ever surface.
   * `kinds` restricts at query level — proactive grounding passes
   * ['server_lore'] so person facts/preferences can never slip through a
   * post-fetch filter bug into an unprompted public answer. */
  async searchMemories(guildId: string, query: string, limit = 5, kinds?: string[]): Promise<Array<{ subjectId: string; content: string; confidence: number }>> {
    // Person-scoped rows surface only for opted-in subjects — server lore and
    // episodes attached to 'server' are consent-exempt shared context.
    const rows = await this.sql<Array<{ subject_id: string; content: string; confidence: number }>>`
      SELECT subject_id, content, confidence FROM memories
      WHERE guild_id = ${guildId} AND status = 'active' AND content ILIKE ${`%${escapeLike(query)}%`}
      AND (subject_id = 'server' OR subject_id IN (SELECT user_id FROM members WHERE guild_id = ${guildId} AND opted_in = 1 AND opted_out = 0))
      ${kinds?.length ? this.sql`AND kind = ANY(${kinds})` : this.sql``}
      ORDER BY importance * confidence DESC LIMIT ${limit}
    `;
    return rows.map(r => ({ subjectId: r.subject_id, content: r.content, confidence: Number(r.confidence) }));
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
    const promotedRows = await this.sql<Array<{ id: number }>>`
      UPDATE memories SET status = 'active' WHERE guild_id = ${guildId} AND status = 'candidate'
      AND mentions >= 2 AND confidence >= ${candidateThreshold}
      AND primary_evidence_type IN ('explicit_fact', 'clear_preference', 'correction')
      RETURNING id
    `;
    const quarantinedCandidatesRows = await this.sql<Array<{ id: number }>>`
      UPDATE memories SET status = 'quarantined' WHERE guild_id = ${guildId} AND status = 'candidate' AND last_confirmed_at < ${candidateCutoff}
      RETURNING id
    `;
    const quarantinedActiveRows = await this.sql<Array<{ id: number }>>`
      UPDATE memories SET status = 'quarantined' WHERE guild_id = ${guildId} AND status = 'active' AND confidence < 0.75 AND last_confirmed_at < ${staleCutoff}
      RETURNING id
    `;
    // Status changes cascade to citing attributes — quarantined provenance no
    // longer supports a live facet; promoted provenance can revive one.
    const changedIds = [...promotedRows, ...quarantinedCandidatesRows, ...quarantinedActiveRows].map(r => r.id);
    if (changedIds.length) await recomputeForMemories(this.sql, guildId, changedIds);

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
      promoted: promotedRows.length,
      quarantinedCandidates: quarantinedCandidatesRows.length,
      quarantinedActive: quarantinedActiveRows.length,
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

  async exportSubject(guildId: string, subjectId: string): Promise<{ memories: Array<Memory & { evidence: MemoryEvidence[] }>; attributes: ProfileAttribute[] }> {
    const rows = await this.sql<MemoryRow[]>`SELECT * FROM memories WHERE guild_id = ${guildId} AND subject_id = ${subjectId} ORDER BY id`;
    const memories = await Promise.all(rows.map(async r => {
      const mem = rowToMemory(r);
      return { ...mem, evidence: await this.evidence(guildId, mem.id) };
    }));
    const attributes = await listAttributes(this.sql, guildId, subjectId);
    return { memories, attributes };
  }

  /** Structured profile attributes for a subject — the provenance-backed facet set. */
  async attributesFor(guildId: string, subjectId: string): Promise<ProfileAttribute[]> {
    return listAttributes(this.sql, guildId, subjectId);
  }

  /** Batch attribute read keyed by subject — the reply path fetches facets
   * for every in-prompt person in one round trip. */
  async attributesForSubjects(guildId: string, subjectIds: string[], opts: { status?: AttributeStatus } = {}): Promise<Map<string, ProfileAttribute[]>> {
    return listAttributesForSubjects(this.sql, guildId, subjectIds, opts);
  }

  /** Guild-wide contested attributes — the admin triage surface. */
  async contestedAttributes(guildId: string, limit = 10): Promise<ProfileAttribute[]> {
    return listContestedAttributes(this.sql, guildId, limit);
  }
}
