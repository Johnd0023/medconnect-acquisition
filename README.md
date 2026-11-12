# MedConnect Client Acquisition Platform

A daily business-development system for MedConnect Staffing. It finds healthcare employers with provider openings (PracticeMatch) and decision-makers nationwide (Lusha), qualifies them, blocks current clients and competitors, sends a three-step outreach sequence from your Microsoft 365 mailbox, reads the replies, and reports results on one dashboard.

```
06:00 ET  Discovery ── PracticeMatch listings ─┐
                      Lusha prospecting ───────┼─► one record per employer ─► qualify ─► protect ─► review queue
                      Lusha contact lookup ────┘                                                     │
08:30–16:30 ET  Send window ─► warm-up cap ─► spacing ─► one email per org per day ─► Outlook ◄──────┘
every 10 min    Inbox check ─► match reply ─► categorize ─► stop sequence / suppress / create task
```

## What runs each day (all times in America/New_York, all editable in Settings)

| When | Job | Limits that apply |
|---|---|---|
| 06:00, Mon–Fri | **Discovery**: PracticeMatch monitor → Lusha prospecting → Lusha contact lookup for employers with no contact → requalify everything → auto-enroll (only when supervised launch is off) | Lusha reveals per day (40), monthly credit budget (1,500), contacts per company (2) |
| 08:30–16:30, Mon–Fri | **Sending**, one email at a time | Daily cap (40), warm-up ramp (10 on day 1, +5 per send day), random 90–240 s spacing, 1 email per organization per day |
| Every 10 min | **Inbox check**: replies, opt-outs, bounces, out-of-office | |

Follow-ups go out 3 and then 4 **send days** later, as replies in the same Outlook thread. Before every send, the platform rechecks the employer (protected? suppressed?), the contact (opted out? bounced?) and the template (every field filled from verified data?). If anything fails, the sequence stops or pauses instead of sending.

**Safety defaults:** `DRY_RUN=true` (composes and logs, never sends) and **supervised launch** on (nothing is enrolled without your approval). Sequences also stay paused until a company postal address is set, which CAN-SPAM requires in every commercial email.

---

## Setup (about 45 minutes)

### 1. Deploy on Railway

1. In Railway: **New Project → Deploy from GitHub repo** → pick this repo.
2. In the same project: **+ New → Database → PostgreSQL**.
3. On the app service: **Settings → Networking → Generate Domain**. Copy the URL, e.g. `https://medconnect-acquisition-production.up.railway.app`.
4. Generate secrets on any machine with Node: `npm run gen:secrets` (or ask Claude to generate them).
5. App service → **Variables** → add:

| Variable | Value |
|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
| `APP_URL` | the domain from step 3, no trailing slash |
| `ADMIN_PASSWORD` | your dashboard password |
| `SESSION_SECRET` | from gen:secrets |
| `ENCRYPTION_KEY` | from gen:secrets (encrypts the Outlook token at rest) |
| `LUSHA_API_KEY` | Lusha → Settings → API |
| `MS_TENANT_ID`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET` | from step 2 below |
| `DRY_RUN` | `true` for now |

Keep **one replica**. The scheduler is safe against double runs, but one instance is all this needs.

### 2. Register the app in Microsoft Entra (for Outlook)

Use a Microsoft 365 admin account.

1. Go to **entra.microsoft.com → Identity → Applications → App registrations → New registration**.
2. Name: `MedConnect Acquisition Platform`. Supported account types: **Accounts in this organizational directory only**.
3. Redirect URI: platform **Web**, value `APP_URL/auth/microsoft/callback` (the exact URL is shown in the dashboard under Settings → Integrations).
4. After it's created, copy **Application (client) ID** → `MS_CLIENT_ID`, and **Directory (tenant) ID** → `MS_TENANT_ID`.
5. **Certificates & secrets → New client secret**. Copy the **Value** → `MS_CLIENT_SECRET`. Put the expiry date in your calendar: when it expires, sending stops until you add a new one.
6. **API permissions → Add a permission → Microsoft Graph → Delegated**: `Mail.Send`, `Mail.ReadWrite`, `User.Read`, `offline_access`, `openid`, `profile`, `email`. Then **Grant admin consent**.
7. In the dashboard: **Settings → Integrations → Connect Outlook**, and sign in as the mailbox that should send (e.g. bizdev@medconnectstaffing.com). Then press **Send test email to myself**.

`Mail.ReadWrite` is needed to create the draft for threaded follow-ups and to read replies. The platform reads only the Inbox and Sent Items of that one mailbox.

### 3. First day checklist

1. **Settings → Protected accounts**: paste your current clients, one per line as `Name | domain`. Do this before anything else.
2. **Settings → Sender and compliance**: set the company postal address and the signature name.
3. **Settings → Integrations → Test Lusha connection**: runs a 10-result search and shows real prospects. It doesn't reveal any contacts, so no reveal credits are spent.
4. **Settings → Integrations → Import CSV or JSON**: load a PracticeMatch export (see below).
5. **Today → Run discovery now**.
6. Review the **Prospect Queue**. Approve or suppress, enroll a handful, and check the email previews in each employer's profile.
7. With `DRY_RUN=true`, enrolled sequences compose their first email, log it, and pause. Read those in **Outreach Activity → Sent log**.
8. When they look right: set `DRY_RUN=false` in Railway, then **Resume** the paused sequences. Real sending starts in the next send window, at the warm-up volume.
9. After a week or two of good results, turn **Supervised launch** off. Employers scoring at or above the auto-approve threshold (70) are then enrolled automatically; everything else still waits for review.

---

## Sources

### PracticeMatch
- **Working now: import.** Upload a CSV or JSON export on the Settings page, or `POST /api/import/practicematch`. Column names are matched flexibly: listing id, employer/facility, specialty, position, city/state or location, contact name/title/email/phone, date posted, link, description. Re-importing is safe: listings are keyed by id, and repeat openings at one employer are consolidated.
- Listings whose text says "no agencies", "direct applicants only" and similar are held for review automatically.
- **Next: the automated monitor.** `src/integrations/practicematch.js → fetchApprovedListings()` is the hook for the approved automated collection. It needs one walkthrough of your saved PracticeMatch searches to build. If you'd rather turn on the PracticeMatch API, the same hook takes that instead.

### Lusha (API v3)
- `POST /v3/contacts/prospecting`: daily nationwide search by job title, industry and US location. Results are previews and cost no reveal credits.
- `POST /v3/contacts/decision-makers`: ranked decision-makers at a known employer domain, used when a listing has no contact.
- `POST /v3/companies/search`: finds the website domain for a listing that came without one. Only an exact-name match is accepted.
- `POST /v3/contacts/enrich`: reveals email and phone. **This is what spends credits.** It only runs for contacts at employers that already passed the protected-client, staffing-firm and suppression checks.
- Credits are taken from each response's `billing.creditsCharged` and counted per day and per month.
- If Lusha renames a field, run `npm run lusha:check` to print the raw response. All mapping lives in `normalizeContact()`.

---

## Reply handling

| Category | What the platform does |
|---|---|
| Interested | Stops the sequence and creates a "call them" task for tomorrow |
| Referral | Stops the sequence. One click adds the referred person and enrolls them |
| Wrong contact | Stops, marks the contact as bad, and clears the employer to try another contact |
| Not now | Stops |
| Opt-out | Stops and adds the email to the suppression list permanently |
| Out of office | Pauses. One click resumes in 7 days |
| Bounce | Stops, marks the contact bad, and suppresses the address |

Categories come from keyword rules. If `ANTHROPIC_API_KEY` is set, replies the rules can't place, and employers whose type is unclear, get an AI check.

## Deliverability

Before going live, confirm SPF, DKIM and DMARC are set up for the sending domain in Microsoft 365. Then keep the warm-up on. If Microsoft blocks sending (an expired token, a revoked permission, a sending quota), the platform stops all sending and shows a red banner in Settings. Nothing more is attempted until you press "I fixed it, resume sending".

## Development

```
npm install
cp .env.example .env    # fill in, use a local Postgres
npm run migrate
npm start               # http://localhost:3000
npm test                # end-to-end test with Lusha and Graph mocked. WIPES the target database.
```

Code map: `src/engine/` (ingest, qualify, compose, outreach, replies, discovery), `src/integrations/` (lusha, outlook, practicematch, ai), `src/scheduler.js`, `src/api.js`, `public/index.html` (dashboard), `db/schema.sql`.
