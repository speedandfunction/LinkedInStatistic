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
// Exit 0 = byte-identical on every section of every feed, and at least one feed.
// Exit 1 = a real difference, printed with its exact path.
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

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
function shape(v) {
  if (v === undefined) return "absent";
  const s = String(v);
  const t = v === null ? "null" : typeof v;
  return `${t} len=${s.length} sha1=${createHash("sha1").update(s).digest("hex").slice(0, 8)}`;
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

// ------------------------------------------------------------------ main

// Default clock: the Monday AFTER the newest week anywhere in the corpus. Any
// instant works as long as both sides use it; this one is stable as the corpus
// grows a week, and keeps `lastWeek` pointing at a week that is really over.
let now = arg("now");
if (!now) {
  const probe = await openDb(DSN, null);
  const r = await probe.q(`
    select max(w)::date + 7 as m from (
      select max(week) w from li.post_week
      union all select max(week) from li.account_week
      union all select max(week) from li.comment_week
      union all select max(attributed_week) from li.engagement_event
    ) x`);
  now = `${r[0].m.toISOString().slice(0, 10)}T00:00:00Z`;
  await probe.close();
}

const work = mkdtempSync(join(tmpdir(), "li-parity-"));
const failures = [];
const report = [];

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
  }
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
if (failures.length) {
  console.error("");
  for (const f of failures) {
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
