// In-browser PracticeMatch collector.
// PracticeMatch's firewall (Cloudflare) refuses requests from cloud servers, so the scan runs in the owner's own
// browser on practicematch.com, where they browse normally. The page reads today's postings (same pacing as the
// server scan) and sends parsed jobs to this platform's /ingest endpoints with a per-install token.
import { readFile } from 'node:fs/promises';
import crypto from 'node:crypto';
import { kvGet, kvSet } from './db.js';
import { cfg } from './config.js';

export async function ingestToken({ rotate = false } = {}) {
  let t = await kvGet('ingest_token');
  if (!t || rotate) { t = crypto.randomBytes(24).toString('base64url'); await kvSet('ingest_token', t); }
  return t;
}

export async function validToken(given) {
  const t = await kvGet('ingest_token');
  if (!t || !given || given.length !== t.length) return false;
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(t));
}

/** The one-line starter (bookmarklet / scheduled run). */
export function starter(token) {
  return `(()=>{window.__MC_API=${JSON.stringify(cfg.appUrl)};window.__MC_TOKEN=${JSON.stringify(token)};var s=document.createElement('script');s.src=${JSON.stringify(cfg.appUrl + '/pm-collector.js?v=')}+Date.now();document.body.appendChild(s)})()`;
}

let cached = null;
/** Builds the collector from the same parsing code the server uses (single source of truth). */
export async function collectorScript() {
  if (cached) return cached;
  const src = await readFile(new URL('./integrations/practicematch.js', import.meta.url), 'utf8');
  const a = src.indexOf('const RESTRICTION_RE');
  const b = src.indexOf('/** Map a parsed job to the row shape');
  let parse = src.slice(a, b).replace(/export function/g, 'function');
  const g0 = parse.indexOf('async function get(');
  const g1 = parse.indexOf('/** Job links on a results page');
  parse = parse.slice(0, g0) + parse.slice(g1);
  cached = `(async () => {
"use strict";
if (window.__mcCollector) { window.__mcCollector.show(); return; }
const API = window.__MC_API, TOKEN = window.__MC_TOKEN;
const BASE = location.origin;
${parse}
const box = document.createElement('div');
box.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;background:#0f1115;color:#fff;font:13px/1.45 Inter,system-ui,sans-serif;padding:14px 16px;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.35);max-width:340px;border:1px solid #1ab7ea';
document.body.appendChild(box);
const state = { phase: 'starting', listed: 0, fresh: 0, read: 0, sent: 0, skipped: 0, errors: 0, done: false, error: null };
const show = () => { box.innerHTML = '<b style="color:#1ab7ea">MedConnect</b> · PracticeMatch scan<br>' +
  (state.error ? '<span style="color:#f87171">' + state.error + '</span>' :
  state.phase + '<br>' + state.listed + ' postings today · ' + state.fresh + ' new<br>' + state.read + ' read · ' + state.sent + ' sent to MedConnect' + (state.skipped ? ' · ' + state.skipped + ' skipped' : '') + (state.done ? '<br><b>Done.</b> You can close this tab.' : '<br><span style="color:#9aa1ad">Keep this tab open.</span>')); };
window.__mcCollector = { state, show };
const api = async (path, body) => {
  const r = await fetch(API + '/ingest/practicematch/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ingest-Token': TOKEN }, body: JSON.stringify(body || {}) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || ('MedConnect ' + r.status));
  return j;
};
try {
  show();
  const conf = await api('start', {});
  if (!conf.enabled) throw new Error('The PracticeMatch scan is turned off in MedConnect Settings.');
  const links = new Map();
  for (const board of conf.boards) {
    let empty = 0;
    for (let page = 1; page <= conf.maxPagesPerBoard; page++) {
      state.phase = 'Reading ' + (board === 'physicians' ? 'physician' : 'advanced-practice') + ' results, page ' + page; show();
      const html = await (await fetch('/' + board + '/jobs/?jobAge=' + conf.jobAge + '&isFirm=' + (conf.inHouseOnly ? 0 : 'All') + '&page_id=' + page, { credentials: 'include' })).text();
      const found = parseResults(html).filter((l) => l.board === board);
      const before = links.size; for (const l of found) links.set(l.id, l);
      state.listed = links.size; show();
      empty = links.size === before ? empty + 1 : 0;
      if (!found.length || empty >= 2) break;
      await sleep(conf.delayMs);
    }
  }
  const { newIds } = await api('new', { ids: [...links.keys()] });
  state.fresh = newIds.length; show();
  let batch = [];
  const flush = async () => { if (!batch.length) return; const r = await api('jobs', { jobs: batch }); state.sent += r.added || batch.length; batch = []; show(); };
  for (const id of newIds) {
    const l = links.get(id);
    state.phase = 'Reading job ' + (state.read + 1) + ' of ' + newIds.length; show();
    try {
      const job = parseJob(await (await fetch(l.path, { credentials: 'include' })).text(), l);
      if (job.nonProvider && conf.providersOnly) state.skipped++;
      else if (job.employer) batch.push(job);
    } catch (e) { state.errors++; }
    state.read++;
    if (batch.length >= 10) await flush();
    await sleep(conf.delayMs);
  }
  await flush();
  state.phase = 'Finished'; state.done = true; show();
  await api('finish', { listed: state.listed, fresh: state.fresh, read: state.read, sent: state.sent, skipped: state.skipped, errors: state.errors });
} catch (e) {
  state.error = e.message; state.done = true; show();
  try { await api('finish', { error: e.message, ...state }); } catch {}
}
})();`;
  return cached;
}
