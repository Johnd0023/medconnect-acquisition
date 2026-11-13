// Open and click tracking for outreach emails.
// Opens: a 1x1 image in the HTML. Clicks: the brochure link carries the message's token.
// Security scanners and privacy proxies open and click automatically, so those are flagged as "machine"
// (too soon after sending, or a scanner's user agent) and left out of the rates.
import crypto from 'node:crypto';
import { q, one } from './db.js';
import { cfg } from './config.js';

export const newToken = () => crypto.randomBytes(12).toString('base64url');
export const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const SCANNER_UA = /(bot|crawler|spider|scanner|python|curl|wget|java\/|go-http|okhttp|barracuda|mimecast|proofpoint|messagelabs|symantec|forcepoint|trendmicro|sophos|fortinet|cisco|ironport|zscaler|safelinks|microsoft office protocol discovery|preview|headless|phantom|httpclient|libwww|appengine)/i;
const MACHINE_WINDOW_SECONDS = 90;

/** Add the open pixel and click tokens to an email's HTML. */
export function instrument(html, token, settings) {
  const t = settings.tracking || {};
  let out = html;
  if (t.clicks !== false) {
    const own = `${cfg.appUrl}/b/`;
    out = out.replace(/href="([^"]+)"/g, (m, href) => {
      const raw = href.replace(/&amp;/g, '&');
      if (raw.startsWith(own)) return `href="${raw}${raw.includes('?') ? '&amp;' : '?'}m=${token}"`;
      if (settings.brochure?.url && raw === settings.brochure.url.trim()) return `href="${cfg.appUrl}/r/${token}"`;
      return m;
    });
  }
  if (t.opens !== false) out += `<img src="${cfg.appUrl}/o/${token}.gif" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0;opacity:0">`;
  return out;
}

/** Record an open or click. Returns the message (for redirects) or null. */
export async function recordEvent(token, kind, req) {
  if (!token || !/^[\w-]{10,40}$/.test(token)) return null;
  const msg = await one('SELECT id, sent_at, employer_id FROM messages WHERE track_token = $1', [token]);
  if (!msg) return null;
  const ua = String(req.headers['user-agent'] || '').slice(0, 300);
  const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim().slice(0, 64);
  const secs = (Date.now() - new Date(msg.sent_at).getTime()) / 1000;
  const machine = secs < MACHINE_WINDOW_SECONDS || SCANNER_UA.test(ua) || !ua;
  await q('INSERT INTO email_events (message_id, kind, ua, ip, machine) VALUES ($1, $2, $3, $4, $5)', [msg.id, kind, ua, ip, machine]);
  return msg;
}

/** Engagement for messages sent in the last `days` (or all time). Human events only. */
export async function engagement(days = null) {
  const r = await one(`
    SELECT count(*)::int AS sent,
      count(*) FILTER (WHERE EXISTS (SELECT 1 FROM email_events e WHERE e.message_id = m.id AND e.kind IN ('open','click') AND NOT e.machine))::int AS opened,
      count(*) FILTER (WHERE EXISTS (SELECT 1 FROM email_events e WHERE e.message_id = m.id AND e.kind = 'click' AND NOT e.machine))::int AS clicked,
      count(*) FILTER (WHERE m.track_token IS NOT NULL)::int AS tracked
    FROM messages m WHERE m.status = 'sent' ${days ? `AND m.sent_at >= now() - interval '${Number(days)} days'` : ''}`);
  return r;
}

/** Per-message engagement for the drawer and sent log. */
export async function messageEngagement(ids) {
  if (!ids.length) return {};
  const rows = await q(`SELECT message_id, kind, min(at) AS first_at, count(*)::int AS n FROM email_events WHERE message_id = ANY($1::int[]) AND NOT machine GROUP BY message_id, kind`, [ids]);
  const out = {};
  for (const r of rows) (out[r.message_id] ||= {})[r.kind] = { first: r.first_at, n: r.n };
  return out;
}
