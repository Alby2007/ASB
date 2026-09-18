import OpenAI from 'openai';
const c = new OpenAI({apiKey: process.env.GROQ_API_KEY, baseURL: 'https://api.groq.com/openai/v1'});
const models = await c.models.list();
models.data.map(m => m.id).sort().forEach(n => console.log(n));
