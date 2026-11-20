// Poll the Outlook inbox, match replies to our sent emails, categorize them and apply stop rules.
import { q, one, logEvent, kvGet, kvSet } from '../db.js';
import { cfg } from '../config.js';
import * as outlook from '../integrations/outlook.js';
import { classifyReply } from '../integrations/ai.js';
import { stopSequence, stopSequenceById } from './outreach.js';
import { requalify } from './qualify.js';
import { isRelay } from '../util.js';

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

/** Microsoft refusing to send from YOUR mailbox (restricted sender, tenant block, quota): not the recipient's fault. */
export const SENDER_BLOCKED = /\b5\.1\.8\b|bad outbound sender|\b5\.7\.70[5-8]\b|restricted from sending|exceeded (your |the )?sending limit|submission quota|access denied,? (bad|banned) (outbound )?sender/i;

export function classify(subject = '', text = '') {
  const s = `${subject}\n${text}`.toLowerCase();
  if (/undeliverable|delivery has failed|couldn't be delivered|not delivered|delivery status notification|mail delivery/.test(s) && SENDER_BLOCKED.test(s)) return 'sender_blocked';
  if (/undeliverable|delivery has failed|delivery status notification|mail delivery (failed|subsystem)|couldn't be delivered|address not found|recipient address rejected/.test(s)) return 'bounce';
  if (/automatic reply|auto-?reply|out of (the )?office|on (annual |parental |medical )?leave|limited access to (my )?email|i am away|i'm away|currently away/.test(s)) return 'ooo';
  if (/unsubscribe|remove me|take me off|stop (emailing|contacting)|do not (email|contact)|opt(ed)? out|no further (emails|contact)/.test(s)) return 'opt_out';
  const pointsElsewhere = /(reach out to|contact|email|speak (with|to)|forward(ed)? (this|your (note|email)) to|best person (is|would be)|cc'?d|copying)/.test(s);
  const otherEmail = (text.match(EMAIL_RE) || []).length > 0;
  if (/not the (right|correct|best) (person|contact)|wrong person|no longer (with|at|work)|i don'?t handle|not (involved|responsible)|left the (company|organization)/.test(s)) {
    return pointsElsewhere && otherEmail ? 'referral' : 'wrong_contact';
  }
  if (pointsElsewhere && otherEmail) return 'referral';
  if (/not (interested|at this time|right now|currently)|no (need|thanks|thank you)|we('re| are) (all )?(set|covered|good)|filled|in-?house|don'?t use (agencies|outside)|maybe (later|next)/.test(s)) return 'not_now';
  if (/interested|send (over|me|us)|let'?s (talk|chat|connect)|(give me|set up|schedule|hop on) a call|available (on|this|next)|profiles|cvs?\b|resumes?|sounds good|tell me more|what are your (rates|fees|terms)|call me/.test(s)) return 'interested';
  return 'other';
}

export function referralFrom(text, ownDomainEmails = []) {
  const found = (text.match(EMAIL_RE) || []).map((e) => e.toLowerCase()).filter((e) => !ownDomainEmails.includes(e));
  return found[0] || null;
}

async function matchSentMessage(msg, fromEmail) {
  if (msg.conversationId) {
    const m = await one(`SELECT * FROM messages WHERE conversation_id = $1 AND status = 'sent' ORDER BY sent_at DESC LIMIT 1`, [msg.conversationId]);
    if (m) return m;
  }
  if (fromEmail && !isRelay(fromEmail)) {
    const m = await one(`SELECT * FROM messages WHERE $1 = ANY(string_to_array(lower(to_email), ', ')) AND status = 'sent' ORDER BY sent_at DESC LIMIT 1`, [fromEmail]);
    if (m) return m;
  }
  return null;
}

async function matchBounce(text) {
  for (const e of (text.match(EMAIL_RE) || []).map((x) => x.toLowerCase())) {
    const m = await one(`SELECT * FROM messages WHERE $1 = ANY(string_to_array(lower(to_email), ', ')) AND status = 'sent' AND sent_at > now() - interval '14 days' ORDER BY sent_at DESC LIMIT 1`, [e]);
    if (m) m._replier = e;
    if (m) return m;
  }
  return null;
}

/** Apply the effects of a categorized reply.
 *  Opt-out, bounce, wrong person: only that person's sequence stops. Any other human reply (interested,
 *  not now, referral…) stops every sequence at that client, so colleagues aren't followed up after someone answered. */
const MONTHS = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
/** When to resume after an out-of-office: 7 days later, or the day after a stated return date (up to 30 days). */
export function oooResumeAt(text = '', received = new Date()) {
  const week = new Date(received.getTime() + 7 * 864e5);
  const t = String(text).toLowerCase().split(/\n\s*(from:|-----original|on .+ wrote:)/)[0];
  const m = t.match(/(?:return(?:ing)?|back(?: in the office)?|until|through|returning to the office)\s+(?:on\s+)?(?:\w+day,?\s+)?(?:(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})|(\d{1,2})\/(\d{1,2}))/);
  if (!m) return week;
  const mon = m[1] ? MONTHS.indexOf(m[1]) : Number(m[3]) - 1, day = Number(m[2] || m[4]);
  if (mon < 0 || mon > 11 || !day || day > 31) return week;
  let back = new Date(Date.UTC(received.getUTCFullYear(), mon, day, 15));
  if (back < received - 864e5) back = new Date(Date.UTC(received.getUTCFullYear() + 1, mon, day, 15));
  const after = new Date(back.getTime() + 864e5);
  return after > week && after - received <= 30 * 864e5 ? after : week;
}

export async function applyReply(reply, message) {
  const empId = message.employer_id;
  const replier = (reply.from_email && await one(`SELECT * FROM contacts WHERE employer_id = $1 AND lower(email) = $2`, [empId, reply.from_email.toLowerCase()]))
    || (message._replier && await one(`SELECT * FROM contacts WHERE employer_id = $1 AND lower(email) = $2`, [empId, message._replier]))
    || await one('SELECT * FROM contacts WHERE id = $1', [message.contact_id]);
  if (replier && replier.id !== reply.contact_id) await q('UPDATE replies SET contact_id = $2 WHERE id = $1', [reply.id, replier.id]);
  const labels = { interested: 'Interested', not_now: 'Not right now', referral: 'Referral', wrong_contact: 'Wrong contact', opt_out: 'Opt-out', ooo: 'Out of office', bounce: 'Bounced', other: 'Reply' };
  await logEvent(empId, `${labels[reply.category]} reply from ${reply.from_email}`);
  const personal = ['opt_out', 'bounce', 'wrong_contact'].includes(reply.category);
  const seqId = message.sequence_id;
  if (reply.category === 'ooo') {
    // Hold the sequence and pick it back up automatically: 7 days out, or the day after they say they're back if later (max 30).
    const at = oooResumeAt(`${reply.subject || ''}\n${reply.body_preview || ''}`, reply.received_at ? new Date(reply.received_at) : new Date());
    const s = seqId && await one(`UPDATE sequences SET next_at = GREATEST(next_at, $2), status = 'active', stop_reason = NULL
                                  WHERE id = $1 AND status IN ('active','paused') RETURNING id`, [seqId, at]);
    if (s) await logEvent(empId, `Out of office: next email moved to ${at.toDateString()}`);
    await q('UPDATE replies SET handled = true WHERE id = $1', [reply.id]); // nothing for the owner to do
  } else if (personal) {
    // Remove just this person: their own sequence stops; in a shared email they're dropped from the recipients.
    const seq = seqId && await one('SELECT * FROM sequences WHERE id = $1', [seqId]);
    if (seq && replier && seq.contact_id !== replier.id && (seq.cc_contact_ids || []).includes(replier.id)) {
      await q('UPDATE sequences SET cc_contact_ids = array_remove(cc_contact_ids, $2) WHERE id = $1', [seq.id, replier.id]);
      await logEvent(empId, `${replier.email} removed from the shared sequence (${labels[reply.category]})`);
    } else if (seqId) {
      await stopSequenceById(seqId, reply.category === 'bounce' ? 'Email bounced' : `${labels[reply.category]} from ${reply.from_email}`);
    }
  } else {
    await q(`UPDATE sequences SET replied = true WHERE employer_id = $1 AND status IN ('active','paused')`, [empId]);
    await stopSequence(empId, `Prospect replied (${labels[reply.category]})`);
    // The same person may be in other sequences (another entity, the CommonSpirit campaign, CC'd on a shared email): end those too
    await stopEverywhereFor([reply.from_email, replier?.email, message._replier].filter(Boolean), `Replied (${labels[reply.category]}) on ${new Date(reply.received_at || Date.now()).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`);
  }
  const contact = replier;
  if (contact && (reply.category === 'opt_out' || reply.category === 'bounce')) {
    if (isRelay(contact.email)) {
      await q(`UPDATE employers SET decision = 'suppressed' WHERE id = $1`, [empId]);
      await logEvent(empId, `Client suppressed (${reply.category === 'bounce' ? 'bounce' : 'opt-out'} via PracticeMatch forwarding address)`);
      await stopSequence(empId, 'Opt-out via PracticeMatch forwarding address');
    } else {
      await optOutEmail(contact.email, {
        reason: reply.category === 'bounce' ? 'Bounced' : 'Opted out', source: 'reply', contactName: contact.full_name,
        employerId: empId, detail: String(reply.body_preview || reply.subject || '').split(/\n\s*(From:|-----Original|On .+ wrote:)/)[0].trim().slice(0, 300),
      });
      // They may have replied from a different address than the one we emailed: block that one too
      if (reply.category === 'opt_out' && reply.from_email && reply.from_email.toLowerCase() !== contact.email.toLowerCase() && !isRelay(reply.from_email)) {
        await optOutEmail(reply.from_email, { reason: 'Opted out', source: 'reply', contactName: contact.full_name, employerId: empId, detail: `Same person as ${contact.email}` });
      }
    }
    if (reply.category === 'opt_out') await q('UPDATE replies SET handled = true WHERE id = $1', [reply.id]); // nothing for the owner to do
  }
  if (contact && (reply.category === 'wrong_contact' || reply.category === 'bounce')) await q('UPDATE contacts SET bad = true WHERE id = $1', [contact.id]);
  if (reply.category === 'interested') {
    await q(`INSERT INTO tasks (employer_id, text, due_date) VALUES ($1, $2, (now() AT TIME ZONE $3)::date + 1)`, [empId, `Call ${contact?.full_name || reply.from_email}: replied interested`, cfg.timezone]);
  }
  await requalify(empId);
}

/**
 * Opt someone out everywhere: add them to the do-not-email list and end every running sequence that would
 * email them (at any client, as the main recipient or CC'd on a shared email). Used for replies and manual adds.
 */
export async function optOutEmail(email, { reason = 'Opted out', source = 'manual', contactName = null, employerId = null, detail = null } = {}) {
  const e = String(email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw Object.assign(new Error('Enter a valid email address.'), { status: 400 });
  const emp = employerId ? await one('SELECT name FROM employers WHERE id = $1', [employerId]) : null;
  const known = await one(`SELECT c.full_name, c.employer_id, em.name FROM contacts c JOIN employers em ON em.id = c.employer_id WHERE lower(c.email) = $1 ORDER BY c.id LIMIT 1`, [e]);
  await q(`INSERT INTO suppressions (kind, value, reason, source, contact_name, employer_id, employer_name, detail) VALUES ('email', $1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (kind, value) DO UPDATE SET reason = EXCLUDED.reason, source = coalesce(suppressions.source, EXCLUDED.source),
             contact_name = coalesce(suppressions.contact_name, EXCLUDED.contact_name), employer_id = coalesce(suppressions.employer_id, EXCLUDED.employer_id),
             employer_name = coalesce(suppressions.employer_name, EXCLUDED.employer_name), detail = coalesce(EXCLUDED.detail, suppressions.detail)`,
  [e, reason, source, contactName || known?.full_name || null, employerId || known?.employer_id || null, emp?.name || known?.name || null, detail]);
  const contacts = await q('SELECT id, employer_id FROM contacts WHERE lower(email) = $1', [e]);
  let stopped = 0;
  for (const c of contacts) {
    for (const s of await q(`SELECT id, contact_id FROM sequences WHERE status IN ('active','paused') AND (contact_id = $1 OR $1 = ANY(cc_contact_ids))`, [c.id])) {
      if (s.contact_id === c.id) { await stopSequenceById(s.id, `${reason}: ${e}`); stopped++; }
      else { await q('UPDATE sequences SET cc_contact_ids = array_remove(cc_contact_ids, $2) WHERE id = $1', [s.id, c.id]); stopped++; }
    }
    await logEvent(c.employer_id, `${e} added to the opt-out list (${reason.toLowerCase()})`);
    await requalify(c.employer_id).catch(() => null);
  }
  return { email: e, stopped };
}

/** End every running sequence that would email any of these addresses again (as the main recipient or CC'd). */
export async function stopEverywhereFor(emails, reason) {
  const list = [...new Set(emails.map((e) => String(e).toLowerCase()).filter((e) => e && !isRelay(e)))];
  if (!list.length) return 0;
  const rows = await q(`SELECT DISTINCT s.id FROM sequences s JOIN contacts c ON c.id = s.contact_id OR c.id = ANY(s.cc_contact_ids)
                        WHERE s.status IN ('active','paused') AND lower(c.email) = ANY($1)`, [list]);
  for (const r of rows) {
    await q('UPDATE sequences SET replied = true WHERE id = $1', [r.id]);
    await stopSequenceById(r.id, reason);
  }
  return rows.length;
}

export async function pollReplies() {
  const conn = await outlook.connection();
  if (!conn.connected) return { checked: 0, matched: 0, reason: 'Outlook not connected' };
  const cursor = await kvGet('reply_cursor');
  const since = cursor ? new Date(cursor) : new Date(Date.now() - 3 * 864e5);
  const inbox = await outlook.inboxSince(new Date(since.getTime() - 60000));
  let matched = 0; let latest = since;
  const own = (conn.email || '').toLowerCase();
  for (const msg of inbox) {
    const received = new Date(msg.receivedDateTime);
    if (received > latest) latest = received;
    if (await one('SELECT 1 FROM replies WHERE graph_id = $1', [msg.id])) continue;
    const fromEmail = (msg.from?.emailAddress?.address || '').toLowerCase();
    if (fromEmail === own) continue;
    const text = msg.body?.content || msg.bodyPreview || '';
    let category = classify(msg.subject, text);
    if (category === 'sender_blocked') { await handleSenderBlocked(msg, text); continue; }
    const message = category === 'bounce' ? await matchBounce(text) : await matchSentMessage(msg, fromEmail);
    if (!message) continue; // not related to our outreach
    if (category === 'other') { const ai = await classifyReply({ subject: msg.subject, text }); if (ai) category = ai.category; }
    const reply = await one(`INSERT INTO replies (employer_id, contact_id, message_id, graph_id, from_email, subject, body_preview, received_at, category)
                             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (graph_id) DO NOTHING RETURNING *`,
    [message.employer_id, message.contact_id, message.id, msg.id, fromEmail, msg.subject, (text || msg.bodyPreview || '').slice(0, 2000), received, category]);
    if (reply) { await applyReply(reply, message); matched++; }
  }
  await kvSet('reply_cursor', latest.toISOString());
  await kvSet('reply_polled_at', new Date().toISOString());
  await bounceGuard();
  return { checked: inbox.length, matched };
}

const RESTRICTED_MSG = 'Microsoft 365 restricted your mailbox from sending outside your organization (550 5.1.8). Nothing more will go out. Unblock it in Microsoft Defender (security.microsoft.com → Email & collaboration → Review → Restricted entities), then click "I fixed it, resume sending". Sending resumes at half your daily cap for 7 days.';

/** Microsoft blocked the mailbox: stop everything, and put the email that didn't go out back in line. */
async function handleSenderBlocked(msg, text) {
  await kvSet('send_blocked', { reason: RESTRICTED_MSG, at: new Date().toISOString(), kind: 'restricted' });
  await kvSet('cooldown_until', new Date(Date.now() + 7 * 864e5).toISOString());
  const m = await matchBounce(text);
  if (m) await requeueUndelivered(m, 'Not delivered: your mailbox was restricted by Microsoft');
  await q(`INSERT INTO replies (employer_id, contact_id, message_id, graph_id, from_email, subject, body_preview, received_at, category, handled)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'sender_blocked', true) ON CONFLICT (graph_id) DO NOTHING`,
  [m?.employer_id || null, m?.contact_id || null, m?.id || null, msg.id, (msg.from?.emailAddress?.address || '').toLowerCase(), msg.subject, String(text || '').slice(0, 2000), new Date(msg.receivedDateTime)]);
}

/** The email never reached them: mark it failed and send that step again later (no opt-out, no "bad contact"). */
async function requeueUndelivered(m, why) {
  await q(`UPDATE messages SET status = 'failed', error = $2 WHERE id = $1`, [m.id, why]);
  if (m.sequence_id) {
    await q(`UPDATE sequences SET status = 'active', step = $2, next_at = now() + interval '1 day', stop_reason = NULL, claimed_at = NULL,
             approved_step = CASE WHEN campaign_id IS NOT NULL THEN GREATEST(approved_step, $2) ELSE approved_step END
             WHERE id = $1 AND status IN ('active','stopped','completed','paused') AND NOT replied`, [m.sequence_id, m.step]);
  }
  if (m.employer_id) await logEvent(m.employer_id, `${why}. ${m.to_email} will get this email again once sending resumes.`);
}

/**
 * Repair: NDRs from a mailbox restriction that were filed as ordinary bounces before this check existed.
 * Takes those people off the opt-out list, un-marks them as bad, and puts their email back in line.
 */
export async function repairSenderBlockBounces() {
  const rows = await q(`SELECT r.*, m.id AS mid FROM replies r LEFT JOIN messages m ON m.id = r.message_id WHERE r.category = 'bounce'`);
  let fixed = 0;
  for (const r of rows) {
    if (!SENDER_BLOCKED.test(`${r.subject}\n${r.body_preview}`)) continue;
    const c = r.contact_id ? await one('SELECT * FROM contacts WHERE id = $1', [r.contact_id]) : null;
    if (c?.email) {
      await q(`DELETE FROM suppressions WHERE kind = 'email' AND lower(value) = lower($1) AND reason = 'Bounced'`, [c.email]);
      await q('UPDATE contacts SET bad = false WHERE lower(email) = lower($1)', [c.email]);
    }
    const m = r.mid ? await one('SELECT * FROM messages WHERE id = $1', [r.mid]) : null;
    if (m) await requeueUndelivered(m, 'Not delivered: your mailbox was restricted by Microsoft');
    await q(`UPDATE replies SET category = 'sender_blocked', handled = true WHERE id = $1`, [r.id]);
    if (r.employer_id) await requalify(r.employer_id);
    fixed++;
  }
  if (fixed) await kvSet('cooldown_until', new Date(Date.now() + 7 * 864e5).toISOString());
  return fixed;
}

/** Stop sending early when bounces spike (a big trigger for Microsoft's outbound filters). */
export async function bounceGuard() {
  const r = await one(`SELECT (SELECT count(*) FROM replies WHERE category = 'bounce' AND received_at > now() - interval '24 hours')::int AS bounces,
                              (SELECT count(*) FROM messages WHERE status = 'sent' AND sent_at > now() - interval '24 hours')::int AS sent`);
  if (r.bounces >= 3 && r.bounces / Math.max(r.sent, 1) > 0.05 && !(await kvGet('send_blocked'))) {
    await kvSet('send_blocked', { reason: `${r.bounces} of the last ${r.sent} emails bounced in 24 hours (over 5%). Microsoft treats high bounce rates as a sign of spam, so sending is paused. Check the Opt-outs → Bounced list for bad addresses, then resume.`, at: new Date().toISOString(), kind: 'bounces' });
    return true;
  }
  return false;
}
