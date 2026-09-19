type Pending = { messageId: string; armedAt: number };
type Sent = { key: string; sentAt: number; resolved: boolean };

type Opts = {
  delayMs: number;            // idle window before a stranded question can fire
  dailyCap: number;           // hard per-channel proactive cap per day
  responseWindowMs: number;   // how long a sent proactive reply waits for engagement
  backoffMs: number;          // how long an elevated streak stays hot
  baseMinConfidence: number;  // classifier floor, baseline
  backoffMinConfidence: number; // classifier floor while backing off
  /** Durable timer — index.ts enqueues a 'proactive-fire' job whose run_after
   * IS the delay; the job row is the timer, this map is the armed-state
   * truth. Tests record the call instead. */
  schedule?: (key: string, messageId: string, runAfter: Date) => void;
  now?: () => number;
};

const DAY_MS = 86_400_000;

/**
 * Debounced stranded-question trigger: a channel message ending in "?" arms a
 * pending entry and schedules a durable 'proactive-fire' job; any follow-up
 * (message or reaction) cancels the pending entry — the job row still fires
 * later but release() no-ops on it, which is exactly the cancel semantics a
 * persistent queue can express. The map is the source of truth for "still
 * armed"; the job row is only the clock. On boot, init() repopulates pending
 * from live job rows so a restart doesn't silently drop armed questions.
 * Hard daily cap bounds the worst case; an ignored attempt raises the
 * confidence floor until engagement resets it. Cap/backoff/sent state stays
 * in-memory like ConversationTracker — restart resets gracefully.
 */
export class ProactiveScheduler {
  private pending = new Map<string, Pending>();
  private sent = new Map<string, Sent>();            // by proactive message id
  private daily = new Map<string, { day: number; count: number }>();
  private ignoredStreak = new Map<string, number>();
  private lastIgnoredAt = new Map<string, number>();
  private now: () => number;

  constructor(private opts: Opts) {
    this.now = opts.now ?? Date.now;
  }

  /** Arm a pending question; a newer arm replaces the old (last question wins). */
  arm(key: string, messageId: string): void {
    this.cancelPending(key);
    this.pending.set(key, { messageId, armedAt: this.now() });
    this.opts.schedule?.(key, messageId, new Date(this.now() + this.opts.delayMs));
  }

  /** Boot repopulation: a 'proactive-fire' row that survived a restart becomes
   * a pending entry again — its run_after is still the timer. A newer arm
   * already in the map wins over a stale row. */
  restore(key: string, messageId: string, armedAt: number): void {
    if (!this.pending.has(key)) this.pending.set(key, { messageId, armedAt });
  }

  /** Any follow-up in the channel cancels the pending question. The job row
   * can't be cancelled — it fires later and release() no-ops on it. */
  cancelPending(key: string, messageId?: string): boolean {
    const p = this.pending.get(key);
    if (!p || (messageId !== undefined && p.messageId !== messageId)) return false;
    this.pending.delete(key);
    return true;
  }

  isPendingQuestion(key: string, messageId: string): boolean {
    return this.pending.get(key)?.messageId === messageId;
  }

  /** The 'proactive-fire' job fired — release the armed entry only if this is
   * still the channel's current question (a newer arm or a human follow-up
   * wins). True means the caller may proceed to the grounded-answer gate. */
  release(key: string, messageId: string): boolean {
    const p = this.pending.get(key);
    if (!p || p.messageId !== messageId) return false;
    this.pending.delete(key);
    return true;
  }

  /** Register a sent proactive reply for outcome tracking. */
  noteSent(key: string, messageId: string): void {
    this.sent.set(messageId, { key, sentAt: this.now(), resolved: false });
  }

  isProactiveTarget(messageId: string): boolean {
    return this.sent.has(messageId);
  }

  /** A reply-edge or reaction on a proactive message = engagement, not ignored. */
  observeEngagement(messageId: string): boolean {
    const s = this.sent.get(messageId);
    if (!s) return false;
    s.resolved = true;
    this.ignoredStreak.set(s.key, 0);
    return true;
  }

  /**
   * Whether a pending fire may proceed, and the confidence floor to apply.
   * First settles stale outcomes: proactive replies that got no reply-edge or
   * reaction within responseWindowMs count as ignored and raise the streak.
   */
  allow(key: string): { allowed: boolean; minConfidence: number } {
    for (const s of this.sent.values()) {
      if (!s.resolved && s.key === key && this.now() - s.sentAt > this.opts.responseWindowMs) {
        s.resolved = true;
        this.ignoredStreak.set(key, (this.ignoredStreak.get(key) ?? 0) + 1);
        this.lastIgnoredAt.set(key, this.now());
      }
    }
    const day = Math.floor(this.now() / DAY_MS);
    const d = this.daily.get(key);
    if (d && d.day === day && d.count >= this.opts.dailyCap) {
      return { allowed: false, minConfidence: this.opts.baseMinConfidence };
    }
    const streak = this.ignoredStreak.get(key) ?? 0;
    const lastIgnored = this.lastIgnoredAt.get(key) ?? 0;
    const backingOff = streak > 0 && this.now() - lastIgnored < this.opts.backoffMs;
    return { allowed: true, minConfidence: backingOff ? this.opts.backoffMinConfidence : this.opts.baseMinConfidence };
  }

  /** Count a fired proactive reply against the daily cap. */
  recordFire(key: string): void {
    const day = Math.floor(this.now() / DAY_MS);
    const d = this.daily.get(key);
    if (!d || d.day !== day) this.daily.set(key, { day, count: 1 });
    else d.count += 1;
  }
}
