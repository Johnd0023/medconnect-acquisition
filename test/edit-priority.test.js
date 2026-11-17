// Per-client email edits, "send first" priority and posting-note client names. WIPES the target database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.SCHEDULER = 'off';
const { q, one, migrate } = await import('../src/db.js');
const { routes } = await import('../src/api.js');
const { compose } = await import('../src/engine/compose.js');
const { getSettings, saveSettings, invalidateSettings } = await import('../src/settings.js');
const { requalify } = await import('../src/engine/qualify.js');

test('edit an email before approving, send first, rename', async () => {
  await migrate();
  await q('TRUNCATE employers, openings, contacts, sequences, messages, replies RESTART IDENTITY CASCADE');
  await q(`UPDATE settings SET data = '{}'::jsonb`); invalidateSettings();
  await saveSettings({ companyAddress: '1440 Coral Ridge Dr, Coral Springs, FL 33071' });
  const e = await one(`INSERT INTO employers (name, norm_name, domain, type, city, state, sources) VALUES ('**OPPORTUNITIES OPEN TO FIRMS**','opportunities open to firms','ecuhealth.org','Hospital / health system','Greenville','NC','{PM}') RETURNING id`);
  const c = await one(`INSERT INTO contacts (employer_id, first_name, last_name, full_name, email, sources) VALUES ($1,'Amanda','Mercer','Amanda Mercer','amanda.mercer@ecuhealth.org','{PM}') RETURNING *`, [e.id]);
  await q(`INSERT INTO openings (employer_id, source, external_id, specialty, role, city, state, contact_email, active, posted_at) VALUES ($1,'PM','1','Cardiology','Physician','Greenville','NC','amanda.mercer@ecuhealth.org',true, now())`, [e.id]);

  // A note in the company field is held for review
  let r = await requalify(e.id);
  assert.ok(r.reasons.some((x) => /looks like a posting note/.test(x)));
  await routes['POST /api/employers/:id/action']({ params: { id: String(e.id) }, body: { action: 'rename', name: 'ECU Health' } });
  r = await requalify(e.id);
  assert.ok(!r.reasons.some((x) => /posting note/.test(x)), 'renamed: no longer held for the name');

  // Starting text: filled in, {{first_name}} kept, typed sign-off removed
  const d0 = await routes['GET /api/employers/:id/draft']({ params: { id: String(e.id) }, query: { step: '0' } });
  assert.match(d0.body, /^Hi \{\{first_name\}\},/);
  assert.match(d0.body, /ECU Health/);
  assert.equal(d0.edited, false);
  await routes['PUT /api/employers/:id/draft']({ params: { id: String(e.id) }, body: { step: 0, subject: 'Your cardiology search, open to firms', body: 'Hi {{first_name}},\n\nSaw your post is open to firms, so reaching out right away.\n\n- Fast – candidates this week' } });
  const emp = await one('SELECT * FROM employers WHERE id = $1', [e.id]);
  const openings = await q('SELECT * FROM openings WHERE employer_id = $1', [e.id]);
  const m = compose(emp, c, openings, 0, await getSettings());
  assert.equal(m.subject, 'Your cardiology search, open to firms');
  assert.match(m.body, /^Hi Amanda,\n\nSaw your post is open to firms/);
  assert.ok(m.edited && m.html.includes('<strong>Fast</strong>'), 'edited text still formatted');
  assert.ok(m.body.includes('John Duva') || m.body.includes('MedConnect Staffing'), 'signature still added');
  const fu = compose(emp, c, openings, 1, await getSettings());
  assert.equal(fu.edited, false, 'other emails keep their template');
  await routes['DELETE /api/employers/:id/draft']({ params: { id: String(e.id) }, query: { step: '0' } });
  assert.equal(compose(await one('SELECT * FROM employers WHERE id = $1', [e.id]), c, openings, 0, await getSettings()).edited, false);

  // Send first: a priority sequence is claimed before older ones
  const e2 = await one(`INSERT INTO employers (name, norm_name) VALUES ('Older Prospect','older prospect') RETURNING id`);
  const c2 = await one(`INSERT INTO contacts (employer_id, email) VALUES ($1,'a@older.org') RETURNING id`, [e2.id]);
  await q(`INSERT INTO sequences (employer_id, contact_id, step, next_at, status) VALUES ($1,$2,0, now() - interval '2 hours','active')`, [e2.id, c2.id]);
  const pri = await one(`INSERT INTO sequences (employer_id, contact_id, step, next_at, status, priority) VALUES ($1,$2,0, now(),'active',1) RETURNING id`, [e.id, c.id]);
  const first = await one(`SELECT s.id FROM sequences s WHERE s.status = 'active' AND s.next_at <= now() ORDER BY s.priority DESC, s.step DESC, s.next_at ASC LIMIT 1`);
  assert.equal(first.id, pri.id);
});
