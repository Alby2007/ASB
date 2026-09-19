import { inc } from "./metrics.js";

type ChannelConvo = {
  participants: Map<string, number>; // userId -> expiry (from last ADDRESSED message)
  openedAt?: number;                 // set when the first participant enrolls; cleared on close
  lastBotSpokeAt?: number;
  recentVoices: Array<{ bot: boolean; authorId?: string }>; // share-of-voice window — channel-level, survives close
};

// Share-of-voice window: the bot's fraction of the last N channel messages is
// the engaged-tier pacing signal — members don't count seconds since they last
// spoke, they don't dominate the floor. Entries carry the author so callers
// can tell a shared floor (bystander voices present) from a ping-pong 1:1 —
// the penalty exists to protect bystanders, and a bot at ~50% in a 1:1 has
// no floor to dominate.
const VOICE_WINDOW = 10;

/**
 * Per-channel conversation state: a real open/close object instead of a bare
 * TTL timer. An addressed message (mention, reply-to-bot, wake word) enrolls
 * the author and opens the conversation; participants leave three ways —
 * TTL expiry, regex dismissal (deterministic override), or the reply model's
 * end_conversation signal — and the convo closes when the last one exits.
 * Each user's expiry is measured from their own last *addressed* message,
 * so drifting side-chatter decays out even while the channel keeps talking.
 * Pacing state (share-of-voice, last-spoke) is channel-level and outlives
 * any single conversation. In-memory; restart resets gracefully.
 */
export class ConversationTracker {
  private channels = new Map<string, ChannelConvo>();

  constructor(
    private ttlMs = 120_000,
    private now: () => number = Date.now
  ) {}

  /**
   * Enroll/refresh a participant after an addressed message. Returns true when
   * this call opened a previously-closed conversation (caller counts
   * `convo.opened`).
   */
  addressed(key: string, userId: string): boolean {
    const ch = this.getOrCreate(key);
    this.sweepExpired(key, ch);
    const opened = ch.openedAt === undefined;
    if (opened) ch.openedAt = this.now();
    ch.participants.set(userId, this.now() + this.ttlMs);
    return opened;
  }

  /** True if the user's last addressed message is still inside the TTL. An
   * expired entry is removed here — the silent leave counts as expired. */
  isParticipant(key: string, userId: string): boolean {
    const ch = this.channels.get(key);
    if (!ch) return false;
    const expiry = ch.participants.get(userId);
    if (expiry === undefined) return false;
    if (expiry <= this.now()) {
      ch.participants.delete(userId);
      inc("convo.leave.expired");
      this.closeIfEmpty(key, ch);
      return false;
    }
    return true;
  }

  /** One participant leaves explicitly (regex dismissal or the model's exit
   * signal). Others stay in; the convo closes when the last one goes.
   * Returns whether a live participant was actually removed — callers count
   * cause-specific metrics only on true, so a dismissal's ack-reply exit
   * can't double-count as a model leave. */
  leave(key: string, userId: string): boolean {
    const ch = this.channels.get(key);
    if (!ch) return false;
    const removed = ch.participants.delete(userId);
    this.closeIfEmpty(key, ch);
    return removed;
  }

  /** Live participant ids, with expired entries swept out first. */
  participants(key: string): string[] {
    const ch = this.channels.get(key);
    if (!ch) return [];
    this.sweepExpired(key, ch);
    return [...ch.participants.keys()];
  }

  /** A conversation is open while it has been opened and not yet closed —
   * i.e. openedAt is set. Participants can linger unexpired but the set
   * emptying is what clears openedAt, so the two stay consistent. */
  isOpen(key: string): boolean {
    const ch = this.channels.get(key);
    if (!ch) return false;
    this.sweepExpired(key, ch);
    return ch.openedAt !== undefined;
  }

  /** Force-close: drop every participant. Pacing data survives — it belongs
   * to the channel, not the conversation. */
  close(key: string): void {
    const ch = this.channels.get(key);
    if (!ch) return;
    ch.participants.clear();
    this.closeIfEmpty(key, ch);
  }

  /** Record that the bot spoke — counts toward share-of-voice; does not
   * extend participants (that's what lets the bot drop out mid-chatter). */
  noteReply(key: string): void {
    this.getOrCreate(key).lastBotSpokeAt = this.now();
    this.noteMessage(key, true);
  }

  /** Record a channel message for the share-of-voice window (bounded deque).
   * authorId lets bystanderVoices() tell floor bystanders from participants. */
  noteMessage(key: string, fromBot: boolean, authorId?: string): void {
    const ch = this.getOrCreate(key);
    ch.recentVoices.push({ bot: fromBot, authorId });
    if (ch.recentVoices.length > VOICE_WINDOW) ch.recentVoices.shift();
  }

  /** The bot's fraction of the last VOICE_WINDOW channel messages (0–1). */
  botShare(key: string): number {
    const voices = this.channels.get(key)?.recentVoices;
    if (!voices?.length) return 0;
    return voices.filter(v => v.bot).length / voices.length;
  }

  /** Distinct humans in the window who are NOT current participants —
   * the floor the bot could actually be dominating. A 1:1 has none. */
  bystanderVoices(key: string): number {
    const ch = this.channels.get(key);
    if (!ch) return 0;
    this.sweepExpired(key, ch); // an expired participant's messages are bystander traffic again
    return new Set(
      ch.recentVoices
        .filter(v => !v.bot && v.authorId && !ch.participants.has(v.authorId))
        .map(v => v.authorId)
    ).size;
  }

  lastSpokeAt(key: string): number | undefined {
    return this.channels.get(key)?.lastBotSpokeAt;
  }

  private getOrCreate(key: string): ChannelConvo {
    let ch = this.channels.get(key);
    if (!ch) {
      ch = { participants: new Map(), recentVoices: [] };
      this.channels.set(key, ch);
    }
    return ch;
  }

  /** Remove every expired participant — each silent exit counts as expired. */
  private sweepExpired(key: string, ch: ChannelConvo): void {
    const t = this.now();
    let expired = 0;
    for (const [userId, expiry] of ch.participants) {
      if (expiry <= t) { ch.participants.delete(userId); expired++; }
    }
    if (expired) {
      inc("convo.leave.expired", expired);
      this.closeIfEmpty(key, ch);
    }
  }

  /** The convo closes when the last participant exits — openedAt clears and
   * the event counts once. The map entry itself only goes away when there's
   * also no pacing data worth keeping (mirrors the old pruneEmpty rule). */
  private closeIfEmpty(key: string, ch: ChannelConvo): void {
    if (ch.participants.size !== 0) return;
    if (ch.openedAt !== undefined) {
      ch.openedAt = undefined;
      inc("convo.closed");
    }
    if (ch.lastBotSpokeAt === undefined) this.channels.delete(key);
  }
}
