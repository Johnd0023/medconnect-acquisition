// Sequences and the send worker: daily cap, warm-up ramp, send window, random spacing,
// one email per organization per day, and every stop condition checked right before each send.
import { q, one, logEvent, kvGet, kvSet } from '../db.js';
import { cfg } from '../config.js';
import { getSettings } from '../settings.js';
import { loadContext, requalify } from './qualify.js';
import { compose } from './compose.js';
import * as outlook from '../integrations/outlook.js';
import { zoned, hhmmToMin, startOfBusinessDay, addSendDays, atLocalTime, randInt } from '../util.js';

export async function enroll(employerId, { by = 'owner' } = {}) {
  const ctx = await loadContext();
  const r = await requalify(employerId, ctx);
  if (!r) throw new Error('Employer not found');
  if (r.bucket !== 'ready') throw new Error(`Not ready for outreach: ${r.reasons.join('; ') || r.status}`);
  const c = r.chosen;
  const busy = await one(`SELECT 1 FROM sequences WHERE contact_id = $1 AND status = 'active'`, [c.id]);
  if (busy) throw new Error(`${c.full_name} is already in another active sequence`);
  await q(`INSERT INTO sequences (employer_id, contact_id, step, next_at, status) VALUES ($1, $2, 0, now(), 'active')`, [employerId, c.id]);
  await q(`UPDATE employers SET decision = 'approved' WHERE id = $1`, [employerId]);
  await logEvent(employerId, `Enrolled in outreach (${by}) → ${c.full_name}${c.title ? `, ${c.title}` : ''}`);
  await requalify(employerId, ctx);
  return c;
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
  return { canSend: !reason, reason, cap, sent, inWindow, dryRun: cfg.dryRun, nextAllowed: nextAllowed ? new Date(nextAllowed) : null, settings: s };
}

async function claimNext(settings) {
  return one(`UPDATE sequences SET claimed_at = now() WHERE id = (
      SELECT s.id FROM sequences s
      WHERE s.status = 'active' AND s.next_at <= now()
        AND (s.claimed_at IS NULL OR s.claimed_at < now() - interval '10 minutes')
        AND (SELECT count(*) FROM messages m WHERE m.employer_id = s.employer_id AND m.sent_at >= $1) < $2
      ORDER BY s.step DESC, s.next_at ASC
      LIMIT 1 FOR UPDATE SKIP LOCKED)
    RETURNING *`, [startOfBusinessDay(), settings.perEmployerPerDay]);
}

/** Send at most one email if every limit allows it. Returns a short description of what happened. */
export async function sendTick({ force = false } = {}) {
  const st = await sendState();
  if (!st.canSend) return { sent: false, reason: st.reason };
  if (!force && st.nextAllowed && st.nextAllowed > new Date()) return { sent: false, reason: 'Waiting for spacing gap' };
  const s = st.settings;
  const seq = await claimNext(s);
  if (!seq) return { sent: false, reason: 'Nothing due' };

  const ctx = await loadContext();
  const r = await requalify(seq.employer_id, ctx);
  const emp = r.employer;
  if (['protected', 'excluded', 'suppressed'].includes(r.status)) { await stopSequence(emp.id, `Employer is now ${r.status}`); return { sent: false, reason: 'stopped' }; }
  const contact = r.contacts.find((c) => c.id === seq.contact_id);
  if (!contact || !contact.email || contact.bad || ctx.suppressedEmails.has(contact.email.toLowerCase())) {
    await stopSequence(emp.id, 'Contact opted out, bounced, or was marked wrong'); return { sent: false, reason: 'stopped' };
  }
  const m = compose(emp, contact, r.openings, seq.step, s);
  if (m.missing.length) { await stopSequence(emp.id, `Missing verified fact: ${m.missing.join(', ')}`, 'paused'); return { sent: false, reason: 'paused (missing fact)' }; }

  let result = {}; let status = 'sent'; let error = null;
  if (cfg.dryRun) {
    status = 'dry_run';
  } else {
    try {
      const prev = seq.step > 0 ? await one(`SELECT internet_message_id FROM messages WHERE sequence_id = $1 AND status = 'sent' ORDER BY sent_at DESC LIMIT 1`, [seq.id]) : null;
      result = seq.step === 0
        ? await outlook.sendNew({ to: contact.email, toName: contact.full_name, subject: m.subject, body: m.body })
        : await outlook.sendFollowUp({ to: contact.email, toName: contact.full_name, previousInternetMessageId: prev?.internet_message_id, body: m.body, fallbackSubject: m.subject });
    } catch (e) {
      error = e.message;
      if (e.status === 401 || e.status === 403 || e.code === 'NotConnected' || e.code === 'invalid_grant' || e.code === 'ErrorAccessDenied' || e.code === 'ErrorExceededMessageLimit' || e.code === 'ErrorSubmissionQuotaExceeded') {
        await kvSet('send_blocked', { reason: error, at: new Date().toISOString() });
        await q('UPDATE sequences SET claimed_at = NULL WHERE id = $1', [seq.id]);
        return { sent: false, reason: `Sending blocked: ${error}` };
      }
      status = 'failed';
    }
  }

  await q(`INSERT INTO messages (sequence_id, employer_id, contact_id, step, to_email, subject, body, status, error, graph_id, internet_message_id, conversation_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
  [seq.id, emp.id, contact.id, seq.step, contact.email, m.subject, m.body, status, error, result.graphId || null, result.internetMessageId || null, result.conversationId || null]);
  await kvSet('next_send_at', new Date(Date.now() + randInt(s.minGapSeconds, s.maxGapSeconds) * 1000).toISOString());

  const label = seq.step === 0 ? 'Initial email' : `Follow-up ${seq.step}`;
  if (status === 'failed') {
    await stopSequence(emp.id, `${label} failed to send: ${error}`);
    return { sent: false, reason: `failed: ${error}` };
  }
  if (status === 'dry_run') {
    await logEvent(emp.id, `${label} composed for ${contact.email} (dry run, not sent)`);
    await q(`UPDATE sequences SET status = 'paused', stop_reason = $2, claimed_at = NULL WHERE id = $1`, [seq.id, `Dry run: ${label.toLowerCase()} composed, not sent. Resume once live sending is on.`]);
    await requalify(emp.id, ctx);
    return { sent: true, dryRun: true, to: contact.email, subject: m.subject };
  }

  await logEvent(emp.id, `${label} sent to ${contact.email}`);
  const nextStep = seq.step + 1;
  if (nextStep >= 3) {
    await q(`UPDATE sequences SET step = $2, status = 'completed', stop_reason = 'Sequence finished with no reply', claimed_at = NULL, conversation_id = coalesce(conversation_id, $3) WHERE id = $1`, [seq.id, nextStep, result.conversationId || null]);
  } else {
    const gap = nextStep === 1 ? s.followupGap1Days : s.followupGap2Days;
    const nextDay = addSendDays(new Date(), gap, s.sendDays);
    await q(`UPDATE sequences SET step = $2, next_at = $3, claimed_at = NULL, conversation_id = coalesce(conversation_id, $4) WHERE id = $1`,
      [seq.id, nextStep, atLocalTime(nextDay, s.sendWindowStart), result.conversationId || null]);
  }
  await requalify(emp.id, ctx);
  return { sent: true, to: contact.email, subject: m.subject };
}

export async function clearSendBlock() { await kvSet('send_blocked', null); }
