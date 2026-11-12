// Microsoft 365 / Outlook via Microsoft Graph, delegated OAuth (the owner signs in once).
// The refresh token is stored encrypted (AES-256-GCM) and rotated on every refresh.
import crypto from 'node:crypto';
import { cfg } from '../config.js';
import { q, one, kvGet, kvSet } from '../db.js';
import { encrypt, decrypt } from '../util.js';

const SCOPES = 'offline_access openid profile email User.Read Mail.Send Mail.ReadWrite';
const GRAPH = 'https://graph.microsoft.com/v1.0';
const authBase = () => `https://login.microsoftonline.com/${encodeURIComponent(cfg.ms.tenantId)}/oauth2/v2.0`;
export const redirectUri = () => `${cfg.appUrl}/auth/microsoft/callback`;

export class GraphError extends Error {
  constructor(status, code, message) { super(`Microsoft Graph ${status} ${code || ''}: ${message}`); this.status = status; this.code = code; }
}

export async function authorizeUrl() {
  const state = crypto.randomBytes(16).toString('hex');
  await kvSet('ms_oauth_state', { state, at: Date.now() });
  const p = new URLSearchParams({
    client_id: cfg.ms.clientId, response_type: 'code', redirect_uri: redirectUri(), response_mode: 'query',
    scope: SCOPES, state, prompt: 'select_account',
  });
  return `${authBase()}/authorize?${p}`;
}

async function tokenRequest(params) {
  const res = await fetch(`${authBase()}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: cfg.ms.clientId, client_secret: cfg.ms.clientSecret, scope: SCOPES, ...params }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new GraphError(res.status, json.error, json.error_description || 'token request failed');
  return json;
}

export async function handleCallback(query) {
  const saved = await kvGet('ms_oauth_state');
  if (!saved || saved.state !== query.state || Date.now() - saved.at > 15 * 60 * 1000) throw new Error('Sign-in link expired or did not match. Start the connection again from Settings.');
  if (query.error) throw new Error(`Microsoft sign-in failed: ${query.error_description || query.error}`);
  const tok = await tokenRequest({ grant_type: 'authorization_code', code: query.code, redirect_uri: redirectUri() });
  if (!tok.refresh_token) throw new Error('Microsoft did not return a refresh token. Make sure offline_access is granted.');
  const me = await fetch(`${GRAPH}/me?$select=mail,userPrincipalName,displayName`, { headers: { Authorization: `Bearer ${tok.access_token}` } }).then((r) => r.json());
  const email = me.mail || me.userPrincipalName;
  await storeTokens(tok, email);
  return { email, name: me.displayName };
}

async function storeTokens(tok, email) {
  await q(`INSERT INTO oauth_tokens (provider, account_email, refresh_token_enc, access_token_enc, expires_at, updated_at)
           VALUES ('microsoft', $1, $2, $3, now() + ($4 || ' seconds')::interval, now())
           ON CONFLICT (provider) DO UPDATE SET account_email = coalesce(EXCLUDED.account_email, oauth_tokens.account_email),
             refresh_token_enc = EXCLUDED.refresh_token_enc, access_token_enc = EXCLUDED.access_token_enc,
             expires_at = EXCLUDED.expires_at, updated_at = now()`,
  [email || null, encrypt(tok.refresh_token), encrypt(tok.access_token), String(Math.max(60, (tok.expires_in || 3600) - 120))]);
}

export async function connection() {
  const r = await one(`SELECT account_email, expires_at, updated_at FROM oauth_tokens WHERE provider = 'microsoft'`);
  return r ? { connected: true, email: r.account_email, since: r.updated_at } : { connected: false };
}

export async function disconnect() { await q(`DELETE FROM oauth_tokens WHERE provider = 'microsoft'`); }

async function accessToken() {
  const r = await one(`SELECT * FROM oauth_tokens WHERE provider = 'microsoft'`);
  if (!r) throw new GraphError(0, 'NotConnected', 'Outlook is not connected. Connect it in Settings → Integrations.');
  if (r.access_token_enc && new Date(r.expires_at) > new Date()) return decrypt(r.access_token_enc);
  const tok = await tokenRequest({ grant_type: 'refresh_token', refresh_token: decrypt(r.refresh_token_enc) });
  await storeTokens({ ...tok, refresh_token: tok.refresh_token || decrypt(r.refresh_token_enc) }, null);
  return tok.access_token;
}

async function graph(method, path, body) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const token = await accessToken();
    const res = await fetch(path.startsWith('http') ? path : GRAPH + path, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: 'outlook.body-content-type="text"' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429 || res.status === 503) {
      const wait = Number(res.headers.get('retry-after') || 5) * 1000;
      await new Promise((r) => setTimeout(r, Math.min(wait, 60000)));
      continue;
    }
    if (res.status === 401 && attempt === 0) { await q(`UPDATE oauth_tokens SET expires_at = now() WHERE provider='microsoft'`); continue; }
    if (res.status === 202 || res.status === 204) return {};
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new GraphError(res.status, json.error?.code, json.error?.message || res.statusText);
    return json;
  }
  throw new GraphError(429, 'Throttled', 'Microsoft Graph kept throttling the request');
}

const SELECT = 'id,conversationId,internetMessageId,subject';

/** Send a brand-new email. Returns ids needed to thread follow-ups and match replies. */
export async function sendNew({ to, toName, subject, body }) {
  const draft = await graph('POST', '/me/messages', {
    subject,
    body: { contentType: 'Text', content: body },
    toRecipients: [{ emailAddress: { address: to, name: toName || undefined } }],
  });
  await graph('POST', `/me/messages/${encodeURIComponent(draft.id)}/send`);
  return { graphId: draft.id, conversationId: draft.conversationId, internetMessageId: draft.internetMessageId };
}

/** Send a follow-up as a reply in the same thread as the earlier message (found by its Internet Message-ID). */
export async function sendFollowUp({ to, toName, previousInternetMessageId, body, fallbackSubject }) {
  let original = null;
  if (previousInternetMessageId) {
    const filter = encodeURIComponent(`internetMessageId eq '${previousInternetMessageId.replace(/'/g, "''")}'`);
    const found = await graph('GET', `/me/mailFolders/sentitems/messages?$filter=${filter}&$select=${SELECT},body,sentDateTime&$top=1`);
    original = found.value?.[0] || null;
  }
  if (!original) return sendNew({ to, toName, subject: fallbackSubject, body });
  const reply = await graph('POST', `/me/messages/${encodeURIComponent(original.id)}/createReply`, {});
  const sent = new Date(original.sentDateTime).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
  const quoted = (original.body?.content || '').split('\n').map((l) => `> ${l}`).join('\n');
  await graph('PATCH', `/me/messages/${encodeURIComponent(reply.id)}`, {
    toRecipients: [{ emailAddress: { address: to, name: toName || undefined } }],
    body: { contentType: 'Text', content: `${body}\n\nOn ${sent}, I wrote:\n${quoted}` },
  });
  await graph('POST', `/me/messages/${encodeURIComponent(reply.id)}/send`);
  return { graphId: reply.id, conversationId: reply.conversationId || original.conversationId, internetMessageId: reply.internetMessageId };
}

/** Inbox messages received since `since` (oldest first), following paging. */
export async function inboxSince(since) {
  const filter = encodeURIComponent(`receivedDateTime ge ${since.toISOString()}`);
  let url = `/me/mailFolders/inbox/messages?$filter=${filter}&$orderby=receivedDateTime asc&$top=50&$select=id,conversationId,subject,from,receivedDateTime,bodyPreview,body`;
  const out = [];
  for (let i = 0; url && i < 10; i++) {
    const page = await graph('GET', url);
    out.push(...(page.value || []));
    url = page['@odata.nextLink'] || null;
  }
  return out;
}

export async function whoAmI() {
  return graph('GET', '/me?$select=mail,userPrincipalName,displayName');
}
