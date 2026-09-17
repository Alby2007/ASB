import 'dotenv/config';
import OpenAI from 'openai';
const c = new OpenAI({apiKey: process.env.GROQ_API_KEY, baseURL: 'https://api.groq.com/openai/v1'});

// The actual messages that slipped through the regex filter
const skipped = [
  'excess foreskin just looks gross and its literally dirty',
  'she don\'t want her man even thinking you\'re pretty',
  'sore from a couple squats',
  'I use the databases my firm uses',
  'Had a great time just played some pool',
  'I do have one it was just not on',
  'people do ket all the time over there',
  'What LLM are you',
  'Am I Luke\'s father?',
  'Are you guys starting a new religion in here?',
  'Grand rising',
  'We keep our eyes on Talos and seek to follow in his footsteps',
];

const numbered = skipped.map((t, i) => `[${i}] ${t}`).join('\n');
const schema = {
  type: 'object',
  properties: {
    results: { type: 'array', items: { type: 'object', properties: {
      index: { type: 'number' }, durable: { type: 'boolean' }, reason: { type: 'string' }
    }, required: ['index','durable','reason'], additionalProperties: false }}
  },
  required: ['results'], additionalProperties: false
};

const r = await c.chat.completions.create({
  model: 'qwen/qwen3.8-27b',
  messages: [{ role: 'user', content: `Rate each Discord message on whether it contains durable social information worth remembering about a person, relationship, or the server community. Durable means: facts, preferences, relationships, health, location, occupation, life events, group dynamics, inside jokes, or community lore. Non-durable means: greetings, one-liners, reactions, off-topic banter, or bot commands.\n\nMessages:\n${numbered}` }],
  response_format: { type: 'json_schema', json_schema: { name: 'triage', strict: true, schema } },
  max_tokens: 1000
});
const out = JSON.parse(r.choices[0].message.content);
for (const res of out.results) {
  console.log(`  [${res.index}] durable=${res.durable} | "${skipped[res.index].slice(0,60)}" | ${res.reason.slice(0,60)}`);
}
