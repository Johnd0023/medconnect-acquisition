// HTTP server: owner login, dashboard, Microsoft sign-in callback, JSON API, health check.
import http from 'node:http';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { cfg, assertCoreConfig } from './config.js';
import { migrate, pool } from './db.js';
import { routes, httpError } from './api.js';
import { startScheduler } from './scheduler.js';
import * as outlook from './integrations/outlook.js';

assertCoreConfig();

// ---------- session (signed cookie, 12h) ----------
const COOKIE = 'mc_session';
const sign = (v) => crypto.createHmac('sha256', cfg.sessionSecret).update(v).digest('base64url');
function makeSession() { const exp = String(Date.now() + 12 * 3600 * 1000); return `${exp}.${sign(exp)}`; }
function validSession(req) {
  const c = Object.fromEntries((req.headers.cookie || '').split(';').map((p) => p.trim().split('=')).filter((p) => p.length === 2));
  const v = c[COOKIE]; if (!v) return false;
  const [exp, sig] = v.split('.');
  const good = sign(exp || '');
  return Boolean(sig) && sig.length === good.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good)) && Number(exp) > Date.now();
}
const secure = cfg.appUrl.startsWith('https');
const cookie = (v, maxAge) => `${COOKIE}=${v}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;

// crude login throttle
const attempts = new Map();
function throttled(ip) {
  const a = attempts.get(ip) || { n: 0, at: Date.now() };
  if (Date.now() - a.at > 15 * 60 * 1000) { a.n = 0; a.at = Date.now(); }
  return a.n >= 8;
}

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string';
  res.writeHead(status, { 'Content-Type': isJson ? 'application/json' : 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY', ...headers });
  res.end(isJson ? JSON.stringify(body) : body);
}
async function readBody(req, limit = 5 * 1024 * 1024) {
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > limit) throw httpError(413, 'Upload too large (5 MB max)'); chunks.push(c); }
  return Buffer.concat(chunks).toString('utf8');
}

const loginPage = (msg = '') => `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in · MedConnect</title>
<style>body{font:15px/1.5 system-ui,sans-serif;background:#eef2f4;color:#14212b;display:grid;place-items:center;min-height:100vh;margin:0}
form{background:#fff;border:1px solid #d9e0e5;border-radius:10px;padding:28px;display:flex;flex-direction:column;gap:12px;width:min(340px,90vw)}
h1{font-size:20px;margin:0}input{padding:9px;border:1px solid #d9e0e5;border-radius:6px;font:inherit}button{padding:9px;border:0;border-radius:6px;background:#1d5d8a;color:#fff;font:inherit;font-weight:600;cursor:pointer}
.err{color:#b0362d;font-size:14px}</style></head><body><form method="post" action="/login"><h1>MedConnect Client Acquisition</h1>
<label for="pw">Owner password</label><input id="pw" type="password" name="password" autofocus required>${msg ? `<div class="err">${msg}</div>` : ''}<button>Sign in</button></form></body></html>`;

// ---------- router ----------
const compiled = Object.entries(routes).map(([key, fn]) => {
  const [method, path] = key.split(' ');
  const names = [];
  const re = new RegExp('^' + path.replace(/:(\w+)/g, (_, n) => { names.push(n); return '([^/]+)'; }) + '$');
  return { method, re, names, fn };
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, cfg.appUrl);
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
  try {
    if (url.pathname === '/healthz') {
      await pool.query('SELECT 1');
      return send(res, 200, { ok: true });
    }
    if (url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
    if (url.pathname === '/login' && req.method === 'GET') return send(res, 200, loginPage());
    if (url.pathname === '/login' && req.method === 'POST') {
      if (throttled(ip)) return send(res, 429, loginPage('Too many attempts. Try again in 15 minutes.'));
      const pw = new URLSearchParams(await readBody(req, 10000)).get('password') || '';
      const a = Buffer.from(crypto.createHash('sha256').update(pw).digest()); const b = Buffer.from(crypto.createHash('sha256').update(cfg.adminPassword).digest());
      if (!crypto.timingSafeEqual(a, b)) {
        const t = attempts.get(ip) || { n: 0, at: Date.now() }; t.n++; attempts.set(ip, t);
        return send(res, 401, loginPage('That password is not right.'));
      }
      attempts.delete(ip);
      return send(res, 302, '', { Location: '/', 'Set-Cookie': cookie(makeSession(), 12 * 3600) });
    }
    if (url.pathname === '/logout') return send(res, 302, '', { Location: '/login', 'Set-Cookie': cookie('', 0) });

    if (!validSession(req)) {
      if (url.pathname.startsWith('/api/')) return send(res, 401, { error: 'Signed out. Reload the page and sign in.' });
      return send(res, 302, '', { Location: '/login' });
    }

    if (url.pathname === '/auth/microsoft/start') {
      if (!cfg.ms.clientId || !cfg.ms.clientSecret) return send(res, 400, '<p>Set MS_CLIENT_ID and MS_CLIENT_SECRET in Railway first. See README → "Connect Outlook".</p>');
      return send(res, 302, '', { Location: await outlook.authorizeUrl() });
    }
    if (url.pathname === '/auth/microsoft/callback') {
      try {
        const who = await outlook.handleCallback(Object.fromEntries(url.searchParams));
        return send(res, 302, '', { Location: `/#settings?connected=${encodeURIComponent(who.email)}` });
      } catch (e) {
        return send(res, 400, `<p style="font-family:system-ui">${e.message.replace(/</g, '&lt;')}</p><p><a href="/#settings">Back to Settings</a></p>`);
      }
    }

    if (url.pathname.startsWith('/api/')) {
      const route = compiled.find((r) => r.method === req.method && r.re.test(url.pathname));
      if (!route) return send(res, 404, { error: 'Not found' });
      if (req.method !== 'GET' && !(req.headers['content-type'] || '').includes('application/json')) return send(res, 415, { error: 'Send JSON' });
      const m = url.pathname.match(route.re);
      const params = Object.fromEntries(route.names.map((n, i) => [n, decodeURIComponent(m[i + 1])]));
      const raw = req.method === 'GET' ? '' : await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const result = await route.fn({ params, body, query: Object.fromEntries(url.searchParams), req });
      return send(res, 200, result ?? { ok: true });
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      return send(res, 200, await readFile(new URL('../public/index.html', import.meta.url), 'utf8'));
    }
    return send(res, 404, '<p>Not found</p>');
  } catch (e) {
    const status = e.status && e.status >= 400 && e.status < 600 ? e.status : 500;
    if (status === 500) console.error(e);
    if (url.pathname.startsWith('/api/')) return send(res, status, { error: e.message });
    return send(res, status, `<p>${String(e.message).replace(/</g, '&lt;')}</p>`);
  }
});

await migrate();
server.listen(cfg.port, () => {
  console.log(`MedConnect platform listening on ${cfg.appUrl} (port ${cfg.port})`);
  startScheduler();
});
