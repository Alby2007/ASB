# Architecture

ASB (Artificial Server Member) is a single TypeScript/Node process that connects to Discord, observes messages, extracts durable memories using an LLM, detects notable server events, and replies conservatively when directly addressed. All state is stored locally in a SQLite database.

---

## Module map

| File | Class / exports | Role |
|------|----------------|------|
| `src/index.ts` | — | Discord client, live message loop, daily maintenance scheduler |
| `src/ingest.ts` | — | Standalone script: bulk-ingest historical channel messages |
| `src/brain.ts` | `Brain` | All LLM calls: extract memories, correct, assess continuity, classify events, reply |
| `src/config.ts` | `config` | Env-variable validation (zod); single exported config object |
| `src/types.ts` | `MessageEvent`, `MemoryCandidate`, `StoredEvent`, `Decision`, … | Shared TypeScript types shared across modules |
| `src/database.ts` | `MemoryStore` | SQLite persistence: memory CRUD, lifecycle, conflict resolution, episode consolidation |
| `src/events.ts` | `EventStore` | SQLite persistence: event CRUD, participants, message/memory attachments |
| `src/migrations.ts` | `runMigrations`, `getMigrationVersion` | Versioned schema migrations (v1–v5) with rollback support |
| `src/confidence.ts` | `calculateInitialConfidence`, `updateConfidence`, `calculateDefaultImportance`, `calculateDefaultExplicitness` | Deterministic numeric formulas; no LLM involvement |
| `src/perception.ts` | `shouldInspectForMemory` | Cheap regex pre-filter: prevents LLM calls for ordinary chat |
| `src/event-detection.ts` | `EventPipeline` | Heuristic + LLM continuity decisions; nightly maintenance |
| `src/event-significance.ts` | `calculateSignificance` | Deterministic significance score and tier assignment |
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
        ▼                                                           │
  brain.ts: extractMemories()                                       │
  (LLM — returns subjectId, kind, content,                         │
   reason, evidenceType, effect only;                              │
   no numeric values)                                              │
        │                                                           │
        ▼                                                           │
  database.ts: saveMemory()                                         │
  • confidence.ts formulas set initial confidence                   │
  • UNIQUE(guild_id, subject_id, kind, content) dedup              │
  • evidence inserted idempotently by (memory_id, message_id)      │
  • lifecycle: candidate → active (if promotable evidence type     │
    and confidence ≥ threshold)                                    │
  • contested memories: confidence frozen; net_score updated       │
  • history row appended                                           │
        │                                                           │
        ▼◄──────────────────────────────────────────────────────────┘
  event-detection.ts: EventPipeline.process()
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
  • recent channel context + relevant active memories
  • max 1800 chars
        │
        ▼
  Discord: message.reply()
```

---

## Data flow — bulk ingest (`npm run ingest`)

`ingest.ts` connects to Discord, fetches the full channel history, sorts messages chronologically (Discord API returns newest-first), and feeds each message through the same `saveMemory` → `EventPipeline.process` path as the live bot. It rate-limits LLM calls to stay under Groq's token limit and skips messages that already have evidence rows (safe to re-run). After processing it calls `EventPipeline.maintainEvents()` to close open windows and score candidates.

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

3. **Transactions everywhere.** `saveMemory()` and `createEvent()` both use SQLite transactions so partial state is impossible.

4. **Conservative speaking.** The bot observes silently and replies only to direct mentions by default (`SPEAK_THRESHOLD=0.70`). The recency penalty never suppresses a direct mention.

---

## Further reading

- [`docs/schema.md`](schema.md) — all tables, columns, and indexes
- [`docs/event-pipeline.md`](event-pipeline.md) — event detection in detail
- [`docs/configuration.md`](configuration.md) — all environment variables
- [`docs/development.md`](development.md) — scripts, tests, and contributor guide
