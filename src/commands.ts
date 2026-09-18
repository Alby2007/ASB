import { ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonInteraction, ButtonStyle, ChatInputCommandInteraction, EmbedBuilder, PermissionFlagsBits } from "discord.js";
import type { Brain } from "./brain.js";
import type { Memory, MemoryStore } from "./database.js";
import type { EventStore } from "./events.js";
import { ProfileStore } from "./profiles.js";
import { metricsSnapshot } from "./metrics.js";
import type { MessageEvent } from "./types.js";

export const commandDefinitions = [
  { name: "memory", description: "View remembered information", options: [
    { name: "about", description: "Member to inspect", type: 6, required: false }, { name: "search", description: "Search your memories", type: 3, required: false },
    { name: "page", description: "Page number", type: 4, required: false }, { name: "server", description: "Show server lore", type: 5, required: false },
    { name: "stats", description: "Show server memory statistics", type: 5, required: false }, { name: "memory_id", description: "Show provenance for a memory", type: 4, required: false },
    { name: "candidates", description: "Show unconfirmed candidate memories", type: 5, required: false }
  ] },
  { name: "forget", description: "Request deletion of one of your memories", options: [{ name: "memory_id", description: "The memory number", type: 4, required: true }] },
  { name: "correct", description: "Correct or update something remembered about you", options: [{ name: "statement", description: "For example: I don't support Arsenal anymore", type: 3, required: true }] },
  { name: "memory-confirm", description: "Confirm one of your candidate memories", options: [{ name: "memory_id", description: "The candidate memory number", type: 4, required: true }] },
  { name: "memory-export", description: "Download all memory stored about you" },
  { name: "memory-purge", description: "Admin: delete old raw messages for this server", default_member_permissions: PermissionFlagsBits.ManageGuild.toString(), options: [{ name: "older_than_days", description: "Delete messages older than this many days", type: 4, required: true }] },
  { name: "memory-pause", description: "Admin: immediately pause observing and replying", default_member_permissions: PermissionFlagsBits.ManageGuild.toString() },
  { name: "memory-resume", description: "Admin: resume observing and replying", default_member_permissions: PermissionFlagsBits.ManageGuild.toString() },
  { name: "memory-settings", description: "Admin: view memory and retention settings", default_member_permissions: PermissionFlagsBits.ManageGuild.toString() },
  { name: "status", description: "Admin: bot uptime and operational counters", default_member_permissions: PermissionFlagsBits.ManageGuild.toString() },
  { name: "memory-triage", description: "Admin: the most recent memories stored for any member", default_member_permissions: PermissionFlagsBits.ManageGuild.toString() },
  { name: "event", description: "Inspect the event linked to one of your memories", options: [
    { name: "memory_id", description: "A memory number returned by /memory", type: 4, required: true }
  ] },
  { name: "profile", description: "View a member's synthesized profile card", options: [
    { name: "user", description: "Member to inspect (admins can view anyone)", type: 6, required: false }
  ] },
  { name: "dossier", description: "View a member's detailed profile dossier", options: [
    { name: "user", description: "Member to inspect (admins can view anyone)", type: 6, required: false }
  ] },
  { name: "opt-out", description: "Stop the bot forming memories or a profile about you, and forget what it already holds" },
  { name: "opt-in", description: "Re-enable memory and profile building about you" }
];

const confidence = (value: number | undefined) => {
  if (value === undefined) return "Unknown";
  return value >= .8 ? "High" : value >= .55 ? "Medium" : "Low";
};
const display = (memory: Memory) => `**#${memory.id} · ${confidence(memory.confidence)} confidence**\n${memory.content}\n*${memory.mentions} confirmation${memory.mentions === 1 ? "" : "s"}; last confirmed ${new Date(memory.lastConfirmedAt).toLocaleDateString()}*`;

export async function handleMemoryCommand(interaction: ChatInputCommandInteraction, store: MemoryStore, brain: Brain, evStore?: EventStore, profileStore: ProfileStore = new ProfileStore()) {
  if (!interaction.guildId) return;
  const guildId = interaction.guildId;
  if (interaction.commandName === "memory") {
    const server = interaction.options.getBoolean("server") ?? false;
    const stats = interaction.options.getBoolean("stats") ?? false;
    if (stats) {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return interaction.reply({ content: "Only server administrators can view memory statistics.", ephemeral: true });
      const value = await store.stats(guildId); return interaction.reply({ ephemeral: true, embeds: [new EmbedBuilder().setTitle("Memory statistics").setDescription(`${value.messages.toLocaleString()} raw messages\n${value.memories.toLocaleString()} active memories\n${value.lore.toLocaleString()} server-lore memories`)] });
    }
    const detailId = interaction.options.getInteger("memory_id");
    if (detailId) {
      const memory = await store.getMemory(guildId, detailId);
      const canInspect = memory && (memory.subjectId === interaction.user.id || interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild));
      if (!canInspect || !memory) return interaction.reply({ content: "I couldn't find a memory you are allowed to inspect with that ID.", ephemeral: true });
      const evidence = (await store.evidence(guildId, memory.id)).slice(0, 5);
      const evidenceText = evidence.length ? evidence.map(item => `• "${item.quote.slice(0, 220)}"\n  *Why:* ${item.reason} · ${new Date(item.observedAt).toLocaleDateString()}`).join("\n") : "No evidence has been retained.";
      return interaction.reply({ ephemeral: true, embeds: [new EmbedBuilder().setTitle(`Memory #${memory.id}`).setDescription(`**${memory.content}**\n\nStatus: ${memory.status}\nConfidence: ${confidence(memory.confidence)} (${(memory.confidence ?? 0).toFixed(2)})\nImportance: ${(memory.importance ?? 0).toFixed(2)}\nFirst observed: ${new Date(memory.createdAt).toLocaleDateString()}\nLast confirmed: ${new Date(memory.lastConfirmedAt).toLocaleDateString()}\nConfirmations: ${memory.mentions}\n\n**Evidence**\n${evidenceText}`)] });
    }
    const member = interaction.options.getUser("about");
    if (member && member.id !== interaction.user.id && !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return interaction.reply({ content: "You can only view your own memories.", ephemeral: true });
    const subjectId = server ? "server" : (member?.id ?? interaction.user.id);
    const candidates = interaction.options.getBoolean("candidates") ?? false;
    const result = await store.listMemories(guildId, subjectId, { search: interaction.options.getString("search") ?? undefined, page: interaction.options.getInteger("page") ?? 1, status: candidates ? "candidate" : undefined });
    const title = candidates ? "Candidate memories awaiting confirmation" : (server ? "What I remember about this server" : `What I remember about ${member?.username ?? interaction.user.username}`);
    const description = result.memories.length ? result.memories.map(display).join("\n\n") : "Nothing active yet.";
    return interaction.reply({ ephemeral: true, embeds: [new EmbedBuilder().setTitle(`🧠 ${title}`).setDescription(description).setFooter({ text: `Page ${result.page} · ${result.total} ${candidates ? "candidate" : "active"} memories` })] });
  }
  if (interaction.commandName === "forget") {
    const id = interaction.options.getInteger("memory_id", true), memory = await store.getMemory(guildId, id);
    if (!memory || memory.subjectId !== interaction.user.id) return interaction.reply({ content: "I couldn't find one of your memories with that ID.", ephemeral: true });
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`forget:${guildId}:${interaction.user.id}:${id}`).setLabel("Forget it").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("forget:cancel").setLabel("Cancel").setStyle(ButtonStyle.Secondary)
    );
    return interaction.reply({ content: `Forget **#${id}**: "${memory.content}"? This removes the curated memory, but not its raw source message.`, components: [row], ephemeral: true });
  }
  if (interaction.commandName === "correct") {
    await interaction.deferReply({ ephemeral: true });
    try {
      const existing = await store.allActiveMemories(guildId, interaction.user.id);
      const correction = await brain.correctMemory(interaction.user.id, interaction.options.getString("statement", true), existing);
      correction.replacement.subjectId = interaction.user.id;
      correction.replacement.evidenceType = "correction";
      correction.replacement.effect = "correct";
      const event: MessageEvent = { guildId, channelId: interaction.channelId, messageId: `correction:${interaction.id}`, authorId: interaction.user.id, authorName: interaction.user.username, content: interaction.options.getString("statement", true), createdAt: new Date(), mentionsBot: false };
      const saved = await store.saveMemory(event, correction.replacement);
      await Promise.all(correction.supersedes.filter(id => existing.some(m => m.id === id)).map(id => store.supersede(guildId, id, saved.id)));
      return interaction.editReply(`Updated memory **#${saved.id}**: "${saved.content}"${correction.supersedes.length ? `. Superseded: ${correction.supersedes.map(id => `#${id}`).join(", ")}.` : "."}`);
    } catch { return interaction.editReply("I couldn't process that correction right now. Nothing was changed."); }
  }
  if (interaction.commandName === "memory-confirm") {
    const memory = await store.getMemory(guildId, interaction.options.getInteger("memory_id", true));
    if (!memory || memory.subjectId !== interaction.user.id || memory.status !== "candidate") return interaction.reply({ content: "I couldn't find one of your candidate memories with that ID.", ephemeral: true });
    await store.confirm(guildId, memory.id);
    return interaction.reply({ content: `Confirmed memory **#${memory.id}**. It is now active.`, ephemeral: true });
  }
  if (interaction.commandName === "memory-export") {
    const data = JSON.stringify(await store.exportSubject(guildId, interaction.user.id), null, 2);
    return interaction.reply({ content: "Here is the memory data I hold about you.", files: [new AttachmentBuilder(Buffer.from(data), { name: "my-asm-memory.json" })], ephemeral: true });
  }
  if (interaction.commandName === "memory-purge") {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return interaction.reply({ content: "Only server administrators can purge raw messages.", ephemeral: true });
    const days = interaction.options.getInteger("older_than_days", true);
    if (days < 1) return interaction.reply({ content: "Retention must be at least one day.", ephemeral: true });
    const deleted = await store.deleteRawMessagesOlderThan(guildId, days);
    return interaction.reply({ content: `Deleted ${deleted.toLocaleString()} raw messages older than ${days} days. Curated memories were retained.`, ephemeral: true });
  }
  if (interaction.commandName === "memory-pause" || interaction.commandName === "memory-resume") {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return interaction.reply({ content: "Only server administrators can change memory collection.", ephemeral: true });
    const paused = interaction.commandName === "memory-pause";
    await store.setPaused(guildId, paused);
    return interaction.reply({ content: paused ? "Memory collection and bot replies are now paused for this server." : "Memory collection and bot replies are now enabled for this server.", ephemeral: true });
  }
  if (interaction.commandName === "status") {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return interaction.reply({ content: "Only server administrators can view bot status.", ephemeral: true });
    const { uptimeSec, counts } = metricsSnapshot();
    const value = await store.stats(guildId);
    const uptime = `${Math.floor(uptimeSec / 3600)}h ${Math.floor((uptimeSec % 3600) / 60)}m ${uptimeSec % 60}s`;
    const counterLines = Object.entries(counts).map(([k, v]) => `**${k}:** ${v.toLocaleString()}`).join("\n") || "No events recorded yet.";
    return interaction.reply({ ephemeral: true, embeds: [new EmbedBuilder().setTitle("Bot status").setDescription(`**Uptime:** ${uptime}\n\n${counterLines}\n\n*${value.messages.toLocaleString()} raw messages · ${value.memories.toLocaleString()} active memories · ${value.lore.toLocaleString()} lore*`)] });
  }
  if (interaction.commandName === "memory-triage") {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return interaction.reply({ content: "Only server administrators can triage memories.", ephemeral: true });
    const recent = await store.recentMemories(guildId, 15);
    const lines = recent.map(m => `**#${m.id}** \`${m.status}/${m.kind}\` **${m.subjectLabel}** — ${m.content.slice(0, 120)}`);
    // Contested attributes are the dispute surface — a stored facet whose
    // evidence is currently under challenge.
    const contested = await store.contestedAttributes(guildId, 5);
    if (contested.length) {
      const attrLines = await Promise.all(contested.map(async a =>
        `⚔️ **${await store.displayNameFor(guildId, a.subjectId)}** — ${a.field}: ${a.value}`));
      lines.push("", "**Contested attributes**", ...attrLines);
    }
    return interaction.reply({ ephemeral: true, embeds: [new EmbedBuilder().setTitle("Recent memories (all members)").setDescription(lines.join("\n") || "Nothing stored yet.")] });
  }
  if (interaction.commandName === "memory-settings") {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return interaction.reply({ content: "Only server administrators can view settings.", ephemeral: true });
    const settings = await store.settings(guildId);
    return interaction.reply({ content: `Memory collection: **${settings.memoryEnabled ? "on" : "paused"}**\nBot replies: **${settings.replyEnabled ? "on" : "paused"}**\nRaw-message retention: **${settings.rawRetentionDays} days**`, ephemeral: true });
  }
  if (interaction.commandName === "event") {
    if (!evStore) return interaction.reply({ content: "Event inspection is not available right now.", ephemeral: true });
    const memId = interaction.options.getInteger("memory_id", true);
    const memory = await store.getMemory(guildId, memId);
    const canInspect = memory && (memory.subjectId === interaction.user.id || interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild));
    if (!canInspect || !memory) return interaction.reply({ content: "I couldn't find a memory you are allowed to inspect with that ID.", ephemeral: true });
    const events = await evStore.eventsForMemory(memId);
    if (events.length === 0) return interaction.reply({ content: `Memory **#${memId}** is not linked to any recorded event.`, ephemeral: true });
    const ev = events[0]; // show the most recent linked event
    const participantList = ev.participants.map(p => `${p.userName} *(${p.role})*`).join(", ") || "Unknown";
    const embed = new EmbedBuilder()
      .setTitle(`📅 ${ev.title || `Event #${ev.id}`}`)
      .setDescription(ev.summary || "*No summary yet.*")
      .addFields(
        { name: "Participants", value: participantList, inline: false },
        { name: "Occurred", value: ev.occurredAt.toLocaleDateString(), inline: true },
        { name: "Significance", value: `${(ev.significance * 100).toFixed(0)}%`, inline: true },
        { name: "Status", value: ev.tier, inline: true },
        { name: "Messages", value: String(ev.messageIds.length), inline: true },
        { name: "Memories", value: String(ev.memoryIds.length), inline: true },
      );
    return interaction.reply({ ephemeral: true, embeds: [embed] });
  }
  if (interaction.commandName === "profile") {
    const member = interaction.options.getUser("user");
    if (member && member.id !== interaction.user.id && !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.reply({ content: "You can only view your own profile.", ephemeral: true });
    }
    const subjectId = member?.id ?? interaction.user.id;
    const memberRow = await store.getMember(guildId, subjectId);
    if (memberRow?.optedOut) return interaction.reply({ content: "This member has opted out of profiles.", ephemeral: true });
    const profile = await profileStore.getProfile(guildId, subjectId);
    if (!profile) return interaction.reply({ content: "No profile has been built for that member yet. Profiles are generated during daily maintenance once enough has been observed.", ephemeral: true });

    const [edges, memories] = await Promise.all([
      store.relationshipsFor(guildId, subjectId),
      store.listMemories(guildId, subjectId),
    ]);
    const topEdges = edges.filter(e => e.observationCount >= 2).slice(0, 5);
    const relLines: string[] = [];
    for (const e of topEdges) {
      const otherId = e.subjectId === subjectId ? e.otherId : e.subjectId;
      const name = await store.displayNameFor(guildId, otherId);
      const tone = e.valence == null ? "" : e.valence >= 0.3 ? " · close" : e.valence <= -0.3 ? " · hostile" : " · neutral";
      relLines.push(`**${name}** — ${e.summary || "observed dynamic"}${tone} (${e.observationCount} observations)`);
    }
    const events = evStore ? (await evStore.listEvents(guildId, { subjectUserId: subjectId, tier: "event" })).events.slice(0, 5) : [];

    const embed = new EmbedBuilder()
      .setTitle(`Profile — ${profile.displayName || member?.username || interaction.user.username}`)
      .setDescription(profile.summary || "*No bio yet.*")
      .addFields({
        name: "Activity",
        value: memberRow
          ? `${memberRow.messageCount.toLocaleString()} messages · first seen ${new Date(memberRow.firstSeenAt).toLocaleDateString()} · last seen ${new Date(memberRow.lastSeenAt).toLocaleDateString()}`
          : "No activity recorded",
        inline: false,
      });
    if (profile.facets.roleInServer) embed.addFields({ name: "Role", value: profile.facets.roleInServer, inline: false });

    // Attributes carry provenance — each facet shows the memories it was
    // derived from, so "why does it think this" has an answer.
    const attrs = (await store.attributesFor(guildId, subjectId)).filter(a => a.status === "active");
    const cite = (a: { memoryIds: number[] }) => a.memoryIds.length ? ` *(${a.memoryIds.map(id => `#${id}`).join(", ")})*` : "";
    const details = attrs.filter(a => !["trait", "interest", "skill"].includes(a.field)).map(a => `**${a.field}:** ${a.value}${cite(a)}`);
    if (details.length) embed.addFields({ name: "Details", value: details.join("\n"), inline: false });
    const traits = attrs.filter(a => a.field === "trait").map(a => `${a.value}${cite(a)}`);
    if (traits.length) embed.addFields({ name: "Traits", value: traits.join(", "), inline: false });
    const interests = attrs.filter(a => a.field === "interest").map(a => `${a.value}${cite(a)}`);
    if (interests.length) embed.addFields({ name: "Interests", value: interests.join(", "), inline: false });
    const skills = attrs.filter(a => a.field === "skill").map(a => `${a.value}${cite(a)}`);
    if (skills.length) embed.addFields({ name: "Skills", value: skills.join(", "), inline: false });
    // Legacy facets cover profiles built before attributes existed.
    if (!attrs.length && profile.facets.traits?.length) embed.addFields({ name: "Traits", value: profile.facets.traits.join(", "), inline: false });
    if (!attrs.length && profile.facets.interests?.length) embed.addFields({ name: "Interests", value: profile.facets.interests.join(", "), inline: false });
    if (relLines.length) embed.addFields({ name: "Relationships", value: relLines.join("\n"), inline: false });
    if (events.length) embed.addFields({
      name: "Significant events",
      value: events.map(e => `${e.title || `Event #${e.id}`} *(${e.participants.find(p => p.userId === subjectId)?.role ?? "participant"})*`).join("\n"),
      inline: false,
    });
    if (memories.memories.length) embed.addFields({
      name: "Top memories",
      value: memories.memories.slice(0, 5).map(m => `• ${m.content}`).join("\n"),
      inline: false,
    });
    return interaction.reply({ ephemeral: true, embeds: [embed] });
  }
  if (interaction.commandName === "dossier") {
    const member = interaction.options.getUser("user");
    if (member && member.id !== interaction.user.id && !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.reply({ content: "You can only view your own dossier.", ephemeral: true });
    }
    const subjectId = member?.id ?? interaction.user.id;
    const memberRow = await store.getMember(guildId, subjectId);
    if (memberRow?.optedOut) return interaction.reply({ content: "This member has opted out of profiles.", ephemeral: true });
    const profile = await profileStore.getProfile(guildId, subjectId);
    const dossier = profile?.facets.dossier?.sections;
    if (!profile || !dossier || Object.keys(dossier).length === 0) {
      return interaction.reply({ content: "No detailed profile has been built for that member yet.", ephemeral: true });
    }

    const cite = (ids?: number[]) => ids?.length ? ` *(${ids.map(id => `#${id}`).join(", ")})*` : "";
    const itemsText = (items?: Array<{ text?: string; source_ids?: number[]; confirmed?: boolean }>) =>
      (items ?? []).map(i => `• ${i.text ?? ""}${cite(i.source_ids)}`).join("\n") || "*None.*";

    const embeds: EmbedBuilder[] = [];
    const head = new EmbedBuilder()
      .setTitle(`Dossier — ${profile.displayName || member?.username || interaction.user.username}`)
      .setDescription(profile.summary || "*No bio yet.*")
      .setFooter({ text: "Unconfirmed items are marked as such. #n references resolve via /memory memory_id." });
    embeds.push(head);

    const v = dossier.voice?.data as { prose?: string; quirks?: string[]; stats?: { avgLength: number; capsRatio: number; emojiRatio: number; questionRatio: number; sampleSize: number } } | undefined;
    if (v) {
      const stats = v.stats ? `\n\n*avg ${v.stats.avgLength} chars · ${(v.stats.capsRatio * 100).toFixed(0)}% all-caps · ${(v.stats.emojiRatio * 100).toFixed(0)}% emoji · ${(v.stats.questionRatio * 100).toFixed(0)}% questions · ${v.stats.sampleSize} msgs sampled*` : "";
      embeds.push(new EmbedBuilder().setTitle("Voice").setDescription(`${v.prose ?? ""}${v.quirks?.length ? `\n\n**Quirks:** ${v.quirks.join("; ")}` : ""}${stats}`));
    }
    const life = dossier.life_situation?.data as { items?: Array<{ text?: string; source_ids?: number[] }> } | undefined;
    if (life) embeds.push(new EmbedBuilder().setTitle("Life situation").setDescription(itemsText(life.items)));
    const temp = dossier.temperament?.data as { prose?: string; items?: Array<{ text?: string; source_ids?: number[] }> } | undefined;
    if (temp) embeds.push(new EmbedBuilder().setTitle("Temperament").setDescription(`${temp.prose ?? ""}${temp.items?.length ? `\n\n${itemsText(temp.items)}` : ""}`));
    const beliefs = dossier.beliefs?.data as { items?: Array<{ text?: string; source_ids?: number[] }> } | undefined;
    if (beliefs) embeds.push(new EmbedBuilder().setTitle("Beliefs & tastes").setDescription(itemsText(beliefs.items)));
    const rels = dossier.relationship_map?.data as { entries?: Array<{ name?: string; dynamic?: string }> } | undefined;
    if (rels?.entries?.length) embeds.push(new EmbedBuilder().setTitle("Relationship map").setDescription(rels.entries.map(e => `• **${e.name ?? "?"}** — ${e.dynamic ?? ""}`).join("\n")));
    const rep = dossier.reputation?.data as { prose?: string; items?: Array<{ text?: string; source_ids?: number[] }> } | undefined;
    if (rep) embeds.push(new EmbedBuilder().setTitle("Reputation").setDescription(`${rep.prose ?? ""}${rep.items?.length ? `\n\n${itemsText(rep.items)}` : ""}`));
    const tl = dossier.timeline?.data as { entries?: Array<{ title?: string; date?: string; role?: string }> } | undefined;
    if (tl?.entries?.length) embeds.push(new EmbedBuilder().setTitle("Timeline").setDescription(tl.entries.map(e => `• ${e.date ?? "?"} — ${e.title ?? "Untitled"} *(${e.role ?? "participant"})*`).join("\n")));

    return interaction.reply({ ephemeral: true, embeds: embeds.slice(0, 10) });
  }
  if (interaction.commandName === "opt-out") {
    const userId = interaction.user.id;
    await store.setMemberOptOut(guildId, userId, true);
    const forgotten = await store.forgetAllFor(guildId, userId);
    const relForgotten = await store.forgetRelationshipsFor(guildId, userId);
    await profileStore.deleteProfile(guildId, userId);
    return interaction.reply({ content: `Opted out. ${forgotten} memor${forgotten === 1 ? "y" : "ies"} and ${relForgotten} relationship record${relForgotten === 1 ? "" : "s"} about you were forgotten and your profile was deleted — no new memories, relationships, or profile data will be formed about you while you're opted out. Your messages still appear in the raw archive until the server's retention window removes them. Use /opt-in to re-enable.`, ephemeral: true });
  }
  if (interaction.commandName === "opt-in") {
    await store.setMemberOptOut(guildId, interaction.user.id, false);
    return interaction.reply({ content: "Opted back in. Previously forgotten memories stay forgotten, but new memories and your profile can be built again from future activity.", ephemeral: true });
  }
}

export async function handleMemoryButton(interaction: ButtonInteraction, store: MemoryStore) {
  if (interaction.customId === "forget:cancel") return interaction.update({ content: "No memory was deleted.", components: [] });
  const [action, guildId, userId, rawId] = interaction.customId.split(":");
  if (action !== "forget" || !guildId || !userId || !rawId || interaction.user.id !== userId) return interaction.reply({ content: "That confirmation is not valid for you.", ephemeral: true });
  const memory = await store.getMemory(guildId, Number(rawId));
  if (!memory || memory.subjectId !== userId || (await store.forget(guildId, memory.id)) === 0) return interaction.update({ content: "That memory is no longer available.", components: [] });
  return interaction.update({ content: `Forgot memory **#${memory.id}**. I will not use it in future replies.`, components: [] });
}
