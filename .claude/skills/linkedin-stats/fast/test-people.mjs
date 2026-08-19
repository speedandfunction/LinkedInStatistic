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
