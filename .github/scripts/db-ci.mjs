#!/usr/bin/env node
// The CI side of the dual-write stage: runs the db/ commands for the `db-sync`
// and `db-backup` jobs and turns whatever happens into job outputs.
//
//   node .github/scripts/db-ci.mjs sync          LI_DSN=<li_sync dsn>
//   node .github/scripts/db-ci.mjs dump <out>    LI_BACKUP_DSN=<li_backup dsn>
//   node .github/scripts/db-ci.mjs touch         LI_DSN=<li_sync dsn>   (daily keep-alive)
//
// Three rules shape everything in this file.
//
// 1. THIS SCRIPT ALWAYS EXITS 0. JSON in git is the source of truth for the
//    collected week. A database that is down, asleep, hung or misconfigured must
//    not cost the week or turn the run red. It is NOT harmless any more, though:
//    Grafana reads the database (dash.feed_*), so a failed sync leaves the
//    dashboards on the previous sync. That is why what went wrong is reported
//    through $GITHUB_OUTPUT (the Slack message reads it and pings the operator)
//    and a ::warning:: annotation — never through the exit code.
//
// 2. NOTHING THE db/ SCRIPTS PRINT REACHES THE LOG UNFILTERED. This repository
//    is public, so its Actions logs are world-readable, and the data is third
//    parties' names, headlines, profile URLs and comment text. The db/ scripts
//    promise to print only counts, paths and hashes — but a Postgres error is not
//    theirs to word: "Key (profile_url)=(https://…/in/someone) already exists"
//    arrives in `detail`, and a connection error can carry the host from the DSN.
//    So child output is captured, and only lines matching a fixed allowlist are
//    shown. Everything else is COUNTED ("N line(s) withheld"), plus a short list
//    of fixed-vocabulary hints (an errno, a constraint name) so a failure is
//    still diagnosable. To see the rest, re-run the same command locally.
//
// 3. EVERY CHILD RUNS UNDER A HARD CAP. A hung TCP connect to a sleeping database
//    can outlive any patience; a job-level timeout-minutes would end the job as
//    CANCELLED, and continue-on-error does not cover a cancelled job. The caps
//    below are what guarantees the job-level timeout is never reached.
//
// Output vocabulary (read by notify-weekly.mjs — keep the two in step):
//   sync    ok | skipped-no-secret | failed:<deps|connect|import|script-missing> | timeout:<deps|import>
//           (failed:connect - the importer never got a connection: paused project, wrong DSN, network)
//   parity  ok | differs | incomplete | error | timeout          (empty: never ran)
//           (incomplete - no difference reported, but fewer feeds compared than main publishes)
//   feeds / feeds_expected   counts behind that verdict (for the backup commit message)
//   dump    ok=1 on success; otherwise backup=failed:<deps|dump|script-missing> | timeout:<deps|dump>

import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const CAPS = {
  touch: Number(process.env.DB_CI_TOUCH_CAP_SECS || 120),
  deps: Number(process.env.DB_CI_DEPS_CAP_SECS || 300),
  import: Number(process.env.DB_CI_IMPORT_CAP_SECS || 900),
  verify: Number(process.env.DB_CI_VERIFY_CAP_SECS || 600),
  dump: Number(process.env.DB_CI_DUMP_CAP_SECS || 900),
};
const KILL_GRACE_MS = 20000;
const MAX_CAPTURE = 8 * 1024 * 1024;
// GitHub refuses a single file of 100 MB or more; stop short of it with a clear
// message instead of a cryptic rejected push.
const MAX_DUMP_BYTES = 95 * 1024 * 1024;

// ------------------------------------------------------------- the log filter

const IDENT = String.raw`[A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)?`;
// A parity path is identifiers, dots, [n] and verify.mjs's own fixed suffixes —
// `{keys}`, `[columns]`, `[lead]`, `[select]` — only. A path that contains anything
// else (a URL-keyed or name-keyed object) is withheld, by design. The braces are
// here because without them the path line of every key-order difference was
// withheld while its two `json:` / `db:` lines were shown: digests with no address.
const PATH = String.raw`[\w$.\[\]{}-]+`;

// The tail db/safe-log.mjs produces for an error — the SHAPE of a failure, by
// construction without values. Accepted here only in its three fixed forms, and
// the free-text part of a server message only when it is made of plain words
// (no digits, no ':' or '/', so neither a URL nor a quoted value can ride along)
// plus safe-log's own "<redacted>" / "<value withheld>" / <addr> placeholders.
// Anything outside that is withheld and left to the HINTS below.
const SAFE_TAIL = String.raw`(?:` +
  // network / TLS:  ECONNREFUSED (connect) — could not reach the database (details withheld)
  String.raw`[A-Z][A-Z0-9_]{2,40}(?: \(\w+\))? — could not reach the database \(details withheld\)` +
  // pg's own client-side wording:  connection timeout — could not reach …
  String.raw`|(?:connection timeout|connection terminated(?: unexpectedly)?|query read timeout|server does not support SSL|SSL handshake error) — could not reach the database \(details withheld\)` +
  // a server error:  SQLSTATE 28P01 · table li.x · (auth_failed) — password authentication failed for user "<redacted>"
  // …optionally closed by safe-log's `: <value withheld>` — what is left of
  // `invalid input syntax for type integer: "…"`. The colon is accepted in that
  // one fixed position only, never inside the free text.
  String.raw`|SQLSTATE [0-9A-Z]{5}(?: · [\w .()]{1,80}){0,7} — (?:[A-Za-z_.,' -]|"<redacted>"|"<value withheld>"|<redacted>|<addr>|<value withheld>){1,200}(?:: <value withheld>)?` +
  String.raw`)`;

const ALLOW = {
  import: [
    // The importer's own connect-failure line: on a paused / unreachable /
    // misconfigured database this is the ONLY line it prints, so withholding it
    // left the operator with "exit code: 1" and nothing else.
    new RegExp(String.raw`^IMPORT FAILED — could not connect: ${SAFE_TAIL}$`),
    /^run [\w-]+$/,
    new RegExp(String.raw`^\s*${IDENT}\s+\d+ row\(s\) written$`),
    /^-- \d+ rows written(?: \(idempotent re-run: nothing changed\))?\.?$/,
    /^-- nothing changed \(idempotent re-run\)$/,
  ],
  verify: [
    new RegExp(String.raw`^PARITY CHECK COULD NOT RUN: ${SAFE_TAIL}$`),
    /^PARITY CHECK COULD NOT RUN: [\w.-]+\.mjs exited \d+ \(its stderr is withheld — re-run locally with --show-values\)$/,
    /^parity check — clock pinned at [\dT:.Z+-]+$/,
    new RegExp(String.raw`^(?:OK|DIFF)\s+[\w./-]+\s+(?:byte-identical|\d+ difference\(s\))$`),
    /^\s+sections:(?: [\w.-]+=\d+)*$/,
    new RegExp(String.raw`^--- [\w./-]+ ---$`),
    new RegExp(String.raw`^\s+${PATH}\s+\[(?:type|length|value|key-order-or-set|feed-absent|grant-missing)\]$`),
    /^-- \d+ feed\(s\) compared, \d+ differ$/,
    // Both of verify.mjs's "a check that did not look" refusals: no feed at all,
    // and no dash.feed_* view reached the FEED PARITY block.
    /^PARITY CHECK COULD NOT RUN: 0 feed(?:s| views) to compare — [\w ./-]+$/,
    /^\s+(?:json|db):\s+(?:absent|\w+ len=\d+ sha1=[0-9a-f]{8})$/,
    /^\(values redacted — run with --show-values locally to see them\)$/,
    /^all feeds byte-identical between the JSON build and the database export\.$/,
  ],
  touch: [
    new RegExp(String.raw`^PING FAILED: ${SAFE_TAIL}$`),
    /^ping ok — \d+ import run\(s\) on record$/,
  ],
  dump: [
    // db/backup.sh: "<table>  <rows in dump>  <rows in source>[  <-- DIFFERS]", its
    // header, and its own fixed-wording "backup: ..." status lines. Plain
    // "<table> <n>" layouts are accepted too, so a reworded script still shows.
    new RegExp(String.raw`^\s*"?${IDENT}"?(?:\s*[:=|]\s*|\s+)(?:\d+|MISSING)(?:\s+\d+)?(?:\s+rows?)?(?:\s+<-- DIFFERS)?\s*$`),
    /^table\s+in dump\s+in source$/,
    /^backup: [\w ,.()<>=—:-]+$/,
    /^pg_dump \(PostgreSQL\) \d+(?:\.\d+)*\b[\w .()~+-]*$/,
  ],
  deps: [
    /^(?:added|removed|changed|audited|up to date)[\w ,]*\d+[\w ,.]*$/i,
    /^npm (?:warn|error|notice) [\w .:/@^~<>=()'"-]*$/i,
  ],
};

// Fixed-vocabulary fragments lifted out of WITHHELD lines. Each pattern can only
// match identifiers and canned server wording, never row data: the point is to
// say "permission denied for table li.person" without saying whose row it was.
const HINTS = [
  // Which of the scripts' own failure lines it was, and the SQLSTATE: fixed
  // vocabulary even when the rest of the line has to be withheld.
  /IMPORT FAILED — (?:could not connect|rolled back, nothing changed)/,
  /PARITY CHECK COULD NOT RUN/,
  /\bSQLSTATE [0-9A-Z]{5}\b/,
  // Supabase's pooler for a project it cannot route to: paused, deleted, or a
  // wrong <role>.<project-ref> user name.
  /Tenant or user not found/i,
  /could not reach the database/i,
  /timeout exceeded when trying to connect/i,
  /\b(?:ECONNREFUSED|ETIMEDOUT|ENOTFOUND|ECONNRESET|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|EPIPE)\b/,
  /\b(?:SELF_SIGNED_CERT_IN_CHAIN|DEPTH_ZERO_SELF_SIGNED_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE|CERT_HAS_EXPIRED|ERR_TLS_CERT_ALTNAME_INVALID)\b/,
  /self[- ]signed certificate(?: in certificate chain)?/i,
  /password authentication failed/i,
  /no pg_hba\.conf entry/i,
  /permission denied for (?:table|schema|function|sequence|relation|database|view) [\w."]+/i,
  /must be owner of [a-z ]+ [\w."]+/i,
  /violates (?:unique|foreign key|check|not-null|exclusion) constraint "[\w.]+"/i,
  /null value in column "[\w.]+"(?: of relation "[\w.]+")? violates not-null constraint/i,
  /(?:relation|schema|role|database|column|type) "(?:[\w.]+|<redacted>)" does not exist/i,
  /function [\w.]+\([\w ,.\[\]"]*\) does not exist/i,
  /canceling statement due to (?:statement|lock) timeout/i,
  /(?:too many connections|remaining connection slots are reserved)/i,
  /Connection terminated(?: unexpectedly| due to connection timeout)?/i,
  /timeout expired|connection timed? ?out/i,
  /the database system is (?:starting up|shutting down|in recovery mode)/i,
  /aborting because of server version mismatch/i,
  /server version: \d+(?:\.\d+)*; pg_dump version: \d+(?:\.\d+)*/i,
  /SSL (?:connection is required|off|error)/i,
  /Cannot find (?:module|package) '[\w@./-]+'/,
  /(?:pg_dump|psql|bash): (?:command )?not found/i,
  /\bEACCES\b|\bENOENT\b|\bENOSPC\b/,
];

export function filterLog(kind, text) {
  const allow = ALLOW[kind] ?? [];
  const shown = [];
  const hints = new Set();
  let withheld = 0;
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) continue;
    if (allow.some((re) => re.test(line))) { shown.push(line); continue; }
    withheld += 1;
    for (const re of HINTS) {
      const m = line.match(re);
      if (m) hints.add(m[0]);
    }
  }
  return { shown, withheld, hints: [...hints] };
}

// verify.mjs exits 0 for "identical", 1 for "differs" and 2 for "could not run" -
// but an exit code is a claim, not evidence, so each one is held against the
// report that came with it:
//   - "differs" needs a DIFF row: exit 1 without one is a crash, i.e. "error";
//   - "ok" needs the count line, and the count has to cover what main PUBLISHES
//     (expectedFeeds below, counted here from the checkout, independently of
//     verify.mjs and of the database). An OK over fewer feeds is the silent zero
//     this repository keeps tripping over - a feed that is on Pages but never
//     reached the database used to be skipped, and the check passed. That is
//     "incomplete": not a difference, not parity, and not a clean week.
export function classifyParity({ code, timedOut, output, expected = 1 }) {
  if (timedOut) return "timeout";
  const text = String(output ?? "");
  if (code === 0) {
    const m = text.match(/^-- (\d+) feed\(s\) compared, (\d+) differ$/m);
    if (!m) return "incomplete";
    if (Number(m[2]) !== 0) return "differs";
    return Number(m[1]) >= Math.max(1, expected) ? "ok" : "incomplete";
  }
  if (code === 1 && /^DIFF\s+\S+\s+\d+ difference\(s\)$/m.test(text)) return "differs";
  return "error";
}

// How many feeds main publishes, by the rule .github/scripts/build-pages.mjs uses:
// one per folder under dashboards/li-stats/ that has an account.json, plus the
// company-page feed when its folder exists.
export function expectedFeeds(root = process.cwd()) {
  const dir = resolve(root, "dashboards", "li-stats");
  let authors = 0;
  try {
    authors = readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !["page", "posts"].includes(d.name))
      .filter((d) => existsSync(resolve(dir, d.name, "account.json"))).length;
  } catch { /* no corpus in the checkout: the import will already have failed */ }
  return authors + (existsSync(resolve(dir, "page")) ? 1 : 0);
}
function comparedFeeds(output) {
  const m = String(output ?? "").match(/^-- (\d+) feed\(s\) compared, \d+ differ$/m);
  return m ? Number(m[1]) : null;
}

// A failed import is one of three different stories. The importer prints a fixed
// line of its own when it never got a connection (db/import.mjs), which is what
// a paused Supabase project, a wrong DSN or a network problem all look like.
export function importState({ timedOut, output }) {
  if (timedOut) return "timeout:import";
  if (/^IMPORT FAILED — could not connect:/m.test(String(output ?? ""))) return "failed:connect";
  return "failed:import";
}

// db/backup.sh prints one line per table: "<table>  <rows in dump>  <rows in
// source>". The count that belongs in the backup's commit message is the one
// taken FROM THE DUMP (the first number). Simpler layouts - "li.post 12",
// "li.post: 12", "li.post=12", "li.post | 12", "li.post 12 rows" - parse too.
export function parseRowCounts(text) {
  const re = new RegExp(String.raw`^\s*"?(${IDENT})"?(?:\s*[:=|]\s*|\s+)(\d+)(?:\s+\d+)?(?:\s+rows?)?(?:\s+<-- DIFFERS)?\s*$`);
  const out = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const m = line.match(re);
    if (m && !/^(?:total|tables?|rows?|backup)$/i.test(m[1])) out.push({ table: m[1], rows: Number(m[2]) });
  }
  return out;
}

// ISO-8601 week label ("2026-W38") of a YYYY-MM-DD date — the week whose Monday
// the weekly workflow pins as WEEK.
export function isoWeekLabel(ymd) {
  const d = new Date(`${ymd}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  const day = (d.getUTCDay() + 6) % 7;
  const thursday = new Date(d.getTime() + (3 - day) * 86400e3);
  const year = thursday.getUTCFullYear();
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const week1Monday = jan4.getTime() - ((jan4.getUTCDay() + 6) % 7) * 86400e3;
  const week = 1 + Math.round((thursday.getTime() - 3 * 86400e3 - week1Monday) / (7 * 86400e3));
  return `${year}-W${String(week).padStart(2, "0")}`;
}

export function isoMonday(now = Date.now()) {
  const d = new Date(now);
  const day = (d.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day)).toISOString().slice(0, 10);
}

// The backup repo's git history IS the backup history - and, during the soak,
// the only DURABLE positive record that parity held: a good week says nothing
// loud in Slack, and the run's log and step summary expire with the run (about 90
// days). So the subject line answers "which week, did parity hold, how much
// data" on its own in `git log --oneline`, and the body repeats it in words.
// Everything that goes in is fixed vocabulary or a number - this is a commit in
// another repository, but the same "counts and names only" rule applies.
const PARITY_WORDS = {
  ok: (n, of) => `ok - ${n} of ${of} feeds byte-identical between the database export and the JSON build`,
  differs: () => "DIFFERS - the database export is NOT byte-identical to the JSON build (paths and hashes are in the run's db-sync job)",
  incomplete: (n, of) => `INCOMPLETE - no difference reported, but only ${n} of the ${of} feeds main publishes were compared. NOT verified`,
  error: () => "NOT VERIFIED - the parity check could not run",
  timeout: () => "NOT VERIFIED - the parity check timed out",
};

export function parityRecord({ parity = "", feeds = "", feedsExpected = "" } = {}) {
  const state = Object.prototype.hasOwnProperty.call(PARITY_WORDS, parity) ? parity : "unknown";
  const num = (v) => (/^\d{1,6}$/.test(String(v)) ? String(v) : "?");
  const n = num(feeds), of = num(feedsExpected);
  const short = state === "ok" ? `parity ok ${n}/${of}`
    : state === "unknown" ? "parity NOT RECORDED"
      : `parity ${state.toUpperCase()}`;
  const line = state === "unknown"
    ? "Parity: NOT RECORDED - this backup was made without a parity result (the db-sync outputs did not reach the backup job)"
    : `Parity: ${PARITY_WORDS[state](n, of)}`;
  return { state, short, line };
}

export function commitMessage({ week, counts, runUrl = "", parity, feeds, feedsExpected, via = "" }) {
  const monday = /^\d{4}-\d{2}-\d{2}$/.test(week ?? "") && isoWeekLabel(week) ? week : isoMonday();
  const label = isoWeekLabel(monday);
  const total = counts.reduce((n, c) => n + c.rows, 0);
  const rec = parityRecord({ parity, feeds, feedsExpected });
  const subject = counts.length
    ? `backup: ${label} (week of ${monday}) - ${rec.short} - ${counts.length} tables, ${total} rows`
    : `backup: ${label} (week of ${monday}) - ${rec.short} - row counts unavailable`;
  const width = Math.max(0, ...counts.map((c) => c.table.length));
  const body = counts.map((c) => `${c.table.padEnd(width)}  ${c.rows}`);
  // The backup only runs after sync == ok, so this line is a statement of fact.
  const head = ["Sync: ok - main imported and published by db/import.mjs --publish", rec.line];
  const viaClean = String(via).replace(/[^\w .()-]/g, "").trim().slice(0, 80);
  if (viaClean) head.push(`Via: ${viaClean}`);
  const tail = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/actions\/runs\/\d+$/.test(runUrl) ? [`Run: ${runUrl}`] : [];
  return [subject, "", ...head, ...tail, "", ...body].join("\n").trimEnd() + "\n";
}

// ------------------------------------------------------------- plumbing

function setOutput(name, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (file) appendFileSync(file, `${name}=${value}\n`);
  else console.log(`[output] ${name}=${value}`);
}

function summary(lines) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (file) appendFileSync(file, `${lines.join("\n")}\n`);
}

const warn = (msg) => console.log(`::warning::${msg}`);

// Defence in depth on top of the filter: register the DSN's password and host
// as masks, so even a line this script shows by mistake is starred out. The mask
// command itself is consumed by the runner and never rendered.
function maskDsn(dsn) {
  // Only on a runner: in a local terminal nothing consumes the command, and it
  // would PRINT the very values it is meant to hide.
  if (process.env.GITHUB_ACTIONS !== "true") return;
  try {
    const u = new URL(dsn);
    const local = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(u.hostname);
    if (u.password) console.log(`::add-mask::${decodeURIComponent(u.password)}`);
    if (u.password) console.log(`::add-mask::${u.password}`);
    if (u.hostname && !local) console.log(`::add-mask::${u.hostname}`);
    // Supabase's pooler puts the project ref in the user name: li_sync.<ref>.
    const ref = decodeURIComponent(u.username).split(".")[1];
    if (ref) console.log(`::add-mask::${ref}`);
  } catch {
    // Not a URL. Do not echo it; the import will fail and be reported as such.
  }
}

// Runs a child under a hard cap. Never throws, never streams: the caller gets
// the captured text and decides what may be shown.
export function runCapped(cmd, args, { capSecs, env = process.env, cwd = process.cwd() }) {
  return new Promise((done) => {
    let out = "";
    let timedOut = false;
    let child;
    try {
      // detached: its own process group, so the cap kills npm's/bash's children too.
      child = spawn(cmd, args, { env, cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      done({ code: null, timedOut: false, output: "", spawnError: e?.code ?? "spawn-failed" });
      return;
    }
    const take = (b) => { if (out.length < MAX_CAPTURE) out += b.toString("utf8"); };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    const kill = (sig) => { try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch { /* gone */ } } };
    const term = setTimeout(() => { timedOut = true; kill("SIGTERM"); }, capSecs * 1000);
    const hard = setTimeout(() => kill("SIGKILL"), capSecs * 1000 + KILL_GRACE_MS);
    child.on("error", (e) => {
      clearTimeout(term); clearTimeout(hard);
      done({ code: null, timedOut, output: out, spawnError: e?.code ?? "spawn-failed" });
    });
    child.on("close", (code) => {
      clearTimeout(term); clearTimeout(hard);
      done({ code, timedOut, output: out });
    });
  });
}

function report(kind, label, res, capSecs) {
  const f = filterLog(kind, res.output);
  console.log(`::group::${label}`);
  for (const line of f.shown) console.log(line);
  if (f.withheld) {
    console.log(`(${f.withheld} line(s) withheld from this public log — they are not on the allowlist and may contain personal data; re-run the command locally to read them)`);
  }
  if (f.hints.length) console.log(`hints from the withheld lines: ${f.hints.join(" | ")}`);
  if (res.spawnError) console.log(`could not start: ${res.spawnError}`);
  console.log(res.timedOut ? `killed at the ${capSecs}s cap` : `exit code: ${res.code}`);
  console.log("::endgroup::");
  return f;
}

// The import had just worked, so a pause is less likely here than a blip - but
// the action is the same, and an unverified week does not count for the soak.
// Two differences that are NOT a data bug and that no code change fixes. Keep in
// step with DIFFERS_ACTION in notify-weekly.mjs.
const SCHEMA_HINT = "If every line is [feed-absent] on a dash.feed_* view, the schema in the database is older than main: re-apply it (apply-schema --force, then import --publish - db/README.md), do not look for a data bug. [grant-missing] means the role Grafana logs in as (grafana_ro) lost a privilege: the panels answer 'permission denied' - re-apply the ROLES section of db/schema.sql.";
const RECHECK = "Run pages-deploy to re-sync and re-check (the import is idempotent); if the database does not answer, check in the Supabase dashboard that the project is not paused. This week does NOT count as verified.";
const hintTail = (f) => (f.hints.length ? ` Hints: ${f.hints.join(" | ")}.` : "");
// What a problem costs. Grafana reads the database, so the three kinds of step
// are no longer the same story - and the old one-size sentence ("The week is NOT
// affected: JSON in git is still the source of truth") had become a half-truth
// for two of them. Keep in step with DASHBOARDS in notify-weekly.mjs.
//   sync    - the week is safe, the dashboards are NOT current;
//   parity  - the week is safe and the database was updated, but it is not
//             confirmed to match the JSON build;
//   backup  - neither the week nor the dashboards are touched.
const DASHBOARDS_STALE = "The collected week is safe in git, but Grafana reads the database: the dashboards stay on the previous sync until this is fixed and pages-deploy is re-run.";
// The database did not ANSWER (never connected, or hung until the cap). That is
// not "stale": Grafana reads this same database, so while it is paused or
// unreachable the panels have nothing to read at all. Saying "the dashboards
// keep showing last week" right next to "the project is paused" was a
// contradiction. Keep in step with DASHBOARDS.down in notify-weekly.mjs.
const DASHBOARDS_DOWN = "The collected week is safe in git, but Grafana reads this same database: while it is paused or unreachable every panel shows a datasource error - not last week's numbers - until it answers again; after that the dashboards stay on the previous sync until pages-deploy has re-run.";
const DASHBOARDS_UNVERIFIED = "The collected week is safe in git, but Grafana reads the database, and this sync is not confirmed to match the JSON build: the dashboards may show different numbers until this is fixed and pages-deploy is re-run.";
const UNAFFECTED = "The week and the dashboards are NOT affected: the week is safe in git, and a backup changes nothing in the database Grafana reads.";
// The cron runs exactly 7 days apart and the Supabase free tier pauses a project
// after 7 idle days, so "paused" is the FIRST thing to check on any Monday the
// database did not answer. Keep in step with RESUME_ACTION in notify-weekly.mjs.
const RESUME = "Most likely the Supabase project is paused (the free tier pauses after 7 idle days): resume it in the Supabase dashboard, then run pages-deploy to re-sync - the import is idempotent.";

// `npm ci --prefix db`. npm gets NO database credential: it executes third-party
// code, and --ignore-scripts keeps even that to a minimum. Returns null on
// success, otherwise the state to report. `cost` is what the failure means for
// the caller's step (see DASHBOARDS_STALE / UNAFFECTED above).
async function installDeps(what, cost) {
  const bare = { ...process.env };
  delete bare.LI_DSN;
  delete bare.LI_BACKUP_DSN;
  const deps = await runCapped("npm", ["ci", "--prefix", "db", "--no-audit", "--no-fund", "--ignore-scripts"], { capSecs: CAPS.deps, env: bare });
  if (deps.code === 0) { console.log("db/ dependencies installed"); return null; }
  report("deps", "npm ci --prefix db", deps, CAPS.deps);
  warn(`database ${what} FAILED — could not install the db/ dependencies. ${cost}`);
  return deps.timedOut ? "timeout:deps" : "failed:deps";
}

// ------------------------------------------------------------- sync

async function sync() {
  const dsn = process.env.LI_DSN ?? "";
  if (!dsn.trim()) {
    warn(`database sync SKIPPED — the LI_SYNC_DATABASE_URL secret is not set. ${DASHBOARDS_STALE}`);
    setOutput("sync", "skipped-no-secret");
    summary(["### Database sync", "Skipped: the `LI_SYNC_DATABASE_URL` secret is not set."]);
    return;
  }
  maskDsn(dsn);

  for (const f of ["db/import.mjs", "db/verify.mjs", "db/package.json"]) {
    if (!existsSync(f)) {
      warn(`database sync FAILED — ${f} is missing from main. ${DASHBOARDS_STALE}`);
      setOutput("sync", "failed:script-missing");
      return;
    }
  }

  const depsState = await installDeps("sync", DASHBOARDS_STALE);
  if (depsState) { setOutput("sync", depsState); return; }

  const imp = await runCapped(process.execPath, ["db/import.mjs", "--publish"], { capSecs: CAPS.import });
  const impLog = report("import", "import (db/import.mjs --publish)", imp, CAPS.import);
  if (imp.code !== 0) {
    const how = imp.timedOut ? `timed out after ${CAPS.import}s` : `exited ${imp.code ?? "without starting"}`;
    // "Never got a connection" is its own phase: it is the paused-project case,
    // it has one specific action, and nothing was rolled back because nothing
    // began. A hang killed at the cap is the same story told more slowly.
    const state = importState(imp);
    const action = state === "failed:import" ? "" : ` ${RESUME}`;
    // failed:import = the database answered and refused: the dashboards are up,
    // on the previous sync. Anything else = it did not answer: they are down.
    const cost = state === "failed:import" ? DASHBOARDS_STALE : DASHBOARDS_DOWN;
    warn(`database sync FAILED — the import ${state === "failed:connect" ? "could not connect to the database" : how}.${hintTail(impLog)}${action} ${cost}`);
    setOutput("sync", state);
    summary(["### Database sync", `Import **failed** (${state}; ${how}). Parity check not run.`, ...(action ? ["", RESUME] : [])]);
    return;
  }
  setOutput("sync", "ok");

  const ver = await runCapped(process.execPath, ["db/verify.mjs"], { capSecs: CAPS.verify });
  const verLog = report("verify", "parity check (db/verify.mjs)", ver, CAPS.verify);
  const expected = expectedFeeds();
  const compared = comparedFeeds(ver.output);
  const parity = classifyParity({ ...ver, expected });
  setOutput("parity", parity);
  // Counts only. They travel to the backup's commit message, which is the
  // durable record of the soak (the run log expires, the backup repo does not).
  setOutput("feeds", compared ?? "");
  setOutput("feeds_expected", expected);
  if (parity === "incomplete") {
    warn(`database parity check INCOMPLETE — it reported no difference but compared ${compared ?? "an unknown number of"} feed(s), and main publishes ${expected}. A feed that is on Pages but not in the database (or a check that did not report its count) is NOT parity. This week does NOT count as verified. ${DASHBOARDS_UNVERIFIED}`);
  } else if (parity === "differs") {
    warn(`database PARITY DIFFERENCE — the database export is not byte-identical to the JSON build; the differing paths are in this job's log (values are hashed). ${SCHEMA_HINT} ${DASHBOARDS_UNVERIFIED}`);
  } else if (parity !== "ok") {
    const how = ver.timedOut ? `timed out after ${CAPS.verify}s` : `exited ${ver.code ?? "without starting"} without a parity report`;
    warn(`database parity check COULD NOT RUN — it ${how}.${hintTail(verLog)} ${RECHECK} ${DASHBOARDS_UNVERIFIED}`);
  } else {
    console.log(`::notice::database sync and parity check OK — ${compared} feed(s) compared (main publishes ${expected}), every one byte-identical between the database export and the JSON build`);
  }
  summary(["### Database sync", `Import: **ok**. Parity: **${parity}** — ${compared ?? "?"} feed(s) compared, main publishes ${expected}.`]);
}

// ------------------------------------------------------------- touch

// The daily keep-alive (linkedin-session-check.yml): one tiny read so the
// Supabase free tier never counts 7 idle days between two Monday syncs. Same
// rules as everything else here - exit 0, filtered output, a hard cap.
//
// Since the Grafana panels read this database, it is also the ONLY daily probe
// of what the dashboards read: "did not answer" means the dashboards are down
// NOW, not "Monday's sync might fail". The warning below says so. It still has
// no Slack line of its own - the daily workflow does not forward the `touch`
// output (see WEEKLY-CADENCE.md section 9, an open operator decision).
const KEEPALIVE_RESUME = "Most likely the Supabase project is paused (the free tier pauses after 7 idle days): resume it in the Supabase dashboard.";
const KEEPALIVE_DOWN = "Grafana reads this database: while it does not answer, the dashboards are down RIGHT NOW (every panel shows a datasource error) - do not wait for Monday.";
const KEEPALIVE_NOT_PROBED = "The database was NOT probed today, so this says nothing about whether the dashboards can reach it; the collected data is not affected.";
async function touch() {
  const dsn = process.env.LI_DSN ?? "";
  if (!dsn.trim()) {
    warn(`database keep-alive SKIPPED — the LI_SYNC_DATABASE_URL secret is not set. ${KEEPALIVE_NOT_PROBED}`);
    setOutput("touch", "skipped-no-secret");
    return;
  }
  maskDsn(dsn);
  for (const f of ["db/ping.mjs", "db/package.json"]) {
    if (!existsSync(f)) {
      warn(`database keep-alive FAILED — ${f} is missing from the checkout. ${KEEPALIVE_NOT_PROBED}`);
      setOutput("touch", "failed:script-missing");
      return;
    }
  }
  const depsState = await installDeps("keep-alive", KEEPALIVE_NOT_PROBED);
  if (depsState) { setOutput("touch", depsState); return; }
  const res = await runCapped(process.execPath, ["db/ping.mjs"], { capSecs: CAPS.touch });
  const log = report("touch", "keep-alive (db/ping.mjs)", res, CAPS.touch);
  if (res.code === 0) { setOutput("touch", "ok"); return; }
  warn(`database keep-alive FAILED — the database did not answer.${hintTail(log)} ${KEEPALIVE_RESUME} ${KEEPALIVE_DOWN}`);
  setOutput("touch", res.timedOut ? "timeout:connect" : "failed:connect");
}

// ------------------------------------------------------------- dump

async function dump(out) {
  const fail = (state, msg) => { warn(`database backup FAILED — ${msg} ${UNAFFECTED}`); setOutput("backup", state); };
  if (!out) return fail("failed:dump", "no output path was given to db-ci.mjs dump.");
  const dsn = process.env.LI_BACKUP_DSN ?? "";
  if (!dsn.trim()) return fail("failed:dump", "LI_BACKUP_DSN is empty.");
  maskDsn(dsn);
  if (!existsSync("db/backup.sh")) return fail("failed:script-missing", "db/backup.sh is missing from main.");

  // db/backup.sh goes through db/pg-env.mjs, which needs the db/ packages.
  const depsState = await installDeps("backup", UNAFFECTED);
  if (depsState) { setOutput("backup", depsState); return; }

  const version = await runCapped("pg_dump", ["--version"], { capSecs: 30, env: { PATH: process.env.PATH } });
  report("dump", "pg_dump --version", version, 30);

  const res = await runCapped("bash", ["db/backup.sh", out], { capSecs: CAPS.dump });
  const log = report("dump", "db/backup.sh", res, CAPS.dump);
  if (res.code !== 0) {
    const how = res.timedOut ? `timed out after ${CAPS.dump}s` : `exited ${res.code ?? "without starting"}`;
    return fail(res.timedOut ? "timeout:dump" : "failed:dump", `db/backup.sh ${how}.${hintTail(log)}`);
  }
  let size = 0;
  try { size = statSync(out).size; } catch { /* checked below */ }
  if (!size) return fail("failed:dump", "db/backup.sh exited 0 but wrote no dump file.");
  if (size >= MAX_DUMP_BYTES) {
    return fail("failed:dump", `the dump is ${Math.round(size / 1048576)} MiB; GitHub rejects files of 100 MB and over, so it cannot be pushed as one file.`);
  }

  const counts = parseRowCounts(res.output);
  if (!counts.length) warn("database backup: db/backup.sh printed no per-table row counts — the commit message will not carry them");
  const server = process.env.GITHUB_SERVER_URL, repo = process.env.GITHUB_REPOSITORY, id = process.env.GITHUB_RUN_ID;
  // The parity verdict of THIS run's db-sync job, handed over by the workflow
  // (needs.db-sync.outputs.*). Empty means it did not arrive, and the commit
  // says "NOT RECORDED" rather than staying quiet about it.
  const rec = parityRecord({ parity: process.env.DB_PARITY ?? "", feeds: process.env.DB_FEEDS ?? "", feedsExpected: process.env.DB_FEEDS_EXPECTED ?? "" });
  if (rec.state === "unknown") warn("database backup: no parity result reached the backup job — the backup commit will say 'parity NOT RECORDED', and this week cannot count for the soak");
  const via = [process.env.GITHUB_WORKFLOW, process.env.GITHUB_EVENT_NAME && `(${process.env.GITHUB_EVENT_NAME})`].filter(Boolean).join(" ");
  writeFileSync(`${out}.msg`, commitMessage({
    week: process.env.WEEK ?? "", counts, runUrl: server && repo && id ? `${server}/${repo}/actions/runs/${id}` : "",
    parity: process.env.DB_PARITY ?? "", feeds: process.env.DB_FEEDS ?? "", feedsExpected: process.env.DB_FEEDS_EXPECTED ?? "", via,
  }), { mode: 0o600 });
  console.log(`commit message: ${rec.short}`);
  console.log(`dump written: ${size} bytes, ${counts.length} table(s), ${counts.reduce((n, c) => n + c.rows, 0)} row(s)`);
  setOutput("ok", "1");
}

// ------------------------------------------------------------- main

const IS_MAIN = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (IS_MAIN) {
  const [mode, arg] = process.argv.slice(2);
  try {
    if (mode === "sync") await sync();
    else if (mode === "touch") await touch();
    else if (mode === "dump") await dump(arg);
    else warn(`db-ci.mjs: unknown mode '${String(mode).replace(/[^\w-]/g, "")}'`);
  } catch (e) {
    // Only the error's class: a message can quote data or the DSN.
    // What an unfinished step costs depends on which step it was.
    const cost = mode === "sync" ? DASHBOARDS_STALE : mode === "dump" ? UNAFFECTED : "Nothing else is affected.";
    warn(`db-ci.mjs crashed (${e?.code ?? e?.name ?? "error"}) — the database step did not finish. ${cost}`);
  }
  // Rule 1. Set explicitly so a stray process.exitCode elsewhere cannot leak out.
  process.exit(0);
}
