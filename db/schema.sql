-- MedConnect Client Acquisition Platform — database schema
-- Idempotent: safe to run on every deploy (npm run migrate).

CREATE TABLE IF NOT EXISTS settings (
  id          int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  data        jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS kv (
  key         text PRIMARY KEY,
  value       jsonb,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS employers (
  id                  serial PRIMARY KEY,
  name                text NOT NULL,
  norm_name           text NOT NULL,
  domain              text,
  type                text NOT NULL DEFAULT 'Unknown',
  city                text,
  state               text,
  sources             text[] NOT NULL DEFAULT '{}',
  lusha_company_id    text,
  first_seen          timestamptz NOT NULL DEFAULT now(),
  last_signal         timestamptz NOT NULL DEFAULT now(),
  decision            text,              -- approved | held | suppressed | null
  selected_contact_id int,
  status              text NOT NULL DEFAULT 'new',   -- qualified | review | needs_contact | excluded | protected | suppressed
  bucket              text NOT NULL DEFAULT 'review', -- ready | review | contact | suppressed | outreach
  score               int,
  reasons             jsonb NOT NULL DEFAULT '[]'::jsonb,
  enrich_attempted_at timestamptz,
  notes               jsonb NOT NULL DEFAULT '[]'::jsonb
);
ALTER TABLE employers ADD COLUMN IF NOT EXISTS ai_checked boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS employers_domain_uq ON employers (domain) WHERE domain IS NOT NULL;
CREATE INDEX IF NOT EXISTS employers_norm_name_ix ON employers (norm_name);
CREATE INDEX IF NOT EXISTS employers_bucket_ix ON employers (bucket);

CREATE TABLE IF NOT EXISTS openings (
  id           serial PRIMARY KEY,
  employer_id  int NOT NULL REFERENCES employers(id) ON DELETE CASCADE,
  source       text NOT NULL DEFAULT 'PM',
  external_id  text NOT NULL,
  role         text,
  specialty    text,
  city         text,
  state        text,
  url          text,
  restriction  text,
  posted_at    timestamptz,
  first_seen   timestamptz NOT NULL DEFAULT now(),
  last_seen    timestamptz NOT NULL DEFAULT now(),
  active       boolean NOT NULL DEFAULT true,
  raw          jsonb,
  UNIQUE (source, external_id)
);
CREATE INDEX IF NOT EXISTS openings_employer_ix ON openings (employer_id);

CREATE TABLE IF NOT EXISTS contacts (
  id               serial PRIMARY KEY,
  employer_id      int NOT NULL REFERENCES employers(id) ON DELETE CASCADE,
  first_name       text,
  last_name        text,
  full_name        text,
  title            text,
  email            text,
  email_confidence text,
  phone            text,
  sources          text[] NOT NULL DEFAULT '{}',
  lusha_id         text,
  bad              boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS contacts_email_uq ON contacts (lower(email)) WHERE email IS NOT NULL;
CREATE INDEX IF NOT EXISTS contacts_employer_ix ON contacts (employer_id);

CREATE TABLE IF NOT EXISTS sequences (
  id              serial PRIMARY KEY,
  employer_id     int NOT NULL REFERENCES employers(id) ON DELETE CASCADE,
  contact_id      int NOT NULL REFERENCES contacts(id),
  step            int NOT NULL DEFAULT 0,
  next_at         timestamptz,
  status          text NOT NULL DEFAULT 'active', -- active | paused | stopped | completed
  stop_reason     text,
  replied         boolean NOT NULL DEFAULT false,
  started_at      timestamptz NOT NULL DEFAULT now(),
  conversation_id text,
  claimed_at      timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS sequences_one_open_per_employer ON sequences (employer_id) WHERE status IN ('active','paused');
CREATE UNIQUE INDEX IF NOT EXISTS sequences_one_active_per_contact ON sequences (contact_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS sequences_due_ix ON sequences (next_at) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS messages (
  id                  serial PRIMARY KEY,
  sequence_id         int REFERENCES sequences(id) ON DELETE SET NULL,
  employer_id         int NOT NULL REFERENCES employers(id) ON DELETE CASCADE,
  contact_id          int NOT NULL REFERENCES contacts(id),
  step                int NOT NULL,
  to_email            text NOT NULL,
  subject             text NOT NULL,
  body                text NOT NULL,
  status              text NOT NULL,       -- sent | dry_run | failed
  error               text,
  graph_id            text,
  internet_message_id text,
  conversation_id     text,
  sent_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS messages_sent_ix ON messages (sent_at);
CREATE INDEX IF NOT EXISTS messages_conv_ix ON messages (conversation_id);

CREATE TABLE IF NOT EXISTS replies (
  id            serial PRIMARY KEY,
  employer_id   int REFERENCES employers(id) ON DELETE CASCADE,
  contact_id    int REFERENCES contacts(id),
  message_id    int REFERENCES messages(id),
  graph_id      text UNIQUE,
  from_email    text,
  subject       text,
  body_preview  text,
  received_at   timestamptz NOT NULL,
  category      text NOT NULL,   -- interested | not_now | referral | wrong_contact | opt_out | ooo | bounce | other
  handled       boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS suppressions (
  id          serial PRIMARY KEY,
  kind        text NOT NULL,     -- email | domain
  value       text NOT NULL,
  reason      text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, value)
);

CREATE TABLE IF NOT EXISTS protected_accounts (
  id          serial PRIMARY KEY,
  name        text NOT NULL,
  norm_name   text NOT NULL,
  domain      text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS protected_norm_uq ON protected_accounts (norm_name);

CREATE TABLE IF NOT EXISTS tasks (
  id           serial PRIMARY KEY,
  employer_id  int REFERENCES employers(id) ON DELETE CASCADE,
  text         text NOT NULL,
  due_date     date,
  done         boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS meetings (
  id           serial PRIMARY KEY,
  employer_id  int REFERENCES employers(id) ON DELETE CASCADE,
  reply_id     int REFERENCES replies(id) ON DELETE SET NULL,
  booked_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS events (
  id           bigserial PRIMARY KEY,
  employer_id  int REFERENCES employers(id) ON DELETE CASCADE,
  at           timestamptz NOT NULL DEFAULT now(),
  text         text NOT NULL
);
CREATE INDEX IF NOT EXISTS events_employer_ix ON events (employer_id, at DESC);

CREATE TABLE IF NOT EXISTS job_runs (
  id           serial PRIMARY KEY,
  job          text NOT NULL,
  run_key      text NOT NULL,
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  status       text NOT NULL DEFAULT 'running',  -- running | ok | error
  summary      jsonb,
  UNIQUE (job, run_key)
);

CREATE TABLE IF NOT EXISTS lusha_usage (
  day       date PRIMARY KEY,
  credits   int NOT NULL DEFAULT 0,
  calls     int NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS oauth_tokens (
  provider           text PRIMARY KEY,
  account_email      text,
  refresh_token_enc  text NOT NULL,
  access_token_enc   text,
  expires_at         timestamptz,
  updated_at         timestamptz NOT NULL DEFAULT now()
);

INSERT INTO settings (id, data) VALUES (1, '{}'::jsonb) ON CONFLICT (id) DO NOTHING;
