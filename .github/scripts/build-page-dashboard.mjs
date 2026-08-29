#!/usr/bin/env node
// Build the company-page Grafana dashboard as an EXACT 1:1 replica of Peter's
// personal "LinkedIn Stats" dashboard — same sections, same panels, same
// titles, same order, same panel TYPES (sparkline stats, line timeseries,
// horizontal demo bars). Panels whose data the company page provides read real
// numbers from the live page-stats.json feed — including Search appearances
// (the admin tab exposes a rolling 7-day figure we snapshot weekly) and
// Profile viewers (whose Page analog is Visitors). Panels whose data is NOT
// collected render "???" instead of a fake zero: ICP/VIP splits + top engagers
// (needs per-person reactor collection), the page's own posting/commenting
// activity, and the per-post correlation charts.
// The company-specific ICP-geography sections are kept BELOW the replica.
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
const BLUE = '#3274D9'; const DARK = '#24292e'; const GREEN = '#56A64B'; const ORANGE = '#FF9830'; const PURPLE = '#B877D9'; const GRAY = '#9d9d9d';

const row = (title, y) => ({ id: nid(), type: 'row', title, gridPos: { h: 1, w: 24, x: 0, y }, collapsed: false, panels: [] });

// ---- real stat reading a numeric field from engagement_score_totals ----
function scoreStat(title, gridPos, scope, field, color) {
  return {
    id: nid(), type: 'stat', title, datasource: DS, gridPos,
    fieldConfig: { defaults: { unit: 'short', decimals: 0, color: { mode: 'fixed', fixedColor: color } }, overrides: [] },
    options: { reduceOptions: { values: false, calcs: ['lastNotNull'], fields: `/^${field}$/` }, textMode: 'value', colorMode: 'value', graphMode: 'none' },
    targets: [urlTarget('engagement_score_totals', [col('scope', 'string'), col(field, 'number')], `scope == "${scope}"`)],
  };
}
// ---- tier stat: reads a real engagement_score_totals field as a STRING, so the
// SAME panel shows "???" while un-collected and the real number once the page
// people-phase has run — no dashboard change needed to light it up. ----
function tierStat(title, gridPos, scope, field, color) {
  return {
    id: nid(), type: 'stat', title, datasource: DS, gridPos,
    fieldConfig: { defaults: { color: { mode: 'fixed', fixedColor: color } }, overrides: [] },
    options: { reduceOptions: { values: false, calcs: ['lastNotNull'], fields: `/^${field}$/` }, textMode: 'value', colorMode: 'value', graphMode: 'none' },
    targets: [urlTarget('engagement_score_totals', [col('scope', 'string'), col(field, 'string')], `scope == "${scope}"`)],
  };
}
// ---- Top engagers: real table (empty until the people-phase runs) ----
function peopleTable(title, gridPos) {
  return {
    id: nid(), type: 'table', title, datasource: DS, gridPos,
    fieldConfig: { defaults: {}, overrides: [] },
    options: { showHeader: true, sortBy: [{ displayName: 'score', desc: true }] },
    targets: [urlTarget('engagement_people', [col('name', 'string'), col('tier', 'string'), col('reactions', 'number'), col('comments', 'number'), col('score', 'number')])],
    transformations: [
      { id: 'sortBy', options: { sort: [{ desc: true, field: 'score' }] } },
      { id: 'limit', options: { limitField: 15 } },
    ],
  };
}
// ---- "???" chart placeholder (for panels whose CHART we cannot draw) ----
function unknownPanel(title, gridPos, note) {
  return {
    id: nid(), type: 'text', title, gridPos,
    fieldConfig: { defaults: {}, overrides: [] },
    options: { mode: 'markdown', content: `\n# ???\n\n${note}` },
  };
}
function tsPanel(title, gridPos, root, fields) {
  return {
    id: nid(), type: 'timeseries', title, datasource: DS, gridPos,
    fieldConfig: { defaults: { custom: { drawStyle: 'line', lineInterpolation: 'smooth', fillOpacity: 10, lineWidth: 2, spanNulls: true } }, overrides: [] },
    options: { legend: { showLegend: true, placement: 'bottom', calcs: [] }, tooltip: { mode: 'multi' } },
    targets: [urlTarget(root, [col('week', 'string'), ...fields.map((f) => col(f, 'number'))])],
    transformations: [
      { id: 'convertFieldType', options: { conversions: [{ targetField: 'week', destinationType: 'time', dateFormat: 'YYYY-MM-DD' }] } },
      { id: 'sortBy', options: { sort: [{ desc: false, field: 'week' }] } },
    ],
  };
}
// ---- stat with a sparkline under the number (Peter's graphMode:'area') —
// reads the weekly series so the sparkline has points; value = latest.
function sparkStat(title, gridPos, root, field, color) {
  return {
    id: nid(), type: 'stat', title, datasource: DS, gridPos,
    fieldConfig: { defaults: { unit: 'short', decimals: 0, color: { mode: 'fixed', fixedColor: color } }, overrides: [] },
    options: { reduceOptions: { values: false, calcs: ['lastNotNull'], fields: `/^${field}$/` }, textMode: 'value', colorMode: 'value', graphMode: 'area' },
    targets: [urlTarget(root, [col('week', 'string'), col(field, 'number')])],
    transformations: [
      { id: 'convertFieldType', options: { conversions: [{ targetField: 'week', destinationType: 'time', dateFormat: 'YYYY-MM-DD' }] } },
      { id: 'sortBy', options: { sort: [{ desc: false, field: 'week' }] } },
    ],
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
// ---- Reactions & comments — total vs ICP: table with real totals and ??? ICP cells ----
function reactVsIcpTable(title, gridPos) {
  return {
    id: nid(), type: 'table', title, datasource: DS, gridPos,
    fieldConfig: { defaults: {}, overrides: [] }, options: { showHeader: true },
    targets: [urlTarget('engagement_score_totals', [
      col('scope', 'string'), col('reactions', 'number'), col('reactions_icp', 'string'),
      col('comments', 'number'), col('comments_icp', 'string'), col('icp_engagement_pct', 'string'),
    ])],
  };
}
// ---- geography helpers (company-specific sections kept below the replica) ----
function monthlyBar(title, gridPos, keys, root = 'page_monthly', unit = 'short', stacking = 'none') {
  return {
    id: nid(), type: 'barchart', title, datasource: DS, gridPos,
    fieldConfig: { defaults: { unit, custom: { lineWidth: 1, fillOpacity: 80 } }, overrides: [] },
    options: { orientation: 'auto', showValue: 'auto', stacking, legend: { showLegend: keys.length > 1, placement: 'bottom' }, xField: 'month' },
    targets: [urlTarget(root, monthCols(keys))],
    transformations: [{ id: 'sortBy', options: { sort: [{ desc: false, field: 'month' }] } }],
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

const NEEDS_ACTIVITY = 'requires tracking the page’s own posting/commenting activity (not collected)';
const NEEDS_PER_POST = 'requires per-post records (not collected for the page)';

const panels = [
  // ============ 1:1 replica of Peter's "LinkedIn Stats" ============
  row('Engagement score — who engaged, weighted by tier', 0),
  scoreStat('Engagement score (last week)', { h: 4, w: 6, x: 0, y: 1 }, 'last_week', 'score', BLUE),
  tierStat('...from normal audience', { h: 4, w: 6, x: 6, y: 1 }, 'last_week', 'score_normal', DARK),
  tierStat('...from ICP', { h: 4, w: 6, x: 12, y: 1 }, 'last_week', 'score_icp', GREEN),
  tierStat('...from VIP list (4×)', { h: 4, w: 6, x: 18, y: 1 }, 'last_week', 'score_vip', PURPLE),
  scoreStat('Engagement score (all time)', { h: 4, w: 6, x: 0, y: 5 }, 'all_time', 'score', BLUE),
  tierStat('...from normal audience', { h: 4, w: 6, x: 6, y: 5 }, 'all_time', 'score_normal', DARK),
  tierStat('...from ICP', { h: 4, w: 6, x: 12, y: 5 }, 'all_time', 'score_icp', GREEN),
  tierStat('...from VIP list (4×)', { h: 4, w: 6, x: 18, y: 5 }, 'all_time', 'score_vip', PURPLE),
  tierStat('ICP share of reactions (all time)', { h: 4, w: 6, x: 0, y: 9 }, 'all_time', 'icp_reaction_pct', GREEN),
  tierStat('ICP share of comments (all time)', { h: 4, w: 6, x: 6, y: 9 }, 'all_time', 'icp_comment_pct', GREEN),
  tierStat('ICP share of all engagement (all time)', { h: 4, w: 6, x: 12, y: 9 }, 'all_time', 'icp_engagement_pct', GREEN),
  tierStat('ICP engagers (all time)', { h: 4, w: 6, x: 18, y: 9 }, 'all_time', 'people_icp', GREEN),
  tsPanel('Engagement score per week', { h: 8, w: 14, x: 0, y: 13 }, 'engagement_score_weeks', ['score']),
  peopleTable('Top engagers', { h: 8, w: 10, x: 14, y: 13 }),

  row('Reactions & comments — total vs ICP (last week and all time)', 21),
  reactVsIcpTable('Reactions & comments — total vs ICP', { h: 6, w: 24, x: 0, y: 22 }),

  row('Account view', 28),
  sparkStat('Followers', { h: 4, w: 6, x: 0, y: 29 }, 'page_account_weeks', 'followers', BLUE),
  sparkStat('Post impressions (monthly)', { h: 4, w: 6, x: 6, y: 29 }, 'page_account_weeks', 'post_impressions', ORANGE),
  sparkStat('Profile viewers — page visitors (monthly)', { h: 4, w: 6, x: 12, y: 29 }, 'page_account_weeks', 'unique_visitors', PURPLE),
  sparkStat('Search appearances (prev week)', { h: 4, w: 6, x: 18, y: 29 }, 'page_search_weeks', 'searches', GREEN),
  tsPanel('Followers', { h: 7, w: 12, x: 0, y: 33 }, 'page_account_weeks', ['followers']),
  tsPanel('Post impressions (monthly)', { h: 7, w: 12, x: 12, y: 33 }, 'page_account_weeks', ['post_impressions']),
  tsPanel('Profile viewers — page visitors (monthly)', { h: 7, w: 12, x: 0, y: 40 }, 'page_account_weeks', ['unique_visitors']),
  tsPanel('Search appearances (weekly snapshots)', { h: 7, w: 12, x: 12, y: 40 }, 'page_search_weeks', ['searches']),
  demoBar('Seniority', { h: 7, w: 8, x: 0, y: 47 }, 'followers', 'Seniority'),
  demoBar('Top job titles', { h: 7, w: 8, x: 8, y: 47 }, 'followers', 'Job function'),
  demoBar('Top locations', { h: 7, w: 8, x: 16, y: 47 }, 'followers', 'Location'),
  unknownPanel('Posts published per month', { h: 7, w: 12, x: 0, y: 54 }, NEEDS_ACTIVITY),
  unknownPanel('Comments posted per month', { h: 7, w: 12, x: 12, y: 54 }, NEEDS_ACTIVITY),
  unknownPanel('Reactions on my comments per month', { h: 7, w: 12, x: 0, y: 61 }, NEEDS_ACTIVITY),
  unknownPanel('Impressions on my comments per month', { h: 7, w: 12, x: 12, y: 61 }, NEEDS_ACTIVITY),
  unknownPanel('Posts published vs impressions (scatter + linear fit)', { h: 7, w: 12, x: 0, y: 68 }, NEEDS_PER_POST),
  unknownPanel('Impressions per post over time', { h: 7, w: 12, x: 12, y: 68 }, NEEDS_PER_POST),

  // ============ company-specific extras (below the replica) ============
  row('ICP geography — US vs India (company-page extra)', 75),
  icpStat('US · ICP share — visitors (6 mo)', { h: 6, w: 6, x: 0, y: 76 }, 'visitors'),
  icpStat('US · ICP share — followers (base)', { h: 6, w: 6, x: 6, y: 76 }, 'followers'),
  bucketGauge('Visitors by ICP bucket (6 mo)', { h: 6, w: 6, x: 12, y: 76 }, 'visitors'),
  bucketGauge('Followers by ICP bucket (base)', { h: 6, w: 6, x: 18, y: 76 }, 'followers'),
  monthlyBar('US · ICP share of visitors by month', { h: 8, w: 12, x: 0, y: 82 }, ['icp_pct'], 'page_geo_monthly', 'percent'),
  monthlyBar('Visitor geography by month', { h: 8, w: 12, x: 12, y: 82 }, ['us', 'team', 'anti', 'other'], 'page_geo_monthly', 'short', 'normal'),
  monthlyBar('Page views & unique visitors', { h: 8, w: 12, x: 0, y: 90 }, ['page_views', 'unique_visitors']),
  monthlyBar('New followers per month', { h: 8, w: 12, x: 12, y: 90 }, ['new_followers']),

  row('Selected month — pick $month above', 98),
  monthStat('US · ICP share ($month)', { h: 5, w: 6, x: 0, y: 99 }, 'icp_pct', 'percent', true),
  monthStat('India / China share ($month)', { h: 5, w: 6, x: 6, y: 99 }, 'anti_pct', 'percent'),
  monthStat('US visitors ($month)', { h: 5, w: 6, x: 12, y: 99 }, 'us', 'short'),
  monthStat('India / China visitors ($month)', { h: 5, w: 6, x: 18, y: 99 }, 'anti', 'short'),
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
