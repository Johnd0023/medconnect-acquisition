// Environment configuration. Every secret lives in environment variables (Railway → Variables),
// never in the database or the browser.
const env = process.env;

function req(name) {
  const v = env[name];
  if (!v) throw new Error(`Missing required environment variable ${name}. See README → "Environment variables".`);
  return v;
}

export const cfg = {
  port: Number(env.PORT) || 3000,
  appUrl: (env.APP_URL || `http://localhost:${Number(env.PORT) || 3000}`).replace(/\/$/, ''),
  databaseUrl: env.DATABASE_URL,
  databaseSsl: env.DATABASE_SSL === 'true',
  adminPassword: env.ADMIN_PASSWORD,
  sessionSecret: env.SESSION_SECRET,
  encryptionKey: env.ENCRYPTION_KEY,              // 32 random bytes, base64 — encrypts the Outlook refresh token
  lushaApiKey: env.LUSHA_API_KEY,
  lushaBaseUrl: (env.LUSHA_BASE_URL || 'https://api.lusha.com').replace(/\/$/, ''),
  ms: {
    tenantId: env.MS_TENANT_ID || 'organizations',
    clientId: env.MS_CLIENT_ID,
    clientSecret: env.MS_CLIENT_SECRET,
  },
  anthropicApiKey: env.ANTHROPIC_API_KEY,          // optional: AI check for employers the rules can't classify
  anthropicModel: env.ANTHROPIC_MODEL || 'claude-haiku-5-5',
  // DRY_RUN=true composes and logs every email but never sends. Defaults to ON until you turn it off.
  dryRun: env.DRY_RUN !== 'false',
  schedulerEnabled: env.SCHEDULER !== 'off',
  timezone: env.TZ_BUSINESS || 'America/New_York',
};

export function assertCoreConfig() {
  req('DATABASE_URL');
  req('ADMIN_PASSWORD');
  req('SESSION_SECRET');
  req('ENCRYPTION_KEY');
  const key = Buffer.from(cfg.encryptionKey, 'base64');
  if (key.length !== 32) throw new Error('ENCRYPTION_KEY must be 32 bytes, base64-encoded. Generate one with: npm run gen:secrets');
}

export const integrations = () => ({
  lusha: Boolean(cfg.lushaApiKey),
  outlookApp: Boolean(cfg.ms.clientId && cfg.ms.clientSecret),
  ai: Boolean(cfg.anthropicApiKey),
});
