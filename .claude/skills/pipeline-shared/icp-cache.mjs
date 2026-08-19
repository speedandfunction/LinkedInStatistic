// The ICP author cache — SHARED between both LinkedIn pipelines.
//
// the owner, 2026-08-18: "this need to be shared between stats and hourly … all
// jsons should be stored in dashboards/li-stats." Both pipelines keep asking
// the same question about the same people:
//
//   * linkedin-comment-hourly's feed gate — "is this post's AUTHOR in the ICP?"
//     It can afford to open the author's profile page, so it produces the rich
//     evidence.
//   * linkedin-stats' `people` phase — "is this engager in the ICP?" It has
//     only a name and a headline, which is a documented false-negative source
//     (it rejected SpecStory's co-founder because the company name doesn't say
//     what it builds, 2026-08-17).
//
// One cache means the profile the comment gate scraped this morning is the
// evidence the weekly stats run reasons from, and a verdict is reached once
// per person instead of once per pipeline.
//
// WHAT IS STORED IS THE SCRAPED DATA, NOT THE ANSWER. The ICP definition
// moves — `sources/icp.md` is re-synced from ClickUp, `icp-filter.md` is a
// tuning knob — and every verdict goes stale with it, while the profile text
// stays exactly as good as the day it was read. So each entry carries the
// `rubric_hash` its verdict was reached under: when that no longer matches,
// the verdict is dropped and the person is re-judged FROM THE STORED TEXT,
// with no page load. That is the whole point of the file.
//
// Entry shape, keyed by normalized profile path ("in/<slug>"):
//   {
//     verdict: true | false | null,   // null = page read, not classified yet
//     confidence: 'high' | 'low',
//     reason: string,
//     evidence: 'card' | 'profile',
//     headline, headline_hash, rubric_hash, model,
//     decided_at,                     // when the VERDICT was computed
//     scraped_at, profile_url, profile_text   // profile entries only
//   }
//
// `scraped_at` and `decided_at` are deliberately separate: the no-touch window
// is measured from the SCRAPE, so re-judging cached data cannot slide it
// forward — otherwise a profile read once would never be re-read.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// Both pipelines' JSON lives here (the owner, 2026-08-18).
export const ICP_CACHE_REL_PATH = path.join('dashboards', 'li-stats', 'icp-authors.json');
export const DEFAULT_TTL_DAYS = 10;

const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const norm = (s) => String(s || '').replace(/[​‌‍﻿]/g, '')
  .toLowerCase().replace(/\s+/g, ' ').trim();
const oneLine = (s) => String(s || '').replace(/\s+/g, ' ').trim();

// ------------------------------------------------------------------ identity

// Person identity = the normalized profile path, the same shape
// linkedin-stats/fast/people.mjs `personKey` stores, so an entry written by
// either pipeline is found by the other. '' when the source carried no usable
// member-profile link — such a person is classified per post, never cached.
export function profileKey(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  try {
    const u = new URL(raw, 'https://www.linkedin.com');
    if (!/(^|\.)linkedin\.com$/i.test(u.hostname)) return '';
    const m = u.pathname.match(/\/in\/([^/?#]+)/i);
    if (!m) return '';
    const slug = decodeURIComponent(m[1]).replace(/\/+$/, '').toLowerCase();
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

// --------------------------------------------------------------------- ages

// Age of the SCRAPE — what the no-touch window is about. `decided_at` is the
// fallback for entries written before the two timestamps were split.
export function cacheAgeDays(entry, now = Date.now()) {
  const ms = Date.parse(entry?.scraped_at || entry?.decided_at || '');
  if (!Number.isFinite(ms)) return Infinity;
  const days = (now - ms) / 86_400_000;
  return days < 0 ? Infinity : days; // a future timestamp is corrupt, not fresh
}

// The scraped profile text a re-judge can run on: present, non-empty, read
// inside the window. Keyed on the DATA, not on `evidence` — `evidence` records
// what the last verdict was judged from, and a later headline-only verdict
// (linkedin-stats) must not make an existing scrape look absent.
export function cachedProfileData(entry, ttlDays = DEFAULT_TTL_DAYS) {
  if (!entry || !entry.profile_text || !String(entry.profile_text).trim()) return null;
  return cacheAgeDays(entry) <= ttlDays ? String(entry.profile_text) : null;
}

// "Opened once, then left alone for the window" applies to the PAGE LOAD, not
// just to the verdict: a profile read but not classified still must not be
// re-opened. Those reads are banked with `verdict: null` — get() skips them
// (no verdict to hand out) and this is what keeps the scraper off them.
export function profileReadRecently(cache, pkey, ttlDays = DEFAULT_TTL_DAYS) {
  if (!pkey) return false;
  const e = cache?.[pkey];
  if (!e || !e.scraped_at) return false; // no page was ever opened for them
  return cacheAgeDays(e) <= ttlDays;
}

// ------------------------------------------------------------- get / set

export function icpCacheGet(cache, pkey, headline, { rubricHash: rh, ttlDays = DEFAULT_TTL_DAYS } = {}) {
  if (!pkey) return null;
  const e = cache?.[pkey];
  if (!e || typeof e.verdict !== 'boolean') return null;
  if (cacheAgeDays(e) > ttlDays) return null;
  // A verdict reached under a different ICP rubric is not an answer to today's
  // question. Drop it — the caller re-judges from the stored profile data.
  if (rh && e.rubric_hash !== rh) return null;
  // Inside the window a PROFILE entry is untouchable even if the headline
  // moved: that page was already opened and paid for. A CARD entry has no such
  // cost — re-judging one is free — so a changed headline invalidates it.
  if (e.evidence !== 'profile' && e.headline_hash !== headlineHash(headline)) return null;
  return e;
}

// Scraped page data SURVIVES every write. Only a fresh read (`profileText`
// supplied) replaces it; everything else — a re-judge, or a headline-only
// verdict from the stats pipeline — carries it over untouched. Without this a
// cheap card verdict would silently delete a profile the other pipeline paid a
// page load for.
export function icpCacheSet(cache, pkey, headline, v, { rubricHash: rh = '' } = {}) {
  if (!pkey) return cache; // no profile link — nothing stable to key on
  const prev = cache[pkey] || {};
  const fresh = v.profileText != null; // a real page read
  const keepsProfile = fresh || prev.profile_text;
  cache[pkey] = {
    verdict: typeof v.verdict === 'boolean' ? v.verdict : null,
    confidence: v.confidence || 'low',
    reason: oneLine(v.reason).slice(0, 200),
    evidence: v.evidence,
    headline: oneLine(headline).slice(0, 300),
    headline_hash: headlineHash(headline),
    rubric_hash: rh,
    model: v.model || null,
    decided_at: nowIso(),
    ...(keepsProfile ? {
      scraped_at: fresh ? nowIso() : (prev.scraped_at || prev.decided_at || nowIso()),
      profile_url: fresh ? (v.profileUrl || null) : (prev.profile_url ?? null),
      profile_text: fresh ? String(v.profileText || '') : String(prev.profile_text || ''),
    } : {}),
  };
  return cache;
}

// ------------------------------------------------------------- load / save

export function loadIcpCache(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch { /* absent or corrupt — a cache miss is never fatal */ }
  return {};
}

// node writes this file, not jq: the "jq is the only serializer" rule guards
// comments.json (the seen-set), not a derived cache. Sorted keys + stable
// 2-space JSON keep the diff readable; tmp+rename keeps it whole.
// Returns null on success, or the error message (never throws — losing the
// cache costs a re-scrape, not a run).
export function saveIcpCache(file, cache) {
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    const sorted = {};
    for (const k of Object.keys(cache).sort()) sorted[k] = cache[k];
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, `${JSON.stringify(sorted, null, 2)}\n`);
    fs.renameSync(tmp, file);
    return null;
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    return String(e.message).split('\n')[0];
  }
}
