#!/usr/bin/env node
// Deterministic fast path for the linkedin-stats skill.
//
// Replaces the LLM-in-the-loop scraping (one sonnet agent per post, sequential,
// multi-hour) with a single Node process driving the SAME logged-in Chrome
// profile the Playwright MCP uses. All selectors, regexes, wait rules, JSON
// shapes and merge semantics are ported verbatim from the agent specs:
//   .claude/agents/linkedin-stats-gather-posts.md
//   .claude/agents/linkedin-stats-gather-metrics.md   (+ .scrape-comments.js)
//   .claude/agents/linkedin-stats-gather-account.md
//   .claude/agents/linkedin-stats-gather-comments-out.md (+ .scrape.js)
// The two canonical scrape bodies are read from the agent .js files at runtime
// so there is exactly one source of truth shared with the (fallback) agents.
// ALL dashboards/li-stats writes go through merge.py — Python serialization
// round-trips existing files byte-for-byte where JSON.stringify does not
// (historical float lexemes like 50.0).
//
// Phase order: posts (discovery) -> account (alone — its audience rendering
// proved contention-sensitive, see doc/incidents/2026-07-20) -> metrics ∥
// comments-out (comments only after account succeeded — mirrors the skill's
// "step 3 ERROR stops step 4").
// Global pacing: max 3 navigations in flight, 750-1250ms between navigation
// starts across ALL tabs, circuit-break on 429 / navigation 403 / checkpoint.
//
// Usage:
//   node scrape-weekly.mjs [--phases=posts,metrics,account,comments]
//                          [--concurrency=3] [--posts-limit=N]
//                          [--post-file=path.json[,path2.json]]
//                          [--week=YYYY-MM-DD] [--cutoff-override=YYYY-MM-DD]
//                          [--headless] [--block-assets] [--verbose]
//
// Exit codes:
//   0  complete
//   10 partial per-post/page failures; outputs valid
//   20 auth/checkpoint wall
//   21 profile busy (another Chrome owns the profile)
//   22 network/rate-limited (circuit breaker tripped)
//   23 filesystem/merge failure
//   30 fast-path selector/compat failure (canary died) — fallback-eligible

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import * as People from './people.mjs';
import { classifyPeople, headlineHash, loadIcpText, needsClassification } from './classify-icp.mjs';
import { openProfileStore, profileKey } from '../../pipeline-shared/profile-store.mjs';
import { openBrowserbaseSession } from './browserbase-backend.mjs';

// ---------------------------------------------------------------- constants

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..', '..', '..');
const earlyArgs = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? true] : [a, true];
}));
// ---- Багатопрофільність: ідентичність і каталог даних на кожного автора ----
// LI_AUTHOR вибирає одну особу; її profile_slug/company_id/cutoff беруться з
// profiles.json (ключ = автор), із фолбеком на config.json для старого
// однокористувацького режиму. Кожен автор пише у власну папку
// dashboards/li-stats/<author>/ — будь-яка кількість профілів збирається
// незалежно, не затираючи одне одного.
const AUTHOR = String(process.env.LI_AUTHOR || '').trim();
const PROFILES_FILE = path.join(SCRIPT_DIR, '..', 'profiles.json');
function loadIdentity() {
  if (AUTHOR) {
    try {
      const profiles = JSON.parse(fs.readFileSync(PROFILES_FILE, 'utf8'));
      if (profiles[AUTHOR]) return profiles[AUTHOR];
      console.error(`profiles.json: немає автора "${AUTHOR}" — додай його або прибери LI_AUTHOR`);
      process.exit(23);
    } catch (e) {
      if (e && e.code !== 'ENOENT') throw e;
      // profiles.json немає — падаємо на config.json (сумісність)
    }
  }
  return JSON.parse(fs.readFileSync(path.join(SCRIPT_DIR, '..', 'config.json'), 'utf8'));
}
const CONFIG = loadIdentity();
const PROFILE_SLUG = String(CONFIG.profile_slug || '').replace(/^\/+|\/+$/g, '');
if (!/^in\/[^/]+$/.test(PROFILE_SLUG)) {
  console.error(`profile_slug must look like "in/<slug>", got "${PROFILE_SLUG}" (author=${AUTHOR || '-'})`);
  process.exit(23);
}
if (/REPLACE-WITH-YOUR-SLUG/i.test(PROFILE_SLUG)) {
  console.error('profile_slug is still the placeholder — set it in profiles.json or config.json.');
  process.exit(23);
}

// Каталог даних: --data-root має пріоритет; далі папка автора; далі старий
// спільний корінь (сумісність / однокористувацький режим).
const DATA_ROOT = earlyArgs['data-root']
  ? path.resolve(String(earlyArgs['data-root']))
  : (AUTHOR
      ? path.join(REPO_ROOT, 'dashboards', 'li-stats', AUTHOR)
      : path.join(REPO_ROOT, 'dashboards', 'li-stats'));
const POSTS_DIR = path.join(DATA_ROOT, 'posts');
fs.mkdirSync(POSTS_DIR, { recursive: true }); // папка автора створюється сама
const ACCOUNT_FILE = path.join(DATA_ROOT, 'account.json');
const COMMENTS_FILE = path.join(DATA_ROOT, 'comments.json');
const ENGAGEMENT_FILE = path.join(DATA_ROOT, 'engagement.json');
// One file per person, SHARED with linkedin-comment-hourly. A --data-root run
// sandboxes it too, so a probe never writes tracked profile files.
const PROFILES_DIR = earlyArgs['profiles-dir']
  ? path.resolve(String(earlyArgs['profiles-dir']))
  : (earlyArgs['data-root']
    ? path.join(DATA_ROOT, 'profiles')
    : path.join(REPO_ROOT, 'dashboards', 'profiles'));
const ICP_FILE = path.join(REPO_ROOT, 'sources', 'icp.md');
const AGENTS_DIR = path.join(REPO_ROOT, '.claude', 'agents');
const MERGE_PY = path.join(SCRIPT_DIR, 'merge.py');
const MANIFEST_FILE = path.join(REPO_ROOT, 'tmp', 'fast-scrape-manifest.json');
// LI_CHROME_PROFILE_DIR overrides the macOS default (Linux runners, sandboxes).
const USER_DATA_DIR = process.env.LI_CHROME_PROFILE_DIR || path.join(
  process.env.HOME, 'Library', 'Caches', 'ms-playwright', 'mcp-chrome-linkedin-stats');

const PROFILE_FRAG = `/${PROFILE_SLUG}`;
const PROFILE_URL = `https://www.linkedin.com/${PROFILE_SLUG}/recent-activity/all/`;
const COMMENTS_URL = `https://www.linkedin.com/${PROFILE_SLUG}/recent-activity/comments/`;
const DEFAULT_CUTOFF = CONFIG.posts_cutoff || '2026-01-01';
const POST_SUMMARY_URL = (urn) => `https://www.linkedin.com/analytics/post-summary/${urn}/`;
const DEMO_URL = (urn) => `https://www.linkedin.com/analytics/demographic-detail/${urn}/?metricType=IMPRESSIONS`;
const DASHBOARD_URL = 'https://www.linkedin.com/dashboard/';
const CONTENT_URL = 'https://www.linkedin.com/analytics/creator/content/?metricType=IMPRESSIONS&timeRange=past_7_days';
const AUDIENCE_URL = 'https://www.linkedin.com/analytics/creator/audience/';
const SEARCH_URL = 'https://www.linkedin.com/analytics/search-appearances/';
const PROFILE_VIEWS_URL = 'https://www.linkedin.com/analytics/profile-views/';

// ---------------------------------------------------------------- cli args

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? true] : [a, true];
}));
const PHASES = String(args.phases || 'posts,metrics,account,comments,people').split(',');
// `people` phase knobs. The caps bound the extra navigations (public bucket,
// 700-900ms apart) so the phase cannot eat the 429 budget the analytics
// surfaces depend on; whatever they drop is reported, never silently skipped.
const PEOPLE_MAX_POSTS = Math.max(0, parseInt(args['people-max-posts'] || '25', 10));
const PEOPLE_MAX_COMMENTS = Math.max(0, parseInt(args['people-max-comments'] || '25', 10));
const PEOPLE_RECENT_DAYS = Math.max(1, parseInt(args['people-recent-days'] || '30', 10));
// Scope the phase to the recency window only, dropping the never-scanned
// backlog. Used by the one-off roster backfill so "the last 30 days" does not
// drag in the whole back catalogue as baselines.
const PEOPLE_RECENT_ONLY = !!args['people-recent-only'];
const NO_ICP = !!args['no-icp'];
const ICP_MAX = Math.max(0, parseInt(args['icp-max'] || '200', 10));
const CONCURRENCY = Math.max(1, parseInt(args.concurrency || '3', 10));
const POSTS_LIMIT = args['posts-limit'] ? parseInt(args['posts-limit'], 10) : Infinity;
const POST_FILES_ONLY = args['post-file'] ? String(args['post-file']).split(',') : null;
const HEADLESS = !!args.headless;
const BLOCK_ASSETS = !!args['block-assets']; // opt-in: routing disables HTTP cache
const VERBOSE = !!args.verbose;
// Wall-clock guard for unattended runs: when it fires, in-flight work stops
// scheduling (breaker), completed per-post merges are already on disk, and
// the run exits 10 (partial) instead of wedging the cron slot.
const DEADLINE_SECS = args['deadline-secs'] ? parseInt(args['deadline-secs'], 10) : 0;

// ---------------------------------------------------------------- utilities

const t0 = Date.now();
const log = (...m) => console.error(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...m);
const vlog = (...m) => { if (VERBOSE) log(...m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stripCommas = (s) => (s || '').replace(/,/g, '');
const int0 = (m) => (m ? parseInt(stripCommas(m[1]), 10) : 0);
const float0 = (m) => (m ? parseFloat(m[1]) : null);

function isoWeekMonday(d = new Date()) {
  const day = (d.getUTCDay() + 6) % 7; // Mon=0
  const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day));
  return m.toISOString().slice(0, 10);
}
const WEEK = String(args.week || isoWeekMonday());
if (!/^\d{4}-\d{2}-\d{2}$/.test(WEEK)) { console.log('ERROR=UNKNOWN'); process.exit(4); }

const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const msToIso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

// page.evaluate(string) treats the string as an EXPRESSION — an arrow-function
// string evaluates to the function object (serializes to undefined) instead of
// being invoked. Compile evaluator sources to real functions once, up front;
// playwright then serializes fn.toString() and invokes it in the page.
const asFn = (src) => new Function(`return (${src})`)();

// All dashboards/li-stats writes go through merge.py (byte-parity with the
// agents' Python heredocs). Throws with reason FS on failure.
function mergeViaPython(payload) {
  const res = spawnSync('python3', [MERGE_PY], {
    input: JSON.stringify(payload), encoding: 'utf8', timeout: 30000,
  });
  if (res.status !== 0) {
    throw Object.assign(
      new Error(`merge.py ${payload.mode} failed: ${res.stderr || res.stdout}`),
      { reason: 'FS' });
  }
  return res.stdout.trim();
}

// Canonical scrape bodies (shared with the agent fallback path). Each file is
// a comment block followed by a single arrow function; playwright invokes a
// function-expression string.
function loadCanonicalScrape(name) {
  const src = fs.readFileSync(path.join(AGENTS_DIR, name), 'utf8');
  // Drop the leading "//" comment block FIRST — the header prose itself can
  // contain the literal "() => {" — then take everything from the arrow on.
  const body = src.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  // Matches both `() => {` and a parameterised `(PROFILE_FRAG) => {`.
  const i = body.search(/\([A-Za-z0-9_$,\s]*\)\s*=>\s*\{/);
  if (i < 0) throw new Error(`no arrow function found in ${name}`);
  return body.slice(i);
}
const SCRAPE_POST_COMMENTS = asFn(loadCanonicalScrape('linkedin-stats-gather-metrics.scrape-comments.js'));
const SCRAPE_COMMENTS_OUT = asFn(loadCanonicalScrape('linkedin-stats-gather-comments-out.scrape.js'));

/**
 * Expand and read the top-level comments on a post page that is ALREADY open.
 *
 * Shared by the metrics phase (which navigates to the public post for the text
 * backfill) and the people phase (which navigates to the same page for the
 * reaction overlay). The people phase harvesting its own commenters is what
 * decouples the roster from the metrics phase — on 2026-08-17 that phase
 * returned zero comments for all 50 posts while the analytics counters said
 * otherwise, and the roster must not inherit that.
 */
async function loadAndScrapePostComments(page) {
  // Load more comments until the button disappears (cap 30 clicks / 200 comments)
  for (let i = 0; i < 30; i++) {
    const before = await page.evaluate(TOP_LEVEL_COMMENT_COUNT);
    const clicked = await page.evaluate(LOAD_MORE_COMMENTS_CLICK);
    if (clicked === 'no-button') break;
    await page.waitForFunction(
      (prev) => Array.from(document.querySelectorAll('article.comments-comment-entity'))
        .filter((a) => !a.closest('.comments-replies-list, .comments-comment-replies'))
        .length > prev,
      before, { timeout: 4000 },
    ).catch(() => {});
    const after = await page.evaluate(TOP_LEVEL_COMMENT_COUNT);
    if (after >= 200) break;
    if (after === before) await sleep(800);
  }
  const expanded = await page.evaluate(SEE_MORE_EXPAND);
  if (expanded > 0) await sleep(800);
  const out = await page.evaluate(SCRAPE_POST_COMMENTS);
  return Array.isArray(out) ? out : [];
}

class AuthError extends Error {}
class BreakerError extends Error {}
class RateLimitError extends Error {}

// ------------------------------------------------ line-anchored text parsing
// 2026-07: LinkedIn migrated the analytics surfaces (post-summary,
// demographic-detail, dashboard, creator content/audience) to obfuscated CSS
// classes — the semantic artdeco/member-analytics selectors from the agent
// specs match NOTHING there. innerText, however, is stable and cleanly
// line-structured, so all analytics parsing anchors on exact label lines.
// (The two activity feeds and the public post page still have semantic
// classes — those scrapers stay selector-based.)

const NUM_LINE = /^\d[\d,]*$/;
const PCT_LINE = /^[-−]?\d+(?:\.\d+)?%$/; // − = U+2212, seen on delta chips

const linesOf = (txt) => txt.split('\n').map((s) => s.trim()).filter(Boolean);

function findLineIdx(lines, re, from = 0, to = lines.length) {
  for (let i = from; i < Math.min(to, lines.length); i++) if (re.test(lines[i])) return i;
  return -1;
}
// nearest bare-number line above/below a label line (window 3)
function numBefore(lines, i, win = 3) {
  for (let j = i - 1; j >= Math.max(0, i - win); j--) {
    if (NUM_LINE.test(lines[j])) return parseInt(lines[j].replace(/,/g, ''), 10);
  }
  return null;
}
function numAfter(lines, i, win = 3) {
  for (let j = i + 1; j <= Math.min(lines.length - 1, i + win); j++) {
    if (NUM_LINE.test(lines[j])) return parseInt(lines[j].replace(/,/g, ''), 10);
  }
  return null;
}
function pctAfter(lines, i, win = 2) {
  for (let j = i + 1; j <= Math.min(lines.length - 1, i + win); j++) {
    if (PCT_LINE.test(lines[j])) return parseFloat(lines[j].replace('−', '-'));
  }
  return null;
}

const MAIN_INNER_TEXT = asFn(`() => (document.querySelector('main') || document.body).innerText`);

// ------------------------------------------------- global navigation pacing
// LinkedIn rate-limits the /analytics/ surface hard (empirically: ~35 page
// loads/min across analytics endpoints earned a 429 mid-run). Pacing is
// therefore bucketed per endpoint class, with demographic-detail (the
// endpoint that actually threw the 429) slowest. A 429 triggers a global
// cool-down + retry rather than a hard abort; only repeated trips abort.

let breakerTripped = null; // string reason once tripped
let cooldownUntil = 0;
let rateTrips = 0;
let lastTripAt = 0;

function noteRateLimit(where, retryAfterSec = 0) {
  const now = Date.now();
  const inEpisode = now < cooldownUntil;
  // A longer Retry-After extends the current episode even when it doesn't
  // count as a new trip.
  if (retryAfterSec > 0) cooldownUntil = Math.max(cooldownUntil, now + retryAfterSec * 1000);
  if (inEpisode || breakerTripped) return; // same episode / already aborting
  lastTripAt = now;
  rateTrips++;
  if (rateTrips > 3) {
    breakerTripped = `repeated 429s (${where})`;
    return;
  }
  const coolMs = Math.max(90000 * 2 ** (rateTrips - 1), retryAfterSec * 1000); // 90s, 180s, 360s
  cooldownUntil = now + coolMs;
  // Permanently slow the analytics bucket after the first episode — the
  // remaining run should not re-approach the limit that just tripped.
  if (rateTrips === 1) PACE_BUCKETS[0].gapMs = PACE_BUCKETS[0].gapMs.map((g) => Math.round(g * 1.5));
  log(`rate-limited (${where}) — cooling down ${coolMs / 1000}s (episode ${rateTrips}/3)`);
}

// Deadline-aware cool-down wait: never sleeps past a tripped breaker.
async function sleepThroughCooldown() {
  while (Date.now() < cooldownUntil) {
    if (breakerTripped) throw new BreakerError(breakerTripped);
    await sleep(Math.min(cooldownUntil - Date.now() + 100, 5000));
  }
}

// One bucket for the WHOLE analytics surface: the observed 429 fired at an
// aggregate ~32 analytics loads/min across endpoints, so the budget must be
// shared, not per-endpoint. ~2.6s avg gap ≈ 23/min keeps a safety margin.
const PACE_BUCKETS = [
  { name: 'analytics', re: /\/analytics\/|\/dashboard\//, gapMs: [2400, 2800] },
  { name: 'public', re: /./, gapMs: [700, 900] },
];
const paceState = PACE_BUCKETS.map(() => ({ last: 0, chain: Promise.resolve() }));

let navInFlight = 0;
const navWaiters = [];
function acquireNavSlot() {
  return new Promise((resolve) => {
    const tryAcquire = () => {
      if (navInFlight < 3) { navInFlight++; resolve(); } else navWaiters.push(tryAcquire);
    };
    tryAcquire();
  });
}
function releaseNavSlot() {
  navInFlight--;
  const next = navWaiters.shift();
  if (next) next();
}

function paceGap(url) {
  const i = PACE_BUCKETS.findIndex((b) => b.re.test(url));
  const st = paceState[i];
  const [lo, hi] = PACE_BUCKETS[i].gapMs;
  const p = st.chain.then(async () => {
    for (;;) {
      const gap = lo + Math.random() * (hi - lo);
      const wait = Math.max(st.last + gap, cooldownUntil) - Date.now();
      if (wait <= 0) break;
      await sleep(Math.min(wait, 5000));
      if (breakerTripped) throw new BreakerError(breakerTripped);
    }
    st.last = Date.now();
  });
  st.chain = p.catch(() => {});
  return p;
}

async function checkAuth(page) {
  const u = page.url();
  if (/\/login|\/checkpoint|\/authwall|\/uas\//.test(u)) throw new AuthError(u);
}

// Every navigation in the run goes through here: breaker check, global gap,
// in-flight cap, auth check, optional text-marker settle.
async function pacedGoto(page, url, marker, { markerTimeout = 10000 } = {}) {
  if (breakerTripped) throw new BreakerError(breakerTripped);
  await paceGap(url);
  await acquireNavSlot();
  try {
    // 90s: under the GH runner navigations have been observed ~20x slower
    // than interactive (2026-07-20 incident, cause unproven) — patience per
    // nav costs nothing against the 429 budget, giving up costs the week.
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
    if (resp && resp.status() === 429) {
      noteRateLimit(url);
      throw new RateLimitError(url);
    }
    if (resp && resp.status() === 403) {
      breakerTripped = `403 on ${url}`;
      throw new BreakerError(breakerTripped);
    }
  } catch (e) {
    // A 429 document response surfaces as this net error, not a Response.
    if (/ERR_HTTP_RESPONSE_CODE_FAILURE/.test(String(e.message))) {
      noteRateLimit(url);
      throw new RateLimitError(url);
    }
    throw e;
  } finally {
    releaseNavSlot();
  }
  await checkAuth(page);
  if (marker) {
    await page.waitForFunction(
      (re) => new RegExp(re, 'i').test(document.body ? document.body.innerText : ''),
      marker, { timeout: markerTimeout },
    ).catch(() => {});
  }
}

// Single-tab phases (posts/account/comments): wait out the cool-down and
// retry once instead of failing the page. The metrics pool requeues instead.
async function pacedGotoRetry(page, url, marker, opts) {
  try {
    await pacedGoto(page, url, marker, opts);
  } catch (e) {
    if (!(e instanceof RateLimitError)) throw e;
    await sleepThroughCooldown();
    await sleep(1000);
    await pacedGoto(page, url, marker, opts);
  }
}

async function scrollBottomSettle(page, ms = 700) {
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await sleep(ms);
}

// -------------------------------------------------- viewport-step scroll loop
// Shared engine for the two activity feeds (gather-posts / gather-comments-out
// step 3): scroll one viewport at a time, stale counter, "Show more results"
// fallback only after 2 stale iterations at the bottom. waitForNew() makes the
// waits event-driven; correctness still rests on the stale-counter protocol.

const SCROLL_STEP = asFn(`() => {
  const before = window.scrollY;
  window.scrollBy({ top: window.innerHeight - 50, behavior: 'instant' });
  return {
    scrollY: window.scrollY,
    scrollHeight: document.body.scrollHeight,
    reachedBottom: window.scrollY + window.innerHeight >= document.body.scrollHeight - 5,
    moved: window.scrollY - before,
  };
}`);

const SHOW_MORE_CLICK = asFn(`() => {
  const buttons = Array.from(document.querySelectorAll('button, a'));
  const re = /\\bshow more (activity|results)\\b/i;
  const btn = buttons.find(b => {
    if (b.offsetParent === null) return false;
    if (b.disabled || b.getAttribute('aria-disabled') === 'true') return false;
    const txt = (b.innerText || b.textContent || '').trim();
    return re.test(txt);
  });
  if (btn) { btn.click(); return 'clicked'; }
  return 'no-button';
}`);

async function feedScrollLoop(page, { scrape, waitForNew, shouldStop, maxIterations }) {
  let stale = 0, iterations = 0;
  for (; iterations < maxIterations; iterations++) {
    if (breakerTripped) throw new BreakerError(breakerTripped);
    const step = await page.evaluate(SCROLL_STEP);
    await waitForNew(2000);
    const grew = await scrape(); // returns count of NEW items this pass
    if (grew > 0) stale = 0; else stale++;
    const stop = await shouldStop();
    if (stop) return { iterations: iterations + 1, endReason: stop };
    if (step.reachedBottom && stale >= 2) {
      const clicked = await page.evaluate(SHOW_MORE_CLICK);
      iterations++;
      if (clicked === 'clicked') {
        await waitForNew(8000); // spec floor: give the batch API up to 8s
        await sleep(300);       // partial-batch settle
        const grew2 = await scrape();
        if (grew2 > 0) stale = 0;
        const stop2 = await shouldStop();
        if (stop2) return { iterations: iterations + 1, endReason: stop2 };
      } else {
        return { iterations: iterations + 1, endReason: 'end-of-feed' };
      }
    }
  }
  return { iterations, endReason: 'cap' };
}

// ---------------------------------------------------------------- browser

// Опційний бекенд Browserbase (хмарна сесія lifleet) замість локального Chrome.
// Вмикається LI_BACKEND=browserbase; акаунт — LI_AUTHOR (дефолт oleksandr).
// release зберігаємо для shutdown, щоб звільнити сесію (єдиний слот на free plan).
let bbRelease = null;

async function launchBrowser() {
  if (process.env.LI_BACKEND === 'browserbase') {
    const slug = process.env.LI_AUTHOR || 'oleksandr';
    const { context, release } = await openBrowserbaseSession(slug);
    bbRelease = release;
    return context;
  }
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await chromium.launchPersistentContext(USER_DATA_DIR, {
        channel: 'chrome',
        headless: HEADLESS,
        viewport: { width: 1440, height: 1000 },
        timeout: 60000,
      });
    } catch (e) {
      lastErr = e;
      log(`launch attempt ${attempt} failed: ${String(e.message).split('\n')[0]}`);
      // A timed-out launch can leave a half-started Chrome holding the
      // profile's ProcessSingleton — sweep it or every retry inherits the lock.
      spawnSync('pkill', ['-f', `user-data-dir=${USER_DATA_DIR}`], { timeout: 10000 });
      await sleep(3000 * attempt);
    }
  }
  if (/ProcessSingleton|SingletonLock|profile is already in use/i.test(String(lastErr))) {
    console.log('ERROR=PROFILE_LOCKED');
    process.exit(21);
  }
  console.log('ERROR=UNKNOWN');
  console.error(lastErr);
  process.exit(4);
}

// ============================================================ phase: posts

const CARD_SCRAPE = asFn(`() => {
  const cards = Array.from(document.querySelectorAll('div[data-urn^="urn:li:activity"]'));
  return cards.map(c => {
    const urn = c.getAttribute('data-urn');
    const id = urn.replace(/^urn:li:activity:/, '');
    const textEl = c.querySelector('.update-components-text, .feed-shared-update-v2__description');
    const previewRaw = (textEl?.innerText || c.innerText || '').trim().replace(/\\s+/g, ' ');
    const isRepost = /\\breposted this\\b/i.test((c.innerText || '').slice(0, 150));
    return { urn, id, previewRaw: previewRaw.slice(0, 400), isRepost };
  });
}`);

const CYR = {
  а:'a',б:'b',в:'v',г:'h',ґ:'g',д:'d',е:'e',є:'ie',ж:'zh',з:'z',и:'y',і:'i',ї:'i',й:'i',
  к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'kh',ц:'ts',ч:'ch',
  ш:'sh',щ:'shch',ь:'',ю:'iu',я:'ia',ы:'y',э:'e',ё:'e',ъ:'',
};

function slugify(preview) {
  let s = preview.split(/\s+/).slice(0, 12).join(' ');
  s = s.normalize('NFKD')                 // 𝗺𝘆 -> my, é -> e + combining mark
    .replace(/[̀-ͯ]/g, '')      // strip combining marks
    .toLowerCase()
    .replace(/[Ѐ-ӿ]/g, (ch) => CYR[ch] ?? '');
  s = s.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/-{2,}/g, '-');
  if (s.length > 60) {
    s = s.slice(0, 60);
    const cut = s.lastIndexOf('-');
    if (cut > 0) s = s.slice(0, cut);
    s = s.replace(/-+$/, '');
  }
  return s || 'post';
}

function cleanPreview(previewRaw) {
  const s = previewRaw
    .replace(/(…|\.{3})?\s*(see more|show more)\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  // Code-point slice — UTF-16 slice() ріже emoji навпіл і лишає lone surrogate,
  // який Python не може записати в UTF-8 (merge.py падає з UnicodeEncodeError).
  return [...s].slice(0, 200).join('').trim();
}

async function phasePosts(page) {
  fs.mkdirSync(POSTS_DIR, { recursive: true });
  const existing = new Map(); // id -> posted_date
  for (const f of fs.readdirSync(POSTS_DIR).filter((f) => f.endsWith('.json'))) {
    try {
      const d = readJson(path.join(POSTS_DIR, f));
      if (d.id) existing.set(d.id, d.posted_date || null);
    } catch { /* skip broken */ }
  }
  let cutoff;
  if (args['cutoff-override']) cutoff = String(args['cutoff-override']);
  else if (existing.size === 0) cutoff = DEFAULT_CUTOFF;
  else cutoff = [...existing.values()].filter(Boolean).sort().at(-1);
  const cutoffMs = Date.parse(cutoff + 'T00:00:00Z');

  const allCards = new Map(); // urn -> card
  let oldestEverSeenMs = null;

  const scrape = async () => {
    const cards = await page.evaluate(CARD_SCRAPE);
    let added = 0;
    for (const c of cards) {
      if (!allCards.has(c.urn)) { allCards.set(c.urn, c); added++; }
      const ms = Number(BigInt(c.id) >> 22n);
      if (oldestEverSeenMs === null || ms < oldestEverSeenMs) oldestEverSeenMs = ms;
    }
    return added;
  };

  // Wait for a previously-unseen URN (not a count change — virtualization can
  // swap cards without growing the count).
  const waitForNew = (timeout) => page.waitForFunction(
    (known) => {
      const set = new Set(known);
      return Array.from(document.querySelectorAll('div[data-urn^="urn:li:activity"]'))
        .some((c) => !set.has(c.getAttribute('data-urn')));
    }, [...allCards.keys()], { timeout },
  ).catch(() => {});

  // LinkedIn occasionally serves the activity feed empty (observed
  // 2026-07-20: zero cards at 14:25, five cards on the same runner at 14:33)
  // — one paced re-navigation covers the transient before the phase dies.
  for (let round = 1; round <= 2; round++) {
    await pacedGotoRetry(page, PROFILE_URL, null);
    await page.waitForSelector('div[data-urn^="urn:li:activity"]', { timeout: 15000 })
      .catch(() => {});
    await scrape();
    const { iterations, endReason } = await feedScrollLoop(page, {
      scrape,
      waitForNew,
      shouldStop: async () =>
        (oldestEverSeenMs !== null && oldestEverSeenMs < cutoffMs) ? 'past-cutoff' : null,
      maxIterations: 120,
    });
    vlog(`posts: scroll ended (${endReason}) after ${iterations} iterations, ${allCards.size} cards`);
    if (allCards.size > 0) break;
    // Keep the evidence a retry would otherwise erase: which page actually
    // rendered when the cards were missing.
    const diag = await page.evaluate(() => ({
      url: location.href,
      title: document.title,
      anyDataUrn: document.querySelectorAll('[data-urn]').length,
      mainLi: document.querySelectorAll('main li').length,
      text: ((document.querySelector('main') || document.body).innerText || '')
        .slice(0, 300).replace(/\n+/g, ' | '),
    })).catch(() => null);
    log(`posts: zero cards on round ${round}: ${JSON.stringify(diag)}`);
    if (round === 1) await sleep(5000);
  }

  if (allCards.size === 0) {
    throw Object.assign(new Error('no activity cards found'), { reason: 'SCRAPE' });
  }

  const usedNames = new Set(fs.readdirSync(POSTS_DIR));
  const newPosts = [];
  for (const c of allCards.values()) {
    const ms = Number(BigInt(c.id) >> 22n);
    if (ms < cutoffMs || existing.has(c.id)) continue;
    const postedAt = msToIso(ms);
    const postedDate = postedAt.slice(0, 10);
    const preview = cleanPreview(c.previewRaw);
    let fname = `${postedDate}-${slugify(preview)}.json`;
    if (usedNames.has(fname)) fname = `${postedDate}-${slugify(preview)}-${c.id.slice(-6)}.json`;
    usedNames.add(fname);
    const rec = {
      urn: c.urn,
      id: c.id,
      type: c.isRepost ? 'repost' : 'post',
      posted_at: postedAt,
      posted_date: postedDate,
      post_url: `https://www.linkedin.com/feed/update/${c.urn}/`,
      preview,
      text: null,
      weeks: {},
    };
    // Write via python so number/indent lexemes match the rest of the corpus.
    mergeViaPython({ mode: 'newfile', path: path.join(POSTS_DIR, fname), record: rec });
    newPosts.push(rec);
  }
  const dates = newPosts.map((p) => p.posted_date).sort();
  return {
    POSTS_DISCOVERED: allCards.size,
    POSTS_NEW: newPosts.length,
    CUTOFF: cutoff,
    OLDEST_NEW: dates[0] || '-',
    NEWEST_NEW: dates.at(-1) || '-',
  };
}

// ============================================================ phase: metrics

const CARDS_EVAL = asFn(`() => {
  const cards = Array.from(document.querySelectorAll('section.artdeco-card.member-analytics-addon-card__base-card'))
    .map(c => ({
      title: c.querySelector('h2')?.textContent?.trim() || '',
      text:  c.textContent.replace(/\\s+/g, ' ').trim(),
    }));
  return { cards };
}`);

const CARDS_READY = asFn(`() => {
  const t = (document.querySelector('main') || document.body).innerText || '';
  return /\\d[\\d,]*\\s+Impressions/.test(t)
    && /\\d[\\d,]*\\s+Members reached/.test(t)
    && /Reactions/.test(t);
}`);

const DEMO_EXPAND = asFn(`() => {
  const btns = Array.from(document.querySelectorAll('button')).filter(b => /show all|show more/i.test(b.textContent || ''));
  btns.forEach(b => b.click());
  return btns.length;
}`);

const DEMO_READY = asFn(`() => {
  const t = document.body ? document.body.innerText : '';
  return /Top demographics/i.test(t) && (/\\d+(\\.\\d+)?%/.test(t) || /no data|nothing to show/i.test(t));
}`);

// Post-summary metrics from line-structured innerText (current layout,
// 2026-07): Discovery/Profile-activity show number-BEFORE-label, the
// Engagement section shows label-THEN-number.
function parseSummaryLines(lines) {
  const m = { impressions: 0, members_reached: 0, reactions: 0, comments: 0,
    reposts: 0, saves: 0, sends: 0, profile_viewers: 0, followers_gained: 0 };
  let matched = 0;
  let iDisc = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === 'Discovery' && findLineIdx(lines, /^Impressions$/, i + 1, i + 5) >= 0) {
      iDisc = i; break;
    }
  }
  const anchor = iDisc >= 0 ? iDisc : 0;
  const grab = (re, dir, from) => {
    const i = findLineIdx(lines, re, from);
    if (i < 0) return null;
    return dir === 'before' ? numBefore(lines, i) : numAfter(lines, i);
  };
  const set = (key, v) => { if (v !== null) { m[key] = v; matched++; } };
  set('impressions', grab(/^Impressions$/, 'before', anchor));
  set('members_reached', grab(/^Members reached$/, 'before', anchor));
  set('profile_viewers', grab(/^Profile viewers from this post$/, 'before', anchor));
  set('followers_gained', grab(/^Followers gained from this post$/, 'before', anchor));
  const iEng = findLineIdx(lines, /^(Social engagement|Engagement)$/, anchor);
  const eFrom = iEng >= 0 ? iEng : anchor;
  set('reactions', grab(/^Reactions$/, 'after', eFrom));
  set('comments', grab(/^Comments$/, 'after', eFrom));
  set('reposts', grab(/^Reposts$/, 'after', eFrom));
  set('saves', grab(/^Saves$/, 'after', eFrom));
  set('sends', grab(/^Sends( on LinkedIn)?$/, 'after', eFrom));
  m.matched = matched;
  return m;
}

// Old-layout fallback: the artdeco card DOM + regex table from the agent spec.
function parseSummaryCards(cards) {
  const m = {};
  let matched = 0;
  for (const [cardTitle, key, re] of METRIC_REGEXES) {
    const card = cards.find((c) => c.title.toLowerCase().includes(cardTitle.toLowerCase()))
      || cards.find((c) => re.test(c.text));
    const mm = card ? card.text.match(re) : null;
    m[key] = int0(mm);
    if (mm) matched++;
  }
  m.matched = matched;
  return m;
}

// Demographic-detail rows: "<Header>" then alternating "<label>" / "<pct>%"
// lines. "< 1%" -> 0 (the convention in the latest corpus snapshots).
const DEMO_HEADERS = {
  Seniority: 'seniority', 'Job title': 'job_title', Industry: 'industry',
  'Company size': 'company_size', Location: 'location', Company: 'company',
};
const DEMO_PCT = /^(<\s*1|\d+(?:\.\d+)?)%$/;
function parseDemoLines(lines) {
  const out = {
    seniority: {}, job_title: {}, industry: {}, company_size: {}, location: {}, company: {},
  };
  const iTop = findLineIdx(lines, /^Top demographics$/);
  let cur = null;
  for (let i = (iTop >= 0 ? iTop + 1 : 0); i < lines.length; i++) {
    const line = lines[i];
    if (Object.prototype.hasOwnProperty.call(DEMO_HEADERS, line)) {
      cur = DEMO_HEADERS[line];
      continue;
    }
    if (!cur) continue;
    const nxt = lines[i + 1];
    if (nxt !== undefined && DEMO_PCT.test(nxt) && !DEMO_PCT.test(line)) {
      const mm = nxt.match(DEMO_PCT);
      out[cur][line] = /^</.test(mm[1]) ? 0 : parseFloat(mm[1]);
      i++;
    }
  }
  return out;
}

// The comment list lost `article.comments-comment-entity` (and every `article`
// element) in LinkedIn's 2026-08 post-page migration — which is what silently
// emptied `weeks[WEEK].comments` for all 50 posts. The repeating unit is now
// `div[id^="replaceableComment_urn:li:comment:..."]`, and a reply is the same
// node NESTED inside its parent's, so there is no separate replies container.
// Old selectors kept as a fallback for A/B buckets. Verified live 2026-08-19.
const COMMENT_UNIT_SEL = 'div[id^="replaceableComment_urn:li:comment:"]';

// "the post page has rendered". `.feed-shared-update-v2` and the `data-urn`
// attribute both disappeared in the same 2026-08 migration; `data-view-name`
// is LinkedIn's own hook and survived. All three are accepted so an A/B bucket
// on either markup still passes.
const POST_PAGE_MARKER = '[data-view-name="feed-full-update"], [data-view-name="feed-detail-page"],'
  + ' .feed-shared-update-v2, [data-urn^="urn:li:activity"]';

const LOAD_MORE_COMMENTS_CLICK = asFn(`() => {
  const btns = Array.from(document.querySelectorAll('button')).filter(b => {
    if (b.offsetParent === null || b.disabled) return false;
    const a = b.getAttribute('aria-label') || '';
    const t = (b.innerText || b.textContent || '').trim();
    return /^(Load more comments|Load previous comments|Show more comments)$/i.test(a)
      || /^(Load more comments|Load previous comments|Show more comments)$/i.test(t);
  });
  if (btns.length) { btns[0].click(); return 'clicked'; }
  return 'no-button';
}`);

const TOP_LEVEL_COMMENT_COUNT = asFn(`() => {
  const UNIT = 'div[id^="replaceableComment_urn:li:comment:"]';
  const units = Array.from(document.querySelectorAll(UNIT));
  if (units.length) return units.filter(u => !u.parentElement || !u.parentElement.closest(UNIT)).length;
  return Array.from(document.querySelectorAll('article.comments-comment-entity'))
    .filter(a => !a.closest('.comments-replies-list, .comments-comment-replies')).length;
}`);

const SEE_MORE_EXPAND = asFn(`() => {
  const UNIT = 'div[id^="replaceableComment_urn:li:comment:"]';
  const isTopLevel = (el) => {
    if (el.closest('.comments-replies-list, .comments-comment-replies')) return false;
    const unit = el.closest(UNIT);
    return !unit || !unit.parentElement || !unit.parentElement.closest(UNIT);
  };
  const btns = Array.from(document.querySelectorAll('button')).filter(b => {
    if (b.offsetParent === null || b.disabled) return false;
    if (!isTopLevel(b)) return false;
    const t = (b.innerText || '').replace(/\\s+/g, ' ').trim().toLowerCase();
    return /^(…\\s*more|\\.\\.\\.\\s*more|see more)$/.test(t)
      || /comments-comment-item__see-more-text|feed-shared-inline-show-more-text__see-more-less-toggle/.test(b.className);
  });
  btns.forEach(b => b.click());
  return btns.length;
}`);

const POST_TEXT_EVAL = asFn(`async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const container = document.querySelector('[data-view-name="feed-full-update"]')
    || document.querySelector('.feed-shared-update-v2')
    || document.querySelector('[data-urn^="urn:li:activity"]')
    || document;
  const btn = Array.from(container.querySelectorAll('button')).find(b => {
    if (b.offsetParent === null || b.disabled) return false;
    if (b.closest('.comments-comments-list, .comments-comment-item, .comments-comment-entity,'
      + ' [data-view-name="comment-container"], div[id^="replaceableComment_"]')) return false;
    const t = (b.innerText || '').trim().toLowerCase();
    return t === 'see more' || t === '…see more' || t === '…more' || t === '... more'
      || /feed-shared-inline-show-more-text__see-more-less-toggle/.test(b.className);
  });
  if (btn) { btn.click(); await sleep(800); }
  const bodyEl = container.querySelector('[data-view-name="feed-commentary"]')
    || container.querySelector('.feed-shared-update-v2__description, .update-components-text');
  const text = (bodyEl ? bodyEl.innerText : '').trim();
  return { found: !!bodyEl, len: text.length, text };
}`);

const METRIC_REGEXES = [
  ['Discovery', 'impressions', /(\d[\d,]*)\s+Impressions/],
  ['Discovery', 'members_reached', /(\d[\d,]*)\s+Members reached/],
  ['Profile activity', 'profile_viewers', /Profile viewers from this post\s*(\d[\d,]*)/],
  ['Profile activity', 'followers_gained', /Followers gained from this post\s*(\d[\d,]*)/],
  ['Social engagement', 'reactions', /Reactions\s*(\d[\d,]*)/],
  ['Social engagement', 'comments', /Comments\s*(\d[\d,]*)/],
  ['Social engagement', 'reposts', /Reposts\s*(\d[\d,]*)/],
  ['Social engagement', 'saves', /Saves\s*(\d[\d,]*)/],
  ['Social engagement', 'sends', /Sends(?: on LinkedIn)?\s*(\d[\d,]*)/],
];

function cleanPostText(raw) {
  return raw
    .replace(/…?\s*see more\s*$/i, '')
    .replace(/hashtag\n#/g, '#')
    .trim();
}

function textMatchesPreview(text, preview) {
  const norm = (s) => s.replace(/\s+/g, ' ').trim().toLowerCase();
  const p = norm((preview || '').replace(/…\s*$/, ''));
  if (!p) return true;
  return norm(text).startsWith(p.slice(0, 30));
}

async function scrapeOnePost(page, postFile) {
  const data = readJson(postFile);
  const { urn, id } = data;
  const type = data.type || 'post';
  if (type === 'repost') return { STATUS: 'SKIPPED_REPOST', POST_ID: id, WEEK };
  const needText = !data.text;

  // -- post-summary
  await pacedGoto(page, POST_SUMMARY_URL(urn), 'Discovery', { markerTimeout: 8000 });
  await page.waitForFunction(CARDS_READY, undefined, { timeout: 10000 }).catch(() => {});
  await scrollBottomSettle(page, 400);
  let metrics = parseSummaryLines(linesOf(await page.evaluate(MAIN_INNER_TEXT)));
  if (metrics.matched === 0) {
    // old-layout fallback: the artdeco card DOM from the agent spec
    const { cards } = await page.evaluate(CARDS_EVAL);
    metrics = parseSummaryCards(cards);
  }
  if (metrics.matched === 0) {
    await sleep(2500);
    metrics = parseSummaryLines(linesOf(await page.evaluate(MAIN_INNER_TEXT)));
  }
  if (metrics.matched === 0) {
    // A rate-limited voyager XHR can leave the shell rendered but empty —
    // that's a retry case, not selector drift.
    if (Date.now() - lastTripAt < 120000) throw new RateLimitError('empty summary during cooldown');
    throw Object.assign(new Error('no metric fields parsed'), { reason: 'SCRAPE' });
  }
  delete metrics.matched;
  metrics.engagement_rate = metrics.impressions === 0 ? 0
    : Math.round((metrics.reactions + metrics.comments + metrics.reposts)
        / metrics.impressions * 100 * 100) / 100;

  // -- demographic-detail
  await pacedGoto(page, DEMO_URL(urn), 'Top demographics', { markerTimeout: 8000 });
  await page.waitForFunction(DEMO_READY, undefined, { timeout: 8000 }).catch(() => {});
  await scrollBottomSettle(page, 400);
  await page.evaluate(DEMO_EXPAND); // no-op on the new layout; expands the old one
  await sleep(400);
  const demographics = parseDemoLines(linesOf(await page.evaluate(MAIN_INNER_TEXT)));
  if (Object.values(demographics).every((d) => Object.keys(d).length === 0)
      && (Date.now() < cooldownUntil || Date.now() - lastTripAt < 120000)) {
    // rendered shell whose demographics XHR got rate-limited — retry, don't
    // merge an empty-but-well-shaped snapshot
    throw new RateLimitError('empty demographics during cooldown');
  }

  // -- public post page: text backfill + top-level comments
  let comments = [];
  let postText = null;
  try {
    await pacedGotoRetry(page, data.post_url, null);
    await page.waitForSelector(POST_PAGE_MARKER,
      { timeout: 10000 }).catch(() => {});
    await sleep(600);

    if (needText) {
      try {
        const res = await page.evaluate(POST_TEXT_EVAL);
        if (res && res.found && res.text) {
          const cleaned = cleanPostText(res.text);
          if (cleaned && textMatchesPreview(cleaned, data.preview)) postText = cleaned;
        }
      } catch { /* best-effort */ }
    }

    comments = await loadAndScrapePostComments(page);
  } catch (e) {
    if (e instanceof AuthError || e instanceof BreakerError || e instanceof RateLimitError) throw e;
    vlog(`comments scrape failed for ${id}: ${e.message}`);
    comments = [];
  }

  const snapshot = {
    snapshot_at: nowIso(),
    metrics: {
      impressions: metrics.impressions,
      members_reached: metrics.members_reached,
      reactions: metrics.reactions,
      comments: metrics.comments,
      reposts: metrics.reposts,
      saves: metrics.saves,
      sends: metrics.sends,
      profile_viewers: metrics.profile_viewers,
      followers_gained: metrics.followers_gained,
      engagement_rate: metrics.engagement_rate,
    },
    demographics,
    comments,
  };

  mergeViaPython({
    mode: 'post', path: postFile, week: WEEK, snapshot,
    post_text: postText || null,
  });

  return {
    STATUS: 'OK', POST_ID: id, WEEK,
    IMPRESSIONS: metrics.impressions, REACTIONS: metrics.reactions,
    COMMENTS: metrics.comments, COMMENTS_SCRAPED: comments.length,
  };
}

function latestCommentCount(file) {
  try {
    const d = readJson(file);
    const weeks = d.weeks || {};
    const latest = Object.keys(weeks).sort().at(-1);
    return latest ? (weeks[latest].metrics?.comments ?? 0) : 0;
  } catch { return 0; }
}

async function phaseMetrics(context) {
  let files = POST_FILES_ONLY
    ? POST_FILES_ONLY.map((f) => path.resolve(REPO_ROOT, f))
    : fs.readdirSync(POSTS_DIR).filter((f) => f.endsWith('.json')).sort()
        .map((f) => path.join(POSTS_DIR, f));
  files = files.slice(0, POSTS_LIMIT);
  // Largest previous comment thread first — kills the long-tail worker AND
  // doubles as the canary (run alone before opening the pool).
  files.sort((a, b) => latestCommentCount(b) - latestCommentCount(a));

  const results = [];
  const runOne = async (page, file) => {
    const started = Date.now();
    try {
      const r = await scrapeOnePost(page, file);
      results.push(r);
      log(`metrics ${results.length}/${files.length} ${r.POST_ID}: ${r.STATUS}` +
        (r.STATUS === 'OK' ? ` imp=${r.IMPRESSIONS} scraped=${r.COMMENTS_SCRAPED}` : '') +
        ` (${((Date.now() - started) / 1000).toFixed(1)}s)`);
      return r;
    } catch (e) {
      if (e instanceof AuthError || e instanceof BreakerError || e instanceof RateLimitError) throw e;
      let id = path.basename(file, '.json');
      try { id = readJson(file).id || id; } catch { /* keep stem */ }
      const reason = e.reason
        || (/timeout|net::|ERR_/i.test(String(e.message)) ? 'NETWORK' : 'UNKNOWN');
      const r = { STATUS: 'FAIL', POST_ID: id, WEEK, REASON: reason };
      results.push(r);
      log(`metrics ${results.length}/${files.length} ${id}: FAIL ${reason} — ${String(e.message).split('\n')[0]}`);
      return r;
    }
  };
  const attempts = new Map();
  const failRecord = (file, reason) => {
    let id = path.basename(file, '.json');
    try { id = readJson(file).id || id; } catch { /* keep stem */ }
    results.push({ STATUS: 'FAIL', POST_ID: id, WEEK, REASON: reason });
    log(`metrics ${results.length}/${files.length} ${id}: FAIL ${reason} (gave up)`);
  };

  // Canary: first non-repost runs alone. A SCRAPE failure here means selector
  // drift — abort fast-path entirely (exit 30) so the wrapper can fall back.
  const canaryIdx = files.findIndex((f) => {
    try { return (readJson(f).type || 'post') !== 'repost'; } catch { return false; }
  });
  const queue = [...files];
  if (canaryIdx >= 0) {
    const canaryFile = queue.splice(canaryIdx, 1)[0];
    const page = await context.newPage();
    let canary = null;
    try {
      for (let a = 0; a < 3 && !canary; a++) {
        try {
          canary = await runOne(page, canaryFile);
        } catch (e) {
          if (!(e instanceof RateLimitError)) throw e;
          if (a < 2) { // no pointless cool-down wait after the final attempt
            await sleepThroughCooldown();
            await sleep(1000);
          }
        }
      }
    } finally { await page.close().catch(() => {}); }
    // Rate-limited three times before the pool even opened: the pool would
    // hit the same wall 41 more times — abort the run instead. Overwrite the
    // stop reason so this classifies as rate (22), not deadline/partial.
    if (!canary) {
      breakerTripped = 'canary rate-limited on every attempt';
      throw new BreakerError(breakerTripped);
    }
    if (canary.STATUS === 'FAIL' && canary.REASON === 'SCRAPE') {
      throw Object.assign(new Error('canary post failed with SCRAPE — selector drift'),
        { reason: 'COMPAT' });
    }
  }

  let stoppedEarly = false;
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    const page = await context.newPage();
    try {
      while (queue.length) {
        // Breaker/deadline: stop scheduling but keep the aggregates of what
        // finished — merged files are already on disk.
        if (breakerTripped) { stoppedEarly = true; break; }
        const file = queue.shift();
        try {
          await runOne(page, file);
        } catch (e) {
          if (e instanceof BreakerError) {
            queue.unshift(file); // in-flight post counts as unprocessed
            stoppedEarly = true;
            break;
          }
          if (e instanceof RateLimitError) {
            const n = (attempts.get(file) || 0) + 1;
            attempts.set(file, n);
            if (n < 3) {
              queue.push(file); // retry after the cool-down, end of queue
              vlog(`metrics: requeued ${path.basename(file)} after rate-limit (attempt ${n})`);
            } else {
              failRecord(file, 'NETWORK');
            }
            continue;
          }
          throw e;
        }
      }
    } finally {
      await page.close().catch(() => {});
    }
  });
  await Promise.all(workers);
  if (stoppedEarly) log(`metrics: stopped early (${breakerTripped}) — ${queue.length} posts unprocessed`);

  const measured = results.filter((r) => r.STATUS === 'OK');
  const failed = results.filter((r) => r.STATUS === 'FAIL');
  const skipped = results.filter((r) => r.STATUS === 'SKIPPED_REPOST');
  return {
    WEEK,
    POSTS_MEASURED: measured.length,
    POSTS_FAILED: failed.length,
    POSTS_SKIPPED: skipped.length,
    POSTS_UNPROCESSED: queue.length, // >0 only after a breaker/deadline stop
    FAILED_IDS: failed.map((r) => r.POST_ID).join(',') || '-',
    COMMENTS_SCRAPED_TOTAL: measured.reduce((s, r) => s + (r.COMMENTS_SCRAPED || 0), 0),
  };
}

// ============================================================ phase: account

const MAIN_TEXT = asFn(`() => (document.querySelector('main') || document.body).innerText.replace(/\\s+/g,' ').trim()`);

async function phaseAccount(page) {
  const failures = [];
  const snapshot = {
    snapshot_at: null,
    dashboard: {}, content_7d: {}, audience: {}, search_appearances: {}, profile_views: {},
  };

  // -- dashboard (2026-07 layout: number-line before label-line, delta after)
  try {
    await pacedGotoRetry(page, DASHBOARD_URL, 'Post impressions');
    await scrollBottomSettle(page);
    const lines = linesOf(await page.evaluate(MAIN_INNER_TEXT));
    const grab = (re) => {
      const i = findLineIdx(lines, re);
      return i < 0 ? null : { n: numBefore(lines, i), pct: pctAfter(lines, i) };
    };
    const pi = grab(/^Post impressions\b/);
    const fo = grab(/^Total followers$/) ?? grab(/^Followers$/);
    snapshot.dashboard = {
      post_impressions_7d: pi?.n ?? 0,
      post_impressions_delta_pct_7d: pi?.pct ?? null,
      followers: fo?.n ?? 0,
      followers_delta_pct_7d: fo?.pct ?? null,
      profile_viewers_90d: grab(/^Profile viewers\b/)?.n ?? 0,
      search_appearances_previous_week: grab(/^Search appearances\b/)?.n ?? 0,
    };
  } catch (e) {
    if (e instanceof AuthError || e instanceof BreakerError) throw e;
    failures.push('dashboard');
  }

  // -- content (same Discovery/Engagement line structure as post-summary;
  // scope to before "Top performing posts" so post bodies can't false-match)
  try {
    await pacedGotoRetry(page, CONTENT_URL, 'Content performance');
    await scrollBottomSettle(page);
    const lines = linesOf(await page.evaluate(MAIN_INNER_TEXT));
    const iDisc = Math.max(0, findLineIdx(lines, /^Discovery$/));
    const iEng = Math.max(iDisc, findLineIdx(lines, /^(Social engagement|Engagement)$/, iDisc));
    const iTopPosts = findLineIdx(lines, /^Top performing posts$/, iEng);
    const end = iTopPosts >= 0 ? iTopPosts : lines.length;
    const at = (re, dir, from) => {
      const i = findLineIdx(lines, re, from, end);
      return i < 0 ? null : (dir === 'before' ? numBefore(lines, i) : numAfter(lines, i));
    };
    const iVs = findLineIdx(lines, /^vs\.? prior 7 days$/);
    snapshot.content_7d = {
      impressions_7d: at(/^Impressions$/, 'before', iDisc) ?? 0,
      impressions_delta_pct: iVs > 0 && PCT_LINE.test(lines[iVs - 1])
        ? parseFloat(lines[iVs - 1].replace('−', '-')) : null,
      members_reached_7d: at(/^Members reached$/, 'before', iDisc) ?? 0,
      social_engagements_7d: at(/^Social engagements$/, 'before', iEng) ?? 0,
      reactions_7d: at(/^Reactions$/, 'after', iEng) ?? 0,
      comments_7d: at(/^Comments$/, 'after', iEng) ?? 0,
      reposts_7d: at(/^Reposts$/, 'after', iEng) ?? 0,
      saves_7d: at(/^Saves$/, 'after', iEng) ?? 0,
      sends_7d: at(/^Sends( on LinkedIn)?$/, 'after', iEng) ?? 0,
      link_engagements_7d: at(/^Link engagements$/, 'before', iEng) ?? 0,
    };
  } catch (e) {
    if (e instanceof AuthError || e instanceof BreakerError) throw e;
    failures.push('content');
  }

  // -- audience
  try {
    await pacedGotoRetry(page, AUDIENCE_URL, 'Top demographics');
    // The demographic rows render per tab click, and a fixed 800ms settle
    // proved not enough under load — every concurrent run (2026-07-13/20)
    // shipped six empty groups while the same page parsed fine idle. Scroll
    // the module into view, wait for the tab strip, then poll per tab until
    // the rows region shows stable, changed content.
    await scrollBottomSettle(page);
    await page.waitForFunction(
      () => Array.from((document.querySelector('main') || document.body).querySelectorAll('button'))
        .some((b) => (b.innerText || '').trim() === 'Job title'),
      { timeout: 10000 },
    ).catch(() => {});
    const head = await page.evaluate(asFn(`() => {
      const main = (document.querySelector('main') || document.body).innerText.replace(/\\s+/g,' ');
      const t = main.match(/(\\d[\\d,]*)\\s+Total followers/);
      const d = main.match(/(-?\\d+(?:\\.\\d+)?)%\\s+vs\\.?\\s+prior 7 days/);
      return { total_followers: t ? parseInt(t[1].replace(/,/g,''),10) : 0,
               followers_delta_pct_7d: d ? parseFloat(d[1]) : null };
    }`));
    const demographics = {};
    const tabs = [
      ['Job title', 'job_title'], ['Location', 'location'], ['Seniority', 'seniority'],
      ['Company', 'company'], ['Industry', 'industry'], ['Company size', 'company_size'],
    ];
    // Rows render as "<label>" / "<pct>%" line pairs after the tab strip
    // (whose last label is "Company size"). "< 1%" -> 0.5 here — the
    // audience-page convention in the existing corpus.
    const grabRows = async () => {
      const lines = linesOf(await page.evaluate(MAIN_INNER_TEXT));
      const iTop = findLineIdx(lines, /^Top demographics$/);
      const iStrip = findLineIdx(lines, /^Company size$/, iTop >= 0 ? iTop : 0);
      const rows = {};
      for (let i = (iStrip >= 0 ? iStrip : iTop) + 1; i < lines.length - 1; i++) {
        const label = lines[i];
        if (label === 'About') break; // footer
        const mm = lines[i + 1].match(DEMO_PCT);
        if (mm && !DEMO_PCT.test(label)) {
          rows[label] = /^</.test(mm[1]) ? 0.5 : parseFloat(mm[1]);
          i++;
        }
      }
      return rows;
    };
    // Seed the stale guard with the pre-click view: the default "All" tab
    // parses to non-empty MIXED rows, which must never be stored as a group.
    const sig = (rows) => JSON.stringify(rows);
    let prevSig = sig(await grabRows());
    for (let ti = 0; ti < tabs.length; ti++) {
      const [tabName, key] = tabs[ti];
      const clicked = await page.evaluate((name) => {
        const btn = Array.from((document.querySelector('main') || document.body).querySelectorAll('button'))
          .find((b) => (b.innerText || '').trim() === name);
        if (!btn) return false;
        btn.click();
        return true;
      }, tabName);
      if (!clicked) { failures.push(`audience-tab-${key}`); demographics[key] = {}; continue; }
      // Accept only STABLE + CHANGED content: two consecutive identical
      // non-empty grabs that differ from the previous view. On timeout store
      // {} and a per-tab failure — stale or half-rendered rows must never be
      // attributed to this tab, and a hollow group can never be real on this
      // account (same reasoning as the audience canary).
      let rows = null;
      let lastSig = null;
      const deadline = Date.now() + 8000;
      do {
        await sleep(250);
        const r = await grabRows();
        const s = sig(r);
        if (s !== prevSig && Object.keys(r).length > 0 && s === lastSig) { rows = r; break; }
        lastSig = s;
      } while (Date.now() < deadline);
      if (rows === null) {
        failures.push(`audience-tab-${key}`);
        demographics[key] = {};
        // Re-baseline on what is visible NOW so a late-arriving response for
        // this tab is less likely to be misattributed to the next one.
        if (lastSig !== null) prevSig = lastSig;
      } else {
        demographics[key] = rows;
        prevSig = sig(rows);
      }
    }
    snapshot.audience = { ...head, demographics };
  } catch (e) {
    if (e instanceof AuthError || e instanceof BreakerError) throw e;
    failures.push('audience');
  }

  // -- search appearances
  try {
    await pacedGotoRetry(page, SEARCH_URL, 'Profile appearances');
    await scrollBottomSettle(page);
    const txt = await page.evaluate(MAIN_TEXT);
    const clicks = await page.evaluate(asFn(`() => {
      const txt = (document.querySelector('main') || document.body).innerText.replace(/\\s+/g,' ');
      const re = /(Intro|Activity|Experience|Skills|Education|Other)\\s+(\\d[\\d,]*)\\s*\\((\\d+(?:\\.\\d+)?)%\\)/g;
      const out = {};
      let m;
      while ((m = re.exec(txt)) !== null) {
        out[m[1]] = { count: parseInt(m[2].replace(/,/g,''),10), pct: parseFloat(m[3]) };
      }
      return out;
    }`));
    // Scope profile-engagement metrics to after the "Profile engagement"
    // header so viewer-card headlines can't false-match; avg view time is
    // now rendered as "1m 19s" (was "77s").
    const pe = txt.split(/Profile engagement/i)[1] || txt;
    const avt = pe.match(/(?:(\d+)m\s*)?(\d+)s\s+Avg view time/);
    snapshot.search_appearances = {
      all_appearances_7d: int0(txt.match(/(\d[\d,]*)\s+All appearances/)),
      search_appearances_7d: int0(txt.match(/(\d[\d,]*)\s+Search appearances/)),
      where_appeared: {
        posts_pct: float0(txt.match(/Posts\s+(\d+(?:\.\d+)?)%/)) ?? 0,
        comments_pct: float0(txt.match(/Comments\s+(\d+(?:\.\d+)?)%/)) ?? 0,
        network_recommendations_pct: float0(txt.match(/Network recommendations\s+(\d+(?:\.\d+)?)%/)) ?? 0,
        search_pct: float0(txt.match(/Search\s+(\d+(?:\.\d+)?)%/)) ?? 0,
      },
      profile_engagement: {
        impressions_90d: int0(pe.match(/(\d[\d,]*)\s+Impressions/)),
        clicks_90d: int0(pe.match(/(\d[\d,]*)\s+Clicks/)),
        avg_view_time_s: avt ? (avt[1] ? parseInt(avt[1], 10) * 60 : 0) + parseInt(avt[2], 10) : 0,
      },
      clicks_per_section: clicks,
    };
  } catch (e) {
    if (e instanceof AuthError || e instanceof BreakerError) throw e;
    failures.push('search');
  }

  // -- profile views
  try {
    await pacedGotoRetry(page, PROFILE_VIEWS_URL, 'Profile viewers');
    await page.evaluate(asFn(`() => {
      const btn = Array.from(document.querySelectorAll('button, a'))
        .find(b => /^show more analytics/i.test((b.innerText || '').trim()));
      if (btn) btn.click();
      return !!btn;
    }`));
    await sleep(1500);
    const txt = await page.evaluate(MAIN_TEXT);
    const highlights = await page.evaluate(asFn(`() => {
      const txt = (document.querySelector('main') || document.body).innerText.replace(/\\s+/g,' ');
      const hi = txt.split(/Highlights\\s/i)[1] || '';
      const piece = hi.split(/Details/i)[0] || '';
      const reLoc = /([^]+?)\\s+Top location\\s+([^]+?)\\s+Top industry\\s+([^]+?)\\s+Top company/i;
      const m = piece.match(reLoc);
      return m ? {
        top_location: m[1].trim(),
        top_industry: m[2].trim(),
        top_company:  m[3].trim()
      } : {};
    }`));
    const topCompanies = await page.evaluate(asFn(`() => {
      const txt = (document.querySelector('main') || document.body).innerText.replace(/\\s+/g,' ');
      const det = txt.split(/Details/i)[1] || '';
      const piece = det.split(/Show (?:all|less)/i)[0] || '';
      const head = piece.split(/Companies/i)[1] || '';
      const out = {};
      const re = /([^()]+?)\\s*\\((\\d+(?:\\.\\d+)?)%\\)/g;
      let m;
      while ((m = re.exec(head)) !== null) {
        const name = m[1].trim().replace(/^[•\\-\\s]+/, '');
        if (name && !/section/i.test(name)) out[name] = parseFloat(m[2]);
      }
      return out;
    }`));
    snapshot.profile_views = {
      viewers_90d: int0(txt.match(/(\d[\d,]*)\s+Profile viewers/)),
      viewers_delta_pct_7d: float0(txt.match(/(-?\d+(?:\.\d+)?)%\s+vs\.?\s+prior 7 days/)),
      highlights,
      top_companies_pct: topCompanies,
    };
  } catch (e) {
    if (e instanceof AuthError || e instanceof BreakerError) throw e;
    failures.push('profile_views');
  }

  // Semantic canaries: the line-anchored parsers default missing anchors to
  // zero/{}, so an anchor drift looks like a clean run with hollow data — it
  // DID: audience demographics came back as six empty groups on 2026-07-13
  // and 2026-07-20 while the run exited 0. Zero followers or zero demographic
  // rows can never be real on this account; count them as page failures so
  // the run exits 10 and cannot auto-merge.
  if (!failures.includes('dashboard') && !(snapshot.dashboard.followers > 0)) {
    failures.push('dashboard-canary');
  }
  if (!failures.includes('audience')) {
    const demoRows = Object.values(snapshot.audience.demographics ?? {})
      .reduce((s, g) => s + Object.keys(g ?? {}).length, 0);
    if (!(snapshot.audience.total_followers > 0) || demoRows === 0) {
      failures.push('audience-canary');
    }
  }

  snapshot.snapshot_at = nowIso();
  mergeViaPython({ mode: 'account', path: ACCOUNT_FILE, week: WEEK, snapshot });

  return {
    WEEK,
    FOLLOWERS: snapshot.dashboard.followers ?? 0,
    POST_IMPRESSIONS_7D: snapshot.dashboard.post_impressions_7d ?? 0,
    ENGAGEMENTS_7D: snapshot.content_7d.social_engagements_7d ?? 0,
    PROFILE_VIEWERS_90D: snapshot.dashboard.profile_viewers_90d ?? 0,
    SEARCH_APPEARANCES_7D: snapshot.dashboard.search_appearances_previous_week ?? 0,
    PAGES_FAILED: failures.join(',') || '-',
  };
}

// ====================================================== phase: comments-out

function computeCommentFloors() {
  const weekMidnightMs = Date.parse(WEEK + 'T00:00:00Z');
  let discoveryCutoffMs = weekMidnightMs;
  let oldest = null;
  for (const f of fs.readdirSync(POSTS_DIR).filter((f) => f.endsWith('.json'))) {
    try {
      const posted = readJson(path.join(POSTS_DIR, f)).posted_date;
      if (!posted) continue;
      const ms = Date.parse(posted + 'T00:00:00Z');
      if (!Number.isNaN(ms) && (oldest === null || ms < oldest)) oldest = ms;
    } catch { /* skip */ }
  }
  if (oldest !== null) discoveryCutoffMs = oldest;

  let recentFloorMs = discoveryCutoffMs;
  try {
    const comments = readJson(COMMENTS_FILE).comments || {};
    let newest = null;
    for (const entry of Object.values(comments)) {
      const iso = entry && entry.commented_at;
      if (!iso) continue;
      const ms = Date.parse(iso);
      if (!Number.isNaN(ms) && (newest === null || ms > newest)) newest = ms;
    }
    if (newest !== null) recentFloorMs = newest - 86400000;
  } catch { /* first run */ }

  return {
    discoveryCutoffMs,
    recentFloorMs,
    snapshotCutoffMs: weekMidnightMs - 30 * 86400 * 1000,
  };
}

async function phaseCommentsOut(page) {
  const { discoveryCutoffMs, recentFloorMs, snapshotCutoffMs } = computeCommentFloors();
  const effectiveFloorMs = Math.max(discoveryCutoffMs, recentFloorMs);
  const daysBack = Math.max(1, Math.ceil((Date.now() - effectiveFloorMs) / 86400000));
  const maxIterations = Math.max(120, Math.ceil(daysBack / 7) * 30);

  await pacedGotoRetry(page, COMMENTS_URL, null);
  await page.waitForSelector('article', { timeout: 15000 }).catch(() => {});
  await sleep(800);

  let pending = [];
  let totalSeen = 0, oldestEverMs = null;
  let newTotal = 0, snapTotal = 0;

  const flush = () => {
    if (!pending.length) return;
    const out = mergeViaPython({
      mode: 'comments', path: COMMENTS_FILE, week: WEEK,
      snapshot_cutoff_ms: snapshotCutoffMs, incoming: pending,
    });
    const m = out.match(/NEW=(\d+) SNAPSHOTTED=(\d+)/);
    if (m) { newTotal += parseInt(m[1], 10); snapTotal += parseInt(m[2], 10); }
    pending = [];
  };

  const scrape = async () => {
    const res = await page.evaluate(SCRAPE_COMMENTS_OUT, PROFILE_FRAG);
    if (!res || !Array.isArray(res.newItems)) return 0;
    pending.push(...res.newItems);
    totalSeen = res.totalSeen;
    oldestEverMs = res.oldestEverMs;
    if (pending.length >= 10) flush();
    return res.newItems.length;
  };
  await scrape();

  const waitForNew = async (timeout) => {
    const before = await page.evaluate(() => document.querySelectorAll('article').length);
    await page.waitForFunction(
      (prev) => document.querySelectorAll('article').length !== prev,
      before, { timeout },
    ).catch(() => {});
  };

  const { iterations, endReason } = await feedScrollLoop(page, {
    scrape,
    waitForNew,
    shouldStop: async () =>
      (oldestEverMs !== null && oldestEverMs < effectiveFloorMs) ? 'past-floor' : null,
    maxIterations,
  });
  flush();
  vlog(`comments-out: scroll ended (${endReason}) after ${iterations} iterations`);

  const hitCap = endReason === 'cap'
    && (oldestEverMs === null || oldestEverMs >= effectiveFloorMs);
  if (hitCap) throw Object.assign(new Error('hit scroll cap before floor'), { reason: 'SCRAPE' });

  return {
    WEEK,
    COMMENTS_DISCOVERED: totalSeen,
    COMMENTS_NEW: newTotal,
    COMMENTS_SNAPSHOTTED: snapTotal,
    DISCOVERY_CUTOFF: msToIso(discoveryCutoffMs),
    OLDEST_VISIBLE: oldestEverMs !== null ? msToIso(oldestEverMs) : '-',
    SCROLL_ITERATIONS: iterations,
    HIT_CAP: String(hitCap),
  };
}

// ------------------------------------------------------- phase: people (who)
// Everything above counts engagement; this phase records WHO produced it.
// The dating rules and the baseline caveat live in people.mjs — read that
// header before touching any of this.
//
// Deliberately ADVISORY: this phase never emits a phase-level `ERROR=` line
// and never escalates the exit code beyond `partial`. A reactor overlay that
// drifts must not demote a weekly run that scraped its metrics perfectly, nor
// block the Pages publish. Its health is reported through PEOPLE_STATUS, which
// the skill report and the run manifest both surface. Promote it to a hard
// canary only once it has proven itself across several fires.
//
// These evaluators are plain functions (playwright serializes fn.toString()),
// not asFn(`…`) strings — the string form exists for the canonical scrape
// bodies loaded from .claude/agents/*.js, and hand-escaping regexes into a
// template literal is a bug farm.

// The reactor overlay is a NATIVE <dialog data-testid="dialog">, not an
// artdeco modal and not [role="dialog"] — verified on the live post page
// 2026-08-17. Keep the legacy selectors as fallbacks.
const DIALOG_SEL = 'dialog[open], [data-testid="dialog"], [role="dialog"], [aria-modal="true"], .artdeco-modal';

// Open the post's reaction list.
//
// 2026-08-19: the counts row stopped rendering a reaction COUNT at all. It now
// reads "<Name> and N others reacted", so the old text anchor
// (/^\d+\s+reactions?/) matched nothing and every target came back 'no-button'.
// What survived the obfuscation is `data-view-name` — LinkedIn's own hook —
// and the reaction summary is `a[data-view-name="feed-reaction-count"]`.
// Verified live 2026-08-19: clicking it mounts <dialog data-testid="dialog">
// with the reactor list inside.
//
// The 2026-08-17 text anchor is kept as a fallback: these migrations roll out
// per A/B bucket, and a bucket still serving "70 reactions 70" must keep
// working.
async function openPostReactors(page, dialogSel) {
  return page.evaluate(async (sel) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const root = document.querySelector('main') || document.body;
    const inComment = (el) => !!el.closest(
      '[data-view-name="comment-container"], div[id^="replaceableComment_"],'
      + ' .comments-comment-entity, .comments-comment-item, .comments-comments-list');

    let target = Array.from(root.querySelectorAll(
      'a[data-view-name="feed-reaction-count"], [data-view-name="feed-reaction-count"] a,'
      + ' a[data-view-name="view-likers"], [data-view-name="view-likers"] a,'
      // Third DOM variant, found 2026-09-03 on an A/B bucket carrying
      // NEITHER the data-view-name hook NOR "reacted"-suffixed text (the
      // summary reads bare "<Name> and N others"): the reaction-proof
      // button itself carries `data-reaction-details`, LinkedIn's own
      // semantic hook for this exact control, independent of text/locale.
      + ' button[data-reaction-details], [data-reaction-details] button',
    )).find((el) => !inComment(el));

    if (!target) {
      // Two shapes, two length bounds. The pre-2026-08 counts row reads
      // "70 reactions 70" and stays short — 40 chars keeps the whole row
      // ("70 reactions 70 90 comments …") from matching. The 2026-08 summary
      // is a NAME list ("Anastasiia Stetsenko and 3 others reacted" — 41
      // chars, which the old bound silently rejected), so it gets room for a
      // long display name. Not every post carries the data-view-name hook;
      // this branch is what covers those.
      const hit = Array.from(root.querySelectorAll('*')).find((el) => {
        if (el.offsetParent === null) return false;
        if (inComment(el)) return false;
        if (!el.closest('a, button, [role="button"]')) return false;
        const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
        if (/\breacted$/i.test(t)) return t.length <= 160;
        return t.length <= 40 && /^\d[\d,]*\s+reactions?\b/i.test(t);
      });
      target = hit?.closest('a, button, [role="button"]') || null;
    }
    if (!target) return 'no-button';
    target.click();
    for (let i = 0; i < 10; i++) {           // the dialog mounts async
      await sleep(400);
      if (document.querySelector(sel)) return 'open';
    }
    return 'no-dialog';
  }, dialogSel);
}

// Read every reactor out of the open dialog, scrolling it until it stops
// growing. Entries are NOT list items with separate name/headline nodes any
// more: each person is a single anchor whose innerText is
// "Name • 1st Headline", so the label is returned raw and split in node by
// people.mjs/parseReactorLabel (pure, and therefore testable).
// Read the entries currently rendered in the dialog, plus the expected total
// from the "All <n>" tab — so a short read is visible instead of silent.
async function readReactorDialog(page, dialogSel) {
  return page.evaluate((sel) => {
    const dialog = document.querySelector(sel);
    if (!dialog) return { error: 'no-dialog', people: [], expected: null };
    const out = new Map();
    for (const a of dialog.querySelectorAll('a[href*="/in/"], a[href*="/company/"]')) {
      let url = a.getAttribute('href') || '';
      try {
        const u = new URL(url, 'https://www.linkedin.com');
        url = u.origin + u.pathname.replace(/\/+$/, '');
      } catch { continue; }
      if (!url || /\/(in|company)$/.test(url)) continue;
      const label = (a.innerText || '').replace(/\s+/g, ' ').trim();
      if (!label) continue;
      if (!out.has(url)) out.set(url, { url, label });
    }
    // The "All" tab carries the true total, which is what makes a short read
    // visible instead of silent. Its aria-label used to read "<n> All
    // reactions"; since 2026-08 the tab renders as text "All <n>" (the dialog
    // heads "Reactions All 2 2"). Try both, aria first.
    let expected = null;
    for (const b of dialog.querySelectorAll('button, [role="button"], [role="tab"]')) {
      const m = (b.getAttribute('aria-label') || '').match(/^(\d[\d,]*)\s+All reactions?$/i);
      if (m) { expected = parseInt(m[1].replace(/,/g, ''), 10); break; }
    }
    if (expected === null) {
      for (const b of dialog.querySelectorAll('button, [role="button"], [role="tab"]')) {
        const t = (b.innerText || '').replace(/\s+/g, ' ').trim();
        const m = t.match(/^All\s+(\d[\d,]*)$/i) || t.match(/^(\d[\d,]*)\s+All$/i);
        if (m) { expected = parseInt(m[1].replace(/,/g, ''), 10); break; }
      }
    }
    return { error: null, people: [...out.values()], expected };
  }, dialogSel);
}

/**
 * Page through the reactor list.
 *
 * The list lazy-loads ~10 entries at a time and, measured on the live dialog
 * 2026-08-17, responds very differently depending on how you ask:
 *   programmatic scrollTop  10 -> 19
 *   real mouse wheel        10 -> 58
 *   End key                    -> 68 of 70
 * So the scrolling is driven from node with real input events, not from inside
 * page.evaluate. Stops on the expected total, on the cap, or after two
 * consecutive rounds that add nobody.
 */
async function scrapeOpenReactorDialog(page, maxScrolls, maxPeople, dialogSel) {
  const box = await page.locator(dialogSel).first().boundingBox().catch(() => null);
  if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2).catch(() => {});

  let last = await readReactorDialog(page, dialogSel);
  if (last.error) return { error: last.error, people: [], expected: null };
  let stagnant = 0;

  for (let i = 0; i < maxScrolls; i++) {
    if (last.expected && last.people.length >= last.expected) break;
    if (last.people.length >= maxPeople) break;
    const before = last.people.length;
    if (box) {
      for (let w = 0; w < 3; w++) { await page.mouse.wheel(0, 900).catch(() => {}); await sleep(250); }
    }
    await page.keyboard.press('End').catch(() => {});
    await sleep(700);
    last = await readReactorDialog(page, dialogSel);
    if (last.error) break;
    stagnant = last.people.length > before ? 0 : stagnant + 1;
    if (stagnant >= 2) break;
  }

  return {
    error: null,
    expected: last.expected,
    people: last.people.slice(0, maxPeople)
      .map(({ url, label }) => ({ url, ...People.parseReactorLabel(label) })),
  };
}

// A native <dialog> closes on Escape; the close button is the fallback.
async function closeDialog(page, dialogSel) {
  await page.keyboard.press('Escape').catch(() => {});
  await sleep(400);
  const stillOpen = await page.evaluate((sel) => !!document.querySelector(sel), dialogSel).catch(() => false);
  if (!stillOpen) return;
  await page.evaluate((sel) => {
    const dlg = document.querySelector(sel);
    const btn = dlg && Array.from(dlg.querySelectorAll('button')).find((b) => {
      const al = (b.getAttribute('aria-label') || '').toLowerCase();
      return /dismiss|close/.test(al);
    });
    if (btn) btn.click();
  }, dialogSel).catch(() => {});
  await sleep(400);
}

// Locate ONE comment's DOM node by its URN, under either markup. Injected into
// the page as a source string because page.evaluate cannot close over helpers.
//
// The 2026-08 unit spells the URN `(urn:li:activity:A,B)` in its id where the
// stored form is `(activity:A,B)` — the `urn:li:` prefix is optional on BOTH
// sides, so the pattern must allow it independently or the two never meet.
// Matching is on the id PAIR, never on the string.
const FIND_COMMENT_FN = `(urn) => {
  const UNIT = 'div[id^="replaceableComment_urn:li:comment:"]';
  const PAIR = /\\((?:urn:li:)?(?:activity:)?(\\d+),(\\d+)\\)/;
  const ids = String(urn || '').match(PAIR);
  if (ids) {
    for (const u of document.querySelectorAll(UNIT)) {
      const m = (u.getAttribute('id') || '').match(PAIR);
      if (m && m[1] === ids[1] && m[2] === ids[2]) return u;
    }
  }
  return document.querySelector('article.comments-comment-entity[data-id="' + urn + '"]')
    || Array.from(document.querySelectorAll('article.comments-comment-entity'))
      .find((a) => (a.getAttribute('data-id') || '') === urn)
    || null;
}`;

// The owner's own comment lives on someone else's post. Open its reaction count.
async function openCommentReactors(page, commentUrn, dialogSel) {
  return page.evaluate(async ({ urn, sel, findSrc }) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    // eslint-disable-next-line no-new-func
    const find = new Function(`return (${findSrc})`)();
    const node = find(urn);
    if (!node) return 'no-comment';
    let target = Array.from(node.querySelectorAll('button, span[role="button"], a')).find((b) => {
      if (b.offsetParent === null) return false;
      const cls = String(b.className || '');
      const view = b.getAttribute('data-view-name') || '';
      const al = (b.getAttribute('aria-label') || '').toLowerCase();
      return /comments-comment-social-bar__reactions-count/.test(cls)
        || /reaction-count|view-likers/.test(view)
        || /reaction/.test(al);
    });
    if (!target) {
      const hit = Array.from(node.querySelectorAll('*')).find((el) => {
        if (el.offsetParent === null) return false;
        const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
        return t.length <= 40
          && (/^\d[\d,]*\s+reactions?\b/i.test(t) || /\breacted$/i.test(t))
          && !!el.closest('a, button, [role="button"]');
      });
      target = hit ? hit.closest('a, button, [role="button"]') : null;
    }
    if (!target) return 'no-button';
    target.click();
    for (let i = 0; i < 8; i++) {
      await sleep(400);
      if (document.querySelector(sel)) return 'open';
    }
    return 'no-dialog';
  }, { urn: commentUrn, sel: dialogSel, findSrc: FIND_COMMENT_FN });
}

// Expand and read the replies under the owner's own comment. Each reply carries
// its own comment URN, so replies are dated exactly.
async function scrapeCommentReplies(page, commentUrn) {
  return page.evaluate(async ({ urn, findSrc }) => {
    const UNIT = 'div[id^="replaceableComment_urn:li:comment:"]';
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    // eslint-disable-next-line no-new-func
    const find = new Function(`return (${findSrc})`)();
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();

    let node = find(urn);
    if (!node) return { error: 'no-comment', replies: [] };

    // "N replies" / "Load more replies" — click until nothing new appears.
    for (let i = 0; i < 6; i++) {
      node = find(urn);
      if (!node) break;
      const scope = node.parentElement || node;
      const btn = Array.from(scope.querySelectorAll('button')).find((b) => {
        if (b.offsetParent === null || b.disabled) return false;
        const t = (b.innerText || b.textContent || '').trim().toLowerCase();
        return /^\d+\s+repl(y|ies)$/.test(t) || /^load more replies$/.test(t)
          || /^previous replies$/.test(t) || /^see previous replies$/.test(t);
      });
      if (!btn) break;
      btn.click();
      await sleep(1200);
    }

    node = find(urn);
    if (!node) return { error: 'no-comment', replies: [] };

    // Where a reply lives, and whether we can tell it IS one.
    //
    // Legacy markup put replies in a `.comments-replies-list` container — a
    // positive signal. The 2026-08 markup sometimes nests the reply unit
    // inside its parent (also positive), but on a comment PERMALINK page it
    // renders the whole thread FLAT: measured live 2026-08-19, every unit had
    // the same parent, the same DOM depth (20) and the same left offset (397px)
    // whether it was a top-level comment or a reply. There is no structural,
    // geometric or attribute signal left to separate them.
    //
    // So when the page is flat we report `measured: false` and the caller
    // writes `null` — "not measured" — instead of `[]`. Guessing from document
    // order would fabricate repliers, and asserting "nobody replied" on a
    // thread we simply could not parse is the same class of lie that put
    // `comments: []` on 50 post files.
    const legacyScope = node.parentElement || node;
    let replyEls = Array.from(node.querySelectorAll(UNIT));
    let modern = replyEls.length > 0;
    let measured = modern;
    if (!modern) {
      const legacyContainer = legacyScope.querySelector('.comments-replies-list, .comments-comment-replies');
      replyEls = legacyContainer ? Array.from(legacyScope.querySelectorAll(
        '.comments-replies-list article.comments-comment-entity, .comments-comment-replies article.comments-comment-entity',
      )) : [];
      // A legacy container that exists but is empty IS a measurement.
      measured = !!legacyContainer
        // A modern page with no nested units at all and no legacy container:
        // if this node has no reply affordance either, there are genuinely no
        // replies to find. Otherwise we cannot tell — leave it unmeasured.
        || (document.querySelector(UNIT) === null);
    }

    const replies = [];
    for (const el of replyEls.slice(0, 100)) {
      let reply_urn = '';
      if (modern) {
        const m = (el.getAttribute('id') || '').match(/\((?:urn:li:)?(?:activity:)?(\d+),(\d+)\)/);
        if (m) reply_urn = `urn:li:comment:(activity:${m[1]},${m[2]})`;
      } else {
        reply_urn = el.getAttribute('data-id') || '';
      }
      if (!/^urn:li:comment:\(/.test(reply_urn)) continue;

      let name = '';
      let headline = '';
      let url = '';
      let text = '';
      if (modern) {
        const nestedDeeper = Array.from(el.querySelectorAll(UNIT));
        const linkEl = Array.from(el.querySelectorAll('a[href*="/in/"]'))
          .find((a) => !nestedDeeper.some((n) => n.contains(a)));
        url = linkEl?.getAttribute('href') || '';
        const lines = (linkEl?.innerText || '').split('\n').map(clean).filter(Boolean);
        name = (lines[0] || '').replace(/,\s*(Open to work|Hiring|Verified)\s*$/i, '').trim();
        const dotIdx = lines.findIndex((l) => /\s•\s/.test(l));
        headline = (dotIdx >= 0 ? lines[dotIdx + 1] : '') || '';
        const own = el.innerText || '';
        let body = linkEl && own.startsWith(linkEl.innerText) ? own.slice(linkEl.innerText.length) : own;
        for (const n of nestedDeeper) {
          const nt = n.innerText || '';
          if (nt && body.includes(nt)) body = body.replace(nt, '');
        }
        text = body.split('\n').map((l) => l.trim())
          .filter((l) => l && !/^(Like|Reply|Reply privately|…\s*more|\(edited\))$/i.test(l))
          .filter((l) => !/^\d+\s*(s|m|h|d|w|mo|yr)$/i.test(l))
          .join('\n').trim();
      } else {
        const nameEl = el.querySelector('.comments-comment-meta__description-title');
        const linkEl = el.querySelector('a.comments-comment-meta__description-container')
          || el.querySelector('a.comments-comment-meta__image-link');
        const headlineEl = el.querySelector('.comments-comment-meta__description-subtitle')
          || el.querySelector('[class*="comments-comment-meta__description-subtitle"]');
        const textEl = el.querySelector('.comments-comment-item__main-content');
        url = linkEl?.getAttribute('href') || '';
        name = clean(nameEl?.textContent);
        headline = clean(headlineEl?.textContent);
        text = (textEl?.innerText || '').trim();
      }
      try {
        const u = new URL(url, 'https://www.linkedin.com');
        url = u.origin + u.pathname;
      } catch { /* keep raw */ }
      replies.push({
        reply_urn, name, url,
        headline: headline.slice(0, 400),
        text: text.slice(0, 500),
      });
    }
    return { error: null, replies, measured };
  }, { urn: commentUrn, findSrc: FIND_COMMENT_FN });
}

function isDeadlineStop() { return /deadline/.test(breakerTripped ?? ''); }

async function phasePeople(page) {
  const attributedWeek = People.previousWeek(WEEK);
  let engagement = {};
  try { engagement = readJson(ENGAGEMENT_FILE); } catch { /* first ever run */ }
  const scannedTargets = engagement.targets ?? {};

  const entries = fs.readdirSync(POSTS_DIR)
    .filter((f) => f.endsWith('.json')).sort()
    .map((f) => {
      const file = path.join(POSTS_DIR, f);
      try { return { file, data: readJson(file) }; } catch { return null; }
    })
    .filter(Boolean);

  const peopleAll = [];
  const eventsAll = [];
  const targetRecords = [];

  // Per-week ROSTERS: who engaged, projected onto the post/comment corpus so a
  // file describes its own week without a join against engagement.json.
  // `null` means "not measured this run" — see merge.py's week_people mode.
  const rosterPosts = new Map();    // post file path -> row
  const rosterComments = new Map(); // comment urn    -> row
  const rosterRow = (m, k) => {
    if (!m.has(k)) m.set(k, { reactors: null, commenters: null });
    return m.get(k);
  };
  // People LinkedIn showed that we could not name. NOT stored — a non-zero
  // count breaks the run instead (see People.rosterUrls).
  let rosterUnresolved = 0;

  // 1. Commenters — free. The metrics phase already wrote this week's comment
  //    snapshots, and each entry now carries its own URN, so every comment
  //    LinkedIn still shows is dated exactly, right back through history.
  let commentEvents = 0;
  let commentsUndated = 0;
  let commentersRecovered = 0;
  for (const e of entries) {
    const snap = (e.data.weeks ?? {})[WEEK];
    if (!snap || !Array.isArray(snap.comments) || !e.data.urn) continue;
    const r = People.buildPostCommentEvents({ post: e.data, comments: snap.comments });
    peopleAll.push(...r.people);
    eventsAll.push(...r.events);
    commentEvents += r.events.length;
    commentsUndated += r.undated;
    // The roster keeps entries the event log skips: a comment with no URN
    // cannot be DATED, but its author still commented.
    //
    // An EMPTY array is deliberately not treated as a measurement. In a
    // snapshot it is indistinguishable from "the comment scrape came back
    // blank", which is exactly what happened to all 50 posts on 2026-08-17 —
    // writing `commenters: []` would assert "nobody commented" on that
    // evidence. Left null, so the on-page harvest below (or a later run) can
    // still fill it.
    if (!snap.comments.length) continue;
    const cr = People.rosterFromComments(snap.comments);
    rosterUnresolved += cr.unresolved;
    rosterRow(rosterPosts, e.file).commenters = cr.urls;
  }

  // 2. Reactors on in-scope posts — one paced navigation each.
  const { selected: postTargets, dropped: postsDropped } = People.selectPostTargets(entries, {
    week: WEEK, maxPosts: PEOPLE_MAX_POSTS, recentDays: PEOPLE_RECENT_DAYS, scannedTargets,
    recentOnly: PEOPLE_RECENT_ONLY,
  });
  log(`people: ${postTargets.length} post targets (${postsDropped} over the cap), `
    + `${commentEvents} comment events, attributing reactions to ${attributedWeek}`);

  let scanned = 0;
  let failed = 0;
  let reactorsSeen = 0;
  let reactorsExpected = 0;
  let reactorsShort = 0;
  let dialogFailures = 0;
  let stopped = null;

  for (const t of postTargets) {
    if (breakerTripped) { stopped = isDeadlineStop() ? 'deadline' : 'breaker'; break; }
    try {
      await pacedGotoRetry(page, t.data.post_url, null);
      await page.waitForSelector(POST_PAGE_MARKER, { timeout: 10000 })
        .catch(() => {});
      await sleep(500);

      // While we are on the page anyway: harvest the commenters ourselves.
      // Zero extra navigations, and it means the roster does not inherit an
      // empty metrics-phase comment scrape (the 2026-08-17 regression).
      if (!(rosterPosts.get(t.file)?.commenters ?? []).length) {
        try {
          const onPage = await loadAndScrapePostComments(page);
          if (onPage.length) {
            const cr = People.rosterFromComments(onPage);
            rosterUnresolved += cr.unresolved;
            rosterRow(rosterPosts, t.file).commenters = cr.urls;
            const ev = People.buildPostCommentEvents({ post: t.data, comments: onPage });
            peopleAll.push(...ev.people);
            eventsAll.push(...ev.events);
            commentEvents += ev.events.length;
            commentsUndated += ev.undated;
            commentersRecovered += cr.urls.length;
          }
        } catch (e) {
          if (e instanceof AuthError || e instanceof BreakerError || e instanceof RateLimitError) throw e;
          vlog(`people: on-page comments for ${t.data.id} failed: ${String(e.message).slice(0, 120)}`);
        }
      }

      const opened = await openPostReactors(page, DIALOG_SEL);
      if (opened !== 'open') { dialogFailures++; failed++; vlog(`people: post ${t.data.id} — ${opened}`); continue; }
      const { error, people: reactors, expected } = await scrapeOpenReactorDialog(page, 30, 500, DIALOG_SEL);
      await closeDialog(page, DIALOG_SEL);
      if (error) { dialogFailures++; failed++; continue; }
      // A short read is data loss, so surface it instead of quietly storing
      // the first page of reactors.
      // Private profiles ("LinkedIn Member") render without a link and can
      // never be identified, so a small shortfall is normal; only a real gap
      // counts as a short read.
      if (expected && reactors.length < expected * 0.9) {
        reactorsShort++;
        log(`people: post ${t.data.id} — read only ${reactors.length} of ${expected} reactors`);
      }
      if (expected) reactorsExpected += expected;
      const isBaseline = !scannedTargets[People.targetIdForPost(t.data.urn)];
      const r = People.buildPostReactionEvents({
        post: t.data, reactors, attributedWeek, isBaseline,
      });
      peopleAll.push(...r.people);
      eventsAll.push(...r.events);
      targetRecords.push({
        target_id: People.targetIdForPost(t.data.urn), target_type: 'post',
        target_urn: t.data.urn, target_url: t.data.post_url,
        week: WEEK, reactor_count: reactors.length,
      });
      const rr = People.rosterUrls(reactors, { expected });
      rosterUnresolved += rr.unresolved;
      rosterRow(rosterPosts, t.file).reactors = rr.urls;
      reactorsSeen += reactors.length;
      scanned++;
      vlog(`people: post ${t.data.id} (${t.reason}) — ${reactors.length} reactors${isBaseline ? ' [baseline]' : ''}`);
    } catch (err) {
      failed++;
      if (err instanceof AuthError) { stopped = 'auth'; break; }
      if (err instanceof BreakerError || err instanceof RateLimitError) {
        stopped = isDeadlineStop() ? 'deadline' : 'rate';
        break;
      }
      vlog(`people: post ${t.data.id} failed: ${String(err.message).slice(0, 120)}`);
    }
  }

  // 3. Reactors and repliers on the owner's OWN recent comments.
  let commentTargetsScanned = 0;
  let replyEvents = 0;
  let repliesUnmeasured = 0;
  let commentsDropped = 0;
  if (!stopped) {
    let outbound = {};
    try { outbound = readJson(COMMENTS_FILE).comments ?? {}; } catch { /* optional */ }
    const sel = People.selectCommentTargets(outbound, {
      maxComments: PEOPLE_MAX_COMMENTS, recentDays: PEOPLE_RECENT_DAYS,
    });
    commentsDropped = sel.dropped;
    for (const { comment } of sel.selected) {
      if (breakerTripped) { stopped = isDeadlineStop() ? 'deadline' : 'breaker'; break; }
      try {
        await pacedGotoRetry(page, comment.permalink, null);
        await page.waitForSelector('article.comments-comment-entity', { timeout: 10000 }).catch(() => {});
        await sleep(600);

        const replyRes = await scrapeCommentReplies(page, comment.comment_urn);
        if (!replyRes.error) {
          if (replyRes.replies.length) {
            const r = People.buildReplyEvents({
              comment, replies: replyRes.replies, selfKey: PROFILE_SLUG,
            });
            peopleAll.push(...r.people);
            eventsAll.push(...r.events);
            replyEvents += r.events.length;
          }
          // Written even when empty — a successful read of zero replies IS a
          // measurement, and [] says so where null would mean "never looked".
          // But only when the DOM could actually tell replies apart from
          // top-level comments; on a flat thread `measured` is false and the
          // side stays null rather than claiming nobody replied.
          if (replyRes.measured) {
            const cr = People.rosterFromReplies(replyRes.replies, PROFILE_SLUG);
            rosterUnresolved += cr.unresolved;
            rosterRow(rosterComments, comment.comment_urn).commenters = cr.urls;
          } else {
            repliesUnmeasured++;
          }
        }

        const opened = await openCommentReactors(page, comment.comment_urn, DIALOG_SEL);
        if (opened === 'open') {
          const { error, people: reactors, expected } = await scrapeOpenReactorDialog(page, 12, 300, DIALOG_SEL);
          await closeDialog(page, DIALOG_SEL);
          if (!error && expected) {
            reactorsExpected += expected;
            if (reactors.length < expected * 0.9) reactorsShort++;
          }
          if (!error) {
            const tid = People.targetIdForComment(comment.comment_urn);
            const isBaseline = !scannedTargets[tid];
            const r = People.buildCommentReactionEvents({
              comment, reactors, attributedWeek, isBaseline,
            });
            peopleAll.push(...r.people);
            eventsAll.push(...r.events);
            targetRecords.push({
              target_id: tid, target_type: 'comment',
              target_urn: comment.comment_urn, target_url: comment.permalink,
              week: WEEK, reactor_count: reactors.length,
            });
            const rr = People.rosterUrls(reactors, { expected });
            rosterUnresolved += rr.unresolved;
            rosterRow(rosterComments, comment.comment_urn).reactors = rr.urls;
            reactorsSeen += reactors.length;
          } else { dialogFailures++; }
        } else if (opened !== 'no-button') {
          // no-button is normal: a comment with zero reactions has no count.
          dialogFailures++;
        }
        commentTargetsScanned++;
      } catch (err) {
        failed++;
        if (err instanceof AuthError) { stopped = 'auth'; break; }
        if (err instanceof BreakerError || err instanceof RateLimitError) {
          stopped = isDeadlineStop() ? 'deadline' : 'rate';
          break;
        }
        vlog(`people: comment ${comment.comment_urn} failed: ${String(err.message).slice(0, 120)}`);
      }
    }
  }

  // 4. One write for the whole phase.
  const mergedPeople = People.mergePeople(peopleAll);
  let mergeOut = '';
  if (mergedPeople.length || eventsAll.length || targetRecords.length) {
    mergeOut = mergeViaPython({
      mode: 'engagement', path: ENGAGEMENT_FILE,
      people: mergedPeople, events: eventsAll, targets: targetRecords,
    });
    log(`people: ${mergeOut}`);
  }
  const mergeVal = (k) => (mergeOut.match(new RegExp(`${k}=(\\d+)`))?.[1] ?? '0');

  // 4b. Everyone this phase saw gets a file under dashboards/profiles/ —
  //     name, headline, link, dates. NO profile page is ever opened here
  //     (upstream, 2026-08-19); this records only what the reaction overlay and
  //     the comment cards already handed us. The store drops a write whose
  //     record is unchanged, so re-seeing the same people cannot churn git.
  let profilesWritten = 0;
  try {
    const profiles = openProfileStore(PROFILES_DIR);
    for (const p of mergedPeople) {
      if (!p.profile_url) continue; // name-only identities have no stable file
      profiles.set(profileKey(p.profile_url), p.headline, {
        name: p.name, profileUrl: p.profile_url,
      });
    }
    const res = profiles.flush();
    profilesWritten = res.written;
    if (res.failed) log(`people: ${res.failed} profile write(s) failed — ${res.errors[0]}`);
  } catch (err) {
    log(`people: profile store skipped — ${String(err.message).slice(0, 140)}`);
  }

  // 4c. The per-week rosters. AFTER the engagement merge on purpose:
  //     engagement.json is the event source of truth, and these lists are a
  //     projection of it that a rerun can always re-derive.
  // A row whose every side is null carries no measurement — sending it would
  // only rewrite files to no effect.
  const hasData = (r) => r.reactors !== null || r.commenters !== null;
  const rosterPostRows = [...rosterPosts].filter(([, r]) => hasData(r)).map(([p, r]) => ({ path: p, ...r }));
  const rosterCommentRows = [...rosterComments].filter(([, r]) => hasData(r)).map(([u, r]) => ({ comment_urn: u, ...r }));
  let rosterOut = '';
  if (rosterPostRows.length || rosterCommentRows.length) {
    rosterOut = mergeViaPython({
      mode: 'week_people', week: WEEK, comments_path: COMMENTS_FILE,
      posts: rosterPostRows, comments: rosterCommentRows,
    });
    log(`people: roster ${rosterOut}`);
  }
  const rosterVal = (k) => (rosterOut.match(new RegExp(`${k}=(\\d+)`))?.[1] ?? '0');

  // 5. ICP tiering — cached per person, so this is a no-op once steady.
  let icpClassified = 0;
  let icpPending = 0;
  if (!NO_ICP) {
    try {
      const after = readJson(ENGAGEMENT_FILE);
      const pending = Object.values(after.people ?? {}).filter(needsClassification);
      icpPending = pending.length;
      // profile_url must travel: the shared store is keyed by profileKey(url),
      // and a percent-encoded slug ("in/nimish-g%c3%a5tam-...") does not equal
      // the decoded key engagement.json holds — dropping the URL would mint a
      // SECOND profile file for the same human.
      const batch = pending.slice(0, ICP_MAX).map((p) => ({
        key: p.key, name: p.name || '', headline: p.headline || '',
        profile_url: p.profile_url || '',
      }));
      if (batch.length) {
        loadIcpText(ICP_FILE);
        const verdicts = await classifyPeople(batch);
        icpClassified = verdicts.size;
        if (verdicts.size) {
          mergeViaPython({
            mode: 'engagement', path: ENGAGEMENT_FILE,
            icp_verdicts: [...verdicts].map(([key, v]) => ({
              key, verdict: v.verdict, reason: v.reason, model: v.model,
              headline_hash: headlineHash(batch.find((b) => b.key === key)?.headline ?? ''),
            })),
          });
        }
      }
    } catch (err) {
      // An unavailable classifier is never fatal: unclassified people score at
      // the `normal` tier and a later run corrects the whole history, because
      // scores are derived at build time.
      log(`people: ICP classification skipped — ${String(err.message).slice(0, 140)}`);
    }
  }

  const rosterMissing = Number(rosterVal('MISSING'));
  const attempted = postTargets.length;
  let status = 'OK';
  if (stopped) status = stopped.toUpperCase();
  // The dialog TOLD us how many reactors there were and we read none: that is
  // drift, not a quiet week, so it escalates without waiting for a session.
  else if (attempted > 0 && scanned === 0 && dialogFailures >= attempted) status = 'SELECTOR_DRIFT';
  else if (scanned > 0 && reactorsSeen === 0 && reactorsExpected > 0) status = 'SELECTOR_DRIFT';
  else if (failed > 0 || postsDropped > 0 || commentsDropped > 0 || reactorsShort > 0
    || rosterMissing > 0) status = 'PARTIAL';

  return {
    PEOPLE_STATUS: status,
    WEEK,
    ATTRIBUTED_WEEK: attributedWeek,
    POST_TARGETS: attempted,
    POST_TARGETS_SCANNED: scanned,
    COMMENT_TARGETS_SCANNED: commentTargetsScanned,
    TARGETS_FAILED: failed,
    TARGETS_DROPPED: postsDropped + commentsDropped,
    REACTORS_SEEN: reactorsSeen,
    REACTORS_EXPECTED: reactorsExpected,
    TARGETS_SHORT_READ: reactorsShort,
    COMMENT_EVENTS: commentEvents,
    REPLY_EVENTS: replyEvents,
    COMMENTS_UNDATED: commentsUndated,
    COMMENTERS_RECOVERED: commentersRecovered,
    REPLIES_UNMEASURED: repliesUnmeasured,
    ROSTER_UNRESOLVED: rosterUnresolved,
    PEOPLE_NEW: mergeVal('PEOPLE_NEW'),
    EVENTS_NEW: mergeVal('EVENTS_NEW'),
    PROFILES_WRITTEN: profilesWritten,
    ROSTER_POSTS: rosterVal('POSTS_UPDATED'),
    ROSTER_COMMENTS: rosterVal('COMMENTS_UPDATED'),
    ROSTER_WEEKS_CREATED: rosterVal('WEEKS_CREATED'),
    ROSTER_MISSING: rosterMissing,
    REACTOR_URLS: rosterVal('REACTOR_URLS'),
    COMMENTER_URLS: rosterVal('COMMENTER_URLS'),
    ICP_PENDING: icpPending,
    ICP_CLASSIFIED: icpClassified,
    ICP_UNCLASSIFIED: Math.max(0, icpPending - icpClassified),
  };
}

// ---------------------------------------------------------------- main

const contractSections = new Map(); // section -> obj | {ERROR}

/**
 * The `[selfcheck]` section: which of the four headline counters came back
 * ZERO (upstream, 2026-08-19).
 *
 * On 2026-08-17 every post's comment array came back empty — 85 comments
 * across 50 files the week before, 0 that week — and the run exited 0,
 * auto-merged and published. Not one counter the acceptance gate reads moved.
 * A zero is the one shape a scraper produces just as happily when it is broken
 * as when the week was quiet.
 *
 * So a zero is REPORTED here and never escalated: `[selfcheck]` touches
 * neither `sev` nor the exit code, because a genuinely quiet week must still
 * exit 0 and publish. run-weekly.sh routes it to a session that can open a
 * browser and tell the two apart (references/zero-revalidation.md). That is
 * the deliberate contrast with the account canary, where zero followers can
 * never be real and therefore IS an exit-code matter.
 */
function computeSelfcheck() {
  const sectionOf = (s) => contractSections.get(s);
  // A phase that errored or was skipped is already the existing machinery's
  // problem; double-reporting it as a zero would send the session chasing a
  // failure someone else has already flagged.
  const ran = (s) => { const o = sectionOf(s); return !!o && !o.ERROR && !o.SKIPPED; };
  const out = {};
  const zero = [];
  const check = (name, section, key) => {
    if (!ran(section)) return;
    const raw = sectionOf(section)?.[key];
    if (raw === undefined || raw === '' || raw === '-') return;
    const v = Number(raw);
    if (!Number.isFinite(v)) return;
    out[key] = v;
    if (v === 0) zero.push(name);
  };
  // Non-zero DEFECTS get the same treatment as a suspicious zero: reported,
  // never escalated to an exit code, and routed to the session that can open a
  // browser and tell a real-world explanation from a broken parser.
  const anomaly = [];
  const flag = (name, section, key) => {
    if (!ran(section)) return;
    const v = Number(sectionOf(section)?.[key]);
    if (!Number.isFinite(v)) return;
    out[key] = v;
    if (v > 0) anomaly.push(name);
  };

  check('posts_new', 'posts', 'POSTS_NEW');
  check('comments_new', 'comments', 'COMMENTS_NEW');
  check('reactors', 'people', 'REACTORS_SEEN');
  // The UPSTREAM counter, not [people] COMMENT_EVENTS: the people phase merely
  // inherits an empty comment scrape, and COMMENT_EVENTS can also be 0 for the
  // unrelated reason that older snapshots carry no comment_urn.
  check('commenters', 'metrics', 'COMMENTS_SCRAPED_TOTAL');
  // A roster entry LinkedIn showed but we could not name. Expected to be 0
  // always — private members render no anchor at all, so they never even
  // reach the parser — which is exactly why a non-zero is worth breaking on
  // rather than storing as an "and N others" footnote.
  flag('roster_unresolved', 'people', 'ROSTER_UNRESOLVED');
  if (ran('people')) {
    const v = sectionOf('people')?.COMMENTER_URLS;
    if (v !== undefined) out.COMMENTER_URLS = Number(v); // cross-check, not a gate
  }
  out.PHASES_RUN = PHASES.join(',');
  out.ZERO_SIGNALS = zero.join(',') || '-';
  out.ANOMALY_SIGNALS = anomaly.join(',') || '-';
  return out;
}

function flushContracts() {
  // A selfcheck bug must never eat the contract the wrapper parses.
  try {
    const sc = computeSelfcheck();
    contractSections.set('selfcheck', sc);
    manifest.selfcheck = sc;
  } catch (e) {
    contractSections.set('selfcheck', {
      ZERO_SIGNALS: '-',
      ANOMALY_SIGNALS: '-',
      SELFCHECK_ERROR: String(e?.message || e).split('\n')[0].slice(0, 120),
    });
  }
  for (const section of ['posts', 'metrics', 'account', 'comments', 'people', 'selfcheck']) {
    const obj = contractSections.get(section);
    if (!obj) continue;
    console.log(`[${section}]`);
    for (const [k, v] of Object.entries(obj)) console.log(`${k}=${v}`);
    console.log('');
  }
}

const manifest = {
  started_at: nowIso(), week: WEEK, node: process.version,
  args: process.argv.slice(2), phases: {},
};
function manifestPhase(name, startedMs, extra) {
  manifest.phases[name] = { seconds: (Date.now() - startedMs) / 1000, ...extra };
}
function writeManifest() {
  try {
    fs.mkdirSync(path.dirname(MANIFEST_FILE), { recursive: true });
    manifest.finished_at = nowIso();
    manifest.total_seconds = (Date.now() - t0) / 1000;
    manifest.rate_trips = rateTrips;
    manifest.stop_reason = breakerTripped;
    fs.writeFileSync(MANIFEST_FILE, JSON.stringify(manifest, null, 2) + '\n');
  } catch { /* best-effort */ }
}

let context = null;
let exiting = false;
async function shutdown(code) {
  if (exiting) return;
  exiting = true;
  flushContracts();
  writeManifest();
  if (context) await context.close().catch(() => {});
  // Browserbase: звільнити хмарну сесію, інакше висить і займає слот плану.
  if (bbRelease) await bbRelease().catch(() => {});
  process.exit(code);
}
process.on('SIGTERM', () => { log('SIGTERM — shutting down'); shutdown(143); });
process.on('SIGINT', () => { log('SIGINT — shutting down'); shutdown(130); });

context = await launchBrowser();
manifest.chrome = context.browser()?.version?.() ?? 'persistent';

if (DEADLINE_SECS > 0) {
  const t = setTimeout(() => {
    log(`deadline of ${DEADLINE_SECS}s reached — stopping new work, keeping partials`);
    breakerTripped = breakerTripped || 'deadline';
  }, DEADLINE_SECS * 1000);
  t.unref();
}

// Circuit breaker: any 429 from linkedin.com trips it; navigation 403 is
// handled in pacedGoto (subresource 403s are common and benign).
context.on('response', (resp) => {
  try {
    if (resp.status() === 429 && /linkedin\.com/.test(new URL(resp.url()).hostname)) {
      const h = resp.headers()['retry-after'] || '';
      let retryAfter = parseFloat(h) || 0; // seconds form
      if (!retryAfter && h) {
        const d = Date.parse(h); // HTTP-date form
        if (!Number.isNaN(d)) retryAfter = Math.max(0, (d - Date.now()) / 1000);
      }
      noteRateLimit(resp.url(), retryAfter);
    }
  } catch { /* ignore */ }
});

if (BLOCK_ASSETS) {
  await context.route('**/*', (route) => {
    const rt = route.request().resourceType();
    if (rt === 'image' || rt === 'media' || rt === 'font') return route.abort();
    return route.continue();
  });
}

// Severity flags — the exit code is resolved from ALL of them at the end so
// a later, more severe failure can't be masked by an earlier partial one.
const sev = { auth: false, compat: false, rate: false, fs: false, unknown: false, partial: false };
function resolveExit() {
  if (sev.auth) return 20;
  if (sev.compat) return 30;
  if (sev.rate) return 22;
  if (sev.fs) return 23;
  if (sev.unknown) return 1;
  if (sev.partial) return 10;
  return 0;
}
const isDeadline = () => /deadline/.test(breakerTripped ?? '');
const fail = (section, err) => {
  if (err instanceof AuthError) {
    contractSections.set(section, { ERROR: 'AUTH' });
    sev.auth = true;
  } else if (err instanceof BreakerError) {
    contractSections.set(section, { ERROR: isDeadline() ? 'DEADLINE' : 'NETWORK' });
    if (isDeadline()) sev.partial = true; else sev.rate = true;
  } else if (/page\.goto: Timeout/.test(String(err?.message))) {
    // Slow-network phase loss (the 2026-07-20 runner signature): keep the
    // partials instead of discarding the whole snapshot as UNKNOWN/exit 1.
    // Only goto timeouts — a waitForSelector timeout can be DOM drift and
    // must keep escalating. run-weekly.sh's coverage gate keeps a hollow
    // exit 10 from passing as ok.
    contractSections.set(section, { ERROR: 'NETWORK' });
    sev.partial = true;
  } else if (err?.reason === 'COMPAT') {
    contractSections.set(section, { ERROR: 'COMPAT' });
    sev.compat = true;
  } else if (err?.reason === 'FS') {
    contractSections.set(section, { ERROR: 'FS' });
    sev.fs = true;
  } else {
    contractSections.set(section, { ERROR: err?.reason || 'UNKNOWN' });
    sev.unknown = true;
  }
  log(`${section} phase failed: ${String(err?.message).split('\n')[0]}`);
};

try {
  // Phase A: discovery (feeds the metrics file list).
  if (PHASES.includes('posts')) {
    const started = Date.now();
    const page = await context.newPage();
    try {
      const r = await phasePosts(page);
      contractSections.set('posts', r);
      manifestPhase('posts', started, r);
    } catch (e) {
      fail('posts', e);
      if (e instanceof AuthError || e instanceof BreakerError) await shutdown(resolveExit());
    } finally {
      await page.close().catch(() => {});
    }
  }

  // Phase C (account) runs ALONE, before the metrics pool opens: its audience
  // demographics parsing proved concurrency-sensitive — six empty groups on
  // every concurrent run (2026-07-13/20) vs healthy rows on every sequential
  // run before, same parser. Costs ~21s of wall-clock; deadline headroom ~5x.
  let accountOk = true;
  if (PHASES.includes('account')) {
    const started = Date.now();
    const page = await context.newPage();
    try {
      const r = await phaseAccount(page);
      contractSections.set('account', r);
      manifestPhase('account', started, r);
      if (r.PAGES_FAILED !== '-') sev.partial = true;
    } catch (e) {
      accountOk = false;
      fail('account', e);
    } finally {
      await page.close().catch(() => {});
    }
  }

  // Phase B (metrics) ∥ D (comments); D strictly after C succeeds — mirrors
  // the sequential skill's "account ERROR stops comments-out".
  const metricsTask = PHASES.includes('metrics')
    ? (async () => {
        const started = Date.now();
        try {
          const r = await phaseMetrics(context);
          contractSections.set('metrics', r);
          manifestPhase('metrics', started, r);
          if (r.POSTS_FAILED > 0 || r.POSTS_UNPROCESSED > 0) sev.partial = true;
          if (r.POSTS_UNPROCESSED > 0 && breakerTripped && !isDeadline()) sev.rate = true;
        } catch (e) { fail('metrics', e); }
      })()
    : Promise.resolve();

  const commentsTask = (async () => {
    if (!PHASES.includes('comments')) return;
    if (!accountOk) {
      contractSections.set('comments', { SKIPPED: 'account_failed' });
      return;
    }
    const started = Date.now();
    const page = await context.newPage();
    try {
      const r = await phaseCommentsOut(page);
      contractSections.set('comments', r);
      manifestPhase('comments', started, r);
    } catch (e) { fail('comments', e); }
    finally { await page.close().catch(() => {}); }
  })();

  await Promise.all([metricsTask, commentsTask]);

  // Phase E (people) runs LAST and ALONE: it reads the post snapshots the
  // metrics phase just wrote and the comments.json the comments phase just
  // merged, and its navigations should never compete with theirs for the
  // shared rate budget. Advisory — see the phase header: it can mark the run
  // partial, but it never sets ERROR= and never escalates past exit 10.
  if (PHASES.includes('people')) {
    const started = Date.now();
    const page = await context.newPage();
    try {
      const r = await phasePeople(page);
      contractSections.set('people', r);
      manifestPhase('people', started, r);
      if (r.PEOPLE_STATUS !== 'OK') sev.partial = true;
    } catch (e) {
      // Deliberately not fail(): no ERROR= line, no severity escalation
      // beyond partial. A brand-new phase must not be able to demote a run
      // whose metrics and account data are perfectly good.
      contractSections.set('people', {
        PEOPLE_STATUS: 'FAILED',
        REASON: String(e?.reason || e?.message || 'UNKNOWN').split('\n')[0].slice(0, 160),
      });
      manifestPhase('people', started, { failed: true });
      sev.partial = true;
      log(`people phase failed (advisory): ${String(e?.message).split('\n')[0]}`);
    } finally {
      await page.close().catch(() => {});
    }
  }
} catch (e) {
  if (e instanceof AuthError) sev.auth = true;
  else if (e instanceof BreakerError) { if (isDeadline()) sev.partial = true; else sev.rate = true; }
  else { console.error(e); sev.unknown = true; }
}

const exitCode = resolveExit();
log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s, exit ${exitCode}`);
await shutdown(exitCode);
