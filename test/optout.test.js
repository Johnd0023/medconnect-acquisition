// Opt-outs: one reply stops every sequence for that person, lands on the opt-out list, and needs no action.
import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.SCHEDULER = 'off';
const { q, one, migrate } = await import('../src/db.js');
const { applyReply, optOutEmail } = await import('../src/engine/replies.js');
const { routes } = await import('../src/api.js');

test('opt-out everywhere and list', async () => {
  await migrate();
  await q('TRUNCATE employers, openings, contacts, sequences, messages, replies, suppressions RESTART IDENTITY CASCADE');
  const e1 = await one(`INSERT INTO employers (name, norm_name, domain) VALUES ('Allina Health Blaine Clinic','allina health blaine clinic','allina.com') RETURNING id`);
  const e2 = await one(`INSERT INTO employers (name, norm_name) VALUES ('Allina Faribault','allina faribault') RETURNING id`);
  const c1 = await one(`INSERT INTO contacts (employer_id, full_name, email) VALUES ($1,'Catherine Gramm','catherine.gramm@allina.com') RETURNING id`, [e1.id]);
  const c2 = await one(`INSERT INTO contacts (employer_id, full_name, email) VALUES ($1,'Catherine Gramm','catherine.gramm@allina.com') RETURNING id`, [e2.id]);
  const other = await one(`INSERT INTO contacts (employer_id, full_name, email) VALUES ($1,'Other Person','other@allina.com') RETURNING id`, [e2.id]);
  const s1 = await one(`INSERT INTO sequences (employer_id, contact_id, step, next_at, status) VALUES ($1,$2,1, now(),'active') RETURNING id`, [e1.id, c1.id]);
  const s2 = await one(`INSERT INTO sequences (employer_id, contact_id, step, next_at, status) VALUES ($1,$2,0, now(),'active') RETURNING id`, [e2.id, c2.id]);
  const s3 = await one(`INSERT INTO sequences (employer_id, contact_id, step, next_at, status, cc_contact_ids) VALUES ($1,$2,0, now(),'active', ARRAY[$3]::int[]) RETURNING id`, [e2.id, other.id, c2.id]);
  const m = await one(`INSERT INTO messages (sequence_id, employer_id, contact_id, step, to_email, subject, body, status) VALUES ($1,$2,$3,0,'catherine.gramm@allina.com','Hi','x','sent') RETURNING *`, [s1.id, e1.id, c1.id]);
  const r = await one(`INSERT INTO replies (employer_id, contact_id, message_id, from_email, subject, body_preview, received_at, category) VALUES ($1,$2,$3,'catherine.gramm@allina.com','RE: Psychiatry','Please remove me from your list\n\nFrom: John', now(),'opt_out') RETURNING *`, [e1.id, c1.id, m.id]);
  await applyReply(r, m);

  const seqs = Object.fromEntries((await q('SELECT id, status, cc_contact_ids FROM sequences')).map((x) => [x.id, x]));
  assert.equal(seqs[s1.id].status, 'stopped');
  assert.equal(seqs[s2.id].status, 'stopped', 'her sequence at another client stops too');
  assert.equal(seqs[s3.id].status, 'active', "the colleague's sequence keeps going");
  assert.deepEqual(seqs[s3.id].cc_contact_ids, [], 'she is removed from the shared email');
  assert.equal((await one('SELECT handled FROM replies WHERE id = $1', [r.id])).handled, true, 'no action needed');

  const list = await routes['GET /api/optouts']({ query: { kind: 'opt' } });
  assert.equal(list.rows.length, 1);
  assert.equal(list.rows[0].name, 'Catherine Gramm');
  assert.equal(list.rows[0].employer, 'Allina Health Blaine Clinic');
  assert.equal(list.rows[0].detail, 'Please remove me from your list');

  await routes['POST /api/optouts']({ body: { email: 'other@allina.com', note: 'Asked by phone' } });
  assert.equal((await one('SELECT status FROM sequences WHERE id = $1', [s3.id])).status, 'stopped');
  assert.equal((await routes['GET /api/optouts']({ query: { kind: 'opt' } })).rows.length, 2);
  const x = await routes['GET /api/optouts/export']({});
  assert.equal(x.__file.data.subarray(0, 2).toString(), 'PK');
  await routes['DELETE /api/optouts/:id']({ params: { id: String(list.rows[0].id) } });
  assert.equal((await routes['GET /api/optouts']({ query: { kind: 'opt' } })).rows.length, 1);
  await assert.rejects(() => optOutEmail('not-an-email'), /valid email/);
});
