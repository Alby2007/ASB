import "dotenv/config";
import { Client, GatewayIntentBits, type Message } from "discord.js";
import { Brain } from "./brain.js";
import { config } from "./config.js";
import { MemoryStore } from "./database.js";
import { EventStore } from "./events.js";
import { EventPipeline } from "./event-detection.js";
import { detectNamingRequest, detectSelfNaming, shouldInspectForMemory } from "./perception.js";
import { runContestCheck } from "./contest.js";
import { ProfileStore } from "./profiles.js";
import { buildAliasMap, resolveSubject } from "./entity-resolution.js";
import { sleep, withRetry } from "./retry.js";
import type { MessageEvent } from "./types.js";

// ── Config ────────────────────────────────────────────────────────────────────
const CHANNEL_NAME = config.ingestChannel;
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



const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
const brain = new Brain(config.groqKey, config.model, config.groqBaseUrl);
const pipeline = new EventPipeline();

let store: MemoryStore;
let eventStore: EventStore;

let total = 0, archived = 0, batchCalls = 0, memoriesSaved = 0, eventsCreated = 0, llmErrors = 0, relationshipsRecorded = 0;



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

/** Archive all messages. Returns the extraction queue (regex pass, no evidence)
 * and the triage queue (regex fail, no evidence, not yet triaged). */
async function archiveAndFilter(msgs: RawMsg[]): Promise<{ toExtract: ExtractItem[]; toTriage: ExtractItem[] }> {
  const toExtract: ExtractItem[] = [];
  const toTriage: ExtractItem[] = [];
  // One query for all existing triage marks instead of per-message lookups
  const triaged = await store.getTriageResults(msgs.map(m => m.id));
  const regexMarked: Array<{ id: string; result: string }> = [];

  for (const msg of msgs) {
    if (msg.author.bot || !msg.content.trim()) continue;
    total++;
    const event = toEvent(msg);
    const replyToId = msg.reference?.messageId ?? undefined;
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

client.once("ready", async () => {
  store = await MemoryStore.create();
  eventStore = new EventStore();

  const guild = client.guilds.cache.get(config.guildId!);
  if (!guild) { console.error("Guild not found"); process.exit(1); }

  const channel = guild.channels.cache.find(c => c.name === CHANNEL_NAME && c.type === 0);
  if (!channel) { console.error(`Channel "${CHANNEL_NAME}" not found`); process.exit(1); }
  if (channel.type !== 0) { console.error("Channel is not a text channel"); process.exit(1); }

  console.log(`Fetching #${CHANNEL_NAME} history...`);

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
  let durableFound = 0;
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
  // can resolve names like "Starz" to real user IDs throughout extraction.
  const aliasMap = await buildAliasMap(guild.id, store);
  // userId → known display names, for the pasted/echoed self-naming guard
  const members = await store.listMembers(guild.id);
  const memberNames = new Map(members.map(m => [m.userId, m.knownNames]));
  // Opted-out members get no memories or relationship observations, same as live.
  const optedOut = new Set(members.filter(m => m.optedOut).map(m => m.userId));

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
        const ids: number[] = [];
        for (const memory of result.memories) {
          memory.subjectId = resolveSubject(memory, aliasMap, item.event);
          if (optedOut.has(memory.subjectId)) continue;
          if (memory.subjectId === "unknown" && memory.subjectName) {
            await store.logUnresolvedName(item.event.guildId, memory.subjectName, item.event.messageId);
          }
          const saved = await store.saveMemory(item.event, memory, config.candidateConfidenceThreshold);
          ids.push(saved.id);
          memoriesSaved++;
        }
        for (const rel of result.relationships) {
          const subjectId = rel.subjectName ? resolveSubject({ subjectName: rel.subjectName }, aliasMap, item.event) : item.event.authorId;
          const otherId = resolveSubject({ subjectName: rel.otherName }, aliasMap, item.event);
          if (optedOut.has(subjectId) || optedOut.has(otherId)) continue;
          if (subjectId === "unknown" && rel.subjectName) await store.logUnresolvedName(item.event.guildId, rel.subjectName, item.event.messageId);
          if (otherId === "unknown" && rel.otherName) await store.logUnresolvedName(item.event.guildId, rel.otherName, item.event.messageId);
          // Don't record edges to "unknown" — they'd smear whoever later claims that slot.
          if (subjectId === "unknown" || otherId === "unknown") continue;
          if (await store.recordRelationship(item.event.guildId, subjectId, otherId, item.event.messageId, rel.nature, rel.valence, rel.reason ?? "")) {
            relationshipsRecorded++;
          }
        }
        savedIdsByMessage.set(item.event.messageId, ids);
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
  const result = await pipeline.maintainEvents(guild.id, eventStore, store, brain);
  console.log(`Maintenance: closed=${result.closed} promoted=${result.promoted} discarded=${result.discarded}`);

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
    const botId = client.user!.id;
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
    const members = await store.listDedupCandidates(guild.id);
    if (members.length) {
      let index = 0;
      const idByIndex = new Map<number, number>();
      const indexed = members.map(m => ({
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

  // Build per-chatter profile cards (bounded: one LLM call per changed member)
  console.log("Building member profiles...");
  try {
    const profileStore = new ProfileStore();
    const profiles = await withRetry(() => profileStore.buildProfiles(guild.id, brain, store, eventStore, config.profileModel ?? BATCH_MODEL, { excludeIds: [client.user!.id] }));
    console.log(`Profiles: ${profiles.built} built | ${profiles.unchanged} unchanged | ${profiles.considered} considered`);
  } catch (err) {
    console.error("Profile build failed:", (err as Error).message.slice(0, 120));
  }

  process.exit(0);
});

client.login(config.discordToken);
