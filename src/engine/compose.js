// Email composition from verified facts only. A template field with no verified value
// leaves the email unsendable (the sequence pauses) instead of guessing.
const FIELD_RE = /\{\{(\w+)\}\}/g;
const OPTIONAL = new Set(['more_openings']);

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
    f.more_openings = active.length > 1 ? ` (one of ${active.length} provider openings we saw listed)` : '';
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

export function footer(settings) {
  const parts = [settings.optOutLine, settings.companyAddress ? `MedConnect Staffing · ${settings.companyAddress}` : ''];
  return parts.filter(Boolean).join('\n');
}

/** Compose the email for `step` (0 = initial, 1-2 = follow-ups). */
export function compose(emp, contact, openings, step, settings) {
  const t = settings.templates;
  const hasOpening = openings.some((o) => o.active);
  const key = step === 0 ? (hasOpening ? 'initial_opening' : 'initial_general') : step === 1 ? 'followup_1' : 'followup_2';
  const r = render(t[key], fieldsFor(emp, contact, openings, settings));
  // PracticeMatch routes and labels messages by the posting's code: keep "Opportunity <code>" in the subject.
  const posting = openings.filter((o) => o.pm_code && contact?.email && (o.contact_email || '').toLowerCase() === contact.email.toLowerCase())
    .sort((a, b) => new Date(b.posted_at || b.first_seen) - new Date(a.posted_at || a.first_seen))[0];
  if (posting && /@practicematch\.com$/i.test(contact.email) && !/opportunity\s+\S+/i.test(r.subject)) r.subject = `Opportunity ${posting.pm_code} | ${r.subject}`;
  if (!settings.companyAddress) r.missing.push('company_address (Settings → Sender)');
  if (!/[a-z]/i.test(r.subject)) r.missing.push('subject');
  return { ...r, body: `${r.body}\n\n--\n${footer(settings)}`, template: t[key].label, key };
}
