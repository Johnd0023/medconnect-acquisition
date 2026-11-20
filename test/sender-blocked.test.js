// A Microsoft mailbox restriction (550 5.1.8) pauses everything and never opts the recipient out. WIPES the target database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.SCHEDULER = 'off';
const { q, one, migrate, kvGet, kvSet } = await import('../src/db.js');
const { repairSenderBlockBounces, bounceGuard, classify } = await import('../src/engine/replies.js');
const { sendState, clearSendBlock } = await import('../src/engine/outreach.js');
const { saveSettings, invalidateSettings } = await import('../src/settings.js');

test('mailbox restriction is not a bounce', async () => {
  await migrate();
  await q('TRUNCATE employers, openings, contacts, sequences, messages, replies, suppressions RESTART IDENTITY CASCADE');
  await q(`UPDATE settings SET data = '{}'::jsonb`); invalidateSettings();
  await kvSet('send_blocked', null); await kvSet('cooldown_until', null);
  const ndr = "Your message couldn't be delivered. Remote Server returned '550 5.1.8 Access denied, bad outbound sender'";
  assert.equal(classify('Undeliverable: Hospitalist opening', ndr), 'sender_blocked');

  // An old NDR that was filed as a bounce gets repaired
  const e = await one(`INSERT INTO employers (name, norm_name) VALUES ('Mercy','mercy') RETURNING id`);
  const c = await one(`INSERT INTO contacts (employer_id, full_name, email, bad) VALUES ($1,'Amy','amy@mercy.net', true) RETURNING id`, [e.id]);
  const s = await one(`INSERT INTO sequences (employer_id, contact_id, step, next_at, status, stop_reason) VALUES ($1,$2,1, now(),'stopped','Email bounced') RETURNING id`, [e.id, c.id]);
  const m = await one(`INSERT INTO messages (sequence_id, employer_id, contact_id, step, to_email, subject, body, status) VALUES ($1,$2,$3,0,'amy@mercy.net','Hi','x','sent') RETURNING id`, [s.id, e.id, c.id]);
  await q(`INSERT INTO suppressions (kind, value, reason) VALUES ('email','amy@mercy.net','Bounced')`);
  await q(`INSERT INTO replies (employer_id, contact_id, message_id, from_email, subject, body_preview, received_at, category) VALUES ($1,$2,$3,'postmaster@x','Undeliverable: Hi',$4, now(),'bounce')`, [e.id, c.id, m.id, ndr]);
  assert.equal(await repairSenderBlockBounces(), 1);
  assert.equal((await one(`SELECT count(*)::int n FROM suppressions`)).n, 0, 'taken off the opt-out list');
  assert.equal((await one('SELECT bad FROM contacts WHERE id = $1', [c.id])).bad, false);
  const after = await one('SELECT * FROM sequences WHERE id = $1', [s.id]);
  assert.equal(after.status, 'active'); assert.equal(after.step, 0, 'the undelivered email goes again');
  assert.equal((await one('SELECT status FROM messages WHERE id = $1', [m.id])).status, 'failed');
  assert.ok(await kvGet('cooldown_until'), 'half-cap cooldown starts');

  // Half cap during cooldown, hourly cap
  await saveSettings({ dailyCap: 40, warmup: { enabled: false }, hourlyCap: 2, sendDays: [0, 1, 2, 3, 4, 5, 6], sendWindowStart: '00:00', sendWindowEnd: '23:59' });
  let st = await sendState();
  assert.equal(st.cap, 20);
  await q(`INSERT INTO messages (employer_id, contact_id, step, to_email, subject, body, status) VALUES ($1,$2,0,'a@b.c','s','b','sent'), ($1,$2,0,'a@b.c','s','b','sent')`, [e.id, c.id]);
  st = await sendState();
  assert.match(st.reason, /Hourly limit reached/);

  // Bounce spike pauses sending
  for (let i = 0; i < 3; i++) await q(`INSERT INTO replies (from_email, subject, body_preview, received_at, category) VALUES ('pm@x','Undeliverable','550 5.1.1 user unknown', now(),'bounce')`);
  assert.equal(await bounceGuard(), true);
  assert.equal((await kvGet('send_blocked')).kind, 'bounces');
  await clearSendBlock();
  await kvSet('cooldown_until', null);
});
