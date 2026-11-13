// Daily email health check for the sending domain: authentication records, blocklists and sending signals
// (bounces, spam blocks, opens, replies), combined into a 0-100 score. Can pause sending if it looks bad.
import dns from 'node:dns/promises';
import { q, one, kvGet, kvSet, logEvent } from './db.js';
import { cfg } from './config.js';
import { engagement } from './tracking.js';

const SPAM_BLOCK = /(spam|blocked|block list|blocklist|blacklist|reputation|junk|5\.7\.(1|23|26|501|505|506|507|508|509|510|511|512|513|514|515|520|708|750)|policy (violation|reasons)|rejected for policy|message rejected|content filter|denied by policy)/i;

async function txt(name) { try { return (await dns.resolveTxt(name)).map((r) => r.join('')); } catch { return []; } }
async function cname(name) { try { return (await dns.resolveCname(name))[0] || null; } catch { return null; } }
async function a(name) {
  try { return { codes: await dns.resolve4(name) }; } catch (e) { return e.code === 'ENOTFOUND' || e.code === 'ENODATA' ? { codes: [] } : { error: e.code || e.message }; }
}

/** Domain blocklists (they list domains seen in spam, including link domains). */
async function blocklists(domain) {
  const lists = [
    { name: 'Spamhaus DBL', zone: 'dbl.spamhaus.org', listed: (c) => /^127\.0\.1\./.test(c), refused: (c) => /^127\.255\.255\./.test(c) },
    { name: 'SURBL', zone: 'multi.surbl.org', listed: (c) => /^127\.0\.0\./.test(c) && c !== '127.0.0.1', refused: (c) => c === '127.0.0.1' },
    { name: 'URIBL', zone: 'multi.uribl.com', listed: (c) => /^127\.0\.0\.(2|4|8|14)$/.test(c), refused: (c) => c === '127.0.0.1' || c === '127.0.0.255' },
  ];
  const out = [];
  for (const l of lists) {
    const r = await a(`${domain}.${l.zone}`);
    const code = r.codes?.[0];
    out.push({ list: l.name, domain, status: r.error ? 'unknown' : !code ? 'clear' : l.refused(code) ? 'unknown' : l.listed(code) ? 'listed' : 'clear', code: code || r.error || null });
  }
  return out;
}

export async function runHealthCheck({ domain = 'medconnectstaffing.com' } = {}) {
  const checks = [];
  const add = (group, label, ok, points, max, detail) => checks.push({ group, label, ok, points, max, detail });

  // --- Authentication (30) ---
  const spfs = (await txt(domain)).filter((t) => /^v=spf1/i.test(t));
  const spfOk = spfs.length === 1 && /include:spf\.protection\.outlook\.com/i.test(spfs[0]);
  add('Authentication', 'SPF allows Microsoft 365 to send for your domain', spfOk, spfOk ? 10 : spfs.length ? 4 : 0, 10,
    spfs.length > 1 ? 'More than one SPF record: merge them into one' : spfs[0] || 'No SPF record found');
  const sel1 = await cname(`selector1._domainkey.${domain}`); const sel2 = await cname(`selector2._domainkey.${domain}`);
  const dkimOk = !!(sel1 && sel2);
  add('Authentication', 'DKIM signing records (Microsoft 365)', dkimOk, dkimOk ? 10 : 0, 10,
    dkimOk ? 'selector1 and selector2 found. Make sure DKIM is switched on in Microsoft Defender' : 'selector1/selector2 records missing: turn on DKIM in Microsoft Defender and add its two CNAME records');
  const dmarc = (await txt(`_dmarc.${domain}`)).find((t) => /^v=DMARC1/i.test(t));
  const policy = dmarc?.match(/;\s*p\s*=\s*(\w+)/i)?.[1]?.toLowerCase();
  add('Authentication', 'DMARC policy published', !!dmarc, dmarc ? (policy === 'none' ? 7 : 10) : 0, 10, dmarc ? `Policy: ${policy || 'unknown'}` : 'No DMARC record');

  // --- Blocklists (20): the sending domain and the domain your links use ---
  const linkHost = new URL(cfg.appUrl).hostname;
  const linkDomain = linkHost.endsWith('.up.railway.app') ? 'up.railway.app' : linkHost.split('.').slice(-2).join('.');
  const bl = [...await blocklists(domain), ...(linkDomain !== domain ? await blocklists(linkDomain) : [])];
  const listed = bl.filter((b) => b.status === 'listed');
  const unknown = bl.filter((b) => b.status === 'unknown');
  add('Blocklists', `Not on spam blocklists (${domain}${linkDomain !== domain ? ` and link domain ${linkDomain}` : ''})`, !listed.length, listed.length ? 0 : 20, 20,
    listed.length ? `Listed: ${listed.map((b) => `${b.domain} on ${b.list}`).join(', ')}` : `Clear${unknown.length ? ` (${unknown.map((b) => b.list).join(', ')} couldn't be checked from this server)` : ''}`);

  // --- Sending signals, last 7 days (50) ---
  const s = await one(`SELECT count(*) FILTER (WHERE status = 'sent')::int AS sent FROM messages WHERE sent_at >= now() - interval '7 days'`);
  const b = await one(`SELECT count(*)::int AS bounces, count(*) FILTER (WHERE coalesce(subject,'') || ' ' || coalesce(body_preview,'') ~* $1)::int AS spam_blocks
                       FROM replies WHERE category = 'bounce' AND received_at >= now() - interval '7 days'`, [SPAM_BLOCK.source]);
  const rep = await one(`SELECT count(*) FILTER (WHERE category NOT IN ('ooo','bounce'))::int AS replies, count(*) FILTER (WHERE category = 'opt_out')::int AS opt_outs
                         FROM replies WHERE received_at >= now() - interval '7 days'`);
  const eng = await engagement(7);
  const sent = s.sent;
  const enough = sent >= 20;
  const bounceRate = sent ? b.bounces / sent : 0;
  add('Sending', 'Bounce rate under 2%', bounceRate <= 0.02, !sent ? 20 : bounceRate <= 0.02 ? 20 : bounceRate <= 0.05 ? 10 : 0, 20,
    sent ? `${b.bounces} bounced of ${sent} sent (${(bounceRate * 100).toFixed(1)}%)` : 'Nothing sent in the last 7 days');
  add('Sending', 'No spam-filter rejections', b.spam_blocks === 0, b.spam_blocks === 0 ? 10 : b.spam_blocks === 1 ? 4 : 0, 10,
    b.spam_blocks ? `${b.spam_blocks} bounce${b.spam_blocks > 1 ? 's' : ''} mentioned spam, blocking or reputation` : 'None');
  const openRate = eng.tracked ? eng.opened / eng.tracked : 0;
  const replyRate = sent ? rep.replies / sent : 0;
  add('Sending', 'People are opening your emails', !enough || openRate >= 0.15, !enough ? 10 : openRate >= 0.2 ? 10 : openRate >= 0.1 ? 5 : 0, 10,
    enough ? `${(openRate * 100).toFixed(0)}% opened by a person (machine opens excluded). Very low open rates usually mean the junk folder` : `Not enough sent yet to judge (${sent} of 20)`);
  add('Sending', 'People are replying', !enough || replyRate > 0, !enough ? 10 : replyRate >= 0.02 ? 10 : replyRate > 0 ? 6 : 2, 10,
    enough ? `${rep.replies} replies (${(replyRate * 100).toFixed(1)}%), ${rep.opt_outs} opt-outs` : `Not enough sent yet to judge (${sent} of 20)`);

  const score = Math.round(checks.reduce((n, c) => n + c.points, 0));
  const status = score >= 85 ? 'Good' : score >= 65 ? 'Watch' : 'At risk';
  const details = { domain, checks, blocklists: bl, metrics: { sent, ...b, ...rep, ...eng, openRate, replyRate, bounceRate }, status };
  const today = new Date().toLocaleDateString('en-CA', { timeZone: cfg.timezone });
  await q(`INSERT INTO domain_health (day, score, details) VALUES ($1, $2, $3::jsonb)
           ON CONFLICT (day) DO UPDATE SET score = EXCLUDED.score, details = EXCLUDED.details, created_at = now()`, [today, score, JSON.stringify(details)]);

  // Safety: stop sending on a blocklisting or repeated spam rejections, until you look at it
  const reasons = [];
  if (listed.some((l) => l.domain === domain)) reasons.push(`${domain} is on a spam blocklist`);
  if (b.spam_blocks >= 3) reasons.push(`${b.spam_blocks} spam-filter rejections in 7 days`);
  if (sent >= 20 && bounceRate > 0.08) reasons.push(`bounce rate ${(bounceRate * 100).toFixed(0)}%`);
  if (reasons.length && !(await kvGet('send_blocked'))) {
    await kvSet('send_blocked', { reason: `Paused by the daily email health check: ${reasons.join('; ')}. Review Performance → Email health, then resume.`, at: new Date().toISOString() });
    await logEvent(null, `Sending paused by health check: ${reasons.join('; ')}`).catch(() => {});
  }
  return { score, status, ...details };
}

export async function healthHistory(days = 30) {
  return q(`SELECT day, score, details, created_at FROM domain_health WHERE day >= (now() AT TIME ZONE $1)::date - $2::int ORDER BY day`, [cfg.timezone, days]);
}
