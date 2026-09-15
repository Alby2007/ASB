import type { EvidenceType, MemoryCandidate, MemoryStatus, MessageEvent } from "./types.js";
import { sql as defaultSql, type Sql } from "./db.js";
import { runMigrations } from "./migrations.js";
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

// ── Helpers ───────────────────────────────────────────────────────────────────

function ts(d: Date | string): string {
  return d instanceof Date ? d.toISOString() : d;
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

  async settings(guildId: string, defaultRetentionDays = 30): Promise<{ guildId: string; memoryEnabled: number; replyEnabled: number; rawRetentionDays: number }> {
    await this.ensureSettings(guildId, defaultRetentionDays);
    const rows = await this.sql<SettingsRow[]>`SELECT guild_id, memory_enabled, reply_enabled, raw_retention_days FROM server_settings WHERE guild_id = ${guildId}`;
    const r = rows[0];
    return { guildId: r.guild_id, memoryEnabled: Number(r.memory_enabled), replyEnabled: Number(r.reply_enabled), rawRetentionDays: Number(r.raw_retention_days) };
  }

  async setPaused(guildId: string, paused: boolean, defaultRetentionDays = 30): Promise<void> {
    await this.ensureSettings(guildId, defaultRetentionDays);
    const v = paused ? 0 : 1;
    await this.sql`UPDATE server_settings SET memory_enabled = ${v}, reply_enabled = ${v} WHERE guild_id = ${guildId}`;
  }

  // ── Messages ───────────────────────────────────────────────────────────────

  async recordMessage(event: MessageEvent): Promise<void> {
    await this.sql`
      INSERT INTO messages (id, guild_id, channel_id, author_id, author_name, content, created_at)
      VALUES (${event.messageId}, ${event.guildId}, ${event.channelId}, ${event.authorId}, ${event.authorName}, ${event.content}, ${event.createdAt.toISOString()})
      ON CONFLICT (id) DO NOTHING
    `;
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
      if (!existing[0]) {
        const initialConfidence = calculateInitialConfidence(evidenceType);
        const importance = memory.importance ?? calculateDefaultImportance(memory.kind);
        const explicitness = memory.explicitness ?? calculateDefaultExplicitness(evidenceType);
        const subjectName = memory.subjectId === event.authorId ? event.authorName : "";
        await sql`
          INSERT INTO memories (guild_id, subject_id, subject_name, kind, content, confidence, importance, mentions, confirmation_count, created_at, updated_at, last_confirmed_at, status, explicitness, reason, primary_evidence_type)
          VALUES (${event.guildId}, ${memory.subjectId}, ${subjectName}, ${memory.kind}, ${memory.content}, ${initialConfidence}, ${importance}, 0, 0, NOW(), NOW(), NOW(), 'candidate', ${explicitness}, ${memory.reason}, ${evidenceType})
          ON CONFLICT (guild_id, subject_id, kind, content) DO NOTHING
        `;
      }

      const savedRows = await sql<MemoryRow[]>`
        SELECT * FROM memories WHERE guild_id = ${event.guildId} AND subject_id = ${memory.subjectId} AND kind = ${memory.kind} AND content = ${memory.content}
      `;
      const saved = rowToMemory(savedRows[0]);

      const evidenceExplicitness = memory.explicitness ?? calculateDefaultExplicitness(evidenceType);
      // Idempotent evidence insert — same (memory_id, message_id) is ignored.
      const insertedEvidence = await sql`
        INSERT INTO memory_evidence (memory_id, message_id, author_id, quote, reason, explicitness, observed_at, evidence_type, effect, message_content_snapshot, message_timestamp, created_at)
        VALUES (${saved.id}, ${event.messageId}, ${event.authorId}, ${event.content.slice(0, 1000)}, ${memory.reason}, ${evidenceExplicitness}, ${event.createdAt.toISOString()}, ${evidenceType}, ${effect}, ${event.content.slice(0, 1000)}, ${event.createdAt.toISOString()}, NOW())
        ON CONFLICT (memory_id, message_id) DO NOTHING
        RETURNING id
      `;

      // No new evidence row — idempotent, return as-is.
      if (insertedEvidence.length === 0) return saved;

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
      const promotableTypes: EvidenceType[] = ["explicit_fact", "clear_preference", "correction"];
      if (status === "candidate" && effect === "support" && confidence >= candidateThreshold && promotableTypes.includes(evidenceType)) {
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
    }) as Memory;
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
    const rows = await this.sql<MemoryRow[]>`
      SELECT * FROM memories WHERE guild_id = ${guildId} AND status = 'active' AND (subject_id = ${subjectId} OR subject_id = 'server')
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
