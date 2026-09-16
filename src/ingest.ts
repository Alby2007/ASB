import "dotenv/config";
import { Client, GatewayIntentBits, type Message } from "discord.js";
import { Brain } from "./brain.js";
import { config } from "./config.js";
import { MemoryStore } from "./database.js";
import { EventStore } from "./events.js";
import { EventPipeline } from "./event-detection.js";
import { shouldInspectForMemory } from "./perception.js";
import type { MessageEvent } from "./types.js";

// ── Config ────────────────────────────────────────────────────────────────────
const CHANNEL_NAME = process.env.INGEST_CHANNEL ?? "general-chat";
const DISCORD_BATCH_SIZE = 100;     // Discord API max per fetch
const LLM_BATCH_SIZE = 5;           // Messages per LLM call (batched extraction)
// llama-4-scout has 30K TPM — 3.75x headroom vs gpt-oss-20b. At ~1500 tokens per 5-msg batch we
// can safely fire a call every 3s without hitting the per-minute token ceiling.
const BATCH_MODEL = process.env.INGEST_MODEL ?? "meta-llama/llama-4-scout-17b-16e-instruct";
const BATCH_DELAY_MS = 3000;        // Delay between batch LLM calls
const EVENT_DELAY_MS = 3000;        // Pipeline LLM calls get the same pacing

async function withRetry<T>(fn: () => Promise<T>, retries = 6): Promise<T> {
  for (let i = 0; i < retries; i++) {
    try { return await fn(); } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes("429") && i < retries - 1) {
        const headers = (err as { headers?: Headers }).headers;
        const tokenReset = headers?.get("x-ratelimit-reset-tokens");
        const retryAfter = headers?.get("retry-after");
        const wait = tokenReset
          ? Math.ceil(parseFloat(tokenReset) * 1000) + 1000
          : retryAfter ? parseInt(retryAfter) * 1000 + 1000 : (i + 1) * 30_000;
        console.log(`  [429] rate limit — waiting ${(wait / 1000).toFixed(1)}s...`);
        await sleep(wait);
      } else throw err;
    }
  }
  throw new Error("exhausted retries");
}

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
const brain = new Brain(config.groqKey, config.model, config.groqBaseUrl);
const pipeline = new EventPipeline();

let store: MemoryStore;
let eventStore: EventStore;

let total = 0, archived = 0, batchCalls = 0, memoriesSaved = 0, eventsCreated = 0, llmErrors = 0;

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

type RawMsg = { id: string; author: { id: string; bot: boolean; username: string; displayName?: string }; member?: { displayName?: string } | null; content: string; createdAt: Date; reference?: { messageId?: string | null } | null; channel: { id: string }; guild: { id: string } };

function toEvent(msg: RawMsg): MessageEvent {
  return {
    guildId: msg.guild.id, channelId: msg.channel.id, messageId: msg.id,
    authorId: msg.author.id,
    authorName: msg.member?.displayName ?? msg.author.username,
    content: msg.content, createdAt: msg.createdAt, mentionsBot: false,
  };
}

/** Archive all messages and return those that need memory extraction (passed pre-filter, not already processed). */
async function archiveAndFilter(msgs: RawMsg[]): Promise<Array<{ event: MessageEvent; replyToId?: string; replyToContent?: string }>> {
  const toExtract: Array<{ event: MessageEvent; replyToId?: string; replyToContent?: string }> = [];
  for (const msg of msgs) {
    if (msg.author.bot || !msg.content.trim()) continue;
    total++;
    const event = toEvent(msg);
    await store.recordMessage(event);
    archived++;

    const replyToId = msg.reference?.messageId ?? undefined;
    if (shouldInspectForMemory(event) && !(await store.hasEvidence(msg.id))) {
      let replyToContent: string | undefined;
      if (replyToId) {
        const ref = await store.getMessage(replyToId);
        if (ref) replyToContent = `${ref.authorName}: ${ref.content}`;
      }
      toExtract.push({ event, replyToId, replyToContent });
    }
  }
  return toExtract;
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

  // ── Step 1: archive all messages + collect those that need extraction ────────
  const toExtract = await archiveAndFilter(backlog as Parameters<typeof archiveAndFilter>[0]);
  console.log(`  archived ${archived} | ${toExtract.length} messages need memory extraction`);

  // ── Step 2: batch extraction — LLM_BATCH_SIZE messages per call ─────────────
  // Map messageId → saved memory IDs so the event pipeline can link them
  const savedIdsByMessage = new Map<string, number[]>();

  for (let i = 0; i < toExtract.length; i += LLM_BATCH_SIZE) {
    const batch = toExtract.slice(i, i + LLM_BATCH_SIZE);
    batchCalls++;
    try {
      const results = await withRetry(() => brain.extractMemoriesBatch(batch, BATCH_MODEL));
      for (const item of batch) {
        const candidates = results.get(item.event.messageId) ?? [];
        const ids: number[] = [];
        for (const memory of candidates) {
          const saved = await store.saveMemory(item.event, memory, config.candidateConfidenceThreshold);
          ids.push(saved.id);
          memoriesSaved++;
        }
        savedIdsByMessage.set(item.event.messageId, ids);
      }
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

  console.log(`\nDone. ${total} total | ${archived} archived | ${batchCalls} batch calls | ${memoriesSaved} memories | ${eventsCreated} candidate events | ${llmErrors} LLM errors`);

  // Run event maintenance to close open windows and score candidates
  console.log("Running event maintenance...");
  const result = await pipeline.maintainEvents(guild.id, eventStore, store, brain);
  console.log(`Maintenance: closed=${result.closed} promoted=${result.promoted} discarded=${result.discarded}`);

  process.exit(0);
});

client.login(config.discordToken);
