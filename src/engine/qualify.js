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
    // "commonspirit" from commonspirit.org also covers commonspirit.careers and "CommonSpirit Health".
    protectedByRoot: new Map(prot.filter((p) => p.domain).map((p) => [domainRoot(p.domain), p.name]).filter(([r]) => r && r.length >= 6)),
    suppressedEmails: new Set(supp.filter((s) => s.kind === 'email').map((s) => s.value.toLowerCase())),
    suppressedDomains: new Set(supp.filter((s) => s.kind === 'domain').map((s) => normDomain(s.value))),
    excludeKeywords: lines(settings.excludeKeywords).map((k) => k.toLowerCase()),
    doNotProspect: lines(settings.doNotProspect).map((k) => normName(k)).filter(Boolean),
    titleTiers: ['tier1', 'tier2', 'tier3', 'tier4'].map((k) => lines(settings.titleTiers?.[k]).flatMap(titleVariants).map(tokens)),
    departments: lines(settings.departments).map((d) => tokens(d)),
  };
}

const STOP = new Set(['of', 'and', 'the', 'for', 'to', 'in', 'at', '&', '-', 'a']);
const ABBR = [[/\bvp\b|\bv\.p\./g, 'vice president'], [/\bsvp\b/g, 'senior vice president'], [/\bavp\b/g, 'assistant vice president'], [/\bevp\b/g, 'executive vice president'],
  [/\bsr\.?\b/g, 'senior'], [/\bdir\.?\b/g, 'director'], [/\bmgr\.?\b/g, 'manager'], [/\bhr\b/g, 'human resources'], [/\bta\b/g, 'talent acquisition'],
  [/\bapps?\b/g, 'advanced practice'], [/\bceo\b/g, 'chief executive officer'], [/\bcoo\b/g, 'chief operating officer'], [/\bcmo\b/g, 'chief medical officer'],
  [/\bchro\b/g, 'chief human resources officer'], [/\bcno\b/g, 'chief nursing officer'], [/\bops\b/g, 'operations'], [/\bassoc\.?\b/g, 'associate'],
  [/\brecruiting\b|\brecruitment\b|\brecruiters?\b/g, 'recruit'], [/\bproviders\b/g, 'provider'], [/\bphysicians\b/g, 'physician']];
export function tokens(text) {
  let t = (text || '').toLowerCase().replace(/&/g, ' and ').replace(/[(),/|:]/g, ' ');
  for (const [re, rep] of ABBR) t = t.replace(re, rep);
  return t.replace(/[^a-z ]/g, ' ').split(/\s+/).filter((w) => w && !STOP.has(w));
}
/** "Chief Executive Officer (CEO)" → both the full title and "CEO". */
function titleVariants(line) {
  const m = line.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
  return m ? [m[1], m[2]] : [line];
}
const LEADERSHIP = new Set(['director', 'vice', 'president', 'head', 'chief', 'officer', 'executive']);
// Words that may sit inside a phrase without changing its meaning.
const FILLER = new Set(['provider', 'physician', 'advanced', 'practice', 'senior', 'associate', 'assistant', 'interim', 'regional', 'system', 'medical', 'clinical', 'group', 'and']);
// Non-clinical functions: a title in one of these is never a target, unless it is also about provider recruiting.
const NON_TARGET_FUNCTION = /\b(data|technology|technical|information|it|security|cyber|engineering|software|digital|innovation|analytics|automation|marketing|communications|brand|branding|sales|commercial|business development|finance|financial|revenue|accounting|tax|treasury|legal|counsel|compliance|procurement|supply chain|facilities|real estate|construction|research|medical affairs|regulatory|investor|product|strategy)\b/;
/** True when the phrase's words appear in the title in the same order, with at most one extra word
 *  between neighbours ("Director of Physician Recruitment" ⊂ "Senior Director of Physician and Provider Recruitment"). */
const containsAll = (have, need) => {
  if (!need.length) return false;
  for (let start = 0; start < have.length; start++) {
    if (have[start] !== need[0]) continue;
    let pos = start; let ok = true;
    for (let k = 1; k < need.length; k++) {
      const next = have.indexOf(need[k], pos + 1);
      if (next < 0 || next - pos > 2 || (next - pos === 2 && !FILLER.has(have[pos + 1]))) { ok = false; break; }
      pos = next;
    }
    if (ok) return true;
  }
  return false;
};

// Recruiters for corporate, campus, tech, sales or nursing roles are not who MedConnect needs.
const NON_CLINICAL_RECRUITING = /executive and corporate|corporate (recruit|talent)|early career|campus|university recruit|employer brand|recruitment marketing|talent (marketing|brand)|technology recruit|tech recruit|\bit recruit|engineering recruit|sales recruit|finance recruit|retail recruit|pharmacy recruit|nurse recruit|nursing recruit|\brn recruit/;

/** 1-4 = your priority tiers (1 best), 5 = only the department matches, 99 = not a target contact. */
export function titleRank(title, ctx, departments = []) {
  const t = (title || '').toLowerCase();
  if (!t || NON_CLINICAL_RECRUITING.test(t)) return 99;
  if (NON_TARGET_FUNCTION.test(t) && !/(physician|provider|clinician|advanced practice|\bapp\b|medical staff)[^,;]*recruit|recruit[^,;]*(physician|provider|clinician)/.test(t)) return 99;
  const have = tokens(t);
  // Most specific matching phrase wins (more words = more specific); a leadership title
  // (director, VP, head, chief…) only matches a phrase that is itself a leadership title.
  const leader = have.some((w) => LEADERSHIP.has(w));
  let best = null;
  ctx.titleTiers.forEach((phrases, i) => {
    for (const need of phrases) {
      if (!containsAll(have, need)) continue;
      if (leader && !need.some((w) => LEADERSHIP.has(w))) continue;
      if (!best || need.length > best.len || (need.length === best.len && i + 1 < best.tier)) best = { tier: i + 1, len: need.length };
    }
  });
  if (best) return best.tier;
  const deptTokens = (Array.isArray(departments) ? departments : [departments]).filter(Boolean).map(tokens);
  if (deptTokens.some((d) => ctx.departments.some((need) => containsAll(d, need)))) return 5;
  return 99;
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

const GENERIC_ROOTS = new Set(['health', 'healthcare', 'medical', 'hospital', 'clinic', 'physicians', 'careers', 'mychart', 'gmail', 'outlook', 'hotmail', 'yahoo']);
export function domainRoot(d) {
  const parts = (normDomain(d) || '').split('.');
  if (parts.length < 2) return null;
  const root = parts[parts.length - 2] === 'co' && parts.length > 2 ? parts[parts.length - 3] : parts[parts.length - 2];
  return GENERIC_ROOTS.has(root) ? null : root;
}

export function onDoNotProspect(normalizedName, ctx) {
  return ctx.doNotProspect.find((k) => normalizedName === k || normalizedName.startsWith(k + ' ') || normalizedName.includes(' ' + k + ' ') || normalizedName.endsWith(' ' + k)) || null;
}

/** Decide, before spending any Lusha credits, whether a prospect's company is worth unlocking.
 *  Returns { ok, reason, type }. */
export function prospectDecision({ companyName, companyDomain, industry, title, departments, aiType }, ctx, inferType) {
  const s = ctx.settings;
  const pseudo = { name: companyName, norm_name: normName(companyName), domain: normDomain(companyDomain) };
  let type = inferType(companyName, industry);
  if (type === T.UNKNOWN && aiType) type = aiType;
  if (protectionMatch(pseudo, ctx)) return { ok: false, reason: 'Skip: current client', type };
  if (pseudo.domain && ctx.suppressedDomains.has(pseudo.domain)) return { ok: false, reason: 'Skip: suppressed domain', type };
  if (type === T.SA || ctx.excludeKeywords.some((k) => pseudo.norm_name.includes(normName(k)))) return { ok: false, reason: 'Skip: staffing firm', type };
  if (onDoNotProspect(pseudo.norm_name, ctx)) return { ok: false, reason: 'Skip: not a provider (do-not-prospect list)', type };
  if (type === T.OTHER) return { ok: false, reason: 'Skip: not a provider employer', type };
  const tier = titleRank(title, ctx, departments);
  if (tier >= 99) return { ok: false, reason: 'Skip: title not in your priority tiers', type };
  if (type === T.UNKNOWN) return { ok: false, reason: "Skip: can't confirm it provides patient care", type };
  if (!s.types.includes(type)) return { ok: false, reason: 'Skip: employer type not targeted', type };
  return { ok: true, reason: tier <= 4 ? `Would unlock · Priority ${tier}` : 'Would unlock · department match', type, tier };
}

export function protectionMatch(emp, ctx) {
  const byName = ctx.protectedByName.get(emp.norm_name);
  if (byName) return byName;
  if (emp.domain) {
    const exact = ctx.protectedByDomain.get(normDomain(emp.domain));
    if (exact) return exact;
    const root = domainRoot(emp.domain);
    if (root && ctx.protectedByRoot.get(root)) return ctx.protectedByRoot.get(root);
  }
  const squashed = (emp.norm_name || '').replace(/ /g, '');
  for (const [root, name] of ctx.protectedByRoot) {
    if ((' ' + emp.norm_name + ' ').includes(' ' + root + ' ') || squashed.startsWith(root)) return name;
  }
  return null;
}

/** Pure evaluation (no writes). */
export function evaluate(emp, openings, contacts, seqs, ctx) {
  const s = ctx.settings;
  const prot = protectionMatch(emp, ctx)
    || contacts.map((c) => c.email && (ctx.protectedByDomain.get(emailDomain(c.email)) || ctx.protectedByRoot.get(domainRoot(emailDomain(c.email))))).find(Boolean) || null;
  const chosen = (emp.selected_contact_id && rankContacts(contacts, ctx).find((c) => c.id === emp.selected_contact_id)) || rankContacts(contacts, ctx)[0] || null;
  const open = seqs.find((x) => x.status === 'active' || x.status === 'paused');
  const anySeq = seqs.length > 0;

  let status; let reasons = []; let score = null;
  if (prot) { status = 'protected'; reasons = [`Matches protected account: ${prot}`]; }
  else if (emp.decision === 'suppressed') { status = 'suppressed'; reasons = ['Suppressed by owner']; }
  else if (emp.domain && ctx.suppressedDomains.has(normDomain(emp.domain))) { status = 'suppressed'; reasons = ['Domain is on the suppression list']; }
  else {
    const kw = ctx.excludeKeywords.find((k) => emp.norm_name.includes(normName(k)));
    const dnp = onDoNotProspect(emp.norm_name, ctx);
    if (emp.type === T.SA || kw) { status = 'excluded'; reasons = [`Staffing or recruiting firm${kw ? ` (name contains "${kw}")` : ''}`]; }
    else if (dnp || emp.type === T.OTHER) { status = 'excluded'; reasons = [dnp ? `Not a provider employer (do-not-prospect list: "${dnp}")` : 'Not a provider employer']; }
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
