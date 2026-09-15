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
const BATCH_SIZE = 100;            // Discord API max per fetch
const LLM_DELAY_MS = 8000;         // ~7.5 RPM — well under Groq's token limit
const EVENT_DELAY_MS = 8000;       // Same — pipeline can trigger assessContinuity LLM calls

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
const store = new MemoryStore();
const eventStore = new EventStore(store.db);
const brain = new Brain(config.groqKey, config.model, config.groqBaseUrl);
const pipeline = new EventPipeline();

let total = 0, archived = 0, memoryCalls = 0, memoriesSaved = 0, eventsCreated = 0, llmErrors = 0;

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function processMessage(msg: { id: string; author: { id: string; bot: boolean; username: string; displayName?: string }; member?: { displayName?: string } | null; content: string; createdAt: Date; reference?: { messageId?: string | null } | null; channel: { id: string }; guild: { id: string } }) {
  if (msg.author.bot || !msg.content.trim()) return;
  total++;

  const event: MessageEvent = {
    guildId: msg.guild.id, channelId: msg.channel.id, messageId: msg.id,
    authorId: msg.author.id,
    authorName: msg.member?.displayName ?? msg.author.username,
    content: msg.content, createdAt: msg.createdAt, mentionsBot: false,
  };

  store.recordMessage(event);
  archived++;

  const savedMemoryIds: number[] = [];
  const replyToId = msg.reference?.messageId ?? undefined;
  // On re-ingest, skip messages that already produced evidence — avoids re-spending tokens
  const alreadyProcessed = store.db.prepare("SELECT COUNT(*) as c FROM memory_evidence WHERE message_id = ?").get(msg.id) as { c: number };
  if (shouldInspectForMemory(event) && alreadyProcessed.c === 0) {
    memoryCalls++;
    // Resolve reply context so the LLM can see what this message is responding to
    let replyToContent: string | undefined;
    if (replyToId) {
      const ref = store.getMessage(replyToId);
      if (ref) replyToContent = `${ref.authorName}: ${ref.content}`;
    }
    try {
      const candidates = await withRetry(() => brain.extractMemories(event, replyToContent));
      for (const memory of candidates) {
        const saved = store.saveMemory(event, memory, config.candidateConfidenceThreshold);
        savedMemoryIds.push(saved.id);
        memoriesSaved++;
      }
    } catch (err) {
      llmErrors++;
      console.error(`  [memory extraction error] msg ${msg.id}:`, (err as Error).message.slice(0, 100));
    }
    await sleep(LLM_DELAY_MS);
  }

  try {
    const before = eventStore.listEvents(msg.guild.id, { tier: "candidate" }).total;
    const llmUsed = await withRetry(() => pipeline.process(event, savedMemoryIds, eventStore, store, brain, replyToId));
    const after = eventStore.listEvents(msg.guild.id, { tier: "candidate" }).total;
    if (after > before) eventsCreated++;
    // Only pace when an LLM call was actually made — heuristic-only messages are free
    if (llmUsed) await sleep(EVENT_DELAY_MS);
  } catch (err) {
    console.error(`  [event pipeline error] msg ${msg.id}:`, (err as Error).message.slice(0, 100));
  }
}

client.once("ready", async () => {
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
    const options: { limit: number; before?: string } = { limit: BATCH_SIZE };
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
    lastId = oldest.id; // before= paginates backwards from the oldest message seen
    console.log(`  fetched ${backlog.length} messages...`);
  }

  backlog.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
  console.log(`Ingesting ${backlog.length} messages (oldest→newest)...`);

  for (const msg of backlog) {
    await processMessage(msg as Parameters<typeof processMessage>[0]);
    if (total % 100 === 0) {
      console.log(`  ${total} messages processed | ${archived} archived | ${memoriesSaved} memories | ${eventsCreated} events | ${llmErrors} errors`);
    }
  }

  console.log(`\nDone. ${total} total | ${archived} archived | ${memoriesSaved} memories | ${eventsCreated} candidate events | ${llmErrors} LLM errors`);

  // Run event maintenance to close open windows and score candidates
  console.log("Running event maintenance...");
  const result = await pipeline.maintainEvents(guild.id, eventStore, store, brain);
  console.log(`Maintenance: closed=${result.closed} promoted=${result.promoted} discarded=${result.discarded}`);

  process.exit(0);
});

client.login(config.discordToken);
