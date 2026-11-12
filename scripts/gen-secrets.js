import crypto from 'node:crypto';
console.log('Paste these into Railway → your service → Variables:\n');
console.log(`SESSION_SECRET=${crypto.randomBytes(32).toString('base64url')}`);
console.log(`ENCRYPTION_KEY=${crypto.randomBytes(32).toString('base64')}`);
console.log(`ADMIN_PASSWORD=${crypto.randomBytes(12).toString('base64url')}   # or choose your own (12+ characters)`);
