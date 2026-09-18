import type { Brain } from "./brain.js";
import { config } from "./config.js";
import type { MemoryStore } from "./database.js";
import type { EventStore } from "./events.js";
import type { ProfileStore } from "./profiles.js";
import { buildAliasMap } from "./entity-resolution.js";
import { persistExtraction } from "./persist-extraction.js";
import { detectNamingRequest, detectSelfNaming } from "./perception.js";
import { sleep, withRetry } from "./retry.js";
import { logError } from "./secrets.js";
import type { MessageEvent } from "./types.js";

export const PROFILE_BUILD_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const SCAN_LIMIT = 1000;          // capped — worst case ~10 min of batched calls
const EXTRACT_BATCH = 5;          // same shape as ingest's batch extraction
const EXTRACT_DELAY_MS = 3000;
const VERIFY_BATCH = 10;
const VERIFY_DELAY_MS = 1500;

export type ProfileBuildStats = { scanned: number; memories: number; relationships: number };

/**
 * Self-service opt-in profile build (/profile-build). Scans the archive for
 * the member's own messages, references to them, and replies to them — then
 * runs the standard consent-gated extraction, verification, edge recompute,
 * and a scoped profile build. Derived data about OTHER members still requires
 * their consent, so this can only ever populate the caller's own corpus
 * (plus consent-exempt server lore).
 */
export async function runProfileBuild(
  guildId: string,
  userId: string,
  deps: { store: MemoryStore; brain: Brain; eventStore: EventStore; profileStore: ProfileStore }
): Promise<ProfileBuildStats> {
  const { store, brain, eventStore, profileStore } = deps;

  const settings = await store.settings(guildId, config.rawMessageRetentionDays);
  const since = new Date(Date.now() - settings.rawRetentionDays * 24 * 60 * 60 * 1000);
  const member = await store.getMember(guildId, userId);
  const rows = await store.messagesAboutSubject(guildId, userId, member?.knownNames ?? [], since, SCAN_LIMIT);
  if (!rows.length) return { scanned: 0, memories: 0, relationships: 0 };

  const members = await store.listMembers(guildId);
  const memberNames = new Map(members.map(m => [m.userId, m.knownNames]));
  const aliasMap = await buildAliasMap(guildId, store);
  const optedIn = new Set(members.filter(m => m.optedIn && !m.optedOut).map(m => m.userId));
  const isConsented = (id: string) => id === "unknown" || id === "server" || optedIn.has(id);

  let memories = 0, relationships = 0;
  for (let i = 0; i < rows.length; i += EXTRACT_BATCH) {
    const batch = rows.slice(i, i + EXTRACT_BATCH).map(r => ({
      event: {
        guildId, channelId: r.channelId, messageId: r.id,
        authorId: r.authorId, authorName: r.authorName,
        content: r.content, createdAt: new Date(r.createdAt), mentionsBot: false,
      } satisfies MessageEvent,
      replyToContent: r.replyToContent,
      note: undefined as string | undefined,
    }));
    // Alias learning runs in the same order as the sweep: explicit request
    // first, self-naming fallback — so historical "call me X" lines resolve.
    for (const item of batch) {
      const authorNames = memberNames.get(item.event.authorId) ?? [item.event.authorName];
      const requested = detectNamingRequest(item.event.content, authorNames);
      const named = requested ?? detectSelfNaming(item.event.content, authorNames);
      if (named) {
        await store.learnAlias(guildId, item.event.authorId, named, requested ? "naming_request" : "self_naming", item.event.messageId);
        memberNames.set(item.event.authorId, [...authorNames, named]);
        aliasMap.set(named.toLowerCase(), item.event.authorId);
        item.note = requested
          ? `the author asked to be called "${requested}" — treat it as their preferred name`
          : `the author may be naming themselves "${named}" (a previously unknown alias) or quoting/describing "${named}" — attribute accordingly`;
      }
    }
    try {
      const results = await withRetry(() => brain.extractMemoriesBatch(batch, config.ingestModel ?? config.model), 3);
      for (const item of batch) {
        const result = results.get(item.event.messageId) ?? { memories: [], relationships: [] };
        const persisted = await persistExtraction(result, item.event, { store, aliases: aliasMap, isConsented });
        memories += persisted.savedIds.length;
        relationships += persisted.relationshipsRecorded;
      }
      // Terminal mark — the scan processed these; the sweep shouldn't re-extract.
      await store.setTriageResults(batch.map(item => ({ id: item.event.messageId, result: "extracted" })));
    } catch { /* batch stays unmarked — retryable on the next build */ }
    if (i + EXTRACT_BATCH < rows.length) await sleep(EXTRACT_DELAY_MS);
  }

  // Sincerity verification on the member's own candidates — verified literal
  // self-reports promote to active so attributes can cite them.
  try {
    const verifiable = await store.listVerifiableCandidates(guildId, 200, userId);
    for (let i = 0; i < verifiable.length; i += VERIFY_BATCH) {
      const batch = verifiable.slice(i, i + VERIFY_BATCH);
      const verdicts = await withRetry(() => brain.verifyMemoriesBatch(
        batch.map(b => ({ memoryId: b.memoryId, authorName: b.authorName, authorNames: b.authorNames, claim: b.content, sourceMessage: b.sourceMessage, contextBefore: b.contextBefore })),
        config.verifyModel ?? config.ingestModel ?? config.model
      ), 3);
      for (const b of batch) {
        const v = verdicts.get(b.memoryId) ?? { verdict: "unclear" as const, reason: "omitted" };
        await store.applyVerification(b.memoryId, v.verdict, v.reason);
      }
      if (i + VERIFY_BATCH < verifiable.length) await sleep(VERIFY_DELAY_MS);
    }
  } catch (error) { logError("Profile-build verification failed", error); }

  try { await store.recomputeEdges(guildId); } catch (error) { logError("Profile-build edge recompute failed", error); }

  try {
    await withRetry(() => profileStore.buildProfiles(guildId, brain, store, eventStore, config.profileModel ?? config.model, { onlyUserId: userId }), 3);
  } catch (error) { logError("Profile-build profile pass failed", error); }

  return { scanned: rows.length, memories, relationships };
}
