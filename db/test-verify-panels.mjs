#!/usr/bin/env node
// The panel parity check, checked. A harness that says "OK" is only worth
// something if it is known to say "DIFF" when it should — so the second half of
// this file breaks a correct dashboard in every way that matters (a wrong value,
// a wrong column order, a missing row, two rows swapped, a target left on
// Infinity, …) and demands that each break is DETECTED, by its right name.
//
// No database, no git, no corpus: verifyDashboard() takes the feed and the query
// function as arguments, and here both are fakes. The frames the stub answers
// with are written out by hand, not produced by the emulator — otherwise the
// emulator would be checked against itself.
//
//   node db/test-verify-panels.mjs

import {
  parseFilter, applyColumns, sqlstring, interpolateSql, usedSqlVars, emulateInfinity, variableValues,
  compareFrames, verifyDashboard, verdict, formatProblem, feedKey,
  INFINITY_TYPE, PG_TYPE, PG_UID, PROBE, Refusal, NotEmulated,
} from "./verify-panels.mjs";

const fails = [];
const check = (what, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "OK  " : "FAIL"}  ${what}`);
  if (!ok) { console.log(`        want: ${JSON.stringify(want)}`); console.log(`        got:  ${JSON.stringify(got)}`); fails.push(what); }
};
const throws = (what, fn, cls) => {
  let thrown = null;
  try { fn(); } catch (e) { thrown = e; }
  const ok = thrown instanceof cls;
  console.log(`${ok ? "OK  " : "FAIL"}  ${what}`);
  if (!ok) { console.log(`        want: a ${cls.name}, got: ${thrown ? thrown.constructor.name : "no error"}`); fails.push(what); }
};

// ------------------------------------------------------------ parseFilter

const ROWS = [
  { id: "p1", scope: "last_week", dimension: "seniority", audience: "followers", category: "Job function", month: "2026-03" },
  { id: "p1", scope: "all_time", dimension: "industry", audience: "visitors", category: "Job function", month: "2026-04" },
  { id: "p2", scope: "all_time", dimension: "seniority", audience: "followers", category: "Seniority", month: "2026-04" },
  { id: null, scope: null },
];
const pick = (expr, vars) => { const f = parseFilter(expr); return ROWS.map((r, i) => (f(r, vars) ? i : -1)).filter((i) => i >= 0); };

check("filter: none at all keeps every row", [pick(undefined), pick(""), pick("   ")], [[0, 1, 2, 3], [0, 1, 2, 3], [0, 1, 2, 3]]);
check('filter: scope == "last_week"', pick('scope == "last_week"'), [0]);
check('filter: id == "${post}" takes the raw value', pick('id == "${post}"', { post: "p1" }), [0, 1]);
check('filter: month == "${month}"', pick('month == "${month}"', { month: "2026-04" }), [1, 2]);
check("filter: (a) && (b), with a variable", pick('(id == "${post}") && (dimension == "seniority")', { post: "p1" }), [0]);
check("filter: a literal with a space in it", pick('(audience == "followers") && (category == "Job function")'), [0]);
check("filter: a null field never matches", pick('scope == "all_time"'), [1, 2]);
check("filter: a value with quotes in it is compared, not spliced", pick('id == "${post}"', { post: PROBE }), []);
check("filter: reports the variables it uses", [parseFilter('(id == "${post}") && (month == "${month}")').vars, parseFilter('scope == "x"').vars], [["month", "post"], []]);

for (const [what, expr] of [
  ["a > comparison", "impressions > 10"],
  ["an || operator", 'scope == "a" || scope == "b"'],
  ["a != operator", 'scope != "last_week"'],
  ["a function call", 'lower(scope) == "last_week"'],
  ["a negation", '!(scope == "last_week")'],
  ["a single-quoted literal", "scope == 'last_week'"],
  ["a number literal", "impressions == 10"],
  ["a === operator", 'scope === "last_week"'],
  ["an unbalanced parenthesis", '(scope == "last_week"'],
  ["trailing input", 'scope == "last_week" scope'],
  ["a dangling &&", 'scope == "last_week" &&'],
  ["an unknown variable", 'week == "${account_latest_week}"'],
  ["a variable glued to text", 'id == "x${post}"'],
  ["a $var without braces", 'id == "$post"'],
  ["an escape sequence", 'id == "a\\"b"'],
]) throws(`filter: rejects ${what}`, () => parseFilter(expr), NotEmulated);
throws("filter: a variable with no value is an error, not a silent mismatch", () => parseFilter('id == "${post}"')(ROWS[0], {}), NotEmulated);
throws("filter: a non-string field is not guessed at", () => parseFilter('n == "1"')({ n: 1 }), NotEmulated);

// ----------------------------------------------------------- applyColumns

const COLS = [
  { selector: "b", text: "B", type: "string" },
  { selector: "a", text: "Eng. %", type: "number" },
  { selector: "c", text: "", type: "string" },
  { selector: "zz", text: "Z", type: "number" },
];
check("columns: selector -> text, in the order given; a missing key and a null are null",
  applyColumns([{ a: 0.41, b: "x", c: null }, { a: 0, b: "", c: "y", zz: 7 }], COLS),
  { columns: [{ name: "B", type: "string" }, { name: "Eng. %", type: "number" }, { name: "c", type: "string" }, { name: "Z", type: "number" }],
    rows: [["x", 0.41, null, null], ["", 0, "y", 7]], coerced: [] });
check("columns: a number read as string is String(v), a numeric string read as number is Number(v) — and both are reported",
  applyColumns([{ a: "12.5", b: 3 }], COLS.slice(0, 2)),
  { columns: [{ name: "B", type: "string" }, { name: "Eng. %", type: "number" }], rows: [["3", 12.5]], coerced: ["B", "Eng. %"] });
check('columns: a string that is not a number ("???", "") is an empty cell, not NaN',
  applyColumns([{ a: "???" }, { a: "" }], [COLS[1]]).rows, [[null], [null]]);
check("columns: no rows still yields the columns", applyColumns([], COLS.slice(0, 2)).columns.map((c) => c.name), ["B", "Eng. %"]);
throws("columns: an unknown type is not guessed at", () => applyColumns([], [{ selector: "a", text: "A", type: "timestamp" }]), NotEmulated);
throws("columns: a nested selector is not guessed at", () => applyColumns([], [{ selector: "a.b", text: "A", type: "string" }]), NotEmulated);
throws("columns: a nested value is not guessed at", () => applyColumns([{ a: { x: 1 } }], [{ selector: "a", text: "A", type: "string" }]), NotEmulated);
throws("columns: a target without columns is not guessed at", () => applyColumns([{ a: 1 }], []), NotEmulated);

// -------------------------------------------------- sqlstring / rawSql

check("sqlstring: O'Brien", sqlstring("O'Brien"), "'O''Brien'");
check("sqlstring: plain, empty, number, list", [sqlstring("7432"), sqlstring(""), sqlstring(5), sqlstring(["a", "b'c"])], ["'7432'", "''", "'5'", "'a','b''c'"]);
check("sqlstring: an injection attempt stays one literal", sqlstring("x' or '1'='1"), "'x'' or ''1''=''1'");

check("rawSql: ${post:sqlstring} and ${month:sqlstring} expand to escaped literals",
  interpolateSql("select 1 where id = ${post:sqlstring} and month = ${month:sqlstring} or id = ${post:sqlstring}", { post: "O'Brien", month: "2026-04" }),
  "select 1 where id = 'O''Brien' and month = '2026-04' or id = 'O''Brien'");
check("rawSql: no variables, no change", interpolateSql('select week as "Week" from dash.feed_account_weeks order by ord'), 'select week as "Week" from dash.feed_account_weeks order by ord');
check("rawSql: reports the variables it uses", usedSqlVars("a = ${post:sqlstring} and b = ${month:sqlstring} and c = ${post:sqlstring}"), ["month", "post"]);
for (const [what, sql] of [
  ["a raw ${post}", "select 1 where id = '${post}'"],
  ["a raw ${post} next to a good one", "select 1 where id = ${post:sqlstring} or id = '${post}'"],
  ["a raw $post", "select 1 where id = '$post'"],
  ["a [[post]]", "select 1 where id = '[[post]]'"],
  ["another format (${post:csv})", "select 1 where id in (${post:csv})"],
  ["a $__timeFilter macro", "select 1 where $__timeFilter(week)"],
  ["a $__timeFrom macro", "select 1 where week > $__timeFrom()"],
  ["a placeholder inside quotes", "select 1 where id = '${post:sqlstring}'"],
  ["an unknown variable", "select 1 where week = ${account_latest_week:sqlstring}"],
  ["the template token __AUTHOR__", "select 1 from dash.feed_posts where author = '__AUTHOR__'"],
  ["an empty rawSql", "  "],
  ["a missing rawSql", undefined],
]) throws(`rawSql: refuses ${what}`, () => interpolateSql(sql, { post: "p1", month: "2026-04" }), Refusal);

// ------------------------------------------------ frames and feed URLs

const F = (cols, rows) => ({ columns: cols.map(([name, type]) => ({ name, type })), rows });
const A = F([["n", "string"], ["v", "number"]], [["a", 1], ["b", null]]);
check("compare: identical frames", compareFrames(A, F([["n", "string"], ["v", "number"]], [["a", 1], ["b", null]])), null);
check("compare: 1 and 1.0 are the same number; undefined is null", compareFrames(A, F([["n", "string"], ["v", "number"]], [["a", 1.0], ["b", undefined]])), null);
check("compare: null is not 0", compareFrames(A, F([["n", "string"], ["v", "number"]], [["a", 1], ["b", 0]]))?.kind, "value");
check('compare: "1" is not 1', compareFrames(A, F([["n", "string"], ["v", "number"]], [["a", "1"], ["b", null]]))?.detail, "number vs string");
check("compare: a text column where a number is due", compareFrames(A, F([["n", "string"], ["v", "string"]], [["a", "1"], ["b", null]]))?.kind, "column-type");
check("compare: a renamed column", compareFrames(A, F([["n", "string"], ["w", "number"]], [["a", 1], ["b", null]]))?.kind, "column-name");
check("compare: an extra column", compareFrames(A, F([["n", "string"], ["v", "number"], ["x", "number"]], []))?.kind, "column-count");
check("compare: an empty result still has to carry the columns", compareFrames(F([["n", "string"]], []), F([["m", "string"]], []))?.kind, "column-name");

check("feed url: author, page, anything else",
  [feedKey("https://speedandfunction.github.io/LinkedInStatistic/peter/stats.json"),
   feedKey("https://speedandfunction.github.io/LinkedInStatistic/page-stats.json"),
   feedKey("https://speedandfunction.github.io/LinkedInStatistic/stats.json"),
   feedKey("https://example.com/peter/stats.json"), feedKey(undefined)],
  ["author:peter", "page", null, null, null]);

// ------------------------------------------------------- end to end, faked

// The sentinels below stand in for personal data: no report line may carry them.
const SENTINELS = ["Zed Sentinel", "O'Brien", "0.41", "0.42", "sentinel-headline"];
const FEED = {
  posts: [{ id: "p1" }, { id: "p2" }],
  post_weeks: [
    { id: "p1", week: "2026-01-05", impressions: 10, engagement_rate: 0.41 },
    { id: "p1", week: "2026-01-12", impressions: 25, engagement_rate: 1.5 },
    { id: "p2", week: "2026-01-05", impressions: 7, engagement_rate: null },
  ],
  engagement_people: [
    { name: "Zed Sentinel", headline: "sentinel-headline", tier: "icp", score: 9 },
    { name: "Amy O'Brien", headline: "sentinel-headline", tier: "normal", score: 4 },
  ],
  account_weeks: [{ week: "2026-01-05" }, { week: "2026-01-12" }],
};
const FEED_URL = "https://speedandfunction.github.io/LinkedInStatistic/fake/stats.json";
const INF_DS = { type: INFINITY_TYPE, uid: "grafanacloud-infinity" };
const PG_DS = { type: PG_TYPE, uid: PG_UID };
const infinity = (root_selector, columns, filterExpression) => ({
  columns, computed_columns: [], datasource: INF_DS, filters: [], format: "table", parser: "backend", refId: "A",
  root_selector, source: "url", type: "json", url: FEED_URL, url_options: { data: "", method: "GET" },
  ...(filterExpression ? { filterExpression } : {}),
});
const sqlTarget = (rawSql) => ({ datasource: PG_DS, editorMode: "code", format: "table", rawQuery: true, rawSql, refId: "A" });
const col = (selector, text, type) => ({ selector, text, type });

const SQL = {
  people: `select name as "Name", tier as "Tier", score as "Score" from dash.feed_engagement_people where author = 'fake' order by ord`,
  weeks: `select week as "Week", impressions as "Impressions", engagement_rate as "Eng. %" from dash.feed_post_weeks where author = 'fake' and id = \${post:sqlstring} order by ord`,
  acct: `select week from dash.feed_account_weeks where author = 'fake' order by ord`,
};
// A function, not a constant: structuredClone() keeps shared references shared,
// and a test that edits one panel must not edit its neighbour.
const panelRest = () => ({ type: "table", gridPos: { h: 8, w: 12, x: 0, y: 0 }, fieldConfig: { defaults: { unit: "short" }, overrides: [] },
  transformations: [{ id: "organize", options: {} }] });
const OLD = {
  templating: { list: [
    { name: "account_latest_week", type: "query", hide: 2, sort: 2, refresh: 1, datasource: INF_DS,
      query: { ...infinity("account_weeks", [col("week", "week", "string")]), refId: "acct_week_var" } },
    { name: "post", type: "custom", query: "one : p1, two : p2" },
  ] },
  panels: [
    { id: 1, type: "row", title: "Row", panels: [] },
    { id: 2, title: "Top engagers", datasource: INF_DS, ...panelRest(),
      targets: [infinity("engagement_people", [col("name", "Name", "string"), col("tier", "Tier", "string"), col("score", "Score", "number")])] },
    { id: 3, title: "Post weeks", datasource: INF_DS, ...panelRest(),
      targets: [infinity("post_weeks", [col("week", "Week", "string"), col("impressions", "Impressions", "number"), col("engagement_rate", "Eng. %", "number")], 'id == "${post}"')] },
  ],
};
const NEW = () => structuredClone({
  templating: { list: [
    { name: "account_latest_week", type: "query", hide: 2, sort: 2, refresh: 1, datasource: PG_DS, query: SQL.acct, definition: SQL.acct },
    { name: "post", type: "custom", query: "" },
  ] },
  panels: [
    { id: 1, type: "row", title: "Row", panels: [] },
    { id: 2, title: "Top engagers", datasource: PG_DS, ...panelRest(), targets: [sqlTarget(SQL.people)] },
    { id: 3, title: "Post weeks", datasource: PG_DS, ...panelRest(), targets: [sqlTarget(SQL.weeks)] },
  ],
});
const weeksCols = [["Week", "string"], ["Impressions", "number"], ["Eng. %", "number"]];
const weeksSql = (v) => SQL.weeks.replace("${post:sqlstring}", sqlstring(v));
const ANSWERS = () => new Map([
  [SQL.people, F([["Name", "string"], ["Tier", "string"], ["Score", "number"]], [["Zed Sentinel", "icp", 9], ["Amy O'Brien", "normal", 4]])],
  [weeksSql("p1"), F(weeksCols, [["2026-01-05", 10, 0.41], ["2026-01-12", 25, 1.5]])],
  [weeksSql("p2"), F(weeksCols, [["2026-01-05", 7, null]])],
  [weeksSql(PROBE), F(weeksCols, [])],
  [SQL.acct, F([["week", "string"]], [["2026-01-05"], ["2026-01-12"]])],
]);

const reportLines = [];
async function runFake({ dash = NEW(), answers = ANSWERS(), oldDash = OLD } = {}) {
  const asked = [];
  const r = await verifyDashboard({
    name: "linkedin-fake.json", oldDash, newDash: dash, feedFor: (url) => { if (url !== FEED_URL) throw new Error("wrong feed url"); return FEED; },
    query: async (sql) => {
      asked.push(sql);
      const a = answers.get(sql);
      if (a instanceof Error) throw a;
      if (!a) throw Object.assign(new Error('relation "nope" does not exist'), { code: "42P01", severity: "ERROR" });
      return structuredClone(a);
    },
  });
  for (const p of r.problems) reportLines.push(formatProblem(p));
  return { ...r, asked, kinds: r.problems.map((p) => p.kind) };
}
const first = (r) => { const { kind, panelId, refId, varIndex, column, row } = r.problems[0] ?? {}; return { kind, panelId, refId, varIndex, column, row }; };

{
  const r = await runFake();
  check("e2e: the correct port passes — 2 targets; 1 + 3 (p1, p2, probe) + 1 variable = 5 comparisons",
    { targets: r.targets, comparisons: r.comparisons, problems: r.problems.map(formatProblem) }, { targets: 2, comparisons: 5, problems: [] });
  check("e2e: the probe reached the database as ONE escaped literal", r.asked.includes(weeksSql(PROBE)) && weeksSql(PROBE).includes(`'no-such-value-''"'`), true);
  check("e2e: …and that is a pass", verdict([r]).ok, true);
}
{
  const answers = ANSWERS(); answers.get(weeksSql("p1")).rows[0][2] = 0.42;
  const r = await runFake({ answers });
  check("e2e: a WRONG VALUE is detected, located by variable index / column / row",
    [r.kinds, first(r)], [["value"], { kind: "value", panelId: 3, refId: "A", varIndex: "post#0", column: "Eng. %", row: 0 }]);
  check("e2e: …and fails the run", verdict([r]).ok, false);
}
{
  const answers = ANSWERS(); answers.get(weeksSql("p2")).rows[0][2] = 0;
  const r = await runFake({ answers });
  check("e2e: a 0 where the feed has null is detected", first(r), { kind: "value", panelId: 3, refId: "A", varIndex: "post#1", column: "Eng. %", row: 0 });
}
{
  const answers = ANSWERS();
  answers.set(SQL.people, F([["Tier", "string"], ["Name", "string"], ["Score", "number"]], [["icp", "Zed Sentinel", 9], ["normal", "Amy O'Brien", 4]]));
  const r = await runFake({ answers });
  check("e2e: a WRONG COLUMN ORDER is detected", [r.kinds, first(r).panelId, first(r).column], [["column-order"], 2, "Name"]);
}
{
  const answers = ANSWERS(); answers.get(weeksSql("p1")).rows.pop();
  const r = await runFake({ answers });
  check("e2e: a MISSING ROW is detected", [r.kinds, first(r).varIndex], [["row-count"], "post#0"]);
}
{
  const answers = ANSWERS(); answers.get(SQL.people).rows.reverse();
  const r = await runFake({ answers });
  check("e2e: a SWAPPED ROW ORDER is detected, and named as an ordering problem", [r.kinds, first(r).row], [["row-order"], 0]);
}
{
  const answers = ANSWERS(); answers.get(weeksSql(PROBE)).rows.push(["2026-01-05", 10, 0.41]);
  const r = await runFake({ answers });
  check("e2e: a filter that lets an unknown id through is detected by the probe", [r.kinds, first(r).varIndex], [["row-count"], "post#probe"]);
}
{
  const answers = ANSWERS();
  for (const v of ["p1", "p2"]) answers.get(weeksSql(v)).rows.forEach((row) => { row[1] += 1; });
  const r = await runFake({ answers });
  check("e2e: one target wrong for every variable value is ONE problem with a count", [r.kinds, r.problems[0].more, r.problems[0].of], [["value"], 1, 3]);
}
{
  const answers = ANSWERS();
  answers.set(SQL.people, F([["Name", "string"], ["Tier", "string"], ["Score", "string"]], [["Zed Sentinel", "icp", "9"], ["Amy O'Brien", "normal", "4"]]));
  const r = await runFake({ answers });
  check("e2e: a number delivered as text is detected", [r.kinds, first(r).column], [["column-type"], "Score"]);
}
{
  const answers = ANSWERS(); answers.get(SQL.acct).rows.reverse();
  const r = await runFake({ answers });
  check("e2e: a query variable offering its values in another order is detected", [r.kinds, r.problems[0].variable, r.problems[0].row], [["row-order"], "account_latest_week", 0]);
}
{
  const dash = NEW(); dash.panels[1].targets[0] = OLD.panels[1].targets[0];
  const r = await runFake({ dash });
  check("e2e: a target STILL ON INFINITY fails", [r.kinds, first(r).panelId, r.targets, verdict([r]).ok], [["still-infinity"], 2, 1, false]);
}
{
  const dash = NEW(); dash.templating.list[0] = OLD.templating.list[0];
  const r = await runFake({ dash });
  check("e2e: a variable still on Infinity fails", r.kinds, ["still-infinity"]);
}
{
  const dash = NEW(); dash.panels.push({ id: 99, title: "New", datasource: PG_DS, ...panelRest(), targets: [sqlTarget(SQL.people)] });
  const r = await runFake({ dash });
  check("e2e: a panel with NO COUNTERPART fails (and is not counted as compared)", [r.kinds, r.targets], [["no-counterpart", "no-counterpart"], 2]);
}
{
  const dash = NEW(); dash.panels[2].targets[0].refId = "B";
  const r = await runFake({ dash });
  check("e2e: a changed refId is a target without a counterpart, and a baseline target nobody ported", r.kinds, ["no-counterpart", "dropped"]);
}
{
  const dash = NEW(); dash.panels.splice(1, 1);
  const r = await runFake({ dash });
  check("e2e: a dropped panel fails", r.kinds, ["dropped"]);
}
{
  const dash = NEW(); dash.panels[2].targets[0].rawSql = SQL.weeks.replace("${post:sqlstring}", "'${post}'");
  const r = await runFake({ dash });
  check("e2e: a raw ${post} in rawSql is REFUSED — and never reaches the database",
    [r.kinds, r.asked.filter((s) => s.includes("feed_post_weeks")).length], [["refused"], 0]);
}
{
  const dash = NEW(); dash.panels[1].targets[0].rawSql = `${SQL.people.replace(" order by ord", "")} and $__timeFilter(week) order by ord`;
  const r = await runFake({ dash });
  check("e2e: a time macro is refused", r.kinds, ["refused"]);
}
{
  const dash = NEW(); dash.panels[1].fieldConfig.defaults.unit = "percent"; dash.panels[2].transformations = [];
  const r = await runFake({ dash });
  check("e2e: anything changed in a panel besides targets/datasource is detected, by key",
    r.problems.map((p) => [p.panelId, p.kind, p.detail.split(": ")[1]]), [[2, "panel-changed", "fieldConfig"], [3, "panel-changed", "transformations"]]);
}
{
  const dash = NEW(); dash.templating.list[0].sort = 1; dash.templating.list[0].definition = "select 1";
  const r = await runFake({ dash });
  check("e2e: a variable that changed besides its query is detected", r.kinds, ["variable-shape", "variable-changed"]);
}
// --- outside the panels: green frames do not make a working dashboard.
{
  const dash = NEW(); dash.refresh = "5s"; dash.time = { from: "now-5m", to: "now" }; dash.links = []; dash.version = 99; dash.id = 7;
  const r = await runFake({ dash });
  check("e2e: a dashboard-level key that moved (refresh, time, links) is detected, by key — version and id are not",
    r.problems.map((p) => [p.scope, p.kind, p.detail.split(": ")[1]]), [["dashboard", "dashboard-changed", "links, refresh, time"]]);
  check("e2e: …and fails the run although every frame matched", [r.comparisons, verdict([r]).ok], [5, false]);
}
{
  const dash = NEW(); dash.templating.enable = false;
  const r = await runFake({ dash });
  check("e2e: a templating key besides list is detected", r.problems.map((p) => [p.kind, p.detail.split(": ")[1]]), [["dashboard-changed", "enable"]]);
}
{
  const dash = NEW(); Object.assign(dash.templating.list[1], { multi: true, includeAll: true });
  const r = await runFake({ dash });
  check("e2e: $post made multi-value / All is detected twice — as a change of a custom variable and as a broken :sqlstring contract",
    r.problems.map((p) => [p.variable, p.kind]), [["post", "variable-changed"], ["post", "variable-multi"]]);
}
{
  // The baseline itself already multi: nothing "changed", the SQL is still broken.
  const oldDash = structuredClone(OLD); oldDash.templating.list[1].includeAll = true;
  const dash = NEW(); dash.templating.list[1].includeAll = true;
  const r = await runFake({ dash, oldDash });
  check("e2e: a ${var:sqlstring} variable with includeAll is refused even when the baseline had it", r.kinds, ["variable-multi"]);
}
{
  const dash = NEW(); Object.assign(dash.templating.list[1], { query: "a : p1", options: [{ text: "a", value: "p1" }], current: { text: "a", value: "p1" } });
  const r = await runFake({ dash });
  check("e2e: options / current / query of the custom $post variable may move (update-post-variable.mjs rewrites them)", r.kinds, []);
}
{
  const dash = NEW(); dash.templating.list[1].hide = 2; dash.templating.list.push({ name: "extra", type: "custom", query: "x" });
  const r = await runFake({ dash });
  check("e2e: any other key of a custom variable, and a variable the baseline lacks, are detected",
    r.problems.map((p) => [p.variable, p.kind]), [["extra", "no-counterpart"], ["post", "variable-changed"]]);
}
{
  const dash = NEW(); dash.templating.list.pop();
  const r = await runFake({ dash });
  check("e2e: a dropped custom variable is detected (the frames still match: $post is enumerated from the feed)", r.problems.map((p) => [p.variable, p.kind]), [["post", "dropped"]]);
}
{
  const dash = NEW(); dash.templating.list.reverse();
  const r = await runFake({ dash });
  check("e2e: reordered variables are detected", r.kinds, ["variable-order"]);
}
{
  const dash = NEW();
  dash.panels[1].targets[0].datasource = { type: PG_TYPE, uid: "a-real-uid-must-not-be-committed" };
  dash.panels[2].targets[0].format = "time_series";
  const r = await runFake({ dash });
  check("e2e: a committed datasource uid and a wrong format are detected", r.kinds, ["target-shape", "target-shape"]);
  check("e2e: …without echoing the uid", reportLines.some((l) => l.includes("a-real-uid")), false);
}
{
  const answers = ANSWERS(); answers.delete(SQL.people);
  const r = await runFake({ answers });
  check("e2e: a rawSql the database rejects is a problem of THAT target, reported by SQLSTATE — and the run goes on",
    [r.kinds, r.problems[0].detail.includes("SQLSTATE 42P01"), r.comparisons], [["sql-error"], true, 4]);
}
{
  const r = await runFake({ oldDash: NEW() });
  check("e2e: a baseline that is already SQL (after the merge) is not mistaken for parity", [...new Set(r.kinds)].sort(), ["baseline-not-infinity", "nothing-compared"]);
}
{
  const empty = await verifyDashboard({ name: "x.json", oldDash: { panels: [] }, newDash: { panels: [] }, feedFor: () => FEED, query: async () => F([], []) });
  check("e2e: a dashboard with zero targets is a problem, not a pass", [empty.problems.map((p) => p.kind), verdict([empty]).ok], [["nothing-compared"], false]);
  check("verdict: nothing compared at all is a failure", [verdict([]).ok, verdict([{ targets: 0, comparisons: 0, problems: [] }]).ok], [false, false]);
  check("verdict: one good dashboard and one bad is a failure",
    verdict([{ targets: 3, comparisons: 3, problems: [] }, { targets: 1, comparisons: 1, problems: [{}] }]), { dashboards: 2, targets: 4, comparisons: 4, problems: 1, ok: false });
}

check("emulator: a variable query with meta.valueField picks that column",
  variableValues(emulateInfinity(infinity("account_weeks", [col("week", "week", "string")]), FEED), "week"), ["2026-01-05", "2026-01-12"]);
throws("emulator: an Infinity feature outside the ones in use (uql, …) is not guessed at",
  () => emulateInfinity({ ...infinity("account_weeks", [col("week", "week", "string")]), uql: "parse-json" }, FEED), NotEmulated);

check(`privacy: ${reportLines.length} report lines were produced above, and none carries a cell value`,
  [reportLines.length > 20, reportLines.filter((l) => SENTINELS.some((s) => l.includes(s)))], [true, []]);

if (fails.length) { console.error(`\n${fails.length} check(s) failed`); process.exit(1); }
console.log("\nthe panel parity harness accepts what it should and detects what it must");
