#!/usr/bin/env node
// The PANEL parity check. db/verify.mjs proves that the database can rebuild the
// JSON feeds; this file proves the next step — that every Grafana target ported
// from the public JSON feed (Infinity datasource) to Postgres still returns the
// SAME frame: same column names, same column order, same rows in the same order,
// same values.
//
// Offline: no Grafana, no network. For every dashboard that is ours
// (linkedin-<author>.json, linkedin-<author>-posts.json for every author in
// profiles.json — the rule gen-author-dashboards.mjs generates by — and
// linkedin-page.json) and every SQL target in it:
//
//   1. find the same panel (panel id + refId) in the PREVIOUS, Infinity version
//      of the file:            git show <baseline>:dashboards/grafana/<file>
//   2. emulate that Infinity query in JS on the freshly built JSON feed
//      (root_selector -> array, filterExpression -> rows, columns -> cells);
//   3. run the new rawSql against the database, expanding ${var:sqlstring} the
//      way Grafana does;
//   4. compare the two frames exactly. Numbers numerically, strings exactly,
//      null == null.
//
// ${post} is iterated over EVERY post id of that author, ${month} over EVERY
// month the old variable offered, plus one probe value that matches nothing and
// carries a quote — so the escaping is exercised, not assumed. The two query
// variables (account_latest_week, month) are compared as ordered lists.
//
//   LI_DSN=<url> node db/verify-panels.mjs [--baseline <git ref>] [--now <iso>]
//                       [--dashboards <dir>] [--repo <dir>] [--max 40] [--dsn <url>]
//
// --baseline defaults to main. That is right only UNTIL the port is merged: from
// then on main holds the SQL version, and the baseline has to be the last commit
// that still had the Infinity targets (--baseline <sha>).
//
// THE CLOCK. Both sides run at the same pinned instant, for the reason spelled
// out in db/verify.mjs and db/export.mjs: build-stats-json.mjs reads the clock in
// two places (the month tail, `last_week`), and the dash views read li.as_of().
// The pin is transaction-local and the transaction is READ ONLY — the same shape
// as openDb() in export.mjs. openDb itself is not reused because it hands back
// rows only, and a frame needs the field list too: names, order and types are
// part of the comparison, also when the result is empty.
//
// Exit 0 = every target of every dashboard matched, at least one comparison ran,
//          no target is still Infinity and every SQL target found its counterpart
//          — AND nothing outside the ported parts moved: every dashboard-level
//          key (refresh, time, links, title, …), every non-query variable except
//          options/current/query of $post, and the rule that a variable used as
//          ${name:sqlstring} is single-valued (multi / includeAll off).
// Exit 1 = a mismatch, listed by dashboard / panel id / title / refId / variable
//          value INDEX / column name / row index.
// Exit 2 = the check COULD NOT RUN (database unreachable, a build script failed,
//          the baseline ref does not exist).
//
// It NEVER prints a cell value: the repository is public, CI logs are
// world-readable, and the cells are third-party people's names and headlines.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { pgConfig, resolveDsn } from "./pg-config.mjs";
import { SafeError, safeError } from "./safe-log.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");

export const INFINITY_TYPE = "yesoreyeram-infinity-datasource";
export const PG_TYPE = "grafana-postgresql-datasource";
export const PG_UID = "${DS_LINKEDIN_PG}";   // the literal placeholder; the real uid never enters the repo
// A value no post id and no month equals. The quote is the point: a rawSql that
// escapes properly returns an empty frame for it, exactly like the old filter.
export const PROBE = `no-such-value-'"`;

const KNOWN_VARS = ["post", "month"];
const PLAIN_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Our own messages: dashboard text and identifiers only, never a cell.
export class Refusal extends SafeError {}      // a rawSql the contract forbids
export class NotEmulated extends SafeError {}  // an Infinity feature outside the grammar in use
export class CannotRun extends SafeError {}    // nobody looked — exit 2, not 1

// ------------------------------------------------------- Infinity emulator

// filterExpression. The grammar actually in use, and nothing else:
//     expr := term ( "&&" term )*
//     term := "(" expr ")" | field "==" "literal"
// where a literal is a plain string, or exactly ${post} / ${month}. Anything else
// (||, !=, >, a function call, single quotes, a number) throws: an operator this
// emulator guesses at is a parity check that guesses.
//
// Returns a predicate (row, vars) => boolean; `.vars` lists the variables used.
// The variable is substituted at evaluation time, with the RAW value, as Grafana
// does for the Infinity filter.
export function parseFilter(expr) {
  if (expr !== undefined && expr !== null && typeof expr !== "string") {
    throw new NotEmulated("filterExpression is not a string");
  }
  const src = expr ?? "";
  if (!src.trim()) return Object.assign(() => true, { vars: [] });
  const bad = (at, what) => new NotEmulated(`filterExpression outside the grammar (${what} at ${at}): ${src}`);

  const tokens = [];
  for (let i = 0; i < src.length;) {
    const ch = src[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === "(" || ch === ")") { tokens.push({ t: ch, at: i }); i++; continue; }
    if (src.startsWith("&&", i)) { tokens.push({ t: "&&", at: i }); i += 2; continue; }
    if (src.startsWith("==", i) && src[i + 2] !== "=") { tokens.push({ t: "==", at: i }); i += 2; continue; }
    if (ch === '"') {
      const end = src.indexOf('"', i + 1);
      if (end < 0) throw bad(i, "unterminated string");
      const value = src.slice(i + 1, end);
      if (value.includes("\\")) throw bad(i, "escape sequence");
      tokens.push({ t: "str", value, at: i });
      i = end + 1;
      continue;
    }
    const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
    if (id) { tokens.push({ t: "id", value: id[0], at: i }); i += id[0].length; continue; }
    throw bad(i, `unexpected "${ch}"`);
  }

  let pos = 0;
  const vars = new Set();
  const take = (t) => {
    const tok = tokens[pos];
    if (!tok || tok.t !== t) throw bad(tok ? tok.at : src.length, `expected ${t}`);
    pos++;
    return tok;
  };
  const term = () => {
    if (tokens[pos]?.t === "(") { take("("); const inner = and(); take(")"); return inner; }
    const field = take("id").value;
    take("==");
    const lit = take("str");
    let varName = null;
    if (lit.value.includes("$")) {
      const m = /^\$\{(\w+)\}$/.exec(lit.value);
      if (!m || !KNOWN_VARS.includes(m[1])) throw bad(lit.at, "unknown variable form");
      varName = m[1];
      vars.add(varName);
    }
    return (row, v) => {
      const want = varName ? v?.[varName] : lit.value;
      if (typeof want !== "string") throw new NotEmulated(`no value given for \${${varName}}`);
      const got = row?.[field];
      if (got === null || got === undefined) return false;
      if (typeof got !== "string") throw new NotEmulated(`filter on the non-string field "${field}" is not emulated`);
      return got === want;
    };
  };
  const and = () => {
    const parts = [term()];
    while (tokens[pos]?.t === "&&") { take("&&"); parts.push(term()); }
    return (row, v) => parts.every((p) => p(row, v));
  };
  const test = and();
  if (pos < tokens.length) throw bad(tokens[pos].at, "trailing input");
  return Object.assign((row, v = {}) => test(row, v), { vars: [...vars].sort() });
}

// columns: selector -> text, in the order given. "string" => String(v) unless
// null, "number" => Number unless null; a missing key is null. A string that does
// not parse as a number becomes null — what Infinity's backend parser leaves in
// the cell — not NaN.
//
// `coerced` names the columns where a value had to change type on the way
// (a number read as "string", a string read as "number"). Today there are none.
// It is reported because Infinity formats a number in Go (1e+06), not in JS
// (1000000): for such a column an emulated match is weaker evidence.
export function applyColumns(rows, columns) {
  if (!Array.isArray(columns) || !columns.length) {
    throw new NotEmulated("the target has no columns — Infinity would return every key, which is not emulated");
  }
  const cols = columns.map((c) => {
    if (!PLAIN_KEY.test(c?.selector ?? "")) throw new NotEmulated(`column selector is not a plain key: ${JSON.stringify(c?.selector)}`);
    if (c.type !== "string" && c.type !== "number") throw new NotEmulated(`column type "${c.type}" is not emulated`);
    return { selector: c.selector, name: c.text || c.selector, type: c.type };
  });
  const coerced = new Set();
  const cell = (v, col) => {
    if (v === null || v === undefined) return null;
    if (typeof v === "object") throw new NotEmulated(`column "${col.name}" selects a nested value`);
    if (col.type === "string") {
      if (typeof v !== "string") coerced.add(col.name);
      return String(v);
    }
    if (typeof v === "number") return v;
    if (typeof v !== "string") throw new NotEmulated(`column "${col.name}" reads a ${typeof v} as a number`);
    coerced.add(col.name);
    const n = v.trim() === "" ? NaN : Number(v);
    return Number.isNaN(n) ? null : n;
  };
  return {
    columns: cols.map(({ name, type }) => ({ name, type })),
    rows: rows.map((r) => cols.map((c) => cell(r?.[c.selector], c))),
    coerced: [...coerced],
  };
}

// Grafana's own :sqlstring format — single quotes doubled, the whole wrapped in
// single quotes; a list is formatted item by item and joined with commas.
export function sqlstring(v) {
  if (Array.isArray(v)) return v.map((x) => sqlstring(x)).join(",");
  return `'${String(v).replace(/'/g, "''")}'`;
}

const SQL_VAR = /\$\{(\w+):sqlstring\}/g;
export const usedSqlVars = (rawSql) => [...new Set([...String(rawSql ?? "").matchAll(SQL_VAR)].map((m) => m[1]))].sort();

// rawSql -> the SQL Grafana would send. REFUSES, before anything reaches the
// database: a raw ${var} / $var / [[var]] (SQL built from an unescaped value), any
// $__ macro (the panels ignore the time picker on purpose), a placeholder inside
// quotes ('${post:sqlstring}' expands to ''x''), an unknown variable, and a
// template token that gen-author-dashboards.mjs should have replaced.
export function interpolateSql(rawSql, vars = {}) {
  if (typeof rawSql !== "string" || !rawSql.trim()) throw new Refusal("rawSql is missing or empty");
  if (rawSql.includes("__AUTHOR__")) throw new Refusal("rawSql still carries the template token __AUTHOR__");
  const rest = rawSql.replace(SQL_VAR, " ");
  if (/\$__/.test(rest)) throw new Refusal("rawSql uses a $__ macro — the panels must keep ignoring the time picker");
  const raw = /\$\{[^}]*\}|\$\w+|\[\[[^\]]*\]\]|\$/.exec(rest);
  if (raw) throw new Refusal(`rawSql contains ${raw[0]} — only \${var:sqlstring} may carry a variable into SQL`);
  if (/'\$\{\w+:sqlstring\}|\$\{\w+:sqlstring\}'/.test(rawSql)) {
    throw new Refusal("a ${var:sqlstring} placeholder sits inside quotes — :sqlstring brings its own");
  }
  return rawSql.replace(SQL_VAR, (_, name) => {
    if (!KNOWN_VARS.includes(name)) throw new Refusal(`rawSql uses the unknown variable \${${name}}`);
    if (typeof vars[name] !== "string") throw new NotEmulated(`no value given for \${${name}}`);
    return sqlstring(vars[name]);
  });
}

// One Infinity query (a panel target or a variable's query) run over a feed.
const INFINITY_KEYS = new Set(["columns", "computed_columns", "datasource", "filterExpression", "filters",
  "format", "parser", "refId", "root_selector", "source", "type", "url", "url_options"]);

export function emulateInfinity(q, feed, vars = {}) {
  const extra = Object.keys(q).filter((k) => !INFINITY_KEYS.has(k));
  if (extra.length) throw new NotEmulated(`the Infinity query uses ${extra.join(", ")} — not emulated`);
  if (q.type !== "json" || q.parser !== "backend" || q.format !== "table" || q.source !== "url") {
    throw new NotEmulated("only type=json, source=url, parser=backend, format=table is emulated");
  }
  if ((q.computed_columns ?? []).length || (q.filters ?? []).length) {
    throw new NotEmulated("computed_columns / filters are not emulated");
  }
  if (!PLAIN_KEY.test(q.root_selector ?? "")) throw new NotEmulated(`root_selector is not a plain key: ${JSON.stringify(q.root_selector)}`);
  const rows = feed?.[q.root_selector];
  if (!Array.isArray(rows)) throw new NotEmulated(`the feed has no array "${q.root_selector}"`);
  const keep = parseFilter(q.filterExpression);
  return applyColumns(rows.filter((r) => keep(r, vars)), q.columns);
}

// The list of values a query variable offers, in query order (Grafana's `sort`
// is applied afterwards, and is one of the properties that must not change).
export function variableValues(frame, valueField = null) {
  const names = frame.columns.map((c) => c.name);
  let i = names.length === 1 ? 0 : names.indexOf(valueField ?? "__value");
  if (i < 0) throw new NotEmulated(`a variable query must return one column (or name its value column); it returns ${names.length}`);
  return frame.rows.map((r) => (r[i] === null || r[i] === undefined ? null : String(r[i])));
}

// --------------------------------------------------------------- comparison

const jsType = (v) => (v === null || v === undefined ? "null" : v instanceof Date ? "date" : typeof v);
function sameCell(e, a) {
  const x = e === undefined ? null : e, y = a === undefined ? null : a;
  if (x === null || y === null) return x === y;
  if (typeof x === "number") return typeof y === "number" && x === y;
  if (typeof x === "string") return typeof y === "string" && x === y;
  return false;
}

// null when the frames are the same frame; otherwise the FIRST difference, as
// { kind, column?, row?, detail } — names, positions and types, never a value.
export function compareFrames(expected, actual) {
  const en = expected.columns.map((c) => c.name), an = actual.columns.map((c) => c.name);
  if (en.length !== an.length) return { kind: "column-count", detail: `expected ${en.length}, got ${an.length}` };
  for (let i = 0; i < en.length; i++) {
    if (en[i] === an[i]) continue;
    const sameSet = JSON.stringify([...en].sort()) === JSON.stringify([...an].sort());
    return { kind: sameSet ? "column-order" : "column-name", column: en[i], detail: `position ${i}: got "${an[i]}"` };
  }
  for (let i = 0; i < en.length; i++) {
    const want = expected.columns[i].type, got = actual.columns[i].type;
    if (want !== got) return { kind: "column-type", column: en[i], detail: `expected ${want}, got ${got}` };
  }
  if (expected.rows.length !== actual.rows.length) {
    return { kind: "row-count", detail: `expected ${expected.rows.length} row(s), got ${actual.rows.length}` };
  }
  for (let r = 0; r < expected.rows.length; r++) {
    for (let c = 0; c < en.length; c++) {
      if (sameCell(expected.rows[r][c], actual.rows[r][c])) continue;
      // The same rows in another order is an ORDER BY to fix, not a value.
      const canon = (rows) => JSON.stringify(rows.map((x) => JSON.stringify(x)).sort());
      const reordered = canon(expected.rows) === canon(actual.rows);
      return { kind: reordered ? "row-order" : "value", column: en[c], row: r,
        detail: `${jsType(expected.rows[r][c])} vs ${jsType(actual.rows[r][c])}` };
    }
  }
  return null;
}

// Order of keys is not rendering; everything else is.
function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && deepEqual(a[k], b[k]));
}
function driftKeys(oldObj, newObj, ignore) {
  const keys = new Set([...Object.keys(oldObj), ...Object.keys(newObj)]);
  return [...keys].filter((k) => !ignore.includes(k) && !deepEqual(oldObj[k], newObj[k])).sort();
}

// ---------------------------------------------------------- one dashboard

// Every panel, rows' children included, and every target keyed "<panel id>/<refId>".
export function collectTargets(dash) {
  const panels = new Map(), byKey = new Map(), duplicates = [];
  const walk = (list) => {
    for (const p of list ?? []) {
      if (panels.has(p.id)) duplicates.push(`panel ${p.id}`);
      panels.set(p.id, p);
      for (const t of p.targets ?? []) {
        const key = `${p.id}/${t.refId}`;
        if (byKey.has(key)) duplicates.push(`target ${key}`);
        byKey.set(key, { panel: p, target: t });
      }
      walk(p.panels);
    }
  };
  walk(dash?.panels);
  return { panels, byKey, duplicates };
}

const isPgDatasource = (d) => d?.type === PG_TYPE && d?.uid === PG_UID;
const isInfinityTarget = (t, p) => (t.datasource?.type ?? p?.datasource?.type) === INFINITY_TYPE
  || t.url !== undefined || t.root_selector !== undefined;
const isInfinityVariable = (v) => v?.type === "query" && (v.datasource?.type === INFINITY_TYPE
  || v.query?.datasource?.type === INFINITY_TYPE || v.query?.infinityQuery !== undefined);

// Contract point 2: the target is exactly these six keys.
const TARGET_KEYS = ["datasource", "editorMode", "format", "rawQuery", "rawSql", "refId"];
function targetShape(t) {
  const out = [];
  if (!isPgDatasource(t.datasource)) out.push("datasource is not { grafana-postgresql-datasource, ${DS_LINKEDIN_PG} }");
  if (t.editorMode !== "code") out.push('editorMode is not "code"');
  if (t.format !== "table") out.push('format is not "table"');
  if (t.rawQuery !== true) out.push("rawQuery is not true");
  const extra = Object.keys(t).filter((k) => !TARGET_KEYS.includes(k)).sort();
  if (extra.length) out.push(`unexpected key(s): ${extra.join(", ")}`);
  return out;
}

function* combos(names, lists) {
  if (!names.length) { yield { vars: {}, label: "" }; return; }
  const [name, ...rest] = names;
  for (let i = 0; i < lists[name].length; i++) {
    const tag = lists[name][i] === PROBE ? `${name}#probe` : `${name}#${i}`;
    for (const tail of combos(rest, lists)) {
      yield { vars: { [name]: lists[name][i], ...tail.vars }, label: tail.label ? `${tag},${tail.label}` : tag };
    }
  }
}

const isServerError = (e) => typeof e?.code === "string" && /^[0-9A-Z]{5}$/.test(e.code) && !!e.severity;
const errorDetail = (e) => safeError(e);   // SafeError -> our text; a server error -> its shape; else withheld
const problemKind = (e) => (e instanceof Refusal ? "refused" : e instanceof NotEmulated ? "not-emulated"
  : e instanceof SafeError ? "cannot-compare" : isServerError(e) ? "sql-error" : "internal-error");

// Compare one dashboard. `feedFor(url)` returns the JSON feed the OLD target read
// from that URL; `query(sql)` returns { columns: [{ name, type }], rows: [[...]] }
// with type "string" | "number" | ... — both are injected, so the tests can run
// this without git, without Postgres and without the corpus.
export async function verifyDashboard({ name, oldDash, newDash, feedFor, query }) {
  const problems = [];
  const coerced = new Set();
  let targets = 0, comparisons = 0;
  const add = (p) => problems.push({ dashboard: name, ...p });

  const oldT = collectTargets(oldDash), newT = collectTargets(newDash);
  for (const d of oldT.duplicates) add({ scope: "dashboard", kind: "ambiguous", detail: `baseline has a duplicate ${d}` });
  for (const d of newT.duplicates) add({ scope: "dashboard", kind: "ambiguous", detail: `duplicate ${d}` });

  // ---- query variables first: ${month} is enumerated from the OLD variable.
  const oldVars = new Map((oldDash?.templating?.list ?? []).map((v) => [v.name, v]));
  const newVars = new Map((newDash?.templating?.list ?? []).map((v) => [v.name, v]));
  const offered = {};
  for (const [vname, ov] of oldVars) {
    if (!isInfinityVariable(ov)) continue;
    const where = { scope: "variable", variable: vname };
    try {
      const oq = ov.query?.infinityQuery ?? ov.query;
      const want = variableValues(emulateInfinity(oq, feedFor(oq.url)), ov.query?.meta?.valueField);
      offered[vname] = want;
      const nv = newVars.get(vname);
      if (!nv) { add({ ...where, kind: "no-counterpart", detail: "the variable is gone" }); continue; }
      if (isInfinityVariable(nv)) { add({ ...where, kind: "still-infinity" }); continue; }
      if (nv.type !== "query" || !isPgDatasource(nv.datasource) || typeof nv.query !== "string") {
        add({ ...where, kind: "variable-shape", detail: "expected a query variable on ${DS_LINKEDIN_PG} whose query is the SQL string" });
        continue;
      }
      if (nv.definition !== nv.query) add({ ...where, kind: "variable-shape", detail: "definition differs from query" });
      const drift = driftKeys(ov, nv, ["datasource", "query", "definition"]);
      if (drift.length) add({ ...where, kind: "variable-changed", detail: `changed besides the query: ${drift.join(", ")}` });
      const got = variableValues(await query(interpolateSql(nv.query)));
      comparisons++;
      if (want.length !== got.length) { add({ ...where, kind: "row-count", detail: `expected ${want.length} value(s), got ${got.length}` }); continue; }
      const at = want.findIndex((v, i) => v !== got[i]);
      if (at >= 0) {
        const reordered = JSON.stringify([...want].sort()) === JSON.stringify([...got].sort());
        add({ ...where, kind: reordered ? "row-order" : "value", row: at });
      }
    } catch (e) {
      if (e instanceof CannotRun) throw e;
      add({ ...where, kind: problemKind(e), detail: errorDetail(e) });
    }
  }
  for (const [vname, nv] of newVars) {
    const ov = oldVars.get(vname);
    if (ov && isInfinityVariable(ov)) continue;   // compared above
    const where = { scope: "variable", variable: vname };
    if (isInfinityVariable(nv)) add({ ...where, kind: "still-infinity" });
    else if (nv.type === "query" && ov?.type === "query") add({ ...where, kind: "baseline-not-infinity", detail: "the baseline variable is not an Infinity query — pass --baseline <last Infinity commit>" });
    else if (nv.type === "query") add({ ...where, kind: "no-counterpart", detail: "a query variable the baseline does not have" });
    else if (!ov) add({ ...where, kind: "no-counterpart", detail: "a variable the baseline does not have" });
  }

  // ---- everything that is NOT a ported query variable, and everything outside
  // `panels` / `templating.list`, must not have moved at all. The panels can be
  // frame-for-frame right and the dashboard still broken: $post turned into a
  // multi-value variable makes `id = ${post:sqlstring}` expand to `id = 'a','b'`
  // — a syntax error on all twelve panels of a -posts dashboard.
  // update-post-variable.mjs legitimately rewrites options / current / query of
  // the Custom $post variable, so those three keys (and only those) are exempt.
  for (const [vname, ov] of oldVars) {
    if (isInfinityVariable(ov)) continue;
    const where = { scope: "variable", variable: vname };
    const nv = newVars.get(vname);
    if (!nv) { add({ ...where, kind: "dropped", detail: "a baseline variable is gone" }); continue; }
    const drift = driftKeys(ov, nv, ["options", "current", "query"]);
    if (drift.length) add({ ...where, kind: "variable-changed", detail: `changed besides options/current/query: ${drift.join(", ")}` });
  }
  if (JSON.stringify([...oldVars.keys()].filter((n) => newVars.has(n))) !== JSON.stringify([...newVars.keys()].filter((n) => oldVars.has(n)))) {
    add({ scope: "dashboard", kind: "variable-order", detail: "templating.list is in a different order than the baseline" });
  }
  const tplDrift = driftKeys(oldDash?.templating ?? {}, newDash?.templating ?? {}, ["list"]);
  if (tplDrift.length) add({ scope: "dashboard", kind: "dashboard-changed", detail: `templating changed besides list: ${tplDrift.join(", ")}` });
  const dashDrift = driftKeys(oldDash ?? {}, newDash ?? {}, ["panels", "templating", "version", "id"]);
  if (dashDrift.length) add({ scope: "dashboard", kind: "dashboard-changed", detail: `changed besides panels/templating: ${dashDrift.join(", ")}` });

  // Contract: a variable that reaches SQL as ${name:sqlstring} is SINGLE-valued.
  // :sqlstring expands a multi-value / "All" selection to 'a','b' — behind `=`
  // that is SQL the server rejects, where the old Infinity filter merely matched
  // nothing. Nothing here can emulate a multi-value selection either, so such a
  // dashboard is refused rather than "compared".
  const sqlVarNames = new Set();
  for (const { target } of newT.byKey.values()) for (const n of usedSqlVars(target.rawSql)) sqlVarNames.add(n);
  for (const nv of newVars.values()) if (nv.type === "query" && typeof nv.query === "string") for (const n of usedSqlVars(nv.query)) sqlVarNames.add(n);
  for (const n of [...sqlVarNames].sort()) {
    const nv = newVars.get(n);
    if (nv && (nv.multi === true || nv.includeAll === true)) {
      add({ scope: "variable", variable: n, kind: "variable-multi", detail: "used as ${" + n + ":sqlstring} but multi / includeAll is on — a multi-value selection expands to 'a','b' and breaks the SQL" });
    }
  }

  // ---- panels: only `targets` and `datasource` may differ (contract point 2).
  for (const [id, np] of newT.panels) {
    const where = { scope: "panel", panelId: id, title: np.title ?? "" };
    const op = oldT.panels.get(id);
    if (!op) { add({ ...where, kind: "no-counterpart", detail: "the baseline has no panel with this id" }); continue; }
    const drift = driftKeys(op, np, ["targets", "datasource", "panels"]);
    if (drift.length) add({ ...where, kind: "panel-changed", detail: `changed besides targets/datasource: ${drift.join(", ")}` });
    if ((np.targets ?? []).length && op.datasource !== undefined && !isPgDatasource(np.datasource)) {
      add({ ...where, kind: "panel-datasource", detail: "panel-level datasource is not { grafana-postgresql-datasource, ${DS_LINKEDIN_PG} }" });
    }
  }
  for (const [id, op] of oldT.panels) {
    if (!newT.panels.has(id)) add({ scope: "panel", panelId: id, title: op.title ?? "", kind: "dropped", detail: "a baseline panel is gone" });
  }

  // ---- targets
  for (const [key, { panel, target }] of newT.byKey) {
    const where = { scope: "panel", panelId: panel.id, title: panel.title ?? "", refId: target.refId };
    if (isInfinityTarget(target, panel)) { add({ ...where, kind: "still-infinity" }); continue; }
    const old = oldT.byKey.get(key);
    if (!old) { add({ ...where, kind: "no-counterpart", detail: "the baseline has no target with this panel id + refId" }); continue; }
    if (!isInfinityTarget(old.target, old.panel)) {
      add({ ...where, kind: "baseline-not-infinity", detail: "the baseline target is not an Infinity query — pass --baseline <last Infinity commit>" });
      continue;
    }
    targets++;
    for (const s of targetShape(target)) add({ ...where, kind: "target-shape", detail: s });
    try {
      const feed = feedFor(old.target.url);
      const names = [...new Set([...parseFilter(old.target.filterExpression).vars, ...usedSqlVars(target.rawSql)])].sort();
      const lists = {};
      for (const n of names) {
        const values = n === "post" ? (feed.posts ?? []).map((p) => p.id) : offered[n];
        if (!Array.isArray(values)) throw new NotEmulated(`\${${n}} cannot be enumerated — the baseline has no query variable of that name`);
        lists[n] = [...values, PROBE];
      }
      const failed = [];
      let ran = 0;
      for (const combo of combos(names, lists)) {
        const expected = emulateInfinity(old.target, feed, combo.vars);
        for (const c of expected.coerced) coerced.add(c);
        const actual = await query(interpolateSql(target.rawSql, combo.vars));
        comparisons++; ran++;
        const d = compareFrames(expected, actual);
        if (d) failed.push({ ...d, varIndex: combo.label });
      }
      if (failed.length) add({ ...where, ...failed[0], more: failed.length - 1, of: ran });
    } catch (e) {
      if (e instanceof CannotRun) throw e;
      add({ ...where, kind: problemKind(e), detail: errorDetail(e) });
    }
  }
  for (const [key, { panel, target }] of oldT.byKey) {
    if (!newT.byKey.has(key) && newT.panels.has(panel.id)) {
      add({ scope: "panel", panelId: panel.id, title: panel.title ?? "", refId: target.refId, kind: "dropped", detail: "a baseline target has no SQL counterpart" });
    }
  }
  if (!targets) add({ scope: "dashboard", kind: "nothing-compared", detail: "0 SQL targets were compared" });

  return { name, targets, comparisons, problems, coerced: [...coerced].sort() };
}

// One line per problem. Every field is a name, a position or a type.
export function formatProblem(p) {
  const bits = [p.dashboard];
  if (p.scope === "panel") bits.push(`panel ${p.panelId} ${JSON.stringify(p.title)}${p.refId !== undefined ? ` refId ${p.refId}` : ""}`);
  if (p.scope === "variable") bits.push(`variable ${p.variable}`);
  bits.push(`[${p.kind}]`);
  if (p.varIndex) bits.push(`at ${p.varIndex}`);
  if (p.column !== undefined) bits.push(`column ${JSON.stringify(p.column)}`);
  if (p.row !== undefined) bits.push(`row ${p.row}`);
  if (p.detail) bits.push(`— ${p.detail}`);
  if (p.more) bits.push(`(+${p.more} more of ${p.of} variable values differ)`);
  return bits.join("  ");
}

// Nothing compared is not "identical": it is a check that did not look.
export function verdict(results) {
  const total = (k) => results.reduce((a, r) => a + r[k], 0);
  const problems = results.reduce((a, r) => a + r.problems.length, 0);
  return { dashboards: results.length, targets: total("targets"), comparisons: total("comparisons"), problems,
    ok: results.length > 0 && problems === 0 && total("targets") > 0 && total("comparisons") > 0 };
}

// ------------------------------------------------------------------- main

// The feed an old target read, recognised by its URL — not by the dashboard's
// file name: a generated dashboard once carried another author's feed, and the
// oracle is what the panel SHOWED.
const FEED_URL = /^https:\/\/speedandfunction\.github\.io\/LinkedInStatistic\/(?:([a-z0-9-]+)\/stats\.json|page-stats\.json)$/;
export function feedKey(url) {
  const m = FEED_URL.exec(String(url ?? ""));
  return m ? (m[1] ? `author:${m[1]}` : "page") : null;
}

// SQL type -> what Grafana's frame calls it. Anything that is not text or a
// number (a date left as `date`, a boolean, jsonb) is a column-type mismatch.
const TEXT_OIDS = new Set([18, 19, 25, 705, 1042, 1043]);
const NUMBER_OIDS = new Set([20, 21, 23, 26, 700, 701, 1700]);
const TIME_OIDS = new Set([1082, 1083, 1114, 1184, 1266]);
const sqlTypeClass = (oid) => (TEXT_OIDS.has(oid) ? "string" : NUMBER_OIDS.has(oid) ? "number"
  : TIME_OIDS.has(oid) ? "time" : oid === 16 ? "boolean" : `oid ${oid}`);

// One connection, one REPEATABLE READ READ ONLY transaction, the clock pinned
// inside it — see openDb() in export.mjs for why each of those words is there.
// Added here: every rawSql goes through the extended protocol, which takes ONE
// statement, so a rawSql cannot end the read-only transaction and carry on
// outside it; and it comes back as arrays plus the field list.
//
// A rawSql the server rejects aborts the transaction, and one broken panel must
// not poison the next 200. So the transaction is rolled back and the SAME one is
// begun again (pin included). Not a savepoint per query: that is two extra round
// trips on each of ~1000 queries, to a database that may be an ocean away, paid
// on the path where nothing is wrong.
async function openPinned(dsn, nowArg) {
  if (nowArg && Number.isNaN(Date.parse(nowArg))) throw new CannotRun("--now is not a timestamp");
  const { default: pg } = await import("pg");
  // numeric / int8 -> Number, as Grafana does (float64) and as export.mjs does.
  // Set on THIS client; the process-wide parsers are left alone.
  const types = { getTypeParser: (oid, format) => (oid === 20 || oid === 1700 ? Number : pg.types.getTypeParser(oid, format)) };
  const c = new pg.Client(pgConfig(dsn, { connectionTimeoutMillis: 20000, types }));
  await c.connect();
  try {
    let now = nowArg;
    if (!now) {
      // Same default as verify.mjs: the Monday after the newest week in the
      // corpus. Formatted by the server — a `date` parsed by the driver lands on
      // local midnight, and east of UTC toISOString() then names the day before.
      //
      // grafana_ro — the role Grafana logs in as, and so the role this check
      // should be run as — cannot see schema li at all (42501). It gets the same
      // Monday from the feed views it CAN read: the newest PUBLISHED week, which
      // is the newest week whenever the gate holds nothing back. Any instant
      // works as long as both sides use it (see verify.mjs); this one is simply
      // the one that needs no flag. No transaction is open yet, so the refused
      // probe leaves nothing behind.
      let r;
      try {
        r = await c.query(`
          select to_char(max(w)::date + 7, 'YYYY-MM-DD') as m from (
            select max(week) w from li.post_week
            union all select max(week) from li.account_week
            union all select max(week) from li.comment_week
            union all select max(attributed_week) from li.engagement_event
          ) x`);
      } catch (e) {
        if (e?.code !== "42501") throw e;
        r = await c.query(`
          select to_char(max(w)::date + 7, 'YYYY-MM-DD') as m from (
            select max(week) w from dash.feed_post_weeks
            union all select max(week) from dash.feed_account_weeks
            union all select max(week) from dash.feed_engagement_score_weeks
          ) x`);
      }
      if (!r.rows[0].m) throw new CannotRun("the database holds no week at all — nothing to pin the clock to (import first, or pass --now)");
      now = `${r.rows[0].m}T00:00:00Z`;
    }
    const begin = async () => {
      await c.query("begin transaction isolation level repeatable read read only");
      await c.query("select set_config('li.as_of', $1, true)", [now]);
    };
    await begin();
    return {
      now,
      query: async (sql) => {
        try {
          const r = await c.query({ text: sql, rowMode: "array", queryMode: "extended" });
          return { columns: r.fields.map((f) => ({ name: f.name, type: sqlTypeClass(f.dataTypeID) })), rows: r.rows };
        } catch (e) {
          // Not the server talking, or the server going away: nobody looked.
          if (!isServerError(e) || /^(08|53|57|58|XX)/.test(e.code)) throw new CannotRun(`the database stopped answering: ${safeError(e, { dsn })}`);
          try { await c.query("rollback"); await begin(); }
          catch (e2) { throw new CannotRun(`the connection did not survive a failed query: ${safeError(e2, { dsn })}`); }
          throw e;
        }
      },
      close: async () => { await c.query("rollback").catch(() => {}); await c.end().catch(() => {}); },
    };
  } catch (e) {
    await c.end().catch(() => {});
    throw e;
  }
}

function arg(name, def = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")
    ? process.argv[i + 1] : def;
}

async function main() {
  const DSN = resolveDsn(arg("dsn"));
  const BASELINE = arg("baseline", "main");
  const CORPUS = resolve(arg("repo", REPO));                       // where the JSON side reads from
  const DASH_DIR = resolve(arg("dashboards", join(REPO, "dashboards", "grafana")));
  const MAX = Number(arg("max", 40)) || 40;
  let db = null, work = null;
  try {
    if (!/^[\w./~^@{}-]+$/.test(BASELINE)) throw new CannotRun("--baseline is not a git ref");
    const git = (args) => execFileSync("git", args, { cwd: REPO, encoding: "utf8", maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "ignore"] });
    try { git(["rev-parse", "--verify", "--quiet", `${BASELINE}^{commit}`]); }
    catch { throw new CannotRun(`the baseline ref "${BASELINE}" does not exist in this checkout (shallow clone? fetch it, or pass --baseline)`); }

    // Ours = what gen-author-dashboards.mjs generates, plus the company page.
    const profiles = JSON.parse(readFileSync(join(CORPUS, ".claude", "skills", "linkedin-stats", "profiles.json"), "utf8"));
    const authors = Object.keys(profiles).filter((k) => !k.startsWith("_"));
    for (const a of authors) if (!/^[a-z0-9-]+$/.test(a)) throw new CannotRun("profiles.json has an author key that is not a slug");
    const files = [...authors.flatMap((a) => [`linkedin-${a}.json`, `linkedin-${a}-posts.json`]), "linkedin-page.json"];

    db = await openPinned(DSN, arg("now"));
    work = mkdtempSync(join(tmpdir(), "li-panels-"));

    // The JSON oracle, built the way verify.mjs builds it, once per feed, at the
    // instant the database session is pinned to.
    const feeds = new Map();
    const run = (script, args, cwd) => {
      const r = spawnSync(process.execPath, [join(REPO, ".github", "scripts", script), ...args], { cwd, encoding: "utf8" });
      if (r.status !== 0) throw new CannotRun(`${script} exited ${r.status} (its stderr is withheld — it can quote the corpus)`);
    };
    const feedFor = (url) => {
      const key = feedKey(url);
      if (!key) throw new SafeError("the baseline target reads a URL that is not one of our feeds");
      if (!feeds.has(key)) {
        const out = join(work, `${key.replace(":", "-")}.json`);
        if (key === "page") run("build-page-stats.mjs", ["--out", out], CORPUS);
        else {
          const author = key.slice("author:".length);
          run("build-stats-json.mjs", [
            "--li-stats", join(CORPUS, "dashboards", "li-stats", author),
            "--skill-dir", join(CORPUS, ".claude", "skills", "linkedin-stats"),
            "--out", out, "--now", db.now], REPO);
        }
        feeds.set(key, JSON.parse(readFileSync(out, "utf8")));
      }
      return feeds.get(key);
    };

    const results = [];
    for (const file of files) {
      const missing = (kind, detail) => results.push({ name: file, targets: 0, comparisons: 0, coerced: [],
        problems: [{ dashboard: file, scope: "dashboard", kind, detail }] });
      const path = join(DASH_DIR, file);
      if (!existsSync(path)) { missing("dashboard-missing", "the file is not in the dashboards directory"); continue; }
      let oldText;
      try { oldText = git(["show", `${BASELINE}:dashboards/grafana/${file}`]); }
      catch { missing("no-baseline", `${BASELINE} has no such file — nothing to compare with`); continue; }
      // A dashboard FILE NAME is not corpus data: name the file that does not
      // parse, or the operator is left guessing which of the seven it is.
      const parse = (text, side) => {
        try { return JSON.parse(text); }
        catch { throw new CannotRun(`${file} is not valid JSON (${side})`); }
      };
      results.push(await verifyDashboard({
        name: file, oldDash: parse(oldText, `baseline ${BASELINE}`), newDash: parse(readFileSync(path, "utf8"), "working tree"), feedFor, query: db.query }));
    }

    console.log(`panel parity check — clock pinned at ${db.now}, baseline ${BASELINE}\n`);
    for (const r of results) {
      console.log(r.problems.length
        ? `DIFF ${r.name} targets=${r.targets} comparisons=${r.comparisons} problems=${r.problems.length}`
        : `OK ${r.name} targets=${r.targets} comparisons=${r.comparisons}`);
      if (r.coerced.length) console.log(`     note: the emulator changed a value's type for column(s) ${r.coerced.map((c) => JSON.stringify(c)).join(", ")} — Infinity formats numbers in Go, check these by eye`);
    }
    const v = verdict(results);
    console.log(`\n-- ${v.dashboards} dashboard(s), ${v.targets} target(s), ${v.comparisons} comparison(s), ${v.problems} problem(s)`);
    if (!v.ok) {
      console.error("");
      const all = results.flatMap((r) => r.problems);
      for (const p of all.slice(0, MAX)) console.error(`  ${formatProblem(p)}`);
      if (all.length > MAX) console.error(`  … and ${all.length - MAX} more (--max ${all.length} to list them)`);
      if (!all.length) console.error("  nothing was compared — that is not parity");
      console.error("\n(cell values are never printed — reproduce locally against the feed views to see them)");
      return 1;
    }
    console.log("\nevery SQL target returns the frame its Infinity predecessor returned.");
    return 0;
  } catch (e) {
    // The comparison did not happen. Report the SHAPE and leave with 2, never
    // with the 1 that means "differs".
    console.error("PANEL PARITY CHECK COULD NOT RUN:", safeError(e, { dsn: DSN }));
    return 2;
  } finally {
    await db?.close();
    if (work) rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && basename(process.argv[1]) === "verify-panels.mjs") {
  process.exitCode = await main();
}
