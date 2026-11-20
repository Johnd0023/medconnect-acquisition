// CommonSpirit MSA campaign: entity matching, separate list, approval before every email. WIPES the target database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.SCHEDULER = 'off';
const { q, one, migrate } = await import('../src/db.js');
const { routes } = await import('../src/api.js');
const { saveSettings, invalidateSettings } = await import('../src/settings.js');
const { enroll, sendTick } = await import('../src/engine/outreach.js');
const { parseFamily, familyMatch, COMMONSPIRIT_FAMILY } = await import('../src/engine/campaigns.js');
const { cfg } = await import('../src/config.js');

test('CommonSpirit campaign', async () => {
  await migrate();
  await q('TRUNCATE employers, openings, contacts, sequences, messages, replies, suppressions, protected_accounts, campaign_contacts RESTART IDENTITY CASCADE');
  await q(`UPDATE settings SET data = '{}'::jsonb`); invalidateSettings();
  await saveSettings({ companyAddress: '100 Main St', sendDays: [0, 1, 2, 3, 4, 5, 6], sendWindowStart: '00:00', sendWindowEnd: '23:59', minGapSeconds: 0, maxGapSeconds: 0, warmup: { enabled: false }, perEmployerPerDay: 5 });
  await q(`INSERT INTO protected_accounts (name, norm_name, domain) VALUES ('CommonSpirit Health','commonspirit health','commonspirit.org'), ('Dignity Health','dignity health','dignityhealth.org')`);
  cfg.dryRun = true;

  const fam = parseFamily(COMMONSPIRIT_FAMILY);
  assert.ok(familyMatch({ employer: { norm_name: 'chi health creighton university medical center' } }, fam));
  assert.ok(familyMatch({ employer: { norm_name: 'dignity health st rose dominican siena' } }, fam));
  assert.equal(familyMatch({ employer: { norm_name: 'mercy clinic springfield' } }, fam), null);
  assert.equal(familyMatch({ employer: { norm_name: 'chicago medical' } }, fam), null, '"CHI *" needs a whole word');

  const mk = async (name, domain, email, fname) => {
    const e = await one(`INSERT INTO employers (name, norm_name, domain, type, sources) VALUES ($1, lower(regexp_replace($1,'[^A-Za-z0-9 ]',' ','g')), $2, 'Hospital / health system', '{PM}') RETURNING *`, [name, domain]);
    if (email) await q(`INSERT INTO contacts (employer_id, first_name, full_name, email, title, sources) VALUES ($1,$2,$3,$4,'Physician Recruiter','{PM}')`, [e.id, fname, fname ? `${fname} Lee` : null, email]);
    await q(`INSERT INTO openings (employer_id, source, external_id, role, specialty, city, state, active, posted_at, contact_email, pm_code) VALUES ($1,'PM',$2,'Physician','Hospitalist','Henderson','NV',true, now(),$3,'OPP1')`, [e.id, String(e.id), email]);
    return e;
  };
  const rose = await mk('Dignity Health St Rose Dominican', 'dignityhealth.org', 'amy.lee@dignityhealth.org', 'Amy');
  await mk('CHI Health Creighton', null, 'abc@practicematch.com', null);
  const conf = await mk('Confidential Hospital', null, 'bo.lee@commonspirit.org', 'Bo');
  await mk('Virginia Mason Franciscan Health', 'vmfh.org', 'gone@vmfh.org', 'Gone');
  await q(`INSERT INTO suppressions (kind, value, reason) VALUES ('email','gone@vmfh.org','Opted out')`);
  await mk('Mercy Clinic', 'mercy.net', 'pat@mercy.net', 'Pat');
  const { requalifyAll } = await import('../src/engine/qualify.js');
  await requalifyAll();

  // Prospect outreach still refuses them
  await assert.rejects(() => enroll(rose.id), /Not ready|Protected/);

  let b = await routes['GET /api/campaigns/:id']({ params: { id: 'commonspirit' } });
  const camp = b.campaign;
  assert.deepEqual(b.rows.map((r) => r.email).sort(), ['amy.lee@dignityhealth.org', 'bo.lee@commonspirit.org']);
  assert.equal(b.counts.review, 2);
  assert.equal(b.noContact.length, 1, 'CHI posting with only a PracticeMatch address');
  assert.equal(b.optedOut, 1);

  // Preview uses the MSA template
  const pv = await routes['GET /api/campaigns/:id/preview']({ params: { id: String(camp.id) }, query: { email: 'amy.lee@dignityhealth.org', step: '0' } });
  assert.match(pv.subject, /^CommonSpirit Health MSA in place/);
  assert.match(pv.body, /^Hi Amy,\n\nWe came across your Hospitalist Physician opening in Henderson, NV on PracticeMatch/);
  assert.match(pv.body, /master services agreement in place with CommonSpirit Health nationwide/);

  // Nothing is queued until approved; skip one
  assert.equal((await sendTick({ force: true })).reason, 'Nothing due');
  await routes['POST /api/campaigns/:id/skip']({ params: { id: String(camp.id) }, body: { emails: ['bo.lee@commonspirit.org'], note: 'Already talking' } });
  await routes['POST /api/campaigns/:id/approve']({ params: { id: String(camp.id) }, body: { emails: ['amy.lee@dignityhealth.org'] } });
  b = await routes['GET /api/campaigns/:id']({ params: { id: 'commonspirit' } });
  assert.equal(b.counts.queued, 1); assert.equal(b.counts.skipped, 1); assert.equal(b.counts.review, 0);

  // Order: "Send first" (⚡) > approved campaign email > regular follow-up
  const pat = await one(`SELECT c.id, c.employer_id FROM contacts c WHERE c.email = 'pat@mercy.net'`);
  const reg = await one(`INSERT INTO sequences (employer_id, contact_id, step, next_at, status) VALUES ($1,$2,1, now() - interval '1 day','active') RETURNING id`, [pat.employer_id, pat.id]);
  const r = await sendTick({ force: true });
  assert.equal(r.sent, true, JSON.stringify(r));
  assert.equal(r.to, 'amy.lee@dignityhealth.org', 'campaign email before a regular follow-up');
  await q(`UPDATE sequences SET status = 'stopped' WHERE id = $1`, [reg.id]);
  const msg = await one(`SELECT * FROM messages WHERE to_email = 'amy.lee@dignityhealth.org'`);
  assert.match(msg.subject, /CommonSpirit Health MSA in place/);
  assert.equal((await one(`SELECT count(*)::int n FROM messages WHERE to_email = 'pat@mercy.net'`)).n, 0);

  // Follow-up waits for approval
  const seq = await one('SELECT * FROM sequences WHERE campaign_id = $1', [camp.id]);
  await q(`UPDATE sequences SET status = 'active', step = 1, next_at = now() - interval '1 minute', claimed_at = NULL WHERE id = $1`, [seq.id]);
  assert.equal((await sendTick({ force: true })).reason, 'Nothing due', 'follow-up held for approval');
  b = await routes['GET /api/campaigns/:id']({ params: { id: 'commonspirit' } });
  assert.equal(b.counts.followup, 1);
  await routes['POST /api/campaigns/:id/approveFollowUps']({ params: { id: String(camp.id) }, body: { seqIds: [seq.id] } });
  const r2 = await sendTick({ force: true });
  assert.equal(r2.sent, true, JSON.stringify(r2));

  // Paused campaign sends nothing
  await routes['PUT /api/campaigns/:id']({ params: { id: String(camp.id) }, body: { active: false } });
  await routes['POST /api/campaigns/:id/unskip']({ params: { id: String(camp.id) }, body: { emails: ['bo.lee@commonspirit.org'] } });
  await routes['POST /api/campaigns/:id/approve']({ params: { id: String(camp.id) }, body: { emails: ['bo.lee@commonspirit.org'] } });
  assert.equal((await sendTick({ force: true })).reason, 'Nothing due');
  await routes['PUT /api/campaigns/:id']({ params: { id: String(camp.id) }, body: { active: true } });
  assert.equal((await sendTick({ force: true })).sent, true);
  void conf;

  // Live: Outlook is searched right before sending; new email since approval puts it back to the owner
  const { encrypt } = await import('../src/util.js');
  let history = [];
  let posted = 0;
  globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(url);
    const json = (status, obj) => new Response(obj === null ? null : JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
    if (u.host === 'login.microsoftonline.com') return json(200, { access_token: 'AT', refresh_token: 'RT2', expires_in: 3600 });
    const p = u.pathname.replace('/v1.0', '');
    if (p === '/me/messages' && (opts.method || 'GET') === 'GET') return json(200, { value: history });
    if (p === '/me/messages' && opts.method === 'POST') { posted++; return json(201, { id: `d${posted}`, conversationId: `c${posted}`, internetMessageId: `<m${posted}@mc>` }); }
    if (/\/send$/.test(p)) return json(202, null);
    throw new Error(`Unmocked fetch ${url}`);
  };
  await q(`INSERT INTO oauth_tokens (provider, account_email, refresh_token_enc, access_token_enc, expires_at) VALUES ('microsoft','john@medconnectstaffing.com',$1,$2, now() + interval '1 hour') ON CONFLICT (provider) DO UPDATE SET refresh_token_enc = EXCLUDED.refresh_token_enc, access_token_enc = EXCLUDED.access_token_enc, expires_at = EXCLUDED.expires_at`, [encrypt('RT1'), encrypt('AT')]);
  cfg.dryRun = false;
  const e3 = await mk('CHI St. Vincent Infirmary', 'chistvincent.com', 'kim.lee@chistvincent.com', 'Kim');
  void e3;
  await routes['POST /api/campaigns/:id/approve']({ params: { id: String(camp.id) }, body: { emails: ['kim.lee@chistvincent.com'] } });
  history = [{ id: 'x', subject: 'RE: Ortho candidates', from: { emailAddress: { address: 'kim.lee@chistvincent.com' } }, toRecipients: [], receivedDateTime: new Date(Date.now() + 60000).toISOString(), internetMessageId: '<theirs@x>', conversationId: 'cv' }];
  const held = await sendTick({ force: true });
  assert.equal(held.reason, 'held for owner review');
  const hs = await one(`SELECT s.* FROM sequences s JOIN contacts c ON c.id = s.contact_id WHERE c.email = 'kim.lee@chistvincent.com'`);
  assert.equal(hs.approved_step, -1); assert.match(hs.hold_note, /New Outlook email/);
  assert.equal(posted, 0, 'nothing sent');
  b = await routes['GET /api/campaigns/:id']({ params: { id: 'commonspirit' } });
  assert.equal(b.rows.find((x) => x.email === 'kim.lee@chistvincent.com').outlook.total, 1);
  cfg.dryRun = true;
});

test('send-first beats the campaign', async () => {
  const { q, one } = await import('../src/db.js');
  const { sendTick } = await import('../src/engine/outreach.js');
  const camp = await one(`SELECT id FROM campaigns WHERE slug = 'commonspirit'`);
  await q(`UPDATE sequences SET status = 'stopped' WHERE status IN ('active','paused')`);
  await q(`DELETE FROM messages`);
  const amy = await one(`SELECT id, employer_id FROM contacts WHERE email = 'amy.lee@dignityhealth.org'`);
  const pat = await one(`SELECT id, employer_id FROM contacts WHERE email = 'pat@mercy.net'`);
  await q(`INSERT INTO sequences (employer_id, contact_id, step, next_at, status, campaign_id, approved_step, approved_at) VALUES ($1,$2,1, now(),'active',$3,1, now())`, [amy.employer_id, amy.id, camp.id]);
  await q(`INSERT INTO sequences (employer_id, contact_id, step, next_at, status, priority) VALUES ($1,$2,0, now(),'active',1)`, [pat.employer_id, pat.id]);
  const r = await sendTick({ force: true });
  assert.equal(r.to, 'pat@mercy.net', '⚡ Send first goes before the campaign');
  const r2 = await sendTick({ force: true });
  assert.equal(r2.to, 'amy.lee@dignityhealth.org');
});
