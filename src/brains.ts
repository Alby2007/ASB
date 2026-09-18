import { Brain } from "./brain.js";
import { decryptSecret, errorText } from "./secrets.js";
import { inc } from "./metrics.js";

/**
 * Per-guild Brain resolver (BYOK). Resolution order:
 *   1. guild_keys row → decrypt → Brain on the guild's key (and base_url if set)
 *   2. env key (operator-level fallback for self-hosters)
 *   3. null — the guild is dormant: callers skip archive/reply politely
 *
 * `requireGuildKeys` (hosted mode) skips step 2 so keyless guilds get nothing.
 *
 * Caching: one Brain per guild, invalidated only by /setup writes — the sole
 * writer — so no TTL is needed (a rotated key is a new row + invalidate()).
 * Decrypt failure (wrong master key, tampered row) logs + metrics + null —
 * dormant, not crash. Recovery is re-running /setup.
 */
export function createBrainResolver(opts: {
  getKey: (guildId: string) => Promise<{ keyEnc: Buffer; baseUrl: string | null } | null>;
  envKey: string;
  envModel: string;
  envBaseUrl: string;
  requireGuildKeys: boolean;
}) {
  const cache = new Map<string, Brain | null>();

  async function brainFor(guildId: string): Promise<Brain | null> {
    if (cache.has(guildId)) return cache.get(guildId)!;

    let brain: Brain | null = null;
    const row = await opts.getKey(guildId);
    if (row) {
      try {
        brain = new Brain(decryptSecret(row.keyEnc), opts.envModel, row.baseUrl ?? opts.envBaseUrl);
      } catch (error) {
        inc("brain.decrypt_failed");
        console.warn(`guild_keys decrypt failed for ${guildId} — guild dormant until /setup re-runs`, errorText(error));
      }
    } else if (opts.envKey && !opts.requireGuildKeys) {
      brain = new Brain(opts.envKey, opts.envModel, opts.envBaseUrl);
    }

    cache.set(guildId, brain);
    return brain;
  }

  function invalidate(guildId: string): void {
    cache.delete(guildId);
  }

  return { brainFor, invalidate };
}

export type BrainResolver = ReturnType<typeof createBrainResolver>;
