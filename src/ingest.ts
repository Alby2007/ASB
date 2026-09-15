import "dotenv/config";
import { Client, GatewayIntentBits } from "discord.js";
import { Brain } from "./brain.js";
import { config } from "./config.js";
import { MemoryStore } from "./database.js";
import { EventStore } from "./events.js";
import { EventPipeline } from "./event-detection.js";
import { shouldInspectForMemory } from "./perception.js";
import type { MessageEvent } from "./types.js";

// ── Config ────────────────────────────────────────────────────────────────────
const CHANNEL_NAME = "general-chat";
const BATCH_SIZE = 100;            // Discord API max per fetch
const LLM_DELAY_MS = 2200;         // ~27 RPM — safe under Groq's 30 RPM free tier
const EVENT_DELAY_MS = 200;        // Small pause between event pipeline calls

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
  if (shouldInspectForMemory(event)) {
    memoryCalls++;
    // Resolve reply context so the LLM can see what this message is responding to
    let replyToContent: string | undefined;
    if (replyToId) {
      const ref = store.getMessage(replyToId);
      if (ref) replyToContent = `${ref.authorName}: ${ref.content}`;
    }
    try {
      const candidates = await brain.extractMemories(event, replyToContent);
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
    await pipeline.process(event, savedMemoryIds, eventStore, store, brain, replyToId);
    const after = eventStore.listEvents(msg.guild.id, { tier: "candidate" }).total;
    if (after > before) eventsCreated++;
  } catch (err) {
    console.error(`  [event pipeline error] msg ${msg.id}:`, (err as Error).message.slice(0, 100));
  }
  await sleep(EVENT_DELAY_MS);
}

client.once("ready", async () => {
  const guild = client.guilds.cache.get(config.guildId!);
  if (!guild) { console.error("Guild not found"); process.exit(1); }

  const channel = guild.channels.cache.find(c => c.name === CHANNEL_NAME && c.type === 0);
  if (!channel) { console.error(`Channel "${CHANNEL_NAME}" not found`); process.exit(1); }
  if (channel.type !== 0) { console.error("Channel is not a text channel"); process.exit(1); }

  console.log(`Ingesting #${CHANNEL_NAME}...`);
  let lastId: string | undefined;
  let done = false;

  while (!done) {
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

    if (batch.size === 0) { done = true; break; }

    // Sort oldest→newest so events build chronologically
    const sorted = [...batch.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
    for (const msg of sorted) {
      await processMessage(msg as Parameters<typeof processMessage>[0]);
      if (total % 100 === 0) {
        console.log(`  ${total} messages processed | ${archived} archived | ${memoriesSaved} memories | ${eventsCreated} events | ${llmErrors} errors`);
      }
    }
    lastId = sorted[0].id; // oldest message id for next batch (before= pagination)
  }

  console.log(`\nDone. ${total} total | ${archived} archived | ${memoriesSaved} memories | ${eventsCreated} candidate events | ${llmErrors} LLM errors`);

  // Run event maintenance to close open windows and score candidates
  console.log("Running event maintenance...");
  const result = await pipeline.maintainEvents(guild.id, eventStore, store, brain);
  console.log(`Maintenance: closed=${result.closed} promoted=${result.promoted} discarded=${result.discarded}`);

  process.exit(0);
});

client.login(config.discordToken);
