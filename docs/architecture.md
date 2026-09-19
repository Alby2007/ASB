# Architecture

ASB (Artificial Server Member) is a single TypeScript/Node process that connects to Discord, observes messages, extracts durable memories using an LLM, detects notable server events, and replies conservatively when directly addressed. All state is stored in Postgres (Supabase in production; any Postgres via `DATABASE_URL`).

---

## Module map

| File | Class / exports | Role |
|------|----------------|------|
| `src/index.ts` | — | Discord client, live message loop, daily maintenance scheduler |
| `src/ingest.ts` | — | CLI wrapper: connects to Discord and calls `runServerIngest` for the configured channel |
| `src/server-ingest.ts` | `runServerIngest` | The server-level historical build (archive → triage → extract → events → verify → profiles) shared by `npm run ingest` and `/server-build` |
| `src/profile-build.ts` | `runProfileBuild`, `PROFILE_BUILD_COOLDOWN_MS` | Self-service opt-in scan (/profile-build): targeted corpus → extraction → verification → scoped profile build |
| `src/persist-extraction.ts` | `persistExtraction` | The single consent-gated write path for extraction results — person memories need an opted-in subject; relationships need one opted-in party |
| `src/brains.ts` | `createBrainResolver` | Per-guild `Brain` resolver (BYOK): guild's encrypted key → env fallback → null (dormant). Cached per guild, invalidated by `/setup` |
| `src/guild-lifecycle.ts` | `announceIfNeeded`, `handleGuildDelete` | Join disclosure card (idempotent via `announced_at`) + kick-purge — GuildDelete never fires on outage (`unavailable`) |
| `src/jobs.ts` | `enqueue`, `claimNext`, `startWorker` | Postgres job queue for deferrable cognition — `SKIP LOCKED` claims with a 10-min visibility lease, per-guild serial + global cap 8, backoff retry, 5-attempt dead-letter, `NOTIFY`/`LISTEN` wake + 3s poll |
| `src/speech-gate.ts` | `evaluateSpeechTurn` | The per-message speak/silence decision extracted from handleMessage — enroll → aim-check → dismissal → share-of-voice → decide(); drives the transcript-replay tests |
| `src/reply-throttle.ts` | `ReplyThrottle` | Per-user reply budget (token bucket) — bounds the drain one user can cause against the guild's daily LLM cap |
| `src/extract-job.ts` | `runExtractJob` | The deferred extract pipeline — alias-learn → describe → extract → consent-gated persist → `extracted` mark → contest → event pipeline (extracted from index.ts so it's unit-testable) |
| `src/pair-analysis-job.ts` | `runPairAnalysisJob` | `pair-analysis` jobs: holistic LLM reads of top interaction pairs' exchange windows → `pair_window` observations (both-party consent) |
| `src/budget.ts` | `meteredClient`, `BudgetExceeded` | Per-guild daily LLM budget — wraps every `responses.create`/`chat.completions.create` with an atomic `guild_usage` charge against `llm_daily_cap` |
| `src/secrets.ts` | `encryptSecret`, `decryptSecret`, `maskKey`, `redactSecrets`, `validateLlmKey` | AES-256-GCM at-rest encryption for guild keys + live key validation against `/models` |
| `src/brain.ts` | `Brain` | All LLM calls: extract memories, correct, assess continuity, classify events, reply |
| `src/config.ts` | `config` | Env-variable validation (zod); single exported config object |
| `src/types.ts` | `MessageEvent`, `MemoryCandidate`, `StoredEvent`, `Decision`, … | Shared TypeScript types shared across modules |
| `src/database.ts` | `MemoryStore` | Postgres persistence: memory CRUD, lifecycle, conflict resolution, episode consolidation |
| `src/events.ts` | `EventStore` | Postgres persistence: event CRUD, participants, message/memory attachments |
| `src/migrations.ts` | `runMigrations`, `getMigrationVersion` | Versioned schema migrations (v1–v17, `LATEST_MIGRATION_VERSION`) with rollback support |
| `src/confidence.ts` | `calculateInitialConfidence`, `updateConfidence`, `calculateDefaultImportance`, `calculateDefaultExplicitness` | Deterministic numeric formulas; no LLM involvement |
| `src/perception.ts` | `shouldInspectForMemory`, `detectNamingRequest`, `detectSelfNaming`, `detectWakeWord`, `detectDismissal`, `contestCue`, `botMemoryCue`, `toolCues` | Cheap pre-filter: prevents LLM calls for ordinary chat; detects naming requests, self-naming, wake words, and dismissal cues |
| `src/event-detection.ts` | `EventPipeline` | Heuristic + LLM continuity decisions; nightly maintenance |
| `src/event-significance.ts` | `calculateSignificance` | Deterministic significance score and tier assignment |
| `src/entity-resolution.ts` | `buildAliasMap`, `resolveSubject`, `findMentionedUsers` | Maps display names to real user IDs; ambiguous names resolve to `unknown` |
| `src/profiles.ts` | `ProfileStore` | Per-chatter profile cards + dossiers: input fingerprinting + LLM synthesis, rebuilt only when inputs change |
| `src/attributes.ts` | `SINGULAR_FIELDS`, `extractDeterministic`, `applyProposals`, `deriveAttributeStatus`, `recomputeForMemories`, `transferProvenance`, `attributeHash` | Structured profile facets: extraction, the upsert-diff (exact → trgm fold → insert), derived status, and lifecycle cascades |
| `src/dossier.ts` | `gatherDossierInputs` | Per-section dossier input gathering and hashing — voice, life_situation, temperament, beliefs, relationship_map, reputation, timeline |
| `src/commands.ts` | `commandDefinitions`, `handleMemoryCommand`, `handleMemoryButton` | Discord slash command schemas and interaction handlers |
| `src/tools.ts` | `replyToolDefs`, `executeTool` | Never-throw tool dispatcher: SSRF-hardened web fetch + internal lookup routing |
| `src/lookup-tools.ts` | `ToolCtx`, `executeLookupTool`, `buildPairContext` | Read-only internal lookup tools (person/relationship/memories/event) over the existing stores |
| `src/reply-format.ts` | `formatReplyProfile`, `formatPairContext` | Pure formatters shared by the reply prompt and tool outputs |
| `src/vision.ts` | `qualifyingImages`, `formatImageContext` | Pure image-attachment gate (image/*, byte cap, ≤3/message) + observation-framed label |
| `src/conversation.ts` | `ConversationTracker` | Per-channel conversation objects: opens on addressed messages, closes when the last participant leaves (TTL expiry, regex dismissal, or the model's `end_conversation`); share-of-voice pacing is channel-level and survives close, and `bystanderVoices` distinguishes a shared floor from a 1:1 ping-pong |

---

## Data flow — live message

```
Discord MessageCreate
        │
        ▼
  index.ts: record raw message in MemoryStore
        │
        ▼
  perception.ts: shouldInspectForMemory()?  (or: has image attachments)
        │ yes                     no ──────────────────────────────┐
        ▼                                                          │
  jobs.ts: enqueue 'extract' job + mark message triage='queued'     │
  (live path keeps only recordMessage/decide/reply — deferrable     │
   cognition runs in the worker, per-guild serial, global cap 8)    │
        │                                                           │
        ▼◄──────────────────────────────────────────────────────────┘
  brain.ts: decide()
  • baseline 0.05 + direct mention +0.85, else engaged +0.70 + question +0.10
  • "direct mention" = @-mention, reply-to-bot, or wake word — the bot's
    username, display name, server nick, or "asb" said in text (perception.ts
    detectWakeWord, word-boundary matched; WAKE_WORD=0 disables)
  • "engaged" = the author is a participant in the channel's open
    conversation — enrolled by addressing the bot within ENGAGEMENT_TTL_MS
    (default 120s); TTL refreshes on addressed messages only, NOT on bot
    replies, so drifting side-chatter decays out and the bot drops
    mid-channel-talk (ENGAGEMENT=0 disables). Participants exit three ways:
    TTL expiry, regex dismissal (the deterministic override — "shut up asb"
    works even if the model wants to keep chatting), or the reply model's
    end_conversation flag (REPLY_EXIT=0 disables honoring it)
  • engaged ≠ every message is at the bot: room-directed cues ("did anyone",
    "you guys" — perception.ts roomAddressCue), replying to another human, or
    @-mentioning someone else suppress the bonus for that message only
  • dismissals ("shut up asb", "shush", "let's end this") fire addressed OR
    while engaged — unaddressed dismissal = silent drop-out, addressed = ack
    reply then out (perception.ts detectDismissal)
  • pacing is per-tier: strangers get proportional recency decay
    −0.25×(1−elapsed/120s), evaluated only inside the window so it can't
    invert; engaged participants instead get share-of-voice — −0.25 when the
    bot is ≥~1/3 of the last 10 channel messages AND a non-participant voice
    is in that window (members don't count seconds since they last spoke,
    they don't dominate the floor — a time window made the bot go silent
    exactly mid-flow). The bystander gate keeps a 1:1 ping-pong safe: bot
    share is structurally ~50% there, but with nobody outside the convo
    speaking there is no floor to dominate; direct mentions exempt from both
  • shouldSpeak = score ≥ SPEAK_THRESHOLD (default 0.70)
        │
        ▼ (only if shouldSpeak && replyEnabled && per-user budget has tokens)
  reply-throttle.ts: token bucket per guild:user — a burst is free
  (REPLY_BURST=4), then ~1 per REPLY_REFILL_MS (30s); bounds the drain one
  person spamming mentions/follow-ups can cause against the guild's daily LLM
  cap. Suppression is silent — a notice would spend the budget it protects.
        ▼
  brain.ts: reply()
  • recent channel context (<@id> tokens demangled to @names) + relevant
    memories: active plus candidates with promotable primary evidence types
  • per-person structured attributes (active only) with confidence buckets —
    high/medium/low annotations let the model hedge weak facets instead of
    stating every trait as fact; legacy flat traits are the fallback
  • pairwise relationship context for every unordered pair among the
    in-prompt people (≤6, author-involved first): directed edges both ways,
    recent literal observation reasons, active memories each authored about
    the other, shared events — zero-signal pairs are dropped
  • author addressed by freshest known name (learned aliases apply instantly)
  • reply output scrubbed: known <@id> → plain @Name, unknown ids stripped
  • returns { text, end_conversation } via strict json_schema (plain +
    compound paths, and the tool loop's final forced call); a tool-loop round
    that answers early degrades to endConversation=false since tools and
    response_format can't combine — safe, wrap-ups rarely carry toolCues.
    index.ts sends text, then honors the flag with convo.leave (REPLY_EXIT=0
    disables; regex dismissal overrides regardless)
  • structured output that fails to parse runs a salvage ladder — strip think
    blocks and re-parse → quoted "text" field → post-</think> tail → empty
    (silence over leak, counted as reply.parse_failed). Independently,
    looksLikeSchemaLeak() is the hard send-boundary guard: any reply still
    containing end_conversation, think tags, or a "text" field is dropped
    (reply.schema_leak) — model internals never reach the channel
  • temperature 0.9, max 1800 chars
  • REPLY_MODEL overrides the reply model on every path (default GROQ_MODEL);
    gpt-oss/qwen models get reasoning_effort=low to keep casual chat fast
  • REPLY_MODEL=groq/compound* switches to Groq's agentic system: server-side
    web_search + visit_website tools, executed_tools logged, falls back to
    GROQ_MODEL on failure
  • REPLY_TOOLS=1 attaches local tools (tools.ts — free, in-process, no
    per-call billing) on a direct mention or a toolCues() match; model-driven
    tool_calls loop, ≤3 rounds, falls back to the plain path. Six tools:
    web_search + visit_url (SSRF-hardened fetch) and four read-only internal
    lookups — lookup_person, lookup_relationship, search_memories,
    lookup_event (lookup-tools.ts) — so the model can fetch members, pair
    dynamics, memories, and events beyond the pre-fetched window. Privacy
    boundaries inherit from the wrapped store methods (opt-out, contested,
    literal-only); outputs render via the same reply-format.ts functions as
    the prompt sections
        │
        ▼
  Discord: message.reply()
```

## Deferred extraction — the job queue (v17)

Every durable message used to run 3+ sequential LLM calls inside `handleMessage`, so a busy guild stacked unbounded concurrent extractions. Now the live path enqueues one `extract` job per durable message and returns; the worker drains `jobs` (Postgres, `FOR UPDATE SKIP LOCKED`).

- **Fairness:** `extract` jobs are per-guild serial (`maxPerGuild = 1`) — pipeline/event ordering is preserved — inside a global in-flight cap of 8.
- **Claims lease** the row (`attempts+1`, `run_after = now()+10min`) so a row is never double-claimed; completion deletes it, failure reschedules with exponential backoff, and a crashed worker's job becomes claimable again when the lease expires. `attempts ≥ 5` dead-letters (row kept for inspection, never claimed); the final failure fires `jobs.dead_letter`. `FatalJobError` dead-letters immediately for permanent failure (unknown `type`, malformed payload) instead of burning retries. Re-drive dead letters with `scripts/requeue-dead-jobs.mjs` (`GUILD_ID` optional).
- **Wake:** `pg_notify('jobs', …)` on enqueue + `LISTEN` in the worker; a 3s poll is the resilient baseline so a missed notification costs one poll.
- **Sweep integration:** the 15-min missed-signal sweep keeps its `triageBatch` role but enqueues durable verdicts into the same queue (marking `queued`) rather than extracting inline — one extraction path, one set of semantics. Each pass first runs `repairQueuedMarks`, which reconciles marks against job rows: extraction-marked messages with a live job canonicalize to `queued` (deduping the enqueue-succeeded/mark-write-failed window), `queued` whose only job is dead-lettered goes `dead` (terminal for the sweep, still reachable by `/profile-build`, overwritten by `extracted` on a successful requeue), and `queued` with no job at all resets to `durable`. `listUninspectedMessages` reads `durable`/`regex` marks at any age — the 2h window only bounds *untriaged* messages — so an orphaned mark always re-enqueues.
- **Ingest serialization:** `/server-build` pauses new claims for its guild (`pauseGuildClaims`) and waits out in-flight work (`waitForGuildIdle`, bounded 2 min) before `runServerIngest` starts — ingest calls `pipeline.process` outside the queue, so this keeps event ordering serial per guild. Resumes in `finally`.
- **Worker handler** (`extract-job.ts`, deps injected for testability): alias-learn → per-image `describeImage` → `extractMemories` → consent-gated `persistExtraction` → terminal `extracted` triage mark → `runContestCheck` → `pipeline.process`. A guild that went dormant between enqueue and claim drops the job (`jobs.dropped_dormant`).

### Per-guild LLM budget

`brains.ts` wraps every constructed `OpenAI` client in `meteredClient` (`budget.ts`) — the Phase-1 `LlmClient` seam, so BYOK, env-fallback, and guarded-fetch paths all meter identically. Each `responses.create`/`chat.completions.create` first runs `chargeLlmCall` — an atomic `INSERT … ON CONFLICT` on `guild_usage (guild_id, day)` gated by `llm_calls < llm_daily_cap`. At/over cap → `BudgetExceeded`: the worker reschedules the job to next UTC midnight **without** burning an attempt; the reply path posts a one-per-channel-per-day notice instead of going silent. `cap = 0` blocks every call; `/limits` sets the cap; `/status` shows today's usage.

### Ignored channels

`server_settings.ignored_channels` (`/ignore-channel`, `/unignore-channel`, listed in `/memory-settings`) makes a channel fully invisible: `handleMessage` returns before `recordMessage`/`brainFor`/member writes, the sweep filters archived rows from ignored channels, and `runServerIngest` early-returns — so `/server-build` never scans one either.

### Cross-guild isolation

`isolation.test.ts` is the dedicated proof: every store read path and every command surface is invoked as guild A against a seeded guild B and must return A's rows only (or a refusal) — including `jobs`/`guild_usage`/`guild_keys` and `purgeGuild` scoping.

## Proactive speaking (v1: stranded questions)

Exactly one unprompted trigger, self-limiting by construction: **an unanswered
question the bot has a grounded answer to, after a real silence.** Everything
else (banter, corrections, volunteering personal facts) is out of scope.

```
message ends in "?" && bot chose silence (!shouldSpeak)
        │
        ▼
  proactive.ts: arm(key, messageId) — enqueues a 'proactive-fire' job whose
  run_after IS the debounce timer (PROACTIVE_DELAY_MS, ~75s): armed questions
  survive restarts and past-due rows claim immediately on boot
  • any human follow-up message cancels the pending entry (room isn't silent)
  • a reaction ON the question cancels (room engaged with it)
  • deleting the question cancels; a newer arm replaces the old
  • the job row can't be cancelled — it fires later and release() no-ops on
    it; the in-memory pending map is the "still armed" truth, the row the clock
        │ run_after reaches now
        ▼
  worker claim → release(key, messageId) → fireProactive() re-verifies at send time
  • PROACTIVE=1 global AND server_settings.proactive_enabled — double opt-in,
    either switch alone kills it (v13 migration, default off)
  • re-fetch the question: deleted → gone, edited → re-check "?"
  • daily cap (PROACTIVE_DAILY_CAP, default 3/channel, in-memory)
  • backoff floor: an ignored prior attempt (no reply-edge or reaction within
    PROACTIVE_RESPONSE_WINDOW_MS) raises the LLM gate's confidence floor until
    PROACTIVE_BACKOFF_MS cools down or engagement resets the streak
        │
        ▼
  Cheap gate: questionKeywords() → searchMemories(kinds=['server_lore'])
  + searchEvents() — person_fact/person_preference excluded AT THE QUERY
  LAYER: opting out of storage never consented to unprompted public
  surfacing. Zero hits → zero LLM calls (the feature's cost bound)
        │
        ▼
  brain.proposeGroundedAnswer(): one classifier call — does the context
  actually answer, is volunteering appropriate, produce a one-liner +
  confidence; null under the caller's floor
        │
        ▼
  question.reply() (no pings) → archived like any reply → noteReply()
  (share-of-voice accounting stays honest) → noteSent() tracks the outcome
```

Reactions are **observable signals only** — the bot never places them
(GatewayIntentBits.GuildMessageReactions + partials; MessageReactionAdd
resolves partials before interpreting). A reply-edge or reaction on a
proactive message marks it engaged — it never feeds the ignored streak.

---

## Consent model

Derived data about a person — `person_*` memories, relationship observations, attributes, profiles, dossiers — is **opt-in**. Effective consent is `members.opted_in=1 AND members.opted_out=0`; `/opt-out` clears `opted_in` and always wins. Server lore (`subject_id='server'`), events, the member registry (names/counts — infrastructure, not profile data), and the raw message archive (retention-bounded) are consent-exempt.

- **Write path** — `persist-extraction.ts` is the single gate, shared by the live path, the nightly sweep, `runServerIngest`, and `runProfileBuild`. Person memories persist only for consenting subjects (`unknown`/`server` exempt — unknowns are inert until resolved). Relationship observations use **subject-consent**: they persist when at least one real party opted in — the gate protects the people the claim is *about*; the assertor is stored (`author_id`) so their own opt-out erases claims they authored.
- **Read path** — `relevantMemories`, `searchMemories`, `pairwiseContext`, `getProfile(s)`, `buildProfiles`, `lookup_person`, and subject-scoped `search_memories` all filter or refuse non-consenting subjects, so a straggler row from before the purge stays invisible everywhere.
- **Self-service** — `/profile-build` (24h cooldown) opts the caller in, scans their archive corpus (`messagesAboutSubject`: authored + name-references + replies-to-them), verifies their candidates, recomputes edges, and runs a scoped `buildProfiles`. `/opt-in` consents without the scan.
- **Purge** — `scripts/purge-nonopted.mjs` (`PURGE_CONFIRM=1`) hard-deletes the pre-consent derived corpus for all non-consenting subjects; `buildProfiles` also deletes straggler profiles on sight.
- **The bot opts itself in** (per guild, at maintenance) so the room's claims about it remain memorable — the reply persona frames them as community claims, not self-truth.

## Per-guild LLM keys (BYOK)

Every LLM call resolves through `createBrainResolver` (`src/brains.ts`), not a shared singleton. Resolution order: the guild's `guild_keys` row (AES-256-GCM decrypted via `KEY_ENCRYPTION_SECRET`) → the operator's env key → `null`. A `null` brain means **dormant**: `handleMessage` returns before archiving, maintenance and sweep loops `continue`, commands reply with a `/setup` pointer. `REQUIRE_GUILD_KEYS=1` removes the env fallback for hosted mode — each guild's key pays for its own cognition. The resolver caches one `Brain` per guild; `/setup` (a modal, so keys never touch channel history) is the only writer and invalidates the cache on write. Undecryptable rows (rotated master secret, tampering) degrade to dormant + a metric, never a crash — recovery is re-running `/setup`.

## Guild lifecycle — consent posture

New guilds start **dormant**: `server_settings` defaults are `memory_enabled=0, reply_enabled=0` (v16), so `handleMessage` returns before archiving and nothing is recorded. On every `GuildCreate` — which discord.js also fires for cached guilds on connect — `announceIfNeeded` (`guild-lifecycle.ts`) posts a disclosure card to the system channel (what's stored, retention, member controls, admin activation path) and stamps `server_settings.announced_at` **only after a successful send**, making the card idempotent and retryable. An admin activates with `/memory-resume` (optionally `/setup` first for a guild key); `/privacy` shows any member the guild's storage state and their own consent.

On `GuildDelete`, `handleGuildDelete` runs `store.purgeGuild` — every guild-scoped row in one FK-ordered transaction. `guild.unavailable` (a Discord outage, not a kick) is explicitly never a purge trigger; a kick during an active `/server-build` is absorbed by the build's error path.

---

## Data flow — bulk ingest (`npm run ingest` / `/server-build`)

`runServerIngest` (in `server-ingest.ts`) is the server-level historical build, invoked from the `ingest.ts` CLI wrapper or the owner/admin `/server-build` command. It fetches the full channel history, sorts messages chronologically (Discord API returns newest-first), and feeds each message through the same consent-gated extraction → `EventPipeline.process` path as the live bot — archiving and lore/events for everyone, derived person data only for opted-in members. It rate-limits LLM calls to stay under Groq's token limit and skips messages that already have evidence rows (safe to re-run). After processing it calls `EventPipeline.maintainEvents()` to close open windows and score candidates, then `ProfileStore.buildProfiles()` to rebuild profile cards for the opted-in set.

`/profile-build` runs the complementary **per-user** build (`profile-build.ts`): a targeted archive scan for one consenting member.

---

## Profiles

`ProfileStore.buildProfiles()` runs during daily maintenance, at the end of ingest, and scoped to one member via `/profile-build`. Eligibility requires consent (`opted_in=1 AND opted_out=0`) — non-consenting members are skipped and any straggler profile is deleted on sight. Profiles have three tiers, built in order:

1. **Attributes (source of truth)** — `src/attributes.ts` owns the structured facet set (`profile_attributes` table: eight fields — singular `pronouns`/`timezone`/`location`/`occupation`/`birthday`, multi-valued `trait`/`interest`/`skill`). Deterministic regexes over `person_fact`/`person_preference` memory content run every pass (pure, idempotent — doubles as the lazy backfill for memories that predate the feature). `Brain.extractAttributes()` then proposes fuzzy facets (`trait`/`interest`/`skill`) gated on `source_hash`, a fingerprint of *semantic* inputs only — memories, candidates, patterns, edges, events — so raw activity churn costs zero LLM. Proposals must cite input memory ids with at least one confirmed citation (uncited and candidate-only proposals are dropped); the current attribute vocabulary is passed in so the model reuses labels verbatim or emits an explicit `replaces`. `applyProposals()` upsert-diffs each proposal: exact match on `(field, value_norm)` revives or no-ops → polarity-gated trigram fold at ≥0.6 (0.4–0.6 logs `attr_near_miss`) → insert. Singular fields supersede sibling live rows via `superseded_by`; status is otherwise derived from cited-memory statuses. Memory lifecycle mutations cascade immediately — `forget` strips citations, `supersede`/`mergeDuplicate` transfer them — so a forgotten fact never lingers as a rendered facet.
2. **Card (prose)** — `Brain.synthesizeProfile()` renders `bio` + `role_in_server` from the *post-diff* active attribute set plus stats/patterns/edges/events, gated on `attr_hash` (attribute rows + that same context). Unchanged render inputs → no re-render; facets assemble deterministically (`traits`/`interests` from active rows, `notableRelationships` from verified edges).
3. **Dossier** — unchanged: independently-hashed narrative sections (below).

Only `active` attributes render; `contested` surfaces in `/memory-triage`. `/profile` shows each facet's memory citations, `/memory-export` includes the attribute rows, and members without consent (`opted_in=0` or `opted_out=1`) have their profile *and* attribute rows deleted on the next pass. Profiles surface via `/profile` (self or admin) and are injected into `brain.reply()` for the author, @-mentioned users, and members referenced by name — where each person carries their active attributes with confidence buckets (`formatReplyProfile`), so weak facets render hedged rather than as flat assertions.

Members with ≥3 active memories or ≥50 messages additionally get a **dossier** — a set of independently-built sections stored under `facets_json.dossier.sections`, each rebuilt only when its own input hash changes:

- `voice` — writing style analyzed from a 60-message raw sample plus deterministic stats (avg length, caps/emoji/question rates)
- `life_situation`, `beliefs` — sourced item lists citing memory IDs (`source_ids`)
- `temperament`, `reputation` — prose + sourced items; reputation uses only third-party claims (evidence author ≠ subject)
- `relationship_map` — per-person dynamics from merged edges (A→B + B→A collapsed at read time), bidirectional observation reasons, and the deterministic interaction graph (mention + name-ref frequency from `interactionPairs`)
- `timeline` — deterministic event list, no LLM

Degenerate LLM output (repeated glyphs, JSON blobs) is detected per section and never overwrites existing data. Dossiers surface via `/dossier` (self or admin); `reply()` only ever injects the card.

Candidate memories pass a **sincerity verification** gate before they can activate: `Brain.verifyMemoriesBatch` re-judges each promotable candidate against its stored source message, the author's known names, and the preceding chat lines (literal / joke / unclear / misattributed). Verified literal self-reports promote to `active`; jokes are re-classified `sarcasm_or_joke` (confidence → 0.10, never promotable); `misattributed` verdicts — pasted/quoted text describing someone other than the poster — are forgotten outright; third-party literals stay candidate pending corroboration. Verification runs in `applyRetention()` and at the end of ingest before profile builds.

Relationship assertions pass the analogous gate: `Brain.verifyRelationshipsBatch` labels each observation `literal` / `joke` / `misattributed` / `unclear` against its source message and preceding lines, and `recomputeEdges()` rebuilds the derived `relationships` table from `literal` verdicts alone — an unverified, pasted, or ironic claim ("we're basically married") never surfaces in `/profile`, dossier inputs, or the reply prompt. New edges therefore materialize at the next maintenance pass rather than at record time. Each observation also stores its `author_id` (the assertor — v19, backfilled from the source message), which lets `/opt-out` erase a member's authored claims about others and lets the derived-data prune drop rows that can never surface: `NULL`-verdict observations whose source message is gone, and non-literal verdicts aged past 90 days.

**Edge aggregation (v20)** — `recomputeEdges(guildId, interactions)` is the sole writer. Edge `summary` is the *modal* nature over the five most recent literals (`MODE() WITHIN GROUP`) so a contradictory flip doesn't rewrite history on one observation. `valence` is a *weighted* average over the same window — observations authored by an edge party count double a third party's, so a pair's own words outweigh gossip. `observation_count` stays all-time; `party_count` tracks self-report depth (zero → "all secondhand" at render). `trend` marks `warming`/`cooling` when the recent-5 weighted average diverges ±0.2 from the all-time average (requires ≥3 observations). The deterministic interaction graph stamps `behavioral_count` onto claimed edges — and pairs with ≥5 contacts in 90d but zero claims materialize as **inferred edges** (`inferred=1`, no summary/valence): rows that render strictly as contact frequency, never a relationship claim. Extraction reuses the guild's established nature labels (`relationshipNatureVocab`) so "close friends" doesn't fragment into synonym churn.

**Pair-analysis jobs** (`pair-analysis-job.ts`, job type `pair-analysis`) close the gap extraction can't see: relationships nobody verbalizes. Maintenance enqueues the top interaction pairs (≥10 contacts in 90d, **both** parties consented — stricter than the either-party write rule because the job reads both people's exchanges — ≥7d since last analysis, and only when new interaction happened since). The handler fetches the pair's exchange window (`pairExchanges`, ≤40 messages where one addressed the other) and `Brain.analyzePairWindow` judges the dynamic from the pattern, not single messages. Confident reads land as symmetric `source='pair_window'` observations with `verdict='literal'` — the window read IS the verification, so no second pass is needed — while unconfident runs write `unclear` markers whose timestamps throttle retries. `author_id` stays NULL: the system is the assertor, and party-side opt-out deletes them like any observation. BudgetExceeded parks to the UTC-day reset like extract.

On the reply path, `MemoryStore.pairwiseContext()` and `EventStore.sharedEvents()` assemble the *current-message* pairs — both directed edges, recent attributed observation reasons, per-pair claims (active memories about one side authored by the other), and events both attended — injected as a `Relationships:` prompt section separate from the flat `People:` profiles, so the model can reference shared history rather than reciting isolated facts. Direction is preserved (`subject_id` is the asserting side) and claims render attributed ("Bob claimed about Alice"), never as facts. `formatPairContext` renders depth honestly — observation counts become confidence tiers ("claimed once" / "well-established"), gossip-only edges carry "all secondhand", stale edges say "not recently observed", and inferred edges render only as contact frequency. The author's pair with the bot itself is included when the author consented (the bot's auto-opt-in can't guard its own edge) — the reply model sees its own dynamic with each member.

Dedup runs at two tiers. The **hot path** uses the pg_trgm fallback in `saveMemory()` — a `similarity(content)` lookup scoped to `(guild, subject, kind)` reinforces one row instead of splitting rephrased extractions (with a polarity check so contradictions can't ride the merge). The **maintenance tier** is semantic: `Brain.dedupMemoriesBatch` scans each member's memory list nightly and proposes `duplicate`/`contradicts` groups — catching pairs with no lexical overlap that trigrams can't see ("allergic to peanuts" / "can't eat nuts"). `applyDedupGroups` merges confirmed groups deterministically: the canonical row keeps its status (merging never promotes), non-colliding evidence moves over (rows sharing a `message_id` stay on the loser — `memory_history` references them via FK), losers become `superseded` with an audit link. `contradicts` verdicts are logged to history only — truth arbitration stays with the contest/supersede machinery.

**Paste/quote attribution.** Extraction instructs the model not to attribute quoted, pasted, or persona text to the poster ("I am \<other person\>", reposted bios, copied bot output) — it should attribute to the named person via `subjectName` or skip it. A deterministic guard (`detectSelfNaming`) flags "I am \<Capitalized Name\>" patterns where the name isn't one of the author's `known_names` and annotates the extraction input.

**Contest detection.** Messages that address the bot and carry denial/correction cues (`contestCue`) are checked by `Brain.detectContest` against the author's stored memories. `contests` relations attach `contradict` evidence (status → `contested`, confidence frozen, `resolveContested` arbitrates via `net_score`); `confirms` attach `support` evidence that can resolve a contested memory back to `active`. Runs live in `MessageCreate` and as a sweep at the end of ingest.

---

## Memory lifecycle states

```
              extractMemories()
                    │
                    ▼
              [ candidate ]
              /            \
  enough confirmations      stays uncertain
  + promotable evidence       │
  type + confidence ≥ 0.70   │
              │             7 days old → [ quarantined ]
              ▼
           [ active ]
          /         \
  contradiction    /correct
  arrives         command
     │               │
     ▼               ▼
 [ contested ]   [ superseded ]
     │
  resolves (net_score ≥ 0.50
  && confidence ≥ 0.70 &&
  newest evidence = support)
     │
     ▼
  [ active ]  ←─── (or stays contested)

  Any status → [ forgotten ]  (/forget command)
  Active, low confidence, 90 days old → [ quarantined ]
```

**Confidence is frozen** while a memory is `contested`. Only `net_score` changes during that period, keeping the two signals independent.

### Promotable evidence types

Only `explicit_fact`, `clear_preference`, and `correction` can promote a candidate to `active`. `sarcasm_or_joke`, `reported_by_other`, and `uncertain_inference` are permanently barred from promotion regardless of evidence volume or confidence.

---

## Event tiers

```
  EventPipeline.process()
        │
        ▼
  [ candidate ]  ── open window collects messages & memories ──►
        │
   daily maintainEvents()
        │
        ├── significance ≥ 0.60 → [ event ]   (surfaced to users via /event)
        └── significance < 0.35 → discarded   (kept in DB, never surfaced)
             (0.35–0.60 stays candidate, re-scored on next run)
```

Back-references to a closed candidate can retroactively promote it to `event` tier if its `reference_count` reaches 2.

---

## Key design principles

1. **LLM provides language interpretation only.** `brain.ts` extracts `subjectId`, `kind`, `content`, `reason`, `evidenceType`, and `effect`. All numeric values (confidence, importance, explicitness, significance) are calculated deterministically by `confidence.ts` and `event-significance.ts`.

2. **Evidence is deduplicated by `(memory_id, message_id)`.** Replaying the same message cannot inflate confidence. Cross-author repetition creates separate evidence rows and legitimately builds confidence.

3. **Transactions everywhere.** `saveMemory()` and `createEvent()` both use Postgres transactions so partial state is impossible.

4. **Conservative speaking.** The bot observes silently and replies only to direct mentions by default (`SPEAK_THRESHOLD=0.70`). The recency penalty never suppresses a direct mention.

---

## Further reading

- [`docs/schema.md`](schema.md) — all tables, columns, and indexes
- [`docs/event-pipeline.md`](event-pipeline.md) — event detection in detail
- [`docs/configuration.md`](configuration.md) — all environment variables
- [`docs/development.md`](development.md) — scripts, tests, and contributor guide
