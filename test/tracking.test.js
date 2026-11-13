// Open/click tracking and the daily email health check. WIPES the target database.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.SCHEDULER = 'off';
process.env.APP_URL = process.env.APP_URL || 'http://localhost:3999';

const { q, one, migrate, kvGet, kvSet } = await import('../src/db.js');
const { instrument, recordEvent, engagement } = await import('../src/tracking.js');
const { runHealthCheck, healthHistory } = await import('../src/health.js');
const { getSettings, invalidateSettings } = await import('../src/settings.js');
const { cfg } = await import('../src/config.js');

const req = (ua) => ({ headers: { 'user-agent': ua, 'x-forwarded-for': '203.0.113.5' }, socket: {} });
const HUMAN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';

test('open and click tracking, machine filtering, health score', async () => {
  await migrate();
  await q('TRUNCATE employers, openings, contacts, sequences, messages, replies, suppressions, events, kv, domain_health RESTART IDENTITY CASCADE');
  await q(`UPDATE settings SET data = '{}'::jsonb`); invalidateSettings();
  const s = await getSettings();

  // instrument(): pixel + token on our brochure link, other links untouched
  const html = `<p><a href="${cfg.appUrl}/b/AbCdEfGh12/Brochure.pdf">here</a> <a href="https://medconnectstaffing.com">site</a></p>`;
  const out = instrument(html, 'tok_1234567890', s);
  assert.ok(out.includes(`/b/AbCdEfGh12/Brochure.pdf?m=tok_1234567890`));
  assert.ok(out.includes('href="https://medconnectstaffing.com"'));
  assert.ok(out.includes(`${cfg.appUrl}/o/tok_1234567890.gif`));
  assert.ok(!instrument(html, 'tok_1234567890', { ...s, tracking: { opens: false, clicks: false } }).includes('/o/'), 'tracking can be turned off');

  const e = await one(`INSERT INTO employers (name, norm_name) VALUES ('Christus Health','christus health') RETURNING id`);
  const c = await one(`INSERT INTO contacts (employer_id, email) VALUES ($1,'liz@christushealth.org') RETURNING id`, [e.id]);
  const mk = async (tok, minsAgo) => one(`INSERT INTO messages (employer_id, contact_id, step, to_email, subject, body, status, track_token, sent_at)
    VALUES ($1,$2,0,'liz@christushealth.org','Hi','x','sent',$3, now() - make_interval(mins => $4)) RETURNING id`, [e.id, c.id, tok, minsAgo]);
  await mk('tok_scanned_000', 0);
  await mk('tok_human_00001', 30);
  await mk('tok_unopened_01', 30);

  // A security scanner opens instantly; a person opens later and clicks the brochure
  await recordEvent('tok_scanned_000', 'open', req(HUMAN));
  await recordEvent('tok_human_00001', 'open', req('Mimecast URL Protect'));
  await recordEvent('tok_human_00001', 'open', req(HUMAN));
  await recordEvent('tok_human_00001', 'click', req(HUMAN));
  assert.equal(await recordEvent('not-a-real-token-x', 'open', req(HUMAN)), null);
  const machine = await one(`SELECT count(*) FILTER (WHERE machine)::int AS m, count(*)::int AS n FROM email_events`);
  assert.deepEqual(machine, { m: 2, n: 4 });
  const eng = await engagement(7);
  assert.equal(eng.tracked, 3); assert.equal(eng.opened, 1); assert.equal(eng.clicked, 1);

  // Health check runs (DNS may be unavailable here) and stores a dated score
  let h = await runHealthCheck();
  assert.ok(h.score >= 0 && h.score <= 100);
  assert.ok(h.checks.some((x) => x.group === 'Authentication') && h.checks.some((x) => x.group === 'Blocklists'));
  assert.equal((await healthHistory(30)).length, 1);
  assert.equal(await kvGet('send_blocked'), null, 'no pause without problems');

  // Repeated spam-filter rejections pause sending
  for (let i = 0; i < 3; i++) await q(`INSERT INTO replies (employer_id, from_email, subject, body_preview, received_at, category) VALUES ($1,'postmaster@x.org','Undeliverable','550 5.7.1 Message rejected as spam by Content Filtering', now(), 'bounce')`, [e.id]);
  h = await runHealthCheck();
  assert.ok(h.checks.find((x) => x.label.startsWith('No spam')).points === 0);
  assert.match((await kvGet('send_blocked')).reason, /spam-filter rejections/);
  assert.equal((await healthHistory(30)).length, 1, 'one row per day');
  await kvSet('send_blocked', null);
});
