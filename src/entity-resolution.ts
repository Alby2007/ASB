import type { MemoryStore } from "./database.js";
import type { MessageEvent } from "./types.js";

// ── Entity resolution ─────────────────────────────────────────────────────────
// Memories about people are often written with a display name rather than a
// Discord mention ("Starz is a Muslim", "Tom lost the bet"). The alias map turns
// those names into real user IDs so memories attach to a person instead of
// "unknown". Correctness beats recall: ambiguous names resolve to "unknown".

/** lowercased name/alias → userId. Only unambiguous aliases are included. */
export type AliasMap = Map<string, string>;

const DISCORD_ID = /^\d{5,25}$/;
const loggedAmbiguous = new Set<string>();

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build the guild alias map from `members.known_names`, falling back to
 * `messages` author pairs for rows archived before the members table existed.
 * Also maps each user_id to itself so raw IDs pass through resolution.
 */
export async function buildAliasMap(guildId: string, store: MemoryStore): Promise<AliasMap> {
  const byName = new Map<string, Set<string>>();
  const add = (name: string | undefined, userId: string) => {
    const key = name?.trim().toLowerCase();
    if (!key) return;
    let ids = byName.get(key);
    if (!ids) byName.set(key, (ids = new Set()));
    ids.add(userId);
  };

  for (const member of await store.listMembers(guildId)) {
    add(member.userId, member.userId);
    for (const name of member.knownNames) add(name, member.userId);
  }
  for (const row of await store.listAuthorNames(guildId)) {
    add(row.authorId, row.authorId);
    add(row.authorName, row.authorId);
  }

  const map: AliasMap = new Map();
  for (const [name, ids] of byName) {
    if (ids.size === 1) {
      map.set(name, [...ids][0]);
    } else if (!loggedAmbiguous.has(`${guildId}:${name}`)) {
      loggedAmbiguous.add(`${guildId}:${name}`);
      console.warn(`[entity-resolution] ambiguous name "${name}" maps to ${ids.size} users in guild ${guildId} — resolving as unknown`);
    }
  }
  return map;
}

/**
 * Resolve an extracted subject to a real user ID.
 * Precedence: explicit <@ID> or raw snowflake → exact alias match on
 * subjectName (or subjectId used as a name) → author when self-referential →
 * "unknown". "server" is preserved for server_lore.
 */
export function resolveSubject(
  candidate: { subjectId?: string; subjectName?: string },
  aliasMap: AliasMap,
  event: MessageEvent
): string {
  const rawId = candidate.subjectId?.trim();
  if (rawId && rawId !== "unknown" && rawId !== "server") {
    const mention = rawId.match(/^<@!?(\d+)>$/)?.[1];
    if (mention) return mention;
    if (DISCORD_ID.test(rawId)) return rawId;
    const byAlias = aliasMap.get(rawId.toLowerCase());
    if (byAlias) return byAlias;
  }
  if (rawId === "server") return "server";

  const name = candidate.subjectName?.trim().toLowerCase();
  if (name) {
    const hit = aliasMap.get(name);
    if (hit) return hit;
    if (name === event.authorName.trim().toLowerCase()) return event.authorId;
  }
  return rawId === "server" ? "server" : "unknown";
}

/**
 * Find user IDs referenced by name in message text. Aliases are scanned
 * longest-first with word boundaries so "al" can't match inside "alby".
 * Discord <@ID> mentions are handled separately via message.mentions.
 */
export function findMentionedUsers(content: string, aliasMap: AliasMap): string[] {
  const found = new Set<string>();
  const aliases = [...aliasMap.keys()]
    .filter(a => !DISCORD_ID.test(a))
    .sort((a, b) => b.length - a.length);
  for (const alias of aliases) {
    if (new RegExp(`\\b${escapeRegExp(alias)}\\b`, "i").test(content)) {
      found.add(aliasMap.get(alias)!);
    }
  }
  return [...found];
}
