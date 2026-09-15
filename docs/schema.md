# Database Schema

ASB stores all state in a single SQLite file at `data/asm.sqlite` (WAL mode). Tables are created on first run and evolved by the versioned migration system in `src/migrations.ts`.

---

## Tables

### `messages`

Raw Discord message archive. Purged on a rolling retention window.

| Column | Type | Notes |
|--------|------|-------|
| `id` | TEXT PK | Discord message snowflake ID |
| `guild_id` | TEXT | Discord server ID |
| `channel_id` | TEXT | Discord channel ID |
| `author_id` | TEXT | Discord user ID |
| `author_name` | TEXT | Display name at time of message |
| `content` | TEXT | Full message text |
| `created_at` | TEXT | ISO-8601 timestamp |

**Index:** `messages_context (guild_id, channel_id, created_at DESC)` — used by `recentContext()`.

**Retention:** `deleteRawMessagesOlderThan(guildId, days)` deletes rows older than the configured window. Evidence quotes in `memory_evidence` are kept separately and survive this purge.

---

### `memories`

One row per curated fact, preference, episode, or piece of server lore. The core memory store.

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PK | Auto-increment |
| `guild_id` | TEXT | Server scope |
| `subject_id` | TEXT | Discord user ID the memory is about, or `"server"` for lore |
| `subject_name` | TEXT | Display name at time of creation (v5) |
| `kind` | TEXT | `person_fact` · `person_preference` · `server_lore` · `episode` |
| `content` | TEXT | Human-readable memory statement |
| `confidence` | REAL | 0–1; deterministic (see `confidence.ts`) |
| `importance` | REAL | 0–1; kind-based default |
| `explicitness` | REAL | 0–1; evidence-type-based default |
| `mentions` | INTEGER | Confirmation count (incremented on each supporting evidence insert) |
| `confirmation_count` | INTEGER | Same as `mentions`; retained for query clarity |
| `contradiction_count` | INTEGER | Number of contradicting evidence rows |
| `status` | TEXT | See lifecycle states below |
| `superseded_by` | INTEGER | FK → `memories.id` of the replacement, when superseded |
| `supersedes_memory_id` | INTEGER | FK → `memories.id` of the memory this one replaced |
| `net_score` | REAL | Age-weighted support−contradiction score; only set during `contested` (v2) |
| `frozen_confidence` | REAL | Confidence snapshot taken when memory first entered `contested`; cleared on resolution (v2) |
| `pattern_id` | INTEGER | FK → `behavioral_patterns.id`; set when an episode is consolidated (v2) |
| `primary_evidence_type` | TEXT | Evidence type of the first evidence row; enforces promotion gate in bulk maintenance (v3) |
| `event_id` | INTEGER | FK → `events.id`; set when memory is linked to an event (v4) |
| `reason` | TEXT | LLM-supplied explanation for why this memory was extracted |
| `created_at` | TEXT | ISO-8601 |
| `updated_at` | TEXT | ISO-8601 |
| `last_confirmed_at` | TEXT | ISO-8601; updated on each supporting evidence insert |
| `last_contradicted_at` | TEXT | ISO-8601; updated on contradicting evidence insert |

**Unique constraint:** `(guild_id, subject_id, kind, content)` — exact deduplication prevents duplicate rows for the same fact.

**Index:** `memories_lookup (guild_id, subject_id, status, importance DESC)`.

#### Memory lifecycle statuses

| Status | Meaning |
|--------|---------|
| `candidate` | New memory below confidence or promotion threshold; never used in replies |
| `active` | Confirmed and surfaced in replies |
| `contested` | Contradicting evidence received; confidence frozen; `net_score` drives resolution |
| `quarantined` | Old candidate (>7 days) or old low-confidence active (>90 days, confidence <0.75) |
| `superseded` | Replaced by a correction; linked to replacement via `superseded_by` |
| `forgotten` | Manually forgotten via `/forget`; never used in replies |

---

### `memory_evidence`

One row per `(memory_id, message_id)` pair. Provenance for every memory.

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PK | Auto-increment |
| `memory_id` | INTEGER | FK → `memories.id` |
| `message_id` | TEXT | Discord message snowflake ID (not FK — message may have been purged) |
| `author_id` | TEXT | Discord user ID of the message author |
| `quote` | TEXT | Truncated message content (≤1000 chars) |
| `reason` | TEXT | LLM-supplied reason this message supports the memory |
| `explicitness` | REAL | 0–1; determined by evidence type |
| `observed_at` | TEXT | ISO-8601 observation timestamp |
| `evidence_type` | TEXT | `explicit_fact` · `clear_preference` · `direct_observation` · `reported_by_other` · `sarcasm_or_joke` · `uncertain_inference` · `correction` |
| `effect` | TEXT | `support` · `contradict` · `correct` · `context` |
| `message_content_snapshot` | TEXT | Full message content snapshot (≤1000 chars) |
| `message_timestamp` | TEXT | ISO-8601; used for age-weighted conflict resolution |
| `created_at` | TEXT | ISO-8601 |

**Unique constraint:** `(memory_id, message_id)` — the same Discord message cannot create duplicate evidence rows for the same memory, making replays idempotent.

**Index:** `evidence_memory (memory_id, observed_at DESC)`.

---

### `memory_history`

Append-only audit trail of every lifecycle transition.

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PK | Auto-increment |
| `memory_id` | INTEGER | FK → `memories.id` |
| `action` | TEXT | e.g. `support`, `promote`, `contradict`, `conflict_resolved`, `superseded`, `correction_activated` |
| `previous_confidence` | REAL | Confidence before the action |
| `new_confidence` | REAL | Confidence after the action |
| `previous_status` | TEXT | Status before the action |
| `new_status` | TEXT | Status after the action |
| `evidence_id` | INTEGER | FK → `memory_evidence.id` (nullable) |
| `details_json` | TEXT | JSON blob with additional context |
| `created_at` | TEXT | ISO-8601 |

**Index:** `memory_history_lookup (memory_id, created_at DESC)`.

---

### `server_settings`

One row per guild. Controls pause state and retention.

| Column | Type | Notes |
|--------|------|-------|
| `guild_id` | TEXT PK | Discord server ID |
| `memory_enabled` | INTEGER | 0 = paused; 1 = active |
| `reply_enabled` | INTEGER | 0 = silent; 1 = replies allowed |
| `raw_retention_days` | INTEGER | Rolling window for raw message purge |

Row is created with defaults on first message from a guild. Administrators can override via `/memory-pause`, `/memory-resume`, and the `RAW_MESSAGE_RETENTION_DAYS` env variable.

---

### `behavioral_patterns`

Consolidated episode patterns. One row per recognised recurring behaviour per subject.

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PK | Auto-increment |
| `guild_id` | TEXT | Server scope |
| `subject_id` | TEXT | Discord user ID |
| `description` | TEXT | Human-readable pattern description (currently copied from the highest-confidence episode; LLM synthesis is a planned future improvement) |
| `episode_count` | INTEGER | Number of linked episodes |
| `confidence` | REAL | Average confidence of linked episodes |
| `status` | TEXT | `active` (only value currently used) |
| `created_at` | TEXT | ISO-8601 |
| `updated_at` | TEXT | ISO-8601 |

**Index:** `patterns_lookup (guild_id, subject_id, status)`.

**Promotion rule:** `consolidateEpisodes()` runs during daily maintenance. It requires ≥3 unlinked `active`-status episodes per subject. Candidates and quarantined episodes are excluded.

---

### `events`

One row per detected server incident.

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PK | Auto-increment |
| `guild_id` | TEXT | Server scope |
| `channel_id` | TEXT | Channel where the event occurred |
| `title` | TEXT | LLM-generated title (empty until classified) |
| `summary` | TEXT | LLM-generated summary (empty until classified) |
| `significance` | REAL | 0–1 deterministic score (see `event-significance.ts`) |
| `tier` | TEXT | `candidate` or `event` |
| `occurred_at` | TEXT | Timestamp of the first message in the event |
| `closed_at` | TEXT | ISO-8601 when the event window was closed (null = still open) |
| `reference_count` | INTEGER | Number of times the event was referenced after closing |
| `created_at` | TEXT | ISO-8601 |
| `updated_at` | TEXT | ISO-8601 |

**Indexes:** `events_guild_channel (guild_id, channel_id, occurred_at DESC)`, `events_guild_open (guild_id, tier, closed_at)`.

---

### `event_participants`

Which users were involved in an event.

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PK | Auto-increment |
| `event_id` | INTEGER | FK → `events.id` |
| `user_id` | TEXT | Discord user ID |
| `user_name` | TEXT | Display name |
| `role` | TEXT | `subject` · `antagonist` · `participant` · `observer` |

**Unique constraint:** `(event_id, user_id)`.

---

### `event_messages`

Which Discord messages are part of an event.

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PK | Auto-increment |
| `event_id` | INTEGER | FK → `events.id` |
| `message_id` | TEXT | Discord message snowflake ID |

**Unique constraint:** `(event_id, message_id)`.

---

### `event_memories`

Which memories are linked to an event.

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PK | Auto-increment |
| `event_id` | INTEGER | FK → `events.id` |
| `memory_id` | INTEGER | FK → `memories.id` |
| `link_type` | TEXT | `generated` (created during event) · `referenced` (back-reference) · `retroactive` (promoted after closing) |

**Unique constraint:** `(event_id, memory_id)`.

---

### `schema_migrations`

Version tracking for the migration system.

| Column | Type | Notes |
|--------|------|-------|
| `version` | INTEGER PK | Migration version number |
| `applied_at` | TEXT | ISO-8601 |

---

## Migration history

| Version | Name | What it added |
|---------|------|--------------|
| 1 | `phase_1a_add_evidence_tracking` | `confirmation_count`, `contradiction_count`, `updated_at`, `last_contradicted_at`, `supersedes_memory_id` on `memories`; `evidence_type`, `effect`, `message_content_snapshot`, `message_timestamp`, `created_at` on `memory_evidence`; `memory_history` table |
| 2 | `phase_1c_conflict_and_patterns` | `net_score`, `frozen_confidence`, `pattern_id` on `memories`; `behavioral_patterns` table |
| 3 | `phase_1c_primary_evidence_type` | `primary_evidence_type` on `memories` |
| 4 | `v02_events` | `event_id` on `memories`; `events`, `event_participants`, `event_messages`, `event_memories` tables |
| 5 | `v02_memory_subject_name` | `subject_name` on `memories` |
