import type { PairContext } from "./types.js";

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
 * Claims are attributed ("B claimed about A"), never stated as facts. */
export function formatPairContext(ctx: PairContext): string {
  const edge = (name: string, e: { summary: string; valence: number | null; observationCount: number }, other: string) =>
    `${name} says about ${other}: "${e.summary}" (${e.valence != null ? e.valence.toFixed(2) : "no valence"}, ${e.observationCount} obs)`;
  const parts: string[] = [];
  if (ctx.aToB) parts.push(edge(ctx.aName, ctx.aToB, ctx.bName));
  if (ctx.bToA) parts.push(edge(ctx.bName, ctx.bToA, ctx.aName));
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
