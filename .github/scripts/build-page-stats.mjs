#!/usr/bin/env node
// Flatten the company-page data (monthly.json + geo-monthly.json) into a single
// page-stats.json that Grafana reads over HTTP via the Infinity datasource —
// the same "publish one JSON to Pages, dashboard reads the URL" shape Peter's
// stats.json uses. This decouples data from the dashboard: refresh the data,
// re-publish, and the dashboard updates on its own (no re-import).
//
// Sections (each a flat array Infinity queries with a root_selector):
//   page_monthly            per-month page metrics
//   page_geo_monthly        per-month ICP-geography buckets (+ $month filter)
//   page_geo_aggregate      last-6-months visitor buckets + follower base
//   page_demographics       12-month audience demographics (long form)
//
// Usage: node .github/scripts/build-page-stats.mjs [--out pages-dist/page-stats.json]

import fs from 'node:fs';
import path from 'node:path';
import { buildEngagement } from './lib/engagement.mjs';

const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) =>
  a.startsWith('--') ? [a.slice(2), arr[i + 1]] : [null, null]).filter(([k]) => k));
const DIR = 'dashboards/li-stats/page';
const OUT = args.out || 'pages-dist/page-stats.json';

const monthly = JSON.parse(fs.readFileSync(path.join(DIR, 'monthly.json'), 'utf8'));
const geoMonthly = JSON.parse(fs.readFileSync(path.join(DIR, 'geo-monthly.json'), 'utf8'));

const page_monthly = Object.entries(monthly.months).map(([month, m]) => ({ month, ...m }));
const page_geo_monthly = Object.entries(geoMonthly.months).map(([month, g]) => ({ month, ...g }));

// 6-month visitor aggregate = sum of the monthly buckets (Location is additive views).
const b = { us: 0, team: 0, anti: 0, other: 0 };
for (const r of page_geo_monthly) { b.us += r.us || 0; b.team += r.team || 0; b.anti += r.anti || 0; b.other += r.other || 0; }
const vTotal = b.us + b.team + b.anti + b.other;
const fol = (monthly.geography && monthly.geography.followers) || { buckets: {}, icp_pct: 0, anti_pct: 0 };
const page_geo_aggregate = [
  { audience: 'visitors', scope: 'last_6_months', us: b.us, team: b.team, anti: b.anti, other: b.other,
    icp_pct: vTotal ? Math.round((1000 * b.us) / vTotal) / 10 : 0,
    anti_pct: vTotal ? Math.round((1000 * b.anti) / vTotal) / 10 : 0 },
  { audience: 'followers', scope: 'current_base', us: fol.buckets.US || 0, team: fol.buckets.TEAM || 0,
    anti: fol.buckets.ANTI || 0, other: fol.buckets.OTHER || 0, icp_pct: fol.icp_pct || 0, anti_pct: fol.anti_pct || 0 },
];

// Demographics -> long form so one section serves every bar-gauge panel.
const page_demographics = [];
for (const [audience, key] of [['visitors', 'visitor_demographics'], ['followers', 'follower_demographics']]) {
  const groups = monthly[key] || {};
  for (const [category, rows] of Object.entries(groups)) {
    for (const [name, value] of rows) page_demographics.push({ audience, category, name, value });
  }
}

// Aggregate buckets in long form so a bar gauge (which needs rows, not columns)
// can render them, filtered by audience.
const BUCKET_LABEL = { us: 'US · ICP', team: 'Ukraine · team', anti: 'India / China · off-ICP', other: 'Other · off-target' };
const page_geo_buckets = [];
for (const row of page_geo_aggregate) {
  for (const k of ['us', 'team', 'anti', 'other']) {
    page_geo_buckets.push({ audience: row.audience, name: BUCKET_LABEL[k], value: row[k] });
  }
}

// Headline numbers for the stat tiles (mirrors Peter's Account-view stats):
// current follower base + 6-month sums of the additive monthly metrics, plus
// the latest month's values. One flat row so a stat panel reads it directly.
const sum = (k) => page_monthly.reduce((a, m) => a + (m[k] || 0), 0);
const latest = page_monthly[page_monthly.length - 1] || {};
const page_totals = [{
  scope: 'summary',
  total_followers: monthly.total_followers || 0,
  new_followers_6mo: sum('new_followers'),
  page_views_6mo: sum('page_views'),
  unique_visitors_6mo: sum('unique_visitors'),
  post_impressions_6mo: sum('post_impressions'),
  post_reactions_6mo: sum('post_reactions'),
  post_comments_6mo: sum('post_comments'),
  latest_month: latest.month || '',
  latest_page_views: latest.page_views || 0,
  latest_new_followers: latest.new_followers || 0,
  latest_post_impressions: latest.post_impressions || 0,
}];

// Engagement — the SAME fields as Peter's dashboard. Score/reactions/comments
// come from the company's real aggregate counts (normal weights: reaction 1,
// comment 5). Every field that NEEDS per-person data (ICP/VIP splits, people
// counts, ICP shares) is the literal string "???" — the company page's
// per-person breakdown has not been collected, and rendering "???" is honest
// where a zero would read as a fact.
const W = { reaction: 1, comment: 5 };
const UNK = '???';

// PER-PERSON path: when the page people-collection has run at least once,
// dashboards/li-stats/page/engagement.json holds who engaged with the page's
// posts; score it with Peter's exact math (shared lib) so the tier splits,
// ICP shares, ICP-engager count and Top engagers are REAL numbers.
const perPerson = buildEngagement({
  engagementFile: path.join(DIR, 'engagement.json'),
  scoringFile: '.claude/skills/linkedin-stats/scoring.json',
  vipFile: '.claude/skills/linkedin-stats/vip-people.md',
});

let engagement_score_totals, engagement_score_weeks, engagement_people;
if (perPerson) {
  ({ engagement_score_totals, engagement_score_weeks, engagement_people } = perPerson);
} else {
  // AGGREGATE fallback: only XLS counts exist — totals are real, tier splits
  // are unknowable, so those fields stay the literal "???".
  const engRow = (scope, week, reactions, comments) => {
    const score = reactions * W.reaction + comments * W.comment;
    return {
      scope, week,
      score, score_normal: UNK, score_icp: UNK, score_vip: UNK,
      reactions, comments, people: UNK,
      reactions_icp: UNK, comments_icp: UNK, people_icp: UNK,
      reactions_non_icp: reactions, comments_non_icp: comments,
      icp_reaction_pct: UNK, icp_comment_pct: UNK, icp_engagement_pct: UNK,
    };
  };
  engagement_score_totals = [
    engRow('last_week', latest.month || '', latest.post_reactions || 0, latest.post_comments || 0),
    engRow('all_time', '', sum('post_reactions'), sum('post_comments')),
  ];
  engagement_score_weeks = page_monthly.map((m) => {
    const score = (m.post_reactions || 0) * W.reaction + (m.post_comments || 0) * W.comment;
    return { week: `${m.month}-01`, score, reactions: m.post_reactions || 0, comments: m.post_comments || 0 };
  });
  engagement_people = [];
}

// Account-view weekly analog: cumulative follower count per month, ending at
// the current base (1362), reconstructed by subtracting later months' new
// followers. Approximation (ignores unfollows) but derived from real numbers.
const page_account_weeks = [];
{
  let cum = monthly.total_followers || 0;
  const rev = [...page_monthly].reverse();
  const rows = [];
  for (const m of rev) {
    rows.push({ week: `${m.month}-01`, followers: cum, post_impressions: m.post_impressions || 0, unique_visitors: m.unique_visitors || 0 });
    cum -= m.new_followers || 0;
  }
  page_account_weeks.push(...rows.reverse());
}

// Weekly Page-searches snapshots (admin "Search appearances" tab shows a
// rolling last-7-days figure; each collection appends one point).
const page_search_weeks = Object.entries(monthly.search_appearances || {})
  .map(([week, searches]) => ({ week, searches }))
  .sort((a, b) => a.week.localeCompare(b.week));
const latestSearch = page_search_weeks.length ? page_search_weeks[page_search_weeks.length - 1] : null;
page_totals[0].search_appearances_7d = latestSearch ? latestSearch.searches : 0;
page_totals[0].latest_unique_visitors = latest.unique_visitors || 0;

// Single-row section the "???" stat tiles read.
const unknowns = [{ v: UNK }];

const out = {
  generated_at: monthly.generated_at || null,
  total_followers: monthly.total_followers || 0,
  page_totals, page_monthly, page_geo_monthly, page_geo_aggregate, page_geo_buckets, page_demographics,
  engagement_score_totals, engagement_score_weeks, engagement_people, page_account_weeks, page_search_weeks, unknowns,
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out) + '\n');
console.error(`wrote ${OUT} — ${page_monthly.length} months, ${page_demographics.length} demo rows`);
