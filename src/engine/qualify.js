// Qualification, protection and queue placement. Every employer's status, score, reasons and queue bucket
// are recomputed here and stored on the row, so the dashboard just reads them.
import { q, one } from '../db.js';
import { getSettings, EMPLOYER_TYPES as T } from '../settings.js';
import { normName, normDomain, lines, emailDomain } from '../util.js';
import { classifyEmployer } from '../integrations/ai.js';
import { cfg } from '../config.js';

export async function loadContext() {
  const settings = await getSettings();
  const prot = await q('SELECT name, norm_name, domain FROM protected_accounts');
  const supp = await q('SELECT kind, value FROM suppressions');
  return {
    settings,
    protectedByName: new Map(prot.map((p) => [p.norm_name, p.name])),
    protectedByDomain: new Map(prot.filter((p) => p.domain).map((p) => [normDomain(p.domain), p.name])),
    suppressedEmails: new Set(supp.filter((s) => s.kind === 'email').map((s) => s.value.toLowerCase())),
    suppressedDomains: new Set(supp.filter((s) => s.kind === 'domain').map((s) => normDomain(s.value))),
    excludeKeywords: lines(settings.excludeKeywords).map((k) => k.toLowerCase()),
    titlePriority: lines(settings.titlePriority).map((k) => k.toLowerCase()),
  };
}

export function titleRank(title, ctx) {
  const t = (title || '').toLowerCase();
  const i = ctx.titlePriority.findIndex((k) => t.includes(k));
  return i < 0 ? 99 : i;
}

export function isUsable(c, ctx) {
  if (!c.email || c.bad) return false;
  if (ctx.suppressedEmails.has(c.email.toLowerCase()) || ctx.suppressedDomains.has(emailDomain(c.email))) return false;
  // A contact published on the listing is the listing's own recruiter, so it is usable even with a vague title.
  return titleRank(c.title, ctx) < 99 || c.sources.includes('PM') || c.sources.includes('Referral');
}

export function rankContacts(contacts, ctx) {
  return contacts.filter((c) => isUsable(c, ctx)).sort((a, b) =>
    (titleRank(a.title, ctx) - titleRank(b.title, ctx))
    || ((b.sources.includes('PM') ? 1 : 0) - (a.sources.includes('PM') ? 1 : 0))
    || (({ 'A+': 4, A: 3, 'B+': 2, B: 1 })[b.email_confidence] || 0) - (({ 'A+': 4, A: 3, 'B+': 2, B: 1 })[a.email_confidence] || 0));
}

export function protectionMatch(emp, ctx) {
  return ctx.protectedByName.get(emp.norm_name) || (emp.domain && ctx.protectedByDomain.get(normDomain(emp.domain))) || null;
}

/** Pure evaluation (no writes). */
export function evaluate(emp, openings, contacts, seqs, ctx) {
  const s = ctx.settings;
  const prot = protectionMatch(emp, ctx)
    || contacts.map((c) => c.email && ctx.protectedByDomain.get(emailDomain(c.email))).find(Boolean) || null;
  const chosen = (emp.selected_contact_id && rankContacts(contacts, ctx).find((c) => c.id === emp.selected_contact_id)) || rankContacts(contacts, ctx)[0] || null;
  const open = seqs.find((x) => x.status === 'active' || x.status === 'paused');
  const anySeq = seqs.length > 0;

  let status; let reasons = []; let score = null;
  if (prot) { status = 'protected'; reasons = [`Matches protected account: ${prot}`]; }
  else if (emp.decision === 'suppressed') { status = 'suppressed'; reasons = ['Suppressed by owner']; }
  else if (emp.domain && ctx.suppressedDomains.has(normDomain(emp.domain))) { status = 'suppressed'; reasons = ['Domain is on the suppression list']; }
  else {
    const kw = ctx.excludeKeywords.find((k) => emp.norm_name.includes(normName(k)));
    if (emp.type === T.SA || kw) { status = 'excluded'; reasons = [`Staffing or recruiting firm${kw ? ` (name contains "${kw}")` : ''}`]; }
    else {
      const active = openings.filter((o) => o.active);
      const restr = active.find((o) => o.restriction);
      if (restr) reasons.push(`Listing ${restr.external_id} says: "${restr.restriction}"`);
      if (emp.type === T.UNKNOWN) reasons.push('Could not determine employer type');
      else if (!s.types.includes(emp.type)) reasons.push(`Employer type not targeted: ${emp.type}`);
      if (active.length && !active.some((o) => s.specialties.some((sp) => (o.specialty || '').toLowerCase().includes(sp.toLowerCase())))) {
        reasons.push(`Openings are outside target specialties (${[...new Set(active.map((o) => o.specialty))].join(', ')})`);
      }
      score = 45 + Math.min(active.length, 3) * 10;
      const fresh = active.some((o) => Date.now() - new Date(o.posted_at || o.first_seen).getTime() < 4 * 864e5);
      if (fresh) score += 10;
      if (emp.sources.length > 1) score += 10;
      if (chosen?.sources.includes('PM')) score += 5;
      if (!active.length) score -= 10;
      score = Math.max(0, Math.min(100, score));
      if (reasons.length) status = 'review';
      else if (!chosen) { status = 'needs_contact'; reasons = [emp.domain ? 'No usable recruiting or HR contact yet' : 'No contact yet, and the employer website is unknown']; }
      else if (!emp.domain) { status = 'review'; reasons = ['Employer domain not confirmed (contact uses a personal email)']; }
      else status = 'qualified';
    }
  }

  let bucket;
  if (open) bucket = 'outreach';
  else if (anySeq && emp.decision !== 'recontact') bucket = 'outreach';
  else if (['protected', 'excluded', 'suppressed'].includes(status)) bucket = 'suppressed';
  else if (status === 'needs_contact') bucket = 'contact';
  else if (emp.decision === 'held') { bucket = 'review'; reasons = ['Held by owner', ...reasons]; }
  else if (status === 'review') bucket = (emp.decision === 'approved' || emp.decision === 'recontact') && chosen ? 'ready' : 'review';
  else if (emp.decision === 'approved' || emp.decision === 'recontact') bucket = 'ready';
  else if (s.supervised) { bucket = 'review'; reasons = [...reasons, 'Supervised launch: owner approval required']; }
  else if (score >= s.threshold) bucket = 'ready';
  else { bucket = 'review'; reasons = [...reasons, `Score ${score} is below the auto-approve threshold of ${s.threshold}`]; }

  return { status, reasons, score, bucket, chosen };
}

export async function requalify(employerId, ctx) {
  ctx = ctx || await loadContext();
  let emp = await one('SELECT * FROM employers WHERE id = $1', [employerId]);
  if (!emp) return null;
  if (emp.type === T.UNKNOWN && !emp.ai_checked && cfg.anthropicApiKey) {
    const ai = await classifyEmployer({ name: emp.name, domain: emp.domain });
    emp = await one('UPDATE employers SET ai_checked = true, type = coalesce($2, type) WHERE id = $1 RETURNING *', [emp.id, ai?.type || null]);
  }
  const [openings, contacts, seqs] = await Promise.all([
    q('SELECT * FROM openings WHERE employer_id = $1', [emp.id]),
    q('SELECT * FROM contacts WHERE employer_id = $1', [emp.id]),
    q('SELECT * FROM sequences WHERE employer_id = $1', [emp.id]),
  ]);
  const r = evaluate(emp, openings, contacts, seqs, ctx);
  await q('UPDATE employers SET status = $2, reasons = $3::jsonb, score = $4, bucket = $5 WHERE id = $1',
    [emp.id, r.status, JSON.stringify(r.reasons), r.score, r.bucket]);
  return { ...r, employer: emp, openings, contacts, seqs };
}

export async function requalifyAll() {
  const ctx = await loadContext();
  const ids = await q('SELECT id FROM employers ORDER BY id');
  for (const { id } of ids) await requalify(id, ctx);
  return ids.length;
}
