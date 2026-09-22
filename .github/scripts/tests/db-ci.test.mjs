#!/usr/bin/env node
// Offline regression for the CI side of the dual-write stage (db-ci.mjs).
// No database and no network: the db/ commands are replaced by stubs in a temp
// directory, because what is under test is what CI does with THEIR behaviour —
// a crash, a hang, a leaked row, a parity difference — not the commands.
//
//   node --test .github/scripts/tests/db-ci.test.mjs
//
// What must never regress: a database problem turning the run red (exit != 0),
// a problem staying silent (no output, no ::warning::), and a third party's
// name or a DSN reaching a world-readable log.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { classifyParity, commitMessage, expectedFeeds, filterLog, importState, isoWeekLabel, parityRecord, parseRowCounts } from "../db-ci.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(HERE, "..", "db-ci.mjs");

const SECRET_HOST = "db.abcdefghijklmnop.supabase.co";
const SECRET_PW = "s3cr3t-Passw0rd";
const DSN = `postgresql://li_sync:${SECRET_PW}@${SECRET_HOST}:5432/postgres`;
const PERSON = "Jane Q. Thirdparty";
const PROFILE = "https://www.linkedin.com/in/jane-thirdparty";

// A throwaway "repo": db/ with a dependency-free package (so `npm ci` is real
// but offline) and stub import/verify/backup scripts.
const VERIFY_OK = [
  'console.log("OK    andy/stats.json        byte-identical");',
  'console.log("OK    peter/stats.json       byte-identical");',
  'console.log("OK    page-stats.json        byte-identical");',
  'console.log("");',
  'console.log("-- 3 feed(s) compared, 0 differ");',
  'console.log("all feeds byte-identical between the JSON build and the database export.");',
].join("");

function sandbox({ importJs, verifyJs, backupSh, pingJs, authors = ["andy", "peter"] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "db-ci-"));
  mkdirSync(join(dir, "db"));
  // What main PUBLISHES: one feed per author folder with an account.json, plus
  // the page feed. posts/ and a folder without account.json are not feeds.
  for (const a of authors) {
    mkdirSync(join(dir, "dashboards", "li-stats", a), { recursive: true });
    writeFileSync(join(dir, "dashboards", "li-stats", a, "account.json"), "{}");
  }
  for (const d of ["page", "posts", "draft-no-account"]) mkdirSync(join(dir, "dashboards", "li-stats", d), { recursive: true });
  if (pingJs) writeFileSync(join(dir, "db", "ping.mjs"), pingJs);
  writeFileSync(join(dir, "db", "package.json"), JSON.stringify({ name: "stub", version: "1.0.0", private: true }));
  writeFileSync(join(dir, "db", "package-lock.json"), JSON.stringify({
    name: "stub", version: "1.0.0", lockfileVersion: 3, requires: true, packages: { "": { name: "stub", version: "1.0.0" } },
  }));
  if (importJs !== null) writeFileSync(join(dir, "db", "import.mjs"), importJs ?? 'console.error("run abc-123");console.error("  post                         67 row(s) written");console.log("-- 67 rows written");');
  if (verifyJs !== null) writeFileSync(join(dir, "db", "verify.mjs"), verifyJs ?? VERIFY_OK);
  if (backupSh) writeFileSync(join(dir, "db", "backup.sh"), backupSh);
  return dir;
}

function run(dir, args, env = {}) {
  const outFile = join(dir, "github-output.txt");
  writeFileSync(outFile, "");
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: dir, encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: process.env.HOME, GITHUB_OUTPUT: outFile, GITHUB_ACTIONS: "true", ...env },
  });
  const outputs = Object.fromEntries(readFileSync(outFile, "utf8").split("\n").filter(Boolean).map((l) => {
    const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1)];
  }));
  return { code: r.status, log: r.stdout + r.stderr, outputs };
}

// Whatever the log shows, it may show the mask COMMANDS (the runner consumes
// those) but never the secret anywhere else.
function assertNoLeak(log) {
  const visible = log.split("\n").filter((l) => !l.startsWith("::add-mask::")).join("\n");
  for (const s of [SECRET_PW, SECRET_HOST, "abcdefghijklmnop", PERSON, PROFILE, "jane-thirdparty", "postgresql://"]) {
    assert.ok(!visible.includes(s), `must not reach a public log: ${s}`);
  }
}

// ------------------------------------------------------------- sync: outcomes

test("a missing secret is a skip with a ::warning::, never a failure", () => {
  const r = run(sandbox(), ["sync"], { LI_DSN: "" });
  assert.equal(r.code, 0);
  assert.deepEqual(r.outputs, { sync: "skipped-no-secret" });
  // Grafana reads the database, so a sync that did not happen is no longer "the
  // week is NOT affected, full stop": the week is safe, the dashboards are stale.
  assert.match(r.log, /::warning::database sync SKIPPED — the LI_SYNC_DATABASE_URL secret is not set\. The collected week is safe in git, but Grafana reads the database: the dashboards stay on the previous sync/);
});

test("a clean sync reports sync=ok parity=ok, shows counts, and masks the DSN's password and host", () => {
  const r = run(sandbox(), ["sync"], { LI_DSN: DSN });
  assert.equal(r.code, 0);
  assert.deepEqual(r.outputs, { sync: "ok", parity: "ok", feeds: "3", feeds_expected: "3" });
  assert.match(r.log, /-- 67 rows written/);
  assert.match(r.log, /^-- 3 feed\(s\) compared, 0 differ$/m);
  assert.match(r.log, /::notice::database sync and parity check OK — 3 feed\(s\) compared \(main publishes 3\)/);
  assert.match(r.log, /all feeds byte-identical/);
  assert.match(r.log, new RegExp(`^::add-mask::${SECRET_PW}$`, "m"));
  assert.match(r.log, new RegExp(`^::add-mask::${SECRET_HOST.replaceAll(".", "\\.")}$`, "m"));
  assert.doesNotMatch(r.log, /::warning::/);
  assertNoLeak(r.log);
});

test("a failed import is sync=failed:import with a ::warning::, exit 0, no parity run — and the failing ROW never reaches the log", () => {
  const importJs = `
    console.error("IMPORT FAILED: duplicate key value violates unique constraint \\"person_pkey\\"");
    console.error("  detail: Key (profile_url)=(${PROFILE}) already exists. name=${PERSON}");
    console.error("    at connect ${DSN}");
    process.exit(1);`;
  const r = run(sandbox({ importJs }), ["sync"], { LI_DSN: DSN });
  assert.equal(r.code, 0, "a database problem must never turn the run red");
  assert.deepEqual(r.outputs, { sync: "failed:import" });
  assert.match(r.log, /::warning::database sync FAILED — the import exited 1\./);
  assert.match(r.log, /violates unique constraint "person_pkey"/, "the constraint NAME is a safe hint");
  assert.match(r.log, /3 line\(s\) withheld from this public log/);
  assert.doesNotMatch(r.log, /paused/, "an import that connected and rolled back is not a paused project");
  // The database ANSWERED and refused: the dashboards are up, on the previous sync.
  assert.match(r.log, /::warning::database sync FAILED[^\n]*the dashboards stay on the previous sync until this is fixed/);
  assert.doesNotMatch(r.log, /datasource error/);
  assertNoLeak(r.log);
});

// The Monday case. The cron is 7 days apart and the Supabase free tier pauses
// after 7 idle days, so "could not connect" is the likeliest failure there is —
// and it used to leave the log with "exit code: 1", one withheld line, no hints.
test("a paused / unreachable database is sync=failed:connect: the importer's own safe line is SHOWN, and the warning names the pause and the action", () => {
  const cases = [
    ["connection timeout — could not reach the database (details withheld)", /connection timeout/],
    ["ETIMEDOUT (connect) — could not reach the database (details withheld)", /ETIMEDOUT/],
    ["ECONNREFUSED (connect) — could not reach the database (details withheld)", /ECONNREFUSED/],
    ["SQLSTATE XX000 — Tenant or user not found", /Tenant or user not found/],
    ['SQLSTATE 3D000 · (InitPostgres) — database "<redacted>" does not exist', /does not exist/],
    ['SQLSTATE 28P01 · (auth_failed) — password authentication failed for user "<redacted>"', /password authentication failed/],
  ];
  for (const [tail, seen] of cases) {
    const importJs = `console.error(${JSON.stringify(`IMPORT FAILED — could not connect: ${tail}`)}); process.exit(1);`;
    const r = run(sandbox({ importJs }), ["sync"], { LI_DSN: DSN });
    assert.equal(r.code, 0, tail);
    assert.deepEqual(r.outputs, { sync: "failed:connect" }, tail);
    assert.ok(r.log.includes(`IMPORT FAILED — could not connect: ${tail}`), `shown, not withheld: ${tail}`);
    assert.doesNotMatch(r.log, /withheld from this public log/, tail);
    assert.match(r.log, seen, tail);
    assert.match(r.log, /::warning::database sync FAILED — the import could not connect to the database\..*Most likely the Supabase project is paused \(the free tier pauses after 7 idle days\): resume it in the Supabase dashboard, then run pages-deploy to re-sync - the import is idempotent\. The collected week is safe in git, but Grafana reads this same database: while it is paused or unreachable every panel shows a datasource error - not last week's numbers - until it answers again/, tail);
    // "paused" and "the dashboards keep showing last week" cannot both be true.
    assert.doesNotMatch(r.log, /::warning::database sync FAILED[^\n]*the dashboards stay on the previous sync until this is fixed/, tail);
    assertNoLeak(r.log);
  }
});

test("the connect-failure line is shown ONLY in its safe shapes — a host, a DSN or a name riding on it is withheld, and the hints still say what happened", () => {
  for (const tail of [
    `SQLSTATE 28P01 — password authentication failed for user "${PERSON}"`,
    `getaddrinfo ENOTFOUND ${SECRET_HOST}`,
    `SQLSTATE XX000 — Tenant or user not found at ${DSN}`,
    `SQLSTATE 23505 — Key (profile_url)=(${PROFILE}) already exists`,
  ]) {
    const importJs = `console.error(${JSON.stringify(`IMPORT FAILED — could not connect: ${tail}`)}); process.exit(1);`;
    const r = run(sandbox({ importJs }), ["sync"], { LI_DSN: DSN });
    assert.deepEqual(r.outputs, { sync: "failed:connect" }, tail);
    assert.match(r.log, /1 line\(s\) withheld from this public log/, tail);
    assert.match(r.log, /hints from the withheld lines: IMPORT FAILED — could not connect/, tail);
    assertNoLeak(r.log);
  }
  const f = filterLog("import", "IMPORT FAILED — could not connect: SQLSTATE XX000 — Tenant or user not found\nIMPORT FAILED — could not connect: Error — message withheld (it may quote data); re-run locally with --show-values");
  assert.equal(f.shown.length, 1);
  assert.deepEqual(f.hints, ["IMPORT FAILED — could not connect"]);
  assert.deepEqual(filterLog("dump", 'pg_dump: error: FATAL:  Tenant or user not found\nFATAL: database "<redacted>" does not exist').hints,
    ["Tenant or user not found", 'database "<redacted>" does not exist']);
});

// Parity "ok" must be EARNED: exit 0 is a claim, the count is the evidence.
test("a parity check that says OK over fewer feeds than main publishes is parity=incomplete, never ok", () => {
  // The vacuous pass: the database lost an author, verify.mjs (as it used to be)
  // looped over the database's list and found nothing to complain about.
  const two = 'console.log("OK    peter/stats.json       byte-identical");console.log("OK    page-stats.json        byte-identical");console.log("-- 2 feed(s) compared, 0 differ");';
  const r = run(sandbox({ verifyJs: two }), ["sync"], { LI_DSN: DSN });
  assert.equal(r.code, 0);
  assert.deepEqual(r.outputs, { sync: "ok", parity: "incomplete", feeds: "2", feeds_expected: "3" });
  assert.match(r.log, /::warning::database parity check INCOMPLETE — it reported no difference but compared 2 feed\(s\), and main publishes 3\./);
  assert.doesNotMatch(r.log, /::notice::database sync and parity check OK/);

  // An OK with no count line at all (an older verify.mjs, a reworded one) is not evidence either.
  const silent = run(sandbox({ verifyJs: 'console.log("all feeds byte-identical between the JSON build and the database export.");' }), ["sync"], { LI_DSN: DSN });
  assert.deepEqual(silent.outputs, { sync: "ok", parity: "incomplete", feeds: "", feeds_expected: "3" });
  assert.match(silent.log, /compared an unknown number of feed\(s\)/);

  // A feed present on one side only is a DIFF, shown by name and shape.
  const absent = `
    console.log("OK    peter/stats.json       byte-identical");
    console.log("DIFF  andy/stats.json        1 difference(s)");
    console.log("-- 3 feed(s) compared, 1 differ");
    console.error("--- andy ---");
    console.error("  andy  [feed-absent]");
    console.error("      json: string len=7 sha1=0a1b2c3d");
    console.error("      db:   absent");
    process.exit(1);`;
  const d = run(sandbox({ verifyJs: absent }), ["sync"], { LI_DSN: DSN });
  assert.deepEqual(d.outputs, { sync: "ok", parity: "differs", feeds: "3", feeds_expected: "3" });
  assert.match(d.log, /^ {2}andy {2}\[feed-absent\]$/m);
  assert.match(d.log, /db: {3}absent/);
  assert.doesNotMatch(d.log, /withheld from this public log/);
});

test("expectedFeeds counts what build-pages.mjs publishes: author folders with account.json, plus page", () => {
  assert.equal(expectedFeeds(sandbox()), 3);
  assert.equal(expectedFeeds(sandbox({ authors: ["andy", "maria", "peter"] })), 4);
  assert.equal(expectedFeeds(mkdtempSync(join(tmpdir(), "db-ci-empty-"))), 0);
});

test("verify's own 'could not run' line is shown in its safe shapes", () => {
  const f = filterLog("verify", [
    "PARITY CHECK COULD NOT RUN: connection timeout — could not reach the database (details withheld)",
    "PARITY CHECK COULD NOT RUN: build-stats-json.mjs exited 1 (its stderr is withheld — re-run locally with --show-values)",
    "PARITY CHECK COULD NOT RUN: SQLSTATE 42501 · table dash.post_week · (aclcheck_error) — permission denied for view post_week",
    "PARITY CHECK COULD NOT RUN: 0 feeds to compare — no author folder with an account.json under dashboards/li-stats/ and no row in li.author",
    `PARITY CHECK COULD NOT RUN: SyntaxError: Unexpected token in ${PROFILE}`,
  ].join("\n"));
  assert.equal(f.shown.length, 4);
  assert.equal(f.withheld, 1);
  assert.deepEqual(f.hints, ["PARITY CHECK COULD NOT RUN"]);
});

// ------------------------------------------------------------- touch (daily keep-alive)

test("touch: skip without the secret, ok when the database answers, failed:connect with the pause named when it does not — always exit 0", () => {
  const skipped = run(sandbox(), ["touch"], { LI_DSN: "" });
  assert.equal(skipped.code, 0);
  assert.deepEqual(skipped.outputs, { touch: "skipped-no-secret" });
  assert.match(skipped.log, /::warning::database keep-alive SKIPPED/);

  const ok = run(sandbox({ pingJs: 'console.log("ping ok — 12 import run(s) on record");' }), ["touch"], { LI_DSN: DSN });
  assert.equal(ok.code, 0);
  assert.deepEqual(ok.outputs, { touch: "ok" });
  assert.match(ok.log, /ping ok — 12 import run\(s\) on record/);
  assert.doesNotMatch(ok.log, /::warning::/);
  assertNoLeak(ok.log);

  const down = run(sandbox({ pingJs: `console.error("PING FAILED: connection timeout — could not reach the database (details withheld)"); console.error("at ${SECRET_HOST}"); process.exit(1);` }), ["touch"], { LI_DSN: DSN });
  assert.equal(down.code, 0);
  assert.deepEqual(down.outputs, { touch: "failed:connect" });
  assert.match(down.log, /PING FAILED: connection timeout/);
  assert.match(down.log, /::warning::database keep-alive FAILED — the database did not answer\..*Most likely the Supabase project is paused.*Grafana reads this database: while it does not answer, the dashboards are down RIGHT NOW/);
  // Since the panels read the database, "nothing else is affected" is false.
  for (const r of [skipped, down]) assert.doesNotMatch(r.log, /Nothing else is affected/);
  assert.match(skipped.log, /The database was NOT probed today/);
  assertNoLeak(down.log);

  const hung = run(sandbox({ pingJs: "setInterval(() => {}, 1000);" }), ["touch"], { LI_DSN: DSN, DB_CI_TOUCH_CAP_SECS: "1" });
  assert.equal(hung.code, 0);
  assert.deepEqual(hung.outputs, { touch: "timeout:connect" });

  assert.deepEqual(run(sandbox(), ["touch"], { LI_DSN: DSN }).outputs, { touch: "failed:script-missing" });
});

test("a hung database connection is killed at the cap: sync=timeout:import, exit 0", () => {
  const r = run(sandbox({ importJs: "setInterval(() => {}, 1000);" }), ["sync"], { LI_DSN: DSN, DB_CI_IMPORT_CAP_SECS: "1" });
  assert.equal(r.code, 0);
  assert.deepEqual(r.outputs, { sync: "timeout:import" });
  assert.match(r.log, /::warning::database sync FAILED — the import timed out after 1s\..*Most likely the Supabase project is paused/);
});

test("a parity difference is parity=differs with the paths and hashes shown, exit 0", () => {
  const verifyJs = `
    console.log("parity check — clock pinned at 2026-09-21T00:00:00Z");
    console.log("DIFF  peter/stats.json       2 difference(s)");
    console.error("--- peter ---");
    console.error("  peter.engagement_people[3].score  [value]");
    console.error("      json: number len=2 sha1=0a1b2c3d");
    console.error("      db:   number len=2 sha1=4e5f6a7b");
    console.error("  peter.engagement_people[4].${PROFILE}  [value]");
    console.error("      json: ${PERSON}");
    console.error("(values redacted — run with --show-values locally to see them)");
    process.exit(1);`;
  const r = run(sandbox({ verifyJs }), ["sync"], { LI_DSN: DSN });
  assert.equal(r.code, 0);
  assert.deepEqual(r.outputs, { sync: "ok", parity: "differs", feeds: "", feeds_expected: "3" });
  assert.match(r.log, /::warning::database PARITY DIFFERENCE/);
  // The two differences no code change fixes are named where the operator reads first.
  assert.match(r.log, /::warning::database PARITY DIFFERENCE[^\n]*\[feed-absent\] on a dash\.feed_\* view, the schema in the database is older than main[^\n]*\[grant-missing\] means the role Grafana logs in as/);
  assert.match(r.log, /peter\.engagement_people\[3\]\.score {2}\[value\]/);
  assert.match(r.log, /json: number len=2 sha1=0a1b2c3d/);
  assert.match(r.log, /2 line\(s\) withheld/, "a path keyed by a URL and a raw value are withheld");
  assertNoLeak(r.log);
});

test("a parity check that crashes (exit 1, no report) is parity=error, NOT a difference", () => {
  const verifyJs = `console.error("Error: connect ECONNREFUSED ${SECRET_HOST}:5432"); process.exit(1);`;
  const r = run(sandbox({ verifyJs }), ["sync"], { LI_DSN: DSN });
  assert.equal(r.code, 0);
  assert.deepEqual(r.outputs, { sync: "ok", parity: "error", feeds: "", feeds_expected: "3" });
  assert.match(r.log, /::warning::database parity check COULD NOT RUN — it exited 1 without a parity report\. Hints: ECONNREFUSED\. Run pages-deploy to re-sync and re-check .* This week does NOT count as verified\./);
  assertNoLeak(r.log);
});

test("a hung parity check is parity=timeout; the sync it followed stays ok", () => {
  const r = run(sandbox({ verifyJs: "setInterval(() => {}, 1000);" }), ["sync"], { LI_DSN: DSN, DB_CI_VERIFY_CAP_SECS: "1" });
  assert.equal(r.code, 0);
  assert.deepEqual(r.outputs, { sync: "ok", parity: "timeout", feeds: "", feeds_expected: "3" });
});

test("db/ scripts not on main yet is a named failure, not a crash", () => {
  const r = run(sandbox({ importJs: null }), ["sync"], { LI_DSN: DSN });
  assert.equal(r.code, 0);
  assert.deepEqual(r.outputs, { sync: "failed:script-missing" });
  assert.match(r.log, /::warning::database sync FAILED — db\/import\.mjs is missing from main/);
});

test("the DSN is never handed to npm", () => {
  const dir = sandbox();
  writeFileSync(join(dir, "db", "package.json"), JSON.stringify({
    name: "stub", version: "1.0.0", private: true, scripts: { preinstall: "node -e \"require('fs').writeFileSync('leak.txt', process.env.LI_DSN || 'none')\"" },
  }));
  const r = run(dir, ["sync"], { LI_DSN: DSN });
  assert.equal(r.code, 0);
  assert.equal(r.outputs.sync, "ok");
  // --ignore-scripts: the lifecycle script must not even run; if it ever does, it sees no DSN.
  const leak = join(dir, "db", "leak.txt");
  assert.ok(!existsSync(leak) || readFileSync(leak, "utf8") === "none");
});

// ------------------------------------------------------------- dump

const BACKUP_OK = `#!/usr/bin/env bash
echo "backup: pg_dump 17, server 17"
printf '%-34s %10s %10s\\n' "table" "in dump" "in source"
printf '%-34s %10s %10s\\n' "li.post" 67 67
printf '%-34s %10s %10s\\n' "li.person" 429 429
printf '%-34s %10s %10s\\n' "li.week_publication" 12 12
echo "backup: 3 tables, 508 rows, 9 dash views, 12 li functions"
printf -- '-- dump\\n' > "$1"
`;

test("dump: counts are parsed into a commit message carrying the ISO week; nothing else is printed", () => {
  const dir = sandbox({ backupSh: BACKUP_OK });
  const out = join(dir, "linkedin.sql");
  const ci = { LI_BACKUP_DSN: DSN, WEEK: "2026-09-14", GITHUB_SERVER_URL: "https://github.com", GITHUB_REPOSITORY: "speedandfunction/LinkedInStatistic", GITHUB_RUN_ID: "42", GITHUB_WORKFLOW: "linkedin-stats-weekly", GITHUB_EVENT_NAME: "schedule" };
  const r = run(dir, ["dump", out], { ...ci, DB_PARITY: "ok", DB_FEEDS: "4", DB_FEEDS_EXPECTED: "4" });
  assert.equal(r.code, 0);
  assert.deepEqual(r.outputs, { ok: "1" });
  const msg = readFileSync(`${out}.msg`, "utf8");
  // The soak ledger: the subject alone answers "which week, did parity hold, how much data".
  assert.equal(msg, [
    "backup: 2026-W38 (week of 2026-09-14) - parity ok 4/4 - 3 tables, 508 rows",
    "",
    "Sync: ok - main imported and published by db/import.mjs --publish",
    "Parity: ok - 4 of 4 feeds byte-identical between the database export and the JSON build",
    "Via: linkedin-stats-weekly (schedule)",
    "Run: https://github.com/speedandfunction/LinkedInStatistic/actions/runs/42",
    "",
    "li.post              67",
    "li.person            429",
    "li.week_publication  12",
    "",
  ].join("\n"));
  assert.match(r.log, /^commit message: parity ok 4\/4$/m);
  assert.doesNotMatch(r.log, /::warning::/);

  // A week whose parity DIFFERED is still backed up - and the ledger says so.
  const differs = run(dir, ["dump", out], { ...ci, DB_PARITY: "differs", DB_FEEDS: "4", DB_FEEDS_EXPECTED: "4" });
  assert.match(readFileSync(`${out}.msg`, "utf8"), /^backup: 2026-W38 \(week of 2026-09-14\) - parity DIFFERS - 3 tables, 508 rows\n\nSync: ok[^\n]*\nParity: DIFFERS - the database export is NOT byte-identical/);
  assert.deepEqual(differs.outputs, { ok: "1" });
  // A verdict that never arrived is written down as exactly that, and warned about.
  const lost = run(dir, ["dump", out], ci);
  assert.deepEqual(lost.outputs, { ok: "1" }, "a missing verdict does not cost the backup");
  assert.match(readFileSync(`${out}.msg`, "utf8"), /^backup: 2026-W38 \(week of 2026-09-14\) - parity NOT RECORDED - 3 tables, 508 rows\n\nSync: ok[^\n]*\nParity: NOT RECORDED - /);
  assert.match(lost.log, /::warning::database backup: no parity result reached the backup job/);
  assert.match(r.log, /li\.person\s+429\s+429/, "the per-table counts are shown");
  assert.match(r.log, /backup: 3 tables, 508 rows/);
  assert.doesNotMatch(r.log, /withheld/, "every line db/backup.sh prints on success is on the allowlist");
  assertNoLeak(r.log + msg);
});

test("dump: a failing backup.sh is backup=failed:dump, exit 0, and pg_dump's complaint is reduced to a hint", () => {
  const backupSh = `#!/usr/bin/env bash
echo "pg_dump: error: connection to server at \\"${SECRET_HOST}\\" failed: FATAL: password authentication failed for user \\"li_backup\\"" >&2
echo "pg_dump: error: aborting because of server version mismatch" >&2
exit 1
`;
  const dir = sandbox({ backupSh });
  const r = run(dir, ["dump", join(dir, "x.sql")], { LI_BACKUP_DSN: DSN });
  assert.equal(r.code, 0);
  assert.deepEqual(r.outputs, { backup: "failed:dump" });
  assert.match(r.log, /::warning::database backup FAILED — db\/backup\.sh exited 1\. Hints: password authentication failed \| aborting because of server version mismatch\./);
  assertNoLeak(r.log);
});

test("dump: exit 0 without a file, a missing script and a hang are each a named failure", () => {
  const empty = sandbox({ backupSh: "#!/usr/bin/env bash\nexit 0\n" });
  assert.deepEqual(run(empty, ["dump", join(empty, "x.sql")], { LI_BACKUP_DSN: DSN }).outputs, { backup: "failed:dump" });
  const none = sandbox();
  assert.deepEqual(run(none, ["dump", join(none, "x.sql")], { LI_BACKUP_DSN: DSN }).outputs, { backup: "failed:script-missing" });
  const hung = sandbox({ backupSh: "#!/usr/bin/env bash\nsleep 60\n" });
  const r = run(hung, ["dump", join(hung, "x.sql")], { LI_BACKUP_DSN: DSN, DB_CI_DUMP_CAP_SECS: "1" });
  assert.equal(r.code, 0);
  assert.deepEqual(r.outputs, { backup: "timeout:dump" });
});

// ------------------------------------------------------------- pure helpers

test("filterLog shows only allowlisted lines and counts the rest", () => {
  const f = filterLog("import", ["run 1-2", "  post   3 row(s) written", "-- 0 rows written (idempotent re-run: nothing changed)", `hello ${PERSON}`, ""].join("\n"));
  assert.equal(f.shown.length, 3);
  assert.equal(f.withheld, 1);
  assert.deepEqual(filterLog("verify", `  peter.posts[0].title  [value]\n      json: string len=40 sha1=deadbeef\n      json: ${PERSON}`).withheld, 1);
  assert.equal(filterLog("nonsense", "anything").withheld, 1, "an unknown kind shows nothing");
});

test("filterLog shows the FEED PARITY lines an operator needs — and still nothing that carries a value", () => {
  // A key-order difference: the path line used to be withheld ({} was not a path
  // character) while its two digest lines were shown.
  const keys = filterLog("verify", "  andy.feed_posts[0]{keys}  [key-order-or-set]\n      json: string len=61 sha1=0a1b2c3d\n      db:   string len=68 sha1=4e5f6a7b\n  andy.feed_posts[columns]  [key-order-or-set]\n  page.feed_page_monthly[lead]  [key-order-or-set]");
  assert.deepEqual([keys.shown.length, keys.withheld], [5, 0]);
  // grafana_ro lost a privilege: verify.mjs reports it as a difference.
  const grants = filterLog("verify", "--- dash.reader_grants ---\n  schema.dash[usage]  [grant-missing]\n  dash.feed_posts[select]  [grant-missing]\n  li.js_round_double_precision[execute]  [grant-missing]\n  role.grafana_ro  [grant-missing]\n      json: absent\n      db:   absent");
  assert.deepEqual([grants.shown.length, grants.withheld], [7, 0]);
  assert.deepEqual(filterLog("verify", "        sections: views=22 compared=46 rows=6005 reader_grants=27").withheld, 0);
  // Both "did not look" refusals.
  assert.equal(filterLog("verify", "PARITY CHECK COULD NOT RUN: 0 feed views to compare — no feed reached the FEED PARITY block").withheld, 0);
  assert.equal(filterLog("verify", "PARITY CHECK COULD NOT RUN: 0 feeds to compare — no author folder with an account.json under dashboards/li-stats/ and no row in li.author").withheld, 0);
  // safe-log's tail for a 22P02: the value is gone, the reason stays.
  assert.equal(filterLog("verify", "PARITY CHECK COULD NOT RUN: SQLSTATE 22P02 · (pg_strtoint32_safe) — invalid input syntax for type integer: <value withheld>").withheld, 0);
  // …and none of it opens the door to a value.
  for (const line of [
    `  andy.feed_posts[0]{${PERSON}}  [value]`,
    `  ${PROFILE}  [grant-missing]`,
    `PARITY CHECK COULD NOT RUN: 0 feed views to compare — ${PERSON}: see ${PROFILE}`,
    `PARITY CHECK COULD NOT RUN: SQLSTATE 22P02 — invalid input syntax for type integer: "${PERSON}"`,
    `PARITY CHECK COULD NOT RUN: SQLSTATE 22P02 — invalid input syntax: ${PERSON}: <value withheld>`,
    "PARITY CHECK COULD NOT RUN: SQLSTATE 22P02 — invalid input syntax for type integer: 12345",
  ]) assert.equal(filterLog("verify", line).withheld, 1, line);
});

test("classifyParity separates a finding from a broken check, and an earned OK from a vacuous one", () => {
  const counted = (n, m = 0) => `OK  x  byte-identical\n\n-- ${n} feed(s) compared, ${m} differ\n`;
  assert.equal(classifyParity({ code: 0, timedOut: false, output: "" }), "incomplete", "exit 0 alone proves nothing");
  assert.equal(classifyParity({ code: 0, timedOut: false, output: counted(4), expected: 4 }), "ok");
  assert.equal(classifyParity({ code: 0, timedOut: false, output: counted(5), expected: 4 }), "ok");
  assert.equal(classifyParity({ code: 0, timedOut: false, output: counted(3), expected: 4 }), "incomplete");
  assert.equal(classifyParity({ code: 0, timedOut: false, output: counted(0), expected: 0 }), "incomplete", "zero feeds is never parity");
  assert.equal(classifyParity({ code: 0, timedOut: false, output: counted(4, 1), expected: 4 }), "differs", "the report outranks the exit code");
  assert.equal(classifyParity({ code: 1, timedOut: false, output: "DIFF  page-stats.json        1 difference(s)\n" }), "differs");
  assert.equal(classifyParity({ code: 1, timedOut: false, output: "TypeError: x is not a function" }), "error");
  assert.equal(classifyParity({ code: 2, timedOut: false, output: "DIFF  a  1 difference(s)" }), "error");
  assert.equal(classifyParity({ code: null, timedOut: true, output: "" }), "timeout");
});

test("parseRowCounts accepts the plausible layouts and ignores everything else", () => {
  assert.deepEqual(parseRowCounts("table      in dump  in source\nli.post       67         67\nli.person    428        429  <-- DIFFERS\nli.gone  MISSING  3\nbackup: 2 tables, 495 rows"), [
    { table: "li.post", rows: 67 }, { table: "li.person", rows: 428 },
  ], "db/backup.sh layout: the count taken from the dump, not from the source");
  assert.deepEqual(parseRowCounts('li.post 12\nli.person: 3\n"li"."x"=4\ndash.v | 5\nli.comment 6 rows\ntotal 30\nsomething else entirely\n'), [
    { table: "li.post", rows: 12 }, { table: "li.person", rows: 3 }, { table: "dash.v", rows: 5 }, { table: "li.comment", rows: 6 },
  ]);
});

test("isoWeekLabel follows ISO-8601, including the year boundary", () => {
  assert.equal(isoWeekLabel("2026-09-14"), "2026-W38");
  assert.equal(isoWeekLabel("2026-12-28"), "2026-W53");
  assert.equal(isoWeekLabel("2027-01-04"), "2027-W01");
  assert.equal(isoWeekLabel("2024-12-30"), "2025-W01");
  assert.equal(isoWeekLabel("garbage"), null);
  assert.match(commitMessage({ week: "", counts: [] }), /^backup: \d{4}-W\d{2} \(week of \d{4}-\d{2}-\d{2}\) - parity NOT RECORDED - row counts unavailable\n\nSync: ok[^\n]*\nParity: NOT RECORDED[^\n]*\n$/);
});

test("parityRecord and importState speak fixed vocabulary only — whatever arrives from the workflow", () => {
  assert.equal(parityRecord({ parity: "ok", feeds: "4", feedsExpected: "4" }).short, "parity ok 4/4");
  assert.equal(parityRecord({ parity: "incomplete", feeds: "3", feedsExpected: "4" }).line, "Parity: INCOMPLETE - no difference reported, but only 3 of the 4 feeds main publishes were compared. NOT verified");
  assert.equal(parityRecord({ parity: "timeout" }).short, "parity TIMEOUT");
  const hostile = parityRecord({ parity: `ok\n${PERSON}`, feeds: PROFILE, feedsExpected: "4; rm -rf" });
  assert.equal(hostile.state, "unknown");
  assert.doesNotMatch(hostile.short + hostile.line, /Jane|linkedin|rm -rf/);
  assert.equal(parityRecord({ parity: "ok", feeds: PROFILE, feedsExpected: "4" }).short, "parity ok ?/4");
  const viaMsg = commitMessage({ week: "2026-09-14", counts: [], parity: "ok", feeds: "4", feedsExpected: "4", via: `weekly $(curl ${PROFILE})` });
  assert.match(viaMsg, /^Via: weekly \(curl httpswww\.linkedin\.cominjane-thirdparty\)$/m, "via is reduced to word characters — no shell, no URL");
  assert.doesNotMatch(viaMsg, /\$\(|https:/);
  assert.equal(importState({ timedOut: true, output: "" }), "timeout:import");
  assert.equal(importState({ timedOut: false, output: "IMPORT FAILED — could not connect: ETIMEDOUT (connect) — could not reach the database (details withheld)" }), "failed:connect");
  assert.equal(importState({ timedOut: false, output: "IMPORT FAILED — rolled back, nothing changed: SQLSTATE 42501" }), "failed:import");
});
