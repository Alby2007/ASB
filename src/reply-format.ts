import type { PairContext, PairContextEdge } from "./types.js";

// Prompt rendering for the reply path — shared by brain.reply()'s prompt
// sections and the internal lookup tools (lookup-tools.ts), so a person or a
// pair reads identically whether it was pre-fetched or fetched on demand.

export function shortDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function monthYear(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-US", { month: "short", year: "numeric" });
}

/** Render one pair's relationship context as a single prompt line. Direction
 * is preserved explicitly — "A says about B" means A is the asserting side.
 * Claims are attributed ("B claimed about A"), never stated as facts. Depth
 * renders as a confidence tier, gossip-only edges are flagged "all
 * secondhand", stale edges say so, and behavior-only pairs surface strictly
 * as contact frequency — never phrased as a relationship claim. */
export function formatPairContext(ctx: PairContext): string {
  const tier = (n: number) => n >= 5 ? "well-established" : n >= 2 ? "described a few times" : "claimed once";
  const edge = (name: string, e: PairContextEdge, other: string) => {
    if (e.inferred || !e.summary) return null; // behavior-only — rendered via behavioralCount below
    let s = `${name} says about ${other}: "${e.summary}" (${e.valence != null ? e.valence.toFixed(2) : "no valence"}, ${tier(e.observationCount)})`;
    if (e.partyCount === 0) s += " — all secondhand";
    if (e.trend) s += `, lately ${e.trend}`;
    if (e.lastObservedAt && Date.now() - new Date(e.lastObservedAt).getTime() > 60 * 86_400_000) {
      s += " (not recently observed)";
    }
    return s;
  };
  const parts: string[] = [];
  const aEdge = ctx.aToB ? edge(ctx.aName, ctx.aToB, ctx.bName) : null;
  const bEdge = ctx.bToA ? edge(ctx.bName, ctx.bToA, ctx.aName) : null;
  if (aEdge) parts.push(aEdge);
  if (bEdge) parts.push(bEdge);
  if (ctx.behavioralCount >= 5) {
    parts.push(aEdge || bEdge
      ? `also interact frequently (${ctx.behavioralCount} times in 90d)`
      : `frequent interaction (${ctx.behavioralCount} times in 90d) — dynamic not recorded`);
  }
  const reasons = ctx.reasons.map(r => `${r.fromName}: "${r.reason}" (${shortDate(r.at)})`).join("; ");
  if (reasons) parts.push(`recent: ${reasons}`);
  if (ctx.claimsAboutA.length) parts.push(`${ctx.bName} claimed about ${ctx.aName}: ${ctx.claimsAboutA.map(c => `"${c}"`).join(", ")}`);
  if (ctx.claimsAboutB.length) parts.push(`${ctx.aName} claimed about ${ctx.bName}: ${ctx.claimsAboutB.map(c => `"${c}"`).join(", ")}`);
  if (ctx.sharedEvents.length) parts.push(`shared events: ${ctx.sharedEvents.join(", ")}`);
  return `- ${ctx.aName} ↔ ${ctx.bName}: ${parts.join(". ")}`;
}

const ATTR_PLURALS: Record<string, string> = { trait: "traits", interest: "interests", skill: "skills" };
const confLabel = (c: number) => c >= 0.8 ? "high" : c >= 0.55 ? "medium" : "low";

export type ReplyProfile = {
  name: string; summary: string; traits?: string[];
  attributes?: Array<{ field: string; value: string; confidence: number }>;
};

/** One person's line in the People section. Structured attributes render with
 * field labels + confidence buckets so the model can hedge weak facets;
 * legacy flat traits are the fallback for profiles with no attribute rows. */
export function formatReplyProfile(p: ReplyProfile): string {
  const attrs = p.attributes ?? [];
  const base = `- ${p.name}${p.summary ? `: ${p.summary}` : ""}`;
  if (!attrs.length) return `${base}${p.traits?.length ? ` (traits: ${p.traits.join(", ")})` : ""}`;
  const byField = new Map<string, Array<{ value: string; confidence: number }>>();
  for (const a of attrs) {
    const list = byField.get(a.field);
    if (list) list.push(a); else byField.set(a.field, [a]);
  }
  const fields = [...byField.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([field, list]) => {
    const items = [...list].sort((x, y) => y.confidence - x.confidence).map(a => `${a.value} (${confLabel(a.confidence)})`).join(", ");
    return `${list.length > 1 ? (ATTR_PLURALS[field] ?? field) : field}: ${items}`;
  });
  return `${base} — ${fields.join("; ")}`;
}
