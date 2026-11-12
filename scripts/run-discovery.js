import { migrate, pool } from '../src/db.js';
import { runDiscovery } from '../src/engine/discovery.js';
await migrate();
console.log(JSON.stringify(await runDiscovery({ trigger: 'cli' }), null, 2));
await pool.end();
