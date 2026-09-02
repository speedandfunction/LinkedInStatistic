#!/usr/bin/env node
// Regression suite for the per-week engagement ROSTERS — browser-free.
//
//   node .claude/skills/linkedin-stats/fast/test-week-people.mjs
//
// Two halves: the pure roster helpers in people.mjs, and the merge.py
// `week_people` mode driven over a throwaway copy of the real corpus. The
// merge half matters most — it is the only writer of dashboards/li-stats/, and
// its byte-for-byte round-trip is what keeps historical float lexemes intact.
//
// Ported from upstream with two fork-specific changes, both deliberate:
//   - No account identity is hardcoded. Upstream pins the owner to one slug;
//     here the owner arrives as `selfKey` (the profile_slug this fork reads
//     out of profiles.json for LI_AUTHOR), so the tests pass a placeholder.
//   - The corpus is discovered, not pinned. This fork stores one corpus per
//     author under dashboards/li-stats/<author>/, and their snapshot weeks
//     differ, so the merge half picks an author dir and a week from disk.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as P from './people.mjs';
import { profileKey } from '../../pipeline-shared/profile-store.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..', '..', '..');
const MERGE_PY = path.join(SCRIPT_DIR, 'merge.py');

// Synthetic week for the pure helpers — no corpus involved.
const WEEK = '2026-08-17';

// The owner slug under test. A placeholder on purpose: which slug is "self"
// is per-LI_AUTHOR data, never a constant in the code.
const SELF = 'in/owner-slug';

let passed = 0;
const test = (name, fn) => {
  try { fn(); passed++; console.log(`ok   ${name}`); }
  catch (err) { console.error(`FAIL ${name}\n     ${String(err.message).split('\n').join('\n     ')}`); process.exitCode = 1; }
};

const U = (slug) => `https://www.linkedin.com/in/${slug}`;

// ------------------------------------------------------------ roster helpers

test('rosterUrls canonicalizes, dedupes and sorts', () => {
  const r = P.rosterUrls([
    { name: 'B', url: 'https://www.linkedin.com/in/b/' },
    { name: 'A', url: 'https://www.linkedin.com/in/a?trk=feed' },
    { name: 'B again', url: 'https://www.linkedin.com/in/b' },
  ]);
  assert.deepEqual(r.urls, [U('a'), U('b')]);
  assert.equal(r.unresolved, 0);
});

test('a roster url always resolves to the person\'s profile file', () => {
  // LinkedIn hands out locale suffixes ("/in/dc-ukr/en") and activity paths.
  // If the roster kept them, the URL would not match the profileKey that
  // names the file under dashboards/profiles/ — a dangling reference.
  for (const raw of [
    'https://www.linkedin.com/in/dc-ukr/en',
    'https://www.linkedin.com/in/dc-ukr/recent-activity/all/',
    'https://www.linkedin.com/in/dc-ukr/?trk=feed',
    'https://www.linkedin.com/in/dc-ukr',
  ]) {
    const r = P.rosterUrls([{ name: 'DC', url: raw }]);
    assert.deepEqual(r.urls, ['https://www.linkedin.com/in/dc-ukr'], `for ${raw}`);
    assert.equal(profileKey(r.urls[0]), 'in/dc-ukr');
  }
});

test('a reactor with no profile link is counted, never dropped', () => {
  const r = P.rosterUrls([
    { name: 'Named', url: U('named') },
    { name: 'LinkedIn Member', url: '' },
  ]);
  assert.deepEqual(r.urls, [U('named')]);
  assert.equal(r.unresolved, 1);
});

test('the dialog total is the only evidence of a private profile', () => {
  // Private members render with no anchor at all, so they never reach the
  // records array — `expected` minus what we resolved is the whole signal.
  const r = P.rosterUrls([{ name: 'A', url: U('a') }], { expected: 5 });
  assert.equal(r.unresolved, 4);
  // …and it never goes negative when we resolved more than expected.
  assert.equal(P.rosterUrls([{ name: 'A', url: U('a') }], { expected: 0 }).unresolved, 0);
});

test('an empty roster is [] with nothing unresolved', () => {
  assert.deepEqual(P.rosterUrls([]), { urls: [], unresolved: 0 });
  assert.deepEqual(P.rosterUrls(null), { urls: [], unresolved: 0 });
});

test('rosterFromComments keeps commenters the EVENT log has to skip', () => {
  // buildPostCommentEvents drops a comment with no URN because it cannot be
  // dated. The roster keeps it: an undatable comment is still a commenter.
  const comments = [
    { author_name: 'Old', author_url: U('old'), text: 'x' },                  // no comment_urn
    {
      author_name: 'New',
      author_url: U('new'),
      comment_urn: 'urn:li:comment:(activity:7487568033847070720,7491792908463964161)',
      text: 'y',
    },
  ];
  assert.deepEqual(P.rosterFromComments(comments).urls, [U('new'), U('old')]);
  const ev = P.buildPostCommentEvents({ post: { urn: 'urn:li:activity:1', post_url: 'u' }, comments });
  assert.equal(ev.events.length, 1);
  assert.equal(ev.undated, 1);
});

test('rosterFromReplies drops the owner replying to himself', () => {
  const r = P.rosterFromReplies([
    { name: 'The Owner', url: U('owner-slug') },
    { name: 'Someone', url: U('someone') },
  ], SELF);
  assert.deepEqual(r.urls, [U('someone')]);
  assert.equal(r.unresolved, 0);
});

test('isSelf matches by key and by url', () => {
  assert.ok(P.isSelf({ key: SELF, profile_url: '' }, SELF));
  assert.ok(P.isSelf({ key: 'other', profile_url: U('owner-slug') }, SELF));
  assert.equal(P.isSelf({ key: 'in/someone', profile_url: U('someone') }, SELF), false);
});

test('with no owner named, nobody is self', () => {
  // The de-personalisation guard: this fork must never assume whose account
  // it is scraping. No selfKey => no filtering, rather than a wrong filter.
  assert.equal(P.isSelf({ key: SELF, profile_url: U('owner-slug') }), false);
  assert.equal(P.isSelf(null, SELF), false);
  // And asking to drop an owner nobody named is a caller bug, not a silent no-op.
  assert.throws(() => P.rosterUrls([{ name: 'A', url: U('a') }], { dropSelf: true }), /selfKey/);
  assert.throws(() => P.rosterFromReplies([{ name: 'A', url: U('a') }]), /selfKey/);
});

test('recentOnly drops the never-scanned backlog', () => {
  const mk = (id, posted) => ({
    file: `${id}.json`,
    data: { urn: `urn:li:activity:${id}`, post_url: 'u', posted_at: posted, weeks: {} },
  });
  const entries = [mk('new', '2026-08-11T00:00:00Z'), mk('ancient', '2025-12-01T00:00:00Z')];
  const all = P.selectPostTargets(entries, { week: WEEK, scannedTargets: {} });
  assert.equal(all.selected.length, 2, 'by default the backlog is in scope');
  const recent = P.selectPostTargets(entries, { week: WEEK, scannedTargets: {}, recentOnly: true });
  assert.deepEqual(recent.selected.map((s) => s.file), ['new.json']);
  assert.equal(recent.selected[0].reason, 'recent');
});

// -------------------------------------------------------------- merge.py mode

// One corpus per author in this fork, so the fixture is discovered rather than
// pinned: any author dir carrying both halves will do — the merge half is
// about the write contract, not about whose numbers are in it.
const LI_STATS = (() => {
  const root = path.join(REPO_ROOT, 'dashboards', 'li-stats');
  if (fs.existsSync(path.join(root, 'comments.json'))) return root;
  const dirs = fs.readdirSync(root)
    .map((n) => path.join(root, n))
    .filter((p) => fs.statSync(p).isDirectory()
      && fs.existsSync(path.join(p, 'comments.json'))
      && fs.existsSync(path.join(p, 'posts')))
    .sort();
  assert.ok(dirs.length, `no author corpus with posts/ + comments.json under ${root}`);
  return dirs[0];
})();

// The newest week the corpus actually carries — pinning a date here would make
// the suite rot the moment the fixture is re-scraped.
const CORPUS_WEEK = (() => {
  const posts = path.join(LI_STATS, 'posts');
  const weeks = new Set();
  for (const n of fs.readdirSync(posts)) {
    if (!n.endsWith('.json')) continue;
    for (const w of Object.keys(JSON.parse(fs.readFileSync(path.join(posts, n), 'utf8')).weeks ?? {})) weeks.add(w);
  }
  const sorted = [...weeks].sort();
  assert.ok(sorted.length, `no post under ${posts} carries any week — fixture assumption broken`);
  return sorted[sorted.length - 1];
})();

const runMerge = (payload) => {
  const res = spawnSync('python3', [MERGE_PY], {
    input: JSON.stringify(payload), encoding: 'utf8', timeout: 30000,
  });
  return { status: res.status, out: (res.stdout || '').trim(), err: (res.stderr || '').trim() };
};
const val = (out, k) => Number(out.match(new RegExp(`${k}=(-?\\d+)`))?.[1] ?? NaN);
const row = (over = {}) => ({ reactors: null, commenters: null, ...over });

const withCorpus = (fn) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'week-people-'));
  try {
    fs.cpSync(LI_STATS, dir, { recursive: true });
    return fn(dir);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
};

const anyPost = (dir) => {
  const posts = path.join(dir, 'posts');
  const f = fs.readdirSync(posts).filter((n) => n.endsWith('.json')).sort()
    .map((n) => path.join(posts, n))
    .find((p) => Object.keys(JSON.parse(fs.readFileSync(p, 'utf8')).weeks ?? {}).includes(CORPUS_WEEK));
  assert.ok(f, `no post file carries weeks[${CORPUS_WEEK}] — fixture assumption broken`);
  return f;
};

test('a roster attaches to an EXISTING week entry without disturbing it', () => withCorpus((dir) => {
  const file = anyPost(dir);
  const before = JSON.parse(fs.readFileSync(file, 'utf8')).weeks[CORPUS_WEEK];
  const r = runMerge({
    mode: 'week_people', week: CORPUS_WEEK, comments_path: path.join(dir, 'comments.json'),
    posts: [{ path: file, ...row({ reactors: [U('b'), U('a')]}) }],
    comments: [],
  });
  assert.equal(r.status, 0, r.err);
  assert.equal(val(r.out, 'POSTS_UPDATED'), 1);
  assert.equal(val(r.out, 'WEEKS_CREATED'), 0);
  assert.equal(val(r.out, 'REACTOR_URLS'), 2);

  const after = JSON.parse(fs.readFileSync(file, 'utf8')).weeks[CORPUS_WEEK];
  assert.deepEqual(after.reactors, [U('a'), U('b')], 'stored sorted');
  assert.equal('reactors_unresolved' in after, false, 'the counter is a defect signal, not stored data');
  assert.equal(after.commenters, undefined, 'an unmeasured side is not invented');
  assert.deepEqual(after.metrics, before.metrics, 'the snapshot is untouched');
  assert.deepEqual(after.demographics, before.demographics);
  assert.equal(after.snapshot_at, before.snapshot_at);
}));

test('a missing week entry is created WITHOUT metrics', () => withCorpus((dir) => {
  const file = anyPost(dir);
  const r = runMerge({
    mode: 'week_people', week: '2030-01-07', comments_path: path.join(dir, 'comments.json'),
    posts: [{ path: file, ...row({ reactors: [U('a')]}) }],
    comments: [],
  });
  assert.equal(r.status, 0, r.err);
  assert.equal(val(r.out, 'WEEKS_CREATED'), 1);
  const entry = JSON.parse(fs.readFileSync(file, 'utf8')).weeks['2030-01-07'];
  assert.equal(entry.people_only, true);
  assert.equal('metrics' in entry, false, 'a metrics-less entry is what the build guard keys on');
  assert.equal('comments' in entry, false);
  assert.deepEqual(entry.reactors, [U('a')]);
}));

test('null means NOT MEASURED and never erases the other side', () => withCorpus((dir) => {
  const file = anyPost(dir);
  const p = path.join(dir, 'comments.json');
  runMerge({
    mode: 'week_people', week: CORPUS_WEEK, comments_path: p, comments: [],
    posts: [{ path: file, ...row({ commenters: [U('c')]}) }],
  });
  runMerge({
    mode: 'week_people', week: CORPUS_WEEK, comments_path: p, comments: [],
    posts: [{ path: file, ...row({ reactors: [U('r')]}) }], // commenters: null
  });
  const entry = JSON.parse(fs.readFileSync(file, 'utf8')).weeks[CORPUS_WEEK];
  assert.deepEqual(entry.commenters, [U('c')], 'a run that did not look must not clear it');
  assert.deepEqual(entry.reactors, [U('r')]);
}));

test('rosters UNION — a partial re-read never shrinks a good list', () => withCorpus((dir) => {
  const file = anyPost(dir);
  const p = path.join(dir, 'comments.json');
  runMerge({
    mode: 'week_people', week: CORPUS_WEEK, comments_path: p, comments: [],
    posts: [{ path: file, ...row({ reactors: [U('a'), U('b'), U('c')]}) }],
  });
  runMerge({
    mode: 'week_people', week: CORPUS_WEEK, comments_path: p, comments: [],
    posts: [{ path: file, ...row({ reactors: [U('a')]}) }],
  });
  const entry = JSON.parse(fs.readFileSync(file, 'utf8')).weeks[CORPUS_WEEK];
  assert.deepEqual(entry.reactors, [U('a'), U('b'), U('c')]);
}));

test('an outbound comment gets the same four keys', () => withCorpus((dir) => {
  const p = path.join(dir, 'comments.json');
  const urn = Object.keys(JSON.parse(fs.readFileSync(p, 'utf8')).comments)[0];
  const r = runMerge({
    mode: 'week_people', week: CORPUS_WEEK, comments_path: p, posts: [],
    comments: [{
      comment_urn: urn,
      ...row({ reactors: [U('r')], commenters: []}),
    }],
  });
  assert.equal(r.status, 0, r.err);
  assert.equal(val(r.out, 'COMMENTS_UPDATED'), 1);
  const entry = JSON.parse(fs.readFileSync(p, 'utf8')).comments[urn].weeks[CORPUS_WEEK];
  assert.deepEqual(entry.reactors, [U('r')]);
  assert.deepEqual(entry.commenters, [], 'measured-and-nobody is a real answer');
}));

test('an unknown path or urn is COUNTED, not crashed on', () => withCorpus((dir) => {
  const r = runMerge({
    mode: 'week_people', week: CORPUS_WEEK, comments_path: path.join(dir, 'comments.json'),
    posts: [{ path: path.join(dir, 'posts', 'does-not-exist.json'), ...row({ reactors: [U('a')]}) }],
    comments: [{ comment_urn: 'urn:li:comment:(activity:9,9)', ...row({ reactors: [U('a')]}) }],
  });
  assert.equal(r.status, 0, r.err);
  assert.equal(val(r.out, 'MISSING'), 2);
  assert.equal(val(r.out, 'POSTS_UPDATED'), 0);
}));

test('a malformed roster is refused as SCRAPE_BAD_SHAPE', () => withCorpus((dir) => {
  const file = anyPost(dir);
  // A side key missing entirely is a caller bug, not a tolerable input.
  const bad = runMerge({
    mode: 'week_people', week: CORPUS_WEEK, comments_path: path.join(dir, 'comments.json'), comments: [],
    posts: [{ path: file, reactors: [U('a')] }],
  });
  assert.notEqual(bad.status, 0);
  assert.match(bad.err, /SCRAPE_BAD_SHAPE/);

  for (const broken of [
    { reactors: 'not-a-list' },
    { reactors: [''] },
    { reactors: ['   '] },
    { reactors: [123] },
    { commenters: [null] },
  ]) {
    const res = runMerge({
      mode: 'week_people', week: CORPUS_WEEK, comments_path: path.join(dir, 'comments.json'), comments: [],
      posts: [{ path: file, ...row(broken) }],
    });
    assert.notEqual(res.status, 0, `expected refusal for ${JSON.stringify(broken)}`);
  }

  const badWeek = runMerge({
    mode: 'week_people', week: 'last-week', comments_path: path.join(dir, 'comments.json'),
    posts: [], comments: [],
  });
  assert.notEqual(badWeek.status, 0);
}));

test('every file the payload did not touch stays byte-identical', () => withCorpus((dir) => {
  const file = anyPost(dir);
  const snapshot = new Map();
  const walk = (d) => {
    for (const name of fs.readdirSync(d)) {
      const full = path.join(d, name);
      if (fs.statSync(full).isDirectory()) walk(full);
      else if (name.endsWith('.json')) snapshot.set(full, fs.readFileSync(full));
    }
  };
  walk(dir);

  runMerge({
    mode: 'week_people', week: CORPUS_WEEK, comments_path: path.join(dir, 'comments.json'), comments: [],
    posts: [{ path: file, ...row({ reactors: [U('a')]}) }],
  });

  for (const [full, before] of snapshot) {
    if (full === file) continue;
    assert.ok(before.equals(fs.readFileSync(full)), `merge.py rewrote an untouched file: ${full}`);
  }
}));

console.log(`\n${passed} passed${process.exitCode ? ' — WITH FAILURES' : ''}`);
