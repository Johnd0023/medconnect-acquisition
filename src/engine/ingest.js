// Turn raw source records (PracticeMatch listings, Lusha contacts) into one employer record each,
// with consolidated openings and deduplicated contacts.
import { q, one, logEvent } from '../db.js';
import { normDomain, normName, emailDomain, isFreeMail, isRelay } from '../util.js';
import { EMPLOYER_TYPES as T, knownProviders } from '../settings.js';

const SRC_LABEL = { PM: 'PracticeMatch', Lusha: 'Lusha', Referral: 'a referral', Manual: 'manual entry' };

// Industries that are healthcare-adjacent but don't deliver hands-on patient care (or don't hire physicians/NPs/PAs).
const NON_PROVIDER = /laborator|diagnostic lab|clinical research|contract research|\bcro\b|research|biotech|pharma|drug|medical (equipment|device|supplies)|device|manufactur|software|information technology|it services|internet|computer|data|analytics|insurance|payer|health plan|financial|wholesale|distribution|retail|pharmac|consult|marketing|advertis|staffing|recruit|education|training|government|environmental|telecom|dentist|dental|chiropract|optomet|veterinar|fitness|wellness|spa\b|cosmetic|medical billing|revenue cycle|transcription|e-?learning/;
// Industries that by themselves confirm hands-on care.
const CARE_INDUSTRY = /(^|[^a-z])hospitals?($|[^a-z&]|\s*$)|medical practice|physicians?\b|outpatient|ambulatory|urgent care|primary care|mental health|behavioral|psychiatr|community health|public health|nursing (home|facilit)|skilled nursing|rehabilitation hospital|hospice|home health/;

export function inferType(name, industry = '') {
  const n = (name || '').toLowerCase();
  const ind = (industry || '').toLowerCase();
  const s = `${n} ${ind}`;
  if (/staffing|locums?\b|recruit(ing|ment)\b|search (firm|partners)|placement|talent solutions|clinician search|physician search|\bshifts\b/.test(s)) return T.SA;

  // 1. Name evidence that it's a care site (strongest signal).
  const byName = (() => {
    if (/behavioral|psychiatr|mental health|addiction treatment|recovery center/.test(n)) return T.BH;
    if (/community health center|health center\b|fqhc|federally qualified/.test(n)) return T.CHC;
    if (/urgent care|walk-?in clinic|immediate care|express care|convenient care|minute ?clinic/.test(n)) return T.UC;
    if (/\bhospitals?\b|medical center|health system|healthcare system|regional health|health network|\bmemorial\b|\bmedical centre\b/.test(n)) return T.HS;
    if (/medical group|physicians?\b|physician partners|medical associates|\bclinics?\b|family (medicine|practice)|primary care|internal medicine|pediatrics?\b|cardiology|orthopa?edic|anesthesia|hospitalists?|emergency physicians|women'?s health|ob\/?gyn|surgical (associates|group|specialists)|medical practice|health partners|\bmd\b|\bpc\b|\bpa\b/.test(n)) return T.PG;
    if (knownProviders().some((k) => (' ' + normName(name) + ' ').includes(' ' + k + ' '))) return T.HS;
    return null;
  })();
  if (ind && NON_PROVIDER.test(ind) && !CARE_INDUSTRY.test(ind)) return T.OTHER; // industry says vendor/lab/pharma/etc.
  if (byName) return byName;

  // 2. A specific care industry (not the broad "Hospitals and Health Care" bucket, which also holds payers and vendors).
  const broadOnly = /^\s*(hospitals? (and|&) health ?care|health ?care|health, wellness (and|&) fitness|medical)\s*$/.test(ind);
  if (ind && !broadOnly && CARE_INDUSTRY.test(ind)) {
    if (/mental health|behavioral|psychiatr/.test(ind)) return T.BH;
    if (/urgent care|outpatient|ambulatory/.test(ind)) return T.UC;
    if (/community health|public health/.test(ind)) return T.CHC;
    if (/medical practice|physicians?|primary care/.test(ind)) return T.PG;
    return T.HS;
  }
  return T.UNKNOWN; // can't confirm hands-on patient care
}

/** Find or create an employer. Returns { employer, isNew }. */
export async function upsertEmployer({ name, domain, city, state, source, industry, lushaCompanyId }) {
  const d = normDomain(domain);
  const usableDomain = d && !isFreeMail(`x@${d}`) ? d : null;
  const nn = normName(name);
  let emp = null;
  if (usableDomain) emp = await one('SELECT * FROM employers WHERE domain = $1', [usableDomain]);
  if (!emp && lushaCompanyId) emp = await one('SELECT * FROM employers WHERE lusha_company_id = $1', [lushaCompanyId]);
  if (!emp && nn) emp = await one(`SELECT * FROM employers WHERE norm_name = $1 AND (state IS NULL OR $2::text IS NULL OR upper(state) = upper($2::text)) ORDER BY id LIMIT 1`, [nn, state || null]);

  if (!emp) {
    emp = await one(`INSERT INTO employers (name, norm_name, domain, type, city, state, sources, lusha_company_id)
                     VALUES ($1, $2, $3, $4, $5, $6, ARRAY[$7]::text[], $8) RETURNING *`,
    [name, nn, usableDomain, inferType(name, industry), city || null, state || null, source, lushaCompanyId || null]);
    await logEvent(emp.id, `Discovered via ${SRC_LABEL[source] || source}`);
    return { employer: emp, isNew: true };
  }

  const addSource = !emp.sources.includes(source);
  const canTakeDomain = !emp.domain && usableDomain && !(await one('SELECT 1 FROM employers WHERE domain = $1', [usableDomain]));
  emp = await one(`UPDATE employers SET
        sources = CASE WHEN $2 = ANY(sources) THEN sources ELSE array_append(sources, $2) END,
        domain = CASE WHEN $3::text IS NOT NULL THEN $3::text ELSE domain END,
        city = coalesce(city, $4), state = coalesce(state, $5),
        lusha_company_id = coalesce(lusha_company_id, $6),
        type = CASE WHEN type = 'Unknown' THEN $7 ELSE type END
      WHERE id = $1 RETURNING *`,
  [emp.id, source, canTakeDomain ? usableDomain : null, city || null, state || null, lushaCompanyId || null, inferType(name, industry)]);
  if (addSource) await logEvent(emp.id, `Also found in ${SRC_LABEL[source] || source}; merged into the existing employer record`);
  return { employer: emp, isNew: false };
}

/** Add a contact if it isn't already on file (matched by email, or by name at the same employer). */
export async function addContact(employerId, c, source) {
  const email = c.email ? c.email.trim().toLowerCase() : null;
  if (email) {
    // Forwarding addresses are matched within the employer; real addresses anywhere.
    const existing = isRelay(email)
      ? await one('SELECT * FROM contacts WHERE employer_id = $1 AND lower(email) = $2', [employerId, email])
      : await one('SELECT * FROM contacts WHERE lower(email) = $1', [email]);
    if (existing) {
      if (!existing.sources.includes(source)) await q('UPDATE contacts SET sources = array_append(sources, $2) WHERE id = $1', [existing.id, source]);
      return { contact: existing, isNew: false };
    }
  } else if (c.fullName) {
    const existing = await one('SELECT * FROM contacts WHERE employer_id = $1 AND lower(full_name) = lower($2)', [employerId, c.fullName]);
    if (existing) return { contact: existing, isNew: false };
  }
  const full = c.fullName || [c.firstName, c.lastName].filter(Boolean).join(' ');
  const contact = await one(`INSERT INTO contacts (employer_id, first_name, last_name, full_name, title, email, email_confidence, phone, sources, lusha_id)
                             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,ARRAY[$9]::text[],$10) RETURNING *`,
  // A forwarding address has no person's name: never guess one from the placeholder label.
  [employerId, isRelay(email) ? (c.firstName || null) : (c.firstName || full.split(' ')[0] || null),
    isRelay(email) ? (c.lastName || null) : (c.lastName || full.split(' ').slice(1).join(' ') || null), full || null,
    c.title || null, email, c.emailConfidence || null, c.phone || null, source, c.lushaId || null]);
  return { contact, isNew: true };
}

/** Ingest one normalized PracticeMatch listing.
 *  A posting contact already on file means the same client: the job is consolidated under that contact's employer,
 *  so a recruiter with many open jobs is one prospect and gets one sequence. */
export async function ingestListing(row) {
  const email = (row.contactEmail || '').trim().toLowerCase() || null;
  let employer = null; let isNew = false;
  if (email && !isRelay(email)) {
    // Same recruiter address = same client. (PracticeMatch forwarding addresses are shared, so not those.)
    const known = await one('SELECT e.* FROM contacts c JOIN employers e ON e.id = c.employer_id WHERE lower(c.email) = $1 ORDER BY c.id LIMIT 1', [email]);
    if (known) employer = known;
  }
  if (!employer) {
    const domain = row.domain || (email && !isRelay(email) && !isFreeMail(email) ? emailDomain(email) : null);
    const r = await upsertEmployer({ name: row.employer, domain, city: row.city, state: row.state, source: 'PM' });
    employer = r.employer; isNew = r.isNew;
    // A PracticeMatch in-house posting is itself evidence of a provider employer.
    if (employer.type === T.UNKNOWN) employer = await one(`UPDATE employers SET type = $2 WHERE id = $1 RETURNING *`, [employer.id, T.PG]);
  } else if (!employer.sources.includes('PM')) {
    await q(`UPDATE employers SET sources = array_append(sources, 'PM') WHERE id = $1`, [employer.id]);
  }
  const existing = await one(`SELECT id FROM openings WHERE source = 'PM' AND external_id = $1`, [row.listingId]);
  let newOpening = false;
  if (existing) {
    await q('UPDATE openings SET last_seen = now(), active = true WHERE id = $1', [existing.id]);
  } else {
    await q(`INSERT INTO openings (employer_id, source, external_id, role, specialty, city, state, url, restriction, posted_at, raw, pm_code, contact_email, title)
             VALUES ($1,'PM',$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13)`,
    [employer.id, row.listingId, row.role, row.specialty, row.city || null, row.state || null, row.url || null, row.restriction || null, row.postedAt,
      JSON.stringify({ ...row, description: (row.description || '').slice(0, 4000) }), row.pmCode || null, email, row.title || null]);
    await q('UPDATE employers SET last_signal = now() WHERE id = $1', [employer.id]);
    newOpening = true;
    if (!isNew) await logEvent(employer.id, `Another opening: ${row.specialty} ${row.role}${row.city ? ` in ${row.city}` : ''}. Same client, no extra outreach.`);
  }
  let newContact = false;
  if (email || row.contactName) {
    const [first, ...rest] = (row.contactName || '').split(/\s+/);
    const r = await addContact(employer.id, {
      firstName: first, lastName: rest.join(' '),
      fullName: row.contactName || (isRelay(email) ? `${employer.name} recruiting (via PracticeMatch)` : ''),
      title: row.contactTitle || 'Listing contact', email, phone: row.contactPhone || null,
    }, 'PM');
    newContact = r.isNew;
  }
  return { employerId: employer.id, isNew, newOpening, newContact };
}

/** Ingest one enriched Lusha contact (with company). */
export async function ingestLushaContact(c) {
  if (!c.companyName && !c.companyDomain) return null;
  const { employer, isNew } = await upsertEmployer({
    name: c.companyName || c.companyDomain, domain: c.companyDomain || (c.email && !isFreeMail(c.email) ? emailDomain(c.email) : null),
    city: c.city, state: c.state, source: 'Lusha', industry: c.industry, lushaCompanyId: c.companyId,
  });
  const r = await addContact(employer.id, c, 'Lusha');
  return { employerId: employer.id, isNew, newContact: r.isNew };
}
