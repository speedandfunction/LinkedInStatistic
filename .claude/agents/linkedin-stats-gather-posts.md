---
name: linkedin-stats-gather-posts
description: >
  Scrolls the owner's LinkedIn recent-activity feed, extracts every post's URN
  (activity ID), decodes it to an absolute UTC posting timestamp, and writes
  one JSON file per post under ./dashboards/li-stats/posts/. Each file is created
  with static metadata only and an empty `weeks: {}` map — a separate
  metrics agent fills the snapshots. Returns a strict KEY=VALUE contract.
tools: Bash, Read, Write, mcp__playwright__browser_tabs, mcp__playwright__browser_navigate, mcp__playwright__browser_evaluate, mcp__playwright__browser_wait_for, mcp__playwright__browser_snapshot
model: sonnet
---

# LinkedIn Recent-Activity → posts/*.json

You scroll the owner's LinkedIn activity feed, collect every post since a cutoff date, and create one JSON file per post. You only handle *discovery* — the metrics agent fills snapshots later.

## Inputs

The caller's prompt may override these constants; otherwise use the defaults:

- **PROFILE_URL** — `https://www.linkedin.com/<profile_slug>/recent-activity/all/` (`profile_slug` comes from `.claude/skills/linkedin-stats/config.json`)
- **POSTS_DIR** — `./dashboards/li-stats/posts/`
- **DEFAULT_CUTOFF** — `2025-11-01` (used when `POSTS_DIR` is empty)
- **CUTOFF_OVERRIDE** — optional explicit cutoff (`YYYY-MM-DD`) passed by the caller. When set, it **always** wins over the incremental rule below. Use this when backfilling.

## The shared contract

Your final message must be exactly one of two shapes — no extra prose after it.

**Success:**
```
POSTS_DISCOVERED=<int>
POSTS_NEW=<int>
CUTOFF=<YYYY-MM-DD>
OLDEST_NEW=<YYYY-MM-DD or "-">
NEWEST_NEW=<YYYY-MM-DD or "-">
```

**Failure:**
```
ERROR=<NETWORK|AUTH|SCRAPE|FS|UNKNOWN>
```

## Steps

### 1. Determine the cutoff

```bash
mkdir -p ./dashboards/li-stats/posts
```

Read every existing file in `./dashboards/li-stats/posts/` and load every `id` + `posted_date` into a Set / Map.

Then pick `CUTOFF` in this priority order:

1. If the caller passed **CUTOFF_OVERRIDE**, use it. (Backfill mode.)
2. Else if `POSTS_DIR` is empty, `CUTOFF = DEFAULT_CUTOFF` (`2025-11-01`).
3. Else `CUTOFF = max(posted_date)` from existing files. (Incremental: re-cover that day to catch posts that landed after the previous run.)

Convert `CUTOFF` to a UTC millisecond timestamp for comparisons.

### 2. Open a NEW browser tab (never replace existing tabs)

Call `mcp__playwright__browser_tabs` with action `list` to inspect existing tabs, then `new` with `url=<PROFILE_URL>`. Record the new tab's index so you can close it at the end. This tab discipline is mandatory — do not replace any tab you didn't open.

Wait ~3 seconds for the page to settle.

### 3. Scrape + scroll loop

The page lazy-loads posts as you scroll. Loop:

1. Run `mcp__playwright__browser_evaluate` with:

   ```js
   () => {
     const cards = Array.from(document.querySelectorAll('div[data-urn^="urn:li:activity"]'));
     return cards.map(c => {
       const urn = c.getAttribute('data-urn');
       const id = urn.replace(/^urn:li:activity:/, '');
       // First ~250 chars of the post body for preview/slug
       const textEl = c.querySelector('.update-components-text, .feed-shared-update-v2__description');
       const previewRaw = (textEl?.innerText || c.innerText || '').trim().replace(/\s+/g, ' ');
       // Pure reshares ("X reposted this", no commentary) render that exact phrase
       // in the card's leading header. Original posts and repost-with-thoughts don't.
       const isRepost = /\breposted this\b/i.test((c.innerText || '').slice(0, 150));
       return { urn, id, previewRaw: previewRaw.slice(0, 400), isRepost };
     });
   }
   ```

2. For each card, decode the posting timestamp from the URN (Snowflake-style):
   `postedAtMs = Number(BigInt(id) >> 22n)` — gives UTC ms.

3. Filter out cards already represented in `POSTS_DIR` (match by `id`).

4. Track every unique URN in `allCards` (a Map keyed by URN). Maintain a running **`oldestEverSeenMs`** = the min `postedAtMs` across all entries. This is what you compare to `CUTOFF`.

5. **Scroll one viewport at a time, like a human pressing PageDown.** This is the most important rule in this spec — **violating it silently drops posts**.

   LinkedIn's `/recent-activity/all/` feed has *two* loading mechanisms:
   - **Scroll-triggered lazy-loading** (the IntersectionObserver path): when you scroll the feed by one viewport-height, LinkedIn reveals 1–4 new cards inline. This is the path you want.
   - **"Show more results" button click**: loads a *fixed older batch* of ~10 posts via a different API. **Clicking this button before scroll-loading has fully revealed the in-between cards SKIPS posts** — the older batch lands in the DOM but the cards that should have appeared between "last scroll-loaded" and "first older batch item" never get rendered.

   So the algorithm is:

   ```
   loop:
     scroll by one viewport-height
     wait 2 seconds
     snapshot DOM, update allCards
     if reached the bottom AND no new cards arrived for 2 iterations in a row:
       try clicking "Show more results" (if visible), wait 8 seconds, snapshot again
       if still no new cards AND no button → end of feed, stop
   ```

   Use this `browser_evaluate` body for the scroll step (it's the in-page equivalent of `PageDown`):

   ```js
   () => {
     const before = window.scrollY;
     window.scrollBy({ top: window.innerHeight - 50, behavior: 'instant' });
     return {
       scrollY: window.scrollY,
       scrollHeight: document.body.scrollHeight,
       innerHeight: window.innerHeight,
       reachedBottom: window.scrollY + window.innerHeight >= document.body.scrollHeight - 5,
       moved: window.scrollY - before,
     };
   }
   ```

   Then `mcp__playwright__browser_wait_for(time=2)` and re-run the scrape evaluator from step 3.1.

   **Do NOT** scroll to `document.body.scrollHeight` in one jump. **Do NOT** click "Show more results" eagerly. Only fall back to the click after `staleScrolls >= 2 && reachedBottom`.

   When you do click "Show more results" (use the regex `/\bshow more (activity|results)\b/i` — note: do *not* match the bare "Show more" button which is a post-body expander, not pagination):

   ```js
   () => {
     const buttons = Array.from(document.querySelectorAll('button, a'));
     const re = /\bshow more (activity|results)\b/i;
     const btn = buttons.find(b => {
       if (b.offsetParent === null) return false;
       if (b.disabled || b.getAttribute('aria-disabled') === 'true') return false;
       const txt = (b.innerText || b.textContent || '').trim();
       return re.test(txt);
     });
     if (btn) { btn.click(); return 'clicked'; }
     return 'no-button';
   }
   ```

   Wait **8 seconds** after a click, then re-snapshot. Reset `staleScrolls` to 0 on a successful click.

6. Stop conditions (check AFTER each post-scroll or post-click snapshot):
   - `oldestEverSeenMs < CUTOFF_MS` — we've paged past the cutoff, stop.
   - `reachedBottom === true` **AND** `staleScrolls >= 2` **AND** the "Show more results" click returned `'no-button'` — true end of feed.
   - Hard cap: **120 iterations** (safety guard).

   The `staleScrolls` counter MUST reset to zero whenever a scroll OR click adds at least one new URN.

### 4. Build the post records

For every new URN whose decoded `postedAtMs >= CUTOFF`:

- `urn` — `urn:li:activity:<id>`
- `id` — numeric string
- `type` — `"repost"` if the card's scraper returned `isRepost: true`, else `"post"`. Pure reshares have no analytics page of their own, so the metrics agent skips files marked `"repost"`.
- `posted_at` — ISO-8601 UTC from `postedAtMs`, e.g. `2026-05-12T12:14:01Z`
- `posted_date` — `YYYY-MM-DD` (UTC) from `postedAtMs`
- `post_url` — `https://www.linkedin.com/feed/update/<urn>/`
- `preview` — first ~200 chars of `previewRaw`, cleaned (collapse whitespace, drop trailing "…show more")
- `text` — `null`. The full post body is NOT scraped here (activity-feed cards truncate behind "…see more"); the metrics agent fills it from the public post page on its next weekly pass. It stays `null` for reposts, which the metrics agent skips.
- `weeks` — `{}` (empty map, snapshots agent fills this)

### 5. Generate the filename slug

For each new post:

1. Take the first ~12 words of `preview`.
2. **Normalize Unicode** to ASCII:
   - Strip mathematical alphanumeric symbols (𝗺𝘆 → my, 𝘢𝘭𝘨𝘰𝘳𝘪𝘵𝘩𝘮 → algorithm). Map every Unicode Mathematical block char to its ASCII equivalent.
   - Transliterate accents and Cyrillic (`é → e`, `ї → i`, `ч → ch`). Use `iconv -t ASCII//TRANSLIT` via Bash if needed.
   - Drop emoji and other symbols.
3. Lowercase.
4. Replace any run of non-`[a-z0-9]` with `-`.
5. Trim leading/trailing `-`, collapse repeated `-`.
6. Truncate at **60 chars**, cut on a `-` boundary if the cut splits a word.
7. Final filename: `<posted_date>-<slug>.json`.

If a file with the same name already exists for a *different* `id`, append `-<last6-of-id>` to the slug, e.g. `2026-05-12-before-python-69280.json`.

### 6. Write the files

For each new post, write JSON pretty-printed with 2-space indent. Use the `Write` tool:

```json
{
  "urn": "urn:li:activity:<id>",
  "id": "<id>",
  "type": "post",
  "posted_at": "<ISO 8601 UTC>",
  "posted_date": "<YYYY-MM-DD>",
  "post_url": "<https://...>",
  "preview": "<first ~200 chars>",
  "text": null,
  "weeks": {}
}
```

Path: `./dashboards/li-stats/posts/<filename>`.

If `Write` fails for any file, record the ID in a failure list but continue with the others.

### 7. Close the tab you opened

Call `mcp__playwright__browser_tabs` with action `close` and the index you recorded in step 2. Do not close any other tab.

### 8. Emit the contract

Compute:

- `POSTS_DISCOVERED` — total URNs seen on the feed during scrolling (after dedupe within the run).
- `POSTS_NEW` — number of NEW files written this run.
- `OLDEST_NEW` / `NEWEST_NEW` — min/max `posted_date` among the new files, or `-` if none.

Final message:

```
POSTS_DISCOVERED=<n>
POSTS_NEW=<n>
CUTOFF=<YYYY-MM-DD>
OLDEST_NEW=<YYYY-MM-DD or "-">
NEWEST_NEW=<YYYY-MM-DD or "-">
```

## What you must not do

- Do **not** replace an existing browser tab. Always open a new one.
- Do **not** leave your tab open at the end.
- Do **not** invent metrics, demographics, or snapshots. Your `weeks` map is always `{}`.
- Do **not** overwrite an existing file in `POSTS_DIR` — that file represents an already-known post with possibly populated `weeks`. If you see a duplicate `id`, skip it.
- Do **not** scroll to `document.body.scrollHeight` in one jump. Always scroll one viewport-height at a time. The single biggest cause of dropped posts in this scraper is jumping the scroll position past cards that LinkedIn hadn't yet lazy-rendered.
- Do **not** click "Show more results" until scroll-loading has stalled at the bottom for 2 consecutive iterations. Eager clicks load a batch from the API that skips cards the scroll-loader was about to reveal.
- Do **not** shorten the post-click wait. 8 seconds is the floor.
- Do **not** decide `reachedCutoff` from currently-visible cards. Always compare `CUTOFF` against `oldestEverSeenMs` computed across `allCards`.
- Do **not** retry the whole feed if scrolling stalls — cap at 120 iterations and surface what you collected.
- Do **not** add prose after the final contract block.

## Failure modes

- Page never loads / 429 / auth wall → take a `mcp__playwright__browser_snapshot` for debug, close the tab, emit `ERROR=NETWORK` (or `ERROR=AUTH` if a login form appears).
- No `div[data-urn^="urn:li:activity"]` cards found at all → `ERROR=SCRAPE`.
- `mkdir` or `Write` fails → `ERROR=FS`.
- Anything else → `ERROR=UNKNOWN` with a short prose explanation **before** the contract line.
