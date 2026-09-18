import type { MemoryStore } from "./database.js";
import type { MessageEvent } from "./types.js";

// ── Entity resolution ─────────────────────────────────────────────────────────
// Memories about people are often written with a display name rather than a
// Discord mention ("Nova is a Buddhist", "Tom lost the bet"). The alias map turns
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
 * Alias-map keys for a display name: the full name, every token ≥4 chars, and
 * every prefix ≥4 of the first token — nickname shortenings ("zeph" for
 * "zephyrine", "nova" for "Nova is a Buddhist") resolve without a learned
 * alias. Variants funnel through buildAliasMap's uniqueness rule, so an
 * ambiguous variant resolves unknown rather than guessing.
 */
export function aliasKeyVariants(name: string): string[] {
  const out = new Set<string>();
  const trimmed = name.trim();
  if (trimmed) out.add(trimmed);
  const tokens = trimmed.split(/\s+/);
  for (const t of tokens) if (t.length >= 4) out.add(t);
  const first = tokens[0] ?? "";
  for (let i = 4; i < first.length; i++) out.add(first.slice(0, i));
  return [...out];
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
    for (const name of member.knownNames) for (const key of aliasKeyVariants(name)) add(key, member.userId);
  }
  for (const row of await store.listAuthorNames(guildId)) {
    add(row.authorId, row.authorId);
    for (const key of aliasKeyVariants(row.authorName)) add(key, row.authorId);
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
 * All aliases compiled into a single `\b(a1|a2|…)\b` pattern, cached per map
 * instance (WeakMap — patterns GC with their maps). One regex construction and
 * one scan per message regardless of alias count. Longest-first ordering inside
 * the alternation is load-bearing: a longer alias wins over its proper
 * word-prefix ("al smith" beats "al"), so a shorter alias belonging to someone
 * else never fires on the same span.
 */
const patternCache = new WeakMap<AliasMap, RegExp | null>();

function aliasPattern(aliasMap: AliasMap): RegExp | null {
  let pattern = patternCache.get(aliasMap);
  if (pattern === undefined) {
    const aliases = [...aliasMap.keys()]
      .filter(a => !DISCORD_ID.test(a))
      .sort((a, b) => b.length - a.length);
    pattern = aliases.length
      ? new RegExp(`\\b(${aliases.map(escapeRegExp).join("|")})\\b`, "gi")
      : null;
    patternCache.set(aliasMap, pattern);
  }
  return pattern;
}

/**
 * Find user IDs referenced by name in message text. Word boundaries apply so
 * "ri" can't match inside "riley". Discord <@ID> mentions are handled separately
 * via message.mentions.
 */
export function findMentionedUsers(content: string, aliasMap: AliasMap): string[] {
  const pattern = aliasPattern(aliasMap);
  if (!pattern) return [];
  const found = new Set<string>();
  for (const m of content.matchAll(pattern)) {
    const id = aliasMap.get(m[1].toLowerCase());
    if (id) found.add(id);
  }
  return [...found];
}

const MENTION_TOKEN = /<@!?(\d+)>/g;

/**
 * Replace `<@id>` mention tokens with `@DisplayName` for LLM-facing text.
 * Raw snowflakes in prompts teach the model to answer in mention markup — or
 * worse, to invent plausible-looking IDs. Unknown ids become a generic
 * "@member" so a real-but-unresolved mention doesn't look like a name.
 */
export function demangleMentions(content: string, names: Map<string, string>): string {
  return content.replace(MENTION_TOKEN, (_m, id) => `@${names.get(id) ?? "member"}`);
}

/**
 * Neutralize mention markup in model output before posting: known ids become
 * plain `@Name` text (allowedMentions already prevents pings); unknown ids —
 * e.g. hallucinated snowflakes — are stripped with whitespace cleaned up.
 */
export function scrubMentions(text: string, names: Map<string, string>): string {
  return text
    .replace(MENTION_TOKEN, (_m, id) => (names.has(id) ? `@${names.get(id)}` : ""))
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([,.!?])/g, "$1")
    .trim();
}
