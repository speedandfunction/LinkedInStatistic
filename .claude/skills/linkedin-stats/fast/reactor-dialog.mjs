// The reactor overlay — reading, paging and closing the "who reacted" dialog
// that a post's or a comment's reaction count opens.
//
// Kept out of scrape-weekly.mjs for one reason: that file starts its scrape on
// import, so nothing inside it can be driven by a test. This module does
// nothing on import, and test-reactor-dialog.mjs runs the real code below in a
// headless browser against local fixtures. Opening the dialog stays in
// scrape-weekly.mjs (openPostReactors / openCommentReactors): that part is
// specific to the page it opens from; once open, both paths read the same
// overlay through this code.
//
// The two REACTOR_* limits are read from the environment once, when this
// module loads — which is now before scrape-weekly.mjs's own body runs. That
// changes nothing: the scraper loads no .env of its own, the variables come
// from the shell, so they are all set before either module evaluates. A test
// sets them before its import for the same reason.

import * as People from './people.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The reactor overlay is a NATIVE <dialog data-testid="dialog">, not an
// artdeco modal and not [role="dialog"] — verified on the live post page
// 2026-08-17. Keep the legacy selectors as fallbacks.
export const DIALOG_SEL = 'dialog[open], [data-testid="dialog"], [role="dialog"], [aria-modal="true"], .artdeco-modal';

// Read every reactor out of the open dialog, scrolling it until it stops
// growing. Entries are NOT list items with separate name/headline nodes any
// more: each person is a single anchor whose innerText is
// "Name • 1st Headline", so the label is returned raw and split in node by
// people.mjs/parseReactorLabel (pure, and therefore testable).
// Read the entries currently rendered in the dialog, plus the expected total
// from the "All <n>" tab — so a short read is visible instead of silent.
export async function readReactorDialog(page, dialogSel) {
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
 * page.evaluate. Stops on the announced total, on the cap, or after rounds
 * that add nobody (People.reactorScrollDecision says how many).
 */
// Both limits are positive milliseconds; anything else ('', '0', 'abc') falls
// back to the default rather than switching the waiting off or making it
// endless.
const envMs = (name, fallback) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};
// Hard ceiling for one dialog, settle included.
export const REACTOR_DIALOG_BUDGET_MS = envMs('LI_REACTOR_DIALOG_BUDGET_MS', 60000);
// How long an open dialog may take to render its FIRST entries. The dialog
// shell mounts at once; the list inside arrives over the network, and through
// Browserbase + a residential proxy that has been seen to take seconds. Never
// longer than the budget it is part of.
export const REACTOR_LIST_SETTLE_MS = Math.min(envMs('LI_REACTOR_SETTLE_MS', 15000), REACTOR_DIALOG_BUDGET_MS);

/**
 * Options:
 *   knownCount  the best count a previous read stored for this target. Buys
 *               patience below it; never ends a read (People.reactorScrollDecision).
 *   patienceMs  how long this dialog may WAIT — for its first entries, and
 *               through the extra quiet rounds below a known count. The caller
 *               sizes it from the time left before the run's deadline
 *               (People.reactorPatienceMs). Past it the loop reads exactly as it
 *               did before the settle wait existed. Default: the whole budget.
 *   shouldStop  () => a stop reason ('deadline', 'breaker') or null, asked
 *               before every poll and round, so a run that is out of time or
 *               rate-limited does not keep scrolling a dialog to the end.
 *
 * Returns { error, expected, people, stop, waitedMs }. `stop` is one of
 * no-dialog, never-rendered, complete, cap, stagnant, rounds, budget,
 * dialog-closed, or what shouldStop returned; the caller turns it into a
 * verdict with People.reactorReadVerdict.
 */
export async function scrapeOpenReactorDialog(page, maxScrolls, maxPeople, dialogSel, {
  knownCount = 0, patienceMs = REACTOR_DIALOG_BUDGET_MS, shouldStop = () => null,
} = {}) {
  const t0 = Date.now();
  const budgetAt = t0 + REACTOR_DIALOG_BUDGET_MS;
  const patienceAt = t0 + Math.max(0, Math.min(Number(patienceMs) || 0, REACTOR_DIALOG_BUDGET_MS));
  const box = await page.locator(dialogSel).first().boundingBox().catch(() => null);
  if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2).catch(() => {});

  // Everyone ANY read has shown, and the largest total the tab announced. The
  // count only grows: a list that re-renders, virtualises or is torn down
  // mid-read cannot take back people already read, and a closing dialog
  // cannot erase the total it announced.
  const seen = new Map();
  let expected = null;
  const absorb = (r) => {
    for (const { url, label } of r.people) if (!seen.has(url)) seen.set(url, label);
    if (r.expected !== null && r.expected !== undefined) expected = Math.max(expected ?? 0, r.expected);
  };
  const gone = (error) => ({ error, people: [], expected: null, stop: 'no-dialog', waitedMs: Date.now() - t0 });
  const done = (stop) => ({
    error: null,
    expected,
    // Why the read ended, and how long it took — so a short read in the log
    // says whether the list never rendered, stopped growing, or ran out of
    // time, instead of just "short". Counts only: this log is public.
    stop: seen.size === 0 && ['stagnant', 'rounds', 'budget'].includes(stop) ? 'never-rendered' : stop,
    waitedMs: Date.now() - t0,
    people: [...seen].slice(0, maxPeople)
      .map(([url, label]) => ({ url, ...People.parseReactorLabel(label) })),
  });

  // 1. Wait for the list to exist before reading it. Reading the instant the
  //    shell appeared is what turned "not rendered yet" into "nobody reacted"
  //    on 2026-09-21.
  //    A poll starts only if it ends inside the window, so the wait never
  //    overruns the patience it was given.
  let last = await readReactorDialog(page, dialogSel);
  if (last.error) return { ...gone(last.error), waitedMs: 0 };
  absorb(last);
  const POLL_MS = 500;
  const settleByPatience = patienceAt <= t0 + REACTOR_LIST_SETTLE_MS;
  const settleAt = settleByPatience ? patienceAt : t0 + REACTOR_LIST_SETTLE_MS;
  let nudged = false;
  while (seen.size === 0 && Date.now() + POLL_MS <= settleAt) {
    const halt = shouldStop();
    if (halt) return done(halt);
    // Halfway through, one nudge: a list that is mounted but has not asked
    // for its first page sometimes needs an input event to start.
    if (!nudged && Date.now() >= t0 + (settleAt - t0) / 2) {
      nudged = true;
      await page.keyboard.press('End').catch(() => {});
    }
    await sleep(POLL_MS);
    last = await readReactorDialog(page, dialogSel);
    if (last.error) return gone(last.error);
    absorb(last);
  }
  // Still nothing after the whole settle window: scrolling an empty list does
  // not make it render, so stop here rather than spend the rest of the budget
  // on it. If it was patience that ran out instead, fall through: the rounds
  // below are then the pre-change loop, which gave an empty list two.
  if (seen.size === 0 && !settleByPatience) return done('never-rendered');

  // 2. Page through it. A round that only patience allows starts only if the
  //    last round's duration still fits before patience runs out.
  let stagnant = 0;
  let stop = 'rounds';
  let roundMs = 1500;
  for (let i = 0; i < maxScrolls; i++) {
    const verdict = People.reactorScrollDecision({
      count: seen.size, announced: expected || 0, known: knownCount || 0, stagnant, maxPeople,
      patient: Date.now() + roundMs <= patienceAt,
    });
    if (verdict !== 'continue') { stop = verdict; break; }
    const halt = shouldStop();
    if (halt) { stop = halt; break; }
    if (Date.now() >= budgetAt) { stop = 'budget'; break; }
    const before = seen.size;
    const r0 = Date.now();
    if (box) {
      for (let w = 0; w < 3; w++) { await page.mouse.wheel(0, 900).catch(() => {}); await sleep(250); }
    }
    await page.keyboard.press('End').catch(() => {});
    await sleep(700);
    const next = await readReactorDialog(page, dialogSel);
    roundMs = Date.now() - r0;
    // Gone mid-read: keep what was read and say so — never report it as a
    // clean read of fewer people. Gone before anyone was read: as above.
    if (next.error) {
      if (seen.size === 0) return gone(next.error);
      stop = 'dialog-closed';
      break;
    }
    absorb(next);
    stagnant = seen.size > before ? 0 : stagnant + 1;
  }
  return done(stop);
}

// A native <dialog> closes on Escape; the close button is the fallback.
export async function closeDialog(page, dialogSel) {
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
