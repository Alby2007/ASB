# ASB — Artificial Server Member

A quiet Discord bot that learns who's in your server. It observes conversations, forms a small persistent memory of people, relationships, and server lore, and speaks when it's invited — directly mentioned, or when a configured threshold says it has something worth adding.

Everything it remembers is inspectable, correctable, and forgettable by the person it concerns.

---

## What it does

**Observes** — archives messages to Postgres (respecting per-guild pause), learns name↔user aliases, and tracks who talks to whom. Derived data about a person requires their explicit opt-in — the raw transcript is retention-bounded infrastructure.

**Remembers** — an LLM extracts durable candidates from messages that pass a cheap pre-filter. Each memory carries an evidence type (`explicit_fact`, `clear_preference`, `reported_by_other`, `sarcasm_or_joke`, …), a deterministic confidence score, provenance (source message, quote, timestamp), and a lifecycle status:

`candidate → active → contested → superseded / forgotten / quarantined`

**Verifies before it trusts** — candidate memories get a sincerity check (`literal` / `joke` / `misattributed` / `unclear`) before promotion; only promotable evidence types can reach `active`, and candidates are never used in replies. Near-duplicates fold together via trigram matching instead of accumulating.

**Handles contradiction** — bot-addressed denials and corrections contest memories rather than silently overwriting them; support vs. contradiction net-score resolves the dispute, with the same evidence-type gate preventing rumors from laundering into facts.

**Builds people (opted-in only)** — per-member structured attributes (pronouns, timezone, location, occupation, birthday, traits, interests, skills) with per-facet provenance — every attribute knows exactly which memories cite it, so a forgotten fact never lingers as a rendered facet. On top of that: synthesized profile cards and admin-only deep dossiers (psychological profile, relationships, opinions, communication style, timeline).

**Maps the social graph** — relationship observations between members are sincerity-verified and rolled up into edges with net valence; interaction pairs feed into dossiers.

**Follows events** — a continuity pipeline groups messages into server events, scores their significance, and promotes notable ones into retrievable lore.

**Replies** — to direct mentions and (above `SPEAK_THRESHOLD`) unsolicited, with member profiles and relevant memories as context, optional web-search tools, and low-effort reasoning for snappy responses.

**Maintains itself** — a periodic sweep re-examines messages the live path missed; daily maintenance quarantines stale candidates, resolves contested memories, purges raw messages past retention, and rebuilds profiles.

---

## Commands

All replies are ephemeral (private to the invoker) unless noted.

### Members

| Command | What it does |
|---------|--------------|
| `/memory` | List your active memories (8/page; `page:`, `search:`, `memory_id:` to navigate/inspect, `candidates:true` for your unconfirmed queue, `server:true` for lore) |
| `/memory-confirm` | Promote one of your own candidate memories to active |
| `/memory-export` | Download every memory + evidence held about you |
| `/forget` | Forget one of your memories (confirmation button required) |
| `/correct` | Replace a memory — supersedes genuinely contradictory active ones |
| `/privacy` | See what ASB stores in this server, the retention window, and your own consent state |
| `/opt-out` | Forget everything about you, delete your profile, revoke consent |
| `/opt-in` | Consent to memories + a profile about you (live activity only) |
| `/profile-build` | Opt in **and** scan your archive history — messages you wrote, references to you, conversations you're in — to build your structured profile now (once per 24h) |
| `/profile` | View your profile card (another member's: admins only) |
| `/dossier` | Deep dossier — facets, relationships, opinions, style, timeline (another member's: admins only) |
| `/event` | Inspect the server event a memory is attached to |

### Administrators (`Manage Server`)

| Command | What it does |
|---------|--------------|
| `/memory about:@member` | Inspect another member's memories |
| `/memory stats:true` | Guild memory counts |
| `/memory-triage` | Newest memories across all members + contested attributes |
| `/memory-purge` | Purge raw archived messages older than N days |
| `/memory-pause` / `/memory-resume` | Stop/restart observing and replying — archiving included |
| `/memory-settings` | Show effective guild settings (including the ignored-channel list and daily LLM cap) |
| `/ignore-channel` / `/unignore-channel` | Exclude a channel entirely — no archiving, no replies, no member writes, no `/server-build` scans |
| `/limits` | Set this server's daily LLM-call cap (0 = block all calls; usage resets each UTC day) |
| `/status` | Uptime, error counters, pipeline health, today's LLM usage vs cap |
| `/server-build` | Backfill a channel's history — asks for an explicit confirm click first, since it archives messages from people who never consented (owner/admin only; archives + lore + events for everyone, derived person data for opted-in members only) |
| `/setup` | Configure this server's own LLM API key via a secure modal (BYOK — the key is encrypted at rest and pays for this server's cognition; re-run to rotate) |

---

## Privacy model

- **Dormant by default.** New servers observe nothing: the bot posts a disclosure card on join and stays paused until an admin runs `/memory-resume`. Removing the bot from a server deletes every row it stored there — keys included.
- **Derived data is opt-in.** Person memories, relationship observations, attributes, profiles, and dossiers form only for members who consent (`/opt-in`, or `/profile-build` which opts in and backfills). Server lore and events are shared context and don't need per-member consent.
- **Reads are gated too.** Non-consenting members have nothing to read — profile cards, `/memory` views, relationship pair context, and the model's lookup tools all hide stragglers.
- **Relationship consent is subject-consent.** An observation persists when at least one party opted in — requiring both would lose almost all graph data.
- **Pause means pause.** `/memory-pause` stops archiving entirely — no raw rows, no member-registry writes — not just extraction.
- **Opt-out is strong.** `/opt-out` revokes consent, forgets memories, deletes relationships and the profile, and blocks all new derived data.
- **Deletes propagate.** Deleting a Discord message removes its archive row *and* scrubs the verbatim quote/snapshot on any evidence it produced. Edits update the archive (extraction-time snapshots are kept as the historical record).
- **Retention is bounded.** Raw messages age out on `RAW_MESSAGE_RETENTION_DAYS`; curated evidence outlives the raw archive by design.
- **Self-service.** Every member can see, export, correct, and forget their own data without admin involvement.
- **One-shot purge.** `scripts/purge-nonopted.mjs` (`PURGE_CONFIRM=1`) hard-deletes the pre-consent derived corpus for members who never opted in — run once after deploying the consent model.

Legal: [Privacy Policy](PRIVACY.md) · [Terms of Service](TERMS.md) · [Security](SECURITY.md) — also mirrored publicly at [Alby2007/asb-docs](https://github.com/Alby2007/asb-docs) for Discord verification.

---

## Quick start

_A hosted instance (bring-your-own-key) is planned — invite link lands here when it exists. Until then, self-host:_

**Prerequisites:** Node.js 20+, a Postgres database (a free [Supabase](https://supabase.com) project works — use the Session pooler URL), a Discord bot token with the Message Content intent, and a Groq API key.

```bash
git clone https://github.com/Alby2007/ASB.git
cd ASB
npm install
cp .env.example .env   # fill in DISCORD_TOKEN, GROQ_API_KEY, DATABASE_URL
npm run dev            # or: npm start
```

Migrations apply automatically on first boot — no manual SQL.

**Backfill history** (optional): `INGEST_CHANNEL=channel-name npm run ingest` runs the server-level historical build — archives + lore + events for everyone, derived person data for opted-in members only. The identical routine is available in-bot as `/server-build` (owner/admin).

### Key configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `GROQ_MODEL` | `openai/gpt-oss-120b` | Base model for replies, extraction, synthesis |
| `GUILD_ID` | *(all guilds)* | Restrict to one server — recommended while testing |
| `SPEAK_THRESHOLD` | `0.70` | Minimum `decide()` score to speak; 0.70 ≈ mentions only |
| `RAW_MESSAGE_RETENTION_DAYS` | `30` | Raw archive retention window |
| `CANDIDATE_CONFIDENCE_THRESHOLD` | `0.70` | Confidence needed for candidate → active promotion |
| `VERIFY_MODEL` … `REPLY_TOOLS` | per-workload | Model overrides and reply-tool toggles |

Full reference: [docs/configuration.md](docs/configuration.md)

---

## Development

```bash
npm run check   # typecheck (tsc --noEmit, strict)
npm test        # node:test suite — DB tests need TEST_DATABASE_URL
```

15 co-located `*.test.ts` files cover the confidence math, evidence lifecycle, dedup, entity resolution, command authorization, attribute provenance cascades, and the LLM prompt parsers (via an injected fake client). DB-backed tests run in CI against Postgres 16.

Docs: [architecture](docs/architecture.md) · [schema](docs/schema.md) · [event pipeline](docs/event-pipeline.md) · [development guide](docs/development.md)

### Layout

```
src/
  index.ts        # Discord wiring: handlers, retention, sweep, shutdown
  brain.ts        # every LLM call (injectable client for tests)
  database.ts     # MemoryStore — memories, evidence, lifecycle, maintenance
  attributes.ts   # profile_attributes: provenance-backed structured facets
  profiles.ts     # profile cards + dossier assembly
  commands.ts     # slash commands (authz matrix under test)
  perception.ts   # durable-signal pre-filter, naming detection
  entity-resolution.ts / events.ts / contest.ts / ingest.ts / retry.ts / …
scripts/          # ops tools (sweeps, backfills, verification) — run via tsx
```
