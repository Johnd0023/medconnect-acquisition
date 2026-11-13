// End-to-end test against a real Postgres with Lusha and Microsoft Graph mocked at the fetch layer.
// Run: DATABASE_URL=postgres://... ADMIN_PASSWORD=x SESSION_SECRET=x ENCRYPTION_KEY=<32B base64> npm test
// WARNING: it wipes all tables in the database it is pointed at. Never point it at production.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.LUSHA_API_KEY = 'test-key';
process.env.MS_CLIENT_ID = 'cid'; process.env.MS_CLIENT_SECRET = 'csecret';
process.env.SCHEDULER = 'off';

// ---------------- fetch mock ----------------
const calls = [];
const inbox = [];
let draftSeq = 0;
const LUSHA_PEOPLE = {
  'lp1': { id: 'lp1', firstName: 'Avery', lastName: 'Stone', jobTitle: { title: 'Director of Provider Recruitment' }, company: { id: 'c1', name: 'Northwind Regional Medical Center', domain: 'northwindrmc.org', industry: 'Hospitals and Health Care' }, location: { city: 'Dayton', state: 'Ohio' } },
  'lp2': { id: 'lp2', firstName: 'Blake', lastName: 'Reyes', jobTitle: { title: 'Physician Recruiter' }, company: { id: 'c2', name: 'Riverbend Health System', domain: 'riverbendhealth.org', industry: 'Hospitals and Health Care' } },
  'lp3': { id: 'lp3', firstName: 'Casey', lastName: 'Ng', jobTitle: { title: 'Recruiter' }, company: { id: 'c3', name: 'Summit Locum Partners', domain: 'summitlocums.com', industry: 'Staffing and Recruiting' } },
  'lp4': { id: 'lp4', firstName: 'Drew', lastName: 'Patel', jobTitle: { title: 'Practice Administrator' }, company: { id: 'c4', name: 'Cedar Valley Family Medicine', domain: 'cedarvalleyfm.com', industry: 'Medical Practices' } },
  'lp5': { id: 'lp5', firstName: 'Emery', lastName: 'Cho', jobTitle: { title: 'Talent Acquisition Manager' }, company: { id: 'c5', name: 'Harbor Point Hospital', domain: 'harborpointhospital.org' } },
};
globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(url); const body = opts.body ? (opts.body instanceof URLSearchParams ? Object.fromEntries(opts.body) : JSON.parse(opts.body)) : null;
  calls.push({ method: opts.method || 'GET', url: u.pathname + u.search, body });
  const json = (status, obj) => new Response(obj === null ? null : JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
  if (u.host === 'api.lusha.com') {
    if (u.pathname === '/v3/contacts/prospecting') return json(200, { requestId: 'r1', results: ['lp1', 'lp2', 'lp3', 'lp4'].map((k) => ({ ...LUSHA_PEOPLE[k], has: ['emails'] })), pagination: { page: 0, size: 25, total: 4 }, billing: { creditsCharged: 0 } });
    if (u.pathname === '/v3/companies/search') return json(200, { results: body.companies.filter((c) => c.name === 'Harbor Point Hospital').map((c) => ({ clientReferenceId: c.clientReferenceId, id: 'c5', name: 'Harbor Point Hospital', domain: 'harborpointhospital.org' })) });
    if (u.pathname === '/v3/contacts/decision-makers') return json(200, { results: [{ company: { domain: 'harborpointhospital.org' }, contacts: [LUSHA_PEOPLE.lp5] }] });
    if (u.pathname === '/v3/contacts/enrich') {
      return json(200, { requestId: 'r2', results: body.ids.map((id) => { const p = LUSHA_PEOPLE[id]; return { ...p, emails: [{ email: `${p.firstName.toLowerCase()}@${p.company.domain}`, confidence: 'A' }], phones: [{ number: '+15555550100', doNotCall: false }] }; }), billing: { creditsCharged: body.ids.length } });
    }
  }
  if (u.host === 'login.microsoftonline.com') return json(200, { access_token: 'AT', refresh_token: 'RT2', expires_in: 3600 });
  if (u.host === 'graph.microsoft.com') {
    const p = u.pathname.replace('/v1.0', '');
    if (p === '/me/messages' && opts.method === 'POST') { draftSeq++; return json(201, { id: `d${draftSeq}`, conversationId: `conv-${body.toRecipients[0].emailAddress.address}`, internetMessageId: `<m${draftSeq}@mc>` }); }
    if (/\/me\/messages\/[^/]+\/send$/.test(p)) return json(202, null);
    if (p === '/me/mailFolders/sentitems/messages') return json(200, { value: [{ id: 'sent1', conversationId: 'conv-x', internetMessageId: '<m1@mc>', sentDateTime: new Date().toISOString(), body: { content: 'original text' } }] });
    if (/\/createReply$/.test(p)) { draftSeq++; return json(201, { id: `r${draftSeq}`, conversationId: 'conv-x', internetMessageId: `<m${draftSeq}@mc>` }); }
    if (/^\/me\/messages\/[^/]+$/.test(p) && opts.method === 'PATCH') return json(200, {});
    if (p === '/me/mailFolders/inbox/messages') return json(200, { value: inbox });
    if (p === '/me') return json(200, { mail: 'bizdev@medconnectstaffing.com' });
  }
  throw new Error(`Unmocked fetch ${url}`);
};

const { q, one, migrate } = await import('../src/db.js');
const { cfg } = await import('../src/config.js');
const { saveSettings, invalidateSettings } = await import('../src/settings.js');
const { importListings, runDiscovery } = await import('../src/engine/discovery.js');
const { enroll, sendTick, todaysCap } = await import('../src/engine/outreach.js');
const { pollReplies, classify } = await import('../src/engine/replies.js');
const { routes } = await import('../src/api.js');
const { encrypt } = await import('../src/util.js');
const pm = await import('../src/integrations/practicematch.js');

const CSV = `Listing ID,Employer,Specialty,Position,Location,Contact Name,Contact Title,Email,Phone,Date Posted,Description
PM-1,Northwind Regional Medical Center,Hospitalist,Physician,"Dayton, OH",Jamie Fox,Physician Recruiter,jfox@northwindrmc.org,555-0101,2026-11-09,Nocturnist role
PM-2,Northwind Regional Medical Center,Emergency Medicine,Physician,"Dayton, OH",Jamie Fox,Physician Recruiter,jfox@northwindrmc.org,555-0101,2026-11-10,
PM-3,Summit Locum Partners,Anesthesiology,CRNA,"Denver, CO",Pat Lee,Recruiter,plee@summitlocums.com,,2026-11-10,
PM-4,Riverbend Health System,Psychiatry,Nurse Practitioner,"Columbus, OH",Sam Hart,Recruiter,shart@riverbendhealth.org,,2026-11-10,
PM-5,Lakeview Pediatrics,Pediatrics,Physician,"Erie, PA",Lee Park,Office Manager,lpark@lakeviewpeds.com,,2026-11-10,Direct applicants only. No agencies please.
PM-6,Harbor Point Hospital,Cardiology,Physician,"Norfolk, VA",,,,,2026-11-10,
`;

test('full pipeline', async () => {
  await migrate();
  await q('TRUNCATE employers, openings, contacts, sequences, messages, replies, suppressions, protected_accounts, tasks, events, job_runs, lusha_usage, oauth_tokens, kv, meetings RESTART IDENTITY CASCADE');
  await q(`UPDATE settings SET data = '{}'::jsonb`); invalidateSettings();
  await routes['POST /api/protected']({ body: { text: 'Riverbend Health System | riverbendhealth.org' } });
  await saveSettings({ lusha: { prospectingEnabled: true }, practicematch: { enabled: false }, companyAddress: '100 Main St, Columbus, OH 43215', sendDays: [0, 1, 2, 3, 4, 5, 6], sendWindowStart: '00:00', sendWindowEnd: '23:59', minGapSeconds: 0, maxGapSeconds: 0, warmup: { enabled: true, startPerDay: 3, increasePerDay: 2 } });

  // --- PracticeMatch import ---
  const rows = pm.parseImport(CSV);
  assert.equal(rows.length, 6);
  assert.ok(rows[4].restriction, 'no-agency restriction detected');
  const imp = await importListings(rows);
  assert.equal(imp.newEmployers, 5, 'two Northwind listings consolidate into one employer');

  // --- Discovery with Lusha ---
  const sum = await runDiscovery({ trigger: 'test' });
  assert.equal(sum.skippedProtected, 1, 'protected company skipped before spending credits');
  assert.equal(sum.skippedExcluded, 1, 'staffing firm skipped before spending credits');
  const enrichCalls = calls.filter((c) => c.url === '/v3/contacts/enrich');
  const revealed = enrichCalls.flatMap((c) => c.body.ids);
  assert.ok(!revealed.includes('lp2') && !revealed.includes('lp3'), 'no credits on protected/excluded');
  assert.ok(revealed.includes('lp4') && revealed.includes('lp5'));

  const by = async (name) => one('SELECT * FROM employers WHERE name = $1', [name]);
  const northwind = await by('Northwind Regional Medical Center');
  assert.deepEqual([...northwind.sources], ['PM'], 'no Lusha credits spent on an employer that already has a contact');
  const harbor = await by('Harbor Point Hospital');
  assert.equal(harbor.domain, 'harborpointhospital.org', 'Lusha supplied the missing domain');
  assert.deepEqual([...harbor.sources].sort(), ['Lusha', 'PM'], 'PracticeMatch + Lusha merged on one employer');
  assert.equal(Number((await one('SELECT count(*) n FROM openings WHERE employer_id = $1', [northwind.id])).n), 2);
  assert.equal((await by('Riverbend Health System')).status, 'protected');
  assert.equal((await by('Summit Locum Partners')).status, 'excluded');
  assert.equal((await by('Lakeview Pediatrics')).bucket, 'review');
  assert.equal((await by('Harbor Point Hospital')).status, 'qualified', 'Lusha filled the missing contact');
  assert.equal(northwind.bucket, 'review', 'supervised launch holds qualified employers');

  // --- Approve + enroll ---
  await routes['POST /api/queue/bulk']({ body: { action: 'approveClean' } });
  const en = await routes['POST /api/queue/bulk']({ body: { action: 'enrollReady' } });
  assert.match(en.message, /^3 enrolled/);

  // --- Dry run: composes, pauses, sends nothing ---
  cfg.dryRun = true;
  const d = await sendTick({ force: true });
  assert.ok(d.dryRun);
  assert.equal(calls.filter((c) => c.url.includes('/send')).length, 0);
  await q(`DELETE FROM messages`); await q(`UPDATE sequences SET status = 'active', stop_reason = NULL`);

  // --- Live sending through Graph ---
  cfg.dryRun = false;
  await q(`INSERT INTO oauth_tokens (provider, account_email, refresh_token_enc, access_token_enc, expires_at) VALUES ('microsoft','bizdev@medconnectstaffing.com',$1,$2, now() - interval '1 minute')`, [encrypt('RT1'), encrypt('old')]);
  assert.equal(await todaysCap(await (await import('../src/settings.js')).getSettings()), 3, 'warm-up day 1 cap');
  const results = [];
  for (let i = 0; i < 5; i++) results.push(await sendTick({ force: true }));
  assert.equal(results.filter((r) => r.sent).length, 3, 'three emails, one per enrolled employer');
  assert.match(results[3].reason, /Nothing due|limit/);
  const sent = await q(`SELECT * FROM messages WHERE status = 'sent' ORDER BY id`);
  assert.equal(sent.length, 3);
  assert.ok(sent.every((m) => m.body.includes('100 Main St') && m.body.includes("won't follow up") && !m.body.includes('\n--\n')), 'footer with address + opt-out');
  const nw = sent.find((m) => m.to_email === 'jfox@northwindrmc.org');
  assert.ok(nw, 'listing recruiter chosen for Northwind');
  assert.match(nw.body, /one of 2 openings/);
  assert.ok(calls.some((c) => c.url.includes('oauth2/v2.0/token') && c.body.grant_type === 'refresh_token'), 'token refreshed');
  assert.equal((await one(`SELECT step FROM sequences WHERE employer_id = $1`, [northwind.id])).step, 1);

  // --- Replies ---
  inbox.push(
    { id: 'in1', conversationId: 'conv-jfox@northwindrmc.org', subject: 'RE: Hospitalist Physician search', from: { emailAddress: { address: 'jfox@northwindrmc.org' } }, receivedDateTime: new Date().toISOString(), body: { content: "Yes, we're interested. Please send over a few profiles." } },
    { id: 'in2', conversationId: 'conv-drew@cedarvalleyfm.com', subject: 'RE: Provider recruiting', from: { emailAddress: { address: 'drew@cedarvalleyfm.com' } }, receivedDateTime: new Date().toISOString(), body: { content: 'Please remove me from your list.' } },
    { id: 'in3', conversationId: 'zzz', subject: 'Lunch?', from: { emailAddress: { address: 'friend@example.com' } }, receivedDateTime: new Date().toISOString(), body: { content: 'unrelated' } },
  );
  const pr = await pollReplies();
  assert.equal(pr.matched, 2, 'unrelated mail ignored');
  const reps = await q('SELECT category FROM replies ORDER BY id');
  assert.deepEqual(reps.map((r) => r.category), ['interested', 'opt_out']);
  assert.ok(await one(`SELECT 1 FROM suppressions WHERE value = 'drew@cedarvalleyfm.com'`), 'opt-out suppressed');
  assert.ok(await one(`SELECT 1 FROM tasks WHERE text LIKE 'Call %'`), 'task created for interested');
  assert.equal((await one(`SELECT status FROM sequences WHERE employer_id = $1`, [northwind.id])).status, 'stopped');
  assert.equal((await pollReplies()).matched, 0, 'replies are not double-counted');

  // --- Follow-up threads as a reply ---
  await q(`UPDATE messages SET sent_at = sent_at - interval '1 day'`); // next day
  assert.equal(await todaysCap(await (await import('../src/settings.js')).getSettings()), 5, 'warm-up day 2 cap');
  await q(`UPDATE sequences SET next_at = now() WHERE status = 'active'`);
  const f = await sendTick({ force: true });
  assert.ok(f.sent, `follow-up sent (${f.reason || ''})`);
  assert.ok(calls.some((c) => c.url.endsWith('/createReply')), 'follow-up used createReply for threading');
  const fu = await one(`SELECT * FROM messages WHERE step = 1`);
  assert.ok(fu);

  // --- API smoke ---
  const ov = await routes['GET /api/overview']();
  assert.ok(ov.totals.employers >= 6);
  const perf = await routes['GET /api/performance']();
  assert.equal(perf.kpis.meetings, 0);
  assert.ok(perf.daily.length === 14);
  const detail = await routes['GET /api/employers/:id']({ params: { id: northwind.id } });
  assert.ok(detail.events.length > 3);

  assert.equal(classify('Automatic reply: Away', 'I am out of the office'), 'ooo');
  assert.equal(classify('RE: x', "I'm not the right person. Please reach out to kim.lo@acme.org"), 'referral');
  assert.equal(classify('Undeliverable: x', 'Delivery has failed to these recipients'), 'bounce');
});
