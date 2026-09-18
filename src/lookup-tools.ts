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

/** Assemble one pair's relationship context — shared by the reply prompt's
 * ≤6-pair section and the lookup_relationship tool so both render identically.
 * Returns undefined when the pair has zero signal. */
export async function buildPairContext(store: MemoryStore, eventStore: EventStore, guildId: string, aId: string, bId: string): Promise<PairContext | undefined> {
  const [pc, events] = await Promise.all([
    store.pairwiseContext(guildId, aId, bId),
    eventStore.sharedEvents(guildId, aId, bId, 3),
  ]);
  if (!pc.ab && !pc.ba && !pc.observations.length && !pc.claimsAboutA.length && !pc.claimsAboutB.length && !events.length) return undefined;
  const [aName, bName] = await Promise.all([
    store.displayNameFor(guildId, aId), store.displayNameFor(guildId, bId),
  ]);
  return {
    aName, bName,
    aToB: pc.ab ? { summary: pc.ab.summary, valence: pc.ab.valence, observationCount: pc.ab.observationCount } : undefined,
    bToA: pc.ba ? { summary: pc.ba.summary, valence: pc.ba.valence, observationCount: pc.ba.observationCount } : undefined,
    reasons: pc.observations.map(o => ({ fromName: o.fromId === aId ? aName : bName, reason: o.reason, at: o.createdAt })),
    claimsAboutA: pc.claimsAboutA,
    claimsAboutB: pc.claimsAboutB,
    sharedEvents: events.map(e => `${e.title} (${monthYear(e.occurredAt)})`),
  };
}

export const LOOKUP_TOOL_NAMES = new Set(["lookup_person", "lookup_relationship", "search_memories", "lookup_event"]);

/** Execute one lookup tool against ctx. Always resolves to a string. */
export async function executeLookupTool(name: string, args: Record<string, unknown>, ctx: ToolCtx): Promise<string> {
  try {
    if (name === "lookup_person") {
      const person = typeof args.name === "string" ? args.name.trim() : "";
      if (!person) return "error: missing name";
      const id = ctx.resolveName(person);
      if (!id) return `no member known as "${person}"`;
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
