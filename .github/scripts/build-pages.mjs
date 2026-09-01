#!/usr/bin/env node
// Багатопрофільний білд для GitHub Pages.
//
// Для КОЖНОЇ папки автора dashboards/li-stats/<author>/ (де є account.json)
// будує pages-dist/<author>/stats.json через build-stats-json.mjs. Плюс один
// спільний pages-dist/page-stats.json (дані сторінки компанії).
//
// Grafana-дашборд кожного автора читає свій URL:
//   https://<pages>/LinkedInStatistic/<author>/stats.json
//
// Кількість авторів не зашита ніде — усе з наявних папок.
//
//   node .github/scripts/build-pages.mjs [--out-dir pages-dist]
import { readdirSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const LI_STATS = join(REPO_ROOT, "dashboards", "li-stats");

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const OUT_DIR = resolve(arg("out-dir", join(REPO_ROOT, "pages-dist")));

// Автор = підпапка li-stats з account.json (page/ і posts/ — не автори).
function authors() {
  return readdirSync(LI_STATS, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((name) => existsSync(join(LI_STATS, name, "account.json")))
    .sort();
}

function run(script, args) {
  const r = spawnSync("node", [join(HERE, script), ...args], {
    stdio: "inherit",
    cwd: REPO_ROOT,
  });
  if (r.status !== 0) {
    console.error(`FAILED: ${script} ${args.join(" ")}`);
    process.exit(r.status || 1);
  }
}

const list = authors();
if (list.length === 0) {
  console.error("no author folders with account.json under dashboards/li-stats/");
  process.exit(1);
}
mkdirSync(OUT_DIR, { recursive: true });

for (const author of list) {
  const outDir = join(OUT_DIR, author);
  mkdirSync(outDir, { recursive: true });
  console.log(`\n== ${author} ==`);
  run("build-stats-json.mjs", [
    "--li-stats", join(LI_STATS, author),
    "--out", join(outDir, "stats.json"),
  ]);
}

// Спільна сторінка компанії (одна на всіх).
console.log("\n== page-stats (shared) ==");
run("build-page-stats.mjs", ["--out", join(OUT_DIR, "page-stats.json")]);

console.log(`\nbuilt ${list.length} author feed(s): ${list.join(", ")}`);
