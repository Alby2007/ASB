import postgres from 'postgres';

// Requeue dead-lettered jobs: resets attempts so the worker's next claim pass
// picks them up. Run after fixing whatever killed them — 'dead' triage marks
// need no resetting; a successful re-run overwrites them with 'extracted'.
// GUILD_ID scopes the requeue to one guild; unset requeues every guild.
//
//   GUILD_ID=123... tsx scripts/requeue-dead-jobs.mjs   # one guild
//   tsx scripts/requeue-dead-jobs.mjs                   # all guilds
//
// attempts >= 5 mirrors MAX_JOB_ATTEMPTS in src/jobs.ts.

const sql = postgres(process.env.DATABASE_URL, { max: 1, onnotice: () => {} });
const guildId = process.env.GUILD_ID;

const rows = guildId
  ? await sql`UPDATE jobs SET attempts = 0, run_after = now() WHERE attempts >= 5 AND guild_id = ${guildId} RETURNING id, guild_id, type`
  : await sql`UPDATE jobs SET attempts = 0, run_after = now() WHERE attempts >= 5 RETURNING id, guild_id, type`;

console.log(`Requeued ${rows.length} dead-lettered job${rows.length === 1 ? '' : 's'}${guildId ? ` for guild ${guildId}` : ''}`);
for (const r of rows) console.log(`  job ${r.id} (${r.type}) guild ${r.guild_id}`);
await sql.end();
process.exit(0);
