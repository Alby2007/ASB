import postgres from 'postgres';
import { MemoryStore } from '../src/database.ts';
import { ProfileStore } from '../src/profiles.ts';
import { EventStore } from '../src/events.ts';
import { shouldInspectForMemory } from '../src/perception.ts';
import { buildAliasMap, findMentionedUsers, resolveSubject } from '../src/entity-resolution.ts';
import { withRetry } from '../src/retry.ts';
import { guildBrain, botIdFromToken, requireGuildId } from './_lib.mjs';

// One-off backfill: relationship extraction over the archived messages.
// Persists ONLY relationship observations — the archive's memories were already
// extracted by the original ingest, and re-saving would create duplicate
// candidates (dedup is exact-string). Finishes by verifying the new
// observations, recomputing edges, and rebuilding profiles.
//
// Consent: an observation persists only when at least one of the two parties
// has opted in (same subject-consent rule persistExtraction applies live).

const GUILD_ID = requireGuildId();
const BATCH_SIZE = 5;
const DELAY_MS = 3000;
const MODEL = process.env.INGEST_MODEL ?? 'qwen/qwen3.8-27b';
const VERIFY = process.env.VERIFY_MODEL ?? 'qwen/qwen3.8-27b';

const sql = postgres(process.env.DATABASE_URL, { max: 1, onnotice: () => {} });
const store = await MemoryStore.create();
const brain = await guildBrain(store, GUILD_ID);
const botId = botIdFromToken();

const aliasMap = await buildAliasMap(GUILD_ID, store);
const rows = await sql`
  SELECT id, guild_id, channel_id, author_id, author_name, content, created_at
  FROM messages WHERE guild_id = ${GUILD_ID} ORDER BY created_at
`;

const consentCache = new Map();
async function consented(userId) {
  if (!consentCache.has(userId)) {
    const m = await store.getMember(GUILD_ID, userId);
    consentCache.set(userId, !!m?.optedIn && !m.optedOut);
  }
  return consentCache.get(userId);
}

// Gate: socially-dense messages only — @mentions, name references, durable cues
const flagged = rows.filter(r =>
  r.content.includes('<@') ||
  findMentionedUsers(r.content, aliasMap).length > 0 ||
  shouldInspectForMemory({ content: r.content })
);
console.log(`${rows.length} messages, ${flagged.length} pass the social gate (~${Math.ceil(flagged.length / BATCH_SIZE)} LLM calls, model ${MODEL})`);

let observations = 0, skippedConsent = 0, errors = 0;
for (let i = 0; i < flagged.length; i += BATCH_SIZE) {
  const batch = flagged.slice(i, i + BATCH_SIZE).map(r => ({
    event: {
      guildId: r.guild_id, channelId: r.channel_id, messageId: r.id,
      authorId: r.author_id, authorName: r.author_name,
      content: r.content, createdAt: new Date(r.created_at), mentionsBot: r.content.includes(`<@${botId}>`),
    },
  }));
  try {
    const results = await withRetry(() => brain.extractMemoriesBatch(batch, MODEL));
    for (const item of batch) {
      const result = results.get(item.event.messageId) ?? { memories: [], relationships: [] };
      for (const rel of result.relationships) {
        const subjectId = rel.subjectName ? resolveSubject({ subjectName: rel.subjectName }, aliasMap, item.event) : item.event.authorId;
        const otherId = resolveSubject({ subjectName: rel.otherName }, aliasMap, item.event);
        if (!(await consented(subjectId)) && !(await consented(otherId))) { skippedConsent++; continue; }
        if (await store.recordRelationship(item.event.guildId, subjectId, otherId, item.event.messageId, rel.nature, rel.valence, rel.reason ?? '')) {
          observations++;
        }
      }
    }
  } catch (err) {
    errors++;
    console.error(`  [batch error at ${i}] ${err.message.slice(0, 120)}`);
  }
  if ((i / BATCH_SIZE) % 10 === 0) console.log(`  ${Math.min(i + BATCH_SIZE, flagged.length)}/${flagged.length} | ${observations} observations`);
  await new Promise(x => setTimeout(x, DELAY_MS));
}

// Verify the new observations — jokes are excluded from the edge roll-up.
console.log('Verifying observations...');
let judged = 0;
const unverified = await store.listUnverifiedObservations(GUILD_ID, 500);
for (let i = 0; i < unverified.length; i += 10) {
  const batch = unverified.slice(i, i + 10);
  const items = await Promise.all(batch.map(async b => ({
    observationId: b.observationId, authorName: b.authorName, authorNames: b.authorNames,
    nature: b.nature, otherName: await store.displayNameFor(GUILD_ID, b.otherId),
    sourceMessage: b.sourceMessage, contextBefore: b.contextBefore,
  })));
  try {
    const verdicts = await withRetry(() => brain.verifyRelationshipsBatch(items, VERIFY));
    for (const b of batch) {
      const v = verdicts.get(b.observationId);
      if (v) { await store.setObservationVerdict(b.observationId, v.verdict); judged++; }
    }
  } catch (err) {
    console.error(`  [verify error at ${i}] ${err.message.slice(0, 120)}`);
  }
  await new Promise(x => setTimeout(x, DELAY_MS));
}
const edges = await store.recomputeEdges(GUILD_ID);
console.log(`Verified ${judged}/${unverified.length} observations; ${edges} edges recomputed`);

// Rebuild profiles so relationship_map picks up the new edges + interactions.
console.log('Rebuilding profiles...');
const profileStore = new ProfileStore();
const eventStore = new EventStore();
const res = await profileStore.buildProfiles(GUILD_ID, brain, store, eventStore, process.env.PROFILE_MODEL, { excludeIds: [botId] });
console.log(`Profiles: ${res.built} rebuilt, ${res.unchanged} unchanged`);

console.log(`Done. ${observations} observations | ${skippedConsent} skipped (no consent) | ${edges} edges | ${errors} errors`);
await sql.end();
process.exit(0);
