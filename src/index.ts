import { Client, Events, GatewayIntentBits, type Message, type OmitPartialGroupDMChannel } from "discord.js";
import { Brain } from "./brain.js";
import { config } from "./config.js";
import { MemoryStore } from "./database.js";
import { commandDefinitions, handleMemoryButton, handleMemoryCommand } from "./commands.js";
import { detectSelfNaming, shouldInspectForMemory, toolCues } from "./perception.js";
import { runContestCheck } from "./contest.js";
import { EventStore } from "./events.js";
import { EventPipeline } from "./event-detection.js";
import { ProfileStore } from "./profiles.js";
import { buildAliasMap, findMentionedUsers, resolveSubject, type AliasMap } from "./entity-resolution.js";
import { withRetry } from "./retry.js";
import { inc } from "./metrics.js";
import type { MessageEvent } from "./types.js";

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
  await init();
  if (config.guildId) await ready.application.commands.set(commandDefinitions, config.guildId);
  else await ready.application.commands.set(commandDefinitions);
  applyRetention();
  console.log(`ASM online as ${ready.user.tag}`);
});

async function applyRetention() {
  for (const guild of client.guilds.cache.values()) {
    const settings = await store.settings(guild.id, config.rawMessageRetentionDays);
    const deleted = await store.deleteRawMessagesOlderThan(guild.id, settings.rawRetentionDays);
    await store.maintain(guild.id, config.candidateConfidenceThreshold);
    if (deleted) console.log(`Retention deleted ${deleted} raw messages in ${guild.name}`);
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
          process.env.VERIFY_MODEL ?? process.env.PROFILE_MODEL ?? config.model
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
    // Verify unverified relationship observations — joke assertions are excluded
    // from the durable edge roll-up. Bounded per run; recompute only when needed.
    try {
      const unverified = await store.listUnverifiedObservations(guild.id, 50);
      if (unverified.length) {
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
            process.env.VERIFY_MODEL ?? process.env.PROFILE_MODEL ?? config.model
          );
          for (const b of batch) {
            const v = verdicts.get(b.observationId);
            if (v) { await store.setObservationVerdict(b.observationId, v.verdict); judged++; }
          }
        }
        const edgeCount = await store.recomputeEdges(guild.id);
        console.log(`Verified ${judged} relationship observations in ${guild.name}; recomputed ${edgeCount} edges`);
      }
    } catch (error) { console.error("Relationship verification failed", error); }
    // v0.3: rebuild per-chatter profile cards + dossiers (LLM calls only when inputs changed)
    try {
      const profiles = await profileStore.buildProfiles(guild.id, brain, store, eventStore, process.env.PROFILE_MODEL);
      if (profiles.built) console.log(`Profiles in ${guild.name}: ${profiles.built} rebuilt, ${profiles.unchanged} unchanged of ${profiles.considered}`);
    } catch (error) { console.error("Profile build failed", error); }
  }
}
setInterval(applyRetention, 24 * 60 * 60 * 1000).unref();

client.on(Events.InteractionCreate, async interaction => {
  try {
    if (interaction.isChatInputCommand()) await handleMemoryCommand(interaction, store, brain, eventStore);
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

// Alias maps are shared per guild rather than built per message — the same map
// object also feeds the compiled-regex cache in entity-resolution, so caching it
// means the alternation pattern compiles once per rebuild, not per message.
// learnAlias invalidates immediately; display-name drift via upsertMember is
// bounded by the TTL.
const aliasMapCache = new Map<string, { map: AliasMap; at: number }>();
const ALIAS_MAP_TTL_MS = 5 * 60_000;

async function guildAliasMap(guildId: string): Promise<AliasMap> {
  const cached = aliasMapCache.get(guildId);
  if (cached && Date.now() - cached.at < ALIAS_MAP_TTL_MS) return cached.map;
  const map = await buildAliasMap(guildId, store);
  aliasMapCache.set(guildId, { map, at: Date.now() });
  return map;
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
  // Resolve the reply target first so it can be persisted with the raw message.
  const replyToId = message.reference?.messageId ?? undefined;
  await store.recordMessage(event, replyToId);
  const savedMemoryIds: number[] = [];
  let replyToContent: string | undefined;
  if (replyToId) {
    const ref = await store.getMessage(replyToId);
    if (ref) replyToContent = `${ref.authorName}: ${ref.content}`;
  }
  // The alias map is built lazily on first use so ordinary chatter costs no extra queries.
  let aliasMap: Promise<AliasMap> | undefined;
  const getAliasMap = () => (aliasMap ??= guildAliasMap(event.guildId));
  if (settings.memoryEnabled && shouldInspectForMemory(event)) {
    try {
      // Flag pasted/echoed self-naming ("I am Sage, a dragon lover…") so the
      // extractor attributes the text to the named person, not the poster.
      const member = await store.getMember(event.guildId, event.authorId);
      const named = detectSelfNaming(event.content, member?.knownNames ?? [event.authorName]);
      // Self-naming with an unknown name is the bot's alias-learning signal:
      // "I am Sage" posted by tinyriot teaches sage → tinyriot.
      if (named) {
        await store.learnAlias(event.guildId, event.authorId, named, "self_naming", event.messageId);
        aliasMapCache.delete(event.guildId); // so this message resolves the new alias
      }
      const note = named ? `the author may be naming themselves "${named}" (a previously unknown alias) or quoting/describing "${named}" — attribute accordingly` : undefined;
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
    } catch (error) { inc("llm.extract_error"); console.error("Memory extraction failed", error); }
  }
  // Contest detection: bot-addressed denials/corrections update the memories they target
  if (settings.memoryEnabled) {
    try {
      await runContestCheck(event, brain, store, client.user!.id, process.env.CONTEST_MODEL ?? process.env.VERIFY_MODEL ?? process.env.INGEST_MODEL ?? config.model);
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
  const decision = brain.decide(event, recentBotMessages);
  if (!settings.replyEnabled || !decision.shouldSpeak || decision.score < config.speakThreshold) return;
  try {
    await message.channel.sendTyping();
    // Inject profile cards for the author, @-mentioned users, and name-referenced members.
    const aliases = await getAliasMap();
    const peopleIds = new Set<string>([
      event.authorId,
      ...message.mentions.users.keys(),
      ...findMentionedUsers(event.content, aliases).slice(0, 3),
    ]);
    const profiles = (await profileStore.getProfiles(event.guildId, [...peopleIds]))
      .map(p => ({ name: p.displayName, summary: p.summary, traits: p.facets.traits }));
    const reply = await brain.reply(event, await store.recentContext(event.guildId, event.channelId), await store.relevantMemories(event.guildId, event.authorId), profiles, process.env.REPLY_MODEL, process.env.REPLY_TOOLS === "1" && toolCues(event.content));
    if (reply) { await message.reply({ content: reply, allowedMentions: { repliedUser: false } }); botActivity.set(key, Date.now()); inc("reply.sent"); }
  } catch (error) { inc("llm.reply_error"); console.error("Reply generation failed", error); }
}

client.login(config.discordToken);
