export type MessageEvent = {
  guildId: string;
  channelId: string;
  messageId: string;
  authorId: string;
  authorName: string;
  content: string;
  createdAt: Date;
  mentionsBot: boolean;
};

export type MemoryCandidate = {
  subjectId: string;
  kind: "person_fact" | "person_preference" | "server_lore" | "episode";
  content: string;
  // Optional: the LLM does not set these; the database calculates them deterministically.
  confidence?: number;
  importance?: number;
  explicitness?: number;
  reason: string;
  evidenceType?: EvidenceType;
  effect?: EvidenceEffect;
};

export function createMemoryCandidate(candidate: Omit<MemoryCandidate, "confidence" | "importance" | "explicitness"> & { confidence?: number; importance?: number; explicitness?: number; evidenceType: EvidenceType; effect: EvidenceEffect }): MemoryCandidate {
  return {
    ...candidate,
    confidence: candidate.confidence,
    importance: candidate.importance,
    explicitness: candidate.explicitness,
  };
}

export type MemoryStatus = "candidate" | "quarantined" | "active" | "contested" | "superseded" | "forgotten";
export type EvidenceType = "explicit_fact" | "clear_preference" | "direct_observation" | "reported_by_other" | "sarcasm_or_joke" | "uncertain_inference" | "correction";
export type EvidenceEffect = "support" | "contradict" | "correct" | "context";

export type Decision = {
  shouldSpeak: boolean;
  score: number;
  reasons: string[];
};

// ── v0.2 Event types ──────────────────────────────────────────────────────────

export type EventTier = "candidate" | "event";

export type ParticipantRole = "subject" | "antagonist" | "participant" | "observer";

/**
 * What the LLM (or heuristic) decides to do with an incoming message relative
 * to currently open event windows.
 */
export type ContinuityDecision =
  | { action: "attach";    eventId: number }
  | { action: "new" }
  | { action: "reference"; eventId: number }   // message mentions a past event without extending it
  | { action: "bridge";    eventIds: number[] }; // message connects two open events

export type EventParticipant = {
  userId: string;
  userName: string;
  role: ParticipantRole;
};

export type EventCandidate = {
  guildId: string;
  channelId: string;
  title: string;
  summary: string;
  significance: number;
  tier: EventTier;
  occurredAt: Date;
  participants: EventParticipant[];
  messageIds: string[];
  memoryIds: number[];
};

export type StoredEvent = EventCandidate & {
  id: number;
  closedAt: Date | null;
  referenceCount: number;
  createdAt: string;
  updatedAt: string;
};
