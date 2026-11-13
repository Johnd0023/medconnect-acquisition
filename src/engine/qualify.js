// Qualification, protection and queue placement. Every employer's status, score, reasons and queue bucket
// are recomputed here and stored on the row, so the dashboard just reads them.
import { q, one } from '../db.js';
import { getSettings, EMPLOYER_TYPES as T } from '../settings.js';
import { normName, normDomain, lines, emailDomain, isFreeMail } from '../util.js';
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
  const base = m ? [m[1], m[2]] : [line];
  const out = [...base];
  for (const b of base) {
    // "HR Director" also matches "Director of HR", and the other way round.
    const tail = b.match(/^(.+?)\s+(director|manager|head|lead|partner|coordinator|specialist|administrator)$/i);
    if (tail) out.push(`${tail[2]} of ${tail[1]}`);
    const head = b.match(/^(director|manager|head|vp|vice president|lead)\s+of\s+(.+)$/i);
    if (head) out.push(`${head[2]} ${head[1]}`);
  }
  return out;
}
const LEADERSHIP = new Set(['director', 'vice', 'president', 'head', 'chief', 'officer', 'executive']);
// Words that may sit inside a phrase without changing its meaning.
const FILLER = new Set(['provider', 'physician', 'advanced', 'practice', 'senior', 'associate', 'assistant', 'interim', 'regional', 'system', 'medical', 'clinical', 'group', 'and']);
// Non-clinical functions: a title in one of these is never a target, unless it is also about provider recruiting.
const NON_TARGET_FUNCTION = /\b(data|technology|technical|information|it|security|cyber|engineering|software|digital|innovation|analytics|automation|marketing|communications|brand|branding|sales|commercial|business development|finance|financial|revenue|accounting|tax|treasury|legal|counsel|compliance|procurement|supply chain|facilities|real estate|construction|research|medical affairs|regulatory|investor)\b/;
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
  if (/@practicematch\.com$/i.test(c.email) && ctx.settings.practicematch?.relayOutreach === false) return false;
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
/** Employer type from industry codes, when Lusha provides them. null = no codes to go on. */
export function typeFromCodes(naics = [], sic = []) {
  for (const c of naics) {
    if (/^62221/.test(c)) return T.BH;
    if (/^622/.test(c)) return T.HS;
    if (/^621112|^62142/.test(c)) return T.BH;
    if (/^6211/.test(c)) return T.PG;
    if (/^621493/.test(c)) return T.UC;
    if (/^62149[18]/.test(c)) return T.CHC;
  }
  for (const c of sic) {
    if (c === '8063') return T.BH;
    if (c === '8062' || c === '8069') return T.HS;
    if (c === '8011') return T.PG;
    if (c === '8093') return T.UC;
  }
  return naics.length || sic.length ? T.OTHER : null; // has codes, none of them patient care
}

export function prospectDecision({ companyName, companyDomain, industry, title, departments, aiType, naics, sic, careCodeSearch }, ctx, inferType) {
  const s = ctx.settings;
  const pseudo = { name: companyName, norm_name: normName(companyName), domain: normDomain(companyDomain) };
  const byCodes = typeFromCodes(naics, sic);
  let type = byCodes || inferType(companyName, industry);
  if (type === T.UNKNOWN && aiType) type = aiType;
  // Found by a search limited to patient-care NAICS/SIC codes: the code filter already confirms it's a care provider.
  if (type === T.UNKNOWN && careCodeSearch) type = T.HS;
  // A staffing-firm name still wins over codes.
  if (inferType(companyName, '') === T.SA) type = T.SA;
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

const GENERIC_NAME = new Set(['health', 'healthcare', 'hospital', 'medical', 'medical center', 'clinic', 'physicians', 'medical group', 'health system', 'care']);

export function protectionMatch(emp, ctx) {
  const byName = ctx.protectedByName.get(emp.norm_name);
  if (byName) return byName;
  // A protected name inside a longer employer name: "Riverbend Health System" ⊂ "Riverbend Health System Columbus Campus"
  const padded = ' ' + (emp.norm_name || '') + ' ';
  for (const [pn, name] of ctx.protectedByName) {
    if (pn.length >= 8 && !GENERIC_NAME.has(pn) && padded.includes(' ' + pn + ' ')) return name;
  }
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

const isRelayAddr = (e) => /@practicematch\.com$/i.test(e || '');

/**
 * System-wide protected-client guard. Looks at everything known about who an email is really for:
 * the employer record, the recipient address (domain and sibling domains), and every job posting behind it
 * (hiring organization name, website, posting contact). PracticeMatch forwarding addresses are judged by the
 * client behind them, since the address itself is @practicematch.com.
 * Returns the matched protected account name, or null.
 */
export function protectedRecipientMatch({ employer, contact, contacts = [], openings = [] }, ctx) {
  const byDomain = (d) => d && (ctx.protectedByDomain.get(normDomain(d)) || ctx.protectedByRoot.get(domainRoot(d)));
  const hit = employer && protectionMatch(employer, ctx);
  if (hit) return hit;
  for (const c of [contact, ...contacts].filter(Boolean)) {
    if (c.email && !isRelayAddr(c.email)) { const m = byDomain(emailDomain(c.email)); if (m) return m; }
  }
  for (const o of openings) {
    const raw = o.raw || {};
    const org = raw.employer;
    if (org) { const m = protectionMatch({ norm_name: normName(org), domain: normDomain(raw.domain || raw.website || '') }, ctx); if (m) return m; }
    const site = byDomain(raw.domain || raw.website);
    if (site) return site;
    if (o.contact_email && !isRelayAddr(o.contact_email)) { const m = byDomain(emailDomain(o.contact_email)); if (m) return m; }
  }
  return null;
}

/** Contacts to email at this employer: the owner's picks, or every posting contact, or the single best contact. */
export function selectedContacts(emp, contacts, openings, ctx) {
  const ranked = rankContacts(contacts, ctx);
  const max = Math.max(1, ctx.settings.maxContactsPerEmployer || 3);
  if (ctx.settings.multiContact === 'single') {
    const pick = (emp.selected_contact_ids || [])[0] || emp.selected_contact_id;
    return [ranked.find((c) => c.id === pick) || ranked[0]].filter(Boolean);
  }
  if (emp.selected_contact_ids?.length) return emp.selected_contact_ids.map((id) => ranked.find((c) => c.id === id)).filter(Boolean).slice(0, max);
  if (emp.selected_contact_id) { const c = ranked.find((x) => x.id === emp.selected_contact_id); if (c) return [c]; }
  const posting = new Set(openings.filter((o) => o.active && o.contact_email).map((o) => o.contact_email.toLowerCase()));
  const owners = ranked.filter((c) => posting.has((c.email || '').toLowerCase()));
  return (owners.length ? owners : ranked.slice(0, 1)).slice(0, max);
}

/** Pure evaluation (no writes). */
export function evaluate(emp, openings, contacts, seqs, ctx) {
  const s = ctx.settings;
  const prot = protectedRecipientMatch({ employer: emp, contacts, openings }, ctx);
  const selected = selectedContacts(emp, contacts, openings, ctx);
  const chosen = selected[0] || null;
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
      if (restr && s.respectNoAgency) reasons.push(`Listing ${restr.external_id} says: "${restr.restriction}"`);
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
      else if (!emp.domain && isFreeMail(chosen.email)) { status = 'review'; reasons = ['Employer domain not confirmed (contact uses a personal email)']; }
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

  return { status, reasons, score, bucket, chosen, selected };
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
