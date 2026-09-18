import type { Brain, LlmClient } from "./brain.js";
import type { MemoryStore } from "./database.js";
import type { EventStore } from "./events.js";
import type { EventPipeline } from "./event-detection.js";
import type { AliasMap } from "./entity-resolution.js";
import type { MessageEvent } from "./types.js";
import { BudgetExceeded, meteredClient } from "./budget.js";
import { detectNamingRequest, detectSelfNaming } from "./perception.js";
import { formatImageContext } from "./vision.js";
import { persistExtraction } from "./persist-extraction.js";
import { runContestCheck } from "./contest.js";
import { withRetry } from "./retry.js";
import { inc } from "./metrics.js";
import { logError } from "./secrets.js";

// ── Extract job handler ──────────────────────────────────────────────────────
// Everything deferrable about a durable message runs here, off the live path:
// alias-learn → describe → extract → persist → terminal triage mark → contest
// → event pipeline. Per-guild serial (maxPerGuild=1 in the worker) preserves
// pipeline/event ordering. BudgetExceeded from ANY stage propagates so the
// worker reschedules the job to the UTC-day reset without burning an attempt;
// other failures retry with backoff (capped at 5 attempts, then dead-letter —
// 'queued' marks stay, bounded loss the sweep already tolerates).
// Lives outside index.ts so it can be unit-tested (index.ts logs in on import).

export type ExtractJobPayload = {
  event: Omit<MessageEvent, "createdAt"> & { createdAt: string };
  replyToId?: string;
  replyToContent?: string;
};

export interface ExtractJobDeps {
  store: MemoryStore;
  brainFor: (guildId: string) => Promise<Brain | null>;
  eventStore: EventStore;
  pipeline: EventPipeline;
  botId: string;
  visionModel?: string;
  visionClient?: LlmClient;
  contestModel: string;
  imageMaxBytes: number;
  /** Alias/name lookups — index.ts serves these from its TTL cache; tests can
   * return a static map. */
  getAliases: (guildId: string) => Promise<AliasMap>;
  /** Drop the guild's cached lookups when learnAlias teaches a new name. */
  invalidateLookups: (guildId: string) => void;
}

export async function runExtractJob(payload: ExtractJobPayload, deps: ExtractJobDeps): Promise<void> {
  const event: MessageEvent = { ...payload.event, createdAt: new Date(payload.event.createdAt) };
  const guildId = event.guildId;
  const brain = await deps.brainFor(guildId);
  if (!brain) { inc("jobs.dropped_dormant"); return; } // went dormant — drop, no retry
  const { store, botId } = deps;
  const images = event.imageAttachments ?? [];

  // Naming signals — same order as the old inline path (request, then weak
  // self-name). learnAlias is cheap; the LLM spend starts below.
  const member = await store.getMember(guildId, event.authorId);
  const authorNames = member?.knownNames ?? [event.authorName];
  const requested = detectNamingRequest(event.content, authorNames);
  const named = requested ?? detectSelfNaming(event.content, authorNames);
  if (named) {
    await store.learnAlias(guildId, event.authorId, named, requested ? "naming_request" : "self_naming", event.messageId);
    deps.invalidateLookups(guildId);
  }
  const note = requested
    ? `the author asked to be called "${requested}" — treat it as their preferred name`
    : named ? `the author may be naming themselves "${named}" (a previously unknown alias) or quoting/describing "${named}" — attribute accordingly` : undefined;

  // Image describe re-runs here — the per-message memoization on the live
  // path only ever shared between extraction and the reply for that message.
  // A separate vision client (VISION_API_KEY/BASE_URL ≠ main creds) is the
  // operator's spend, not the guild's key — but it still counts against the
  // guild's daily cap, so it's wrapped in the same meter. When visionClient is
  // undefined, describeImage falls back to the brain's already-metered client.
  let imageContext: string | undefined;
  if (images.length && deps.visionModel) {
    const vision = deps.visionClient
      ? meteredClient(deps.visionClient, { guildId, store: deps.store, getCap: async () => (await deps.store.settings(guildId)).llmDailyCap })
      : undefined;
    const descs = await Promise.all(images.map(async a => {
      try {
        const d = await brain.describeImage({ url: a.url, contextText: event.content, maxBytes: deps.imageMaxBytes }, deps.visionModel!, vision);
        inc("vision.described");
        return d.description;
      } catch (error) {
        if (error instanceof BudgetExceeded) throw error; // reschedule — the image must not be extracted silently stripped of its context
        inc("vision.error"); logError("Image describe failed", error); return undefined;
      }
    })).then(list => list.filter((d): d is string => !!d));
    imageContext = formatImageContext(descs, event.authorName) || undefined;
  }

  const { memories: candidates, relationships } = await withRetry(() => brain.extractMemories(event, payload.replyToContent, note, imageContext), 3);
  const aliases = (candidates.length || relationships.length) ? await deps.getAliases(guildId) : new Map<string, string>();
  // Opt-in consent — identical rule to the sweep/ingest paths: derived person
  // data persists only for consenting members; the bot counts as consented.
  const consentCache = new Map<string, boolean>();
  const isConsented = async (userId: string) => {
    if (userId === "unknown" || userId === "server" || userId === botId) return true;
    const cached = consentCache.get(userId);
    if (cached !== undefined) return cached;
    const m = await store.getMember(guildId, userId);
    const ok = !!m?.optedIn && !m.optedOut;
    consentCache.set(userId, ok);
    return ok;
  };
  const { savedIds } = await persistExtraction(
    { memories: candidates, relationships },
    event,
    { store, aliases, isConsented, onMemorySaved: () => inc("memory.saved") },
  );
  // Terminal mark — extraction ran even if it yielded nothing.
  await store.setTriageResults([{ id: event.messageId, result: "extracted" }]);
  try {
    await runContestCheck(event, brain, store, botId, deps.contestModel);
  } catch (error) {
    if (error instanceof BudgetExceeded) throw error; // reschedule — cap is not a fault
    inc("contest.error"); logError("Contest check failed", error);
  }
  try {
    await deps.pipeline.process(event, savedIds, deps.eventStore, store, brain, payload.replyToId);
  } catch (error) {
    if (error instanceof BudgetExceeded) throw error;
    inc("pipeline.error"); logError("Event pipeline failed", error);
  }
}
