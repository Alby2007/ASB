# Phase 1A — Foundation audit

Audit date: 2026-09-14. This note describes the implementation before the formal Phase 1 memory-engine refactor.

## Current pipeline

`src/index.ts` archives each eligible Discord message. A cheap regular-expression pre-filter in `src/perception.ts` decides whether to ask `Brain.extractMemories()` for LLM-proposed memory candidates. `MemoryStore.saveMemory()` persists a candidate and then Discord reply generation retrieves active memories for the message author plus server-wide active memories.

## Current schema

- `messages`: Discord message ID, guild/channel/author identifiers, author display name, full content, and timestamp.
- `memories`: guild, subject, kind, content, LLM-supplied confidence/importance/explicitness, confirmation count (`mentions`), lifecycle status, timestamps, and an optional replacement pointer.
- `memory_evidence`: one source quote per `(memory_id, message_id)`, author, LLM reason, explicitness, and observation timestamp.
- `server_settings`: pause state and raw-message retention length.

The evidence table already correctly uses `UNIQUE(memory_id, message_id)`, which permits one message to support different memories. Evidence quotes survive raw-message retention purges.

## Current behaviour

- Candidates below an LLM confidence/explicitness threshold are stored as `candidate`; active memories alone are retrieved.
- A repeated candidate can promote to `active`; old candidates and weak active memories can become `stale` in daily maintenance.
- `/correct` asks the LLM to choose which existing memories to supersede; `/forget` marks a memory forgotten after confirmation.
- `/memory` and export expose stored memory evidence privately, subject to member/admin permissions.

## Baseline test coverage

`src/reliability.test.ts` currently verifies only the local extraction pre-filter and candidate promotion. `npm run check` and `npm test` pass at the time of this audit.

## Gaps against the formal Phase 1 plan

1. Confidence is not authoritative or deterministic: initial confidence comes from the LLM, and later updates use a separate ad-hoc formula.
2. Duplicate evidence is not safe end-to-end: `saveMemory()` updates confidence and confirmation count before the idempotent evidence insert, so replaying the same message can still affect the memory.
3. Evidence does not model the required independent `evidence_type` and `effect` axes. There is no support/contradict/correct/context confidence engine.
4. The schema lacks contradiction counts, update/contradiction timestamps, formal quarantine state, and transition history.
5. No deterministic conflict detection, age-weighted resolution, correction confirmation, or decision logging exists.
6. Episodes are not consolidated and behavioural patterns are not supported.
7. The test suite does not yet cover sarcasm, rumours, ambiguity, conflict resolution, evidence reuse, or retention explainability.
8. Schema evolution is ad hoc `ALTER TABLE` attempts rather than versioned migrations.

## Gate 1A decision

Do not extend social intelligence or autonomous behaviour. Gate 1B should introduce a versioned SQLite migration and a standalone deterministic memory engine. The LLM may return language interpretation only: proposed memory content, evidence type/effect, and relation to known memories. It must not set confidence, lifecycle status, or transitions.
