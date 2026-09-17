import 'dotenv/config';
import OpenAI from 'openai';

const c = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: 'https://api.groq.com/openai/v1'
});

// Simulate a batch of 10 Discord messages — mix of durable and non-durable
const messages = [
  { id: 'm1', text: 'I just moved to Leeds last week for work' },
  { id: 'm2', text: 'lol nice' },
  { id: 'm3', text: 'my wife hates it when I play pool' },
  { id: 'm4', text: 'ok' },
  { id: 'm5', text: 'we always do this on fridays, it\'s basically tradition' },
  { id: 'm6', text: 'Starz is a Muslim has been going through a rough time lately' },
  { id: 'm7', text: 'haha yeah' },
  { id: 'm8', text: 'the doctor said I have low iron' },
  { id: 'm9', text: 'gg' },
  { id: 'm10', text: 'she works at the hospital on weekends' }
];

const numbered = messages.map((m, i) => `[${i}] ${m.text}`).join('\n');

const schema = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'number' },
          durable: { type: 'boolean' },
          reason: { type: 'string' }
        },
        required: ['index', 'durable', 'reason'],
        additionalProperties: false
      }
    }
  },
  required: ['results'],
  additionalProperties: false
};

for (const model of ['qwen/qwen3.8-27b', 'openai/gpt-oss-20b']) {
  try {
    const r = await c.chat.completions.create({
      model,
      messages: [{
        role: 'user',
        content: `Rate each Discord message on whether it contains durable social information worth remembering about a person, relationship, or the server community. Durable means: facts, preferences, relationships, health, location, occupation, life events, group dynamics, inside jokes, or community lore. Non-durable means: greetings, one-liners, reactions, off-topic banter, or bot commands.\n\nMessages:\n${numbered}`
      }],
      response_format: { type: 'json_schema', json_schema: { name: 'triage', strict: true, schema } },
      max_tokens: 1000
    });
    const out = JSON.parse(r.choices[0].message.content);
    console.log(`\n=== ${model} ===`);
    for (const res of out.results) {
      const m = messages[res.index];
      console.log(`  [${res.index}] durable=${res.durable} | ${res.reason.slice(0,60)} | "${m.text.slice(0,50)}"`);
    }
  } catch(e) {
    console.log(`\n=== ${model} ===`);
    console.log(`  FAIL: ${e.message.slice(0,100)}`);
  }
}
