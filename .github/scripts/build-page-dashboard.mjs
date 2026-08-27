#!/usr/bin/env node
// Build the company-page Grafana dashboard. Panels read LIVE from the published
// page-stats.json over HTTP (Infinity source:"url") — the same architecture as
// Peter's stats.json dashboards. Refresh the data + re-publish page-stats.json
// and the dashboard updates on its own; no re-import, no embedded snapshot.
//
// Usage: node .github/scripts/build-page-dashboard.mjs [--out dashboards/grafana/linkedin-page.json]

import fs from 'node:fs';

const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) =>
  a.startsWith('--') ? [a.slice(2), arr[i + 1]] : [null, null]).filter(([k]) => k));
const OUT = args.out || 'dashboards/grafana/linkedin-page.json';
const STATS_URL = args.url || 'https://speedandfunction.github.io/LinkedInStatistic/page-stats.json';

const DS = { type: 'yesoreyeram-infinity-datasource', uid: 'grafanacloud-infinity' };

// Infinity URL target (backend parser so filterExpression applies).
function urlTarget(root, columns, filterExpression) {
  const t = {
    refId: 'A', datasource: DS, type: 'json', source: 'url', format: 'table', parser: 'backend',
    root_selector: root, url: STATS_URL, url_options: { data: '', method: 'GET' }, columns, filters: [],
  };
  if (filterExpression) t.filterExpression = filterExpression;
  return t;
}
const col = (selector, type) => ({ selector, text: selector, type });
const monthCols = (keys) => [col('month', 'string'), ...keys.map((k) => col(k, 'number'))];
const demoCols = [col('audience', 'string'), col('category', 'string'), col('name', 'string'), col('value', 'number')];
const bucketCols = [col('audience', 'string'), col('name', 'string'), col('value', 'number')];
const aggCols = (field) => [col('audience', 'string'), col(field, 'number')];

let id = 0; const nid = () => ++id;

// ---- engagement panels — the exact fields Peter's dashboard shows, wired to
// the engagement_score_* sections of page-stats.json (backend parser so the
// scope filter applies). "Who engaged with the company's posts, weighted by
// ICP/VIP tier", identical math to Peter's personal board.
const FIX = (c) => ({ color: { mode: 'fixed', fixedColor: c } });
function scoreStat(title, gridPos, scope, field, color) {
  return {
    id: nid(), type: 'stat', title, datasource: DS, gridPos,
    fieldConfig: { defaults: { unit: 'short', decimals: 0, ...FIX(color) }, overrides: [] },
    options: { reduceOptions: { values: false, calcs: ['lastNotNull'], fields: `/^${field}$/` }, textMode: 'value', colorMode: 'value', graphMode: 'none' },
    targets: [urlTarget('engagement_score_totals', [col('scope', 'string'), col(field, 'number')], `scope == "${scope}"`)],
  };
}
function pctStat(title, gridPos, scope, field) {
  return {
    id: nid(), type: 'stat', title, datasource: DS, gridPos,
    fieldConfig: { defaults: { unit: 'percent', decimals: 1, thresholds: { mode: 'absolute', steps: [{ color: 'red', value: null }, { color: 'orange', value: 15 }, { color: 'green', value: 30 }] } }, overrides: [] },
    options: { reduceOptions: { values: false, calcs: ['lastNotNull'], fields: `/^${field}$/` }, textMode: 'value', colorMode: 'value', graphMode: 'none' },
    targets: [urlTarget('engagement_score_totals', [col('scope', 'string'), col(field, 'number')], `scope == "${scope}"`)],
  };
}
function countStat(title, gridPos, scope, field, color) {
  return {
    id: nid(), type: 'stat', title, datasource: DS, gridPos,
    fieldConfig: { defaults: { unit: 'short', decimals: 0, ...FIX(color) }, overrides: [] },
    options: { reduceOptions: { values: false, calcs: ['lastNotNull'], fields: `/^${field}$/` }, textMode: 'value', colorMode: 'value', graphMode: 'none' },
    targets: [urlTarget('engagement_score_totals', [col('scope', 'string'), col(field, 'number')], `scope == "${scope}"`)],
  };
}
function weeksTs(title, gridPos) {
  return {
    id: nid(), type: 'timeseries', title, datasource: DS, gridPos,
    fieldConfig: { defaults: { custom: { drawStyle: 'line', lineInterpolation: 'smooth', fillOpacity: 20, lineWidth: 2, spanNulls: true } }, overrides: [] },
    options: { legend: { showLegend: true, placement: 'bottom', calcs: [] }, tooltip: { mode: 'multi' } },
    targets: [urlTarget('engagement_score_weeks', [col('week', 'string'), col('score', 'number'), col('score_icp', 'number')])],
    transformations: [
      { id: 'convertFieldType', options: { conversions: [{ targetField: 'week', destinationType: 'time', dateFormat: 'YYYY-MM-DD' }] } },
      { id: 'sortBy', options: { sort: [{ desc: false, field: 'week' }] } },
    ],
  };
}
function peopleTable(title, gridPos) {
  return {
    id: nid(), type: 'table', title, datasource: DS, gridPos,
    fieldConfig: { defaults: {}, overrides: [] },
    options: { showHeader: true, sortBy: [{ displayName: 'All time', desc: true }] },
    targets: [urlTarget('engagement_people', [col('name', 'string'), col('tier', 'string'), col('score_last_week', 'number'), col('score', 'number'), col('reactions', 'number'), col('comments', 'number')])],
    transformations: [
      { id: 'organize', options: { excludeByName: {}, indexByName: { name: 0, tier: 1, score_last_week: 2, score: 3, reactions: 4, comments: 5 },
        renameByName: { name: 'Person', tier: 'Tier', score_last_week: 'Last week', score: 'All time', reactions: 'reactions', comments: 'comments' } } },
      { id: 'sortBy', options: { sort: [{ desc: true, field: 'All time' }] } },
      { id: 'limit', options: { limitField: 15 } },
    ],
  };
}
function reactCommentBar(title, gridPos) {
  return {
    id: nid(), type: 'barchart', title, datasource: DS, gridPos,
    fieldConfig: { defaults: { unit: 'short', custom: { lineWidth: 1, fillOpacity: 80 } }, overrides: [] },
    options: { orientation: 'auto', showValue: 'auto', stacking: 'none', legend: { showLegend: true, placement: 'bottom' }, xField: 'scope' },
    targets: [urlTarget('engagement_score_totals', [col('scope', 'string'), col('reactions', 'number'), col('reactions_icp', 'number'), col('comments', 'number'), col('comments_icp', 'number')])],
  };
}

function barchart(title, gridPos, keys, unit = 'short', stacking = 'none') {
  return {
    id: nid(), type: 'barchart', title, datasource: DS, gridPos,
    fieldConfig: { defaults: { unit, custom: { lineWidth: 1, fillOpacity: 80 } }, overrides: [] },
    options: { orientation: 'auto', showValue: 'auto', stacking, legend: { showLegend: true, placement: 'bottom' }, xField: 'month' },
    targets: [urlTarget('page_geo_monthly', monthCols(keys))],
    transformations: [{ id: 'sortBy', options: { sort: [{ desc: false, field: 'month' }] } }],
  };
}
function metricBarchart(title, gridPos, keys) {
  return {
    id: nid(), type: 'barchart', title, datasource: DS, gridPos,
    fieldConfig: { defaults: { unit: 'short', custom: { lineWidth: 1, fillOpacity: 80 } }, overrides: [] },
    options: { orientation: 'auto', showValue: 'auto', stacking: 'none', legend: { showLegend: true, placement: 'bottom' }, xField: 'month' },
    targets: [urlTarget('page_monthly', monthCols(keys))],
    transformations: [{ id: 'sortBy', options: { sort: [{ desc: false, field: 'month' }] } }],
  };
}
function table(title, gridPos) {
  return {
    id: nid(), type: 'table', title, datasource: DS, gridPos,
    fieldConfig: { defaults: {}, overrides: [] }, options: { showHeader: true },
    targets: [urlTarget('page_monthly', monthCols(['page_views', 'unique_visitors', 'new_followers', 'post_impressions', 'post_reactions', 'post_comments', 'post_reposts', 'post_clicks']))],
    transformations: [{ id: 'sortBy', options: { sort: [{ desc: false, field: 'month' }] } }],
  };
}
function bucketGauge(title, gridPos, audience) {
  return {
    id: nid(), type: 'bargauge', title, datasource: DS, gridPos,
    fieldConfig: { defaults: { color: { mode: 'continuous-BlPu' } }, overrides: [] },
    options: { orientation: 'horizontal', displayMode: 'gradient', reduceOptions: { values: true, calcs: [], fields: '/^value$/' }, showUnfilled: true },
    targets: [urlTarget('page_geo_buckets', bucketCols, `audience == "${audience}"`)],
    transformations: [{ id: 'organize', options: { excludeByName: { audience: true }, indexByName: {}, renameByName: {} } }],
  };
}
function demoGauge(title, gridPos, audience, category) {
  return {
    id: nid(), type: 'bargauge', title, datasource: DS, gridPos,
    fieldConfig: { defaults: { color: { mode: 'continuous-BlPu' } }, overrides: [] },
    options: { orientation: 'horizontal', displayMode: 'gradient', reduceOptions: { values: true, calcs: [], fields: '/^value$/' }, showUnfilled: true },
    targets: [urlTarget('page_demographics', demoCols, `(audience == "${audience}") && (category == "${category}")`)],
    transformations: [
      { id: 'organize', options: { excludeByName: { audience: true, category: true }, indexByName: {}, renameByName: {} } },
      { id: 'sortBy', options: { sort: [{ desc: true, field: 'value' }] } },
      { id: 'limit', options: { limitField: 8 } },
    ],
  };
}
function icpStat(title, gridPos, audience) {
  return {
    id: nid(), type: 'stat', title, datasource: DS, gridPos,
    fieldConfig: { defaults: { unit: 'percent', decimals: 1, thresholds: { mode: 'absolute', steps: [{ color: 'red', value: null }, { color: 'orange', value: 30 }, { color: 'green', value: 50 }] } }, overrides: [] },
    options: { reduceOptions: { values: false, calcs: ['lastNotNull'], fields: '/^icp_pct$/' }, textMode: 'value', colorMode: 'value', graphMode: 'none' },
    targets: [urlTarget('page_geo_aggregate', aggCols('icp_pct'), `audience == "${audience}"`)],
  };
}
function monthStat(title, gridPos, field, unit, colored = false) {
  const defaults = { unit, decimals: unit === 'percent' ? 1 : 0 };
  if (colored) defaults.thresholds = { mode: 'absolute', steps: [{ color: 'red', value: null }, { color: 'orange', value: 30 }, { color: 'green', value: 50 }] };
  return {
    id: nid(), type: 'stat', title, datasource: DS, gridPos,
    fieldConfig: { defaults, overrides: [] },
    options: { reduceOptions: { values: false, calcs: ['lastNotNull'], fields: `/^${field}$/` }, textMode: 'value', colorMode: colored ? 'value' : 'none', graphMode: 'none' },
    targets: [urlTarget('page_geo_monthly', [col('month', 'string'), col(field, 'number')], 'month == "${month}"')],
  };
}

const BLUE = '#3274D9'; const DARK = '#24292e'; const GREEN = '#56A64B'; const PURPLE = '#B877D9';

const panels = [
  // ---- Engagement (Peter's exact fields), on the company's posts ----
  { id: nid(), type: 'row', title: 'Engagement score — who engaged, weighted by tier', gridPos: { h: 1, w: 24, x: 0, y: 0 }, collapsed: false, panels: [] },
  scoreStat('Engagement score (last week)', { h: 4, w: 6, x: 0, y: 1 }, 'last_week', 'score', BLUE),
  scoreStat('...from normal audience', { h: 4, w: 6, x: 6, y: 1 }, 'last_week', 'score_normal', DARK),
  scoreStat('...from ICP', { h: 4, w: 6, x: 12, y: 1 }, 'last_week', 'score_icp', GREEN),
  scoreStat('...from VIP list (4×)', { h: 4, w: 6, x: 18, y: 1 }, 'last_week', 'score_vip', PURPLE),
  scoreStat('Engagement score (all time)', { h: 4, w: 6, x: 0, y: 5 }, 'all_time', 'score', BLUE),
  scoreStat('...from normal audience', { h: 4, w: 6, x: 6, y: 5 }, 'all_time', 'score_normal', DARK),
  scoreStat('...from ICP', { h: 4, w: 6, x: 12, y: 5 }, 'all_time', 'score_icp', GREEN),
  scoreStat('...from VIP list (4×)', { h: 4, w: 6, x: 18, y: 5 }, 'all_time', 'score_vip', PURPLE),
  pctStat('ICP share of reactions (all time)', { h: 4, w: 6, x: 0, y: 9 }, 'all_time', 'icp_reaction_pct'),
  pctStat('ICP share of comments (all time)', { h: 4, w: 6, x: 6, y: 9 }, 'all_time', 'icp_comment_pct'),
  pctStat('ICP share of all engagement (all time)', { h: 4, w: 6, x: 12, y: 9 }, 'all_time', 'icp_engagement_pct'),
  countStat('ICP engagers (all time)', { h: 4, w: 6, x: 18, y: 9 }, 'all_time', 'people_icp', GREEN),
  weeksTs('Engagement score per week', { h: 8, w: 14, x: 0, y: 13 }),
  peopleTable('Top engagers', { h: 8, w: 10, x: 14, y: 13 }),
  { id: nid(), type: 'row', title: 'Reactions & comments — total vs ICP (last week and all time)', gridPos: { h: 1, w: 24, x: 0, y: 21 }, collapsed: false, panels: [] },
  reactCommentBar('Reactions & comments — total vs ICP', { h: 7, w: 24, x: 0, y: 22 }),

  // ---- Company-page geography & audience (S&F-specific, beyond Peter's board) ----
  { id: nid(), type: 'row', title: 'ICP geography (visitors · last 6 months)', gridPos: { h: 1, w: 24, x: 0, y: 29 }, collapsed: false, panels: [] },
  icpStat('US · ICP share — visitors (6 mo)', { h: 6, w: 6, x: 0, y: 30 }, 'visitors'),
  icpStat('US · ICP share — followers (base)', { h: 6, w: 6, x: 6, y: 30 }, 'followers'),
  bucketGauge('Visitors by ICP bucket (6 mo)', { h: 6, w: 6, x: 12, y: 30 }, 'visitors'),
  bucketGauge('Followers by ICP bucket (base)', { h: 6, w: 6, x: 18, y: 30 }, 'followers'),
  barchart('US · ICP share of visitors by month', { h: 8, w: 12, x: 0, y: 36 }, ['icp_pct'], 'percent'),
  barchart('Visitor geography by month', { h: 8, w: 12, x: 12, y: 36 }, ['us', 'team', 'anti', 'other'], 'short', 'normal'),

  { id: nid(), type: 'row', title: 'Selected month — pick $month above', gridPos: { h: 1, w: 24, x: 0, y: 44 }, collapsed: false, panels: [] },
  monthStat('US · ICP share ($month)', { h: 5, w: 6, x: 0, y: 45 }, 'icp_pct', 'percent', true),
  monthStat('India / China share ($month)', { h: 5, w: 6, x: 6, y: 45 }, 'anti_pct', 'percent'),
  monthStat('US visitors ($month)', { h: 5, w: 6, x: 12, y: 45 }, 'us', 'short'),
  monthStat('India / China visitors ($month)', { h: 5, w: 6, x: 18, y: 45 }, 'anti', 'short'),

  { id: nid(), type: 'row', title: 'Company Page — monthly', gridPos: { h: 1, w: 24, x: 0, y: 50 }, collapsed: false, panels: [] },
  metricBarchart('Page views & unique visitors', { h: 8, w: 12, x: 0, y: 51 }, ['page_views', 'unique_visitors']),
  metricBarchart('New followers', { h: 8, w: 6, x: 12, y: 51 }, ['new_followers']),
  metricBarchart('Post impressions', { h: 8, w: 6, x: 18, y: 51 }, ['post_impressions']),
  table('Monthly metrics', { h: 8, w: 24, x: 0, y: 59 }),

  { id: nid(), type: 'row', title: 'Audience (12-month snapshot)', gridPos: { h: 1, w: 24, x: 0, y: 67 }, collapsed: false, panels: [] },
  demoGauge('Visitors by seniority', { h: 8, w: 12, x: 0, y: 68 }, 'visitors', 'Seniority'),
  demoGauge('Visitors by industry', { h: 8, w: 12, x: 12, y: 68 }, 'visitors', 'Industry'),
  demoGauge('Followers by seniority', { h: 8, w: 12, x: 0, y: 76 }, 'followers', 'Seniority'),
  demoGauge('Followers by industry', { h: 8, w: 12, x: 12, y: 76 }, 'followers', 'Industry'),
];

// $month picker built from the published geo months (Custom var; Query type
// can't read Infinity in v0alpha1 dashboards, so the list is embedded).
const geoMonthly = JSON.parse(fs.readFileSync('dashboards/li-stats/page/geo-monthly.json', 'utf8'));
const months = Object.keys(geoMonthly.months);
const monthVar = {
  name: 'month', type: 'custom', label: 'Month',
  query: months.map((m) => `${m} : ${m}`).join(', '),
  current: months.length ? { text: months[months.length - 1], value: months[months.length - 1] } : {},
  options: months.map((m, i) => ({ text: m, value: m, selected: i === months.length - 1 })),
  includeAll: false, multi: false,
};

const dashboard = {
  uid: 'linkedin-page', title: 'LinkedIn Stats — Company Page', tags: ['linkedin', 'company-page'],
  timezone: '', schemaVersion: 42, version: 1, refresh: '', time: { from: 'now-1y', to: 'now' },
  templating: { list: months.length ? [monthVar] : [] }, annotations: { list: [] }, panels,
};
fs.writeFileSync(OUT, JSON.stringify(dashboard, null, 2) + '\n');
console.error(`wrote ${OUT} — ${panels.length} panels, url=${STATS_URL}`);
