import OpenAI from "openai";
import type { Memory } from "./database.js";
import type { ContinuityDecision, Decision, MemoryCandidate, MessageEvent, StoredEvent } from "./types.js";

export class Brain {
  private client: OpenAI;
  constructor(apiKey: string, private model: string, baseURL?: string) { this.client = new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) }); }

  decide(event: MessageEvent, recentBotMessages: number): Decision {
    const reasons: string[] = [];
    let score = 0.05;
    if (event.mentionsBot) { score += 0.85; reasons.push("direct mention"); }
    if (event.content.endsWith("?")) { score += 0.1; reasons.push("question"); }
    if (recentBotMessages > 0) { score -= 0.25; reasons.push("bot spoke recently"); }
    return { shouldSpeak: score >= 0.7, score: Math.max(0, Math.min(1, score)), reasons };
  }

  async extractMemories(event: MessageEvent, replyToContent?: string): Promise<MemoryCandidate[]> {
    const replyContext = replyToContent ? `\n\nThis message is a reply to: "${replyToContent}"` : "";
    const response = await this.client.responses.create({
      model: this.model,
      input: `Extract only durable, useful memories from this Discord message. Do not infer sensitive traits, diagnoses, private information, or insults. A single casual message rarely merits memory. Classify the language as evidenceType and its relation to the proposed memory as effect, but do not decide lifecycle transitions. Provide language interpretation only; confidence, importance, and explicitness will be calculated deterministically by the database.\n\nsubjectId rules: use the Author ID below when the memory is about the message author. If the memory is about a different person mentioned in the message, use their Discord user ID if it appears in the message as a mention (<@ID>). If the subject cannot be resolved to a Discord user ID, use "unknown". Never use descriptive labels or slugs.\n\nAuthor ID: ${event.authorId}\nMessage: ${event.content}${replyContext}`,
      text: { format: { type: "json_schema", name: "memory_candidates", strict: true, schema: {
        type: "object", properties: { memories: { type: "array", items: { type: "object", properties: {
          subjectId: { type: "string" }, kind: { type: "string", enum: ["person_fact", "person_preference", "server_lore", "episode"] }, content: { type: "string" }, reason: { type: "string" }, evidenceType: { type: "string", enum: ["explicit_fact", "clear_preference", "direct_observation", "reported_by_other", "sarcasm_or_joke", "uncertain_inference", "correction"] }, effect: { type: "string", enum: ["support", "contradict", "correct", "context"] }
        }, required: ["subjectId", "kind", "content", "reason", "evidenceType", "effect"], additionalProperties: false } } }, required: ["memories"], additionalProperties: false
      } } }
    });
    return JSON.parse(response.output_text).memories as MemoryCandidate[];
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
    return JSON.parse(response.output_text) as { significance: number; tier: "low" | "medium" | "high"; tone: string; narrativeComplete: boolean; futureRelevant: boolean; title: string; summary: string };
  }

  async reply(event: MessageEvent, context: Array<{ authorName: string; content: string }>, memories: Memory[]): Promise<string> {
    const response = await this.client.responses.create({
      model: this.model,
      input: `You are a persistent, socially aware Discord server member. Be concise, warm, and a little witty. You only know what is in the supplied context and memories. Never claim certainty beyond them; do not expose private internal data or explain the memory system. Do not invent facts.\n\nRecent conversation:\n${context.map(x => `${x.authorName}: ${x.content}`).join("\n")}\n\nRelevant memories:\n${memories.map(m => `- ${m.content} (confidence ${(m.confidence ?? 0).toFixed(2)})`).join("\n") || "None"}\n\nRespond to ${event.authorName}'s latest message: ${event.content}`
    });
    return response.output_text.trim().slice(0, 1800);
  }
}
