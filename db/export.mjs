#!/usr/bin/env node
// The database, shaped back into the JSON the dashboards already read.
//
// Reads ONLY the `dash` schema — the same surface Grafana is granted — so if
// this produces the right bytes, a Grafana datasource pointed at `dash` has
// everything it needs and `li` can stay private.
//
//   node db/export.mjs --author peter --out /tmp/li-export/peter/stats.json
//   node db/export.mjs --page            --out /tmp/li-export/page-stats.json
//   node db/export.mjs --all             --out-dir /tmp/li-export/
//   [--now 2026-09-17T12:00:00Z]   pin the clock (see below)
//
// --out / --out-dir are REQUIRED and have no default. The output contains 720
// named people with their headlines and profile URLs — the exact payload this
// migration exists to get OUT of a public git repo — and a default like
// `peter-stats.json` writes it into whatever directory you happen to be
// standing in, which is usually the repo root. Write it outside the tree.
//
// THE CLOCK. build-stats-json.mjs consults it in exactly two places:
//   * zeroFillMonths() extends the month series to currentMonthUTC(), so the
//     tail of posts_per_month / comments_per_month depends on today's date;
//   * the engagement block picks `lastWeek` as the latest attributed week that
//     is strictly before currentWeekMonday().
// Both are reproduced here by li.as_of(), which --now pins. Without pinning,
// a parity run straddling midnight UTC would diff for no reason.

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import pg from "pg";

import { pgConfig } from "./pg-config.mjs";
// numeric -> Number, exactly as the reader's Number(pct) does. NOT via float8:
// the whole point of storing these as numeric is that 0.41 stays 0.41.
pg.types.setTypeParser(1700, (v) => Number(v));
pg.types.setTypeParser(20, (v) => Number(v));   // int8

function arg(name, def = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")
    ? process.argv[i + 1] : def;
}
const flag = (n) => process.argv.includes(`--${n}`);

const DSN = arg("dsn", process.env.LI_DSN || "postgresql://postgres:devpw@localhost:55432/linkedin");

export async function openDb(dsn = DSN, now = null) {
  const pool = new pg.Pool(pgConfig(dsn, { max: 2 }));
  const c = await pool.connect();
  // Pinning the clock is a write to li.dash_config, so it is the owner's job,
  // not Grafana's. Views read it through li.as_of().
  await c.query("update li.dash_config set as_of = $1", [now]);
  return {
    q: async (sql, params = []) => (await c.query(sql, params)).rows,
    close: async () => { c.release(); await pool.end(); },
  };
}

const byStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------- per author

export async function buildStats(db, author) {
  const METRIC_KEYS = ["impressions", "members_reached", "reactions", "comments",
    "reposts", "saves", "sends", "profile_viewers", "followers_gained", "engagement_rate"];

  // readdirSync(POSTS_DIR).sort() is the reader's order; sort here in JS so the
  // comparison is JS's, not the database collation's.
  const postRows = (await db.q(
    `select id, posted_date, posted_month, type, preview, text, post_url, source_file
       from dash.post where author = $1`, [author]))
    .sort((a, b) => byStr(a.source_file, b.source_file));
  const posts = postRows.map(({ id, posted_date, posted_month, type, preview, text, post_url }) =>
    ({ id, posted_date, posted_month, type, preview, text, post_url }));

  const pwRows = (await db.q(
    `select id, week, impressions, members_reached, reactions, comments, reposts,
            saves, sends, profile_viewers, followers_gained, engagement_rate, ord, source_file
       from dash.post_week where author = $1`, [author]))
    .sort((a, b) => byStr(a.source_file, b.source_file) || a.ord - b.ord);
  const post_weeks = pwRows.map((r) => {
    const row = { id: r.id, week: r.week };
    for (const k of METRIC_KEYS) row[k] = r[k];
    return row;
  });

  const post_demographics = (await db.q(
    `select id, week, dimension, label, pct, dim_ord, label_ord, week_ord, source_file
       from dash.post_demographic where author = $1`, [author]))
    .sort((a, b) => byStr(a.source_file, b.source_file) || a.week_ord - b.week_ord
                 || a.dim_ord - b.dim_ord || a.label_ord - b.label_ord)
    .map(({ id, week, dimension, label, pct }) => ({ id, week, dimension, label, pct }));

  const account_weeks = (await db.q(
    `select week, followers, post_impressions_7d, profile_viewers_90d,
            search_appearances_previous_week, followers_delta_pct_7d, ord
       from dash.account_week where author = $1 order by ord`, [author]))
    .map(({ week, followers, post_impressions_7d, profile_viewers_90d,
            search_appearances_previous_week, followers_delta_pct_7d }) =>
      ({ week, followers, post_impressions_7d, profile_viewers_90d,
         search_appearances_previous_week, followers_delta_pct_7d }));

  const account_demographics = (await db.q(
    `select week, dimension, label, pct
       from dash.account_demographic where author = $1
      order by week_ord, dim_ord, label_ord`, [author]));

  const posts_per_month = await db.q(
    `select month, posts, reposts, total_impressions, avg_impressions_per_post
       from dash.posts_per_month where author = $1 order by month`, [author]);

  const comments_per_month = await db.q(
    `select month, comments_posted, reactions_received, impressions_received
       from dash.comments_per_month where author = $1 order by month`, [author]);

  const correlation_points = (await db.q(
    `select id, posted_date, posted_month, type, posts_in_month, impressions, source_file
       from dash.correlation_point where author = $1`, [author]))
    .sort((a, b) => byStr(a.source_file, b.source_file))
    .map(({ id, posted_date, posted_month, type, posts_in_month, impressions }) =>
      ({ id, posted_date, posted_month, type, posts_in_month, impressions }));

  const correlation_trend = (await db.q(
    `select posts_in_month, impressions from dash.correlation_trend
      where author = $1 order by endpoint`, [author]))
    .map(({ posts_in_month, impressions }) => ({ posts_in_month, impressions }));

  const engagement_score_weeks = await db.q(
    `select week, score, score_normal, score_icp, score_vip, reactions, comments
       from dash.engagement_score_week where author = $1 order by week_date`, [author]);

  // Shape shared by the real aggregation and the all-zero fallback. They must
  // never drift: a tile reading a field the fallback forgot renders "No data"
  // instead of 0.
  const EMPTY_TOTALS = {
    scope: "", week: "",
    score: 0, score_normal: 0, score_icp: 0, score_vip: 0,
    reactions: 0, comments: 0, people: 0,
    reactions_icp: 0, comments_icp: 0, people_icp: 0,
    reactions_non_icp: 0, comments_non_icp: 0,
    icp_reaction_pct: 0, icp_comment_pct: 0, icp_engagement_pct: 0,
  };
  // One decimal place: the tiles read as percentages, and a raw ratio would
  // render as 0.37.
  const pct = (n, d) => (d > 0 ? Math.round((1000 * n) / d) / 10 : 0);

  const totalRows = await db.q(
    `select scope, week, score, score_normal, score_icp, score_vip, reactions, comments,
            people, reactions_icp, comments_icp, people_icp
       from dash.engagement_total where author = $1`, [author]);
  const byScope = Object.fromEntries(totalRows.map((r) => [r.scope, r]));
  const engagement_score_totals = ["last_week", "all_time"].map((scope) => {
    const r = byScope[scope];
    if (!r) return { ...EMPTY_TOTALS, scope };
    const t = { ...EMPTY_TOTALS, ...r, scope };
    t.reactions_non_icp = t.reactions - t.reactions_icp;
    t.comments_non_icp = t.comments - t.comments_icp;
    t.icp_reaction_pct = pct(t.reactions_icp, t.reactions);
    t.icp_comment_pct = pct(t.comments_icp, t.comments);
    t.icp_engagement_pct = pct(t.reactions_icp + t.comments_icp, t.reactions + t.comments);
    return t;
  });

  // Ties keep insertion order in the reader, and insertion order is the order
  // each person's FIRST event appears in an event_id-sorted list.
  const engagement_people = (await db.q(
    `select person_key, name, headline, profile_url, tier, is_icp,
            reactions, comments, score, score_last_week, first_event_id
       from dash.engagement_person where author = $1`, [author]))
    .sort((a, b) => (b.score - a.score) || byStr(a.first_event_id, b.first_event_id))
    .map(({ person_key, name, headline, profile_url, tier, is_icp,
            reactions, comments, score, score_last_week }) =>
      ({ person_key, name, headline, profile_url, tier, is_icp,
         reactions, comments, score, score_last_week }));

  return { posts, post_weeks, post_demographics, account_weeks, account_demographics,
           posts_per_month, comments_per_month, correlation_points, correlation_trend,
           engagement_score_weeks, engagement_score_totals, engagement_people };
}

// ------------------------------------------------------------ the page

export async function buildPageStats(db) {
  const meta = (await db.q(`select source, generated_at from dash.page_meta`))[0] ?? {};
  const manual = (await db.q(`select total_followers, geography from dash.page_manual`))[0];
  if (!manual) throw new Error("li.page_manual is empty — the follower curve would be built backwards from zero");

  const page_monthly = (await db.q(
    `select month, page_views, unique_visitors, new_followers, post_impressions,
            post_reactions, post_comments, post_reposts, post_clicks
       from dash.page_month order by ord`));
  const page_geo_monthly = (await db.q(
    `select month, us, team, anti, other, icp_pct, anti_pct, total
       from dash.page_geo_month order by ord`));

  const b = { us: 0, team: 0, anti: 0, other: 0 };
  for (const r of page_geo_monthly) { b.us += r.us || 0; b.team += r.team || 0; b.anti += r.anti || 0; b.other += r.other || 0; }
  const vTotal = b.us + b.team + b.anti + b.other;
  const fol = manual.geography?.followers ?? { buckets: {}, icp_pct: 0, anti_pct: 0 };
  const page_geo_aggregate = [
    { audience: "visitors", scope: "last_6_months", us: b.us, team: b.team, anti: b.anti, other: b.other,
      icp_pct: vTotal ? Math.round((1000 * b.us) / vTotal) / 10 : 0,
      anti_pct: vTotal ? Math.round((1000 * b.anti) / vTotal) / 10 : 0 },
    { audience: "followers", scope: "current_base", us: fol.buckets?.US || 0, team: fol.buckets?.TEAM || 0,
      anti: fol.buckets?.ANTI || 0, other: fol.buckets?.OTHER || 0,
      icp_pct: fol.icp_pct || 0, anti_pct: fol.anti_pct || 0 },
  ];

  const page_demographics = await db.q(
    `select audience, category, name, value from dash.page_demographic
      order by case audience when 'visitors' then 0 else 1 end, cat_ord, row_ord`);

  const BUCKET_LABEL = { us: "US · ICP", team: "Ukraine · team", anti: "India / China · off-ICP", other: "Other · off-target" };
  const page_geo_buckets = [];
  for (const row of page_geo_aggregate) {
    for (const k of ["us", "team", "anti", "other"]) {
      page_geo_buckets.push({ audience: row.audience, name: BUCKET_LABEL[k], value: row[k] });
    }
  }

  const sum = (k) => page_monthly.reduce((a, m) => a + (m[k] || 0), 0);
  const latest = page_monthly[page_monthly.length - 1] || {};
  const page_totals = [{
    scope: "summary",
    total_followers: manual.total_followers,
    new_followers_6mo: sum("new_followers"),
    page_views_6mo: sum("page_views"),
    unique_visitors_6mo: sum("unique_visitors"),
    post_impressions_6mo: sum("post_impressions"),
    post_reactions_6mo: sum("post_reactions"),
    post_comments_6mo: sum("post_comments"),
    latest_month: latest.month || "",
    latest_page_views: latest.page_views || 0,
    latest_new_followers: latest.new_followers || 0,
    latest_post_impressions: latest.post_impressions || 0,
  }];

  // The company page's per-person engagement has never been collected (there is
  // no dashboards/li-stats/page/engagement.json), so every field that NEEDS it
  // is the literal "???" — rendering it is honest where a zero would read as a
  // fact. If that file ever appears, it wants its own author scope in `li`.
  const W = { reaction: 1, comment: 5 };
  const UNK = "???";
  const engRow = (scope, week, reactions, comments) => ({
    scope, week,
    score: reactions * W.reaction + comments * W.comment,
    score_normal: UNK, score_icp: UNK, score_vip: UNK,
    reactions, comments, people: UNK,
    reactions_icp: UNK, comments_icp: UNK, people_icp: UNK,
    reactions_non_icp: reactions, comments_non_icp: comments,
    icp_reaction_pct: UNK, icp_comment_pct: UNK, icp_engagement_pct: UNK,
  });
  const engagement_score_totals = [
    engRow("last_week", latest.month || "", latest.post_reactions || 0, latest.post_comments || 0),
    engRow("all_time", "", sum("post_reactions"), sum("post_comments")),
  ];
  const engagement_score_weeks = page_monthly.map((m) => ({
    week: `${m.month}-01`,
    score: (m.post_reactions || 0) * W.reaction + (m.post_comments || 0) * W.comment,
    reactions: m.post_reactions || 0, comments: m.post_comments || 0,
  }));
  const engagement_people = [];

  // Cumulative follower count per month, ending at the current base and
  // reconstructed by subtracting later months' new followers. Approximate
  // (ignores unfollows) but derived from real numbers.
  const page_account_weeks = [];
  {
    let cum = manual.total_followers;
    const rows = [];
    for (const m of [...page_monthly].reverse()) {
      rows.push({ week: `${m.month}-01`, followers: cum,
        post_impressions: m.post_impressions || 0, unique_visitors: m.unique_visitors || 0 });
      cum -= m.new_followers || 0;
    }
    page_account_weeks.push(...rows.reverse());
  }

  const page_search_weeks = (await db.q(
    `select week, searches from dash.page_search_week order by week_date`));
  page_totals[0].search_appearances_7d = page_search_weeks.length
    ? page_search_weeks[page_search_weeks.length - 1].searches : 0;
  page_totals[0].latest_unique_visitors = latest.unique_visitors || 0;

  return {
    generated_at: meta.generated_at ? meta.generated_at.toISOString().replace(/\.\d{3}Z$/, "Z") : null,
    total_followers: manual.total_followers,
    page_totals, page_monthly, page_geo_monthly, page_geo_aggregate, page_geo_buckets,
    page_demographics, engagement_score_totals, engagement_score_weeks, engagement_people,
    page_account_weeks, page_search_weeks, unknowns: [{ v: UNK }],
  };
}

export async function listAuthors(db) {
  return (await db.q(`select author from li.author order by author`)).map((r) => r.author);
}

// ---------------------------------------------------------------- cli

const isMain = process.argv[1] && resolve(process.argv[1]).endsWith("export.mjs");
if (isMain) {
  const db = await openDb(DSN, arg("now", null));
  const write = (p, obj, nl = "") => {
    mkdirSync(dirname(resolve(p)), { recursive: true });
    writeFileSync(p, JSON.stringify(obj) + nl);
    console.error(`wrote ${p}`);
  };
  const usage = () => {
    console.error("usage: export.mjs --author <name> --out <path>");
    console.error("       export.mjs --page          --out <path>");
    console.error("       export.mjs --all           --out-dir <dir>");
    console.error("");
    console.error("--out / --out-dir are required. The output names real people;");
    console.error("write it outside the repo, e.g. --out-dir /tmp/li-export/");
    process.exit(2);
  };
  if (flag("all")) {
    const outDir = arg("out-dir");
    if (!outDir) usage();
    for (const a of await listAuthors(db)) write(join(outDir, a, "stats.json"), await buildStats(db, a));
    write(join(outDir, "page-stats.json"), await buildPageStats(db), "\n");
  } else if (flag("page")) {
    const out = arg("out");
    if (!out) usage();
    write(out, await buildPageStats(db), "\n");
  } else {
    const a = arg("author"), out = arg("out");
    if (!a || !out) usage();
    write(out, await buildStats(db, a));
  }
  await db.close();
}
