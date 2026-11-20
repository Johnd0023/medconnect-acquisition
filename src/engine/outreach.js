// Sequences and the send worker: daily cap, warm-up ramp, send window, random spacing,
// one email per organization per day, and every stop condition checked right before each send.
import { q, one, logEvent, kvGet, kvSet } from '../db.js';
import { cfg } from '../config.js';
import { getSettings } from '../settings.js';
import { loadContext, requalify, protectedRecipientMatch } from './qualify.js';
import { compose } from './compose.js';
import { getCampaign, parseFamily, eligibleForCampaign, otherProtectedContext, checkOutlook, composeInputs } from './campaigns.js';
import { brochureFor } from '../brochure.js';
import { instrument, newToken } from '../tracking.js';
import * as outlook from '../integrations/outlook.js';
import { zoned, hhmmToMin, startOfBusinessDay, addSendDays, atLocalTime, randInt, isRelay } from '../util.js';

/** Has this contact already had a sequence? A PracticeMatch forwarding address counts per client, a real address overall. */
async function alreadyContacted(c) {
  return isRelay(c.email)
    ? one(`SELECT s.status, e.name FROM sequences s JOIN employers e ON e.id = s.employer_id WHERE s.contact_id = $1 OR $1 = ANY(s.cc_contact_ids) ORDER BY s.started_at DESC LIMIT 1`, [c.id])
    : one(`SELECT s.status, e.name FROM sequences s JOIN employers e ON e.id = s.employer_id
           JOIN contacts ct ON ct.id = s.contact_id OR ct.id = ANY(s.cc_contact_ids)
           WHERE lower(ct.email) = lower($1) ORDER BY s.started_at DESC LIMIT 1`, [c.email]);
}

/** Enroll a client's selected contacts. Returns the contacts enrolled. */
// With "respect no-agency postings" on, those employers are never enrolled automatically or in bulk.
const notRestricted = (s) => (s.respectNoAgency ? `NOT EXISTS (SELECT 1 FROM openings o WHERE o.employer_id = employers.id AND o.active AND o.restriction IS NOT NULL)` : 'true');

/**
 * Automated mode: enroll every Ready employer scoring at or above the threshold (default 70).
 * Skips "no agencies" postings. Sends still follow the daily cap, warm-up and send window.
 */
export async function autoEnrollReady() {
  const s = await getSettings();
  if (s.supervised || !s.autoEnroll || s.paused) return { enrolled: 0, skipped: 0, reason: 'Automated enrolling is off' };
  const rows = await q(`SELECT id FROM employers WHERE bucket = 'ready' AND coalesce(score, 0) >= $1 AND ${notRestricted(s)} ORDER BY score DESC NULLS LAST, last_signal DESC`, [s.threshold]);
  let enrolled = 0; let skipped = 0;
  for (const { id } of rows) { try { await enroll(id, { by: 'auto' }); enrolled++; } catch { skipped++; } }
  return { enrolled, skipped };
}

export async function readyIds({ minScore = 0 } = {}) {
  const s = await getSettings();
  return q(`SELECT id FROM employers WHERE bucket = 'ready' AND coalesce(score, 0) >= $1 AND ${notRestricted(s)} ORDER BY score DESC NULLS LAST`, [minScore]);
}

export async function enroll(employerId, { by = 'owner' } = {}) {
  const ctx = await loadContext();
  const r = await requalify(employerId, ctx);
  if (!r) throw new Error('Employer not found');
  if (r.bucket !== 'ready') throw new Error(`Not ready for outreach: ${r.reasons.join('; ') || r.status}`);
  const guard = protectedRecipientMatch({ employer: r.employer, contacts: r.contacts, openings: r.openings }, ctx);
  if (guard) throw new Error(`Protected client "${guard}": outreach is not allowed`);
  const recontact = r.employer.decision === 'recontact';
  const fresh = [];
  const skipped = [];
  for (const c of r.selected) {
    const prior = await alreadyContacted(c);
    if (prior && !recontact) skipped.push(`${c.email} (already contacted for ${prior.name})`);
    else fresh.push(c);
  }
  if (!fresh.length) throw new Error(skipped.length ? `Already contacted: ${skipped.join('; ')}. Each contact gets one sequence; follow-ups are part of it.` : 'No contact selected');
  const mode = ctx.settings.multiContact || 'separate';
  if (mode === 'together' && fresh.length > 1) {
    await q(`INSERT INTO sequences (employer_id, contact_id, cc_contact_ids, step, next_at, status) VALUES ($1, $2, $3::int[], 0, now(), 'active')`,
      [employerId, fresh[0].id, fresh.slice(1).map((c) => c.id)]);
    await logEvent(employerId, `Enrolled in outreach (${by}): one email to ${fresh.map((c) => c.full_name || c.email).join(', ')}`);
  } else {
    for (const c of mode === 'single' ? fresh.slice(0, 1) : fresh) {
      await q(`INSERT INTO sequences (employer_id, contact_id, step, next_at, status) VALUES ($1, $2, 0, now(), 'active')`, [employerId, c.id]);
      await logEvent(employerId, `Enrolled in outreach (${by}) → ${c.full_name || c.email}${c.title ? `, ${c.title}` : ''}`);
    }
  }
  if (skipped.length) await logEvent(employerId, `Not enrolled again: ${skipped.join('; ')}`);
  await q(`UPDATE employers SET decision = 'approved' WHERE id = $1`, [employerId]);
  await requalify(employerId, ctx);
  return fresh[0];
}

/** Stop or pause one contact's sequence (others at the same client keep going). */
export async function stopSequenceById(seqId, reason, status = 'stopped') {
  const s = await one(`UPDATE sequences SET status = $2, stop_reason = $3, claimed_at = NULL WHERE id = $1 AND status IN ('active','paused') RETURNING employer_id`, [seqId, status, reason]);
  if (s) { await logEvent(s.employer_id, `Sequence ${status === 'paused' ? 'paused' : 'stopped'}: ${reason}`); await requalify(s.employer_id); }
  return Boolean(s);
}

export async function stopSequence(employerId, reason, status = 'stopped') {
  const s = await one(`UPDATE sequences SET status = $2, stop_reason = $3, claimed_at = NULL
                       WHERE employer_id = $1 AND status IN ('active','paused') RETURNING id`, [employerId, status, reason]);
  if (s) await logEvent(employerId, `Sequence ${status === 'paused' ? 'paused' : 'stopped'}: ${reason}`);
  await requalify(employerId);
  return Boolean(s);
}

export async function resumeSequence(employerId, at = new Date()) {
  const s = await one(`UPDATE sequences SET status = 'active', stop_reason = NULL, next_at = $2, replied = false
                       WHERE employer_id = $1 AND status = 'paused' RETURNING id`, [employerId, at]);
  if (s) await logEvent(employerId, `Sequence resumed (next send ${at.toDateString()})`);
  await requalify(employerId);
  return Boolean(s);
}

/** Today's allowed volume after warm-up. */
export async function todaysCap(settings) {
  // For 7 days after Microsoft restricted the mailbox, send at half the usual cap
  const cool = await kvGet('cooldown_until');
  const base = cool && new Date(cool) > new Date() ? Math.max(5, Math.floor(settings.dailyCap / 2)) : settings.dailyCap;
  settings = { ...settings, dailyCap: base };
  if (!settings.warmup?.enabled) return settings.dailyCap;
  const r = await one(`SELECT count(DISTINCT (sent_at AT TIME ZONE $1)::date) AS days FROM messages
                       WHERE status = 'sent' AND sent_at < $2`, [cfg.timezone, startOfBusinessDay()]);
  return Math.min(settings.dailyCap, settings.warmup.startPerDay + settings.warmup.increasePerDay * Number(r.days || 0));
}

export async function sentToday() {
  const r = await one(`SELECT count(*) AS n FROM messages WHERE status IN ('sent','dry_run') AND sent_at >= $1`, [startOfBusinessDay()]);
  return Number(r.n);
}

export async function sendState(now = new Date()) {
  const s = await getSettings();
  const z = zoned(now);
  const minutes = z.hh * 60 + z.mm;
  const inDay = s.sendDays.includes(z.dow);
  const inWindow = inDay && minutes >= hhmmToMin(s.sendWindowStart) && minutes < hhmmToMin(s.sendWindowEnd);
  const cap = await todaysCap(s);
  const sent = await sentToday();
  const nextAllowed = await kvGet('next_send_at');
  const blocked = await kvGet('send_blocked');
  const outlookConn = await outlook.connection();
  let reason = null;
  if (s.paused) reason = 'Automation is paused';
  else if (blocked) reason = `Sending stopped: ${blocked.reason}`;
  else if (!cfg.dryRun && !outlookConn.connected) reason = 'Outlook is not connected';
  else if (!inDay) reason = 'Not a send day';
  else if (!inWindow) reason = `Outside the send window (${s.sendWindowStart}–${s.sendWindowEnd})`;
  else if (sent >= cap) reason = `Today's limit reached (${sent}/${cap})`;
  else {
    const hour = Number((await one(`SELECT count(*) AS n FROM messages WHERE status IN ('sent','dry_run') AND sent_at > now() - interval '60 minutes'`)).n);
    const hc = s.hourlyCap ?? 10;
    if (hour >= hc) reason = `Hourly limit reached (${hour}/${hc} in the last hour)`;
  }
  return { canSend: !reason, reason, cap, sent, inWindow, dryRun: cfg.dryRun, nextAllowed: nextAllowed ? new Date(nextAllowed) : null, settings: s };
}

async function claimNext(settings) {
  return one(`UPDATE sequences SET claimed_at = now() WHERE id = (
      SELECT s.id FROM sequences s
      WHERE s.status = 'active' AND s.next_at <= now()
        AND (s.claimed_at IS NULL OR s.claimed_at < now() - interval '10 minutes')
        AND NOT s.editing
        AND (SELECT count(*) FROM messages m WHERE m.employer_id = s.employer_id AND m.sent_at >= $1) < $2
        AND (s.campaign_id IS NULL OR (s.approved_step >= s.step AND EXISTS (SELECT 1 FROM campaigns c WHERE c.id = s.campaign_id AND c.active
             AND (SELECT count(*) FROM messages m2 JOIN sequences s2 ON s2.id = m2.sequence_id WHERE s2.campaign_id = c.id AND m2.status IN ('sent','dry_run') AND m2.sent_at >= $1)
                 < coalesce((c.settings->>'dailyLimit')::int, 25))))
      -- 1) emails the owner pushed with "Send first"  2) approved client-campaign emails (CommonSpirit MSA)  3) everything else
      ORDER BY (s.campaign_id IS NULL AND s.priority > 0) DESC, (s.campaign_id IS NOT NULL) DESC, s.step DESC, s.next_at ASC
      LIMIT 1 FOR UPDATE SKIP LOCKED)
    RETURNING *`, [startOfBusinessDay(), settings.perEmployerPerDay]);
}

/** Has anyone this sequence emails written back (not an out-of-office) since it started? */
async function repliedSince(seq) {
  if (seq.replied) return true;
  const r = await one(`SELECT 1 FROM replies r JOIN contacts c ON lower(c.email) = lower(r.from_email)
                       WHERE (c.id = $1 OR c.id = ANY($2::int[])) AND r.received_at >= $3 AND r.category NOT IN ('ooo','bounce','sender_blocked') LIMIT 1`,
  [seq.contact_id, seq.cc_contact_ids || [], seq.started_at]);
  if (r) return true;
  const t = await one(`SELECT 1 FROM replies r JOIN messages m ON m.id = r.message_id WHERE m.sequence_id = $1 AND r.category NOT IN ('ooo','bounce','sender_blocked') LIMIT 1`, [seq.id]);
  return Boolean(t);
}

/** Send at most one email if every limit allows it. Returns a short description of what happened. */
export async function sendTick({ force = false } = {}) {
  const st = await sendState();
  if (!st.canSend) return { sent: false, reason: st.reason };
  if (!force && st.nextAllowed && st.nextAllowed > new Date()) return { sent: false, reason: 'Waiting for spacing gap' };
  const s = st.settings;
  // Read the inbox right before sending if it hasn't been checked in the last 3 minutes, so a fresh reply stops the next email
  if (!cfg.dryRun) {
    const last = await kvGet('reply_polled_at');
    if (!last || Date.now() - new Date(last) > 3 * 60000) {
      try { await (await import('./replies.js')).pollReplies(); } catch (e) { console.error('Reply check before send failed:', e.message); }
    }
  }
  const seq = await claimNext(s);
  if (!seq) return { sent: false, reason: 'Nothing due' };
  if (await repliedSince(seq)) {
    await q('UPDATE sequences SET replied = true WHERE id = $1', [seq.id]);
    await stopSequenceById(seq.id, 'Replied: no more emails in this sequence');
    return { sent: false, reason: 'stopped (they replied)' };
  }
  if (seq.campaign_id) return campaignSend(seq, s);

  const ctx = await loadContext();
  const r = await requalify(seq.employer_id, ctx);
  const emp = r.employer;
  if (['protected', 'excluded', 'suppressed'].includes(r.status)) {
    if (r.status === 'protected') await logEvent(emp.id, `Email BLOCKED: ${r.reasons[0] || 'protected client'}`);
    await stopSequence(emp.id, r.status === 'protected' ? `Blocked before sending: ${r.reasons[0] || 'protected client'}` : `Employer is now ${r.status}`);
    return { sent: false, reason: r.status === 'protected' ? 'Blocked: protected client' : 'stopped' };
  }
  const contact = r.contacts.find((c) => c.id === seq.contact_id);
  if (contact && isRelay(contact.email)) {
    await stopSequenceById(seq.id, 'PracticeMatch address (@practicematch.com): never emailed'); await requalify(emp.id); return { sent: false, reason: 'stopped' };
  }
  if (!contact || !contact.email || contact.bad || ctx.suppressedEmails.has(contact.email.toLowerCase())) {
    await stopSequenceById(seq.id, 'Contact opted out, bounced, or was marked wrong'); return { sent: false, reason: 'stopped' };
  }
  // "Together" sequences also go to the other selected contacts (minus anyone who opted out or bounced since)
  const others = (seq.cc_contact_ids || []).map((id) => r.contacts.find((c) => c.id === id))
    .filter((c) => c && c.email && !c.bad && !isRelay(c.email) && !ctx.suppressedEmails.has(c.email.toLowerCase()));
  const recipients = [contact, ...others];
  // FINAL GUARDRAIL: never email a protected client, whatever the source (PracticeMatch, Lusha, import, manual).
  // Uses a freshly loaded protected list and every posting behind this contact.
  const guardCtx = await loadContext();
  const guard = protectedRecipientMatch({ employer: emp, contacts: recipients.concat(r.contacts), openings: r.openings }, guardCtx);
  if (guard) {
    await logEvent(emp.id, `Email to ${contact.email} BLOCKED: matches protected client "${guard}"`);
    await stopSequence(emp.id, `Blocked before sending: protected client "${guard}"`);
    return { sent: false, reason: `Blocked: protected client ${guard}` };
  }
  const names = recipients.map((c) => c.first_name).filter(Boolean);
  const addressee = recipients.length > 1
    ? { ...contact, email: null, first_name: names.length === recipients.length ? (names.length === 2 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`) : 'there' }
    : contact;
  const bro = await brochureFor(seq.step, s, { lineOnly: cfg.dryRun });
  const m = compose(emp, addressee, r.openings, seq.step, s, bro);
  const attachments = bro?.attachment?.contentBytes ? [bro.attachment] : undefined;
  if (m.missing.length) { await stopSequenceById(seq.id, `Missing verified fact: ${m.missing.join(', ')}`, 'paused'); return { sent: false, reason: 'paused (missing fact)' }; }
  return deliver({ seq, emp, contact, recipients, m, attachments, s, ctx });
}

/** Send (or dry-run) one composed email, record it, and move the sequence to its next step. */
async function deliver({ seq, emp, contact, recipients, m, attachments, s, ctx, label: labelPrefix = '' }) {
  const toList = recipients.map((c) => ({ address: c.email, name: c.full_name || undefined }));
  const trackToken = newToken();
  if (m.html) m.html = instrument(m.html, trackToken, s);

  let result = {}; let status = 'sent'; let error = null;
  if (cfg.dryRun) {
    status = 'dry_run';
  } else {
    try {
      const prev = seq.step > 0 ? await one(`SELECT internet_message_id FROM messages WHERE sequence_id = $1 AND status = 'sent' ORDER BY sent_at DESC LIMIT 1`, [seq.id]) : null;
      result = seq.step === 0
        ? await outlook.sendNew({ to: toList, subject: m.subject, body: m.body, html: m.html, attachments })
        : await outlook.sendFollowUp({ to: toList, previousInternetMessageId: prev?.internet_message_id, body: m.body, html: m.html, fallbackSubject: m.subject, attachments });
    } catch (e) {
      error = e.message;
      if (e.status === 401 || e.status === 403 || e.code === 'NotConnected' || e.code === 'invalid_grant' || e.code === 'ErrorAccessDenied' || e.code === 'ErrorExceededMessageLimit' || e.code === 'ErrorSubmissionQuotaExceeded') {
        const restricted = /5\.1\.8|outbound sender|quota|limit/i.test(`${e.code} ${error}`);
        await kvSet('send_blocked', { reason: restricted ? `Microsoft refused to send (${error}). Your mailbox may be restricted: check Microsoft Defender → Restricted entities, then resume.` : error, at: new Date().toISOString(), kind: restricted ? 'restricted' : 'error' });
        await q('UPDATE sequences SET claimed_at = NULL WHERE id = $1', [seq.id]);
        return { sent: false, reason: `Sending blocked: ${error}` };
      }
      status = 'failed';
    }
  }

  await q(`INSERT INTO messages (sequence_id, employer_id, contact_id, step, to_email, subject, body, status, error, graph_id, internet_message_id, conversation_id, attachment, track_token)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
  [seq.id, emp.id, contact.id, seq.step, recipients.map((c) => c.email).join(', '), m.subject, m.body, status, error, result.graphId || null, result.internetMessageId || null, result.conversationId || null, m.attachment, status === 'sent' ? trackToken : null]);
  if (seq.priority) await q('UPDATE sequences SET priority = 0 WHERE id = $1', [seq.id]);
  await kvSet('next_send_at', new Date(Date.now() + randInt(s.minGapSeconds, s.maxGapSeconds) * 1000).toISOString());

  const label = labelPrefix + (seq.step === 0 ? 'Initial email' : `Follow-up ${seq.step}`);
  if (status === 'failed') {
    await stopSequenceById(seq.id, `${label} failed to send: ${error}`);
    return { sent: false, reason: `failed: ${error}` };
  }
  if (status === 'dry_run') {
    await logEvent(emp.id, `${label} composed for ${recipients.map((c) => c.email).join(', ')} (dry run, not sent)`);
    await q(`UPDATE sequences SET status = 'paused', stop_reason = $2, claimed_at = NULL WHERE id = $1`, [seq.id, `Dry run: ${label.toLowerCase()} composed, not sent. Resume once live sending is on.`]);
    await requalify(emp.id, ctx);
    return { sent: true, dryRun: true, to: recipients.map((c) => c.email).join(', '), subject: m.subject };
  }

  await logEvent(emp.id, `${label} sent to ${recipients.map((c) => c.email).join(', ')}`);
  const nextStep = seq.step + 1;
  const maxSteps = Math.max(1, Math.min(3, seq.max_steps || 3));
  if (nextStep >= maxSteps) {
    await q(`UPDATE sequences SET step = $2, status = 'completed', stop_reason = '${maxSteps === 1 ? 'Sent only the initial email, as you chose. No reply' : maxSteps === 2 ? 'Sent the 2 emails you chose. No reply' : 'Sequence finished with no reply'}', claimed_at = NULL, conversation_id = coalesce(conversation_id, $3) WHERE id = $1`, [seq.id, nextStep, result.conversationId || null]);
  } else {
    const gap = nextStep === 1 ? s.followupGap1Days : s.followupGap2Days;
    const nextDay = addSendDays(new Date(), gap, s.sendDays);
    await q(`UPDATE sequences SET step = $2, next_at = $3, claimed_at = NULL, conversation_id = coalesce(conversation_id, $4) WHERE id = $1`,
      [seq.id, nextStep, atLocalTime(nextDay, s.sendWindowStart), result.conversationId || null]);
  }
  await requalify(emp.id, ctx);
  return { sent: true, to: recipients.map((c) => c.email).join(', '), subject: m.subject };
}

/**
 * A client-campaign email (e.g. CommonSpirit MSA). The owner approved this exact step. Protection for the campaign's
 * own client is lifted; every other check still applies, plus a fresh Outlook search for email with this person
 * since the approval (anything new puts it back in front of the owner instead of sending).
 */
async function campaignSend(seq, s) {
  const camp = await getCampaign(seq.campaign_id);
  const fam = parseFamily(camp.family);
  if ((await one('SELECT editing FROM sequences WHERE id = $1', [seq.id]))?.editing) {
    await q('UPDATE sequences SET claimed_at = NULL WHERE id = $1', [seq.id]);
    return { sent: false, reason: 'Paused while you edit' };
  }
  const ctx = await loadContext();
  const emp = await one('SELECT * FROM employers WHERE id = $1', [seq.employer_id]);
  const [openings, contacts] = await Promise.all([
    q('SELECT * FROM openings WHERE employer_id = $1', [emp.id]), q('SELECT * FROM contacts WHERE employer_id = $1', [emp.id])]);
  const contact = contacts.find((c) => c.id === seq.contact_id);
  const stop = async (why, status = 'stopped') => { await stopSequenceById(seq.id, why, status); return { sent: false, reason: why }; };
  if (!contact?.email || isRelay(contact.email)) return stop('No direct email address');
  const email = contact.email.toLowerCase();
  if (contact.bad || ctx.suppressedEmails.has(email) || ctx.suppressedDomains.has(email.split('@')[1])) return stop('Contact opted out, bounced, or was marked wrong');
  if (!eligibleForCampaign(contact, emp, openings, fam)) return stop(`${email} isn't a ${camp.client} address (a posting for a ${camp.client} hospital, from another company)`);
  const other = protectedRecipientMatch({ employer: emp, contacts: [contact], openings }, await otherProtectedContext(fam));
  if (other) { await logEvent(emp.id, `${camp.name} email to ${email} BLOCKED: also matches protected client "${other}"`); return stop(`Blocked: also matches protected client "${other}"`); }
  if (!cfg.dryRun) {
    let hold = null;
    try {
      const { messages } = await checkOutlook(camp.id, email);
      const since = new Date(seq.approved_at || seq.started_at);
      const fresh = messages.filter((x) => new Date(x.at) > since);
      const fromThem = fresh.filter((x) => x.from === email && !/^(automatic reply|auto(matic)?[- ]?reply|out of (the )?office)/i.test(x.subject || ''));
      if (fromThem.length) {
        await q('UPDATE sequences SET replied = true WHERE id = $1', [seq.id]);
        return stop(`Replied ${new Date(fromThem[0].at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}: "${(fromThem[0].subject || '').slice(0, 80)}". No more campaign emails.`);
      }
      if (fresh.length) hold = `New Outlook email with ${email} since you approved this (${new Date(fresh[0].at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}: "${(fresh[0].subject || '').slice(0, 80)}"). Check it, then approve again.`;
    } catch (e) { hold = `Couldn't check Outlook for earlier emails (${e.message}). Approve again to retry.`; }
    if (hold) {
      await q('UPDATE sequences SET approved_step = step - 1, hold_note = $2, claimed_at = NULL, priority = 0 WHERE id = $1', [seq.id, hold]);
      await logEvent(emp.id, `${camp.name}: held before sending. ${hold}`);
      return { sent: false, reason: 'held for owner review' };
    }
  }
  const inputs = await composeInputs(camp, email);
  const bro = await brochureFor(seq.step, s, { lineOnly: cfg.dryRun });
  const m = compose({ ...emp, drafts: inputs.drafts }, contact, openings, seq.step, { ...s, templates: inputs.templates }, bro, inputs.extra);
  if (m.missing.length) return stop(`Missing verified fact: ${m.missing.join(', ')}`, 'paused');
  const attachments = bro?.attachment?.contentBytes ? [bro.attachment] : undefined;
  const r = await deliver({ seq, emp, contact, recipients: [contact], m, attachments, s, ctx, label: `${camp.name}: ` });
  if (r.sent && !r.dryRun) await q(`UPDATE sequences SET priority = 0, hold_note = NULL WHERE id = $1`, [seq.id]);
  return r;
}

export async function clearSendBlock() {
  const b = await kvGet('send_blocked');
  if (b?.kind === 'restricted') await kvSet('cooldown_until', new Date(Date.now() + 7 * 864e5).toISOString());
  await kvSet('send_blocked', null);
}
