import type { Brain } from "./brain.js";
import type { EventStore } from "./events.js";
import type { MemoryStore } from "./database.js";
import type { ContinuityDecision, MessageEvent, StoredEvent } from "./types.js";
import { calculateSignificance } from "./event-significance.js";

// ── Heuristic pre-filter constants ────────────────────────────────────────────

/** Open events newer than this are considered for attach (ms). */
const OPEN_EVENT_MAX_AGE_MS = 4 * 60 * 60 * 1000; // 4 hours

/** Score above which the heuristic is confident enough to attach without LLM. */
const HEURISTIC_ATTACH_THRESHOLD = 0.60;

/** Score above which the heuristic is confident enough to discard without LLM. */
const HEURISTIC_DISCARD_THRESHOLD = 0.15;

/** Maximum number of candidate events passed to the LLM for continuity judgement. */
const MAX_LLM_CANDIDATES = 3;

/** Max messages from an open event sent to the LLM for context. */
const LLM_CONTEXT_MESSAGES = 5;

/**
 * Patterns that indicate a message is explicitly referencing a past occurrence.
 * A match is a positive signal for "reference" rather than "new".
 */
const BACK_REFERENCE_RE = /\b(remember\s+when|that\s+time|same\s+(?:thing|incident|situation|story)\s+again|just\s+(?:like|did\s+it)\s+again|happened\s+again|as\s+(?:always|usual)|same\s+as\s+(?:last|before)|you\s+(?:always|never)|he(?:'s|\s+is)\s+doing\s+it\s+again)\b/i;

// ── Heuristic scoring ─────────────────────────────────────────────────────────

type HeuristicScore = {
  eventId: number;
  score: number;
  isReplyChain: boolean;
};

/**
 * Score how likely this message is to belong to an open event.
 * Returns scores sorted descending. Does NOT call the LLM.
 */
function scoreOpenEvents(
  message: MessageEvent,
  openEvents: StoredEvent[],
  replyToMessageId?: string
): HeuristicScore[] {
  const now = Date.now();
  return openEvents
    .map(ev => {
      let score = 0;

      // Time recency: events get stale
      const ageMs = now - ev.occurredAt.getTime();
      if (ageMs > OPEN_EVENT_MAX_AGE_MS) return { eventId: ev.id, score: -1, isReplyChain: false };
      score += 0.20 * Math.max(0, 1 - ageMs / OPEN_EVENT_MAX_AGE_MS);

      // Reply-chain: very strong signal
      const isReplyChain = !!replyToMessageId && ev.messageIds.includes(replyToMessageId);
      if (isReplyChain) score += 0.50;

      // Shared participants
      const eventUserIds = new Set(ev.participants.map(p => p.userId));
      if (eventUserIds.has(message.authorId)) score += 0.20;

      // Entity/keyword overlap with event title+summary
      const evText = `${ev.title} ${ev.summary}`.toLowerCase();
      const msgWords = message.content.toLowerCase().split(/\W+/).filter(w => w.length > 3);
      const overlappingWords = msgWords.filter(w => evText.includes(w));
      if (overlappingWords.length > 0) score += Math.min(0.20, overlappingWords.length * 0.05);

      // Same channel bonus (weak signal on its own)
      if (ev.channelId === message.channelId) score += 0.05;

      // Back-reference: likely a reference rather than a continuation, but still links them
      if (BACK_REFERENCE_RE.test(message.content)) score += 0.10;

      return { eventId: ev.id, score, isReplyChain };
    })
    .filter(s => s.score >= 0)
    .sort((a, b) => b.score - a.score);
}

// ── EventPipeline ─────────────────────────────────────────────────────────────

export class EventPipeline {
  /**
   * Main entry point called from index.ts after memories are saved.
   *
   * @param message   The incoming Discord message.
   * @param savedMemoryIds  IDs of memories just saved from this message (may be empty).
   * @param eventStore  The EventStore instance.
   * @param memoryStore The MemoryStore instance (to read message context).
   * @param brain     The Brain instance (for LLM calls when heuristic is ambiguous).
   * @param replyToMessageId  Optional: Discord message_id this message replies to.
   */
  async process(
    message: MessageEvent,
    savedMemoryIds: number[],
    eventStore: EventStore,
    memoryStore: MemoryStore,
    brain: Brain,
    replyToMessageId?: string
  ): Promise<void> {
    const openEvents = eventStore.openEvents(message.guildId, message.channelId);
    const decision = await this.decideContinuity(message, openEvents, brain, replyToMessageId);

    if (decision.action === "attach") {
      eventStore.attachMessage(decision.eventId, message.messageId);
      eventStore.addParticipant(decision.eventId, message.authorId, message.authorName);
      for (const id of savedMemoryIds) eventStore.attachMemory(decision.eventId, id, "generated");
    } else if (decision.action === "reference") {
      eventStore.incrementReferenceCount(decision.eventId);
      for (const id of savedMemoryIds) eventStore.attachMemory(decision.eventId, id, "referenced");
      // Re-score the referenced event if its reference count has reached a promotion threshold
      await this.maybeRetroactivelyPromote(decision.eventId, message.guildId, eventStore, memoryStore, brain);
    } else if (decision.action === "bridge") {
      // Attach to the first event and record the link on the second
      const [primary, ...rest] = decision.eventIds;
      if (primary != null) {
        eventStore.attachMessage(primary, message.messageId);
        eventStore.addParticipant(primary, message.authorId, message.authorName);
        for (const id of savedMemoryIds) eventStore.attachMemory(primary, id, "generated");
      }
      for (const bridgedId of rest) {
        eventStore.incrementReferenceCount(bridgedId);
      }
    } else {
      // "new" — only create a candidate event window if the message produced at least one memory
      // (ordinary chatter that didn't generate any memories doesn't need an event window).
      if (savedMemoryIds.length > 0) {
        const ev = eventStore.createEvent({
          guildId: message.guildId,
          channelId: message.channelId,
          title: "",
          summary: "",
          significance: 0,
          tier: "candidate",
          occurredAt: message.createdAt,
          participants: [{ userId: message.authorId, userName: message.authorName, role: "participant" }],
        });
        eventStore.attachMessage(ev.id, message.messageId);
        for (const id of savedMemoryIds) eventStore.attachMemory(ev.id, id, "generated");
      }
    }
  }

  // ── Continuity decision ───────────────────────────────────────────────────

  async decideContinuity(
    message: MessageEvent,
    openEvents: StoredEvent[],
    brain: Brain,
    replyToMessageId?: string
  ): Promise<ContinuityDecision> {
    if (openEvents.length === 0) return { action: "new" };

    const scores = scoreOpenEvents(message, openEvents, replyToMessageId);
    if (scores.length === 0) return { action: "new" };

    const top = scores[0];

    // Definite attach: reply chain, or heuristic score well above threshold
    if (top.isReplyChain || top.score >= HEURISTIC_ATTACH_THRESHOLD) {
      return { action: "attach", eventId: top.eventId };
    }

    // Definite discard: nothing scores above the noise floor
    if (top.score < HEURISTIC_DISCARD_THRESHOLD) return { action: "new" };

    // Ambiguous: ask the LLM
    const candidates = scores.slice(0, MAX_LLM_CANDIDATES);
    const llmEvents = candidates.map(s => {
      const ev = openEvents.find(e => e.id === s.eventId)!;
      // We don't have the raw messages here, so we use the title/summary as context.
      // The message archive is queried via MemoryStore in the full pipeline (index.ts),
      // but for the Brain call we use what we have on the event object already.
      return {
        id: ev.id,
        title: ev.title || `(untitled event #${ev.id})`,
        summary: ev.summary || `Started at ${ev.occurredAt.toISOString()} with ${ev.participants.map(p => p.userName).join(", ")}`,
        recentMessages: [] as Array<{ authorName: string; content: string }>,
      };
    });
    return brain.assessContinuity(message, llmEvents);
  }

  // ── Retroactive promotion ─────────────────────────────────────────────────

  /**
   * Called when a "reference" back-reference is recorded against an event.
   * If the event has accumulated enough references, re-evaluate its significance.
   */
  async maybeRetroactivelyPromote(
    eventId: number,
    guildId: string,
    eventStore: EventStore,
    memoryStore: MemoryStore,
    brain: Brain
  ): Promise<void> {
    const ev = eventStore.getEvent(guildId, eventId);
    if (!ev || ev.tier === "event") return; // already promoted or not found
    if (ev.referenceCount < 2) return;     // wait for more evidence

    // Re-classify using current cluster data
    const cluster = buildCluster(ev, memoryStore);
    const classification = await brain.classifyEvent(cluster);
    const { score, tier } = calculateSignificance({
      distinctParticipants: ev.participants.length,
      messageCount: ev.messageIds.length,
      memoryCount: ev.memoryIds.length,
      tone: classification.tone,
      narrativeComplete: classification.narrativeComplete,
      futureRelevant: classification.futureRelevant,
    });

    if (tier === "event") {
      eventStore.updateSignificance(eventId, score, "event", classification.title, classification.summary);
    } else if (tier === "candidate" && ev.tier !== "candidate") {
      eventStore.updateSignificance(eventId, score, "candidate", classification.title, classification.summary);
    }
    // "discard" tier — don't downgrade an event that has accumulated references
  }

  // ── Cluster scoring (for nightly maintain() call) ─────────────────────────

  /**
   * Close stale open events and score candidate events.
   * Called by the daily maintenance job in index.ts.
   */
  async maintainEvents(
    guildId: string,
    eventStore: EventStore,
    memoryStore: MemoryStore,
    brain: Brain,
    maxAgeMs = 24 * 60 * 60 * 1000
  ): Promise<{ closed: number; promoted: number; discarded: number }> {
    const closed = eventStore.closeStaleEvents(guildId, maxAgeMs);

    // Score all closed candidate events that have not been given a score yet
    const unscored = eventStore.listEvents(guildId, { tier: "candidate" });
    let promoted = 0, discarded = 0;

    for (const ev of unscored.events) {
      if (ev.closedAt == null) continue; // still open
      const cluster = buildCluster(ev, memoryStore);
      const classification = await brain.classifyEvent(cluster);
      const { score, tier } = calculateSignificance({
        distinctParticipants: ev.participants.length,
        messageCount: ev.messageIds.length,
        memoryCount: ev.memoryIds.length,
        tone: classification.tone,
        narrativeComplete: classification.narrativeComplete,
        futureRelevant: classification.futureRelevant,
      });
      if (tier === "event") {
        eventStore.updateSignificance(ev.id, score, "event", classification.title, classification.summary);
        promoted++;
      } else if (tier === "discard") {
        // Discard: close the record with significance 0 and leave tier as candidate
        // (we never hard-delete — "discard" just means we don't surface it)
        eventStore.updateSignificance(ev.id, score, "candidate", ev.title, ev.summary);
        discarded++;
      }
    }

    return { closed, promoted, discarded };
  }
}

// ── Cluster builder helper ────────────────────────────────────────────────────

function buildCluster(
  ev: StoredEvent,
  memoryStore: MemoryStore
): {
  messages: Array<{ authorName: string; content: string; createdAt: string }>;
  participants: string[];
  memoryCount: number;
} {
  // Read back the raw messages from the message archive where possible.
  // recentContext returns the last 12 — enough for cluster scoring.
  const context = memoryStore.recentContext(ev.guildId, ev.channelId, 50)
    .filter(m => ev.messageIds.includes((m as unknown as { messageId?: string }).messageId ?? ""))
    .map(m => ({ authorName: m.authorName, content: m.content, createdAt: m.createdAt }));

  // Fall back to an empty message list if the raw messages have been purged.
  return {
    messages: context,
    participants: ev.participants.map(p => p.userName),
    memoryCount: ev.memoryIds.length,
  };
}
