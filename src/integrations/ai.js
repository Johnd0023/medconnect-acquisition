// Optional AI checks (only when ANTHROPIC_API_KEY is set). Used for the cases rules can't settle:
// an employer whose type is unknown, and a reply the keyword rules couldn't categorize.
import { cfg } from '../config.js';
import { EMPLOYER_TYPES } from '../settings.js';

async function ask(system, user) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': cfg.anthropicApiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: cfg.anthropicModel, max_tokens: 300, system, messages: [{ role: 'user', content: user }] }),
  });
  if (!res.ok) throw new Error(`AI request failed: ${res.status}`);
  const json = await res.json();
  const text = json.content?.map((c) => c.text || '').join('') || '';
  const m = text.match(/\{[\s\S]*\}/);
  return m ? JSON.parse(m[0]) : null;
}

export async function classifyEmployer({ name, domain, industry, context }) {
  if (!cfg.anthropicApiKey) return null;
  const types = Object.values(EMPLOYER_TYPES).filter((t) => t !== EMPLOYER_TYPES.UNKNOWN);
  try {
    const r = await ask(
      `You classify US healthcare organizations for a provider-staffing firm's prospect list. Answer only with JSON: {"type": one of ${JSON.stringify(types)} or "Unknown", "confidence": 0-1, "reason": short}. A staffing, locum tenens, or recruiting company is "${EMPLOYER_TYPES.SA}". Do not guess: use "Unknown" when the name and context don't say.`,
      JSON.stringify({ name, domain, industry, context }),
    );
    if (!r || !types.includes(r.type) || !(r.confidence >= 0.7)) return null;
    return r;
  } catch { return null; }
}

export async function classifyReply({ subject, text }) {
  if (!cfg.anthropicApiKey) return null;
  const cats = ['interested', 'not_now', 'referral', 'wrong_contact', 'opt_out', 'ooo', 'other'];
  try {
    const r = await ask(
      `Categorize a reply to a staffing firm's cold email. Answer only with JSON: {"category": one of ${JSON.stringify(cats)}, "referralEmail": email address if they point to someone else, else null}.`,
      `Subject: ${subject}\n\n${(text || '').slice(0, 2000)}`,
    );
    return r && cats.includes(r.category) ? r : null;
  } catch { return null; }
}
