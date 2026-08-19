#!/usr/bin/env node
// Flattens dashboards/li-stats/{account.json, posts/*.json} into a single
// payload {posts, post_weeks, post_demographics, account_weeks, account_demographics}.
// Mirrors dashboards/observable/src/data/stats.json.ts so Observable and the
// Grafana Infinity feed share the same shape.

import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
// --li-stats points the read side at a fixture directory (scoring tests);
// CI always uses the real one.
const LI_STATS_ARG = process.argv.indexOf("--li-stats");
const LI_STATS = LI_STATS_ARG > -1 && process.argv[LI_STATS_ARG + 1]
  ? resolve(process.argv[LI_STATS_ARG + 1])
  : join(REPO_ROOT, "dashboards", "li-stats");
const POSTS_DIR = join(LI_STATS, "posts");
const ACCOUNT_FILE = join(LI_STATS, "account.json");
const COMMENTS_FILE = join(LI_STATS, "comments.json");
const ENGAGEMENT_FILE = join(LI_STATS, "engagement.json");
const SCORING_FILE = join(REPO_ROOT, ".claude", "skills", "linkedin-stats", "scoring.json");
const VIP_FILE = join(REPO_ROOT, ".claude", "skills", "linkedin-stats", "vip-people.md");

const METRIC_KEYS = [
  "impressions", "members_reached", "reactions", "comments",
  "reposts", "saves", "sends", "profile_viewers",
  "followers_gained", "engagement_rate",
];

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out" && argv[i + 1]) { out.out = argv[++i]; }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (!args.out) {
  console.error("usage: build-stats-json.mjs --out <path>");
  process.exit(2);
}

const posts = [];
const post_weeks = [];
const post_demographics = [];
const account_weeks = [];
const account_demographics = [];
const monthAgg = new Map(); // month -> {posts, reposts}
const postLatestImpressions = new Map(); // post id -> latest snapshot impressions

for (const fname of readdirSync(POSTS_DIR).filter(f => f.endsWith(".json")).sort()) {
  const d = JSON.parse(readFileSync(join(POSTS_DIR, fname), "utf8"));
  const posted_date = d.posted_date ?? "";
  const posted_month = posted_date.slice(0, 7);
  const type = d.type ?? "post";
  posts.push({
    id: d.id,
    posted_date,
    posted_month,
    type,
    preview: [...(d.preview ?? "")].slice(0, 120).join(""),  // code-point slice — a UTF-16 slice can split an emoji into a lone surrogate (invalid JSON)
    text: d.text ?? "",
    post_url: d.post_url ?? "",
  });
  let latestWeek = "";
  let latestImpressions = 0;
  for (const [week, snap] of Object.entries(d.weeks ?? {})) {
    const m = snap.metrics ?? {};
    const row = { id: d.id, week };
    for (const k of METRIC_KEYS) row[k] = m[k] ?? 0;
    post_weeks.push(row);
    for (const [dim, labels] of Object.entries(snap.demographics ?? {})) {
      for (const [label, pct] of Object.entries(labels ?? {})) {
        post_demographics.push({ id: d.id, week, dimension: dim, label, pct: Number(pct) });
      }
    }
    if (week > latestWeek) { latestWeek = week; latestImpressions = m.impressions ?? 0; }
  }
  postLatestImpressions.set(d.id, latestImpressions);
  if (posted_month) {
    const cur = monthAgg.get(posted_month) ?? { month: posted_month, posts: 0, reposts: 0, total_impressions: 0 };
    cur.posts += 1;
    if (type === "repost") cur.reposts += 1;
    cur.total_impressions += latestImpressions;
    monthAgg.set(posted_month, cur);
  }
}

const correlation_points = posts
  .filter(p => p.posted_month && monthAgg.has(p.posted_month))
  .map(p => ({
    id: p.id,
    posted_date: p.posted_date,
    posted_month: p.posted_month,
    type: p.type,
    posts_in_month: monthAgg.get(p.posted_month).posts,
    impressions: postLatestImpressions.get(p.id) ?? 0,
  }));

// OLS linear regression of impressions on posts_in_month — two endpoints for XY Chart line series.
const correlation_trend = (() => {
  const n = correlation_points.length;
  if (!n) return [];
  let sx = 0, sy = 0, sxy = 0, sx2 = 0;
  for (const p of correlation_points) {
    sx += p.posts_in_month; sy += p.impressions;
    sxy += p.posts_in_month * p.impressions;
    sx2 += p.posts_in_month * p.posts_in_month;
  }
  const denom = n * sx2 - sx * sx;
  const slope = denom ? (n * sxy - sx * sy) / denom : 0;
  const intercept = (sy - slope * sx) / n;
  const xs = correlation_points.map(p => p.posts_in_month);
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  return [
    { posts_in_month: xMin, impressions: Math.round(slope * xMin + intercept) },
    { posts_in_month: xMax, impressions: Math.round(slope * xMax + intercept) },
  ];
})();

try {
  const acct = JSON.parse(readFileSync(ACCOUNT_FILE, "utf8"));
  for (const [week, snap] of Object.entries(acct.weeks ?? {})) {
    const dash = snap.dashboard ?? {};
    const aud = snap.audience ?? {};
    account_weeks.push({
      week,
      followers: dash.followers ?? 0,
      post_impressions_7d: dash.post_impressions_7d ?? 0,
      profile_viewers_90d: dash.profile_viewers_90d ?? 0,
      search_appearances_previous_week: dash.search_appearances_previous_week ?? 0,
      followers_delta_pct_7d: aud.followers_delta_pct_7d ?? 0,
    });
    for (const [dim, labels] of Object.entries(aud.demographics ?? {})) {
      for (const [label, pct] of Object.entries(labels ?? {})) {
        account_demographics.push({ week, dimension: dim, label, pct: Number(pct) });
      }
    }
  }
} catch { /* account.json optional */ }

// Current calendar month in UTC as "YYYY-MM".
function currentMonthUTC() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

// Inclusive list of "YYYY-MM" months from start to end.
function monthRange(startMonth, endMonth) {
  const out = [];
  let [y, m] = startMonth.split("-").map(Number);
  const [ey, em] = endMonth.split("-").map(Number);
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    if (++m > 12) { m = 1; y += 1; }
  }
  return out;
}

// Fill month gaps so absent months render as an explicit 0 instead of vanishing
// from the bar charts. Spans the earliest present month through the current UTC
// month (or the latest present month, whichever is later). `zeroFor(month)`
// supplies the shape for a missing month.
function zeroFillMonths(rows, zeroFor) {
  if (!rows.length) return rows;
  const byMonth = new Map(rows.map(r => [r.month, r]));
  const months = rows.map(r => r.month).sort();
  const start = months[0];
  const end = [months[months.length - 1], currentMonthUTC()].sort().pop();
  return monthRange(start, end).map(month => byMonth.get(month) ?? zeroFor(month));
}

// Weekly sibling of zeroFillMonths: a week with no engagement must render as
// an explicit 0 in the trend, not vanish from the series.
function zeroFillWeeks(rows, zeroFor) {
  if (!rows.length) return rows;
  const byWeek = new Map(rows.map(r => [r.week, r]));
  const weeks = rows.map(r => r.week).sort();
  const out = [];
  const end = Date.parse(`${weeks[weeks.length - 1]}T00:00:00Z`);
  for (let t = Date.parse(`${weeks[0]}T00:00:00Z`); t <= end; t += 7 * 86400000) {
    const week = new Date(t).toISOString().slice(0, 10);
    out.push(byWeek.get(week) ?? zeroFor(week));
  }
  return out;
}

const posts_per_month = zeroFillMonths(
  [...monthAgg.values()]
    .map(m => ({ ...m, avg_impressions_per_post: m.posts > 0 ? Math.round(m.total_impressions / m.posts) : 0 })),
  month => ({ month, posts: 0, reposts: 0, total_impressions: 0, avg_impressions_per_post: 0 }),
);

const commentsAgg = new Map();
try {
  const c = JSON.parse(readFileSync(COMMENTS_FILE, "utf8"));
  for (const entry of Object.values(c.comments ?? {})) {
    const month = (entry.commented_at ?? "").slice(0, 7);
    if (!month) continue;
    const weeks = entry.weeks ?? {};
    const sortedWeeks = Object.keys(weeks).sort();
    const latestSnap = sortedWeeks.length ? weeks[sortedWeeks[sortedWeeks.length - 1]] : {};
    const cur = commentsAgg.get(month) ?? { month, comments_posted: 0, reactions_received: 0, impressions_received: 0 };
    cur.comments_posted += 1;
    cur.reactions_received += latestSnap.reactions ?? 0;
    cur.impressions_received += latestSnap.impressions ?? 0;
    commentsAgg.set(month, cur);
  }
} catch { /* comments.json optional */ }
const comments_per_month = zeroFillMonths(
  [...commentsAgg.values()],
  month => ({ month, comments_posted: 0, reactions_received: 0, impressions_received: 0 }),
);

// ---------------------------------------------------------------- engagement
// Who engaged, and what it is worth. Scores are DERIVED HERE, never stored:
// dashboards/li-stats/engagement.json holds raw, immutable events, and the
// weights (scoring.json) plus the hand-curated 4x list (vip-people.md) are
// applied at build time. Retuning a weight or adding a VIP therefore rescores
// the entire history on the next Pages build, with no re-scrape.
//
// Weekly rows exclude `backfill` events on purpose: a backfilled reaction is
// one LinkedIn never dated, discovered on a target's first scan, so it belongs
// to "all time" but to no particular week. See fast/people.mjs for why.

// One `- https://www.linkedin.com/in/<slug>` bullet per person.
// Fenced code blocks and inline code are stripped first, and only bullet lines
// count — otherwise the file's own format example and the sentence describing
// it get parsed as real VIPs (they did, on the first run of this).
function readVipKeys(file) {
  try {
    const md = readFileSync(file, "utf8")
      .replace(/```[\s\S]*?```/g, "")   // fenced examples
      .replace(/`[^`\n]*`/g, "");        // inline code
    const keys = new Set();
    for (const line of md.split("\n")) {
      if (!/^\s*[-*]\s/.test(line)) continue;
      for (const m of line.matchAll(/https?:\/\/(?:[a-z0-9-]+\.)*linkedin\.com\/in\/([A-Za-z0-9\-_%.]+)/gi)) {
        const slug = m[1].replace(/\/+$/, "");
        if (/[a-z0-9]/i.test(slug)) keys.add(`in/${slug.toLowerCase()}`);
      }
    }
    return keys;
  } catch { return new Set(); }
}

// Base 1/5, ICP 2x, VIP list 4x. Only a fallback — scoring.json is the knob.
const DEFAULT_WEIGHTS = {
  normal: { reaction: 1, comment: 5 },
  icp: { reaction: 2, comment: 10 },
  vip: { reaction: 4, comment: 20 },
};

function readScoring(file) {
  try {
    const cfg = JSON.parse(readFileSync(file, "utf8"));
    return { weights: { ...DEFAULT_WEIGHTS, ...(cfg.weights ?? {}) }, precedence: cfg.precedence ?? "max" };
  } catch { return { weights: DEFAULT_WEIGHTS, precedence: "max" }; }
}

const scoring = readScoring(SCORING_FILE);
const vipKeys = readVipKeys(VIP_FILE);

// Tiers a person belongs to, richest last. `normal` is always a floor so a
// tier weighted below normal can never punish the person who earned it.
function tiersFor(person, key) {
  const t = ["normal"];
  if (person?.icp?.verdict === true) t.push("icp");
  if (vipKeys.has(key)) t.push("vip");
  return t;
}

function pointsFor(tiers, kind) {
  const vals = tiers.map(t => scoring.weights[t]?.[kind] ?? 0);
  if (scoring.precedence === "max") return Math.max(...vals);
  return vals[vals.length - 1]; // priority order: vip > icp > normal
}

// One shape for a totals row, used by the real aggregation and by the
// all-zero fallback below — they must never drift apart, or a tile that reads
// a field the fallback forgot renders "No data" instead of 0.
//
// `*_icp` counts are keyed on the person's ICP verdict, NOT on their scoring
// tier: the VIP list is a separate, hand-curated axis, so a VIP who is not in
// the ICP must not inflate the ICP share. The `icp_*_pct` fields answer "how
// much of my engagement comes from the audience I am actually targeting".
const EMPTY_TOTALS = {
  scope: "", week: "",
  score: 0, score_normal: 0, score_icp: 0, score_vip: 0,
  reactions: 0, comments: 0, people: 0,
  reactions_icp: 0, comments_icp: 0, people_icp: 0,
  reactions_non_icp: 0, comments_non_icp: 0,
  icp_reaction_pct: 0, icp_comment_pct: 0, icp_engagement_pct: 0,
};

const engagement_score_weeks = [];
const engagement_score_totals = [];
const engagement_people = [];
try {
  const eng = JSON.parse(readFileSync(ENGAGEMENT_FILE, "utf8"));
  const peopleMap = eng.people ?? {};
  const events = Object.values(eng.events ?? {});

  // The most recent ISO week that is already over — the "last week" the tiles
  // report. Derived from the data, not the clock, so a delayed publish still
  // shows the week the scrape covered.
  const currentWeekMonday = (() => {
    const d = new Date();
    const day = (d.getUTCDay() + 6) % 7;
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day))
      .toISOString().slice(0, 10);
  })();
  const weeksPresent = [...new Set(events.map(e => e.attributed_week).filter(Boolean))].sort();
  const lastWeek = [...weeksPresent].reverse().find(w => w < currentWeekMonday) ?? null;

  const weekAgg = new Map();   // week -> row
  const personAgg = new Map(); // person_key -> row
  const totals = {
    all_time: { ...EMPTY_TOTALS, scope: "all_time" },
    last_week: { ...EMPTY_TOTALS, scope: "last_week" },
  };
  const allTimePeople = new Set();
  const lastWeekPeople = new Set();
  const allTimeIcpPeople = new Set();
  const lastWeekIcpPeople = new Set();

  for (const ev of events) {
    const key = ev.person_key;
    const person = peopleMap[key];
    const tiers = tiersFor(person, key);
    const tier = tiers[tiers.length - 1];
    const kind = ev.kind === "comment" ? "comment" : "reaction";
    const pts = pointsFor(tiers, kind);
    const bucket = `score_${tier}`;
    const isIcp = person?.icp?.verdict === true;
    const countField = kind === "comment" ? "comments" : "reactions";
    const icpCountField = `${countField}_icp`;

    const prow = personAgg.get(key) ?? {
      person_key: key,
      name: person?.name ?? key,
      headline: person?.headline ?? "",
      profile_url: person?.profile_url ?? "",
      tier,
      is_icp: isIcp,
      reactions: 0, comments: 0, score: 0, score_last_week: 0,
    };
    prow.tier = tier;
    prow.is_icp = isIcp;
    prow[countField] += 1;
    prow.score += pts;

    totals.all_time.score += pts;
    totals.all_time[bucket] += pts;
    totals.all_time[countField] += 1;
    allTimePeople.add(key);
    if (isIcp) { totals.all_time[icpCountField] += 1; allTimeIcpPeople.add(key); }

    if (ev.attributed_week && !ev.backfill) {
      const w = ev.attributed_week;
      const row = weekAgg.get(w) ?? {
        week: w, score: 0, score_normal: 0, score_icp: 0, score_vip: 0, reactions: 0, comments: 0,
      };
      row.score += pts;
      row[bucket] += pts;
      row[kind === "comment" ? "comments" : "reactions"] += 1;
      weekAgg.set(w, row);

      if (w === lastWeek) {
        prow.score_last_week += pts;
        totals.last_week.score += pts;
        totals.last_week[bucket] += pts;
        totals.last_week[countField] += 1;
        lastWeekPeople.add(key);
        if (isIcp) { totals.last_week[icpCountField] += 1; lastWeekIcpPeople.add(key); }
      }
    }
    personAgg.set(key, prow);
  }

  totals.all_time.people = allTimePeople.size;
  totals.last_week.people = lastWeekPeople.size;
  totals.all_time.people_icp = allTimeIcpPeople.size;
  totals.last_week.people_icp = lastWeekIcpPeople.size;
  totals.last_week.week = lastWeek ?? "";
  totals.all_time.week = "";

  // Share of engagement that came from the ICP. One decimal place: the tiles
  // read as percentages, and a raw ratio would render as 0.37.
  const pct = (n, d) => (d > 0 ? Math.round((1000 * n) / d) / 10 : 0);
  for (const t of [totals.last_week, totals.all_time]) {
    t.reactions_non_icp = t.reactions - t.reactions_icp;
    t.comments_non_icp = t.comments - t.comments_icp;
    t.icp_reaction_pct = pct(t.reactions_icp, t.reactions);
    t.icp_comment_pct = pct(t.comments_icp, t.comments);
    t.icp_engagement_pct = pct(t.reactions_icp + t.comments_icp, t.reactions + t.comments);
  }

  engagement_score_weeks.push(...zeroFillWeeks(
    [...weekAgg.values()].sort((a, b) => a.week.localeCompare(b.week)),
    week => ({ week, score: 0, score_normal: 0, score_icp: 0, score_vip: 0, reactions: 0, comments: 0 }),
  ));
  engagement_score_totals.push(totals.last_week, totals.all_time);
  engagement_people.push(...[...personAgg.values()].sort((a, b) => b.score - a.score));
} catch { /* engagement.json optional until the people phase has run once */ }

// Always emit both total rows so the score tiles read "0" rather than
// "No data" before the first people-phase run.
if (!engagement_score_totals.length) {
  for (const scope of ["last_week", "all_time"]) {
    engagement_score_totals.push({ ...EMPTY_TOTALS, scope });
  }
}

const payload = { posts, post_weeks, post_demographics, account_weeks, account_demographics, posts_per_month, comments_per_month, correlation_points, correlation_trend, engagement_score_weeks, engagement_score_totals, engagement_people };

mkdirSync(dirname(resolve(args.out)), { recursive: true });
writeFileSync(args.out, JSON.stringify(payload));

console.error(`wrote ${args.out} — posts=${posts.length} post_weeks=${post_weeks.length} post_demographics=${post_demographics.length} account_weeks=${account_weeks.length} account_demographics=${account_demographics.length} posts_per_month=${posts_per_month.length} comments_per_month=${comments_per_month.length} correlation_points=${correlation_points.length} engagement_score_weeks=${engagement_score_weeks.length} engagement_people=${engagement_people.length} vip_list=${vipKeys.size}`);
