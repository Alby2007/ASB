import { detectDismissal, roomAddressCue } from "./perception.js";
import { inc } from "./metrics.js";
import type { ConversationTracker } from "./conversation.js";
import type { Decision, MessageEvent } from "./types.js";

// ── Speech gate ───────────────────────────────────────────────────────────────
// The per-message speak/silence decision, extracted from handleMessage so a
// scripted transcript can replay it: enroll → engagement aim-check →
// deterministic dismissal → share-of-voice → decide(). Discord objects are
// flattened to booleans at the boundary (repliedToOtherUser/mentionsOtherUsers)
// so tests drive it with plain data.

export type SpeechTurnInput = {
  event: MessageEvent;
  botId: string;
  /** The message this one replies to is a human's (not the bot's). */
  repliedToOtherUser?: boolean;
  /** Any @-mention of a user other than the bot. */
  mentionsOtherUsers?: boolean;
};

export type SpeechVerdict = {
  /** convo.addressed opened a closed conversation this turn. */
  opened: boolean;
  /** Participant AND the message was aimed at the bot (room-aimed turns don't count). */
  engaged: boolean;
  /** The deterministic dismissal fired — addressed or mid-conversation. */
  dismissed: boolean;
  /** The share-of-voice penalty input actually applied (0 with no bystanders). */
  share: number;
  decision: Decision;
};

export function evaluateSpeechTurn(
  input: SpeechTurnInput,
  convo: ConversationTracker,
  decide: (event: MessageEvent, elapsedSinceLastSpokeMs: number, engaged: boolean, botShare: number) => Decision,
  opts: { engagement: boolean; now?: () => number },
): SpeechVerdict {
  const { event, botId } = input;
  const now = opts.now ?? Date.now;
  const key = `${event.guildId}:${event.channelId}`;
  // This human message counts toward share-of-voice before scoring — it
  // dilutes the bot's floor share for the decide() below.
  convo.noteMessage(key, false, event.authorId);
  // An addressed message enrolls the author — opening the conversation if it
  // wasn't already. ENGAGEMENT=0 = address-only mode: no state is enrolled,
  // every message scores as stranger, and convo.opened stays honest.
  const opened = opts.engagement && event.mentionsBot && convo.addressed(key, event.authorId);
  if (opened) inc("convo.opened");
  let engaged = opts.engagement && convo.isParticipant(key, event.authorId);
  // Engaged ≠ every message is at the bot: aimed at the room ("did anyone see
  // that"), replying to another human, or @-mentioning someone else doesn't
  // earn the bonus — participation itself is untouched.
  if (engaged && !event.mentionsBot
    && (roomAddressCue(event.content) || input.repliedToOtherUser || input.mentionsOtherUsers)) {
    engaged = false;
  }
  // Dismissals are the deterministic override — they fire addressed ("shut up
  // asb") or mid-conversation ("shush") regardless of what the model thinks.
  // Unaddressed clears participation → silence; addressed still gets its ack
  // reply, then drops out.
  let dismissed = false;
  if ((event.mentionsBot || engaged) && detectDismissal(event.content)) {
    convo.leave(key, event.authorId);
    inc("convo.leave.dismissal");
    engaged = false;
    dismissed = true;
  }
  const lastSpokeAt = convo.lastSpokeAt(key);
  const elapsed = lastSpokeAt === undefined ? Infinity : now() - lastSpokeAt;
  // The share-of-voice penalty exists to keep the bot off a shared floor — it
  // only applies when someone OUTSIDE the conversation spoke recently. A 1:1
  // ping-pong is structurally ~50% bot forever; no bystanders, no floor.
  const share = convo.bystanderVoices(key) > 0 ? convo.botShare(key) : 0;
  const decision = decide(event, elapsed, engaged, share);
  return { opened, engaged, dismissed, share, decision };
}
