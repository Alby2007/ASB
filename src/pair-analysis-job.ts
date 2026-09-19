import type { Brain } from "./brain.js";
import type { MemoryStore } from "./database.js";
import type { AliasMap } from "./entity-resolution.js";
import { inc } from "./metrics.js";

// ── Pair-analysis job handler ────────────────────────────────────────────────
// Single-message extraction only sees claimed dynamics — most real
// relationships are never verbalized. This job reads the deterministic
// interaction graph's top pairs' actual exchange windows and asks the model
// for a holistic read: how they talk to each other, not what was claimed.
// Enqueued by maintenance for pairs with >=10 interactions, both parties
// consented, and no analysis in the last 7 days. Results land as
// source='pair_window' observations — verdict pre-set ('literal' confident,
// 'unclear' marker otherwise), so they feed edges on the next recompute
// without a second verification pass: the window read IS the verification.
// BudgetExceeded propagates like extract — parked to the UTC-day reset.

export type PairAnalysisPayload = { aId?: string; bId?: string };

export interface PairAnalysisDeps {
  store: MemoryStore;
  brainFor: (guildId: string) => Promise<Brain | null>;
  getAliases: (guildId: string) => Promise<AliasMap>;
  botId: string;
  analysisModel: string;
}

export async function runPairAnalysisJob(
  guildId: string, payload: PairAnalysisPayload, deps: PairAnalysisDeps
): Promise<void> {
  const aId = payload.aId, bId = payload.bId;
  if (!aId || !bId || aId === bId) { inc("jobs.dropped_malformed"); return; }
  // Both-party consent — stricter than the either-party write rule: this
  // reads BOTH people's exchanges holistically, so one consenting party
  // can't open the other's window. The bot counts as consented (it's
  // auto-opted-in), so bot↔member pairs analyze on member consent alone.
  const consented = async (id: string) => {
    if (id === deps.botId) return true;
    const m = await deps.store.getMember(guildId, id);
    return !!m?.optedIn && !m.optedOut;
  };
  if (!(await consented(aId)) || !(await consented(bId))) {
    inc("pair_analysis.consent_drop"); return;
  }
  const brain = await deps.brainFor(guildId);
  if (!brain) { inc("jobs.dropped_dormant"); return; } // went dormant — drop, no retry
  const aliases = await deps.getAliases(guildId);
  const exchanges = await deps.store.pairExchanges(guildId, aId, bId, aliases);
  if (exchanges.length < 5) { inc("pair_analysis.thin"); return; } // window dried up since enqueue
  const [aName, bName] = await Promise.all([
    deps.store.displayNameFor(guildId, aId), deps.store.displayNameFor(guildId, bId),
  ]);
  const analysis = await brain.analyzePairWindow(aName, bName, exchanges, deps.analysisModel);
  // The newest exchange's message id doubles as provenance — it keeps the
  // (subject, other, message) dedup key and the audit trail honest.
  await deps.store.recordWindowObservation(
    guildId, aId, bId, exchanges[exchanges.length - 1].id,
    analysis.nature, analysis.valence, analysis.reason, analysis.confident
  );
  inc(analysis.confident ? "pair_analysis.recorded" : "pair_analysis.unconfident");
}
