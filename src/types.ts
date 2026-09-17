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
  // The subject's name exactly as written in the message — resolved to a user ID
  // via the alias map when subjectId can't be determined directly.
  subjectName?: string;
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

/**
 * An LLM-asserted interpersonal dynamic between two chatters.
 * subjectName omitted/empty = the assertion is about the message author.
 */
export type RelationshipAssertion = {
  subjectName?: string;
  otherName: string;
  nature: string;
  // Language judgment like evidenceType: -1 hostile … 0 neutral … +1 close.
  valence: number;
  reason?: string;
};

/** What one message's extraction pass produces. */
export type ExtractionResult = {
  memories: MemoryCandidate[];
  relationships: RelationshipAssertion[];
};

export type RelationshipEdge = {
  id: number; guildId: string; subjectId: string; otherId: string;
  summary: string; valence: number | null; observationCount: number;
  lastObservedAt: string | null; updatedAt: string;
};

export type Member = {
  guildId: string; userId: string; knownNames: string[];
  firstSeenAt: string; lastSeenAt: string; messageCount: number; optedOut: boolean;
};

export type Profile = {
  guildId: string; subjectId: string; displayName: string;
  summary: string; facets: ProfileFacets;
  builtAt: string | null; updatedAt: string;
};

export type ProfileFacets = {
  traits?: string[];
  interests?: string[];
  notableRelationships?: string[];
  roleInServer?: string;
  dossier?: Dossier;
};

// ── Dossier (tier-2 profile) ─────────────────────────────────────────────────
// Detailed per-section synthesis stored under facets_json.dossier. Each section
// is rebuilt only when its own input hash changes.

export type DossierSection = "voice" | "life_situation" | "temperament" | "beliefs" | "relationship_map" | "reputation" | "timeline";

export type DossierSectionResult = {
  hash: string;
  builtAt: string;
  // Section-specific payload (prose, items[] with source_ids, entries[] …).
  data: Record<string, unknown>;
};

export type Dossier = {
  sections: Partial<Record<DossierSection, DossierSectionResult>>;
};

/** A dossier item that cites the memories it was synthesized from. */
export type SourcedItem = { text: string; source_ids?: number[]; confirmed?: boolean };

export type VoiceSectionData = {
  prose: string;
  quirks: string[];
  stats: { avgLength: number; capsRatio: number; emojiRatio: number; questionRatio: number; sampleSize: number };
};

export type SourcedListSectionData = { prose?: string; items: SourcedItem[] };

export type RelationshipMapEntry = { name: string; dynamic: string; source_ids?: number[] };
export type RelationshipMapData = { entries: RelationshipMapEntry[] };

export type TimelineEntry = { title: string; date: string; role: string; significance: number };
export type TimelineData = { entries: TimelineEntry[] };

/** Deterministic inputs gathered for one subject before profile synthesis. */
export type ProfileSynthesisInput = {
  displayName: string;
  stats: {
    messageCount: number;
    firstSeenAt: string | null;
    lastSeenAt: string | null;
    topChannel: string | null;
    activeHours: string;
  };
  memories: Array<{ content: string; kind: string; confidence: number; confirmed: boolean }>;
  patterns: string[];
  relationships: Array<{ withName: string; summary: string; valence: number | null; observations: number }>;
  events: Array<{ title: string; role: string; significance: number }>;
};

/** LLM output of profile synthesis (camelCase form of the profile facets). */
export type ProfileSynthesis = {
  bio: string;
  traits: string[];
  interests: string[];
  notableRelationships: string[];
  roleInServer: string;
};

export function createMemoryCandidate(candidate: Omit<MemoryCandidate, "confidence" | "importance" | "explicitness"> & { confidence?: number; importance?: number; explicitness?: number; evidenceType: EvidenceType; effect: EvidenceEffect }): MemoryCandidate {
  return {
    ...candidate,
    confidence: candidate.confidence,
    importance: candidate.importance,
    explicitness: candidate.explicitness,
  };
}

/** Sincerity verdict for a candidate memory, judged against its source message.
 * "misattributed" = the source is quoting/pasting/describing someone other than the poster. */
export type VerificationVerdict = "literal" | "joke" | "unclear" | "misattributed";

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
