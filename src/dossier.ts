import { createHash } from "node:crypto";
import type { MemoryStore, Memory } from "./database.js";
import type { EventStore } from "./events.js";
import type { DossierSection, Member, TimelineData } from "./types.js";

// ── Dossier input gathering ──────────────────────────────────────────────────
// Each section gathers its own inputs and hashes them; buildProfiles only calls
// the LLM for sections whose hash changed since the last build.

export type DossierInput = {
  section: DossierSection;
  hash: string;
  payload: Record<string, unknown>;
};

/** Precomputed per-member context shared across sections (caller computes once
 * per guild run — e.g. the interaction graph over all archived messages). */
export type DossierContext = {
  interactions?: Array<{ otherId: string; count: number }>;
};

function hashInput(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

type SourcedMemory = { id: number; content: string; kind: string; confidence: number; confirmed: boolean };

function toSourced(m: Memory, confirmed: boolean): SourcedMemory {
  return { id: m.id, content: m.content, kind: m.kind, confidence: m.confidence, confirmed };
}

/** Deterministic voice stats computed over the raw message sample. */
function voiceStats(samples: string[]): { avgLength: number; capsRatio: number; emojiRatio: number; questionRatio: number; sampleSize: number } {
  const n = samples.length || 1;
  const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]|<a?:\w+:\d+>/u;
  return {
    avgLength: Math.round(samples.reduce((s, m) => s + m.length, 0) / n),
    capsRatio: +(samples.filter(m => { const letters = m.replace(/[^a-z]/gi, ""); return letters.length >= 8 && letters === letters.toUpperCase(); }).length / n).toFixed(2),
    emojiRatio: +(samples.filter(m => EMOJI.test(m)).length / n).toFixed(2),
    questionRatio: +(samples.filter(m => m.trim().endsWith("?")).length / n).toFixed(2),
    sampleSize: samples.length,
  };
}

/**
 * Gather inputs for every dossier section of one member. Returns only sections
 * that have enough data to be worth building — absent sections are skipped.
 */
export async function gatherDossierInputs(
  guildId: string,
  member: Member,
  memoryStore: MemoryStore,
  eventStore: EventStore,
  ctx: DossierContext = {},
): Promise<Map<DossierSection, DossierInput>> {
  const out = new Map<DossierSection, DossierInput>();

  const active = await memoryStore.allActiveMemories(guildId, member.userId);
  const candidates = (await memoryStore.listMemories(guildId, member.userId, { status: "candidate" })).memories
    .filter(m => m.confidence >= 0.5);
  const sourced = [...active.map(m => toSourced(m, true)), ...candidates.map(m => toSourced(m, false))];

  // voice — raw message sample + deterministic style stats (ground truth data)
  if (member.messageCount >= 20) {
    const sample = await memoryStore.sampleMessages(guildId, member.userId);
    if (sample.length >= 10) {
      const messages = sample.map(s => s.content.slice(0, 200));
      const payload = { stats: voiceStats(messages), samples: messages.slice(0, 40) };
      out.set("voice", { section: "voice", hash: hashInput(payload), payload });
    }
  }

  // life_situation — self-reported facts (person_fact kind)
  const lifeFacts = sourced.filter(m => m.kind === "person_fact");
  if (lifeFacts.length) {
    const payload = { items: lifeFacts.slice(0, 20) };
    out.set("life_situation", { section: "life_situation", hash: hashInput(payload), payload });
  }

  // temperament — memories + behavioral patterns + relationship edges
  const patterns = await memoryStore.patterns(guildId, member.userId);
  // mergedEdges collapses A→B and B→A into one counterparty view so
  // bidirectionally-observed pairs aren't fragmented across two directed edges.
  const edges = await memoryStore.mergedEdges(guildId, member.userId);
  const interactionIds = (ctx.interactions ?? []).slice(0, 5).map(i => i.otherId);
  const names = await memoryStore.displayNamesFor(guildId, [...edges.slice(0, 8).map(e => e.otherId), ...interactionIds]);
  const edgeViews = [] as Array<{ name: string; summary: string; natures: string[]; valence: number | null; observations: number; trend: string | null; behavioral: number; inferred: boolean }>;
  for (const e of edges.slice(0, 8)) {
    edgeViews.push({ name: names.get(e.otherId)!, summary: e.summary, natures: e.natures, valence: e.valence, observations: e.observationCount, trend: e.trend, behavioral: e.behavioralCount, inferred: e.inferred });
  }
  if (sourced.length || patterns.length || edgeViews.length) {
    const payload = {
      memories: sourced.slice(0, 15),
      patterns: patterns.map(p => p.description),
      relationships: edgeViews,
    };
    out.set("temperament", { section: "temperament", hash: hashInput(payload), payload });
  }

  // beliefs — preferences + lore they're attached to
  const beliefItems = sourced.filter(m => m.kind === "person_preference" || m.kind === "server_lore");
  if (beliefItems.length) {
    const payload = { items: beliefItems.slice(0, 20) };
    out.set("beliefs", { section: "beliefs", hash: hashInput(payload), payload });
  }

  // relationship_map — edges + the reasons behind each observation + the
  // deterministic interaction graph (how often they actually address each other)
  const interactionViews = [] as Array<{ name: string; addressedCount: number }>;
  for (const i of (ctx.interactions ?? []).slice(0, 5)) {
    interactionViews.push({ name: names.get(i.otherId)!, addressedCount: i.count });
  }
  if (edgeViews.length || interactionViews.length) {
    const observations = await memoryStore.relationshipObservationsFor(guildId, member.userId);
    const obsNames = await memoryStore.displayNamesFor(guildId, observations.slice(0, 25).map(o => o.otherId));
    const obsViews = [] as Array<{ name: string; nature: string; valence: number | null; reason: string; direction: string; source: string }>;
    for (const o of observations.slice(0, 25)) {
      obsViews.push({ name: obsNames.get(o.otherId)!, nature: o.nature, valence: o.valence, reason: o.reason, direction: o.direction, source: o.source });
    }
    const payload = { edges: edgeViews, observations: obsViews, interactions: interactionViews };
    out.set("relationship_map", { section: "relationship_map", hash: hashInput(payload), payload });
  }

  // reputation — claims about this member asserted by other people
  const claims = await memoryStore.thirdPartyClaims(guildId, member.userId);
  if (claims.length) {
    const payload = {
      items: claims.slice(0, 15).map(c => ({
        id: c.memoryId, content: c.content, confidence: c.confidence,
        confirmed: c.status === "active",
      })),
    };
    out.set("reputation", { section: "reputation", hash: hashInput(payload), payload });
  }

  // timeline — deterministic, no LLM
  const events = (await eventStore.listEvents(guildId, { subjectUserId: member.userId, tier: "event" })).events
    .sort((a, b) => b.significance - a.significance).slice(0, 10);
  if (events.length) {
    const data: TimelineData = {
      entries: events.map(e => ({
        title: e.title || `Event #${e.id}`,
        date: new Date(e.occurredAt).toISOString().slice(0, 10),
        role: e.participants.find(p => p.userId === member.userId)?.role ?? "participant",
        significance: e.significance,
      })),
    };
    out.set("timeline", { section: "timeline", hash: hashInput(data), payload: data as unknown as Record<string, unknown> });
  }

  return out;
}
