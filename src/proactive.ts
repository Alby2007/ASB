type Timer = ReturnType<typeof setTimeout>;

type Pending = { messageId: string; timer: Timer; armedAt: number };
type Sent = { key: string; sentAt: number; resolved: boolean };

type Opts = {
  delayMs: number;            // idle window before a stranded question can fire
  dailyCap: number;           // hard per-channel proactive cap per day
  responseWindowMs: number;   // how long a sent proactive reply waits for engagement
  backoffMs: number;          // how long an elevated streak stays hot
  baseMinConfidence: number;  // classifier floor, baseline
  backoffMinConfidence: number; // classifier floor while backing off
  onFire?: (key: string, messageId: string) => void;
  setTimeoutFn?: (fn: () => void, ms: number) => Timer;
  clearTimeoutFn?: (t: Timer) => void;
  now?: () => number;
};

const DAY_MS = 86_400_000;

/**
 * Debounced stranded-question trigger: a channel message ending in "?" arms a
 * pending entry; any follow-up (message or reaction) cancels it — the point is
 * waiting to see if a human answers first. If the timer survives, index.ts's
 * onFire runs the grounded-answer gate. Hard daily cap bounds the worst case;
 * an ignored attempt raises the confidence floor until engagement resets it.
 * In-memory like ConversationTracker — restart resets gracefully.
 */
export class ProactiveScheduler {
  private pending = new Map<string, Pending>();
  private sent = new Map<string, Sent>();            // by proactive message id
  private daily = new Map<string, { day: number; count: number }>();
  private ignoredStreak = new Map<string, number>();
  private lastIgnoredAt = new Map<string, number>();
  private onFire?: (key: string, messageId: string) => void;
  private setTimeoutFn: (fn: () => void, ms: number) => Timer;
  private clearTimeoutFn: (t: Timer) => void;
  private now: () => number;

  constructor(private opts: Opts) {
    this.onFire = opts.onFire;
    this.setTimeoutFn = opts.setTimeoutFn ?? setTimeout;
    this.clearTimeoutFn = opts.clearTimeoutFn ?? clearTimeout;
    this.now = opts.now ?? Date.now;
  }

  setFireHandler(fn: (key: string, messageId: string) => void): void {
    this.onFire = fn;
  }

  /** Arm a pending question; a newer arm replaces the old (last question wins). */
  arm(key: string, messageId: string): void {
    this.cancelPending(key);
    const timer = this.setTimeoutFn(() => this.fire(key), this.opts.delayMs);
    this.pending.set(key, { messageId, timer, armedAt: this.now() });
  }

  /** Any follow-up in the channel cancels the pending question. */
  cancelPending(key: string, messageId?: string): boolean {
    const p = this.pending.get(key);
    if (!p || (messageId !== undefined && p.messageId !== messageId)) return false;
    this.clearTimeoutFn(p.timer);
    this.pending.delete(key);
    return true;
  }

  isPendingQuestion(key: string, messageId: string): boolean {
    return this.pending.get(key)?.messageId === messageId;
  }

  /** Timer survived — hand off to the fire callback. */
  private fire(key: string): void {
    const p = this.pending.get(key);
    if (!p) return;
    this.pending.delete(key);
    this.onFire?.(key, p.messageId);
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
