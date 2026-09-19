export type MessageEvent = {
  guildId: string;
  channelId: string;
  messageId: string;
  authorId: string;
  authorName: string;
  content: string;
  createdAt: Date;
  // The message addresses the bot: @-mention, reply-to-bot, or a wake word
  // (bot name / server nick / "asb" said in text — see detectWakeWord).
  mentionsBot: boolean;
  // Transient: populated live from Discord attachments, consumed in-flight by
  // describeImage, never persisted — recordMessage writes explicit columns and
  // no attachment column exists to receive these.
  imageAttachments?: Array<{ url: string; contentType: string; size: number; name?: string }>;
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
  /** 90d mention/name-ref count stamped from the interaction graph —
   *  deterministic contact frequency, not a claim about the dynamic. */
  behavioralCount: number;
  /** Literal observations authored by an edge party — self-report depth.
   *  Zero means every claim about this pair came from a third party. */
  partyCount: number;
  /** 'warming' | 'cooling' | null — recent-5 weighted valence vs all-time,
   *  only set with ≥3 observations. */
  trend: string | null;
  /** Behavior-only edge: frequent interaction, zero literal claims. Renders
   *  as contact frequency, never as a relationship claim. */
  inferred: boolean;
};

export type Member = {
  guildId: string; userId: string; knownNames: string[];
  firstSeenAt: string; lastSeenAt: string; messageCount: number; optedOut: boolean;
  optedIn: boolean;
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

// ── Structured profile attributes ────────────────────────────────────────────
// The source of truth for profile facets: enumerated (field, value) rows with
// memory_ids provenance. profiles.summary/facets_json are renderings of these.
// Status is derived from cited memories except 'superseded', asserted via
// superseded_by — a row can be superseded while its evidence is still live.

export type AttributeStatus = "active" | "contested" | "superseded" | "forgotten";

export type ProfileAttribute = {
  id: number; guildId: string; subjectId: string;
  field: string; value: string; valueNorm: string;
  confidence: number; memoryIds: number[];
  status: AttributeStatus; supersededBy: number | null;
  firstSeenAt: string; lastSeenAt: string;
};

/** A candidate attribute before the upsert-diff decides insert/fold/revive. */
export type AttributeProposal = {
  field: string;
  value: string;
  memoryIds: number[];
  /** value_norm of an existing row this proposal replaces (LLM multi-valued). */
  replaces?: string;
};

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
  /** Confirmed attributes — the structured source the bio renders from. */
  attributes: Array<{ field: string; value: string; confidence: number }>;
  patterns: string[];
  relationships: Array<{ withName: string; summary: string; valence: number | null; observations: number }>;
  events: Array<{ title: string; role: string; significance: number }>;
};

/** LLM output of profile rendering — prose only; facets come from attributes. */
export type ProfileSynthesis = {
  bio: string;
  roleInServer: string;
};

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

/**
 * The reply contract: the model's text plus its read on whether this human is
 * done. `endConversation` removes the author from the channel's conversation —
 * the model understands "ok cool thanks that's all" better than any regex,
 * while detectDismissal stays the deterministic override for explicit exits.
 */
export type ReplyResult = {
  text: string;
  endConversation: boolean;
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
  /** Re-classification passes spent on this event — capped so a
   * 'discard'-verdict candidate stops paying a full LLM call per reference. */
  classifications: number;
  createdAt: string;
  updatedAt: string;
};

/**
 * Pairwise relationship context for the reply prompt — what two specific
 * people assert about each other, separate from either one's standalone
 * profile. Direction is load-bearing: aToB is what A (subject_id, the
 * asserting side) says about B; bToA is the reverse. Claims are attributed
 * assertions, not facts about the subject.
 */
export type PairContextEdge = {
  summary: string; valence: number | null; observationCount: number;
  partyCount: number; trend: string | null; lastObservedAt: string | null;
  /** Behavior-only edge — render as contact frequency, never a claim. */
  inferred: boolean;
};

export type PairContext = {
  aName: string;
  bName: string;
  aToB?: PairContextEdge;
  bToA?: PairContextEdge;
  /** Interaction-graph count for the pair — behavior signal, not a claim.
   *  Surfaces as "frequent interaction" when no edge exists. */
  behavioralCount: number;
  reasons: Array<{ fromName: string; reason: string; at: string }>;
  claimsAboutA: string[];   // things B asserted about A
  claimsAboutB: string[];   // things A asserted about B
  sharedEvents: string[];   // "Title (Sep 2026)"
};
