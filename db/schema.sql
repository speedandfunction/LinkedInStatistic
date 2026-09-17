-- LinkedInStatistic — the database layer.
--
-- Today the corpus lives as JSON in a PUBLIC repo: 720 named person files,
-- verbatim comment texts, and weekly account snapshots that LinkedIn will never
-- hand back (it only ever exposes *current* values). This schema is where that
-- moves, so the public repo can stop being the store of record.
--
-- Two schemas, one direction of travel:
--
--   li    facts. What the scraper saw, when it saw it. Nothing derived.
--   dash  the read surface. Grafana is granted SELECT on THIS ONLY, and every
--         view here hides a week until it has been explicitly published.
--
-- Conventions that are not negotiable:
--
--   * An ISO week is a `date` — the Monday. Never a string. "2026-9-7" and
--     "2026-09-07" are the same week and the type says so.
--   * Percentages and rates are `numeric`, never `double precision`. The corpus
--     contains 0.41 and 50.0; float8 renders the first as 0.41000000000000003
--     and makes a parity diff unreadable.
--   * Facts are INSERT-ONLY wherever they can be. The writer role is granted
--     INSERT and SELECT and nothing else — see the ROLES section at the bottom
--     for the two exceptions and how they are fenced.
--   * Every fact carries `run_id`, so "which scrape put this here" is answerable
--     without a git blame.
--
-- Apply with:
--   docker exec -i li-pg psql -U postgres -d linkedin -v ON_ERROR_STOP=1 < db/schema.sql

\set ON_ERROR_STOP on

drop schema if exists dash cascade;
drop schema if exists li cascade;

create schema li;
create schema dash;

comment on schema li   is 'Facts as scraped. Insert-only where possible. Never exposed to Grafana.';
comment on schema dash is 'Published read surface. The only schema Grafana may SELECT from.';


-- ===========================================================================
-- runs and authors
-- ===========================================================================

create table li.import_run (
  run_id      uuid primary key,
  started_at  timestamptz not null default now(),
  source      text        not null,          -- 'json-import' | 'scrape' | ...
  note        text
);
comment on table li.import_run is
  'One row per write session. Every fact row points back here.';

create table li.author (
  author        text primary key,            -- 'peter' | 'andy' | 'maria'
  display_name  text not null,
  profile_slug  text not null,               -- 'in/ovchyn'
  company_id    text,
  posts_cutoff  date
);
comment on table li.author is
  'Mirrors .claude/skills/linkedin-stats/profiles.json. Adding a person is a row here.';


-- ===========================================================================
-- the publication gate
-- ===========================================================================
--
-- A scrape week is invisible to Grafana until someone publishes it. The
-- partial unique index is the whole enforcement: any number of pending,
-- rejected or superseded rows may exist for an (author, week); exactly one
-- may be `published`.

create table li.week_publication (
  publication_id bigint generated always as identity primary key,
  author         text        not null references li.author(author),
  week           date        not null,
  run_id         uuid        not null references li.import_run(run_id),
  status         text        not null check (status in ('pending','published','rejected','superseded')),
  decided_at     timestamptz not null default now(),
  decided_by     text,
  note           text
);

create unique index week_publication_one_published
  on li.week_publication (author, week)
  where status = 'published';

create index week_publication_lookup on li.week_publication (author, week, status);

comment on index li.week_publication_one_published is
  'At most one published row per (author, week). A second publish is rejected by the database, not by application code.';

-- The gate, as a relation. Every dash view joins this and nothing else.
create view dash.published_week as
  select author, week, run_id, decided_at
    from li.week_publication
   where status = 'published';


-- ===========================================================================
-- config — what the build scripts read off disk today
-- ===========================================================================
--
-- scoring.json and vip-people.md are deliberately build-time knobs: "retuning a
-- weight rescores the entire history on the next build, with no re-scrape".
-- They live here so the dash views can carry the same property without the
-- views having to read the filesystem.

create table li.scoring_weight (
  tier   text not null check (tier in ('normal','icp','vip')),
  kind   text not null check (kind in ('reaction','comment')),
  points numeric not null,
  run_id uuid references li.import_run(run_id),   -- which run last asserted it
  primary key (tier, kind)
);

create table li.scoring_config (
  only_row   boolean primary key default true check (only_row),
  precedence text not null default 'max' check (precedence in ('max','priority')),
  run_id     uuid references li.import_run(run_id)
);

create table li.vip_person (
  person_key text primary key,               -- 'in/<slug>', lowercased
  note       text,
  run_id     uuid references li.import_run(run_id)
);
comment on table li.vip_person is
  'REPLACED wholesale from vip-people.md on every import, not appended to: removing a bullet from that file has to lower the score it was inflating.';

-- The clock, pinned. build-stats-json.mjs consults the wall clock in exactly
-- two places (the month-range tail of the zero-fill, and "which week is
-- `last_week`"). Views cannot take parameters, so the pinned value lives here:
-- NULL means "use now()", a value means "pretend it is this instant". verify.mjs
-- sets it, so the DB export and the JSON build are compared at the same instant.
create table li.dash_config (
  only_row boolean primary key default true check (only_row),
  as_of    timestamptz
);
insert into li.dash_config (only_row, as_of) values (true, null);

create function li.as_of() returns timestamptz
  language sql stable as $$
    select coalesce((select as_of from li.dash_config), now())
  $$;

-- The Monday of the ISO week containing li.as_of(), in UTC — the reader's
-- `currentWeekMonday`.
create function li.current_week_monday() returns date
  language sql stable as $$
    select (date_trunc('week', (li.as_of() at time zone 'UTC')))::date
  $$;

-- The reader's `currentMonthUTC()`, as a first-of-month date.
create function li.current_month() returns date
  language sql stable as $$
    select (date_trunc('month', (li.as_of() at time zone 'UTC')))::date
  $$;

-- JS Math.round: half away from zero is Postgres' round(); JS rounds half UP
-- (Math.round(-0.5) === -0). floor(x + 0.5) is Math.round exactly.
create function li.js_round(v numeric) returns numeric
  language sql immutable as $$ select floor(v + 0.5) $$;

create function li.js_round(v double precision) returns double precision
  language sql immutable as $$ select floor(v + 0.5) $$;


-- ===========================================================================
-- posts
-- ===========================================================================

create table li.post (
  author       text not null references li.author(author),
  post_id      text not null,                -- d.id, the numeric activity id
  urn          text not null,
  type         text not null,                -- 'post' | 'repost'
  posted_at    timestamptz not null,
  posted_date  date not null,
  post_url     text,
  preview      text,
  body_text    text,                         -- d.text; null until a scrape captured it
  source_file  text not null,                -- posts/<name>.json — the READ ORDER
  run_id       uuid not null references li.import_run(run_id),
  primary key (author, post_id)
);
comment on column li.post.source_file is
  'build-stats-json.mjs iterates readdirSync(POSTS_DIR).sort(), so the filename IS the output order. Losing it reorders the posts array.';

create index post_by_file on li.post (author, source_file);

create table li.post_week (
  author            text not null,
  post_id           text not null,
  week              date not null,
  ord               integer not null,        -- position of this week key in the file
  snapshot_at       timestamptz,
  has_metrics       boolean not null,        -- false = a people-phase-only entry
  impressions       bigint,
  members_reached   bigint,
  reactions         bigint,
  comments          bigint,
  reposts           bigint,
  saves             bigint,
  sends             bigint,
  profile_viewers   bigint,
  followers_gained  bigint,
  engagement_rate   numeric,
  run_id            uuid not null references li.import_run(run_id),
  primary key (author, post_id, week),
  foreign key (author, post_id) references li.post(author, post_id)
);
comment on column li.post_week.ord is
  'Week keys are appended by merge.py in encounter order, not sorted. Object.entries() hands the reader that order; ord preserves it.';
comment on column li.post_week.has_metrics is
  'merge_week_people() creates {snapshot_at, people_only:true} entries with no metrics. Consumers key on the ABSENCE of `metrics`.';

create table li.post_week_demographic (
  author     text not null,
  post_id    text not null,
  week       date not null,
  dimension  text not null,                  -- job_title | location | seniority | company | company_size | industry
  label      text not null,
  pct        numeric not null,
  dim_ord    integer not null,
  label_ord  integer not null,
  primary key (author, post_id, week, dimension, label),
  foreign key (author, post_id, week) references li.post_week(author, post_id, week)
);

create table li.post_week_comment (
  author           text not null,
  post_id          text not null,
  week             date not null,
  comment_urn      text not null,
  ord              integer not null,
  author_name      text,
  author_headline  text,
  author_url       text,
  body_text        text,
  reactions        bigint,
  replies_count    bigint,
  primary key (author, post_id, week, comment_urn),
  foreign key (author, post_id, week) references li.post_week(author, post_id, week)
);
comment on table li.post_week_comment is
  'Inbound comments ON the author''s posts, as captured in that week''s snapshot. Verbatim text — the reason this corpus should not be in a public repo.';

create table li.post_week_person (
  author      text not null,
  post_id     text not null,
  week        date not null,
  side        text not null check (side in ('reactor','commenter')),
  profile_url text not null,
  primary key (author, post_id, week, side, profile_url),
  foreign key (author, post_id, week) references li.post_week(author, post_id, week)
);
comment on table li.post_week_person is
  'The weekly roster. NULL (no rows AND the roster flag off) means NOT MEASURED; an empty roster with the flag on means measured-and-nobody. See li.post_week_roster.';

-- "None means NOT MEASURED, [] means measured-and-nobody" (merge.py,
-- merge_week_people). A child table cannot express the difference between
-- "absent" and "empty", so the presence of the roster is its own fact.
create table li.post_week_roster (
  author   text not null,
  post_id  text not null,
  week     date not null,
  side     text not null check (side in ('reactor','commenter')),
  primary key (author, post_id, week, side),
  foreign key (author, post_id, week) references li.post_week(author, post_id, week)
);


-- ===========================================================================
-- account snapshots — the unbackfillable ones
-- ===========================================================================

create table li.account_week (
  author  text not null references li.author(author),
  week    date not null,
  ord     integer not null,
  snapshot_at timestamptz,

  -- the "Dashboard" tile block
  dashboard_post_impressions_7d            bigint,
  dashboard_post_impressions_delta_pct_7d  numeric,
  dashboard_followers                      bigint,
  dashboard_followers_delta_pct_7d         numeric,
  dashboard_profile_viewers_90d            bigint,
  dashboard_search_appearances_prev_week   bigint,

  -- the "Content, last 7 days" block
  content_impressions_7d        bigint,
  content_impressions_delta_pct numeric,
  content_members_reached_7d    bigint,
  content_social_engagements_7d bigint,
  content_reactions_7d          bigint,
  content_comments_7d           bigint,
  content_reposts_7d            bigint,
  content_saves_7d              bigint,
  content_sends_7d              bigint,
  content_link_engagements_7d   bigint,

  -- the "Audience" block
  audience_total_followers          bigint,
  audience_followers_delta_pct_7d   numeric,

  -- "Search appearances" scalars
  search_all_appearances_7d       bigint,
  search_appearances_7d           bigint,
  search_profile_impressions_90d  bigint,
  search_profile_clicks_90d       bigint,
  search_profile_avg_view_time_s  numeric,

  -- "Profile views" scalars
  profile_viewers_90d          bigint,
  profile_viewers_delta_pct_7d numeric,

  -- Everything as it arrived. The typed columns above are the fields a
  -- dashboard reads today; this is the escrow for the ones it does not, because
  -- a weekly account snapshot cannot be re-fetched and a column added next
  -- quarter must still find its history here.
  raw jsonb not null,

  run_id  uuid not null references li.import_run(run_id),
  primary key (author, week)
);

create table li.account_week_demographic (
  author     text not null,
  week       date not null,
  dimension  text not null,
  label      text not null,
  pct        numeric not null,
  dim_ord    integer not null,
  label_ord  integer not null,
  primary key (author, week, dimension, label),
  foreign key (author, week) references li.account_week(author, week)
);


-- ===========================================================================
-- outbound comments — what the author wrote on other people's posts
-- ===========================================================================

create table li.comment (
  author              text not null references li.author(author),
  comment_urn         text not null,
  ord                 integer not null,      -- merge.py sorts by commented_at DESC
  commented_at        timestamptz not null,
  verb                text not null,
  body_text           text,
  comment_author_name text,
  comment_author_url  text,
  post_urn            text,
  post_url            text,
  post_author_name    text,
  post_author_url     text,
  permalink           text,
  run_id              uuid not null references li.import_run(run_id),
  primary key (author, comment_urn)
);

create table li.comment_week (
  author        text not null,
  comment_urn   text not null,
  week          date not null,
  ord           integer not null,
  snapshot_at   timestamptz,
  people_only   boolean not null default false,
  reactions     bigint,
  replies_count bigint,
  impressions   bigint,
  run_id        uuid not null references li.import_run(run_id),
  primary key (author, comment_urn, week),
  foreign key (author, comment_urn) references li.comment(author, comment_urn)
);

create table li.comment_week_person (
  author      text not null,
  comment_urn text not null,
  week        date not null,
  side        text not null check (side in ('reactor','commenter')),
  profile_url text not null,
  primary key (author, comment_urn, week, side, profile_url),
  foreign key (author, comment_urn, week) references li.comment_week(author, comment_urn, week)
);

create table li.comment_week_roster (
  author      text not null,
  comment_urn text not null,
  week        date not null,
  side        text not null check (side in ('reactor','commenter')),
  primary key (author, comment_urn, week, side),
  foreign key (author, comment_urn, week) references li.comment_week(author, comment_urn, week)
);


-- ===========================================================================
-- engagement — who engaged, and with what
-- ===========================================================================
--
-- Scoped by AUTHOR, not global. The same person_key carries a different
-- display name, headline and first_seen_at in two authors' engagement.json
-- files (34 keys overlap across the three authors today, 8 of them with
-- different core fields — "Speed and Function 1,364 followers" vs
-- "... 1,362 followers"). A global person table would silently pick one and
-- change what the export produces.

create table li.person (
  author            text not null references li.author(author),
  person_key        text not null,           -- 'in/<slug>' or 'company/<slug>'
  name              text,
  profile_url       text,
  headline          text,
  headline_seen_at  timestamptz,
  first_seen_at     timestamptz not null,
  icp_verdict       boolean,
  icp_reason        text,
  icp_model         text,
  icp_classified_at timestamptz,
  icp_headline_hash text,
  gate_week         date not null,           -- ISO Monday of first_seen_at
  run_id            uuid not null references li.import_run(run_id),
  primary key (author, person_key)
);
comment on column li.person.first_seen_at is
  'MERGE RULE: never moves once set. merge.py sets it only in the `entry is None` branch (lines 244-254); the update branch touches name/profile_url/headline only.';
comment on column li.person.gate_week is
  'The scrape week this person was discovered in. Identity rows have no week of their own, so this is what the publication gate holds them behind.';

create table li.engagement_event (
  author          text not null references li.author(author),
  event_id        text not null,
  kind            text not null check (kind in ('reaction','comment')),
  target_type     text not null,
  target_urn      text not null,
  target_url      text,
  person_key      text not null,
  occurred_at     timestamptz,               -- null: LinkedIn never dated it
  attributed_week date,                      -- null: ditto — belongs to all-time, to no week
  backfill        boolean not null,
  first_seen_at   timestamptz not null,
  body_text       text,
  gate_week       date not null,             -- ISO Monday of first_seen_at
  run_id          uuid not null references li.import_run(run_id),
  primary key (author, event_id),
  foreign key (author, person_key) references li.person(author, person_key)
);
comment on table li.engagement_event is
  'MERGE RULE: immutable and append-only. ON CONFLICT DO NOTHING, never DO UPDATE. merge.py line 272: `if event_id in events: continue` — a replayed run must not re-date an engagement.';
comment on column li.engagement_event.gate_week is
  'Discovery week, NOT attributed_week. attributed_week reaches back to 2023-03-27 — when the engagement happened. The gate is about when the scrape ran.';

create table li.scan_target (
  author             text not null references li.author(author),
  target_id          text not null,
  target_type        text not null,
  target_urn         text not null,
  target_url         text,
  first_scanned_week date not null,
  last_scanned_week  date not null,
  reactor_count      bigint not null,
  run_id             uuid not null references li.import_run(run_id),
  primary key (author, target_id)
);
comment on table li.scan_target is
  'Which posts/comments have ever had their reactor list read. A target absent here has never been scanned, so its reactors are a baseline, not a week of new reactions.';
comment on column li.scan_target.first_scanned_week is
  'MERGE RULE: frozen. merge.py sets it only on insert (line 315); the else branch (lines 320-322) overwrites last_scanned_week and reactor_count and nothing else.';


-- ===========================================================================
-- the shared profile cache (dashboards/profiles/*.json)
-- ===========================================================================
--
-- Global, unlike li.person: one file per human, shared by both pipelines,
-- keyed by the normalized profile path.

create table li.profile (
  person_key    text primary key,
  schema_version integer not null,
  profile_url   text,
  name          text,
  headline      text,
  headline_hash text,
  first_seen_at timestamptz,
  updated_at    timestamptz,
  scraped_at    timestamptz,                 -- when the PAGE was opened; null = never
  profile_text  text,
  icp           jsonb,                       -- the nested verdict block, verbatim
  source_file   text not null,
  run_id        uuid not null references li.import_run(run_id)
);
comment on column li.profile.scraped_at is
  'Deliberately separate from icp.decided_at: the no-touch window is measured from the SCRAPE, so re-judging cached data must not slide it forward.';


-- ===========================================================================
-- the company page (dashboards/li-stats/page/)
-- ===========================================================================
--
-- No author and no week: this is monthly XLS export, not a weekly scrape. It is
-- therefore NOT behind the publication gate — there is nothing weekly to gate.

create table li.page_meta (
  only_row     boolean primary key default true check (only_row),
  source       text,
  generated_at timestamptz,
  run_id       uuid not null references li.import_run(run_id)
);

create table li.page_month (
  month            date primary key,         -- first of month
  ord              integer not null,
  page_views       bigint,
  unique_visitors  bigint,
  new_followers    bigint,
  post_impressions bigint,
  post_reactions   bigint,
  post_comments    bigint,
  post_reposts     bigint,
  post_clicks      bigint,
  run_id           uuid not null references li.import_run(run_id)
);

create table li.page_geo_month (
  month    date primary key,
  ord      integer not null,
  us       bigint,
  team     bigint,
  anti     bigint,
  other    bigint,
  total    bigint,
  icp_pct  numeric,
  anti_pct numeric,
  run_id   uuid not null references li.import_run(run_id)
);

create table li.page_demographic (
  audience text not null check (audience in ('visitors','followers')),
  category text not null,                    -- 'Seniority' | 'Job function' | ...
  name     text not null,
  value    bigint not null,
  cat_ord  integer not null,
  row_ord  integer not null,
  run_id   uuid not null references li.import_run(run_id),
  primary key (audience, category, name)
);

create table li.page_manual (
  only_row        boolean primary key default true check (only_row),
  total_followers bigint not null check (total_followers > 0),
  last_updated    text,
  geography       jsonb not null,
  run_id          uuid not null references li.import_run(run_id)
);
comment on table li.page_manual is
  'Hand-entered values the XLS export does not carry. build-page-stats.mjs exits 23 rather than publish a follower curve built backwards from zero — the CHECK is the same refusal, one layer down.';

create table li.page_search_week (
  week     date primary key,
  searches bigint not null,
  run_id   uuid not null references li.import_run(run_id)
);


-- ===========================================================================
-- dash — the published read surface
-- ===========================================================================
--
-- Section names match the JSON payload build-stats-json.mjs writes, so a
-- Grafana panel reading `dash.post_weeks` and one reading the Infinity feed's
-- `post_weeks` root_selector see the same columns.

-- A post is visible once one of its weekly snapshots is published. A post with
-- no snapshots at all (37 of Peter's 126) is corpus, not measurement, and is
-- always visible.
create view dash.post as
  select p.author,
         p.post_id                         as id,
         to_char(p.posted_date,'YYYY-MM-DD') as posted_date,
         to_char(p.posted_date,'YYYY-MM')    as posted_month,
         p.type,
         left(coalesce(p.preview,''), 120) as preview,   -- code-point slice, as the reader does
         coalesce(p.body_text,'')          as text,
         coalesce(p.post_url,'')           as post_url,
         p.source_file
    from li.post p
   where not exists (select 1 from li.post_week w
                      where w.author = p.author and w.post_id = p.post_id)
      or exists (select 1 from li.post_week w
                   join dash.published_week pw on pw.author = w.author and pw.week = w.week
                  where w.author = p.author and w.post_id = p.post_id);

create view dash.post_week as
  select w.author,
         w.post_id                       as id,
         to_char(w.week,'YYYY-MM-DD')    as week,
         w.week                          as week_date,
         coalesce(w.impressions,0)       as impressions,
         coalesce(w.members_reached,0)   as members_reached,
         coalesce(w.reactions,0)         as reactions,
         coalesce(w.comments,0)          as comments,
         coalesce(w.reposts,0)           as reposts,
         coalesce(w.saves,0)             as saves,
         coalesce(w.sends,0)             as sends,
         coalesce(w.profile_viewers,0)   as profile_viewers,
         coalesce(w.followers_gained,0)  as followers_gained,
         coalesce(w.engagement_rate,0)   as engagement_rate,
         w.ord, p.source_file
    from li.post_week w
    join dash.published_week pub on pub.author = w.author and pub.week = w.week
    join li.post p on p.author = w.author and p.post_id = w.post_id;

create view dash.post_demographic as
  select d.author,
         d.post_id                    as id,
         to_char(d.week,'YYYY-MM-DD') as week,
         d.dimension,
         d.label,
         d.pct,
         d.dim_ord, d.label_ord, w.ord as week_ord, p.source_file
    from li.post_week_demographic d
    join dash.published_week pub on pub.author = d.author and pub.week = d.week
    join li.post_week w on w.author=d.author and w.post_id=d.post_id and w.week=d.week
    join li.post p on p.author = d.author and p.post_id = d.post_id;

create view dash.account_week as
  select a.author,
         to_char(a.week,'YYYY-MM-DD') as week,
         a.week                       as week_date,
         coalesce(a.dashboard_followers,0)                    as followers,
         coalesce(a.dashboard_post_impressions_7d,0)          as post_impressions_7d,
         coalesce(a.dashboard_profile_viewers_90d,0)          as profile_viewers_90d,
         coalesce(a.dashboard_search_appearances_prev_week,0) as search_appearances_previous_week,
         coalesce(a.audience_followers_delta_pct_7d,0)        as followers_delta_pct_7d,
         a.ord
    from li.account_week a
    join dash.published_week pub on pub.author = a.author and pub.week = a.week;

create view dash.account_demographic as
  select d.author,
         to_char(d.week,'YYYY-MM-DD') as week,
         d.dimension, d.label, d.pct,
         d.dim_ord, d.label_ord, a.ord as week_ord
    from li.account_week_demographic d
    join dash.published_week pub on pub.author = d.author and pub.week = d.week
    join li.account_week a on a.author = d.author and a.week = d.week;

-- Outbound comments: visible once one of their snapshots is published, or
-- immediately if none has been taken (they still count in comments_per_month).
create view dash.comment as
  select c.author, c.comment_urn, c.ord,
         to_char(c.commented_at at time zone 'UTC','YYYY-MM') as month,
         c.commented_at
    from li.comment c
   where not exists (select 1 from li.comment_week w
                      where w.author=c.author and w.comment_urn=c.comment_urn)
      or exists (select 1 from li.comment_week w
                   join dash.published_week pw on pw.author=w.author and pw.week=w.week
                  where w.author=c.author and w.comment_urn=c.comment_urn);

create view dash.comment_week as
  select w.author, w.comment_urn,
         to_char(w.week,'YYYY-MM-DD') as week,
         w.week as week_date,
         w.people_only, w.reactions, w.replies_count, w.impressions, w.ord
    from li.comment_week w
    join dash.published_week pub on pub.author=w.author and pub.week=w.week
    join dash.comment c on c.author=w.author and c.comment_urn=w.comment_urn;

create view dash.person as
  select p.author, p.person_key, p.name, p.profile_url, p.headline,
         p.icp_verdict, p.first_seen_at
    from li.person p
    join dash.published_week pub on pub.author=p.author and pub.week=p.gate_week;

create view dash.engagement_event as
  select e.author, e.event_id, e.kind, e.target_type, e.target_urn, e.target_url,
         e.person_key, e.occurred_at,
         e.attributed_week,
         to_char(e.attributed_week,'YYYY-MM-DD') as attributed_week_text,
         e.backfill, e.body_text
    from li.engagement_event e
    join dash.published_week pub on pub.author=e.author and pub.week=e.gate_week;

create view dash.scan_target as
  select t.author, t.target_id, t.target_type, t.target_urn, t.target_url,
         to_char(t.first_scanned_week,'YYYY-MM-DD') as first_scanned_week,
         to_char(t.last_scanned_week,'YYYY-MM-DD')  as last_scanned_week,
         t.reactor_count
    from li.scan_target t
    -- first_scanned_week IS a scrape week; it needs no separate gate column.
    join dash.published_week pub on pub.author=t.author and pub.week=t.first_scanned_week;


-- ---------------------------------------------------------------- derived
--
-- Everything below reproduces a section build-stats-json.mjs computes. The
-- arithmetic is deliberately identical, down to Math.round: all the sums are
-- sums of integers, which float8 represents exactly below 2^53, so SQL and JS
-- land on the same double and li.js_round() finishes the job the same way.

-- Latest snapshot per post, and the month roll-up that hangs off it.
create view dash.post_latest_impressions as
  select p.author, p.id, p.posted_month, p.type, p.source_file,
         coalesce((select w.impressions
                     from dash.post_week w
                    where w.author = p.author and w.id = p.id
                    order by w.week desc limit 1), 0) as impressions
    from dash.post p;

create view dash.posts_per_month_raw as
  select author, posted_month as month,
         count(*)                                   as posts,
         count(*) filter (where type='repost')      as reposts,
         sum(impressions)                           as total_impressions
    from dash.post_latest_impressions
   where posted_month <> ''
   group by author, posted_month;

create view dash.posts_per_month as
  with bounds as (
    select author,
           to_date(min(month),'YYYY-MM') as first_month,
           greatest(to_date(max(month),'YYYY-MM'), li.current_month()) as last_month
      from dash.posts_per_month_raw group by author),
  grid as (
    select b.author, generate_series(b.first_month, b.last_month, interval '1 month')::date as month
      from bounds b)
  select g.author,
         to_char(g.month,'YYYY-MM')          as month,
         coalesce(r.posts,0)                 as posts,
         coalesce(r.reposts,0)               as reposts,
         coalesce(r.total_impressions,0)     as total_impressions,
         case when coalesce(r.posts,0) > 0
              then li.js_round(r.total_impressions::double precision / r.posts)::bigint
              else 0 end                     as avg_impressions_per_post
    from grid g
    left join dash.posts_per_month_raw r
           on r.author = g.author and r.month = to_char(g.month,'YYYY-MM');

create view dash.correlation_point as
  select l.author, l.id, p.posted_date, l.posted_month, l.type,
         m.posts as posts_in_month, l.impressions, l.source_file
    from dash.post_latest_impressions l
    join dash.post p on p.author=l.author and p.id=l.id
    join dash.posts_per_month_raw m on m.author=l.author and m.month=l.posted_month
   where l.posted_month <> '';

-- OLS of impressions on posts_in_month, as two endpoints for the XY chart.
create view dash.correlation_trend as
  with s as (
    select author,
           count(*)::double precision                                          as n,
           sum(posts_in_month)::double precision                               as sx,
           sum(impressions)::double precision                                  as sy,
           sum(posts_in_month::double precision * impressions)                 as sxy,
           sum(posts_in_month::double precision * posts_in_month)              as sx2,
           min(posts_in_month)::double precision                               as xmin,
           max(posts_in_month)::double precision                               as xmax
      from dash.correlation_point group by author),
  c as (
    select author, n, sx, sy, xmin, xmax,
           case when (n*sx2 - sx*sx) <> 0 then (n*sxy - sx*sy)/(n*sx2 - sx*sx) else 0 end as slope
      from s)
  select author, xmin as posts_in_month,
         li.js_round(slope*xmin + (sy - slope*sx)/n)::bigint as impressions, 0 as endpoint
    from c
  union all
  select author, xmax, li.js_round(slope*xmax + (sy - slope*sx)/n)::bigint, 1
    from c;

-- One row per outbound comment, carrying its LATEST published snapshot.
create view dash.comments_per_month_raw as
  select c.author, c.month,
         count(*) as comments_posted,
         sum(coalesce((select w.reactions   from dash.comment_week w
                        where w.author=c.author and w.comment_urn=c.comment_urn
                        order by w.week_date desc limit 1),0)) as reactions_received,
         sum(coalesce((select w.impressions from dash.comment_week w
                        where w.author=c.author and w.comment_urn=c.comment_urn
                        order by w.week_date desc limit 1),0)) as impressions_received
    from dash.comment c
   where c.month <> ''
   group by c.author, c.month;

create view dash.comments_per_month as
  with bounds as (
    select author, to_date(min(month),'YYYY-MM') as first_month,
           greatest(to_date(max(month),'YYYY-MM'), li.current_month()) as last_month
      from dash.comments_per_month_raw group by author),
  grid as (
    select b.author, generate_series(b.first_month,b.last_month,interval '1 month')::date as month
      from bounds b)
  select g.author, to_char(g.month,'YYYY-MM') as month,
         coalesce(r.comments_posted,0)     as comments_posted,
         coalesce(r.reactions_received,0)  as reactions_received,
         coalesce(r.impressions_received,0) as impressions_received
    from grid g
    left join dash.comments_per_month_raw r
           on r.author=g.author and r.month=to_char(g.month,'YYYY-MM');


-- ------------------------------------------------------------- engagement
--
-- Scores are DERIVED HERE, never stored. Retuning li.scoring_weight or adding a
-- row to li.vip_person rescores the entire history on the next query, with no
-- re-scrape — the same property the JSON build has.

create view dash.engagement_scored as
  select e.author, e.event_id, e.person_key, e.kind, e.attributed_week, e.backfill,
         (p.icp_verdict is true)                     as is_icp,
         t.tiers[array_length(t.tiers,1)]            as tier,
         case when cfg.precedence = 'max'
              -- precedence 'max': the higher points of the tiers the person is in.
              then coalesce((select max(w.points) from li.scoring_weight w
                              where w.kind = e.kind and w.tier = any(t.tiers)), 0)
              -- otherwise: priority order vip > icp > normal, i.e. the LAST tier.
              else coalesce((select w.points from li.scoring_weight w
                              where w.kind = e.kind
                                and w.tier = t.tiers[array_length(t.tiers,1)]), 0)
         end                                         as points,
         p.name, p.headline, p.profile_url
    from dash.engagement_event e
    left join dash.person p     on p.author = e.author and p.person_key = e.person_key
    left join li.vip_person v   on v.person_key = e.person_key
    cross join li.scoring_config cfg
    cross join lateral (
      -- 'normal' is always a floor, so a tier weighted below it can never
      -- punish the person who earned it.
      select array['normal']
             || case when p.icp_verdict is true    then array['icp'] else array[]::text[] end
             || case when v.person_key is not null then array['vip'] else array[]::text[] end
             as tiers
    ) t;

-- The most recent ISO week that is already over. Derived from the data, not the
-- clock alone, so a delayed publish still shows the week the scrape covered.
create view dash.engagement_last_week as
  select author,
         max(attributed_week) filter (where attributed_week < li.current_week_monday()) as last_week
    from dash.engagement_event
   where attributed_week is not null
   group by author;

-- Weekly rows exclude `backfill` events on purpose: a backfilled reaction is one
-- LinkedIn never dated, discovered on a target's first scan, so it belongs to
-- "all time" but to no particular week.
create view dash.engagement_score_week_raw as
  select author, attributed_week as week,
         sum(points)                                        as score,
         coalesce(sum(points) filter (where tier='normal'),0) as score_normal,
         coalesce(sum(points) filter (where tier='icp'),0)    as score_icp,
         coalesce(sum(points) filter (where tier='vip'),0)    as score_vip,
         count(*) filter (where kind='reaction')            as reactions,
         count(*) filter (where kind='comment')             as comments
    from dash.engagement_scored
   where attributed_week is not null and not backfill
   group by author, attributed_week;

create view dash.engagement_score_week as
  with bounds as (select author, min(week) as w0, max(week) as w1
                    from dash.engagement_score_week_raw group by author),
  grid as (select b.author, generate_series(b.w0, b.w1, interval '7 days')::date as week
             from bounds b)
  select g.author, to_char(g.week,'YYYY-MM-DD') as week, g.week as week_date,
         coalesce(r.score,0)        as score,
         coalesce(r.score_normal,0) as score_normal,
         coalesce(r.score_icp,0)    as score_icp,
         coalesce(r.score_vip,0)    as score_vip,
         coalesce(r.reactions,0)    as reactions,
         coalesce(r.comments,0)     as comments
    from grid g
    left join dash.engagement_score_week_raw r on r.author=g.author and r.week=g.week;

create view dash.engagement_person as
  select s.author, s.person_key,
         coalesce(max(s.name), s.person_key)        as name,
         coalesce(max(s.headline),'')               as headline,
         coalesce(max(s.profile_url),'')            as profile_url,
         min(s.tier)                                as tier,   -- constant per person
         bool_or(s.is_icp)                          as is_icp,
         count(*) filter (where s.kind='reaction')  as reactions,
         count(*) filter (where s.kind='comment')   as comments,
         sum(s.points)                              as score,
         coalesce(sum(s.points) filter (
           where s.attributed_week is not null and not s.backfill
             and s.attributed_week = lw.last_week), 0) as score_last_week,
         min(s.event_id)                            as first_event_id
    from dash.engagement_scored s
    left join dash.engagement_last_week lw on lw.author = s.author
   group by s.author, s.person_key, lw.last_week;

-- `*_icp` counts key on the person's ICP verdict, NOT on their scoring tier:
-- the VIP list is a separate, hand-curated axis, so a VIP outside the ICP must
-- not inflate the ICP share.
create view dash.engagement_total as
  with lw as (select author, last_week from dash.engagement_last_week),
  base as (
    select s.*,
           (s.attributed_week is not null and not s.backfill
            and s.attributed_week = lw.last_week) as in_last_week,
           lw.last_week
      from dash.engagement_scored s
      left join lw on lw.author = s.author),
  scopes(scope) as (values ('last_week'), ('all_time')),
  sel as (
    select b.*, sc.scope,
           (sc.scope = 'all_time' or b.in_last_week) as counted
      from base b cross join scopes sc)
  select author, scope,
         case when scope='last_week' then coalesce(to_char(max(last_week),'YYYY-MM-DD'),'') else '' end as week,
         coalesce(sum(points) filter (where counted),0)                              as score,
         coalesce(sum(points) filter (where counted and tier='normal'),0)            as score_normal,
         coalesce(sum(points) filter (where counted and tier='icp'),0)               as score_icp,
         coalesce(sum(points) filter (where counted and tier='vip'),0)               as score_vip,
         count(*) filter (where counted and kind='reaction')                         as reactions,
         count(*) filter (where counted and kind='comment')                          as comments,
         count(distinct person_key) filter (where counted)                           as people,
         count(*) filter (where counted and kind='reaction' and is_icp)              as reactions_icp,
         count(*) filter (where counted and kind='comment'  and is_icp)              as comments_icp,
         count(distinct person_key) filter (where counted and is_icp)                as people_icp
    from sel
   group by author, scope;


-- ----------------------------------------------------------------- page
-- Not gated: monthly XLS export, no weekly scrape to publish.

create view dash.page_month as
  select to_char(month,'YYYY-MM') as month, month as month_date, ord,
         page_views, unique_visitors, new_followers, post_impressions,
         post_reactions, post_comments, post_reposts, post_clicks
    from li.page_month;

create view dash.page_geo_month as
  select to_char(month,'YYYY-MM') as month, month as month_date, ord,
         us, team, anti, other, total, icp_pct, anti_pct
    from li.page_geo_month;

create view dash.page_demographic as
  select audience, category, name, value, cat_ord, row_ord from li.page_demographic;

create view dash.page_search_week as
  select to_char(week,'YYYY-MM-DD') as week, week as week_date, searches
    from li.page_search_week;

create view dash.page_manual as
  select total_followers, last_updated, geography from li.page_manual;

create view dash.page_meta as
  select source, generated_at from li.page_meta;


-- ===========================================================================
-- the merge rules, fenced behind SECURITY DEFINER functions
-- ===========================================================================
--
-- The writer role is granted INSERT and SELECT and nothing else. Every merge in
-- merge.py that is not a plain append therefore lives here as a function owned
-- by li_owner: the rule is written once, next to the line of merge.py it comes
-- from, and a writer cannot reach past it to UPDATE anything else.
--
-- There are three kinds of rule, and mixing them up is how this layer breaks:
--
--   APPEND-ONLY   engagement events. ON CONFLICT DO NOTHING, never DO UPDATE
--                 (merge.py:272 `if event_id in events: continue`).
--   FROZEN FIELD  person.first_seen_at (merge.py:244-254),
--                 scan_target.first_scanned_week (merge.py:315) — set on insert,
--                 never moved; the rest of the row is overwritten.
--   REPLACED      a week snapshot. merge.py:84 and :96 are
--                 `data.setdefault("weeks", {})[week] = snapshot` — a plain
--                 assignment, so a re-scrape of a week REPLACES it, children and
--                 all. The same goes for every document the scraper rewrites
--                 wholesale rather than appends to: the profile cache, the
--                 company-page monthly export, and the scoring config.
--
-- Everything below is written so that replaying the same input writes no tuple
-- at all — the DO UPDATE carries a `where ... is distinct from` guard and the
-- children are reconciled as a set (stale rows deleted, new rows inserted),
-- never blindly deleted and re-inserted. "Idempotent" here means "a second run
-- changes nothing", NOT "a second run ignores what changed".
--
-- All of them take jsonb and INSERT ... SELECT FROM jsonb_populate_recordset, so
-- the payload keys are the column names. Postgres refuses to let one
-- INSERT ... ON CONFLICT DO UPDATE touch the same row twice ("cannot affect row
-- a second time"), so callers MUST fold the batch first — merge.py gets away
-- with it only because it is building Python dicts. import.mjs folds.

-- Patch author/run_id into every element of a payload, so the caller ships only
-- the fields it actually read out of the JSON.
create function li.stamp(p_rows jsonb, p_patch jsonb) returns jsonb
  language sql immutable as $$
    select coalesce(jsonb_agg(e || p_patch), '[]'::jsonb)
      from jsonb_array_elements(coalesce(p_rows,'[]'::jsonb)) e
  $$;


-- ---------------------------------------------------------------- posts

-- Identity is written once (fast/merge.py new_file() refuses to overwrite an
-- existing post file), with ONE exception: merge.py:82-83,
--   `if text and not data.get("text"): data["text"] = text`
-- backfills the body of a post whose text was not captured at discovery. That
-- is a fill-if-empty, not a replace, and it is the only field that moves.
create function li.upsert_post(p_author text, p_run_id uuid, p_posts jsonb)
returns integer language plpgsql security definer set search_path = li, pg_temp as $$
declare n integer;
begin
  insert into li.post
  select * from jsonb_populate_recordset(null::li.post,
           li.stamp(p_posts, jsonb_build_object('author', p_author, 'run_id', p_run_id)))
  on conflict (author, post_id) do update set
      body_text = coalesce(nullif(li.post.body_text,''), excluded.body_text),
      run_id    = p_run_id
    where li.post.body_text is distinct from
          coalesce(nullif(li.post.body_text,''), excluded.body_text);
  get diagnostics n = row_count;
  return n;
end $$;
comment on function li.upsert_post is
  'merge.py:82-83 — the post body is backfilled when empty, never replaced. Every other field is written once by new_file(), which refuses to overwrite.';

-- A week snapshot is REPLACED, not merged: merge.py:84 is
-- `data.setdefault("weeks", {})[week] = snapshot`. The demographics, the
-- inbound comments and the reactor/commenter rosters arrive inside that
-- snapshot, so they are replaced as a SET — a label that is gone from the new
-- snapshot must be gone from the table, not left behind from the old one.
create function li.replace_post_week(p_author text, p_run_id uuid, p_snapshots jsonb)
returns integer language plpgsql security definer set search_path = li, pg_temp as $$
declare n integer := 0; k integer;
begin
  -- 1. the snapshot row
  insert into li.post_week
  select * from jsonb_populate_recordset(null::li.post_week,
           li.stamp(p_snapshots, jsonb_build_object('author', p_author, 'run_id', p_run_id)))
  on conflict (author, post_id, week) do update set
      ord = excluded.ord, snapshot_at = excluded.snapshot_at,
      has_metrics = excluded.has_metrics,
      impressions = excluded.impressions, members_reached = excluded.members_reached,
      reactions = excluded.reactions, comments = excluded.comments,
      reposts = excluded.reposts, saves = excluded.saves, sends = excluded.sends,
      profile_viewers = excluded.profile_viewers,
      followers_gained = excluded.followers_gained,
      engagement_rate = excluded.engagement_rate,
      run_id = p_run_id
    where (li.post_week.ord, li.post_week.snapshot_at, li.post_week.has_metrics,
           li.post_week.impressions, li.post_week.members_reached, li.post_week.reactions,
           li.post_week.comments, li.post_week.reposts, li.post_week.saves,
           li.post_week.sends, li.post_week.profile_viewers,
           li.post_week.followers_gained, li.post_week.engagement_rate)
       is distinct from
          (excluded.ord, excluded.snapshot_at, excluded.has_metrics,
           excluded.impressions, excluded.members_reached, excluded.reactions,
           excluded.comments, excluded.reposts, excluded.saves,
           excluded.sends, excluded.profile_viewers,
           excluded.followers_gained, excluded.engagement_rate);
  get diagnostics k = row_count; n := n + k;

  -- 2. demographics — reconciled as a set
  delete from li.post_week_demographic t
   using jsonb_array_elements(p_snapshots) s
   where t.author = p_author and t.post_id = s->>'post_id' and t.week = (s->>'week')::date
     and not exists (select 1 from jsonb_to_recordset(coalesce(s->'demographics','[]'::jsonb))
                              as d(dimension text, label text)
                      where d.dimension = t.dimension and d.label = t.label);
  get diagnostics k = row_count; n := n + k;

  insert into li.post_week_demographic (author, post_id, week, dimension, label, pct, dim_ord, label_ord)
  select p_author, s->>'post_id', (s->>'week')::date, d.dimension, d.label, d.pct, d.dim_ord, d.label_ord
    from jsonb_array_elements(p_snapshots) s,
         jsonb_to_recordset(coalesce(s->'demographics','[]'::jsonb))
           as d(dimension text, label text, pct numeric, dim_ord integer, label_ord integer)
  on conflict (author, post_id, week, dimension, label) do update set
      pct = excluded.pct, dim_ord = excluded.dim_ord, label_ord = excluded.label_ord
    where (li.post_week_demographic.pct, li.post_week_demographic.dim_ord, li.post_week_demographic.label_ord)
       is distinct from (excluded.pct, excluded.dim_ord, excluded.label_ord);
  get diagnostics k = row_count; n := n + k;

  -- 3. inbound comments — same set treatment
  delete from li.post_week_comment t
   using jsonb_array_elements(p_snapshots) s
   where t.author = p_author and t.post_id = s->>'post_id' and t.week = (s->>'week')::date
     and not exists (select 1 from jsonb_to_recordset(coalesce(s->'comment_rows','[]'::jsonb))
                              as c(comment_urn text)
                      where c.comment_urn = t.comment_urn);
  get diagnostics k = row_count; n := n + k;

  insert into li.post_week_comment (author, post_id, week, comment_urn, ord, author_name,
      author_headline, author_url, body_text, reactions, replies_count)
  select p_author, s->>'post_id', (s->>'week')::date, c.comment_urn, c.ord, c.author_name,
         c.author_headline, c.author_url, c.body_text, c.reactions, c.replies_count
    from jsonb_array_elements(p_snapshots) s,
         jsonb_to_recordset(coalesce(s->'comment_rows','[]'::jsonb))
           as c(comment_urn text, ord integer, author_name text, author_headline text,
                author_url text, body_text text, reactions bigint, replies_count bigint)
  on conflict (author, post_id, week, comment_urn) do update set
      ord = excluded.ord, author_name = excluded.author_name,
      author_headline = excluded.author_headline, author_url = excluded.author_url,
      body_text = excluded.body_text, reactions = excluded.reactions,
      replies_count = excluded.replies_count
    where (li.post_week_comment.ord, li.post_week_comment.author_name,
           li.post_week_comment.author_headline, li.post_week_comment.author_url,
           li.post_week_comment.body_text, li.post_week_comment.reactions,
           li.post_week_comment.replies_count)
       is distinct from (excluded.ord, excluded.author_name, excluded.author_headline,
           excluded.author_url, excluded.body_text, excluded.reactions, excluded.replies_count);
  get diagnostics k = row_count; n := n + k;

  -- 4. the roster flag (measured / not measured) and its contents
  delete from li.post_week_roster t
   using jsonb_array_elements(p_snapshots) s
   where t.author = p_author and t.post_id = s->>'post_id' and t.week = (s->>'week')::date
     and not exists (select 1 from jsonb_to_recordset(coalesce(s->'rosters','[]'::jsonb))
                              as r(side text) where r.side = t.side);
  get diagnostics k = row_count; n := n + k;

  insert into li.post_week_roster (author, post_id, week, side)
  select p_author, s->>'post_id', (s->>'week')::date, r.side
    from jsonb_array_elements(p_snapshots) s,
         jsonb_to_recordset(coalesce(s->'rosters','[]'::jsonb)) as r(side text)
  on conflict do nothing;
  get diagnostics k = row_count; n := n + k;

  delete from li.post_week_person t
   using jsonb_array_elements(p_snapshots) s
   where t.author = p_author and t.post_id = s->>'post_id' and t.week = (s->>'week')::date
     and not exists (select 1 from jsonb_to_recordset(coalesce(s->'people','[]'::jsonb))
                              as pp(side text, profile_url text)
                      where pp.side = t.side and pp.profile_url = t.profile_url);
  get diagnostics k = row_count; n := n + k;

  insert into li.post_week_person (author, post_id, week, side, profile_url)
  select p_author, s->>'post_id', (s->>'week')::date, pp.side, pp.profile_url
    from jsonb_array_elements(p_snapshots) s,
         jsonb_to_recordset(coalesce(s->'people','[]'::jsonb)) as pp(side text, profile_url text)
  on conflict do nothing;
  get diagnostics k = row_count; n := n + k;

  return n;
end $$;
comment on function li.replace_post_week is
  'MERGE RULE: REPLACE. merge.py:84 `data.setdefault("weeks", {})[week] = snapshot`. A re-scrape of a week already stored overwrites it; the demographics, comments and rosters that arrive inside the snapshot are replaced as a set.';


-- -------------------------------------------------------------- account

-- merge.py:96, the same assignment as merge_post. These are the unbackfillable
-- rows: LinkedIn only ever exposes current values, so a corrected re-scrape of
-- a week is the ONLY chance to fix it, and dropping it on the floor is data loss.
create function li.replace_account_week(p_author text, p_run_id uuid, p_snapshots jsonb)
returns integer language plpgsql security definer set search_path = li, pg_temp as $$
declare n integer := 0; k integer;
begin
  insert into li.account_week
  select * from jsonb_populate_recordset(null::li.account_week,
           li.stamp(p_snapshots, jsonb_build_object('author', p_author, 'run_id', p_run_id)))
  on conflict (author, week) do update set
      ord = excluded.ord, snapshot_at = excluded.snapshot_at,
      dashboard_post_impressions_7d           = excluded.dashboard_post_impressions_7d,
      dashboard_post_impressions_delta_pct_7d = excluded.dashboard_post_impressions_delta_pct_7d,
      dashboard_followers                     = excluded.dashboard_followers,
      dashboard_followers_delta_pct_7d        = excluded.dashboard_followers_delta_pct_7d,
      dashboard_profile_viewers_90d           = excluded.dashboard_profile_viewers_90d,
      dashboard_search_appearances_prev_week  = excluded.dashboard_search_appearances_prev_week,
      content_impressions_7d        = excluded.content_impressions_7d,
      content_impressions_delta_pct = excluded.content_impressions_delta_pct,
      content_members_reached_7d    = excluded.content_members_reached_7d,
      content_social_engagements_7d = excluded.content_social_engagements_7d,
      content_reactions_7d          = excluded.content_reactions_7d,
      content_comments_7d           = excluded.content_comments_7d,
      content_reposts_7d            = excluded.content_reposts_7d,
      content_saves_7d              = excluded.content_saves_7d,
      content_sends_7d              = excluded.content_sends_7d,
      content_link_engagements_7d   = excluded.content_link_engagements_7d,
      audience_total_followers        = excluded.audience_total_followers,
      audience_followers_delta_pct_7d = excluded.audience_followers_delta_pct_7d,
      search_all_appearances_7d      = excluded.search_all_appearances_7d,
      search_appearances_7d          = excluded.search_appearances_7d,
      search_profile_impressions_90d = excluded.search_profile_impressions_90d,
      search_profile_clicks_90d      = excluded.search_profile_clicks_90d,
      search_profile_avg_view_time_s = excluded.search_profile_avg_view_time_s,
      profile_viewers_90d            = excluded.profile_viewers_90d,
      profile_viewers_delta_pct_7d   = excluded.profile_viewers_delta_pct_7d,
      raw = excluded.raw, run_id = p_run_id
    -- `raw` is the snapshot verbatim, so it is the whole comparison: every typed
    -- column above is a projection of it. `ord` is file position, which raw does
    -- not carry.
    where li.account_week.raw is distinct from excluded.raw
       or li.account_week.ord is distinct from excluded.ord;
  get diagnostics k = row_count; n := n + k;

  delete from li.account_week_demographic t
   using jsonb_array_elements(p_snapshots) s
   where t.author = p_author and t.week = (s->>'week')::date
     and not exists (select 1 from jsonb_to_recordset(coalesce(s->'demographics','[]'::jsonb))
                              as d(dimension text, label text)
                      where d.dimension = t.dimension and d.label = t.label);
  get diagnostics k = row_count; n := n + k;

  insert into li.account_week_demographic (author, week, dimension, label, pct, dim_ord, label_ord)
  select p_author, (s->>'week')::date, d.dimension, d.label, d.pct, d.dim_ord, d.label_ord
    from jsonb_array_elements(p_snapshots) s,
         jsonb_to_recordset(coalesce(s->'demographics','[]'::jsonb))
           as d(dimension text, label text, pct numeric, dim_ord integer, label_ord integer)
  on conflict (author, week, dimension, label) do update set
      pct = excluded.pct, dim_ord = excluded.dim_ord, label_ord = excluded.label_ord
    where (li.account_week_demographic.pct, li.account_week_demographic.dim_ord,
           li.account_week_demographic.label_ord)
       is distinct from (excluded.pct, excluded.dim_ord, excluded.label_ord);
  get diagnostics k = row_count; n := n + k;

  return n;
end $$;
comment on function li.replace_account_week is
  'MERGE RULE: REPLACE. merge.py:96, identical to merge_post. A weekly account snapshot cannot be re-fetched from LinkedIn, so a corrected re-scrape must land.';


-- ------------------------------------------------------------- comments

-- merge_comments (merge.py:127-146): the comment record is written on first
-- sight and never rewritten — except `ord`, which is not a fact but the file's
-- sort position (merge.py:165-167 re-sorts by commented_at DESC on every merge).
create function li.upsert_comment(p_author text, p_run_id uuid, p_comments jsonb)
returns integer language plpgsql security definer set search_path = li, pg_temp as $$
declare n integer;
begin
  insert into li.comment
  select * from jsonb_populate_recordset(null::li.comment,
           li.stamp(p_comments, jsonb_build_object('author', p_author, 'run_id', p_run_id)))
  on conflict (author, comment_urn) do update set ord = excluded.ord
    where li.comment.ord is distinct from excluded.ord;
  get diagnostics n = row_count;
  return n;
end $$;

-- merge.py:149-154: `entry.setdefault("weeks", {})[week] = {...}` — replace.
create function li.replace_comment_week(p_author text, p_run_id uuid, p_snapshots jsonb)
returns integer language plpgsql security definer set search_path = li, pg_temp as $$
declare n integer := 0; k integer;
begin
  insert into li.comment_week
  select * from jsonb_populate_recordset(null::li.comment_week,
           li.stamp(p_snapshots, jsonb_build_object('author', p_author, 'run_id', p_run_id)))
  on conflict (author, comment_urn, week) do update set
      ord = excluded.ord, snapshot_at = excluded.snapshot_at,
      people_only = excluded.people_only, reactions = excluded.reactions,
      replies_count = excluded.replies_count, impressions = excluded.impressions,
      run_id = p_run_id
    where (li.comment_week.ord, li.comment_week.snapshot_at, li.comment_week.people_only,
           li.comment_week.reactions, li.comment_week.replies_count, li.comment_week.impressions)
       is distinct from (excluded.ord, excluded.snapshot_at, excluded.people_only,
           excluded.reactions, excluded.replies_count, excluded.impressions);
  get diagnostics k = row_count; n := n + k;

  delete from li.comment_week_roster t
   using jsonb_array_elements(p_snapshots) s
   where t.author = p_author and t.comment_urn = s->>'comment_urn' and t.week = (s->>'week')::date
     and not exists (select 1 from jsonb_to_recordset(coalesce(s->'rosters','[]'::jsonb))
                              as r(side text) where r.side = t.side);
  get diagnostics k = row_count; n := n + k;

  insert into li.comment_week_roster (author, comment_urn, week, side)
  select p_author, s->>'comment_urn', (s->>'week')::date, r.side
    from jsonb_array_elements(p_snapshots) s,
         jsonb_to_recordset(coalesce(s->'rosters','[]'::jsonb)) as r(side text)
  on conflict do nothing;
  get diagnostics k = row_count; n := n + k;

  delete from li.comment_week_person t
   using jsonb_array_elements(p_snapshots) s
   where t.author = p_author and t.comment_urn = s->>'comment_urn' and t.week = (s->>'week')::date
     and not exists (select 1 from jsonb_to_recordset(coalesce(s->'people','[]'::jsonb))
                              as pp(side text, profile_url text)
                      where pp.side = t.side and pp.profile_url = t.profile_url);
  get diagnostics k = row_count; n := n + k;

  insert into li.comment_week_person (author, comment_urn, week, side, profile_url)
  select p_author, s->>'comment_urn', (s->>'week')::date, pp.side, pp.profile_url
    from jsonb_array_elements(p_snapshots) s,
         jsonb_to_recordset(coalesce(s->'people','[]'::jsonb)) as pp(side text, profile_url text)
  on conflict do nothing;
  get diagnostics k = row_count; n := n + k;

  return n;
end $$;


-- --------------------------------------------------------------- people

create function li.upsert_person(
  p_author text, p_run_id uuid, p_now timestamptz,
  p_key text[], p_name text[], p_profile_url text[], p_headline text[],
  p_headline_seen_at timestamptz[] default null, p_first_seen_at timestamptz[] default null
) returns integer
language plpgsql security definer set search_path = li, pg_temp as $$
declare n integer;
begin
  insert into li.person (author, person_key, name, profile_url, headline,
                         headline_seen_at, first_seen_at, gate_week, run_id)
  -- The INSERT branch takes the values verbatim, INCLUDING an empty string —
  -- merge.py:243-254 does the same, and the corpus proves it matters:
  -- peter's in/johanevj has name "" and headline "", and the reader
  -- (build-stats-json.mjs:356 `person?.name ?? key`) keeps the empty string
  -- rather than falling back to the key. nullif() here would change the feed.
  -- The batch is folded first-wins-with-non-empty-updates by the caller, which
  -- is what stops a later empty row from being the one that lands.
  select p_author, k.key, k.name, k.profile_url, k.headline,
         coalesce(k.hseen, p_now),
         coalesce(k.fseen, p_now),
         (date_trunc('week', coalesce(k.fseen, p_now) at time zone 'UTC'))::date,
         p_run_id
    from unnest(p_key, p_name, p_profile_url, p_headline,
                coalesce(p_headline_seen_at, array_fill(p_now, array[array_length(p_key,1)])),
                coalesce(p_first_seen_at,    array_fill(p_now, array[array_length(p_key,1)])))
           as k(key, name, profile_url, headline, hseen, fseen)
  on conflict (author, person_key) do update set
      -- Never overwrite a known value with an empty one: the reaction overlay
      -- sometimes renders a person without a headline (merge.py:259-261).
      name        = case when nullif(excluded.name,'')        is not null then excluded.name        else li.person.name end,
      profile_url = case when nullif(excluded.profile_url,'') is not null then excluded.profile_url else li.person.profile_url end,
      headline    = case when nullif(excluded.headline,'')    is not null then excluded.headline    else li.person.headline end,
      headline_seen_at = case when nullif(excluded.headline,'') is not null
                               and excluded.headline is distinct from li.person.headline
                              then excluded.headline_seen_at else li.person.headline_seen_at end
      -- first_seen_at and gate_week are ABSENT from this SET list on purpose.
      -- MERGE RULE: first_seen_at never moves once set (merge.py:244-254).
      where li.person.name        is distinct from (case when nullif(excluded.name,'')        is not null then excluded.name        else li.person.name end)
         or li.person.profile_url is distinct from (case when nullif(excluded.profile_url,'') is not null then excluded.profile_url else li.person.profile_url end)
         or li.person.headline    is distinct from (case when nullif(excluded.headline,'')    is not null then excluded.headline    else li.person.headline end);
  get diagnostics n = row_count;
  return n;
end $$;

-- The ICP verdict is replaced wholesale when a classifier runs (merge.py:291-303).
-- `classified_at` is PER PERSON, not per batch: merge.py stamps a batch with one
-- now_iso, but this importer is replaying verdicts recorded across many runs, and
-- the verdict's age is what profile-store.mjs:165-170 and :192-204 use to decide
-- whether it is still usable. Flattening them to one instant falsifies the TTL.
create function li.set_person_icp(
  p_author text, p_key text[], p_verdict boolean[], p_reason text[], p_model text[],
  p_headline_hash text[], p_classified_at timestamptz[]
) returns integer
language plpgsql security definer set search_path = li, pg_temp as $$
declare n integer;
begin
  update li.person p set
    icp_verdict = v.verdict, icp_reason = v.reason, icp_model = v.model,
    icp_headline_hash = v.hhash, icp_classified_at = v.at
  from unnest(p_key, p_verdict, p_reason, p_model, p_headline_hash, p_classified_at)
         as v(key, verdict, reason, model, hhash, at)
  where p.author = p_author and p.person_key = v.key
    -- Guarded like the other two rules, so replaying a run rewrites no tuple.
    and (p.icp_verdict, p.icp_reason, p.icp_model, p.icp_headline_hash, p.icp_classified_at)
        is distinct from (v.verdict, v.reason, v.model, v.hhash, v.at);
  get diagnostics n = row_count;
  return n;
end $$;

-- first_scanned_week and last_scanned_week are SEPARATE inputs. They are not the
-- same value even on first sight: 8 targets in today's corpus were first scanned
-- in one week and last scanned in another, and collapsing them to one column
-- would rewrite a frozen fact on the very first import.
create function li.upsert_scan_target(
  p_author text, p_run_id uuid,
  p_target_id text[], p_target_type text[], p_target_urn text[], p_target_url text[],
  p_first_week date[], p_last_week date[], p_reactor_count bigint[]
) returns integer
language plpgsql security definer set search_path = li, pg_temp as $$
declare n integer;
begin
  insert into li.scan_target (author, target_id, target_type, target_urn, target_url,
                              first_scanned_week, last_scanned_week, reactor_count, run_id)
  select p_author, t.id, t.ttype, t.urn, t.url, t.fweek, t.lweek, t.cnt, p_run_id
    from unnest(p_target_id, p_target_type, p_target_urn, p_target_url,
                p_first_week, p_last_week, p_reactor_count)
           as t(id, ttype, urn, url, fweek, lweek, cnt)
  on conflict (author, target_id) do update set
      last_scanned_week = excluded.last_scanned_week,
      reactor_count     = excluded.reactor_count
      -- first_scanned_week is ABSENT on purpose. MERGE RULE: frozen (merge.py:315
      -- sets it in the insert branch only; :320-322 overwrites the other two).
      where li.scan_target.last_scanned_week is distinct from excluded.last_scanned_week
         or li.scan_target.reactor_count     is distinct from excluded.reactor_count;
  get diagnostics n = row_count;
  return n;
end $$;


-- -------------------------------------------------- shared profile cache

-- profile-store.mjs:300-353, rule for rule. This is the one store BOTH pipelines
-- write, so it needs a write path of its own, not an insert-and-hope.
create function li.upsert_profile(p_run_id uuid, p_rows jsonb)
returns integer language plpgsql security definer set search_path = li, pg_temp as $$
declare n integer;
begin
  insert into li.profile
  select * from jsonb_populate_recordset(null::li.profile,
           li.stamp(p_rows, jsonb_build_object('run_id', p_run_id)))
  on conflict (person_key) do update set
      schema_version = excluded.schema_version,
      -- :313-315 — never overwrite a known value with an empty one.
      profile_url = coalesce(nullif(excluded.profile_url,''), li.profile.profile_url),
      name        = coalesce(nullif(excluded.name,''),        li.profile.name),
      headline    = coalesce(nullif(excluded.headline,''),    li.profile.headline),
      -- :316 — the hash follows the headline, and only when the headline is real.
      headline_hash = case when nullif(excluded.headline,'') is not null
                           then excluded.headline_hash else li.profile.headline_hash end,
      -- :317 — first_seen_at is frozen.
      first_seen_at = coalesce(li.profile.first_seen_at, excluded.first_seen_at),
      -- :319-320 — scraped_at and profile_text advance only on a real page read,
      -- which is exactly what a non-null scraped_at in the incoming record means.
      scraped_at   = coalesce(excluded.scraped_at, li.profile.scraped_at),
      profile_text = case when excluded.scraped_at is not null
                          then excluded.profile_text
                          else coalesce(excluded.profile_text, li.profile.profile_text) end,
      -- :323-337 — the verdict block is replaced when one is supplied, carried
      -- forward otherwise.
      icp = coalesce(excluded.icp, li.profile.icp),
      -- :343-348 — updated_at means last CHANGED, so it rides the guard below.
      updated_at = excluded.updated_at,
      source_file = excluded.source_file,
      run_id = p_run_id
    where (li.profile.schema_version, li.profile.profile_url, li.profile.name,
           li.profile.headline, li.profile.headline_hash, li.profile.scraped_at,
           li.profile.profile_text, li.profile.icp, li.profile.source_file)
       is distinct from
          (excluded.schema_version,
           coalesce(nullif(excluded.profile_url,''), li.profile.profile_url),
           coalesce(nullif(excluded.name,''),        li.profile.name),
           coalesce(nullif(excluded.headline,''),    li.profile.headline),
           case when nullif(excluded.headline,'') is not null
                then excluded.headline_hash else li.profile.headline_hash end,
           coalesce(excluded.scraped_at, li.profile.scraped_at),
           case when excluded.scraped_at is not null then excluded.profile_text
                else coalesce(excluded.profile_text, li.profile.profile_text) end,
           coalesce(excluded.icp, li.profile.icp),
           excluded.source_file);
  get diagnostics n = row_count;
  return n;
end $$;


-- ---------------------------------------------------------------- config

-- scoring.json says of itself: "editing this file rescores all history on the
-- next Pages build, with no re-scrape". Config is NOT a fact — it is replaced,
-- and a weight removed from the file has to be removed from the table too, or
-- dash keeps scoring on a rule nobody can see any more.
create function li.set_scoring(
  p_run_id uuid, p_precedence text,
  p_tier text[], p_kind text[], p_points numeric[]
) returns integer
language plpgsql security definer set search_path = li, pg_temp as $$
declare n integer := 0; k integer;
begin
  insert into li.scoring_config (only_row, precedence, run_id)
  values (true, p_precedence, p_run_id)
  on conflict (only_row) do update set precedence = excluded.precedence, run_id = p_run_id
    where li.scoring_config.precedence is distinct from excluded.precedence;
  get diagnostics k = row_count; n := n + k;

  delete from li.scoring_weight w
   where not exists (select 1 from unnest(p_tier, p_kind) as t(tier, kind)
                      where t.tier = w.tier and t.kind = w.kind);
  get diagnostics k = row_count; n := n + k;

  insert into li.scoring_weight (tier, kind, points, run_id)
  select t.tier, t.kind, t.points, p_run_id from unnest(p_tier, p_kind, p_points) as t(tier, kind, points)
  on conflict (tier, kind) do update set points = excluded.points, run_id = p_run_id
    where li.scoring_weight.points is distinct from excluded.points;
  get diagnostics k = row_count; n := n + k;

  return n;
end $$;

-- Same for the hand-curated VIP list. REMOVING a person from vip-people.md has
-- to remove them here, or their score stays inflated in dash forever.
create function li.set_vip(p_run_id uuid, p_keys text[])
returns integer language plpgsql security definer set search_path = li, pg_temp as $$
declare n integer := 0; k integer;
begin
  delete from li.vip_person v
   where not exists (select 1 from unnest(coalesce(p_keys, array[]::text[])) as x(key) where x.key = v.person_key);
  get diagnostics k = row_count; n := n + k;

  insert into li.vip_person (person_key, run_id)
  select x.key, p_run_id from unnest(coalesce(p_keys, array[]::text[])) as x(key)
  on conflict (person_key) do nothing;
  get diagnostics k = row_count; n := n + k;

  return n;
end $$;


-- ----------------------------------------------------------- company page

-- manual.json says it in its own _note: monthly.json is COMPLETELY REWRITTEN by
-- the parser on every scrape-page.mjs run. A restated month (LinkedIn does
-- restate them in later XLS exports) therefore has to land. Each section is
-- replaced for the keys the document asserts; months it does not mention are
-- history and are left alone.
create function li.replace_page(
  p_run_id uuid, p_meta jsonb, p_months jsonb, p_geo jsonb,
  p_demographics jsonb, p_manual jsonb, p_search jsonb
) returns integer
language plpgsql security definer set search_path = li, pg_temp as $$
declare n integer := 0; k integer;
begin
  if p_meta is not null then
    insert into li.page_meta (only_row, source, generated_at, run_id)
    select true, m.source, m.generated_at, p_run_id
      from jsonb_to_record(p_meta) as m(source text, generated_at timestamptz)
    on conflict (only_row) do update set
        source = excluded.source, generated_at = excluded.generated_at, run_id = p_run_id
      where (li.page_meta.source, li.page_meta.generated_at)
         is distinct from (excluded.source, excluded.generated_at);
    get diagnostics k = row_count; n := n + k;
  end if;

  if p_months is not null then
    insert into li.page_month
    select * from jsonb_populate_recordset(null::li.page_month,
             li.stamp(p_months, jsonb_build_object('run_id', p_run_id)))
    on conflict (month) do update set
        ord = excluded.ord, page_views = excluded.page_views,
        unique_visitors = excluded.unique_visitors, new_followers = excluded.new_followers,
        post_impressions = excluded.post_impressions, post_reactions = excluded.post_reactions,
        post_comments = excluded.post_comments, post_reposts = excluded.post_reposts,
        post_clicks = excluded.post_clicks, run_id = p_run_id
      where (li.page_month.ord, li.page_month.page_views, li.page_month.unique_visitors,
             li.page_month.new_followers, li.page_month.post_impressions,
             li.page_month.post_reactions, li.page_month.post_comments,
             li.page_month.post_reposts, li.page_month.post_clicks)
         is distinct from (excluded.ord, excluded.page_views, excluded.unique_visitors,
             excluded.new_followers, excluded.post_impressions, excluded.post_reactions,
             excluded.post_comments, excluded.post_reposts, excluded.post_clicks);
    get diagnostics k = row_count; n := n + k;
  end if;

  if p_geo is not null then
    insert into li.page_geo_month
    select * from jsonb_populate_recordset(null::li.page_geo_month,
             li.stamp(p_geo, jsonb_build_object('run_id', p_run_id)))
    on conflict (month) do update set
        ord = excluded.ord, us = excluded.us, team = excluded.team, anti = excluded.anti,
        other = excluded.other, total = excluded.total, icp_pct = excluded.icp_pct,
        anti_pct = excluded.anti_pct, run_id = p_run_id
      where (li.page_geo_month.ord, li.page_geo_month.us, li.page_geo_month.team,
             li.page_geo_month.anti, li.page_geo_month.other, li.page_geo_month.total,
             li.page_geo_month.icp_pct, li.page_geo_month.anti_pct)
         is distinct from (excluded.ord, excluded.us, excluded.team, excluded.anti,
             excluded.other, excluded.total, excluded.icp_pct, excluded.anti_pct);
    get diagnostics k = row_count; n := n + k;
  end if;

  if p_demographics is not null then
    -- Replaced as a set within the (audience, category) pairs the document
    -- asserts: a job function that has dropped out of the export must drop out
    -- of the table, or the percentages stop adding up.
    delete from li.page_demographic t
     where exists (select 1 from jsonb_to_recordset(p_demographics) as d(audience text, category text)
                    where d.audience = t.audience and d.category = t.category)
       and not exists (select 1 from jsonb_to_recordset(p_demographics) as d(audience text, category text, name text)
                        where d.audience = t.audience and d.category = t.category and d.name = t.name);
    get diagnostics k = row_count; n := n + k;

    insert into li.page_demographic
    select * from jsonb_populate_recordset(null::li.page_demographic,
             li.stamp(p_demographics, jsonb_build_object('run_id', p_run_id)))
    on conflict (audience, category, name) do update set
        value = excluded.value, cat_ord = excluded.cat_ord, row_ord = excluded.row_ord,
        run_id = p_run_id
      where (li.page_demographic.value, li.page_demographic.cat_ord, li.page_demographic.row_ord)
         is distinct from (excluded.value, excluded.cat_ord, excluded.row_ord);
    get diagnostics k = row_count; n := n + k;
  end if;

  if p_manual is not null then
    insert into li.page_manual
    select * from jsonb_populate_recordset(null::li.page_manual,
             li.stamp(jsonb_build_array(p_manual), jsonb_build_object('run_id', p_run_id, 'only_row', true)))
    on conflict (only_row) do update set
        total_followers = excluded.total_followers, last_updated = excluded.last_updated,
        geography = excluded.geography, run_id = p_run_id
      where (li.page_manual.total_followers, li.page_manual.last_updated, li.page_manual.geography)
         is distinct from (excluded.total_followers, excluded.last_updated, excluded.geography);
    get diagnostics k = row_count; n := n + k;
  end if;

  if p_search is not null then
    insert into li.page_search_week
    select * from jsonb_populate_recordset(null::li.page_search_week,
             li.stamp(p_search, jsonb_build_object('run_id', p_run_id)))
    on conflict (week) do update set searches = excluded.searches, run_id = p_run_id
      where li.page_search_week.searches is distinct from excluded.searches;
    get diagnostics k = row_count; n := n + k;
  end if;

  return n;
end $$;


-- ------------------------------------------------------- the publication gate

-- Publishing a week is a DECISION, not a write, so the writer role cannot make
-- one. It may only ASK, through this function, which hardcodes status='pending'.
-- A plain INSERT is not enough of a fence: a writer with INSERT on the table can
-- simply insert a row that already says 'published' and walk past the UPDATE
-- privilege the gate was relying on. INSERT is therefore revoked below and this
-- is the only door.
create function li.request_week(p_author text, p_week date, p_run_id uuid, p_note text default null)
returns integer language plpgsql security definer set search_path = li, pg_temp as $$
declare n integer;
begin
  insert into li.week_publication (author, week, run_id, status, decided_by, note)
  select p_author, p_week, p_run_id, 'pending', session_user, p_note
   where not exists (select 1 from li.week_publication p
                      where p.author = p_author and p.week = p_week
                        and p.status in ('pending','published'));
  get diagnostics n = row_count;
  return n;
end $$;
comment on function li.request_week is
  'The ONLY way the writer role touches li.week_publication. Status is hardcoded to pending: promoting it is an UPDATE, which only the owner may run.';

-- The third rule needs no function: it is a plain INSERT the writer may run.
--   insert into li.engagement_event (...) values (...) on conflict do nothing;
-- NEVER `do update`. An event id that already exists is never rewritten, so a
-- replayed run cannot re-date or duplicate an engagement (merge.py:272).
-- Note that ON CONFLICT DO NOTHING also gives merge.py's FIRST-wins behaviour
-- for duplicates inside one batch, which is why import.mjs does not deduplicate
-- that batch: deduplicating it last-wins would be the bug.


-- ===========================================================================
-- roles
-- ===========================================================================
--
--   li_owner   owns the two schemas and everything in them. NOLOGIN: nobody
--              connects as it. It exists so the SECURITY DEFINER functions above
--              do not execute as a superuser — a definer body can reach anything
--              its owner can, and `postgres` can reach the whole cluster.
--   li_writer  the scraper. INSERT and SELECT on li, EXECUTE on the merge
--              functions. No UPDATE, no DELETE, no TRUNCATE, and no way into
--              li.week_publication except li.request_week().
--   grafana_ro the dashboard. SELECT on dash and nothing else — it cannot see li
--              at all, so an unpublished week is not merely hidden from it, it is
--              unreachable.
--
-- All three are created WITHOUT passwords. Setting them is the operator's job
-- and belongs nowhere near a repo:
--
--   ALTER ROLE li_writer  WITH LOGIN PASSWORD '...';
--   ALTER ROLE grafana_ro WITH LOGIN PASSWORD '...';
--
-- Until then neither login role can authenticate over the network, which is the
-- desired default for a file that is committed.

do $$ begin
  if not exists (select 1 from pg_roles where rolname='li_owner')   then create role li_owner   nologin; end if;
  if not exists (select 1 from pg_roles where rolname='li_writer')  then create role li_writer  login; end if;
  if not exists (select 1 from pg_roles where rolname='grafana_ro') then create role grafana_ro login; end if;
end $$;

-- Hand everything to li_owner. This runs as the superuser applying the file;
-- ALTER ... OWNER TO needs membership in the new role, which a superuser has by
-- definition. After this, no object here is owned by a superuser.
do $$
declare r record;
begin
  execute 'alter schema li owner to li_owner';
  execute 'alter schema dash owner to li_owner';
  for r in select c.oid::regclass as rel, c.relkind
             from pg_class c join pg_namespace n on n.oid = c.relnamespace
            -- Identity sequences are not listed: they are owned BY their table and
            -- follow it, and Postgres refuses to separate them.
            where n.nspname in ('li','dash') and c.relkind in ('r','v','m')
  loop
    if r.relkind = 'v' then execute format('alter view %s owner to li_owner', r.rel);
    elsif r.relkind = 'm' then execute format('alter materialized view %s owner to li_owner', r.rel);
    else execute format('alter table %s owner to li_owner', r.rel);
    end if;
  end loop;
  for r in select p.oid::regprocedure as fn
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'li'
  loop
    execute format('alter function %s owner to li_owner', r.fn);
    -- CREATE FUNCTION grants EXECUTE to PUBLIC. On a SECURITY DEFINER function
    -- that means any role with USAGE on schema li can run the definer body and
    -- write tables it holds no privilege on. Take it back; the explicit grants
    -- below are then the only path in.
    execute format('revoke execute on function %s from public', r.fn);
  end loop;
end $$;

-- Writer: put facts in, read them back. No UPDATE, no DELETE, no TRUNCATE.
grant usage on schema li to li_writer;
grant select, insert on all tables in schema li to li_writer;
grant usage, select on all sequences in schema li to li_writer;

-- ...except the gate, which it may only knock on.
revoke insert on li.week_publication from li_writer;

grant execute on function li.upsert_post(text,uuid,jsonb)                to li_writer;
grant execute on function li.replace_post_week(text,uuid,jsonb)          to li_writer;
grant execute on function li.replace_account_week(text,uuid,jsonb)       to li_writer;
grant execute on function li.upsert_comment(text,uuid,jsonb)             to li_writer;
grant execute on function li.replace_comment_week(text,uuid,jsonb)       to li_writer;
grant execute on function li.upsert_person(text,uuid,timestamptz,text[],text[],text[],text[],timestamptz[],timestamptz[]) to li_writer;
grant execute on function li.set_person_icp(text,text[],boolean[],text[],text[],text[],timestamptz[]) to li_writer;
grant execute on function li.upsert_scan_target(text,uuid,text[],text[],text[],text[],date[],date[],bigint[]) to li_writer;
grant execute on function li.upsert_profile(uuid,jsonb)                  to li_writer;
grant execute on function li.request_week(text,date,uuid,text)           to li_writer;

-- Config and the company-page document are NOT the scraper's to rewrite: they
-- are operator inputs (scoring.json, vip-people.md) and a monthly XLS export.
-- li.set_scoring / li.set_vip / li.replace_page stay with the owner, and the
-- importer runs as the owner.

-- Grafana: the dash schema and nothing else. It cannot see li at all.
grant usage on schema dash to grafana_ro;
grant select on all tables in schema dash to grafana_ro;
revoke all on schema li from grafana_ro;

-- Views run with the owner's rights, so grafana_ro reading dash never needs li.
alter default privileges for role li_owner in schema li   grant select, insert on tables to li_writer;
alter default privileges for role li_owner in schema dash grant select on tables to grafana_ro;
