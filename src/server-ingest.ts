import type { Message, TextChannel } from "discord.js";
import type { Brain } from "./brain.js";
import { config } from "./config.js";
import type { MemoryStore } from "./database.js";
import type { EventStore } from "./events.js";
import type { EventPipeline } from "./event-detection.js";
import { detectNamingRequest, detectSelfNaming, shouldInspectForMemory } from "./perception.js";
import { runContestCheck } from "./contest.js";
import { ProfileStore } from "./profiles.js";
import { buildAliasMap } from "./entity-resolution.js";
import { persistExtraction } from "./persist-extraction.js";
import { sleep, withRetry } from "./retry.js";
import type { MessageEvent } from "./types.js";

// ── Config ────────────────────────────────────────────────────────────────────
const DISCORD_BATCH_SIZE = 100;     // Discord API max per fetch
const LLM_BATCH_SIZE = 5;           // Messages per LLM call (batched extraction)
// qwen3.8-27b gets 60 RPM on Groq free tier — 2x the rate limit of gpt-oss-20b.
// Combined with 5-msg batching this gives ~10x effective throughput vs single-message calls.
const BATCH_MODEL = config.ingestModel ?? "qwen/qwen3.8-27b";
const BATCH_DELAY_MS = 3000;        // Delay between batch LLM calls
const EVENT_DELAY_MS = 3000;        // Pipeline LLM calls get the same pacing
const TRIAGE_MODEL = config.triageModel ?? "qwen/qwen3.8-27b";
const TRIAGE_BATCH_SIZE = 10;       // Messages per triage call
const TRIAGE_DELAY_MS = 1500;       // Triage prompts are small — 40 RPM is safe

export type ServerIngestDeps = {
  store: MemoryStore;
  eventStore: EventStore;
  brain: Brain;
  pipeline: EventPipeline;
  /** The bot's own user id — excluded from profile builds, used for the contest sweep. */
  botId: string;
};

export type ServerIngestStats = {
  total: number; archived: number; durableFound: number; batchCalls: number;
  memoriesSaved: number; relationshipsRecorded: number; eventsCreated: number;
  llmErrors: number; profilesBuilt: number;
};

type RawMsg = { id: string; author: { id: string; bot: boolean; username: string; displayName?: string }; member?: { displayName?: string } | null; content: string; createdAt: Date; reference?: { messageId?: string | null } | null; channel: { id: string }; guild: { id: string } };

function toEvent(msg: RawMsg): MessageEvent {
  return {
    guildId: msg.guild.id, channelId: msg.channel.id, messageId: msg.id,
    authorId: msg.author.id,
    authorName: msg.member?.displayName ?? msg.author.username,
    content: msg.content, createdAt: msg.createdAt, mentionsBot: false,
  };
}

type ExtractItem = { event: MessageEvent; replyToId?: string; replyToContent?: string; note?: string };

/**
 * The server-level historical build: archive a channel's full history, extract
 * server lore + events, and form derived person data ONLY for opted-in members.
 * Runs from `npm run ingest` (CLI) and from /server-build (admin command) —
 * the work is identical, only the client/store wiring differs.
 */
export async function runServerIngest(channel: TextChannel, deps: ServerIngestDeps): Promise<ServerIngestStats> {
  const { store, eventStore, brain, pipeline, botId } = deps;
  const guild = channel.guild;

  let total = 0, archived = 0, batchCalls = 0, memoriesSaved = 0, eventsCreated = 0, llmErrors = 0, relationshipsRecorded = 0, durableFound = 0;

  /** Archive all messages. Returns the extraction queue (regex pass, no evidence)
   * and the triage queue (regex fail, no evidence, not yet triaged). */
  async function archiveAndFilter(msgs: RawMsg[]): Promise<{ toExtract: ExtractItem[]; toTriage: ExtractItem[] }> {
    const toExtract: ExtractItem[] = [];
    const toTriage: ExtractItem[] = [];
    // One query for all existing triage marks instead of per-message lookups
    const triaged = await store.getTriageResults(msgs.map(m => m.id));
    const regexMarked: Array<{ id: string; result: string }> = [];

    for (const msg of msgs) {
      if (!msg.content.trim()) continue;
      const event = toEvent(msg);
      const replyToId = msg.reference?.messageId ?? undefined;
      // Bot chatter is archive-only context (same rule as the live path):
      // record it for the transcript, mark it so no pipeline ever extracts it.
      if (msg.author.bot) {
        await store.recordMessage(event, replyToId, false);
        await store.setTriageResults([{ id: msg.id, result: "noise" }]);
        continue;
      }
      total++;
      await store.recordMessage(event, replyToId);
      archived++;
      if (shouldInspectForMemory(event) && triaged.get(msg.id) !== "extracted") {
        // Regex-passed messages count as triaged too — record the path they took
        if (!triaged.has(msg.id)) regexMarked.push({ id: msg.id, result: "regex" });
        if (!(await store.hasEvidence(msg.id))) {
          let replyToContent: string | undefined;
          if (replyToId) {
            const ref = await store.getMessage(replyToId);
            if (ref) replyToContent = `${ref.authorName}: ${ref.content}`;
          }
          toExtract.push({ event, replyToId, replyToContent });
        }
      } else if (msg.content.trim().length >= 4 && !triaged.has(msg.id) && !(await store.hasEvidence(msg.id))) {
        toTriage.push({ event, replyToId });
      } else if (triaged.get(msg.id) === "durable" && !(await store.hasEvidence(msg.id))) {
        // Marked durable in a previous run but never extracted (e.g. crash
        // mid-run). 'extracted' marks don't reach here — they skip above.
        let replyToContent: string | undefined;
        if (replyToId) {
          const ref = await store.getMessage(replyToId);
          if (ref) replyToContent = `${ref.authorName}: ${ref.content}`;
        }
        toExtract.push({ event, replyToId, replyToContent });
      }
    }
    await store.setTriageResults(regexMarked);
    return { toExtract, toTriage };
  }

  /** Run event pipeline (no memory IDs yet — memories are saved in batch step). */
  async function runEventPipeline(event: MessageEvent, savedMemoryIds: number[], replyToId?: string): Promise<void> {
    try {
      const before = (await eventStore.listEvents(event.guildId, { tier: "candidate" })).total;
      const llmUsed = await withRetry(() => pipeline.process(event, savedMemoryIds, eventStore, store, brain, replyToId));
      const after = (await eventStore.listEvents(event.guildId, { tier: "candidate" })).total;
      if (after > before) eventsCreated++;
      if (llmUsed) await sleep(EVENT_DELAY_MS);
    } catch (err) {
      console.error(`  [event pipeline error] msg ${event.messageId}:`, (err as Error).message.slice(0, 100));
    }
  }

  console.log(`Fetching #${channel.name} history...`);

  // Discord pages newest→oldest, so buffer everything and sort globally —
  // events must be built in chronological order across batch boundaries.
  const backlog: Message[] = [];
  let lastId: string | undefined;

  while (true) {
    const options: { limit: number; before?: string } = { limit: DISCORD_BATCH_SIZE };
    if (lastId) options.before = lastId;

    let batch;
    try {
      batch = await channel.messages.fetch(options);
    } catch (err) {
      console.error("Fetch failed:", (err as Error).message.slice(0, 100));
      await sleep(5000);
      continue;
    }

    if (batch.size === 0) break;
    backlog.push(...batch.values());
    const oldest = batch.reduce((min, m) => (m.createdTimestamp < min.createdTimestamp ? m : min));
    lastId = oldest.id;
    console.log(`  fetched ${backlog.length} messages...`);
  }

  backlog.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
  console.log(`Ingesting ${backlog.length} messages oldest→newest (batch model: ${BATCH_MODEL})...`);

  // ── Step 1: archive all messages + split into extraction / triage queues ────
  const { toExtract, toTriage } = await archiveAndFilter(backlog as Parameters<typeof archiveAndFilter>[0]);
  console.log(`  archived ${archived} | ${toExtract.length} regex-passed | ${toTriage.length} need LLM triage`);

  // ── Step 1.5: LLM triage — catch durable signals the regex missed ────────────
  for (let i = 0; i < toTriage.length; i += TRIAGE_BATCH_SIZE) {
    const batch = toTriage.slice(i, i + TRIAGE_BATCH_SIZE);
    try {
      const verdicts = await withRetry(() => brain.triageBatch(
        batch.map(b => ({ messageId: b.event.messageId, authorName: b.event.authorName, content: b.event.content })),
        TRIAGE_MODEL
      ));
      const marks: Array<{ id: string; result: string }> = [];
      for (const item of batch) {
        const v = verdicts.get(item.event.messageId);
        const durable = v?.durable ?? false;
        marks.push({ id: item.event.messageId, result: durable ? "durable" : "noise" });
        if (durable) {
          durableFound++;
          // Resolve reply context the same way archiveAndFilter does
          if (item.replyToId) {
            const ref = await store.getMessage(item.replyToId);
            if (ref) item.replyToContent = `${ref.authorName}: ${ref.content}`;
          }
          toExtract.push(item);
        }
      }
      await store.setTriageResults(marks);
    } catch (err) {
      llmErrors++;
      console.error(`  [triage error] batch ${i / TRIAGE_BATCH_SIZE + 1}:`, (err as Error).message.slice(0, 120));
    }
    const done = Math.min(i + TRIAGE_BATCH_SIZE, toTriage.length);
    if (done % 100 === 0 || done === toTriage.length) {
      console.log(`  triage ${done}/${toTriage.length} | durable found: ${durableFound}`);
    }
    await sleep(TRIAGE_DELAY_MS);
  }
  // Keep extraction in chronological order — durable messages were appended out of order
  toExtract.sort((a, b) => a.event.createdAt.getTime() - b.event.createdAt.getTime());
  console.log(`  extraction queue: ${toExtract.length} messages`);

  // ── Step 2: batch extraction — LLM_BATCH_SIZE messages per call ─────────────
  // Map messageId → saved memory IDs so the event pipeline can link them
  const savedIdsByMessage = new Map<string, number[]>();
  // The member registry is fully populated by the archive step, so the alias map
  // can resolve names like "Nova" to real user IDs throughout extraction.
  const aliasMap = await buildAliasMap(guild.id, store);
  // userId → known display names, for the pasted/echoed self-naming guard
  const members = await store.listMembers(guild.id);
  const memberNames = new Map(members.map(m => [m.userId, m.knownNames]));
  // Opt-in consent: person memories and relationship observations persist only
  // for members who asked for derived data. Server lore and events are exempt.
  const optedIn = new Set(members.filter(m => m.optedIn && !m.optedOut).map(m => m.userId));
  optedIn.add(botId); // the bot is a willing subject
  const isConsented = (id: string) => id === "unknown" || id === "server" || optedIn.has(id);

  for (let i = 0; i < toExtract.length; i += LLM_BATCH_SIZE) {
    const batch = toExtract.slice(i, i + LLM_BATCH_SIZE);
    batchCalls++;
    for (const item of batch) {
      const authorNames = memberNames.get(item.event.authorId) ?? [item.event.authorName];
      const requested = detectNamingRequest(item.event.content, authorNames);
      const named = requested ?? detectSelfNaming(item.event.content, authorNames);
      if (named) {
        await store.learnAlias(item.event.guildId, item.event.authorId, named, requested ? "naming_request" : "self_naming", item.event.messageId);
        memberNames.set(item.event.authorId, [...authorNames, named]);
        aliasMap.set(named.toLowerCase(), item.event.authorId);
        item.note = requested
          ? `the author asked to be called "${requested}" — treat it as their preferred name`
          : `the author may be naming themselves "${named}" (a previously unknown alias) or quoting/describing "${named}" — attribute accordingly`;
      }
    }
    try {
      const results = await withRetry(() => brain.extractMemoriesBatch(batch, BATCH_MODEL));
      for (const item of batch) {
        const result = results.get(item.event.messageId) ?? { memories: [], relationships: [] };
        const { savedIds } = await persistExtraction(result, item.event, {
          store, aliases: aliasMap, isConsented,
          onMemorySaved: () => { memoriesSaved++; },
          onRelationshipRecorded: () => { relationshipsRecorded++; },
        });
        savedIdsByMessage.set(item.event.messageId, savedIds);
      }
      // Terminal mark — a re-ingest never re-extracts these, even the ones that
      // legitimately produced nothing. Batches that threw keep their verdict
      // and are retried on the next run.
      await store.setTriageResults(batch.map(item => ({ id: item.event.messageId, result: "extracted" })));
    } catch (err) {
      llmErrors++;
      console.error(`  [batch extraction error] batch ${batchCalls}:`, (err as Error).message.slice(0, 120));
      for (const item of batch) savedIdsByMessage.set(item.event.messageId, []);
    }
    const done = Math.min(i + LLM_BATCH_SIZE, toExtract.length);
    console.log(`  extraction ${done}/${toExtract.length} | ${memoriesSaved} memories | ${llmErrors} errors`);
    await sleep(BATCH_DELAY_MS);
  }

  // ── Step 3: event pipeline — run in chronological order across all messages ──
  console.log("Running event pipeline...");
  let pipelineCount = 0;
  for (const msg of backlog as Parameters<typeof archiveAndFilter>[0]) {
    if (msg.author.bot || !msg.content.trim()) continue;
    const event = toEvent(msg);
    const savedMemoryIds = savedIdsByMessage.get(event.messageId) ?? [];
    const replyToId = msg.reference?.messageId ?? undefined;
    await runEventPipeline(event, savedMemoryIds, replyToId);
    pipelineCount++;
    if (pipelineCount % 100 === 0) {
      console.log(`  pipeline ${pipelineCount}/${total} | ${eventsCreated} events`);
    }
  }

  console.log(`\nDone. ${total} total | ${archived} archived | ${durableFound} durable via triage | ${batchCalls} batch calls | ${memoriesSaved} memories | ${relationshipsRecorded} relationship observations | ${eventsCreated} candidate events | ${llmErrors} LLM errors`);

  // Run event maintenance to close open windows and score candidates
  console.log("Running event maintenance...");
  const maintenanceResult = await pipeline.maintainEvents(guild.id, eventStore, store, brain);
  console.log(`Maintenance: closed=${maintenanceResult.closed} promoted=${maintenanceResult.promoted} discarded=${maintenanceResult.discarded}`);

  // Sincerity verification — re-judge promotable candidates against their source
  // messages so edgy jokes don't promote. Verified literal self-reports go active.
  console.log("Verifying candidate memories...");
  try {
    const verifiable = await store.listVerifiableCandidates(guild.id);
    let vPromoted = 0, vFlagged = 0;
    for (let i = 0; i < verifiable.length; i += TRIAGE_BATCH_SIZE) {
      const batch = verifiable.slice(i, i + TRIAGE_BATCH_SIZE);
      try {
        const verdicts = await withRetry(() => brain.verifyMemoriesBatch(
          batch.map(b => ({ memoryId: b.memoryId, authorName: b.authorName, authorNames: b.authorNames, claim: b.content, sourceMessage: b.sourceMessage, contextBefore: b.contextBefore })),
          config.verifyModel ?? BATCH_MODEL
        ));
        for (const b of batch) {
          const v = verdicts.get(b.memoryId) ?? { verdict: "unclear" as const, reason: "omitted" };
          const r = await store.applyVerification(b.memoryId, v.verdict, v.reason);
          if (r === "promoted") vPromoted++;
          else if (r === "flagged") vFlagged++;
          else if (r === "rejected") vFlagged++;
        }
      } catch (err) {
        llmErrors++;
        console.error(`  [verify error] batch ${i / TRIAGE_BATCH_SIZE + 1}:`, (err as Error).message.slice(0, 120));
      }
      await sleep(TRIAGE_DELAY_MS);
    }
    console.log(`  verification: ${vPromoted} promoted | ${vFlagged} flagged | ${verifiable.length - vPromoted - vFlagged} unchanged`);
  } catch (err) {
    console.error("Verification failed:", (err as Error).message.slice(0, 120));
  }

  // Contest sweep — bot-addressed denials/corrections update the memories they target
  try {
    let contests = 0, confirms = 0;
    for (const msg of backlog as Parameters<typeof archiveAndFilter>[0]) {
      if (msg.author.bot || !msg.content.trim()) continue;
      if (!msg.content.includes(`<@${botId}>`) && !msg.content.includes(`<@!${botId}>`)) continue;
      try {
        const r = await withRetry(() => runContestCheck(toEvent(msg), brain, store, botId, config.contestModel ?? BATCH_MODEL));
        contests += r.contests; confirms += r.confirms;
        if (r.contests || r.confirms) await sleep(EVENT_DELAY_MS);
      } catch (err) {
        llmErrors++;
        console.error(`  [contest error] msg ${msg.id}:`, (err as Error).message.slice(0, 120));
      }
    }
    if (contests || confirms) console.log(`  contest sweep: ${contests} contested | ${confirms} confirmed`);
  } catch (err) {
    console.error("Contest sweep failed:", (err as Error).message.slice(0, 120));
  }

  // Rebuild relationship edges from literal-verdicted observations — ingest
  // doesn't verify observations itself, so only already-verified ones form
  // edges here; the rest surface after the next nightly verification pass.
  try {
    const edgeCount = await store.recomputeEdges(guild.id);
    console.log(`Relationship edges: ${edgeCount}`);
  } catch (err) {
    console.error("Edge recompute failed:", (err as Error).message.slice(0, 120));
  }

  // Semantic dedup — LLM finds rephrased duplicates across each member's memory
  // list; applyDedupGroups merges confirmed groups into a canonical row.
  try {
    const dedupMembers = await store.listDedupCandidates(guild.id);
    if (dedupMembers.length) {
      let index = 0;
      const idByIndex = new Map<number, number>();
      const indexed = dedupMembers.map(m => ({
        label: m.label,
        memories: m.memories.map(mm => { const i = index++; idByIndex.set(i, mm.memoryId); return { index: i, kind: mm.kind, status: mm.status, content: mm.content }; }),
      }));
      const groups = await withRetry(() => brain.dedupMemoriesBatch(indexed, config.verifyModel ?? BATCH_MODEL));
      const dupGroups = groups.filter(g => g.relation === "duplicate")
        .map(g => ({ ids: g.indices.map(i => idByIndex.get(i)).filter((x): x is number => x !== undefined), reason: g.reason }));
      const { merged, skipped } = await store.applyDedupGroups(guild.id, dupGroups);
      let contradictions = 0;
      for (const g of groups) {
        if (g.relation !== "contradicts") continue;
        const ids = g.indices.map(i => idByIndex.get(i)).filter((x): x is number => x !== undefined);
        for (const id of ids) {
          await store.logHistory(id, "dedup_contradiction", null, null, null, null, null, { otherIds: ids.filter(x => x !== id), reason: g.reason });
        }
        contradictions++;
      }
      console.log(`Dedup: ${merged} merged | ${skipped} groups skipped | ${contradictions} contradictions logged`);
    }
  } catch (err) {
    llmErrors++;
    console.error("Dedup pass failed:", (err as Error).message.slice(0, 120));
  }

  // Build per-chatter profile cards — bounded to opted-in members by
  // buildProfiles itself, and to changed members by its hash gates.
  console.log("Building member profiles...");
  let profilesBuilt = 0;
  try {
    const profileStore = new ProfileStore();
    const profiles = await withRetry(() => profileStore.buildProfiles(guild.id, brain, store, eventStore, config.profileModel ?? BATCH_MODEL, { excludeIds: [botId] }));
    profilesBuilt = profiles.built;
    console.log(`Profiles: ${profiles.built} built | ${profiles.unchanged} unchanged | ${profiles.considered} considered`);
  } catch (err) {
    console.error("Profile build failed:", (err as Error).message.slice(0, 120));
  }

  return { total, archived, durableFound, batchCalls, memoriesSaved, relationshipsRecorded, eventsCreated, llmErrors, profilesBuilt };
}
