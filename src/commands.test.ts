import "dotenv/config";
import assert from "node:assert/strict";
import test from "node:test";
import type { ButtonInteraction, ChatInputCommandInteraction, ModalSubmitInteraction } from "discord.js";
import { handleMemoryButton, handleMemoryCommand, handleSetupModal } from "./commands.js";
import { ProfileStore } from "./profiles.js";
import { makeTestSql, makeStore } from "./test-helpers.js";
import type { Brain } from "./brain.js";
import type { EventStore } from "./events.js";
import type { MessageEvent } from "./types.js";
import { config } from "./config.js";
import { decryptSecret } from "./secrets.js";

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
      getChannel: (name: string) => opts.options?.[name] ?? null,
    },
    reply: async (r: (typeof replies)[number]) => { replies.push(r); return r; },
    editReply: async (r: string) => { replies.push({ content: r }); return r; },
    deferReply: async () => {},
    showModal: async (m: unknown) => { replies.push({ content: `modal:${(m as { data?: { custom_id?: string } }).data?.custom_id ?? "?"}` }); },
    replied: false,
    deferred: false,
  };
  return { interaction: interaction as unknown as ChatInputCommandInteraction, replies };
}

function stubButton(opts: { customId: string; userId: string; guildId?: string; admin?: boolean; channelId?: string }): { interaction: ButtonInteraction; replies: Replies; updates: Replies } {
  const replies: Replies = [];
  const updates: Replies = [];
  // Empty message fetch → the ingest loop breaks immediately and the build
  // completes on an empty backlog rather than retrying forever on a stub.
  const channel = { type: 0, name: "general", send: async () => {}, messages: { fetch: async () => new Map() } };
  const interaction = {
    customId: opts.customId,
    user: { id: opts.userId },
    guildId: opts.guildId ?? "g1",
    memberPermissions: { has: () => !!opts.admin },
    guild: {
      channels: {
        cache: { get: (id: string) => (id === (opts.channelId ?? "ch-1") ? channel : null) },
        fetch: async () => channel,
      },
    },
    channel: { send: async () => {} },
    client: { user: { id: "bot-1" } },
    reply: async (r: (typeof replies)[number]) => { replies.push(r); return r; },
    update: async (r: (typeof updates)[number]) => { updates.push(r); return r; },
  };
  return { interaction: interaction as unknown as ButtonInteraction, replies, updates };
}

const brain = {} as Brain; // commands under test here never reach the LLM
const brainFor = async () => brain; // resolver signature — guild keys untested at this level
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
    await handleMemoryCommand(interaction, store, brainFor);
    assert.match(replies[0].content ?? "", /only view your own/i);
  } finally { await sql.end(); }
});

test("/memory about: an admin can view another member's memories", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    await store.setMemberOptIn("g1", "u-other", true); // derived data requires consent
    const { interaction, replies } = stubCommand({
      commandName: "memory", userId: "u-admin", admin: true,
      options: { about: { id: "u-other", username: "Other" } },
    });
    await handleMemoryCommand(interaction, store, brainFor);
    assert.ok(replies[0].embeds?.length, "expected an embed reply");
  } finally { await sql.end(); }
});

test("/memory memory_id: non-admin cannot inspect another member's memory, admin can", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const mem = await store.saveMemory(msg("I have a cat"), candidate);
    const denied = stubCommand({ commandName: "memory", userId: "u-stranger", options: { memory_id: mem.id } });
    await handleMemoryCommand(denied.interaction, store, brainFor);
    assert.match(denied.replies[0].content ?? "", /couldn't find/i);
    const allowed = stubCommand({ commandName: "memory", userId: "u-admin", admin: true, options: { memory_id: mem.id } });
    await handleMemoryCommand(allowed.interaction, store, brainFor);
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
      await handleMemoryCommand(interaction, store, brainFor);
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
    await handleMemoryCommand(interaction, store, brainFor, evStore);
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
      ["proactive", { enabled: true }],
    ] as const) {
      const { interaction, replies } = stubCommand({ commandName, userId: "u-stranger", options });
      await handleMemoryCommand(interaction, store, brainFor);
      assert.match(replies[0].content ?? "", /administrator/i, commandName);
    }
  } finally { await sql.end(); }
});

test("/memory-pause flips both settings flags for admins only", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const { interaction } = stubCommand({ commandName: "memory-pause", userId: "u-admin", admin: true });
    await handleMemoryCommand(interaction, store, brainFor);
    const settings = await store.settings("g1");
    assert.equal(settings.memoryEnabled, 0);
    assert.equal(settings.replyEnabled, 0);
  } finally { await sql.end(); }
});

test("/proactive persists the per-server flag, defaults off", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    // Default must be OFF — proactive is opt-in per server, unlike replies.
    assert.equal((await store.settings("g1")).proactiveEnabled, 0);
    const { interaction } = stubCommand({ commandName: "proactive", userId: "u-admin", admin: true, options: { enabled: true } });
    await handleMemoryCommand(interaction, store, brainFor);
    assert.equal((await store.settings("g1")).proactiveEnabled, 1);
    const { interaction: off } = stubCommand({ commandName: "proactive", userId: "u-admin", admin: true, options: { enabled: false } });
    await handleMemoryCommand(off, store, brainFor);
    assert.equal((await store.settings("g1")).proactiveEnabled, 0);
  } finally { await sql.end(); }
});

test("/memory-purge rejects a sub-one-day retention even for admins", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const { interaction, replies } = stubCommand({
      commandName: "memory-purge", userId: "u-admin", admin: true, options: { older_than_days: 0 },
    });
    await handleMemoryCommand(interaction, store, brainFor);
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
    await handleMemoryCommand(interaction, store, brainFor);
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
    await handleMemoryCommand(interaction, store, brainFor);
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
    await handleMemoryCommand(denied.interaction, store, brainFor);
    assert.match(denied.replies[0].content ?? "", /couldn't find/i);
    assert.equal((await store.getMemory("g1", mem.id))?.status, "candidate");
    // The owner — confirmed and active.
    const own = stubCommand({ commandName: "memory-confirm", userId: "u-user", options: { memory_id: mem.id } });
    await handleMemoryCommand(own.interaction, store, brainFor);
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
    await handleMemoryCommand(out.interaction, store, brainFor, undefined, new ProfileStore(sql));
    assert.match(out.replies[0].content ?? "", /opted out/i);
    assert.equal((await store.getMember("g1", "u-user"))?.optedOut, true);
    assert.equal((await store.getMemory("g1", mem.id))?.status, "forgotten");

    const back = stubCommand({ commandName: "opt-in", userId: "u-user" });
    await handleMemoryCommand(back.interaction, store, brainFor);
    const member = await store.getMember("g1", "u-user");
    assert.equal(member?.optedOut, false);
    assert.equal(member?.optedIn, true); // /opt-in now grants derived-data consent
    // Forgotten stays forgotten — opt-in doesn't resurrect.
    assert.equal((await store.getMemory("g1", mem.id))?.status, "forgotten");
  } finally { await sql.end(); }
});

test("/memory for a member who never opted in points at /profile-build", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const { interaction, replies } = stubCommand({ commandName: "memory", userId: "u-user" });
    await handleMemoryCommand(interaction, store, brainFor);
    assert.match(replies[0].content ?? "", /profile-build/i);
  } finally { await sql.end(); }
});

test("/profile-build opts the member in and reports the scan", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const { interaction, replies } = stubCommand({ commandName: "profile-build", userId: "u-user" });
    await handleMemoryCommand(interaction, store, brainFor, undefined, new ProfileStore(sql));
    assert.equal((await store.getMember("g1", "u-user"))?.optedIn, true);
    assert.match(replies.at(-1)?.content ?? "", /scanned 0 messages/i);
  } finally { await sql.end(); }
});

test("/server-build refuses non-admins and wants a channel from admins", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const denied = stubCommand({ commandName: "server-build", userId: "u-stranger" });
    await handleMemoryCommand(denied.interaction, store, brainFor);
    assert.match(denied.replies[0].content ?? "", /administrator/i);

    const admin = stubCommand({ commandName: "server-build", userId: "u-admin", admin: true });
    await handleMemoryCommand(admin.interaction, store, brainFor);
    assert.match(admin.replies[0].content ?? "", /pick a text channel/i);
  } finally { await sql.end(); }
});

// ── /setup (BYOK) ─────────────────────────────────────────────────────────────

function stubModal(opts: { key?: string; baseUrl?: string; guildId?: string; admin?: boolean }) {
  const replies: Replies = [];
  const interaction = {
    customId: "setup-key",
    guildId: opts.guildId ?? "g1",
    memberPermissions: { has: () => opts.admin !== false },
    fields: { getTextInputValue: (id: string) => id === "api-key" ? (opts.key ?? "") : (opts.baseUrl ?? "") },
    reply: async (r: { content: string }) => { replies.push({ content: r.content }); return r; },
    deferReply: async () => {},
    editReply: async (r: string) => { replies.push({ content: r }); return r; },
  };
  return { interaction: interaction as unknown as ModalSubmitInteraction, replies };
}

test("/setup: non-admin rejected; admin without KEY_ENCRYPTION_SECRET gets the operator message", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const denied = stubCommand({ commandName: "setup", userId: "u-stranger" });
    await handleMemoryCommand(denied.interaction, store, brainFor);
    assert.match(denied.replies[0].content ?? "", /administrator/i);

    const saved = config.keyEncryptionSecret;
    config.keyEncryptionSecret = undefined;
    try {
      const admin = stubCommand({ commandName: "setup", userId: "u-admin", admin: true });
      await handleMemoryCommand(admin.interaction, store, brainFor);
      assert.match(admin.replies[0].content ?? "", /KEY_ENCRYPTION_SECRET/i);
    } finally { config.keyEncryptionSecret = saved; }
  } finally { await sql.end(); }
});

test("/setup modal: valid key stores ciphertext + masked hint and invalidates the cache", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const saved = config.keyEncryptionSecret;
    config.keyEncryptionSecret = "test-master-passphrase";
    try {
      let invalidated = "";
      const { interaction, replies } = stubModal({ key: "gsk_test_secretkey1234" });
      await handleSetupModal(interaction, store, g => { invalidated = g; }, async () => ({ ok: true }));
      const row = await store.getGuildKey("g1");
      assert.ok(row, "guild key row missing");
      assert.equal(row!.keyHint, "…1234");
      assert.equal(decryptSecret(row!.keyEnc), "gsk_test_secretkey1234"); // ciphertext round-trips
      assert.ok(row!.validatedAt, "validated key should carry validated_at");
      assert.equal(invalidated, "g1");
      assert.match(replies.at(-1)?.content ?? "", /…1234/);
      assert.doesNotMatch(replies.at(-1)?.content ?? "", /gsk_test_secretkey1234/); // never echo the key
    } finally { config.keyEncryptionSecret = saved; }
  } finally { await sql.end(); }
});

test("/setup modal: non-admin submit is re-checked and rejected", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const saved = config.keyEncryptionSecret;
    config.keyEncryptionSecret = "test-master-passphrase";
    try {
      const denied = stubModal({ key: "gsk_test_secretkey1234", guildId: "g-setup-nonadmin", admin: false });
      await handleSetupModal(denied.interaction, store, () => {}, async () => ({ ok: true }));
      assert.match(denied.replies[0]?.content ?? "", /Manage Server|permission/i);
      assert.equal(await store.getGuildKey("g-setup-nonadmin"), null, "nothing should be stored for a non-admin submit");
    } finally { config.keyEncryptionSecret = saved; }
  } finally { await sql.end(); }
});

test("/setup modal: rejected key stores nothing; unreachable stores unverified", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const saved = config.keyEncryptionSecret;
    config.keyEncryptionSecret = "test-master-passphrase";
    try {
      const bad = stubModal({ key: "bad-key", guildId: "g-setup-bad" });
      await handleSetupModal(bad.interaction, store, () => {}, async () => ({ ok: false, status: 401 }));
      assert.equal(await store.getGuildKey("g-setup-bad"), null);
      assert.match(bad.replies.at(-1)?.content ?? "", /rejected|auth/i);

      const flaky = stubModal({ key: "gsk_unverified9999", guildId: "g-setup-flaky" });
      await handleSetupModal(flaky.interaction, store, () => {}, async () => ({ ok: false, unreachable: true }));
      const row = await store.getGuildKey("g-setup-flaky");
      assert.ok(row, "unverified key should still be stored");
      assert.equal(row!.validatedAt, null);
      assert.match(flaky.replies.at(-1)?.content ?? "", /unverified|couldn't reach/i);

      const ssrf = stubModal({ key: "gsk_whatever1234", baseUrl: "http://169.254.169.254/v1", guildId: "g-setup-ssrf" });
      await handleSetupModal(ssrf.interaction, store, () => {}, async () => ({ ok: true }));
      assert.equal(await store.getGuildKey("g-setup-ssrf"), null);
      assert.match(ssrf.replies.at(-1)?.content ?? "", /base URL|public http/i);
    } finally { config.keyEncryptionSecret = saved; }
  } finally { await sql.end(); }
});

function updates_content(updates: Replies): string {
  return updates.map(u => u.content ?? "").join("\n");
}

// ── /privacy + /server-build consent gate ────────────────────────────────────

test("/privacy is ephemeral and reflects the caller's consent state", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const anon = stubCommand({ commandName: "privacy", userId: "u-anon" });
    await handleMemoryCommand(anon.interaction, store, brainFor);
    assert.equal(anon.replies[0].ephemeral, true, "privacy replies must be ephemeral");
    const fields = JSON.stringify(anon.replies[0].embeds);
    assert.match(fields, /not opted in/i);
    assert.match(fields, /\*\*30 days\*\*|30 days/, "retention should be shown");

    await store.setMemberOptIn("g1", "u-consented", true);
    const consented = stubCommand({ commandName: "privacy", userId: "u-consented" });
    await handleMemoryCommand(consented.interaction, store, brainFor);
    assert.match(JSON.stringify(consented.replies[0].embeds), /opted in/i);
  } finally { await sql.end(); }
});

test("/server-build asks for consent instead of starting", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const channel = { id: "ch-1", type: 0, name: "general" };
    const cmd = stubCommand({ commandName: "server-build", userId: "u-admin", admin: true, options: { channel } });
    await handleMemoryCommand(cmd.interaction, store, brainFor);
    assert.equal(cmd.replies[0].ephemeral, true);
    assert.match(cmd.replies[0].content ?? "", /scans and archives|never consented/i);
    assert.ok(cmd.replies[0].components?.length, "consent prompt must carry confirm/cancel buttons");
    assert.doesNotMatch(cmd.replies[0].content ?? "", /build started/i, "the build must not start from the command");
  } finally { await sql.end(); }
});

test("serverbuild buttons: wrong user rejected, cancel updates, confirm reaches the runner", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    // Someone else clicking the confirm button is denied.
    const stranger = stubButton({ customId: "serverbuild:confirm:g1:u-admin:ch-1", userId: "u-stranger", admin: true });
    await handleMemoryButton(stranger.interaction, store, brainFor);
    assert.match(stranger.replies[0]?.content ?? "", /not for you/i);
    assert.equal(stranger.updates.length, 0);

    // Cancel dismisses the prompt without starting anything.
    const cancel = stubButton({ customId: "serverbuild:cancel:g1:u-admin", userId: "u-admin", admin: true });
    await handleMemoryButton(cancel.interaction, store, brainFor);
    assert.match(updates_content(cancel.updates), /cancelled/i);

    // Non-admin (permissions revoked between prompt and click) is denied.
    const demoted = stubButton({ customId: "serverbuild:confirm:g1:u-admin:ch-1", userId: "u-admin", admin: false });
    await handleMemoryButton(demoted.interaction, store, brainFor);
    assert.match(demoted.replies[0]?.content ?? "", /Manage Server/i);

    // A real confirm claims the flag and reaches the runner — the stub channel
    // fails the build almost immediately, but the "started" update proves the
    // path; the flag releases in finally once the runner settles.
    const confirm = stubButton({ customId: "serverbuild:confirm:g1:u-admin:ch-1", userId: "u-admin", admin: true });
    await handleMemoryButton(confirm.interaction, store, brainFor);
    assert.match(updates_content(confirm.updates), /Server build started/i);
    await new Promise(r => setTimeout(r, 20)); // let the failed runner release the flag
  } finally { await sql.end(); }
});
