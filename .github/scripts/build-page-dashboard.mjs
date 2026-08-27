#!/usr/bin/env node
// Build the company-page Grafana dashboard. It mirrors the FIELDS of Peter's
// personal "LinkedIn Stats" dashboard (the Account-view section: headline
// stats, over-time charts, audience demographics) but reads the COMPANY's data
// — there is no engager-level "engagement score / top engagers" section here,
// because that needs per-person collection the company page does not have.
// The company's ICP signal is geography (US vs India), kept as its own section.
//
// Panels read LIVE from the published page-stats.json over HTTP (Infinity
// source:"url"), same architecture as Peter's board: refresh the data + re-
// publish and the dashboard updates itself, no re-import.
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
const BLUE = '#3274D9'; const GREEN = '#56A64B'; const ORANGE = '#FF9830'; const PURPLE = '#B877D9';

// ---- headline stat (reads the single page_totals row) — mirrors Peter's
// Account-view stat tiles (Followers / Post impressions / ...).
function stat(title, gridPos, field, color, unit = 'short') {
  return {
    id: nid(), type: 'stat', title, datasource: DS, gridPos,
    fieldConfig: { defaults: { unit, decimals: 0, color: { mode: 'fixed', fixedColor: color } }, overrides: [] },
    options: { reduceOptions: { values: false, calcs: ['lastNotNull'], fields: `/^${field}$/` }, textMode: 'value', colorMode: 'value', graphMode: 'none' },
    targets: [urlTarget('page_totals', [col('scope', 'string'), col(field, 'number')])],
  };
}
// ---- monthly bar (page_monthly, x=month) — the over-time charts.
function monthlyBar(title, gridPos, keys, unit = 'short', stacking = 'none') {
  return {
    id: nid(), type: 'barchart', title, datasource: DS, gridPos,
    fieldConfig: { defaults: { unit, custom: { lineWidth: 1, fillOpacity: 80 } }, overrides: [] },
    options: { orientation: 'auto', showValue: 'auto', stacking, legend: { showLegend: keys.length > 1, placement: 'bottom' }, xField: 'month' },
    targets: [urlTarget('page_monthly', monthCols(keys))],
    transformations: [{ id: 'sortBy', options: { sort: [{ desc: false, field: 'month' }] } }],
  };
}
// ---- demographics bar (page_demographics, filtered by audience+category) —
// mirrors Peter's "Seniority / Top job titles / Top locations" barcharts.
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
// ---- ICP geography (the company's ICP dimension) ----
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
  // ---- Company page — headline (mirrors Peter's Account-view stat tiles) ----
  { id: nid(), type: 'row', title: 'Company page — headline', gridPos: { h: 1, w: 24, x: 0, y: 0 }, collapsed: false, panels: [] },
  stat('Followers', { h: 4, w: 6, x: 0, y: 1 }, 'total_followers', BLUE),
  stat('New followers (6 mo)', { h: 4, w: 6, x: 6, y: 1 }, 'new_followers_6mo', GREEN),
  stat('Page views (6 mo)', { h: 4, w: 6, x: 12, y: 1 }, 'page_views_6mo', ORANGE),
  stat('Unique visitors (6 mo)', { h: 4, w: 6, x: 18, y: 1 }, 'unique_visitors_6mo', PURPLE),

  // ---- Over time (monthly) — mirrors Peter's Account-view timeseries ----
  { id: nid(), type: 'row', title: 'Over time (monthly)', gridPos: { h: 1, w: 24, x: 0, y: 5 }, collapsed: false, panels: [] },
  monthlyBar('New followers per month', { h: 8, w: 12, x: 0, y: 6 }, ['new_followers']),
  monthlyBar('Post impressions per month', { h: 8, w: 12, x: 12, y: 6 }, ['post_impressions']),
  monthlyBar('Page views & unique visitors', { h: 8, w: 12, x: 0, y: 14 }, ['page_views', 'unique_visitors']),
  monthlyBar('Reactions & comments per month', { h: 8, w: 12, x: 12, y: 14 }, ['post_reactions', 'post_comments']),
  table('Monthly metrics', { h: 8, w: 24, x: 0, y: 22 }),

  // ---- Audience — visitors (mirrors Peter's demographics barcharts) ----
  { id: nid(), type: 'row', title: 'Audience — visitors (12-month)', gridPos: { h: 1, w: 24, x: 0, y: 30 }, collapsed: false, panels: [] },
  demoBar('Seniority', { h: 7, w: 8, x: 0, y: 31 }, 'visitors', 'Seniority'),
  demoBar('Job function', { h: 7, w: 8, x: 8, y: 31 }, 'visitors', 'Job function'),
  demoBar('Industry', { h: 7, w: 8, x: 16, y: 31 }, 'visitors', 'Industry'),
  demoBar('Location', { h: 7, w: 12, x: 0, y: 38 }, 'visitors', 'Location'),
  demoBar('Company size', { h: 7, w: 12, x: 12, y: 38 }, 'visitors', 'Company size'),

  // ---- Audience — followers ----
  { id: nid(), type: 'row', title: 'Audience — followers (base)', gridPos: { h: 1, w: 24, x: 0, y: 45 }, collapsed: false, panels: [] },
  demoBar('Seniority', { h: 7, w: 8, x: 0, y: 46 }, 'followers', 'Seniority'),
  demoBar('Job function', { h: 7, w: 8, x: 8, y: 46 }, 'followers', 'Job function'),
  demoBar('Industry', { h: 7, w: 8, x: 16, y: 46 }, 'followers', 'Industry'),
  demoBar('Location', { h: 7, w: 12, x: 0, y: 53 }, 'followers', 'Location'),
  demoBar('Company size', { h: 7, w: 12, x: 12, y: 53 }, 'followers', 'Company size'),

  // ---- ICP geography (the company's ICP dimension: US vs India) ----
  { id: nid(), type: 'row', title: 'ICP geography — US vs India', gridPos: { h: 1, w: 24, x: 0, y: 60 }, collapsed: false, panels: [] },
  icpStat('US · ICP share — visitors (6 mo)', { h: 6, w: 6, x: 0, y: 61 }, 'visitors'),
  icpStat('US · ICP share — followers (base)', { h: 6, w: 6, x: 6, y: 61 }, 'followers'),
  bucketGauge('Visitors by ICP bucket (6 mo)', { h: 6, w: 6, x: 12, y: 61 }, 'visitors'),
  bucketGauge('Followers by ICP bucket (base)', { h: 6, w: 6, x: 18, y: 61 }, 'followers'),
  monthlyBar('US · ICP share of visitors by month', { h: 8, w: 12, x: 0, y: 67 }, ['icp_pct'], 'percent'),
  monthlyBar('Visitor geography by month', { h: 8, w: 12, x: 12, y: 67 }, ['us', 'team', 'anti', 'other'], 'short', 'normal'),

  { id: nid(), type: 'row', title: 'Selected month — pick $month above', gridPos: { h: 1, w: 24, x: 0, y: 75 }, collapsed: false, panels: [] },
  monthStat('US · ICP share ($month)', { h: 5, w: 6, x: 0, y: 76 }, 'icp_pct', 'percent', true),
  monthStat('India / China share ($month)', { h: 5, w: 6, x: 6, y: 76 }, 'anti_pct', 'percent'),
  monthStat('US visitors ($month)', { h: 5, w: 6, x: 12, y: 76 }, 'us', 'short'),
  monthStat('India / China visitors ($month)', { h: 5, w: 6, x: 18, y: 76 }, 'anti', 'short'),
];

// Fix the ICP-geography by-month barcharts: page_geo_monthly is the source, not
// page_monthly. Re-point those two panels (icp_pct + us/team/anti/other).
for (const p of panels) {
  if (p.title === 'US · ICP share of visitors by month' || p.title === 'Visitor geography by month') {
    p.targets[0].root_selector = 'page_geo_monthly';
  }
}

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
