// Lusha credit balance and monthly usage summary. WIPES lusha tables in the target database.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.SCHEDULER = 'off';
process.env.LUSHA_API_KEY = 'test-key';
let calls = 0;
globalThis.fetch = async (url) => {
  calls++;
  const u = new URL(url);
  if (u.pathname === '/v3/account/usage') return new Response(JSON.stringify({ credits: { total: 1000, used: 880, remaining: 120 } }), { status: 200 });
  return new Response('{}', { status: 404 });
};

const { q, migrate } = await import('../src/db.js');
const lusha = await import('../src/integrations/lusha.js');
const { routes } = await import('../src/api.js');

test('Lusha balance, daily usage and running-low advice', async () => {
  await migrate();
  await q('TRUNCATE lusha_usage, lusha_balance, kv');
  await q(`INSERT INTO lusha_usage (day, credits, calls) SELECT (now() AT TIME ZONE 'America/New_York')::date - g, 20, 5 FROM generate_series(0, 6) g`);
  const b = await lusha.accountBalance();
  assert.deepEqual([b.total, b.used, b.remaining], [1000, 880, 120]);
  const n = calls; await lusha.accountBalance();
  assert.equal(calls, n, 'cached: no second call to Lusha within 30 minutes');
  const p = await routes['GET /api/performance']({ query: {} });
  assert.equal(p.lusha.balance.remaining, 120);
  assert.equal(p.lusha.avg7, 20);
  assert.equal(p.lusha.runway, 6);
  assert.match(p.lusha.advice, /Running low: about 6 days left/);
  assert.ok(p.lusha.days.length >= 1 && p.lusha.today === 20);
});
