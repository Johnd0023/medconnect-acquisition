// Endpoints the in-browser PracticeMatch collector reports to. Authenticated with the ingest token, CORS-limited
// to practicematch.com. No dashboard session is needed (the collector runs on practicematch.com).
import { q, one, kvGet, kvSet } from './db.js';
import { getSettings } from './settings.js';
import { validToken } from './collector.js';
import { toRow } from './integrations/practicematch.js';
import { importListings } from './engine/discovery.js';
import { requalifyAll } from './engine/qualify.js';
import { enroll } from './engine/outreach.js';

export const ALLOWED_ORIGINS = ['https://www.practicematch.com', 'https://practicematch.com'];

const str = (v, n = 500) => (typeof v === 'string' ? v.slice(0, n) : '');

export async function handleIngest(path, body, token) {
  if (!(await validToken(token))) { const e = new Error('Invalid or missing ingest token. Copy a fresh scan link from MedConnect Settings.'); e.status = 401; throw e; }
  const s = await getSettings();
  const P = s.practicematch || {};
  if (path === 'start') {
    const firstRun = !(await q(`SELECT 1 FROM openings WHERE source = 'PM' AND raw ? 'pmCode' LIMIT 1`)).length;
    const run = await one(`INSERT INTO job_runs (job, run_key, summary) VALUES ('pm-scan', $1, '{"mode":"browser"}'::jsonb) RETURNING id`, [`browser-${Date.now()}`]);
    await kvSet('pm_browser_run', { id: run.id, listings: 0, newEmployers: 0, newOpenings: 0, newContacts: 0, merged: 0 });
    return { enabled: P.enabled !== false, boards: P.boards || ['physicians', 'advanced-practitioners'], jobAge: firstRun ? (P.firstRunJobAge || 1) : (P.jobAge || 1),
      inHouseOnly: P.inHouseOnly !== false, maxPagesPerBoard: P.maxPagesPerBoard || 60, delayMs: Math.max(800, P.delayMs || 1500), providersOnly: P.providersOnly === true };
  }
  if (path === 'new') {
    const ids = (Array.isArray(body.ids) ? body.ids : []).map(String).filter((x) => /^\d{1,12}$/.test(x)).slice(0, 5000);
    const seen = new Set((await q(`SELECT external_id FROM openings WHERE source = 'PM' AND external_id = ANY($1::text[])`, [ids])).map((r) => r.external_id));
    if (seen.size) await q(`UPDATE openings SET last_seen = now(), active = true WHERE source = 'PM' AND external_id = ANY($1::text[])`, [[...seen]]);
    return { newIds: ids.filter((id) => !seen.has(id)).slice(0, P.maxDetailsPerRun || 1500) };
  }
  if (path === 'jobs') {
    const jobs = (Array.isArray(body.jobs) ? body.jobs : []).slice(0, 50).map((j) => ({
      listingId: str(j.listingId, 20), board: str(j.board, 40), url: str(j.url, 500), title: str(j.title, 300), datePosted: str(j.datePosted, 30),
      employer: str(j.employer, 200), website: str(j.website, 300), city: str(j.city, 100), state: str(j.state, 50), code: str(j.code, 80),
      description: str(j.description, 4000), contactEmail: str(j.contactEmail, 200).toLowerCase(), emailSubject: str(j.emailSubject, 300),
      relay: /@practicematch\.com$/i.test(j.contactEmail || ''), specialty: str(j.specialty, 100), role: str(j.role, 60),
      restriction: j.restriction ? str(j.restriction, 300) : null, contactName: str(j.contactName, 100),
    })).filter((j) => /^\d+$/.test(j.listingId) && j.employer);
    const r = jobs.length ? await importListings(jobs.map(toRow), 'browser') : { listings: 0 };
    const acc = (await kvGet('pm_browser_run')) || {};
    for (const k of ['listings', 'newEmployers', 'newOpenings', 'newContacts', 'merged']) acc[k] = (acc[k] || 0) + (r[k] || 0);
    await kvSet('pm_browser_run', acc);
    if (acc.id) await q(`UPDATE job_runs SET summary = $2::jsonb WHERE id = $1`, [acc.id, JSON.stringify({ ...acc, mode: 'browser' })]);
    return { added: r.listings || 0 };
  }
  if (path === 'finish') {
    const acc = (await kvGet('pm_browser_run')) || {};
    await requalifyAll();
    let enrolled = 0;
    if (!s.supervised && s.autoEnroll && !s.paused) for (const { id } of await q(`SELECT id FROM employers WHERE bucket = 'ready'`)) { try { await enroll(id, { by: 'auto' }); enrolled++; } catch { /* skip */ } }
    const summary = { ...acc, mode: 'browser', enrolled, log: [`Browser scan: ${body.listed || 0} postings, ${body.fresh || 0} new, ${body.read || 0} read, ${body.sent || 0} added${body.skipped ? `, ${body.skipped} skipped` : ''}${body.errors ? `, ${body.errors} errors` : ''}`] };
    if (acc.id) await q(`UPDATE job_runs SET finished_at = now(), status = $2, summary = $3::jsonb WHERE id = $1`, [acc.id, body.error ? 'error' : 'ok', JSON.stringify(body.error ? { ...summary, error: str(body.error) } : summary)]);
    return { ok: true };
  }
  const e = new Error('Not found'); e.status = 404; throw e;
}
