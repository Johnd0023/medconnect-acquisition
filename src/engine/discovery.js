// The daily discovery run: PracticeMatch listings → Lusha prospecting → Lusha contact lookup for
// employers with no usable contact → requalify → auto-enroll (only when supervised launch is off).
// Lusha credits are only spent on employers that pass the protection and exclusion checks first.
import { q, one, kvGet, kvSet, logEvent } from '../db.js';
import { cfg } from '../config.js';
import { getSettings } from '../settings.js';
import * as lusha from '../integrations/lusha.js';
import * as pm from '../integrations/practicematch.js';
import { ingestListing, ingestLushaContact, addContact, inferType } from './ingest.js';
import { loadContext, requalify, requalifyAll, titleRank, prospectDecision } from './qualify.js';
import { enroll } from './outreach.js';
import { normName, normDomain } from '../util.js';
import { classifyEmployer } from '../integrations/ai.js';
import { EMPLOYER_TYPES as T } from '../settings.js';

/** Fill in a missing industry for prospects whose company the name alone can't place:
 *  1) Lusha company lookup by domain, 2) optional AI check. Mutates and returns the list. */
export async function resolveIndustries(prospects) {
  const unknown = prospects.filter((p) => inferType(p.companyName, p.industry) === T.UNKNOWN && p.companyDomain);
  if (unknown.length) {
    try {
      const found = await lusha.companyIndustries(unknown.map((p) => normDomain(p.companyDomain)));
      for (const p of unknown) { const ind = found.get(normDomain(p.companyDomain)); if (ind) p.industry = ind; }
    } catch (e) { /* lookup is best effort; unknown companies are simply skipped */ }
  }
  for (const p of prospects) {
    if (inferType(p.companyName, p.industry) !== T.UNKNOWN) continue;
    const ai = await classifyEmployer({ name: p.companyName, domain: p.companyDomain, industry: p.industry, context: 'Lusha prospect' });
    if (ai?.type) p.aiType = ai.type;
  }
  return prospects;
}

export async function importListings(rows, label = 'import') {
  const sum = { listings: rows.length, newEmployers: 0, newOpenings: 0, newContacts: 0, merged: 0, label };
  const touched = new Set();
  for (const row of rows) {
    const r = await ingestListing(row);
    touched.add(r.employerId);
    if (r.isNew) sum.newEmployers++; else sum.merged++;
    if (r.newOpening) sum.newOpenings++;
    if (r.newContact) sum.newContacts++;
  }
  const ctx = await loadContext();
  for (const id of touched) await requalify(id, ctx);
  return sum;
}

async function revealBudget(settings) {
  const used = await lusha.creditsUsed();
  const revealedToday = Number((await one(`SELECT count(*) AS n FROM contacts WHERE 'Lusha' = ANY(sources) AND created_at >= current_date`)).n);
  return {
    monthLeft: Math.max(0, settings.lusha.monthlyCreditBudget - used.month),
    todayLeft: Math.max(0, settings.lusha.dailyRevealLimit - revealedToday),
    used,
  };
}

/** Lusha prospecting: find decision-makers at healthcare employers we don't have yet. */
async function lushaProspecting(settings, ctx, sum) {
  let page = Number(await kvGet('lusha_prospect_page', 0)) || 0;
  for (let i = 0; i < settings.lusha.pagesPerDay; i++) {
    const budget = await revealBudget(settings);
    if (budget.todayLeft <= 0 || budget.monthLeft <= 0) { sum.notes.push('Lusha reveal budget reached'); break; }
    const { results, pagination } = await lusha.prospectContacts(settings, page);
    sum.lushaPreviews += results.length;
    if (!results.length) { page = 0; break; }
    await resolveIndustries(results);
    page = (pagination.total && (page + 1) * settings.lusha.pageSize >= pagination.total) ? 0 : page + 1;

    // Spend credits only on contacts at employers that pass protection/exclusion, and that we don't already know.
    const picks = [];
    const perCompany = new Map();
    for (const c of results.sort((a, b) => titleRank(a.title, ctx, a.departments) - titleRank(b.title, ctx, b.departments))) {
      if (!c.lushaId) continue;
      const pseudo = { norm_name: normName(c.companyName), domain: normDomain(c.companyDomain) };
      const d = prospectDecision(c, ctx, inferType);
      if (!d.ok) {
        if (/current client/.test(d.reason)) sum.skippedProtected++;
        else if (/staffing/.test(d.reason)) sum.skippedExcluded++;
        else sum.skippedNotTarget++;
        continue;
      }
      if (await one('SELECT 1 FROM contacts WHERE lusha_id = $1', [c.lushaId])) continue;
      const known = pseudo.domain && await one(`SELECT e.id FROM employers e JOIN contacts ct ON ct.employer_id = e.id WHERE e.domain = $1 AND ct.email IS NOT NULL AND NOT ct.bad LIMIT 1`, [pseudo.domain]);
      if (known) continue;
      const key = pseudo.domain || pseudo.norm_name;
      if ((perCompany.get(key) || 0) >= settings.lusha.maxContactsPerCompany) continue;
      perCompany.set(key, (perCompany.get(key) || 0) + 1);
      picks.push(c.lushaId);
      if (picks.length >= Math.min(budget.todayLeft, budget.monthLeft)) break;
    }
    if (!picks.length) continue;
    const enriched = await lusha.enrichContacts(picks);
    for (const c of enriched) {
      if (!c.email) continue;
      const r = await ingestLushaContact(c);
      if (!r) continue;
      sum.touched.add(r.employerId);
      if (r.isNew) sum.newEmployers++;
      if (r.newContact) { sum.newContacts++; sum.lushaRevealed++; }
    }
  }
  await kvSet('lusha_prospect_page', page);
}

/** For employers stuck on "needs contact", ask Lusha for ranked decision-makers by domain, then reveal the best. */
export async function lushaFillContacts(settings, ctx, sum, onlyIds = null) {
  // Listings that came without a website or email: ask Lusha for the company's domain first.
  const noDomain = onlyIds
    ? await q(`SELECT id, name, norm_name FROM employers WHERE id = ANY($1::int[]) AND domain IS NULL`, [onlyIds])
    : await q(`SELECT id, name, norm_name FROM employers WHERE status = 'needs_contact' AND domain IS NULL
               AND (enrich_attempted_at IS NULL OR enrich_attempted_at < now() - interval '30 days') ORDER BY last_signal DESC LIMIT 50`);
  if (noDomain.length) {
    const found = await lusha.companyDomains(noDomain.map((e) => ({ ref: e.id, name: e.name })));
    for (const e of noDomain) {
      const hit = found.get(String(e.id));
      if (!hit) continue;
      if (hit.name && normName(hit.name) !== e.norm_name) continue; // only accept an exact-name match
      if (await one('SELECT 1 FROM employers WHERE domain = $1', [hit.domain])) continue;
      await q('UPDATE employers SET domain = $2 WHERE id = $1', [e.id, hit.domain]);
      await logEvent(e.id, `Domain ${hit.domain} confirmed by Lusha`);
    }
  }
  const rows = onlyIds
    ? await q(`SELECT * FROM employers WHERE id = ANY($1::int[]) AND domain IS NOT NULL`, [onlyIds])
    : await q(`SELECT * FROM employers WHERE status = 'needs_contact' AND domain IS NOT NULL
               AND (enrich_attempted_at IS NULL OR enrich_attempted_at < now() - interval '30 days')
               ORDER BY last_signal DESC LIMIT 50`);
  for (let i = 0; i < rows.length; i += 25) {
    const batch = rows.slice(i, i + 25);
    const budget = await revealBudget(settings);
    if (budget.todayLeft <= 0 || budget.monthLeft <= 0) { sum.notes.push('Lusha reveal budget reached'); break; }
    await q(`UPDATE employers SET enrich_attempted_at = now() WHERE id = ANY($1::int[])`, [batch.map((e) => e.id)]);
    const previews = await lusha.decisionMakers(batch.map((e) => e.domain));
    const byDomain = new Map();
    for (const p of previews) {
      if (!p.lushaId || titleRank(p.title, ctx, p.departments) >= 99) continue;
      const d = normDomain(p.companyDomain);
      if (!d) continue;
      if (!byDomain.has(d)) byDomain.set(d, []);
      byDomain.get(d).push(p);
    }
    const ids = [];
    for (const e of batch) {
      const best = (byDomain.get(e.domain) || []).sort((a, b) => titleRank(a.title, ctx, a.departments) - titleRank(b.title, ctx, b.departments)).slice(0, 2);
      for (const b of best) if (!(await one('SELECT 1 FROM contacts WHERE lusha_id = $1', [b.lushaId]))) ids.push(b.lushaId);
    }
    const allowed = ids.slice(0, Math.min(budget.todayLeft, budget.monthLeft));
    if (!allowed.length) continue;
    const enriched = await lusha.enrichContacts(allowed);
    for (const c of enriched) {
      if (!c.email) continue;
      const emp = batch.find((e) => e.domain === normDomain(c.companyDomain)) || batch.find((e) => c.email.endsWith('@' + e.domain));
      if (!emp) continue;
      const r = await addContact(emp.id, c, 'Lusha');
      if (r.isNew) {
        sum.lushaRevealed++; sum.newContacts++; sum.touched.add(emp.id);
        await q(`UPDATE employers SET sources = CASE WHEN 'Lusha' = ANY(sources) THEN sources ELSE array_append(sources, 'Lusha') END WHERE id = $1`, [emp.id]);
        await logEvent(emp.id, `Lusha found ${c.fullName} (${c.title})`);
      }
    }
  }
}

/** Scan PracticeMatch for today's postings and add them. Used by the morning discovery and the extra scan times. */
export async function runPracticeMatchScan({ requalifyAfter = true, autoEnroll = false } = {}) {
  const settings = await getSettings();
  const logs = [];
  const r = { listings: 0, newEmployers: 0, newOpenings: 0, newContacts: 0, merged: 0 };
  await pm.fetchApprovedListings(settings, (m) => { logs.push(m); console.log('[practicematch]', m); }, async (batch) => {
    const b = await importListings(batch, 'scan');
    for (const k of Object.keys(r)) r[k] += b[k] || 0;
    console.log(`[practicematch] added ${b.listings} jobs (${r.listings} so far)`);
  });
  if (requalifyAfter) await requalifyAll();
  let enrolled = 0;
  if (autoEnroll && !settings.supervised && settings.autoEnroll && !settings.paused) {
    for (const { id } of await q(`SELECT id FROM employers WHERE bucket = 'ready' ORDER BY score DESC NULLS LAST`)) { try { await enroll(id, { by: 'auto' }); enrolled++; } catch { /* skip */ } }
  }
  return { ...r, enrolled, log: logs.slice(-6) };
}

export async function runDiscovery({ trigger = 'schedule' } = {}) {
  const settings = await getSettings();
  const sum = { trigger, pmListings: 0, newEmployers: 0, newOpenings: 0, newContacts: 0, merged: 0, lushaPreviews: 0, lushaRevealed: 0, skippedProtected: 0, skippedExcluded: 0, skippedNotTarget: 0, enrolled: 0, notes: [], touched: new Set() };
  let ctx = await loadContext();

  // 1. PracticeMatch daily scan
  try {
    const r = await runPracticeMatchScan({ requalifyAfter: false });
    Object.assign(sum, { pmListings: r.listings, newOpenings: r.newOpenings, merged: r.merged });
    sum.newEmployers += r.newEmployers; sum.newContacts += r.newContacts;
  } catch (e) { sum.notes.push(`PracticeMatch scan failed: ${e.message}`); }

  // 2-3. Lusha
  if (cfg.lushaApiKey) {
    try { if (settings.lusha.prospectingEnabled) await lushaProspecting(settings, ctx, sum); }
    catch (e) { sum.notes.push(`Lusha prospecting failed: ${e.message}`); }
    try { if (settings.autoEnrich) { await requalifyAll(); ctx = await loadContext(); await lushaFillContacts(settings, ctx, sum); } }
    catch (e) { sum.notes.push(`Lusha contact lookup failed: ${e.message}`); }
  } else sum.notes.push('Lusha skipped: LUSHA_API_KEY not set');

  // 4. Requalify everything (rules or protected list may have changed)
  await requalifyAll();

  // 5. Auto-enroll when supervised launch is off
  if (!settings.supervised && settings.autoEnroll && !settings.paused) {
    for (const { id } of await q(`SELECT id FROM employers WHERE bucket = 'ready' ORDER BY score DESC NULLS LAST`)) {
      try { await enroll(id, { by: 'auto' }); sum.enrolled++; } catch { /* skip */ }
    }
  }

  // 6. Openings not seen by the monitor in 30 days are treated as filled
  if (sum.pmListings > 0) await q(`UPDATE openings SET active = false WHERE source = 'PM' AND active AND last_seen < now() - interval '30 days'`);

  const credits = await lusha.creditsUsed();
  const out = { ...sum, touched: sum.touched.size, lushaCreditsToday: credits.today, lushaCreditsMonth: credits.month };
  return out;
}
