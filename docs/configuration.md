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
| `GROQ_MODEL` | `openai/gpt-oss-20b` | Model name passed to Groq. `openai/gpt-oss-20b` is fast and free; `openai/gpt-oss-120b` is more capable. |
| `GROQ_BASE_URL` | `https://api.groq.com/openai/v1` | Override the Groq base URL. Useful for proxies or self-hosted endpoints. |
| `GUILD_ID` | (empty) | If set, restricts the bot to a single Discord server. **Recommended during development** to avoid accidental activity in other servers. Leave empty to enable all servers the bot has joined. |
| `SPEAK_THRESHOLD` | `0.70` | Minimum `brain.decide()` score required to send a reply. Range 0–1. A score of 0.70 means the bot will normally only speak when directly @mentioned (which scores 0.90). Lowering this value enables more frequent unsolicited replies. |
| `RAW_MESSAGE_RETENTION_DAYS` | `30` | How many days of raw Discord messages to keep in the `messages` table. Messages older than this are deleted by the daily maintenance job. Evidence quotes in `memory_evidence` are **not** affected by this purge. Range 1–365. |
| `CANDIDATE_CONFIDENCE_THRESHOLD` | `0.70` | Minimum confidence required to auto-promote a candidate memory to active status (subject to evidence type gates). Range 0–1. |

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
| `/memory-settings` | Shows current values of `memory_enabled`, `reply_enabled`, and `raw_retention_days`. |
| `/memory-purge older_than_days:N` | Manually deletes raw messages older than N days for this server (regardless of the global retention setting). |
| `/status` | Shows bot uptime and in-process operational counters (LLM errors, contest misses, memories saved). |
| `/memory-triage` | Shows the 15 most recently stored memories across all members, with status, kind, and subject. |

### How runtime settings interact with env variables

- `SPEAK_THRESHOLD` and `CANDIDATE_CONFIDENCE_THRESHOLD` are process-level constants. They apply to all guilds and can only be changed by restarting with different env values.
- `RAW_MESSAGE_RETENTION_DAYS` sets the initial default for new guilds. Once a guild row exists in `server_settings`, the `raw_retention_days` column is the authoritative value for that guild.
- `reply_enabled` is checked before `SPEAK_THRESHOLD`. A paused server will never receive a reply even if the score exceeds the threshold.

---

## Ingest-only variable

| Variable | Default | Description |
|----------|---------|-------------|
| `INGEST_CHANNEL` | `general-chat` | Name of the channel to fetch history from when running `npm run ingest`. Only used by `src/ingest.ts`; ignored by the live bot. |
