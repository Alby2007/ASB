import 'dotenv/config';
import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL, { max: 1, onnotice: () => {} });

// Merge #102 (paarth's post-denial self-correction) into #43:
// reattach its evidence row as correction evidence on #43, then supersede #102.
await sql`UPDATE memory_evidence SET memory_id = 43 WHERE memory_id = 102`;
await sql`UPDATE memories SET status = 'active', confidence = 0.8, updated_at = NOW() WHERE id = 43`;
await sql`INSERT INTO memory_history (memory_id, action, previous_confidence, new_confidence, previous_status, new_status, evidence_id, details_json)
  VALUES (43, 'contest_resolved', 0.35, 0.8, 'contested', 'active', NULL, ${JSON.stringify({
    reason: "subject initially denied ('I didn't mention low iron once'), then self-corrected after finding the original message: 'Correction: I did say my iron always be low asf. add that to the memory'. Evidence merged from #102."
  })})`;
await sql`UPDATE memories SET status = 'superseded', updated_at = NOW() WHERE id = 102`;
await sql`INSERT INTO memory_history (memory_id, action, previous_confidence, new_confidence, previous_status, new_status, evidence_id, details_json)
  VALUES (102, 'supersede', 0.62, 0.62, 'candidate', 'superseded', NULL, ${JSON.stringify({
    reason: 'duplicate of #43 — its evidence row (subject self-correction) merged into #43'
  })})`;

const check = await sql`SELECT id, subject_name, status, confidence, content FROM memories WHERE id IN (43, 89, 102)`;
check.forEach(r => console.log(JSON.stringify(r)));
await sql.end();
