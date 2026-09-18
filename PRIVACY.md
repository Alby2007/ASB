# ASB Privacy Policy

_Last updated: 2026-09-18_

ASB ("the bot") is a Discord bot that participates in servers like a member. This policy describes what it stores, why, and how to remove it. Plain English, no legalese.

## What the bot stores

**Raw message archive.** Messages in channels the bot can read are archived to a PostgreSQL database so the bot can reply with context, extract knowledge, and audit where a memory came from. Raw messages are retained for **30 days** by default (the operator may configure 1–365 days) and then permanently deleted.

**Member registry.** Per server, per user: display names/nicknames observed, message count, and first/last activity timestamps. This exists so the bot can tell who a name refers to — it is infrastructure, not a profile.

**Server-level knowledge.** Facts and lore about the server itself (in-jokes, events, what the community is) plus detected server events. These are shared context and do not require individual consent.

**Derived personal data — opt-in only.** Memories about a person, structured profile attributes (pronouns, interests, timezone, etc.), generated profile cards and dossiers, and relationship observations/edges are created **only for members who explicitly opt in** via `/profile-build` or `/opt-in`. Members who never opt in get no derived data.

**Third-party processing.** Message content is sent to a large-language-model API (currently Groq; configurable to any OpenAI-compatible provider) for memory extraction, verification, and reply generation. The operator's API key is used today; a bring-your-own-key model where each server supplies and controls its own key is on the roadmap.

## What the bot does not do

- It does not message users first in DMs, sell data, or share data between servers.
- It does not build profiles or person-memories for members who haven't opted in.
- It does not respond to other bots or store their messages as memory sources.

## Deletion and your controls

- **Deleting a Discord message** removes its archived copy and scrubs the verbatim text from any evidence it produced (audit metadata like evidence type is kept).
- **Editing a message** updates the archived copy. Evidence snapshots deliberately keep the original text, as the record of what a memory was derived from.
- **`/opt-out`** deletes all your derived data (memories, relationships, profile, attributes) and prevents any new derived data about you. Your raw messages remain in the archive until retention expires.
- **`/forget`** removes a single memory.
- **`/memory-export`** lets you download everything the bot holds about you.
- Server admins can set a shorter retention window via `/memory-purge` or disable memory/reply features entirely via `/memory-pause`.

_Roadmap:_ purging a server's data when the bot is removed from it, and per-server encryption of stored keys, are planned but not yet implemented. This document describes current behavior.

## Contact

Operated by [Alby2007](https://github.com/Alby2007). Questions or deletion requests: open an issue on the project repository or contact the operator via GitHub.
