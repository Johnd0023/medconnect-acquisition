// PracticeMatch scan → consolidation by contact → one sequence per contact → correct subjects.
// Mocks practicematch.com and Microsoft Graph at the fetch layer. WIPES the target database.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.SCHEDULER = 'off';
process.env.MS_CLIENT_ID = 'cid'; process.env.MS_CLIENT_SECRET = 'csecret';

const enc = (e) => e.replace('@', '&#x40;');
const jobPage = ({ id, code, title, org, site, city, st, email, candidate = 'MD, DO' }) => `<!doctype html><html><head>
<script type="application/ld+json">${JSON.stringify({ '@context': 'http://schema.org', '@type': 'JobPosting', title, datePosted: '2026-11-11',
  hiringOrganization: { '@type': 'Organization', name: org, ...(site ? { sameAs: site } : {}) },
  identifier: { '@type': 'PropertyValue', name: 'PracticeMatch', value: code },
  jobLocation: { '@type': 'Place', address: { addressLocality: city, addressRegion: st } }, description: '<p>Great role.</p>' })}</script></head>
<body><select><option>Certified Registered Nurse Anesthetist</option></select><h1>${title}</h1><div>CANDIDATE TYPE\n${candidate}</div>
<a id="clickToEmail" data-oid="${id}" href="mailto:${enc(email)}?subject=Opportunity ${code}">Click to email</a>
<p>This site is only intended for job seekers.</p></body></html>`;

const JOBS = {
  physicians: [
    { id: '1176353', code: '1176353MS', title: 'Critical Care | $480K Base', org: 'Maury Regional Medical Group', city: 'Columbia', st: 'TN', email: 'mnstelmat@practicematch.com', spec: 'critical-care-medicine' },
    { id: '1176070', code: '1176070MS', title: 'Hematology/Medical Oncology', org: 'Sky Lakes Medical Center', city: 'Klamath Falls', st: 'OR', email: 'mnstelmat@practicematch.com', spec: 'hematology-oncology' },
    { id: '1176074', code: '1176074MS', title: 'Emergency Medicine Physician', org: 'Sky Lakes Medical Center', city: 'Klamath Falls', st: 'OR', email: 'mnstelmat@practicematch.com', spec: 'emergency-medicine' },
    { id: '1134487', code: '1134487RF', title: 'Hospice (MD/DO) – Full-Time', org: 'Health First Medical Group', site: 'https://hf.org/', city: 'Melbourne', st: 'FL', email: 'robert.ferreri@hf.org', spec: 'hospice-palliative-medicine' },
    { id: '1171977', code: '1171977MS', title: 'Clinical Psychologist (Psychologist II)', org: 'Terrell Center for Youth', city: 'Terrell', st: 'TX', email: 'mnstelmat@practicematch.com', spec: 'behavioral-health' },
  ],
  'advanced-practitioners': [
    { id: '1176755', code: '1176755KS', title: 'Experienced Urgent Care Nurse Practitioner or Physician Assistant', org: 'ThedaCare Urgent Care-Neenah', site: 'https://thedacare.org/', city: 'Neenah', st: 'WI', email: 'kristen.stumpf@thedacare.org', spec: 'urgent-care', candidate: '' },
    { id: '1176754', code: '1176754KS', title: 'Experienced Urgent Care Nurse Practitioner or Physician Assistant', org: 'ThedaCare Urgent Care-Appleton', city: 'Appleton', st: 'WI', email: 'kristen.stumpf@thedacare.org', spec: 'urgent-care', candidate: '' },
    { id: '1173489', code: '1173489KS', title: 'Family Medicine Nurse Practitioner', org: 'ThedaCare Physicians-Oshkosh', city: 'Oshkosh', st: 'WI', email: 'kristen.stumpf@thedacare.org', spec: 'family-medicine', candidate: '' },
    { id: '999001', code: 'JR25-22161', title: 'Pediatric CRNA - Certified Registered Nurse Anesthetist', org: 'WVU Medicine J.W. Ruby Memorial Hospital', city: 'Morgantown', st: 'WV', email: 'michael.addis@wvumedicine.org', spec: 'anesthesiology', candidate: '' },
  ],
};
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const pathOf = (board, j) => `/${board}/job-details.cfm/${j.id}/${j.spec}/${slug(j.st)}/${slug(j.city)}/${slug(j.org)}/`;
const listPage = (board, page) => page > 1 ? '<html><body>No more</body></html>'
  : `<html><body>${JOBS[board].map((j) => `<a href="${pathOf(board, j)}">View Job</a><a href="${pathOf(board, j)}">${j.title}</a>`).join('')}</body></html>`;

const calls = []; let draftSeq = 0;
globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  calls.push({ method: opts.method || 'GET', url: u.pathname + u.search, body: opts.body && typeof opts.body === 'string' ? JSON.parse(opts.body) : null });
  const html = (b) => new Response(b, { status: 200, headers: { 'content-type': 'text/html' } });
  const json = (status, obj) => new Response(obj === null ? null : JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
  if (u.host === 'www.practicematch.com') {
    const lm = u.pathname.match(/^\/(physicians|advanced-practitioners)\/jobs\/$/);
    if (lm) return html(listPage(lm[1], Number(u.searchParams.get('page_id') || 1)));
    for (const [board, list] of Object.entries(JOBS)) for (const j of list) if (u.pathname === pathOf(board, j)) return html(jobPage(j));
    return new Response('nf', { status: 404 });
  }
  if (u.host === 'login.microsoftonline.com') return json(200, { access_token: 'AT', refresh_token: 'RT2', expires_in: 3600 });
  if (u.host === 'graph.microsoft.com') {
    const p = u.pathname.replace('/v1.0', '');
    const body = opts.body ? JSON.parse(opts.body) : null;
    if (p === '/me/messages' && opts.method === 'POST') { draftSeq++; return json(201, { id: `d${draftSeq}`, conversationId: `c${draftSeq}`, internetMessageId: `<m${draftSeq}@mc>`, _to: body.toRecipients[0].emailAddress.address }); }
    if (/\/send$/.test(p)) return json(202, null);
  }
  throw new Error(`Unmocked fetch ${url}`);
};

const { q, one, migrate } = await import('../src/db.js');
const { cfg } = await import('../src/config.js');
const { saveSettings, invalidateSettings } = await import('../src/settings.js');
const { runPracticeMatchScan } = await import('../src/engine/discovery.js');
const { enroll, sendTick } = await import('../src/engine/outreach.js');
const { routes } = await import('../src/api.js');
const { encrypt } = await import('../src/util.js');

test('PracticeMatch scan, consolidation and one sequence per contact', async () => {
  await migrate();
  await q('TRUNCATE employers, openings, contacts, sequences, messages, replies, suppressions, protected_accounts, tasks, events, job_runs, lusha_usage, oauth_tokens, kv, meetings RESTART IDENTITY CASCADE');
  await q(`UPDATE settings SET data = '{}'::jsonb`); invalidateSettings();
  await saveSettings({ companyAddress: '100 Main St, Columbus, OH 43215', practicematch: { delayMs: 800, mode: 'server' }, sendDays: [0, 1, 2, 3, 4, 5, 6], sendWindowStart: '00:00', sendWindowEnd: '23:59', minGapSeconds: 0, maxGapSeconds: 0, warmup: { enabled: false } });

  const r = await runPracticeMatchScan({});
  assert.equal(r.listings, 9, 'every role kept by default');
  const emps = await q('SELECT id, name, sources FROM employers ORDER BY id');
  const names = emps.map((e) => e.name);
  // Shared PracticeMatch forwarding address: separate clients
  assert.ok(names.includes('Maury Regional Medical Group') && names.includes('Sky Lakes Medical Center'));
  // Same direct recruiter across three ThedaCare sites: one client
  assert.equal(names.filter((n) => /ThedaCare/.test(n)).length, 1, 'ThedaCare sites consolidated under one contact');
  assert.ok(names.includes('Terrell Center for Youth'), 'non-provider roles kept at healthcare facilities');
  assert.equal((await one(`SELECT role FROM openings WHERE external_id = '1171977'`)).role, 'Psychologist');
  const theda = emps.find((e) => /ThedaCare/.test(e.name));
  assert.equal(Number((await one('SELECT count(*) n FROM openings WHERE employer_id = $1', [theda.id])).n), 3);
  const sky = emps.find((e) => e.name === 'Sky Lakes Medical Center');
  assert.equal(Number((await one('SELECT count(*) n FROM openings WHERE employer_id = $1', [sky.id])).n), 2);
  const relayContacts = await q(`SELECT employer_id FROM contacts WHERE email = 'mnstelmat@practicematch.com'`);
  assert.equal(relayContacts.length, 3, 'forwarding address stored once per client (Maury, Sky Lakes, Terrell)');
  const crna = await one(`SELECT role FROM openings WHERE external_id = '999001'`);
  assert.equal(crna.role, 'CRNA');
  const np = await one(`SELECT role FROM openings WHERE external_id = '1173489'`);
  assert.equal(np.role, 'Nurse Practitioner');
  const req = await one(`SELECT pm_code FROM openings WHERE external_id = '999001'`);
  assert.equal(req.pm_code, 'JR25-22161');

  // Re-scan: nothing new, no duplicate openings
  const r2 = await runPracticeMatchScan({});
  assert.equal(r2.listings, 0, 'already-seen postings are not reopened');

  // Approve + enroll everything
  await routes['POST /api/queue/bulk']({ body: { action: 'approveClean' } });
  const en = await routes['POST /api/queue/bulk']({ body: { action: 'enrollReady' } });
  assert.match(en.message, /^6 enrolled/, 'Maury, Sky Lakes, Health First, ThedaCare, WVU, Terrell each once');

  // A second ThedaCare record with the same recruiter cannot start another sequence
  const extra = await one(`INSERT INTO employers (name, norm_name, type, sources, decision) VALUES ('ThedaCare Extra', 'thedacare extra', 'Urgent care / outpatient', ARRAY['PM'], 'approved') RETURNING id`);
  await q(`INSERT INTO contacts (employer_id, full_name, email, title, sources) VALUES ($1, 'Kristen Stumpf', 'kristen.stumpf@thedacare.org', 'Recruiter', ARRAY['PM'])`, [extra.id]);
  await assert.rejects(() => enroll(extra.id), /already contacted/);

  // Live send: subjects
  cfg.dryRun = false;
  await q(`INSERT INTO oauth_tokens (provider, account_email, refresh_token_enc, access_token_enc, expires_at) VALUES ('microsoft','bizdev@medconnectstaffing.com',$1,$2, now() + interval '1 hour')`, [encrypt('RT1'), encrypt('AT')]);
  for (let i = 0; i < 8; i++) await sendTick({ force: true });
  const sent = await q(`SELECT to_email, subject, body FROM messages WHERE status = 'sent' ORDER BY id`);
  assert.equal(sent.length, 6);
  const maury = sent.find((m) => /Maury/.test(m.subject) || m.body.includes('Maury'));
  assert.match(maury.subject, /^Opportunity 1176353MS \| /, 'forwarding address keeps the Opportunity code');
  assert.match(maury.body, /^Hi there,/, 'no name on a forwarding address');
  const skyMsg = sent.filter((m) => m.to_email === 'mnstelmat@practicematch.com' && m.body.includes('Sky Lakes'));
  assert.equal(skyMsg.length, 1, 'one email for Sky Lakes despite two openings');
  assert.match(skyMsg[0].subject, /^Opportunity 117607[04]MS \| /);
  const hf = sent.find((m) => m.to_email === 'robert.ferreri@hf.org');
  assert.doesNotMatch(hf.subject, /^Opportunity/, 'direct recruiter gets a normal subject');
  assert.match(hf.body, /^Hi Robert,/);
  const td = sent.filter((m) => m.to_email === 'kristen.stumpf@thedacare.org');
  assert.equal(td.length, 1, 'ThedaCare recruiter emailed once');
});

test('protected-client guardrail blocks every route right before sending', async () => {
  const { protectedRecipientMatch, loadContext } = await import('../src/engine/qualify.js');
  await q(`DELETE FROM messages`); await q(`DELETE FROM sequences`);
  await q(`UPDATE employers SET decision = 'approved'`);
  // Fresh prospects from three routes
  const mk = async (name, domain, email, sourceOrg, contactName) => {
    const e = await one(`INSERT INTO employers (name, norm_name, domain, type, sources, decision) VALUES ($1, lower(regexp_replace($1,'[^A-Za-z0-9 ]',' ','g')), $2, 'Hospital / health system', ARRAY['PM'], 'approved') RETURNING *`, [name, domain]);
    await q(`INSERT INTO contacts (employer_id, first_name, full_name, email, title, sources) VALUES ($1, $2, $3, $4, 'Physician Recruiter', ARRAY['PM'])`, [e.id, contactName, contactName || name, email]);
    await q(`INSERT INTO openings (employer_id, source, external_id, role, specialty, city, state, raw, pm_code, contact_email) VALUES ($1,'PM',$2,'Physician','Hospitalist','X','TX',$3::jsonb,$4,$5)`,
      [e.id, String(Math.floor(Math.random() * 1e9)), JSON.stringify({ employer: sourceOrg || name }), 'OPP' + e.id, email]);
    return e;
  };
  await q(`UPDATE settings SET data = jsonb_set(data, '{companyAddress}', '"100 Main St"')`);
  const relay = await mk('Northside Columbus Campus', null, 'jdoe@practicematch.com', 'Riverbend Health System - Columbus Campus');
  const sibling = await mk('Lakeside Clinic', 'lakesideclinic.org', 'amy.lee@riverbendhealth.careers', null, 'Amy');
  const lusha = await mk('Coastal Medical Center', 'coastalmc.org', 'kim@coastalmc.org', null, 'Kim');
  const fine = await mk('Unrelated Hospital', 'unrelated.org', 'pat@unrelated.org', null, 'Pat');
  const { requalifyAll } = await import('../src/engine/qualify.js');
  await requalifyAll();
  for (const e of [relay, sibling, lusha, fine]) await enroll(e.id);

  // Clients added to the protected list AFTER outreach was queued
  await q(`INSERT INTO protected_accounts (name, norm_name, domain) VALUES ('Riverbend Health System','riverbend health system','riverbendhealth.org'), ('Coastal Medical Center','coastal medical center', null)`);

  for (let i = 0; i < 6; i++) await sendTick({ force: true });
  const sent = await q(`SELECT to_email FROM messages WHERE status = 'sent'`);
  assert.deepEqual(sent.map((m) => m.to_email), ['pat@unrelated.org'], 'only the unprotected prospect is emailed');
  for (const e of [relay, sibling, lusha]) {
    const ev = await one(`SELECT text FROM events WHERE employer_id = $1 AND text LIKE '%BLOCKED%'`, [e.id]);
    assert.ok(ev, `blocked event recorded for ${e.name}`);
  }
  // The same check runs at enrollment
  const ctx = await loadContext();
  assert.equal(protectedRecipientMatch({ employer: { norm_name: 'riverbend health system north tower', domain: null } }, ctx), 'Riverbend Health System');
  assert.equal(protectedRecipientMatch({ employer: { norm_name: 'hospital', domain: null } }, ctx), null, 'generic words never match');
});

test('several posting contacts at one client: separate sequences, shared reply stop, together mode', async () => {
  const { importListings } = await import('../src/engine/discovery.js');
  const { applyReply } = await import('../src/engine/replies.js');
  await q('TRUNCATE employers, openings, contacts, sequences, messages, replies, suppressions, protected_accounts, tasks, events RESTART IDENTITY CASCADE');
  await saveSettings({ multiContact: 'separate', perEmployerPerDay: 2, supervised: true });
  const row = (id, title, spec, role, email, org = 'Methodist Le Bonheur Healthcare', domain = 'methodisthealth.org') => ({ listingId: id, employer: org, domain, specialty: spec, role, city: 'Memphis', state: 'TN',
    contactName: '', contactTitle: 'Job posting contact', contactEmail: email, url: '', description: '', restriction: null, postedAt: new Date(), pmCode: id + 'X', title, relay: false });
  await importListings([
    row('801', 'Family Medicine Physician', 'Family Medicine', 'Physician', 'keri.wuertz@mlh.org'),
    row('802', 'Cardiology Physician Assistant', 'Cardiology', 'Physician Assistant', 'lewis.rowe@mlh.org'),
    row('803', 'Vascular Physician', 'Vascular Surgery', 'Physician', 'lewis.rowe@mlh.org'),
  ]);
  const emp = await one(`SELECT * FROM employers WHERE name = 'Methodist Le Bonheur Healthcare'`);
  assert.equal(Number((await one('SELECT count(*) n FROM contacts WHERE employer_id = $1', [emp.id])).n), 2);
  // Name the contacts like the real postings do
  await q(`UPDATE contacts SET first_name = 'Keri', full_name = 'Keri Wuertz' WHERE email = 'keri.wuertz@mlh.org'`);
  await q(`UPDATE contacts SET first_name = 'Lewis', full_name = 'Lewis Rowe' WHERE email = 'lewis.rowe@mlh.org'`);
  await routes['POST /api/employers/:id/action']({ params: { id: emp.id }, body: { action: 'approve' } });
  const detail = await routes['GET /api/employers/:id']({ params: { id: emp.id } });
  assert.equal(detail.contacts.filter((c) => c.selected).length, 2, 'both posting contacts ticked automatically');
  assert.equal(detail.previews.length, 2, 'one preview per contact');
  await enroll(emp.id);
  assert.equal(Number((await one(`SELECT count(*) n FROM sequences WHERE employer_id = $1 AND status = 'active'`, [emp.id])).n), 2);
  for (let i = 0; i < 3; i++) await sendTick({ force: true });
  const sent = await q(`SELECT to_email, subject, body FROM messages WHERE employer_id = $1 ORDER BY id`, [emp.id]);
  assert.equal(sent.length, 2);
  const keri = sent.find((m) => m.to_email === 'keri.wuertz@mlh.org');
  const lewis = sent.find((m) => m.to_email === 'lewis.rowe@mlh.org');
  assert.match(keri.body, /^Hi Keri,/); assert.match(keri.subject, /Family Medicine/);
  assert.match(lewis.body, /^Hi Lewis,/); assert.match(lewis.body, /one of 2 openings/); assert.doesNotMatch(lewis.subject, /Family Medicine/);
  // Keri replies "interested": Lewis's follow-ups stop too
  const msg = await one(`SELECT * FROM messages WHERE to_email = 'keri.wuertz@mlh.org'`);
  const rep = await one(`INSERT INTO replies (employer_id, contact_id, message_id, graph_id, from_email, subject, body_preview, received_at, category) VALUES ($1,$2,$3,'g1','keri.wuertz@mlh.org','RE','Yes please send profiles', now(), 'interested') RETURNING *`, [emp.id, msg.contact_id, msg.id]);
  await applyReply(rep, msg);
  assert.equal(Number((await one(`SELECT count(*) n FROM sequences WHERE employer_id = $1 AND status = 'active'`, [emp.id])).n), 0, 'all sequences at the client stop on a reply');

  // Together mode: one email to both, and an opt-out removes only that person
  await saveSettings({ multiContact: 'together' });
  await importListings([
    row('901', 'Hospitalist', 'Hospitalist', 'Physician', 'ann.lee@baptist.org', 'Baptist Memorial Hospital', 'baptistonline.org'),
    row('902', 'ICU Nurse Practitioner', 'Critical Care', 'Nurse Practitioner', 'bo.king@baptist.org', 'Baptist Memorial Hospital', 'baptistonline.org'),
  ]);
  const b = await one(`SELECT * FROM employers WHERE name = 'Baptist Memorial Hospital'`);
  await q(`UPDATE contacts SET first_name = initcap(split_part(email, '.', 1)) WHERE employer_id = $1`, [b.id]);
  await routes['POST /api/employers/:id/action']({ params: { id: b.id }, body: { action: 'approve' } });
  await enroll(b.id);
  const seqs = await q(`SELECT * FROM sequences WHERE employer_id = $1`, [b.id]);
  assert.equal(seqs.length, 1); assert.equal(seqs[0].cc_contact_ids.length, 1);
  for (let i = 0; i < 2; i++) await sendTick({ force: true });
  const tog = await one(`SELECT * FROM messages WHERE employer_id = $1`, [b.id]);
  assert.equal(tog.to_email, 'ann.lee@baptist.org, bo.king@baptist.org');
  assert.match(tog.body, /^Hi Ann and Bo,/);
  const optOut = await one(`INSERT INTO replies (employer_id, contact_id, message_id, graph_id, from_email, subject, body_preview, received_at, category) VALUES ($1,$2,$3,'g2','bo.king@baptist.org','RE','unsubscribe', now(), 'opt_out') RETURNING *`, [b.id, tog.contact_id, tog.id]);
  await applyReply(optOut, tog);
  const after = await one(`SELECT * FROM sequences WHERE employer_id = $1`, [b.id]);
  assert.equal(after.status, 'active', 'sequence continues for Ann');
  assert.equal(after.cc_contact_ids.length, 0, 'Bo removed after opting out');
  await saveSettings({ multiContact: 'separate' });
});
