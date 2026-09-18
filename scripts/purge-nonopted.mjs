import 'dotenv/config';
import { sql } from '../src/db.ts';
import { runMigrations } from '../src/migrations.ts';

// One-shot purge of derived data for every member who never opted in.
// Run once after the consent model ships (migration v14 + opt-in window).
// Hard-deletes memories, evidence, history, attributes, profiles, and
// relationship observations/edges for non-consenting subjects — the raw
// message archive and the member registry are untouched. 'server' lore and
// events are shared context and are never purged.
//
// Requires PURGE_CONFIRM=1 — this is irreversible.

const guildId = process.env.GUILD_ID;
if (!guildId) { console.error('GUILD_ID env is required'); process.exit(1); }
if (process.env.PURGE_CONFIRM !== '1') {
  console.error('Refusing to run without PURGE_CONFIRM=1 — this permanently deletes derived data for all non-consenting members.');
  process.exit(1);
}

await runMigrations(sql);

const CONSENTED = sql`SELECT user_id FROM members WHERE guild_id = ${guildId} AND opted_in = 1 AND opted_out = 0`;

// ── Dry-run counts ────────────────────────────────────────────────────────────
const [{ n: memN }] = await sql`
  SELECT COUNT(*)::int AS n FROM memories
  WHERE guild_id = ${guildId} AND subject_id <> 'server'
    AND subject_id NOT IN (${CONSENTED})
`;
const [{ n: attrN }] = await sql`
  SELECT COUNT(*)::int AS n FROM profile_attributes
  WHERE guild_id = ${guildId} AND subject_id NOT IN (${CONSENTED})
`;
const [{ n: profN }] = await sql`
  SELECT COUNT(*)::int AS n FROM profiles
  WHERE guild_id = ${guildId} AND subject_id NOT IN (${CONSENTED})
`;
const [{ n: obsN }] = await sql`
  SELECT COUNT(*)::int AS n FROM relationship_observations
  WHERE guild_id = ${guildId}
    AND subject_id NOT IN (${CONSENTED}) AND other_id NOT IN (${CONSENTED})
`;
const [{ n: edgeN }] = await sql`
  SELECT COUNT(*)::int AS n FROM relationships
  WHERE guild_id = ${guildId}
    AND subject_id NOT IN (${CONSENTED}) AND other_id NOT IN (${CONSENTED})
`;
console.log(`Purge scope in ${guildId}: ${memN} memories · ${attrN} attributes · ${profN} profiles · ${obsN} observations · ${edgeN} edges`);

// ── Purge (one transaction) ───────────────────────────────────────────────────
await sql.begin(async tx => {
  // Evidence/history hang off memories — delete through the memory set.
  const doomed = tx`SELECT id FROM memories WHERE guild_id = ${guildId} AND subject_id <> 'server' AND subject_id NOT IN (${CONSENTED})`;
  // memory_history.evidence_id FKs to memory_evidence — history must go first,
  // including rows on surviving memories that merely cite doomed evidence.
  await tx`DELETE FROM memory_history WHERE memory_id IN (${doomed})
    OR evidence_id IN (SELECT id FROM memory_evidence WHERE memory_id IN (${doomed}))`;
  await tx`DELETE FROM memory_evidence WHERE memory_id IN (${doomed})`;
  await tx`DELETE FROM memories WHERE id IN (${doomed})`;
  await tx`DELETE FROM profile_attributes WHERE guild_id = ${guildId} AND subject_id NOT IN (${CONSENTED})`;
  await tx`DELETE FROM profiles WHERE guild_id = ${guildId} AND subject_id NOT IN (${CONSENTED})`;
  // Subject-consent: a relationship row survives when either party consented.
  await tx`DELETE FROM relationship_observations WHERE guild_id = ${guildId} AND subject_id NOT IN (${CONSENTED}) AND other_id NOT IN (${CONSENTED})`;
  await tx`DELETE FROM relationships WHERE guild_id = ${guildId} AND subject_id NOT IN (${CONSENTED}) AND other_id NOT IN (${CONSENTED})`;
});

console.log('Purge complete. members/messages archive untouched; server lore and events retained.');
process.exit(0);
