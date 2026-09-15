import "dotenv/config";
import { z } from "zod";

const env = z.object({
  DISCORD_TOKEN: z.string().min(1),
  GROQ_API_KEY: z.string().min(1),
  GROQ_MODEL: z.string().default("openai/gpt-oss-20b"),
  GROQ_BASE_URL: z.string().default("https://api.groq.com/openai/v1"),
  // Optional when running tests via TEST_DATABASE_URL — db.ts prefers TEST_DATABASE_URL.
  DATABASE_URL: z.string().default(""),
  GUILD_ID: z.string().optional(),
  SPEAK_THRESHOLD: z.coerce.number().min(0).max(1).default(0.7),
  RAW_MESSAGE_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  CANDIDATE_CONFIDENCE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.7),
}).parse(process.env);

export const config = {
  discordToken: env.DISCORD_TOKEN,
  groqKey: env.GROQ_API_KEY,
  model: env.GROQ_MODEL,
  groqBaseUrl: env.GROQ_BASE_URL,
  databaseUrl: env.DATABASE_URL,
  guildId: env.GUILD_ID,
  speakThreshold: env.SPEAK_THRESHOLD,
  rawMessageRetentionDays: env.RAW_MESSAGE_RETENTION_DAYS,
  candidateConfidenceThreshold: env.CANDIDATE_CONFIDENCE_THRESHOLD,
};
