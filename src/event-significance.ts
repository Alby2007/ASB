import type { EventTier } from "./types.js";

/**
 * Deterministic component of significance scoring.
 *
 * The LLM classifyEvent() call provides tone, narrativeComplete, and
 * futureRelevant.  This module combines those signals with the measurable
 * structural signals (participant count, message count, memory count) to
 * produce a single 0–1 significance score and a tier decision.
 *
 * Keeping the formula here (not in event-detection.ts) means it can be tested
 * in isolation without any LLM machinery.
 */

export type SignificanceInputs = {
  // Structural signals — measurable without LLM
  distinctParticipants: number;
  messageCount: number;
  memoryCount: number;
  // LLM-supplied signals
  tone: "calm" | "playful" | "argumentative" | "dramatic" | string;
  narrativeComplete: boolean;
  futureRelevant: boolean;
};

export type SignificanceResult = {
  score: number;     // 0–1
  tier: EventTier | "discard";
};

// Tier thresholds (matching the plan spec)
const THRESHOLD_DISCARD   = 0.35;
const THRESHOLD_CANDIDATE = 0.60;

// Signal weights (must sum to 1.0)
const W_PARTICIPANTS = 0.15;
const W_MESSAGES     = 0.10;
const W_MEMORIES     = 0.20;
const W_TONE         = 0.15;
const W_NARRATIVE    = 0.15;
const W_FUTURE       = 0.15;
// Remaining 0.10 is allocated to memory-count overflow (> 3 memories is extra evidence)
const W_MEMORY_BONUS = 0.10;

function toneScore(tone: string): number {
  switch (tone.toLowerCase()) {
    case "dramatic":     return 1.0;
    case "argumentative": return 0.6;
    case "playful":      return 0.3;
    case "calm":
    default:             return 0.0;
  }
}

export function calculateSignificance(inputs: SignificanceInputs): SignificanceResult {
  const participantScore = inputs.distinctParticipants >= 3 ? 1.0
    : inputs.distinctParticipants >= 2 ? 0.5
    : 0.0;

  const messageScore = Math.min(1.0, inputs.messageCount / 8);

  const memoryScore = Math.min(1.0, inputs.memoryCount / 3);

  // Bonus for many memories — strong signal that the incident was information-dense
  const memoryBonus = Math.min(1.0, Math.max(0, inputs.memoryCount - 3) / 4);

  const tScore = toneScore(inputs.tone);

  const narrativeScore = inputs.narrativeComplete ? 1.0 : 0.0;

  const futureScore = inputs.futureRelevant ? 1.0 : 0.0;

  const score = (
    W_PARTICIPANTS * participantScore +
    W_MESSAGES     * messageScore +
    W_MEMORIES     * memoryScore +
    W_MEMORY_BONUS * memoryBonus +
    W_TONE         * tScore +
    W_NARRATIVE    * narrativeScore +
    W_FUTURE       * futureScore
  );

  const clamped = Math.min(1, Math.max(0, score));

  let tier: EventTier | "discard";
  if (clamped < THRESHOLD_DISCARD) {
    tier = "discard";
  } else if (clamped < THRESHOLD_CANDIDATE) {
    tier = "candidate";
  } else {
    tier = "event";
  }

  return { score: clamped, tier };
}
