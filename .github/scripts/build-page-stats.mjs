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
const SKILL = '.claude/skills/linkedin-stats';

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

// Engagement — WHO engaged with the company's posts, weighted by ICP/VIP tier.
// Same three sections and identical scoring as Peter's personal dashboard; the
// only difference is the event source: engagers of the COMPANY's posts, written
// to dashboards/li-stats/page/engagement.json by the company people phase.
// Absent until that phase runs once -> the tiles render 0 (not "No data").
const { engagement_score_totals, engagement_score_weeks, engagement_people } = buildEngagement({
  engagementFile: path.join(DIR, 'engagement.json'),
  scoringFile: path.join(SKILL, 'scoring.json'),
  vipFile: path.join(SKILL, 'vip-people.md'),
});

const out = {
  generated_at: monthly.generated_at || null,
  page_monthly, page_geo_monthly, page_geo_aggregate, page_geo_buckets, page_demographics,
  engagement_score_totals, engagement_score_weeks, engagement_people,
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out) + '\n');
console.error(`wrote ${OUT} — ${page_monthly.length} months, ${page_demographics.length} demo rows`);
