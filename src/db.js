import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { cfg } from './config.js';

// Return Postgres count/bigint as JS numbers.
pg.types?.setTypeParser?.(20, (v) => Number(v));

export const pool = new pg.Pool({
  connectionString: cfg.databaseUrl,
  ssl: cfg.databaseSsl ? { rejectUnauthorized: false } : undefined,
  max: 6,
});

/** Run a query and return rows. Every statement in this app is a single statement (no session state). */
export async function q(text, params = []) {
  const res = await pool.query(text, params);
  return res.rows;
}
export async function one(text, params = []) {
  return (await q(text, params))[0] ?? null;
}

export async function migrate() {
  const sql = await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8');
  // Run statement by statement so it also works through simple drivers.
  for (const stmt of sql.split(/;\s*\n/).map((s) => s.trim()).filter((s) => s && !s.split('\n').every((l) => l.trim().startsWith('--') || !l.trim()))) {
    await pool.query(stmt);
  }
}

export async function logEvent(employerId, text) {
  await q('INSERT INTO events (employer_id, text) VALUES ($1, $2)', [employerId, text]);
}

export async function kvGet(key, fallback = null) {
  const r = await one('SELECT value FROM kv WHERE key = $1', [key]);
  return r ? r.value : fallback;
}
export async function kvSet(key, value) {
  await q(`INSERT INTO kv (key, value, updated_at) VALUES ($1, $2::jsonb, now())
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [key, JSON.stringify(value)]);
}
