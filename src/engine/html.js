// Turns the plain-text email (as written in the templates) into simple, clean HTML:
// paragraphs, real bullet lists with bold lead-ins, short link text, and a quiet signature.
// Deliberately plain (no images, no layout tables) so it reads like a personal email and lands in the inbox.

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const FONT = "font-family:Aptos,Calibri,Arial,Helvetica,sans-serif;font-size:11pt;line-height:1.45;color:#1f2328";
const P = 'margin:0 0 14px 0';
const QUIET = 'color:#6b7280;font-size:9.5pt';
const BULLET_RE = /^\s*[-•*]\s+/;
const URL_RE = /\bhttps?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]/g;

function linkify(text, labels) {
  // [text](url) first, then bare URLs; links are kept as placeholders so they aren't escaped twice
  const links = [];
  const keep = (href, label) => { links.push(`<a href="${esc(href)}" style="color:#0b6bcb;text-decoration:underline">${esc(label)}</a>`); return `\u0000${links.length - 1}\u0000`; };
  let s = text.replace(/\[([^\]\n]{1,80})\]\((https?:\/\/[^\s)]+)\)/g, (_, label, href) => keep(href, label));
  s = s.replace(URL_RE, (u) => keep(u, labels[u] || u));
  return esc(s).replace(/\u0000(\d+)\u0000/g, (_, i) => links[Number(i)]);
}

function bulletItem(line, labels) {
  const text = line.replace(BULLET_RE, '');
  const m = text.match(/^(.{2,70}?)\s+[–—-]\s+(.+)$/); // "Lead-in – description" → bold lead-in
  return m ? `<li style="margin:0 0 6px 0"><strong>${linkify(m[1], labels)}</strong> – ${linkify(m[2], labels)}</li>` : `<li style="margin:0 0 6px 0">${linkify(text, labels)}</li>`;
}

/**
 * @param text   the final plain-text body (with signature and P.S.)
 * @param opts   { linkLabels: { [url]: 'short text' }, quietLines: ['address', ...] }
 */
export function toHtml(text, { linkLabels = {}, quietLines = [] } = {}) {
  const quiet = new Set(quietLines.filter(Boolean).map((l) => l.trim()));
  const out = [];
  for (const para of text.replace(/\r/g, '').split(/\n{2,}/)) {
    const lines = para.split('\n');
    let buf = []; let list = [];
    const flushP = () => {
      if (!buf.length) return;
      const html = buf.map((l) => (quiet.has(l.trim()) ? `<span style="${QUIET}">${linkify(l, linkLabels)}</span>` : linkify(l, linkLabels))).join('<br>');
      const allQuiet = buf.every((l) => quiet.has(l.trim()));
      out.push(`<p style="${P}${allQuiet ? `;${QUIET}` : ''}">${html}</p>`); buf = [];
    };
    const flushL = () => { if (!list.length) return; out.push(`<ul style="margin:0 0 14px 0;padding-left:22px">${list.map((l) => bulletItem(l, linkLabels)).join('')}</ul>`); list = []; };
    for (const l of lines) {
      if (BULLET_RE.test(l)) { flushP(); list.push(l); } else { flushL(); buf.push(l); }
    }
    flushP(); flushL();
  }
  return `<div style="${FONT}">${out.join('\n')}</div>`;
}

/** Body of an HTML document (what Outlook returns for a sent message), for quoting under a reply. */
export function innerBody(html) {
  const m = String(html || '').match(/<body[^>]*>([\s\S]*)<\/body>/i);
  return m ? m[1] : String(html || '');
}

export { esc as escapeHtml };
