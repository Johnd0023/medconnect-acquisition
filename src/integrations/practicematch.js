// PracticeMatch source adapter.
//
// 1) Daily automated scan (fetchApprovedListings): reads the in-house physician and advanced-practitioner
//    job boards filtered to jobs posted today (isFirm=0 excludes agency postings), opens each job it hasn't
//    seen before, and reads the employer, location, specialty and the posting's "Click to email" contact.
//    Used with PracticeMatch's written permission for MedConnect's business-development workflow.
// 2) Manual import (parseImport): a CSV/JSON export, from Settings → Import or POST /api/import/practicematch.
import { q } from '../db.js';

const BASE = 'https://www.practicematch.com';
const UA = 'MedConnectStaffing-BusinessDevelopment/1.0 (+https://medconnectstaffing.com)';
const RESTRICTION_RE = /(no (outside |third[- ]party )?(agencies|agency|recruiters|recruiting firms|search firms)|direct applicants only|principals only|agencies need not apply|no headhunters|no recruiters)/i;
const BOARDS = { physicians: 'Physician', 'advanced-practitioners': 'Advanced Practice Provider' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const decode = (s) => (s || '').replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d))).replace(/&amp;/g, '&').replace(/&#39;|&rsquo;|&lsquo;/g, "'").replace(/&quot;|&ldquo;|&rdquo;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&ndash;|&mdash;/g, '-');
const stripTags = (h) => decode((h || '').replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<br\s*\/?>|<\/p>|<\/li>|<\/div>|<\/h\d>/gi, '\n').replace(/<[^>]+>/g, ' ')).replace(/[ \t]+/g, ' ').replace(/\n\s+/g, '\n').trim();
const titleCase = (slug) => slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).replace(/\bAnd\b/g, '&');

async function get(path, attempt = 0) {
  const res = await fetch(BASE + path, { headers: { 'User-Agent': UA, Accept: 'text/html' }, redirect: 'follow' });
  if ((res.status === 429 || res.status >= 500) && attempt < 3) { await sleep(5000 * (attempt + 1)); return get(path, attempt + 1); }
  if (!res.ok) throw new Error(`PracticeMatch ${res.status} for ${path}`);
  return res.text();
}

/** Job links on a results page: [{ path, id, board, specialtySlug, stateSlug, citySlug, orgSlug }] */
export function parseResults(html) {
  const out = new Map();
  const re = /href="(\/(physicians|advanced-practitioners)\/job-details\.cfm\/(\d+)\/([^/"]+)\/([^/"]+)\/([^/"]+)\/([^"]*?)\/?)"/g;
  let m;
  while ((m = re.exec(html))) {
    if (!out.has(m[3])) out.set(m[3], { path: m[1], board: m[2], id: m[3], specialtySlug: m[4], stateSlug: m[5], citySlug: m[6], orgSlug: m[7] });
  }
  return [...out.values()];
}

/** Everything we need from one job page. */
export function parseJob(html, link) {
  const job = { listingId: link.id, board: link.board, url: BASE + link.path };
  // Structured data
  for (const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const d = JSON.parse(m[1].trim());
      if (d['@type'] !== 'JobPosting') continue;
      job.title = decode(d.title);
      job.datePosted = d.datePosted;
      job.employer = decode(d.hiringOrganization?.name || '');
      job.website = d.hiringOrganization?.sameAs || '';
      const a = d.jobLocation?.address || {};
      job.city = a.addressLocality || ''; job.state = a.addressRegion || ''; job.zip = a.postalCode || '';
      job.code = d.identifier?.value || '';
      job.description = stripTags(d.description || '');
    } catch { /* ignore malformed block */ }
  }
  // "Click to email" contact
  const tag = (html.match(/<a\b[^>]*id=["']clickToEmail["'][^>]*>/i) || [])[0] || '';
  const href = decode((tag.match(/href=["']mailto:([^"']+)["']/i) || [])[1] || '');
  if (href) {
    const [addr, query = ''] = href.split('?');
    job.contactEmail = decodeURIComponent(addr).trim().toLowerCase();
    job.emailSubject = decodeURIComponent((query.match(/subject=([^&]*)/i) || [])[1] || '').replace(/\+/g, ' ').trim();
  }
  // The code PracticeMatch routes by is the one in the Click-to-email subject; the posting's own identifier can be an employer req number.
  job.code = ((job.emailSubject || '').match(/Opportunity\s+(\S+)/i) || [])[1] || job.code || link.id;
  job.relay = /@practicematch\.com$/.test(job.contactEmail || '');
  // Fallbacks from the URL
  if (!job.employer) job.employer = titleCase(link.orgSlug);
  if (!job.city) job.city = titleCase(link.citySlug);
  if (!job.state) job.state = titleCase(link.stateSlug);
  job.specialty = titleCase(link.specialtySlug);
  const text = `${job.title || ''}\n${stripTags(html).slice(0, 20000)}`;
  // Role: from the title and the posting's "Candidate type" (not the page's menus)
  const title = job.title || '';
  const candidate = ((stripTags(html).match(/CANDIDATE TYPE\s+([^\n]+)/i) || [])[1] || '').slice(0, 120);
  const t = `${title} | ${candidate}`;
  if (/certified registered nurse anesthetist|\bcrna\b/i.test(t)) job.role = 'CRNA';
  else if (/nurse practitioner|\bnp\b|\baprn\b|\bfnp\b|\bpmhnp\b|\bagacnp\b|\bnnp\b/i.test(t) && /physician assistant|\bpa-?c?\b/i.test(t)) job.role = 'NP / PA';
  else if (/nurse practitioner|\bnp\b|\baprn\b|\bfnp\b|\bpmhnp\b|\bagacnp\b|\bnnp\b/i.test(t)) job.role = 'Nurse Practitioner';
  else if (/physician assistant|\bpa-c\b|\bpa\b/i.test(t)) job.role = 'Physician Assistant';
  else if (/nurse midwife|\bcnm\b/i.test(t)) job.role = 'Certified Nurse Midwife';
  else if (/\b(md|do)\b|physician|hospitalist|surgeon|intensivist|psychiatrist|anesthesiologist|radiologist|patholog|cardiolog|oncolog|neurolog|gastroenterolog|dermatolog|urolog|nephrolog|pulmonolog|rheumatolog|endocrinolog|ophthalmolog|otolaryngolog|obstetric|gynecolog|pediatrician|internist|medical director/i.test(t) || link.board === 'physicians') job.role = 'Physician';
  else job.role = 'Advanced Practice Provider';
  // Not a physician or advanced-practice opening (psychologists, therapists, nurses, techs…): skip
  const nonProvider = /psycholog|therapist|counsel(or|ing)|social worker|\blcsw\b|registered nurse|\brn\b|pharmacist|dentist|dental|chiropract|optometr|audiolog|dietitian|technolog|technician|sonograph|veterinar|medical assistant|scribe/i;
  const providerWords = /physician|\b(md|do)\b|nurse practitioner|\bnp\b|physician assistant|\bpa-?c?\b|crna|nurse anesthetist|midwife|\bcnm\b|\baprn\b|psychiatr/i;
  job.skip = nonProvider.test(title) && !providerWords.test(title) ? `Not a physician or APP role: ${title.slice(0, 80)}` : null;

  const r = text.match(RESTRICTION_RE);
  job.restriction = r ? text.slice(Math.max(0, r.index - 60), r.index + r[0].length + 60).replace(/\s+/g, ' ').trim() : null;
  // A direct (non-relay) address shaped like first.last@ gives us a name
  if (!job.relay && job.contactEmail) {
    const local = job.contactEmail.split('@')[0];
    const parts = local.split(/[._-]/).filter((p) => /^[a-z]{2,}$/i.test(p));
    if (parts.length >= 2) job.contactName = parts.slice(0, 2).map((p) => p[0].toUpperCase() + p.slice(1).toLowerCase()).join(' ');
  }
  return job;
}

/** Map a parsed job to the row shape ingestListing() expects. */
function toRow(job) {
  return {
    listingId: job.listingId,
    employer: job.employer,
    domain: job.website || '',
    specialty: job.specialty,
    role: job.role,
    city: job.city,
    state: job.state,
    contactName: job.contactName || '',
    contactTitle: job.relay ? 'Job posting contact (via PracticeMatch)' : 'Job posting contact',
    contactEmail: job.contactEmail || '',
    contactPhone: '',
    url: job.url,
    description: job.description || '',
    restriction: job.restriction,
    postedAt: job.datePosted ? new Date(job.datePosted + 'T12:00:00Z') : new Date(),
    pmCode: job.code,
    emailSubject: job.emailSubject || '',
    relay: job.relay,
    title: job.title || '',
    board: job.board,
  };
}

/**
 * Daily scan. Reads today's in-house postings on the selected boards, then opens only job IDs not already
 * on file. Polite pacing between requests. Returns rows for ingestListing().
 */
export async function fetchApprovedListings(settings, log = () => {}) {
  const P = settings.practicematch || {};
  if (!P.enabled) return [];
  const firstRun = !(await q(`SELECT 1 FROM openings WHERE source = 'PM' AND raw ? 'pmCode' LIMIT 1`)).length;
  const jobAge = firstRun ? (P.firstRunJobAge || 7) : (P.jobAge || 1);
  const delay = Math.max(800, P.delayMs || 1500);
  const links = new Map();
  for (const board of P.boards || Object.keys(BOARDS)) {
    let emptyPages = 0;
    for (let page = 1; page <= (P.maxPagesPerBoard || 40); page++) {
      const html = await get(`/${board}/jobs/?jobAge=${jobAge}&isFirm=${P.inHouseOnly === false ? 'All' : 0}&page_id=${page}`);
      const found = parseResults(html).filter((l) => l.board === board);
      const before = links.size;
      for (const l of found) links.set(l.id, l);
      log(`${board} page ${page}: ${found.length} jobs`);
      emptyPages = links.size === before ? emptyPages + 1 : 0;
      if (!found.length || emptyPages >= 2) break; // past the last page
      await sleep(delay);
    }
  }
  // Only open jobs we haven't seen
  const ids = [...links.keys()];
  const seen = new Set((await q(`SELECT external_id FROM openings WHERE source = 'PM' AND external_id = ANY($1::text[])`, [ids])).map((r) => r.external_id));
  const fresh = ids.filter((id) => !seen.has(id)).slice(0, P.maxDetailsPerRun || 600);
  // Refresh "last seen" for listings still posted
  if (seen.size) await q(`UPDATE openings SET last_seen = now(), active = true WHERE source = 'PM' AND external_id = ANY($1::text[])`, [[...seen]]);
  const rows = [];
  let skipped = 0;
  for (const id of fresh) {
    try {
      const job = parseJob(await get(links.get(id).path), links.get(id));
      if (job.skip) { skipped++; continue; }
      if (job.employer) rows.push(toRow(job));
    } catch (e) { log(`job ${id}: ${e.message}`); }
    await sleep(delay);
  }
  log(`PracticeMatch: ${ids.length} postings (jobAge=${jobAge}), ${fresh.length} new, ${rows.length} physician/APP jobs read, ${skipped} other roles skipped`);
  return rows;
}

// ---------------------------------------------------------------------------------------------
// Manual import (CSV / JSON export)
const H = {
  listingId: ['listing id', 'listingid', 'job id', 'jobid', 'id', 'opportunity id', 'reference'],
  employer: ['employer', 'organization', 'organisation', 'facility', 'company', 'practice', 'hospital', 'client'],
  domain: ['website', 'domain', 'url of employer', 'employer website'],
  specialty: ['specialty', 'speciality', 'discipline'],
  role: ['position', 'role', 'provider type', 'job type', 'profession', 'title'],
  city: ['city', 'location city'],
  state: ['state', 'st', 'location state'],
  location: ['location'],
  contactName: ['contact', 'contact name', 'recruiter', 'recruiter name'],
  contactTitle: ['contact title', 'recruiter title'],
  contactEmail: ['email', 'contact email', 'recruiter email'],
  contactPhone: ['phone', 'contact phone', 'recruiter phone'],
  posted: ['posted', 'date posted', 'posted date', 'post date', 'updated'],
  url: ['link', 'listing url', 'job url', 'url'],
  description: ['description', 'details', 'notes', 'requirements'],
};

export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQ = false;
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((x) => x.trim() !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((x) => x.trim() !== '')) rows.push(row);
  if (!rows.length) return [];
  const head = rows[0].map((h) => h.trim().toLowerCase());
  return rows.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? '').trim()])));
}

function pick(obj, keys) {
  const lower = Object.fromEntries(Object.entries(obj).map(([k, v]) => [k.toLowerCase().trim(), v]));
  for (const k of keys) if (lower[k] != null && String(lower[k]).trim() !== '') return String(lower[k]).trim();
  return '';
}

const ROLE_MAP = [[/\bCRNA\b|nurse anesthetist/i, 'CRNA'], [/\bNP\b|nurse practitioner/i, 'Nurse Practitioner'], [/\bPA\b|PA-C|physician assistant/i, 'Physician Assistant'], [/\b(MD|DO|physician)\b/i, 'Physician']];

export function normalizeRow(obj) {
  const row = {
    listingId: pick(obj, H.listingId), employer: pick(obj, H.employer), domain: pick(obj, H.domain),
    specialty: pick(obj, H.specialty), role: pick(obj, H.role), city: pick(obj, H.city), state: pick(obj, H.state),
    contactName: pick(obj, H.contactName), contactTitle: pick(obj, H.contactTitle), contactEmail: pick(obj, H.contactEmail),
    contactPhone: pick(obj, H.contactPhone), posted: pick(obj, H.posted), url: pick(obj, H.url), description: pick(obj, H.description),
  };
  if (!row.city && !row.state) {
    const loc = pick(obj, H.location);
    const m = loc.match(/^(.*?),\s*([A-Z]{2})\b/);
    if (m) { row.city = m[1].trim(); row.state = m[2]; } else row.city = loc;
  }
  const mapped = ROLE_MAP.find(([re]) => re.test(row.role));
  row.role = mapped ? mapped[1] : (row.role || 'Physician');
  if (!row.listingId) row.listingId = [row.employer, row.specialty, row.role, row.city, row.state].join('|').toLowerCase();
  const r = row.description.match(RESTRICTION_RE);
  row.restriction = r ? row.description.slice(Math.max(0, r.index - 40), r.index + r[0].length + 40).trim() : null;
  const parsed = row.posted ? new Date(row.posted) : null;
  row.postedAt = parsed && !Number.isNaN(parsed.getTime()) ? parsed : new Date();
  row.relay = /@practicematch\.com$/i.test(row.contactEmail);
  return row.employer ? row : null;
}

export function parseImport(text, kind) {
  const data = kind === 'json' || /^\s*[[{]/.test(text) ? JSON.parse(text) : parseCsv(text);
  const arr = Array.isArray(data) ? data : data.listings || data.results || [];
  return arr.map(normalizeRow).filter(Boolean);
}
