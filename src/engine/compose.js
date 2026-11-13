// Email composition from verified facts only. A template field with no verified value
// leaves the email unsendable (the sequence pauses) instead of guessing.
import { toHtml, escapeHtml } from './html.js';
import { cfg } from '../config.js';
const FIELD_RE = /\{\{(\w+)\}\}/g;
const OPTIONAL = new Set(['more_openings', 'brochure']);

export function fieldsFor(emp, contact, openings, settings) {
  const active = openings.filter((o) => o.active).sort((a, b) => new Date(b.posted_at || b.first_seen) - new Date(a.posted_at || a.first_seen));
  const mine = contact?.email ? active.filter((o) => (o.contact_email || '').toLowerCase() === contact.email.toLowerCase()) : [];
  const o = mine[0] || active[0];
  const f = {
    // No name on a forwarding address: "Hi there,"
    first_name: contact?.first_name || 'there',
    employer: emp.name,
    sender_name: settings.senderName,
    city: o?.city || emp.city || '',
    state: o?.state || emp.state || '',
  };
  if (o) {
    f.role = o.role || '';
    f.specialty = o.specialty || '';
    const list = mine.length ? mine : active;
    f.more_openings = list.length > 1 ? ` (one of ${list.length} openings we saw listed)` : '';
    f.signal_line = `the ${o.specialty} ${o.role} opening in ${o.city || emp.city || 'your area'}`;
    f.signal_subject = `${o.specialty} ${o.role} search at ${emp.name}`;
  } else {
    f.signal_line = `provider recruiting at ${emp.name}`;
    f.signal_subject = `Provider recruiting support for ${emp.name}`;
  }
  return f;
}

export function render(tpl, f) {
  const missing = new Set();
  const sub = (s) => s.replace(FIELD_RE, (_, k) => {
    const v = f[k];
    if (v === undefined || v === null || (v === '' && !OPTIONAL.has(k))) { missing.add(k); return `{{${k}}}`; }
    return v;
  });
  return { subject: sub(tpl.subject), body: sub(tpl.body), missing: [...missing] };
}

const OLD_OPT_OUT = "If you'd rather not hear from me, reply \"unsubscribe\" and I won't email you again.";
export const DEFAULT_OPT_OUT = "P.S. If this isn't relevant, just let me know and I won't follow up.";

/** The address goes in the signature, under the company name, like a normal business signature. */
export function withSignature(body, settings) {
  const text = body.replace(/\s+$/, '');
  const addr = (settings.companyAddress || '').trim();
  const signed = !addr ? text : /MedConnect Staffing$/i.test(text) ? `${text}\n${addr}` : `${text}\nMedConnect Staffing\n${addr}`;
  const optOut = !settings.optOutLine || settings.optOutLine === OLD_OPT_OUT ? DEFAULT_OPT_OUT : settings.optOutLine;
  return `${signed}\n\n${optOut}`;
}

/** Compose the email for `step` (0 = initial, 1-2 = follow-ups). */
export function compose(emp, contact, openings, step, settings, brochure = null) {
  const t = settings.templates;
  const hasOpening = openings.some((o) => o.active);
  const key = step === 0 ? (hasOpening ? 'initial_opening' : 'initial_general') : step === 1 ? 'followup_1' : 'followup_2';
  const r = render(t[key], { ...fieldsFor(emp, contact, openings, settings), brochure: brochure?.line || '', brochure_url: brochure?.url || '' });
  // Brochure line: where the template puts {{brochure}}, otherwise as its own paragraph just above the sign-off
  if (brochure?.line && !/\{\{\s*brochure(_url)?\s*\}\}/.test(t[key].body)) {
    const paras = r.body.replace(/\s+$/, '').split(/\n{2,}/);
    paras.splice(Math.max(1, paras.length - 1), 0, brochure.line);
    r.body = paras.join('\n\n');
  }
  r.body = r.body.replace(/\n{3,}/g, '\n\n');
  // PracticeMatch routes and labels messages by the posting's code: keep "Opportunity <code>" in the subject.
  const posting = openings.filter((o) => o.pm_code && contact?.email && (o.contact_email || '').toLowerCase() === contact.email.toLowerCase())
    .sort((a, b) => new Date(b.posted_at || b.first_seen) - new Date(a.posted_at || a.first_seen))[0];
  if (posting && /@practicematch\.com$/i.test(contact.email) && !/opportunity\s+\S+/i.test(r.subject)) r.subject = `Opportunity ${posting.pm_code} | ${r.subject}`;
  if (!settings.companyAddress) r.missing.push('company_address (Settings → Sender)');
  if (!/[a-z]/i.test(r.subject)) r.missing.push('subject');
  const sig = settings.signature;
  if (sig?.enabled) {
    const main = stripSignOff(r.body, settings);
    const body = `${main}\n\n${signatureText(settings)}\n\n${optOutLine(settings)}`;
    const html = htmlFor(main, settings, brochure) + signatureHtml(settings) + `<p style="margin:18px 0 0 0;font-family:Aptos,Calibri,Arial,sans-serif;color:#6b7280;font-size:10.5pt">${escapeHtml(optOutLine(settings))}</p>`;
    return { ...r, body, html, template: t[key].label, key, attachment: brochure?.attachment?.name || null };
  }
  const body = withSignature(r.body, settings);
  return { ...r, body, html: htmlFor(body, settings, brochure), template: t[key].label, key, attachment: brochure?.attachment?.name || null };
}

const optOutLine = (settings) => (!settings.optOutLine || settings.optOutLine === OLD_OPT_OUT ? DEFAULT_OPT_OUT : settings.optOutLine);

/**
 * Templates often end with a typed sign-off ("John Duva / 954-900-8931 / MedConnect Staffing" or "{{sender_name}}").
 * With the signature turned on, drop that last block (and a closing like "Thanks,") so it isn't signed twice.
 */
export function stripSignOff(text, settings) {
  const sig = settings.signature || {};
  const names = [sig.name, settings.senderName, sig.company, 'MedConnect Staffing'].filter(Boolean).map((n) => n.toLowerCase());
  const paras = text.replace(/\s+$/, '').split(/\n{2,}/);
  const isSignOff = (p) => {
    const lines = p.split('\n').map((l) => l.trim()).filter(Boolean);
    return lines.length > 0 && lines.length <= 6 && lines.every((l) => l.length <= 60)
      && lines.some((l) => names.includes(l.toLowerCase()) || /^\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}$/.test(l) || /^(direct|cell|phone|mobile)\b/i.test(l));
  };
  const isClosing = (p) => /^(thank you|thanks|best|best regards|regards|sincerely|kind regards|warm regards|cheers),?$/i.test(p.trim());
  while (paras.length > 1 && (isSignOff(paras.at(-1)) || isClosing(paras.at(-1)))) paras.pop();
  // a closing on the first line of the sign-off block ("Thanks,\nJohn")
  return paras.join('\n\n');
}

export function signatureText(settings) {
  const s = settings.signature || {};
  return [s.closing, '', [s.name, s.title].filter(Boolean).join('\n'), '', [s.company, s.phone, s.tagline, settings.companyAddress].filter(Boolean).join('\n')]
    .join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function signatureHtml(settings) {
  const s = settings.signature || {}; const e = escapeHtml;
  const base = 'font-family:Aptos,Calibri,Arial,Helvetica,sans-serif;font-size:12pt;line-height:1.35;color:#1f2328;margin:0';
  const grey = 'color:#5f6b7a';
  const tel = (s.phone || '').replace(/[^\d+]/g, '');
  const phone = s.phone ? (tel.length >= 10 ? `<a href="tel:+1${tel.slice(-10)}" style="${grey};text-decoration:none">${e(s.phone)}</a>` : `<span style="${grey}">${e(s.phone)}</span>`) : '';
  return `<div style="margin-top:18px">`
    + (s.closing ? `<p style="${base};margin-bottom:14px">${e(s.closing)}</p>` : '')
    + `<p style="${base};margin-bottom:14px">${s.name ? `<strong>${e(s.name)}</strong>` : ''}${s.title ? `<br><span style="${grey}">${e(s.title)}</span>` : ''}</p>`
    + `<p style="${base};margin-bottom:10px">${s.company ? `<strong>${e(s.company)}</strong>` : ''}${phone ? `<br>${phone}` : ''}</p>`
    + (s.logo ? `<p style="${base};margin-bottom:6px"><a href="https://medconnectstaffing.com" style="text-decoration:none"><img src="${cfg.appUrl}/email-logo.png" width="212" height="53" alt="MedConnect Staffing" style="display:block;border:0;width:212px;height:53px"></a></p>` : '')
    + (s.tagline ? `<p style="${base};font-size:11pt;margin-bottom:6px">${e(s.tagline)}</p>` : '')
    + (settings.companyAddress ? `<p style="${base};font-size:10pt;color:#6b7280">${e(settings.companyAddress)}</p>` : '')
    + `</div>`;
}

/** HTML version: real bullets, bold lead-ins, short link text, quiet address and P.S. */
export function htmlFor(body, settings, brochure) {
  let text = body;
  const url = brochure?.url;
  if (url) {
    const u = url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // "...brochure here: <url>" → "...brochure here." with "here" as the link
    text = text.replace(new RegExp(`\\b(here|below)\\s*:?\\s*${u}([.!]?)`, 'gi'), (_, w, p) => `[${w}](${url})${p || '.'}`);
  }
  const optOut = body.trim().split('\n').at(-1);
  return toHtml(text, {
    linkLabels: url ? { [url]: 'MedConnect client brochure (PDF)' } : {},
    quietLines: [settings.companyAddress, /^p\.?s\.?\b/i.test(optOut) || /follow up|unsubscribe|hear from me/i.test(optOut) ? optOut : null],
  });
}
