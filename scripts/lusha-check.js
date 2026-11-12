// Runs one small prospecting search (no reveal, no email credits) and prints what Lusha returned,
// so field mapping can be confirmed against your account.  Usage: LUSHA_API_KEY=... DATABASE_URL=... npm run lusha:check
import { getSettings } from '../src/settings.js';
import * as lusha from '../src/integrations/lusha.js';
import { migrate, pool } from '../src/db.js';
await migrate();
const s = await getSettings();
try {
  const r = await lusha.prospectContacts({ ...s, lusha: { ...s.lusha, pageSize: 10 } }, 0);
  console.log('Top-level keys:', Object.keys(r.raw));
  console.log('Pagination:', r.pagination);
  console.log('First raw result:', JSON.stringify((r.raw.results || [])[0], null, 2));
  console.log('Normalized:', r.results.slice(0, 5));
  console.log('Credits used:', await lusha.creditsUsed());
} catch (e) {
  console.error(e.message, e.body ? JSON.stringify(e.body, null, 2) : '');
}
await pool.end();
