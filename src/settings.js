import { q, one } from './db.js';

export const EMPLOYER_TYPES = {
  HS: 'Hospital / health system',
  PG: 'Physician group / practice',
  UC: 'Urgent care / outpatient',
  CHC: 'Community health center',
  BH: 'Behavioral health',
  SA: 'Staffing / recruiting firm',
  OTHER: 'Not a provider employer (vendor, tech, pharma, other)',
  UNKNOWN: 'Unknown',
};

export const DEFAULT_TEMPLATES = {
  initial_opening: {
    label: 'Initial: active opening',
    subject: '{{specialty}} {{role}} search at {{employer}}',
    body: `Hi {{first_name}},

I saw that {{employer}} is recruiting a {{specialty}} {{role}} in {{city}}, {{state}}{{more_openings}}.

I'm with MedConnect Staffing. We help hospitals and practices across the country fill physician, NP and PA openings. If it's useful, I can send over provider profiles that match the posting.

Would a 10-minute call this week work?

{{sender_name}}
MedConnect Staffing`,
  },
  initial_general: {
    label: 'Initial: no active listing (Lusha)',
    subject: 'Provider recruiting support for {{employer}}',
    body: `Hi {{first_name}},

I lead business development at MedConnect Staffing. We help healthcare employers fill physician, NP and PA openings nationwide.

When {{employer}} has provider openings, are you the right person to talk to about outside recruiting support? If not, I'd appreciate a pointer to the right colleague.

{{sender_name}}
MedConnect Staffing`,
  },
  followup_1: {
    label: 'Follow-up 1',
    subject: 'Re: {{signal_subject}}',
    body: `Hi {{first_name}},

Following up on my note about {{signal_line}}. Happy to share a few matching provider profiles if that would help.

{{sender_name}}`,
  },
  followup_2: {
    label: 'Follow-up 2 (last)',
    subject: 'Re: {{signal_subject}}',
    body: `Hi {{first_name}},

I'll close the loop here. If {{employer}} needs help with provider recruiting later on, just reply to this email.

{{sender_name}}
MedConnect Staffing`,
  },
};

export const DEFAULT_SETTINGS = {
  // --- automation ---
  supervised: true,            // every qualified employer waits for owner approval
  paused: false,               // stops sending + auto-enroll; discovery keeps running
  autoEnrich: true,            // use Lusha to find a contact when a listing has none
  autoEnroll: true,            // when not supervised, enroll employers that reach Ready
  threshold: 70,               // auto-approve score when supervised is off

  // --- daily schedule (business timezone) ---
  discoveryTime: '06:00',
  discoveryDays: [1, 2, 3, 4, 5],     // 0=Sun … 6=Sat
  sendDays: [1, 2, 3, 4, 5],
  sendWindowStart: '08:30',
  sendWindowEnd: '16:30',
  replyPollMinutes: 10,

  // --- sending limits ---
  dailyCap: 40,                // hard ceiling per day
  warmup: { enabled: true, startPerDay: 10, increasePerDay: 5 },  // ramp toward dailyCap from the first send day
  minGapSeconds: 90,           // random spacing between sends
  maxGapSeconds: 240,
  perEmployerPerDay: 1,        // never email the same organization twice in a day
  followupGap1Days: 3,         // send days after the initial email
  followupGap2Days: 4,         // send days after follow-up 1

  // --- Lusha ---
  lusha: {
    prospectingEnabled: true,
    pagesPerDay: 1,
    pageSize: 25,
    maxContactsPerCompany: 2,
    dailyRevealLimit: 40,      // max contacts revealed (credit spend) per day
    monthlyCreditBudget: 1500,
    jobTitles: ['Physician Recruiter', 'Provider Recruiter', 'Director of Provider Recruitment', 'Talent Acquisition', 'Medical Staff Recruiter', 'Practice Administrator', 'Practice Manager'],
    industriesLabels: [],      // Lusha industry labels (optional; use Settings → Lusha → Find industry IDs)
    mainIndustriesIds: [],
    subIndustriesIds: [],
    states: [],                // empty = nationwide
  },

  // --- targeting ---
  specialties: ['Hospitalist', 'Emergency Medicine', 'Family Medicine', 'Internal Medicine', 'Psychiatry', 'Anesthesiology', 'OB/GYN', 'Urgent Care', 'Cardiology', 'Pediatrics', 'Radiology', 'Neurology', 'Gastroenterology', 'Oncology', 'General Surgery', 'Orthopedic Surgery', 'Pulmonology', 'Nephrology', 'Urology', 'Dermatology'],
  types: [EMPLOYER_TYPES.HS, EMPLOYER_TYPES.PG, EMPLOYER_TYPES.UC, EMPLOYER_TYPES.CHC, EMPLOYER_TYPES.BH],
  excludeKeywords: 'staffing\nlocum\nlocums\nrecruiting\nrecruitment firm\nsearch firm\nsearch partners\nplacement\ntalent solutions\nshifts\nworkforce solutions',
  // Large hospital and physician-group operators whose names don't say "hospital" (always treated as care providers).
  knownProviders: 'hca healthcare\ntenet healthcare\ncommonspirit\nascension\ntrinity health\nprovidence\nkaiser permanente\nadvocate health\natrium health\nupmc\nintermountain\nbanner health\nsutter health\nbaylor scott and white\nnorthwell\nnyu langone\nmass general brigham\nsanford health\nnovant health\nprisma health\nochsner\ngeisinger\ncorewell health\nbon secours mercy\nmercy\nchristus health\nlifepoint health\nuniversal health services\nencompass health\nselect medical\nardent health\nprime healthcare\nadventhealth\nadventist health\nallina health\nessentia health\natlantic health\nhackensack meridian\nrwjbarnabas\njefferson health\npenn medicine\nyale new haven\nhartford healthcare\nhenry ford health\nohiohealth\nfroedtert\nmulticare\npeacehealth\nlegacy health\nrenown health\nscripps health\nsharp healthcare\nuchealth\nhealthpartners\navera\ngundersen\ncarilion\nsentara\ninova\nmedstar\nwellspan\nchristianacare\nwellstar\npiedmont healthcare\nemory healthcare\nvanderbilt health\nerlanger\nduke health\nunc health\nuva health\nvcu health\ncedars sinai\nstanford health care\nuc health\nmontefiore\nmount sinai\nnewyork presbyterian\nhoag\nmemorialcare\ndignity health\nuniversity hospitals\nbeaumont\nspectrum health\nsaint lukes\nst lukes\nbaptist health\nmethodist\npresbyterian\nmayo clinic\ncleveland clinic\noptum care\nonemedical\none medical\noak street health\nchenmed\ncarbon health\nconcentra\nmedexpress\nfastmed\ncitymd\ngohealth urgent care\nteamhealth\nenvision physician services\nus acute care solutions\nsound physicians\nusap\nus anesthesia partners\nnorthstar anesthesia\nradiology partners',
  // Healthcare companies that are not provider employers (payers, labs, pharmacies, vendors, health IT, GPOs).
  doNotProspect: 'cvs health\naetna\nunitedhealth\noptum\nhumana\ncigna\nelevance\nanthem\ncentene\nmolina\nwalgreens\nwalmart\nlabcorp\nquest diagnostics\nvizient\npremier inc\nathenahealth\nepic systems\noracle health\ncerner\nmckesson\ncardinal health\ncencora\namerisourcebergen\nchange healthcare\niqvia\nwep clinical\nmedtronic\ndexcom\nabbott\njohnson and johnson\npfizer\nbaxter\nbecton dickinson\nphilips\nge healthcare\nsiemens healthineers\nteladoc\namwell\nhealthgrades\ndoximity',
  titlePriority: 'provider recruit\nphysician recruit\nrecruit\ntalent acquisition\nhuman resources\npractice administrator\npractice manager\nmedical staff\nchief operating\noperations',

  // --- sender & compliance ---
  senderName: 'MedConnect Business Development',
  companyAddress: '',          // CAN-SPAM: a valid physical postal address must appear in every email
  optOutLine: "If you'd rather not hear from me, reply \"unsubscribe\" and I won't email you again.",
  templates: DEFAULT_TEMPLATES,
};

let cache = null;
let knownCache = null;
/** Normalized known-provider names (from settings once loaded, else defaults). */
export function knownProviders() {
  if (!knownCache) knownCache = (cache?.knownProviders ?? DEFAULT_SETTINGS.knownProviders).split('\n').map((x) => x.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean);
  return knownCache;
}

function deepMerge(base, over) {
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return over === undefined ? base : over;
  const out = { ...base };
  for (const k of Object.keys(over || {})) out[k] = deepMerge(base[k], over[k]);
  return out;
}

export async function getSettings() {
  if (cache) return cache;
  const row = await one('SELECT data FROM settings WHERE id = 1');
  cache = deepMerge(DEFAULT_SETTINGS, row?.data || {});
  knownCache = null;
  return cache;
}

export async function saveSettings(patch) {
  const current = await getSettings();
  const next = deepMerge(current, patch);
  validate(next);
  await q('UPDATE settings SET data = $1::jsonb, updated_at = now() WHERE id = 1', [JSON.stringify(next)]);
  cache = next;
  knownCache = null;
  return next;
}

function validate(s) {
  const int = (v, lo, hi, name) => { if (!Number.isInteger(v) || v < lo || v > hi) throw new Error(`${name} must be a whole number between ${lo} and ${hi}.`); };
  int(s.dailyCap, 1, 500, 'Daily cap');
  int(s.threshold, 0, 100, 'Auto-approve threshold');
  int(s.minGapSeconds, 0, 3600, 'Minimum gap');
  int(s.maxGapSeconds, s.minGapSeconds, 7200, 'Maximum gap');
  int(s.followupGap1Days, 1, 30, 'Follow-up 1 gap');
  int(s.followupGap2Days, 1, 30, 'Follow-up 2 gap');
  int(s.lusha.dailyRevealLimit, 0, 1000, 'Lusha daily reveal limit');
  int(s.lusha.pagesPerDay, 0, 20, 'Lusha pages per day');
  for (const t of ['sendWindowStart', 'sendWindowEnd', 'discoveryTime']) if (!/^\d{1,2}:\d{2}$/.test(s[t])) throw new Error(`${t} must look like 08:30.`);
}

export function invalidateSettings() { cache = null; knownCache = null; }
