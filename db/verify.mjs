#!/usr/bin/env node
// The parity check. Builds the dashboard feeds twice — once from the JSON on
// disk with the existing .github/scripts, once from the database with
// db/export.mjs — and diffs them field by field.
//
// Both sides are run at the SAME pinned instant (--now, default: the Monday
// after the newest week in the corpus), because build-stats-json.mjs reads the
// wall clock in two places that change its output. Without pinning, a run
// straddling midnight UTC would report a difference that is not one.
//
//   LI_DSN=<url> node db/verify.mjs [--now <iso>] [--keep] [--max 40]
//                      [--repo <dir>] [--no-page] [--show-values] [--dsn <url>]
//
// WHICH FEEDS. The union of what the JSON side PUBLISHES (every folder under
// dashboards/li-stats/ with an account.json — the exact rule build-pages.mjs uses
// for GitHub Pages) and what the database HOLDS (li.author). It used to be the
// database's list alone, and that made "ok" vacuous: a feed that is on Pages but
// never reached the database was simply not in the loop, and the check passed.
// A feed present on one side only is a DIFF (feed-absent), exit 1. The number of
// feeds compared is printed ("-- N feed(s) compared, M differ") so the caller
// can hold it against its own count (db-ci.mjs does).
//
// Exit 0 = byte-identical on every section of every feed, and at least one feed;
//          AND every dash.feed_* view identical to its section (FEED PARITY below).
// Exit 1 = a real difference in either half, printed with its exact path.
// Exit 2 = the check COULD NOT RUN (database unreachable, a build script failed,
//          LI_DSN missing in CI). Deliberately not 1: "the two stores disagree"
//          and "nobody looked" are different alarms, and an uncaught exception
//          used to report the second as the first.
//
// It writes NOTHING to the database. The clock is pinned inside export.mjs's own
// read-only transaction (see openDb there), so it runs as li_sync — or any role
// that can read dash — and leaves no trace for the next reader to trip over.
//
// A difference is reported by PATH and SHAPE, not by value: this repo is public,
// CI logs are world-readable, and the values here are third-party people's names,
// headlines and profile URLs. Two different hashes on the same path tell you the
// values differ; `--show-values` prints them, and is for a local terminal only.
//
// --repo points both sides at a fixture corpus (see db/fixture-icp.mjs), so the
// ICP and VIP scoring branches can be compared on data that actually exercises
// them. --no-page skips the company-page feed, which a fixture has no copy of.
//
// FEED PARITY — the second half, and the one Grafana depends on. export.mjs is a
// JavaScript program: it sorts, rounds and assembles on top of the dash views, so
// "export.mjs is byte-identical" says nothing about a panel, which has only SQL.
// The panels read the dash.feed_* views (see that section of schema.sql), one per
// JSON section, so every one of them is compared here with the section the build
// scripts produced — in the SAME transaction, at the SAME pinned instant, as the
// SAME role: `select * from dash.feed_<section> [where author = $1] order by ord`,
// minus the leading author/ord, must re-serialise to the JSON section byte for
// byte (row count, key names and order, every value; a number equals a number,
// a string a string, null null). On top of that: `ord` must be exactly 0..n-1,
// every view on the list must exist, and every dash.feed_* view that exists must
// be on the list — a view a panel could read that nobody compares is a DIFF.
// A difference here exits 1 exactly like one in the first half.

import { spawnSync } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { readFileSync, mkdtempSync, rmSync, readdirSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { openDb, buildStats, buildPageStats, listAuthors } from "./export.mjs";
import { resolveDsn } from "./pg-config.mjs";
import { SafeError, safeError } from "./safe-log.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");

function arg(name, def = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")
    ? process.argv[i + 1] : def;
}
const flag = (n) => process.argv.includes(`--${n}`);

const DSN = resolveDsn(arg("dsn"));
const MAX = Number(arg("max", 40));
const CORPUS = resolve(arg("repo", REPO));   // where the JSON side reads from
const SHOW = flag("show-values");

// Anything that escapes below means the comparison did not happen. Report its
// SHAPE (a pg message carries the host; a build script's stderr can quote the
// corpus) and leave with 2, never with the 1 that means "differs".
const cannotRun = (e) => {
  console.error("PARITY CHECK COULD NOT RUN:", safeError(e, { dsn: DSN, showValues: SHOW }));
  process.exit(2);
};
process.on("uncaughtException", cannotRun);
process.on("unhandledRejection", cannotRun);

// What a difference looks like when we are NOT allowed to print it: enough to
// tell two values apart and to recognise the same wrong value twice, and nothing
// a log scraper can turn back into a person.
// The digest is an HMAC under a key drawn for THIS run and never printed. A bare
// sha1 of a four-digit number or of a person's name is a lookup table away from
// the value — and the db side of a difference may be a value that is not
// published. Salted, the two lines of one difference still compare with each
// other (and the same wrong value repeats within a run), which is all the digest
// is for; across runs it says nothing. The label stays "sha1=": db-ci.mjs shows a
// log line only in this exact shape.
const RUN_KEY = randomBytes(32);
function shape(v) {
  if (v === undefined) return "absent";
  const s = String(v);
  const t = v === null ? "null" : typeof v;
  return `${t} len=${s.length} sha1=${createHmac("sha1", RUN_KEY).update(s).digest("hex").slice(0, 8)}`;
}
const show = (v) => (SHOW ? String(v).slice(0, 220) : shape(v));

// ------------------------------------------------------------------ diff

// Deep structural diff. Reports the first MAX differences with a JSON-pointer
// style path, so "engagement_people[3].score" is the answer, not "objects
// differ". Type, key-order and length differences are called out separately,
// because each is fixed somewhere different — a cast, an ORDER BY, a JOIN.
const KEYSEP = String.fromCharCode(1);

function diff(a, b, path = "$", out = []) {
  if (out.length >= MAX) return out;
  if (a === b) return out;
  const ta = a === null ? "null" : Array.isArray(a) ? "array" : typeof a;
  const tb = b === null ? "null" : Array.isArray(b) ? "array" : typeof b;
  if (ta !== tb) { out.push({ path, kind: "type", json: JSON.stringify(a), db: JSON.stringify(b) }); return out; }
  if (ta === "array") {
    if (a.length !== b.length) out.push({ path: `${path}.length`, kind: "length", json: a.length, db: b.length });
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      diff(a[i], b[i], `${path}[${i}]`, out);
      if (out.length >= MAX) return out;
    }
    return out;
  }
  if (ta === "object") {
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.join(KEYSEP) !== kb.join(KEYSEP)) {
      out.push({ path: `${path}{keys}`, kind: "key-order-or-set", json: ka.join(","), db: kb.join(",") });
    }
    for (const k of new Set([...ka, ...kb])) {
      diff(a?.[k], b?.[k], `${path}.${k}`, out);
      if (out.length >= MAX) return out;
    }
    return out;
  }
  out.push({ path, kind: "value", json: JSON.stringify(a), db: JSON.stringify(b) });
  return out;
}

// ------------------------------------------------------------ feed views

// The sections a panel or a dashboard variable reads — the contract between
// schema.sql (dash.feed_*), the dashboards and db/verify-panels.mjs. A section
// added to the JSON and to a panel gets a view there and a name here.
const AUTHOR_SECTIONS = ["posts", "post_weeks", "post_demographics", "account_weeks",
  "account_demographics", "posts_per_month", "comments_per_month", "correlation_points",
  "correlation_trend", "engagement_score_weeks", "engagement_score_totals", "engagement_people"];
const PAGE_SECTIONS = ["engagement_score_totals", "engagement_score_weeks", "engagement_people",
  "page_account_weeks", "page_search_weeks", "page_demographics", "page_monthly",
  "page_geo_aggregate", "page_geo_buckets", "page_geo_monthly"];
// post_weeks -> feed_post_weeks; on the page, page_monthly -> feed_page_monthly
// and engagement_score_totals -> feed_page_engagement_score_totals.
const feedView = (section, page) =>
  (page ? `feed_page_${section.replace(/^page_/, "")}` : `feed_${section}`);

// Every dash.feed_* view with its columns in order, from the catalog — readable
// by any role, so this works as li_sync. Asked up front because naming a view
// that does not exist would abort the read-only transaction everything shares.
async function feedCatalog(db) {
  const rows = await db.q(`
    select c.relname as view, a.attname as col, format_type(a.atttypid, null) as type
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
     where n.nspname = 'dash' and c.relkind = 'v' and c.relname like 'feed\\_%'
     order by c.relname, a.attnum`);
  const cat = new Map();
  for (const r of rows) (cat.get(r.view) ?? cat.set(r.view, []).get(r.view)).push({ col: r.col, type: r.type });
  return cat;
}

// One feed (an author, or the page) against its views. `json` is what the build
// script wrote; nothing from export.mjs is involved. Returns the row count per
// view and appends differences to `out` in the shape diff() uses, so they print
// — and are redacted — exactly like the first half's.
async function compareFeedViews(db, cat, { prefix, author, sections, json }, out) {
  const page = author === null;
  const lead = page ? [["ord", "integer"]] : [["author", "text"], ["ord", "integer"]];
  const counts = {};
  for (const section of sections) {
    const view = feedView(section, page);
    const path = `${prefix}.${view}`;
    const cols = cat.get(view);
    if (!cols) { out.push({ path, kind: "feed-absent", json: "present", db: undefined }); continue; }
    if (!Array.isArray(json[section])) { out.push({ path, kind: "feed-absent", json: undefined, db: "present" }); continue; }

    const head = cols.slice(0, lead.length).map((c) => `${c.col}:${c.type}`).join(",");
    const want = lead.map(([c, t]) => `${c}:${t}`).join(",");
    if (head !== want) out.push({ path: `${path}[lead]`, kind: "key-order-or-set", json: want, db: head });

    const rows = await db.q(
      `select * from dash.${view}${page ? "" : " where author = $1"} order by ord`, page ? [] : [author]);
    // The row object carries the columns in view order; the leading ones are the
    // view's own, the rest must BE the JSON row.
    const bare = rows.map((r) => Object.fromEntries(Object.entries(r).slice(lead.length)));
    const bad = rows.findIndex((r, i) => r.ord !== i);
    if (bad > -1) out.push({ path: `${path}[${bad}].ord`, kind: "value", json: String(bad), db: String(rows[bad].ord) });

    const before = out.length;
    // An empty section has no row to take the keys from — then only the row
    // count (and the lead columns) can be held against it.
    if (json[section].length) {
      const kj = Object.keys(json[section][0]).join(KEYSEP);
      const kd = cols.slice(lead.length).map((c) => c.col).join(KEYSEP);
      if (kj !== kd) out.push({ path: `${path}[columns]`, kind: "key-order-or-set", json: kj.split(KEYSEP).join(","), db: kd.split(KEYSEP).join(",") });
    }
    diff(json[section], bare, path, out);
    if (out.length === before && JSON.stringify(json[section]) !== JSON.stringify(bare)) {
      out.push({ path, kind: "value", json: "section", db: "view" });   // diff() is capped; the bytes are the authority
    }
    counts[view] = json[section].length;
  }
  return counts;
}

// READER GRANTS. Everything above is read as the role this script runs as — in
// CI that is li_sync. The dashboards read as grafana_ro, and "the views are
// right" says nothing about whether THAT role may open them: with
// `revoke usage on schema dash from grafana_ro` the whole parity check stayed
// green while every panel answered "permission denied". No second credential is
// needed to look: has_*_privilege() answers for another role. Checked: USAGE on
// dash, SELECT on every dash.feed_* view, EXECUTE on the helpers the views call
// (a function inside a view is checked against the CALLER).
//
// Not checked when dash carries no grant for anybody — nspacl is NULL. That is a
// dump restored with --no-privileges (db/restore-drill.sh), where no role but the
// owner gets in at all and the ROLES section has to be re-applied anyway; the
// run then says so in its summary line (reader_grants=0) instead of failing.
// What this does NOT see: the datasource in Grafana itself (its password, its
// uid) and whether the live dashboards are the files in this repository.
const READER = "grafana_ro";
const READER_FUNCTIONS = ["li.current_month()", "li.current_week_monday()", "li.js_round(numeric)", "li.js_round(double precision)"];
async function readerGrants(db, cat, out) {
  const acl = await db.q("select nspacl is not null as granted from pg_namespace where nspname = 'dash'");
  if (!acl[0]?.granted) return 0;
  const miss = (path) => out.push({ path, kind: "grant-missing", json: undefined, db: undefined });
  const role = await db.q("select 1 from pg_roles where rolname = $1", [READER]);
  if (!role.length) { miss(`role.${READER}`); return 1; }
  let checked = 1;
  const usage = await db.q("select has_schema_privilege($1, 'dash', 'usage') as ok", [READER]);
  if (!usage[0].ok) miss("schema.dash[usage]");
  for (const view of cat.keys()) {
    checked++;
    const r = await db.q("select has_table_privilege($1, $2, 'select') as ok", [READER, `dash.${view}`]);
    if (!r[0].ok) miss(`dash.${view}[select]`);
  }
  for (const fn of READER_FUNCTIONS) {
    checked++;
    const r = await db.q("select has_function_privilege($1, $2, 'execute') as ok", [READER, fn]);
    if (!r[0].ok) miss(`${fn.replace(/[^\w.]+/g, "_").replace(/_$/, "")}[execute]`);
  }
  return checked;
}

// ------------------------------------------------------------------ main

// Default clock: the Monday AFTER the newest week anywhere in the corpus. Any
// instant works as long as both sides use it; this one is stable as the corpus
// grows a week, and keeps `lastWeek` pointing at a week that is really over.
let now = arg("now");
if (!now) {
  const probe = await openDb(DSN, null);
  // ::text, not a `date`: the driver turns a date into a JS Date at LOCAL midnight,
  // and toISOString() then lands on the day BEFORE for anyone east of UTC — the
  // default clock was a Sunday in Kyiv and a Monday in CI.
  const r = await probe.q(`
    select (max(w)::date + 7)::text as m from (
      select max(week) w from li.post_week
      union all select max(week) from li.account_week
      union all select max(week) from li.comment_week
      union all select max(attributed_week) from li.engagement_event
    ) x`);
  now = `${r[0].m}T00:00:00Z`;
  await probe.close();
}

const work = mkdtempSync(join(tmpdir(), "li-parity-"));
const failures = [];
const report = [];
// The second half: one entry per feed whose dash.feed_* views were compared.
const feedFailures = [];
const feedReport = [];
let readerChecked = 0;   // privileges of grafana_ro looked at; 0 = dash carries no grants at all

function run(script, args, cwd = REPO) {
  const r = spawnSync("node", [join(REPO, ".github", "scripts", script), ...args],
    { cwd, encoding: "utf8" });
  if (r.status !== 0) {
    // The script's stderr can quote the corpus (a JSON parse error does), so it is
    // shown only on request.
    throw new SafeError(`${script} exited ${r.status}` + (SHOW
      ? `: ${(r.stderr || "").trim().split("\n").slice(-3).join(" | ")}`
      : " (its stderr is withheld — re-run locally with --show-values)"));
  }
  return r;
}

// An author the JSON side publishes = a folder under dashboards/li-stats/ with an
// account.json (page/ and posts/ are not authors). Character for character the
// rule in .github/scripts/build-pages.mjs: if Pages would build a feed for it,
// the parity check has to look at it.
function publishedAuthors(corpus) {
  const root = join(corpus, "dashboards", "li-stats");
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !["page", "posts"].includes(d.name))
    .map((d) => d.name)
    .filter((name) => existsSync(join(root, name, "account.json")))
    .sort();
}

// A feed one side has and the other does not. Author keys are folder names in a
// public repo, so naming the feed is fine; what is "absent" is said by shape().
function oneSided(feed, path, side) {
  const d = [{ path, kind: "feed-absent", json: side === "json" ? "present" : undefined, db: side === "db" ? "present" : undefined }];
  report.push({ feed, identical: false, diffs: 1, sections: {} });
  failures.push({ feed: path, d });
}

const db = await openDb(DSN, now);
try {
  const oracle = [];   // { prefix, author | null, sections, json } — what the build scripts wrote
  const inJson = publishedAuthors(CORPUS);
  const inDb = await listAuthors(db);
  const authors = [...new Set([...inJson, ...inDb])].sort();

  for (const author of authors) {
    if (!inDb.includes(author)) { oneSided(`${author}/stats.json`, author, "json"); continue; }
    if (!inJson.includes(author)) { oneSided(`${author}/stats.json`, author, "db"); continue; }
    const ref = join(work, `${author}.json`);
    run("build-stats-json.mjs", [
      "--li-stats", join(CORPUS, "dashboards", "li-stats", author),
      "--skill-dir", join(CORPUS, ".claude", "skills", "linkedin-stats"),
      "--out", ref, "--now", now]);
    const fromJson = JSON.parse(readFileSync(ref, "utf8"));
    const fromDb = await buildStats(db, author);
    const d = diff(fromJson, fromDb, `${author}`);
    const identical = JSON.stringify(fromJson) === JSON.stringify(fromDb);
    report.push({
      feed: `${author}/stats.json`, identical, diffs: d.length,
      sections: Object.fromEntries(Object.keys(fromJson).map((k) =>
        [k, Array.isArray(fromJson[k]) ? fromJson[k].length : 1])),
    });
    if (!identical) failures.push({ feed: author, d });
    oracle.push({ prefix: author, author, sections: AUTHOR_SECTIONS, json: fromJson });
  }

  // page-stats.json. build-page-stats.mjs reads its inputs relative to cwd (DIR
  // is the literal 'dashboards/li-stats/page'), so the corpus is chosen by where
  // it is run from, not by a flag. A fixture corpus has no page export of its
  // own, hence --no-page.
  if (!flag("no-page")) {
  const pageRef = join(work, "page-stats.json");
  run("build-page-stats.mjs", ["--out", pageRef], CORPUS);
  const pageJson = JSON.parse(readFileSync(pageRef, "utf8"));
  const pageDb = await buildPageStats(db);
  const pd = diff(pageJson, pageDb, "page");
  const pageIdentical = JSON.stringify(pageJson) === JSON.stringify(pageDb);
  report.push({
    feed: "page-stats.json", identical: pageIdentical, diffs: pd.length,
    sections: Object.fromEntries(Object.keys(pageJson).map((k) =>
      [k, Array.isArray(pageJson[k]) ? pageJson[k].length : 1])),
  });
  if (!pageIdentical) failures.push({ feed: "page", d: pd });
  oracle.push({ prefix: "page", author: null, sections: PAGE_SECTIONS, json: pageJson });
  }

  // FEED PARITY. Same connection, same read-only transaction, same pinned clock
  // as everything above — and the JSON it is held against is the build scripts'
  // own output (`oracle`), never export.mjs's. A feed that is absent on one side
  // has already been reported above and has nothing to compare here.
  const cat = await feedCatalog(db);
  for (const o of oracle) {
    const d = [];
    const counts = await compareFeedViews(db, cat, o, d);
    const feed = o.author === null ? "page/dash.feed_page" : `${o.author}/dash.feed`;
    feedReport.push({ feed, identical: d.length === 0, diffs: d.length, sections: counts });
    if (d.length) feedFailures.push({ feed, d });
  }
  // A view nobody compares. Both lists count, whatever --no-page says: a page
  // view is on the list even when this run has no page feed to hold it against.
  const listed = new Set([...AUTHOR_SECTIONS.map((x) => feedView(x, false)), ...PAGE_SECTIONS.map((x) => feedView(x, true))]);
  const unlisted = [...cat.keys()].filter((v) => !listed.has(v))
    .map((v) => ({ path: `dash.${v}`, kind: "feed-absent", json: undefined, db: "present" }));
  if (unlisted.length) feedFailures.push({ feed: "dash.feed_views", d: unlisted });
  const ungranted = [];
  readerChecked = await readerGrants(db, cat, ungranted);
  if (ungranted.length) feedFailures.push({ feed: "dash.reader_grants", d: ungranted });
} finally {
  await db.close();
  if (!flag("keep")) rmSync(work, { recursive: true, force: true });
}

console.log(`parity check — clock pinned at ${now}\n`);
for (const r of report) {
  const tag = r.identical ? "OK  " : "DIFF";
  console.log(`${tag}  ${r.feed.padEnd(22)} ${r.identical ? "byte-identical" : `${r.diffs} difference(s)`}`);
  if (r.identical) {
    console.log(`        sections: ${Object.entries(r.sections).map(([k, v]) => `${k}=${v}`).join(" ")}`);
  }
}
// Nothing compared is not "identical": it is a check that did not look.
if (!report.length) {
  throw new SafeError("0 feeds to compare — no author folder with an account.json under dashboards/li-stats/ and no row in li.author");
}
// Always printed, in one fixed shape: the caller checks N against its own count
// of what main publishes, so an "OK" over too few feeds cannot pass for parity.
console.log(`\n-- ${report.length} feed(s) compared, ${failures.length} differ`);

// The second half, in the same line shapes as the first (db-ci.mjs shows a log
// line only if it is on its allowlist): one entry per feed, every view with its
// row count. Counts only — never a value.
console.log("");
for (const r of feedReport) {
  console.log(`${r.identical ? "OK  " : "DIFF"}  ${r.feed.padEnd(22)} ${r.identical ? "byte-identical" : `${r.diffs} difference(s)`}`);
  console.log(`        sections: ${Object.entries(r.sections).map(([k, v]) => `${k}=${v}`).join(" ")}`);
}
const feedTotals = {
  views: new Set(feedReport.flatMap((r) => Object.keys(r.sections))).size,
  compared: feedReport.reduce((n, r) => n + Object.keys(r.sections).length, 0),
  rows: feedReport.reduce((n, r) => n + Object.values(r.sections).reduce((a, b) => a + b, 0), 0),
};
const feedDiffs = feedFailures.reduce((n, f) => n + f.d.length, 0);
console.log(`${feedDiffs ? "DIFF" : "OK  "}  ${"dash.feed_views".padEnd(22)} ${feedDiffs ? `${feedDiffs} difference(s)` : "byte-identical"}`);
console.log(`        sections: views=${feedTotals.views} compared=${feedTotals.compared} rows=${feedTotals.rows} reader_grants=${readerChecked}`);
// The same rule as above, for the same reason: a green line over nothing is how
// a dashboard ends up reading views that no check has ever looked at.
if (!failures.length && !feedFailures.length && feedTotals.compared === 0) {
  throw new SafeError("0 feed views to compare — no feed reached the FEED PARITY block");
}

if (failures.length || feedFailures.length) {
  console.error("");
  for (const f of [...failures, ...feedFailures]) {
    console.error(`--- ${f.feed} ---`);
    for (const x of f.d) {
      console.error(`  ${x.path}  [${x.kind}]`);
      console.error(`      json: ${show(x.json)}`);
      console.error(`      db:   ${show(x.db)}`);
    }
  }
  if (!SHOW) console.error("\n(values redacted — run with --show-values locally to see them)");
  process.exit(1);
}
console.log("\nall feeds byte-identical between the JSON build and the database export.");
// (…and so is every dash.feed_* view: the line above is kept word for word
// because db-ci.mjs matches it; the feed views' verdict is the OK line above.)
