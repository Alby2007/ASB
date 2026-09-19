import { createHash } from "node:crypto";
import type { Brain } from "./brain.js";
import type { MemoryStore } from "./database.js";
import { botMemoryCue, contestCue } from "./perception.js";
import { inc } from "./metrics.js";
import type { MessageEvent } from "./types.js";

// ── Contest detection ─────────────────────────────────────────────────────────
// When a user addresses the bot with denial/correction cues ("I never said that",
// "you have me confused", "Correction: I did say X"), the message may contest or
// confirm one of their stored memories. A cue regex gates the LLM check; matched
// relations attach as evidence — contests mark the memory contested (confidence
// frozen, net_score arbitrates), confirms count as support toward resolution.

export async function runContestCheck(
  event: MessageEvent,
  brain: Brain,
  store: MemoryStore,
  botUserId: string,
  model?: string
): Promise<{ contests: number; confirms: number }> {
  const addressesBot = event.mentionsBot
    || event.content.includes(`<@${botUserId}>`)
    || event.content.includes(`<@!${botUserId}>`)
    || botMemoryCue(event.content);
  if (!addressesBot) return { contests: 0, confirms: 0 };
  // Cue miss on a bot-addressed message: only worth logging when the author has
  // contestable memories — otherwise every ordinary bot-directed reply would log
  // as a "near miss" and the signal would be pure noise. These misses are the
  // data for tuning contestCue later; logged per occurrence, not deduped.
  if (!contestCue(event.content)) {
    const hasContestable = (await store.contestableMemories(event.guildId, event.authorId)).length > 0;
    if (hasContestable) {
      inc("contest.cue_miss");
      // No raw content in operator logs — a content hash correlates repeated
      // phrasings for cue tuning without turning the log into a PII store.
      const hash = createHash("sha256").update(event.content).digest("hex").slice(0, 10);
      console.warn(`[contest] cue miss with contestable memories — guild ${event.guildId} author ${event.authorId} msg ${event.messageId} content-hash ${hash}`);
    }
    return { contests: 0, confirms: 0 };
  }

  const memories = await store.contestableMemories(event.guildId, event.authorId);
  if (memories.length === 0) return { contests: 0, confirms: 0 };

  const relations = await brain.detectContest(
    event,
    memories.map(m => ({ id: m.id, content: m.content, status: m.status })),
    model
  );

  const byId = new Map(memories.map(m => [m.id, m]));
  let contests = 0, confirms = 0;
  for (const rel of relations) {
    const target = byId.get(rel.memoryId);
    if (!target) continue;
    const updated = await store.attachEvidence(
      rel.memoryId, event, "correction",
      rel.relation === "contests" ? "contradict" : "support",
      rel.reason
    );
    if (!updated) {
      // Evidence already attached — a fresh confirm from the subject still adjudicates.
      if (rel.relation === "confirms" && target.status === "contested" && target.subjectId === event.authorId) {
        await store.subjectConfirm(event.guildId, rel.memoryId);
        confirms++;
      }
      continue;
    }
    if (rel.relation === "contests") { contests++; inc("contest.contested"); } else { confirms++; inc("contest.confirmed"); }
    if (updated.status !== "contested") continue;
    const r = await store.resolveContested(event.guildId, rel.memoryId);
    // Subject adjudication: when net_score can't settle it but the person the
    // memory describes affirms it themselves, that confirmation is decisive.
    if (!r.resolved && rel.relation === "confirms" && updated.subjectId === event.authorId) {
      await store.subjectConfirm(event.guildId, rel.memoryId);
    }
  }
  return { contests, confirms };
}
