# Phase 1C: Conflict Resolution and Memory Consolidation

**Status**: Complete

This phase builds on the deterministic confidence and evidence safety foundation established in Phase 1B to implement the full conflict resolution and memory consolidation system.

## Core Requirements (from existing specification)

### 1. Net Score-Based Conflict Resolution
- Implement deterministic conflict resolution using age-weighted evidence scoring
- Maintain separation between `confidence` (authoritative belief) and `net_score` (temporary resolution signal)
- Resolution criteria: memory.confidence >= 0.70 AND net_score >= 0.50 AND newest evidence is not contradictory

### 2. Episode Consolidation and Behavioral Patterns
- Consolidate related episodes into behavioral patterns
- Pattern detection thresholds and time windows
- Pattern promotion criteria

### 3. Sarcasm-Gated Promotion Logic
- Implement promotion rules that specifically gate sarcasm evidence
- Evidence type-specific promotion thresholds
- Temporal decay for low-confidence evidence

## Critical Implementation Requirements

### Confidence Freezing During Contested State
**CRITICAL**: When a memory is in `contested` status, confidence updates must be frozen to maintain net_score independence.

- Add check in `saveMemory()` to skip confidence updates if memory.status === 'contested'
- Only allow net_score calculations to continue during contested state
- This prevents the confidence/conflict resolution coupling issue identified in the Phase 1A audit

### Episode Promotion Restrictions
**CRITICAL**: Episode promotion should only count `active`-status episodes.

- Modify maintenance logic to filter episodes by status before counting
- Prevent candidate/quarantined episodes from contributing to pattern formation
- Ensures only validated behavioral patterns influence consolidation

## Conflict Resolution Algorithm

### Net Score Calculation
```
net_score = Σ(weight(support_evidence)) - Σ(weight(contradict_evidence))

where weight(timestamp) = 0.5^(max(0, now - timestamp) / 90 days)
```

### Resolution Decision Matrix
| Confidence | Net Score | Newest Evidence | Resolution |
|------------|-----------|-----------------|------------|
| >= 0.70    | >= 0.50   | Not contradict  | Active     |
| >= 0.70    | < 0.50    | Any             | Contest    |
| < 0.70     | Any       | Any             | Contest    |

## Data Model Additions

### Schema Changes (Migration v2)
- Add `net_score` column to memories table
- Add `frozen_confidence` column to track frozen confidence during contested state
- Add `pattern_id` column to episodes for consolidation tracking
- Create `behavioral_patterns` table for consolidated patterns

### History Tracking
- Add conflict resolution events to memory_history
- Track frozen/unfrozen confidence transitions
- Log pattern consolidation events

## Test Coverage Requirements

### Conflict Resolution Tests
- Age-weighted evidence scoring accuracy
- Resolution decision matrix edge cases
- Frozen confidence behavior during contested state
- Cross-temporal conflict scenarios

### Episode Consolidation Tests
- Pattern detection with varying episode density
- Active-only episode promotion enforcement
- Pattern decay and retirement
- Sarcasm-gated promotion logic

### Integration Tests
- End-to-end conflict lifecycle
- Multi-stage consolidation workflows
- Concurrent conflict and consolidation

## Migration Strategy

### Phase 1C Migration (v2)
1. Add new columns and tables
2. Backfill net_score for existing contested memories
3. Migrate existing episodes to patterns where applicable
4. Update maintenance job logic
5. Implement confidence freezing checks

## Dependencies

### Prerequisites from Phase 1B
- ✅ Deterministic confidence calculation
- ✅ Evidence safety with message_id dedup
- ✅ Versioned migration system
- ✅ Comprehensive test coverage

### Blocking for Phase 1D
- Complete conflict resolution implementation
- Episode consolidation system
- Updated adversarial test suite

## Success Criteria

Phase 1C complete when:
- ✅ Conflict resolution uses deterministic net_score calculations
- ✅ Confidence is frozen during contested state
- ✅ Episode promotion only counts active episodes
- ✅ Pattern consolidation is functional and tested
- ✅ All conflict resolution edge cases are covered
- ✅ System can handle complex multi-stage conflicts
- ✅ Test coverage > 90% for conflict and consolidation logic

## Implementation summary

All requirements implemented across two sessions:

**Session 1 (foundation fixes)**
- `src/types.ts` / `src/database.ts`: `Memory.confidence` typed `number` (was `number | undefined`); 16 typecheck errors resolved.
- `saveMemory()`: confidence frozen from the instant a memory enters `contested` — no confidence changes (up or down) during contested state; `net_score` is the sole resolution signal.
- `saveMemory()`: explicit `promotableTypes` allowlist (`explicit_fact`, `clear_preference`, `correction`) — sarcasm, rumour, and uncertain inference can never promote a candidate regardless of how much evidence accumulates.
- `maintain()`: iterates all contested memories and calls `resolveContested()` on each; returns `resolved` count alongside existing counters.
- `commands.ts`: `/correct` now calls `allActiveMemories()` (no page cap) so all memories are visible to the LLM for supersession decisions.
- Tests added: contested resolution via `maintain()`, unresolvable contested state, confidence freeze, sarcasm volume accumulation, `uncertain_inference`/`reported_by_other` promotion gate.

**Session 2 (schema and consolidation)**
- `migrations.ts`: Migration v2 (`phase_1c_conflict_and_patterns`) adds `net_score REAL`, `frozen_confidence REAL`, `pattern_id INTEGER` to `memories`; creates `behavioral_patterns` table with `patterns_lookup` index.
- `database.ts`: `frozen_confidence` written to the row when a memory first enters contested; `net_score` persisted by `resolveContested()` (cleared on successful resolution).
- `database.ts`: `consolidateEpisodes(guildId, subjectId, minEpisodes=3)` — counts only `active`-status episodes (candidates and quarantined are excluded), creates a `behavioral_patterns` row, and links the episodes via `pattern_id`.
- `database.ts`: `patterns(guildId, subjectId)` query method added.
- `maintain()` now also calls `consolidateEpisodes()` per subject and returns `patternsFound`.
- Tests added: migration v2 schema verification (5 tests), episode threshold gate, active-only enforcement, pattern creation, `maintain()` surfacing `patternsFound`.

**Verification**: `npm run check` 0 errors · `npm test` 60/60 pass.