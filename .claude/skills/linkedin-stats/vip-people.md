# VIP people — the 4× engagement tier

People listed here score at the `vip` weights in `scoring.json` (reaction 4, comment 20)
instead of the `normal` weights (1 / 5). This is the hand-curated list: someone belongs
here because the owner decided they matter, not because a classifier said so.

Tune this file freely — no code change is needed, and no re-scrape either. The score is
recomputed from the raw event log on every Pages build, so adding a person here
retroactively rescores everything they have ever done.

Someone who is on this list **and** classified as ICP scores at whichever tier gives the
higher points for that event kind (see `precedence` in `scoring.json`).

## Format

One LinkedIn profile URL per bullet. Everything else on the line is a free-text note for
humans and is ignored by the parser; lines without a `linkedin.com/in/...` URL are ignored
entirely, so headings and prose like this are safe.

```
- https://www.linkedin.com/in/some-slug — why they matter (optional note)
```

Matching is on the normalized profile path (`/in/<slug>`, lowercased, query string and
trailing slash stripped), which is the same identity key the scraper stores per person.

## The list

<!-- Empty by design as of 2026-08-17 — add people below. -->
