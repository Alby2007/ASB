import type { MemoryStore } from "./database.js";
import { resolveSubject, type AliasMap } from "./entity-resolution.js";
import { config } from "./config.js";
import type { ExtractionResult, MessageEvent } from "./types.js";

/**
 * Consent-gated write path for one message's extraction result. Shared by the
 * live path, the nightly sweep, historical ingest, and /profile-build so the
 * privacy rules exist in exactly one place:
 *
 *  - person memories persist only when the resolved subject consented to
 *    derived data (`isConsented`). "unknown" and "server" are exempt — unknown
 *    subjects are inert until claimed, server lore is shared context.
 *  - relationship observations use subject-consent: they persist when at
 *    least one real party consented. Edges to "unknown" are never recorded
 *    (they'd smear whoever later claims that name) but the name is logged for
 *    resolution either way.
 *
 * `isConsented` is supplied per call site (a Set over the guild's opted-in
 * members, or a lazily-cached member lookup) so this stays testable and the
 * callers control how the consent set is built. The predicate receives real
 * user IDs plus the sentinels "unknown"/"server" — implementors must treat
 * the sentinels as consented so lore keeps flowing.
 */
export type PersistExtractionCtx = {
  store: MemoryStore;
  aliases: AliasMap;
  isConsented: (userId: string) => boolean | Promise<boolean>;
  /** Fires once per persisted memory with the new row id. */
  onMemorySaved?: (memoryId: number) => void;
  /** Fires once per newly recorded relationship observation. */
  onRelationshipRecorded?: () => void;
};

export async function persistExtraction(
  result: ExtractionResult,
  event: MessageEvent,
  ctx: PersistExtractionCtx
): Promise<{ savedIds: number[]; relationshipsRecorded: number }> {
  const { store, aliases, isConsented } = ctx;
  const savedIds: number[] = [];
  let relationshipsRecorded = 0;

  for (const memory of result.memories) {
    memory.subjectId = resolveSubject(memory, aliases, event);
    if (!(await isConsented(memory.subjectId))) continue;
    if (memory.subjectId === "unknown" && memory.subjectName) {
      await store.logUnresolvedName(event.guildId, memory.subjectName, event.messageId);
    }
    const saved = await store.saveMemory(event, memory, config.candidateConfidenceThreshold);
    savedIds.push(saved.id);
    ctx.onMemorySaved?.(saved.id);
  }

  for (const rel of result.relationships) {
    const subjectId = rel.subjectName ? resolveSubject({ subjectName: rel.subjectName }, aliases, event) : event.authorId;
    const otherId = resolveSubject({ subjectName: rel.otherName }, aliases, event);
    if (subjectId === "unknown" && rel.subjectName) {
      await store.logUnresolvedName(event.guildId, rel.subjectName, event.messageId);
    }
    if (otherId === "unknown" && rel.otherName) {
      await store.logUnresolvedName(event.guildId, rel.otherName, event.messageId);
    }
    if (subjectId === "unknown" || otherId === "unknown") continue;
    // Subject-consent: either edge party opted in is enough — the gate
    // protects the people the claim is ABOUT, so a non-consenting assertor's
    // claim about consenting members still persists. The assertor is recorded
    // (author_id) so opt-out can erase their authored claims later.
    if (!(await isConsented(subjectId)) && !(await isConsented(otherId))) continue;
    if (await store.recordRelationship(event.guildId, subjectId, otherId, event.messageId, event.authorId, rel.nature, rel.valence, rel.reason ?? "")) {
      relationshipsRecorded++;
      ctx.onRelationshipRecorded?.();
    }
  }

  return { savedIds, relationshipsRecorded };
}
