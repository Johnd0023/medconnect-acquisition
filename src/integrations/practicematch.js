// PracticeMatch source adapter.
//
// Phase 1 (works today): import listings from a PracticeMatch export (CSV) or JSON — from the dashboard
// (Settings → Import) or POST /api/import/practicematch. Re-importing is safe: listings are keyed by
// listing id, so repeats only refresh "last seen".
//
// Phase 2 (automated monitor): fetchApprovedListings() is where the approved automated collection plugs in.
// It must return the same normalized rows as normalizeRow(). Fill it in once we've walked through your
// saved PracticeMatch searches together (or swap in the PracticeMatch API when you enable it).

const RESTRICTION_RE = /(no (outside |third[- ]party )?(agencies|agency|recruiters|recruiting firms|search firms)|direct applicants only|principals only|agencies need not apply|no headhunters)/i;

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
    listingId: pick(obj, H.listingId),
    employer: pick(obj, H.employer),
    domain: pick(obj, H.domain),
    specialty: pick(obj, H.specialty),
    role: pick(obj, H.role),
    city: pick(obj, H.city),
    state: pick(obj, H.state),
    contactName: pick(obj, H.contactName),
    contactTitle: pick(obj, H.contactTitle),
    contactEmail: pick(obj, H.contactEmail),
    contactPhone: pick(obj, H.contactPhone),
    posted: pick(obj, H.posted),
    url: pick(obj, H.url),
    description: pick(obj, H.description),
  };
  if (!row.city && !row.state) {
    const loc = pick(obj, H.location);
    const m = loc.match(/^(.*?),\s*([A-Z]{2})\b/);
    if (m) { row.city = m[1].trim(); row.state = m[2]; } else row.city = loc;
  }
  const mapped = ROLE_MAP.find(([re]) => re.test(row.role));
  row.role = mapped ? mapped[1] : (row.role || 'Physician');
  if (!row.listingId) row.listingId = [row.employer, row.specialty, row.role, row.city, row.state].join('|').toLowerCase();
  const restriction = (row.description.match(RESTRICTION_RE) || [])[0];
  row.restriction = restriction ? row.description.slice(Math.max(0, row.description.search(RESTRICTION_RE) - 40), row.description.search(RESTRICTION_RE) + restriction.length + 40).trim() : null;
  const parsed = row.posted ? new Date(row.posted) : null;
  row.postedAt = parsed && !Number.isNaN(parsed.getTime()) ? parsed : new Date();
  return row.employer ? row : null;
}

export function parseImport(text, kind) {
  const data = kind === 'json' || /^\s*[[{]/.test(text) ? JSON.parse(text) : parseCsv(text);
  const arr = Array.isArray(data) ? data : data.listings || data.results || [];
  return arr.map(normalizeRow).filter(Boolean);
}

/** Automated monitor hook — returns [] until the approved collection is configured (see README). */
export async function fetchApprovedListings() {
  return [];
}
