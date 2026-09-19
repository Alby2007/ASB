import { inc } from "./metrics.js";

type ChannelConvo = {
  participants: Map<string, number>; // userId -> expiry (from last ADDRESSED message)
  openedAt?: number;                 // set when the first participant enrolls; cleared on close
  lastBotSpokeAt?: number;
  recentBotFlags: boolean[];         // share-of-voice window — channel-level, survives close
};

// Share-of-voice window: the bot's fraction of the last N channel messages is
// the engaged-tier pacing signal — members don't count seconds since they last
// spoke, they don't dominate the floor.
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

  /** Record a channel message for the share-of-voice window (bounded deque). */
  noteMessage(key: string, fromBot: boolean): void {
    const ch = this.getOrCreate(key);
    ch.recentBotFlags.push(fromBot);
    if (ch.recentBotFlags.length > VOICE_WINDOW) ch.recentBotFlags.shift();
  }

  /** The bot's fraction of the last VOICE_WINDOW channel messages (0–1). */
  botShare(key: string): number {
    const flags = this.channels.get(key)?.recentBotFlags;
    if (!flags?.length) return 0;
    return flags.filter(Boolean).length / flags.length;
  }

  lastSpokeAt(key: string): number | undefined {
    return this.channels.get(key)?.lastBotSpokeAt;
  }

  private getOrCreate(key: string): ChannelConvo {
    let ch = this.channels.get(key);
    if (!ch) {
      ch = { participants: new Map(), recentBotFlags: [] };
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
