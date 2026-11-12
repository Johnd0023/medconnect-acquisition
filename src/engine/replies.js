// Poll the Outlook inbox, match replies to our sent emails, categorize them and apply stop rules.
import { q, one, logEvent, kvGet, kvSet } from '../db.js';
import { cfg } from '../config.js';
import * as outlook from '../integrations/outlook.js';
import { classifyReply } from '../integrations/ai.js';
import { stopSequence, stopSequenceById } from './outreach.js';
import { requalify } from './qualify.js';
import { isRelay } from '../util.js';

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

export function classify(subject = '', text = '') {
  const s = `${subject}\n${text}`.toLowerCase();
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
    if (seqId) await stopSequenceById(seqId, 'Out-of-office reply. Resume from the Response Queue.', 'paused');
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
  }
  const contact = replier;
  if (contact && (reply.category === 'opt_out' || reply.category === 'bounce')) {
    if (isRelay(contact.email)) {
      await q(`UPDATE employers SET decision = 'suppressed' WHERE id = $1`, [empId]);
      await logEvent(empId, `Client suppressed (${reply.category === 'bounce' ? 'bounce' : 'opt-out'} via PracticeMatch forwarding address)`);
      await stopSequence(empId, 'Opt-out via PracticeMatch forwarding address');
    } else {
      await q(`INSERT INTO suppressions (kind, value, reason) VALUES ('email', $1, $2) ON CONFLICT DO NOTHING`, [contact.email.toLowerCase(), reply.category === 'bounce' ? 'Bounced' : 'Opted out']);
    }
  }
  if (contact && (reply.category === 'wrong_contact' || reply.category === 'bounce')) await q('UPDATE contacts SET bad = true WHERE id = $1', [contact.id]);
  if (reply.category === 'interested') {
    await q(`INSERT INTO tasks (employer_id, text, due_date) VALUES ($1, $2, (now() AT TIME ZONE $3)::date + 1)`, [empId, `Call ${contact?.full_name || reply.from_email}: replied interested`, cfg.timezone]);
  }
  await requalify(empId);
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
    const message = category === 'bounce' ? await matchBounce(text) : await matchSentMessage(msg, fromEmail);
    if (!message) continue; // not related to our outreach
    if (category === 'other') { const ai = await classifyReply({ subject: msg.subject, text }); if (ai) category = ai.category; }
    const reply = await one(`INSERT INTO replies (employer_id, contact_id, message_id, graph_id, from_email, subject, body_preview, received_at, category)
                             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (graph_id) DO NOTHING RETURNING *`,
    [message.employer_id, message.contact_id, message.id, msg.id, fromEmail, msg.subject, (text || msg.bodyPreview || '').slice(0, 2000), received, category]);
    if (reply) { await applyReply(reply, message); matched++; }
  }
  await kvSet('reply_cursor', latest.toISOString());
  return { checked: inbox.length, matched };
}
