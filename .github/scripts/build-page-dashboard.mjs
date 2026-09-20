#!/usr/bin/env node
// Build the company-page Grafana dashboard. It started as a 1:1 replica of
// Peter's personal "LinkedIn Stats" dashboard — same sections, same panel TYPES
// (sparkline stats, line timeseries, horizontal demo bars) — and keeps that
// shape wherever the company page actually has the same data. Where it does
// NOT, the panel says so instead of borrowing the personal board's wording:
// the page has no weekly granularity (its export is monthly), its "unique
// visitors" is not a profile's "profile viewers", and its Search appearances
// is a hand-entered snapshot, not a series.
//
// WINDOWS — three different ones live on this board, and every title or
// description that can be mistaken for another says which it is:
//   * 6 months  — every time series and monthly aggregate. scrape-page.mjs
//     defaults to --months=6 and OVERWRITES monthly.json wholesale, so older
//     months are retained nowhere: a "total" here is a rolling window, never a
//     lifetime figure.
//   * 12 months — the demographic sheets only (scrape-page.mjs sets the export
//     Time range to "Last 365 days"), and for the visitors audience they are
//     view-weighted, not a headcount.
//   * the newest month is whatever the export covered, which is usually a
//     PARTIAL month — see partialMonthNote below, derived from generated_at.
// Panels whose data is not collected
// render "???" instead of a fake zero: ICP/VIP splits + top engagers (needs
// per-person reactor collection) and the per-post charts — both obtainable
// later, so the placeholder is a promise. Panels that could NEVER have data
// (a Page's own outbound comments — LinkedIn exposes no such surface) are not
// drawn at all. The company-specific ICP-geography sections are kept BELOW.
//
// Usage: node .github/scripts/build-page-dashboard.mjs [--out dashboards/grafana/linkedin-page.json]

import fs from 'node:fs';

const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) =>
  a.startsWith('--') ? [a.slice(2), arr[i + 1]] : [null, null]).filter(([k]) => k));
const OUT = args.out || 'dashboards/grafana/linkedin-page.json';

// Every panel reads Postgres. The uid is a PLACEHOLDER on purpose: this repo is
// public, so the real datasource uid never lands in a committed file —
// push-dashboard.mjs substitutes it (env GRAFANA_PG_DATASOURCE_UID) just before
// POSTing, and its --dump puts the placeholder back.
const DS = { type: 'grafana-postgresql-datasource', uid: '${DS_LINKEDIN_PG}' };

// ---- feed views ------------------------------------------------------------
// One view per section of the company-page feed (db/schema.sql, schema dash):
// section "page_monthly" -> dash.feed_page_monthly, "engagement_people" ->
// dash.feed_page_engagement_people. Columns are `ord` (0-based position of the
// row in the section's array) followed by exactly the keys of the section's row
// objects, so "order by ord" IS the feed order. A section missing from this
// list has no view: asking for it fails HERE, not as a broken panel in Grafana.
const PAGE_FEEDS = new Set([
  'engagement_score_totals', 'engagement_score_weeks', 'engagement_people',
  'page_account_weeks', 'page_search_weeks', 'page_demographics', 'page_monthly',
  'page_geo_aggregate', 'page_geo_buckets', 'page_geo_monthly',
]);
const feedView = (root) => {
  if (!PAGE_FEEDS.has(root)) throw new Error(`no feed view for section "${root}" — add dash.feed_page_${String(root).replace(/^page_/, '')} to db/schema.sql and list the section in PAGE_FEEDS`);
  return `dash.feed_page_${root.replace(/^page_/, '')}`;
};

// SQL spelling of an identifier / a string literal. Identifiers are quoted only
// when Postgres needs it (anything but a lower-case simple name, or a word that
// cannot be a bare column name: PostgreSQL 16, Appendix C, "reserved" and
// "reserved (can be function or type)"), so the common case reads like
// hand-written SQL.
const PG_RESERVED = new Set(('all analyse analyze and any array as asc asymmetric both case cast check collate column '
  + 'constraint create current_catalog current_date current_role current_time current_timestamp current_user default '
  + 'deferrable desc distinct do else end except false fetch for foreign from grant group having in initially intersect '
  + 'into lateral leading limit localtime localtimestamp not null offset on only or order placing primary references '
  + 'returning select session_user some symmetric system_user table then to trailing true union unique user using '
  + 'variadic when where window with '
  + 'authorization binary collation concurrently cross current_schema freeze full ilike inner is isnull join left like '
  + 'natural notnull outer overlaps right similar tablesample verbose').split(' '));
const sqlIdent = (s) => (/^[a-z_][a-z0-9_]*$/.test(s) && !PG_RESERVED.has(s) ? s : `"${s.replace(/"/g, '""')}"`);
const sqlLiteral = (s) => `'${s.replace(/'/g, "''")}'`;

// ---- filter expression -> WHERE --------------------------------------------
// The whole grammar this board has ever used, and the ONLY one accepted:
//   expr := term ( "&&" term )*
//   term := "(" expr ")"  |  field == "literal"  |  field == "${variable}"
// Anything else — ||, !=, a number, a single-quoted string, an escape, a
// variable glued into a longer literal — is REFUSED rather than guessed at: a
// wrong guess here is a panel that silently shows other rows. Since && is the
// only operator, parentheses carry no meaning and the result is a flat list of
// conjuncts, in source order.
const FILTER_VARS = new Set(['post', 'month']);
const usedVars = new Set();
function parseFilter(expr) {
  const refuse = (why) => { throw new Error(`filterExpression outside the supported grammar (${why}): ${expr}`); };
  const tokens = [];
  const re = /\s*(?:(\()|(\))|(&&)|(==)|([A-Za-z_][A-Za-z0-9_]*)|"([^"\\]*)")/y;
  const src = expr.trimEnd();
  while (re.lastIndex < src.length) {
    const at = re.lastIndex;
    const m = re.exec(src);
    if (!m) refuse(`unexpected input at offset ${at}`);
    if (m[1]) tokens.push({ t: '(' });
    else if (m[2]) tokens.push({ t: ')' });
    else if (m[3]) tokens.push({ t: '&&' });
    else if (m[4]) tokens.push({ t: '==' });
    else if (m[5]) tokens.push({ t: 'field', v: m[5] });
    else tokens.push({ t: 'string', v: m[6] });
  }
  let i = 0;
  const take = (t) => (tokens[i] && tokens[i].t === t ? tokens[i++] : refuse(`expected ${t} at token ${i + 1}`));
  const term = () => {
    if (tokens[i] && tokens[i].t === '(') { i++; const inner = conj(); take(')'); return inner; }
    const field = take('field').v; take('==');
    const value = take('string').v;
    const asVar = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value);
    if (asVar) {
      if (!FILTER_VARS.has(asVar[1])) refuse(`unknown dashboard variable \${${asVar[1]}}`);
      return [{ field, variable: asVar[1] }];
    }
    if (value.includes('$')) refuse('a variable must be the whole literal');
    return [{ field, literal: value }];
  };
  const conj = () => { let list = term(); while (tokens[i] && tokens[i].t === '&&') { i++; list = list.concat(term()); } return list; };
  const list = conj();
  if (i !== tokens.length) refuse(`unexpected ${tokens[i].t} at token ${i + 1}`);
  return list;
}

// ---- THE translation: (section, columns, filter) -> one SQL string ---------
// Returns the frame the panel has always been fed: one output column per entry
// of `columns`, in that order, named by its `text` and read from feed column
// `selector`; rows matching the filter, in feed order.
//   * 'string' columns are cast ::text even where the feed column already is
//     text (a no-op there). The tier stats read a field that is "???" today and
//     a real number once per-person collection lands; the cast keeps "no
//     dashboard change needed to light it up" (see tierStat) true whichever
//     type the view gives that column.
//   * a filter names a FRAME field (a column's `text`), exactly as it always
//     did, so a field that is not among the columns is refused, not invented.
//   * variables go in as ${name:sqlstring} — Grafana's own escaping, expanding
//     to a quoted, quote-escaped literal. Never a raw ${name} inside SQL.
//   * no $__timeFilter and no time macro: see the hidden time picker below.
function feedSql(root, columns, filterExpression) {
  const select = columns.map((c) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(c.selector)) throw new Error(`selector "${c.selector}" is not a plain feed column (section ${root})`);
    const from = sqlIdent(c.selector); const as = sqlIdent(c.text);
    if (c.type === 'string') return `${from}::text as ${as}`;
    if (c.type === 'number') return from === as ? from : `${from} as ${as}`;
    throw new Error(`column type "${c.type}" has no SQL translation (section ${root}, column ${c.text})`);
  });
  const where = (filterExpression ? parseFilter(filterExpression) : []).map((f) => {
    const c = columns.find((x) => x.text === f.field);
    if (!c) throw new Error(`filter field "${f.field}" is not among the target's columns (section ${root}): ${filterExpression}`);
    if (c.type !== 'string') throw new Error(`filter field "${f.field}" is compared with a string but is read as ${c.type} (section ${root}): ${filterExpression}`);
    if (f.variable) usedVars.add(f.variable);
    return `${sqlIdent(c.selector)} = ${f.variable ? `\${${f.variable}:sqlstring}` : sqlLiteral(f.literal)}`;
  });
  return `select ${select.join(', ')} from ${feedView(root)}${where.length ? ` where ${where.join(' and ')}` : ''} order by ord`;
}
function sqlTarget(root, columns, filterExpression) {
  return { datasource: DS, editorMode: 'code', format: 'table', rawQuery: true, rawSql: feedSql(root, columns, filterExpression), refId: 'A' };
}
const col = (selector, type) => ({ selector, text: selector, type });
const monthCols = (keys) => [col('month', 'string'), ...keys.map((k) => col(k, 'number'))];
const demoCols = [col('audience', 'string'), col('category', 'string'), col('name', 'string'), col('value', 'number')];
const bucketCols = [col('audience', 'string'), col('name', 'string'), col('value', 'number')];
const aggCols = (field) => [col('audience', 'string'), col(field, 'number')];

let id = 0; const nid = () => ++id;
const BLUE = '#3274D9'; const DARK = '#24292e'; const GREEN = '#56A64B'; const ORANGE = '#FF9830'; const PURPLE = '#B877D9'; const GRAY = '#9d9d9d';

// ---- grid layout ----------------------------------------------------------
// Panels declare only {h,w}; x and y are PACKED left-to-right and wrap at 24
// columns. Nothing carries a literal y, so inserting or deleting a panel can
// no longer leave every panel below it sitting on a stale coordinate. The
// panels array is evaluated in order, exactly like nid() already relies on.
let curX = 0; let curY = 0; let bandH = 0;
function place(h, w) {
  if (curX + w > 24) { curY += bandH; curX = 0; bandH = 0; }
  const gridPos = { h, w, x: curX, y: curY };
  curX += w; bandH = Math.max(bandH, h);
  return gridPos;
}
// Attach a description (the tooltip in the panel header) without giving every
// helper below an extra parameter it mostly would not use.
const withDesc = (panel, description) => ({ ...panel, description });

const row = (title) => ({ id: nid(), type: 'row', title, gridPos: place(1, 24), collapsed: false, panels: [] });

// ---- real stat reading a numeric field from engagement_score_totals ----
function scoreStat(title, gridPos, scope, field, color) {
  return {
    id: nid(), type: 'stat', title, datasource: DS, gridPos,
    fieldConfig: { defaults: { unit: 'short', decimals: 0, color: { mode: 'fixed', fixedColor: color } }, overrides: [] },
    options: { reduceOptions: { values: false, calcs: ['lastNotNull'], fields: `/^${field}$/` }, textMode: 'value', colorMode: 'value', graphMode: 'none' },
    targets: [sqlTarget('engagement_score_totals', [col('scope', 'string'), col(field, 'number')], `scope == "${scope}"`)],
  };
}
// ---- tier stat: reads a real engagement_score_totals field as a STRING, so the
// SAME panel shows "???" while un-collected and the real number once the page
// people-phase has run — no dashboard change needed to light it up.
// CAVEAT — the panel BODY needs no change, but the TITLES do: the two paths in
// build-page-stats.mjs mean different things by the same scope keys. The
// aggregate fallback fills "last_week" from the latest MONTH and "all_time"
// from the rolling 6-month export; the per-person path fills them from a real
// ISO week and from every collected event. So this generator reads whether
// dashboards/li-stats/page/engagement.json exists (PER_PERSON below) and words
// the period labels from that. Do not hard-code either wording back in. ----
function tierStat(title, gridPos, scope, field, color) {
  return {
    id: nid(), type: 'stat', title, datasource: DS, gridPos,
    fieldConfig: { defaults: { color: { mode: 'fixed', fixedColor: color } }, overrides: [] },
    options: { reduceOptions: { values: false, calcs: ['lastNotNull'], fields: `/^${field}$/` }, textMode: 'value', colorMode: 'value', graphMode: 'none' },
    targets: [sqlTarget('engagement_score_totals', [col('scope', 'string'), col(field, 'string')], `scope == "${scope}"`)],
  };
}
// ---- Top engagers: real table (empty until the people-phase runs). noValue is
// the board's "???" convention, not Grafana's "No data": an empty table here
// means UNCOLLECTED, and the score panels beside it prove engagement is not
// zero, so the default wording would state a fact that is false. ----
function peopleTable(title, gridPos) {
  return {
    id: nid(), type: 'table', title, datasource: DS, gridPos,
    fieldConfig: { defaults: { noValue: '???' }, overrides: [] },
    options: { showHeader: true, sortBy: [{ displayName: 'score', desc: true }] },
    targets: [sqlTarget('engagement_people', [col('name', 'string'), col('tier', 'string'), col('reactions', 'number'), col('comments', 'number'), col('score', 'number')])],
    transformations: [
      { id: 'sortBy', options: { sort: [{ desc: true, field: 'score' }] } },
      { id: 'limit', options: { limitField: 15 } },
    ],
  };
}
// ---- "???" chart placeholder (for panels whose CHART we cannot draw YET) ----
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
    targets: [sqlTarget(root, [col('week', 'string'), ...fields.map((f) => col(f, 'number'))])],
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
    targets: [sqlTarget(root, [col('week', 'string'), col(field, 'number')])],
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
    targets: [sqlTarget('page_demographics', demoCols, `(audience == "${audience}") && (category == "${category}")`)],
    transformations: [
      { id: 'organize', options: { excludeByName: { audience: true, category: true }, indexByName: {}, renameByName: {} } },
      { id: 'sortBy', options: { sort: [{ desc: true, field: 'value' }] } },
      { id: 'limit', options: { limitField: 8 } },
    ],
  };
}
// ---- Reactions & comments — total vs ICP: table with real totals and ??? ICP
// cells. The scope column carries the feed's raw keys ("last_week", "all_time"),
// which would contradict the row header above it — the reader believes the cell,
// because that is where the number is. So the keys are mapped to the SAME words
// the titles use, and the column is renamed. The mappings live in `defaults`
// rather than a per-field override on purpose: overrides are matched AFTER
// transformations, so an override on "scope" would miss the renamed column,
// while a value mapping for a string like "last_week" can never match any of
// the numeric fields it also touches. ----
function reactVsIcpTable(title, gridPos, scopeLabels) {
  return {
    id: nid(), type: 'table', title, datasource: DS, gridPos,
    fieldConfig: {
      defaults: { mappings: [{ type: 'value', options: scopeLabels }] },
      overrides: [],
    },
    options: { showHeader: true },
    targets: [sqlTarget('engagement_score_totals', [
      col('scope', 'string'), col('reactions', 'number'), col('reactions_icp', 'string'),
      col('comments', 'number'), col('comments_icp', 'string'), col('icp_engagement_pct', 'string'),
    ])],
    transformations: [
      { id: 'organize', options: { excludeByName: {}, indexByName: {}, renameByName: { scope: 'Window' } } },
    ],
  };
}
// ---- geography helpers (company-specific sections kept below the replica) ----
function monthlyBar(title, gridPos, keys, root = 'page_monthly', unit = 'short', stacking = 'none') {
  return {
    id: nid(), type: 'barchart', title, datasource: DS, gridPos,
    fieldConfig: { defaults: { unit, custom: { lineWidth: 1, fillOpacity: 80 } }, overrides: [] },
    options: { orientation: 'auto', showValue: 'auto', stacking, legend: { showLegend: keys.length > 1, placement: 'bottom' }, xField: 'month' },
    targets: [sqlTarget(root, monthCols(keys))],
    transformations: [{ id: 'sortBy', options: { sort: [{ desc: false, field: 'month' }] } }],
  };
}
function icpStat(title, gridPos, audience) {
  return {
    id: nid(), type: 'stat', title, datasource: DS, gridPos,
    fieldConfig: { defaults: { unit: 'percent', decimals: 1, thresholds: { mode: 'absolute', steps: [{ color: 'red', value: null }, { color: 'orange', value: 30 }, { color: 'green', value: 50 }] } }, overrides: [] },
    options: { reduceOptions: { values: false, calcs: ['lastNotNull'], fields: '/^icp_pct$/' }, textMode: 'value', colorMode: 'value', graphMode: 'none' },
    targets: [sqlTarget('page_geo_aggregate', aggCols('icp_pct'), `audience == "${audience}"`)],
  };
}
function bucketGauge(title, gridPos, audience) {
  return {
    id: nid(), type: 'bargauge', title, datasource: DS, gridPos,
    fieldConfig: { defaults: { color: { mode: 'continuous-BlPu' } }, overrides: [] },
    options: { orientation: 'horizontal', displayMode: 'gradient', reduceOptions: { values: true, calcs: [], fields: '/^value$/' }, showUnfilled: true },
    targets: [sqlTarget('page_geo_buckets', bucketCols, `audience == "${audience}"`)],
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
    targets: [sqlTarget('page_geo_monthly', [col('month', 'string'), col(field, 'number')], 'month == "${month}"')],
  };
}

// ---- generation-time facts, used ONLY inside panel DESCRIPTIONS ------------
// $month was deliberately moved OFF generation-time data (see monthVar below)
// because a reader picks values from it, and a stale option list is a silent
// lie. Caveat prose is the one place a generation-time number is still the
// honest choice: these numbers exist to say what a panel's own number is NOT,
// and every sentence degrades to a number-free version when its source file is
// not readable from here. Nothing a reader can CLICK is built from them.
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const PAGE_DIR = 'dashboards/li-stats/page';
const monthlyRaw = readJson(`${PAGE_DIR}/monthly.json`);
const geoRaw = readJson(`${PAGE_DIR}/geo-monthly.json`);
const manualRaw = readJson(`${PAGE_DIR}/manual.json`);

// Which of build-page-stats.mjs's two paths is live. The aggregate fallback
// fills scope "last_week" from the latest MONTH; the per-person path fills it
// from a real ISO week (lib/engagement.mjs). Titles that name the period must
// follow the data, or they lie again the moment the people-phase lands — see
// the tierStat comment above.
const PER_PERSON = fs.existsSync(`${PAGE_DIR}/engagement.json`);
const PERIOD_LABEL = PER_PERSON ? 'last week' : 'latest month';
const TOTAL_LABEL = PER_PERSON ? 'all time' : 'last 6 months';
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const note = (...parts) => parts.filter(Boolean).join(' ');

// Is the newest month only partly covered? monthly.json's generated_at is the
// moment the export was taken; an export taken mid-month yields a short month
// whose every metric looks like a collapse next to six full ones.
const partialMonthNote = (() => {
  const generic = 'The newest month is only as complete as the export that produced it: when the export runs mid-month that month is PARTIAL, and its lower value may be nothing but the missing days.';
  const months = monthlyRaw && monthlyRaw.months ? Object.keys(monthlyRaw.months).sort() : [];
  const last = months[months.length - 1];
  const gen = monthlyRaw && monthlyRaw.generated_at ? String(monthlyRaw.generated_at).slice(0, 10) : '';
  if (!last || !/^\d{4}-\d{2}-\d{2}$/.test(gen) || gen.slice(0, 7) !== last) return generic;
  const day = Number(gen.slice(8, 10));
  const daysInMonth = new Date(Date.UTC(Number(last.slice(0, 4)), Number(last.slice(5, 7)), 0)).getUTCDate();
  if (day >= daysInMonth) return '';
  return `The newest month is PARTIAL: monthly.json was generated ${gen}, so ${last} covers about ${day} days against ${daysInMonth} — it is NOT comparable to the full months beside it, and a drop in the last point or bar may be nothing but the missing days.`;
})();

// The Location sheet the ICP-geography section is classified from reconciles
// with neither unique visitors nor page views, and nothing in the repo defines
// what it counts — so the panels may claim composition, never a headcount.
const GEO_UNIT_NOTE = (() => {
  const base = 'Counts from the Visitors export’s Location sheet (only members whose location LinkedIn names), classified into ICP buckets by geo-monthly.py. Read these as COMPOSITION — the sheet is not a count of visitors.';
  const gm = geoRaw && geoRaw.months;
  const mm = monthlyRaw && monthlyRaw.months;
  if (!gm || !mm) return base;
  const shared = Object.keys(gm).filter((m) => mm[m]);
  if (!shared.length) return base;
  const loc = shared.reduce((a, m) => a + (gm[m].total || 0), 0);
  const uv = shared.reduce((a, m) => a + (mm[m].unique_visitors || 0), 0);
  const pv = shared.reduce((a, m) => a + (mm[m].page_views || 0), 0);
  return `${base} Across ${shared[0]}–${shared[shared.length - 1]} it totals ${loc}, against ${uv} unique visitors and ${pv} page views over the same months — it matches neither, so it cannot be read as "how many people looked at the page".`;
})();

// The follower ICP percentages are computed over the geo-classified SUBSET, not
// over the follower base shown three rows up. The gap is large enough to move
// the panel across a threshold colour, so the ceiling is spelled out.
const FOLLOWER_GEO_NOTE = (() => {
  const base = 'Computed over ONLY those followers whose country the export names — NOT over the follower base shown above. Unclassified followers are excluded from both the numerator and the denominator, so this percentage is an upper bound on the share of the real base.';
  const g = manualRaw && manualRaw.geography && manualRaw.geography.followers;
  const total = g && Number(g.total);
  const us = g && g.buckets && Number(g.buckets.US);
  const baseN = manualRaw && Number(manualRaw.total_followers);
  if (!total || !baseN || !Number.isFinite(us)) return base;
  const stamp = manualRaw._last_updated ? `, recorded ${manualRaw._last_updated}` : '';
  const ceiling = Math.round((1000 * us) / baseN) / 10;
  return `${base} As recorded in manual.json${stamp}: ${total} of ${baseN} followers are geo-classified, so ${baseN - total} are invisible here; the US share of the FULL base is at most ${us}/${baseN} = ${ceiling}%.`;
})();

// The follower curve is not measured — it is reconstructed backwards from a
// hand-entered total, which makes a decline structurally impossible to draw.
const FOLLOWERS_NOTE = (() => {
  const n = manualRaw && Number(manualRaw.total_followers);
  const stamp = manualRaw && manualRaw._last_updated ? `, recorded ${manualRaw._last_updated}` : '';
  const src = n ? `the hand-entered current total (manual.json total_followers = ${n}${stamp})` : 'the hand-entered current total in manual.json';
  return `NOT a measured history. The curve is computed BACKWARDS from ${src} by subtracting each month’s new followers, so it ignores unfollows and can only ever slope upward — it could not show a decline even if the page lost followers every month. Only the newest point is a measured number, and it is exactly as stale as manual.json.`;
})();

// "???" that is a PROMISE, not a lie: both come from the per-post export.
const NEEDS_PER_POST = 'requires the page’s per-post records (obtainable from the post export — not collected yet)';
const NEEDS_PER_POST_IMPRESSIONS = 'requires per-post impression records (obtainable from the post export — not collected yet)';

// Panel descriptions where the honest title still needs a sentence of context.
const VISITORS_NOTE = 'LinkedIn’s Page metric “unique visitors”: a SUM OF DAILY UNIQUES over the month — one person who visits on three days counts three times. It is NOT a personal profile’s “profile viewers”, which counts distinct members over a rolling 90 days. Different object, different window, different definition.';
const SIX_MONTH_NOTE = 'NOT a lifetime total. The page export is a rolling 6-month window (scrape-page.mjs --months=6) and monthly.json is OVERWRITTEN whole on every run, so months older than six are retained nowhere in this repo. This figure drops its oldest month on the next collection and can FALL while engagement rises.';
const TOTAL_NOTE = PER_PERSON
  ? 'Totalled over every per-person engagement event collected so far (dashboards/li-stats/page/engagement.json).'
  : SIX_MONTH_NOTE;
const LATEST_PERIOD_NOTE = PER_PERSON
  ? 'Per-person data is present, so the feed’s “last_week” scope is a REAL ISO week (lib/engagement.mjs).'
  : note(
    'The feed’s “last_week” scope is filled from the LATEST MONTH of the page export (the aggregate fallback in build-page-stats.mjs) — the company page publishes no weekly granularity, so this is a month, not a week.',
    partialMonthNote,
    'If per-person collection later puts engagement.json in place, this scope becomes a real ISO week; this generator reads whether that file exists and words the title accordingly.');
const SCORE_SERIES_NOTE = PER_PERSON
  ? 'One point per real ISO week, from the per-person engagement records (lib/engagement.mjs).'
  : note('One point per MONTH: engagement_score_weeks is derived from the monthly page export (week = first of month), not from real weeks.', partialMonthNote);
// The tier multipliers are inapplicable while only aggregate counts exist, so
// the headline score is an unweighted count — which is exactly what a reader
// would NOT assume from a row promising tier weighting.
const FLAT_WEIGHT_NOTE = PER_PERSON ? '' : 'Flat weighting only — reaction ×1, comment ×5. The ICP ×2 and VIP ×4 multipliers in scoring.json cannot be applied until per-person engagers are collected, which is why every tier panel here reads “???”. This number says nothing about WHO engaged.';
const PEOPLE_NOTE = PER_PERSON ? '' : 'Per-person engagers are NOT collected for the company page yet (dashboards/li-stats/page/engagement.json does not exist). Empty here means UNCOLLECTED, not zero — the score panels above are built from real reactions and comments over the same window.';
const SEARCH_SNAPSHOT_NOTE = 'Hand-entered snapshot from the page admin’s “Search appearances” tab (a rolling last-7-days figure). LinkedIn keeps no history for it, so this number moves only when somebody records a new one into manual.json.';
const SEARCH_SERIES_NOTE = 'One point per hand-entered snapshot in manual.json — not a weekly series. There is currently a single snapshot, so this chart draws ONE DOT rather than a trend.';
const JOB_FUNCTION_NOTE = 'LinkedIn’s “Job function” facet (Engineering, Sales, HR …). The page export contains no job-TITLE breakdown at all.';
const CLICKS_NOTE = 'Clicks and reposts on the page’s posts, straight from the monthly page export — the two engagement columns nothing on this board used to read.';

// The two demographic audiences are DIFFERENT UNITS over a window twice as long
// as the rest of the board. Side-by-side panels invite a magnitude comparison
// that the data does not support, so each side says what it counts.
const DEMO_WINDOW = 'The demographic sheets are a single snapshot over the LAST 365 DAYS (the export range scrape-page.mjs sets) — twice the 6-month window every other panel on this board shows. LinkedIn publishes no per-month demographic breakdown, so this is one slice, not a series.';
const FOLLOWER_DEMO_NOTE = note('A snapshot of the CURRENT follower base — a headcount, top 8 rows of the export.', DEMO_WINDOW);
const VISITOR_DEMO_NOTE = note('Counts of page-VIEW events, not distinct people: one person visiting ten times counts ten, and the totals here run well above the page’s unique-visitor count. Top 8 rows of the export.', DEMO_WINDOW, 'Comparable with the follower panel beside it in COMPOSITION only — never as a headcount, since the two are different units over the same 12 months.');

// ---- one demographic facet, follower base NEXT TO page visitors. Pairing the
// same facet is what makes the two audiences comparable — who SUBSCRIBES to the
// page and who merely LOOKS at it are genuinely different questions — but only
// in shape. Each panel keeps its own axis (a shared one would flatten the
// follower side ~7:1) and each title names its own unit, so the eye compares
// composition, which is the only comparison these two units support.
const followerDemo = (facet, category, extra) => withDesc(
  demoBar(`${facet} — follower base (top 8)`, place(7, 12), 'followers', category),
  note(FOLLOWER_DEMO_NOTE, extra));
const visitorDemo = (facet, category, extra) => withDesc(
  demoBar(`${facet} — page views by visitor ${facet.toLowerCase()} (12 mo, top 8)`, place(7, 12), 'visitors', category),
  note(VISITOR_DEMO_NOTE, extra));
const demoPair = (facet, category, extra) => [followerDemo(facet, category, extra), visitorDemo(facet, category, extra)];

const panels = [
  // ============ engagement score ============
  // The row header must not promise a methodology the data has not had applied
  // to it: while only aggregate counts exist the score is a flat count, and
  // every tier panel below it is "???".
  row(PER_PERSON
    ? 'Engagement score — who engaged, weighted by tier'
    : 'Engagement score — reactions + 5× comments (tier splits not collected yet)'),
  withDesc(scoreStat(`Engagement score (${PERIOD_LABEL})`, place(4, 6), 'last_week', 'score', BLUE), note(LATEST_PERIOD_NOTE, FLAT_WEIGHT_NOTE)),
  tierStat('...from normal audience', place(4, 6), 'last_week', 'score_normal', DARK),
  tierStat('...from ICP', place(4, 6), 'last_week', 'score_icp', GREEN),
  tierStat('...from VIP list (4×)', place(4, 6), 'last_week', 'score_vip', PURPLE),
  withDesc(scoreStat(`Engagement score (${TOTAL_LABEL})`, place(4, 6), 'all_time', 'score', BLUE), note(TOTAL_NOTE, FLAT_WEIGHT_NOTE)),
  withDesc(tierStat('...from normal audience', place(4, 6), 'all_time', 'score_normal', DARK), TOTAL_NOTE),
  withDesc(tierStat('...from ICP', place(4, 6), 'all_time', 'score_icp', GREEN), TOTAL_NOTE),
  withDesc(tierStat('...from VIP list (4×)', place(4, 6), 'all_time', 'score_vip', PURPLE), TOTAL_NOTE),
  withDesc(tierStat(`ICP share of reactions (${TOTAL_LABEL})`, place(4, 6), 'all_time', 'icp_reaction_pct', GREEN), TOTAL_NOTE),
  withDesc(tierStat(`ICP share of comments (${TOTAL_LABEL})`, place(4, 6), 'all_time', 'icp_comment_pct', GREEN), TOTAL_NOTE),
  withDesc(tierStat(`ICP share of all engagement (${TOTAL_LABEL})`, place(4, 6), 'all_time', 'icp_engagement_pct', GREEN), TOTAL_NOTE),
  withDesc(tierStat(`ICP engagers (${TOTAL_LABEL})`, place(4, 6), 'all_time', 'people_icp', GREEN), TOTAL_NOTE),
  withDesc(tsPanel(PER_PERSON ? 'Engagement score per week' : 'Engagement score per month', place(8, 14), 'engagement_score_weeks', ['score']), SCORE_SERIES_NOTE),
  withDesc(peopleTable('Top engagers', place(8, 10)), PEOPLE_NOTE),

  row(`Reactions & comments — total vs ICP (${PERIOD_LABEL} and ${TOTAL_LABEL})`),
  withDesc(reactVsIcpTable('Reactions & comments — total vs ICP', place(6, 24),
    { last_week: { text: cap(PERIOD_LABEL) }, all_time: { text: cap(TOTAL_LABEL) } }),
  note(LATEST_PERIOD_NOTE, TOTAL_NOTE)),

  // ============ account view ============
  row('Account view'),
  withDesc(sparkStat('Followers (reconstructed)', place(4, 6), 'page_account_weeks', 'followers', BLUE), FOLLOWERS_NOTE),
  withDesc(sparkStat('Post impressions (monthly)', place(4, 6), 'page_account_weeks', 'post_impressions', ORANGE), partialMonthNote),
  withDesc(sparkStat('Page visitors (monthly)', place(4, 6), 'page_account_weeks', 'unique_visitors', PURPLE), note(VISITORS_NOTE, partialMonthNote)),
  withDesc(sparkStat('Search appearances (7-day rolling, last snapshot)', place(4, 6), 'page_search_weeks', 'searches', GREEN), SEARCH_SNAPSHOT_NOTE),
  withDesc(tsPanel('Followers (reconstructed)', place(7, 12), 'page_account_weeks', ['followers']), FOLLOWERS_NOTE),
  withDesc(tsPanel('Post impressions (monthly)', place(7, 12), 'page_account_weeks', ['post_impressions']), partialMonthNote),
  withDesc(tsPanel('Page visitors (monthly)', place(7, 12), 'page_account_weeks', ['unique_visitors']), note(VISITORS_NOTE, partialMonthNote)),
  withDesc(tsPanel('Search appearances (manual snapshots)', place(7, 12), 'page_search_weeks', ['searches']), SEARCH_SERIES_NOTE),

  // Demographics: every facet the export carries, for BOTH audiences.
  ...demoPair('Seniority', 'Seniority'),
  ...demoPair('Job function', 'Job function', JOB_FUNCTION_NOTE),
  ...demoPair('Industry', 'Industry'),
  ...demoPair('Company size', 'Company size'),
  ...demoPair('Location', 'Location'),

  unknownPanel('Posts published per month', place(7, 12), NEEDS_PER_POST),
  withDesc(monthlyBar('Post clicks & reposts per month', place(7, 12), ['post_clicks', 'post_reposts']), note(CLICKS_NOTE, partialMonthNote)),
  unknownPanel('Posts published vs impressions (scatter + linear fit)', place(7, 12), NEEDS_PER_POST_IMPRESSIONS),
  unknownPanel('Impressions per post over time', place(7, 12), NEEDS_PER_POST_IMPRESSIONS),

  // ============ company-specific extras (below the replica) ============
  // Everything in this section is classified from the export's Location sheet,
  // which reconciles with neither unique visitors nor page views — so the
  // titles say "locations", never "visitors".
  row('ICP geography — US vs India (company-page extra)'),
  withDesc(icpStat('US · ICP share of visitor locations (6 mo)', place(6, 6), 'visitors'), GEO_UNIT_NOTE),
  withDesc(icpStat('US · ICP share — followers (geo-classified subset)', place(6, 6), 'followers'), FOLLOWER_GEO_NOTE),
  withDesc(bucketGauge('Visitor locations by ICP bucket (6 mo)', place(6, 6), 'visitors'), GEO_UNIT_NOTE),
  withDesc(bucketGauge('Followers by ICP bucket (geo-classified subset)', place(6, 6), 'followers'), FOLLOWER_GEO_NOTE),
  withDesc(monthlyBar('US · ICP share of visitor locations by month', place(8, 12), ['icp_pct'], 'page_geo_monthly', 'percent'), note(GEO_UNIT_NOTE, partialMonthNote)),
  withDesc(monthlyBar('Visitor locations by month', place(8, 12), ['us', 'team', 'anti', 'other'], 'page_geo_monthly', 'short', 'normal'), note(GEO_UNIT_NOTE, partialMonthNote)),
  withDesc(monthlyBar('Page views & unique visitors', place(8, 12), ['page_views', 'unique_visitors']), note(VISITORS_NOTE, partialMonthNote)),
  withDesc(monthlyBar('New followers per month', place(8, 12), ['new_followers']), partialMonthNote),

  row('Selected month — pick $month above'),
  withDesc(monthStat('US · ICP share of locations ($month)', place(5, 6), 'icp_pct', 'percent', true), note(GEO_UNIT_NOTE, partialMonthNote)),
  withDesc(monthStat('India / China share of locations ($month)', place(5, 6), 'anti_pct', 'percent'), note(GEO_UNIT_NOTE, partialMonthNote)),
  // Raw counts off the Location sheet — NOT a share and NOT a visitor count.
  withDesc(monthStat('US · Location-sheet count ($month)', place(5, 6), 'us', 'short'), note(GEO_UNIT_NOTE, partialMonthNote)),
  withDesc(monthStat('India / China · Location-sheet count ($month)', place(5, 6), 'anti', 'short'), note(GEO_UNIT_NOTE, partialMonthNote)),
];

// $month picker. It used to be a 'custom' variable whose options were baked
// from the local geo-monthly.json AT GENERATION TIME — so once the data moved
// on and nobody re-ran this script, the picker quietly kept offering the old
// months. It is a QUERY variable reading the SAME feed view the month panels
// read, so the month list tracks the data by itself — and its SQL comes out of
// the same feedSql() as every target, so the two cannot drift apart.
// Shape per Grafana's PostgreSQL datasource: `query` (and `definition`, which is
// only what the variables list shows) is the SQL string itself; a one-column
// result serves as both the option's text and its value. The view's order is
// kept (order by ord) and Grafana re-sorts on top of it: alphabetically
// DESCENDING, so the newest month is first — which is also what Grafana falls
// back to when the stored selection is no longer among the returned options.
const monthSql = feedSql('page_geo_monthly', [col('month', 'string')]);
const monthVar = {
  name: 'month', type: 'query', label: 'Month', datasource: DS,
  definition: monthSql,
  query: monthSql,
  current: {}, options: [], refresh: 1, sort: 2, regex: '', hide: 0,
  includeAll: false, multi: false, skipUrlSync: false,
};

// A ${name:sqlstring} that no variable on this board defines would reach
// Postgres uninterpolated — a syntax error in every panel that carries it.
const templating = { list: [monthVar] };
for (const v of usedVars) {
  if (!templating.list.some((t) => t.name === v)) throw new Error(`a filter uses \${${v}} but this dashboard declares no such variable`);
}

// The time picker is HIDDEN, not merely unused. Every target here is a plain
// SQL read of a whole feed view: no rawSql carries $__timeFilter or any other
// time macro, so nothing applies the dashboard range. A visible picker would
// therefore answer "Last 30 days" with the identical six-month board — a
// control that responds to input with unchanged data, which is exactly the
// kind of lie the rest of this file exists to remove. Each panel states its own
// window in its title and description instead. Give this board a working picker
// only by making the targets time-aware first.
const dashboard = {
  uid: 'linkedin-page', title: 'LinkedIn Stats — Company Page', tags: ['linkedin', 'company-page'],
  timezone: '', schemaVersion: 42, version: 1, refresh: '', time: { from: 'now-1y', to: 'now' },
  timepicker: { hidden: true },
  templating, annotations: { list: [] }, panels,
};
fs.writeFileSync(OUT, JSON.stringify(dashboard, null, 2) + '\n');
const targetCount = panels.reduce((n, p) => n + (p.targets ? p.targets.length : 0), 0);
console.error(`wrote ${OUT} — ${panels.length} panels, ${targetCount} SQL targets, datasource=${DS.type}`);
