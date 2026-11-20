// Client campaigns: outreach to the people at ONE client the owner already has a contract with (e.g. CommonSpirit
// Health under a nationwide MSA). Completely separate from prospect outreach:
//  - its own contact list: everyone at the client's entities in the database, including protected/suppressed ones
//  - its own 3-email sequence and templates
//  - nothing is sent until the owner approves that specific email (follow-ups included, by default)
//  - right before each send, Outlook is searched again for any email with that person since the approval
import { q, one, logEvent } from '../db.js';
import { normName, normDomain, emailDomain, isFreeMail, lines, isRelay, startOfBusinessDay } from '../util.js';
import { domainRoot, loadContext, protectedRecipientMatch } from './qualify.js';
import * as outlook from '../integrations/outlook.js';

export const COMMONSPIRIT_FAMILY = `CommonSpirit Health | commonspirit.org
CommonSpirit Careers | commonspirit.careers
Dignity Health | dignityhealth.org
Dignity Health Medical Foundation
Catholic Health Initiatives | catholichealth.net
CHI *
CHI Health | chihealth.com
CHI St. Luke's Health | stlukeshealth.org
CHI St. Vincent | chistvincent.com
CHI Saint Joseph Health | chisaintjosephhealth.org
CHI St. Alexius Health | chistalexiushealth.org
CHI Memorial
CHI Mercy Health
Virginia Mason Franciscan Health | vmfh.org
Virginia Mason Medical Center | virginiamason.org
St. Joseph's Hospital and Medical Center
Barrow Neurological Institute | barrowneuro.org
St. Rose Dominican
Chandler Regional Medical Center
Mercy Gilbert Medical Center`;

export const COMMONSPIRIT_TEMPLATES = {
  initial_opening: {
    label: 'Initial email: they have an opening',
    subject: '{{client}} MSA in place: {{specialty}} {{role}} in {{city}}, {{state}}',
    body: `Hi {{first_name}},

We came across your {{specialty}} {{role}} opening in {{city}}, {{state}} on PracticeMatch{{more_openings}}.

I wanted to reach out because MedConnect Staffing already has a master services agreement in place with {{client}} nationwide, so there's no new contract or vendor setup needed on your end.

Are these openings available for us to recruit on, and approved for outside partners? If so, I'd be happy to connect so I can get more details and have our team get started on them right away.

{{brochure}}

Thank you,
{{sender_name}}`,
  },
  initial_general: {
    label: 'Initial email: no opening on file',
    subject: '{{client}} MSA in place: provider recruiting support for {{employer}}',
    body: `Hi {{first_name}},

We came across your information on PracticeMatch and wanted to reach out.

MedConnect Staffing already has a master services agreement in place with {{client}} nationwide, so there's no new contract or vendor setup needed on your end.

Do you have any physician or APP openings that are available for us to recruit on and approved for outside partners? If so, I'd be happy to connect so I can get more details and have our team get started on them right away.

{{brochure}}

Thank you,
{{sender_name}}`,
  },
  followup_1: {
    label: 'Follow-up 1',
    subject: 'RE: {{client}} MSA in place: recruiting support for {{employer}}',
    body: `Hi {{first_name}},

Just following up on my note below. Since MedConnect already has a nationwide master services agreement with {{client}}, we can start on {{signal_line}} as soon as it's approved for outside recruiting, with no new paperwork.

Is it open to outside partners? If you're not the right person for this, I'd appreciate a point in the right direction.

Thank you,
{{sender_name}}`,
  },
  followup_2: {
    label: 'Follow-up 2',
    subject: 'RE: {{client}} MSA in place: recruiting support for {{employer}}',
    body: `Hi {{first_name}},

One last note from me. If {{employer}} has any physician or APP searches approved for agency support, now or in the coming months, we're already contracted with {{client}} through our master services agreement and can start right away.

Happy to connect whenever the timing works.

Thank you,
{{sender_name}}`,
  },
};

export const CAMPAIGN_DEFAULT_SETTINGS = { dailyLimit: 25, approveFollowUps: true };

/** Create the built-in CommonSpirit campaign once. */
export async function ensureCampaigns() {
  await q(`INSERT INTO campaigns (slug, name, client, family, templates, settings) VALUES ('commonspirit', 'CommonSpirit MSA', 'CommonSpirit Health', $1, $2::jsonb, $3::jsonb)
           ON CONFLICT (slug) DO NOTHING`, [COMMONSPIRIT_FAMILY, JSON.stringify(COMMONSPIRIT_TEMPLATES), JSON.stringify(CAMPAIGN_DEFAULT_SETTINGS)]);
}

export async function getCampaign(idOrSlug) {
  const c = /^\d+$/.test(String(idOrSlug))
    ? await one('SELECT * FROM campaigns WHERE id = $1', [Number(idOrSlug)])
    : await one('SELECT * FROM campaigns WHERE slug = $1', [String(idOrSlug)]);
  if (!c) return null;
  return { ...c, family: c.family || (c.slug === 'commonspirit' ? COMMONSPIRIT_FAMILY : ''), settings: { ...CAMPAIGN_DEFAULT_SETTINGS, ...(c.settings || {}) }, templates: { ...COMMONSPIRIT_TEMPLATES, ...(c.templates || {}) } };
}

/* ---------------- who belongs to the client ---------------- */

const GENERIC = new Set(['health', 'healthcare', 'hospital', 'medical', 'medical center', 'clinic', 'physicians', 'medical group', 'health system', 'care']);

/** "Name | domain" lines → matcher. A line ending in " *" matches names that start with it ("CHI *"). */
export function parseFamily(text) {
  const names = []; const prefixes = []; const domains = [];
  for (const line of lines(text)) {
    const [rawName, rawDomain] = line.split('|').map((x) => (x || '').trim());
    if (/\s\*$/.test(rawName)) { const p = normName(rawName.replace(/\s*\*$/, '')); if (p) prefixes.push([p, rawName.replace(/\s*\*$/, '').trim()]); }
    else if (rawName && !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(rawName)) { const n = normName(rawName); if (n && !GENERIC.has(n)) names.push([n, rawName]); }
    const d = normDomain(rawDomain || (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(rawName) ? rawName : ''));
    if (d) domains.push([d, rawName || d]);
  }
  return { names, prefixes, domains };
}

function nameHit(norm, fam) {
  if (!norm) return null;
  const padded = ` ${norm} `;
  for (const [n, label] of fam.names) if (norm === n || (n.length >= 8 && padded.includes(` ${n} `))) return label;
  for (const [p, label] of fam.prefixes) if (norm === p || norm.startsWith(p + ' ')) return label;
  return null;
}
function domainHit(d, fam) {
  d = normDomain(d || '');
  if (!d) return null;
  for (const [fd, label] of fam.domains) {
    if (d === fd || d.endsWith('.' + fd)) return label;
    const r = domainRoot(d);
    if (r && r.length >= 6 && r === domainRoot(fd)) return label;
  }
  return null;
}

/** Which of the client's entities (if any) an employer, contact or posting belongs to. */
export function familyMatch({ employer, contacts = [], openings = [] }, fam) {
  if (employer) {
    const h = nameHit(employer.norm_name || normName(employer.name || ''), fam) || domainHit(employer.domain, fam);
    if (h) return h;
  }
  for (const c of contacts) if (c?.email && !isRelay(c.email)) { const h = domainHit(emailDomain(c.email), fam); if (h) return h; }
  for (const o of openings) {
    const raw = o.raw || {};
    const h = (raw.employer && nameHit(normName(raw.employer), fam)) || domainHit(raw.domain || raw.website, fam)
      || (o.contact_email && !isRelay(o.contact_email) && domainHit(emailDomain(o.contact_email), fam));
    if (h) return h;
  }
  return null;
}

/** Protected-account context with the campaign client's own entries removed (so only OTHER protected clients block). */
export async function otherProtectedContext(fam) {
  const ctx = await loadContext();
  const isFam = (name, domain) => nameHit(normName(name || ''), fam) || (domain && domainHit(domain, fam));
  const strip = (m, isDomain) => new Map([...m].filter(([k, name]) => !isFam(name, isDomain ? k : null)));
  return { ...ctx, protectedByName: strip(ctx.protectedByName), protectedByDomain: strip(ctx.protectedByDomain, true), protectedByRoot: strip(ctx.protectedByRoot) };
}

/* ---------------- the contact list ---------------- */

async function familyEmployers(fam) {
  const [emps, openings, contacts] = await Promise.all([
    q('SELECT id, name, norm_name, domain, city, state, status, decision FROM employers'),
    q(`SELECT id, employer_id, role, specialty, city, state, posted_at, first_seen, active, pm_code, contact_email, raw, url FROM openings`),
    q('SELECT * FROM contacts WHERE email IS NOT NULL'),
  ]);
  const oBy = new Map(); for (const o of openings) { if (!oBy.has(o.employer_id)) oBy.set(o.employer_id, []); oBy.get(o.employer_id).push(o); }
  const cBy = new Map(); for (const c of contacts) { if (!cBy.has(c.employer_id)) cBy.set(c.employer_id, []); cBy.get(c.employer_id).push(c); }
  const out = [];
  for (const e of emps) {
    const os = oBy.get(e.id) || []; const cs = cBy.get(e.id) || [];
    const entity = familyMatch({ employer: e }, fam) || familyMatch({ openings: os }, fam);
    // A contact with a client email domain counts even when filed under an unrelated employer name
    const domainContacts = entity ? cs : cs.filter((c) => familyMatch({ contacts: [c] }, fam));
    if (entity || domainContacts.length) out.push({ employer: e, entity: entity || familyMatch({ contacts: domainContacts }, fam), openings: os, contacts: domainContacts });
  }
  return out;
}

/**
 * Everyone at the client the owner could email, one row per email address, with what's known about prior contact.
 * Opted-out, bounced and @practicematch.com addresses are never listed.
 */
export async function campaignBoard(campaignId) {
  const camp = await getCampaign(campaignId);
  const fam = parseFamily(camp.family);
  const ctx = await loadContext();
  const groups = await familyEmployers(fam);
  const decisions = new Map((await q('SELECT * FROM campaign_contacts WHERE campaign_id = $1', [camp.id])).map((d) => [d.email, d]));
  const seqs = await q(`SELECT s.*, c.email, (SELECT max(m.sent_at) FROM messages m WHERE m.sequence_id = s.id AND m.status = 'sent') AS last_sent
                        FROM sequences s JOIN contacts c ON c.id = s.contact_id WHERE s.campaign_id = $1 ORDER BY s.id DESC`, [camp.id]);
  const seqBy = new Map(); for (const s of seqs) if (!seqBy.has(s.email.toLowerCase())) seqBy.set(s.email.toLowerCase(), s);
  const people = new Map(); let optedOut = 0; let relayOnly = 0;
  const noContact = [];
  for (const g of groups) {
    const active = g.openings.filter((o) => o.active);
    let usable = 0; let optedHere = 0;
    for (const c of g.contacts) {
      const email = c.email.toLowerCase();
      if (isRelay(email)) continue;
      if (c.bad || ctx.suppressedEmails.has(email) || ctx.suppressedDomains.has(emailDomain(email))) { optedOut++; optedHere++; continue; }
      usable++;
      const mine = active.filter((o) => (o.contact_email || '').toLowerCase() === email);
      const ops = (mine.length ? mine : active).sort((a, b) => new Date(b.posted_at || b.first_seen) - new Date(a.posted_at || a.first_seen));
      const row = people.get(email) || { email, contactId: c.id, employerId: g.employer.id, name: c.full_name, firstName: c.first_name, title: c.title, sources: c.sources,
        entity: g.employer.name, matchedAs: g.entity, openings: [], otherEntities: [], freeMail: isFreeMail(email) };
      if (people.has(email) && row.employerId !== g.employer.id) {
        // Same recruiter posting for several entities: keep the one with the most recent opening as the main record
        const newer = ops[0] && (!row.openings[0] || new Date(ops[0].posted_at || ops[0].first_seen) > new Date(row.openings[0].postedAt || 0));
        if (newer) { row.otherEntities.push(row.entity); Object.assign(row, { contactId: c.id, employerId: g.employer.id, entity: g.employer.name, name: row.name || c.full_name, title: row.title || c.title }); }
        else row.otherEntities.push(g.employer.name);
      }
      for (const o of ops.slice(0, 4)) row.openings.push({ role: o.role, specialty: o.specialty, city: o.city, state: o.state, postedAt: o.posted_at || o.first_seen, code: o.pm_code, url: o.url, entity: g.employer.name });
      people.set(email, row);
    }
    if (!usable && !optedHere && active.length) {
      if (g.contacts.some((c) => isRelay(c.email))) relayOnly++;
      noContact.push({ employerId: g.employer.id, entity: g.employer.name, matchedAs: g.entity, city: g.employer.city, state: g.employer.state, domain: g.employer.domain,
        openings: active.slice(0, 4).map((o) => ({ role: o.role, specialty: o.specialty, city: o.city, state: o.state, postedAt: o.posted_at || o.first_seen, code: o.pm_code })), openingCount: active.length });
    }
  }
  // What the app itself has sent them before (regular outreach), and replies
  const emails = [...people.keys()];
  const prior = emails.length ? await q(`SELECT lower(c.email) AS email, max(m.sent_at) AS at, count(*)::int AS n, bool_or(s.campaign_id IS NOT NULL) AS camp
      FROM messages m JOIN contacts c ON c.id = m.contact_id LEFT JOIN sequences s ON s.id = m.sequence_id
      WHERE m.status = 'sent' AND lower(c.email) = ANY($1) AND (s.campaign_id IS NULL OR s.campaign_id <> $2) GROUP BY 1`, [emails, camp.id]) : [];
  const priorBy = new Map(prior.map((p) => [p.email, p]));
  const reps = emails.length ? await q(`SELECT lower(from_email) AS email, max(received_at) AS at, (array_agg(category ORDER BY received_at DESC))[1] AS category FROM replies WHERE lower(from_email) = ANY($1) GROUP BY 1`, [emails]) : [];
  const repBy = new Map(reps.map((r) => [r.email, r]));

  const rows = [...people.values()].map((p) => {
    const d = decisions.get(p.email); const s = seqBy.get(p.email);
    let stage = 'review';
    if (s) {
      if (s.status === 'active' && s.approved_step < s.step) stage = 'followup';
      else if (s.status === 'active' && s.step === 0) stage = 'queued';
      else if (s.status === 'active') stage = 'sequence';
      else stage = 'done';
    } else if (d?.decision === 'skipped') stage = 'skipped';
    return { ...p, stage, decisionNote: d?.note || null, outlook: d?.outlook || null, checkedAt: d?.checked_at || null, edited: Object.keys(d?.drafts || {}).filter((k) => d.drafts[k]?.body),
      appEmailed: priorBy.get(p.email) || null, replied: repBy.get(p.email) || null,
      seq: s ? { id: s.id, step: s.step, status: s.status, nextAt: s.next_at, approvedStep: s.approved_step, stopReason: s.stop_reason, holdNote: s.hold_note, lastSent: s.last_sent, replied: s.replied } : null };
  }).sort((a, b) => new Date(b.openings[0]?.postedAt || 0) - new Date(a.openings[0]?.postedAt || 0) || a.entity.localeCompare(b.entity));
  noContact.sort((a, b) => new Date(b.openings[0]?.postedAt || 0) - new Date(a.openings[0]?.postedAt || 0));
  const counts = { review: 0, followup: 0, queued: 0, sequence: 0, done: 0, skipped: 0 };
  for (const r of rows) counts[r.stage]++;
  counts.nocontact = noContact.length;
  const sentToday = (await one(`SELECT count(*)::int AS n FROM messages m JOIN sequences s ON s.id = m.sequence_id WHERE s.campaign_id = $1 AND m.status IN ('sent','dry_run') AND m.sent_at >= $2`, [camp.id, startOfBusinessDay()])).n;
  return { campaign: camp, rows, noContact, counts, optedOut, relayOnly, sentToday, entities: [...new Set(groups.map((g) => g.employer.name))].length };
}

/** How many people need the owner's decision (nav badge). */
let pendingCache = { at: 0, n: 0 };
export async function pendingCount() {
  if (Date.now() - pendingCache.at < 120000) return pendingCache.n; // the nav badge doesn't need to rescan every page load
  const camp = await getCampaign('commonspirit');
  if (!camp) return 0;
  const b = await campaignBoard(camp.id);
  pendingCache = { at: Date.now(), n: b.counts.review + b.counts.followup };
  return pendingCache.n;
}
export function setPendingFromBoard(b) { pendingCache = { at: Date.now(), n: b.counts.review + b.counts.followup }; }

/* ---------------- Outlook history ---------------- */

/** Search Outlook for email with this person; emails sent by this app are told apart from the owner's own. */
export async function checkOutlook(campaignId, email) {
  email = email.toLowerCase();
  const conn = await outlook.connection();
  if (!conn.connected) throw new Error('Outlook is not connected');
  const msgs = await outlook.historyWith(email);
  const ours = new Set((await q(`SELECT internet_message_id, conversation_id FROM messages WHERE status = 'sent' AND (internet_message_id IS NOT NULL OR conversation_id IS NOT NULL)`))
    .flatMap((m) => [m.internet_message_id, m.conversation_id]).filter(Boolean));
  const own = (conn.email || '').toLowerCase();
  const theirs = msgs.filter((m) => !ours.has(m.internetMessageId) && !ours.has(m.conversationId));
  const last = theirs[0];
  const summary = {
    total: theirs.length, fromApp: msgs.length - theirs.length,
    last: last ? { at: last.at, subject: last.subject, direction: last.from === email ? 'from them' : last.from === own ? 'from you' : 'cc' } : null,
    recent: theirs.slice(0, 5).map((m) => ({ at: m.at, subject: m.subject, direction: m.from === email ? 'from them' : 'from you' })),
  };
  await q(`INSERT INTO campaign_contacts (campaign_id, email, outlook, checked_at) VALUES ($1, $2, $3::jsonb, now())
           ON CONFLICT (campaign_id, email) DO UPDATE SET outlook = EXCLUDED.outlook, checked_at = now(), updated_at = now()`, [campaignId, email, JSON.stringify(summary)]);
  return { summary, messages: theirs };
}

/* ---------------- owner decisions ---------------- */

export async function approvePeople(campaignId, emails) {
  const camp = await getCampaign(campaignId);
  const board = await campaignBoard(camp.id);
  const by = new Map(board.rows.map((r) => [r.email, r]));
  let queued = 0; const skipped = [];
  for (const raw of emails) {
    const r = by.get(String(raw).toLowerCase());
    if (!r) { skipped.push(`${raw} (not on the list, opted out, or a PracticeMatch address)`); continue; }
    if (r.seq && (r.seq.status === 'active' || r.seq.status === 'paused')) { skipped.push(`${r.email} (already in the campaign)`); continue; }
    if (r.seq) { skipped.push(`${r.email} (already received the campaign)`); continue; }
    const busy = await one(`SELECT 1 FROM sequences WHERE contact_id = $1 AND status = 'active'`, [r.contactId]);
    if (busy) { skipped.push(`${r.email} (in a regular outreach sequence right now)`); continue; }
    const approvedStep = camp.settings.approveFollowUps ? 0 : 2;
    await q(`INSERT INTO sequences (employer_id, contact_id, step, next_at, status, campaign_id, approved_step, approved_at, priority) VALUES ($1,$2,0, now(),'active',$3,$4, now(), 1)`,
      [r.employerId, r.contactId, camp.id, approvedStep]);
    await q(`INSERT INTO campaign_contacts (campaign_id, email, decision) VALUES ($1,$2,'approved') ON CONFLICT (campaign_id, email) DO UPDATE SET decision = 'approved', updated_at = now()`, [camp.id, r.email]);
    await logEvent(r.employerId, `${camp.name}: initial email to ${r.email} approved by owner`);
    queued++;
  }
  return { queued, skipped };
}

export async function approveFollowUps(campaignId, seqIds) {
  const rows = await q(`UPDATE sequences SET approved_step = step, approved_at = now(), hold_note = NULL, priority = 1
                        WHERE campaign_id = $1 AND id = ANY($2::int[]) AND status = 'active' AND approved_step < step RETURNING id, employer_id, step`, [campaignId, seqIds.map(Number)]);
  for (const r of rows) await logEvent(r.employer_id, `Campaign follow-up ${r.step} approved by owner`);
  return rows.length;
}

export async function setDecision(campaignId, emails, decision, note = null) {
  for (const e of emails) {
    await q(`INSERT INTO campaign_contacts (campaign_id, email, decision, note) VALUES ($1,$2,$3,$4)
             ON CONFLICT (campaign_id, email) DO UPDATE SET decision = EXCLUDED.decision, note = EXCLUDED.note, updated_at = now()`, [campaignId, String(e).toLowerCase(), decision, note]);
  }
  return emails.length;
}

export async function saveDraft(campaignId, email, step, draft) {
  const val = draft ? JSON.stringify({ [String(step)]: { subject: String(draft.subject || '').slice(0, 300), body: String(draft.body || '').slice(0, 20000) } }) : null;
  if (val) {
    await q(`INSERT INTO campaign_contacts (campaign_id, email, drafts) VALUES ($1,$2,$3::jsonb)
             ON CONFLICT (campaign_id, email) DO UPDATE SET drafts = campaign_contacts.drafts || EXCLUDED.drafts, updated_at = now()`, [campaignId, email.toLowerCase(), val]);
  } else {
    await q(`UPDATE campaign_contacts SET drafts = drafts - $3 WHERE campaign_id = $1 AND email = $2`, [campaignId, email.toLowerCase(), String(step)]);
  }
}

/** Settings and fields used to compose this campaign's emails. */
export async function composeInputs(camp, email) {
  const d = await one('SELECT drafts FROM campaign_contacts WHERE campaign_id = $1 AND email = $2', [camp.id, email.toLowerCase()]);
  return { templates: camp.templates, drafts: d?.drafts || {}, extra: { client: camp.client } };
}

export { protectedRecipientMatch };
