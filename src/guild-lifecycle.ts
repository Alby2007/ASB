import { ChannelType, EmbedBuilder, PermissionFlagsBits, type Guild, type GuildBasedChannel, type TextChannel } from "discord.js";
import { config } from "./config.js";
import type { MemoryStore } from "./database.js";

// Guild lifecycle — announce-then-wait-for-consent: new guilds start dormant
// (v16 defaults memory_enabled=0/reply_enabled=0), get a disclosure card, and
// every row is purged if the bot is kicked. announced_at is the idempotency
// marker — discord.js fires GuildCreate for every cached guild on connect AND
// on real joins, so the first deploy announces once to existing guilds
// (desirable). Lives outside index.ts so it can be unit-tested.

/** Post the join disclosure card once per guild. Stamps announced_at only
 * after a successful send — failure leaves it NULL so the next GuildCreate
 * retries. Returns true when an announcement was posted. */
export async function announceIfNeeded(guild: Guild, store: MemoryStore): Promise<boolean> {
  const s = await store.settings(guild.id, config.rawMessageRetentionDays); // creates the row with dormant defaults
  if (s.announcedAt) return false;
  const me = guild.members.me;
  // systemChannel goes through the SAME permission check as the fallback scan —
  // an unsendable system channel must fall through, or the card retries forever.
  const sendable = (c: GuildBasedChannel | null | undefined): c is TextChannel =>
    c?.type === ChannelType.GuildText &&
    (!me || !!c.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]));
  const channel = (sendable(guild.systemChannel) ? guild.systemChannel : null)
    ?? guild.channels.cache.find(sendable) ?? null;
  if (!channel) {
    console.warn(`[announce] no sendable channel in ${guild.name} — will retry on next connect`);
    return false;
  }
  const embed = new EmbedBuilder()
    .setTitle("ASB is here — and it's waiting for consent")
    .setDescription(
      "ASB is a community-memory bot: once enabled, it reads channel messages to build shared lore and opt-in member profiles. **Right now it is dormant — it is not recording anything.**"
    )
    .addFields(
      { name: "What it stores (when enabled)", value: `Raw messages for **${s.rawRetentionDays} days**, then deleted. Derived memories, profiles, and relationship notes form **only for members who opt in**.` },
      { name: "Your controls", value: "`/privacy` — see exactly what's stored · `/opt-in` `/opt-out` — control your derived data · `/memory-export` — export everything stored about you" },
      { name: "Admins", value: "To activate ASB: run `/setup` to configure an LLM key (or use the operator's), then `/memory-resume`. `/server-build` can additionally backfill history." },
      { name: "Privacy policy", value: "[github.com/Alby2007/ASB-Docs](https://github.com/Alby2007/ASB-Docs) — kick the bot and every row it stored here is deleted." },
    );
  await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
  return store.markAnnounced(guild.id);
}

/** GuildDelete semantics — returns true when a purge ran. `unavailable` means
 * a Discord outage took the guild offline, NOT a kick: never purge on it;
 * the rows come back when Discord recovers. */
export async function handleGuildDelete(
  guild: { id: string; name: string; unavailable?: boolean },
  store: MemoryStore,
): Promise<boolean> {
  if (guild.unavailable) return false;
  await store.purgeGuild(guild.id);
  return true;
}
