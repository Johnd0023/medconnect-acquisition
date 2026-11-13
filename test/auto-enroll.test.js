// Automated enrolling picks Ready employers at or above the threshold and skips "no agencies" postings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.SCHEDULER = 'off';
const { q, one, migrate } = await import('../src/db.js');
const { readyIds } = await import('../src/engine/outreach.js');
const { saveSettings, invalidateSettings } = await import('../src/settings.js');

test('ready list for auto/bulk enrolling', async () => {
  await migrate();
  await q('TRUNCATE employers, openings, contacts, sequences, messages RESTART IDENTITY CASCADE');
  const mk = async (name, score) => (await one(`INSERT INTO employers (name, norm_name, bucket, score) VALUES ($1, lower($1), 'ready', $2) RETURNING id`, [name, score])).id;
  const a = await mk('Alpha Health', 90); const b = await mk('Beta Clinic', 60); const c = await mk('St Joseph Healthcare', 80);
  await q(`INSERT INTO openings (employer_id, source, external_id, active, restriction) VALUES ($1,'PM','1',true,'NO AGENCY INQUIRIES, PLEASE')`, [c]);
  await q(`UPDATE settings SET data = '{}'::jsonb`); invalidateSettings();
  assert.deepEqual((await readyIds({ minScore: 70 })).map((r) => r.id), [a, c], 'default: 70+, no-agency postings included');
  await saveSettings({ respectNoAgency: true });
  assert.deepEqual((await readyIds({ minScore: 70 })).map((r) => r.id), [a], 'rule on: no-agency posting skipped');
  assert.deepEqual((await readyIds()).map((r) => r.id), [a, b]);
  await saveSettings({ respectNoAgency: false });
});
