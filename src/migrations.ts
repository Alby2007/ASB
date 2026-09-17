import type { Sql } from "./db.js";

export interface Migration {
  version: number;
  name: string;
  up: (sql: Sql) => Promise<void>;
  down: (sql: Sql) => Promise<void>;
}

async function hasColumn(sql: Sql, table: string, column: string): Promise<boolean> {
  const rows = await sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = ${table} AND column_name = ${column}
  `;
  return rows.length > 0;
}

async function addColumn(sql: Sql, table: string, definition: string): Promise<void> {
  const column = definition.trim().split(/\s+/)[0];
  if (!(await hasColumn(sql, table, column))) {
    await sql.unsafe(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
  }
}

const migrations: Migration[] = [
  {
    version: 1,
    name: "phase_1a_add_evidence_tracking",
    up: async (sql) => {
      await addColumn(sql, "memories", "confirmation_count INTEGER NOT NULL DEFAULT 0");
      await addColumn(sql, "memories", "contradiction_count INTEGER NOT NULL DEFAULT 0");
      await addColumn(sql, "memories", "updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()");
      await addColumn(sql, "memories", "last_contradicted_at TIMESTAMPTZ");
      await addColumn(sql, "memories", "supersedes_memory_id BIGINT");
      await addColumn(sql, "memory_evidence", "evidence_type TEXT NOT NULL DEFAULT 'uncertain_inference'");
      await addColumn(sql, "memory_evidence", "effect TEXT NOT NULL DEFAULT 'context'");
      await addColumn(sql, "memory_evidence", "message_content_snapshot TEXT NOT NULL DEFAULT ''");
      await addColumn(sql, "memory_evidence", "message_timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()");
      await addColumn(sql, "memory_evidence", "created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()");
      await sql`
        CREATE TABLE IF NOT EXISTS memory_history (
          id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          memory_id        BIGINT NOT NULL REFERENCES memories(id),
          action           TEXT NOT NULL,
          previous_confidence DOUBLE PRECISION,
          new_confidence   DOUBLE PRECISION,
          previous_status  TEXT,
          new_status       TEXT,
          evidence_id      BIGINT REFERENCES memory_evidence(id),
          details_json     TEXT NOT NULL DEFAULT '{}',
          created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS memory_history_lookup ON memory_history(memory_id, created_at DESC)`;
      await sql`UPDATE memories SET confirmation_count = mentions WHERE confirmation_count = 0 AND mentions > 0`;
      await sql`UPDATE memories SET status = 'quarantined' WHERE status = 'stale'`;
    },
    down: async (sql) => {
      await sql`DROP INDEX IF EXISTS memory_history_lookup`;
      await sql`DROP TABLE IF EXISTS memory_history`;
      await sql`UPDATE memory_evidence SET message_content_snapshot = '', effect = 'context', evidence_type = 'uncertain_inference'`;
      await sql`UPDATE memories SET supersedes_memory_id = NULL, last_contradicted_at = NULL, contradiction_count = 0, confirmation_count = 0`;
    },
  },
  {
    version: 2,
    name: "phase_1c_conflict_and_patterns",
    up: async (sql) => {
      await addColumn(sql, "memories", "net_score DOUBLE PRECISION");
      await addColumn(sql, "memories", "frozen_confidence DOUBLE PRECISION");
      await addColumn(sql, "memories", "pattern_id BIGINT");
      await sql`
        CREATE TABLE IF NOT EXISTS behavioral_patterns (
          id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          guild_id      TEXT NOT NULL,
          subject_id    TEXT NOT NULL,
          description   TEXT NOT NULL,
          episode_count INTEGER NOT NULL DEFAULT 0,
          confidence    DOUBLE PRECISION NOT NULL DEFAULT 0,
          created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          status        TEXT NOT NULL DEFAULT 'active'
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS patterns_lookup ON behavioral_patterns(guild_id, subject_id, status)`;
    },
    down: async (sql) => {
      await sql`DROP INDEX IF EXISTS patterns_lookup`;
      await sql`DROP TABLE IF EXISTS behavioral_patterns`;
      await sql`UPDATE memories SET net_score = NULL, frozen_confidence = NULL, pattern_id = NULL`;
    },
  },
  {
    version: 3,
    name: "phase_1c_primary_evidence_type",
    up: async (sql) => {
      await addColumn(sql, "memories", "primary_evidence_type TEXT NOT NULL DEFAULT 'uncertain_inference'");
    },
    down: async (sql) => {
      await sql`UPDATE memories SET primary_evidence_type = 'uncertain_inference'`;
    },
  },
  {
    version: 4,
    name: "v02_events",
    up: async (sql) => {
      await addColumn(sql, "memories", "event_id BIGINT");
      await sql`
        CREATE TABLE IF NOT EXISTS events (
          id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          guild_id        TEXT NOT NULL,
          channel_id      TEXT NOT NULL,
          title           TEXT NOT NULL DEFAULT '',
          summary         TEXT NOT NULL DEFAULT '',
          significance    DOUBLE PRECISION NOT NULL DEFAULT 0,
          tier            TEXT NOT NULL DEFAULT 'candidate',
          occurred_at     TIMESTAMPTZ NOT NULL,
          closed_at       TIMESTAMPTZ,
          reference_count INTEGER NOT NULL DEFAULT 0,
          created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS events_guild_channel ON events(guild_id, channel_id, occurred_at DESC)`;
      await sql`CREATE INDEX IF NOT EXISTS events_guild_open ON events(guild_id, tier, closed_at)`;
      await sql`
        CREATE TABLE IF NOT EXISTS event_participants (
          id        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          event_id  BIGINT NOT NULL REFERENCES events(id),
          user_id   TEXT NOT NULL,
          user_name TEXT NOT NULL,
          role      TEXT NOT NULL DEFAULT 'participant',
          UNIQUE(event_id, user_id)
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS event_participants_event ON event_participants(event_id)`;
      await sql`
        CREATE TABLE IF NOT EXISTS event_messages (
          id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          event_id   BIGINT NOT NULL REFERENCES events(id),
          message_id TEXT NOT NULL,
          UNIQUE(event_id, message_id)
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS event_messages_event ON event_messages(event_id)`;
      await sql`
        CREATE TABLE IF NOT EXISTS event_memories (
          id        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          event_id  BIGINT NOT NULL REFERENCES events(id),
          memory_id BIGINT NOT NULL REFERENCES memories(id),
          link_type TEXT NOT NULL DEFAULT 'generated',
          UNIQUE(event_id, memory_id)
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS event_memories_memory ON event_memories(memory_id)`;
      await sql`CREATE INDEX IF NOT EXISTS event_memories_event ON event_memories(event_id)`;
    },
    down: async (sql) => {
      await sql`DROP INDEX IF EXISTS event_memories_event`;
      await sql`DROP INDEX IF EXISTS event_memories_memory`;
      await sql`DROP TABLE IF EXISTS event_memories`;
      await sql`DROP INDEX IF EXISTS event_messages_event`;
      await sql`DROP TABLE IF EXISTS event_messages`;
      await sql`DROP INDEX IF EXISTS event_participants_event`;
      await sql`DROP TABLE IF EXISTS event_participants`;
      await sql`DROP INDEX IF EXISTS events_guild_open`;
      await sql`DROP INDEX IF EXISTS events_guild_channel`;
      await sql`DROP TABLE IF EXISTS events`;
      await sql`UPDATE memories SET event_id = NULL`;
    },
  },
  {
    version: 5,
    name: "v02_memory_subject_name",
    up: async (sql) => {
      await addColumn(sql, "memories", "subject_name TEXT NOT NULL DEFAULT ''");
    },
    down: async (sql) => {
      await sql`UPDATE memories SET subject_name = ''`;
    },
  },
  {
    version: 6,
    name: "v02_message_triage_result",
    up: async (sql) => {
      await addColumn(sql, "messages", "triage_result TEXT");
    },
    down: async (sql) => {
      await sql`UPDATE messages SET triage_result = NULL`;
    },
  },
  {
    version: 7,
    name: "v03_profiles_and_relationships",
    up: async (sql) => {
      await addColumn(sql, "messages", "reply_to_id TEXT");
      await sql`
        CREATE TABLE IF NOT EXISTS members (
          guild_id      TEXT NOT NULL,
          user_id       TEXT NOT NULL,
          known_names   TEXT[] NOT NULL DEFAULT '{}',
          first_seen_at TIMESTAMPTZ NOT NULL,
          last_seen_at  TIMESTAMPTZ NOT NULL,
          message_count INTEGER NOT NULL DEFAULT 0,
          opted_out     SMALLINT NOT NULL DEFAULT 0,
          PRIMARY KEY (guild_id, user_id)
        )
      `;
      await sql`
        CREATE TABLE IF NOT EXISTS relationship_observations (
          id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          guild_id   TEXT NOT NULL,
          subject_id TEXT NOT NULL,
          other_id   TEXT NOT NULL,
          message_id TEXT NOT NULL,
          nature     TEXT NOT NULL,
          valence    DOUBLE PRECISION,
          reason     TEXT NOT NULL DEFAULT '',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE(subject_id, other_id, message_id)
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS relationship_obs_lookup ON relationship_observations(guild_id, subject_id, other_id)`;
      await sql`
        CREATE TABLE IF NOT EXISTS relationships (
          id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          guild_id          TEXT NOT NULL,
          subject_id        TEXT NOT NULL,
          other_id          TEXT NOT NULL,
          summary           TEXT NOT NULL DEFAULT '',
          valence           DOUBLE PRECISION,
          observation_count INTEGER NOT NULL DEFAULT 0,
          last_observed_at  TIMESTAMPTZ,
          updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE(guild_id, subject_id, other_id)
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS relationships_lookup ON relationships(guild_id, subject_id)`;
      await sql`
        CREATE TABLE IF NOT EXISTS profiles (
          guild_id     TEXT NOT NULL,
          subject_id   TEXT NOT NULL,
          display_name TEXT NOT NULL DEFAULT '',
          summary      TEXT NOT NULL DEFAULT '',
          facets_json  TEXT NOT NULL DEFAULT '{}',
          source_hash  TEXT NOT NULL DEFAULT '',
          built_at     TIMESTAMPTZ,
          updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (guild_id, subject_id)
        )
      `;
    },
    down: async (sql) => {
      await sql`DROP INDEX IF EXISTS relationships_lookup`;
      await sql`DROP TABLE IF EXISTS relationships`;
      await sql`DROP INDEX IF EXISTS relationship_obs_lookup`;
      await sql`DROP TABLE IF EXISTS relationship_observations`;
      await sql`DROP TABLE IF EXISTS profiles`;
      await sql`DROP TABLE IF EXISTS members`;
      await sql`UPDATE messages SET reply_to_id = NULL`;
    },
  },
  {
    version: 8,
    name: "v04_relationship_verdicts",
    // Sincerity verdict per observation ('literal'|'joke'|'unclear'; NULL = not
    // yet judged). Edge roll-up excludes 'joke' rows so edgy banter doesn't
    // create durable edges.
    up: async (sql) => {
      await addColumn(sql, "relationship_observations", "verdict TEXT");
    },
    down: async (sql) => {
      await sql`ALTER TABLE relationship_observations DROP COLUMN IF EXISTS verdict`;
    },
  },
  {
    version: 9,
    name: "v05_alias_learning",
    // Provenance for learned aliases: a self-naming hit ("I am Sage" posted by
    // tinyriot) both records the candidate and applies it to known_names.
    up: async (sql) => {
      await sql`
        CREATE TABLE IF NOT EXISTS alias_candidates (
          id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          guild_id            TEXT NOT NULL,
          user_id             TEXT NOT NULL,
          name                TEXT NOT NULL,
          source              TEXT NOT NULL,
          evidence_message_id TEXT NOT NULL DEFAULT '',
          created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE(guild_id, user_id, name, evidence_message_id)
        )
      `;
    },
    down: async (sql) => {
      await sql`DROP TABLE IF EXISTS alias_candidates`;
    },
  },
  {
    version: 10,
    name: "v06_unresolved_names",
    // Names that failed entity resolution, logged with their message — the
    // discovery surface for aliases the self-naming path can't catch and for
    // recurring non-member entities worth modeling.
    up: async (sql) => {
      await sql`
        CREATE TABLE IF NOT EXISTS unresolved_names (
          id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          guild_id   TEXT NOT NULL,
          name       TEXT NOT NULL,
          message_id TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE(guild_id, name, message_id)
        )
      `;
    },
    down: async (sql) => {
      await sql`DROP TABLE IF EXISTS unresolved_names`;
    },
  },
  {
    version: 11,
    name: "v11_memory_trigram_dedup",
    // pg_trgm powers the near-duplicate fast-path in saveMemory(): when the exact
    // (guild, subject, kind, content) key misses, a similarity() lookup scoped to
    // the same subject+kind decides whether to reinforce an existing row instead.
    up: async (sql) => {
      await sql`CREATE EXTENSION IF NOT EXISTS pg_trgm`;
      await sql`CREATE INDEX IF NOT EXISTS memories_content_trgm ON memories USING gin (content gin_trgm_ops)`;
    },
    down: async (sql) => {
      await sql`DROP INDEX IF EXISTS memories_content_trgm`;
      // pg_trgm is left installed — other objects outside this schema may rely on it.
    },
  },
  {
    version: 12,
    name: "v12_profile_attributes",
    // Structured profile facets become the source of truth; profiles.summary /
    // facets_json become renderings gated on attr_hash. memory_ids carries
    // provenance so /forget / supersede / merge cascade immediately. Status is
    // derived from cited memories except 'superseded', which is asserted via
    // superseded_by (a row can be superseded while its evidence is still live).
    // No backfill: derivation runs lazily inside buildProfiles.
    up: async (sql) => {
      await sql`
        CREATE TABLE IF NOT EXISTS profile_attributes (
          id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          guild_id       TEXT NOT NULL,
          subject_id     TEXT NOT NULL,
          field          TEXT NOT NULL,
          value          TEXT NOT NULL,
          value_norm     TEXT NOT NULL,
          confidence     DOUBLE PRECISION NOT NULL,
          memory_ids     BIGINT[] NOT NULL DEFAULT '{}',
          status         TEXT NOT NULL,
          superseded_by  BIGINT,
          first_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          last_seen_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (guild_id, subject_id, field, value_norm)
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS profile_attributes_lookup ON profile_attributes(guild_id, subject_id, status)`;
      await sql`CREATE INDEX IF NOT EXISTS profile_attributes_value_trgm ON profile_attributes USING gin (value_norm gin_trgm_ops)`;
      await addColumn(sql, "profiles", "attr_hash TEXT NOT NULL DEFAULT ''");
    },
    down: async (sql) => {
      await sql`DROP INDEX IF EXISTS profile_attributes_lookup`;
      await sql`DROP INDEX IF EXISTS profile_attributes_value_trgm`;
      await sql`DROP TABLE IF EXISTS profile_attributes`;
      await sql`ALTER TABLE profiles DROP COLUMN IF EXISTS attr_hash`;
    },
  },
];

/** Highest known migration version — tests assert against this instead of a
 * hardcoded number so adding a migration doesn't silently stale them. */
export const LATEST_MIGRATION_VERSION = Math.max(...migrations.map(m => m.version));

export async function runMigrations(sql: Sql, targetVersion?: number): Promise<void> {
  // Ensure the base tables exist on a fresh database.
  await sql`
    CREATE TABLE IF NOT EXISTS messages (
      id         TEXT PRIMARY KEY,
      guild_id   TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      author_id  TEXT NOT NULL,
      author_name TEXT NOT NULL,
      content    TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS memories (
      id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      guild_id            TEXT NOT NULL,
      subject_id          TEXT NOT NULL,
      kind                TEXT NOT NULL,
      content             TEXT NOT NULL,
      confidence          DOUBLE PRECISION NOT NULL,
      importance          DOUBLE PRECISION NOT NULL,
      mentions            INTEGER NOT NULL DEFAULT 1,
      confirmation_count  INTEGER NOT NULL DEFAULT 0,
      contradiction_count INTEGER NOT NULL DEFAULT 0,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_confirmed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_contradicted_at TIMESTAMPTZ,
      status              TEXT NOT NULL DEFAULT 'candidate',
      superseded_by       BIGINT,
      supersedes_memory_id BIGINT,
      explicitness        DOUBLE PRECISION NOT NULL DEFAULT 0.5,
      reason              TEXT NOT NULL DEFAULT '',
      UNIQUE(guild_id, subject_id, kind, content)
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS memories_lookup ON memories(guild_id, subject_id, status, importance DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS messages_context ON messages(guild_id, channel_id, created_at DESC)`;
  await sql`
    CREATE TABLE IF NOT EXISTS memory_evidence (
      id                      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      memory_id               BIGINT NOT NULL REFERENCES memories(id),
      message_id              TEXT NOT NULL,
      author_id               TEXT NOT NULL,
      quote                   TEXT NOT NULL,
      reason                  TEXT NOT NULL,
      explicitness            DOUBLE PRECISION NOT NULL,
      observed_at             TIMESTAMPTZ NOT NULL,
      evidence_type           TEXT NOT NULL DEFAULT 'uncertain_inference',
      effect                  TEXT NOT NULL DEFAULT 'context',
      message_content_snapshot TEXT NOT NULL DEFAULT '',
      message_timestamp       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(memory_id, message_id)
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS evidence_memory ON memory_evidence(memory_id, observed_at DESC)`;
  await sql`
    CREATE TABLE IF NOT EXISTS server_settings (
      guild_id          TEXT PRIMARY KEY,
      memory_enabled    SMALLINT NOT NULL DEFAULT 1,
      reply_enabled     SMALLINT NOT NULL DEFAULT 1,
      raw_retention_days INTEGER NOT NULL DEFAULT 30
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  const row = await sql<[{ version: number | null }]>`SELECT MAX(version) as version FROM schema_migrations`;
  const current = row[0].version ?? 0;
  const target = targetVersion ?? Math.max(...migrations.map(m => m.version));

  if (current === target) return;

  if (target > current) {
    for (const migration of migrations) {
      if (migration.version > current && migration.version <= target) {
        console.log(`Applying migration ${migration.version}: ${migration.name}`);
        await sql.begin(async sql => {
          await migration.up(sql as unknown as Sql);
          await sql`INSERT INTO schema_migrations (version) VALUES (${migration.version}) ON CONFLICT DO NOTHING`;
        });
      }
    }
  } else {
    for (const migration of [...migrations].reverse()) {
      if (migration.version <= current && migration.version > target) {
        console.log(`Rolling back migration ${migration.version}: ${migration.name}`);
        await sql.begin(async sql => {
          await migration.down(sql as unknown as Sql);
          await sql`DELETE FROM schema_migrations WHERE version = ${migration.version}`;
        });
      }
    }
  }
}

export async function getMigrationVersion(sql: Sql): Promise<number> {
  const rows = await sql<[{ version: number | null }]>`SELECT MAX(version) as version FROM schema_migrations`;
  return rows[0].version ?? 0;
}
