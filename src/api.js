// JSON API used by the dashboard. All routes require the owner session (enforced in server.js).
import { q, one, logEvent, kvGet } from './db.js';
import { cfg, integrations } from './config.js';
import { getSettings, saveSettings, DEFAULT_TEMPLATES, EMPLOYER_TYPES } from './settings.js';
import { loadContext, requalify, requalifyAll, rankContacts, isUsable, protectionMatch, prospectDecision } from './engine/qualify.js';
import { compose } from './engine/compose.js';
import { enroll, stopSequence, resumeSequence, sendState, sendTick, clearSendBlock } from './engine/outreach.js';
import { runDiscovery, importListings, lushaFillContacts, resolveIndustries } from './engine/discovery.js';
import { pollReplies, referralFrom } from './engine/replies.js';
import { addContact, inferType } from './engine/ingest.js';
import { runJob } from './scheduler.js';
import * as outlook from './integrations/outlook.js';
import * as lusha from './integrations/lusha.js';
import * as pm from './integrations/practicematch.js';
import { normName, normDomain, startOfBusinessDay, zoned } from './util.js';

const today = () => startOfBusinessDay();

async function employerRow(e, ctx) {
  const [openings, contacts] = await Promise.all([
    q('SELECT * FROM openings WHERE employer_id = $1 AND active ORDER BY posted_at DESC NULLS LAST', [e.id]),
    q('SELECT * FROM contacts WHERE employer_id = $1', [e.id]),
  ]);
  const ranked = rankContacts(contacts, ctx);
  const chosen = ranked.find((c) => c.id === e.selected_contact_id) || ranked[0] || null;
  const seq = await one(`SELECT s.*, c.full_name AS contact_name, c.email AS contact_email FROM sequences s JOIN contacts c ON c.id = s.contact_id
                         WHERE s.employer_id = $1 ORDER BY s.started_at DESC LIMIT 1`, [e.id]);
  return {
    id: e.id, name: e.name, domain: e.domain, type: e.type, city: e.city, state: e.state, sources: e.sources,
    status: e.status, bucket: e.bucket, score: e.score, reasons: e.reasons, decision: e.decision,
    firstSeen: e.first_seen, lastSignal: e.last_signal,
    openings: openings.map((o) => ({ specialty: o.specialty, role: o.role, postedAt: o.posted_at })),
    openingCount: openings.length,
    contact: chosen ? { id: chosen.id, name: chosen.full_name, title: chosen.title, email: chosen.email } : null,
    sequence: seq ? { status: seq.status, step: seq.step, nextAt: seq.next_at, stopReason: seq.stop_reason, replied: seq.replied, contactName: seq.contact_name } : null,
  };
}

export const routes = {
  'GET /api/overview': async () => {
    const s = await getSettings();
    const ctxAll = await loadContext();
    const counts = Object.fromEntries((await q('SELECT bucket, count(*) AS n FROM employers GROUP BY bucket')).map((r) => [r.bucket, Number(r.n)]));
    const fresh = await q(`SELECT * FROM employers WHERE (first_seen >= $1 OR last_signal >= $1) AND bucket <> 'suppressed' ORDER BY score DESC NULLS LAST LIMIT 40`, [today()]);
    const lastRun = await one(`SELECT * FROM job_runs WHERE job = 'discovery' ORDER BY started_at DESC LIMIT 1`);
    const st = await sendState();
    const due = Number((await one(`SELECT count(*) AS n FROM sequences WHERE status = 'active' AND next_at <= now()`)).n);
    const totals = await one(`SELECT (SELECT count(*) FROM employers) AS employers, (SELECT count(*) FROM contacts) AS contacts,
      (SELECT count(*) FROM sequences WHERE status = 'active') AS active, (SELECT count(*) FROM replies) AS replies,
      (SELECT count(*) FROM replies WHERE NOT handled) AS unhandled, (SELECT count(*) FROM tasks WHERE NOT done) AS tasks`);
    return {
      now: new Date(), timezone: cfg.timezone, counts, fresh: await Promise.all(fresh.map(async (e) => employerRow(e, ctxAll))),
      lastRun, send: { ...st, settings: undefined, due }, totals: Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, Number(v)])),
      credits: await lusha.creditsUsed(), budget: s.lusha.monthlyCreditBudget,
      mode: { supervised: s.supervised, paused: s.paused, dryRun: cfg.dryRun },
    };
  },

  'GET /api/employers': async ({ query }) => {
    const bucket = query.bucket || 'review';
    const search = (query.q || '').trim();
    const rows = await q(`SELECT * FROM employers WHERE bucket = $1 AND ($2 = '' OR name ILIKE '%' || $2 || '%' OR domain ILIKE '%' || $2 || '%')
                          ORDER BY last_signal DESC LIMIT 300`, [bucket, search]);
    const counts = Object.fromEntries((await q('SELECT bucket, count(*) AS n FROM employers GROUP BY bucket')).map((r) => [r.bucket, Number(r.n)]));
    const ctx = await loadContext();
    return { counts, employers: await Promise.all(rows.map((e) => employerRow(e, ctx))) };
  },

  'GET /api/employers/:id': async ({ params }) => {
    const e = await one('SELECT * FROM employers WHERE id = $1', [params.id]);
    if (!e) throw httpError(404, 'Employer not found');
    const s = await getSettings();
    const ctx = await loadContext();
    const [openings, contacts, seqs, messages, replies, events] = await Promise.all([
      q('SELECT * FROM openings WHERE employer_id = $1 ORDER BY active DESC, posted_at DESC NULLS LAST', [e.id]),
      q('SELECT * FROM contacts WHERE employer_id = $1 ORDER BY id', [e.id]),
      q('SELECT * FROM sequences WHERE employer_id = $1 ORDER BY started_at DESC', [e.id]),
      q('SELECT id, step, to_email, subject, status, error, sent_at FROM messages WHERE employer_id = $1 ORDER BY sent_at', [e.id]),
      q('SELECT * FROM replies WHERE employer_id = $1 ORDER BY received_at', [e.id]),
      q('SELECT at, text FROM events WHERE employer_id = $1 ORDER BY at DESC LIMIT 100', [e.id]),
    ]);
    const ranked = rankContacts(contacts, ctx);
    const open = seqs.find((x) => x.status === 'active' || x.status === 'paused');
    const chosen = open ? contacts.find((c) => c.id === open.contact_id) : (ranked.find((c) => c.id === e.selected_contact_id) || ranked[0] || null);
    const preview = chosen ? compose(e, chosen, openings, open ? open.step : 0, s) : null;
    return {
      employer: { ...e, notes: e.notes },
      openings, seqs, messages, replies, events, preview,
      contacts: contacts.map((c) => {
        const usable = isUsable(c, ctx);
        const email = (c.email || '').toLowerCase();
        const why = usable ? null : !c.email ? 'No email address' : c.bad ? 'Said they are the wrong contact, or the email bounced'
          : ctx.suppressedEmails.has(email) ? 'Opted out or bounced (on the suppression list)'
            : ctx.suppressedDomains.has(email.split('@')[1]) ? 'Domain is on the suppression list' : 'Title is outside your contact title priority list';
        return { ...c, usable, unusableReason: why, selected: chosen?.id === c.id };
      }),
    };
  },

  'POST /api/employers/:id/action': async ({ params, body }) => {
    const id = Number(params.id);
    const e = await one('SELECT * FROM employers WHERE id = $1', [id]);
    if (!e) throw httpError(404, 'Employer not found');
    const a = body.action;
    const setDecision = async (d, text) => { await q('UPDATE employers SET decision = $2 WHERE id = $1', [id, d]); await logEvent(id, text); };
    switch (a) {
      case 'approve': await setDecision('approved', 'Approved by owner'); break;
      case 'hold': await setDecision('held', 'Held for review by owner'); break;
      case 'suppress': await setDecision('suppressed', 'Suppressed by owner'); await stopSequence(id, 'Suppressed by owner'); break;
      case 'unsuppress': await setDecision(null, 'Restored by owner'); break;
      case 'recontact': await setDecision('recontact', 'Cleared for a new outreach attempt'); break;
      case 'enroll': { const c = await enroll(id); return { ok: true, message: `Enrolled. First email to ${c.email} goes out in the next send window.` }; }
      case 'pause': await stopSequence(id, 'Paused by owner', 'paused'); break;
      case 'resume': await clearSendBlock(); await resumeSequence(id); break;
      case 'choose': {
        const c = await one('SELECT id FROM contacts WHERE id = $1 AND employer_id = $2', [body.contactId, id]);
        if (!c) throw httpError(400, 'That contact does not belong to this employer');
        await q('UPDATE employers SET selected_contact_id = $2 WHERE id = $1', [id, c.id]);
        break;
      }
      case 'protect':
        await q(`INSERT INTO protected_accounts (name, norm_name, domain) VALUES ($1, $2, $3) ON CONFLICT (norm_name) DO NOTHING`, [e.name, e.norm_name, e.domain]);
        await logEvent(id, 'Marked as a current client (protected)');
        await stopSequence(id, 'Marked as current client');
        break;
      case 'note': {
        const text = String(body.text || '').trim().slice(0, 2000);
        if (text) { await q(`UPDATE employers SET notes = notes || $2::jsonb WHERE id = $1`, [id, JSON.stringify([{ at: new Date(), text }])]); await logEvent(id, 'Note added'); }
        break;
      }
      case 'enrich': {
        if (!cfg.lushaApiKey) throw httpError(400, 'Add LUSHA_API_KEY in Railway to use Lusha.');
        const sum = { lushaRevealed: 0, newContacts: 0, notes: [], touched: new Set() };
        await lushaFillContacts(await getSettings(), await loadContext(), sum, [id]);
        await requalify(id);
        return { ok: true, message: sum.lushaRevealed ? `Lusha added ${sum.lushaRevealed} contact(s).` : (sum.notes[0] || 'Lusha found no new matching contacts.') };
      }
      case 'addContact': {
        const email = String(body.email || '').trim().toLowerCase();
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw httpError(400, 'Enter a valid email address.');
        const name = String(body.name || '').trim();
        const r = await addContact(id, { fullName: name || email, firstName: name.split(' ')[0] || '', lastName: name.split(' ').slice(1).join(' '), title: body.title || 'Added by owner', email }, 'Referral');
        await q('UPDATE employers SET selected_contact_id = $2 WHERE id = $1', [id, r.contact.id]);
        await logEvent(id, `Contact added by owner: ${email}`);
        break;
      }
      default: throw httpError(400, `Unknown action ${a}`);
    }
    await requalify(id);
    return { ok: true };
  },

  'POST /api/queue/bulk': async ({ body }) => {
    let n = 0;
    if (body.action === 'approveClean') {
      const rows = await q(`SELECT id FROM employers WHERE bucket = 'review' AND status = 'qualified' AND decision IS NULL`);
      for (const { id } of rows) { await q(`UPDATE employers SET decision = 'approved' WHERE id = $1`, [id]); await logEvent(id, 'Approved by owner (bulk)'); await requalify(id); n++; }
      return { ok: true, message: `${n} approved. They're in Ready; enroll them when you're set.` };
    }
    if (body.action === 'enrollReady') {
      for (const { id } of await q(`SELECT id FROM employers WHERE bucket = 'ready' ORDER BY score DESC NULLS LAST`)) { try { await enroll(id); n++; } catch { /* skip */ } }
      return { ok: true, message: `${n} enrolled.` };
    }
    throw httpError(400, 'Unknown bulk action');
  },

  'GET /api/outreach': async () => {
    const st = await sendState();
    const due = await q(`SELECT s.*, e.name, c.full_name, c.email FROM sequences s JOIN employers e ON e.id = s.employer_id JOIN contacts c ON c.id = s.contact_id
                         WHERE s.status = 'active' AND s.next_at <= now() ORDER BY s.step DESC, s.next_at LIMIT 200`);
    const upcoming = await q(`SELECT s.*, e.name, c.full_name FROM sequences s JOIN employers e ON e.id = s.employer_id JOIN contacts c ON c.id = s.contact_id
                              WHERE s.status = 'active' AND s.next_at > now() ORDER BY s.next_at LIMIT 200`);
    const stopped = await q(`SELECT s.*, e.name FROM sequences s JOIN employers e ON e.id = s.employer_id WHERE s.status <> 'active' ORDER BY s.started_at DESC LIMIT 100`);
    const log = await q(`SELECT m.id, m.employer_id, e.name, m.to_email, m.subject, m.status, m.error, m.step, m.sent_at FROM messages m JOIN employers e ON e.id = m.employer_id ORDER BY m.sent_at DESC LIMIT 100`);
    return { send: { ...st, settings: undefined }, due, upcoming, stopped, log };
  },

  'POST /api/send/now': async () => sendTick({ force: true }),
  'POST /api/send/unblock': async () => { await clearSendBlock(); return { ok: true }; },

  'GET /api/replies': async () => ({
    replies: await q(`SELECT r.*, e.name AS employer_name, c.full_name AS contact_name, c.title AS contact_title FROM replies r
                      LEFT JOIN employers e ON e.id = r.employer_id LEFT JOIN contacts c ON c.id = r.contact_id ORDER BY r.handled, r.received_at DESC LIMIT 300`),
    tasks: await q(`SELECT t.*, e.name AS employer_name FROM tasks t LEFT JOIN employers e ON e.id = t.employer_id WHERE NOT t.done ORDER BY t.due_date NULLS LAST`),
  }),

  'POST /api/replies/:id/action': async ({ params, body }) => {
    const r = await one('SELECT * FROM replies WHERE id = $1', [params.id]);
    if (!r) throw httpError(404, 'Reply not found');
    const done = () => q('UPDATE replies SET handled = true WHERE id = $1', [r.id]);
    switch (body.action) {
      case 'handled': await done(); break;
      case 'meeting':
        await q('INSERT INTO meetings (employer_id, reply_id) VALUES ($1, $2)', [r.employer_id, r.id]);
        await q('UPDATE tasks SET done = true WHERE employer_id = $1', [r.employer_id]);
        await logEvent(r.employer_id, 'Meeting booked');
        await done(); break;
      case 'task':
        await q(`INSERT INTO tasks (employer_id, text, due_date) VALUES ($1, $2, (now() AT TIME ZONE $3)::date + 3)`, [r.employer_id, `Follow up with ${r.from_email}`, cfg.timezone]);
        break;
      case 'useReferral': {
        const email = (body.email || referralFrom(r.body_preview || '', [r.from_email]) || '').toLowerCase();
        if (!email) throw httpError(400, 'No referral email found in the reply. Add the contact from the employer profile.');
        const c = await addContact(r.employer_id, { fullName: body.name || email, firstName: (body.name || '').split(' ')[0] || '', title: 'Referred contact', email }, 'Referral');
        await q(`UPDATE employers SET selected_contact_id = $2, decision = 'recontact' WHERE id = $1`, [r.employer_id, c.contact.id]);
        await logEvent(r.employer_id, `Referral ${email} added`);
        await requalify(r.employer_id);
        try { await enroll(r.employer_id); } catch (e) { await done(); return { ok: true, message: `Referral added. Not enrolled yet: ${e.message}` }; }
        await done(); return { ok: true, message: `Referral ${email} enrolled.` };
      }
      case 'nextContact':
        await q(`UPDATE employers SET decision = 'recontact', selected_contact_id = NULL WHERE id = $1`, [r.employer_id]);
        await requalify(r.employer_id);
        await done(); return { ok: true, message: 'Cleared for a new contact. Review it in the Prospect Queue.' };
      case 'resumeOoo': {
        const at = new Date(Date.now() + 7 * 864e5);
        await resumeSequence(r.employer_id, at);
        await done(); return { ok: true, message: `Sequence resumes ${at.toDateString()}.` };
      }
      default: throw httpError(400, 'Unknown action');
    }
    return { ok: true };
  },

  'POST /api/tasks/:id/done': async ({ params }) => { await q('UPDATE tasks SET done = true WHERE id = $1', [params.id]); return { ok: true }; },

  'GET /api/performance': async () => {
    const bySource = await q(`
      WITH e AS (SELECT id, CASE WHEN array_length(sources,1) > 1 THEN 'Both sources' WHEN sources = ARRAY['PM'] THEN 'PracticeMatch only' WHEN sources = ARRAY['Lusha'] THEN 'Lusha only' ELSE 'Other' END AS src FROM employers)
      SELECT e.src,
        count(DISTINCT e.id) AS employers,
        count(DISTINCT m.employer_id) AS contacted,
        count(DISTINCT r.employer_id) FILTER (WHERE r.category NOT IN ('ooo','bounce')) AS replied,
        count(DISTINCT r.employer_id) FILTER (WHERE r.category IN ('interested','referral')) AS positive
      FROM e LEFT JOIN messages m ON m.employer_id = e.id AND m.status = 'sent'
             LEFT JOIN replies r ON r.employer_id = e.id
      GROUP BY e.src ORDER BY e.src`);
    const daily = await q(`SELECT d::date AS day,
        (SELECT count(*) FROM messages m WHERE m.status = 'sent' AND (m.sent_at AT TIME ZONE $1)::date = d::date) AS sent,
        (SELECT count(*) FROM replies r WHERE (r.received_at AT TIME ZONE $1)::date = d::date AND r.category NOT IN ('ooo','bounce')) AS replies
      FROM generate_series((now() AT TIME ZONE $1)::date - 13, (now() AT TIME ZONE $1)::date, interval '1 day') d ORDER BY d`, [cfg.timezone]);
    const k = await one(`SELECT
        (SELECT count(*) FROM employers WHERE bucket <> 'suppressed') AS qualified,
        (SELECT count(*) FROM employers WHERE bucket = 'suppressed') AS blocked,
        (SELECT count(DISTINCT employer_id) FROM messages WHERE status = 'sent') AS contacted,
        (SELECT count(*) FROM messages WHERE status = 'sent') AS sent,
        (SELECT count(*) FROM contacts WHERE email IS NOT NULL AND NOT bad) AS usable_contacts,
        (SELECT count(*) FROM replies WHERE category NOT IN ('ooo','bounce')) AS human_replies,
        (SELECT count(DISTINCT employer_id) FROM replies WHERE category IN ('interested','referral')) AS positive,
        (SELECT count(*) FROM meetings) AS meetings,
        (SELECT count(*) FROM replies WHERE category = 'bounce') AS bounces`);
    return { kpis: Object.fromEntries(Object.entries(k).map(([a, b]) => [a, Number(b)])), bySource, daily, credits: await lusha.creditsUsed() };
  },

  'GET /api/settings': async () => {
    const protectedAccounts = await q('SELECT id, name, domain FROM protected_accounts ORDER BY name');
    const suppressions = await q('SELECT id, kind, value, reason, created_at FROM suppressions ORDER BY created_at DESC LIMIT 500');
    return {
      settings: await getSettings(), defaults: { templates: DEFAULT_TEMPLATES }, types: Object.values(EMPLOYER_TYPES).filter((t) => ![EMPLOYER_TYPES.UNKNOWN, EMPLOYER_TYPES.SA, EMPLOYER_TYPES.OTHER].includes(t)),
      protectedAccounts, suppressions,
      integrations: { ...integrations(), outlook: await outlook.connection(), redirectUri: outlook.redirectUri(), dryRun: cfg.dryRun, scheduler: cfg.schedulerEnabled, timezone: cfg.timezone, sendBlocked: await kvGet('send_blocked') },
      credits: await lusha.creditsUsed(),
    };
  },

  'PUT /api/settings': async ({ body }) => {
    const s = await saveSettings(body || {});
    await requalifyAll();
    return { ok: true, settings: s };
  },

  'POST /api/protected': async ({ body }) => {
    const lines = String(body.text || '').split('\n').map((l) => l.trim()).filter(Boolean);
    let n = 0;
    for (const l of lines) {
      let [name, domain] = l.split(/[|,\t]/).map((x) => (x || '').trim());
      // A bare domain, @domain or email on its own line protects that domain.
      if (!domain && /^[^\s|]*@?[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(name)) { domain = name.replace(/^.*@/, ''); name = normDomain(domain); }
      domain = normDomain((domain || '').replace(/^.*@/, ''));
      if (!name) continue;
      await q(`INSERT INTO protected_accounts (name, norm_name, domain) VALUES ($1, $2, $3) ON CONFLICT (norm_name) DO UPDATE SET domain = coalesce(EXCLUDED.domain, protected_accounts.domain)`, [name, normName(name), normDomain(domain)]);
      n++;
    }
    const stoppedIds = await q(`SELECT e.id FROM employers e JOIN protected_accounts p ON p.norm_name = e.norm_name OR (p.domain IS NOT NULL AND p.domain = e.domain)
                                JOIN sequences s ON s.employer_id = e.id AND s.status IN ('active','paused')`);
    for (const { id } of stoppedIds) await stopSequence(id, 'Employer added to protected accounts');
    await requalifyAll();
    return { ok: true, message: `${n} protected account(s) saved.` };
  },
  'DELETE /api/protected/:id': async ({ params }) => { await q('DELETE FROM protected_accounts WHERE id = $1', [params.id]); await requalifyAll(); return { ok: true }; },
  'DELETE /api/suppressions/:id': async ({ params }) => { await q('DELETE FROM suppressions WHERE id = $1', [params.id]); await requalifyAll(); return { ok: true }; },

  'POST /api/import/practicematch': async ({ body }) => {
    let rows;
    try { rows = pm.parseImport(String(body.text || ''), body.kind); } catch (e) { throw httpError(400, `Could not read that file: ${e.message}`); }
    if (!rows.length) throw httpError(400, 'No listings found. The file needs at least an employer column.');
    const sum = await importListings(rows, 'upload');
    return { ok: true, message: `${sum.listings} listings read: ${sum.newEmployers} new employers, ${sum.newOpenings} new openings, ${sum.newContacts} new contacts.`, summary: sum };
  },

  'POST /api/jobs/discovery': async () => {
    const key = `manual-${zoned().ymd}-${Date.now()}`;
    return { ok: true, summary: await runJob('discovery', key, () => runDiscovery({ trigger: 'manual' })) };
  },
  'POST /api/jobs/replies': async () => ({ ok: true, summary: await pollReplies() }),
  'GET /api/jobs': async () => ({ runs: await q(`SELECT * FROM job_runs WHERE job = 'discovery' ORDER BY started_at DESC LIMIT 20`) }),

  'POST /api/outlook/disconnect': async () => { await outlook.disconnect(); return { ok: true }; },
  'POST /api/outlook/test': async ({ body }) => {
    const me = await outlook.whoAmI();
    const to = body.to || me.mail || me.userPrincipalName;
    await outlook.sendNew({ to, subject: 'MedConnect platform: test email', body: 'This is a test from your Client Acquisition Platform. Outlook sending works.' });
    return { ok: true, message: `Test email sent to ${to}.` };
  },

  'GET /api/lusha/industries': async () => lusha.industryValues(),

  'GET /api/lusha/check': async () => {
    const s = await getSettings();
    const r = await lusha.prospectContacts({ ...s, lusha: { ...s.lusha, pageSize: 25 } }, 0);
    const ctx = await loadContext();
    await resolveIndustries(r.results);
    const previews = r.results.slice(0, 25).map((p) => {
      const d = prospectDecision(p, ctx, inferType);
      return { ...p, type: d.type, decision: d.reason, ok: d.ok, tier: d.tier };
    });
    return { ok: true, previews, passed: previews.filter((x) => x.ok).length, titlesSearched: lusha.searchTitles(s).length, pagination: r.pagination, rawKeys: Object.keys(r.raw || {}), rawSample: (r.raw?.results || [])[0] || null, filters: { used: r.filterUsed, sent: r.companyFilterSent }, credits: await lusha.creditsUsed() };
  },
};

export function httpError(status, message) { const e = new Error(message); e.status = status; return e; }
