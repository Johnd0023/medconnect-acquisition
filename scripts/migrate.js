import { migrate, pool } from '../src/db.js';
await migrate();
console.log('Database schema is up to date.');
await pool.end();
