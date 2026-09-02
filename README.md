# LinkedInStatistic

Weekly LinkedIn analytics collection and dashboarding. A paced Playwright run
scrapes post discovery, per-post metrics, account analytics, outbound comments
and the people behind each engagement into git-tracked JSON under
`dashboards/li-stats/<author>/`; a build step flattens that corpus into one
`stats.json` per author, published to GitHub Pages and read by Grafana over
HTTP. Any number of authors is supported — the roster is `profiles.json`.

```
scrape  ->  dashboards/li-stats/<author>/*.json  ->  PR  ->  <author>/stats.json on Pages  ->  Grafana
```

## Setup

1. `cp .env.example .env` and fill in the Grafana values.
2. Add one entry per tracked person to
   `.claude/skills/linkedin-stats/profiles.json` — the key is the author slug
   and it is the only place the roster is defined; every consumer (scraper,
   weekly driver, Pages build) discovers authors from it, so adding someone is
   a data change, not a code change:

```json
{
  "your-slug": {
    "name": "Your Name",
    "profile_slug": "in/your-linkedin-slug",
    "company_id": "0000000",
    "posts_cutoff": "2026-01-01"
  }
}
```

   `config.json` is the single-account fallback, used only when `LI_AUTHOR` is
   unset. Each author writes to `dashboards/li-stats/<author>/`.

3. Install the scraper deps:

```bash
cd .claude/skills/linkedin-stats/fast && npm install --no-audit
```

4. Give each author a logged-in browser session. The default backend is
   **Browserbase** (`LI_BACKEND=browserbase`): the session lives in a remote,
   persistent Browserbase context whose id is held in the lifleet registry
   (`scripts/lifleet/authors.json`, gitignored), and you log a person in once
   with `lifleet import <slug> <cookies.json>`. Set `BROWSERBASE_API_KEY` and
   `BROWSERBASE_PROJECT_ID` (see `.env.example`). Any other value of
   `LI_BACKEND` — including **unset**, which is what a bare
   `node scrape-weekly.mjs` gets — falls back to a local Chrome profile at
   `LI_CHROME_PROFILE_DIR`; `run-weekly.sh` defaults it to `browserbase`.

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
stock **`ubuntu-latest`** runner. No self-hosted runner is needed: the browser
is remote (Browserbase), so the runner is a thin client and an ephemeral CI
box keeps no session of its own — the LinkedIn session lives in the
Browserbase context, not on the runner. The workflow scrapes every author in
`profiles.json` sequentially, validates the snapshots, and opens a PR; only a
run where every author exits 0 auto-merges and triggers the Pages publish, and
any other outcome leaves the PR open **and fails the run red** so a missed
week cannot pass as a green tick.

Operator setup — required secrets, variables and recovery runbook — is in
[`.claude/skills/linkedin-stats/WEEKLY-CADENCE.md`](.claude/skills/linkedin-stats/WEEKLY-CADENCE.md).

`.claude/skills/linkedin-stats/run-weekly.sh` is the richer driver for the same
job (per-author retries, headless self-heal sessions between failed attempts,
an incident in `doc/incidents/`, Slack bookends). It needs the `claude` CLI, so
it is run manually rather than by the workflow.

## Scoring

Engagement scores are **derived at build time** from the raw event log, never
stored. Retuning a weight in `.claude/skills/linkedin-stats/scoring.json` or
adding someone to `vip-people.md` rescores all history on the next build with
no re-scrape.
