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
const OUT = args.out || 'dashboards/grafana/linkedin-page.json';

const src = JSON.parse(fs.readFileSync(IN, 'utf8'));
const months = Object.entries(src.months).map(([month, m]) => ({ month, ...m }));

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

const demoRows = (obj, cat) => (obj[cat] || []).map(([name, value]) => ({ name, value }));
const geo = src.geography || { visitors: { buckets: {}, icp_pct: 0 }, followers: { buckets: {}, icp_pct: 0 } };
const BUCKET_LABEL = { US: 'US · ICP', TEAM: 'Ukraine · team', ANTI: 'India / China · off-ICP', OTHER: 'Other · off-target' };
const geoRows = (b) => ['US', 'TEAM', 'ANTI', 'OTHER'].map((k) => ({ name: BUCKET_LABEL[k], value: (b || {})[k] || 0 }));

const panels = [
  { id: nid(), type: 'row', title: 'ICP geography (12-month snapshot)', gridPos: { h: 1, w: 24, x: 0, y: 0 }, collapsed: false, panels: [] },
  icpStat('US · ICP share — visitors', { h: 6, w: 6, x: 0, y: 1 }, geo.visitors.icp_pct),
  icpStat('US · ICP share — followers', { h: 6, w: 6, x: 6, y: 1 }, geo.followers.icp_pct),
  bargauge('Visitors by ICP bucket', { h: 6, w: 6, x: 12, y: 1 }, geoRows(geo.visitors.buckets)),
  bargauge('Followers by ICP bucket', { h: 6, w: 6, x: 18, y: 1 }, geoRows(geo.followers.buckets)),

  { id: nid(), type: 'row', title: 'Company Page — monthly', gridPos: { h: 1, w: 24, x: 0, y: 7 }, collapsed: false, panels: [] },
  barchart('Page views & unique visitors', { h: 8, w: 12, x: 0, y: 8 }, ['page_views', 'unique_visitors']),
  barchart('New followers', { h: 8, w: 6, x: 12, y: 8 }, ['new_followers']),
  barchart('Post impressions', { h: 8, w: 6, x: 18, y: 8 }, ['post_impressions']),
  table('Monthly metrics', { h: 8, w: 24, x: 0, y: 16 }),

  { id: nid(), type: 'row', title: 'Audience (12-month snapshot)', gridPos: { h: 1, w: 24, x: 0, y: 24 }, collapsed: false, panels: [] },
  bargauge('Visitors by seniority', { h: 8, w: 12, x: 0, y: 25 }, demoRows(src.visitor_demographics, 'Seniority')),
  bargauge('Visitors by industry', { h: 8, w: 12, x: 12, y: 25 }, demoRows(src.visitor_demographics, 'Industry')),
  bargauge('Followers by seniority', { h: 8, w: 12, x: 0, y: 33 }, demoRows(src.follower_demographics, 'Seniority')),
  bargauge('Followers by industry', { h: 8, w: 12, x: 12, y: 33 }, demoRows(src.follower_demographics, 'Industry')),
];

const dashboard = {
  uid: 'linkedin-page',
  title: 'LinkedIn Stats — Company Page',
  tags: ['linkedin', 'company-page'],
  timezone: '',
  schemaVersion: 42,
  version: 1,
  refresh: '',
  time: { from: 'now-1y', to: 'now' },
  templating: { list: [] },
  annotations: { list: [] },
  panels,
};

fs.writeFileSync(OUT, JSON.stringify(dashboard, null, 2) + '\n');
console.error(`wrote ${OUT} — ${months.length} months, ${panels.length} panels`);
