import OpenAI from "openai";
import { Agent, fetch as undiciFetch } from "undici";
import { Brain } from "./brain.js";
import { decryptSecret, errorText } from "./secrets.js";
import { inc } from "./metrics.js";
import { isPrivateAddress, safeLookup } from "./tools.js";

// Per-guild base URLs are untrusted input — a guild admin can point them
// anywhere, and every call carries that guild's API key. isSafeUrl +
// the /setup DNS check are input-time gates only; this dispatcher runs the
// validation INSIDE the socket connect path, so a hostname that later flips
// to a private/internal address (rebinding) still can't turn the bot into an
// internal-network request primitive. Only applied to guild-chosen URLs —
// the operator's env URL is trusted by definition (self-hosters may
// legitimately point at LAN/local model servers).
const guildDispatcher = new Agent({ connect: { lookup: safeLookup } });

/** fetch that re-validates DNS at connect time — for calls carrying a
 * guild's own key to a guild-chosen base URL. IP literals are checked here
 * because undici skips lookup() for them and would otherwise connect raw. */
export const guardedLlmFetch: typeof fetch = (input, init) => {
  const raw = typeof input === "string" || input instanceof URL ? String(input) : (input as Request).url;
  const host = new URL(raw).hostname;
  if (isPrivateAddress(host)) return Promise.reject(new Error(`blocked: ${host} is a private address`));
  return undiciFetch(input as any, { ...(init as any), dispatcher: guildDispatcher }) as unknown as Promise<Response>;
};

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
  getKey: (guildId: string) => Promise<{ keyEnc: Buffer; baseUrl: string | null; validatedAt?: string | null } | null>;
  envKey: string;
  envModel: string;
  envBaseUrl: string;
  requireGuildKeys: boolean;
  /** Persist "key proven good" for rows stored while the provider was
   * unreachable at /setup time. Optional — revalidation is skipped without it. */
  markValidated?: (guildId: string) => Promise<void>;
  /** Re-check a stored-unverified key; injectable for tests. */
  revalidate?: (key: string, baseUrl: string) => Promise<boolean>;
}) {
  const cache = new Map<string, Brain | null>();

  async function brainFor(guildId: string): Promise<Brain | null> {
    if (cache.has(guildId)) return cache.get(guildId)!;

    let brain: Brain | null = null;
    const row = await opts.getKey(guildId);
    if (row) {
      try {
        const key = decryptSecret(row.keyEnc);
        const baseUrl = row.baseUrl ?? opts.envBaseUrl;
        brain = row.baseUrl
          ? new Brain(key, opts.envModel, baseUrl, new OpenAI({ apiKey: key, baseURL: baseUrl, fetch: guardedLlmFetch }))
          : new Brain(key, opts.envModel, baseUrl);
        // Rows stored unverified (provider unreachable at /setup) get one
        // re-check per process — flips validated_at once the provider answers.
        if (!row.validatedAt && opts.markValidated && opts.revalidate) {
          void opts.revalidate(key, baseUrl)
            .then(ok => { if (ok) return opts.markValidated!(guildId); })
            .catch(() => { /* validation is best-effort — the Brain still works */ });
        }
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
