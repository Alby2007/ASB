import { Client, Events, GatewayIntentBits, type Message, type OmitPartialGroupDMChannel } from "discord.js";
import { Brain } from "./brain.js";
import { config } from "./config.js";
import { sql } from "./db.js";
import { MemoryStore } from "./database.js";
import { commandDefinitions, handleMemoryButton, handleMemoryCommand } from "./commands.js";
import { detectNamingRequest, detectSelfNaming, shouldInspectForMemory, toolCues } from "./perception.js";
import { runContestCheck } from "./contest.js";
import { EventStore } from "./events.js";
import { EventPipeline } from "./event-detection.js";
import { ProfileStore } from "./profiles.js";
import { buildAliasMap, demangleMentions, findMentionedUsers, resolveSubject, scrubMentions, type AliasMap } from "./entity-resolution.js";
import { withRetry } from "./retry.js";
import { inc } from "./metrics.js";
import type { MessageEvent, PairContext } from "./types.js";

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
const brain = new Brain(config.groqKey, config.model, config.groqBaseUrl);
const pipeline = new EventPipeline();
const botActivity = new Map<string, number>();

// MemoryStore.create() runs migrations; EventStore shares the same sql connection.
let store: MemoryStore;
let eventStore: EventStore;
let profileStore: ProfileStore;

async function init() {
  store = await MemoryStore.create();
  eventStore = new EventStore();
  profileStore = new ProfileStore();
}

client.once(Events.ClientReady, async ready => {
  // init failure leaves a connected but braindead bot — exit so supervision
  // restarts it rather than letting it sit mute.
  try {
    await init();
  } catch (error) { console.error("Startup init failed", error); process.exit(1); }
  try {
    if (config.guildId) await ready.application.commands.set(commandDefinitions, config.guildId);
    else await ready.application.commands.set(commandDefinitions);
  } catch (error) { inc("init.commands_error"); console.error("Command registration failed", error); }
  // Fire-and-forget: both loops must never reject into the event loop — on
  // Node >=15 an unhandled rejection here is fatal to the process.
  applyRetention().catch(error => { inc("maintenance.error"); console.error("Retention run failed", error); });
  sweepMissedSignals(24 * 60 * 60_000).catch(error => { inc("sweep.error"); console.error("Boot sweep failed", error); }); // wide window on boot to cover downtime
  console.log(`ASM online as ${ready.user.tag}`);
});

async function applyRetention() {
  for (const guild of client.guilds.cache.values()) {
    // These three calls sit outside the feature-level try/catches below — a DB
    // blip here must skip the guild, not reject the whole interval callback.
    try {
      const settings = await store.settings(guild.id, config.rawMessageRetentionDays);
      const deleted = await store.deleteRawMessagesOlderThan(guild.id, settings.rawRetentionDays);
      await store.maintain(guild.id, config.candidateConfidenceThreshold);
      if (deleted) console.log(`Retention deleted ${deleted} raw messages in ${guild.name}`);
    } catch (error) { inc("maintenance.retention_error"); console.error(`Retention/maintenance failed in ${guild.name}`, error); continue; }
    try {
      const pruned = await store.pruneDerivedData(guild.id);
      if (pruned.history + pruned.names + pruned.aliases + pruned.events) {
        console.log(`Pruned derived data in ${guild.name}: ${pruned.history} history, ${pruned.names} unresolved names, ${pruned.aliases} alias candidates, ${pruned.events} events`);
      }
    } catch (error) { inc("maintenance.prune_error"); console.error("Derived-data pruning failed", error); }
    // v0.2: close stale open event windows and score candidate events
    try {
      const result = await pipeline.maintainEvents(guild.id, eventStore, store, brain);
      if (result.closed || result.promoted || result.discarded) {
        console.log(`Events maintained in ${guild.name}: closed=${result.closed} promoted=${result.promoted} discarded=${result.discarded}`);
      }
    } catch (error) { console.error("Event maintenance failed", error); }
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
    } catch (error) { console.error("Verification failed", error); }
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
    } catch (error) { console.error("Relationship verification failed", error); }
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
    } catch (error) { console.error("Dedup pass failed", error); inc("dedup.errors"); }
    // v0.3: rebuild per-chatter profile cards + dossiers (LLM calls only when inputs changed)
    try {
      const profiles = await profileStore.buildProfiles(guild.id, brain, store, eventStore, config.profileModel, { excludeIds: [client.user!.id] });
      if (profiles.built) console.log(`Profiles in ${guild.name}: ${profiles.built} rebuilt, ${profiles.unchanged} unchanged of ${profiles.considered}`);
    } catch (error) { console.error("Profile build failed", error); }
  }
}
// Belt-and-braces: every guild body is try/caught, but an interval callback
// rejection would still be an unhandled (fatal) rejection.
setInterval(() => applyRetention().catch(error => { inc("maintenance.error"); console.error("Retention run failed", error); }), 24 * 60 * 60 * 1000).unref();

const SWEEP_INTERVAL_MS = 15 * 60_000;
const SWEEP_WINDOW_MS = 2 * 60 * 60_000;
const SWEEP_TRIAGE_BATCH = 10;
const SWEEP_EXTRACT_BATCH = 5;

setInterval(() => sweepMissedSignals(SWEEP_WINDOW_MS), SWEEP_INTERVAL_MS).unref();

// Live traffic that fails the durableSignals regex is never inspected inline —
// this sweep gives it the same LLM triage ingest already uses, so durable
// preferences in unpatterned phrasing ("can you just call me Alby from now on",
// said to nobody in particular) still land within ~15 minutes. Marks persist on
// messages.triage_result, so each message is classified once; a durable or
// regex verdict with no evidence is re-extracted on the next pass (crash-safe),
// and 'extracted' marks the terminal state so empty results don't re-extract
// forever.
async function sweepMissedSignals(windowMs: number) {
  for (const guild of client.guilds.cache.values()) {
    try {
      const settings = await store.settings(guild.id, config.rawMessageRetentionDays);
      if (!settings.memoryEnabled) continue;
      const pending = await store.listUninspectedMessages(guild.id, new Date(Date.now() - windowMs), client.user!.id);
      if (!pending.length) continue;
      const toEvent = (m: (typeof pending)[number]): MessageEvent => ({
        guildId: guild.id, channelId: m.channelId, messageId: m.id,
        authorId: m.authorId, authorName: m.authorName, content: m.content,
        createdAt: new Date(m.createdAt),
        mentionsBot: m.content.includes(`<@${client.user!.id}>`) || m.content.includes(`<@!${client.user!.id}>`),
      });
      const marks: Array<{ id: string; result: string }> = [];
      const queue: Array<{ event: MessageEvent; replyToId?: string; replyToContent?: string; note?: string }> = [];
      const triageQueue: typeof pending = [];
      for (const m of pending) {
        const event = toEvent(m);
        if (m.triageResult === "durable" || m.triageResult === "regex") {
          queue.push({ event, replyToId: m.replyToId ?? undefined }); // marked earlier but never extracted
        } else if (shouldInspectForMemory(event)) {
          marks.push({ id: m.id, result: "regex" });
          queue.push({ event, replyToId: m.replyToId ?? undefined });
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
            if (durable) queue.push({ event: toEvent(item), replyToId: item.replyToId ?? undefined });
          }
        } catch { /* batch stays unmarked — next sweep retries it */ }
      }
      // Persist marks before extraction: durable marks survive a crash and are
      // picked back up on the next pass via the no-evidence filter.
      await store.setTriageResults(marks);
      if (!queue.length) continue;
      const members = await store.listMembers(guild.id);
      const optedOut = new Set(members.filter(m => m.optedOut).map(m => m.userId));
      const memberNames = new Map(members.map(m => [m.userId, m.knownNames]));
      const aliases = await buildAliasMap(guild.id, store);
      for (let i = 0; i < queue.length; i += SWEEP_EXTRACT_BATCH) {
        const batch = queue.slice(i, i + SWEEP_EXTRACT_BATCH);
        for (const item of batch) {
          if (item.replyToId) {
            const ref = await store.getMessage(item.replyToId);
            if (ref) item.replyToContent = `${ref.authorName}: ${ref.content}`;
          }
          // Alias learning must not be live-path-only: naming requests archived
          // while the bot was down (or on an older build) reach the sweep only
          // through this queue. Mirror the live order — explicit request first.
          const authorNames = memberNames.get(item.event.authorId) ?? [item.event.authorName];
          const requested = detectNamingRequest(item.event.content, authorNames);
          const named = requested ?? detectSelfNaming(item.event.content, authorNames);
          if (named) {
            await store.learnAlias(guild.id, item.event.authorId, named, requested ? "naming_request" : "self_naming", item.event.messageId);
            memberNames.set(item.event.authorId, [...authorNames, named]);
            aliases.set(named.toLowerCase(), item.event.authorId);
            item.note = requested
              ? `the author asked to be called "${requested}" — treat it as their preferred name`
              : `the author may be naming themselves "${named}" (a previously unknown alias) or quoting/describing "${named}" — attribute accordingly`;
          }
        }
        try {
          const results = await withRetry(() => brain.extractMemoriesBatch(batch, config.ingestModel ?? config.model), 3);
          for (const item of batch) {
            const result = results.get(item.event.messageId) ?? { memories: [], relationships: [] };
            for (const memory of result.memories) {
              memory.subjectId = resolveSubject(memory, aliases, item.event);
              if (optedOut.has(memory.subjectId)) continue;
              if (memory.subjectId === "unknown" && memory.subjectName) {
                await store.logUnresolvedName(guild.id, memory.subjectName, item.event.messageId);
              }
              await store.saveMemory(item.event, memory, config.candidateConfidenceThreshold);
            }
            for (const rel of result.relationships) {
              const subjectId = rel.subjectName ? resolveSubject({ subjectName: rel.subjectName }, aliases, item.event) : item.event.authorId;
              const otherId = resolveSubject({ subjectName: rel.otherName }, aliases, item.event);
              if (optedOut.has(subjectId) || optedOut.has(otherId)) continue;
              if (subjectId === "unknown" && rel.subjectName) await store.logUnresolvedName(guild.id, rel.subjectName, item.event.messageId);
              if (otherId === "unknown" && rel.otherName) await store.logUnresolvedName(guild.id, rel.otherName, item.event.messageId);
              if (subjectId === "unknown" || otherId === "unknown") continue;
              await store.recordRelationship(guild.id, subjectId, otherId, item.event.messageId, rel.nature, rel.valence, rel.reason ?? "");
            }
          }
          // Terminal mark: the batch returned and every item was processed, so
          // these messages never qualify for re-extraction — even the ones that
          // legitimately yielded nothing. A throw anywhere above leaves them
          // 'durable'/'regex', which the no-evidence filter retries next pass.
          await store.setTriageResults(batch.map(item => ({ id: item.event.messageId, result: "extracted" })));
        } catch (error) { inc("sweep.extract_error"); console.error("Sweep extraction failed", error); }
      }
      inc("sweep.runs");
    } catch (error) { inc("sweep.error"); console.error(`Missed-signal sweep failed in ${guild.name}`, error); }
  }
}

client.on(Events.InteractionCreate, async interaction => {
  try {
    if (interaction.isChatInputCommand()) await handleMemoryCommand(interaction, store, brain, eventStore, profileStore);
    if (interaction.isButton()) await handleMemoryButton(interaction, store);
  } catch (error) {
    inc("handler.interaction_error");
    console.error("Interaction handling failed", error);
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
  handleMessage(message).catch(error => { inc("handler.message_error"); console.error("Message handling failed", error); });
});

// Edits update the archive row; the extraction-time snapshot in memory_evidence
// is deliberately left alone — it's the record of what was observed, not a
// mirror of current content.
client.on(Events.MessageUpdate, (_old, message) => {
  if (!store) return; // before init() completes — a sync TypeError would escape .catch
  if (!message.guild || message.author?.bot || !message.content?.trim()) return;
  if (config.guildId && message.guild.id !== config.guildId) return;
  store.updateMessageContent(message.guild.id, message.id, message.content)
    .catch(error => { inc("handler.message_error"); console.error("Message update handling failed", error); });
});

// Deletes remove the raw row (so the sweep never extracts deleted content)
// and scrub the verbatim text on any evidence it already produced.
client.on(Events.MessageDelete, message => {
  if (!store) return;
  if (!message.guild) return;
  if (config.guildId && message.guild.id !== config.guildId) return;
  store.deleteMessage(message.guild.id, message.id)
    .catch(error => { inc("handler.message_error"); console.error("Message delete handling failed", error); });
});

// Alias maps are shared per guild rather than built per message — the same map
// object also feeds the compiled-regex cache in entity-resolution, so caching it
// means the alternation pattern compiles once per rebuild, not per message.
// learnAlias invalidates immediately; display-name drift via upsertMember is
// bounded by the TTL. The same cache carries an id→display-name map used to
// demangle <@id> tokens before they reach the LLM.
const lookupCache = new Map<string, { map: AliasMap; names: Map<string, string>; at: number }>();
const LOOKUP_TTL_MS = 5 * 60_000;

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

async function handleMessage(message: OmitPartialGroupDMChannel<Message>) {
  if (!message.guild || message.author.bot || !message.content.trim()) return;
  if (config.guildId && message.guild.id !== config.guildId) return;
  const event: MessageEvent = {
    guildId: message.guild.id, channelId: message.channel.id, messageId: message.id,
    authorId: message.author.id, authorName: message.member?.displayName ?? message.author.username,
    content: message.content, createdAt: message.createdAt,
    mentionsBot: message.mentions.has(client.user!) || message.mentions.repliedUser?.id === client.user!.id,
  };
  const settings = await store.settings(event.guildId, config.rawMessageRetentionDays);
  // "Pause observing" must actually stop observing — a paused guild gets no
  // raw archive rows or member-registry writes, not just no extraction. The
  // sweep skips paused guilds anyway, so archive-during-pause rows would be
  // orphaned the moment they're written.
  if (!settings.memoryEnabled && !settings.replyEnabled) return;
  // Resolve the reply target first so it can be persisted with the raw message.
  const replyToId = message.reference?.messageId ?? undefined;
  if (settings.memoryEnabled) await store.recordMessage(event, replyToId);
  const savedMemoryIds: number[] = [];
  let replyToContent: string | undefined;
  if (replyToId) {
    const ref = await store.getMessage(replyToId);
    if (ref) replyToContent = `${ref.authorName}: ${ref.content}`;
  }
  // The alias map is built lazily on first use so ordinary chatter costs no extra queries.
  let aliasMap: Promise<AliasMap> | undefined;
  const getAliasMap = () => (aliasMap ??= guildLookups(event.guildId).then(e => e.map));
  if (settings.memoryEnabled && shouldInspectForMemory(event)) {
    try {
      // Naming signals: "call me Alby" is an explicit request (strong);
      // "I am Sage" from a non-matching name is a pasted/quoted-bio tell (weak).
      const member = await store.getMember(event.guildId, event.authorId);
      const authorNames = member?.knownNames ?? [event.authorName];
      const requested = detectNamingRequest(event.content, authorNames);
      const named = requested ?? detectSelfNaming(event.content, authorNames);
      // An unknown self-name is the bot's alias-learning signal: "I am Sage"
      // posted by tinyriot teaches sage → tinyriot.
      if (named) {
        await store.learnAlias(event.guildId, event.authorId, named, requested ? "naming_request" : "self_naming", event.messageId);
        lookupCache.delete(event.guildId); // so this message resolves the new alias
      }
      const note = requested
        ? `the author asked to be called "${requested}" — treat it as their preferred name`
        : named ? `the author may be naming themselves "${named}" (a previously unknown alias) or quoting/describing "${named}" — attribute accordingly` : undefined;
      const { memories: candidates, relationships } = await withRetry(() => brain.extractMemories(event, replyToContent, note), 3);
      const aliases = (candidates.length || relationships.length) ? await getAliasMap() : new Map<string, string>();
      // Opted-out members accrue no new derived data: memories or relationship
      // observations about them are skipped (raw archive is unaffected — that's
      // covered by message retention, not opt-out).
      const optOutCache = new Map<string, boolean>();
      const isOptedOut = async (userId: string) => {
        if (userId === "unknown" || userId === "server") return false;
        const cached = optOutCache.get(userId);
        if (cached !== undefined) return cached;
        const opted = (await store.getMember(event.guildId, userId))?.optedOut ?? false;
        optOutCache.set(userId, opted);
        return opted;
      };
      for (const memory of candidates) {
        memory.subjectId = resolveSubject(memory, aliases, event);
        if (await isOptedOut(memory.subjectId)) continue;
        if (memory.subjectId === "unknown" && memory.subjectName) {
          await store.logUnresolvedName(event.guildId, memory.subjectName, event.messageId);
        }
        const saved = await store.saveMemory(event, memory, config.candidateConfidenceThreshold);
        savedMemoryIds.push(saved.id);
        inc("memory.saved");
      }
      for (const rel of relationships) {
        const subjectId = rel.subjectName ? resolveSubject({ subjectName: rel.subjectName }, aliases, event) : event.authorId;
        const otherId = resolveSubject({ subjectName: rel.otherName }, aliases, event);
        if (await isOptedOut(subjectId) || await isOptedOut(otherId)) continue;
        if (subjectId === "unknown" && rel.subjectName) await store.logUnresolvedName(event.guildId, rel.subjectName, event.messageId);
        if (otherId === "unknown" && rel.otherName) await store.logUnresolvedName(event.guildId, rel.otherName, event.messageId);
        // Edges to "unknown" would smear whoever later claims that slot — the
        // name is already logged for resolution, so just don't record the edge.
        if (subjectId === "unknown" || otherId === "unknown") continue;
        await store.recordRelationship(event.guildId, subjectId, otherId, event.messageId, rel.nature, rel.valence, rel.reason ?? "");
      }
      // Terminal mark: extraction ran to completion, even if it yielded
      // nothing — without this a zero-yield regex message gets one redundant
      // sweep pass before ingest-side marking would catch it.
      await store.setTriageResults([{ id: event.messageId, result: "extracted" }]);
    } catch (error) { inc("llm.extract_error"); console.error("Memory extraction failed", error); }
  }
  // Contest detection: bot-addressed denials/corrections update the memories they target
  if (settings.memoryEnabled) {
    try {
      await runContestCheck(event, brain, store, client.user!.id, config.contestModel ?? config.model);
    } catch (error) { inc("contest.error"); console.error("Contest check failed", error); }
  }
  // v0.2: event detection pipeline (runs regardless of whether memories were extracted,
  // so back-references and reply chains are tracked even for ordinary messages)
  if (settings.memoryEnabled) {
    try {
      await pipeline.process(event, savedMemoryIds, eventStore, store, brain, replyToId);
    } catch (error) { inc("pipeline.error"); console.error("Event pipeline failed", error); }
  }

  const key = `${event.guildId}:${event.channelId}`;
  const lastSpoke = botActivity.get(key) ?? 0;
  const recentBotMessages = Date.now() - lastSpoke < 120_000 ? 1 : 0;
  const decision = brain.decide(event, recentBotMessages, config.speakThreshold);
  if (!settings.replyEnabled || !decision.shouldSpeak) return;
  try {
    await message.channel.sendTyping();
    // Inject profile cards for the author, @-mentioned users, and name-referenced members.
    const lookups = await guildLookups(event.guildId);
    const peopleIds = new Set<string>([
      event.authorId,
      ...message.mentions.users.keys(),
      ...findMentionedUsers(event.content, lookups.map).slice(0, 3),
    ]);
    const profiles = (await profileStore.getProfiles(event.guildId, [...peopleIds]))
      .map(p => ({ name: p.displayName, summary: p.summary, traits: p.facets.traits }));
    // Pairwise relationship context — what the in-prompt people assert about
    // each other, distinct from either's standalone profile. All unordered
    // pairs among non-bot people, author-involved pairs first, capped so the
    // prompt stays bounded. Pairs with zero signal drop out entirely.
    const pairIds = [...peopleIds].filter(id => id !== client.user!.id);
    const pairList: Array<[string, string]> = [];
    for (let i = 0; i < pairIds.length; i++)
      for (let j = i + 1; j < pairIds.length; j++) pairList.push([pairIds[i], pairIds[j]]);
    pairList.sort((x, y) => Number(y.includes(event.authorId)) - Number(x.includes(event.authorId)));
    const monthYear = (iso: string) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-US", { month: "short", year: "numeric" }); };
    const relationships = (await Promise.all(pairList.slice(0, 6).map(async ([aId, bId]): Promise<PairContext | undefined> => {
      const [pc, events] = await Promise.all([
        store.pairwiseContext(event.guildId, aId, bId),
        eventStore.sharedEvents(event.guildId, aId, bId, 3),
      ]);
      if (!pc.ab && !pc.ba && !pc.observations.length && !pc.claimsAboutA.length && !pc.claimsAboutB.length && !events.length) return undefined;
      const [aName, bName] = await Promise.all([
        store.displayNameFor(event.guildId, aId), store.displayNameFor(event.guildId, bId),
      ]);
      return {
        aName, bName,
        aToB: pc.ab ? { summary: pc.ab.summary, valence: pc.ab.valence, observationCount: pc.ab.observationCount } : undefined,
        bToA: pc.ba ? { summary: pc.ba.summary, valence: pc.ba.valence, observationCount: pc.ba.observationCount } : undefined,
        reasons: pc.observations.map(o => ({ fromName: o.fromId === aId ? aName : bName, reason: o.reason, at: o.createdAt })),
        claimsAboutA: pc.claimsAboutA,
        claimsAboutB: pc.claimsAboutB,
        sharedEvents: events.map(e => `${e.title} (${monthYear(e.occurredAt)})`),
      };
    }))).filter((x): x is PairContext => !!x);
    // Model-facing text carries names, never raw <@id> markup — real mention
    // tokens in stored content taught the model to greet users with fabricated
    // snowflakes ("Hey <@1549171765056638>!").
    const context = (await store.recentContext(event.guildId, event.channelId))
      .map(x => ({ ...x, content: demangleMentions(x.content, lookups.names), replyToSnippet: x.replyToSnippet ? demangleMentions(x.replyToSnippet, lookups.names) : undefined }));
    // Address the author by their freshest known name so a "call me X" learned
    // moments ago takes effect immediately, not after the next profile build.
    const authorName = await store.displayNameFor(event.guildId, event.authorId);
    const ownerName = message.guild.ownerId ? await store.displayNameFor(event.guildId, message.guild.ownerId) : undefined;
    const reply = await brain.reply({ ...event, authorName }, context, await store.relevantMemories(event.guildId, event.authorId), profiles, relationships, config.replyModel, config.replyTools && toolCues(event.content), client.user!.id, { guildName: message.guild.name, ownerName });
    const clean = reply ? scrubMentions(reply, lookups.names) : "";
    if (clean) {
      const sent = await message.reply({ content: clean, allowedMentions: { repliedUser: false } });
      botActivity.set(key, Date.now()); inc("reply.sent");
      // Archive the bot's own line so the transcript carries its voice and
      // member→bot reply edges resolve — otherwise reply_to_id dangles.
      await store.recordMessage({
        guildId: event.guildId, channelId: event.channelId, messageId: sent.id,
        authorId: client.user!.id, authorName: message.guild.members.me?.displayName ?? client.user!.username,
        content: clean, createdAt: sent.createdAt ?? new Date(), mentionsBot: false,
      }, event.messageId);
    }
  } catch (error) { inc("llm.reply_error"); console.error("Reply generation failed", error); }
}

// Graceful shutdown — close the Discord socket and the pg pool cleanly so
// container/systemd restarts don't sever in-flight work.
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    console.log(`Received ${sig}, shutting down`);
    client.destroy();
    await sql.end();
    process.exit(0);
  });
}

client.login(config.discordToken);
