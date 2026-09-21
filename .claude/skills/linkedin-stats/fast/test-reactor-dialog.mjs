#!/usr/bin/env node
// Browser suite for the reactor overlay (reactor-dialog.mjs): the REAL
// scrapeOpenReactorDialog, driven in headless Chromium against a local page
// that behaves like LinkedIn's "who reacted" dialog.
// Run: node .claude/skills/linkedin-stats/fast/test-reactor-dialog.mjs
//
// Nothing leaves 127.0.0.1: the fixture is served by a throwaway node:http
// server on a random port, its people are invented ("Test Person N"), and
// their profile links are never followed. No install step either — it uses the
// Chromium playwright-core expects, else any headless shell already in the
// Playwright cache, else the local Google Chrome.
//
// Why a browser and not a pure test: the 2026-09-21 loss was a TIMING bug. The
// dialog shell mounted, the list inside had not rendered yet, the loop read it
// at once, gave up two quiet rounds (~3 s) later and stored "nobody reacted".
// The patience rules are pure (people.mjs/reactorScrollDecision, covered in
// test-people.mjs); whether the loop around them waits long enough, and stops
// soon enough, only shows against a list that really loads late.
//
// Every scenario asserts what was read, why the read stopped, and how long it
// took. Where "before" matters, the same fixture is also read by the loop as
// it stood before the change (legacyScrapeOpenReactorDialog, below), so the
// suite shows the old failure next to the new behaviour. Scenarios run
// concurrently, each in its own browser context, so the suite costs about one
// dialog budget of wall-clock, not the sum of them.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import * as People from './people.mjs';

// The two limits are read once, when reactor-dialog.mjs loads, so they are set
// BEFORE the dynamic import below. The paging round itself (3 wheel ticks +
// End + 700 ms, ~1.5 s) and the 500 ms settle poll are fixed in the code and
// cannot be scaled, so the fixture is timed around them:
//   - settle 7 s: the 2026-09-21 shape needs its first page to land at ~60% of
//     the window AND after the old loop's ~3 s had given up (0.6 x 7 = 4.2 s);
//   - budget 16 s: above the ~12 s the slow-paging list needs, low enough that
//     the budget scenario ends in reasonable time.
const SETTLE_MS = 7000;
const BUDGET_MS = 16000;
process.env.LI_REACTOR_SETTLE_MS = String(SETTLE_MS);
process.env.LI_REACTOR_DIALOG_BUDGET_MS = String(BUDGET_MS);
const R = await import('./reactor-dialog.mjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SETTLE = SETTLE_MS / 1000;
const BUDGET = BUDGET_MS / 1000;
// One paging round: 3 x (wheel + 250 ms) + End + 700 ms + a page.evaluate.
// The sleeps alone are 1.45 s — a hard floor; the input and evaluate calls add
// a little, more while a dozen pages run at once. Bounds are written in
// rounds: lower bounds with the floor, upper bounds with the slow case.
const ROUND_MIN = 1.45;
const ROUND_MAX = 2.2;

// The loop as it stood before the settle wait and the patience rules (commit
// 589c2c8), verbatim but for the name — the oracle for "the old code would
// have read …". It shares readReactorDialog, which the change did not touch.
async function legacyScrapeOpenReactorDialog(page, maxScrolls, maxPeople, dialogSel) {
  const box = await page.locator(dialogSel).first().boundingBox().catch(() => null);
  if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2).catch(() => {});

  let last = await R.readReactorDialog(page, dialogSel);
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
    last = await R.readReactorDialog(page, dialogSel);
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

// ---------------------------------------------------------------------------
// The fixture: one page, shaped by its query string.
//   n         entries the list holds ("inf" = never ends)
//   total     announced total in an "All <n>" tab; absent = no tab at all
//   tab       "aria" (aria-label "<n> All reactions") or "text" ("All <n>")
//   first     ms until the first page renders ("never" = it never does)
//   needInput "any" | "wheel": the first page waits for that input event
//   page1     size of the first page (10)
//   step      entries each later page adds (10)
//   delay     ms each later page takes to arrive after the scroll asked for it
//   priv      1-based entries rendered WITHOUT a link (private profiles)
//   stallAt   the list never grows past this many entries (a permanent gap)
//   closeAt   ms after mount at which the dialog is removed from the page
//   clearAt   ms after mount at which the list is emptied and stops loading
//   noEscape  1 = Escape does not close it; only the Dismiss button does
// Nothing renders until window.__mount() — the click that opens the dialog —
// so every timer counts from the moment the shell appears, as it does live.
// The dialog is modal (showModal), so it stays put under the mouse while the
// wheel scrolls, and closing it unmounts it, as LinkedIn's does.
const FIXTURE = `<!doctype html>
<html><head><meta charset="utf-8"><title>reactor dialog fixture</title>
<style>
  body { margin: 0; font: 14px sans-serif; height: 2000px; }
  dialog { width: 480px; height: 420px; padding: 0; }
  .list { list-style: none; margin: 0; padding: 0 12px; height: 340px; overflow-y: auto; }
  .list li { height: 48px; }
</style></head>
<body><main><p>A post body.</p></main>
<script>
  const q = new URLSearchParams(location.search);
  const num = (k, d) => {
    if (!q.has(k)) return d;
    const v = q.get(k);
    return v === 'inf' || v === 'never' ? Infinity : Number(v);
  };
  const N = num('n', 0);
  const TOTAL = q.get('total');
  const TAB = q.get('tab') || 'aria';
  const FIRST = num('first', 0);
  const NEED = q.get('needInput');
  const PAGE1 = num('page1', 10);
  const STEP = num('step', 10);
  const DELAY = num('delay', 150);
  const PRIV = new Set((q.get('priv') || '').split(',').filter(Boolean).map(Number));
  const STALL = num('stallAt', Infinity);
  const CLOSE = num('closeAt', Infinity);
  const CLEAR = num('clearAt', Infinity);
  const NO_ESCAPE = q.get('noEscape') === '1';

  window.__mount = () => {
    const dlg = document.createElement('dialog');
    dlg.setAttribute('data-testid', 'dialog');
    let tab = '';
    if (TOTAL !== null) {
      tab = TAB === 'text'
        ? '<button role="tab"><span>All</span> <span>' + TOTAL + '</span></button>'
        : '<button role="tab" aria-label="' + TOTAL + ' All reactions">All ' + TOTAL + '</button>';
    }
    dlg.innerHTML = '<header><h2>Reactions</h2><div>' + tab
      + '<button role="tab" aria-label="Like">Like</button></div>'
      + '<button aria-label="Dismiss">x</button></header><ul class="list"></ul>';
    document.body.appendChild(dlg);
    dlg.showModal();
    dlg.addEventListener('close', () => dlg.remove());
    if (NO_ESCAPE) dlg.addEventListener('cancel', (e) => e.preventDefault());
    dlg.querySelector('[aria-label="Dismiss"]').addEventListener('click', () => dlg.close());
    const list = dlg.querySelector('.list');

    let rendered = 0;
    let loading = false;
    let cleared = false;
    let started = !NEED;
    const cap = Math.min(N, STALL);
    const append = (k) => {
      const to = Math.min(cap, rendered + k);
      for (let i = rendered + 1; i <= to; i++) {
        const li = document.createElement('li');
        li.innerHTML = PRIV.has(i)
          ? '<span>LinkedIn Member</span>'
          : '<a href="https://www.linkedin.com/in/test-person-' + i + '">Test Person ' + i
            + ' <span>\\u2022</span> 2nd Invented headline ' + i + '</a>';
        list.appendChild(li);
      }
      rendered = to;
    };
    const later = (k, ms) => {
      loading = true;
      setTimeout(() => { if (dlg.isConnected && !cleared) append(k); loading = false; }, ms);
    };
    // A scroll asks for the next page. One request in flight at a time, and
    // nothing to ask for before the first page exists.
    const more = (kind) => {
      if (cleared) return;
      if (!started) {
        if (NEED === 'any' || NEED === kind) { started = true; later(PAGE1, DELAY); }
        return;
      }
      if (rendered === 0 || loading || rendered >= cap) return;
      later(STEP, DELAY);
    };
    dlg.addEventListener('wheel', () => more('wheel'), { passive: true });
    document.addEventListener('keydown', (e) => { if (e.key === 'End') more('end'); });

    if (started && FIRST !== Infinity) {
      if (FIRST === 0) append(PAGE1);
      else setTimeout(() => append(PAGE1), FIRST);
    }
    if (CLOSE !== Infinity) setTimeout(() => dlg.remove(), CLOSE);
    if (CLEAR !== Infinity) setTimeout(() => { cleared = true; list.innerHTML = ''; }, CLEAR);
  };
</script></body></html>`;

function startServer() {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/dialog')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(FIXTURE);
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// The Chromium this playwright-core expects, else a headless shell of another
// revision already in the Playwright cache, else the local Google Chrome.
function cachedExecutables() {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || (process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright')
    : path.join(os.homedir(), '.cache', 'ms-playwright'));
  let dirs = [];
  try { dirs = fs.readdirSync(root); } catch { return []; }
  const rev = (d) => Number((d.match(/-(\d+)$/) || [])[1] || 0);
  const out = [];
  for (const d of dirs.filter((x) => /^chromium_headless_shell-\d+$/.test(x)).sort((a, b) => rev(b) - rev(a))) {
    for (const sub of ['chrome-headless-shell-mac-arm64', 'chrome-headless-shell-mac-x64',
      'chrome-headless-shell-linux64', 'chrome-headless-shell-linux-arm64']) {
      out.push(path.join(root, d, sub, 'chrome-headless-shell'));
    }
  }
  for (const d of dirs.filter((x) => /^chromium-\d+$/.test(x)).sort((a, b) => rev(b) - rev(a))) {
    out.push(path.join(root, d, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'));
    out.push(path.join(root, d, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'));
    out.push(path.join(root, d, 'chrome-linux64', 'chrome'));
    out.push(path.join(root, d, 'chrome-linux', 'chrome'));
  }
  return out.filter((p) => fs.existsSync(p));
}

async function launchBrowser() {
  const attempts = [
    ['expected revision', { headless: true }],
    ...cachedExecutables().map((exe) => [exe, { headless: true, executablePath: exe }]),
    ['channel chrome', { headless: true, channel: 'chrome' }],
  ];
  const errors = [];
  for (const [label, opts] of attempts) {
    try {
      const browser = await chromium.launch(opts);
      return { browser, label };
    } catch (err) {
      errors.push(`${label}: ${String(err.message).split('\n')[0]}`);
    }
  }
  throw new Error(`no browser could be launched:\n  ${errors.join('\n  ')}`);
}

// ---------------------------------------------------------------------------

const server = await startServer();
const BASE = `http://127.0.0.1:${server.address().port}`;
let browser;
let failures = 0;
const rows = [];

// Read one fixture with one loop. Resolves with what the loop returned (or
// threw), its wall-clock seconds, and — with `close` — whether closeDialog
// left the dialog on the page.
async function read(loop, query, {
  maxScrolls = 30, maxPeople = 500, knownCount = 0, close = false, patienceMs, shouldStop,
} = {}) {
  const context = await browser.newContext({ viewport: { width: 900, height: 700 } });
  const page = await context.newPage();
  try {
    await page.goto(`${BASE}/dialog?${query}`);
    await page.evaluate(() => window.__mount());
    const t0 = Date.now();
    let res = null;
    let threw = null;
    try {
      res = await loop(page, maxScrolls, maxPeople, R.DIALOG_SEL, { knownCount, patienceMs, shouldStop });
    } catch (err) {
      threw = err;
    }
    const secs = (Date.now() - t0) / 1000;
    let stillOpen = null;
    if (close && !threw) {
      await R.closeDialog(page, R.DIALOG_SEL);
      stillOpen = await page.evaluate((sel) => !!document.querySelector(sel), R.DIALOG_SEL);
    }
    return { res, threw, secs, stillOpen };
  } finally {
    await context.close().catch(() => {});
  }
}

const within = (secs, lo, hi, what) => assert.ok(secs >= lo && secs <= hi,
  `${what}: took ${secs.toFixed(2)}s, expected ${lo.toFixed(2)}–${hi.toFixed(2)}s`);

// name, the reads to run (all concurrently), and the checks over them.
const NEW = (...a) => read(R.scrapeOpenReactorDialog, ...a);
const OLD = (...a) => read(legacyScrapeOpenReactorDialog, ...a);
// What the caller makes of a read (scrape-weekly.mjs does exactly this).
const verdict = (res, known = 0, scannedBefore = known > 0) => People.reactorReadVerdict({
  got: res.people.length, announced: res.expected, known, stop: res.stop, scannedBefore,
});
// A caller's shouldStop for a deadline `ms` after the loop first asks — so
// the page load before the read, slower while a dozen run at once, does not
// eat into it.
const deadlineIn = (ms) => {
  let at = null;
  return () => {
    if (at === null) at = Date.now() + ms;
    return Date.now() >= at ? 'deadline' : null;
  };
};

// One author's people phase in miniature: `n` dialogs read one after another,
// the way phasePeople reads its targets, each sized by the same
// People.reactorPatienceMs call phasePeople makes — with the per-target cost
// floor set to this fixture's pre-change cost instead of the production 45 s.
// mode 'bounded' = the fix, 'unbounded' = full patience (the reviewed change),
// 'old' = the pre-change loop.
async function authorRun(mode, query, { n, deadlineMs, costFloorMs, knownCount }) {
  const start = Date.now();
  const deadlineAt = start + deadlineMs;
  const reads = [];
  try {
    for (let k = 0; k < n; k++) {
      const avg = k > 0 ? (Date.now() - start) / k : 0;
      const patienceMs = People.reactorPatienceMs({
        nowMs: Date.now(), deadlineAtMs: deadlineAt, targetsLeft: n - k, perTargetMs: Math.max(costFloorMs, avg),
      });
      const shouldStop = () => (Date.now() >= deadlineAt ? 'deadline' : null);
      const r = mode === 'old'
        ? await OLD(query, { knownCount })
        : await NEW(query, mode === 'bounded' ? { knownCount, patienceMs, shouldStop } : { knownCount });
      if (r.threw) throw r.threw;
      reads.push({ ...r, patienceMs });
    }
  } catch (err) {
    return { res: reads, secs: (Date.now() - start) / 1000, threw: err };
  }
  return { res: reads, secs: (Date.now() - start) / 1000 };
}

// The two limits are read when the module loads, so each env combination
// needs its own process. Async on purpose: a blocking spawn would stall the
// event loop the concurrent browser scenarios are being timed on.
async function envProbe() {
  const t0 = Date.now();
  const modUrl = new URL('./reactor-dialog.mjs', import.meta.url).href;
  const code = `const R = await import(${JSON.stringify(modUrl)});`
    + 'console.log(JSON.stringify([R.REACTOR_LIST_SETTLE_MS, R.REACTOR_DIALOG_BUDGET_MS]));';
  const run = (settle, budget) => new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.LI_REACTOR_SETTLE_MS;
    delete env.LI_REACTOR_DIALOG_BUDGET_MS;
    if (settle !== undefined) env.LI_REACTOR_SETTLE_MS = settle;
    if (budget !== undefined) env.LI_REACTOR_DIALOG_BUDGET_MS = budget;
    execFile(process.execPath, ['--input-type=module', '-e', code], { env, timeout: 15000 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(JSON.parse(String(stdout).trim()));
    });
  });
  try {
    const [defaults, zero, junk, settleOverBudget, valid] = await Promise.all([
      run(undefined, undefined), run('0', '0'), run('abc', 'abc'), run('25000', '10000'), run('4000', '30000'),
    ]);
    return { res: { defaults, zero, junk, settleOverBudget, valid }, secs: (Date.now() - t0) / 1000 };
  } catch (err) {
    return { res: null, secs: (Date.now() - t0) / 1000, threw: err };
  }
}

const scenarios = [
  {
    name: 'a) fast list, 25 announced: all 25, complete, no slower than before',
    reads: { now: () => NEW('n=25&total=25&tab=text&delay=150'), old: () => OLD('n=25&total=25&tab=text&delay=150') },
    check({ now, old }) {
      assert.equal(now.res.people.length, 25);
      assert.equal(now.res.stop, 'complete');
      assert.equal(now.res.expected, 25);
      assert.deepEqual(now.res.people[0], {
        url: 'https://www.linkedin.com/in/test-person-1', name: 'Test Person 1', headline: 'Invented headline 1',
      });
      assert.equal(old.res.people.length, 25);
      within(now.secs, 0, 2 * ROUND_MAX + 0.6, 'new');
      assert.ok(now.secs <= old.secs + 0.5, `new ${now.secs}s vs old ${old.secs}s — waited longer than before`);
      return { secs: now.secs, note: `old ${old.secs.toFixed(1)}s` };
    },
  },
  {
    name: 'b) 2026-09-21 shape: first page at 60% of settle, 14, no total, known 14 -> 14 (old loop: 0)',
    reads: {
      now: () => NEW(`n=14&first=${SETTLE_MS * 0.6}&delay=300`, { knownCount: 14 }),
      old: () => OLD(`n=14&first=${SETTLE_MS * 0.6}&delay=300`),
    },
    check({ now, old }) {
      assert.equal(now.res.error, null);
      assert.equal(now.res.expected, null, 'the fixture announces no total');
      assert.equal(now.res.people.length, 14);
      // The known 14 is not a stop: the list ends on its own two quiet rounds.
      assert.equal(now.res.stop, 'stagnant');
      assert.deepEqual(verdict(now.res, 14), { short: false, record: true });
      // First page + the round that brings 14 + two quiet ones.
      within(now.secs, SETTLE * 0.6 + 3 * ROUND_MIN - 0.3, SETTLE * 0.6 + 0.6 + 3 * ROUND_MAX + 0.6, 'new');
      // The regression, reproduced: the old loop gave up before the list rendered.
      assert.equal(old.res.error, null);
      assert.equal(old.res.people.length, 0, 'the old loop should have read nobody');
      within(old.secs, 0, 2 * ROUND_MAX + 0.6, 'old');
      return { secs: now.secs, note: `old read ${old.res.people.length} in ${old.secs.toFixed(1)}s` };
    },
  },
  {
    name: 'c) never renders: [] never-rendered after the settle window, not the budget; short, not recorded if new',
    reads: {
      now: () => NEW('n=14&first=never', { knownCount: 14 }),
      fresh: () => NEW('n=14&first=never'),
    },
    check({ now, fresh }) {
      assert.equal(now.res.error, null);
      assert.equal(now.res.people.length, 0);
      assert.equal(now.res.stop, 'never-rendered');
      // A poll starts only if it ends inside the window, so it ends up to one
      // poll early, never late by more than the last evaluate.
      within(now.secs, SETTLE - 0.6, SETTLE + 1, 'new');
      assert.ok(now.secs < BUDGET, 'must not spend the dialog budget on an empty list');
      // A target we knew had 14: short, recorded, re-read next run.
      assert.deepEqual(verdict(now.res, 14), { short: true, record: true });
      // A first-ever target: isShortRead alone called this complete and it
      // was stored as "nobody reacted". Now short, and no record is written.
      assert.equal(fresh.res.stop, 'never-rendered');
      assert.deepEqual(verdict(fresh.res, 0, false), { short: true, record: false });
      return { secs: now.secs };
    },
  },
  {
    name: 'd) slow paging (3.5 s per page), 40 announced: 40 (old loop: stopped at 10)',
    reads: {
      now: () => NEW('n=40&total=40&delay=3500'),
      old: () => OLD('n=40&total=40&delay=3500'),
    },
    check({ now, old }) {
      assert.equal(now.res.people.length, 40);
      assert.equal(now.res.stop, 'complete');
      within(now.secs, 3 * 3.5, BUDGET, 'new');
      assert.equal(old.res.people.length, 10, 'the old two-quiet-rounds rule should stop at the first page');
      return { secs: now.secs, note: `old read ${old.res.people.length} in ${old.secs.toFixed(1)}s` };
    },
  },
  {
    name: 'd2) limit: a page slower than 5 quiet rounds (12 s) is still cut short',
    reads: { now: () => NEW('n=40&total=40&delay=12000') },
    check({ now }) {
      // Documented, not desired: patience below the target is 5 quiet rounds
      // (7-8 s locally, longer through a remote browser). A page slower than
      // that ends the read as 'stagnant'; the short read is then flagged and
      // re-read next run.
      assert.equal(now.res.people.length, 10);
      assert.equal(now.res.stop, 'stagnant');
      within(now.secs, 5 * ROUND_MIN - 0.3, 5 * ROUND_MAX + 1, 'new');
      return { secs: now.secs };
    },
  },
  {
    name: 'e) private profiles: 28 announced, 20 linked -> 20, stagnant after the below-target patience',
    reads: {
      now: () => NEW('n=28&total=28&delay=200&priv=3,6,9,12,15,18,21,24'),
      old: () => OLD('n=28&total=28&delay=200&priv=3,6,9,12,15,18,21,24'),
    },
    check({ now, old }) {
      assert.equal(now.res.people.length, 20);
      assert.equal(now.res.expected, 28);
      assert.equal(now.res.stop, 'stagnant');
      // 1 round that grows + 5 quiet ones — bounded, not endless.
      within(now.secs, 6 * ROUND_MIN - 0.4, Math.min(7 * ROUND_MAX, BUDGET), 'new');
      assert.equal(old.res.people.length, 20);
      return { secs: now.secs, note: `old ${old.secs.toFixed(1)}s, +${(now.secs - old.secs).toFixed(1)}s patience` };
    },
  },
  {
    name: 'f) endless trickle (+1 per scroll): stops at the dialog budget',
    reads: { now: () => NEW('n=inf&step=1&delay=100') },
    check({ now }) {
      assert.equal(now.res.error, null);
      assert.equal(now.res.stop, 'budget');
      assert.ok(now.res.people.length > 10, `kept growing (${now.res.people.length})`);
      // The budget is checked before each round, so it can overrun by one round.
      within(now.secs, BUDGET, BUDGET + ROUND_MAX + 1, 'new');
      return { secs: now.secs, note: `${now.res.people.length} read` };
    },
  },
  {
    name: 'g) no total, known 0, 7 entries: 7 after two quiet rounds, as before',
    reads: { now: () => NEW('n=7'), old: () => OLD('n=7') },
    check({ now, old }) {
      assert.equal(now.res.people.length, 7);
      assert.equal(now.res.stop, 'stagnant');
      assert.equal(old.res.people.length, 7);
      within(now.secs, 2 * ROUND_MIN - 0.3, 2 * ROUND_MAX + 0.8, 'new');
      assert.ok(Math.abs(now.secs - old.secs) <= 0.6, `new ${now.secs}s vs old ${old.secs}s`);
      return { secs: now.secs, note: `old ${old.secs.toFixed(1)}s` };
    },
  },
  {
    name: 'h) dialog removed mid-read: returns, does not throw',
    reads: { now: () => NEW('n=40&total=40&delay=3500&closeAt=2600') },
    check({ now }) {
      assert.ok(now.res, 'returned a result');
      within(now.secs, 2 * ROUND_MIN - 0.3, 2 * ROUND_MAX + 0.8, 'new');
      return { secs: now.secs, note: `error=${now.res.error} people=${now.res.people.length} stop=${now.res.stop}` };
    },
  },
  {
    name: 'h\') dialog removed mid-read: the 10 already read and the total 40 are kept, flagged short (old loop: 0)',
    reads: {
      now: () => NEW('n=40&total=40&delay=3500&closeAt=2600'),
      fresh: () => NEW('n=40&delay=3500&closeAt=2600'),
      old: () => OLD('n=40&total=40&delay=3500&closeAt=2600'),
    },
    check({ now, fresh, old }) {
      // 10 people were on screen before the dialog went away. Returning
      // error:null with people:[] is exactly "we looked and nobody reacted" —
      // the false negative this change exists to stop.
      const res = now.res;
      assert.equal(res.error, null);
      assert.equal(res.people.length, 10,
        `got people=${res.people.length} stop=${res.stop}: a closed dialog became a read of fewer people`);
      assert.equal(res.stop, 'dialog-closed');
      assert.equal(res.expected, 40, 'the total the dialog announced survives it closing');
      assert.deepEqual(verdict(res, 0, false), { short: true, record: true });
      // No total and no history: only the stop says the read was cut short.
      assert.equal(fresh.res.people.length, 10);
      assert.equal(fresh.res.stop, 'dialog-closed');
      assert.equal(People.isShortRead({ got: 10, announced: null, known: 0 }), false, 'the number alone looks complete');
      assert.deepEqual(verdict(fresh.res, 0, false), { short: true, record: true });
      // The pre-change loop lost them.
      assert.equal(old.res.people.length, 0);
      return { secs: now.secs, note: `old read ${old.res.people.length}` };
    },
  },
  {
    name: 'h3) list emptied mid-read (re-render): keeps the 10, ends on quiet rounds, not the budget',
    reads: { now: () => NEW('n=40&total=40&delay=3500&clearAt=2600') },
    check({ now }) {
      // Before: the loop's count dropped to 0, an empty list was "never done",
      // and it scrolled until the budget, returning [] as never-rendered.
      assert.equal(now.res.people.length, 10);
      assert.equal(now.res.expected, 40);
      assert.equal(now.res.stop, 'stagnant');
      within(now.secs, 5 * ROUND_MIN - 0.3, 5 * ROUND_MAX + 1, 'new');
      assert.ok(now.secs < BUDGET - 3, 'must not wait out the dialog budget');
      assert.deepEqual(verdict(now.res), { short: true, record: true });
      return { secs: now.secs };
    },
  },
  {
    name: 'h2) dialog removed before the list rendered: error no-dialog, promptly',
    reads: { now: () => NEW('n=14&first=never&closeAt=1200', { knownCount: 14 }) },
    check({ now }) {
      assert.equal(now.res.error, 'no-dialog');
      assert.equal(now.res.stop, 'no-dialog');
      assert.equal(now.res.people.length, 0);
      // The removal timer starts at mount, a moment before the loop's clock,
      // so the lower bound gives it that moment back. The point is the upper
      // one: the next 500 ms poll sees the dialog gone and returns.
      within(now.secs, 0.9, 2.4, 'new');
      return { secs: now.secs };
    },
  },
  {
    name: 'i) list that waits for input: the End nudge at half the settle window starts it',
    reads: { now: () => NEW('n=12&total=12&needInput=any&delay=300') },
    check({ now }) {
      assert.equal(now.res.people.length, 12);
      assert.equal(now.res.stop, 'complete');
      within(now.secs, SETTLE / 2, SETTLE / 2 + 1 + 2 * ROUND_MAX + 0.6, 'new');
      return { secs: now.secs };
    },
  },
  {
    name: 'j) list really shrank (known 14, now 10, no total): 10 after the below-target patience',
    reads: {
      now: () => NEW('n=14&stallAt=10', { knownCount: 14 }),
      old: () => OLD('n=14&stallAt=10'),
    },
    check({ now, old }) {
      // Reactions do get withdrawn. With no announced total the stored count
      // is the only target, so a list that is genuinely shorter now costs the
      // 5-round patience before it is accepted — bounded, and the same 10.
      assert.equal(now.res.people.length, 10);
      assert.equal(now.res.stop, 'stagnant');
      assert.equal(old.res.people.length, 10);
      within(now.secs, 5 * ROUND_MIN - 0.3, 5 * ROUND_MAX + 1, 'new');
      return { secs: now.secs, note: `old ${old.secs.toFixed(1)}s, +${(now.secs - old.secs).toFixed(1)}s patience` };
    },
  },
  {
    name: 'l) list grew since the last read (known 7, now 30, no total): all 30, not cut at the stored count',
    reads: {
      now: () => NEW('n=30', { knownCount: 7 }),
      big: () => NEW('n=60', { knownCount: 1 }),
      old: () => OLD('n=30'),
    },
    check({ now, big, old }) {
      // Before: the stored 7 was a STOP — 10 read, 'complete', zero rounds,
      // and isShortRead(10, -, 7) is false, so 10 of 30 was stored as a
      // complete read and published green.
      assert.equal(now.res.people.length, 30);
      assert.equal(now.res.stop, 'stagnant');
      assert.deepEqual(verdict(now.res, 7), { short: false, record: true });
      assert.equal(big.res.people.length, 60);
      assert.equal(old.res.people.length, 30);
      // Growing past the known count costs nothing extra: the old two quiet rounds.
      assert.ok(Math.abs(now.secs - old.secs) <= 0.8, `new ${now.secs}s vs old ${old.secs}s`);
      return { secs: now.secs, note: `old ${old.secs.toFixed(1)}s; 60 of 60 in ${big.secs.toFixed(1)}s` };
    },
  },
  {
    name: 'l2) comment path (12 rounds, cap 300): known 4, now 18 -> 18',
    reads: { now: () => NEW('n=18', { knownCount: 4, maxScrolls: 12, maxPeople: 300 }) },
    check({ now }) {
      assert.equal(now.res.people.length, 18);
      assert.equal(now.res.stop, 'stagnant');
      return { secs: now.secs };
    },
  },
  {
    name: 'm) deadline passes mid-read (endless trickle): stops at once with what it has, flagged short',
    reads: { now: () => NEW('n=inf&step=1&delay=100', { shouldStop: deadlineIn(3000) }) },
    check({ now }) {
      assert.equal(now.res.stop, 'deadline');
      assert.ok(now.res.people.length >= 10, `kept what was read (${now.res.people.length})`);
      // Checked before every round: at most one round past it, not the budget.
      within(now.secs, 3, 3 + ROUND_MAX + 0.5, 'new');
      assert.deepEqual(verdict(now.res), { short: true, record: true });
      return { secs: now.secs, note: `${now.res.people.length} read` };
    },
  },
  {
    name: 'm2) deadline passes during the settle wait: stops at the next poll, not the settle window',
    reads: { now: () => NEW('n=14&first=never', { knownCount: 14, shouldStop: deadlineIn(2000) }) },
    check({ now }) {
      assert.equal(now.res.error, null);
      assert.equal(now.res.stop, 'deadline');
      assert.equal(now.res.people.length, 0);
      within(now.secs, 1.9, 2.8, 'new');
      assert.deepEqual(verdict(now.res, 14), { short: true, record: true });
      assert.deepEqual(verdict(now.res, 0, false), { short: true, record: false });
      return { secs: now.secs };
    },
  },
  {
    name: 'n) no spare time (patience 0): the pre-change loop exactly — same reads, same time',
    reads: {
      now: () => NEW(`n=14&first=${SETTLE_MS * 0.6}&delay=300`, { knownCount: 14, patienceMs: 0 }),
      lateOld: () => OLD(`n=14&first=${SETTLE_MS * 0.6}&delay=300`),
      slow: () => NEW('n=40&total=40&delay=3500', { patienceMs: 0 }),
      slowOld: () => OLD('n=40&total=40&delay=3500'),
      fast: () => NEW('n=25&total=25&delay=150', { patienceMs: 0 }),
    },
    check({ now, lateOld, slow, slowOld, fast }) {
      // With nothing spare the loop buys nothing extra — including the
      // failure it was written to fix, which is then flagged short instead
      // of stored as "nobody".
      assert.equal(now.res.people.length, lateOld.res.people.length);
      assert.equal(now.res.people.length, 0);
      assert.equal(now.res.stop, 'never-rendered');
      assert.ok(Math.abs(now.secs - lateOld.secs) <= 0.6, `new ${now.secs}s vs old ${lateOld.secs}s`);
      assert.deepEqual(verdict(now.res, 14), { short: true, record: true });
      assert.equal(slow.res.people.length, slowOld.res.people.length);
      assert.ok(Math.abs(slow.secs - slowOld.secs) <= 0.6, `new ${slow.secs}s vs old ${slowOld.secs}s`);
      // A list that loads normally still reads in full.
      assert.equal(fast.res.people.length, 25);
      assert.equal(fast.res.stop, 'complete');
      return { secs: now.secs, note: `old ${lateOld.secs.toFixed(1)}s; slow ${slow.secs.toFixed(1)}s vs ${slowOld.secs.toFixed(1)}s` };
    },
  },
  {
    name: 'o) an author near its deadline: 3 never-rendering dialogs fit in 15 s bounded; unbounded runs late',
    reads: {
      // 15 s left for 3 targets. Each costs ~3-3.5 s with the pre-change
      // loop, so the old reads fit (~10 s); with a 7 s settle wait each, the
      // unbounded change needs ~21 s — the waiting alone runs it late. The
      // cost floor (4.5 s) plays REACTOR_TARGET_COST_MS: at or above what a
      // target really costs, which is what the guarantee rests on.
      now: () => authorRun('bounded', 'n=14&first=never', { n: 3, deadlineMs: 15000, costFloorMs: 4500, knownCount: 14 }),
      unbounded: () => authorRun('unbounded', 'n=14&first=never', { n: 3, deadlineMs: 15000, costFloorMs: 4500, knownCount: 14 }),
      old: () => authorRun('old', 'n=14&first=never', { n: 3, deadlineMs: 15000, costFloorMs: 4500, knownCount: 14 }),
    },
    check({ now, unbounded, old }) {
      assert.ok(old.secs < 15, `the pre-change reads must fit for this to be a fair test (${old.secs}s)`);
      assert.ok(unbounded.secs > 15, `unbounded waiting should run past the deadline (${unbounded.secs}s)`);
      assert.ok(now.secs <= 15, `bounded waiting ran past the deadline: ${now.secs.toFixed(2)}s`);
      for (const r of now.res) {
        assert.equal(r.res.people.length, 0);
        assert.deepEqual(verdict(r.res, 14), { short: true, record: true });
      }
      // It still waited where it could: the shares were used, not zero.
      assert.ok(now.res.some((r) => r.patienceMs > 0), 'some patience should have been spare');
      const shares = now.res.map((r) => (r.patienceMs / 1000).toFixed(1)).join('/');
      return { secs: now.secs, note: `old ${old.secs.toFixed(1)}s, unbounded ${unbounded.secs.toFixed(1)}s, shares ${shares}s` };
    },
  },
  {
    name: 'p) env overrides are guarded: 0, junk and settle > budget fall back or clamp',
    reads: { now: () => envProbe() },
    check({ now }) {
      const r = now.res;
      assert.deepEqual(r.defaults, [15000, 60000]);
      assert.deepEqual(r.zero, [15000, 60000], 'budget 0 would have read one page and stopped');
      assert.deepEqual(r.junk, [15000, 60000], "'abc' would have switched the wait off");
      assert.deepEqual(r.settleOverBudget, [10000, 10000], 'the settle window is part of the budget');
      assert.deepEqual(r.valid, [4000, 30000]);
      return { secs: now.secs };
    },
  },
  {
    name: 'k) closeDialog: Escape closes the dialog after a read',
    reads: { now: () => NEW('n=5&total=5', { close: true }) },
    check({ now }) {
      assert.equal(now.res.people.length, 5);
      assert.equal(now.res.stop, 'complete');
      assert.equal(now.stillOpen, false, 'dialog still open after closeDialog');
      within(now.secs, 0, 1, 'new');
      return { secs: now.secs };
    },
  },
  {
    name: 'k2) closeDialog: Escape swallowed, the Dismiss button closes it',
    reads: { now: () => NEW('n=5&total=5&noEscape=1', { close: true }) },
    check({ now }) {
      assert.equal(now.res.people.length, 5);
      assert.equal(now.stillOpen, false, 'dialog still open after closeDialog');
      return { secs: now.secs };
    },
  },
];

try {
  assert.equal(R.REACTOR_LIST_SETTLE_MS, SETTLE_MS, 'LI_REACTOR_SETTLE_MS override not applied');
  assert.equal(R.REACTOR_DIALOG_BUDGET_MS, BUDGET_MS, 'LI_REACTOR_DIALOG_BUDGET_MS override not applied');
  const launched = await launchBrowser();
  browser = launched.browser;
  console.log(`browser: ${launched.label} (${browser.version()}); settle ${SETTLE}s, budget ${BUDGET}s\n`);

  const t0 = Date.now();
  // Every read of every scenario at once: each has its own context and page,
  // and the loop's clock is its own.
  const results = await Promise.all(scenarios.map(async (s) => {
    const entries = await Promise.all(Object.entries(s.reads).map(async ([k, fn]) => [k, await fn()]));
    return Object.fromEntries(entries);
  }));

  scenarios.forEach((s, i) => {
    const r = results[i];
    try {
      // No loop may throw on any fixture — a throw fails the scenario outright.
      for (const v of Object.values(r)) if (v.threw) throw v.threw;
      const { secs, note } = s.check(r);
      rows.push({ name: s.name, ok: true, secs });
      console.log(`ok   ${s.name} — ${secs.toFixed(1)}s${note ? ` (${note})` : ''}`);
    } catch (err) {
      failures++;
      rows.push({ name: s.name, ok: false, secs: r.now?.secs ?? NaN });
      console.error(`FAIL ${s.name} — ${(r.now?.secs ?? NaN).toFixed(1)}s\n     ${err.message}`);
    }
  });
  console.log(`\nwall-clock ${((Date.now() - t0) / 1000).toFixed(1)}s for ${scenarios.length} scenarios`);
} catch (err) {
  failures++;
  console.error(`FAIL setup\n     ${err.message}`);
} finally {
  if (browser) await browser.close().catch(() => {});
  await new Promise((r) => server.close(r));
}

console.log(`\n${rows.filter((r) => r.ok).length} passed${failures ? ` — ${failures} FAILED` : ''}`);
if (failures) process.exitCode = 1;
