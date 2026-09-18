# Database Schema

ASB stores all state in Postgres — Supabase in production, or any Postgres via `DATABASE_URL`. Tables are created on first run and evolved by the versioned migration system in `src/migrations.ts`.

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
| `triage_result` | TEXT \| NULL | Durability/extraction state (v6): `'regex'` passed the regex gate, `'durable'` flagged by LLM triage, `'noise'` rejected, `'extracted'` extraction ran (terminal — never re-selected, even with zero evidence rows). NULL = not yet triaged |
| `reply_to_id` | TEXT \| NULL | Discord ID of the message this one replies to (v7) |

**Index:** `messages_context (guild_id, channel_id, created_at DESC)` — used by `recentContext()`.

**Retention:** `deleteRawMessagesOlderThan(guildId, days)` deletes rows older than the configured window. Evidence quotes in `memory_evidence` are kept separately and survive this purge. Separately, `pruneDerivedData(guildId)` caps the append-only tables at 90 days: `memory_history`, `unresolved_names`, `alias_candidates`, and closed candidate-tier `events` (promoted `event` rows are kept). `memory_evidence` is intentionally not pruned.

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

**Indexes:** `memories_lookup (guild_id, subject_id, status, importance DESC)`; `memories_content_trgm` — GIN trigram index (v11) powering the near-duplicate fallback in `saveMemory()`: when the exact key misses, the best `similarity(content)` row in the same `(guild_id, subject_id, kind)` scope is reinforced instead. Matches and near-misses are audited in `memory_history` as `dedup_matched` / `dedup_near_miss`.

**Semantic dedup:** the trigram path only catches lexically similar rephrasings. A nightly maintenance pass (`applyRetention`, also at end of ingest) hands each member's memory list to `Brain.dedupMemoriesBatch`, which returns `duplicate` groups and `contradicts` pairs. Confirmed duplicate groups merge via `applyDedupGroups`/`mergeDuplicate`: evidence moves to a deterministic canonical row (active > candidate, then confidence, then lowest id) — except rows colliding on `message_id`, which stay on the superseded loser because `memory_history.evidence_id` references them. The losers become `superseded` with `superseded_by` pointing at the canonical — never deleted. Canonical status/confidence are untouched (merging cannot promote). Guards drop groups that mix subjects, kinds, or non-live statuses; `episode` kind and `unknown` subjects are never offered. `contradicts` verdicts only log `dedup_contradiction` history rows — no status change.

#### Memory lifecycle statuses

| Status | Meaning |
|--------|---------|
| `candidate` | New memory below confidence or promotion threshold; never used in replies |
| `active` | Confirmed and surfaced in replies |
| `contested` | Contradicting evidence received; confidence frozen; `net_score` drives resolution |
| `quarantined` | Old candidate (>7 days) or old low-confidence active (>90 days, confidence <0.75) |
| `superseded` | Replaced by a correction **or** merged as a duplicate; linked to the surviving row via `superseded_by` |
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
| `action` | TEXT | e.g. `support`, `promote`, `contradict`, `conflict_resolved`, `superseded`, `correction_activated`, `dedup_matched`, `dedup_near_miss`, `dedup_merged`, `dedup_contradiction` |
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
| `proactive_enabled` | INTEGER | 0 = off (default); 1 = server opted in to proactive answers — requires the global `PROACTIVE=1` env flag too |
| `raw_retention_days` | INTEGER | Rolling window for raw message purge |
| `announced_at` | TIMESTAMPTZ NULL | Set once the join disclosure card posts — the idempotency marker for `announceIfNeeded` |

Row is created with dormant defaults (`memory_enabled=0`, `reply_enabled=0`) on first sight of a guild — an admin enables observation via `/memory-resume`. Administrators can override via `/memory-pause`, `/memory-resume`, `/proactive enabled:<bool>`, and the `RAW_MESSAGE_RETENTION_DAYS` env variable.

---

### `guild_keys`

One row per guild — the server's own LLM key (BYOK), written by `/setup`. Lives in a dedicated table so export/purge paths never casually touch ciphertext.

| Column | Type | Notes |
|--------|------|-------|
| `guild_id` | TEXT PK | Discord server ID |
| `key_enc` | BYTEA | AES-256-GCM ciphertext (`iv ‖ tag ‖ ciphertext`, `src/secrets.ts`) — there is no plaintext key column |
| `key_hint` | TEXT | Last 4 chars of the key, for masked display (`…abcd`) |
| `base_url` | TEXT NULL | Per-guild OpenAI-compatible endpoint; NULL = env default |
| `validated_at` | TIMESTAMPTZ NULL | NULL = stored but never verified live (provider unreachable at /setup) |
| `created_at` / `updated_at` | TIMESTAMPTZ | Upsert timestamps |

Decryption requires `KEY_ENCRYPTION_SECRET`; rotating that secret orphans existing rows (recovery = re-run `/setup`).

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

### `members`

Member registry — one row per (guild, user). Built by `recordMessage()` so both the live bot and ingest populate it.

| Column | Type | Notes |
|--------|------|-------|
| `guild_id` | TEXT | Server scope (composite PK) |
| `user_id` | TEXT | Discord user ID (composite PK) |
| `known_names` | TEXT[] | Every display name observed for this user; backs the entity-resolution alias map |
| `first_seen_at` | TEXT | ISO-8601 |
| `last_seen_at` | TEXT | ISO-8601 |
| `message_count` | INTEGER | Total recorded messages |
| `opted_out` | INTEGER | 1 = hard revoke: `/opt-out` forgets existing memories, hard-deletes relationship observations/edges, deletes the profile, and clears `opted_in` — opt-out always wins |
| `opted_in` | INTEGER | 1 = consent for derived data (person memories, relationship observations, attributes, profiles, dossiers). Effective consent = `opted_in=1 AND opted_out=0`. Set by `/opt-in` and `/profile-build` |

---

### `relationship_observations`

Raw LLM relationship assertions. One row per (subject, other, message) — idempotent evidence for the derived edges in `relationships`. This is the holding state: an assertion stays invisible until verification.

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PK | Auto-increment |
| `guild_id` | TEXT | Server scope |
| `subject_id` | TEXT | Discord user ID the assertion is about |
| `other_id` | TEXT | Discord user ID of the other party |
| `message_id` | TEXT | Source message snowflake |
| `nature` | TEXT | Free-text dynamic: "close friends", "antagonizes", "dating", … |
| `valence` | REAL \| NULL | −1 hostile … 0 neutral … +1 close |
| `reason` | TEXT | LLM-supplied explanation |
| `verdict` | TEXT \| NULL | Sincerity verdict (v8): `'literal'` counts toward edges; `'joke'`/`'unclear'`/NULL never do. NULL = not yet verified |
| `created_at` | TEXT | ISO-8601 |

**Unique constraint:** `(subject_id, other_id, message_id)`. **Index:** `relationship_obs_lookup (guild_id, subject_id, other_id)`.

---

### `relationships`

Durable relationship edges — fully derived. `recomputeEdges()` deletes and rebuilds this table from `literal`-verdicted observations only, so unverified, `unclear`, or `joke` assertions never form or feed an edge. New edges materialize at the next verification pass, not at record time.

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PK | Auto-increment |
| `guild_id` | TEXT | Server scope |
| `subject_id` | TEXT | Discord user ID |
| `other_id` | TEXT | Discord user ID |
| `summary` | TEXT | Latest nature among literal-verdicted observations |
| `valence` | REAL \| NULL | Average valence over literal-verdicted observations |
| `observation_count` | INTEGER | Count of literal-verdicted observations; `/profile` and profile synthesis surface edges at ≥2 |
| `last_observed_at` | TEXT | ISO-8601 |
| `updated_at` | TEXT | ISO-8601 |

**Unique constraint:** `(guild_id, subject_id, other_id)`. **Index:** `relationships_lookup (guild_id, subject_id)`.

---

### `profiles`

Synthesized per-chatter profile cards, rebuilt only when their input fingerprint changes.

| Column | Type | Notes |
|--------|------|-------|
| `guild_id` | TEXT | Server scope (composite PK) |
| `subject_id` | TEXT | Discord user ID (composite PK) |
| `display_name` | TEXT | Best current display name |
| `summary` | TEXT | LLM-written bio |
| `facets_json` | TEXT | JSON rendered deterministically from `profile_attributes` + edges: `traits`, `interests`, `notableRelationships`, `roleInServer`, plus `dossier.sections` — per-section results `{ hash, builtAt, data }` for `voice`, `life_situation`, `temperament`, `beliefs`, `relationship_map`, `reputation`, `timeline`; list items carry `source_ids` memory citations |
| `source_hash` | TEXT | SHA-256 fingerprint of semantic build inputs (memories, candidates, patterns, edges, events — raw activity churn excluded); gates LLM attribute extraction |
| `attr_hash` | TEXT | SHA-256 fingerprint of the render inputs: active attribute rows + bio context (patterns, edges, events, stats); identical hash → prose render skipped |
| `built_at` | TEXT | ISO-8601 of last LLM synthesis |
| `updated_at` | TEXT | ISO-8601 |

---

### `profile_attributes`

Structured person facets — the **source of truth** for profile cards; `summary`/`facets_json` are renderings of these rows. Provenance-backed: every facet cites the memories that justify it, so `/forget`/`supersede`/merge cascade immediately.

| Column | Type | Notes |
|--------|------|-------|
| `id` | BIGINT PK | Identity |
| `guild_id` | TEXT | Server scope |
| `subject_id` | TEXT | Discord user ID |
| `field` | TEXT | One of eight: singular `pronouns`/`timezone`/`location`/`occupation`/`birthday`; multi-valued `trait`/`interest`/`skill` (`SINGULAR_FIELDS` in `src/attributes.ts` is the classifier) |
| `value` | TEXT | Display form |
| `value_norm` | TEXT | `trim().toLowerCase()` — uniqueness/fold key only |
| `confidence` | DOUBLE | `max()` of surviving cited memories' confidence; corroboration is reported via `array_length(memory_ids)` |
| `memory_ids` | BIGINT[] | Provenance — citing memory IDs (set union, no dupes) |
| `status` | TEXT | Derived from cited-memory statuses + `superseded_by`: all-forgotten/empty → `forgotten`; any `contested` → `contested`; any `active` → `active`; all-`superseded` → `superseded` |
| `superseded_by` | BIGINT | The only asserted input to status — set on singular-field replacement and LLM `replaces` |
| `first_seen_at`/`last_seen_at` | TIMESTAMPTZ | |

`UNIQUE (guild_id, subject_id, field, value_norm)` — case/whitespace variants can't produce sibling rows. Indexes: `(guild_id, subject_id, status)` lookup; GIN trigram on `value_norm` for the polarity-gated near-dup fold (≥0.6 folds, 0.4–0.6 logs `attr_near_miss`).

Extraction: deterministic regexes on `person_fact`/`person_preference` content run inside `buildProfiles` (also the lazy backfill); an LLM pass proposes `trait`/`interest`/`skill` gated on `source_hash`. Only `active` rows render anywhere; `contested` surfaces in `/memory-triage`.

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
| 6 | `v02_message_triage_result` | `triage_result` on `messages` — persists LLM triage verdicts so re-ingests never re-triage |
| 7 | `v03_profiles_and_relationships` | `reply_to_id` on `messages`; `members`, `relationship_observations`, `relationships`, `profiles` tables |
| 8 | `v04_relationship_verdicts` | `verdict` on `relationship_observations` — joke assertions excluded from edge roll-up |
| 9 | `v05_alias_learning` | `alias_candidates` table — provenance for learned display-name aliases |
| 10 | `v06_unresolved_names` | `unresolved_names` table — names that failed entity resolution |
| 11 | `v11_memory_trigram_dedup` | `pg_trgm` extension + `memories_content_trgm` GIN index for near-duplicate memory matching |
| 12 | `v12_profile_attributes` | `profile_attributes` table + `profiles.attr_hash` — structured provenance-backed facets become the profile source of truth; create-only, no backfill |
| 13 | `v13_proactive_enabled` | `proactive_enabled` on `server_settings` — per-server opt-in for proactive speaking, default off |
| 14 | `v14_member_opted_in` | `opted_in` on `members` — derived data becomes consent-gated: person memories, relationships, attributes, profiles form only for `opted_in=1 AND opted_out=0` |
| 15 | `v15_guild_keys` | `guild_keys` table — BYOK: per-guild LLM keys encrypted AES-256-GCM, written by `/setup` |
| 16 | `v16_consent_posture` | `server_settings` defaults flip to dormant (`memory_enabled=0`, `reply_enabled=0`); `announced_at` marks the join disclosure |
