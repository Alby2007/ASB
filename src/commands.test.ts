import "dotenv/config";
import assert from "node:assert/strict";
import test from "node:test";
import type { ButtonInteraction, ChatInputCommandInteraction } from "discord.js";
import { handleMemoryButton, handleMemoryCommand } from "./commands.js";
import { makeTestSql, makeStore } from "./test-helpers.js";
import type { Brain } from "./brain.js";
import type { EventStore } from "./events.js";
import type { MessageEvent } from "./types.js";

// ── Interaction stubs ─────────────────────────────────────────────────────────

type Replies = Array<{ content?: string; embeds?: unknown[]; components?: unknown[]; files?: unknown[]; ephemeral?: boolean }>;

function stubCommand(opts: {
  commandName: string;
  userId?: string;
  username?: string;
  admin?: boolean;
  options?: Record<string, unknown>;
}): { interaction: ChatInputCommandInteraction; replies: Replies } {
  const replies: Replies = [];
  const interaction = {
    guildId: "g1",
    channelId: "c1",
    id: "ix-1",
    commandName: opts.commandName,
    user: { id: opts.userId ?? "u-user", username: opts.username ?? "User" },
    memberPermissions: { has: () => !!opts.admin },
    options: {
      getBoolean: (name: string) => opts.options?.[name] ?? null,
      getInteger: (name: string, _required?: boolean) => opts.options?.[name] ?? null,
      getString: (name: string, _required?: boolean) => opts.options?.[name] ?? null,
      getUser: (name: string) => opts.options?.[name] ?? null,
    },
    reply: async (r: (typeof replies)[number]) => { replies.push(r); return r; },
    editReply: async (r: string) => { replies.push({ content: r }); return r; },
    deferReply: async () => {},
    replied: false,
    deferred: false,
  };
  return { interaction: interaction as unknown as ChatInputCommandInteraction, replies };
}

function stubButton(opts: { customId: string; userId: string }): { interaction: ButtonInteraction; replies: Replies; updates: Replies } {
  const replies: Replies = [];
  const updates: Replies = [];
  const interaction = {
    customId: opts.customId,
    user: { id: opts.userId },
    reply: async (r: (typeof replies)[number]) => { replies.push(r); return r; },
    update: async (r: (typeof updates)[number]) => { updates.push(r); return r; },
  };
  return { interaction: interaction as unknown as ButtonInteraction, replies, updates };
}

const brain = {} as Brain; // commands under test here never reach the LLM
const evStore = { eventsForMemory: async () => [] } as unknown as EventStore;

function msg(content: string, overrides: Partial<MessageEvent> = {}): MessageEvent {
  return {
    guildId: "g1", channelId: "c1", messageId: `m-${Math.random().toString(36).slice(2)}`,
    authorId: "u-user", authorName: "User",
    content, createdAt: new Date(), mentionsBot: false,
    ...overrides,
  };
}

const candidate = {
  subjectId: "u-user", kind: "person_fact" as const, content: "User has a cat",
  reason: "Heard it somewhere", evidenceType: "reported_by_other" as const, effect: "support" as const,
};

// ── Cross-member read authorization ──────────────────────────────────────────

test("/memory about: a non-admin cannot view another member's memories", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const { interaction, replies } = stubCommand({
      commandName: "memory", userId: "u-user",
      options: { about: { id: "u-other", username: "Other" } },
    });
    await handleMemoryCommand(interaction, store, brain);
    assert.match(replies[0].content ?? "", /only view your own/i);
  } finally { await sql.end(); }
});

test("/memory about: an admin can view another member's memories", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const { interaction, replies } = stubCommand({
      commandName: "memory", userId: "u-admin", admin: true,
      options: { about: { id: "u-other", username: "Other" } },
    });
    await handleMemoryCommand(interaction, store, brain);
    assert.ok(replies[0].embeds?.length, "expected an embed reply");
  } finally { await sql.end(); }
});

test("/memory memory_id: non-admin cannot inspect another member's memory, admin can", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const mem = await store.saveMemory(msg("I have a cat"), candidate);
    const denied = stubCommand({ commandName: "memory", userId: "u-stranger", options: { memory_id: mem.id } });
    await handleMemoryCommand(denied.interaction, store, brain);
    assert.match(denied.replies[0].content ?? "", /couldn't find/i);
    const allowed = stubCommand({ commandName: "memory", userId: "u-admin", admin: true, options: { memory_id: mem.id } });
    await handleMemoryCommand(allowed.interaction, store, brain);
    assert.ok(allowed.replies[0].embeds?.length, "expected provenance embed");
  } finally { await sql.end(); }
});

test("/profile user: and /dossier user: block non-admin cross-member views", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    for (const commandName of ["profile", "dossier"]) {
      const { interaction, replies } = stubCommand({
        commandName, userId: "u-stranger",
        options: { user: { id: "u-other", username: "Other" } },
      });
      await handleMemoryCommand(interaction, store, brain);
      assert.match(replies[0].content ?? "", /only view your own/i, commandName);
    }
  } finally { await sql.end(); }
});

test("/event memory_id: non-admin cannot inspect another member's memory linkage", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const mem = await store.saveMemory(msg("I have a cat"), candidate);
    const { interaction, replies } = stubCommand({
      commandName: "event", userId: "u-stranger", options: { memory_id: mem.id },
    });
    await handleMemoryCommand(interaction, store, brain, evStore);
    assert.match(replies[0].content ?? "", /couldn't find/i);
  } finally { await sql.end(); }
});

// ── Admin gates ───────────────────────────────────────────────────────────────

test("admin commands refuse non-admin callers", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    for (const [commandName, options] of [
      ["memory", { stats: true }],
      ["memory-purge", { older_than_days: 7 }],
      ["memory-pause", {}],
      ["memory-resume", {}],
      ["status", {}],
      ["memory-triage", {}],
      ["memory-settings", {}],
    ] as const) {
      const { interaction, replies } = stubCommand({ commandName, userId: "u-stranger", options });
      await handleMemoryCommand(interaction, store, brain);
      assert.match(replies[0].content ?? "", /administrator/i, commandName);
    }
  } finally { await sql.end(); }
});

test("/memory-pause flips both settings flags for admins only", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const { interaction } = stubCommand({ commandName: "memory-pause", userId: "u-admin", admin: true });
    await handleMemoryCommand(interaction, store, brain);
    const settings = await store.settings("g1");
    assert.equal(settings.memoryEnabled, 0);
    assert.equal(settings.replyEnabled, 0);
  } finally { await sql.end(); }
});

test("/memory-purge rejects a sub-one-day retention even for admins", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const { interaction, replies } = stubCommand({
      commandName: "memory-purge", userId: "u-admin", admin: true, options: { older_than_days: 0 },
    });
    await handleMemoryCommand(interaction, store, brain);
    assert.match(replies[0].content ?? "", /at least one day/i);
  } finally { await sql.end(); }
});

// ── Ownership-gated writes ────────────────────────────────────────────────────

test("/forget refuses memories owned by someone else", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const mem = await store.saveMemory(msg("I have a cat", { authorId: "u-owner" }), candidate);
    const { interaction, replies } = stubCommand({
      commandName: "forget", userId: "u-stranger", options: { memory_id: mem.id },
    });
    await handleMemoryCommand(interaction, store, brain);
    assert.match(replies[0].content ?? "", /couldn't find/i);
    assert.equal((await store.getMemory("g1", mem.id))?.status, "candidate");
  } finally { await sql.end(); }
});

test("/forget on your own memory offers a confirm button, and the button forgets it", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const mem = await store.saveMemory(msg("I have a cat"), candidate);
    const { interaction, replies } = stubCommand({
      commandName: "forget", userId: "u-user", options: { memory_id: mem.id },
    });
    await handleMemoryCommand(interaction, store, brain);
    assert.ok(replies[0].components?.length, "expected a confirmation row");

    const button = stubButton({ customId: `forget:g1:u-user:${mem.id}`, userId: "u-user" });
    await handleMemoryButton(button.interaction, store);
    assert.match(updates_content(button.updates), /forgot memory/i);
    assert.equal((await store.getMemory("g1", mem.id))?.status, "forgotten");
  } finally { await sql.end(); }
});

test("forget button rejects a click from anyone but the owner", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const mem = await store.saveMemory(msg("I have a cat"), candidate);
    const { interaction, replies, updates } = stubButton({ customId: `forget:g1:u-user:${mem.id}`, userId: "u-stranger" });
    await handleMemoryButton(interaction, store);
    assert.equal(updates.length, 0);
    assert.match(replies[0].content ?? "", /not valid for you/i);
    assert.equal((await store.getMemory("g1", mem.id))?.status, "candidate");
  } finally { await sql.end(); }
});

test("/memory-confirm only activates your own candidates", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const mem = await store.saveMemory(msg("I have a cat"), candidate);
    // Someone else's candidate — refused, stays candidate.
    const denied = stubCommand({ commandName: "memory-confirm", userId: "u-stranger", options: { memory_id: mem.id } });
    await handleMemoryCommand(denied.interaction, store, brain);
    assert.match(denied.replies[0].content ?? "", /couldn't find/i);
    assert.equal((await store.getMemory("g1", mem.id))?.status, "candidate");
    // The owner — confirmed and active.
    const own = stubCommand({ commandName: "memory-confirm", userId: "u-user", options: { memory_id: mem.id } });
    await handleMemoryCommand(own.interaction, store, brain);
    assert.equal((await store.getMemory("g1", mem.id))?.status, "active");
  } finally { await sql.end(); }
});

// ── Opt-out / opt-in ──────────────────────────────────────────────────────────

test("/opt-out forgets memories and deletes the profile; /opt-in re-enables", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const mem = await store.saveMemory(msg("I have a cat"), candidate);
    const out = stubCommand({ commandName: "opt-out", userId: "u-user" });
    await handleMemoryCommand(out.interaction, store, brain);
    assert.match(out.replies[0].content ?? "", /opted out/i);
    assert.equal((await store.getMember("g1", "u-user"))?.optedOut, true);
    assert.equal((await store.getMemory("g1", mem.id))?.status, "forgotten");

    const back = stubCommand({ commandName: "opt-in", userId: "u-user" });
    await handleMemoryCommand(back.interaction, store, brain);
    assert.equal((await store.getMember("g1", "u-user"))?.optedOut, false);
    // Forgotten stays forgotten — opt-in doesn't resurrect.
    assert.equal((await store.getMemory("g1", mem.id))?.status, "forgotten");
  } finally { await sql.end(); }
});

function updates_content(updates: Replies): string {
  return updates.map(u => u.content ?? "").join("\n");
}
