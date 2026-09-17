// Shared retry helper for LLM calls. 429s wait on Groq's rate-limit headers;
// transient 5xx/network failures get a short fixed backoff so a blip doesn't
// silently drop work on the live path.

export function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function isTransient(err: Error): boolean {
  const status = (err as { status?: number }).status;
  if (status !== undefined && status >= 500) return true;
  return /ECONNRESET|ENOTFOUND|ETIMEDOUT|ECONNREFUSED|fetch failed|socket hang up/i.test(err.message);
}

export async function withRetry<T>(fn: () => Promise<T>, retries = 6): Promise<T> {
  for (let i = 0; i < retries; i++) {
    try { return await fn(); } catch (err) {
      const msg = (err as Error).message;
      const is429 = msg.includes("429");
      if ((is429 || isTransient(err as Error)) && i < retries - 1) {
        const headers = (err as { headers?: Headers }).headers;
        const tokenReset = headers?.get("x-ratelimit-reset-tokens");
        const retryAfter = headers?.get("retry-after");
        const wait = is429
          ? tokenReset
            ? Math.ceil(parseFloat(tokenReset) * 1000) + 1000
            : retryAfter ? parseInt(retryAfter) * 1000 + 1000 : (i + 1) * 30_000
          : (i + 1) * 5_000;
        console.log(`  [retry] ${msg.slice(0, 80)} — waiting ${(wait / 1000).toFixed(1)}s...`);
        await sleep(wait);
      } else throw err;
    }
  }
  throw new Error("exhausted retries");
}
