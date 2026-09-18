type ChannelEngagement = {
  participants: Map<string, number>; // userId -> expiry timestamp
  lastSpokeAt?: number;
  recentBotFlags: boolean[]; // rolling window: was each recent message ours?
};

// Share-of-voice window: the bot's fraction of the last N channel messages is
// the engaged-tier pacing signal — members don't count seconds since they last
// spoke, they don't dominate the floor.
const VOICE_WINDOW = 10;

/**
 * Per-channel conversational engagement: who is actively talking *with* the bot.
 * A trigger (mention, reply-to-bot, wake word) enrolls the author for `ttlMs`;
 * enrolled messages earn a mid-tier decide() bonus so the bot stays in the
 * thread without needing re-mentions. Participants expire independently —
 * noteReply does NOT extend them — so drifting side-chatter decays out even
 * while the channel keeps talking. In-memory; restart resets gracefully.
 */
export class EngagementTracker {
  private channels = new Map<string, ChannelEngagement>();

  constructor(
    private ttlMs = 120_000,
    private now: () => number = Date.now
  ) {}

  /** Enroll/refresh a participant after an addressed message. */
  noteTrigger(key: string, userId: string): void {
    const ch = this.getOrCreate(key);
    ch.participants.set(userId, this.now() + this.ttlMs);
  }

  /** Record that the bot spoke — counts toward share-of-voice; does not extend participants. */
  noteReply(key: string): void {
    this.getOrCreate(key).lastSpokeAt = this.now();
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

  /** True if the user's last addressed message is still inside the TTL. */
  isEngaged(key: string, userId: string): boolean {
    const ch = this.channels.get(key);
    if (!ch) return false;
    const expiry = ch.participants.get(userId);
    if (expiry === undefined) return false;
    if (expiry <= this.now()) {
      ch.participants.delete(userId);
      this.pruneEmpty(key, ch);
      return false;
    }
    return true;
  }

  /** Remove one participant (explicit dismissal). Others stay engaged. */
  dismiss(key: string, userId: string): void {
    const ch = this.channels.get(key);
    if (!ch) return;
    ch.participants.delete(userId);
    this.pruneEmpty(key, ch);
  }

  lastSpokeAt(key: string): number | undefined {
    return this.channels.get(key)?.lastSpokeAt;
  }

  private getOrCreate(key: string): ChannelEngagement {
    let ch = this.channels.get(key);
    if (!ch) {
      ch = { participants: new Map(), recentBotFlags: [] };
      this.channels.set(key, ch);
    }
    return ch;
  }

  private pruneEmpty(key: string, ch: ChannelEngagement): void {
    if (ch.participants.size === 0 && ch.lastSpokeAt === undefined) {
      this.channels.delete(key);
    }
  }
}
