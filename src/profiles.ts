import { createHash } from "node:crypto";
import { config } from "./config.js";
import { sql as defaultSql, type Sql } from "./db.js";
import type { Brain } from "./brain.js";
import type { MemoryStore } from "./database.js";
import type { EventStore } from "./events.js";
import type { Dossier, DossierSection, Profile, ProfileSynthesis, ProfileSynthesisInput } from "./types.js";
import { gatherDossierInputs, type DossierInput } from "./dossier.js";
import { buildAliasMap } from "./entity-resolution.js";
import { applyProposals, attributeHash, extractDeterministic, listAttributes } from "./attributes.js";
import { logError } from "./secrets.js";

// ── Row types returned by Postgres ────────────────────────────────────────────

type ProfileRow = {
  guild_id: string; subject_id: string; display_name: string;
  summary: string; facets_json: string; source_hash: string; attr_hash: string;
  built_at: Date | string | null; updated_at: Date | string;
};

function ts(d: Date | string): string {
  return d instanceof Date ? d.toISOString() : d;
}

/** Memory IDs that were actually present in a section's input payload. */
function collectSourceIds(payload: Record<string, unknown>): Set<number> {
  const ids = new Set<number>();
  for (const list of ["items", "memories"]) {
    const arr = payload[list];
    if (Array.isArray(arr)) for (const x of arr) {
      if (x && typeof x === "object" && typeof (x as { id?: unknown }).id === "number") ids.add((x as { id: number }).id);
    }
  }
  return ids;
}

/** Drop LLM-invented citations: keep only source_ids that existed in the input. */
function filterSourceIds(data: Record<string, unknown>, validIds: Set<number>): Record<string, unknown> {
  if (!validIds.size) return data;
  const out = { ...data };
  for (const list of ["items", "traits"]) {
    const arr = out[list];
    if (Array.isArray(arr)) {
      out[list] = arr.map(item =>
        item && typeof item === "object" && Array.isArray((item as { source_ids?: unknown }).source_ids)
          ? { ...(item as Record<string, unknown>), source_ids: (item as { source_ids: number[] }).source_ids.filter(id => validIds.has(id)) }
          : item
      );
    }
  }
  return out;
}

/** Degenerate-output detector: models occasionally emit repeated punctuation/glyphs
 * instead of prose. Require real words and some alphanumeric content. */
function looksDegenerate(bio: string): boolean {
  const t = bio.trim();
  const words = t.split(/\s+/).filter(Boolean);
  const alnum = t.replace(/[^a-z0-9]/gi, "");
  return words.length < 5 || alnum.length < 20 || t.startsWith("{") || t.startsWith("[");
}

function rowToProfile(r: ProfileRow): Profile {
  let facets: Profile["facets"] = {};
  try { facets = JSON.parse(r.facets_json); } catch { /* malformed facet JSON → empty facets */ }
  return {
    guildId: r.guild_id, subjectId: r.subject_id, displayName: r.display_name,
    summary: r.summary, facets,
    builtAt: r.built_at ? ts(r.built_at) : null, updatedAt: ts(r.updated_at),
  };
}

// ── ProfileStore ──────────────────────────────────────────────────────────────
// Per-chatter profile cards. buildProfiles() gathers deterministic inputs per
// subject (memories, patterns, relationship edges, events, activity stats),
// hashes them, and only calls the LLM when the inputs have changed.

export class ProfileStore {
  constructor(private sql: Sql = defaultSql) {}

  async getProfile(guildId: string, subjectId: string): Promise<Profile | undefined> {
    // Consent-gated: a straggler profile for a non-opted-in member is invisible
    // everywhere, not just in /profile — defense in depth under the purge.
    const rows = await this.sql<ProfileRow[]>`
      SELECT * FROM profiles WHERE guild_id = ${guildId} AND subject_id = ${subjectId}
        AND subject_id IN (SELECT user_id FROM members WHERE guild_id = ${guildId} AND opted_in = 1 AND opted_out = 0)
    `;
    return rows[0] ? rowToProfile(rows[0]) : undefined;
  }

  async getProfiles(guildId: string, subjectIds: string[]): Promise<Profile[]> {
    if (subjectIds.length === 0) return [];
    const rows = await this.sql<ProfileRow[]>`
      SELECT * FROM profiles WHERE guild_id = ${guildId} AND subject_id = ANY(${subjectIds})
        AND subject_id IN (SELECT user_id FROM members WHERE guild_id = ${guildId} AND opted_in = 1 AND opted_out = 0)
    `;
    return rows.map(rowToProfile);
  }

  /** Public for /opt-out — removes card, dossier sections, and attribute rows.
   * Attributes are pure derived data: deleted, not forgotten. */
  async deleteProfile(guildId: string, subjectId: string): Promise<void> {
    await this.sql`DELETE FROM profiles WHERE guild_id = ${guildId} AND subject_id = ${subjectId}`;
    await this.sql`DELETE FROM profile_attributes WHERE guild_id = ${guildId} AND subject_id = ${subjectId}`;
  }

  /** Top channel and active-hour histogram for a member, from the raw message archive. */
  private async activityStats(guildId: string, userId: string): Promise<{ topChannel: string | null; activeHours: string }> {
    const channelRows = await this.sql<Array<{ channel_id: string; c: number }>>`
      SELECT channel_id, COUNT(*)::int AS c FROM messages
      WHERE guild_id = ${guildId} AND author_id = ${userId}
      GROUP BY channel_id ORDER BY c DESC LIMIT 1
    `;
    const hourRows = await this.sql<Array<{ hour: number; c: number }>>`
      SELECT EXTRACT(HOUR FROM created_at)::int AS hour, COUNT(*)::int AS c FROM messages
      WHERE guild_id = ${guildId} AND author_id = ${userId}
      GROUP BY hour ORDER BY c DESC LIMIT 3
    `;
    return {
      topChannel: channelRows[0]?.channel_id ?? null,
      activeHours: hourRows.length ? hourRows.map(r => `${String(r.hour).padStart(2, "0")}:00`).join(", ") : "unknown",
    };
  }

  /**
   * Rebuild profile cards for every eligible member of a guild.
   * Eligible = opted in AND (≥1 active memory OR ≥5 recorded messages); members
   * without consent are skipped and any straggler profile is deleted on sight.
   * `opts.onlyUserId` scopes the pass to one member (used by /profile-build).
   */
  async buildProfiles(
    guildId: string,
    brain: Brain,
    memoryStore: MemoryStore,
    eventStore: EventStore,
    model?: string,
    opts?: { excludeIds?: string[]; onlyUserId?: string }
  ): Promise<{ built: number; unchanged: number; considered: number }> {
    let built = 0, unchanged = 0, considered = 0;

    // Interaction graph is guild-wide — compute once, slice per member.
    const aliasMap = await buildAliasMap(guildId, memoryStore);
    const allPairs = await memoryStore.interactionPairs(guildId, aliasMap, opts?.excludeIds ?? []);

    for (const member of await memoryStore.listMembers(guildId)) {
      if (opts?.onlyUserId && member.userId !== opts.onlyUserId) continue;
      if (!member.optedIn || member.optedOut) {
        await this.deleteProfile(guildId, member.userId);
        continue;
      }

      const active = await memoryStore.allActiveMemories(guildId, member.userId);
      if (member.messageCount < 5 && active.length === 0) continue;
      considered++;

      const candidates = (await memoryStore.listMemories(guildId, member.userId, { status: "candidate" })).memories
        .filter(m => m.confidence >= 0.5).slice(0, 5);
      const patterns = await memoryStore.patterns(guildId, member.userId);
      const edges = (await memoryStore.mergedEdges(guildId, member.userId))
        .filter(e => e.observationCount >= 2).slice(0, 8);
      const events = (await eventStore.listEvents(guildId, { subjectUserId: member.userId, tier: "event" })).events
        .sort((a, b) => b.significance - a.significance).slice(0, 5);
      const stats = await this.activityStats(guildId, member.userId);
      const displayName = await memoryStore.displayNameFor(guildId, member.userId);

      // The extraction call is bounded by this fingerprint over semantic
      // inputs only — raw activity churn (messageCount, lastSeenAt) is
      // deliberately excluded so a member who just chats costs zero LLM.
      // Stats reach the bio through the render hash instead.
      const fingerprint = [
        member.userId,
        ...active.map(m => `m${m.id}:${m.updatedAt}`),
        ...candidates.map(m => `c${m.id}:${m.updatedAt}`),
        ...patterns.map(p => `p${p.id}:${p.updatedAt}`),
        ...edges.map(e => `r${e.otherId}:${e.observationCount}:${e.lastObservedAt}`),
        ...events.map(e => `e${e.id}`),
      ].join("|");
      const sourceHash = createHash("sha256").update(fingerprint).digest("hex");

      const existing = await this.sql<[{ source_hash: string; attr_hash: string; facets_json: string }]>`
        SELECT source_hash, attr_hash, facets_json FROM profiles WHERE guild_id = ${guildId} AND subject_id = ${member.userId}
      `;
      let existingFacets: Profile["facets"] = {};
      try { existingFacets = JSON.parse(existing[0]?.facets_json ?? "{}"); } catch { /* malformed JSON → rebuild */ }
      const sections: Dossier["sections"] = { ...(existingFacets.dossier?.sections ?? {}) };

      // ── Dossier inputs (tier 2) — gathered before the card early-out so
      // section changes alone can trigger a rebuild.
      const dossierEligible = active.length >= 3 || member.messageCount >= 50;
      const memberInteractions = allPairs
        .filter(p => p.aId === member.userId || p.bId === member.userId)
        .map(p => ({ otherId: p.aId === member.userId ? p.bId : p.aId, count: p.count }));
      const dossierInputs = dossierEligible
        ? await gatherDossierInputs(guildId, member, memoryStore, eventStore, { interactions: memberInteractions })
        : new Map<DossierSection, DossierInput>();

      // Sections whose inputs vanished are dropped; unchanged hashes are kept.
      for (const key of Object.keys(sections) as DossierSection[]) {
        if (!dossierInputs.has(key)) delete sections[key];
      }
      const toBuild = [...dossierInputs.values()].filter(i => sections[i.section]?.hash !== i.hash);

      const cardChanged = existing[0]?.source_hash !== sourceHash;

      // ── Tier 0: structured attributes — the source of truth ──────────────
      // Deterministic extraction runs every pass: pure code, free, idempotent
      // via the upsert-diff, and the catch-all for every activation path plus
      // the lazy backfill for memories that predate this feature.
      const detProposals = active.flatMap(m => extractDeterministic({ id: m.id, kind: m.kind, content: m.content }));
      // A DB error here must fail this member's pass, not the guild's build.
      if (detProposals.length) {
        try { await applyProposals(this.sql, guildId, member.userId, detProposals); }
        catch (error) { logError(`Attribute upsert failed for ${member.userId}`, error); }
      }

      // LLM extraction is gated: memory-fingerprint change, or the member has
      // never been through extraction (attr_hash unset = first pass / lazy
      // backfill). Citations are validated ⊆ input; zero-citation and
      // candidate-only proposals are dropped — an uncitable facet is exactly
      // the failure this table exists to kill.
      const extractionInput = [
        ...active.slice(0, 15).map(m => ({ id: m.id, content: m.content, kind: m.kind, confirmed: true })),
        ...candidates.map(m => ({ id: m.id, content: m.content, kind: m.kind, confirmed: false })),
      ];
      const neverExtracted = (existing[0]?.attr_hash ?? "") === "";
      if ((cardChanged || neverExtracted) && extractionInput.length) {
        try {
          const attrsNow = await listAttributes(this.sql, guildId, member.userId);
          const raw = await brain.extractAttributes({
            displayName,
            memories: extractionInput,
            currentAttributes: attrsNow.filter(a => a.status === "active").map(a => ({ field: a.field, value: a.value })),
          }, model);
          const validIds = new Set(extractionInput.map(m => m.id));
          const activeIds = new Set(active.map(m => m.id));
          const proposals = raw
            .map(p => ({ ...p, memoryIds: p.memoryIds.filter(id => validIds.has(id)) }))
            .filter(p => p.memoryIds.length > 0)
            .filter(p => p.memoryIds.some(id => activeIds.has(id)));
          if (proposals.length) await applyProposals(this.sql, guildId, member.userId, proposals);
        } catch { /* model flakiness — attributes just stay as they are */ }
      }

      // ── Render gate: the bio re-renders when the attribute set or the
      // context feeding it changes — not on raw activity churn. ────────────
      const attrs = await listAttributes(this.sql, guildId, member.userId);
      // Only active attributes render — contested stays visible in admin
      // triage but never presents as fact in a profile.
      const liveAttrs = attrs.filter(a => a.status === "active");
      const renderHash = attributeHash(attrs, [
        ...patterns.map(p => `p${p.id}:${p.updatedAt}`),
        ...edges.map(e => `r${e.otherId}:${e.observationCount}:${e.lastObservedAt}`),
        ...events.map(e => `e${e.id}`),
        `ch:${stats.topChannel ?? ""}`, `hr:${stats.activeHours}`,
      ]);
      const renderChanged = existing[0]?.attr_hash !== renderHash;

      if (!cardChanged && !renderChanged && toBuild.length === 0) { unchanged++; continue; }

      // ── Tier 1: card — prose rendered from the structured set ────────────
      const edgeNames = new Map<string, string>();
      for (const e of edges) {
        edgeNames.set(e.otherId, await memoryStore.displayNameFor(guildId, e.otherId));
      }

      let cardResult: ProfileSynthesis | undefined;
      if (renderChanged || !existing[0]) {
        const input: ProfileSynthesisInput = {
          displayName,
          stats: {
            messageCount: member.messageCount,
            firstSeenAt: member.firstSeenAt, lastSeenAt: member.lastSeenAt,
            topChannel: stats.topChannel, activeHours: stats.activeHours,
          },
          attributes: liveAttrs.map(a => ({ field: a.field, value: a.value, confidence: a.confidence })),
          patterns: patterns.map(p => p.description),
          relationships: edges.map(e => ({
            withName: edgeNames.get(e.otherId) ?? "unknown",
            summary: e.summary, valence: e.valence, observations: e.observationCount,
          })),
          events: events.map(e => ({
            title: e.title || `Event #${e.id}`,
            role: e.participants.find(p => p.userId === member.userId)?.role ?? "participant",
            significance: e.significance,
          })),
        };

        try {
          cardResult = await brain.synthesizeProfile(input, model);
          if (looksDegenerate(cardResult.bio)) cardResult = await brain.synthesizeProfile(input, model);
        } catch { /* model flakiness (json_validate_failed, loops) — fall through */ }
        if (cardResult && looksDegenerate(cardResult.bio)) cardResult = undefined;
        if (!cardResult && !existing[0]) {
          cardResult = {
            bio: `${displayName} has posted ${input.stats.messageCount} messages between ${input.stats.firstSeenAt ?? "unknown"} and ${input.stats.lastSeenAt ?? "unknown"}.`,
            roleInServer: "",
          };
        }
      }

      // ── Tier 2: dossier sections ──────────────────────────────────────────
      for (const sectionInput of toBuild) {
        const builtAt = new Date().toISOString();
        if (sectionInput.section === "timeline") {
          sections.timeline = { hash: sectionInput.hash, builtAt, data: sectionInput.payload };
          continue;
        }
        const validIds = collectSourceIds(sectionInput.payload);
        const sectionModel = config.dossierModel ?? model;
        try {
          let data = await brain.synthesizeDossierSection(sectionInput.section, displayName, sectionInput.payload, sectionModel);
          if (typeof data.prose === "string" && looksDegenerate(data.prose)) {
            data = await brain.synthesizeDossierSection(sectionInput.section, displayName, sectionInput.payload, sectionModel);
          }
          if (typeof data.prose === "string" && looksDegenerate(data.prose)) continue; // keep old section
          if (sectionInput.section === "voice") data = { ...data, stats: sectionInput.payload.stats };
          sections[sectionInput.section] = { hash: sectionInput.hash, builtAt, data: filterSourceIds(data, validIds) };
        } catch { /* keep previous section data on failure */ }
        await new Promise(r => setTimeout(r, 800)); // pace section calls for Groq TPM
      }

      // Facets assemble deterministically: traits/interests from live
      // attributes, notable relationships from verified edges.
      const facets: Profile["facets"] = {
        traits: liveAttrs.filter(a => a.field === "trait").map(a => a.value),
        interests: liveAttrs.filter(a => a.field === "interest").map(a => a.value),
        notableRelationships: edges.slice(0, 5).map(e => `${edgeNames.get(e.otherId) ?? "unknown"} — ${e.summary || "observed dynamic"}`),
        roleInServer: cardResult?.roleInServer ?? existingFacets.roleInServer ?? "",
        dossier: { sections },
      };
      const summary = cardResult?.bio ?? (existing[0] ? undefined : "");
      if (cardResult || !existing[0]) {
        await this.sql`
          INSERT INTO profiles (guild_id, subject_id, display_name, summary, facets_json, source_hash, attr_hash, built_at, updated_at)
          VALUES (${guildId}, ${member.userId}, ${displayName}, ${summary ?? ""}, ${JSON.stringify(facets)}, ${sourceHash}, ${renderHash}, NOW(), NOW())
          ON CONFLICT (guild_id, subject_id) DO UPDATE SET
            display_name = EXCLUDED.display_name,
            summary      = EXCLUDED.summary,
            facets_json  = EXCLUDED.facets_json,
            source_hash  = EXCLUDED.source_hash,
            attr_hash    = EXCLUDED.attr_hash,
            built_at     = EXCLUDED.built_at,
            updated_at   = NOW()
        `;
      } else {
        // Card unchanged — refresh facets/dossier + hashes, preserve summary + built_at.
        await this.sql`
          UPDATE profiles SET display_name = ${displayName}, facets_json = ${JSON.stringify(facets)}, source_hash = ${sourceHash}, attr_hash = ${renderHash}, updated_at = NOW()
          WHERE guild_id = ${guildId} AND subject_id = ${member.userId}
        `;
      }
      built++;
    }

    return { built, unchanged, considered };
  }
}
