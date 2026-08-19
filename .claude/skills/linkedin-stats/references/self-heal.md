# Self-heal overlay — linkedin-stats weekly scrape

Pipeline-specific half of the heal protocol. Read AFTER
`.claude/skills/pipeline-shared/references/self-heal-core.md`; this file is
additive — it cannot relax the core's ground rules.

Extra context keys from the caller: `WEEK` (the ISO-Monday week being
scraped). `WRAPPER` is `.claude/skills/linkedin-stats/run-weekly.sh`; the
fast script is `<FAST_DIR>/scrape-weekly.mjs`.

## Pipeline-specific ground rules

- **Respect the LinkedIn 429 budget.** All analytics surfaces share ONE rate
  budget (~23 paced loads/min is safe; ~32/min trips the limiter). Probe
  with single targeted navigations, never a second full scrape run. If the
  failure itself was rate-limiting, do NOT navigate LinkedIn at all while
  diagnosing.
- **Preferred fix surfaces:** anything under `<FAST_DIR>` (scrape-weekly.mjs,
  merge.py) and this skill's `references/`. Every li-stats write must keep
  going through `fast/merge.py` (Python round-trips the corpus byte-for-byte
  where JSON.stringify rewrites historical float lexemes like `50.0`).

## Exit-code taxonomy of scrape-weekly.mjs

| exit | meaning | typical response |
|---|---|---|
| 0 / 10 | ok / partial (you won't be called for these unless coverage was too low — see below) | improve throughput: timeouts, pacing, requeue logic |
| 20 | AUTH — LinkedIn session expired on the runner profile | unfixable by code → ABORT (needs the owner's interactive relogin) |
| 21 | profile locked (Chrome ProcessSingleton) | find + kill the orphan `mcp-chrome-linkedin-stats` Chrome; jobs serialize on the single runner, so any profile Chrome mid-run is an orphan |
| 22 | rate-limited beyond the breaker | you are only called for repeat/mixed cases — diagnose WITHOUT navigating LinkedIn. Never loosen pacing in response to a single 429 (it may be an account-level restriction, not a pacing bug) |
| 23 | fs error | disk/permissions on the runner — diagnose locally |
| 30 | selector drift — LinkedIn DOM changed under a line-anchored parser | fix the parser in `scrape-weekly.mjs` against the live page |
| 1 / other | UNKNOWN phase error | full diagnosis per the core protocol |

Rejected exit 10 is dispatched to you too: the wrapper's acceptance gate
requires NO phase-level `ERROR=` line in the contract (a dead posts/account/
comments phase means a whole surface is missing) and ≥80% per-post coverage
(`POSTS_MEASURED ≥ 4×(POSTS_FAILED+POSTS_UNPROCESSED)`, measured > 0).
Partial classification kept the data, but the run is not healthy — usually
the nav-slowdown signature. The scraper also has semantic canaries (zero
followers / zero audience-demographic rows → page failure): hollow data from
silent anchor drift arrives as exit 10, not as a lying exit 0.

## Known history (do not re-derive)

2026-07-20: both weekly fires failed ONLY under the GH Actions runner — Chrome
launch >30s, then every heavy `page.goto` (activity feed, post-summary
analytics, public post pages) hung past 45s while light analytics pages loaded;
interactively the same profile/code/Chrome loads everything in 2–3s. Root cause
unproven. Already falsified by experiment (do NOT re-test): background QoS
clamp, occluded window, launchd Standard spawn, dirty profile after SIGKILL,
playwright-core version skew, runner plist ProcessType, runner env. Chrome
149→150 upgrade correlates but launchd-context fires succeeded on 150.
Headroom fixes landed after that incident: 90s nav timeout, 60s launch timeout
with an orphan sweep between attempts, timeout-class phase errors → exit 10
(partials kept). Diag probes from that investigation live in `tmp/diag-*.mjs`
in interactive checkouts (gitignored — may be absent here; the incident doc
describes them).
