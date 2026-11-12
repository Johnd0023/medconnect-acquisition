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
  await saveSettings({ companyAddress: '100 Main St, Columbus, OH 43215', practicematch: { delayMs: 800 }, sendDays: [0, 1, 2, 3, 4, 5, 6], sendWindowStart: '00:00', sendWindowEnd: '23:59', minGapSeconds: 0, maxGapSeconds: 0, warmup: { enabled: false } });

  const r = await runPracticeMatchScan({});
  assert.equal(r.listings, 8, '9 postings, psychologist skipped');
  const emps = await q('SELECT id, name, sources FROM employers ORDER BY id');
  const names = emps.map((e) => e.name);
  // Shared PracticeMatch forwarding address: separate clients
  assert.ok(names.includes('Maury Regional Medical Group') && names.includes('Sky Lakes Medical Center'));
  // Same direct recruiter across three ThedaCare sites: one client
  assert.equal(names.filter((n) => /ThedaCare/.test(n)).length, 1, 'ThedaCare sites consolidated under one contact');
  assert.ok(!names.includes('Terrell Center for Youth'), 'non-provider role skipped');
  const theda = emps.find((e) => /ThedaCare/.test(e.name));
  assert.equal(Number((await one('SELECT count(*) n FROM openings WHERE employer_id = $1', [theda.id])).n), 3);
  const sky = emps.find((e) => e.name === 'Sky Lakes Medical Center');
  assert.equal(Number((await one('SELECT count(*) n FROM openings WHERE employer_id = $1', [sky.id])).n), 2);
  const relayContacts = await q(`SELECT employer_id FROM contacts WHERE email = 'mnstelmat@practicematch.com'`);
  assert.equal(relayContacts.length, 2, 'forwarding address stored once per client');
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
  assert.match(en.message, /^5 enrolled/, 'Maury, Sky Lakes, Health First, ThedaCare, WVU each once');

  // A second ThedaCare record with the same recruiter cannot start another sequence
  const extra = await one(`INSERT INTO employers (name, norm_name, type, sources, decision) VALUES ('ThedaCare Extra', 'thedacare extra', 'Urgent care / outpatient', ARRAY['PM'], 'approved') RETURNING id`);
  await q(`INSERT INTO contacts (employer_id, full_name, email, title, sources) VALUES ($1, 'Kristen Stumpf', 'kristen.stumpf@thedacare.org', 'Recruiter', ARRAY['PM'])`, [extra.id]);
  await assert.rejects(() => enroll(extra.id), /already contacted/);

  // Live send: subjects
  cfg.dryRun = false;
  await q(`INSERT INTO oauth_tokens (provider, account_email, refresh_token_enc, access_token_enc, expires_at) VALUES ('microsoft','bizdev@medconnectstaffing.com',$1,$2, now() + interval '1 hour')`, [encrypt('RT1'), encrypt('AT')]);
  for (let i = 0; i < 8; i++) await sendTick({ force: true });
  const sent = await q(`SELECT to_email, subject, body FROM messages WHERE status = 'sent' ORDER BY id`);
  assert.equal(sent.length, 5);
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
