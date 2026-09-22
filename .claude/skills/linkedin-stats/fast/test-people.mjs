#!/usr/bin/env node
// Regression suite for the `people` phase logic (people.mjs) — browser-free.
// Run: node .claude/skills/linkedin-stats/fast/test-people.mjs
//
// Pure logic only — no browser, no network, and no scraped corpus, so the suite
// runs on a fresh checkout before a single scrape has happened.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as P from './people.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
let passed = 0;
const test = (name, fn) => {
  try { fn(); passed++; console.log(`ok   ${name}`); }
  catch (err) { console.error(`FAIL ${name}\n     ${err.message}`); process.exitCode = 1; }
};

test('previousWeek steps back exactly one ISO week', () => {
  assert.equal(P.previousWeek('2026-08-17'), '2026-08-10');
  assert.equal(P.previousWeek('2026-01-05'), '2025-12-29'); // across a year boundary
});

test('isoWeekMondayFromMs snaps to Monday', () => {
  assert.equal(P.isoWeekMondayFromMs(Date.parse('2026-08-13T09:50:20Z')), '2026-08-10'); // Thu
  assert.equal(P.isoWeekMondayFromMs(Date.parse('2026-08-10T00:00:00Z')), '2026-08-10'); // Mon
  assert.equal(P.isoWeekMondayFromMs(Date.parse('2026-08-16T23:59:59Z')), '2026-08-10'); // Sun
});

test('commentUrnToMs decodes the 22-bit-shifted epoch out of a comment URN', () => {
  // Synthetic on purpose: the decode is pure arithmetic, so it is verified by
  // round-tripping known instants instead of shipping a real comment corpus.
  for (const iso of ['2025-11-01T08:15:30Z', '2026-01-13T14:08:18Z', '2026-08-17T23:59:59Z']) {
    const ms = Date.parse(iso);
    const urn = `urn:li:comment:(activity:7487568033847070720,${BigInt(ms) << 22n})`;
    assert.equal(P.commentUrnToMs(urn), ms, `round-trip failed for ${iso}`);
  }
  // LinkedIn packs a sequence counter into the low 22 bits — it truncates away.
  const ms = Date.parse('2026-01-13T14:08:18Z');
  const packed = (BigInt(ms) << 22n) + 4194303n;
  assert.equal(P.commentUrnToMs(`urn:li:comment:(activity:1,${packed})`), ms);
  assert.equal(P.commentUrnToMs('not-a-urn'), null);
  assert.equal(P.commentUrnToMs(''), null);
});
test('commentUrnToMs refuses malformed urns', () => {
  assert.equal(P.commentUrnToMs('urn:li:activity:7487568033847070720'), null);
  assert.equal(P.commentUrnToMs(''), null);
  assert.equal(P.commentUrnToMs(null), null);
});

test('personKey normalizes profile urls and falls back to a name slug', () => {
  assert.equal(P.personKey('https://www.linkedin.com/in/KentGregoire/'), 'in/kentgregoire');
  assert.equal(P.personKey('https://www.linkedin.com/in/kentgregoire?trk=feed'), 'in/kentgregoire');
  assert.equal(P.personKey('/in/kentgregoire'), 'in/kentgregoire');
  assert.equal(P.personKey('', 'Kent Gregoire'), 'name:kent-gregoire');
  assert.equal(P.personKey('', ''), '');
  // A name that slugifies to nothing still gets a stable, repeatable id.
  const cyr = P.personKey('', 'Петро Овчинников');
  assert.match(cyr, /^name:[0-9a-f]{12}$/);
  assert.equal(cyr, P.personKey('', ' петро  овчинников '));
});

test('parseReactorLabel splits the dialog label into name and headline', () => {
  // Real labels captured from the live reactor dialog, 2026-08-17.
  assert.deepEqual(P.parseReactorLabel('Yura Puzichenko • 1st AI Solo Founder | автор тг-каналу “Пан Пузіч”'),
    { name: 'Yura Puzichenko', headline: 'AI Solo Founder | автор тг-каналу “Пан Пузіч”' });
  assert.deepEqual(P.parseReactorLabel('Oleksii Mudryk • 1st Software Engineer'),
    { name: 'Oleksii Mudryk', headline: 'Software Engineer' });
  assert.equal(P.parseReactorLabel('Deirdre Martin • 2nd Business strategist for cybersecurity founders').headline,
    'Business strategist for cybersecurity founders');
  assert.deepEqual(P.parseReactorLabel('Yana Nakonechna 🇺🇦 • 1st Talent Acquisition Specialist'),
    { name: 'Yana Nakonechna 🇺🇦', headline: 'Talent Acquisition Specialist' });
  // "3rd+" is a real degree: without the plus, the headline keeps a "+ " head.
  assert.deepEqual(P.parseReactorLabel('Alexandros Petrache • 3rd+ Software Engineer'),
    { name: 'Alexandros Petrache', headline: 'Software Engineer' });
  assert.deepEqual(P.parseReactorLabel('Anna Krigan • 3rd+ HR & Talent Executive | Partnership-driven leadership'),
    { name: 'Anna Krigan', headline: 'HR & Talent Executive | Partnership-driven leadership' });
  // Degenerate labels must not throw or invent a headline.
  assert.deepEqual(P.parseReactorLabel('Just A Name'), { name: 'Just A Name', headline: '' });
  assert.deepEqual(P.parseReactorLabel(''), { name: '', headline: '' });
  assert.deepEqual(P.parseReactorLabel(null), { name: '', headline: '' });
});

test('personRecord keeps a clean profile url and trims the headline', () => {
  const r = P.personRecord({
    name: '  Kent Gregoire ', url: 'https://www.linkedin.com/in/kentgregoire/?trk=x',
    headline: 'Founder,\n  Society of EI ',
  });
  assert.equal(r.key, 'in/kentgregoire');
  assert.equal(r.name, 'Kent Gregoire');
  assert.equal(r.profile_url, 'https://www.linkedin.com/in/kentgregoire');
  assert.equal(r.headline, 'Founder, Society of EI');
  assert.equal(P.personRecord({ name: '', url: '', headline: '' }), null);
});

const postEntry = (id, urn, postedDate, weeks = {}) => ({
  file: `${id}.json`,
  data: { id, urn, post_url: `https://www.linkedin.com/posts/${id}/`, posted_at: `${postedDate}T09:00:00Z`, posted_date: postedDate, type: 'post', weeks },
});

test('selectPostTargets prioritizes changed counts, then recent, then unscanned', () => {
  const week = '2026-08-17';
  const changed = postEntry('changed', 'urn:li:activity:1', '2026-01-01', {
    '2026-08-10': { metrics: { reactions: 5, comments: 1 } },
    '2026-08-17': { metrics: { reactions: 9, comments: 1 } },
  });
  const stale = postEntry('stale', 'urn:li:activity:2', '2026-01-02', {
    '2026-08-10': { metrics: { reactions: 5, comments: 1 } },
    '2026-08-17': { metrics: { reactions: 5, comments: 1 } },
  });
  const recent = postEntry('recent', 'urn:li:activity:3', '2026-08-05');
  const repost = { ...postEntry('repost', 'urn:li:activity:4', '2026-08-06'), data: { ...postEntry('r', 'urn:li:activity:4', '2026-08-06').data, type: 'repost' } };

  const scannedTargets = {
    'post:urn:li:activity:1': {}, 'post:urn:li:activity:2': {}, 'post:urn:li:activity:3': {},
  };
  const { selected, dropped } = P.selectPostTargets([stale, recent, changed, repost], { week, scannedTargets });
  assert.deepEqual(selected.map((s) => s.data.id), ['changed', 'recent']);
  assert.equal(selected[0].reason, 'counts-changed');
  assert.equal(selected[1].reason, 'recent');
  assert.equal(dropped, 0);

  // With nothing scanned yet, the stale old post joins as baseline backlog.
  const all = P.selectPostTargets([stale, recent, changed, repost], { week, scannedTargets: {} });
  assert.deepEqual(all.selected.map((s) => s.data.id), ['changed', 'recent', 'stale']);
  assert.equal(all.selected[2].reason, 'never-scanned');

  // The cap is reported, not hidden.
  const capped = P.selectPostTargets([stale, recent, changed], { week, scannedTargets: {}, maxPosts: 2 });
  assert.equal(capped.selected.length, 2);
  assert.equal(capped.dropped, 1);
});

test('isShortRead trusts the dialog AND our own history, and nothing else', () => {
  const S = (got, announced, known) => P.isShortRead({ got, announced, known });
  // The dialog announced a total and we read less than 90% of it.
  assert.equal(S(10, 25, 0), true);
  assert.equal(S(24, 25, 0), false, '10% slack: private profiles have no link to read');
  // It announced nothing (every one of peter's posts, 2026-09-21) — then the
  // only witness is what a previous read stored. This is the half that turns
  // a 14 -> 0 overwrite into a flagged target instead of silent loss.
  assert.equal(S(0, 0, 14), true);
  assert.equal(S(1, 0, 14), true, 'one-of-fourteen is a short read, not a post that lost 13');
  assert.equal(S(14, 0, 14), false);
  assert.equal(S(20, 0, 14), false, 'more than we knew about is a better read, not a short one');
  // A first-ever read has no witness at all and no good count to destroy.
  assert.equal(S(0, 0, 0), false);
  // Reactions genuinely withdrawn: the dialog now says 20 and we read all 20.
  // Complete, even though we stored 25 last week — otherwise the count would
  // freeze at a number that is no longer true.
  assert.equal(S(20, 20, 25), false);
  // Private profiles: 8 of 28 carry no link, so we can never read past 20.
  // The first time that is a short read; once it repeats, the gap is
  // structural and flagging it forever would re-read the post every week and
  // never do better.
  assert.equal(S(20, 28, 0), true, 'first time: we have nothing to compare with');
  assert.equal(S(20, 28, 20), false, 'no worse than our best read: the gap is structural');
  assert.equal(S(19, 28, 20), true, 'worse than our best read: something did fail');
  // Junk must not be read as a ceiling.
  assert.equal(S(0, null, undefined), false);
  assert.equal(S(0, NaN, null), false);
});

test('reactorScrollDecision: only the announced total completes a read; a known count buys patience', () => {
  const D = (o) => P.reactorScrollDecision(o);
  const { quiet, quietBelowTarget } = P.REACTOR_PATIENCE;

  // Reached what the dialog announced: done.
  assert.equal(D({ count: 25, announced: 25, stagnant: 0 }), 'complete');
  assert.equal(D({ count: 30, announced: 25, stagnant: 0 }), 'complete');

  // What we stored last time is NOT a stop. The list grew since (the very
  // posts selectPostTargets reopens as counts-changed); stopping at the old
  // number stored 10 of 30 as a complete read, with no flag.
  assert.equal(D({ count: 10, known: 7, stagnant: 0 }), 'continue');
  assert.equal(D({ count: 20, known: 14, stagnant: 0 }), 'continue');
  assert.equal(D({ count: 14, known: 14, stagnant: quiet - 1 }), 'continue');
  assert.equal(D({ count: 14, known: 14, stagnant: quiet }), 'stagnant', 'at the known count: the old rule');

  // Well below either number: more quiet rounds before accepting it — a slow
  // proxy pauses between pages, it does not end the list.
  for (const o of [{ announced: 25 }, { known: 25 }]) {
    assert.equal(D({ count: 10, ...o, stagnant: quiet }), 'continue');
    assert.equal(D({ count: 10, ...o, stagnant: quietBelowTarget - 1 }), 'continue');
    assert.equal(D({ count: 10, ...o, stagnant: quietBelowTarget }), 'stagnant');
  }
  // The announced total wins over a stale known count.
  assert.equal(D({ count: 10, announced: 10, known: 25, stagnant: 0 }), 'complete');

  // Within 10% (the private-profile slack) or nothing known at all: the old
  // rule, two quiet rounds, so a normal list costs nothing extra.
  assert.equal(D({ count: 23, announced: 25, stagnant: quiet - 1 }), 'continue');
  assert.equal(D({ count: 23, announced: 25, stagnant: quiet }), 'stagnant');
  assert.equal(D({ count: 7, stagnant: quiet }), 'stagnant');

  // An empty list is waited for by the settle window, not here: past it, it
  // ends like any other, so a list that empties mid-read cannot hold the
  // loop until the budget.
  assert.equal(D({ count: 0, known: 14, stagnant: quietBelowTarget }), 'stagnant');
  assert.equal(D({ count: 0, stagnant: quiet }), 'stagnant');

  // No spare time before the deadline: no extra patience — the pre-change rule.
  assert.equal(D({ count: 10, announced: 25, stagnant: quiet, patient: false }), 'stagnant');
  assert.equal(D({ count: 25, announced: 25, stagnant: 0, patient: false }), 'complete');

  // The cap always wins.
  assert.equal(D({ count: 500, announced: 900, stagnant: 0, maxPeople: 500 }), 'cap');
  assert.ok(quietBelowTarget > quiet, 'more patience below the target than above it');
});

test('reactorReadVerdict: an abandoned read is short, and nobody-read on a new target leaves no record', () => {
  const V = (got, announced, known, stop, scannedBefore) => P.reactorReadVerdict({ got, announced, known, stop, scannedBefore });

  // A finished read: isShortRead decides, exactly as before.
  assert.deepEqual(V(14, null, 14, 'stagnant', true), { short: false, record: true });
  assert.deepEqual(V(1, null, 14, 'stagnant', true), { short: true, record: true });
  assert.deepEqual(V(7, null, 0, 'stagnant', false), { short: false, record: true });

  // The list never rendered, on a post never scanned before. isShortRead has
  // no witness (0 announced, 0 known) and calls it complete; storing that
  // would say "nobody reacted" — false, the dialog opens only from a
  // reaction count — and credit the whole list to the next week that reads
  // it. Short, and not recorded: neverScanned brings it back as a baseline.
  assert.equal(P.isShortRead({ got: 0, announced: null, known: 0 }), false, 'the blind spot');
  assert.deepEqual(V(0, null, 0, 'never-rendered', false), { short: true, record: false });
  // Same, with a total announced.
  assert.deepEqual(V(0, 40, 0, 'never-rendered', false), { short: true, record: false });
  // A target we HAVE scanned keeps its record and its flag.
  assert.deepEqual(V(0, null, 14, 'never-rendered', true), { short: true, record: true });
  assert.deepEqual(V(0, null, 0, 'never-rendered', true), { short: true, record: true });

  // Cut off with no total to compare against: short whatever the number.
  for (const stop of ['dialog-closed', 'budget', 'deadline', 'breaker']) {
    assert.deepEqual(V(10, null, 0, stop, false), { short: true, record: true }, stop);
    assert.deepEqual(V(30, null, 14, stop, true), { short: true, record: true }, stop);
  }
  // With a total announced, the total is the witness: 26 of 28 is complete
  // even if the budget ended the scrolling; 10 of 40 is short either way.
  assert.deepEqual(V(26, 28, 0, 'budget', false), { short: false, record: true });
  assert.deepEqual(V(10, 40, 0, 'dialog-closed', false), { short: true, record: true });
  // Limits set on purpose are judged by the number, as before.
  assert.deepEqual(V(500, null, 0, 'cap', false), { short: false, record: true });
  assert.deepEqual(V(300, null, 0, 'rounds', false), { short: false, record: true });

  // Composed with the phase verdict: a total collapse on NEW posts only is
  // still drift (every read short, nothing seen), and one new post that never
  // rendered among good reads is an advisory shortfall, not a clean week.
  assert.equal(P.reactorPhaseStatus({ attempted: 4, scanned: 4, reactorsSeen: 0, reactorsShort: 4 }), 'SELECTOR_DRIFT');
  assert.equal(P.reactorPhaseStatus({ attempted: 4, scanned: 4, reactorsSeen: 30, reactorsShort: 1 }), 'REACTORS_SHORT');
});

test('reactorPatienceMs: waiting is paid only from spare time, so it cannot run the author past the deadline', () => {
  const S = 1000;
  const W = (o) => P.reactorPatienceMs(o);
  // No deadline: no limit here (the dialog budget still applies).
  assert.equal(W({ nowMs: 0, deadlineAtMs: Infinity, targetsLeft: 10, perTargetMs: 45 * S }), Infinity);
  // Light week — 10 targets with 18 minutes left: the whole dialog budget.
  assert.ok(W({ nowMs: 420 * S, deadlineAtMs: 1500 * S, targetsLeft: 10, perTargetMs: 45 * S }) >= 60 * S);
  // 15 minutes left: less, but still the whole settle window and more.
  assert.equal(W({ nowMs: 600 * S, deadlineAtMs: 1500 * S, targetsLeft: 10, perTargetMs: 45 * S }), 45 * S);
  // Nothing spare: none at all, and never negative.
  assert.equal(W({ nowMs: 500 * S, deadlineAtMs: 1500 * S, targetsLeft: 50, perTargetMs: 45 * S }), 0);
  assert.equal(W({ nowMs: 1600 * S, deadlineAtMs: 1500 * S, targetsLeft: 1, perTargetMs: 0 }), 0);
  // Junk counts are read as one target at no cost: a number out, never NaN
  // (NaN would compare false everywhere and switch the limit off).
  assert.equal(W({ nowMs: 0, deadlineAtMs: 100 * S, targetsLeft: NaN, perTargetMs: NaN }), 100 * S);
  assert.ok(P.REACTOR_TARGET_COST_MS > 0);

  // The guarantee, walked through: for any week whose pre-change reads fit
  // before the deadline, spend EVERY millisecond of patience offered and
  // still finish in time — as long as targets cost no more than the estimate
  // the caller passes (max of REACTOR_TARGET_COST_MS and the measured
  // average; here the true cost, the tightest case).
  let rnd = 7;
  const rand = () => { rnd = (rnd * 16807) % 2147483647; return rnd / 2147483647; };
  let unboundedLate = 0;
  for (let trial = 0; trial < 500; trial++) {
    const deadline = 1500 * S;
    const targets = 1 + Math.floor(rand() * 50);
    // Per target, no patience — and never so much that the old reads alone
    // would miss the deadline: that week was lost before patience existed.
    const cost = Math.min(5 + rand() * 55, 1500 / targets) * S;
    const start = rand() * (deadline - targets * cost);
    let now = start;
    for (let k = 0; k < targets; k++) {
      const done = k;
      const avg = done > 0 ? (now - start) / done : 0;
      const p = W({ nowMs: now, deadlineAtMs: deadline, targetsLeft: targets - done, perTargetMs: Math.max(cost, avg) });
      now += cost + p; // worst case: the whole share is waited out
    }
    assert.ok(now <= deadline + 1e-6,
      `trial ${trial}: ${targets} targets at ${(cost / S).toFixed(1)}s from ${(start / S).toFixed(0)}s ended at ${(now / S).toFixed(1)}s`);
    // The same week with a fixed 15 s settle wait per dialog and no share:
    // the unbounded version the review measured.
    if (start + targets * (cost + 15 * S) > deadline) unboundedLate++;
  }
  // …which would have run late on a good part of these same weeks.
  assert.ok(unboundedLate > 100, `unbounded waiting ran late in only ${unboundedLate} of 500 weeks`);
});

test('reactorPhaseStatus: only a clean overlay shortfall may publish', () => {
  const base = { attempted: 4, scanned: 4, reactorsSeen: 30, reactorsExpected: 30 };
  const st = (o) => P.reactorPhaseStatus({ ...base, ...o });

  assert.equal(st({}), 'OK');
  // The whole point: reaction lists short, everything else complete.
  assert.equal(st({ reactorsShort: 1, reactorsSeen: 20 }), 'REACTORS_SHORT');

  // Not overlay problems — these still send the week to a human. A dropped
  // target was never even attempted, and no flag will bring it back.
  assert.equal(st({ reactorsShort: 1, failed: 1 }), 'PARTIAL');
  assert.equal(st({ reactorsShort: 1, postsDropped: 1 }), 'PARTIAL');
  assert.equal(st({ reactorsShort: 1, commentsDropped: 1 }), 'PARTIAL');
  assert.equal(st({ reactorsShort: 1, rosterMissing: 1 }), 'PARTIAL');
  assert.equal(st({ failed: 1 }), 'PARTIAL');

  // Drift must never hide inside the advisory branch: nothing self-heals and
  // every later week fails the same way, so each shape has to be loud.
  assert.equal(st({ scanned: 0, dialogFailures: 4, reactorsSeen: 0, reactorsExpected: 0, failed: 4 }),
    'SELECTOR_DRIFT', 'no dialog opened at all');
  assert.equal(st({ reactorsSeen: 0, reactorsExpected: 30, reactorsShort: 4 }),
    'SELECTOR_DRIFT', 'dialogs announced totals and handed back nothing');
  // The 2026-09-21 shape: the overlay announces NO total, so the test above is
  // blind to it. Every opened dialog read nothing and every one was short.
  assert.equal(st({ reactorsSeen: 0, reactorsExpected: 0, reactorsShort: 4 }),
    'SELECTOR_DRIFT', 'nothing read anywhere, and we knew better for every target');
  // But a week where the posts genuinely have no reactions is not drift: no
  // target is short, because there was nothing to miss.
  assert.equal(st({ reactorsSeen: 0, reactorsExpected: 0, reactorsShort: 0 }), 'OK');
  // Partial coverage is not collapse: something did come back.
  assert.equal(st({ reactorsSeen: 5, reactorsExpected: 0, reactorsShort: 4 }), 'REACTORS_SHORT');

  // A stop reason outranks everything — it says the run was cut short.
  assert.equal(st({ stopped: 'deadline', reactorsShort: 1 }), 'DEADLINE');
  assert.equal(st({ stopped: 'auth' }), 'AUTH');
  assert.equal(st({ stopped: 'rate' }), 'RATE');
});

test('selectPostTargets comes back for a target whose reactor list was read short', () => {
  const week = '2026-08-17';
  // Old, scanned, and its counts have not moved: invisible to every other
  // rule, which is exactly why a short read has to carry its own flag. Without
  // it the unread reactors are lost for good — and that is the premise on
  // which a short read is allowed to publish the week (scrape-weekly exit 11).
  const stale = postEntry('stale', 'urn:li:activity:2', '2026-01-02', {
    '2026-08-10': { metrics: { reactions: 5, comments: 1 } },
    '2026-08-17': { metrics: { reactions: 5, comments: 1 } },
  });
  const recent = postEntry('recent', 'urn:li:activity:3', '2026-08-05');

  const complete = { 'post:urn:li:activity:2': { reactor_count: 14 }, 'post:urn:li:activity:3': {} };
  assert.deepEqual(P.selectPostTargets([stale, recent], { week, scannedTargets: complete })
    .selected.map((s) => s.data.id), ['recent'], 'a complete read stays off the list');

  const short = { 'post:urn:li:activity:2': { reactor_count: 14, short_read: true }, 'post:urn:li:activity:3': {} };
  const got = P.selectPostTargets([stale, recent], { week, scannedTargets: short });
  // Ahead of `recent`: when the cap bites, an incomplete target is the one
  // that cannot wait — a recent post stays recent next week, this one does not.
  assert.deepEqual(got.selected.map((s) => s.data.id), ['stale', 'recent']);
  assert.equal(got.selected[0].reason, 'short-read');
  assert.equal(P.selectPostTargets([stale, recent], { week, scannedTargets: short, maxPosts: 1 })
    .selected[0].data.id, 'stale');

  // And ahead of `counts-changed` too. Both are band-0 urgent, but a changed
  // post is still changed next week, while an old flagged one would lose the
  // date tiebreak to every fresh post and never be re-read at all.
  const changedNew = postEntry('changed', 'urn:li:activity:9', '2026-08-16', {
    '2026-08-10': { metrics: { reactions: 5, comments: 1 } },
    '2026-08-17': { metrics: { reactions: 9, comments: 1 } },
  });
  const both = { ...short, 'post:urn:li:activity:9': {} };
  assert.deepEqual(P.selectPostTargets([changedNew, stale], { week, scannedTargets: both, maxPosts: 1 })
    .selected.map((s) => s.data.id), ['stale'], 'the flagged target outranks a newer changed one');

  // recentOnly is the explicit "only fresh posts" backfill mode: it must not
  // start dragging in old targets just because they carry the flag.
  assert.deepEqual(P.selectPostTargets([stale, recent], { week, scannedTargets: short, recentOnly: true })
    .selected.map((s) => s.data.id), ['recent']);
});

test('selectCommentTargets reopens a comment whose reactor list was read short, at any age', () => {
  const nowMs = Date.parse('2026-09-21T00:00:00Z');
  const mk = (urn, iso) => ({ comment_urn: urn, permalink: `https://x/?commentUrn=${urn}`, commented_at: iso });
  // Six months old: outside the 30-day window, which is the ONLY thing that
  // ever brings a comment target back. Unflagged it is gone for good.
  const old = mk('urn:li:comment:(activity:1,1)', '2026-03-01T10:00:00Z');
  const fresh = mk('urn:li:comment:(activity:2,2)', '2026-09-18T10:00:00Z');
  const map = { a: old, b: fresh };

  assert.deepEqual(P.selectCommentTargets(map, { nowMs }).selected.map((s) => s.comment.comment_urn),
    [fresh.comment_urn], 'without the flag the old comment stays out');

  const flagged = { [P.targetIdForComment(old.comment_urn)]: { reactor_count: 9, short_read: true } };
  const got = P.selectCommentTargets(map, { nowMs, scannedTargets: flagged });
  assert.deepEqual(got.selected.map((s) => s.comment.comment_urn), [old.comment_urn, fresh.comment_urn]);
  // First, so the cap cannot drop the one target that has no other way back.
  assert.equal(P.selectCommentTargets(map, { nowMs, scannedTargets: flagged, maxComments: 1 })
    .selected[0].comment.comment_urn, old.comment_urn);
});

test('selectCommentTargets keeps only recent comments and reports the overflow', () => {
  const nowMs = Date.parse('2026-08-17T00:00:00Z');
  const mk = (urn, iso) => ({ comment_urn: urn, permalink: `https://x/?commentUrn=${urn}`, commented_at: iso });
  const map = {
    a: mk('urn:li:comment:(activity:1,2)', '2026-08-16T00:00:00Z'),
    b: mk('urn:li:comment:(activity:1,3)', '2026-08-01T00:00:00Z'),
    old: mk('urn:li:comment:(activity:1,4)', '2026-05-01T00:00:00Z'),
    nolink: { comment_urn: 'urn:li:comment:(activity:1,5)', commented_at: '2026-08-16T00:00:00Z' },
  };
  const { selected, dropped } = P.selectCommentTargets(map, { nowMs });
  assert.deepEqual(selected.map((s) => s.comment.comment_urn),
    ['urn:li:comment:(activity:1,2)', 'urn:li:comment:(activity:1,3)']);
  assert.equal(dropped, 0);
  assert.equal(P.selectCommentTargets(map, { nowMs, maxComments: 1 }).dropped, 1);
});

test('post reaction events: baseline is undated, a rescan lands in the reported week', () => {
  const post = { urn: 'urn:li:activity:1', post_url: 'https://x/' };
  const reactors = [{ name: 'Kent Gregoire', url: 'https://www.linkedin.com/in/kentgregoire', headline: 'Founder' }];

  const base = P.buildPostReactionEvents({ post, reactors, attributedWeek: '2026-08-10', isBaseline: true });
  assert.equal(base.events[0].event_id, 'react:post:urn:li:activity:1:in/kentgregoire');
  assert.equal(base.events[0].backfill, true);
  assert.equal(base.events[0].attributed_week, null);
  assert.equal(base.events[0].occurred_at_ms, null);

  const fresh = P.buildPostReactionEvents({ post, reactors, attributedWeek: '2026-08-10', isBaseline: false });
  assert.equal(fresh.events[0].backfill, false);
  assert.equal(fresh.events[0].attributed_week, '2026-08-10');
  // Same id both times — merge.py keeps the first, so a rescan can never
  // re-date or duplicate an existing reaction.
  assert.equal(fresh.events[0].event_id, base.events[0].event_id);
});

test('post comment events are dated from the urn, undated ones are counted not guessed', () => {
  const post = { urn: 'urn:li:activity:7487568033847070720', post_url: 'https://x/' };
  const comments = [
    { author_name: 'A', author_url: 'https://www.linkedin.com/in/aaa', author_headline: 'H',
      comment_urn: 'urn:li:comment:(activity:7487568033847070720,7491792908463964161)', text: 'hi' },
    { author_name: 'B', author_url: 'https://www.linkedin.com/in/bbb', author_headline: '', comment_urn: '', text: 'legacy' },
  ];
  const r = P.buildPostCommentEvents({ post, comments });
  assert.equal(r.events.length, 1);
  assert.equal(r.undated, 1);
  const ev = r.events[0];
  assert.equal(ev.kind, 'comment');
  assert.equal(ev.backfill, false);
  assert.equal(ev.person_key, 'in/aaa');
  assert.equal(ev.attributed_week, P.isoWeekMondayFromMs(ev.occurred_at_ms));
});

test('reply events drop the owner replying to himself', () => {
  const comment = { comment_urn: 'urn:li:comment:(activity:1,2)', permalink: 'https://x/' };
  const replies = [
    { reply_urn: 'urn:li:comment:(activity:7487568033847070720,7491792908463964161)', name: 'Other', url: 'https://www.linkedin.com/in/other', headline: 'H', text: 'y' },
    { reply_urn: 'urn:li:comment:(activity:7487568033847070720,7491792908463964162)', name: 'Owner', url: 'https://www.linkedin.com/in/owner-slug', headline: '', text: 'thanks' },
  ];
  const r = P.buildReplyEvents({ comment, replies, selfKey: 'in/owner-slug' });
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].person_key, 'in/other');
});

test('mergePeople keeps the richest record per key', () => {
  const merged = P.mergePeople([
    { key: 'in/a', name: 'A', profile_url: 'https://www.linkedin.com/in/a', headline: '' },
    { key: 'in/a', name: 'A', profile_url: 'https://www.linkedin.com/in/a', headline: 'Founder' },
    { key: 'in/b', name: 'B', profile_url: '', headline: '' },
  ]);
  assert.equal(merged.length, 2);
  assert.equal(merged.find((m) => m.key === 'in/a').headline, 'Founder');
});

console.log(`\n${passed} passed${process.exitCode ? ' — WITH FAILURES' : ''}`);
