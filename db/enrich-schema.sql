-- The enrichment schema: what we learned by OPENING a person's profile page.
--
-- Why it is not in `li`. db/schema.sql begins with `drop schema li cascade` and
-- rebuilds everything from the JSON corpus, which is safe precisely because the
-- database is a derived copy. Enrichment has no JSON oracle — the page view is
-- the only place it ever existed — so putting it in `li` would mean the next
-- `apply-schema --force` silently destroys weeks of collection. Its own schema
-- survives that, and the weekly pg_dump (db/backup.sh) covers it.
--
-- Why it is not in the repo. The repo is PUBLIC. Name and headline are already
-- there; location and work history are not, and publishing a few hundred
-- people's mini-CVs is a different act from counting reactions on our own posts
-- (operator decision, 2026-09-29: enrichment goes to the database only).
--
-- Apply (owner DSN), idempotent — it never drops anything:
--   LI_DSN="$LI_DATABASE_URL" node db/apply-enrich-schema.mjs

create schema if not exists enrich;
comment on schema enrich is
  'What opening a profile page told us. NO JSON oracle: this schema is the only copy, so schema.sql must never drop it.';

-- One row per person, replaced wholesale by a later, better read.
create table if not exists enrich.profile (
  person_key      text primary key,
  name            text,
  headline        text,
  location_raw    text,
  geo_bucket      text,                        -- US / TEAM / ANTI / OTHER, as fast/page/geo_classify.py
  current_title   text,
  current_company text,
  work_history    jsonb not null default '[]', -- [{company,title,dates}] — up to 5, newest first
  parse_status    text not null,               -- ok | partial | drift
  visited_at      timestamptz not null,
  visited_by      text not null,               -- which author's session opened it
  constraint geo_bucket_known check (geo_bucket in ('US', 'TEAM', 'ANTI', 'OTHER') or geo_bucket is null),
  constraint parse_status_known check (parse_status in ('ok', 'partial', 'drift'))
);
comment on table enrich.profile is
  'The current picture per person. Deliberately no About text, education, contacts, photo or raw page text — see the field list agreed on 2026-09-29.';
comment on column enrich.profile.parse_status is
  'partial = the page opened but a field was not found; drift = the page opened and NOTHING was found, which is the markup moving. A silent empty row must never read as "this person has no data".';

-- Every visit, including the ones that produced nothing. This is the audit
-- trail AND the rate limiter: the daily cap and the 90-day no-touch window are
-- both answered from here, so they cannot be lost with a local state file.
create table if not exists enrich.visit (
  visit_id     bigserial primary key,
  person_key   text not null,
  visited_at   timestamptz not null default now(),
  visited_by   text not null,
  outcome      text not null,                  -- ok | partial | drift | authwall | captcha | error | skipped
  note         text,                           -- shape of the failure, never page content
  constraint outcome_known check (outcome in ('ok', 'partial', 'drift', 'authwall', 'captcha', 'error', 'skipped'))
);
create index if not exists visit_by_day on enrich.visit (visited_by, visited_at desc);
create index if not exists visit_by_person on enrich.visit (person_key, visited_at desc);
comment on table enrich.visit is
  'One row per page we opened, successful or not. The daily budget and the 90-day rule are computed from this table, not from a file that can be deleted.';

-- How many pages has this account opened since local midnight, and who is due?
create or replace view enrich.today as
  select visited_by, count(*) as visits, max(visited_at) as last_visit
    from enrich.visit
   where visited_at >= date_trunc('day', now())
group by visited_by;

grant usage on schema enrich to li_writer;
grant select, insert, update on enrich.profile to li_writer;
grant select, insert on enrich.visit to li_writer;
grant usage, select on sequence enrich.visit_visit_id_seq to li_writer;
grant select on enrich.today to li_writer;

-- The dashboards read `dash` only, so nothing here is exposed to Grafana yet.
-- When the ICP panels land, they read a dash view built ON TOP of this — which
-- is also the moment to decide what a public-facing panel may show.
