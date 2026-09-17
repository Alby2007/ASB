import 'dotenv/config';
import postgres from 'postgres';
const sql = postgres(process.env.DATABASE_URL, {max: 1, onnotice: () => {}});

// Messages that produced evidence (were extracted from)
const extracted = await sql`SELECT COUNT(DISTINCT message_id) as c FROM memory_evidence`;
console.log('messages with evidence rows:', extracted[0].c);

// Messages that were archived
const total = await sql`SELECT COUNT(*) as c FROM messages`;
console.log('total archived messages:', total[0].c);

// Messages that passed the pre-filter (rough approximation — we can't replay
// the regex in SQL, but we can look at what has evidence vs not)
// The real question: of messages that DIDN'T get extracted, how many look
// like they should have? Sample some skipped messages:
const skipped = await sql`
  SELECT author_name, content
  FROM messages
  WHERE id NOT IN (SELECT DISTINCT message_id FROM memory_evidence)
  ORDER BY created_at DESC
  LIMIT 30
`;
console.log('\n--- last 30 skipped messages ---');
skipped.forEach(r => console.log(`${r.author_name}: ${r.content.slice(0,80)}`));
await sql.end();
