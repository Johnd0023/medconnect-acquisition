// In-process scheduler. Every 20 seconds it checks what is due in the business timezone.
// Each job run is claimed through a unique (job, run_key) row, so a restart or a second instance
// can never run the same daily job twice.
import { q, one } from './db.js';
import { cfg } from './config.js';
import { getSettings } from './settings.js';
import { zoned, hhmmToMin } from './util.js';
import { runDiscovery, runPracticeMatchScan } from './engine/discovery.js';
import { pollReplies } from './engine/replies.js';
import { sendTick } from './engine/outreach.js';
import { runHealthCheck } from './health.js';

const running = new Set();

/** Run `fn` once per `runKey`. Returns the summary, or null if that key already ran. */
export async function runJob(job, runKey, fn) {
  const claim = await one(`INSERT INTO job_runs (job, run_key) VALUES ($1, $2) ON CONFLICT (job, run_key) DO NOTHING RETURNING id`, [job, runKey]);
  if (!claim) return null;
  try {
    const summary = await fn();
    await q(`UPDATE job_runs SET finished_at = now(), status = 'ok', summary = $2::jsonb WHERE id = $1`, [claim.id, JSON.stringify(summary ?? {})]);
    return summary;
  } catch (e) {
    console.error(`[${job}] ${e.stack || e.message}`);
    await q(`UPDATE job_runs SET finished_at = now(), status = 'error', summary = $2::jsonb WHERE id = $1`, [claim.id, JSON.stringify({ error: e.message })]);
    throw e;
  }
}

async function guarded(name, fn) {
  if (running.has(name)) return;
  running.add(name);
  try { await fn(); } catch (e) { console.error(`[scheduler:${name}]`, e.message); } finally { running.delete(name); }
}

export async function tick(now = new Date()) {
  const s = await getSettings();
  const z = zoned(now);
  const minutes = z.hh * 60 + z.mm;

  if (s.discoveryDays.includes(z.dow) && minutes >= hhmmToMin(s.discoveryTime)) {
    await guarded('discovery', () => runJob('discovery', z.ymd, () => runDiscovery({ trigger: 'schedule' })));
  }

  // Extra PracticeMatch scans (the first scan time is covered by the morning discovery run)
  const P = s.practicematch || {};
  if (P.enabled && P.mode === 'server' && s.discoveryDays.includes(z.dow)) {
    for (const t of (P.scanTimes || []).slice(1)) {
      if (minutes >= hhmmToMin(t)) await guarded('pm-scan', () => runJob('pm-scan', `${z.ymd}#${t}`, () => runPracticeMatchScan({ autoEnroll: true })));
    }
  }

  if (minutes >= hhmmToMin(s.healthCheckTime || '07:00')) {
    await guarded('health', () => runJob('health', z.ymd, () => runHealthCheck().then((h) => ({ score: h.score, status: h.status }))));
  }

  const slot = Math.floor(minutes / Math.max(1, s.replyPollMinutes));
  await guarded('replies', () => runJob('replies', `${z.ymd}#${slot}`, () => pollReplies()));

  await guarded('send', async () => {
    const r = await sendTick();
    if (r.sent) console.log(`[send] ${r.dryRun ? 'DRY RUN ' : ''}${r.to}: ${r.subject}`);
  });
}

export function startScheduler() {
  if (!cfg.schedulerEnabled) { console.log('Scheduler is off (SCHEDULER=off).'); return; }
  console.log(`Scheduler on (${cfg.timezone}). Dry run: ${cfg.dryRun ? 'ON, nothing will be sent' : 'off, live sending'}.`);
  const loop = () => tick().catch((e) => console.error('[scheduler]', e.message));
  setTimeout(loop, 5000);
  setInterval(loop, 20000);
}
