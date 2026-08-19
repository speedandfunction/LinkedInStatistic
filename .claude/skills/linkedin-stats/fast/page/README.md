# Company-Page phase

Collects **company-page** admin analytics (a different surface from the personal
profile the rest of the pipeline scrapes) and aggregates them **monthly**.

Unlike the personal profile — which only exposes "last 7 days" and forces the
weekly-snapshot model — the Page admin analytics **retain ~12 months** and ship
a first-party **XLS export**. So this phase exports rather than screen-scrapes:
richer data (full daily series + demographics), and stable against the CSS
obfuscation that keeps breaking the personal parsers.

## What it produces

`dashboards/li-stats/page/monthly.json`:

- `months[YYYY-MM]` — `page_views`, `unique_visitors`, `new_followers`,
  `post_impressions`, `post_reactions`, `post_comments`, `post_reposts`,
  `post_clicks`
- `visitor_demographics` / `follower_demographics` — a single 12-month snapshot
  (Seniority, Job function, Industry, Company size, Location). LinkedIn does not
  break demographics down per month, so this is one current slice, not a series.

Page views and post impressions are additive across days. LinkedIn reports
"unique visitors" as the **sum of daily uniques**, so summing daily uniques
reproduces its own number (verified 2026-08-19: Jul 19–Aug 17 → 569 / 225,
matching the on-screen highlight exactly).

## Requirements

- The Chrome profile at `LI_CHROME_PROFILE_DIR` (or the macOS default) logged
  into LinkedIn with **admin or analyst** access to `config.company_id`.
- `python3` with **xlrd** (`pip install xlrd`) — the export is old-style BIFF
  `.xls` (OLE2), which openpyxl cannot read.

## Run

```bash
node .claude/skills/linkedin-stats/fast/page/scrape-page.mjs --months=6
```

Flags: `--headful` (watch it), `--keep-xls` (keep the raw exports),
`--out=path.json`. Exit codes match `scrape-weekly.mjs`
(0 ok / 20 auth / 21 profile busy / 23 fs-parse / 30 selector drift).

## Two pieces

- `scrape-page.mjs` — Playwright driver: for Visitors / Followers / Content it
  opens **Export**, sets the range to **Last 365 days**, captures the download,
  and saves `visitors.xls` / `followers.xls` / `content.xls`. The click-path was
  captured live 2026-08-19; if LinkedIn moves this UI a selector stops matching
  and the run exits 30.
- `parse-page-xls.py` — reads the three `.xls` by **column name** (so a column
  reshuffle inside the file does not break it) and writes the monthly JSON.
  Run standalone against a folder of the three files:
  `python3 parse-page-xls.py <xls-dir> <out.json> --months=6`.
