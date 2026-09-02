// Pure logic for the `people` phase: which targets to scan, and how captured
// reactors / commenters / repliers become engagement events.
//
// Kept browser-free on purpose — every rule in here is unit-testable, and the
// only thing scrape-weekly.mjs adds is the paced navigation and the DOM
// evaluators.
//
// THE DATING PROBLEM (read this before changing anything):
// LinkedIn timestamps comments but NOT reactions. A comment carries its own
// URN (`urn:li:comment:(activity:A,B)`) whose B decodes to an exact epoch-ms,
// so comment events are dated exactly and retroactively. A reaction carries
// nothing — so a reaction is dated by DIFFING this week's reactor set against
// the reactor set we already recorded for that target. Consequences:
//   - The first scan of a target is a BASELINE: its reactors are recorded with
//     backfill=true and excluded from weekly scores (they accrued over months,
//     attributing them to one week would be a lie).
//   - From the second scan on, the newly-appeared reactors are exactly the
//     people who reacted during the week that just ended, so they carry
//     attributed_week = the PREVIOUS ISO Monday (the run happens at the start
//     of week W and reports on week W-1).
//   - A reaction added and then removed between two scans is never seen, and a
//     retracted reaction is not subtracted (events are immutable).

import crypto from 'node:crypto';

export const DAY_MS = 86_400_000;
export const WEEK_MS = 7 * DAY_MS;

export function isoWeekMondayFromMs(ms) {
  const d = new Date(ms);
  const day = (d.getUTCDay() + 6) % 7; // Mon=0
  const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day));
  return m.toISOString().slice(0, 10);
}

export const weekToMs = (week) => Date.parse(`${week}T00:00:00Z`);

// The run happens at the start of week W and reports on the week that ended.
export const previousWeek = (week) => new Date(weekToMs(week) - WEEK_MS).toISOString().slice(0, 10);

// urn:li:comment:(activity:7487568033847070720,7491792908463964161) -> epoch ms
export function commentUrnToMs(urn) {
  const m = String(urn || '').match(/urn:li:comment:\(activity:\d+,(\d+)\)/);
  if (!m) return null;
  try { return Number(BigInt(m[1]) >> 22n); } catch { return null; }
}

// Person identity = normalized profile path ("in/kentgregoire"), with a name
// fallback for reactors LinkedIn renders without a profile link. A name that
// slugifies to nothing (Cyrillic, CJK, emoji-only) still gets a stable id from
// a hash of the name — dropping those people would silently under-count the
// Ukrainian and Russian half of the owner's audience.
export function personKey(url, name = '') {
  const raw = String(url || '').trim();
  if (raw) {
    try {
      const u = new URL(raw, 'https://www.linkedin.com');
      const p = u.pathname.replace(/\/+$/, '').replace(/^\/+/, '').toLowerCase();
      if (p) return p;
    } catch { /* fall through */ }
  }
  const clean = String(name || '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  const slug = clean
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 40).replace(/-+$/, '');
  if (slug) return `name:${slug}`;
  const hash = crypto.createHash('sha256').update(clean.toLowerCase(), 'utf8').digest('hex').slice(0, 12);
  return `name:${hash}`;
}

/**
 * The reactor dialog renders one anchor per person whose innerText is
 * "Name • 1st Headline" (name, connection degree, headline — separate spans
 * joined by innerText). There is no per-entry list item to read fields from,
 * so the label itself is the only source. Verified against the live dialog
 * 2026-08-17.
 */
export function parseReactorLabel(label) {
  const t = String(label || '').replace(/\s+/g, ' ').trim();
  if (!t) return { name: '', headline: '' };
  const idx = t.indexOf('•');
  if (idx < 0) return { name: t.slice(0, 120), headline: '' };
  const name = t.slice(0, idx).trim();
  // Degrees render as "1st", "2nd", "3rd" and also "3rd+" — without the
  // optional plus, every third-degree headline keeps a leading "+ ".
  const rest = t.slice(idx + 1).trim()
    .replace(/^(?:1st|2nd|3rd|\d+(?:st|nd|rd|th)|Following|You)\+?[\s•·]*/i, '')
    .trim();
  return { name: name.slice(0, 120), headline: rest.slice(0, 400) };
}

export function personRecord({ name, url, headline }) {
  const key = personKey(url, name);
  if (!key) return null;
  let profile_url = '';
  try {
    if (url) {
      const u = new URL(url, 'https://www.linkedin.com');
      let p = u.pathname.replace(/\/+$/, '');
      // Trailing segments are noise, not identity: LinkedIn hands out locale
      // suffixes ("/in/dc-ukr/en") and activity paths
      // ("/in/x/recent-activity/all"). Keep only "/in/<slug>" so this URL and
      // the profileKey that names the person's file agree — otherwise a
      // roster entry points at a profile file that does not exist.
      const m = p.match(/^(\/in\/[^/]+)/i);
      if (m) p = m[1];
      profile_url = u.origin + p;
    }
  } catch { profile_url = ''; }
  return {
    key,
    name: String(name || '').trim(),
    profile_url,
    headline: String(headline || '').replace(/\s+/g, ' ').trim().slice(0, 400),
  };
}

// ------------------------------------------------------------ target scoping

const targetIdForPost = (urn) => `post:${urn}`;
const targetIdForComment = (urn) => `comment:${urn}`;
export { targetIdForPost, targetIdForComment };

/**
 * Which posts are worth opening this run.
 *
 * Priority: counts changed since the previous snapshot > published recently >
 * never scanned (the baseline backlog). Everything is newest-first inside its
 * band, and the caller caps the list — the number dropped is reported, never
 * silently swallowed.
 *
 * `recentOnly` drops the never-scanned band entirely, so a run can be scoped
 * to "the last N days" instead of dragging in the whole back catalogue as
 * baselines. Used by the one-off roster backfill.
 */
export function selectPostTargets(entries, {
  week, maxPosts = 25, recentDays = 30, scannedTargets = {}, recentOnly = false,
} = {}) {
  const weekMs = weekToMs(week);
  const scored = [];
  for (const { file, data } of entries) {
    if (!data || (data.type || 'post') === 'repost') continue;
    if (!data.post_url || !data.urn) continue;
    const postedMs = Date.parse(data.posted_at || `${data.posted_date}T00:00:00Z`);
    const weeks = data.weeks ?? {};
    const keys = Object.keys(weeks).sort();
    const latest = keys.length ? weeks[keys[keys.length - 1]] : null;
    const prev = keys.length > 1 ? weeks[keys[keys.length - 2]] : null;
    const changed = !!(latest && prev
      && ((latest.metrics?.reactions ?? 0) !== (prev.metrics?.reactions ?? 0)
        || (latest.metrics?.comments ?? 0) !== (prev.metrics?.comments ?? 0)));
    const recent = Number.isFinite(postedMs) && (weekMs - postedMs) <= recentDays * DAY_MS;
    const neverScanned = !recentOnly && !scannedTargets[targetIdForPost(data.urn)];
    if (recentOnly && !recent) continue;
    if (!changed && !recent && !neverScanned) continue;
    scored.push({
      file,
      data,
      band: changed ? 0 : recent ? 1 : 2,
      postedMs: Number.isFinite(postedMs) ? postedMs : 0,
      reason: changed ? 'counts-changed' : recent ? 'recent' : 'never-scanned',
    });
  }
  scored.sort((a, b) => a.band - b.band || b.postedMs - a.postedMs);
  return { selected: scored.slice(0, maxPosts), dropped: Math.max(0, scored.length - maxPosts) };
}

/**
 * Which of the owner's own comments are worth opening this run — the ones young
 * enough to still be accruing reactions and replies. Mirrors the 30-day
 * snapshot cut-off the comments phase already uses.
 */
export function selectCommentTargets(commentsMap, { maxComments = 25, recentDays = 30, nowMs = Date.now() } = {}) {
  const rows = Object.values(commentsMap ?? {})
    .filter((c) => c.comment_urn && c.permalink)
    .map((c) => ({ comment: c, ms: Date.parse(c.commented_at || '') || 0 }))
    .filter((r) => r.ms && (nowMs - r.ms) <= recentDays * DAY_MS)
    .sort((a, b) => b.ms - a.ms);
  return { selected: rows.slice(0, maxComments), dropped: Math.max(0, rows.length - maxComments) };
}

// -------------------------------------------------------------- event models

/**
 * Reactors on one of the owner's posts. `isBaseline` (target never scanned before)
 * marks every reactor backfill=true so months of accumulated reactions do not
 * land in a single week.
 */
export function buildPostReactionEvents({ post, reactors, attributedWeek, isBaseline }) {
  const people = [];
  const events = [];
  for (const r of reactors) {
    const person = personRecord(r);
    if (!person) continue;
    people.push(person);
    events.push({
      event_id: `react:post:${post.urn}:${person.key}`,
      kind: 'reaction',
      target_type: 'post',
      target_urn: post.urn,
      target_url: post.post_url,
      person_key: person.key,
      occurred_at_ms: null,
      attributed_week: isBaseline ? null : attributedWeek,
      backfill: !!isBaseline,
    });
  }
  return { people, events };
}

/**
 * Commenters on one of the owner's posts, taken from the snapshot the metrics
 * phase just wrote. Only entries carrying a comment URN can be dated; entries
 * from older snapshots (scraped before the URN was captured) are skipped
 * rather than guessed at, and counted by the caller.
 */
export function buildPostCommentEvents({ post, comments }) {
  const people = [];
  const events = [];
  let undated = 0;
  for (const c of comments ?? []) {
    const ms = commentUrnToMs(c.comment_urn);
    if (!ms) { undated++; continue; }
    const person = personRecord({ name: c.author_name, url: c.author_url, headline: c.author_headline });
    if (!person) { undated++; continue; }
    people.push(person);
    events.push({
      event_id: `comment:${c.comment_urn}`,
      kind: 'comment',
      target_type: 'post',
      target_urn: post.urn,
      target_url: post.post_url,
      person_key: person.key,
      occurred_at_ms: ms,
      attributed_week: isoWeekMondayFromMs(ms),
      backfill: false,
      text: String(c.text || '').slice(0, 500),
    });
  }
  return { people, events, undated };
}

/** Reactors on one of the owner's own outbound comments. Same baseline rule as posts. */
export function buildCommentReactionEvents({ comment, reactors, attributedWeek, isBaseline }) {
  const people = [];
  const events = [];
  for (const r of reactors) {
    const person = personRecord(r);
    if (!person) continue;
    people.push(person);
    events.push({
      event_id: `react:comment:${comment.comment_urn}:${person.key}`,
      kind: 'reaction',
      target_type: 'comment',
      target_urn: comment.comment_urn,
      target_url: comment.permalink,
      person_key: person.key,
      occurred_at_ms: null,
      attributed_week: isBaseline ? null : attributedWeek,
      backfill: !!isBaseline,
    });
  }
  return { people, events };
}

// ------------------------------------------------------------------ rosters

/**
 * The account owner is not an engager with themselves.
 *
 * The owner is NEVER hardcoded here. `selfKey` is the `profile_slug`
 * ("in/<slug>") the caller read out of profiles.json for the LI_AUTHOR being
 * scraped, so one copy of this code serves every profile in the pool. With no
 * selfKey nobody is self — the honest default, because inventing an owner
 * would silently delete a real stranger from somebody else's roster.
 */
export function isSelf(person, selfKey = '') {
  const self = String(selfKey || '').trim().replace(/^\/+|\/+$/g, '').toLowerCase();
  if (!self || !person) return false;
  if (String(person.key || '').toLowerCase() === self) return true;
  const url = String(person.profile_url || '').trim().toLowerCase().replace(/\/+$/, '');
  return !!url && url.endsWith(`/${self}`);
}

/**
 * The "who engaged" list a week snapshot carries: canonical profile URLs, one
 * per person, deduped and sorted so a week's diff shows only real change. Each
 * URL resolves to a file under dashboards/profiles/.
 *
 * `unresolved` counts the people LinkedIn showed that could NOT be given a URL
 * — computed here, but deliberately NOT stored (upstream author, 2026-08-19:
 * "let's just drop them. if face such stuff, just break pipeline and fix
 * during self-improving stuff"). A roster is a list of profile links; a person
 * who has no link is a hole in it, and carrying a "some people are missing"
 * number next to the array forever just normalizes the hole. So the caller
 * treats a non-zero count as a DEFECT that blocks the merge and goes to the
 * revalidation session, which can open a browser and say whether it is a
 * genuinely private "LinkedIn Member" or a parser that stopped finding links.
 *
 * `expected` is the reaction dialog's own total. Private profiles render with
 * no anchor at all — they never reach `records` — so that total minus the URLs
 * found is the only evidence they were there.
 *
 * Expected to be 0 essentially always (12 of 12 on the first real corpus), so
 * a non-zero here reads as "a parser stopped finding links", not "someone was
 * shy". That is the whole reason it is worth failing on.
 *
 * `dropSelf` needs `selfKey` to mean anything: asking to drop an owner nobody
 * named is a caller bug, and it throws rather than quietly keeping the owner
 * in the roster.
 */
export function rosterUrls(records, { expected = null, dropSelf = false, selfKey = '' } = {}) {
  if (dropSelf && !String(selfKey || '').trim()) {
    throw new Error('rosterUrls: dropSelf needs selfKey (profile_slug of the LI_AUTHOR being scraped)');
  }
  const urls = new Set();
  let blank = 0;
  for (const r of records ?? []) {
    const p = personRecord(r);
    if (!p) { blank++; continue; }
    if (dropSelf && isSelf(p, selfKey)) continue;
    if (p.profile_url) urls.add(p.profile_url); else blank++;
  }
  const list = [...urls].sort();
  return {
    urls: list,
    unresolved: expected === null ? blank : Math.max(blank, expected - list.length),
  };
}

/**
 * Commenters on one of the owner's posts, from the snapshot the metrics phase
 * wrote. Unlike buildPostCommentEvents this KEEPS entries with no comment URN:
 * a comment that cannot be DATED is still a commenter.
 */
export const rosterFromComments = (comments) => rosterUrls(
  (comments ?? []).map((c) => ({ name: c.author_name, url: c.author_url, headline: c.author_headline })));

/**
 * Repliers to one of the owner's own comments. `selfKey` is required — the
 * whole point of this roster is that the owner's own replies are not
 * engagement with the owner, and which slug that is depends on LI_AUTHOR.
 */
export const rosterFromReplies = (replies, selfKey) => rosterUrls(
  (replies ?? []).map((r) => ({ name: r.name, url: r.url, headline: r.headline })),
  { dropSelf: true, selfKey });

/** Replies to one of the owner's own comments — dated exactly by their own URN. */
export function buildReplyEvents({ comment, replies, selfKey = '' }) {
  const people = [];
  const events = [];
  let undated = 0;
  for (const r of replies ?? []) {
    const ms = commentUrnToMs(r.reply_urn);
    if (!ms) { undated++; continue; }
    const person = personRecord({ name: r.name, url: r.url, headline: r.headline });
    if (!person) { undated++; continue; }
    // The account owner replying to themselves is not engagement with them.
    if (isSelf(person, selfKey)) continue;
    people.push(person);
    events.push({
      event_id: `reply:${r.reply_urn}`,
      kind: 'comment',
      target_type: 'comment',
      target_urn: comment.comment_urn,
      target_url: comment.permalink,
      person_key: person.key,
      occurred_at_ms: ms,
      attributed_week: isoWeekMondayFromMs(ms),
      backfill: false,
      text: String(r.text || '').slice(0, 500),
    });
  }
  return { people, events, undated };
}

/** Dedup people by key, keeping the richest record (a headline beats a blank). */
export function mergePeople(records) {
  const byKey = new Map();
  for (const r of records) {
    if (!r?.key) continue;
    const cur = byKey.get(r.key);
    if (!cur) { byKey.set(r.key, r); continue; }
    byKey.set(r.key, {
      key: r.key,
      name: cur.name || r.name,
      profile_url: cur.profile_url || r.profile_url,
      headline: cur.headline || r.headline,
    });
  }
  return [...byKey.values()];
}
