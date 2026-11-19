// Out-of-office replies push the next email out 7 days and need no action.
import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.SCHEDULER = 'off';
const { q, one, migrate } = await import('../src/db.js');
const { applyReply } = await import('../src/engine/replies.js');

test('ooo auto-resumes in 7 days', async () => {
  await migrate();
  await q('TRUNCATE employers, openings, contacts, sequences, messages, replies, suppressions RESTART IDENTITY CASCADE');
  const e = await one(`INSERT INTO employers (name, norm_name) VALUES ('Mercy Clinic','mercy clinic') RETURNING id`);
  const c = await one(`INSERT INTO contacts (employer_id, full_name, email) VALUES ($1,'Amy Clem','amy@mercy.net') RETURNING id`, [e.id]);
  const s = await one(`INSERT INTO sequences (employer_id, contact_id, step, next_at, status) VALUES ($1,$2,1, now() + interval '2 days','active') RETURNING id`, [e.id, c.id]);
  const m = await one(`INSERT INTO messages (sequence_id, employer_id, contact_id, step, to_email, subject, body, status) VALUES ($1,$2,$3,0,'amy@mercy.net','Hi','x','sent') RETURNING *`, [s.id, e.id, c.id]);
  const r = await one(`INSERT INTO replies (employer_id, contact_id, message_id, from_email, subject, body_preview, received_at, category) VALUES ($1,$2,$3,'amy@mercy.net','Automatic reply: Psychiatry','I am out of the office with limited access to email.', now(),'ooo') RETURNING *`, [e.id, c.id, m.id]);
  await applyReply(r, m);
  const after = await one('SELECT status, next_at, replied FROM sequences WHERE id = $1', [s.id]);
  assert.equal(after.status, 'active');
  const days = (new Date(after.next_at) - Date.now()) / 864e5;
  assert.ok(days > 6.9 && days < 7.1, `next send in ~7 days, got ${days}`);
  assert.equal((await one('SELECT handled FROM replies WHERE id = $1', [r.id])).handled, true);
});
