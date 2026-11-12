// Lusha API v3 client: prospecting search (free previews), decision-makers lookup by company domain,
// and Enrich Contacts (the step that spends credits). Every call records credits from `billing`.
// Field mapping is defensive and lives in normalizeContact(); run `npm run lusha:check` against your key
// to print raw responses if Lusha changes a field name.
import { cfg } from '../config.js';
import { q, one } from '../db.js';
import { normDomain } from '../util.js';

export class LushaError extends Error {
  constructor(status, message, body) { super(`Lusha ${status}: ${message}`); this.status = status; this.body = body; }
}

async function call(method, path, body) {
  if (!cfg.lushaApiKey) throw new LushaError(0, 'LUSHA_API_KEY is not set');
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(cfg.lushaBaseUrl + path, {
      method,
      headers: { api_key: cfg.lushaApiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json; try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
    if (res.status === 429 && attempt < 3) { await new Promise((r) => setTimeout(r, 2000 * (attempt + 1))); continue; }
    if (!res.ok) {
      const msg = json?.message || json?.error?.message || (Array.isArray(json?.errors) ? json.errors.map((e) => e.message || e).join('; ') : '') || res.statusText;
      throw new LushaError(res.status, msg, json);
    }
    await recordUsage(json?.billing?.creditsCharged || 0);
    return json;
  }
}

async function recordUsage(credits) {
  await q(`INSERT INTO lusha_usage (day, credits, calls) VALUES (current_date, $1, 1)
           ON CONFLICT (day) DO UPDATE SET credits = lusha_usage.credits + EXCLUDED.credits, calls = lusha_usage.calls + 1`, [Math.round(credits)]);
}

export async function creditsUsed() {
  const r = await one(`SELECT
      coalesce(sum(credits) FILTER (WHERE day = current_date), 0) AS today,
      coalesce(sum(credits) FILTER (WHERE date_trunc('month', day) = date_trunc('month', current_date)), 0) AS month
    FROM lusha_usage`);
  return { today: Number(r.today), month: Number(r.month) };
}

/** Pull a usable contact shape out of any Lusha v3 result object. */
export function normalizeContact(r) {
  if (!r || typeof r !== 'object') return null;
  const d = r.data && typeof r.data === 'object' ? { ...r, ...r.data } : r;
  const jt = d.jobTitle;
  const title = typeof jt === 'string' ? jt : jt?.title || d.title || '';
  const company = d.company || {};
  const emails = d.emails || d.emailAddresses || [];
  const best = [...emails].sort((a, b) => rankConf(b.confidence || b.emailConfidence) - rankConf(a.confidence || a.emailConfidence))
    .find((e) => (e.email || e.address) && !/personal/i.test(e.type || e.emailType || ''));
  const phones = d.phones || d.phoneNumbers || [];
  const phone = phones.find((p) => p.number && !p.doNotCall) || null;
  const first = d.firstName || d.name?.first || '';
  const last = d.lastName || d.name?.last || '';
  return {
    lushaId: String(d.id ?? d.contactId ?? d.personId ?? ''),
    firstName: first,
    lastName: last,
    fullName: d.fullName || [first, last].filter(Boolean).join(' '),
    title,
    departments: (typeof jt === 'object' && jt?.departments) || d.departments || [],
    email: best ? (best.email || best.address) : null,
    emailConfidence: best ? (best.confidence || best.emailConfidence || null) : null,
    phone: phone ? phone.number : null,
    companyName: company.name || d.companyName || '',
    companyDomain: normDomain(company.domain || company.fqdn || d.companyDomain || d.fqdn),
    companyId: company.id != null ? String(company.id) : (d.companyId != null ? String(d.companyId) : null),
    industry: findIndustry(company) || findIndustry(d) || '',
    city: d.location?.city || null,
    state: d.location?.state || null,
    hasEmail: Boolean(best) || (Array.isArray(d.has) ? d.has.includes('emails') : Boolean(d.has?.emails)),
    error: d.error || null,
  };
}
/** Collect any industry-like fields (industry, mainIndustry, subIndustry, industries[]…) into one label. */
export function findIndustry(obj) {
  if (!obj || typeof obj !== 'object') return '';
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    if (!/industr/i.test(k)) continue;
    if (typeof v === 'string') out.push(v);
    else if (Array.isArray(v)) v.forEach((x) => out.push(typeof x === 'string' ? x : x?.name || x?.label || x?.value || ''));
    else if (v && typeof v === 'object') out.push(v.name || v.label || v.value || '');
  }
  return [...new Set(out.filter(Boolean))].join(' / ');
}
const rankConf = (c) => ({ 'A+': 5, A: 4, 'B+': 3, B: 2, C: 1 })[c] ?? 0;

/** Walk any response and collect objects that look like contacts (have an id and a name). */
function collectContacts(json) {
  const out = [];
  const walk = (v) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!v || typeof v !== 'object') return;
    if ((v.id != null || v.contactId != null) && (v.firstName || v.fullName || v.data?.firstName || v.emails || v.emailAddresses || v.jobTitle)) { out.push(v); return; }
    Object.values(v).forEach(walk);
  };
  walk(json);
  return out;
}

/** Every title in the four priority tiers, without the "(CEO)" style abbreviations. */
export function searchTitles(settings, tiers = settings.lusha?.prospectTiers || [1, 2, 3, 4]) {
  const out = [];
  for (const k of tiers.map((n) => `tier${n}`)) for (const l of (settings.titleTiers?.[k] || '').split('\n')) {
    const t = l.replace(/\s*\([^)]*\)\s*$/, '').trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out.length ? out : (settings.lusha.jobTitles || []);
}

function excludeNames(settings) {
  return (settings.doNotProspect || '').split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 100);
}

function companyInclude(L) {
  const inc = {};
  if (L.mainIndustriesIds?.length) inc.mainIndustriesIds = L.mainIndustriesIds.map(Number);
  if (L.subIndustriesIds?.length) inc.subIndustriesIds = L.subIndustriesIds.map(Number);
  if (L.industriesLabels?.length) inc.industriesLabels = L.industriesLabels;
  return inc;
}

/** Find Lusha's industry filter values on this account. Tries the known filter endpoints and returns
 *  every industry entry it can find as { id, name, parentId?, parentName? }. */
export async function industryValues() {
  const paths = ['/v3/companies/prospecting/filters/industries', '/v3/companies/prospecting/filters/mainIndustries',
    '/v3/companies/prospecting/filters/industriesLabels', '/prospecting/filters/companies/industries_labels'];
  const tried = [];
  for (const p of paths) {
    try {
      const json = await call('GET', p);
      const out = [];
      const walk = (v, parent) => {
        if (Array.isArray(v)) return v.forEach((x) => walk(x, parent));
        if (!v || typeof v !== 'object') return;
        const name = v.name || v.label || v.value || v.main_industry || v.mainIndustry;
        const id = v.id ?? v.main_industry_id ?? v.mainIndustryId ?? v.sub_industry_id ?? v.subIndustryId;
        if (name && id != null) out.push({ id, name, parentId: parent?.id ?? null, parentName: parent?.name ?? null });
        for (const k of Object.keys(v)) if (Array.isArray(v[k])) walk(v[k], name && id != null ? { id, name } : parent);
      };
      walk(json, null);
      if (out.length) return { endpoint: p, values: out };
      tried.push(`${p}: no values`);
    } catch (e) { tried.push(`${p}: ${e.message}`); }
  }
  return { endpoint: null, values: [], tried };
}

/** Prospecting search for decision-makers at US healthcare employers. Returns previews (no emails). */
export async function prospectContacts(settings, page) {
  const L = settings.lusha;
  const locations = (L.states?.length ? L.states.map((s) => ({ country: 'United States', state: s })) : [{ country: 'United States' }]);
  const body = {
    pagination: { page, size: Math.min(100, Math.max(10, L.pageSize)) },
    filters: {
      contacts: { include: { jobTitles: searchTitles(settings), locations, existingDataPoints: ['work_email'] } },
      companies: { include: companyInclude(L), exclude: { names: excludeNames(settings) } },
    },
    // Plan-dependent options. If Lusha rejects one for this plan, retry without options;
    // contacts-per-company is also enforced on our side, and DNC phones are never used (email only).
    options: { maxContactsPerCompany: L.maxContactsPerCompany },
  };
  let json;
  try {
    json = await call('POST', '/v3/contacts/prospecting', body);
  } catch (e) {
    if (!(e instanceof LushaError) || ![400, 403, 422].includes(e.status)) throw e;
    // Drop plan-dependent extras one at a time (options, then company excludes) and retry.
    delete body.options;
    try { json = await call('POST', '/v3/contacts/prospecting', body); }
    catch (e2) {
      if (!(e2 instanceof LushaError) || ![400, 403, 422].includes(e2.status)) throw e2;
      delete body.filters.companies.exclude;
      json = await call('POST', '/v3/contacts/prospecting', body);
    }
  }
  return { results: collectContacts(json.results ?? json).map(normalizeContact).filter(Boolean), pagination: json.pagination || {}, raw: json };
}

/** Ranked decision-makers at known companies (by domain). Returns previews (no emails). */
export async function decisionMakers(domains) {
  const json = await call('POST', '/v3/contacts/decision-makers', { companies: domains.map((domain) => ({ domain })) });
  return collectContacts(json).map(normalizeContact).filter(Boolean);
}

/** Reveal emails/phones for up to 100 contact ids. This spends credits. */
export async function enrichContacts(ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += 100) {
    const json = await call('POST', '/v3/contacts/enrich', { ids: ids.slice(i, i + 100).map(String), reveal: ['emails', 'phones'] });
    out.push(...collectContacts(json.results ?? json).map(normalizeContact).filter(Boolean));
  }
  return out;
}

/** Look up company domains by name (for listings that came without a website or email). */
export async function companyDomains(items) {
  if (!items.length) return new Map();
  const json = await call('POST', '/v3/companies/search', {
    companies: items.map((it) => ({ clientReferenceId: String(it.ref), name: it.name })),
  });
  const out = new Map();
  const walk = (v) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!v || typeof v !== 'object') return;
    const domain = normDomain(v.domain || v.fqdn || v.website || v.company?.domain);
    if (v.clientReferenceId != null && domain) { out.set(String(v.clientReferenceId), { domain, name: v.name || v.company?.name || '' }); return; }
    Object.values(v).forEach(walk);
  };
  walk(json.results ?? json);
  return out;
}

/** Look up industry labels for companies by domain (for prospects whose results came without one). */
export async function companyIndustries(domains) {
  const out = new Map();
  const list = [...new Set(domains.filter(Boolean))].slice(0, 100);
  if (!list.length) return out;
  const json = await call('POST', '/v3/companies/search', { companies: list.map((d) => ({ clientReferenceId: d, domain: d })) });
  const walk = (v) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!v || typeof v !== 'object') return;
    if (v.clientReferenceId != null) { const ind = findIndustry(v) || findIndustry(v.company || v.data || {}); if (ind) out.set(String(v.clientReferenceId), ind); return; }
    Object.values(v).forEach(walk);
  };
  walk(json.results ?? json);
  return out;
}

export async function filterValues(type) {
  return call('GET', `/v3/contacts/prospecting/filters/${encodeURIComponent(type)}`);
}
