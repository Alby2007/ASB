// In-process operational counters — no DB, reset on restart. Incremented at
// failure/observability points and surfaced to admins via /status so degraded
// behavior (LLM errors, contest misses) is visible without reading logs.
const counters = new Map<string, number>();
const startedAt = Date.now();

export function inc(name: string, by = 1): void {
  counters.set(name, (counters.get(name) ?? 0) + by);
}

export function metricsSnapshot(): { uptimeSec: number; counts: Record<string, number> } {
  return {
    uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
    counts: Object.fromEntries([...counters].sort(([a], [b]) => a.localeCompare(b))),
  };
}
