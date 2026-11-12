// Turn raw source records (PracticeMatch listings, Lusha contacts) into one employer record each,
// with consolidated openings and deduplicated contacts.
import { q, one, logEvent } from '../db.js';
import { normDomain, normName, emailDomain, isFreeMail } from '../util.js';
import { EMPLOYER_TYPES as T } from '../settings.js';

const SRC_LABEL = { PM: 'PracticeMatch', Lusha: 'Lusha', Referral: 'a referral', Manual: 'manual entry' };

export function inferType(name, industry = '') {
  const s = `${name} ${industry}`.toLowerCase();
  if (/staffing|locum|recruit(ing|ment) (firm|partners|group|solutions)|search (firm|partners)|placement|talent solutions|clinician search|physician search/.test(s)) return T.SA;
  if (/behavioral|psychiatr|mental health|addiction|recovery center/.test(s)) return T.BH;
  if (/community health|fqhc|federally qualified|health center\b/.test(s)) return T.CHC;
  if (/urgent care|walk-?in|immediate care|express care|convenient care|ambulatory surgery|surgery center/.test(s)) return T.UC;
  if (/hospital|medical center|health system|healthcare system|regional health|health network|\bhealth$|memorial|baptist health|methodist|presbyterian/.test(s)) return T.HS;
  if (/medical group|physicians|physician partners|associates|clinic|practice|family medicine|pediatrics|cardiology|orthopa?edic|anesthesia|hospitalists|emergency physicians|women'?s health|imaging|internal medicine|medical practices/.test(s)) return T.PG;
  if (/hospitals and health care|hospital & health care/.test(s)) return T.HS;
  return T.UNKNOWN;
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
    const existing = await one('SELECT * FROM contacts WHERE lower(email) = $1', [email]);
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
  [employerId, c.firstName || full.split(' ')[0] || null, c.lastName || full.split(' ').slice(1).join(' ') || null, full || null,
    c.title || null, email, c.emailConfidence || null, c.phone || null, source, c.lushaId || null]);
  return { contact, isNew: true };
}

/** Ingest one normalized PracticeMatch listing. */
export async function ingestListing(row) {
  const domain = row.domain || (row.contactEmail && !isFreeMail(row.contactEmail) ? emailDomain(row.contactEmail) : null);
  const { employer, isNew } = await upsertEmployer({ name: row.employer, domain, city: row.city, state: row.state, source: 'PM' });
  const existing = await one(`SELECT id FROM openings WHERE source = 'PM' AND external_id = $1`, [row.listingId]);
  let newOpening = false;
  if (existing) {
    await q('UPDATE openings SET last_seen = now(), active = true WHERE id = $1', [existing.id]);
  } else {
    const same = await one(`SELECT id FROM openings WHERE employer_id = $1 AND active AND lower(coalesce(specialty,'')) = lower($2) AND lower(coalesce(role,'')) = lower($3)`, [employer.id, row.specialty || '', row.role || '']);
    if (same) {
      await q('UPDATE openings SET last_seen = now() WHERE id = $1', [same.id]);
    } else {
      await q(`INSERT INTO openings (employer_id, source, external_id, role, specialty, city, state, url, restriction, posted_at, raw)
               VALUES ($1,'PM',$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
      [employer.id, row.listingId, row.role, row.specialty, row.city || null, row.state || null, row.url || null, row.restriction || null, row.postedAt, JSON.stringify(row)]);
      await q('UPDATE employers SET last_signal = now() WHERE id = $1', [employer.id]);
      newOpening = true;
      if (!isNew) await logEvent(employer.id, `Additional opening: ${row.specialty} ${row.role}. Consolidated into the employer; no extra outreach.`);
    }
  }
  let newContact = false;
  if (row.contactEmail || row.contactName) {
    const [first, ...rest] = (row.contactName || '').split(/\s+/);
    const r = await addContact(employer.id, { firstName: first, lastName: rest.join(' '), fullName: row.contactName, title: row.contactTitle || 'Listing contact', email: row.contactEmail || null, phone: row.contactPhone || null }, 'PM');
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
