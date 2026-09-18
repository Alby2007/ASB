import 'dotenv/config';
import { MemoryStore } from '../src/database.ts';
import { createBrainResolver } from '../src/brains.ts';
import { registerSecret } from '../src/secrets.ts';

// Shared setup for ops scripts.
//
// Secrets: register env credentials up front so logError/redactSecrets scrub
// them if a script ever prints an SDK error object.
// Brains: every script resolves through the same BYOK resolver the bot runs —
// a guild's own key when /setup stored one, env key otherwise, and nothing at
// all when REQUIRE_GUILD_KEYS=1 has no guild key. No script may bypass the
// resolver with a raw `new Brain(env key)`.

registerSecret(process.env.DISCORD_TOKEN);
registerSecret(process.env.DATABASE_URL);
registerSecret(process.env.GROQ_API_KEY);
registerSecret(process.env.VISION_API_KEY);
registerSecret(process.env.KEY_ENCRYPTION_SECRET);

export const GUILD_ID = process.env.GUILD_ID;

export function requireGuildId() {
  if (!GUILD_ID) {
    console.error('GUILD_ID is not set — ops scripts are guild-scoped by design');
    process.exit(1);
  }
  return GUILD_ID;
}

export async function guildBrain(store, guildId) {
  const { brainFor } = createBrainResolver({
    getKey: gid => store.getGuildKey(gid),
    envKey: process.env.GROQ_API_KEY ?? '',
    envModel: process.env.GROQ_MODEL ?? 'openai/gpt-oss-120b',
    envBaseUrl: process.env.GROQ_BASE_URL ?? 'https://api.groq.com/openai/v1',
    requireGuildKeys: process.env.REQUIRE_GUILD_KEYS === '1',
  });
  const brain = await brainFor(guildId);
  if (!brain) {
    throw new Error(`no LLM key resolves for guild ${guildId} — run /setup in Discord or set GROQ_API_KEY`);
  }
  return brain;
}

/** The bot's own Discord user id, decoded from the token's first segment. */
export function botIdFromToken() {
  const token = process.env.DISCORD_TOKEN;
  if (!token) throw new Error('DISCORD_TOKEN is not set');
  const id = Buffer.from(token.split('.')[0], 'base64').toString();
  if (!/^\d+$/.test(id)) throw new Error('could not derive bot id from DISCORD_TOKEN');
  return id;
}
