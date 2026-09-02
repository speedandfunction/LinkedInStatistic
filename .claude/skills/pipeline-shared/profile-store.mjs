// The person/profile cache — SHARED between both LinkedIn pipelines.
//
// The owner, 2026-08-19: "create a dashboards/profiles folder that is gonna be
// cache. each file contains profile for each scraped person, with date when it
// was last updated." This supersedes the single-file `icp-authors.json` map.
//
// ONE FILE PER PERSON, keyed by the normalized profile path ("in/<slug>"):
//
//   dashboards/profiles/greg-ceccarelli.json
//   dashboards/profiles/nimish-gatam-44125512--3f1c9a02b8e4d570.json
//
// Both pipelines keep asking the same questions about the same people:
//
//   * linkedin-comment-hourly's feed gate — "is this post's AUTHOR in the ICP?"
//     It can afford to open the author's profile page, so it produces the rich
//     evidence (`profile_text`).
//   * linkedin-stats' `people` phase — "who engaged with this post, and are
//     they in the ICP?" It NEVER opens a profile page (the owner, 2026-08-19:
//     "don't even think to open each profile"); it records what the reaction
//     overlay and comment cards already hand it — name, headline, link.
//
// One store means the profile the comment gate scraped this morning is the
// evidence the weekly stats run reasons from, and a person is described once
// instead of once per pipeline.
//
// WHAT IS STORED IS THE SCRAPED DATA, NOT THE ANSWER. The ICP definition moves
// — `sources/icp.md` is re-synced from ClickUp, `icp-filter.md` is a tuning
// knob — and every verdict goes stale with it, while the profile stays exactly
// as good as the day it was read. So the verdict lives in a nested `icp` block
// carrying the `rubric_hash` it was reached under: when that no longer matches,
// the verdict is dropped and the person is re-judged FROM THE STORED TEXT, with
// no page load. That is the whole point of the store.
//
// Record shape:
//   {
//     schema: 1,
//     key: "in/<slug>",
//     profile_url, name, headline, headline_hash,   // headline LAST SEEN
//     first_seen_at, updated_at,
//     scraped_at,      // when the PAGE was read — null if never opened
//     profile_text,    // null unless a pipeline actually opened the page
//     icp: null | {
//       verdict: true | false | null,   // null = page read, not classified yet
//       confidence: 'high' | 'low',
//       reason, evidence: 'card' | 'profile', model,
//       rubric_hash,     // the ICP rubric this verdict was reached under
//       headline_hash,   // the headline this verdict was JUDGED on
//       decided_at,      // when the VERDICT was computed
//     }
//   }
//
// `scraped_at` and `icp.decided_at` are deliberately separate: the no-touch
// window is measured from the SCRAPE, so re-judging cached data cannot slide it
// forward — otherwise a profile read once would never be re-read.
//
// The top-level `headline_hash` is the headline last SEEN; `icp.headline_hash`
// is the headline the verdict was JUDGED on. A card verdict goes stale when
// they diverge; a profile verdict does not (that page was already paid for).

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// Both pipelines' profile files live here (the owner, 2026-08-19).
export const PROFILES_REL_DIR = path.join('dashboards', 'profiles');
export const DEFAULT_TTL_DAYS = 10;
export const SCHEMA_VERSION = 1;

const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const norm = (s) => String(s || '').replace(/[​‌‍﻿]/g, '')
  .toLowerCase().replace(/\s+/g, ' ').trim();
const oneLine = (s) => String(s || '').replace(/\s+/g, ' ').trim();

// ------------------------------------------------------------------ identity

// Person identity = the normalized profile path, the same shape
// linkedin-stats/fast/people.mjs `personKey` stores, so a record written by
// either pipeline is found by the other. '' when the source carried no usable
// member-profile link — such a person is classified per post, never cached.
//
// NFC-normalized: without it a percent-encoded NFD URL and its NFC twin are two
// keys for one human — and now two FILES.
export function profileKey(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  try {
    const u = new URL(raw, 'https://www.linkedin.com');
    if (!/(^|\.)linkedin\.com$/i.test(u.hostname)) return '';
    const m = u.pathname.match(/\/in\/([^/?#]+)/i);
    if (!m) return '';
    const slug = decodeURIComponent(m[1]).normalize('NFC').replace(/\/+$/, '').toLowerCase();
    return /[a-z0-9]/i.test(slug) ? `in/${slug}` : '';
  } catch { return ''; }
}

export const headlineHash = (headline) =>
  crypto.createHash('sha256').update(norm(headline), 'utf8').digest('hex').slice(0, 16);

// The rubric a verdict was reached under: `sources/icp.md` + the pipeline's
// decision rules. Pass the same texts in the same order from every caller, or
// the two pipelines will invalidate each other's verdicts forever.
export const rubricHash = (...texts) =>
  crypto.createHash('sha256').update(texts.map((t) => String(t || '')).join('\n---\n'), 'utf8')
    .digest('hex').slice(0, 16);

// Profile-URL bullets from a markdown section. Only `- `/`* ` bullet lines
// count, and fenced/inline code is stripped first — otherwise a file's own
// format example parses as a real entry (exactly how readVipKeys in
// .github/scripts/build-stats-json.mjs got burned on its first run).
export function readProfileList(md, section = null) {
  const clean = String(md || '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`\n]*`/g, '');
  const want = section ? section.toLowerCase() : null;
  const keys = new Set();
  let inSection = !want;
  for (const line of clean.split('\n')) {
    const h = line.match(/^\s{0,3}#{1,6}\s+(.*)$/);
    if (h) { inSection = !want || h[1].toLowerCase().includes(want); continue; }
    if (!inSection) continue;
    if (!/^\s*[-*]\s/.test(line)) continue;
    for (const m of line.matchAll(/https?:\/\/(?:[a-z0-9-]+\.)*linkedin\.com\/in\/([A-Za-z0-9\-_%.]+)/gi)) {
      const k = profileKey(`https://www.linkedin.com/in/${m[1]}`);
      if (k) keys.add(k);
    }
  }
  return keys;
}

// ------------------------------------------------------------ file naming

// Deterministic key -> filename, so a lookup needs no index and no readdir.
//
// Two disjoint branches: a plain slug becomes itself, anything else is folded
// to ASCII and disambiguated by a hash of the FULL slug. They cannot collide
// because '--' is forbidden in the plain branch and mandatory in the folded
// one. Lowercase-only output keeps APFS case-insensitivity a non-issue.
const PLAIN_NAME = /^[a-z0-9][a-z0-9._-]{0,80}$/;

function asciiFold(slug) {
  const s = slug.normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 60)
    .replace(/[-.]+$/, '');
  return s || 'x';
}

export function profileFileName(pkey) {
  const slug = String(pkey || '').startsWith('in/') ? String(pkey).slice(3) : '';
  if (!slug) return '';
  if (PLAIN_NAME.test(slug) && !slug.includes('--') && !slug.endsWith('.')) {
    return `${slug}.json`;
  }
  const hash = crypto.createHash('sha256').update(slug, 'utf8').digest('hex').slice(0, 16);
  return `${asciiFold(slug)}--${hash}.json`;
}

// --------------------------------------------------------------------- ages

// Age of the SCRAPE — what the no-touch window is about. `icp.decided_at` is
// the fallback for records that were never scraped but were judged from a card.
export function recordAgeDays(rec, now = Date.now()) {
  const ms = Date.parse(rec?.scraped_at || rec?.icp?.decided_at || '');
  if (!Number.isFinite(ms)) return Infinity;
  const days = (now - ms) / 86_400_000;
  return days < 0 ? Infinity : days; // a future timestamp is corrupt, not fresh
}

// The scraped profile text a re-judge can run on: present, non-empty, read
// inside the window. Keyed on the DATA, not on `icp.evidence` — evidence
// records what the last verdict was judged from, and a later headline-only
// verdict (linkedin-stats) must not make an existing scrape look absent.
export function cachedProfileData(rec, ttlDays = DEFAULT_TTL_DAYS) {
  if (!rec || !rec.profile_text || !String(rec.profile_text).trim()) return null;
  return recordAgeDays(rec) <= ttlDays ? String(rec.profile_text) : null;
}

// "Opened once, then left alone for the window" applies to the PAGE LOAD, not
// just to the verdict: a profile read but not classified still must not be
// re-opened. Those reads are banked with `icp.verdict: null` — verdictOf skips
// them (no verdict to hand out) and this is what keeps the scraper off them.
export function wasReadRecently(rec, ttlDays = DEFAULT_TTL_DAYS) {
  if (!rec || !rec.scraped_at) return false; // no page was ever opened for them
  return recordAgeDays(rec) <= ttlDays;
}

// -------------------------------------------------------------- the verdict

export function verdictOf(rec, headline, { rubricHash: rh, ttlDays = DEFAULT_TTL_DAYS } = {}) {
  const icp = rec?.icp;
  if (!icp || typeof icp.verdict !== 'boolean') return null;
  if (recordAgeDays(rec) > ttlDays) return null;
  // A verdict reached under a different ICP rubric is not an answer to today's
  // question. Drop it — the caller re-judges from the stored profile data.
  if (rh && icp.rubric_hash !== rh) return null;
  // Inside the window a PROFILE verdict is untouchable even if the headline
  // moved: that page was already opened and paid for. A CARD verdict has no
  // such cost — re-judging one is free — so a changed headline invalidates it.
  if (icp.evidence !== 'profile' && icp.headline_hash !== headlineHash(headline)) return null;
  return icp;
}

// ---------------------------------------------------------------- the store

// Key order is fixed so a record rewritten with the same content produces a
// byte-identical file (readable git diffs).
const ORDER = [
  'schema', 'key', 'profile_url', 'name', 'headline', 'headline_hash',
  'first_seen_at', 'updated_at', 'scraped_at', 'profile_text', 'icp',
];
const ICP_ORDER = [
  'verdict', 'confidence', 'reason', 'evidence', 'model',
  'rubric_hash', 'headline_hash', 'decided_at',
];

const ordered = (obj, keys) => {
  const out = {};
  for (const k of keys) out[k] = obj[k] === undefined ? null : obj[k];
  return out;
};

/**
 * Lazy per-person store. Reads one file on demand, memoizes (misses too), and
 * writes only the records that changed, on flush().
 *
 * @param dir        read root; null for an in-memory store (tests)
 * @param writeDir   flush target; null => dir. This is the --dry-run redirect.
 * @param ttlDays    the no-touch / verdict-freshness window
 * @param rubricHash the ICP rubric verdicts are read and written under
 * @param seed       {pkey: record} preloaded records (tests)
 */
export function openProfileStore(dir, {
  writeDir = null, ttlDays = DEFAULT_TTL_DAYS, rubricHash: rh = '', seed = null,
} = {}) {
  const cache = new Map(); // pkey -> record | null (null is a memoized miss)
  const dirty = new Set();
  const s = { files: null, loaded: 0, hits: 0, misses: 0, written: 0, failed: 0 };
  let rubric = rh;

  if (seed) for (const [k, v] of Object.entries(seed)) cache.set(k, v);

  const fileFor = (root, pkey) => {
    const name = profileFileName(pkey);
    return name ? path.join(root, name) : '';
  };

  const readOne = (pkey) => {
    if (!dir) return null;
    const file = fileFor(dir, pkey);
    if (!file) return null;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch { /* absent or corrupt — a cache miss is never fatal */ }
    return null;
  };

  const writeOne = (pkey, rec) => {
    const root = writeDir || dir;
    if (!root) return null; // memory-only store
    const file = fileFor(root, pkey);
    if (!file) return null;
    const tmp = `${file}.tmp-${process.pid}`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(tmp, `${JSON.stringify(rec, null, 2)}\n`);
      fs.renameSync(tmp, file);
      return null;
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      return String(e.message).split('\n')[0];
    }
  };

  const get = (pkey) => {
    if (!pkey) return null;
    if (cache.has(pkey)) {
      const hit = cache.get(pkey);
      if (hit) s.hits++; else s.misses++;
      return hit;
    }
    const rec = readOne(pkey);
    cache.set(pkey, rec);
    if (rec) { s.loaded++; s.hits++; } else { s.misses++; }
    return rec;
  };

  /**
   * Upsert. `v.profileText != null` means a real page read: it replaces
   * profile_text/profile_url and advances scraped_at. Anything else — a
   * re-judge, or a headline-only verdict from the stats pipeline — leaves the
   * scrape untouched, structurally: those fields are simply not assigned.
   *
   * Passing no verdict fields at all (just name/headline) is the stats
   * pipeline's "I saw this person" write.
   */
  const set = (pkey, headline, v = {}) => {
    if (!pkey) return null; // no profile link — nothing stable to key on
    const prev = get(pkey) || {};
    const now = nowIso();
    const fresh = v.profileText != null;
    const hl = oneLine(headline).slice(0, 300) || prev.headline || '';

    const rec = ordered({
      ...prev,
      schema: SCHEMA_VERSION,
      key: pkey,
      // Never overwrite a known value with an empty one: the reaction overlay
      // sometimes renders a person without a headline or a name.
      profile_url: v.profileUrl || prev.profile_url || null,
      name: oneLine(v.name).slice(0, 200) || prev.name || null,
      headline: hl || null,
      headline_hash: hl ? headlineHash(hl) : (prev.headline_hash ?? null),
      first_seen_at: prev.first_seen_at || now,
      updated_at: now,
      scraped_at: fresh ? now : (prev.scraped_at ?? null),
      profile_text: fresh ? String(v.profileText || '') : (prev.profile_text ?? null),
    }, ORDER);

    const hasVerdict = v.verdict !== undefined || v.evidence !== undefined;
    if (hasVerdict) {
      rec.icp = ordered({
        verdict: typeof v.verdict === 'boolean' ? v.verdict : null,
        confidence: v.confidence || 'low',
        reason: oneLine(v.reason).slice(0, 200),
        evidence: v.evidence || null,
        model: v.model || null,
        rubric_hash: v.rubricHash ?? rubric,
        headline_hash: headlineHash(hl),
        decided_at: now,
      }, ICP_ORDER);
    } else {
      rec.icp = prev.icp ?? null;
    }

    // `updated_at` means "last CHANGED", not "last looked at". A pipeline that
    // re-sees the same person every week must not rewrite 50 identical files
    // with a fresh timestamp — that is pure git churn, and it would make the
    // one date the owner asked for meaningless.
    const same = prev.key && JSON.stringify({ ...rec, updated_at: null })
      === JSON.stringify({ ...ordered(prev, ORDER), updated_at: null });
    if (same) {
      cache.set(pkey, prev);
      return prev;
    }

    cache.set(pkey, rec);
    dirty.add(pkey);
    return rec;
  };

  return {
    get,
    set,
    verdict: (pkey, headline) => verdictOf(get(pkey), headline, { rubricHash: rubric, ttlDays }),
    profileText: (pkey) => cachedProfileData(get(pkey), ttlDays),
    readRecently: (pkey) => (pkey ? wasReadRecently(get(pkey), ttlDays) : false),
    setRubricHash: (h) => { rubric = h; },
    getRubricHash: () => rubric,
    ttlDays,
    dirtyCount: () => dirty.size,

    // One readdir, memoized. Never reads a file.
    count: () => {
      if (s.files === null) {
        try {
          s.files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).length;
        } catch { s.files = 0; }
      }
      return s.files;
    },

    stats: () => ({ ...s, files: s.files, dirty: dirty.size }),

    // Full read — maintenance and debugging only, never the hot path.
    * scan() {
      let names = [];
      try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return; }
      for (const name of names.sort()) {
        try {
          const rec = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
          if (rec && rec.key) yield [rec.key, rec];
        } catch { /* a corrupt file is skipped, never fatal */ }
      }
    },

    // Writes only what changed. Never throws — losing the cache costs a
    // re-scrape, not a run.
    flush() {
      const errors = [];
      let written = 0;
      let failed = 0;
      for (const pkey of [...dirty]) {
        const rec = cache.get(pkey);
        if (!rec) { dirty.delete(pkey); continue; }
        const err = writeOne(pkey, rec);
        if (err) { failed++; errors.push(`${pkey}: ${err}`); } else { written++; dirty.delete(pkey); }
      }
      s.written += written;
      s.failed += failed;
      if (written) s.files = null; // the readdir count is stale now
      return { written, failed, errors };
    },
  };
}
