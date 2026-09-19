// ── Per-user reply throttle ───────────────────────────────────────────────────
// The guild's daily LLM cap bounds cost but not WHO spends it: a troll firing
// mentions (or rapid engaged follow-ups) drains the day's budget for everyone
// else. A token bucket per guild:user preserves natural ping-pong — a burst of
// quick exchanges is allowed, then replies throttle to the refill rate —
// while bounding the worst-case drain to ~capacity + (1/refill) sustained.
// In-memory like ConversationTracker — a restart resets buckets gracefully.
// Keyed guild:user (not per-channel) so channel-hopping can't dodge it.

export class ReplyThrottle {
  private buckets = new Map<string, { tokens: number; refilledAt: number }>();
  private now: () => number;

  constructor(private opts: { capacity: number; refillMs: number; now?: () => number }) {
    this.now = opts.now ?? Date.now;
  }

  /** Lazily refill then try to spend one token. False = suppress the reply —
   *  callers stay silent (a "slow down" reply spends the budget it protects). */
  consume(guildId: string, userId: string): boolean {
    const now = this.now();
    const key = `${guildId}:${userId}`;
    let b = this.buckets.get(key);
    if (!b) {
      b = { tokens: this.opts.capacity, refilledAt: now };
      this.buckets.set(key, b);
    } else {
      const refill = Math.floor((now - b.refilledAt) / this.opts.refillMs);
      if (refill > 0) {
        b.tokens = Math.min(this.opts.capacity, b.tokens + refill);
        b.refilledAt += refill * this.opts.refillMs;
      }
    }
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }
}
