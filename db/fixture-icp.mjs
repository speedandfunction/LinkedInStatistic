#!/usr/bin/env node
// The ICP / VIP branch of the parity proof.
//
// The real corpus cannot test it. All 720 profile files carry `icp: null` — the
// classifier has never run on this data — and vip-people.md is empty. So in a
// parity run against the real corpus every person is `normal`, score_icp and
// score_vip are 0 in every row, and the ICP share columns are 0 everywhere:
// roughly 5% of the compared leaves are equal only because BOTH sides are
// degenerate. dash.engagement_person's ICP join, the tier resolution and
// scoring.json's `precedence: max` rule for a person who is both VIP and ICP are
// simply never exercised.
//
// This builds a small synthetic corpus that does exercise them — ICP true, ICP
// false, VIP-only, and the both-tiers precedence case — imports it into a
// SEPARATE database, and runs the same parity check against it.
//
//   node db/fixture-icp.mjs [--dir <path>] [--dsn <url>] [--keep]
//
// Nothing here touches the real corpus or the real database.

import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import pg from "pg";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");

function arg(name, def = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")
    ? process.argv[i + 1] : def;
}
const flag = (n) => process.argv.includes(`--${n}`);

const AUTHOR = arg("author", "maria");          // the smallest folder in the corpus
const DIR = resolve(arg("dir", join(tmpdir(), "li-icp-fixture")));
const DSN = arg("dsn", process.env.LI_FIXTURE_DSN
  || "postgresql://postgres:devpw@localhost:55432/linkedin_fixture");

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

// ------------------------------------------------------------ the corpus

rmSync(DIR, { recursive: true, force: true });
mkdirSync(join(DIR, "dashboards", "li-stats"), { recursive: true });
mkdirSync(join(DIR, ".claude", "skills", "linkedin-stats"), { recursive: true });
cpSync(join(REPO, "dashboards", "li-stats", AUTHOR), join(DIR, "dashboards", "li-stats", AUTHOR),
  { recursive: true });
cpSync(join(REPO, ".claude", "skills", "linkedin-stats", "scoring.json"),
  join(DIR, ".claude", "skills", "linkedin-stats", "scoring.json"));

// One author only, so the fixture import reads nothing else.
const identity = readJson(join(REPO, ".claude", "skills", "linkedin-stats", "profiles.json"));
writeFileSync(join(DIR, ".claude", "skills", "linkedin-stats", "profiles.json"),
  JSON.stringify({ [AUTHOR]: identity[AUTHOR] }, null, 2));

// Verdicts. Deliberately spread over four cases, and with DIFFERENT
// classified_at values per person: a batch stamped with one instant is a bug
// this fixture is also here to catch.
const engPath = join(DIR, "dashboards", "li-stats", AUTHOR, "engagement.json");
const eng = readJson(engPath);
// Prefer people with a DATED, non-backfill event: those are the ones that reach
// dash.engagement_score_week, so picking them is what makes the weekly score_icp
// and score_vip columns non-zero rather than trivially equal on both sides.
const weekly = new Set(Object.values(eng.events)
  .filter((e) => e.attributed_week && !e.backfill).map((e) => e.person_key));
const byWeekly = (a, b) => (weekly.has(b) ? 1 : 0) - (weekly.has(a) ? 1 : 0);
const inKeys = Object.keys(eng.people).filter((k) => k.startsWith("in/")).sort().sort(byWeekly);
if (inKeys.length < 6) { console.error(`${AUTHOR}: not enough people to build the fixture`); process.exit(2); }

const icpTrue = inKeys.slice(0, 4);     // plain ICP
const icpFalse = inKeys.slice(4, 6);    // judged and rejected — must NOT score as ICP
const vipOnly = inKeys[6] ?? inKeys[5];   // hand-curated, no verdict
const both = icpTrue[0];                  // VIP *and* ICP — the precedence case

const verdict = (key, v, i) => {
  eng.people[key].icp = {
    verdict: v, reason: v ? "fixture: matches the ICP rubric" : "fixture: out of profile",
    model: "fixture-model",
    classified_at: `2026-0${1 + (i % 8)}-1${i % 9}T0${i % 9}:00:00Z`,
    headline_hash: `hash${i}`,
  };
};
icpTrue.forEach((k, i) => verdict(k, true, i));
icpFalse.forEach((k, i) => verdict(k, false, i + 4));
writeFileSync(engPath, JSON.stringify(eng, null, 2));

// The VIP list, in the format build-stats-json.mjs parses (bullets, real URLs).
const slug = (k) => k.slice(3);
writeFileSync(join(DIR, ".claude", "skills", "linkedin-stats", "vip-people.md"),
`# VIP people — the 4x engagement tier (FIXTURE)

- https://www.linkedin.com/in/${slug(vipOnly)} — VIP only: no ICP verdict at all
- https://www.linkedin.com/in/${slug(both)} — VIP *and* ICP: the precedence case
`);

// A couple of profile-cache files with a real verdict block, so li.upsert_profile
// is exercised on something other than \`icp: null\`.
const profSrc = join(REPO, "dashboards", "profiles");
if (existsSync(profSrc)) {
  const dst = join(DIR, "dashboards", "profiles");
  mkdirSync(dst, { recursive: true });
  const some = (await import("node:fs")).readdirSync(profSrc).filter((f) => f.endsWith(".json")).sort().slice(0, 5);
  for (const f of some) {
    const p = readJson(join(profSrc, f));
    p.scraped_at = "2026-09-01T00:00:00Z";
    p.profile_text = "fixture profile text";
    p.icp = { verdict: true, confidence: "high", reason: "fixture", evidence: "profile",
              model: "fixture-model", rubric_hash: "rh-fixture",
              headline_hash: p.headline_hash ?? null, decided_at: "2026-09-01T00:00:00Z" };
    writeFileSync(join(dst, f), JSON.stringify(p, null, 2));
  }
}

console.error(`fixture corpus: ${DIR}`);
console.error(`  icp=true ${icpTrue.length}  icp=false ${icpFalse.length}  vip 2 (one of them also icp)`);

// ---------------------------------------------------------- the database

const admin = new pg.Client({ connectionString: DSN.replace(/\/[^/]*$/, "/postgres") });
await admin.connect();
const dbName = DSN.split("/").pop();
await admin.query(`drop database if exists ${dbName} with (force)`);
await admin.query(`create database ${dbName}`);
await admin.end();

const c = new pg.Client({ connectionString: DSN });
await c.connect();
// psql meta-commands are not SQL; everything else in schema.sql is.
await c.query(readFileSync(join(HERE, "schema.sql"), "utf8")
  .split("\n").filter((l) => !l.startsWith("\\")).join("\n"));
await c.end();
console.error(`fixture database: ${dbName}`);

// ------------------------------------------------------------- the proof

const node = (script, args) => {
  const r = spawnSync("node", [join(HERE, script), ...args], { cwd: REPO, encoding: "utf8", stdio: "inherit" });
  return r.status ?? 1;
};

let status = node("import.mjs", ["--dsn", DSN, "--repo", DIR, "--publish"]);
if (status !== 0) { console.error("fixture import failed"); process.exit(status); }

// Same clock rule as a normal run: pinned, and the same instant on both sides.
status = node("verify.mjs", ["--dsn", DSN, "--repo", DIR, "--no-page"]);

if (!flag("keep")) rmSync(DIR, { recursive: true, force: true });
process.exit(status);
