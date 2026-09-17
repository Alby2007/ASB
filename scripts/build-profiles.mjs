import 'dotenv/config';
import { sql } from './src/db.ts';
import { MemoryStore } from './src/database.ts';
import { EventStore } from './src/events.ts';
import { Brain } from './src/brain.ts';
import { ProfileStore } from './src/profiles.ts';

const guildId = process.env.GUILD_ID;

// MemoryStore.create() runs migrations — brings prod schema to v7.
const store = await MemoryStore.create();
const eventStore = new EventStore();
const brain = new Brain(process.env.GROQ_API_KEY, process.env.GROQ_MODEL, process.env.GROQ_BASE_URL ?? 'https://api.groq.com/openai/v1');

// Backfill the member registry from the pre-v7 message archive — produces the
// same rows recordMessage()/upsertMember() would have written.
const backfilled = await sql`
  INSERT INTO members (guild_id, user_id, known_names, first_seen_at, last_seen_at, message_count)
  SELECT guild_id, author_id,
         ARRAY_AGG(DISTINCT author_name),
         MIN(created_at), MAX(created_at), COUNT(*)::int
  FROM messages
  GROUP BY guild_id, author_id
  ON CONFLICT (guild_id, user_id) DO NOTHING
`;
console.log(`members backfilled: ${backfilled.count}`);

const profileStore = new ProfileStore();
const model = process.env.PROFILE_MODEL ?? process.env.INGEST_MODEL ?? 'qwen/qwen3.8-27b';
console.log(`building profiles (model: ${model})...`);
const result = await profileStore.buildProfiles(guildId, brain, store, eventStore, model);
console.log(`Profiles: ${result.built} built | ${result.unchanged} unchanged | ${result.considered} considered`);

const rows = await sql`SELECT subject_id, display_name, LEFT(summary, 120) AS bio FROM profiles WHERE guild_id = ${guildId} ORDER BY updated_at DESC`;
for (const r of rows) console.log(`- ${r.display_name} (${r.subject_id}): ${r.bio}`);

process.exit(0);
