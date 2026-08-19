# LinkedInStatistic

Weekly LinkedIn analytics collection and dashboarding. A paced Playwright run
scrapes post discovery, per-post metrics, account analytics, outbound comments
and the people behind each engagement into git-tracked JSON under
`dashboards/li-stats/`; a build step flattens that corpus into a single
`stats.json` published to GitHub Pages, which Grafana reads over HTTP.

```
scrape  ->  dashboards/li-stats/*.json  ->  PR  ->  stats.json on Pages  ->  Grafana
```

## Setup

1. `cp .env.example .env` and fill in the Grafana values.
2. Set the tracked account in `.claude/skills/linkedin-stats/config.json`:

```json
{
  "profile_slug": "in/your-linkedin-slug",
  "company_id": "0000000",
  "posts_cutoff": "2026-01-01"
}
```

3. Install the scraper deps:

```bash
cd .claude/skills/linkedin-stats/fast && npm install --no-audit
```

4. Log the Chrome profile at `LI_CHROME_PROFILE_DIR` (or the macOS default)
   into LinkedIn once, interactively. The session lives in that profile — the
   pipeline never handles credentials.

## Running

One paced pass over every phase (~5 min):

```bash
node .claude/skills/linkedin-stats/fast/scrape-weekly.mjs
```

Exit codes: `0` complete · `10` partial · `20` auth wall · `21` profile locked ·
`22` rate-limited · `23` filesystem · `30` selector drift.

The browser-free regression suite runs anywhere, including on a fresh checkout
before the first scrape:

```bash
node .claude/skills/linkedin-stats/fast/test-people.mjs
```

## Scheduled runs

`.github/workflows/linkedin-stats-weekly.yml` fires Monday 00:00 UTC on a
self-hosted runner and drives `.claude/skills/linkedin-stats/run-weekly.sh`:
retries with headless heal sessions between failed attempts, writes an incident
to `doc/incidents/`, and opens a PR. Only a clean first-attempt run auto-merges
and triggers the Pages publish.

The runner must be a persistent machine holding the logged-in Chrome profile —
ephemeral CI runners cannot keep a LinkedIn session alive.

## Scoring

Engagement scores are **derived at build time** from the raw event log, never
stored. Retuning a weight in `.claude/skills/linkedin-stats/scoring.json` or
adding someone to `vip-people.md` rescores all history on the next build with
no re-scrape.
