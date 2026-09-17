import OpenAI from "openai";
import type { Memory } from "./database.js";
import { executeTool, replyToolDefs } from "./tools.js";
import type { ContinuityDecision, Decision, DossierSection, ExtractionResult, MemoryCandidate, MessageEvent, ProfileSynthesis, ProfileSynthesisInput, StoredEvent, VerificationVerdict } from "./types.js";

export class Brain {
  private client: OpenAI;
  constructor(apiKey: string, private model: string, baseURL?: string) { this.client = new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) }); }

  decide(event: MessageEvent, recentBotMessages: number): Decision {
    const reasons: string[] = [];
    let score = 0.05;
    if (event.mentionsBot) { score += 0.85; reasons.push("direct mention"); }
    if (event.content.endsWith("?")) { score += 0.1; reasons.push("question"); }
    // The recency penalty suppresses unsolicited chatter — it must never suppress
    // an explicit mention, which is a direct request for a reply.
    if (recentBotMessages > 0 && !event.mentionsBot) { score -= 0.25; reasons.push("bot spoke recently"); }
    return { shouldSpeak: score >= 0.7, score: Math.max(0, Math.min(1, score)), reasons };
  }

  async extractMemories(event: MessageEvent, replyToContent?: string, note?: string): Promise<ExtractionResult> {
    const replyContext = replyToContent ? `\n\nThis message is a reply to: "${replyToContent}"` : "";
    const noteContext = note ? `\n\nNote: ${note}` : "";
    const response = await this.client.responses.create({
      model: this.model,
      input: `Extract only durable, useful memories from this Discord message. Do not infer sensitive traits, diagnoses, private information, or insults. A single casual message rarely merits memory. Classify the language as evidenceType and its relation to the proposed memory as effect, but do not decide lifecycle transitions. Provide language interpretation only; confidence, importance, and explicitness will be calculated deterministically by the database.\n\nsubjectId rules: use the Author ID below when the memory is about the message author. If the memory is about a different person mentioned in the message, use their Discord user ID if it appears in the message as a mention (<@ID>). If the subject cannot be resolved to a Discord user ID, use "unknown". Never use descriptive labels or slugs.\nsubjectName: the subject's name exactly as written in the message (empty string if none).\n\nQuoted text: if the message's first-person text describes someone other than the author — e.g. "I am <other person's name>", a pasted bio or profile card, or clearly copied/generated text — do not attribute it to the author. Attribute it to the named person via subjectName, or skip it entirely if it reads as pasted content rather than a genuine statement.\n\nAlso emit relationship assertions when the message describes a durable interpersonal dynamic between two people (friendship, conflict, dating, rivalry). For each: subjectName (empty string = the message author), otherName, nature (e.g. "close friends", "antagonizes", "dating"), valence from -1 (hostile) to +1 (close), and a short reason.\n\nAuthor ID: ${event.authorId}\nMessage: ${event.content}${replyContext}${noteContext}`,
      text: { format: { type: "json_schema", name: "memory_candidates", strict: true, schema: {
        type: "object", properties: {
          memories: { type: "array", items: { type: "object", properties: {
            subjectId: { type: "string" }, subjectName: { type: "string" }, kind: { type: "string", enum: ["person_fact", "person_preference", "server_lore", "episode"] }, content: { type: "string" }, reason: { type: "string" }, evidenceType: { type: "string", enum: ["explicit_fact", "clear_preference", "direct_observation", "reported_by_other", "sarcasm_or_joke", "uncertain_inference", "correction"] }, effect: { type: "string", enum: ["support", "contradict", "correct", "context"] }
          }, required: ["subjectId", "subjectName", "kind", "content", "reason", "evidenceType", "effect"], additionalProperties: false } },
          relationships: { type: "array", items: { type: "object", properties: {
            subjectName: { type: "string" }, otherName: { type: "string" }, nature: { type: "string" }, valence: { type: "number" }, reason: { type: "string" }
          }, required: ["subjectName", "otherName", "nature", "valence", "reason"], additionalProperties: false } }
        }, required: ["memories", "relationships"], additionalProperties: false
      } } }
    });
    const raw = JSON.parse(response.output_text) as { memories?: MemoryCandidate[]; relationships?: ExtractionResult["relationships"] };
    return { memories: raw.memories ?? [], relationships: raw.relationships ?? [] };
  }

  async correctMemory(authorId: string, statement: string, existing: Memory[]): Promise<{ replacement: MemoryCandidate; supersedes: number[] }> {
    const response = await this.client.responses.create({
      model: this.model,
      input: `A Discord user is correcting what a bot remembers about them. Convert the correction into exactly one durable replacement memory. Select only existing memory IDs that are actually contradicted by the correction; return none if it merely adds information. Provide language interpretation only; confidence, importance, and explicitness will be calculated deterministically by the database.\n\nUser ID: ${authorId}\nCorrection: ${statement}\nExisting memories: ${existing.map(m => `#${m.id}: ${m.content}`).join("\n")}`,
      text: { format: { type: "json_schema", name: "memory_correction", strict: true, schema: { type: "object", properties: {
        replacement: { type: "object", properties: { subjectId: { type: "string" }, kind: { type: "string", enum: ["person_fact", "person_preference", "server_lore", "episode"] }, content: { type: "string" }, reason: { type: "string" } }, required: ["subjectId", "kind", "content", "reason"], additionalProperties: false },
        supersedes: { type: "array", items: { type: "number" } }
      }, required: ["replacement", "supersedes"], additionalProperties: false } } }
    });
    return JSON.parse(response.output_text) as { replacement: MemoryCandidate; supersedes: number[] };
  }

  /**
   * Given a new message and up to 3 open candidate events, decide whether the
   * message continues an existing event, starts a new one, references a past
   * event without extending it, or bridges multiple events.
   *
   * Only called when the cheap heuristic pre-filter is ambiguous.
   */
  async assessContinuity(
    event: MessageEvent,
    openEvents: Array<{ id: number; title: string; summary: string; recentMessages: Array<{ authorName: string; content: string }> }>
  ): Promise<ContinuityDecision> {
    const eventsText = openEvents.map(e =>
      `Event #${e.id} — "${e.title}"\nSummary: ${e.summary}\nRecent messages:\n${e.recentMessages.map(m => `  ${m.authorName}: ${m.content}`).join("\n")}`
    ).join("\n\n");

    const response = await this.client.responses.create({
      model: this.model,
      input: `You are deciding whether a Discord message continues one of the currently open event windows, starts a fresh event, references a past event without extending it, or bridges multiple events.\n\nNew message\nAuthor: ${event.authorName}\nContent: ${event.content}\n\nOpen event windows:\n${eventsText || "None"}\n\nRespond with your decision.`,
      text: { format: { type: "json_schema", name: "continuity_decision", strict: true, schema: {
        type: "object", properties: {
          action: { type: "string", enum: ["attach", "new", "reference", "bridge"] },
          eventId: { type: "number" },
          eventIds: { type: "array", items: { type: "number" } },
          reason: { type: "string" }
        }, required: ["action", "eventId", "eventIds", "reason"], additionalProperties: false
      } } }
    });
    const raw = JSON.parse(response.output_text) as { action: string; eventId: number; eventIds: number[]; reason: string };
    if (raw.action === "attach" && raw.eventId > 0) return { action: "attach", eventId: raw.eventId };
    if (raw.action === "reference" && raw.eventId > 0) return { action: "reference", eventId: raw.eventId };
    if (raw.action === "bridge" && raw.eventIds?.length) return { action: "bridge", eventIds: raw.eventIds };
    return { action: "new" };
  }

  /**
   * Given a closed candidate event cluster, produce a significance score,
   * tier decision, and — for promoted events — a title and summary.
   */
  async classifyEvent(cluster: {
    messages: Array<{ authorName: string; content: string; createdAt: string }>;
    participants: string[];
    memoryCount: number;
  }): Promise<{ significance: number; tier: "low" | "medium" | "high"; tone: string; narrativeComplete: boolean; futureRelevant: boolean; title: string; summary: string }> {
    const messagesText = cluster.messages.map(m => `[${m.createdAt}] ${m.authorName}: ${m.content}`).join("\n");
    const response = await this.client.responses.create({
      model: this.model,
      input: `Evaluate this Discord conversation cluster and decide how significant it is as a shared event.\n\nParticipants: ${cluster.participants.join(", ")}\nMemories generated: ${cluster.memoryCount}\n\nMessages:\n${messagesText}\n\nProvide your evaluation.`,
      text: { format: { type: "json_schema", name: "event_classification", strict: true, schema: {
        type: "object", properties: {
          significance: { type: "number" },
          tier: { type: "string", enum: ["low", "medium", "high"] },
          tone: { type: "string" },
          narrativeComplete: { type: "boolean" },
          futureRelevant: { type: "boolean" },
          title: { type: "string" },
          summary: { type: "string" }
        }, required: ["significance", "tier", "tone", "narrativeComplete", "futureRelevant", "title", "summary"], additionalProperties: false
      } } }
    });
    const raw = JSON.parse(response.output_text) as {
      significance: number; tier: string; tone: string;
      narrativeComplete: boolean | string; futureRelevant: boolean | string;
      title: string; summary: string;
    };
    return {
      significance: raw.significance,
      tier: raw.tier as "low" | "medium" | "high",
      tone: raw.tone,
      narrativeComplete: raw.narrativeComplete === true || raw.narrativeComplete === "true",
      futureRelevant: raw.futureRelevant === true || raw.futureRelevant === "true",
      title: raw.title,
      summary: raw.summary,
    };
  }

  /**
   * Batch memory extraction for ingestion — processes up to 5 messages per LLM call.
   * Uses Chat Completions (works with llama-4-scout and other non-Responses-API models).
   * Returns a map of messageId → MemoryCandidate[].
   */
  async extractMemoriesBatch(
    messages: Array<{ event: MessageEvent; replyToContent?: string; note?: string }>,
    model: string
  ): Promise<Map<string, ExtractionResult>> {
    const numbered = messages.map((m, i) => {
      const replyCtx = m.replyToContent ? ` [replying to: "${m.replyToContent}"]` : "";
      const noteCtx = m.note ? ` [note: ${m.note}]` : "";
      return `[${i}] Author ID: ${m.event.authorId} | Author: ${m.event.authorName}${replyCtx}${noteCtx}\n${m.event.content}`;
    }).join("\n\n");

    const schema = {
      type: "object" as const,
      properties: {
        results: {
          type: "array" as const,
          items: {
            type: "object" as const,
            properties: {
              index: { type: "number" as const },
              memories: {
                type: "array" as const,
                items: {
                  type: "object" as const,
                  properties: {
                    subjectId: { type: "string" as const },
                    subjectName: { type: "string" as const },
                    kind: { type: "string" as const, enum: ["person_fact", "person_preference", "server_lore", "episode"] },
                    content: { type: "string" as const },
                    reason: { type: "string" as const },
                    evidenceType: { type: "string" as const, enum: ["explicit_fact", "clear_preference", "direct_observation", "reported_by_other", "sarcasm_or_joke", "uncertain_inference", "correction"] },
                    effect: { type: "string" as const, enum: ["support", "contradict", "correct", "context"] },
                  },
                  required: ["subjectId", "subjectName", "kind", "content", "reason", "evidenceType", "effect"],
                  additionalProperties: false,
                },
              },
              relationships: {
                type: "array" as const,
                items: {
                  type: "object" as const,
                  properties: {
                    subjectName: { type: "string" as const },
                    otherName: { type: "string" as const },
                    nature: { type: "string" as const },
                    valence: { type: "number" as const },
                    reason: { type: "string" as const },
                  },
                  required: ["subjectName", "otherName", "nature", "valence", "reason"],
                  additionalProperties: false,
                },
              },
            },
            required: ["index", "memories", "relationships"],
            additionalProperties: false,
          },
        },
      },
      required: ["results"],
      additionalProperties: false,
    };

    const response = await this.client.chat.completions.create({
      model,
      messages: [{
        role: "user",
        content: `Extract only durable, useful memories from each of the following Discord messages. For each message, return its index, any memories found (empty array if none), and any relationship assertions. Do not infer sensitive traits, diagnoses, private information, or insults. A single casual message rarely merits memory.\n\nsubjectId rules: use the Author ID when the memory is about the author. For third-party mentions use their Discord ID from <@ID> syntax. Otherwise use "unknown". Never use descriptive slugs.\nsubjectName: the subject's name exactly as written in the message (empty string if none).\nquoted text: if a message's first-person text describes someone other than its author — e.g. "I am <other person's name>", a pasted bio or profile card, or clearly copied/generated text — do not attribute it to the author. Attribute it to the named person via subjectName, or skip it entirely if it reads as pasted content.\nrelationships: emit when a message describes a durable interpersonal dynamic between two people (friendship, conflict, dating, rivalry). subjectName empty string = the message author; otherName, nature (e.g. "close friends", "antagonizes", "dating"), valence from -1 (hostile) to +1 (close), and a short reason.\n\nMessages:\n\n${numbered}`,
      }],
      response_format: { type: "json_schema", json_schema: { name: "batch_memories", strict: true, schema } },
    });

    const raw = JSON.parse(response.choices[0].message.content ?? "{}") as {
      results: Array<{ index: number; memories?: MemoryCandidate[]; relationships?: ExtractionResult["relationships"] }>;
    };

    const out = new Map<string, ExtractionResult>();
    for (const r of raw.results) {
      const m = messages[r.index];
      if (m) out.set(m.event.messageId, { memories: r.memories ?? [], relationships: r.relationships ?? [] });
    }
    // Ensure every message has an entry, even if LLM omitted it
    for (const m of messages) {
      if (!out.has(m.event.messageId)) out.set(m.event.messageId, { memories: [], relationships: [] });
    }
    return out;
  }

  /**
   * Synthesise a per-chatter profile card from deterministic inputs gathered by
   * ProfileStore.buildProfiles(). Neutral third-person dossier; unconfirmed
   * information must be labelled as such.
   */
  async synthesizeProfile(input: ProfileSynthesisInput, model?: string): Promise<ProfileSynthesis> {
    const schema = {
      type: "object" as const,
      properties: {
        bio: { type: "string" as const },
        traits: { type: "array" as const, items: { type: "string" as const } },
        interests: { type: "array" as const, items: { type: "string" as const } },
        notable_relationships: { type: "array" as const, items: { type: "string" as const } },
        role_in_server: { type: "string" as const },
      },
      required: ["bio", "traits", "interests", "notable_relationships", "role_in_server"],
      additionalProperties: false,
    };

    const memoriesText = input.memories.length
      ? input.memories.map(m => `- [${m.confirmed ? "confirmed" : "unconfirmed"}] ${m.content}`).join("\n")
      : "None";
    const relsText = input.relationships.length
      ? input.relationships.map(r => `- ${r.withName}: ${r.summary} (valence ${r.valence?.toFixed(2) ?? "?"}, ${r.observations} observations)`).join("\n")
      : "None";
    const eventsText = input.events.length
      ? input.events.map(e => `- ${e.title} (role: ${e.role})`).join("\n")
      : "None";

    const response = await this.client.chat.completions.create({
      model: model ?? this.model,
      messages: [{
        role: "user",
        content: `Write a neutral third-person profile card for a Discord server member based only on the evidence below. Label unconfirmed information as unconfirmed. Never infer sensitive traits beyond what the evidence states. Keep the bio under 80 words.\n\nMember: ${input.displayName}\nActivity: ${input.stats.messageCount} messages, first seen ${input.stats.firstSeenAt ?? "unknown"}, last seen ${input.stats.lastSeenAt ?? "unknown"}, most active in ${input.stats.topChannel ?? "unknown"}, active hours ${input.stats.activeHours}\n\nMemories:\n${memoriesText}\n\nBehavioral patterns:\n${input.patterns.map(p => `- ${p}`).join("\n") || "None"}\n\nRelationships:\n${relsText}\n\nEvents participated in:\n${eventsText}`,
      }],
      response_format: { type: "json_schema", json_schema: { name: "profile", strict: true, schema } },
    });

    const raw = JSON.parse(response.choices[0].message.content ?? "{}") as {
      bio?: string; traits?: string[]; interests?: string[]; notable_relationships?: string[]; role_in_server?: string;
    };
    return {
      bio: raw.bio ?? "",
      traits: raw.traits ?? [],
      interests: raw.interests ?? [],
      notableRelationships: raw.notable_relationships ?? [],
      roleInServer: raw.role_in_server ?? "",
    };
  }

  /**
   * Second-pass durability triage for ingestion — classifies up to ~10 messages
   * per call as containing durable social information or not. Used to catch
   * signals the regex pre-filter misses (opinions, group dynamics, lore).
   * Returns a map of messageId → { durable, reason }.
   */
  async triageBatch(
    messages: Array<{ messageId: string; authorName: string; content: string }>,
    model: string
  ): Promise<Map<string, { durable: boolean; reason: string }>> {
    const numbered = messages.map((m, i) =>
      `[${i}] ${m.authorName}: ${m.content.slice(0, 500)}`
    ).join("\n");

    const schema = {
      type: "object" as const,
      properties: {
        results: {
          type: "array" as const,
          items: {
            type: "object" as const,
            properties: {
              index: { type: "number" as const },
              durable: { type: "boolean" as const },
              reason: { type: "string" as const },
            },
            required: ["index", "durable", "reason"],
            additionalProperties: false,
          },
        },
      },
      required: ["results"],
      additionalProperties: false,
    };

    const response = await this.client.chat.completions.create({
      model,
      messages: [{
        role: "user",
        content: `Rate each Discord message on whether it contains durable social information worth remembering about a person, relationship, or the server community. Durable means: facts, preferences, opinions, relationships, health, location, occupation, life events, group dynamics, inside jokes, or community lore. Non-durable means: greetings, one-liners, reactions, off-topic banter, rhetorical questions, or bot commands.\n\nMessages:\n${numbered}`,
      }],
      response_format: { type: "json_schema", json_schema: { name: "triage", strict: true, schema } },
    });

    const raw = JSON.parse(response.choices[0].message.content ?? "{}") as {
      results: Array<{ index: number; durable: boolean | string; reason: string }>;
    };

    const out = new Map<string, { durable: boolean; reason: string }>();
    for (const r of raw.results) {
      const m = messages[r.index];
      if (m) out.set(m.messageId, { durable: r.durable === true || r.durable === "true", reason: r.reason });
    }
    for (const m of messages) {
      if (!out.has(m.messageId)) out.set(m.messageId, { durable: false, reason: "omitted by model" });
    }
    return out;
  }

  /**
   * Sincerity verification for candidate memories — judges each extracted claim
   * against its stored source message and returns a literal / joke / unclear
   * verdict. Gates promotion on edgy servers where extraction mislabels humor
   * as explicit_fact. Returns a map of memoryId → verdict.
   */
  async verifyMemoriesBatch(
    items: Array<{
      memoryId: number; authorName: string; authorNames?: string[];
      claim: string; sourceMessage: string;
      contextBefore?: Array<{ authorName: string; content: string }>;
    }>,
    model: string
  ): Promise<Map<number, { verdict: VerificationVerdict; reason: string }>> {
    const numbered = items.map((m, i) => {
      const aka = m.authorNames?.length ? ` (aka: ${m.authorNames.join(", ")})` : "";
      const ctx = m.contextBefore?.length
        ? `\n    preceding chat:\n${m.contextBefore.map(c => `      ${c.authorName}: ${c.content.slice(0, 200)}`).join("\n")}`
        : "";
      return `[${i}] claim: "${m.claim}"\n    source (${m.authorName}${aka}): "${m.sourceMessage.slice(0, 500)}"${ctx}`;
    }).join("\n");

    const schema = {
      type: "object" as const,
      properties: {
        results: {
          type: "array" as const,
          items: {
            type: "object" as const,
            properties: {
              index: { type: "number" as const },
              verdict: { type: "string" as const, enum: ["literal", "joke", "unclear", "misattributed"] },
              reason: { type: "string" as const },
            },
            required: ["index", "verdict", "reason"],
            additionalProperties: false,
          },
        },
      },
      required: ["results"],
      additionalProperties: false,
    };

    const response = await this.client.chat.completions.create({
      model,
      messages: [{
        role: "user",
        content: `Each item pairs a memory claim extracted from a Discord message with the original message it came from, plus the author's known names and the chat lines just before it. Judge the source message:\n- "literal": a sincere literal statement the claim can be believed from\n- "joke": sarcasm, edgy humor, exaggeration, bait, or a bit\n- "misattributed": the source is quoting, pasting, forwarding, or speaking as someone OTHER than the poster (e.g. "I am <other person>", a reposted bio, copied bot output). The claim may be true of someone else — it just isn't the poster's own statement.\n- "unclear": none of the above can be decided\nThese servers contain heavy irony — when a message reads as shitposting or edgy bait, choose "joke".\n\nItems:\n${numbered}`,
      }],
      response_format: { type: "json_schema", json_schema: { name: "verify", strict: true, schema } },
    });

    const raw = JSON.parse(response.choices[0].message.content ?? "{}") as {
      results: Array<{ index: number; verdict: string; reason: string }>;
    };

    const out = new Map<number, { verdict: VerificationVerdict; reason: string }>();
    for (const r of raw.results) {
      const m = items[r.index];
      const verdict: VerificationVerdict = r.verdict === "literal" || r.verdict === "joke" || r.verdict === "misattributed" ? r.verdict : "unclear";
      if (m) out.set(m.memoryId, { verdict, reason: r.reason });
    }
    for (const m of items) {
      if (!out.has(m.memoryId)) out.set(m.memoryId, { verdict: "unclear", reason: "omitted by model" });
    }
    return out;
  }

  /**
   * Sincerity verification for relationship observations — same shape as
   * verifyMemoriesBatch but for asserted dynamics. Joke observations are
   * excluded from edge roll-up by recomputeEdges.
   */
  async verifyRelationshipsBatch(
    items: Array<{
      observationId: number; authorName: string; authorNames?: string[];
      nature: string; otherName: string; sourceMessage: string;
      contextBefore?: Array<{ authorName: string; content: string }>;
    }>,
    model: string
  ): Promise<Map<number, { verdict: "literal" | "joke" | "unclear"; reason: string }>> {
    if (!items.length) return new Map();
    const numbered = items.map((m, i) => {
      const aka = m.authorNames?.length ? ` (aka: ${m.authorNames.join(", ")})` : "";
      const ctx = m.contextBefore?.length
        ? `\n    preceding chat:\n${m.contextBefore.map(c => `      ${c.authorName}: ${c.content.slice(0, 200)}`).join("\n")}`
        : "";
      return `[${i}] assertion: "${m.nature}" involving ${m.otherName}\n    source (${m.authorName}${aka}): "${m.sourceMessage.slice(0, 500)}"${ctx}`;
    }).join("\n");

    const response = await this.client.chat.completions.create({
      model,
      messages: [{
        role: "user",
        content: `Each item pairs a relationship assertion extracted from a Discord message with the original message it came from. The assertion claims a dynamic ("nature") involving the named other person. Judge the source message:\n- "literal": a sincere statement the asserted dynamic can be believed from\n- "joke": sarcasm, edgy humor, exaggeration, bait, or a bit\n- "unclear": none of the above can be decided\nThese servers contain heavy irony — when a message reads as shitposting or edgy bait, choose "joke".\n\nItems:\n${numbered}`,
      }],
      response_format: { type: "json_schema", json_schema: { name: "verify_relationships", strict: true, schema: {
        type: "object", properties: {
          results: { type: "array", items: { type: "object", properties: {
            index: { type: "number" },
            verdict: { type: "string", enum: ["literal", "joke", "unclear"] },
            reason: { type: "string" },
          }, required: ["index", "verdict", "reason"], additionalProperties: false } },
        }, required: ["results"], additionalProperties: false,
      } } },
    });

    const raw = JSON.parse(response.choices[0].message.content ?? "{}") as {
      results?: Array<{ index: number; verdict: string; reason: string }>;
    };
    const out = new Map<number, { verdict: "literal" | "joke" | "unclear"; reason: string }>();
    for (const r of raw.results ?? []) {
      const m = items[r.index];
      const verdict = r.verdict === "literal" || r.verdict === "joke" ? r.verdict : "unclear";
      if (m) out.set(m.observationId, { verdict, reason: r.reason });
    }
    for (const m of items) {
      if (!out.has(m.observationId)) out.set(m.observationId, { verdict: "unclear", reason: "omitted by model" });
    }
    return out;
  }

  /**
   * Semantic dedup: given each member's memory list, identify groups that are the
   * same claim rephrased (lexically disjoint pairs like "allergic to peanuts" /
   * "can't eat nuts" are exactly what the trigram fast-path can't see) and pairs
   * that contradict. Returns index groups — the caller maps indices back to
   * memoryIds and applies guards before merging.
   */
  async dedupMemoriesBatch(
    members: Array<{ label: string; memories: Array<{ index: number; kind: string; status: string; content: string }> }>,
    model: string
  ): Promise<Array<{ indices: number[]; relation: "duplicate" | "contradicts"; reason: string }>> {
    const sections = members.map(m =>
      `${m.label}:\n${m.memories.map(mm => `  [${mm.index}] (${mm.kind}, ${mm.status}) ${mm.content}`).join("\n")}`
    ).join("\n");

    const response = await this.client.chat.completions.create({
      model,
      messages: [{
        role: "user",
        content: `Each section lists stored memory claims about one person. Find claims within a section that should be reconciled:\n- "duplicate": the same fact/preference/trait expressed with different wording or detail level — one claim, stored twice (e.g. "allergic to peanuts" vs "can't eat nuts", "love cold weather" vs "I love cold weather"). Group ALL duplicates together.\n- "contradicts": two claims that cannot both be currently true about the same thing (e.g. "has gallstones" vs "gallbladder removed").\nDo NOT group claims that merely share a topic — different facts about receipts are different claims. Only flag pairs within the same person's section. If nothing is duplicated or contradictory, return an empty results array.\n\nSections:\n${sections}`,
      }],
      response_format: { type: "json_schema", json_schema: { name: "dedup", strict: true, schema: {
        type: "object", properties: {
          results: { type: "array", items: { type: "object", properties: {
            indices: { type: "array", items: { type: "number" } },
            relation: { type: "string", enum: ["duplicate", "contradicts"] },
            reason: { type: "string" },
          }, required: ["indices", "relation", "reason"], additionalProperties: false } },
        }, required: ["results"], additionalProperties: false,
      } } },
    });

    const raw = JSON.parse(response.choices[0].message.content ?? "{}") as {
      results?: Array<{ indices?: number[]; relation?: string; reason?: string }>;
    };
    return (raw.results ?? [])
      .filter(r => Array.isArray(r.indices) && (r.relation === "duplicate" || r.relation === "contradicts"))
      .map(r => ({ indices: r.indices!.map(i => Number(i)).filter(i => Number.isFinite(i)), relation: r.relation as "duplicate" | "contradicts", reason: r.reason ?? "" }));
  }

  /**
   * Contest detection: a message addressed at the bot may deny or confirm one of
   * the author's own memories ("I never said that" / "Correction: I did say X").
   * Returns the memory relations found — caller applies them as evidence.
   */
  async detectContest(
    event: MessageEvent,
    memories: Array<{ id: number; content: string; status: string }>,
    model?: string
  ): Promise<Array<{ memoryId: number; relation: "contests" | "confirms"; reason: string }>> {
    const list = memories.map(m => `#${m.id} [${m.status}]: ${m.content}`).join("\n");
    const response = await this.client.chat.completions.create({
      model: model ?? this.model,
      messages: [{
        role: "user",
        content: `A Discord user addressed the bot. The bot has stored these memories about this user:\n${list}\n\nThe user's message:\n"${event.content}"\n\nDecide whether the message denies/disputes ("contests") or affirms/corrects-in-favour ("confirms") any listed memory. Report only actual relations — a correction that admits the claim ("Correction: I did say X") is "confirms". Return an empty results array if the message relates to none of them.`,
      }],
      response_format: { type: "json_schema", json_schema: { name: "contest", strict: true, schema: {
        type: "object", properties: {
          results: { type: "array", items: { type: "object", properties: {
            memoryId: { type: "number" }, relation: { type: "string", enum: ["contests", "confirms"] }, reason: { type: "string" },
          }, required: ["memoryId", "relation", "reason"], additionalProperties: false } },
        }, required: ["results"], additionalProperties: false,
      } } },
    });
    const raw = JSON.parse(response.choices[0].message.content ?? "{}") as {
      results?: Array<{ memoryId: number; relation: string; reason: string }>;
    };
    const valid = new Set(memories.map(m => m.id));
    return (raw.results ?? [])
      .filter(r => valid.has(r.memoryId) && (r.relation === "contests" || r.relation === "confirms"))
      .map(r => ({ memoryId: r.memoryId, relation: r.relation as "contests" | "confirms", reason: r.reason }));
  }

  /**
   * Synthesize one dossier section. Each section has its own prompt + strict
   * json_schema; item arrays may cite input memory IDs via source_ids (filtered
   * to real IDs by the caller). timeline is deterministic — never reaches here.
   */
  async synthesizeDossierSection(
    section: Exclude<DossierSection, "timeline">,
    displayName: string,
    payload: Record<string, unknown>,
    model?: string
  ): Promise<Record<string, unknown>> {
    const sourcedItems = { type: "array" as const, items: { type: "object" as const, properties: {
      text: { type: "string" as const },
      source_ids: { type: "array" as const, items: { type: "number" as const } },
    }, required: ["text", "source_ids"], additionalProperties: false } };

    const specs: Record<Exclude<DossierSection, "timeline">, { instruction: string; schema: Record<string, unknown> }> = {
      voice: {
        instruction: `Analyze this Discord member's writing voice from a sample of their actual messages and computed stats. Describe how they write: message length habits, capitalization/punctuation style, emoji and formatting use, humor register (irony, deadpan, edginess), and tone. Do not summarize message contents into facts about their life — describe HOW they communicate, not what they said.`,
        schema: { type: "object", properties: {
          prose: { type: "string" }, quirks: { type: "array", items: { type: "string" } },
        }, required: ["prose", "quirks"], additionalProperties: false },
      },
      life_situation: {
        instruction: `List the concrete life-situation facts known about this member (location, occupation, living situation, health, family/partner, major life circumstances). One item per fact. Cite source_ids of the memories each fact comes from. Only include what the evidence states.`,
        schema: { type: "object", properties: { items: sourcedItems }, required: ["items"], additionalProperties: false },
      },
      temperament: {
        instruction: `Describe this member's temperament and social style: how they banter, handle conflict, their emotional register, how they treat others. Write a short prose paragraph plus a trait list; cite source_ids per trait. Base only on evidence.`,
        schema: { type: "object", properties: {
          prose: { type: "string" }, items: sourcedItems,
        }, required: ["prose", "items"], additionalProperties: false },
      },
      beliefs: {
        instruction: `List this member's expressed values, tastes, and opinions (things they like/dislike/believe). One item each, citing source_ids. Mark nothing stronger than the evidence states.`,
        schema: { type: "object", properties: { items: sourcedItems }, required: ["items"], additionalProperties: false },
      },
      relationship_map: {
        instruction: `Summarize this member's relationships as a map: one entry per notable person, describing the dynamic in a sentence. Use the edges and the observed reasons (direction "member_subject" = this member asserted the dynamic; "member_other" = someone asserted it about them). The interactions list shows how often the member actually addresses each person — contact frequency is not relationship quality; only mention it when informative. Use the names given.`,
        schema: { type: "object", properties: {
          entries: { type: "array", items: { type: "object", properties: {
            name: { type: "string" }, dynamic: { type: "string" },
          }, required: ["name", "dynamic"], additionalProperties: false } },
        }, required: ["entries"], additionalProperties: false },
      },
      reputation: {
        instruction: `Summarize how the community sees this member, based only on things OTHER people said about them. Write a short prose read of their reputation plus the key claims as items citing source_ids. Note when claims are unconfirmed.`,
        schema: { type: "object", properties: {
          prose: { type: "string" }, items: sourcedItems,
        }, required: ["prose", "items"], additionalProperties: false },
      },
    };

    const spec = specs[section];
    const response = await this.client.chat.completions.create({
      model: model ?? this.model,
      messages: [{
        role: "user",
        content: `${spec.instruction}\n\nMember: ${displayName}\n\nData:\n${JSON.stringify(payload)}`,
      }],
      response_format: { type: "json_schema", json_schema: { name: `dossier_${section}`, strict: true, schema: spec.schema } },
    });
    return JSON.parse(response.choices[0].message.content ?? "{}") as Record<string, unknown>;
  }

  /**
   * Generate the bot's reply. When `model` is a groq/compound* system the call
   * goes through chat.completions with server-side built-in tools (web_search,
   * visit_website) — executed tool calls are logged for observability. When
   * `toolsEnabled` is set on a non-compound model, the call instead runs a local
   * tool-calling loop on chat.completions with web_search/visit_url executed
   * in-process (free — no per-tool billing). Either path's failure falls back
   * to the plain Responses-API call on this.model.
   */
  async reply(event: MessageEvent, context: Array<{ authorName: string; content: string }>, memories: Memory[], profiles: Array<{ name: string; summary: string; traits?: string[] }> = [], model?: string, toolsEnabled = false): Promise<string> {
    const people = profiles.map(p => `- ${p.name}: ${p.summary}${p.traits?.length ? ` (traits: ${p.traits.join(", ")})` : ""}`).join("\n");
    const persona = "You are a persistent, socially aware Discord server member. Be concise, warm, and a little witty. You only know what is in the supplied context and memories. Never claim certainty beyond them; do not expose private internal data or explain the memory system. Do not invent facts. Address people by their display names — never emit <@...> mention markup. If you use web results, work them in naturally — don't dump citations.";
    const situation = `Recent conversation:\n${context.map(x => `${x.authorName}: ${x.content}`).join("\n")}\n\nPeople:\n${people || "None"}\n\nRelevant memories:\n${memories.map(m => `- ${m.content} (confidence ${(m.confidence ?? 0).toFixed(2)})`).join("\n") || "None"}\n\nRespond to ${event.authorName}'s latest message: ${event.content}`;
    const useModel = model ?? this.model;

    if (useModel.startsWith("groq/compound")) {
      try {
        // compound_custom is a Groq extension the openai SDK doesn't type — it
        // forwards unknown body params, so the cast is all that's needed.
        const params = {
          model: useModel,
          messages: [
            { role: "system" as const, content: persona },
            { role: "user" as const, content: situation },
          ],
          compound_custom: { tools: { enabled_tools: ["web_search", "visit_website"] } },
        } as OpenAI.ChatCompletionCreateParamsNonStreaming & { compound_custom?: unknown };
        const res = await this.client.chat.completions.create(params);
        const msg = res.choices[0]?.message as { content?: string | null; executed_tools?: Array<{ type?: string; arguments?: string }> } | undefined;
        const tools = msg?.executed_tools ?? [];
        if (tools.length) {
          const desc = tools.map(t => `${t.type}${t.arguments ? `(${t.arguments.slice(0, 80)})` : ""}`).join(", ");
          console.log(`[reply] ${useModel} executed tools: ${desc}`);
        }
        return (msg?.content ?? "").trim().slice(0, 1800);
      } catch (err) {
        console.warn(`[reply] ${useModel} failed, falling back to ${this.model}:`, (err as Error).message.slice(0, 120));
      }
    }

    // Local tool-calling path (free alternative to Compound): the model emits
    // tool_calls, we execute them in-process and loop until it answers.
    if (toolsEnabled) {
      try {
        const messages: OpenAI.ChatCompletionMessageParam[] = [
          { role: "system", content: `${persona} You have tools: web_search(query) and visit_url(url). Use them only when the conversation needs live information or a linked page — never for ordinary chat.` },
          { role: "user", content: situation },
        ];
        for (let round = 0; round < 3; round++) {
          const res = await this.client.chat.completions.create({
            model: useModel, messages,
            tools: replyToolDefs as unknown as OpenAI.ChatCompletionTool[],
            tool_choice: "auto",
          });
          const msg = res.choices[0]?.message;
          const calls = (msg?.tool_calls ?? []).filter(c => c.type === "function");
          if (!calls.length) return (msg?.content ?? "").trim().slice(0, 1800);
          messages.push(msg!);
          for (const call of calls) {
            const started = Date.now();
            const result = await executeTool(call.function.name, call.function.arguments);
            console.log(`[reply] tool ${call.function.name}(${call.function.arguments.slice(0, 80)}) → ${result.length} chars in ${Date.now() - started}ms`);
            messages.push({ role: "tool", tool_call_id: call.id, content: result });
          }
        }
        // Rounds exhausted — final call without tools forces a plain answer.
        const res = await this.client.chat.completions.create({ model: useModel, messages });
        return (res.choices[0]?.message?.content ?? "").trim().slice(0, 1800);
      } catch (err) {
        console.warn(`[reply] tool path failed, falling back to plain reply:`, (err as Error).message.slice(0, 120));
      }
    }

    const response = await this.client.responses.create({
      model: this.model,
      input: `${persona}\n\n${situation}`
    });
    return response.output_text.trim().slice(0, 1800);
  }
}
