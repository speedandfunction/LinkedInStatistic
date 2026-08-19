#!/usr/bin/env node
// Company-Page phase for the linkedin-stats pipeline.
//
// The personal-profile phases (scrape-weekly.mjs) read obfuscated analytics
// pages by parsing main.innerText. The Page admin analytics are different: they
// ship a first-party **XLS export** (Visitors / Followers / Content) that
// carries the full DAILY series plus a 12-month demographic snapshot — richer
// and far more stable than scraping the rendered charts. So this phase drives
// the three Export buttons, captures each download through Playwright's
// download API (reliable, unlike a headless "click and hope"), and hands the
// three .xls files to parse-page-xls.py, which aggregates them to a monthly
// JSON verified against LinkedIn's own on-screen highlights.
//
// Requires: a Chrome profile already logged into LinkedIn with ADMIN or
// ANALYST access to the page named by config.company_id. Same persistent
// profile the rest of the pipeline uses. No credentials are ever handled here.
//
// Usage:
//   node scrape-page.mjs [--months=6] [--headful] [--keep-xls] [--out=path.json]
//
// Exit codes (aligned with scrape-weekly.mjs):
//   0  ok    20 auth wall    21 profile busy    23 fs/parse    30 selector drift
//
// NOTE: the export click-path (open dialog -> Time range -> "Last 365 days" ->
// Update -> reopen Export -> Export) was captured live 2026-08-19. LinkedIn
// moves this UI; if a selector below stops matching, the run exits 30 and the
// heal loop / a human re-captures the flow. The XLS *contents* are parsed by
// column NAME in parse-page-xls.py, so column reshuffles do not reach here.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..', '..', '..', '..');
const CONFIG = JSON.parse(fs.readFileSync(path.join(SCRIPT_DIR, '..', '..', 'config.json'), 'utf8'));
const COMPANY_ID = String(CONFIG.company_id || '').trim();

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? true] : [a, true];
}));
const MONTHS = parseInt(args.months || '6', 10);
const HEADFUL = !!args.headful;
const KEEP_XLS = !!args['keep-xls'];
const OUT_FILE = args.out
  ? path.resolve(String(args.out))
  : path.join(REPO_ROOT, 'dashboards', 'li-stats', 'page', 'monthly.json');
const USER_DATA_DIR = process.env.LI_CHROME_PROFILE_DIR || path.join(
  os.homedir(), 'Library', 'Caches', 'ms-playwright', 'mcp-chrome-linkedin-stats');
const PARSER = path.join(SCRIPT_DIR, 'parse-page-xls.py');

const t0 = Date.now();
const log = (...m) => console.error(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The three admin surfaces -> the export filename the parser expects.
const SURFACES = [
  { key: 'visitors', url: `https://www.linkedin.com/company/${COMPANY_ID}/admin/analytics/visitors/` },
  { key: 'followers', url: `https://www.linkedin.com/company/${COMPANY_ID}/admin/analytics/followers/` },
  { key: 'content', url: `https://www.linkedin.com/company/${COMPANY_ID}/admin/analytics/updates/` },
];

function die(code, msg) { log(msg); process.exit(code); }

async function exportOneSurface(page, surface, xlsDir) {
  await page.goto(surface.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  if (/\/authwall|\/uas\/login|\/checkpoint/.test(page.url())) die(20, `auth wall on ${surface.key}`);
  await page.waitForTimeout(2500);

  const exportBtn = page.getByRole('button', { name: 'Export', exact: true });
  if (!(await exportBtn.count())) die(30, `no Export button on ${surface.key}`);

  // 1) open dialog, 2) set the time range to the last 365 days, which closes
  //    the dialog, 3) reopen it (the range is now remembered), 4) Export.
  await exportBtn.first().click();
  await page.waitForTimeout(800);
  const timeRange = page.getByRole('button', { name: /^Time range/ });
  if (!(await timeRange.count())) die(30, `no Time range control on ${surface.key}`);
  await timeRange.first().click();
  await page.waitForTimeout(500);
  const preset = page.getByText('Last 365 days', { exact: true });
  if (!(await preset.count())) die(30, `no "Last 365 days" preset on ${surface.key}`);
  await preset.first().click();
  await page.getByRole('button', { name: 'Update', exact: true }).first().click();
  await page.waitForTimeout(800);

  // reopen — range now reads "... - ..." (365d) and Export is the primary action
  await exportBtn.first().click();
  await page.waitForTimeout(600);

  const dest = path.join(xlsDir, `${surface.key}.xls`);
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 60000 }).catch(() => null),
    page.getByRole('button', { name: 'Export', exact: true }).last().click(),
  ]);
  if (!download) die(30, `export download never fired on ${surface.key}`);
  await download.saveAs(dest);
  const size = fs.statSync(dest).size;
  // OLE2 signature — a login/HTML page saved as .xls would fail the parser later
  const sig = fs.readFileSync(dest).subarray(0, 4);
  if (!(sig[0] === 0xd0 && sig[1] === 0xcf)) die(20, `${surface.key}.xls is not an XLS (auth/HTML?)`);
  log(`${surface.key}: exported ${size} bytes`);
  await page.waitForTimeout(500);
}

async function main() {
  if (!/^\d+$/.test(COMPANY_ID)) die(23, `config.company_id must be the numeric Page id, got "${COMPANY_ID}"`);
  const xlsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'li-page-'));
  let context;
  try {
    context = await chromium.launchPersistentContext(USER_DATA_DIR, {
      channel: 'chrome', headless: !HEADFUL, acceptDownloads: true, timeout: 60000,
    });
  } catch (e) {
    if (/ProcessSingleton|SingletonLock|already running/i.test(String(e))) die(21, 'profile busy (another Chrome owns it)');
    die(23, `launch failed: ${e}`);
  }
  const page = context.pages()[0] || await context.newPage();
  try {
    for (const s of SURFACES) await exportOneSurface(page, s, xlsDir);
  } finally {
    await context.close().catch(() => {});
  }

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  const py = spawnSync('python3', [PARSER, xlsDir, OUT_FILE, `--months=${MONTHS}`], { encoding: 'utf8' });
  if (py.stderr) process.stderr.write(py.stderr);
  if (py.status !== 0) die(23, `parser failed (exit ${py.status})`);
  if (!KEEP_XLS) fs.rmSync(xlsDir, { recursive: true, force: true });

  const data = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8'));
  log(`done — ${Object.keys(data.months).length} months -> ${OUT_FILE}`);
  process.exit(0);
}

main().catch((e) => die(23, `unexpected: ${e && e.stack || e}`));
