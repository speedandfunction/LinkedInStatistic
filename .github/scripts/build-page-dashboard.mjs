#!/usr/bin/env node
// Build the company-page Grafana dashboard so its FIELDS match Peter's personal
// "LinkedIn Stats" dashboard field-for-field, adapted to the company's data:
//   1. Engagement score — who engaged, weighted by tier   (Peter's signature
//      section: score last-week/all-time x normal/ICP/VIP, ICP share of
//      reactions/comments/engagement, ICP engagers, score-per-week, top
//      engagers, reactions-vs-ICP). Fed by the company's AGGREGATE engagement
//      (reaction/comment counts) — every event scores at `normal`, ICP/VIP
//      splits are 0, top-engagers is empty, because the company page has no
//      per-person data and we do NOT scrape reactors.
//   2. Company page — headline / over-time / audience demographics  (Peter's
//      Account-view fields on the company's real page metrics).
//   3. ICP geography — US vs India  (the company's real ICP signal; Peter's ICP
//      is engager-based, the company's is geography-based).
//
// Panels read LIVE from the published page-stats.json (Infinity source:"url"),
// same architecture as Peter's board — refresh + re-publish and it updates.
//
// Usage: node .github/scripts/build-page-dashboard.mjs [--out dashboards/grafana/linkedin-page.json]

import fs from 'node:fs';

const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) =>
  a.startsWith('--') ? [a.slice(2), arr[i + 1]] : [null, null]).filter(([k]) => k));
const OUT = args.out || 'dashboards/grafana/linkedin-page.json';
const STATS_URL = args.url || 'https://speedandfunction.github.io/LinkedInStatistic/page-stats.json';

const DS = { type: 'yesoreyeram-infinity-datasource', uid: 'grafanacloud-infinity' };

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
const BLUE = '#3274D9'; const DARK = '#24292e'; const GREEN = '#56A64B'; const ORANGE = '#FF9830'; const PURPLE = '#B877D9'; const TEAL = '#37A2A6';

// ===== 1. Engagement section (Peter's exact fields) =====
function scoreStat(title, gridPos, scope, field, color) {
  return {
    id: nid(), type: 'stat', title, datasource: DS, gridPos,
    fieldConfig: { defaults: { unit: 'short', decimals: 0, color: { mode: 'fixed', fixedColor: color } }, overrides: [] },
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
    fieldConfig: { defaults: { unit: 'short', decimals: 0, color: { mode: 'fixed', fixedColor: color } }, overrides: [] },
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

// ===== 2. Account view (Peter's Account-view fields, company data) =====
function stat(title, gridPos, field, color, unit = 'short') {
  return {
    id: nid(), type: 'stat', title, datasource: DS, gridPos,
    fieldConfig: { defaults: { unit, decimals: 0, color: { mode: 'fixed', fixedColor: color } }, overrides: [] },
    options: { reduceOptions: { values: false, calcs: ['lastNotNull'], fields: `/^${field}$/` }, textMode: 'value', colorMode: 'value', graphMode: 'none' },
    targets: [urlTarget('page_totals', [col('scope', 'string'), col(field, 'number')])],
  };
}
function monthlyBar(title, gridPos, keys, root = 'page_monthly', unit = 'short', stacking = 'none') {
  return {
    id: nid(), type: 'barchart', title, datasource: DS, gridPos,
    fieldConfig: { defaults: { unit, custom: { lineWidth: 1, fillOpacity: 80 } }, overrides: [] },
    options: { orientation: 'auto', showValue: 'auto', stacking, legend: { showLegend: keys.length > 1, placement: 'bottom' }, xField: 'month' },
    targets: [urlTarget(root, monthCols(keys))],
    transformations: [{ id: 'sortBy', options: { sort: [{ desc: false, field: 'month' }] } }],
  };
}
function demoBar(title, gridPos, audience, category) {
  return {
    id: nid(), type: 'barchart', title, datasource: DS, gridPos,
    fieldConfig: { defaults: { unit: 'short', color: { mode: 'continuous-BlPu' }, custom: { lineWidth: 1, fillOpacity: 80 } }, overrides: [] },
    options: { orientation: 'horizontal', showValue: 'auto', stacking: 'none', legend: { showLegend: false }, xField: 'name' },
    targets: [urlTarget('page_demographics', demoCols, `(audience == "${audience}") && (category == "${category}")`)],
    transformations: [
      { id: 'organize', options: { excludeByName: { audience: true, category: true }, indexByName: {}, renameByName: {} } },
      { id: 'sortBy', options: { sort: [{ desc: true, field: 'value' }] } },
      { id: 'limit', options: { limitField: 8 } },
    ],
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

// ===== 3. ICP geography (company's ICP dimension) =====
function icpStat(title, gridPos, audience) {
  return {
    id: nid(), type: 'stat', title, datasource: DS, gridPos,
    fieldConfig: { defaults: { unit: 'percent', decimals: 1, thresholds: { mode: 'absolute', steps: [{ color: 'red', value: null }, { color: 'orange', value: 30 }, { color: 'green', value: 50 }] } }, overrides: [] },
    options: { reduceOptions: { values: false, calcs: ['lastNotNull'], fields: '/^icp_pct$/' }, textMode: 'value', colorMode: 'value', graphMode: 'none' },
    targets: [urlTarget('page_geo_aggregate', aggCols('icp_pct'), `audience == "${audience}"`)],
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

const panels = [
  // ---- 1. Engagement score — who engaged, weighted by tier (Peter's exact) ----
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

  // ---- 2. Account view (Peter's Account-view section, on company data) ----
  { id: nid(), type: 'row', title: 'Account view', gridPos: { h: 1, w: 24, x: 0, y: 29 }, collapsed: false, panels: [] },
  stat('Followers', { h: 4, w: 5, x: 0, y: 30 }, 'total_followers', BLUE),
  stat('New followers (6 mo)', { h: 4, w: 5, x: 5, y: 30 }, 'new_followers_6mo', GREEN),
  stat('Post impressions (6 mo)', { h: 4, w: 4, x: 10, y: 30 }, 'post_impressions_6mo', TEAL),
  stat('Page views (6 mo)', { h: 4, w: 5, x: 14, y: 30 }, 'page_views_6mo', ORANGE),
  stat('Unique visitors (6 mo)', { h: 4, w: 5, x: 19, y: 30 }, 'unique_visitors_6mo', PURPLE),
  monthlyBar('New followers per month', { h: 8, w: 12, x: 0, y: 34 }, ['new_followers']),
  monthlyBar('Post impressions per month', { h: 8, w: 12, x: 12, y: 34 }, ['post_impressions']),
  monthlyBar('Page views & unique visitors', { h: 8, w: 12, x: 0, y: 42 }, ['page_views', 'unique_visitors']),
  monthlyBar('Reactions & comments per month', { h: 8, w: 12, x: 12, y: 42 }, ['post_reactions', 'post_comments']),
  table('Monthly metrics', { h: 8, w: 24, x: 0, y: 50 }),
  demoBar('Visitors — seniority', { h: 7, w: 8, x: 0, y: 58 }, 'visitors', 'Seniority'),
  demoBar('Visitors — job function', { h: 7, w: 8, x: 8, y: 58 }, 'visitors', 'Job function'),
  demoBar('Visitors — industry', { h: 7, w: 8, x: 16, y: 58 }, 'visitors', 'Industry'),
  demoBar('Visitors — location', { h: 7, w: 12, x: 0, y: 65 }, 'visitors', 'Location'),
  demoBar('Visitors — company size', { h: 7, w: 12, x: 12, y: 65 }, 'visitors', 'Company size'),
  demoBar('Followers — seniority', { h: 7, w: 8, x: 0, y: 72 }, 'followers', 'Seniority'),
  demoBar('Followers — job function', { h: 7, w: 8, x: 8, y: 72 }, 'followers', 'Job function'),
  demoBar('Followers — industry', { h: 7, w: 8, x: 16, y: 72 }, 'followers', 'Industry'),
  demoBar('Followers — location', { h: 7, w: 12, x: 0, y: 79 }, 'followers', 'Location'),
  demoBar('Followers — company size', { h: 7, w: 12, x: 12, y: 79 }, 'followers', 'Company size'),

  // ---- 3. ICP geography — US vs India (company's ICP dimension) ----
  { id: nid(), type: 'row', title: 'ICP geography — US vs India', gridPos: { h: 1, w: 24, x: 0, y: 86 }, collapsed: false, panels: [] },
  icpStat('US · ICP share — visitors (6 mo)', { h: 6, w: 6, x: 0, y: 87 }, 'visitors'),
  icpStat('US · ICP share — followers (base)', { h: 6, w: 6, x: 6, y: 87 }, 'followers'),
  bucketGauge('Visitors by ICP bucket (6 mo)', { h: 6, w: 6, x: 12, y: 87 }, 'visitors'),
  bucketGauge('Followers by ICP bucket (base)', { h: 6, w: 6, x: 18, y: 87 }, 'followers'),
  monthlyBar('US · ICP share of visitors by month', { h: 8, w: 12, x: 0, y: 93 }, ['icp_pct'], 'page_geo_monthly', 'percent'),
  monthlyBar('Visitor geography by month', { h: 8, w: 12, x: 12, y: 93 }, ['us', 'team', 'anti', 'other'], 'page_geo_monthly', 'short', 'normal'),

  { id: nid(), type: 'row', title: 'Selected month — pick $month above', gridPos: { h: 1, w: 24, x: 0, y: 101 }, collapsed: false, panels: [] },
  monthStat('US · ICP share ($month)', { h: 5, w: 6, x: 0, y: 102 }, 'icp_pct', 'percent', true),
  monthStat('India / China share ($month)', { h: 5, w: 6, x: 6, y: 102 }, 'anti_pct', 'percent'),
  monthStat('US visitors ($month)', { h: 5, w: 6, x: 12, y: 102 }, 'us', 'short'),
  monthStat('India / China visitors ($month)', { h: 5, w: 6, x: 18, y: 102 }, 'anti', 'short'),
];

// $month picker built from the published geo months.
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
