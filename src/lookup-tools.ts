import type { MemoryStore } from "./database.js";
import type { EventStore } from "./events.js";
import type { ProfileStore } from "./profiles.js";
import type { PairContext } from "./types.js";
import { formatPairContext, formatReplyProfile, monthYear, shortDate } from "./reply-format.js";

// Internal lookup tools for the reply path — read-only queries over the bot's
// own data, callable by the model when conversation turns to someone outside
// the pre-fetched prompt window. Errors return as strings (the dispatcher's
// contract); privacy boundaries inherit from the wrapped store methods.

/** Guild-scoped handles the lookup tools run against — built once per reply
 * in index.ts and threaded through brain.reply() into the tool loop. */
export type ToolCtx = {
  guildId: string;
  store: MemoryStore;
  eventStore: EventStore;
  profileStore: ProfileStore;
  /** Lowercase-name → userId via the guild alias map; undefined when unknown. */
  resolveName: (name: string) => string | undefined;
};

/** Derived-data consent for a member row: opted in and not opted out. The bot
 * is auto-opted-in by the retention pass, so human↔bot pairs surface — the
 * same "either party consents" rule persistence applies. */
async function memberConsented(store: MemoryStore, guildId: string, userId: string): Promise<boolean> {
  const m = await store.getMember(guildId, userId);
  return !!m?.optedIn && !m.optedOut;
}

/** Assemble one pair's relationship context — shared by the reply prompt's
 * ≤6-pair section and the lookup_relationship tool so both render identically.
 * Returns undefined when the pair has zero signal OR when neither party
 * consents: pair data is shared once either side opts in (the persistence
 * rule in persist-extraction.ts), and gating here covers every consumer —
 * including rows written before consent gating existed. */
export async function buildPairContext(store: MemoryStore, eventStore: EventStore, guildId: string, aId: string, bId: string): Promise<PairContext | undefined> {
  const [aOk, bOk] = await Promise.all([
    memberConsented(store, guildId, aId), memberConsented(store, guildId, bId),
  ]);
  if (!aOk && !bOk) return undefined;
  const [pc, events] = await Promise.all([
    store.pairwiseContext(guildId, aId, bId),
    eventStore.sharedEvents(guildId, aId, bId, 3),
  ]);
  if (!pc.ab && !pc.ba && !pc.observations.length && !pc.claimsAboutA.length && !pc.claimsAboutB.length && !events.length && !pc.behavioralCount) return undefined;
  const [aName, bName] = await Promise.all([
    store.displayNameFor(guildId, aId), store.displayNameFor(guildId, bId),
  ]);
  const edge = (e: typeof pc.ab) => e ? {
    summary: e.summary, valence: e.valence, observationCount: e.observationCount,
    partyCount: e.partyCount, trend: e.trend, lastObservedAt: e.lastObservedAt, inferred: e.inferred,
  } : undefined;
  return {
    aName, bName,
    aToB: edge(pc.ab),
    bToA: edge(pc.ba),
    behavioralCount: pc.behavioralCount,
    reasons: pc.observations.map(o => ({ fromName: o.fromId === aId ? aName : bName, reason: o.reason, at: o.createdAt })),
    claimsAboutA: pc.claimsAboutA,
    claimsAboutB: pc.claimsAboutB,
    sharedEvents: events.map(e => `${e.title} (${monthYear(e.occurredAt)})`),
  };
}

export const LOOKUP_TOOL_NAMES = new Set(["lookup_person", "lookup_relationship", "search_memories", "lookup_event"]);

/** Derived-data consent: opted in and not opted out. Non-members (including
 * "unknown" subjects) are not consented — their rows are inert anyway. */
async function hasConsent(ctx: ToolCtx, userId: string): Promise<boolean> {
  return memberConsented(ctx.store, ctx.guildId, userId);
}

/** Execute one lookup tool against ctx. Always resolves to a string. */
export async function executeLookupTool(name: string, args: Record<string, unknown>, ctx: ToolCtx): Promise<string> {
  try {
    if (name === "lookup_person") {
      const person = typeof args.name === "string" ? args.name.trim() : "";
      if (!person) return "error: missing name";
      const id = ctx.resolveName(person);
      if (!id) return `no member known as "${person}"`;
      if (!(await hasConsent(ctx, id))) return `"${person}" hasn't opted in to profiles`;
      const [profile, attrs] = await Promise.all([
        ctx.profileStore.getProfile(ctx.guildId, id),
        ctx.store.attributesFor(ctx.guildId, id),
      ]);
      const active = attrs.filter(a => a.status === "active").map(a => ({ field: a.field, value: a.value, confidence: a.confidence }));
      if (!profile && !active.length) return `no profile or attributes recorded for "${person}"`;
      const displayName = profile?.displayName ?? await ctx.store.displayNameFor(ctx.guildId, id);
      return formatReplyProfile({ name: displayName, summary: profile?.summary ?? "", attributes: active });
    }

    if (name === "lookup_relationship") {
      const a = typeof args.person_a === "string" ? args.person_a.trim() : "";
      const b = typeof args.person_b === "string" ? args.person_b.trim() : "";
      if (!a || !b) return "error: missing person_a or person_b";
      const aId = ctx.resolveName(a), bId = ctx.resolveName(b);
      if (!aId) return `no member known as "${a}"`;
      if (!bId) return `no member known as "${b}"`;
      // Pair data is shared once EITHER side consents — the same rule the
      // persistence path applies (persist-extraction.ts). Gating reads the
      // same way filters any rows written before consent gating existed.
      if (!(await hasConsent(ctx, aId)) && !(await hasConsent(ctx, bId)))
        return `"${a}" and "${b}" haven't opted in to profiles`;
      const pc = await buildPairContext(ctx.store, ctx.eventStore, ctx.guildId, aId, bId);
      return pc ? formatPairContext(pc).replace(/^- /, "") : `no recorded dynamic between "${a}" and "${b}"`;
    }

    if (name === "search_memories") {
      const query = typeof args.query === "string" ? args.query.trim() : "";
      if (!query) return "error: missing query";
      const subject = typeof args.subject === "string" ? args.subject.trim() : "";
      if (subject) {
        const id = ctx.resolveName(subject);
        if (!id) return `no member known as "${subject}"`;
        if (!(await hasConsent(ctx, id))) return `"${subject}" hasn't opted in to profiles`;
        const { memories } = await ctx.store.listMemories(ctx.guildId, id, { search: query });
        if (!memories.length) return `no memories matching "${query}" for "${subject}"`;
        const label = await ctx.store.displayNameFor(ctx.guildId, id);
        return memories.slice(0, 5).map(m => `- [${label}] ${m.content} (${(m.confidence ?? 0).toFixed(2)})`).join("\n");
      }
      const hits = await ctx.store.searchMemories(ctx.guildId, query, 5);
      if (!hits.length) return `no memories matching "${query}"`;
      const labels = new Map<string, string>();
      for (const h of hits) {
        if (!labels.has(h.subjectId)) labels.set(h.subjectId, await ctx.store.displayNameFor(ctx.guildId, h.subjectId));
      }
      return hits.map(h => `- [${labels.get(h.subjectId)}] ${h.content} (${h.confidence.toFixed(2)})`).join("\n");
    }

    if (name === "lookup_event") {
      // Deliberately ungated: events are shared server context, not person
      // profiles — participants are part of what happened, like minutes of a
      // meeting. Person-scoped memories still require subject consent above.
      const title = typeof args.title === "string" ? args.title.trim() : "";
      if (!title) return "error: missing title";
      const events = await ctx.eventStore.searchEvents(ctx.guildId, title, 3);
      if (!events.length) return `no events matching "${title}"`;
      return events.map(e =>
        `${e.title || `Event #${e.id}`} (${shortDate(e.occurredAt.toISOString())}) — ${e.summary || "no summary"}. Participants: ${e.participants.map(p => `${p.userName} (${p.role})`).join(", ") || "unknown"}`
      ).join("\n");
    }

    return `error: unknown lookup tool ${name}`;
  } catch (err) {
    return `error: ${(err as Error).message.slice(0, 120)}`;
  }
}
