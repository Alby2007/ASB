// One-time port: data/asm.sqlite (dumped to data/sqlite-dump.json) → Postgres.
// Prod already has rows whose IDs collide with sqlite IDs, so all serial IDs
// are remapped: insert without id, keep old→new map, rewrite references.
import "dotenv/config";
import { readFileSync } from "node:fs";
import postgres from "postgres";

const dump = JSON.parse(readFileSync("data/sqlite-dump.json", "utf8"));
const sql = postgres(process.env.DATABASE_URL, { max: 3, onnotice: () => {} });

const pick = (row, cols) => Object.fromEntries(cols.filter(c => c in row).map(c => [c, row[c]]));

async function insertRemap(sql, table, row, dropCols, uniqueWhere) {
  const cols = Object.keys(row);
  const inserted = await sql`
    INSERT INTO ${sql(table)} ${sql(row, cols)}
    ON CONFLICT DO NOTHING
    RETURNING id
  `;
  if (inserted[0]) return inserted[0].id;
  const [existing] = await uniqueWhere();
  return existing?.id;
}

const counts = {};
try {
  await sql.begin(async s => {
    // ── messages (PK is the Discord snowflake — real IDs, keep as-is) ──
    for (const m of dump.messages) {
      await s`INSERT INTO messages ${s(pick(m, ["id","guild_id","channel_id","author_id","author_name","content","created_at"]))} ON CONFLICT (id) DO NOTHING`;
    }
    counts.messages = dump.messages.length;

    // ── events (remap ids; needed by memories.event_id) ──
    const eventMap = new Map();
    for (const e of dump.events) {
      const row = pick(e, ["guild_id","channel_id","title","summary","significance","tier","occurred_at","closed_at","reference_count","created_at","updated_at"]);
      const [ins] = await s`INSERT INTO events ${s(row)} RETURNING id`;
      eventMap.set(e.id, ins.id);
    }
    counts.events = dump.events.length;

    // ── memories (remap ids; self-FKs and event_id fixed in second pass) ──
    const memMap = new Map();
    const pendingMemRefs = [];
    for (const m of dump.memories) {
      const row = pick(m, ["guild_id","subject_id","kind","content","confidence","importance","mentions","confirmation_count","contradiction_count","created_at","updated_at","last_confirmed_at","last_contradicted_at","status","explicitness","reason","net_score","frozen_confidence","pattern_id","primary_evidence_type","subject_name"]);
      const ins = await s`INSERT INTO memories ${s(row)} ON CONFLICT (guild_id, subject_id, kind, content) DO NOTHING RETURNING id`;
      let newId = ins[0]?.id;
      if (!newId) {
        const [ex] = await s`SELECT id FROM memories WHERE guild_id=${m.guild_id} AND subject_id=${m.subject_id} AND kind=${m.kind} AND content=${m.content}`;
        newId = ex.id;
      }
      memMap.set(m.id, newId);
      pendingMemRefs.push({ newId, superseded_by: m.superseded_by, supersedes_memory_id: m.supersedes_memory_id, event_id: m.event_id });
    }
    counts.memories = dump.memories.length;

    // ── memory_evidence (remap ids; memory_id via memMap) ──
    const evMap = new Map();
    for (const e of dump.memory_evidence) {
      const row = pick(e, ["message_id","author_id","quote","reason","explicitness","observed_at","evidence_type","effect","message_content_snapshot","message_timestamp","created_at"]);
      row.memory_id = memMap.get(e.memory_id);
      if (!row.memory_id) continue;
      const ins = await s`INSERT INTO memory_evidence ${s(row)} ON CONFLICT (memory_id, message_id) DO NOTHING RETURNING id`;
      let newId = ins[0]?.id;
      if (!newId) {
        const [ex] = await s`SELECT id FROM memory_evidence WHERE memory_id=${row.memory_id} AND message_id=${e.message_id}`;
        newId = ex.id;
      }
      evMap.set(e.id, newId);
    }
    counts.memory_evidence = dump.memory_evidence.length;

    // ── memory_history (remap memory_id + evidence_id) ──
    for (const h of dump.memory_history) {
      const row = pick(h, ["action","previous_confidence","new_confidence","previous_status","new_status","details_json","created_at"]);
      row.memory_id = memMap.get(h.memory_id);
      if (!row.memory_id) continue;
      row.evidence_id = h.evidence_id != null ? evMap.get(h.evidence_id) ?? null : null;
      await s`INSERT INTO memory_history ${s(row)}`;
    }
    counts.memory_history = dump.memory_history.length;

    // ── second pass: memory self-FKs + event_id ──
    for (const p of pendingMemRefs) {
      await s`UPDATE memories SET
        superseded_by = ${p.superseded_by != null ? memMap.get(p.superseded_by) ?? null : null},
        supersedes_memory_id = ${p.supersedes_memory_id != null ? memMap.get(p.supersedes_memory_id) ?? null : null},
        event_id = ${p.event_id != null ? eventMap.get(p.event_id) ?? null : null}
        WHERE id = ${p.newId}`;
    }

    // ── event link tables ──
    for (const p of dump.event_participants) {
      const eid = eventMap.get(p.event_id); if (!eid) continue;
      await s`INSERT INTO event_participants (event_id, user_id, user_name, role) VALUES (${eid}, ${p.user_id}, ${p.user_name}, ${p.role}) ON CONFLICT (event_id, user_id) DO NOTHING`;
    }
    counts.event_participants = dump.event_participants.length;
    for (const m of dump.event_messages) {
      const eid = eventMap.get(m.event_id); if (!eid) continue;
      await s`INSERT INTO event_messages (event_id, message_id) VALUES (${eid}, ${m.message_id}) ON CONFLICT (event_id, message_id) DO NOTHING`;
    }
    counts.event_messages = dump.event_messages.length;
    for (const m of dump.event_memories) {
      const eid = eventMap.get(m.event_id); const mid = memMap.get(m.memory_id);
      if (!eid || !mid) continue;
      await s`INSERT INTO event_memories (event_id, memory_id, link_type) VALUES (${eid}, ${mid}, ${m.link_type}) ON CONFLICT (event_id, memory_id) DO NOTHING`;
    }
    counts.event_memories = dump.event_memories.length;
  });

  // Fix IDENTITY sequences so future inserts don't collide with assigned ids
  for (const t of ["memories", "memory_evidence", "memory_history", "events", "event_participants", "event_messages", "event_memories"]) {
    await sql`SELECT setval(pg_get_serial_sequence(${t}, 'id'), COALESCE((SELECT MAX(id) FROM ${sql(t)}), 1))`;
  }

  console.log("Migrated:", counts);
  for (const t of ["messages","memories","memory_evidence","memory_history","events","event_participants","event_messages","event_memories"]) {
    const [c] = await sql`SELECT COUNT(*)::int n FROM ${sql(t)}`;
    console.log(t.padEnd(20), c.n);
  }
} finally {
  await sql.end();
}
