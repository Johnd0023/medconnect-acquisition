// The MedConnect brochure: one uploaded file, sent as a link or an attachment on the emails chosen in Settings.
import crypto from 'node:crypto';
import { q, one } from './db.js';
import { cfg } from './config.js';

export const MAX_BYTES = 3 * 1024 * 1024; // Outlook's limit for a file sent with the message itself
export const DEFAULT_LINK_LINE = "Here's a quick overview of MedConnect: {{brochure_url}}";
export const DEFAULT_ATTACH_LINE = "I've attached a short overview of MedConnect for reference.";
const TYPES = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' };

export async function brochureMeta() {
  return one(`SELECT name, content_type, size, slug, uploaded_at FROM files WHERE kind = 'brochure'`);
}

export function publicUrl(meta) {
  return meta ? `${cfg.appUrl}/b/${meta.slug}/${encodeURIComponent(meta.name)}` : null;
}

export async function saveBrochure({ name, dataBase64 }) {
  const clean = String(name || '').split(/[\\/]/).pop().replace(/[^\w.\- ()&]+/g, '_').slice(0, 120);
  const ext = (clean.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
  if (!TYPES[ext]) throw Object.assign(new Error('Upload a PDF (or PNG, JPG, Word or PowerPoint file).'), { status: 400 });
  const data = String(dataBase64 || '').replace(/^data:[^,]*,/, '');
  const size = Buffer.from(data, 'base64').length;
  if (!size) throw Object.assign(new Error('That file is empty.'), { status: 400 });
  if (size > MAX_BYTES) throw Object.assign(new Error(`That file is ${(size / 1048576).toFixed(1)} MB. Keep the brochure under 3 MB (export the PDF with "reduce file size").`), { status: 400 });
  const slug = crypto.randomBytes(9).toString('base64url');
  await q(`INSERT INTO files (kind, name, content_type, size, slug, data, uploaded_at) VALUES ('brochure', $1, $2, $3, $4, $5, now())
           ON CONFLICT (kind) DO UPDATE SET name = EXCLUDED.name, content_type = EXCLUDED.content_type, size = EXCLUDED.size, slug = EXCLUDED.slug, data = EXCLUDED.data, uploaded_at = now()`,
  [clean, TYPES[ext], size, slug, data]);
  return brochureMeta();
}

export async function deleteBrochure() { await q(`DELETE FROM files WHERE kind = 'brochure'`); }

export async function brochureBySlug(slug) {
  return one(`SELECT name, content_type, data FROM files WHERE kind = 'brochure' AND slug = $1`, [slug]);
}

/**
 * What the email at `step` (0 = first email, 1-2 = follow-ups) should carry, or null.
 * { line, url?, attachment? } — attachment includes the file bytes unless lineOnly (for previews).
 */
export async function brochureFor(step, settings, { lineOnly = false } = {}) {
  const b = settings.brochure || {};
  if (!b.mode || b.mode === 'off' || !(b.steps || []).includes(step)) return null;
  const meta = await brochureMeta();
  if (b.mode === 'link') {
    const url = (b.url || '').trim() || publicUrl(meta);
    if (!url) return null;
    return { line: (b.linkLine || DEFAULT_LINK_LINE).replace(/\{\{\s*brochure_url\s*\}\}/g, url), url };
  }
  if (b.mode === 'attach') {
    if (!meta) return null;
    const attachment = { name: meta.name, contentType: meta.content_type };
    if (!lineOnly) attachment.contentBytes = (await one(`SELECT data FROM files WHERE kind = 'brochure'`)).data;
    return { line: b.attachLine || DEFAULT_ATTACH_LINE, attachment };
  }
  return null;
}
