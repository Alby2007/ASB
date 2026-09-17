# Architecture

ASB (Artificial Server Member) is a single TypeScript/Node process that connects to Discord, observes messages, extracts durable memories using an LLM, detects notable server events, and replies conservatively when directly addressed. All state is stored in Postgres (Supabase in production; any Postgres via `DATABASE_URL`).

---

## Module map

| File | Class / exports | Role |
|------|----------------|------|
| `src/index.ts` | — | Discord client, live message loop, daily maintenance scheduler |
| `src/ingest.ts` | — | Standalone script: bulk-ingest historical channel messages |
| `src/brain.ts` | `Brain` | All LLM calls: extract memories, correct, assess continuity, classify events, reply |
| `src/config.ts` | `config` | Env-variable validation (zod); single exported config object |
| `src/types.ts` | `MessageEvent`, `MemoryCandidate`, `StoredEvent`, `Decision`, … | Shared TypeScript types shared across modules |
| `src/database.ts` | `MemoryStore` | Postgres persistence: memory CRUD, lifecycle, conflict resolution, episode consolidation |
| `src/events.ts` | `EventStore` | Postgres persistence: event CRUD, participants, message/memory attachments |
| `src/migrations.ts` | `runMigrations`, `getMigrationVersion` | Versioned schema migrations (v1–v5) with rollback support |
| `src/confidence.ts` | `calculateInitialConfidence`, `updateConfidence`, `calculateDefaultImportance`, `calculateDefaultExplicitness` | Deterministic numeric formulas; no LLM involvement |
| `src/perception.ts` | `shouldInspectForMemory`, `detectNamingRequest`, `detectSelfNaming` | Cheap pre-filter: prevents LLM calls for ordinary chat; detects explicit naming requests and self-naming |
| `src/event-detection.ts` | `EventPipeline` | Heuristic + LLM continuity decisions; nightly maintenance |
| `src/event-significance.ts` | `calculateSignificance` | Deterministic significance score and tier assignment |
| `src/entity-resolution.ts` | `buildAliasMap`, `resolveSubject`, `findMentionedUsers` | Maps display names to real user IDs; ambiguous names resolve to `unknown` |
| `src/profiles.ts` | `ProfileStore` | Per-chatter profile cards + dossiers: input fingerprinting + LLM synthesis, rebuilt only when inputs change |
| `src/dossier.ts` | `gatherDossierInputs` | Per-section dossier input gathering and hashing — voice, life_situation, temperament, beliefs, relationship_map, reputation, timeline |
| `src/commands.ts` | `commandDefinitions`, `handleMemoryCommand`, `handleMemoryButton` | Discord slash command schemas and interaction handlers |

---

## Data flow — live message

```
Discord MessageCreate
        │
        ▼
  index.ts: record raw message in MemoryStore
        │
        ▼
  perception.ts: shouldInspectForMemory()?
        │ yes                     no ──────────────────────────────┐
        ▼   (passes durableSignals regex, or any bot-addressed msg) │
  brain.ts: extractMemories()                                      │
  (LLM — returns subjectId, subjectName, kind, content,            │
   reason, evidenceType, effect + relationship assertions;         │
   no numeric values)                                              │
        ▼                                                           │
  entity-resolution.ts: resolveSubject()                           │
  • subjectName → real user ID via the members alias map           │
  • ambiguous names → "unknown" (correctness over recall)          │
  • relationship assertions → relationship_observations            │
    → verdict column (v8) records sincerity; recomputeEdges()      │
    rebuilds relationships edges from 'literal' verdicts only —    │
    unverified/joke assertions never surface as edges              │
        │                                                           │
        ▼                                                           │
  database.ts: saveMemory()                                         │
  • confidence.ts formulas set initial confidence                   │
  • UNIQUE(guild_id, subject_id, kind, content) dedup, with a pg_trgm
    similarity fallback so rephrased extractions reinforce one row              │
  • evidence inserted idempotently by (memory_id, message_id)      │
  • lifecycle: candidate → active (if promotable evidence type     │
    and confidence ≥ threshold)                                    │
  • contested memories: confidence frozen; net_score updated       │
  • history row appended                                           │
        │                                                           │
        ▼◄──────────────────────────────────────────────────────────┘
  event-detection.ts: EventPipeline.process()                          │
  • regex-failed messages aren't dropped: a 15-min sweep in index.ts   │
    re-triages recent uninspected messages via brain.triageBatch and   │
    routes durable verdicts into the same extraction path            │
  • scoreOpenEvents() heuristic (no LLM)
  • if ambiguous: brain.assessContinuity() (LLM)
  • attach / new / reference / bridge
        │
        ▼
  brain.ts: decide()
  • baseline 0.05 + direct mention +0.85 + question +0.10
  • recency penalty −0.25 (only if NOT a direct mention)
  • shouldSpeak = score ≥ SPEAK_THRESHOLD (default 0.70)
        │
        ▼ (only if shouldSpeak && replyEnabled)
  brain.ts: reply()
  • recent channel context (<@id> tokens demangled to @names) + relevant
    memories: active plus candidates with promotable primary evidence types
  • author addressed by freshest known name (learned aliases apply instantly)
  • reply output scrubbed: known <@id> → plain @Name, unknown ids stripped
  • temperature 0.9, max 1800 chars
  • REPLY_MODEL overrides the reply model on every path (default GROQ_MODEL);
    gpt-oss/qwen models get reasoning_effort=low to keep casual chat fast
  • REPLY_MODEL=groq/compound* switches to Groq's agentic system: server-side
    web_search + visit_website tools, executed_tools logged, falls back to
    GROQ_MODEL on failure
  • REPLY_TOOLS=1 attaches local web_search/visit_url tools (tools.ts — free,
    in-process, no per-call billing) when the message matches toolCues();
    model-driven tool_calls loop, ≤3 rounds, falls back to the plain path
        │
        ▼
  Discord: message.reply()
```

---

## Data flow — bulk ingest (`npm run ingest`)

`ingest.ts` connects to Discord, fetches the full channel history, sorts messages chronologically (Discord API returns newest-first), and feeds each message through the same `saveMemory` → `EventPipeline.process` path as the live bot. It rate-limits LLM calls to stay under Groq's token limit and skips messages that already have evidence rows (safe to re-run). After processing it calls `EventPipeline.maintainEvents()` to close open windows and score candidates, then `ProfileStore.buildProfiles()` to rebuild per-chatter profile cards.

---

## Profiles

`ProfileStore.buildProfiles()` runs during daily maintenance and at the end of ingest. For each member with ≥1 active memory or ≥5 messages it gathers deterministic inputs — top memories, behavioral patterns, relationship edges (≥2 observations), events, and activity stats — hashes them into `source_hash`, and only calls `Brain.synthesizeProfile()` when the fingerprint changed. Opted-out members are skipped and their profiles deleted. Profiles surface via `/profile` (self or admin) and are injected into `brain.reply()` for the author, @-mentioned users, and members referenced by name.

Members with ≥3 active memories or ≥50 messages additionally get a **dossier** — a set of independently-built sections stored under `facets_json.dossier.sections`, each rebuilt only when its own input hash changes:

- `voice` — writing style analyzed from a 60-message raw sample plus deterministic stats (avg length, caps/emoji/question rates)
- `life_situation`, `beliefs` — sourced item lists citing memory IDs (`source_ids`)
- `temperament`, `reputation` — prose + sourced items; reputation uses only third-party claims (evidence author ≠ subject)
- `relationship_map` — per-person dynamics from merged edges (A→B + B→A collapsed at read time), bidirectional observation reasons, and the deterministic interaction graph (mention + name-ref frequency from `interactionPairs`)
- `timeline` — deterministic event list, no LLM

Degenerate LLM output (repeated glyphs, JSON blobs) is detected per section and never overwrites existing data. Dossiers surface via `/dossier` (self or admin); `reply()` only ever injects the card.

Candidate memories pass a **sincerity verification** gate before they can activate: `Brain.verifyMemoriesBatch` re-judges each promotable candidate against its stored source message, the author's known names, and the preceding chat lines (literal / joke / unclear / misattributed). Verified literal self-reports promote to `active`; jokes are re-classified `sarcasm_or_joke` (confidence → 0.10, never promotable); `misattributed` verdicts — pasted/quoted text describing someone other than the poster — are forgotten outright; third-party literals stay candidate pending corroboration. Verification runs in `applyRetention()` and at the end of ingest before profile builds.

Relationship assertions pass the analogous gate: `Brain.verifyRelationshipsBatch` labels each observation `literal` / `joke` / `unclear` against its source message and preceding lines, and `recomputeEdges()` rebuilds the derived `relationships` table from `literal` verdicts alone — an unverified or ironic claim ("we're basically married") never surfaces in `/profile`, dossier inputs, or the reply prompt. New edges therefore materialize at the next maintenance pass rather than at record time.

Dedup runs at two tiers. The **hot path** uses the pg_trgm fallback in `saveMemory()` — a `similarity(content)` lookup scoped to `(guild, subject, kind)` reinforces one row instead of splitting rephrased extractions (with a polarity check so contradictions can't ride the merge). The **maintenance tier** is semantic: `Brain.dedupMemoriesBatch` scans each member's memory list nightly and proposes `duplicate`/`contradicts` groups — catching pairs with no lexical overlap that trigrams can't see ("allergic to peanuts" / "can't eat nuts"). `applyDedupGroups` merges confirmed groups deterministically: the canonical row keeps its status (merging never promotes), evidence moves over, losers become `superseded` with an audit link. `contradicts` verdicts are logged to history only — truth arbitration stays with the contest/supersede machinery.

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
