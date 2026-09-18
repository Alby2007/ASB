import "dotenv/config";
import { Client, GatewayIntentBits } from "discord.js";
import { config } from "./config.js";
import { MemoryStore } from "./database.js";
import { EventStore } from "./events.js";
import { EventPipeline } from "./event-detection.js";
import { createBrainResolver, guardedLlmFetch } from "./brains.js";
import { validateLlmKey } from "./secrets.js";
import { runServerIngest } from "./server-ingest.js";

// CLI entry for the server-level historical build. The work itself lives in
// server-ingest.ts so /server-build can run the identical routine in-process.
const CHANNEL_NAME = config.ingestChannel;

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
const pipeline = new EventPipeline();

client.once("ready", async () => {
  const store = await MemoryStore.create();
  const eventStore = new EventStore();
  const { brainFor } = createBrainResolver({
    getKey: guildId => store.getGuildKey(guildId),
    envKey: config.groqKey, envModel: config.model, envBaseUrl: config.groqBaseUrl,
    requireGuildKeys: config.requireGuildKeys,
    markValidated: guildId => store.markGuildKeyValidated(guildId),
    revalidate: async (key, baseUrl) => (await validateLlmKey(key, baseUrl, guardedLlmFetch)).ok,
  });

  const guild = client.guilds.cache.get(config.guildId!);
  if (!guild) { console.error("Guild not found"); process.exit(1); }

  const brain = await brainFor(guild.id);
  if (!brain) { console.error("No LLM key configured for this guild — run /setup in Discord or set GROQ_API_KEY"); process.exit(1); }

  const channel = guild.channels.cache.find(c => c.name === CHANNEL_NAME && c.type === 0);
  if (!channel) { console.error(`Channel "${CHANNEL_NAME}" not found`); process.exit(1); }
  if (channel.type !== 0) { console.error("Channel is not a text channel"); process.exit(1); }

  await runServerIngest(channel, { store, eventStore, brain, pipeline, botId: client.user!.id });
  process.exit(0);
});

client.login(config.discordToken);
