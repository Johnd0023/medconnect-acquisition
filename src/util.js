import crypto from 'node:crypto';
import { cfg } from './config.js';

export const normDomain = (d) =>
  (d || '').toLowerCase().trim().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[/?#].*$/, '') || null;

export const normName = (n) =>
  (n || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\b(the|inc|llc|pllc|pc|pa|corp|corporation|co|ltd)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

export const emailDomain = (e) => normDomain((e || '').split('@')[1]);

const FREE_MAIL = new Set(['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'aol.com', 'icloud.com', 'live.com', 'msn.com', 'comcast.net', 'protonmail.com']);
export const isFreeMail = (e) => FREE_MAIL.has(emailDomain(e));

/** PracticeMatch forwarding addresses are shared by many clients; the client is identified by the Opportunity code. */
export const isRelay = (e) => /@practicematch\.com$/i.test(e || '');

export const lines = (s) => (s || '').split('\n').map((x) => x.trim()).filter(Boolean);

// ---------- AES-256-GCM for tokens at rest ----------
function key() { return Buffer.from(cfg.encryptionKey, 'base64'); }
export function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
}
export function decrypt(blob) {
  const [iv, tag, enc] = blob.split('.').map((s) => Buffer.from(s, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}

// ---------- business-timezone helpers ----------
/** Parts of `date` in the business timezone: { y, m, d, hh, mm, dow (0=Sun), ymd } */
export function zoned(date = new Date(), tz = cfg.timezone) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short' });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday);
  return { y: +p.year, m: +p.month, d: +p.day, hh: +p.hour, mm: +p.minute, dow, ymd: `${p.year}-${p.month}-${p.day}` };
}
export const hhmmToMin = (s) => { const [h, m] = String(s || '0:0').split(':').map(Number); return h * 60 + (m || 0); };

/** Offset (ms) of the business timezone from UTC at instant `date` (e.g. -5h for EST). */
function tzOffsetMs(date, tz = cfg.timezone) {
  const z = zoned(date, tz);
  const asUtc = Date.UTC(z.y, z.m - 1, z.d, z.hh, z.mm);
  return asUtc - Math.floor(date.getTime() / 60000) * 60000;
}
/** The UTC instant of local midnight (business tz) for the local date of `date`. */
export function startOfBusinessDay(date = new Date(), tz = cfg.timezone) {
  const z = zoned(date, tz);
  const naive = Date.UTC(z.y, z.m - 1, z.d);
  let t = naive - tzOffsetMs(new Date(naive), tz);
  t = naive - tzOffsetMs(new Date(t), tz); // second pass settles DST edges
  return new Date(t);
}
/** UTC instant for local clock time "HH:MM" on the business-local date of `date`. */
export function atLocalTime(date, hhmm, tz = cfg.timezone) {
  const mid = startOfBusinessDay(date, tz);
  return new Date(mid.getTime() + hhmmToMin(hhmm) * 60000);
}

/** Add business days (skipping days not in `days`, 0=Sun..6=Sat) to a local date, returns Date at local 00:00. */
export function addSendDays(from, n, days = [1, 2, 3, 4, 5]) {
  let t = startOfBusinessDay(from).getTime();
  let added = 0;
  while (added < n) {
    t += 26 * 3600 * 1000; // jump past DST edges, then snap to local midnight
    t = startOfBusinessDay(new Date(t)).getTime();
    if (days.includes(zoned(new Date(t)).dow)) added++;
  }
  return new Date(t);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const randInt = (a, b) => a + Math.floor(Math.random() * (b - a + 1));

// Mailboxes that belong to a team, not a person: never turned into a name.
const GENERIC_MAILBOX = /^(info|careers?|jobs?|recruit\w*|talent\w*|hr|humanresources|admin\w*|office|contact|hello|support|staffing|physicians?|providers?|apply|applications?|noreply|no-reply|donotreply|medicalstaff|credentialing|frontdesk|reception|billing|marketing|sales|team|hiring|employment|workforce|careers?team|physicianrecruitment|providerrecruitment)$/i;
const GENERIC_WORD = /(recruit|career|talent|staffing|hiring|employment|credential|info|admin|office|noreply|support|physicians|providers|jobs)/i;
const cap = (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();

/** "liz.ray@christushealth.org" → { first: 'Liz', last: 'Ray' }; null when the address doesn't spell out a person's name. */
export function nameFromEmail(email) {
  if (!email || isRelay(email)) return null;
  const local = String(email).split('@')[0].split('+')[0].toLowerCase();
  if (GENERIC_MAILBOX.test(local) || GENERIC_WORD.test(local)) return null;
  const parts = local.split(/[._-]+/).map((p) => p.replace(/\d+/g, '')).filter(Boolean);
  if (parts.length < 2 || parts.some((p) => !/^[a-z']+$/.test(p))) return null;
  const words = parts[0] === 'dr' ? parts.slice(1) : parts;
  const first = words[0]; const last = words[words.length - 1];
  if (words.length < 2 || first.length < 2 || last.length < 2) return null;
  return { first: cap(first), last: cap(last) };
}
