#!/usr/bin/env node
// Build a self-contained Grafana dashboard for the company-page monthly data.
//
// Reads dashboards/li-stats/page/monthly.json and emits a dashboard JSON whose
// panels carry the data INLINE (Infinity source:"inline"), so it can be
// imported into Grafana with no hosting, no Pages, no datasource wiring beyond
// the existing `grafanacloud-infinity` Infinity datasource. This is a snapshot:
// re-run this script after a fresh page scrape to refresh the embedded data,
// then re-import. (The live-updating path is Pages + Infinity-by-URL, later.)
//
// Usage: node .github/scripts/build-page-dashboard.mjs \
//          [--in dashboards/li-stats/page/monthly.json] \
//          [--out dashboards/grafana/linkedin-page.json]

import fs from 'node:fs';

const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) =>
  a.startsWith('--') ? [a.slice(2), arr[i + 1]] : [null, null]).filter(([k]) => k));
const IN = args.in || 'dashboards/li-stats/page/monthly.json';
const GEO_IN = args.geo || 'dashboards/li-stats/page/geo-monthly.json';
const OUT = args.out || 'dashboards/grafana/linkedin-page.json';

const src = JSON.parse(fs.readFileSync(IN, 'utf8'));
const months = Object.entries(src.months).map(([month, m]) => ({ month, ...m }));
// Monthly ICP-geography trend (one Visitors export per calendar month).
const geoMonthly = fs.existsSync(GEO_IN)
  ? Object.entries(JSON.parse(fs.readFileSync(GEO_IN, 'utf8')).months).map(([month, g]) => ({ month, ...g }))
  : [];
// 6-month VISITOR geography = sum of the monthly exports (Location is additive
// "total views"), so the headline matches the rest of the 6-month dashboard.
const vis6 = (() => {
  const b = { US: 0, TEAM: 0, ANTI: 0, OTHER: 0 };
  for (const r of geoMonthly) { b.US += r.us || 0; b.TEAM += r.team || 0; b.ANTI += r.anti || 0; b.OTHER += r.other || 0; }
  const total = b.US + b.TEAM + b.ANTI + b.OTHER;
  return { buckets: b, icp_pct: total ? Math.round((1000 * b.US) / total) / 10 : 0 };
})();

const DS = { type: 'yesoreyeram-infinity-datasource', uid: 'grafanacloud-infinity' };

// Infinity inline target: data embedded as a JSON string, parsed client-side.
function inlineTarget(rows, columns, refId = 'A') {
  return {
    refId,
    datasource: DS,
    type: 'json',
    source: 'inline',
    format: 'table',
    parser: 'simple',
    root_selector: '',
    data: JSON.stringify(rows),
    columns,
    filters: [],
  };
}
// Backend-parser inline target that honours a filterExpression on the `month`
// column — the ONLY way an inline panel responds to the $month variable
// (parser:'simple' ignores filterExpression; parser:'backend' applies it).
function filteredTarget(rows, keys, filterExpression, refId = 'A') {
  return {
    refId, datasource: DS, type: 'json', source: 'inline', format: 'table',
    parser: 'backend', root_selector: '', data: JSON.stringify(rows),
    columns: [{ selector: 'month', text: 'month', type: 'string' },
      ...keys.map((k) => ({ selector: k, text: k, type: 'number' }))],
    filters: [], filterExpression,
  };
}
const numCols = (keys) => [{ selector: 'month', text: 'month', type: 'string' },
  ...keys.map((k) => ({ selector: k, text: k, type: 'number' }))];
const demoCols = [{ selector: 'name', text: 'name', type: 'string' },
  { selector: 'value', text: 'value', type: 'number' }];

let id = 0;
const nid = () => ++id;

function barchart(title, gridPos, keys, unit = 'short') {
  return {
    id: nid(), type: 'barchart', title, datasource: DS, gridPos,
    fieldConfig: { defaults: { unit, custom: { lineWidth: 1, fillOpacity: 80 } }, overrides: [] },
    options: { orientation: 'auto', xTickLabelRotation: 0, showValue: 'auto', stacking: 'none', legend: { showLegend: true, placement: 'bottom' } },
    targets: [inlineTarget(months, numCols(keys))],
  };
}
function table(title, gridPos) {
  return {
    id: nid(), type: 'table', title, datasource: DS, gridPos,
    fieldConfig: { defaults: {}, overrides: [] }, options: { showHeader: true },
    targets: [inlineTarget(months, numCols(['page_views', 'unique_visitors', 'new_followers', 'post_impressions', 'post_reactions', 'post_comments', 'post_reposts', 'post_clicks']))],
  };
}
function bargauge(title, gridPos, rows) {
  return {
    id: nid(), type: 'bargauge', title, datasource: DS, gridPos,
    fieldConfig: { defaults: { color: { mode: 'continuous-BlPu' } }, overrides: [] },
    options: { orientation: 'horizontal', displayMode: 'gradient', reduceOptions: { values: true, calcs: [], fields: '/^value$/' }, showUnfilled: true },
    targets: [inlineTarget(rows, demoCols)],
  };
}
// ICP share as a coloured stat: green above target, red below.
function icpStat(title, gridPos, pct) {
  return {
    id: nid(), type: 'stat', title, datasource: DS, gridPos,
    fieldConfig: { defaults: { unit: 'percent', decimals: 1, min: 0, max: 100, thresholds: {
      mode: 'absolute', steps: [{ color: 'red', value: null }, { color: 'orange', value: 30 }, { color: 'green', value: 50 }] } }, overrides: [] },
    options: { reduceOptions: { values: false, calcs: ['lastNotNull'], fields: '/^v$/' }, textMode: 'value', colorMode: 'value', graphMode: 'none' },
    targets: [inlineTarget([{ v: pct }], [{ selector: 'v', text: 'v', type: 'number' }])],
  };
}

// Stat for the $month-selected value (filtered inline via backend parser).
function monthStat(title, gridPos, field, unit, colored = false) {
  const defaults = { unit, decimals: unit === 'percent' ? 1 : 0 };
  if (colored) defaults.thresholds = { mode: 'absolute',
    steps: [{ color: 'red', value: null }, { color: 'orange', value: 30 }, { color: 'green', value: 50 }] };
  return {
    id: nid(), type: 'stat', title, datasource: DS, gridPos,
    fieldConfig: { defaults, overrides: [] },
    options: { reduceOptions: { values: false, calcs: ['lastNotNull'], fields: `/^${field}$/` },
      textMode: 'value', colorMode: colored ? 'value' : 'none', graphMode: 'none' },
    targets: [filteredTarget(geoMonthly, [field], 'month == "${month}"')],
  };
}

const demoRows = (obj, cat) => (obj[cat] || []).map(([name, value]) => ({ name, value }));
const geo = src.geography || { visitors: { buckets: {}, icp_pct: 0 }, followers: { buckets: {}, icp_pct: 0 } };
const BUCKET_LABEL = { US: 'US · ICP', TEAM: 'Ukraine · team', ANTI: 'India / China · off-ICP', OTHER: 'Other · off-target' };
const geoRows = (b) => ['US', 'TEAM', 'ANTI', 'OTHER'].map((k) => ({ name: BUCKET_LABEL[k], value: (b || {})[k] || 0 }));

// Generic barchart over an explicit data array (used for the monthly geo trend).
function barchartData(title, gridPos, data, keys, unit = 'short', stacking = 'none') {
  return {
    id: nid(), type: 'barchart', title, datasource: DS, gridPos,
    fieldConfig: { defaults: { unit, custom: { lineWidth: 1, fillOpacity: 80 } }, overrides: [] },
    options: { orientation: 'auto', xTickLabelRotation: 0, showValue: 'auto', stacking, legend: { showLegend: true, placement: 'bottom' } },
    targets: [inlineTarget(data, [{ selector: 'month', text: 'month', type: 'string' }, ...keys.map((k) => ({ selector: k, text: k, type: 'number' }))])],
  };
}

const panels = [
  { id: nid(), type: 'row', title: 'ICP geography (visitors · last 6 months)', gridPos: { h: 1, w: 24, x: 0, y: 0 }, collapsed: false, panels: [] },
  icpStat('US · ICP share — visitors (6 mo)', { h: 6, w: 6, x: 0, y: 1 }, vis6.icp_pct),
  icpStat('US · ICP share — followers (base)', { h: 6, w: 6, x: 6, y: 1 }, geo.followers.icp_pct),
  bargauge('Visitors by ICP bucket (6 mo)', { h: 6, w: 6, x: 12, y: 1 }, geoRows(vis6.buckets)),
  bargauge('Followers by ICP bucket (base)', { h: 6, w: 6, x: 18, y: 1 }, geoRows(geo.followers.buckets)),
  barchartData('US · ICP share of visitors by month', { h: 8, w: 12, x: 0, y: 7 }, geoMonthly, ['icp_pct'], 'percent'),
  barchartData('Visitor geography by month', { h: 8, w: 12, x: 12, y: 7 }, geoMonthly, ['us', 'team', 'anti', 'other'], 'short', 'normal'),

  { id: nid(), type: 'row', title: 'Selected month — pick $month above', gridPos: { h: 1, w: 24, x: 0, y: 15 }, collapsed: false, panels: [] },
  monthStat('US · ICP share ($month)', { h: 5, w: 6, x: 0, y: 16 }, 'icp_pct', 'percent', true),
  monthStat('India / China share ($month)', { h: 5, w: 6, x: 6, y: 16 }, 'anti_pct', 'percent'),
  monthStat('US visitors ($month)', { h: 5, w: 6, x: 12, y: 16 }, 'us', 'short'),
  monthStat('India / China visitors ($month)', { h: 5, w: 6, x: 18, y: 16 }, 'anti', 'short'),

  { id: nid(), type: 'row', title: 'Company Page — monthly', gridPos: { h: 1, w: 24, x: 0, y: 21 }, collapsed: false, panels: [] },
  barchart('Page views & unique visitors', { h: 8, w: 12, x: 0, y: 22 }, ['page_views', 'unique_visitors']),
  barchart('New followers', { h: 8, w: 6, x: 12, y: 22 }, ['new_followers']),
  barchart('Post impressions', { h: 8, w: 6, x: 18, y: 22 }, ['post_impressions']),
  table('Monthly metrics', { h: 8, w: 24, x: 0, y: 30 }),

  { id: nid(), type: 'row', title: 'Audience (12-month snapshot)', gridPos: { h: 1, w: 24, x: 0, y: 38 }, collapsed: false, panels: [] },
  bargauge('Visitors by seniority', { h: 8, w: 12, x: 0, y: 39 }, demoRows(src.visitor_demographics, 'Seniority')),
  bargauge('Visitors by industry', { h: 8, w: 12, x: 12, y: 39 }, demoRows(src.visitor_demographics, 'Industry')),
  bargauge('Followers by seniority', { h: 8, w: 12, x: 0, y: 47 }, demoRows(src.follower_demographics, 'Seniority')),
  bargauge('Followers by industry', { h: 8, w: 12, x: 12, y: 47 }, demoRows(src.follower_demographics, 'Industry')),
];

// $month picker — Custom variable in "display : value" format (Query type
// can't read Infinity in v0alpha1 dashboards, so the list is embedded).
const monthValues = geoMonthly.map((r) => r.month);
const monthVar = {
  name: 'month', type: 'custom', label: 'Month',
  query: monthValues.map((m) => `${m} : ${m}`).join(', '),
  current: monthValues.length ? { text: monthValues[monthValues.length - 1], value: monthValues[monthValues.length - 1] } : {},
  options: monthValues.map((m, i) => ({ text: m, value: m, selected: i === monthValues.length - 1 })),
  includeAll: false, multi: false,
};

const dashboard = {
  uid: 'linkedin-page',
  title: 'LinkedIn Stats — Company Page',
  tags: ['linkedin', 'company-page'],
  timezone: '',
  schemaVersion: 42,
  version: 1,
  refresh: '',
  time: { from: 'now-1y', to: 'now' },
  templating: { list: monthValues.length ? [monthVar] : [] },
  annotations: { list: [] },
  panels,
};

fs.writeFileSync(OUT, JSON.stringify(dashboard, null, 2) + '\n');
console.error(`wrote ${OUT} — ${months.length} months, ${panels.length} panels`);
