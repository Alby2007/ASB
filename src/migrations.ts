import type Database from "better-sqlite3";

type Db = Database.Database;

export interface Migration {
  version: number;
  name: string;
  up: (db: Db) => void;
  down: (db: Db) => void;
}

function hasColumn(db: Db, table: string, column: string) {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some(item => item.name === column);
}

function addColumn(db: Db, table: string, definition: string) {
  const column = definition.trim().split(/\s+/)[0];
  if (!hasColumn(db, table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
}

const migrations: Migration[] = [
  {
    version: 1,
    name: "phase_1a_add_evidence_tracking",
    up: (db: Db) => {
      addColumn(db, "memories", "confirmation_count INTEGER NOT NULL DEFAULT 0");
      addColumn(db, "memories", "contradiction_count INTEGER NOT NULL DEFAULT 0");
      addColumn(db, "memories", "updated_at TEXT NOT NULL DEFAULT ''");
      addColumn(db, "memories", "last_contradicted_at TEXT");
      addColumn(db, "memories", "supersedes_memory_id INTEGER");
      addColumn(db, "memory_evidence", "evidence_type TEXT NOT NULL DEFAULT 'uncertain_inference'");
      addColumn(db, "memory_evidence", "effect TEXT NOT NULL DEFAULT 'context'");
      addColumn(db, "memory_evidence", "message_content_snapshot TEXT NOT NULL DEFAULT ''");
      addColumn(db, "memory_evidence", "message_timestamp TEXT NOT NULL DEFAULT ''");
      addColumn(db, "memory_evidence", "created_at TEXT NOT NULL DEFAULT ''");
      db.exec(`
        CREATE TABLE IF NOT EXISTS memory_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT, memory_id INTEGER NOT NULL REFERENCES memories(id),
          action TEXT NOT NULL, previous_confidence REAL, new_confidence REAL,
          previous_status TEXT, new_status TEXT, evidence_id INTEGER REFERENCES memory_evidence(id),
          details_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS memory_history_lookup ON memory_history(memory_id, created_at DESC);
      `);
      db.exec("UPDATE memories SET confirmation_count=mentions WHERE confirmation_count=0 AND mentions > 0");
      db.exec("UPDATE memories SET updated_at=last_confirmed_at WHERE updated_at='' ");
      db.exec("UPDATE memories SET status='quarantined' WHERE status='stale'");
      db.exec("UPDATE memory_evidence SET message_content_snapshot=quote WHERE message_content_snapshot='' ");
      db.exec("UPDATE memory_evidence SET message_timestamp=observed_at WHERE message_timestamp='' ");
      db.exec("UPDATE memory_evidence SET created_at=observed_at WHERE created_at='' ");
    },
    down: (db: Db) => {
      db.exec("DROP INDEX IF EXISTS memory_history_lookup");
      db.exec("DROP TABLE IF EXISTS memory_history");
      // SQLite has limited DROP COLUMN support, so we set values to defaults instead
      db.exec("UPDATE memory_evidence SET created_at = '', message_timestamp = '', message_content_snapshot = '', effect = 'context', evidence_type = 'uncertain_inference'");
      db.exec("UPDATE memories SET supersedes_memory_id = NULL, last_contradicted_at = NULL, updated_at = '', contradiction_count = 0, confirmation_count = 0");
    },
  },
  {
    version: 2,
    name: "phase_1c_conflict_and_patterns",
    up: (db: Db) => {
      // Conflict resolution: persistent net_score and frozen_confidence let the UI and
      // future analytics inspect the resolution state without recomputing from evidence.
      addColumn(db, "memories", "net_score REAL");
      addColumn(db, "memories", "frozen_confidence REAL");
      // Pattern tracking: a nullable FK linking an episode to its consolidated pattern.
      addColumn(db, "memories", "pattern_id INTEGER");
      // Behavioral patterns table: one row per recognised pattern, pointing back to a
      // representative memory (the highest-confidence active episode in the group).
      db.exec(`
        CREATE TABLE IF NOT EXISTS behavioral_patterns (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          guild_id TEXT NOT NULL,
          subject_id TEXT NOT NULL,
          description TEXT NOT NULL,
          episode_count INTEGER NOT NULL DEFAULT 0,
          confidence REAL NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active'
        );
        CREATE INDEX IF NOT EXISTS patterns_lookup ON behavioral_patterns(guild_id, subject_id, status);
      `);
    },
    down: (db: Db) => {
      db.exec("DROP INDEX IF EXISTS patterns_lookup");
      db.exec("DROP TABLE IF EXISTS behavioral_patterns");
      // SQLite does not support DROP COLUMN reliably; null the added columns instead.
      db.exec("UPDATE memories SET net_score = NULL, frozen_confidence = NULL, pattern_id = NULL");
    },
  },
  {
    version: 3,
    name: "phase_1c_primary_evidence_type",
    up: (db: Db) => {
      // Store the evidence type that first created the memory so that the nightly bulk-promotion
      // path in maintain() can enforce the same evidence-type gate as the per-insert path.
      addColumn(db, "memories", "primary_evidence_type TEXT NOT NULL DEFAULT 'uncertain_inference'");
    },
    down: (db: Db) => {
      db.exec("UPDATE memories SET primary_evidence_type = 'uncertain_inference'");
    },
  },
  {
    version: 4,
    name: "v02_events",
    up: (db: Db) => {
      // Link memories to the event that generated or referenced them.
      addColumn(db, "memories", "event_id INTEGER");

      db.exec(`
        -- Core event row: one per detected incident.
        CREATE TABLE IF NOT EXISTS events (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          guild_id        TEXT    NOT NULL,
          channel_id      TEXT    NOT NULL,
          title           TEXT    NOT NULL DEFAULT '',
          summary         TEXT    NOT NULL DEFAULT '',
          significance    REAL    NOT NULL DEFAULT 0,
          tier            TEXT    NOT NULL DEFAULT 'candidate',
          occurred_at     TEXT    NOT NULL,
          closed_at       TEXT,
          reference_count INTEGER NOT NULL DEFAULT 0,
          created_at      TEXT    NOT NULL,
          updated_at      TEXT    NOT NULL
        );
        CREATE INDEX IF NOT EXISTS events_guild_channel
          ON events(guild_id, channel_id, occurred_at DESC);
        CREATE INDEX IF NOT EXISTS events_guild_open
          ON events(guild_id, tier, closed_at);

        -- Who was involved in an event.
        CREATE TABLE IF NOT EXISTS event_participants (
          id        INTEGER PRIMARY KEY AUTOINCREMENT,
          event_id  INTEGER NOT NULL REFERENCES events(id),
          user_id   TEXT    NOT NULL,
          user_name TEXT    NOT NULL,
          role      TEXT    NOT NULL DEFAULT 'participant',
          UNIQUE(event_id, user_id)
        );
        CREATE INDEX IF NOT EXISTS event_participants_event
          ON event_participants(event_id);

        -- Which Discord messages are part of the event.
        CREATE TABLE IF NOT EXISTS event_messages (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          event_id   INTEGER NOT NULL REFERENCES events(id),
          message_id TEXT    NOT NULL,
          UNIQUE(event_id, message_id)
        );
        CREATE INDEX IF NOT EXISTS event_messages_event
          ON event_messages(event_id);

        -- Which memories are linked to the event.
        CREATE TABLE IF NOT EXISTS event_memories (
          id        INTEGER PRIMARY KEY AUTOINCREMENT,
          event_id  INTEGER NOT NULL REFERENCES events(id),
          memory_id INTEGER NOT NULL REFERENCES memories(id),
          link_type TEXT    NOT NULL DEFAULT 'generated',
          UNIQUE(event_id, memory_id)
        );
        CREATE INDEX IF NOT EXISTS event_memories_memory
          ON event_memories(memory_id);
        CREATE INDEX IF NOT EXISTS event_memories_event
          ON event_memories(event_id);
      `);
    },
    down: (db: Db) => {
      db.exec("DROP INDEX IF EXISTS event_memories_event");
      db.exec("DROP INDEX IF EXISTS event_memories_memory");
      db.exec("DROP TABLE IF EXISTS event_memories");
      db.exec("DROP INDEX IF EXISTS event_messages_event");
      db.exec("DROP TABLE IF EXISTS event_messages");
      db.exec("DROP INDEX IF EXISTS event_participants_event");
      db.exec("DROP TABLE IF EXISTS event_participants");
      db.exec("DROP INDEX IF EXISTS events_guild_open");
      db.exec("DROP INDEX IF EXISTS events_guild_channel");
      db.exec("DROP TABLE IF EXISTS events");
      db.exec("UPDATE memories SET event_id = NULL");
    },
  },
];

export function runMigrations(db: Db, targetVersion?: number) {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  
  const currentVersion = db.prepare("SELECT MAX(version) as version FROM schema_migrations").get() as { version: number | null };
  const current = currentVersion.version ?? 0;
  
  const target = targetVersion ?? Math.max(...migrations.map(m => m.version));
  
  if (current === target) return;
  
  if (target > current) {
    for (const migration of migrations) {
      if (migration.version > current && migration.version <= target) {
        console.log(`Applying migration ${migration.version}: ${migration.name}`);
        const transaction = db.transaction(() => {
          migration.up(db);
          db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(migration.version, new Date().toISOString());
        });
        transaction();
      }
    }
  } else if (target < current) {
    for (const migration of [...migrations].reverse()) {
      if (migration.version <= current && migration.version > target) {
        console.log(`Rolling back migration ${migration.version}: ${migration.name}`);
        const transaction = db.transaction(() => {
          migration.down(db);
          db.prepare("DELETE FROM schema_migrations WHERE version = ?").run(migration.version);
        });
        transaction();
      }
    }
  }
}

export function getMigrationVersion(db: Db): number {
  const result = db.prepare("SELECT MAX(version) as version FROM schema_migrations").get() as { version: number | null };
  return result.version ?? 0;
}
