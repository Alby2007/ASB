import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { EvidenceType, MemoryCandidate, MemoryStatus, MessageEvent } from "./types.js";
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

export class MemoryStore {
  /** Exposed so EventStore can share the same connection. */
  readonly db: Database.Database;
  constructor(filename = "data/asm.sqlite") {
    mkdirSync(dirname(filename), { recursive: true });
    this.db = new Database(filename); this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, author_id TEXT NOT NULL, author_name TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, subject_id TEXT NOT NULL, kind TEXT NOT NULL, content TEXT NOT NULL,
        confidence REAL NOT NULL, importance REAL NOT NULL, mentions INTEGER NOT NULL DEFAULT 1, confirmation_count INTEGER NOT NULL DEFAULT 0, contradiction_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_confirmed_at TEXT NOT NULL, last_contradicted_at TEXT,
        status TEXT NOT NULL DEFAULT 'candidate', superseded_by INTEGER, supersedes_memory_id INTEGER, explicitness REAL NOT NULL DEFAULT 0.5, reason TEXT NOT NULL DEFAULT '', UNIQUE(guild_id, subject_id, kind, content)
      );
      CREATE TABLE IF NOT EXISTS memory_evidence (
        id INTEGER PRIMARY KEY AUTOINCREMENT, memory_id INTEGER NOT NULL REFERENCES memories(id), message_id TEXT NOT NULL, author_id TEXT NOT NULL,
        quote TEXT NOT NULL, reason TEXT NOT NULL, explicitness REAL NOT NULL, observed_at TEXT NOT NULL,
        evidence_type TEXT NOT NULL DEFAULT 'uncertain_inference', effect TEXT NOT NULL DEFAULT 'context',
        message_content_snapshot TEXT NOT NULL, message_timestamp TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(memory_id, message_id)
      );
      CREATE TABLE IF NOT EXISTS server_settings (
        guild_id TEXT PRIMARY KEY, memory_enabled INTEGER NOT NULL DEFAULT 1,
        reply_enabled INTEGER NOT NULL DEFAULT 1, raw_retention_days INTEGER NOT NULL DEFAULT 30
      );
      CREATE INDEX IF NOT EXISTS memories_lookup ON memories(guild_id, subject_id, status, importance DESC);
      CREATE INDEX IF NOT EXISTS messages_context ON messages(guild_id, channel_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS evidence_memory ON memory_evidence(memory_id, observed_at DESC);
    `);
    runMigrations(this.db);
  }
  private memorySelect() { return "id, guild_id as guildId, subject_id as subjectId, subject_name as subjectName, kind, content, confidence, importance, mentions, confirmation_count as confirmationCount, contradiction_count as contradictionCount, created_at as createdAt, updated_at as updatedAt, last_confirmed_at as lastConfirmedAt, last_contradicted_at as lastContradictedAt, status, superseded_by as supersededBy, supersedes_memory_id as supersedesMemoryId, explicitness, reason, net_score as netScore, frozen_confidence as frozenConfidence, pattern_id as patternId, primary_evidence_type as primaryEvidenceType, event_id as eventId"; }
  private ensureSettings(guildId: string, retentionDays = 30) { this.db.prepare("INSERT OR IGNORE INTO server_settings (guild_id, raw_retention_days) VALUES (?, ?)").run(guildId, retentionDays); }
  settings(guildId: string, defaultRetentionDays = 30) {
    this.ensureSettings(guildId, defaultRetentionDays);
    return this.db.prepare("SELECT guild_id as guildId, memory_enabled as memoryEnabled, reply_enabled as replyEnabled, raw_retention_days as rawRetentionDays FROM server_settings WHERE guild_id=?").get(guildId) as { guildId: string; memoryEnabled: number; replyEnabled: number; rawRetentionDays: number };
  }
  setPaused(guildId: string, paused: boolean, defaultRetentionDays = 30) { this.ensureSettings(guildId, defaultRetentionDays); this.db.prepare("UPDATE server_settings SET memory_enabled=?, reply_enabled=? WHERE guild_id=?").run(paused ? 0 : 1, paused ? 0 : 1, guildId); }
  recordMessage(event: MessageEvent) { this.db.prepare("INSERT OR IGNORE INTO messages VALUES (?, ?, ?, ?, ?, ?, ?)").run(event.messageId, event.guildId, event.channelId, event.authorId, event.authorName, event.content, event.createdAt.toISOString()); }
  getMessage(messageId: string) { return this.db.prepare("SELECT id, guild_id as guildId, channel_id as channelId, author_id as authorId, author_name as authorName, content, created_at as createdAt FROM messages WHERE id=?").get(messageId) as { id: string; guildId: string; channelId: string; authorId: string; authorName: string; content: string; createdAt: string } | undefined; }
  // Phase 1 authoritative update: the LLM supplies language interpretation only. Confidence,
  // lifecycle, counters, and history are all determined here after an idempotent evidence insert.
  saveMemory(event: MessageEvent, memory: MemoryCandidate, candidateThreshold = .7): Memory {
    const now = new Date().toISOString();
    const evidenceType = memory.evidenceType ?? "uncertain_inference", effect = memory.effect ?? "context";
    
    const transaction = this.db.transaction(() => {
      const current = this.db.prepare("SELECT id FROM memories WHERE guild_id=? AND subject_id=? AND kind=? AND content=?").get(event.guildId, memory.subjectId, memory.kind, memory.content) as { id: number } | undefined;
      if (!current) {
        const initialConfidence = calculateInitialConfidence(evidenceType);
        const importance = memory.importance ?? calculateDefaultImportance(memory.kind);
        const explicitness = memory.explicitness ?? calculateDefaultExplicitness(evidenceType);
        this.db.prepare("INSERT INTO memories (guild_id, subject_id, subject_name, kind, content, confidence, importance, mentions, confirmation_count, created_at, updated_at, last_confirmed_at, status, explicitness, reason, primary_evidence_type) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, 'candidate', ?, ?, ?)").run(event.guildId, memory.subjectId, memory.subjectId === event.authorId ? event.authorName : "", memory.kind, memory.content, initialConfidence, importance, now, now, now, explicitness, memory.reason, evidenceType);
      }
      const saved = this.db.prepare(`SELECT ${this.memorySelect()} FROM memories WHERE guild_id=? AND subject_id=? AND kind=? AND content=?`).get(event.guildId, memory.subjectId, memory.kind, memory.content) as Memory;
      
      const evidenceExplicitness = memory.explicitness ?? calculateDefaultExplicitness(evidenceType);
      const inserted = this.db.prepare("INSERT OR IGNORE INTO memory_evidence (memory_id, message_id, author_id, quote, reason, explicitness, observed_at, evidence_type, effect, message_content_snapshot, message_timestamp, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(saved.id, event.messageId, event.authorId, event.content.slice(0, 1000), memory.reason, evidenceExplicitness, event.createdAt.toISOString(), evidenceType, effect, event.content.slice(0, 1000), event.createdAt.toISOString(), now);
      
      if (inserted.changes === 0) return saved;
      
      const evidenceId = Number(inserted.lastInsertRowid), previousConfidence = saved.confidence, previousStatus = saved.status;
      // Confidence is frozen the moment a memory enters contested state and remains frozen while contested.
      // net_score is the sole arbiter of conflict resolution; confidence must not be changed by either
      // supporting or contradicting evidence during this period so the two signals stay independent.
      const isContested = saved.status === "contested";
      let confidence = saved.confidence, status = saved.status, confirmations = saved.confirmationCount, contradictions = saved.contradictionCount, action = "context";
      if (effect === "support") { if (!isContested) confidence = updateConfidence(confidence, "support"); confirmations++; action = "support"; }
      if (effect === "contradict") {
        contradictions++; status = "contested"; action = "contradict";
        // Write frozen_confidence the first time a memory enters contested state.
        if (saved.status !== "contested") {
          this.db.prepare("UPDATE memories SET frozen_confidence=? WHERE id=?").run(saved.confidence, saved.id);
        }
      }
      if (effect === "correct") { action = "correction_evidence"; }
      // Only high-quality evidence types may promote a candidate to active. Sarcasm, rumour, and
      // uncertain inferences are explicitly excluded regardless of how high confidence grows.
      const promotableTypes: EvidenceType[] = ["explicit_fact", "clear_preference", "correction"];
      if (status === "candidate" && effect === "support" && confidence >= candidateThreshold && promotableTypes.includes(evidenceType)) { status = "active"; action = "promote"; }
      this.db.prepare("UPDATE memories SET confidence=?, confirmation_count=?, mentions=?, contradiction_count=?, status=?, updated_at=?, last_confirmed_at=CASE WHEN ?='support' THEN ? ELSE last_confirmed_at END, last_contradicted_at=CASE WHEN ?='contradict' THEN ? ELSE last_contradicted_at END WHERE id=?").run(confidence, confirmations, confirmations, contradictions, status, now, effect, now, effect, now, saved.id);
      this.logHistory(saved.id, action, previousConfidence, confidence, previousStatus, status, evidenceId, { evidenceType, effect, sourceMessageId: event.messageId });
      return this.getMemory(event.guildId, saved.id)!;
    });
    
    return transaction();
  }
  getMemory(guildId: string, id: number) { return this.db.prepare(`SELECT ${this.memorySelect()} FROM memories WHERE guild_id=? AND id=?`).get(guildId, id) as Memory | undefined; }
  listMemories(guildId: string, subjectId: string, options: { search?: string; page?: number; status?: MemoryStatus } = {}) {
    const page = Math.max(1, options.page ?? 1), where = ["guild_id = ?", "subject_id = ?"], values: Array<string | number> = [guildId, subjectId];
    if (options.status) { where.push("status = ?"); values.push(options.status); } else where.push("status = 'active'");
    if (options.search) { where.push("content LIKE ?"); values.push(`%${options.search}%`); }
    const count = this.db.prepare(`SELECT COUNT(*) as count FROM memories WHERE ${where.join(" AND ")}`).get(...values) as { count: number };
    const memories = this.db.prepare(`SELECT ${this.memorySelect()} FROM memories WHERE ${where.join(" AND ")} ORDER BY importance * confidence DESC, last_confirmed_at DESC LIMIT 8 OFFSET ?`).all(...values, (page - 1) * 8) as Memory[];
    return { memories, total: count.count, page };
  }
  relevantMemories(guildId: string, subjectId: string, limit = 8) { return this.db.prepare(`SELECT ${this.memorySelect()} FROM memories WHERE guild_id=? AND status='active' AND (subject_id=? OR subject_id='server') ORDER BY importance * confidence DESC, last_confirmed_at DESC LIMIT ?`).all(guildId, subjectId, limit) as Memory[]; }
  allActiveMemories(guildId: string, subjectId: string) { return this.db.prepare(`SELECT ${this.memorySelect()} FROM memories WHERE guild_id=? AND subject_id=? AND status='active' ORDER BY importance * confidence DESC, last_confirmed_at DESC`).all(guildId, subjectId) as Memory[]; }
  evidence(guildId: string, memoryId: number) { return this.db.prepare("SELECT e.id, e.memory_id as memoryId, e.message_id as messageId, e.author_id as authorId, e.quote, e.reason, e.explicitness, e.observed_at as observedAt, e.evidence_type as evidenceType, e.effect, e.message_content_snapshot as messageContentSnapshot, e.message_timestamp as messageTimestamp, e.created_at as createdAt FROM memory_evidence e JOIN memories m ON m.id=e.memory_id WHERE m.guild_id=? AND m.id=? ORDER BY e.observed_at DESC").all(guildId, memoryId) as MemoryEvidence[]; }
  history(guildId: string, memoryId: number) { return this.db.prepare("SELECT h.id, h.memory_id as memoryId, h.action, h.previous_confidence as previousConfidence, h.new_confidence as newConfidence, h.previous_status as previousStatus, h.new_status as newStatus, h.evidence_id as evidenceId, h.details_json as detailsJson, h.created_at as createdAt FROM memory_history h JOIN memories m ON m.id=h.memory_id WHERE m.guild_id=? AND m.id=? ORDER BY h.created_at DESC").all(guildId, memoryId) as MemoryHistory[]; }
  logHistory(memoryId: number, action: string, previousConfidence: number | null, newConfidence: number | null, previousStatus: MemoryStatus | null, newStatus: MemoryStatus | null, evidenceId: number | null, details: Record<string, unknown> = {}) { this.db.prepare("INSERT INTO memory_history (memory_id, action, previous_confidence, new_confidence, previous_status, new_status, evidence_id, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(memoryId, action, previousConfidence, newConfidence, previousStatus, newStatus, evidenceId, JSON.stringify(details), new Date().toISOString()); }
  forget(guildId: string, id: number) { return this.db.prepare("UPDATE memories SET status='forgotten' WHERE guild_id=? AND id=? AND status != 'forgotten'").run(guildId, id).changes; }
  confirm(guildId: string, id: number) { return this.db.prepare("UPDATE memories SET status='active', confidence=MAX(confidence, .9), last_confirmed_at=? WHERE guild_id=? AND id=? AND status='candidate'").run(new Date().toISOString(), guildId, id).changes; }
  supersede(guildId: string, oldId: number, replacementId: number) {
    const old = this.getMemory(guildId, oldId), replacement = this.getMemory(guildId, replacementId);
    if (!old || !replacement) return;
    const now = new Date().toISOString();
    this.db.prepare("UPDATE memories SET status='superseded', superseded_by=?, updated_at=? WHERE guild_id=? AND id=?").run(replacementId, now, guildId, oldId);
    this.db.prepare("UPDATE memories SET supersedes_memory_id=?, status='active', updated_at=? WHERE guild_id=? AND id=?").run(oldId, now, guildId, replacementId);
    this.logHistory(oldId, "superseded", old.confidence, old.confidence, old.status, "superseded", null, { replacementId });
    this.logHistory(replacementId, "correction_activated", replacement.confidence, replacement.confidence, replacement.status, "active", null, { supersedesMemoryId: oldId });
  }
  resolveContested(guildId: string, memoryId: number, now = new Date()) {
    const memory = this.getMemory(guildId, memoryId);
    if (!memory || memory.status !== "contested") return { resolved: false, netScore: 0 };
    const evidence = this.evidence(guildId, memoryId).filter(item => item.effect === "support" || item.effect === "contradict");
    const weight = (timestamp: string) => Math.pow(.5, Math.max(0, now.getTime() - new Date(timestamp).getTime()) / 86_400_000 / 90);
    const supportScore = evidence.filter(item => item.effect === "support").reduce((sum, item) => sum + weight(item.messageTimestamp), 0);
    const contradictionScore = evidence.filter(item => item.effect === "contradict").reduce((sum, item) => sum + weight(item.messageTimestamp), 0);
    const netScore = supportScore - contradictionScore;
    const newest = [...evidence].sort((a, b) => b.messageTimestamp.localeCompare(a.messageTimestamp))[0];
    // Always persist the current net_score so the DB reflects the latest resolution signal.
    this.db.prepare("UPDATE memories SET net_score=? WHERE guild_id=? AND id=?").run(netScore, guildId, memoryId);
    if (memory.confidence >= .70 && netScore >= .50 && newest?.effect !== "contradict") {
      // Resolution: restore to active and clear the conflict tracking columns.
      this.db.prepare("UPDATE memories SET status='active', frozen_confidence=NULL, net_score=NULL, updated_at=? WHERE guild_id=? AND id=?").run(now.toISOString(), guildId, memoryId);
      this.logHistory(memoryId, "conflict_resolved", memory.confidence, memory.confidence, "contested", "active", null, { supportScore, contradictionScore, netScore });
      return { resolved: true, netScore };
    }
    this.logHistory(memoryId, "conflict_unresolved", memory.confidence, memory.confidence, "contested", "contested", null, { supportScore, contradictionScore, netScore });
    return { resolved: false, netScore };
  }
  recentContext(guildId: string, channelId: string, limit = 12) { return this.db.prepare("SELECT author_name as authorName, content, created_at as createdAt FROM messages WHERE guild_id=? AND channel_id=? ORDER BY created_at DESC LIMIT ?").all(guildId, channelId, limit).reverse() as Array<{ authorName: string; content: string; createdAt: string }>; }
  deleteRawMessagesOlderThan(guildId: string, days: number) { return this.db.prepare("DELETE FROM messages WHERE guild_id=? AND created_at < ?").run(guildId, new Date(Date.now() - days * 86_400_000).toISOString()).changes; }
  // Consolidate active episodes for a subject into behavioral_patterns rows.
  // Only active-status episodes count toward pattern formation — candidates and quarantined
  // episodes must not influence whether a pattern is recognised.
  //
  // If the subject already has an active pattern, unlinked episodes are appended to it (the
  // episode_count and confidence are refreshed) rather than creating a second pattern row.
  // This prevents unbounded pattern accumulation across maintenance runs.
  consolidateEpisodes(guildId: string, subjectId: string, minEpisodes = 3): number {
    const now = new Date().toISOString();
    // Find unlinked active episodes for this subject.
    const unlinked = this.db.prepare(
      "SELECT id, content, confidence FROM memories WHERE guild_id=? AND subject_id=? AND kind='episode' AND status='active' AND pattern_id IS NULL ORDER BY confidence DESC"
    ).all(guildId, subjectId) as Array<{ id: number; content: string; confidence: number }>;
    if (unlinked.length < minEpisodes) return 0;
    const ids = unlinked.map(e => e.id);
    // Check for an existing active pattern to append to.
    const existing = this.db.prepare(
      "SELECT id, episode_count FROM behavioral_patterns WHERE guild_id=? AND subject_id=? AND status='active' ORDER BY id LIMIT 1"
    ).get(guildId, subjectId) as { id: number; episode_count: number } | undefined;
    const avgConfidence = unlinked.reduce((sum, e) => sum + e.confidence, 0) / unlinked.length;
    let patternId: number;
    if (existing) {
      // Append: refresh episode count and confidence on the existing pattern row.
      const newCount = existing.episode_count + unlinked.length;
      this.db.prepare("UPDATE behavioral_patterns SET episode_count=?, confidence=?, updated_at=? WHERE id=?").run(newCount, avgConfidence, now, existing.id);
      patternId = existing.id;
    } else {
      // Create: derive a placeholder description from the highest-confidence episode.
      // TODO(Phase 1D): synthesise a human-readable description via LLM rather than copying the
      // episode content verbatim.
      const description = unlinked[0].content;
      const result = this.db.prepare(
        "INSERT INTO behavioral_patterns (guild_id, subject_id, description, episode_count, confidence, created_at, updated_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'active')"
      ).run(guildId, subjectId, description, unlinked.length, avgConfidence, now, now);
      patternId = Number(result.lastInsertRowid);
    }
    // Link the episodes to the pattern (new or existing).
    this.db.prepare(`UPDATE memories SET pattern_id=? WHERE id IN (${ids.map(() => "?").join(",")})`).run(patternId, ...ids);
    return 1;
  }
  patterns(guildId: string, subjectId: string) {
    return this.db.prepare("SELECT id, guild_id as guildId, subject_id as subjectId, description, episode_count as episodeCount, confidence, created_at as createdAt, updated_at as updatedAt, status FROM behavioral_patterns WHERE guild_id=? AND subject_id=? AND status='active' ORDER BY confidence DESC").all(guildId, subjectId) as BehavioralPattern[];
  }
  maintain(guildId: string, candidateThreshold = .7) {
    const now = Date.now(), candidateCutoff = new Date(now - 7 * 86_400_000).toISOString(), staleCutoff = new Date(now - 90 * 86_400_000).toISOString();
    // The primary_evidence_type gate mirrors the per-insert promotableTypes allowlist so that
    // sarcasm, rumour, and uncertain-inference memories cannot be promoted by bulk maintenance
    // even if their confidence and mention counts happen to satisfy the numeric thresholds.
    const promoted = this.db.prepare("UPDATE memories SET status='active' WHERE guild_id=? AND status='candidate' AND mentions >= 2 AND confidence >= ? AND primary_evidence_type IN ('explicit_fact','clear_preference','correction')").run(guildId, candidateThreshold).changes;
    const quarantinedCandidates = this.db.prepare("UPDATE memories SET status='quarantined' WHERE guild_id=? AND status='candidate' AND last_confirmed_at < ?").run(guildId, candidateCutoff).changes;
    const quarantinedActive = this.db.prepare("UPDATE memories SET status='quarantined' WHERE guild_id=? AND status='active' AND confidence < .75 AND last_confirmed_at < ?").run(guildId, staleCutoff).changes;
    // Attempt to resolve all contested memories in this guild via age-weighted net score.
    const contestedIds = this.db.prepare("SELECT id FROM memories WHERE guild_id=? AND status='contested'").all(guildId) as Array<{ id: number }>;
    const resolved = contestedIds.filter(row => this.resolveContested(guildId, row.id).resolved).length;
    // Consolidate episodes into behavioral patterns per subject.
    const subjects = this.db.prepare("SELECT DISTINCT subject_id FROM memories WHERE guild_id=? AND kind='episode' AND status='active' AND pattern_id IS NULL").all(guildId) as Array<{ subject_id: string }>;
    const patternsFound = subjects.reduce((sum, row) => sum + this.consolidateEpisodes(guildId, row.subject_id), 0);
    return { promoted, quarantinedCandidates, quarantinedActive, resolved, patternsFound };
  }
  stats(guildId: string) { const count = (sql: string) => (this.db.prepare(sql).get(guildId) as { count: number }).count; return { messages: count("SELECT COUNT(*) as count FROM messages WHERE guild_id=?"), memories: count("SELECT COUNT(*) as count FROM memories WHERE guild_id=? AND status='active'"), lore: count("SELECT COUNT(*) as count FROM memories WHERE guild_id=? AND status='active' AND kind='server_lore'") }; }
  exportSubject(guildId: string, subjectId: string) { const memories = this.db.prepare(`SELECT ${this.memorySelect()} FROM memories WHERE guild_id=? AND subject_id=? ORDER BY id`).all(guildId, subjectId) as Memory[]; return memories.map(memory => ({ ...memory, evidence: this.evidence(guildId, memory.id) })); }
}
