# Developer Guide

Everything you need to work on ASB locally.

---

## Prerequisites

- **Node.js** 20+ (the project uses ES modules and `node:test`)
- A **Discord bot token** — see [configuration.md](configuration.md) for setup
- A **Groq API key** — free at [console.groq.com](https://console.groq.com)
- A **Postgres database** — a free [Supabase](https://supabase.com) project works. Use the Session pooler connection string (port 5432).
- `npm` (bundled with Node)

---

## First-time setup

```bash
git clone https://github.com/Alby2007/ASB.git
cd ASB
npm install
cp .env.example .env
# Edit .env and fill in DISCORD_TOKEN, GROQ_API_KEY, and DATABASE_URL
# Set GUILD_ID to your test server's ID while developing
```

On first run the bot connects to Postgres, creates all tables, and applies migrations automatically — no manual SQL required.

---

## npm scripts

| Command | What it does |
|---------|-------------|
| `npm run dev` | Start with live reload via `tsx watch`. Restart on every file save. |
| `npm start` | Start once (no reload). Use for production. |
| `npm run ingest` | Bulk-ingest historical messages from a Discord channel. Set `INGEST_CHANNEL=channel-name` before running. Safe to re-run — already-processed messages are skipped. |
| `npm run check` | TypeScript type-check only (`tsc --noEmit`). No output = pass. |
| `npm test` | Run the full test suite using Node's built-in test runner. |

---

## Test suite

Tests live alongside source files as `*.test.ts`. Run them all with `npm test`.

| File | Coverage |
|------|---------|
| `confidence.test.ts` | Determinism of all confidence formulas; initial values by evidence type; update behaviour for all four effects |
| `evidence.test.ts` | Evidence deduplication by `(memory_id, message_id)`; replay protection; cross-author corroboration still builds confidence; transaction atomicity |
| `migrations.test.ts` | Migration apply and rollback for every version; idempotency; schema column presence checks |
| `reliability.test.ts` | Pre-filter (`shouldInspectForMemory`); candidate promotion gates (evidence type allowlist); lifecycle transitions; age-weighted quarantine |
| `adversarial.test.ts` | Sarcasm and `uncertain_inference` volume accumulation cannot promote; `reported_by_other` promotion gate; confidence manipulation via contradiction timing; contested state confidence freeze |
| `event.test.ts` | Heuristic scoring signals (reply chain, participant overlap, keyword overlap, recency, back-reference); `calculateSignificance` tier assignment; retroactive promotion threshold |
| `brain.test.ts` | `decide()` scoring: direct mention overrides recency penalty; recency penalty applies to non-mention messages; unmentioned chatter stays below threshold. Extraction/contest/verification prompt parsing via an injected `LlmClient` stub |
| `attributes.test.ts` | `normalizeValue`/`attributeHash` canonicalisation; `deriveAttributeStatus` precedence (contested > active > candidate > quarantined); `applyProposals` upsert-diff: exact revive, trgm fold, singular supersession, provenance cascades |
| `commands.test.ts` | Slash-command authorization matrix: non-admin vs admin cross-member views, opt-out/forget ownership, confirm-button userId binding, admin-gated commands, opt-in consent flag, `/profile-build` + `/server-build` |
| `dedup.test.ts` | Trigram near-duplicate merge: same-claim phrasing reinforces instead of duplicating; distinct content stays separate; episodes never fuzzy-merge |
| `entity-resolution.test.ts` | `resolveSubject` mention/name/self-resolution; `buildAliasMap` from `known_names`; `findMentionedUsers` matching rules |
| `perception.test.ts` | Durable-signal pre-filter patterns; bot-addressed bypass; `detectNamingRequest`/`detectSelfNaming` extraction and stopword rejection |
| `profiles.test.ts` | `recordMessage` member upsert/dedup/`reply_to_id`; `buildProfiles` consent + eligibility gates, attribute pipeline, dossier build |
| `persist-extraction.test.ts` | Consent-gated extraction writes: person memories only for opted-in subjects, server lore exempt, relationship subject-consent, opt-out beats opt-in |
| `tools.test.ts` | `isSafeUrl` SSRF guards; `stripHtml`/`parseDdgLite` parsing; `executeTool` error strings never throw |

### Adding a test

Tests use Node's built-in `node:test` and `node:assert/strict`. All database tests run against a real Postgres instance — set `TEST_DATABASE_URL` in your `.env` before running:

```bash
# Fastest option: local Postgres via Docker
docker run -d -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres npm test

# Or point at a dedicated Supabase test project (separate from production)
TEST_DATABASE_URL=postgresql://postgres:[pw]@db.[ref].supabase.co:5432/postgres npm test
```

Each test creates a fresh `sql` connection via `makeTestSql()` from `src/test-helpers.ts`, runs migrations, truncates all data, then closes the connection on teardown. Tests do not share state.

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { makeTestSql, makeStore } from "./test-helpers.js";

test("description of what you are testing", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    // arrange, act, assert
  } finally { await sql.end(); }
});
```

`brain.test.ts`, `confidence.test.ts`, `attributes.test.ts`, `perception.test.ts`, and `tools.test.ts` run without a database.

---

## Adding a migration

1. Open `src/migrations.ts`.
2. Add a new object to the `migrations` array with the next version number:

   ```ts
   {
     version: 6,
     name: "descriptive_snake_case_name",
     up: async (sql: Sql) => {
       // addColumn() is idempotent — safe to call even if the column exists
       await addColumn(sql, "memories", "new_column TEXT");
       // or: await sql`CREATE TABLE IF NOT EXISTS ...`
     },
     down: async (sql: Sql) => {
       // Postgres supports DROP COLUMN:
       await sql`ALTER TABLE memories DROP COLUMN IF EXISTS new_column`;
       // For new tables: await sql`DROP TABLE IF EXISTS ...`
     },
   }
   ```

3. The migration is applied automatically on the next startup.
4. Add a test in `src/migrations.test.ts` verifying the column/table exists after applying and is gone/nulled after rollback.

**Naming convention:** use a prefix that identifies the phase or feature (`phase_1a_`, `v02_`, etc.) followed by a description of what was added.

---

## Database access

The database lives in Supabase Postgres (or any Postgres configured via `DATABASE_URL`). Use the Supabase dashboard's **Table Editor** or **SQL Editor** to inspect data. From `psql`:

```bash
psql "$DATABASE_URL"

-- Check migration state
SELECT * FROM schema_migrations ORDER BY version;

-- Count memories by status
SELECT status, COUNT(*) FROM memories GROUP BY status;

-- Schema overview
\dt
```

No local files are written. There is no `data/` directory.

---

## Debugging tips

### Groq rate limits (ingest)

`ingest.ts` paces LLM calls with `BATCH_DELAY_MS = 3000` between extraction batches and `TRIAGE_DELAY_MS = 1500` between triage calls. If you hit 429 errors:
- The script reads the `x-ratelimit-reset-tokens` header and waits accordingly (shared `withRetry` in `src/retry.ts`).
- Up to 6 retries are attempted with exponential backoff.
- You can increase the `*_DELAY_MS` constants at the top of `ingest.ts` if your Groq tier has tighter limits.

### Bot not responding to direct mentions

1. Check that `GUILD_ID` is set correctly (or unset for all guilds).
2. Confirm **Message Content Intent** is enabled in the Discord Developer Portal under Bot → Privileged Gateway Intents.
3. Verify the bot has **Send Messages** and **Read Message History** permissions in the target channel.
4. Check `SPEAK_THRESHOLD` — it defaults to 0.70. A direct mention scores 0.90, so it should always exceed the threshold. If it still doesn't reply, check that `reply_enabled` is 1 in `server_settings` (use `/memory-settings`).

### Memory not being extracted

- The pre-filter in `perception.ts` is intentionally conservative. A message must be 12–2000 characters and match at least one durable-signal pattern. Short or casual messages are skipped.
- Check the `memory_enabled` setting for the guild (`/memory-settings`).
- Set `GUILD_ID` so you can confirm which server's messages are being processed.

### TypeScript errors

```bash
npm run check
```

All errors must be resolved before committing. The project uses `strict: true`.

---

## Project structure reference

```
ASB/
├── src/
│   ├── index.ts              # Entry point — Discord client and event loop
│   ├── ingest.ts             # Standalone bulk-ingest script
│   ├── brain.ts              # All LLM calls
│   ├── config.ts             # Env validation
│   ├── types.ts              # Shared TypeScript types
│   ├── db.ts                 # Shared postgres.js connection singleton
│   ├── database.ts           # MemoryStore (Postgres)
│   ├── events.ts             # EventStore (Postgres)
│   ├── migrations.ts         # Versioned schema migrations (async Postgres DDL)
│   ├── confidence.ts         # Deterministic confidence formulas
│   ├── perception.ts         # Pre-filter regex
│   ├── event-detection.ts    # EventPipeline
│   ├── event-significance.ts # Significance scoring formula
│   ├── commands.ts           # Slash command definitions and handlers
│   └── *.test.ts             # Test files (co-located with source)
├── docs/
│   ├── architecture.md       # Module map and data flow
│   ├── schema.md             # Database schema reference
│   ├── event-pipeline.md     # Event detection explainer
│   ├── configuration.md      # Env var reference
│   └── development.md        # This file
├── src/test-helpers.ts       # Shared Postgres test utilities
├── .env.example              # Template for environment variables
├── package.json
└── tsconfig.json
```
