// A reply ends every sequence that would email that person again. WIPES the target database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.SCHEDULER = 'off';
const { q, one, migrate } = await import('../src/db.js');
const { applyReply } = await import('../src/engine/replies.js');
const { sendTick } = await import('../src/engine/outreach.js');
const { saveSettings, invalidateSettings } = await import('../src/settings.js');
const { cfg } = await import('../src/config.js');

test('reply stops all sequences for that person', async () => {
  await migrate();
  await q('TRUNCATE employers, openings, contacts, sequences, messages, replies, suppressions RESTART IDENTITY CASCADE');
  await q(`UPDATE settings SET data = '{}'::jsonb`); invalidateSettings();
  await saveSettings({ companyAddress: '1 Main St', sendDays: [0, 1, 2, 3, 4, 5, 6], sendWindowStart: '00:00', sendWindowEnd: '23:59', minGapSeconds: 0, maxGapSeconds: 0, warmup: { enabled: false }, hourlyCap: 50 });
  cfg.dryRun = true;
  const mk = async (name) => one(`INSERT INTO employers (name, norm_name, type) VALUES ($1, lower($1), 'Hospital / health system') RETURNING id`, [name]);
  const a = await mk('Mercy North'); const b = await mk('Mercy South');
  const ca = await one(`INSERT INTO contacts (employer_id, first_name, full_name, email) VALUES ($1,'Amy','Amy Lee','amy@mercy.net') RETURNING id`, [a.id]);
  const cb = await one(`INSERT INTO contacts (employer_id, first_name, full_name, email) VALUES ($1,'Amy','Amy Lee','amy@mercy.net') RETURNING id`, [b.id]);
  const sa = await one(`INSERT INTO sequences (employer_id, contact_id, step, next_at, status, started_at) VALUES ($1,$2,1, now() + interval '2 days','active', now() - interval '3 days') RETURNING *`, [a.id, ca.id]);
  const sb = await one(`INSERT INTO sequences (employer_id, contact_id, step, next_at, status, started_at) VALUES ($1,$2,1, now() + interval '2 days','active', now() - interval '3 days') RETURNING *`, [b.id, cb.id]);
  const m = await one(`INSERT INTO messages (sequence_id, employer_id, contact_id, step, to_email, subject, body, status) VALUES ($1,$2,$3,0,'amy@mercy.net','Hi','x','sent') RETURNING *`, [sa.id, a.id, ca.id]);
  const r = await one(`INSERT INTO replies (employer_id, contact_id, message_id, from_email, subject, body_preview, received_at, category) VALUES ($1,$2,$3,'amy@mercy.net','RE: Hi','Thanks, we are covered for now', now(),'not_now') RETURNING *`, [a.id, ca.id, m.id]);
  await applyReply(r, m);
  for (const id of [sa.id, sb.id]) assert.equal((await one('SELECT status FROM sequences WHERE id = $1', [id])).status, 'stopped', `sequence ${id} stopped`);

  // Last-moment guard: a reply already logged stops a due follow-up instead of sending it
  const c2 = await one(`INSERT INTO contacts (employer_id, first_name, full_name, email) VALUES ($1,'Bo','Bo King','bo@mercy.net') RETURNING id`, [b.id]);
  const s2 = await one(`INSERT INTO sequences (employer_id, contact_id, step, next_at, status, started_at) VALUES ($1,$2,1, now() - interval '1 minute','active', now() - interval '3 days') RETURNING id`, [b.id, c2.id]);
  await q(`INSERT INTO replies (from_email, subject, body_preview, received_at, category) VALUES ('bo@mercy.net','RE: Hi','Call me', now() - interval '1 hour','interested')`);
  const t = await sendTick({ force: true });
  assert.match(t.reason, /replied/);
  assert.equal((await one('SELECT status FROM sequences WHERE id = $1', [s2.id])).status, 'stopped');
  assert.equal((await one(`SELECT count(*)::int n FROM messages WHERE to_email = 'bo@mercy.net'`)).n, 0);
});
