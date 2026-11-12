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
