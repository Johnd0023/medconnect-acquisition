// Brochure: upload → link or attachment on the chosen emails → Graph receives the file. WIPES the target database.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.SCHEDULER = 'off';
process.env.MS_CLIENT_ID = 'cid'; process.env.MS_CLIENT_SECRET = 'csecret';

const calls = [];
globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(url); const body = opts.body && typeof opts.body === 'string' ? JSON.parse(opts.body) : null;
  calls.push({ method: opts.method || 'GET', path: u.pathname + u.search, body });
  const json = (status, obj) => new Response(obj === null ? null : JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
  if (u.host === 'login.microsoftonline.com') return json(200, { access_token: 'AT', refresh_token: 'RT2', expires_in: 3600 });
  if (u.pathname === '/v1.0/me/messages' && opts.method === 'POST') return json(201, { id: 'd1', conversationId: 'c1', internetMessageId: '<m1@mc>' });
  if (u.pathname.startsWith('/v1.0/me/mailFolders/sentitems/messages')) return json(200, { value: [{ id: 'orig', conversationId: 'c1', body: { content: 'hello' }, sentDateTime: '2026-11-12T15:00:00Z' }] });
  if (u.pathname.endsWith('/createReply')) return json(201, { id: 'r1', conversationId: 'c1', internetMessageId: '<r1@mc>' });
  return json(opts.method === 'PATCH' ? 200 : 202, opts.method === 'PATCH' ? {} : null);
};

const { q, migrate } = await import('../src/db.js');
const { encrypt } = await import('../src/util.js');
const { saveSettings, invalidateSettings, getSettings } = await import('../src/settings.js');
const { saveBrochure, brochureFor, brochureBySlug, brochureMeta } = await import('../src/brochure.js');
const { compose } = await import('../src/engine/compose.js');
const outlook = await import('../src/integrations/outlook.js');

const PDF = Buffer.from('%PDF-1.4\n% MedConnect brochure\n%%EOF').toString('base64');

test('brochure as a link or an attachment', async () => {
  await migrate();
  await q('TRUNCATE files, oauth_tokens');
  await q(`UPDATE settings SET data = '{}'::jsonb`); invalidateSettings();
  await saveSettings({ companyAddress: '1440 Coral Ridge Dr, Coral Springs, FL 33071', senderName: 'John Duva' });

  await assert.rejects(() => saveBrochure({ name: 'virus.exe', dataBase64: PDF }), /PDF/);
  const meta = await saveBrochure({ name: 'MedConnect Brochure.pdf', dataBase64: PDF });
  assert.equal(meta.content_type, 'application/pdf');
  assert.ok((await brochureBySlug(meta.slug)).data, 'public link serves the file');
  assert.equal(await brochureBySlug('wrong-slug-123'), null);

  const emp = { id: 1, name: 'Cedar Valley Family Medicine', type: 'PG' };
  const contact = { email: 'drew@cedarvalleyfm.com', first_name: 'Drew' };

  // Off by default
  assert.equal(await brochureFor(0, await getSettings()), null);

  // Link on the first email only, inserted above the sign-off
  await saveSettings({ brochure: { mode: 'link', steps: [0] } });
  let s = await getSettings();
  const link = await brochureFor(0, s);
  assert.match(link.line, /\/b\/[\w-]+\/MedConnect%20Brochure\.pdf$/);
  assert.equal(await brochureFor(1, s), null, 'follow-ups not chosen');
  const m = compose(emp, contact, [], 0, s, link);
  assert.ok(m.body.indexOf(link.url) > 0 && m.body.indexOf(link.url) < m.body.indexOf('John Duva'), 'link sits above the signature');
  assert.equal(m.attachment, null);

  // Own link instead of the uploaded file
  await saveSettings({ brochure: { url: 'https://medconnectstaffing.com/brochure.pdf' } });
  assert.match((await brochureFor(0, await getSettings())).line, /medconnectstaffing\.com\/brochure\.pdf/);
  await assert.rejects(() => saveSettings({ brochure: { url: 'not a link' } }), /https/);

  // Attachment on follow-up 1
  await saveSettings({ brochure: { mode: 'attach', steps: [1], url: '' } });
  s = await getSettings();
  const att = await brochureFor(1, s);
  assert.equal(att.attachment.contentBytes, PDF);
  assert.equal((await brochureFor(1, s, { lineOnly: true })).attachment.contentBytes, undefined, 'previews skip the file bytes');
  const f = compose(emp, contact, [], 1, s, att);
  assert.equal(f.attachment, 'MedConnect Brochure.pdf');
  assert.match(f.body, /attached a short overview/);

  // Graph receives the file: inline on new messages, as an added attachment on thread replies
  await q(`INSERT INTO oauth_tokens (provider, account_email, refresh_token_enc, access_token_enc, expires_at) VALUES ('microsoft','bizdev@medconnectstaffing.com',$1,$2, now() + interval '1 hour')`, [encrypt('RT1'), encrypt('AT')]);
  await outlook.sendNew({ to: [{ address: 'drew@cedarvalleyfm.com' }], subject: 'Hi', body: 'x', attachments: [att.attachment] });
  const draft = calls.find((c) => c.path === '/v1.0/me/messages' && c.method === 'POST');
  assert.equal(draft.body.attachments[0].name, 'MedConnect Brochure.pdf');
  assert.equal(draft.body.attachments[0]['@odata.type'], '#microsoft.graph.fileAttachment');
  await outlook.sendFollowUp({ to: [{ address: 'drew@cedarvalleyfm.com' }], previousInternetMessageId: '<m1@mc>', body: 'y', fallbackSubject: 'Hi', attachments: [att.attachment] });
  assert.ok(calls.some((c) => c.path === '/v1.0/me/messages/r1/attachments' && c.body.contentBytes === PDF), 'attachment added to the reply');

  assert.ok(await brochureMeta());
});
