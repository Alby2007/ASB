import postgres from 'postgres';
import { MemoryStore } from '../src/database.ts';
import { EventStore } from '../src/events.ts';
import { ProfileStore } from '../src/profiles.ts';
import { guildBrain, requireGuildId } from './_lib.mjs';

const GUILD_ID = requireGuildId();
const sql = postgres(process.env.DATABASE_URL, { max: 1, onnotice: () => {} });

// MemoryStore.create() runs migrations — brings prod schema to v7.
const store = await MemoryStore.create();
const eventStore = new EventStore();
const brain = await guildBrain(store, GUILD_ID);

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
const result = await profileStore.buildProfiles(GUILD_ID, brain, store, eventStore, model);
console.log(`Profiles: ${result.built} built | ${result.unchanged} unchanged | ${result.considered} considered`);

const rows = await sql`SELECT subject_id, display_name, LEFT(summary, 120) AS bio FROM profiles WHERE guild_id = ${GUILD_ID} ORDER BY updated_at DESC`;
for (const r of rows) console.log(`- ${r.display_name} (${r.subject_id}): ${r.bio}`);

await sql.end();
process.exit(0);
