import { sql as defaultSql, type Sql } from "./db.js";
import type { EventCandidate, EventParticipant, EventTier, ParticipantRole, StoredEvent } from "./types.js";

// ── Row types returned by Postgres ────────────────────────────────────────────

type EventRow = {
  id: number; guild_id: string; channel_id: string;
  title: string; summary: string; significance: number; tier: string;
  occurred_at: Date | string; closed_at: Date | string | null; reference_count: number;
  created_at: Date | string; updated_at: Date | string;
};

type ParticipantRow = { user_id: string; user_name: string; role: string };
type MessageRow    = { message_id: string };
type MemoryRow     = { memory_id: number };

// ── Helpers ───────────────────────────────────────────────────────────────────

function ts(d: Date | string): string {
  return d instanceof Date ? d.toISOString() : d;
}

function rowToStored(row: EventRow, participants: EventParticipant[], messageIds: string[], memoryIds: number[]): StoredEvent {
  return {
    id: Number(row.id), guildId: row.guild_id, channelId: row.channel_id,
    title: row.title, summary: row.summary,
    significance: Number(row.significance), tier: row.tier as EventTier,
    occurredAt: new Date(ts(row.occurred_at)),
    closedAt: row.closed_at ? new Date(ts(row.closed_at)) : null,
    referenceCount: Number(row.reference_count),
    participants, messageIds, memoryIds,
    createdAt: ts(row.created_at), updatedAt: ts(row.updated_at),
  };
}

// ── EventStore ────────────────────────────────────────────────────────────────

export class EventStore {
  private sql: Sql;

  constructor(sql: Sql = defaultSql) {
    this.sql = sql;
  }

  // ── Reads ──────────────────────────────────────────────────────────────────

  private async hydrate(row: EventRow): Promise<StoredEvent> {
    const participants = (await this.sql<ParticipantRow[]>`
      SELECT user_id, user_name, role FROM event_participants WHERE event_id = ${row.id}
    `).map(p => ({ userId: p.user_id, userName: p.user_name, role: p.role as ParticipantRole }));

    const messageIds = (await this.sql<MessageRow[]>`
      SELECT message_id FROM event_messages WHERE event_id = ${row.id}
    `).map(r => r.message_id);

    const memoryIds = (await this.sql<MemoryRow[]>`
      SELECT memory_id FROM event_memories WHERE event_id = ${row.id}
    `).map(r => Number(r.memory_id));

    return rowToStored(row, participants, messageIds, memoryIds);
  }

  async getEvent(guildId: string, eventId: number): Promise<StoredEvent | undefined> {
    const rows = await this.sql<EventRow[]>`
      SELECT id, guild_id, channel_id, title, summary, significance, tier, occurred_at, closed_at, reference_count, created_at, updated_at
      FROM events WHERE guild_id = ${guildId} AND id = ${eventId}
    `;
    return rows[0] ? this.hydrate(rows[0]) : undefined;
  }

  /** All open (unclosed) events for a guild/channel, ordered newest first. */
  async openEvents(guildId: string, channelId: string): Promise<StoredEvent[]> {
    const rows = await this.sql<EventRow[]>`
      SELECT id, guild_id, channel_id, title, summary, significance, tier, occurred_at, closed_at, reference_count, created_at, updated_at
      FROM events WHERE guild_id = ${guildId} AND channel_id = ${channelId} AND closed_at IS NULL
      ORDER BY occurred_at DESC
    `;
    return Promise.all(rows.map(r => this.hydrate(r)));
  }

  /** All events that a given memory is linked to. */
  async eventsForMemory(memoryId: number): Promise<StoredEvent[]> {
    const rows = await this.sql<EventRow[]>`
      SELECT e.id, e.guild_id, e.channel_id, e.title, e.summary, e.significance, e.tier,
             e.occurred_at, e.closed_at, e.reference_count, e.created_at, e.updated_at
      FROM events e JOIN event_memories em ON em.event_id = e.id WHERE em.memory_id = ${memoryId}
    `;
    return Promise.all(rows.map(r => this.hydrate(r)));
  }

  async listEvents(guildId: string, options: { tier?: EventTier; subjectUserId?: string; page?: number } = {}): Promise<{ events: StoredEvent[]; total: number; page: number }> {
    const page = Math.max(1, options.page ?? 1);
    const offset = (page - 1) * 8;
    const tier = options.tier ?? "event";

    let countResult: [{ count: number }];
    let rows: EventRow[];

    if (options.subjectUserId) {
      countResult = await this.sql<[{ count: number }]>`
        SELECT COUNT(*)::int as count FROM events e WHERE e.guild_id = ${guildId} AND e.tier = ${tier}
        AND EXISTS (SELECT 1 FROM event_participants ep WHERE ep.event_id = e.id AND ep.user_id = ${options.subjectUserId})
      `;
      rows = await this.sql<EventRow[]>`
        SELECT e.id, e.guild_id, e.channel_id, e.title, e.summary, e.significance, e.tier,
               e.occurred_at, e.closed_at, e.reference_count, e.created_at, e.updated_at
        FROM events e WHERE e.guild_id = ${guildId} AND e.tier = ${tier}
        AND EXISTS (SELECT 1 FROM event_participants ep WHERE ep.event_id = e.id AND ep.user_id = ${options.subjectUserId})
        ORDER BY e.occurred_at DESC LIMIT 8 OFFSET ${offset}
      `;
    } else {
      countResult = await this.sql<[{ count: number }]>`SELECT COUNT(*)::int as count FROM events WHERE guild_id = ${guildId} AND tier = ${tier}`;
      rows = await this.sql<EventRow[]>`
        SELECT id, guild_id, channel_id, title, summary, significance, tier, occurred_at, closed_at, reference_count, created_at, updated_at
        FROM events WHERE guild_id = ${guildId} AND tier = ${tier}
        ORDER BY occurred_at DESC LIMIT 8 OFFSET ${offset}
      `;
    }

    return { events: await Promise.all(rows.map(r => this.hydrate(r))), total: Number(countResult[0].count), page };
  }

  /** Promoted events both users participated in — the shared-history layer for
   * pairwise reply context. Roles are returned per side so the caller can
   * attribute them correctly. */
  async sharedEvents(guildId: string, aId: string, bId: string, limit = 3): Promise<Array<{
    title: string; occurredAt: string; roleA: string | null; roleB: string | null;
  }>> {
    const rows = await this.sql<Array<{
      title: string; occurred_at: Date | string; role_a: string | null; role_b: string | null;
    }>>`
      SELECT e.title, e.occurred_at, pa.role AS role_a, pb.role AS role_b
      FROM events e
      JOIN event_participants pa ON pa.event_id = e.id AND pa.user_id = ${aId}
      JOIN event_participants pb ON pb.event_id = e.id AND pb.user_id = ${bId}
      WHERE e.guild_id = ${guildId} AND e.tier = 'event' AND e.title != ''
      ORDER BY e.significance DESC, e.occurred_at DESC LIMIT ${limit}
    `;
    return rows.map(r => ({
      title: r.title, occurredAt: ts(r.occurred_at),
      roleA: r.role_a, roleB: r.role_b,
    }));
  }

  // ── Writes ─────────────────────────────────────────────────────────────────

  async createEvent(candidate: Omit<EventCandidate, "messageIds" | "memoryIds">): Promise<StoredEvent> {
    return await this.sql.begin(async sql => {
      const inserted = await sql<EventRow[]>`
        INSERT INTO events (guild_id, channel_id, title, summary, significance, tier, occurred_at)
        VALUES (${candidate.guildId}, ${candidate.channelId}, ${candidate.title}, ${candidate.summary}, ${candidate.significance}, ${candidate.tier}, ${candidate.occurredAt.toISOString()})
        RETURNING id, guild_id, channel_id, title, summary, significance, tier, occurred_at, closed_at, reference_count, created_at, updated_at
      `;
      const row = inserted[0];
      const eventId = Number(row.id);
      for (const p of candidate.participants) {
        await sql`
          INSERT INTO event_participants (event_id, user_id, user_name, role)
          VALUES (${eventId}, ${p.userId}, ${p.userName}, ${p.role})
          ON CONFLICT (event_id, user_id) DO NOTHING
        `;
      }
      // Build the StoredEvent from the RETURNING row + participants (no separate SELECT needed)
      return rowToStored(row, candidate.participants, [], []);
    }) as StoredEvent;
  }

  async attachMessage(eventId: number, messageId: string): Promise<void> {
    await this.sql`INSERT INTO event_messages (event_id, message_id) VALUES (${eventId}, ${messageId}) ON CONFLICT (event_id, message_id) DO NOTHING`;
    await this.sql`UPDATE events SET updated_at = NOW() WHERE id = ${eventId}`;
  }

  async attachMemory(eventId: number, memoryId: number, linkType: "generated" | "referenced" | "retroactive" = "generated"): Promise<void> {
    await this.sql`INSERT INTO event_memories (event_id, memory_id, link_type) VALUES (${eventId}, ${memoryId}, ${linkType}) ON CONFLICT (event_id, memory_id) DO NOTHING`;
    await this.sql`UPDATE memories SET event_id = ${eventId} WHERE id = ${memoryId} AND event_id IS NULL`;
    await this.sql`UPDATE events SET updated_at = NOW() WHERE id = ${eventId}`;
  }

  async addParticipant(eventId: number, userId: string, userName: string, role: ParticipantRole = "participant"): Promise<void> {
    await this.sql`INSERT INTO event_participants (event_id, user_id, user_name, role) VALUES (${eventId}, ${userId}, ${userName}, ${role}) ON CONFLICT (event_id, user_id) DO NOTHING`;
  }

  async closeEvent(eventId: number): Promise<void> {
    await this.sql`UPDATE events SET closed_at = NOW(), updated_at = NOW() WHERE id = ${eventId} AND closed_at IS NULL`;
  }

  async updateSignificance(eventId: number, significance: number, tier: EventTier, title: string, summary: string): Promise<void> {
    await this.sql`UPDATE events SET significance = ${significance}, tier = ${tier}, title = ${title}, summary = ${summary}, updated_at = NOW() WHERE id = ${eventId}`;
  }

  async incrementReferenceCount(eventId: number): Promise<number> {
    await this.sql`UPDATE events SET reference_count = reference_count + 1, updated_at = NOW() WHERE id = ${eventId}`;
    const rows = await this.sql<[{ reference_count: number }]>`SELECT reference_count FROM events WHERE id = ${eventId}`;
    return rows[0]?.reference_count ?? 0;
  }

  /** Close all open events older than maxAgeMs. Returns the count closed. */
  async closeStaleEvents(guildId: string, maxAgeMs: number): Promise<number> {
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    const result = await this.sql`UPDATE events SET closed_at = NOW(), updated_at = NOW() WHERE guild_id = ${guildId} AND closed_at IS NULL AND occurred_at < ${cutoff}`;
    return result.count;
  }
}
