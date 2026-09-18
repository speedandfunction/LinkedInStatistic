#!/usr/bin/env node
// dashboards/**.json -> Postgres.
//
// It is deliberately the *same* merge semantics the live writer will use, not a
// shortcut for a bulk load, and there are three kinds of them:
//
//   APPEND-ONLY   engagement events   INSERT ... ON CONFLICT DO NOTHING
//                                     (merge.py:272 — never DO UPDATE, and never
//                                     deduplicated last-wins on the way in)
//   FROZEN FIELD  people              li.upsert_person()      first_seen_at
//                 scan targets        li.upsert_scan_target() first_scanned_week
//   REPLACED      week snapshots      li.replace_post_week() / _account_week() /
//                                     _comment_week() — merge.py:84 and :96 are
//                                     `weeks[week] = snapshot`, a plain
//                                     assignment, so a re-scrape of a week
//                                     OVERWRITES it, children and all.
//                 profile cache       li.upsert_profile()  (profile-store.mjs)
//                 config, page doc    li.set_scoring/set_vip/replace_page —
//                                     documents that are rewritten wholesale
//
// Idempotent in the strict sense: a second run over the SAME input writes no
// tuple at all (every DO UPDATE carries a `where ... is distinct from` guard).
// That is not the same as ignoring a correction — run it over a re-scraped week
// and the new numbers land.
//
//   node db/import.mjs [--dsn <url>] [--reset] [--repo <path>] [--publish] [--quiet]
//
// --reset empties every li table first. It is the only destructive flag and the
// writer role cannot do it — TRUNCATE is not granted.
// --publish promotes this run's pending weeks to `published`. Without it the
// weeks land as pending and stay invisible to Grafana until a human decides.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { pgConfig } from "./pg-config.mjs";
import { fold, foldPeople, foldTargets } from "./merge-rules.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

// numeric must come back as a string and be parsed where we want a number —
// never through pg's float8 path, which would turn 0.41 into 0.41000000000000003.
pg.types.setTypeParser(20, (v) => Number(v)); // int8 -> number (all our counts fit)

function arg(name, def = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")
    ? process.argv[i + 1] : def;
}
const flag = (name) => process.argv.includes(`--${name}`);

const DSN = arg("dsn", process.env.LI_DSN || "postgresql://postgres:devpw@localhost:55432/linkedin");
const REPO = resolve(arg("repo", join(HERE, "..")));
const QUIET = flag("quiet");
const PUBLISH = flag("publish");
const log = (...a) => { if (!QUIET) console.error(...a); };

const LI_STATS = join(REPO, "dashboards", "li-stats");
const PROFILES = join(REPO, "dashboards", "profiles");
const PAGE = join(LI_STATS, "page");
const SKILL = join(REPO, ".claude", "skills", "linkedin-stats");

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
// A file that is not there is a fact about the corpus. A file that is there and
// will not parse is a CRASHED WRITE, and importing it as `{}` would silently
// drop weeks LinkedIn will never hand back. Absent is tolerated; corrupt throws.
const tryJson = (p) => (existsSync(p) ? readJson(p) : null);

// ---------------------------------------------------------------- helpers

// ISO Monday of an instant, in UTC — the same arithmetic the scraper uses.
function mondayOf(iso) {
  const d = new Date(iso);
  const day = (d.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day))
    .toISOString().slice(0, 10);
}

// The batch folds live in db/merge-rules.mjs, next to the merge.py lines they
// come from, so they can be tested without a database connection.
//   fold()        last-wins, for rows that came out of a JSON object
//   foldPeople()  first-wins, non-empty later values only  (merge.py:243-262)
//   foldTargets() first-wins on first_scanned_week          (merge.py:311-322)
// Engagement events are NOT folded: ON CONFLICT DO NOTHING keeps the first row
// of a duplicate pair, which is merge.py:271-273.

const CHUNK = 500;

async function insertMany(client, table, columns, rows, { conflict = "do nothing" } = {}) {
  if (!rows.length) return 0;
  let total = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    const params = [];
    const tuples = slice.map((row) => {
      const ph = columns.map((c) => { params.push(row[c] === undefined ? null : row[c]); return `$${params.length}`; });
      return `(${ph.join(",")})`;
    });
    const sql = `insert into ${table} (${columns.join(",")}) values ${tuples.join(",")} on conflict ${conflict}`;
    const r = await client.query(sql, params);
    total += r.rowCount;
  }
  return total;
}

// A merge function call, chunked. Every one of them takes (…, jsonb) and returns
// the number of tuples it actually changed.
async function callMerge(client, sql, head, rows) {
  if (!rows.length) return 0;
  const fn = sql.match(/li\.[a-z_]+/)?.[0] ?? sql;
  let total = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    try {
      const r = await client.query(sql, [...head, JSON.stringify(rows.slice(i, i + CHUNK))]);
      total += Number(Object.values(r.rows[0])[0]);
    } catch (e) {
      // Which merge, and which slice — a bare Postgres message names neither.
      e.message = `${fn} [${head.join(",")}] rows ${i}..${i + CHUNK}: ${e.message}`;
      throw e;
    }
  }
  return total;
}

// ------------------------------------------------------------------ main

const pool = new pg.Pool(pgConfig(DSN, { max: 4 }));
const client = await pool.connect();
const runId = randomUUID();
const counts = {};
const bump = (k, n) => { counts[k] = (counts[k] ?? 0) + n; };

try {
  await client.query("begin");

  if (flag("reset")) {
    log("-- --reset: emptying li");
    const { rows } = await client.query(
      `select tablename from pg_tables where schemaname='li' order by tablename`);
    await client.query(`truncate ${rows.map((r) => `li.${r.tablename}`).join(",")} restart identity cascade`);
    await client.query(`insert into li.dash_config (only_row, as_of) values (true, null)`);
  }

  await client.query(
    `insert into li.import_run (run_id, source, note) values ($1,'json-import',$2)`,
    [runId, `repo=${REPO}`]);

  // ------------------------------------------------------------- authors
  const identity = readJson(join(SKILL, "profiles.json"));
  const authors = Object.entries(identity)
    .filter(([k, v]) => !k.startsWith("_") && v && typeof v === "object")
    .filter(([k]) => existsSync(join(LI_STATS, k, "account.json")))
    .map(([k, v]) => ({
      author: k, display_name: v.name, profile_slug: v.profile_slug,
      company_id: v.company_id ?? null,
      posts_cutoff: v.posts_cutoff ?? null,
    }))
    .sort((a, b) => a.author.localeCompare(b.author));
  bump("author", await insertMany(client, "li.author",
    ["author", "display_name", "profile_slug", "company_id", "posts_cutoff"], authors));

  // -------------------------------------------------------------- config
  // NOT facts. scoring.json says of itself that editing it "rescores all history
  // on the next Pages build, with no re-scrape" — so it is replaced wholesale on
  // every import, weights that vanished from the file included.
  const scoring = tryJson(join(SKILL, "scoring.json")) ?? {};
  const DEFAULT_WEIGHTS = {
    normal: { reaction: 1, comment: 5 },
    icp: { reaction: 2, comment: 10 },
    vip: { reaction: 4, comment: 20 },
  };
  const weights = { ...DEFAULT_WEIGHTS, ...(scoring.weights ?? {}) };
  const wrows = Object.entries(weights).flatMap(([tier, kinds]) =>
    Object.entries(kinds).map(([kind, points]) => ({ tier, kind, points })));
  bump("scoring", Number((await client.query(
    `select li.set_scoring($1,$2,$3::text[],$4::text[],$5::numeric[]) as n`,
    [runId, scoring.precedence ?? "max",
     wrows.map((w) => w.tier), wrows.map((w) => w.kind), wrows.map((w) => w.points)])).rows[0].n));

  // The VIP list parser, character for character as build-stats-json.mjs reads it:
  // fenced and inline code stripped first, bullets only, otherwise the file's own
  // format example parses as a real VIP (it did, on the first run of this).
  const vipKeys = (() => {
    const f = join(SKILL, "vip-people.md");
    if (!existsSync(f)) return [];
    const md = readFileSync(f, "utf8")
      .replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
    const keys = new Set();
    for (const line of md.split("\n")) {
      if (!/^\s*[-*]\s/.test(line)) continue;
      for (const m of line.matchAll(/https?:\/\/(?:[a-z0-9-]+\.)*linkedin\.com\/in\/([A-Za-z0-9\-_%.]+)/gi)) {
        const slug = m[1].replace(/\/+$/, "");
        if (/[a-z0-9]/i.test(slug)) keys.add(`in/${slug.toLowerCase()}`);
      }
    }
    return [...keys];
  })();
  bump("vip_person", Number((await client.query(
    `select li.set_vip($1,$2::text[]) as n`, [runId, vipKeys])).rows[0].n));

  // The set of (author, week) this import is allowed to REQUEST publication for.
  // Filled as the data is read, requested in one go at the end.
  const weeksSeen = new Set(); // `${author}\t${week}`
  const seeWeek = (author, week) => weeksSeen.add(`${author}\t${week}`);
  // What each author's files actually yielded, so a half-read corpus is caught
  // before it is committed rather than after Grafana has been serving it.
  const read = {};

  for (const { author } of authors) {
    const dir = join(LI_STATS, author);
    read[author] = { postWeeks: 0, accountWeeks: 0 };

    // ----------------------------------------------------------- posts
    const postRows = [];
    const postWeekRows = [];

    const files = readdirSync(join(dir, "posts")).filter((f) => f.endsWith(".json")).sort();
    for (const fname of files) {
      const d = readJson(join(dir, "posts", fname));
      postRows.push({
        post_id: String(d.id), urn: d.urn ?? "", type: d.type ?? "post",
        posted_at: d.posted_at, posted_date: d.posted_date,
        post_url: d.post_url ?? null, preview: d.preview ?? null,
        body_text: d.text ?? null, source_file: fname,
      });
      let ord = 0;
      for (const [week, snap] of Object.entries(d.weeks ?? {})) {
        seeWeek(author, week);
        read[author].postWeeks++;
        const m = snap.metrics ?? null;
        const demographics = [];
        let dimOrd = 0;
        for (const [dimension, labels] of Object.entries(snap.demographics ?? {})) {
          let labelOrd = 0;
          for (const [label, pct] of Object.entries(labels ?? {})) {
            demographics.push({ dimension, label, pct, dim_ord: dimOrd, label_ord: labelOrd++ });
          }
          dimOrd++;
        }
        let cOrd = 0;
        const comment_rows = (snap.comments ?? []).map((c) => ({
          comment_urn: c.comment_urn, ord: cOrd++,
          author_name: c.author_name ?? null, author_headline: c.author_headline ?? null,
          author_url: c.author_url ?? null, body_text: c.text ?? null,
          reactions: c.reactions ?? null, replies_count: c.replies_count ?? null,
        }));
        // null means NOT MEASURED, [] means measured-and-nobody. The roster row
        // is the "measured" fact; the person rows are its contents.
        const rosters = [], people = [];
        for (const [side, key] of [["reactor", "reactors"], ["commenter", "commenters"]]) {
          if (snap[key] == null) continue;
          rosters.push({ side });
          for (const url of snap[key]) people.push({ side, profile_url: url });
        }
        postWeekRows.push({
          post_id: String(d.id), week, ord: ord++,
          snapshot_at: snap.snapshot_at ?? null,
          has_metrics: m !== null,
          impressions: m?.impressions ?? null, members_reached: m?.members_reached ?? null,
          reactions: m?.reactions ?? null, comments: m?.comments ?? null,
          reposts: m?.reposts ?? null, saves: m?.saves ?? null, sends: m?.sends ?? null,
          profile_viewers: m?.profile_viewers ?? null,
          followers_gained: m?.followers_gained ?? null,
          engagement_rate: m?.engagement_rate ?? null,
          demographics: fold(demographics, (r) => `${r.dimension}\t${r.label}`),
          comment_rows: fold(comment_rows, (r) => r.comment_urn),
          rosters, people: fold(people, (r) => `${r.side}\t${r.profile_url}`),
        });
      }
    }

    bump("post", await callMerge(client, `select li.upsert_post($1,$2,$3::jsonb) as n`,
      [author, runId], fold(postRows, (r) => r.post_id)));
    bump("post_week", await callMerge(client, `select li.replace_post_week($1,$2,$3::jsonb) as n`,
      [author, runId], fold(postWeekRows, (r) => `${r.post_id}\t${r.week}`)));

    // --------------------------------------------------------- account
    const acct = tryJson(join(dir, "account.json")) ?? { weeks: {} };
    const acctRows = [];
    let aOrd = 0;
    for (const [week, s] of Object.entries(acct.weeks ?? {})) {
      seeWeek(author, week);
      read[author].accountWeeks++;
      const dash = s.dashboard ?? {}, c7 = s.content_7d ?? {}, aud = s.audience ?? {};
      const sa = s.search_appearances ?? {}, pv = s.profile_views ?? {};
      const demographics = [];
      let dimOrd = 0;
      for (const [dimension, labels] of Object.entries(aud.demographics ?? {})) {
        let labelOrd = 0;
        for (const [label, pct] of Object.entries(labels ?? {})) {
          demographics.push({ dimension, label, pct, dim_ord: dimOrd, label_ord: labelOrd++ });
        }
        dimOrd++;
      }
      acctRows.push({
        week, ord: aOrd++, snapshot_at: s.snapshot_at ?? null,
        dashboard_post_impressions_7d: dash.post_impressions_7d ?? null,
        dashboard_post_impressions_delta_pct_7d: dash.post_impressions_delta_pct_7d ?? null,
        dashboard_followers: dash.followers ?? null,
        dashboard_followers_delta_pct_7d: dash.followers_delta_pct_7d ?? null,
        dashboard_profile_viewers_90d: dash.profile_viewers_90d ?? null,
        dashboard_search_appearances_prev_week: dash.search_appearances_previous_week ?? null,
        content_impressions_7d: c7.impressions_7d ?? null,
        content_impressions_delta_pct: c7.impressions_delta_pct ?? null,
        content_members_reached_7d: c7.members_reached_7d ?? null,
        content_social_engagements_7d: c7.social_engagements_7d ?? null,
        content_reactions_7d: c7.reactions_7d ?? null,
        content_comments_7d: c7.comments_7d ?? null,
        content_reposts_7d: c7.reposts_7d ?? null,
        content_saves_7d: c7.saves_7d ?? null,
        content_sends_7d: c7.sends_7d ?? null,
        content_link_engagements_7d: c7.link_engagements_7d ?? null,
        audience_total_followers: aud.total_followers ?? null,
        audience_followers_delta_pct_7d: aud.followers_delta_pct_7d ?? null,
        search_all_appearances_7d: sa.all_appearances_7d ?? null,
        search_appearances_7d: sa.search_appearances_7d ?? null,
        search_profile_impressions_90d: sa.profile_engagement?.impressions_90d ?? null,
        search_profile_clicks_90d: sa.profile_engagement?.clicks_90d ?? null,
        search_profile_avg_view_time_s: sa.profile_engagement?.avg_view_time_s ?? null,
        profile_viewers_90d: pv.viewers_90d ?? null,
        profile_viewers_delta_pct_7d: pv.viewers_delta_pct_7d ?? null,
        raw: s,   // the snapshot verbatim — the escrow for columns not modelled yet
        demographics: fold(demographics, (r) => `${r.dimension}\t${r.label}`),
      });
    }
    bump("account_week", await callMerge(client, `select li.replace_account_week($1,$2,$3::jsonb) as n`,
      [author, runId], fold(acctRows, (r) => r.week)));

    // -------------------------------------------------------- comments
    const cfile = tryJson(join(dir, "comments.json")) ?? { comments: {} };
    const cRows = [], cwRows = [];
    let cOrd = 0;
    for (const [urn, e] of Object.entries(cfile.comments ?? {})) {
      cRows.push({
        comment_urn: urn, ord: cOrd++, commented_at: e.commented_at,
        verb: e.verb ?? "commented", body_text: e.text ?? null,
        comment_author_name: e.comment_author_name ?? null,
        comment_author_url: e.comment_author_url ?? null,
        post_urn: e.post_urn ?? null, post_url: e.post_url ?? null,
        post_author_name: e.post_author_name ?? null,
        post_author_url: e.post_author_url ?? null,
        permalink: e.permalink ?? null,
      });
      let wOrd = 0;
      for (const [week, s] of Object.entries(e.weeks ?? {})) {
        seeWeek(author, week);
        const rosters = [], people = [];
        for (const [side, key] of [["reactor", "reactors"], ["commenter", "commenters"]]) {
          if (s[key] == null) continue;
          rosters.push({ side });
          for (const url of s[key]) people.push({ side, profile_url: url });
        }
        cwRows.push({ comment_urn: urn, week, ord: wOrd++,
          snapshot_at: s.snapshot_at ?? null, people_only: s.people_only === true,
          reactions: s.reactions ?? null, replies_count: s.replies_count ?? null,
          impressions: s.impressions ?? null,
          rosters, people: fold(people, (r) => `${r.side}\t${r.profile_url}`) });
      }
    }
    bump("comment", await callMerge(client, `select li.upsert_comment($1,$2,$3::jsonb) as n`,
      [author, runId], fold(cRows, (r) => r.comment_urn)));
    bump("comment_week", await callMerge(client, `select li.replace_comment_week($1,$2,$3::jsonb) as n`,
      [author, runId], fold(cwRows, (r) => `${r.comment_urn}\t${r.week}`)));

    // ------------------------------------------------------ engagement
    const eng = tryJson(join(dir, "engagement.json")) ?? { people: {}, events: {}, targets: {} };

    // people — through the merge function, so first_seen_at is frozen by the
    // same code path the live writer uses.
    const people = foldPeople(Object.values(eng.people ?? {}));
    if (people.length) {
      for (const p of people) seeWeek(author, mondayOf(p.first_seen_at));
      const r = await client.query(
        `select li.upsert_person($1,$2,now(),$3::text[],$4::text[],$5::text[],$6::text[],$7::timestamptz[],$8::timestamptz[]) as n`,
        [author, runId,
         people.map((p) => p.key), people.map((p) => p.name ?? ""),
         people.map((p) => p.profile_url ?? ""), people.map((p) => p.headline ?? ""),
         people.map((p) => p.headline_seen_at ?? null),
         people.map((p) => p.first_seen_at ?? null)]);
      bump("person", r.rows[0].n);
    }
    // ICP verdicts, where a classifier has actually run. classified_at is carried
    // PER PERSON: it is what the TTL in profile-store.mjs is measured from, and
    // stamping the batch with one instant would falsify every verdict's age.
    const verdicts = people.filter((p) => p.icp && p.icp.verdict !== null && p.icp.verdict !== undefined);
    if (verdicts.length) {
      const r = await client.query(
        `select li.set_person_icp($1,$2::text[],$3::boolean[],$4::text[],$5::text[],$6::text[],$7::timestamptz[]) as n`,
        [author,
         verdicts.map((p) => p.key), verdicts.map((p) => p.icp.verdict),
         verdicts.map((p) => p.icp.reason ?? null), verdicts.map((p) => p.icp.model ?? null),
         verdicts.map((p) => p.icp.headline_hash ?? null),
         verdicts.map((p) => p.icp.classified_at ?? null)]);
      bump("person_icp", r.rows[0].n);
    }

    // events — ordered by event_id so the personAgg insertion order the reader
    // relies on (stable sort, ties keep insertion order) is reproducible.
    // NOT folded: ON CONFLICT DO NOTHING keeps the first of a duplicate pair,
    // which is merge.py:272. Folding last-wins would re-date the engagement —
    // the exact thing the append-only rule forbids.
    const evRows = Object.values(eng.events ?? {})
      .sort((a, b) => (a.event_id < b.event_id ? -1 : a.event_id > b.event_id ? 1 : 0))
      .map((e) => {
        const gate = mondayOf(e.first_seen_at);
        seeWeek(author, gate);
        return {
          author, event_id: e.event_id, kind: e.kind, target_type: e.target_type,
          target_urn: e.target_urn, target_url: e.target_url ?? null,
          person_key: e.person_key, occurred_at: e.occurred_at ?? null,
          attributed_week: e.attributed_week ?? null, backfill: !!e.backfill,
          first_seen_at: e.first_seen_at, body_text: e.text ?? null,
          gate_week: gate, run_id: runId,
        };
      });
    bump("engagement_event", await insertMany(client, "li.engagement_event",
      ["author", "event_id", "kind", "target_type", "target_urn", "target_url",
       "person_key", "occurred_at", "attributed_week", "backfill", "first_seen_at",
       "body_text", "gate_week", "run_id"], evRows, { conflict: "do nothing" }));

    // scan targets — through the merge function; first_scanned_week is frozen,
    // and it is passed SEPARATELY from last_scanned_week because in this corpus
    // 8 targets already differ on the two.
    const targets = foldTargets(Object.values(eng.targets ?? {}));
    if (targets.length) {
      for (const t of targets) { seeWeek(author, t.first_scanned_week); seeWeek(author, t.last_scanned_week); }
      const r = await client.query(
        `select li.upsert_scan_target($1,$2,$3::text[],$4::text[],$5::text[],$6::text[],$7::date[],$8::date[],$9::bigint[]) as n`,
        [author, runId, targets.map((t) => t.target_id), targets.map((t) => t.target_type),
         targets.map((t) => t.target_urn), targets.map((t) => t.target_url ?? null),
         targets.map((t) => t.first_scanned_week), targets.map((t) => t.last_scanned_week),
         targets.map((t) => t.reactor_count)]);
      bump("scan_target", r.rows[0].n);
    }
  }

  // ------------------------------------------------------ profile cache
  if (existsSync(PROFILES)) {
    const rows = readdirSync(PROFILES).filter((f) => f.endsWith(".json")).sort().map((f) => {
      const p = readJson(join(PROFILES, f));
      return {
        person_key: p.key, schema_version: p.schema ?? 1, profile_url: p.profile_url ?? null,
        name: p.name ?? null, headline: p.headline ?? null, headline_hash: p.headline_hash ?? null,
        first_seen_at: p.first_seen_at ?? null, updated_at: p.updated_at ?? null,
        scraped_at: p.scraped_at ?? null, profile_text: p.profile_text ?? null,
        icp: p.icp ?? null, source_file: f,
      };
    });
    bump("profile", await callMerge(client, `select li.upsert_profile($1,$2::jsonb) as n`,
      [runId], fold(rows, (r) => r.person_key)));
  }

  // -------------------------------------------------------- company page
  // monthly.json is COMPLETELY REWRITTEN by the parser on every run (manual.json
  // says so in its own _note), so it is replaced here, not appended to.
  const monthly = tryJson(join(PAGE, "monthly.json"));
  const geoMonthly = tryJson(join(PAGE, "geo-monthly.json"));
  const manual = tryJson(join(PAGE, "manual.json"));
  {
    let mOrd = 0, gOrd = 0;
    const months = monthly ? Object.entries(monthly.months ?? {}).map(([month, m]) => ({
      month: `${month}-01`, ord: mOrd++, page_views: m.page_views ?? null,
      unique_visitors: m.unique_visitors ?? null, new_followers: m.new_followers ?? null,
      post_impressions: m.post_impressions ?? null, post_reactions: m.post_reactions ?? null,
      post_comments: m.post_comments ?? null, post_reposts: m.post_reposts ?? null,
      post_clicks: m.post_clicks ?? null,
    })) : null;
    const demoRows = monthly ? (() => {
      const out = [];
      for (const [audience, key] of [["visitors", "visitor_demographics"], ["followers", "follower_demographics"]]) {
        let catOrd = 0;
        for (const [category, list] of Object.entries(monthly[key] ?? {})) {
          let rowOrd = 0;
          for (const [name, value] of list) out.push({ audience, category, name, value, cat_ord: catOrd, row_ord: rowOrd++ });
          catOrd++;
        }
      }
      return fold(out, (r) => `${r.audience}\t${r.category}\t${r.name}`);
    })() : null;
    const geo = geoMonthly ? Object.entries(geoMonthly.months ?? {}).map(([month, g]) => ({
      month: `${month}-01`, ord: gOrd++, us: g.us ?? null, team: g.team ?? null,
      anti: g.anti ?? null, other: g.other ?? null, total: g.total ?? null,
      icp_pct: g.icp_pct ?? null, anti_pct: g.anti_pct ?? null,
    })) : null;
    const man = manual ? {
      total_followers: manual.total_followers,
      last_updated: manual._last_updated ?? null,
      geography: manual.geography ?? {},
    } : null;
    const search = manual
      ? Object.entries(manual.search_appearances ?? {}).map(([week, searches]) => ({ week, searches }))
      : null;
    const meta = monthly ? { source: monthly.source ?? null, generated_at: monthly.generated_at ?? null } : null;
    const r = await client.query(
      `select li.replace_page($1,$2::jsonb,$3::jsonb,$4::jsonb,$5::jsonb,$6::jsonb,$7::jsonb) as n`,
      [runId, meta && JSON.stringify(meta), months && JSON.stringify(months),
       geo && JSON.stringify(geo), demoRows && JSON.stringify(demoRows),
       man && JSON.stringify(man), search && JSON.stringify(search)]);
    bump("page", Number(r.rows[0].n));
  }

  // --------------------------------------------- did we read a whole corpus?
  // A corrupt account.json now throws on parse, but a file can also be VALID and
  // truncated to `{"weeks":{}}`. Weeks are requested from posts as well, so that
  // would still have published an author with no follower history at all. Refuse.
  for (const { author } of authors) {
    const r = read[author];
    if (r.accountWeeks === 0) {
      throw new Error(
        `${author}: account.json yielded 0 weeks (posts yielded ${r.postWeeks}). ` +
        `Weekly account snapshots cannot be re-fetched from LinkedIn — refusing to ` +
        `import a partial corpus. Fix the file, or drop the author from profiles.json.`);
    }
  }

  // --------------------------------------------------------- publication
  // The importer ASKS. li.request_week() hardcodes status='pending' and is the
  // only door into li.week_publication the writer role has — it cannot insert a
  // row that already says 'published', which is how the gate stops being a gate.
  const pubRows = [...weeksSeen].map((s) => s.split("\t"))
    .sort((a, b) => (a[0] + a[1]).localeCompare(b[0] + b[1]));
  let requested = 0;
  for (const [author, week] of pubRows) {
    const r = await client.query(`select li.request_week($1,$2::date,$3,$4) as n`,
      [author, week, runId, "imported from the published JSON corpus"]);
    requested += Number(r.rows[0].n);
  }
  bump("week_publication(pending)", requested);

  // Promoting is a DECISION and belongs to the owner, not to the scraper. The
  // corpus this importer reads has already been reviewed and shipped to Pages,
  // so --publish is the operator saying exactly that, in one place.
  if (PUBLISH) {
    const r = await client.query(
      `update li.week_publication p
          set status='published', decided_at=now(), decided_by=$1, note=coalesce(p.note,'')
        where p.status='pending'
          and not exists (select 1 from li.week_publication q
                           where q.author=p.author and q.week=p.week and q.status='published')`,
      [`operator:--publish`]);
    bump("week_publication(published)", r.rowCount);
  }

  await client.query("commit");
} catch (e) {
  await client.query("rollback").catch(() => {});
  console.error("IMPORT FAILED:", e.message);
  if (e.detail) console.error("  detail:", e.detail);
  process.exitCode = 1;
  client.release();
  await pool.end();
  process.exit(1);
}

log(`run ${runId}`);
for (const [k, v] of Object.entries(counts)) log(`  ${k.padEnd(26)} ${v} row(s) written`);
const inserted = Object.values(counts).reduce((a, b) => a + b, 0);
log(inserted === 0 ? "-- nothing changed (idempotent re-run)" : `-- ${inserted} rows written`);
if (!PUBLISH) log("-- weeks are PENDING. Nothing is visible in dash until someone publishes them.");

client.release();
await pool.end();
