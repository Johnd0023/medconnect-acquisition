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
| 06:00 and 18:00, Mon–Fri | **PracticeMatch scan** of today's in-house physician and APP postings |
| 06:00, Mon–Fri | **Discovery**: PracticeMatch scan → (optional) Lusha prospecting → Lusha contact lookup for employers with no contact → requalify everything → auto-enroll (only when supervised launch is off) | Lusha reveals per day (40), monthly credit budget (1,500), contacts per company (2) |
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

### PracticeMatch (primary source)
**Runs in your browser.** PracticeMatch's firewall (Cloudflare) refuses requests from cloud servers, so the scan runs on practicematch.com in your own browser: Settings → PracticeMatch scan → drag **"MedConnect: scan PracticeMatch"** to your bookmarks bar, open PracticeMatch, click it, and keep the tab open until the MedConnect box says Done. It sends jobs to `/ingest/practicematch/*` with a private token (Settings → Make a new link to replace it). Daily automatic runs can be scheduled in the Claude desktop app. `mode: 'server'` remains available if PracticeMatch allowlists the server or provides API access.

**Daily scan** at 06:00 and 18:00 ET (Settings → PracticeMatch scan):
1. Reads PracticeMatch's **in-house** job boards (agency postings excluded) for jobs **posted today**:
   - physician jobs: `/physicians/jobs/?jobAge=1&isFirm=0`
   - advanced-practice jobs: `/advanced-practitioners/jobs/?jobAge=1&isFirm=0`
2. Opens only job IDs it hasn't seen before and reads the job title, employer, location, specialty, role (Physician, NP, PA, CRNA, CNM), and the posting's **"Click to email"** address with its Opportunity code.
3. Skips non-provider roles (psychologist, therapist, RN, technologist…) and flags "no agencies" wording for review.
4. Pauses 1.5 s between requests. First scan of the day can take ~30 minutes; later scans read only new jobs.

**One prospect per contact.**
- **Direct recruiter emails** (most postings, e.g. `name@thedacare.org`) are one contact. All of that recruiter's jobs are grouped under one client, and they get **one** sequence: the first email plus two follow-ups.
- **PracticeMatch forwarding addresses** (`…@practicematch.com`) are shared by PracticeMatch staff across many clients. They count **once per client**, and the subject keeps `Opportunity <code>` so PracticeMatch routes it to the right posting.
- An opt-out or bounce from a forwarding address suppresses that client, not the shared address.

Used under MedConnect's written permission from PracticeMatch for business development. PracticeMatch's job pages otherwise say contact is for job seekers only, so keep that permission on file.

**Manual import** still works: Settings → Integrations → Import CSV.

### Lusha (API v3)
- `POST /v3/contacts/prospecting`: daily nationwide search by job title, industry and US location. Results are previews and cost no reveal credits.
- `POST /v3/contacts/decision-makers`: ranked decision-makers at a known employer domain, used when a listing has no contact.
- `POST /v3/companies/search`: finds the website domain for a listing that came without one. Only an exact-name match is accepted.
- `POST /v3/contacts/enrich`: reveals email and phone. **This is what spends credits.** It only runs for contacts at employers that already passed the protected-client, staffing-firm and suppression checks.
- Credits are taken from each response's `billing.creditsCharged` and counted per day and per month.
- If Lusha renames a field, run `npm run lusha:check` to print the raw response. All mapping lives in `normalizeContact()`.

---

## Several contacts at one client
When a client's postings list different recruiters (e.g. one for Family Medicine, another for Cardiology), every posting contact is ticked automatically (up to *Max contacts per client*). In the employer profile you can untick or add contacts. Settings → Sending limits → *When a client has several contacts*:
- **Separate** (default): each contact gets their own sequence about their own postings.
- **Together**: one email (and follow-ups) addressed to all of them.
- **Only the best contact**.

Any human reply from one contact stops follow-ups to all of them. An opt-out, bounce or "wrong person" only removes that person (from a shared email they're dropped and the others continue).

## Protected-client guardrail (system-wide)
Every email, from any source (PracticeMatch, Lusha, import, manual), is checked **immediately before sending** against a freshly loaded protected list. It also runs at enrollment and in the queue. An email is blocked if any of these match a protected account:
- the employer's name (exact, or the protected name inside a longer name: "Riverbend Health System - Columbus Campus") or website, including sibling domains (`commonspirit.org` also covers `commonspirit.careers`),
- the recipient's email domain,
- **every job posting behind the contact**: its hiring organization, website and posting contact. This is how PracticeMatch forwarding addresses (`…@practicematch.com`) are checked, by the client behind them.

A blocked email stops the sequence and writes "Email … BLOCKED: matches protected client" to the employer's history. Clients added to the list later are honored at the next send.

## Client Contacts (database and Excel export)

The **Client Contacts** page lists every contact the system has found or you added: name, title, email, phone, the client they're with (type, city, state, website), where you found them (PracticeMatch with the job post and code, Lusha, or added by you), outreach status (not contacted, in sequence, emailed, interested, replied, do not contact, current client) and your own notes. Search and filter by source, status and state, or show direct emails only (hiding PracticeMatch forwarding addresses).

**Export to Excel** downloads an .xlsx with two sheets, Contacts and Clients, using the current filters. **Add a contact** saves someone you met or a referral; a new client added this way is held, so the automation never emails them unless you tick the box.

## Brochure

Settings → Brochure: upload a PDF (up to 3 MB), then choose **Off**, **As a link** or **As an attachment**, and which emails carry it (first email, follow-up 1, follow-up 2). One sentence is added just above the sign-off, or wherever a template has `{{brochure}}`.

- Link: the uploaded file is served at a private, unguessable URL (`/b/<code>/<file name>`) that needs no login, so clients can open it. Or paste your own link (website, Google Drive). Uploading a new file changes the private URL.
- Attachment: the file goes with the email through Outlook. Hospital spam filters often hold attachments from unknown senders, so links are safer for first emails.
- The employer drawer preview shows the sentence and a 📎 line when a file will be attached.

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
