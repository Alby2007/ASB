import Database from "better-sqlite3";
import type { EventCandidate, EventParticipant, EventTier, ParticipantRole, StoredEvent } from "./types.js";

// ── Row shapes returned by SQLite ─────────────────────────────────────────────

type EventRow = {
  id: number; guildId: string; channelId: string;
  title: string; summary: string; significance: number; tier: string;
  occurredAt: string; closedAt: string | null; referenceCount: number;
  createdAt: string; updatedAt: string;
};

type ParticipantRow = { userId: string; userName: string; role: string };
type MessageRow    = { messageId: string };
type MemoryRow     = { memoryId: number };

// ── Helpers ───────────────────────────────────────────────────────────────────

function rowToStored(row: EventRow, participants: EventParticipant[], messageIds: string[], memoryIds: number[]): StoredEvent {
  return {
    id: row.id, guildId: row.guildId, channelId: row.channelId,
    title: row.title, summary: row.summary,
    significance: row.significance, tier: row.tier as EventTier,
    occurredAt: new Date(row.occurredAt),
    closedAt: row.closedAt ? new Date(row.closedAt) : null,
    referenceCount: row.referenceCount,
    participants, messageIds, memoryIds,
    createdAt: row.createdAt, updatedAt: row.updatedAt,
  };
}

// ── EventStore ────────────────────────────────────────────────────────────────

export class EventStore {
  constructor(private db: Database.Database) {}

  // ── Reads ──────────────────────────────────────────────────────────────────

  private hydrate(row: EventRow): StoredEvent {
    const participants = (this.db.prepare(
      "SELECT user_id as userId, user_name as userName, role FROM event_participants WHERE event_id=?"
    ).all(row.id) as ParticipantRow[]).map(p => ({ ...p, role: p.role as ParticipantRole }));

    const messageIds = (this.db.prepare(
      "SELECT message_id as messageId FROM event_messages WHERE event_id=?"
    ).all(row.id) as MessageRow[]).map(r => r.messageId);

    const memoryIds = (this.db.prepare(
      "SELECT memory_id as memoryId FROM event_memories WHERE event_id=?"
    ).all(row.id) as MemoryRow[]).map(r => r.memoryId);

    return rowToStored(row, participants, messageIds, memoryIds);
  }

  getEvent(guildId: string, eventId: number): StoredEvent | undefined {
    const row = this.db.prepare(
      "SELECT id, guild_id as guildId, channel_id as channelId, title, summary, significance, tier, occurred_at as occurredAt, closed_at as closedAt, reference_count as referenceCount, created_at as createdAt, updated_at as updatedAt FROM events WHERE guild_id=? AND id=?"
    ).get(guildId, eventId) as EventRow | undefined;
    return row ? this.hydrate(row) : undefined;
  }

  /** All open (unclosed) events for a guild/channel, ordered newest first. */
  openEvents(guildId: string, channelId: string): StoredEvent[] {
    const rows = this.db.prepare(
      "SELECT id, guild_id as guildId, channel_id as channelId, title, summary, significance, tier, occurred_at as occurredAt, closed_at as closedAt, reference_count as referenceCount, created_at as createdAt, updated_at as updatedAt FROM events WHERE guild_id=? AND channel_id=? AND closed_at IS NULL ORDER BY occurred_at DESC"
    ).all(guildId, channelId) as EventRow[];
    return rows.map(r => this.hydrate(r));
  }

  /** All open events across a guild (used by retroactive reference scan). */
  openEventsForGuild(guildId: string): StoredEvent[] {
    const rows = this.db.prepare(
      "SELECT id, guild_id as guildId, channel_id as channelId, title, summary, significance, tier, occurred_at as occurredAt, closed_at as closedAt, reference_count as referenceCount, created_at as createdAt, updated_at as updatedAt FROM events WHERE guild_id=? AND closed_at IS NULL ORDER BY occurred_at DESC"
    ).all(guildId) as EventRow[];
    return rows.map(r => this.hydrate(r));
  }

  /** All events that a given message_id is part of. */
  eventsForMessage(messageId: string): StoredEvent[] {
    const rows = this.db.prepare(
      "SELECT e.id, e.guild_id as guildId, e.channel_id as channelId, e.title, e.summary, e.significance, e.tier, e.occurred_at as occurredAt, e.closed_at as closedAt, e.reference_count as referenceCount, e.created_at as createdAt, e.updated_at as updatedAt FROM events e JOIN event_messages em ON em.event_id=e.id WHERE em.message_id=?"
    ).all(messageId) as EventRow[];
    return rows.map(r => this.hydrate(r));
  }

  /** All events that a given memory is linked to. */
  eventsForMemory(memoryId: number): StoredEvent[] {
    const rows = this.db.prepare(
      "SELECT e.id, e.guild_id as guildId, e.channel_id as channelId, e.title, e.summary, e.significance, e.tier, e.occurred_at as occurredAt, e.closed_at as closedAt, e.reference_count as referenceCount, e.created_at as createdAt, e.updated_at as updatedAt FROM events e JOIN event_memories em ON em.event_id=e.id WHERE em.memory_id=?"
    ).all(memoryId) as EventRow[];
    return rows.map(r => this.hydrate(r));
  }

  listEvents(guildId: string, options: { tier?: EventTier; subjectUserId?: string; page?: number } = {}): { events: StoredEvent[]; total: number; page: number } {
    const page = Math.max(1, options.page ?? 1);
    const where = ["e.guild_id = ?"];
    const values: Array<string | number> = [guildId];

    if (options.tier) { where.push("e.tier = ?"); values.push(options.tier); } else where.push("e.tier = 'event'");
    if (options.subjectUserId) {
      where.push("EXISTS (SELECT 1 FROM event_participants ep WHERE ep.event_id=e.id AND ep.user_id=?)");
      values.push(options.subjectUserId);
    }

    const whereClause = where.join(" AND ");
    const count = this.db.prepare(`SELECT COUNT(*) as count FROM events e WHERE ${whereClause}`).get(...values) as { count: number };
    const rows = this.db.prepare(`SELECT e.id, e.guild_id as guildId, e.channel_id as channelId, e.title, e.summary, e.significance, e.tier, e.occurred_at as occurredAt, e.closed_at as closedAt, e.reference_count as referenceCount, e.created_at as createdAt, e.updated_at as updatedAt FROM events e WHERE ${whereClause} ORDER BY e.occurred_at DESC LIMIT 8 OFFSET ?`).all(...values, (page - 1) * 8) as EventRow[];
    return { events: rows.map(r => this.hydrate(r)), total: count.count, page };
  }

  // ── Writes ─────────────────────────────────────────────────────────────────

  createEvent(candidate: Omit<EventCandidate, "messageIds" | "memoryIds">): StoredEvent {
    const now = new Date().toISOString();
    const transaction = this.db.transaction(() => {
      const result = this.db.prepare(
        "INSERT INTO events (guild_id, channel_id, title, summary, significance, tier, occurred_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(candidate.guildId, candidate.channelId, candidate.title, candidate.summary, candidate.significance, candidate.tier, candidate.occurredAt.toISOString(), now, now);
      const eventId = Number(result.lastInsertRowid);
      for (const p of candidate.participants) {
        this.db.prepare("INSERT OR IGNORE INTO event_participants (event_id, user_id, user_name, role) VALUES (?, ?, ?, ?)").run(eventId, p.userId, p.userName, p.role);
      }
      return this.getEvent(candidate.guildId, eventId)!;
    });
    return transaction();
  }

  attachMessage(eventId: number, messageId: string): void {
    this.db.prepare("INSERT OR IGNORE INTO event_messages (event_id, message_id) VALUES (?, ?)").run(eventId, messageId);
    this.db.prepare("UPDATE events SET updated_at=? WHERE id=?").run(new Date().toISOString(), eventId);
  }

  attachMemory(eventId: number, memoryId: number, linkType: "generated" | "referenced" | "retroactive" = "generated"): void {
    this.db.prepare("INSERT OR IGNORE INTO event_memories (event_id, memory_id, link_type) VALUES (?, ?, ?)").run(eventId, memoryId, linkType);
    this.db.prepare("UPDATE memories SET event_id=? WHERE id=? AND event_id IS NULL").run(eventId, memoryId);
    this.db.prepare("UPDATE events SET updated_at=? WHERE id=?").run(new Date().toISOString(), eventId);
  }

  addParticipant(eventId: number, userId: string, userName: string, role: ParticipantRole = "participant"): void {
    this.db.prepare("INSERT OR IGNORE INTO event_participants (event_id, user_id, user_name, role) VALUES (?, ?, ?, ?)").run(eventId, userId, userName, role);
  }

  closeEvent(eventId: number): void {
    this.db.prepare("UPDATE events SET closed_at=?, updated_at=? WHERE id=? AND closed_at IS NULL").run(new Date().toISOString(), new Date().toISOString(), eventId);
  }

  updateSignificance(eventId: number, significance: number, tier: EventTier, title: string, summary: string): void {
    this.db.prepare("UPDATE events SET significance=?, tier=?, title=?, summary=?, updated_at=? WHERE id=?").run(significance, tier, title, summary, new Date().toISOString(), eventId);
  }

  incrementReferenceCount(eventId: number): number {
    this.db.prepare("UPDATE events SET reference_count=reference_count+1, updated_at=? WHERE id=?").run(new Date().toISOString(), eventId);
    const row = this.db.prepare("SELECT reference_count as referenceCount FROM events WHERE id=?").get(eventId) as { referenceCount: number } | undefined;
    return row?.referenceCount ?? 0;
  }

  /** Close all open events older than maxAgeMs. Returns the count closed. */
  closeStaleEvents(guildId: string, maxAgeMs: number): number {
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    return this.db.prepare("UPDATE events SET closed_at=?, updated_at=? WHERE guild_id=? AND closed_at IS NULL AND occurred_at < ?").run(new Date().toISOString(), new Date().toISOString(), guildId, cutoff).changes;
  }
}
