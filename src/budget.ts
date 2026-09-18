import type { LlmClient } from "./brain.js";
import type { MemoryStore } from "./database.js";

// ── Per-guild LLM budget ──────────────────────────────────────────────────────
// Every LLM call a guild makes — regardless of whether it rides the guild's
// own BYOK key or the operator's env key — flows through the LlmClient seam
// (Brain's private client). Wrapping that client here makes the cap universal:
// extraction, replies, triage, profiles, contests all pay the same toll.
// The counter lives in guild_usage keyed by UTC day; chargeLlmCall increments
// atomically under the row lock, so concurrent calls can't overshoot.

export class BudgetExceeded extends Error {
  constructor(
    public readonly guildId: string,
    public readonly cap: number,
  ) {
    super(`guild ${guildId} hit the daily LLM cap (${cap})`);
    this.name = "BudgetExceeded";
  }
}

export function isBudgetExceeded(error: unknown): error is BudgetExceeded {
  return error instanceof BudgetExceeded;
}

/**
 * Proxy an LlmClient so every responses.create / chat.completions.create
 * charges the guild's daily counter first. Over cap → BudgetExceeded before
 * the request leaves the process. The cap is re-read per call through
 * getCap() (settings() is cached 60s — acceptable softness for a daily bound,
 * and it means /limits takes effect without a resolver invalidation).
 */
export function meteredClient(inner: LlmClient, opts: {
  guildId: string;
  store: MemoryStore;
  getCap: () => Promise<number>;
}): LlmClient {
  const charge = async () => {
    const cap = await opts.getCap();
    const result = await opts.store.chargeLlmCall(opts.guildId, cap);
    if (!result.ok) throw new BudgetExceeded(opts.guildId, result.cap);
  };
  return {
    responses: { create: (params: unknown) => charge().then(() => inner.responses.create(params)) },
    chat: { completions: { create: (params: unknown) => charge().then(() => inner.chat.completions.create(params)) } },
  };
}
