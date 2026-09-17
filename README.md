# Artificial Server Member — v1

An intentionally quiet Discord bot that observes conversations, forms a small persistent memory of people and server lore, and joins in when it is directly invited.

## Version 1.1 — trusted memory

1. Ingest messages and retain only server-visible content.
2. Extract a small number of confidence-scored, durable memories.
3. Recall relevant person and server memories in later conversations.
4. Reply reliably to direct mentions and otherwise remain silent by default.
5. Store messages and memories in Postgres so a restart does not erase its context.
6. Make every curated memory inspectable, correctable, and forgettable by the person it concerns.

### Memory commands

All replies are private (ephemeral) by default.

- `/memory` — list your active memories, eight at a time.
- `/memory page:2`, `/memory search:Arsenal` — navigate or filter them.
- `/memory memory_id:42` — inspect confidence, dates, confirmations, source quotes, and why the bot created that memory.
- `/memory candidates:true` and `/memory-confirm memory_id:42` — inspect and explicitly promote uncertain memories. Candidates are never used in replies.
- `/memory server:true` — show server lore (administrators can also inspect another member with `/memory about:@member`).
- `/forget memory_id:42` — asks for confirmation, then marks that curated memory as forgotten. It does not delete raw source messages.
- `/correct statement:"I don't support Arsenal anymore"` — creates the replacement memory and supersedes genuinely contradictory active memories.
- `/memory-export` — download every memory and its evidence held about you.
- `/memory stats:true` and `/memory-purge` — server-administrator controls for counts and raw-message retention.
- `/opt-out` and `/opt-in` — forget everything remembered about you, delete your profile, and stop the bot forming new memories or relationships about you (raw messages still age out via retention).
- `/memory-pause`, `/memory-resume`, `/memory-settings`, and `/status` — server-administrator emergency and operational controls (`/status` shows uptime and error counters).
- `/event memory_id:42` — inspect the server event linked to a memory: participants, significance score, summary, and message count.

Every curated memory keeps its lifecycle state (`active`, `stale`, `contested`, `superseded`, or `forgotten`) plus provenance: the source message, author, observation time, extraction reason, explicitness, and confirmation count.

Out of scope for v1: autonomous proactive posts, relationship inference, rich server history, moderation, and a web dashboard. Those rely on reliable observation and memory first.

## Build order

1. **This foundation:** Discord ingestion, Postgres memory, LLM extraction and mention replies.
2. Add Discord slash commands: `/memory`, `/forget`, `/status` and consent controls.
3. Add a reviewable memory queue and tests with synthetic conversation fixtures.
4. Enable carefully rate-limited contextual interventions in one test channel.
5. Add relationship memories and a server-lore timeline only after accuracy is proven.

## Architecture at a glance

ASB is a single TypeScript process. Every Discord message goes through a pre-filter, optional LLM memory extraction, Postgres persistence, and an event-detection pipeline before a reply is considered. See [`docs/architecture.md`](docs/architecture.md) for the full module map and data-flow diagram.

## Run locally

1. Create a Discord application and bot at the [Discord Developer Portal](https://discord.com/developers/applications). Enable the **Message Content Intent** under Bot → Privileged Gateway Intents, then invite it with `bot` permissions to a test server.
2. Copy `.env.example` to `.env`, then supply the Discord bot token, Groq API key, and a `DATABASE_URL` pointing at Postgres (a free [Supabase](https://supabase.com) project works; use the Session pooler URL). Set `GUILD_ID` to the test server while developing. See [`docs/configuration.md`](docs/configuration.md) for all options.
3. Install dependencies and start it:

   ```bash
   npm install
   npm run dev
   ```

Memory is stored in the Postgres database configured via `DATABASE_URL`; the schema is created automatically by migrations on startup. Treat it as community data: use a private test server first and tell members what is retained. Raw messages are automatically removed after `RAW_MESSAGE_RETENTION_DAYS` (30 by default), and administrators can manually purge them earlier. Curated memories and their short evidence quotes remain until forgotten, corrected, or later decayed by a retention policy.

### Bulk-ingest historical messages

To seed the memory store from an existing channel's history before going live:

```bash
INGEST_CHANNEL=general-chat npm run ingest
```

The script fetches the entire channel history in chronological order, runs the same memory-extraction and event-detection pipeline as the live bot, and then exits. Re-running it is safe — messages already processed are skipped.

## Development

```bash
npm run check    # TypeScript type-check (no output = pass)
npm test         # run all tests
npm run dev      # start with live reload
```

See [`docs/development.md`](docs/development.md) for a full contributor guide including test coverage map, migration instructions, and debugging tips.

## Reliability behaviour

The bot uses a local pre-filter before calling the memory model, so ordinary chat is archived but not sent for memory extraction. Clear, highly explicit observations become active memories; weaker ones become candidates. A daily maintenance job promotes repeated candidates and marks old weak candidates or old low-confidence memories as stale. Only active memories are eligible for replies.

## Design guardrails

- The bot has no hidden knowledge: its replies are bounded by stored memories and visible channel context.
- Memory extraction rejects sensitive inferences and stores only durable, useful observations.
- Speaking is conservative. In this initial build it responds only to direct mentions (and obeys the configured threshold).
- Each remembered item includes confidence, importance, recency, and confirmation count so later releases can improve or retire it rather than treating every statement as fact.
