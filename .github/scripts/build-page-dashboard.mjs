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

const panels = [
  { id: nid(), type: 'row', title: 'ICP geography (visitors · last 6 months)', gridPos: { h: 1, w: 24, x: 0, y: 0 }, collapsed: false, panels: [] },
  icpStat('US · ICP share — visitors (6 mo)', { h: 6, w: 6, x: 0, y: 1 }, 'visitors'),
  icpStat('US · ICP share — followers (base)', { h: 6, w: 6, x: 6, y: 1 }, 'followers'),
  bucketGauge('Visitors by ICP bucket (6 mo)', { h: 6, w: 6, x: 12, y: 1 }, 'visitors'),
  bucketGauge('Followers by ICP bucket (base)', { h: 6, w: 6, x: 18, y: 1 }, 'followers'),
  barchart('US · ICP share of visitors by month', { h: 8, w: 12, x: 0, y: 7 }, ['icp_pct'], 'percent'),
  barchart('Visitor geography by month', { h: 8, w: 12, x: 12, y: 7 }, ['us', 'team', 'anti', 'other'], 'short', 'normal'),

  { id: nid(), type: 'row', title: 'Selected month — pick $month above', gridPos: { h: 1, w: 24, x: 0, y: 15 }, collapsed: false, panels: [] },
  monthStat('US · ICP share ($month)', { h: 5, w: 6, x: 0, y: 16 }, 'icp_pct', 'percent', true),
  monthStat('India / China share ($month)', { h: 5, w: 6, x: 6, y: 16 }, 'anti_pct', 'percent'),
  monthStat('US visitors ($month)', { h: 5, w: 6, x: 12, y: 16 }, 'us', 'short'),
  monthStat('India / China visitors ($month)', { h: 5, w: 6, x: 18, y: 16 }, 'anti', 'short'),

  { id: nid(), type: 'row', title: 'Company Page — monthly', gridPos: { h: 1, w: 24, x: 0, y: 21 }, collapsed: false, panels: [] },
  metricBarchart('Page views & unique visitors', { h: 8, w: 12, x: 0, y: 22 }, ['page_views', 'unique_visitors']),
  metricBarchart('New followers', { h: 8, w: 6, x: 12, y: 22 }, ['new_followers']),
  metricBarchart('Post impressions', { h: 8, w: 6, x: 18, y: 22 }, ['post_impressions']),
  table('Monthly metrics', { h: 8, w: 24, x: 0, y: 30 }),

  { id: nid(), type: 'row', title: 'Audience (12-month snapshot)', gridPos: { h: 1, w: 24, x: 0, y: 38 }, collapsed: false, panels: [] },
  demoGauge('Visitors by seniority', { h: 8, w: 12, x: 0, y: 39 }, 'visitors', 'Seniority'),
  demoGauge('Visitors by industry', { h: 8, w: 12, x: 12, y: 39 }, 'visitors', 'Industry'),
  demoGauge('Followers by seniority', { h: 8, w: 12, x: 0, y: 47 }, 'followers', 'Seniority'),
  demoGauge('Followers by industry', { h: 8, w: 12, x: 12, y: 47 }, 'followers', 'Industry'),
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
