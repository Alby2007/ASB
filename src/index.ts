import { Client, Events, GatewayIntentBits, Partials, type Guild, type Message, type OmitPartialGroupDMChannel } from "discord.js";
import OpenAI from "openai";
import { config } from "./config.js";
import { sql } from "./db.js";
import { MemoryStore } from "./database.js";
import { createBrainResolver, guardedLlmFetch } from "./brains.js";
import { commandDefinitions, handleMemoryButton, handleMemoryCommand, handleSetupModal } from "./commands.js";
import { detectDismissal, detectWakeWord, looksLikeSchemaLeak, questionKeywords, roomAddressCue, shouldInspectForMemory, toolCues } from "./perception.js";
import { ConversationTracker } from "./conversation.js";
import { ProactiveScheduler } from "./proactive.js";
import { EventStore } from "./events.js";
import { EventPipeline } from "./event-detection.js";
import { ProfileStore } from "./profiles.js";
import { buildAliasMap, demangleMentions, findMentionedUsers, scrubMentions, type AliasMap } from "./entity-resolution.js";
import { enqueue, startWorker } from "./jobs.js";
import { buildPairContext, type ToolCtx } from "./lookup-tools.js";
import { qualifyingImages, formatImageContext, IMAGE_MAX_PER_MESSAGE, type AttachmentMeta } from "./vision.js";
import { withRetry } from "./retry.js";
import { inc } from "./metrics.js";
import { logError, redactSecrets, registerSecret, validateLlmKey } from "./secrets.js";
import { announceIfNeeded, handleGuildDelete } from "./guild-lifecycle.js";
import { isSafeUrl } from "./tools.js";
import { BudgetExceeded, meteredClient } from "./budget.js";
import { runExtractJob, type ExtractJobPayload } from "./extract-job.js";
import type { MessageEvent, PairContext } from "./types.js";

// Register every credential before any code path can log it — redactSecrets
// scrubs all registered values plus auth-header-shaped tokens out of logs.
registerSecret(config.discordToken);
registerSecret(config.databaseUrl);
registerSecret(config.keyEncryptionSecret);
registerSecret(config.groqKey);
registerSecret(config.visionApiKey);

// Operator-set endpoints still get the SSRF guard — a pasted internal URL
// would otherwise aim every LLM call (carrying the API key) at the wrong host.
for (const [name, url] of [["GROQ_BASE_URL", config.groqBaseUrl], ["VISION_BASE_URL", config.visionBaseUrl]] as const) {
  if (url && !isSafeUrl(url)) {
    console.error(`${name} fails the URL safety check (private/internal host) — refusing to start`);
    process.exit(1);
  }
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMessageReactions],
  // Reactions on uncached messages arrive as partials — the listener resolves
  // them explicitly before interpreting.
  partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.User],
});
// Per-guild Brain resolver (BYOK): a guild's own key when /setup stored one,
// env key otherwise, null (dormant) when REQUIRE_GUILD_KEYS blocks the fallback.
// `store` is assigned in init() before any resolution can be requested.
const { brainFor, invalidate: invalidateBrain } = createBrainResolver({
  getKey: guildId => store.getGuildKey(guildId),
  envKey: config.groqKey, envModel: config.model, envBaseUrl: config.groqBaseUrl,
  requireGuildKeys: config.requireGuildKeys,
  markValidated: guildId => store.markGuildKeyValidated(guildId),
  revalidate: async (key, baseUrl) => (await validateLlmKey(key, baseUrl, guardedLlmFetch)).ok,
  // Every LLM call a guild makes — BYOK or env key — charges its daily budget.
  // getCap reads settings() (60s cache — fine for a daily bound).
  meter: (guildId, c) => meteredClient(c, {
    guildId, store,
    getCap: async () => (await store.settings(guildId, config.rawMessageRetentionDays)).llmDailyCap,
  }),
});
// Vision can live on a different provider than the main key (e.g. Gemini's
// free tier, since Groq rotated its vision models off) — a second client is
// built only when the creds actually differ.
const visionClient = config.visionModel &&
  (config.visionApiKey !== config.groqKey || config.visionBaseUrl !== config.groqBaseUrl)
    ? new OpenAI({ apiKey: config.visionApiKey, baseURL: config.visionBaseUrl })
    : undefined;
const pipeline = new EventPipeline();
// Per-channel conversation state: who's actively talking *with* the bot.
// Opens on addressed messages, closes when the last participant leaves —
// TTL expiry, regex dismissal, or the model's end_conversation signal.
const convo = new ConversationTracker(config.engagementTtlMs);
// Stranded-question trigger: a question arms a debounced timer; any follow-up
// (message or reaction) cancels it — the point is waiting to see if a human
// answers first. In-memory like ConversationTracker — restart resets the daily
// cap and backoff state gracefully.
const proactive = new ProactiveScheduler({
  delayMs: config.proactiveDelayMs,
  dailyCap: config.proactiveDailyCap,
  responseWindowMs: config.proactiveResponseWindowMs,
  backoffMs: config.proactiveBackoffMs,
  baseMinConfidence: 0.6,
  backoffMinConfidence: 0.85,
});
proactive.setFireHandler((key, messageId) => {
  void fireProactive(key, messageId).catch(error => {
    // A capped guild isn't a fault — the metered client threw before spend.
    if (error instanceof BudgetExceeded) { inc("budget.proactive_blocked"); return; }
    inc("proactive.error"); logError("Proactive fire failed", error);
  });
});

// MemoryStore.create() runs migrations; EventStore shares the same sql connection.
let store: MemoryStore;
let eventStore: EventStore;
let profileStore: ProfileStore;
let worker: { stop: () => Promise<void> } | undefined;

async function init() {
  store = await MemoryStore.create();
  eventStore = new EventStore();
  profileStore = new ProfileStore();
  // Deferrable cognition runs here — extract jobs claimed per-guild-serial,
  // global cap 8. LISTEN 'jobs' for wake hints, 3s poll as the baseline.
  worker = startWorker({
    sql, handle: job => runExtractJob(job.payload as ExtractJobPayload, extractDeps),
    onError: (m, e) => logError(m, e),
  });
}

client.once(Events.ClientReady, async ready => {
  // init failure leaves a connected but braindead bot — exit so supervision
  // restarts it rather than letting it sit mute.
  try {
    await init();
  } catch (error) { logError("Startup init failed", error); process.exit(1); }
  try {
    if (config.guildId) await ready.application.commands.set(commandDefinitions, config.guildId);
    else await ready.application.commands.set(commandDefinitions);
  } catch (error) { inc("init.commands_error"); logError("Command registration failed", error); }
  // Fire-and-forget: both loops must never reject into the event loop — on
  // Node >=15 an unhandled rejection here is fatal to the process.
  applyRetention().catch(error => { inc("maintenance.error"); logError("Retention run failed", error); });
  sweepMissedSignals(24 * 60 * 60_000).catch(error => { inc("sweep.error"); logError("Boot sweep failed", error); }); // wide window on boot to cover downtime
  if (!config.visionModel) console.warn("[vision] VISION_MODEL unset — image attachments will be ignored");
  console.log(`ASM online as ${ready.user.tag}`);
});

// ── Guild lifecycle (announce / kick-purge) ─────────────────────────────────
// announceIfNeeded + handleGuildDelete live in guild-lifecycle.ts so they can
// be unit-tested (this module logs in on import).
client.on(Events.GuildCreate, guild => {
  if (!store) return; // fires before init on connect — ClientReady runs first in practice
  announceIfNeeded(guild, store).catch(error => { inc("guild.announce_error"); logError(`Join announcement failed in ${guild.name}`, error); });
});

client.on(Events.GuildDelete, guild => {
  if (!store) return;
  handleGuildDelete(guild as Guild & { unavailable?: boolean }, store)
    .then(purged => { if (purged) { inc("guild.purged"); console.log(`Purged all data for removed guild ${guild.id} (${guild.name})`); } })
    .catch(error => { inc("guild.purge_error"); logError(`Guild purge failed for ${guild.id}`, error); });
});

async function applyRetention() {
  // Zombie sweep first: an in-flight write can race a kick-purge and re-insert
  // a server_settings/members row after it commits. Cache is authoritative —
  // discord.js keeps unavailable (outage) guilds cached, so they're never
  // swept. guildsNotIn no-ops on an empty cache (treated as "not ready").
  try {
    const known = client.guilds.cache.map(g => g.id);
    for (const orphanId of await store.guildsNotIn(known)) {
      await store.purgeGuild(orphanId);
      inc("guild.purged");
      console.log(`Purged zombie rows for removed guild ${orphanId}`);
    }
  } catch (error) { inc("maintenance.error"); logError("Zombie-guild sweep failed", error); }
  for (const guild of client.guilds.cache.values()) {
    // These three calls sit outside the feature-level try/catches below — a DB
    // blip here must skip the guild, not reject the whole interval callback.
    try {
      const settings = await store.settings(guild.id, config.rawMessageRetentionDays);
      // The bot opts itself in — memories the room forms about it are part of
      // its persona surface (framed as community claims, not self-truth).
      await store.setMemberOptIn(guild.id, client.user!.id, true);
      const deleted = await store.deleteRawMessagesOlderThan(guild.id, settings.rawRetentionDays);
      await store.maintain(guild.id, config.candidateConfidenceThreshold);
      if (deleted) console.log(`Retention deleted ${deleted} raw messages in ${guild.name}`);
    } catch (error) { inc("maintenance.retention_error"); logError(`Retention/maintenance failed in ${guild.name}`, error); continue; }
    try {
      const pruned = await store.pruneDerivedData(guild.id);
      if (pruned.history + pruned.names + pruned.aliases + pruned.events + pruned.usage) {
        console.log(`Pruned derived data in ${guild.name}: ${pruned.history} history, ${pruned.names} unresolved names, ${pruned.aliases} alias candidates, ${pruned.events} events, ${pruned.usage} usage rows`);
      }
    } catch (error) { inc("maintenance.prune_error"); logError("Derived-data pruning failed", error); }
    // Dormant guilds (no key) skip every LLM pass — retention/pruning above
    // still ran; they're lifecycle ops, not cognition.
    const brain = await brainFor(guild.id);
    if (!brain) continue;
    // v0.2: close stale open event windows and score candidate events
    try {
      const result = await pipeline.maintainEvents(guild.id, eventStore, store, brain);
      if (result.closed || result.promoted || result.discarded) {
        console.log(`Events maintained in ${guild.name}: closed=${result.closed} promoted=${result.promoted} discarded=${result.discarded}`);
      }
    } catch (error) { logError("Event maintenance failed", error); }
    // Verify promotable candidate memories against their source messages so edgy
    // jokes don't activate; verified literal self-reports promote. Runs before
    // the profile build so cards and dossiers see final statuses.
    try {
      const verifiable = await store.listVerifiableCandidates(guild.id);
      let vPromoted = 0, vFlagged = 0;
      for (let i = 0; i < verifiable.length; i += 10) {
        const batch = verifiable.slice(i, i + 10);
        const verdicts = await brain.verifyMemoriesBatch(
          batch.map(b => ({ memoryId: b.memoryId, authorName: b.authorName, authorNames: b.authorNames, claim: b.content, sourceMessage: b.sourceMessage, contextBefore: b.contextBefore })),
          config.verifyModel ?? config.model
        );
        for (const b of batch) {
          const v = verdicts.get(b.memoryId);
          if (!v) continue;
          const r = await store.applyVerification(b.memoryId, v.verdict, v.reason);
          if (r === "promoted") vPromoted++;
          else if (r === "flagged") vFlagged++;
        }
      }
      if (vPromoted || vFlagged) console.log(`Verified candidates in ${guild.name}: ${vPromoted} promoted, ${vFlagged} flagged as jokes`);
    } catch (error) { logError("Verification failed", error); }
    // Verify unverified relationship observations, then rebuild edges — the
    // relationships table is derived from 'literal'-verdicted observations
    // only, so unverified assertions never surface as edges. Recompute runs
    // every pass so opted-out deletions and pre-existing edges stay consistent.
    try {
      const unverified = await store.listUnverifiedObservations(guild.id, 50);
      let judged = 0;
      for (let i = 0; i < unverified.length; i += 10) {
        const batch = unverified.slice(i, i + 10);
        const items = await Promise.all(batch.map(async b => ({
          observationId: b.observationId, authorName: b.authorName, authorNames: b.authorNames,
          nature: b.nature, otherName: await store.displayNameFor(guild.id, b.otherId),
          sourceMessage: b.sourceMessage, contextBefore: b.contextBefore,
        })));
        const verdicts = await brain.verifyRelationshipsBatch(
          items,
          config.verifyModel ?? config.model
        );
        for (const b of batch) {
          const v = verdicts.get(b.observationId);
          if (v) { await store.setObservationVerdict(b.observationId, v.verdict); judged++; }
        }
      }
      const edgeCount = await store.recomputeEdges(guild.id);
      if (unverified.length) console.log(`Verified ${judged} relationship observations in ${guild.name}; recomputed ${edgeCount} edges`);
    } catch (error) { logError("Relationship verification failed", error); }
    // Semantic dedup — the LLM scans each member's memory list for rephrased
    // duplicates the trigram fast-path can't see ("allergic to peanuts" /
    // "can't eat nuts"). It proposes groups; applyDedupGroups enforces
    // same-subject/kind, live-status guards and merges into a canonical row.
    try {
      const members = await store.listDedupCandidates(guild.id);
      if (members.length) {
        let index = 0;
        const idByIndex = new Map<number, number>();
        const indexed = members.map(m => ({
          label: m.label,
          memories: m.memories.map(mm => { const i = index++; idByIndex.set(i, mm.memoryId); return { index: i, kind: mm.kind, status: mm.status, content: mm.content }; }),
        }));
        const groups = await brain.dedupMemoriesBatch(indexed, config.verifyModel ?? config.model);
        const dupGroups = groups.filter(g => g.relation === "duplicate")
          .map(g => ({ ids: g.indices.map(i => idByIndex.get(i)).filter((x): x is number => x !== undefined), reason: g.reason }));
        const { merged, skipped } = await store.applyDedupGroups(guild.id, dupGroups);
        let contradictions = 0;
        for (const g of groups) {
          if (g.relation !== "contradicts") continue;
          const ids = g.indices.map(i => idByIndex.get(i)).filter((x): x is number => x !== undefined);
          for (const id of ids) {
            await store.logHistory(id, "dedup_contradiction", null, null, null, null, null, { otherIds: ids.filter(x => x !== id), reason: g.reason });
          }
          contradictions++;
        }
        if (merged || skipped || contradictions) console.log(`Dedup in ${guild.name}: ${merged} merged | ${skipped} groups skipped | ${contradictions} contradictions logged`);
        inc("dedup.merged", merged);
      }
    } catch (error) { logError("Dedup pass failed", error); inc("dedup.errors"); }
    // v0.3: rebuild per-chatter profile cards + dossiers (LLM calls only when inputs changed)
    try {
      const profiles = await profileStore.buildProfiles(guild.id, brain, store, eventStore, config.profileModel, { excludeIds: [client.user!.id] });
      if (profiles.built) console.log(`Profiles in ${guild.name}: ${profiles.built} rebuilt, ${profiles.unchanged} unchanged of ${profiles.considered}`);
    } catch (error) { logError("Profile build failed", error); }
  }
}
// Belt-and-braces: every guild body is try/caught, but an interval callback
// rejection would still be an unhandled (fatal) rejection.
setInterval(() => applyRetention().catch(error => { inc("maintenance.error"); logError("Retention run failed", error); }), 24 * 60 * 60 * 1000).unref();

const SWEEP_INTERVAL_MS = 15 * 60_000;
const SWEEP_WINDOW_MS = 2 * 60 * 60_000;
const SWEEP_TRIAGE_BATCH = 10;

setInterval(() => sweepMissedSignals(SWEEP_WINDOW_MS), SWEEP_INTERVAL_MS).unref();

// Live traffic that fails the durableSignals regex is never inspected inline —
// this sweep gives it the same LLM triage ingest already uses, so durable
// preferences in unpatterned phrasing ("can you just call me Riley from now on",
// said to nobody in particular) still land within ~15 minutes. Marks persist on
// messages.triage_result, so each message is classified once; durable/regex
// verdicts enqueue 'extract' jobs and flip to 'queued' (a failed enqueue keeps
// the mark so the next pass retries — crash-safe), and 'extracted' marks the
// terminal state so empty results don't re-extract forever.
async function sweepMissedSignals(windowMs: number) {
  for (const guild of client.guilds.cache.values()) {
    try {
      const settings = await store.settings(guild.id, config.rawMessageRetentionDays);
      if (!settings.memoryEnabled) continue;
      // No key → nothing to triage or extract with — skip the guild entirely.
      const brain = await brainFor(guild.id);
      if (!brain) continue;
      const pending = (await store.listUninspectedMessages(guild.id, new Date(Date.now() - windowMs), client.user!.id))
        .filter(m => !settings.ignoredChannels.includes(m.channelId)); // ignored = invisible, including rows archived before the flag
      if (!pending.length) continue;
      const toEvent = (m: (typeof pending)[number]): MessageEvent => ({
        guildId: guild.id, channelId: m.channelId, messageId: m.id,
        authorId: m.authorId, authorName: m.authorName, content: m.content,
        createdAt: new Date(m.createdAt),
        mentionsBot: m.content.includes(`<@${client.user!.id}>`) || m.content.includes(`<@!${client.user!.id}>`),
      });
      const marks: Array<{ id: string; result: string }> = [];
      const toEnqueue: Array<{ event: MessageEvent; replyToId?: string }> = [];
      const triageQueue: typeof pending = [];
      for (const m of pending) {
        const event = toEvent(m);
        if (m.triageResult === "durable" || m.triageResult === "regex") {
          toEnqueue.push({ event, replyToId: m.replyToId ?? undefined }); // marked earlier but never extracted
        } else if (shouldInspectForMemory(event)) {
          marks.push({ id: m.id, result: "regex" });
          toEnqueue.push({ event, replyToId: m.replyToId ?? undefined });
        } else if (m.content.trim().length >= 4) {
          triageQueue.push(m);
        } else {
          marks.push({ id: m.id, result: "noise" });
        }
      }
      for (let i = 0; i < triageQueue.length; i += SWEEP_TRIAGE_BATCH) {
        const batch = triageQueue.slice(i, i + SWEEP_TRIAGE_BATCH);
        try {
          const verdicts = await withRetry(() => brain.triageBatch(
            batch.map(b => ({ messageId: b.id, authorName: b.authorName, content: b.content })),
            config.triageModel ?? config.model
          ), 3);
          for (const item of batch) {
            const durable = verdicts.get(item.id)?.durable ?? false;
            marks.push({ id: item.id, result: durable ? "durable" : "noise" });
            if (durable) toEnqueue.push({ event: toEvent(item), replyToId: item.replyToId ?? undefined });
          }
        } catch { /* batch stays unmarked — next sweep retries it */ }
      }
      // Persist marks before enqueueing: durable/regex marks survive a crash
      // and are picked back up on the next pass via the no-evidence filter.
      await store.setTriageResults(marks);
      if (!toEnqueue.length) continue;
      // Extraction defers to the job queue — the sweep's role is triage, and
      // routing through the queue gets per-guild serial execution, backoff,
      // and budget-aware rescheduling for free. A failed enqueue leaves the
      // durable mark in place so the next pass retries.
      const queuedMarks: Array<{ id: string; result: string }> = [];
      for (const item of toEnqueue) {
        let replyToContent: string | undefined;
        if (item.replyToId) {
          const ref = await store.getMessage(guild.id, item.replyToId);
          if (ref) replyToContent = `${ref.authorName}: ${ref.content}`;
        }
        try {
          await enqueue(sql, guild.id, "extract", { event: item.event, replyToId: item.replyToId, replyToContent });
          queuedMarks.push({ id: item.event.messageId, result: "queued" });
        } catch (error) { inc("jobs.enqueue_error"); logError("Sweep enqueue failed", error); }
      }
      if (queuedMarks.length) await store.setTriageResults(queuedMarks);
      inc("sweep.runs");
    } catch (error) { inc("sweep.error"); logError(`Missed-signal sweep failed in ${guild.name}`, error); }
  }
}

client.on(Events.InteractionCreate, async interaction => {
  try {
    if (interaction.isChatInputCommand()) await handleMemoryCommand(interaction, store, brainFor, eventStore, profileStore);
    if (interaction.isModalSubmit()) await handleSetupModal(interaction, store, invalidateBrain);
    if (interaction.isButton()) await handleMemoryButton(interaction, store, brainFor, eventStore);
  } catch (error) {
    inc("handler.interaction_error");
    logError("Interaction handling failed", error);
    // Best-effort user-facing error; ignore failures (already replied/expired).
    try {
      if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: "Something went wrong handling that.", ephemeral: true });
      }
    } catch { /* interaction no longer replyable */ }
  }
});

client.on(Events.MessageCreate, message => {
  // Outer catch lives here, not inline: an unhandled rejection in a listener
  // crashes the process, so every failure mode lands in this log instead.
  handleMessage(message).catch(error => { inc("handler.message_error"); logError("Message handling failed", error); });
});

// Edits update the archive row; the extraction-time snapshot in memory_evidence
// is deliberately left alone — it's the record of what was observed, not a
// mirror of current content.
client.on(Events.MessageUpdate, (_old, message) => {
  if (!store) return; // before init() completes — a sync TypeError would escape .catch
  if (!message.guild || !message.content?.trim()) return;
  if (config.guildId && message.guild.id !== config.guildId) return;
  store.updateMessageContent(message.guild.id, message.id, message.content)
    .catch(error => { inc("handler.message_error"); logError("Message update handling failed", error); });
});

// Deletes remove the raw row (so the sweep never extracts deleted content)
// and scrub the verbatim text on any evidence it already produced.
client.on(Events.MessageDelete, message => {
  if (!store) return;
  if (!message.guild) return;
  if (config.guildId && message.guild.id !== config.guildId) return;
  // A deleted question is no longer stranded — drop any pending proactive arm.
  proactive.cancelPending(`${message.guild.id}:${message.channelId}`, message.id);
  store.deleteMessage(message.guild.id, message.id)
    .catch(error => { inc("handler.message_error"); logError("Message delete handling failed", error); });
});

// Reactions are observable signals only — the bot never places them. A
// reaction on the pending question means the room engaged with it (answered or
// acknowledged) → cancel; a reaction on a proactive reply means it landed →
// don't count it as ignored toward backoff.
client.on(Events.MessageReactionAdd, async (reaction, user) => {
  try {
    if (reaction.partial) reaction = await reaction.fetch().catch(() => reaction);
    const msg = reaction.message.partial ? await reaction.message.fetch().catch(() => undefined) : reaction.message;
    if (!msg?.guildId) return;
    if (config.guildId && msg.guildId !== config.guildId) return;
    if (user.id === client.user?.id) return;
    const key = `${msg.guildId}:${msg.channelId}`;
    if (proactive.isProactiveTarget(msg.id)) proactive.observeEngagement(msg.id);
    else proactive.cancelPending(key, msg.id);
  } catch (error) { inc("handler.reaction_error"); logError("Reaction handling failed", error); }
});

// Alias maps are shared per guild rather than built per message — the same map
// object also feeds the compiled-regex cache in entity-resolution, so caching it
// means the alternation pattern compiles once per rebuild, not per message.
// learnAlias invalidates immediately; display-name drift via upsertMember is
// bounded by the TTL. The same cache carries an id→display-name map used to
// demangle <@id> tokens before they reach the LLM.
const lookupCache = new Map<string, { map: AliasMap; names: Map<string, string>; at: number }>();
const LOOKUP_TTL_MS = 5 * 60_000;

// BudgetExceeded on the reply path → one short notice per channel per UTC
// day: silence on a direct request is rude, spam is worse. In-memory —
// a restart re-noticing once is harmless.
const budgetNotices = new Set<string>();
function budgetNoticeOnce(channelId: string): boolean {
  const key = `${channelId}:${new Date().toISOString().slice(0, 10)}`;
  if (budgetNotices.has(key)) return false;
  budgetNotices.add(key);
  return true;
}

async function guildLookups(guildId: string): Promise<{ map: AliasMap; names: Map<string, string> }> {
  const cached = lookupCache.get(guildId);
  if (cached && Date.now() - cached.at < LOOKUP_TTL_MS) return cached;
  const [map, members] = await Promise.all([buildAliasMap(guildId, store), store.listMembers(guildId)]);
  const names = new Map<string, string>();
  for (const m of members) names.set(m.userId, m.knownNames.at(-1) ?? m.userId);
  if (client.user) names.set(client.user.id, client.user.username);
  const entry = { map, names, at: Date.now() };
  lookupCache.set(guildId, entry);
  return entry;
}

// The extract-job handler lives in extract-job.ts (deps injected) so it's
// unit-testable — index.ts can't be imported (it logs in on load). The worker
// deps bind this process's live singletons; getAliases/invalidateLookups close
// over the TTL lookup cache.
const extractDeps = {
  get store() { return store; },
  brainFor,
  get eventStore() { return eventStore; },
  pipeline,
  get botId() { return client.user!.id; },
  get visionModel() { return config.visionModel; },
  visionClient,
  get contestModel() { return config.contestModel ?? config.model; },
  get imageMaxBytes() { return config.imageMaxBytes; },
  getAliases: (guildId: string) => guildLookups(guildId).then(e => e.map),
  invalidateLookups: (guildId: string) => { lookupCache.delete(guildId); },
};

/**
 * A pending question's timer survived — the room stayed silent. Re-verify
 * everything at send time: kill switches, the question still existing and
 * still being a question, the daily cap, then the two-stage gate (grounded
 * context first, one LLM proposal only if something came back).
 */
async function fireProactive(key: string, messageId: string): Promise<void> {
  const [guildId, channelId] = key.split(":");
  if (!config.proactiveEnabled) return;
  const settings = await store.settings(guildId, config.rawMessageRetentionDays);
  if (!settings.proactiveEnabled || !settings.replyEnabled) return;
  const brain = await brainFor(guildId);
  if (!brain) return; // dormant guild — no grounded answers to propose with
  const gate = proactive.allow(key);
  if (!gate.allowed) { inc("proactive.capped"); return; }
  // Re-fetch: a deleted question fails the fetch, an edited one may no longer
  // be a question — neither should earn a stale proactive answer.
  const channel = await client.channels.fetch(channelId).catch(() => undefined);
  if (!channel?.isTextBased()) return;
  const question = await channel.messages.fetch(messageId).catch(() => undefined);
  if (!question || !question.content.trimEnd().endsWith("?")) { inc("proactive.stale"); return; }
  // Grounded context is server lore + promoted events ONLY — person facts and
  // preferences are excluded at the query layer, not filtered after the fact,
  // because opt-out-of-storage never consented to unprompted public surfacing.
  // Zero hits → zero LLM calls; that bound is the feature's cost control.
  const terms = questionKeywords(question.content);
  const grounded = new Set<string>();
  for (const t of terms) {
    for (const m of await store.searchMemories(guildId, t, 3, ["server_lore"])) grounded.add(m.content);
    for (const e of await eventStore.searchEvents(guildId, t, 2)) grounded.add(`event: ${e.title}${e.summary ? ` — ${e.summary}` : ""}`);
    if (grounded.size >= 8) break;
  }
  if (!grounded.size) { inc("proactive.ungrounded"); return; }
  const names = (await guildLookups(guildId)).names;
  const proposal = await brain.proposeGroundedAnswer(demangleMentions(question.content, names), [...grounded].slice(0, 8), gate.minConfidence, config.replyModel);
  if (!proposal) { inc("proactive.gated"); return; }
  const clean = scrubMentions(proposal.answer, names);
  if (!clean) return;
  const sent = await question.reply({ content: clean, allowedMentions: { parse: [], repliedUser: false } });
  proactive.recordFire(key);
  proactive.noteSent(key, sent.id);
  // Proactive speech counts toward share-of-voice like any other reply — an
  // invisible reply would corrupt the pacing accounting.
  convo.noteReply(key);
  inc("proactive.fired");
  await store.recordMessage({
    guildId, channelId, messageId: sent.id,
    authorId: client.user!.id, authorName: question.guild?.members.me?.displayName ?? client.user!.username,
    content: clean, createdAt: sent.createdAt ?? new Date(), mentionsBot: false,
  }, messageId, false);
  await store.setTriageResults([{ id: sent.id, result: "noise" }]);
}

async function handleMessage(message: OmitPartialGroupDMChannel<Message>) {
  // Image attachments are gated before the empty-content early-out so an
  // image-only message still reaches extraction; VISION_MODEL unset = off.
  const images = config.visionModel
    ? qualifyingImages(message.attachments.values(), config.imageMaxBytes, IMAGE_MAX_PER_MESSAGE)
    : [];
  if (!message.guild || (!message.content.trim() && !images.length)) return;
  if (config.guildId && message.guild.id !== config.guildId) return;
  const event: MessageEvent = {
    guildId: message.guild.id, channelId: message.channel.id, messageId: message.id,
    authorId: message.author.id, authorName: message.member?.displayName ?? message.author.username,
    content: message.content, createdAt: message.createdAt,
    // Wake words ("asb", the bot's username/display name, its server nick)
    // count as addressing the bot — same flag, same downstream behavior.
    mentionsBot: message.mentions.has(client.user!) || message.mentions.repliedUser?.id === client.user!.id
      || (config.wakeWord && detectWakeWord(message.content, [
        "asb", client.user!.username, client.user!.globalName, message.guild.members.me?.displayName,
      ])),
    imageAttachments: images.length ? images : undefined,
  };
  const settings = await store.settings(event.guildId, config.rawMessageRetentionDays);
  // "Pause observing" must actually stop observing — a paused guild gets no
  // raw archive rows or member-registry writes, not just no extraction. The
  // sweep skips paused guilds anyway, so archive-during-pause rows would be
  // orphaned the moment they're written.
  if (!settings.memoryEnabled && !settings.replyEnabled) return;
  // Ignored channels are truly invisible: no archive, no replies, no member
  // writes — checked before brainFor/recordMessage so nothing at all happens.
  if (settings.ignoredChannels.includes(event.channelId)) return;
  // BYOK dormant guild: no key → no archive, no reply — everything below
  // (extraction, contest, pipeline, decide, reply) binds this guild's brain.
  const brain = await brainFor(event.guildId);
  if (!brain) return;
  // Resolve the reply target first so it can be persisted with the raw message.
  const replyToId = message.reference?.messageId ?? undefined;
  if (settings.memoryEnabled) await store.recordMessage(event, replyToId, !message.author.bot);
  // Bot chatter is archive-only context: it resolves references and appears in
  // recentContext, but is never a memory source, never enters the event
  // pipeline, and never triggers a reply — no bot→bot loops.
  if (message.author.bot) {
    if (settings.memoryEnabled) await store.setTriageResults([{ id: event.messageId, result: "noise" }]);
    return;
  }
  let replyToContent: string | undefined;
  if (replyToId) {
    const ref = await store.getMessage(event.guildId, replyToId);
    if (ref) replyToContent = `${ref.authorName}: ${ref.content}`;
    else {
      // Reply target isn't archived (bot message that predates this, pre-boot
      // history) — ask Discord for it so the reference still resolves.
      const live = await message.channel.messages.fetch(replyToId).catch(() => undefined);
      if (live) replyToContent = `${live.member?.displayName ?? live.author.username}: ${live.content}`;
    }
  }
  // Per-image describe, per-image fault tolerance — a dead URL or a 429 skips
  // that image, never the message's text. Memoized so extraction and the reply
  // path share one describe pass for the same message. A separate vision
  // client is operator spend but still counts against this guild's daily cap —
  // metered here (undefined → describeImage uses the brain's metered client).
  const meteredVision = visionClient
    ? meteredClient(visionClient, { guildId: event.guildId, store, getCap: async () => (await store.settings(event.guildId, config.rawMessageRetentionDays)).llmDailyCap })
    : undefined;
  const describeImages = (list: Array<AttachmentMeta & { contentType: string }>) =>
    Promise.all(list.map(async a => {
      try {
        const d = await brain.describeImage({ url: a.url, contextText: event.content, maxBytes: config.imageMaxBytes }, config.visionModel!, meteredVision);
        inc("vision.described");
        return d.description;
      } catch (error) {
        if (error instanceof BudgetExceeded) throw error; // lands in the reply block's budget notice
        inc("vision.error"); logError("Image describe failed", error); return undefined;
      }
    })).then(list => list.filter((d): d is string => !!d));
  let imageDescs: Promise<string[]> | undefined;
  const getImageDescriptions = () => (imageDescs ??= describeImages(images));
  // Extraction, contest detection, and the event pipeline all defer to the
  // 'extract' job — the live path keeps only recordMessage/decide/reply so a
  // busy guild can't stack unbounded concurrent LLM calls inside one handler.
  // 'queued' marks the row so the sweep (NULL/'durable'/'regex' only) can't
  // double-extract; a dead job just stays 'queued' — bounded loss, metric'd.
  if (settings.memoryEnabled && (shouldInspectForMemory(event) || images.length)) {
    try {
      await enqueue(sql, event.guildId, "extract", { event, replyToId, replyToContent });
      await store.setTriageResults([{ id: event.messageId, result: "queued" }]);
      inc("jobs.enqueued");
    } catch (error) { inc("jobs.enqueue_error"); logError("Extraction enqueue failed", error); }
  }

  const key = `${event.guildId}:${event.channelId}`;
  // Any human follow-up means the room isn't silent — a pending stranded
  // question is answered or abandoned, either way it's cancelled. A reply-edge
  // to a sent proactive reply counts as engagement instead: it wasn't ignored,
  // so it must not feed the ignored-streak backoff.
  proactive.cancelPending(key);
  if (replyToId) proactive.observeEngagement(replyToId);
  // This human message counts toward share-of-voice before scoring — it
  // dilutes the bot's floor share for the decide() below.
  convo.noteMessage(key, false, event.authorId);
  // An addressed message enrolls the author — opening the conversation if it
  // wasn't already (first participant in → opened).
  // ENGAGEMENT=0 = address-only mode: no conversation state is enrolled at
  // all, so every message scores as stranger and the opened metric stays
  // honest rather than claiming opens that can never be entered.
  if (config.engagement && event.mentionsBot && convo.addressed(key, event.authorId)) inc("convo.opened");
  let engaged = config.engagement && convo.isParticipant(key, event.authorId);
  // Engaged ≠ every message is at the bot: a message aimed at the room ("did
  // anyone see that"), replying to another human, or @-mentioning someone else
  // doesn't earn the in-conversation bonus — participation itself is untouched.
  if (engaged && !event.mentionsBot) {
    const botId = client.user!.id;
    if (roomAddressCue(event.content)
      || (message.mentions.repliedUser !== null && message.mentions.repliedUser.id !== botId)
      || message.mentions.users.some(u => u.id !== botId)) {
      engaged = false;
    }
  }
  // Dismissals are the deterministic override — they fire addressed ("shut up
  // asb") or mid-conversation ("shush") regardless of what the model thinks.
  // An unaddressed dismissal clears participation → silence, the clean
  // drop-out; an addressed one still gets its ack reply, then drops out.
  if ((event.mentionsBot || engaged) && detectDismissal(event.content)) {
    convo.leave(key, event.authorId);
    inc("convo.leave.dismissal");
    engaged = false;
  }
  const lastSpokeAt = convo.lastSpokeAt(key);
  const elapsedSinceLastSpoke = lastSpokeAt === undefined ? Infinity : Date.now() - lastSpokeAt;
  // The share-of-voice penalty exists to keep the bot off a shared floor —
  // it only applies when someone OUTSIDE the conversation spoke recently. A
  // 1:1 ping-pong is structurally ~50% bot forever; with no bystanders there
  // is no floor to dominate, so share is gated to zero.
  const share = convo.bystanderVoices(key) > 0 ? convo.botShare(key) : 0;
  const decision = brain.decide(event, elapsedSinceLastSpoke, engaged, share, config.speakThreshold);
  if (!settings.replyEnabled || !decision.shouldSpeak) {
    // The bot stayed silent on a question — arm the stranded-question timer.
    // A question it already answered never reaches here, so it can't be
    // answered twice. Everything re-checks at fire time; this is only the arm.
    if (settings.replyEnabled && !decision.shouldSpeak
      && config.proactiveEnabled && settings.proactiveEnabled
      && event.content.trimEnd().endsWith("?")) {
      proactive.arm(key, event.messageId);
    }
    return;
  }
  try {
    await message.channel.sendTyping();
    // Inject profile cards for the author, @-mentioned users, and name-referenced members.
    const lookups = await guildLookups(event.guildId);
    const peopleIds = new Set<string>([
      event.authorId,
      ...message.mentions.users.keys(),
      ...findMentionedUsers(event.content, lookups.map).slice(0, 3),
    ]);
    const profileRows = await profileStore.getProfiles(event.guildId, [...peopleIds]);
    // Structured attributes (active only — the same boundary /profile uses)
    // carry field labels + per-facet confidence, so the model can hedge weak
    // facets instead of stating every trait with equal confidence.
    const attrMap = await store.attributesForSubjects(event.guildId, profileRows.map(p => p.subjectId), { status: "active" });
    const profiles = profileRows.map(p => ({
      name: p.displayName, summary: p.summary, traits: p.facets.traits,
      attributes: (attrMap.get(p.subjectId) ?? []).map(a => ({ field: a.field, value: a.value, confidence: a.confidence })),
    }));
    // Pairwise relationship context — what the in-prompt people assert about
    // each other, distinct from either's standalone profile. All unordered
    // pairs among non-bot people, author-involved pairs first, capped so the
    // prompt stays bounded. Pairs with zero signal drop out entirely.
    const pairIds = [...peopleIds].filter(id => id !== client.user!.id);
    const pairList: Array<[string, string]> = [];
    for (let i = 0; i < pairIds.length; i++)
      for (let j = i + 1; j < pairIds.length; j++) pairList.push([pairIds[i], pairIds[j]]);
    pairList.sort((x, y) => Number(y.includes(event.authorId)) - Number(x.includes(event.authorId)));
    const relationships = (await Promise.all(pairList.slice(0, 6).map(([aId, bId]) =>
      buildPairContext(store, eventStore, event.guildId, aId, bId)
    ))).filter((x): x is PairContext => !!x);
    // Model-facing text carries names, never raw <@id> markup — real mention
    // tokens in stored content taught the model to greet users with fabricated
    // snowflakes ("Hey <@1549171765056638>!").
    const context = (await store.recentContext(event.guildId, event.channelId))
      .map(x => ({ ...x, content: demangleMentions(x.content, lookups.names), replyToSnippet: x.replyToSnippet ? demangleMentions(x.replyToSnippet, lookups.names) : undefined }));
    // Address the author by their freshest known name so a "call me X" learned
    // moments ago takes effect immediately, not after the next profile build.
    const authorName = await store.displayNameFor(event.guildId, event.authorId);
    const ownerName = message.guild.ownerId ? await store.displayNameFor(event.guildId, message.guild.ownerId) : undefined;
    // Images on this message — and on the message it replies to — are described
    // once and handed to the reply model as observed content. The replied-to
    // fetch is needed even when the row is archived: DB rows carry no
    // attachment data by design, and the live fetch returns fresh signed URLs.
    const imgParts: string[] = [];
    if (images.length) imgParts.push(formatImageContext(await getImageDescriptions(), authorName));
    if (replyToId) {
      const refMsg = await message.channel.messages.fetch(replyToId).catch(() => undefined);
      const refImages = refMsg ? qualifyingImages(refMsg.attachments.values(), config.imageMaxBytes, IMAGE_MAX_PER_MESSAGE) : [];
      if (refImages.length && refMsg)
        imgParts.push(formatImageContext(await describeImages(refImages), refMsg.member?.displayName ?? refMsg.author.username));
    }
    const imageContext = imgParts.filter(Boolean).join("\n") || undefined;
    // Lookup tools get the guild's handles + name resolution — the model can
    // fetch people/pairs/memories/events beyond the pre-fetched window above.
    const toolCtx: ToolCtx = {
      guildId: event.guildId, store, eventStore, profileStore,
      resolveName: n => lookups.map.get(n.trim().toLowerCase()),
    };
    // Direct mentions arm the full toolkit (they're nearly every reply at the
    // default threshold); engaged in-conversation messages get the same — an
    // in-thread "what do you know about X" deserves tools. Stray unsolicited
    // replies still need a toolCues signal.
    const toolsOn = config.replyTools && (toolCues(event.content) || event.mentionsBot || engaged);
    const { text, endConversation } = await brain.reply({ ...event, authorName }, context, await store.relevantMemories(event.guildId, event.authorId), profiles, relationships, config.replyModel, toolsOn, client.user!.id, { guildName: message.guild.name, ownerName, botName: message.guild.members.me?.displayName ?? client.user!.username }, toolCtx, imageContext);
    const clean = text ? scrubMentions(text, lookups.names) : "";
    // Hard send-boundary guard: model internals (schema fields, think blocks)
    // must never reach the channel no matter which reply path produced them.
    // Silence over leak — the parser's salvage ladder should catch these
    // first, so anything reaching here is a shape the ladder missed.
    if (clean && looksLikeSchemaLeak(clean)) { inc("reply.schema_leak"); return; }
    if (clean) {
      const sent = await message.reply({ content: clean, allowedMentions: { parse: [], repliedUser: false } });
      convo.noteReply(key); inc("reply.sent");
      if (engaged && !event.mentionsBot) inc("reply.engaged");
      // Archive the bot's own line so the transcript carries its voice and
      // member→bot reply edges resolve — otherwise reply_to_id dangles.
      await store.recordMessage({
        guildId: event.guildId, channelId: event.channelId, messageId: sent.id,
        authorId: client.user!.id, authorName: message.guild.members.me?.displayName ?? client.user!.username,
        content: clean, createdAt: sent.createdAt ?? new Date(), mentionsBot: false,
      }, event.messageId, false);
      // Same rule as inbound bot chatter: archive for transcript fidelity,
      // never a memory source — keep it out of the sweep's extraction set.
      await store.setTriageResults([{ id: sent.id, result: "noise" }]);
    }
    // The model's read that this human is done — thanks/bye/wrap-up, or the
    // exchange is clearly complete. Outside the `clean` block so an empty
    // sign-off still exits. REPLY_EXIT=0 disables this; regex dismissal is
    // unaffected either way.
    if (config.replyExit && endConversation && convo.leave(key, event.authorId)) {
      inc("convo.leave.model");
    }
  } catch (error) {
    if (error instanceof BudgetExceeded) {
      inc("budget.reply_blocked");
      if (budgetNoticeOnce(event.channelId)) {
        await message.reply({ content: "I've hit this server's daily LLM limit, so I can't respond right now — it resets at midnight UTC. An admin can raise it with `/limits`.", allowedMentions: { parse: [], repliedUser: false } }).catch(() => {});
      }
      return;
    }
    inc("llm.reply_error"); logError("Reply generation failed", error);
  }
}

// Graceful shutdown — close the Discord socket and the pg pool cleanly so
// container/systemd restarts don't sever in-flight work.
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    console.log(`Received ${sig}, shutting down`);
    await worker?.stop(); // finish in-flight jobs, claim nothing new
    client.destroy();
    await sql.end();
    process.exit(0);
  });
}

client.login(config.discordToken);
