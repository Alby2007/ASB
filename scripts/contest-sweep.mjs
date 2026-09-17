import 'dotenv/config';
import postgres from 'postgres';
import { MemoryStore } from './src/database.ts';
import { Brain } from './src/brain.ts';
import { runContestCheck } from './src/contest.ts';
import { botMemoryCue, contestCue } from './src/perception.ts';

// Retroactive contest sweep over the archived messages: finds bot-addressed
// denial/correction messages and applies them as evidence on the author's
// memories. The bot's own messages aren't archived, so the trigger is the
// <@BOT_ID> mention in the human's message.

const sql = postgres(process.env.DATABASE_URL, { max: 1, onnotice: () => {} });
const store = await MemoryStore.create();
const brain = new Brain(process.env.GROQ_API_KEY, process.env.GROQ_MODEL, process.env.GROQ_BASE_URL ?? 'https://api.groq.com/openai/v1');
const model = process.env.CONTEST_MODEL ?? process.env.VERIFY_MODEL ?? process.env.INGEST_MODEL ?? 'qwen/qwen3.8-27b';

// Bot user id is embedded in the token's first segment
const botId = Buffer.from(process.env.DISCORD_TOKEN.split('.')[0], 'base64').toString();
console.log(`bot id: ${botId}`);

const rows = await sql`
  SELECT id, guild_id, channel_id, author_id, author_name, content, created_at
  FROM messages
  WHERE guild_id = ${process.env.GUILD_ID}
  ORDER BY created_at
`;

const flagged = rows.filter(r =>
  contestCue(r.content) &&
  (r.content.includes(`<@${botId}>`) || r.content.includes(`<@!${botId}>`) || botMemoryCue(r.content))
);
console.log(`${rows.length} messages scanned, ${flagged.length} with bot-addressed contest cues`);

let contests = 0, confirms = 0, errors = 0;
for (const r of flagged) {
  const event = {
    guildId: r.guild_id, channelId: r.channel_id, messageId: r.id,
    authorId: r.author_id, authorName: r.author_name,
    content: r.content, createdAt: new Date(r.created_at), mentionsBot: true,
  };
  try {
    const mems = await store.contestableMemories(event.guildId, event.authorId);
    const rels = mems.length ? await brain.detectContest(event, mems.map(m => ({ id: m.id, content: m.content, status: m.status })), model) : [];
    console.log(`  ${r.author_name}: "${r.content.slice(0, 60)}" → rels: ${JSON.stringify(rels)}`);
    const res = await runContestCheck(event, brain, store, botId, model);
    contests += res.contests; confirms += res.confirms;
    const m = await store.getMemory(event.guildId, 43);
    console.log(`    applied: ${res.contests} contests, ${res.confirms} confirms | #43 → ${m.status}@${m.confidence}`);
    await new Promise(x => setTimeout(x, 2000));
  } catch (err) {
    errors++;
    console.error(`  [error] ${r.id}: ${err.message.slice(0, 120)}`);
  }
}

console.log(`Done. ${contests} contested | ${confirms} confirmed | ${errors} errors`);
await sql.end();
process.exit(0);
