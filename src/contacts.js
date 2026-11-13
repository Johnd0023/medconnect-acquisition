// Client contact database: every contact the system has found or you added, with where they came from,
// which client they're with, the job posts behind them and the outreach history. Exportable to Excel.
import { q, one, logEvent } from './db.js';
import { isRelay, isFreeMail, emailDomain } from './util.js';
import { upsertEmployer, addContact } from './engine/ingest.js';
import { writeXlsx } from './xlsx.js';

const SOURCE = { PM: 'PracticeMatch', Lusha: 'Lusha', Referral: 'Added by you', Manual: 'Added by you', Import: 'Import' };
const REPLY = { interested: 'Interested', not_now: 'Not right now', referral: 'Referred elsewhere', wrong_contact: 'Wrong contact', opt_out: 'Opted out', ooo: 'Out of office', bounce: 'Bounced', other: 'Replied' };
export const STATUSES = ['Not contacted', 'In sequence', 'Emailed', 'Interested', 'Replied', 'Not right now', 'Do not contact', 'Current client'];

function outreachStatus(r) {
  if (r.emp_status === 'protected') return 'Current client';
  if (r.bad || r.suppressed || ['opt_out', 'bounce'].includes(r.last_reply)) return 'Do not contact';
  if (r.last_reply === 'interested') return 'Interested';
  if (r.last_reply === 'not_now') return 'Not right now';
  if (r.last_reply && !['ooo'].includes(r.last_reply)) return 'Replied';
  if (['active', 'paused'].includes(r.seq_status)) return 'In sequence';
  if (Number(r.sent_count) > 0) return 'Emailed';
  return 'Not contacted';
}

export async function listContacts({ search = '', source = '', state = '', status = '', direct = '', limit = 5000 } = {}) {
  const rows = await q(`
    SELECT c.id, c.full_name, c.first_name, c.last_name, c.title, c.email, c.phone, c.email_confidence, c.sources, c.bad, c.notes, c.created_at,
           e.id AS employer_id, e.name AS employer, e.type, e.city, e.state, e.domain, e.status AS emp_status,
           (SELECT jsonb_agg(j) FROM (SELECT coalesce(o.title, concat_ws(' ', o.specialty, o.role)) AS title, o.pm_code AS code, o.url, o.city, o.state, o.posted_at AS posted, o.active
                                      FROM openings o WHERE o.employer_id = e.id AND c.email IS NOT NULL AND lower(o.contact_email) = lower(c.email)
                                      ORDER BY o.posted_at DESC NULLS LAST LIMIT 10) j) AS jobs,
           m.sent_count, m.last_sent, r.category AS last_reply, r.received_at AS last_reply_at, s.status AS seq_status, s.step AS seq_step,
           EXISTS (SELECT 1 FROM suppressions x WHERE c.email IS NOT NULL AND ((x.kind = 'email' AND x.value = lower(c.email))
                   OR (x.kind = 'domain' AND x.value = split_part(lower(c.email), '@', 2) AND split_part(lower(c.email), '@', 2) <> 'practicematch.com'))) AS suppressed
      FROM contacts c JOIN employers e ON e.id = c.employer_id
      LEFT JOIN LATERAL (SELECT count(*) FILTER (WHERE status = 'sent') AS sent_count, max(sent_at) FILTER (WHERE status = 'sent') AS last_sent
                           FROM messages WHERE employer_id = e.id AND (contact_id = c.id OR (c.email IS NOT NULL AND position(lower(c.email) IN lower(to_email)) > 0))) m ON true
      LEFT JOIN LATERAL (SELECT category, received_at FROM replies WHERE employer_id = e.id AND (contact_id = c.id OR (c.email IS NOT NULL AND lower(from_email) = lower(c.email)))
                           ORDER BY received_at DESC LIMIT 1) r ON true
      LEFT JOIN LATERAL (SELECT status, step FROM sequences WHERE contact_id = c.id OR c.id = ANY(cc_contact_ids) ORDER BY id DESC LIMIT 1) s ON true
     WHERE ($1 = '' OR c.full_name ILIKE '%' || $1 || '%' OR c.email ILIKE '%' || $1 || '%' OR c.title ILIKE '%' || $1 || '%'
            OR e.name ILIKE '%' || $1 || '%' OR e.city ILIKE '%' || $1 || '%' OR coalesce(c.notes, '') ILIKE '%' || $1 || '%')
       AND ($2 = '' OR $2 = ANY(c.sources) OR ($2 = 'Manual' AND 'Referral' = ANY(c.sources)))
       AND ($3 = '' OR upper(e.state) = upper($3))
       AND ($4 = '' OR (c.email IS NOT NULL AND c.email NOT ILIKE '%@practicematch.com'))
     ORDER BY e.name, c.full_name NULLS LAST, c.id
     LIMIT ${Math.min(Number(limit) || 5000, 20000)}`, [String(search).trim(), source, String(state).trim(), direct ? '1' : '']);
  return rows.map((r) => {
    const jobs = r.jobs || [];
    const relay = r.email ? isRelay(r.email) : false;
    const foundVia = [...new Set((r.sources || []).map((x) => SOURCE[x] || x))];
    return {
      ...r, jobs, relay,
      name: r.full_name || [r.first_name, r.last_name].filter(Boolean).join(' ') || (relay ? 'PracticeMatch posting contact' : ''),
      foundVia,
      outreach: outreachStatus(r),
      lastReplyLabel: r.last_reply ? REPLY[r.last_reply] || r.last_reply : null,
      sent_count: Number(r.sent_count || 0),
    };
  }).filter((r) => !status || r.outreach === status);
}

export async function updateContact(id, body) {
  const allowed = ['notes', 'phone', 'title', 'full_name'];
  const sets = []; const vals = [id];
  for (const k of allowed) if (k in body) { vals.push(String(body[k] ?? '').slice(0, 4000) || null); sets.push(`${k} = $${vals.length}`); }
  if (!sets.length) return { ok: true };
  const c = await one(`UPDATE contacts SET ${sets.join(', ')} WHERE id = $1 RETURNING id, employer_id`, [...vals]);
  if (!c) throw Object.assign(new Error('Contact not found'), { status: 404 });
  return { ok: true, message: 'Saved' };
}

/** Add a contact by hand. Unless "outreach" is ticked, a brand-new client is held so the automation never emails them. */
export async function createContact(body) {
  const email = String(body.email || '').trim().toLowerCase();
  const name = String(body.name || '').trim();
  const company = String(body.company || '').trim();
  if (!company) throw Object.assign(new Error('Enter the client/company name.'), { status: 400 });
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw Object.assign(new Error('That email address doesn\'t look right.'), { status: 400 });
  if (!email && !name) throw Object.assign(new Error('Enter at least a name or an email.'), { status: 400 });
  const website = String(body.website || '').trim() || (email && !isFreeMail(email) && !isRelay(email) ? emailDomain(email) : '');
  const { employer, isNew } = await upsertEmployer({ name: company, domain: website, city: body.city || null, state: body.state || null, source: 'Manual' });
  const parts = name.split(/\s+/).filter(Boolean);
  const r = await addContact(employer.id, { fullName: name || email, firstName: parts[0] || '', lastName: parts.slice(1).join(' '), title: body.title || '', email: email || null, phone: body.phone || null }, 'Manual');
  if (body.notes) await q('UPDATE contacts SET notes = $2 WHERE id = $1', [r.contact.id, String(body.notes).slice(0, 4000)]);
  if (isNew && !body.outreach) await q(`UPDATE employers SET decision = 'held', bucket = 'review' WHERE id = $1`, [employer.id]);
  await logEvent(employer.id, `Contact added by owner on the Contacts page: ${name || email}`);
  return { ok: true, message: `${name || email} saved under ${employer.name}${isNew && !body.outreach ? ' (held: no automated emails)' : ''}`, id: r.contact.id };
}

const fmtDate = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');

export async function exportContacts(filters) {
  const list = await listContacts({ ...filters, limit: 20000 });
  const contacts = {
    name: 'Contacts',
    columns: [
      { header: 'Name', width: 24 }, { header: 'Title', width: 28 }, { header: 'Email', width: 32 }, { header: 'Phone', width: 16 },
      { header: 'Client / Company', width: 34 }, { header: 'Client type', width: 16 }, { header: 'City', width: 16 }, { header: 'State', width: 7 },
      { header: 'Website', width: 24 }, { header: 'Found via', width: 18 }, { header: 'Job posts', width: 48 }, { header: 'PracticeMatch codes', width: 20 },
      { header: 'Job post link', width: 30 }, { header: 'Outreach status', width: 16 }, { header: 'Emails sent', width: 11 }, { header: 'Last emailed', width: 13 },
      { header: 'Last reply', width: 18 }, { header: 'Last reply date', width: 14 }, { header: 'Email type', width: 22 }, { header: 'Added', width: 12 }, { header: 'Notes', width: 40 },
    ],
    rows: list.map((r) => [
      r.name, r.title || '', r.email || '', r.phone || '', r.employer, r.type || '', r.city || '', r.state || '',
      r.domain ? { text: r.domain, link: `https://${r.domain}` } : '', r.foundVia.join(', '),
      r.jobs.map((j) => [j.title, [j.city, j.state].filter(Boolean).join(', ')].filter(Boolean).join(' – ')).join('; '),
      r.jobs.map((j) => j.code).filter(Boolean).join(', '),
      r.jobs[0]?.url ? { text: 'Open post', link: r.jobs[0].url } : '',
      r.outreach, r.sent_count, fmtDate(r.last_sent), r.lastReplyLabel || '', fmtDate(r.last_reply_at),
      r.relay ? 'PracticeMatch forwarding' : r.email ? 'Direct' : '', fmtDate(r.created_at), r.notes || '',
    ]),
  };
  const clientRows = new Map();
  for (const r of list) {
    const c = clientRows.get(r.employer_id) || { r, n: 0, jobs: new Set(), via: new Set() };
    c.n++; r.jobs.forEach((j) => c.jobs.add(j.title)); r.foundVia.forEach((v) => c.via.add(v)); clientRows.set(r.employer_id, c);
  }
  const clients = {
    name: 'Clients',
    columns: [{ header: 'Client / Company', width: 34 }, { header: 'Type', width: 16 }, { header: 'City', width: 16 }, { header: 'State', width: 7 }, { header: 'Website', width: 24 },
      { header: 'Contacts', width: 10 }, { header: 'Found via', width: 18 }, { header: 'Openings seen', width: 50 }, { header: 'Protected (current client)', width: 14 }],
    rows: [...clientRows.values()].map(({ r, n, jobs, via }) => [r.employer, r.type || '', r.city || '', r.state || '', r.domain ? { text: r.domain, link: `https://${r.domain}` } : '', n, [...via].join(', '), [...jobs].slice(0, 12).join('; '), r.emp_status === 'protected' ? 'Yes' : '']),
  };
  const stamp = new Date().toISOString().slice(0, 10);
  return { __file: { name: `MedConnect-Contacts-${stamp}.xlsx`, type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', data: writeXlsx([contacts, clients]) }, count: list.length };
}
