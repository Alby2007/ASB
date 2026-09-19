# Configuration Reference

ASB is configured through environment variables validated at startup by `src/config.ts` using [zod](https://github.com/colinhacks/zod). Copy `.env.example` to `.env` and fill in the required values before starting the bot.

---

## Environment variables

### Required

| Variable | Description |
|----------|-------------|
| `DISCORD_TOKEN` | Your Discord bot token. Obtain from the [Discord Developer Portal](https://discord.com/developers/applications) under Bot → Token. |
| `GROQ_API_KEY` | API key for Groq. Used for all LLM calls (memory extraction, continuity decisions, event classification, replies). |
| `DATABASE_URL` | Postgres connection string. Use the **Session pooler** URL (port 5432) from your Supabase project: **Settings → Database → Connection string → Session mode**. Example: `postgresql://postgres:[password]@db.[ref].supabase.co:5432/postgres` |

### Optional

| Variable | Default | Description |
|----------|---------|-------------|
| `GROQ_MODEL` | `openai/gpt-oss-120b` | Model name passed to Groq. `openai/gpt-oss-120b` is the default; `openai/gpt-oss-20b` is faster and cheaper. |
| `GROQ_BASE_URL` | `https://api.groq.com/openai/v1` | Override the Groq base URL. Useful for proxies or self-hosted endpoints. |
| `GUILD_ID` | (empty) | If set, restricts the bot to a single Discord server. **Recommended during development** to avoid accidental activity in other servers. Leave empty to enable all servers the bot has joined. |
| `SPEAK_THRESHOLD` | `0.70` | Minimum `brain.decide()` score required to send a reply. Range 0–1. At 0.70 the bot speaks on direct address (0.90) and on in-conversation engaged messages (0.75 before recency decay). Lowering this value enables more frequent unsolicited replies. |
| `RAW_MESSAGE_RETENTION_DAYS` | `30` | How many days of raw Discord messages to keep in the `messages` table. Messages older than this are deleted by the daily maintenance job. Evidence quotes in `memory_evidence` are **not** affected by this purge. Range 1–365. |
| `CANDIDATE_CONFIDENCE_THRESHOLD` | `0.70` | Minimum confidence required to auto-promote a candidate memory to active status (subject to evidence type gates). Range 0–1. |
| `REPLY_MODEL` | `GROQ_MODEL` | Model used for Discord replies, across all reply paths. Any Groq model id, or `groq/compound*` for Groq's agentic system with built-in web tools. Reasoning models (gpt-oss, qwen3) get `reasoning_effort=low` automatically to cut latency and flatten the register. |
| `REPLY_TOOLS` | (off) | `1` attaches free local tools to replies — `web_search`/`visit_url` plus internal lookups (`lookup_person`, `lookup_relationship`, `search_memories`, `lookup_event`) — on a direct mention or when a message matches tool cues. |
| `VERIFY_MODEL` | `PROFILE_MODEL` → `GROQ_MODEL` | Model for memory/relationship verification and dedup passes. |
| `PROFILE_MODEL` | `GROQ_MODEL` | Model for profile card synthesis. |
| `DOSSIER_MODEL` | `GROQ_MODEL` | Model for dossier section synthesis. |
| `CONTEST_MODEL` | `VERIFY_MODEL` → `INGEST_MODEL` → `GROQ_MODEL` | Model for contest/denial detection. |
| `INGEST_MODEL` | `qwen/qwen3.8-27b` (ingest), `GROQ_MODEL` (sweep) | Model for batch memory extraction. |
| `INGEST_TRIAGE_MODEL` | `qwen/qwen3.8-27b` (ingest), `GROQ_MODEL` (sweep) | Model for the durability triage pass. |
| `INGEST_CHANNEL` | `general-chat` | Channel name `npm run ingest` backfills from; also the `/server-build` fallback when its `channel` option is omitted. |
| `VISION_MODEL` | (off) | Vision-capable model for image understanding (e.g. `gemini-2.5-flash` on Gemini's free tier). **Unset disables image handling entirely** — there is no fallback to `GROQ_MODEL`, since a text-only model could silently drop the image block and store a hallucinated description. When set, image attachments (`image/*` except GIFs, ≤`IMAGE_MAX_BYTES`, ≤3/message) are described once and the text rides the normal extraction/reply pipelines; URLs and bytes are never persisted. |
| `VISION_API_KEY` | `GROQ_API_KEY` | API key for the vision provider — set only when `VISION_MODEL` lives off-Groq (e.g. a Gemini AI Studio key). |
| `VISION_BASE_URL` | `GROQ_BASE_URL` | OpenAI-compatible endpoint for the vision provider (e.g. `https://generativelanguage.googleapis.com/v1beta/openai/` for Gemini). |
| `IMAGE_MAX_BYTES` | `4000000` | Per-image size cap for `VISION_MODEL` processing; larger attachments are skipped. Keep at or under the provider's per-image limit. |
| `WAKE_WORD` | `1` | Saying the bot's name — its username, display name, server nickname, or `"asb"` — counts as addressing it (same as an @-mention: reply trigger, always-inspect, tools armed). Word-boundary matched, names under 3 chars ignored. `0` disables if casual name-drops get noisy. |
| `ENGAGEMENT` | `1` | Conversational engagement: once someone addresses the bot (mention, reply-to-bot, or wake word), a per-channel conversation opens and their follow-up messages get a mid-tier reply score (+0.70) for `ENGAGEMENT_TTL_MS` without re-mentioning — the bot stays in the thread. Participants leave three ways: TTL expiry (refreshes only on addressed messages, so drift decays out), explicit dismissals ("shut up &lt;name&gt;", "we're done" — deterministic override), or the reply model's `end_conversation` signal. `0` reverts to address-only replies. |
| `REPLY_EXIT` | `1` | Honor the reply model's `end_conversation` flag — when the model reads a wrap-up ("ok cool thanks that's all") the human leaves the conversation, so wrap-ups the dismissal regex can't parse don't keep the +0.70 bonus alive for the full TTL. `0` ignores the flag; regex dismissal keeps working regardless. |
| `ENGAGEMENT_TTL_MS` | `120000` | How long a participant stays "in conversation" after their last addressed message. Range 10s–1h. Longer = chattier mid-flow but slower to drop out. |
| `PROACTIVE` | unset (off) | Proactive speaking global kill switch — **opt-in**, `1` required. When on, the bot may answer a question nobody answered after a channel silence, but only when it has grounded server lore/event context, only after the server's own `proactive_enabled` flag is set via `/proactive enabled:true`, and capped per channel per day. Any other value = feature entirely off regardless of server settings. |
| `PROACTIVE_DELAY_MS` | `75000` | Idle silence a question must survive before the bot considers answering it. Range 15s–10min. Any follow-up message or reaction on the question cancels the pending attempt — the point is waiting to see if a human answers first. |
| `PROACTIVE_DAILY_CAP` | `3` | Hard per-channel cap on proactive messages per day. Range 1–20. In-memory (restart resets) — bounds the worst case to "a few messages" no matter how many qualifying silences occur. |
| `PROACTIVE_RESPONSE_WINDOW_MS` | `600000` | How long a sent proactive reply waits for engagement (a reply-edge or a reaction) before counting as ignored. Range 1min–1h. |
| `PROACTIVE_BACKOFF_MS` | `21600000` | How long the elevated confidence floor stays hot after an ignored proactive reply (6h default). Range 5min–48h. While hot, the LLM gate requires higher confidence before the bot tries again. |
| `KEY_ENCRYPTION_SECRET` | unset | Master passphrase encrypting per-guild LLM keys at rest (AES-256-GCM, SHA-256-derived). Required for `/setup` — without it the command tells admins key storage is unavailable. Any string; rotating it orphans existing `guild_keys` rows (recovery = re-run `/setup`). |
| `REQUIRE_GUILD_KEYS` | `0` | Hosted BYOK mode: `1` disables the `GROQ_API_KEY` fallback so a guild without a stored key is fully dormant — no archiving, no replies, no LLM spend. Self-hosters leave this off. Note this is a *key* gate, orthogonal to the consent posture: every guild also starts dormant (`memory_enabled=0`) until an admin runs `/memory-resume`. |

---

## Discord bot setup

1. Create an application at [discord.com/developers/applications](https://discord.com/developers/applications).
2. Add a Bot user. Under **Bot → Privileged Gateway Intents**, enable **Message Content Intent**.
3. Under **OAuth2 → URL Generator**, select scopes `bot` and `applications.commands`, then grant the following permissions:
   - Read Messages / View Channels
   - Send Messages
   - Read Message History
4. Use the generated URL to invite the bot to your server.

---

## Runtime settings (per-guild overrides)

Administrators can adjust per-server behaviour at runtime without restarting the bot. These settings are stored in the `server_settings` table and override the default values from environment variables for that specific server.

| Command | Effect |
|---------|--------|
| `/memory-pause` | Sets `memory_enabled=0` and `reply_enabled=0`. The bot stops observing and replying immediately. |
| `/memory-resume` | Sets both back to 1. |
| `/proactive enabled:<true|false>` | Sets `proactive_enabled` for this server. Off by default and independently required alongside the global `PROACTIVE=1` env flag — unprompted speech is a different risk profile than replying when addressed, so both must explicitly opt in. |
| `/memory-settings` | Shows current values of `memory_enabled`, `reply_enabled`, `proactive_enabled`, `raw_retention_days`, `llm_daily_cap`, and the `ignored_channels` list. |
| `/limits daily_cap:N` | Sets `llm_daily_cap` — the per-guild LLM-call budget per UTC day (default 1000, range 0–100000). `0` blocks every LLM call for the guild; usage resets at UTC midnight. Deferrable work (extract jobs) reschedules to the next day rather than failing; a reply-path call at cap posts a one-per-channel-per-day notice. |
| `/ignore-channel channel:#c` | Adds a channel to `ignored_channels` — fully invisible to the bot: no archiving, no replies, no member writes, no `/server-build` scans. |
| `/unignore-channel channel:#c` | Removes a channel from `ignored_channels`. |
| `/memory-purge older_than_days:N` | Manually deletes raw messages older than N days for this server (regardless of the global retention setting). |
| `/status` | Shows bot uptime, in-process operational counters, and today's LLM usage vs the guild's cap. |
| `/memory-triage` | Shows the 15 most recently stored memories across all members, with status, kind, and subject. |

### How runtime settings interact with env variables

- `SPEAK_THRESHOLD` and `CANDIDATE_CONFIDENCE_THRESHOLD` are process-level constants. They apply to all guilds and can only be changed by restarting with different env values.
- `RAW_MESSAGE_RETENTION_DAYS` sets the initial default for new guilds. Once a guild row exists in `server_settings`, the `raw_retention_days` column is the authoritative value for that guild.
- `reply_enabled` is checked before `SPEAK_THRESHOLD`. A paused server will never receive a reply even if the score exceeds the threshold.
- `proactive_enabled` requires `PROACTIVE=1` globally AND the per-server flag — double opt-in. Either switch independently suppresses the entire feature. Proactive answers draw only on `server_lore` memories and promoted events; `person_fact`/`person_preference` memories are excluded at the query layer, so the bot never volunteers personal facts unprompted. |
- `llm_daily_cap` bounds a guild's total LLM spend per UTC day — every call through the guild's resolved `Brain` (extraction, triage, replies, verification, tools) charges `guild_usage` atomically before executing. `0` means "no LLM calls at all"; archived messages still record, they just queue for extraction until the cap resets.

### Job queue (fixed parameters)

Deferrable cognition (memory extraction, contest checks, event-pipeline processing) runs on a Postgres-backed queue rather than inside the live message handler. The constants are compile-time in `src/jobs.ts`, not env-configurable: global in-flight cap **8**, per-guild concurrency **1** (preserves event ordering), 3-second poll with `LISTEN`/`NOTIFY` wake hints, 10-minute claim lease, exponential backoff, dead-letter at **5** attempts. Jobs that hit `BudgetExceeded` reschedule to the next UTC midnight without consuming an attempt.

---

## Ingest-only variable

| Variable | Default | Description |
|----------|---------|-------------|
| `INGEST_CHANNEL` | `general-chat` | Name of the channel to fetch history from when running `npm run ingest`. Only used by `src/ingest.ts`; ignored by the live bot. |
