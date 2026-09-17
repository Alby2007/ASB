import 'dotenv/config';
import { MemoryStore } from './src/database.ts';
import { Brain } from './src/brain.ts';

const store = await MemoryStore.create();
const brain = new Brain(process.env.GROQ_API_KEY, process.env.GROQ_MODEL, process.env.GROQ_BASE_URL ?? 'https://api.groq.com/openai/v1');
const model = process.env.VERIFY_MODEL ?? process.env.INGEST_MODEL ?? 'qwen/qwen3.8-27b';
const BATCH = 5;
const DELAY_MS = 2000;

async function withRetry(fn, retries = 4) {
  for (let i = 0; i < retries; i++) {
    try { return await fn(); } catch (err) {
      if (err.message.includes('429') && i < retries - 1) {
        const wait = (i + 1) * 30_000;
        console.log(`  [429] waiting ${wait / 1000}s...`);
        await new Promise(r => setTimeout(r, wait));
      } else throw err;
    }
  }
}

const items = await store.listVerifiableCandidates(process.env.GUILD_ID);
console.log(`verifying ${items.length} candidates (model: ${model})...`);

let promoted = 0, flagged = 0, unchanged = 0;
for (let i = 0; i < items.length; i += BATCH) {
  const batch = items.slice(i, i + BATCH);
  try {
    const verdicts = await withRetry(() => brain.verifyMemoriesBatch(
      batch.map(b => ({ memoryId: b.memoryId, authorName: b.authorName, authorNames: b.authorNames, claim: b.content, sourceMessage: b.sourceMessage, contextBefore: b.contextBefore })),
      model
    ));
    for (const b of batch) {
      const v = verdicts.get(b.memoryId) ?? { verdict: 'unclear', reason: 'omitted' };
      const r = await store.applyVerification(b.memoryId, v.verdict, v.reason);
      if (r === 'promoted') { promoted++; console.log(`  + active: ${b.content.slice(0, 80)}`); }
      else if (r === 'flagged' || r === 'rejected') { flagged++; console.log(`  x ${v.verdict}: ${b.content.slice(0, 80)}`); }
      else unchanged++;
    }
  } catch (err) {
    console.error(`  [verify error] batch ${i / BATCH + 1}:`, err.message.slice(0, 120));
  }
  console.log(`  verified ${Math.min(i + BATCH, items.length)}/${items.length} | promoted ${promoted} | flagged ${flagged}`);
  await new Promise(r => setTimeout(r, DELAY_MS));
}

console.log(`Done. promoted=${promoted} flagged=${flagged} unchanged=${unchanged}`);
process.exit(0);
