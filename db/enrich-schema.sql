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
--   LI_DSN="$LI_DATABASE_URL" node db/apply-schema.mjs --enrich-only
--
-- ORDER. db/schema.sql depends on this file: its dash.enrich_* views read
-- enrich.profile and enrich.advocate_company. So this file goes FIRST, and
-- db/apply-schema.mjs applies the two in that order inside one transaction.
-- Nothing here may depend on li or dash — schema.sql drops both.

-- The three roles the grants below name. schema.sql creates them too (with
-- grafana_ro and li_sync, which hold nothing here) in its ROLES section, but on a
-- fresh database this file runs before it, and a GRANT to a role that does not
-- exist yet would abort the whole apply. Same rule as there: no passwords, ever —
-- setting them is the operator's job.
do $$ begin
  if not exists (select 1 from pg_roles where rolname='li_owner')  then create role li_owner  nologin; end if;
  if not exists (select 1 from pg_roles where rolname='li_writer') then create role li_writer login; end if;
  if not exists (select 1 from pg_roles where rolname='li_backup') then create role li_backup login; end if;
end $$;

create schema if not exists enrich;
comment on schema enrich is
  'What opening a profile page told us. NO JSON oracle: this schema is the only copy, so schema.sql must never drop it.';

-- One row per person, replaced wholesale by a later, better read.
create table if not exists enrich.profile (
  person_key      text primary key,
  name            text,
  headline        text,
  location_raw    text,
  geo_bucket      text,                        -- US / TEAM / ANTI / OTHER, or NULL = unknown (fast/profile-parse.mjs)
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

-- Whose former employees count as advocates: our clients. A row is a
-- case-insensitive pattern matched with ~* against the COMPANY of a work_history
-- entry, so a part of the name finds the whole of it ('invented widgets' finds
-- "Invented Widgets Ltd"). Company names only: this table names no person. The
-- two checks keep one bad row from taking the panel down (a pattern that is not
-- a regular expression makes every query of the view fail) or from turning
-- everybody into an advocate (an empty one matches every company).
--
-- NO ROWS ARE SEEDED HERE, on purpose. This file is in a PUBLIC repository, and a
-- list of "clients of ours" is not ours alone to publish: a client can be under
-- an NDA, and what is committed once stays in the history for good. The list —
-- the evidence accounts of the ED ICP sheet — is DATA and goes where the rest of
-- the enrichment goes, into the database, by the owner's hand:
--
--   insert into enrich.advocate_company (pattern, note)
--   values ('<part of the company name, lower case>', 'ED ICP sheet, evidence account')
--   on conflict (pattern) do nothing;
--
-- The panel follows on the next query; nothing is re-applied. The rows survive
-- `apply-schema --force` (this schema is never dropped) and are in the weekly
-- dump (db/backup.sh). Until the first row is there, the Advocates panel says
-- "none found yet" — db/README.md, «ICP-панелі», has the whole procedure.
create table if not exists enrich.advocate_company (
  pattern text primary key,
  note    text,
  constraint pattern_not_empty check (btrim(pattern) <> ''),
  constraint pattern_is_a_regex check (('' ~* pattern) is not null)
);
comment on table enrich.advocate_company is
  'Clients whose people we look for in work_history (dash.enrich_advocates). pattern is a case-insensitive regular expression, in practice a substring of the company name. Filled by the owner, not by a file: the repository is public.';


-- ---------------------------------------------------------------- grants
-- Last in the file, so that re-applying it also covers a table added above.

-- The scraper: what it had before, nothing more. It does not read the client list.
grant usage on schema enrich to li_writer;
grant select, insert, update on enrich.profile to li_writer;
grant select, insert on enrich.visit to li_writer;
grant usage, select on sequence enrich.visit_visit_id_seq to li_writer;
grant select on enrich.today to li_writer;

-- The owner of the dash views. A view reads its tables with the rights of its
-- OWNER, and every dash view is handed to li_owner by schema.sql — so li_owner is
-- the role that must be able to read these three. SELECT only: nothing in dash
-- writes here.
grant usage on schema enrich to li_owner;
grant select on enrich.profile, enrich.visit, enrich.advocate_company to li_owner;

-- The backup: this schema is the ONLY copy of its data, so the weekly pg_dump
-- (db/backup.sh) must be able to read all of it — every table and view, and the
-- sequence, whose last_value pg_dump SELECTs. Read, never write.
grant usage on schema enrich to li_backup;
grant select on all tables    in schema enrich to li_backup;
grant select on all sequences in schema enrich to li_backup;
alter default privileges in schema enrich grant select on tables    to li_backup;
alter default privileges in schema enrich grant select on sequences to li_backup;

-- grafana_ro gets NOTHING here, on purpose: not USAGE, not SELECT. The dashboards
-- read schema dash only. The ICP panels go through the seven dash.enrich_* views
-- of db/schema.sql, which show counts and scores per bucket, plus — for the people
-- who worked at a client — the one matching line of their work history. Location,
-- the rest of the work history, the current company and the visit log stay on
-- this side of that line, and so does anything per person: the bucket and the
-- persona of each one are in li.enrich_person, which the reader cannot name.
-- li_sync, the CI role, gets nothing here either.
-- db/test-roles.mjs and db/test-enrich-views.mjs check it by logging in as the role.
