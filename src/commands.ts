import { ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonInteraction, ButtonStyle, ChatInputCommandInteraction, EmbedBuilder, PermissionFlagsBits } from "discord.js";
import type { Brain } from "./brain.js";
import type { Memory, MemoryStore } from "./database.js";
import type { EventStore } from "./events.js";
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
  { name: "event", description: "Inspect the event linked to one of your memories", options: [
    { name: "memory_id", description: "A memory number returned by /memory", type: 4, required: true }
  ] }
];

const confidence = (value: number | undefined) => {
  if (value === undefined) return "Unknown";
  return value >= .8 ? "High" : value >= .55 ? "Medium" : "Low";
};
const display = (memory: Memory) => `**#${memory.id} · ${confidence(memory.confidence)} confidence**\n${memory.content}\n*${memory.mentions} confirmation${memory.mentions === 1 ? "" : "s"}; last confirmed ${new Date(memory.lastConfirmedAt).toLocaleDateString()}*`;

export async function handleMemoryCommand(interaction: ChatInputCommandInteraction, store: MemoryStore, brain: Brain, evStore?: EventStore) {
  if (!interaction.guildId) return;
  const guildId = interaction.guildId;
  if (interaction.commandName === "memory") {
    const server = interaction.options.getBoolean("server") ?? false;
    const stats = interaction.options.getBoolean("stats") ?? false;
    if (stats) {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return interaction.reply({ content: "Only server administrators can view memory statistics.", ephemeral: true });
      const value = store.stats(guildId); return interaction.reply({ ephemeral: true, embeds: [new EmbedBuilder().setTitle("Memory statistics").setDescription(`${value.messages.toLocaleString()} raw messages\n${value.memories.toLocaleString()} active memories\n${value.lore.toLocaleString()} server-lore memories`)] });
    }
    const detailId = interaction.options.getInteger("memory_id");
    if (detailId) {
      const memory = store.getMemory(guildId, detailId);
      const canInspect = memory && (memory.subjectId === interaction.user.id || interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild));
      if (!canInspect || !memory) return interaction.reply({ content: "I couldn't find a memory you are allowed to inspect with that ID.", ephemeral: true });
      const evidence = store.evidence(guildId, memory.id).slice(0, 5);
      const evidenceText = evidence.length ? evidence.map(item => `• “${item.quote.slice(0, 220)}”\n  *Why:* ${item.reason} · ${new Date(item.observedAt).toLocaleDateString()}`).join("\n") : "No evidence has been retained.";
      return interaction.reply({ ephemeral: true, embeds: [new EmbedBuilder().setTitle(`Memory #${memory.id}`).setDescription(`**${memory.content}**\n\nStatus: ${memory.status}\nConfidence: ${confidence(memory.confidence)} (${(memory.confidence ?? 0).toFixed(2)})\nImportance: ${(memory.importance ?? 0).toFixed(2)}\nFirst observed: ${new Date(memory.createdAt).toLocaleDateString()}\nLast confirmed: ${new Date(memory.lastConfirmedAt).toLocaleDateString()}\nConfirmations: ${memory.mentions}\n\n**Evidence**\n${evidenceText}`)] });
    }
    const member = interaction.options.getUser("about");
    if (member && member.id !== interaction.user.id && !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return interaction.reply({ content: "You can only view your own memories.", ephemeral: true });
    const subjectId = server ? "server" : (member?.id ?? interaction.user.id);
    const candidates = interaction.options.getBoolean("candidates") ?? false;
    const result = store.listMemories(guildId, subjectId, { search: interaction.options.getString("search") ?? undefined, page: interaction.options.getInteger("page") ?? 1, status: candidates ? "candidate" : undefined });
    const title = candidates ? "Candidate memories awaiting confirmation" : (server ? "What I remember about this server" : `What I remember about ${member?.username ?? interaction.user.username}`);
    const description = result.memories.length ? result.memories.map(display).join("\n\n") : "Nothing active yet.";
    return interaction.reply({ ephemeral: true, embeds: [new EmbedBuilder().setTitle(`🧠 ${title}`).setDescription(description).setFooter({ text: `Page ${result.page} · ${result.total} active memories` })] });
  }
  if (interaction.commandName === "forget") {
    const id = interaction.options.getInteger("memory_id", true), memory = store.getMemory(guildId, id);
    if (!memory || memory.subjectId !== interaction.user.id) return interaction.reply({ content: "I couldn't find one of your memories with that ID.", ephemeral: true });
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`forget:${guildId}:${interaction.user.id}:${id}`).setLabel("Forget it").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("forget:cancel").setLabel("Cancel").setStyle(ButtonStyle.Secondary)
    );
    return interaction.reply({ content: `Forget **#${id}**: “${memory.content}”? This removes the curated memory, but not its raw source message.`, components: [row], ephemeral: true });
  }
  if (interaction.commandName === "correct") {
    await interaction.deferReply({ ephemeral: true });
    try {
      const existing = store.allActiveMemories(guildId, interaction.user.id);
      const correction = await brain.correctMemory(interaction.user.id, interaction.options.getString("statement", true), existing);
      correction.replacement.subjectId = interaction.user.id;
      correction.replacement.evidenceType = "correction";
      correction.replacement.effect = "correct";
      const event: MessageEvent = { guildId, channelId: interaction.channelId, messageId: `correction:${interaction.id}`, authorId: interaction.user.id, authorName: interaction.user.username, content: interaction.options.getString("statement", true), createdAt: new Date(), mentionsBot: false };
      const saved = store.saveMemory(event, correction.replacement);
      correction.supersedes.filter(id => existing.some(m => m.id === id)).forEach(id => store.supersede(guildId, id, saved.id));
      return interaction.editReply(`Updated memory **#${saved.id}**: “${saved.content}”${correction.supersedes.length ? `. Superseded: ${correction.supersedes.map(id => `#${id}`).join(", ")}.` : "."}`);
    } catch { return interaction.editReply("I couldn't process that correction right now. Nothing was changed."); }
  }
  if (interaction.commandName === "memory-confirm") {
    const memory = store.getMemory(guildId, interaction.options.getInteger("memory_id", true));
    if (!memory || memory.subjectId !== interaction.user.id || memory.status !== "candidate") return interaction.reply({ content: "I couldn't find one of your candidate memories with that ID.", ephemeral: true });
    store.confirm(guildId, memory.id);
    return interaction.reply({ content: `Confirmed memory **#${memory.id}**. It is now active.`, ephemeral: true });
  }
  if (interaction.commandName === "memory-export") {
    const data = JSON.stringify(store.exportSubject(guildId, interaction.user.id), null, 2);
    return interaction.reply({ content: "Here is the memory data I hold about you.", files: [new AttachmentBuilder(Buffer.from(data), { name: "my-asm-memory.json" })], ephemeral: true });
  }
  if (interaction.commandName === "memory-purge") {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return interaction.reply({ content: "Only server administrators can purge raw messages.", ephemeral: true });
    const days = interaction.options.getInteger("older_than_days", true);
    if (days < 1) return interaction.reply({ content: "Retention must be at least one day.", ephemeral: true });
    const deleted = store.deleteRawMessagesOlderThan(guildId, days);
    return interaction.reply({ content: `Deleted ${deleted.toLocaleString()} raw messages older than ${days} days. Curated memories were retained.`, ephemeral: true });
  }
  if (interaction.commandName === "memory-pause" || interaction.commandName === "memory-resume") {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return interaction.reply({ content: "Only server administrators can change memory collection.", ephemeral: true });
    const paused = interaction.commandName === "memory-pause";
    store.setPaused(guildId, paused);
    return interaction.reply({ content: paused ? "Memory collection and bot replies are now paused for this server." : "Memory collection and bot replies are now enabled for this server.", ephemeral: true });
  }
  if (interaction.commandName === "memory-settings") {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return interaction.reply({ content: "Only server administrators can view settings.", ephemeral: true });
    const settings = store.settings(guildId);
    return interaction.reply({ content: `Memory collection: **${settings.memoryEnabled ? "on" : "paused"}**\nBot replies: **${settings.replyEnabled ? "on" : "paused"}**\nRaw-message retention: **${settings.rawRetentionDays} days**`, ephemeral: true });
  }
  if (interaction.commandName === "event") {
    if (!evStore) return interaction.reply({ content: "Event inspection is not available right now.", ephemeral: true });
    const memId = interaction.options.getInteger("memory_id", true);
    const memory = store.getMemory(guildId, memId);
    const canInspect = memory && (memory.subjectId === interaction.user.id || interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild));
    if (!canInspect || !memory) return interaction.reply({ content: "I couldn't find a memory you are allowed to inspect with that ID.", ephemeral: true });
    const events = evStore.eventsForMemory(memId);
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
}

export async function handleMemoryButton(interaction: ButtonInteraction, store: MemoryStore) {
  if (interaction.customId === "forget:cancel") return interaction.update({ content: "No memory was deleted.", components: [] });
  const [action, guildId, userId, rawId] = interaction.customId.split(":");
  if (action !== "forget" || !guildId || !userId || !rawId || interaction.user.id !== userId) return interaction.reply({ content: "That confirmation is not valid for you.", ephemeral: true });
  const memory = store.getMemory(guildId, Number(rawId));
  if (!memory || memory.subjectId !== userId || store.forget(guildId, memory.id) === 0) return interaction.update({ content: "That memory is no longer available.", components: [] });
  return interaction.update({ content: `Forgot memory **#${memory.id}**. I will not use it in future replies.`, components: [] });
}
