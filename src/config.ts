import "dotenv/config";
import { z } from "zod";

const env = z.object({
  // Required at runtime by the bot; tests don't need these — use empty string default.
  DISCORD_TOKEN: z.string().default(""),
  GROQ_API_KEY: z.string().default(""),
  GROQ_MODEL: z.string().default("openai/gpt-oss-120b"),
  GROQ_BASE_URL: z.string().default("https://api.groq.com/openai/v1"),
  // Optional when running tests via TEST_DATABASE_URL — db.ts prefers TEST_DATABASE_URL.
  DATABASE_URL: z.string().default(""),
  GUILD_ID: z.string().optional(),
  SPEAK_THRESHOLD: z.coerce.number().min(0).max(1).default(0.7),
  RAW_MESSAGE_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  CANDIDATE_CONFIDENCE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.7),
  // Model overrides — all optional; per-feature fallback chains live in the
  // derived config below so a typo'd name or value is visible in one place.
  VERIFY_MODEL: z.string().optional(),
  PROFILE_MODEL: z.string().optional(),
  DOSSIER_MODEL: z.string().optional(),
  CONTEST_MODEL: z.string().optional(),
  INGEST_MODEL: z.string().optional(),
  INGEST_TRIAGE_MODEL: z.string().optional(),
  REPLY_MODEL: z.string().optional(),
  REPLY_TOOLS: z.string().optional(),
  INGEST_CHANNEL: z.string().optional(),
  VISION_MODEL: z.string().optional(),
  IMAGE_MAX_BYTES: z.coerce.number().int().min(1).default(4_000_000),
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
  // Model override chains — terminal default stays at each call site because
  // index.ts and ingest.ts intentionally differ (config.model vs qwen).
  verifyModel: env.VERIFY_MODEL ?? env.PROFILE_MODEL,
  profileModel: env.PROFILE_MODEL,
  dossierModel: env.DOSSIER_MODEL,
  contestModel: env.CONTEST_MODEL ?? env.VERIFY_MODEL ?? env.INGEST_MODEL,
  ingestModel: env.INGEST_MODEL,
  triageModel: env.INGEST_TRIAGE_MODEL,
  replyModel: env.REPLY_MODEL,
  replyTools: env.REPLY_TOOLS === "1",
  ingestChannel: env.INGEST_CHANNEL ?? "general-chat",
  // No fallback: unset means image understanding is OFF. A text-only model
  // could silently drop the image block and store a hallucinated description.
  visionModel: env.VISION_MODEL,
  imageMaxBytes: env.IMAGE_MAX_BYTES,
};
