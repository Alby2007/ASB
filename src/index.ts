import { Client, Events, GatewayIntentBits } from "discord.js";
import { Brain } from "./brain.js";
import { config } from "./config.js";
import { MemoryStore } from "./database.js";
import { commandDefinitions, handleMemoryButton, handleMemoryCommand } from "./commands.js";
import { shouldInspectForMemory } from "./perception.js";
import { EventStore } from "./events.js";
import { EventPipeline } from "./event-detection.js";
import type { MessageEvent } from "./types.js";

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
const store = new MemoryStore();
const eventStore = new EventStore(store.db);
const brain = new Brain(config.groqKey, config.model, config.groqBaseUrl);
const pipeline = new EventPipeline();
const botActivity = new Map<string, number>();

client.once(Events.ClientReady, async ready => {
  if (config.guildId) await ready.application.commands.set(commandDefinitions, config.guildId);
  else await ready.application.commands.set(commandDefinitions);
  applyRetention();
  console.log(`ASM online as ${ready.user.tag}`);
});

async function applyRetention() {
  for (const guild of client.guilds.cache.values()) {
    const settings = store.settings(guild.id, config.rawMessageRetentionDays);
    const deleted = store.deleteRawMessagesOlderThan(guild.id, settings.rawRetentionDays);
    store.maintain(guild.id, config.candidateConfidenceThreshold);
    if (deleted) console.log(`Retention deleted ${deleted} raw messages in ${guild.name}`);
    // v0.2: close stale open event windows and score candidate events
    try {
      const result = await pipeline.maintainEvents(guild.id, eventStore, store, brain);
      if (result.closed || result.promoted || result.discarded) {
        console.log(`Events maintained in ${guild.name}: closed=${result.closed} promoted=${result.promoted} discarded=${result.discarded}`);
      }
    } catch (error) { console.error("Event maintenance failed", error); }
  }
}
setInterval(applyRetention, 24 * 60 * 60 * 1000).unref();

client.on(Events.InteractionCreate, async interaction => {
  if (interaction.isChatInputCommand()) await handleMemoryCommand(interaction, store, brain, eventStore);
  if (interaction.isButton()) await handleMemoryButton(interaction, store);
});

client.on(Events.MessageCreate, async message => {
  console.log(`[debug] MessageCreate fired — guild=${message.guild?.id} author=${message.author?.username} content=${message.content?.slice(0,50)}`);
  if (!message.guild || message.author.bot || !message.content.trim()) return;
  if (config.guildId && message.guild.id !== config.guildId) return;
  const event: MessageEvent = {
    guildId: message.guild.id, channelId: message.channel.id, messageId: message.id,
    authorId: message.author.id, authorName: message.member?.displayName ?? message.author.username,
    content: message.content, createdAt: message.createdAt, mentionsBot: message.mentions.has(client.user!),
  };
  const settings = store.settings(event.guildId, config.rawMessageRetentionDays);
  store.recordMessage(event);
  const savedMemoryIds: number[] = [];
  // Resolve reply context so the LLM knows what the message is responding to
  const replyToId = message.reference?.messageId ?? undefined;
  let replyToContent: string | undefined;
  if (replyToId) {
    const ref = store.getMessage(replyToId);
    if (ref) replyToContent = `${ref.authorName}: ${ref.content}`;
  }
  if (settings.memoryEnabled && shouldInspectForMemory(event)) {
    try {
      const candidates = await brain.extractMemories(event, replyToContent);
      candidates.forEach(memory => {
        const saved = store.saveMemory(event, memory, config.candidateConfidenceThreshold);
        savedMemoryIds.push(saved.id);
      });
    } catch (error) { console.error("Memory extraction failed", error); }
  }
  // v0.2: event detection pipeline (runs regardless of whether memories were extracted,
  // so back-references and reply chains are tracked even for ordinary messages)
  if (settings.memoryEnabled) {
    try {
      await pipeline.process(event, savedMemoryIds, eventStore, store, brain, replyToId);
    } catch (error) { console.error("Event pipeline failed", error); }
  }

  const key = `${event.guildId}:${event.channelId}`;
  const lastSpoke = botActivity.get(key) ?? 0;
  const recentBotMessages = Date.now() - lastSpoke < 120_000 ? 1 : 0;
  const decision = brain.decide(event, recentBotMessages);
  if (!settings.replyEnabled || !decision.shouldSpeak || decision.score < config.speakThreshold) return;
  try {
    await message.channel.sendTyping();
    const reply = await brain.reply(event, store.recentContext(event.guildId, event.channelId), store.relevantMemories(event.guildId, event.authorId));
    if (reply) { await message.reply({ content: reply, allowedMentions: { repliedUser: false } }); botActivity.set(key, Date.now()); }
  } catch (error) { console.error("Reply generation failed", error); }
});

client.login(config.discordToken);
