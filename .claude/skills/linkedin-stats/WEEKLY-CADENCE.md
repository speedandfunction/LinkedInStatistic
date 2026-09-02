# Weekly cadence — operator guide

How the LinkedIn stats pipeline runs itself once a week, what you must put
into GitHub before it can, and what to do when it breaks.

**The one rule that matters:** a missed week can never be backfilled.
LinkedIn only exposes *current* analytics; `dashboards/li-stats/<author>/`
accumulates one `weeks[<monday>]` snapshot per run. If Monday's run does not
happen — dead Browserbase session, missing secret, no runner — that week is
gone forever. Everything below exists to make a silent miss impossible.

**Corollary, and the single most important line in this document:**
a run that did not collect a complete week now **fails red**. Green means the
week landed. If you only ever check one thing, check that Monday's run is
green.

---

## 1. What the weekly run does

`.github/workflows/linkedin-stats-weekly.yml`, cron `0 0 * * 1`
(00:00 UTC Monday = 02:00 Kyiv winter / 03:00 summer), plus
`workflow_dispatch`.

**It does not call `run-weekly.sh`.** That script is the *local* driver: its
first act is `pl_require_cmds claude node npm gh git jq`, and its commit path
asks the `claude` CLI to write the commit message. Neither the CLI nor a
Claude credential exists on a stock `ubuntu-latest` runner, so the workflow
drives the deterministic scraper directly instead. What that consciously
gives up: the self-heal retry loop, the codex review pass, the Slack bookends
and the `doc/incidents/` write-up — **none of those artefacts are produced by
a CI run, so do not go looking for them.** What it keeps: sequential
per-author scraping, the truncated-snapshot guard, PR-not-direct-to-main, and
"only a boring clean run auto-merges".

The job, step by step:

1. checks the three required secrets are non-empty and fails immediately with
   a readable message if not;
2. **pins one ISO-Monday** for the whole run and passes it to every scrape as
   `--week`, so the data key, the branch name and the health assertion are
   the same string by construction;
3. `npm ci` in `fast/` (no `playwright install` — the package pins
   `playwright-core` and the browser is remote);
4. materialises the lifleet registry from a secret into `RUNNER_TEMP`
   (**never** the working tree) and cross-checks it against `profiles.json`;
5. scrapes **every author in `profiles.json`, one at a time**, with a 60 s
   pause between them, each under a 2100 s `timeout` hard cap;
6. validates every `dashboards/**/*.json` and reverts anything truncated;
7. commits, pushes, opens a PR, and **auto-merges only** a run where every
   author exited 0, wrote data, and produced this week's `weeks[<monday>]`
   key, and every snapshot parsed;
8. on auto-merge only, sets `main_updated=true`, which gates the `publish`
   job (build Pages `stats.json` → deploy → refresh the Grafana `$post`
   variable).

**Runner.** Our browser is remote (Browserbase), so this needs
`runs-on: ubuntu-latest`. Upstream's `[self-hosted, macOS]` exists because
upstream drives a local Chrome profile on one specific Mac. We have no
self-hosted runner registered — a job pinned to one waits 24 h and is
silently cancelled (that is exactly what happened to run `33354614284`
on 2026-08-31: *"exceeded the maximum execution time while awaiting a
runner for 24h0m0s"*).

**Multi-profile.** Identity per author lives in
`.claude/skills/linkedin-stats/profiles.json`; the Browserbase login context
per author lives in `scripts/lifleet/authors.json`. One scrape process
handles **one** author (`LI_AUTHOR`), writing to
`dashboards/li-stats/<author>/`. Authors are a **sequential loop inside a
single job**, not a build matrix — the free Browserbase plan allows exactly
one concurrent session, and serial runs keep the request pace gentle. In the
Actions UI you will therefore see one `scrape` job containing one collapsible
`::group::` per author, not one job per author.

Adding a person to `profiles.json` is picked up automatically: the author
list, the publish build and the Grafana refresh all derive it from the data.
No workflow edit is ever needed. (You do have to update one secret — §5.)

---

## 2. Secrets and variables

Nothing is set today: `gh api repos/speedandfunction/LinkedInStatistic/actions/secrets`
and `.../actions/variables` both return `total_count: 0`. The workflow's first
step exists to tell you that in one line instead of failing 25 minutes in.

### Required secrets — the run cannot start without these

| Name | Read by | What breaks without it |
|---|---|---|
| `BROWSERBASE_API_KEY` | `fast/browserbase-backend.mjs:75` (`requireEnv`) | `openBrowserbaseSession` throws before any page loads. Caught by the preflight step, which fails the run immediately. |
| `BROWSERBASE_PROJECT_ID` | `fast/browserbase-backend.mjs:76` | Same immediate throw, same preflight catch. |
| `LIFLEET_AUTHORS_JSON` | written to `$RUNNER_TEMP/lifleet-authors.json` by the workflow, then read via `LIFLEET_AUTHORS` in `fast/browserbase-backend.mjs:21-47` | `scripts/lifleet/authors.json` is gitignored (`scripts/lifleet/.gitignore:2`), so a fresh checkout has **no registry** and `loadAuthor()` throws `не читається реєстр lifleet`. Value = the entire JSON file. This is the top blocker after the runner. |

`GITHUB_TOKEN` is automatic — nothing to create.

### Optional — the run works without them, with the noted loss

| Name | Kind | Notes |
|---|---|---|
| `GRAFANA_SERVICE_ACCOUNT_TOKEN` | secret | Read by `update-post-variable.mjs:37`. **Both** the weekly `publish` job and `pages-deploy.yml` guard on it and skip cleanly when unset — the data still deploys to Pages, only the Grafana `$post` picker goes stale. |
| `GRAFANA_URL` | variable | `update-post-variable.mjs:36`. The weekly workflow falls back inline to `https://speedandfunction.grafana.net`; `pages-deploy.yml` has **no** fallback and skips the step instead. Set it so the two agree. |
| `LIFLEET_PROXIES` | variable | Default `on`. On the free Browserbase plan proxies `402` and the backend falls back automatically (`browserbase-backend.mjs:95-108`); `off` just skips the wasted call. |
| `LI_SESSION_TIMEOUT` | variable | Default `1800` s (`browserbase-backend.mjs:90`). The scrape hard cap is 2100 s, so a slow author can outlive its own Browserbase session. Set `2400`. |

### Set by the workflow, not by you

- `LI_BACKEND=browserbase` — the switch at `fast/scrape-weekly.mjs:507`.
  Without it the scraper tries to launch a local Chrome and dies.
- `LI_AUTHOR=<slug>` — one iteration per author, read at
  `fast/scrape-weekly.mjs:65`; an unknown slug exits 23.
- `--week=<monday>` — the pinned ISO week, so a run that crosses midnight
  cannot split its authors across two week buckets.
- `LIFLEET_AUTHORS` — path to the materialised registry.
- `PYTHONUTF8=1` — `merge.py` performs every snapshot write and opens files
  with no explicit `encoding=`. The corpus is Cyrillic; under a C/POSIX
  locale that is a `UnicodeEncodeError` → exit 23 → a lost week.
- `git config user.name` / `user.email` — a bare runner cannot `git commit`
  without them.

### Deliberately NOT used by CI

Do not set these expecting the weekly run to read them — it will not:

- **`ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN`.** The workflow never
  invokes the `claude` CLI. Only the local `run-weekly.sh` path needs a
  Claude credential. Storing one in the repo adds a credential to your blast
  radius for no benefit.
- **`SLACK_CHANNEL_ID`.** The Slack bookends live in `run-weekly.sh` and post
  through the claude.ai connector `mcp__claude_ai_Slack_Bot__postMessage`,
  which only exists inside an OAuth-authenticated Claude Code session. CI
  never posts to Slack. **Do not treat Slack silence as a health signal** —
  use the run's red/green status (§8).
- **`LI_CHROME_PROFILE_DIR`.** Only the local-Chrome path reads it
  (`scrape-weekly.mjs:116`). Dead weight under `LI_BACKEND=browserbase`.

### Repo settings the run also depends on

- Actions → General → Workflow permissions: **Read and write**, and **Allow
  GitHub Actions to create and approve pull requests**. If the second is off,
  the branch is pushed but no PR is created; the workflow detects this
  explicitly and fails with that exact diagnosis rather than going green.
- Pull requests: **Allow squash merging** (`gh pr merge --squash`).
- Pages is already configured (`build_type: workflow`,
  `https://speedandfunction.github.io/LinkedInStatistic/`).

---

## 3. Where to copy the values from (names only — never paste values here)

| Local file | Names present |
|---|---|
| `/Users/sashaorlyk/LinkedInStatistic/.env` | `GRAFANA_URL`, `GRAFANA_SERVICE_ACCOUNT_TOKEN` |
| `/Users/sashaorlyk/LinkedInStatistic/scripts/lifleet/.env` | `BROWSERBASE_API_KEY`, `BROWSERBASE_PROJECT_ID`, `LIFLEET_REGISTRY`, `LIFLEET_REGION` |
| `/Users/sashaorlyk/LinkedInStatistic/scripts/lifleet/authors.json` | the whole file → `LIFLEET_AUTHORS_JSON` |

---

## 4. Commands to run (placeholders only — substitute real values)

Read the local names without echoing any value into your shell history:

```bash
grep -oE '^[A-Za-z_][A-Za-z0-9_]*' /Users/sashaorlyk/LinkedInStatistic/.env
grep -oE '^[A-Za-z_][A-Za-z0-9_]*' /Users/sashaorlyk/LinkedInStatistic/scripts/lifleet/.env
```

Then, from any directory. Prefer the `< file` and bare forms — a value typed
after `--body` lands in your shell history; with no `--body` at all, `gh`
prompts and reads it without echoing.

```bash
R=speedandfunction/LinkedInStatistic

# --- required secrets (gh prompts for each value; nothing is echoed) ---
gh secret set BROWSERBASE_API_KEY    --repo "$R"
gh secret set BROWSERBASE_PROJECT_ID --repo "$R"

# the Browserbase login registry — read straight from the file, never pasted
gh secret set LIFLEET_AUTHORS_JSON --repo "$R" \
  < /Users/sashaorlyk/LinkedInStatistic/scripts/lifleet/authors.json

# --- optional secret ---
gh secret set GRAFANA_SERVICE_ACCOUNT_TOKEN --repo "$R"

# --- variables (not secret; safe on the command line) ---
gh variable set GRAFANA_URL        --repo "$R" --body 'https://speedandfunction.grafana.net'
gh variable set LIFLEET_PROXIES    --repo "$R" --body 'on'    # paid plan: UA residential IP keeps the session alive
gh variable set LI_SESSION_TIMEOUT --repo "$R" --body '2400'  # must exceed the 2100s cap

# --- verify ---
gh secret   list --repo "$R"
gh variable list --repo "$R"
```

---

## 5. Adding a new author

Three places. **Steps 2 and 3 must land together**: the preflight cross-checks
`profiles.json` against the registry secret and fails the **whole run** — every
author, not just the new one — if a profiled author has no `context_id`. That
is deliberate (fail before burning sessions), but it means a `profiles.json`
commit without the matching secret update breaks Monday for everybody.

1. **Browserbase login** — give the person a live-view link and let them log
   in themselves (details in §6):
   ```bash
   cd /Users/sashaorlyk/LinkedInStatistic/scripts/lifleet
   set -a; . ./.env; set +a
   ./.venv/bin/python -m lifleet add <slug> --name "Full Name" --country UA
   ./.venv/bin/python -m lifleet invite <slug>       # or: python invite_link.py <slug> 30
   ./.venv/bin/python -m lifleet check <slug>        # must print status=live
   ```
   This writes `context_id` into `scripts/lifleet/authors.json`.
2. **Re-upload the registry secret** — the file is gitignored, so GitHub only
   sees what you push:
   ```bash
   gh secret set LIFLEET_AUTHORS_JSON --repo speedandfunction/LinkedInStatistic \
     < /Users/sashaorlyk/LinkedInStatistic/scripts/lifleet/authors.json
   ```
3. **Identity + dashboards** — add the same slug to
   `.claude/skills/linkedin-stats/profiles.json` (`name`, `profile_slug` as
   `in/<slug>`, `company_id`, `posts_cutoff`), then:
   ```bash
   cd /Users/sashaorlyk/LinkedInStatistic
   node .github/scripts/gen-author-dashboards.mjs
   set -a; . ./.env; set +a
   node .github/scripts/push-dashboard.mjs --uid linkedin-<slug>       --file dashboards/grafana/linkedin-<slug>.json
   node .github/scripts/push-dashboard.mjs --uid linkedin-<slug>-posts --file dashboards/grafana/linkedin-<slug>-posts.json
   ```
   Commit `profiles.json` + the generated dashboards. The scrape loop,
   `build-pages.mjs` and the Grafana refresh all derive the author list from
   the data — **no workflow edit needed**.

The slug must be **identical** in `profiles.json` and `authors.json`.

Each extra author adds up to ~36 min to the job. The loop self-bounds on
`RUN_BUDGET_SECS` (90 min): past that it stops *starting* authors, marks them
`skipped-budget`, and still commits what finished — so a growing roster
degrades one author at a time instead of losing the whole week to a job-level
kill. Raise `RUN_BUDGET_SECS` and `timeout-minutes` together when you outgrow
it.

---

## 6. Browserbase sessions expire — the recovery drill

The login lives as cookies inside a Browserbase **context**, not in this
repo. LinkedIn invalidates it on its own schedule, and on the free plan
(no proxies → datacentre IP) that can be within days —
`scripts/lifleet/START-HERE.md` says so explicitly. Between two Mondays is
plenty of time to go dead, and a dead session means the scrape fails and
**that week is unrecoverable**.

**Check it — do this on Friday, not Monday morning:**

```bash
cd /Users/sashaorlyk/LinkedInStatistic/scripts/lifleet
set -a; . ./.env; set +a
./.venv/bin/python -m lifleet check --all      # exit 1 if anyone is not "live"
```

Statuses (`lifleet/cli.py:_check_one`, `DECISIONS.md`):
`live` (fine) · `dead` (logged out) · `challenge` (LinkedIn wants
verification) · `new` (never logged in) · `error` (transient) · `unknown`.

**Recover:**

- `dead` or `new` — re-establish the login. Two routes:
  - *Live view* (`scripts/lifleet/invite_link.py`, or `lifleet invite <slug>`):
    ```bash
    python invite_link.py <slug> 30        # prints LIVEVIEW_URL, keeps the session alive 30 min
    ```
    Send the person `LIVEVIEW_URL`; they type their own credentials and 2FA
    in the cloud browser. Recording and the captcha auto-solver are off for
    this session by design — no replay of the password exists. If the social
    buttons are all they see, push that same session to the email/password
    form: `python repair_login.py <SESSION_ID>`.
  - *Cookie import* (the free-plan workaround, because captcha on a
    datacentre IP often blocks the interactive login): the person exports
    their LinkedIn cookies with Cookie-Editor, then
    `./.venv/bin/python -m lifleet import <slug> ~/Downloads/<slug>.json`.
- `challenge` — the person must first open LinkedIn **on their phone** and
  clear the verification, then run the invite flow above.
- `error` — retry `lifleet check <slug>`; if it persists, open the session in
  the Browserbase dashboard (screenshots + logs are there).

**After any recovery, re-upload the registry secret** — `context_id` may have
changed:

```bash
gh secret set LIFLEET_AUTHORS_JSON --repo speedandfunction/LinkedInStatistic \
  < /Users/sashaorlyk/LinkedInStatistic/scripts/lifleet/authors.json
```

Then re-run the week manually (§7) *before* the next Monday, so the missed
snapshot is only late rather than lost.

Local registry snapshot at the time of writing: `oleksandr`, `peter`, `maria`
have a `context_id`; `alex` and `olga` do not. Every entry reads
`status: new` — nobody has passed a `check` yet, so **assume the sessions
need re-establishing before the first cloud run**.

---

## 7. Triggering a run manually

```bash
R=speedandfunction/LinkedInStatistic
gh workflow run linkedin-stats-weekly.yml --repo "$R" --ref main
gh run list --workflow=linkedin-stats-weekly.yml --repo "$R" --limit 5
gh run watch  <run-id> --repo "$R"
gh run view   <run-id> --repo "$R" --log-failed
```

Publishing only (data already merged to `main`):

```bash
gh workflow run pages-deploy.yml --repo "$R" --ref main
```

Both workflows share the `pages` concurrency group, so a manual
`pages-deploy` queues behind an in-flight weekly rather than racing it.

---

## 8. Was the run healthy?

**The short version: green = the week landed. Red = it did not.** The workflow
fails on purpose when any author is incomplete, so a failure email is the
detector. You do not have to read logs to know something is wrong — but you
do have to read them to know *what*.

This is the property that matters most here. `::error::` annotations decorate
a log without changing a step's exit status, so it is entirely possible to
build a pipeline that logs a dead session in red text and still reports
SUCCESS. That shape — a green Monday hiding an empty week, unnoticed for
weeks — is the failure this project has already paid for once. The commit
step therefore ends with an explicit non-zero exit whenever the run is not
clean.

**a. It started at all.** `gh run list --workflow=linkedin-stats-weekly.yml`.
A row reading `cancelled` at ~`24h` means the job waited for a runner that
does not exist — check `runs-on`. `gh api .../actions/runners` returning
`total_count: 0` is expected and fine on `ubuntu-latest`.

**b. Red — read the note.** Every failure carries a machine-readable tag in
the summary and the PR body:

| note | meaning | fix |
|---|---|---|
| `<a>:auth` | exit 20 — the Browserbase context is logged out | §6 recovery drill |
| `<a>:drift` | exit 30 — LinkedIn's DOM changed | update the selectors; **every** later week fails until you do |
| `<a>:ratelimit` | exit 22 — LinkedIn throttled the account | back off, re-dispatch later in the day |
| `<a>:fs` | exit 23 — the snapshot write itself failed | check the `merge.py` traceback |
| `<a>:partial` | exit 10 — the soft deadline fired mid-run | usually re-dispatchable as-is |
| `<a>:hardcap` | killed at 2100 s | raise `LI_SESSION_TIMEOUT`, check for a hung session |
| `<a>:nodata` | exited 0 but wrote nothing | a soft-block: the session renders empty pages |
| `<a>:noweek` | exited 0, wrote files, but no `weeks[<monday>]` key | the account phase produced nothing for this week |
| `<a>:skipped-budget` | the 90-min loop budget ran out first | raise `RUN_BUDGET_SECS` + `timeout-minutes` |
| `invalid-json=1` | a snapshot was truncated and reverted | usually follows a `hardcap` |

`nodata` and `noweek` are the two that exist purely to catch a *lying* exit
code — a throttled session where every phase "succeeds" against empty pages.
Without them that author is silently dropped from an otherwise clean run.

**c. What happened to the data.** Red does **not** mean the data was thrown
away: the branch is pushed and the PR is open before the failure. Read the PR,
merge it by hand if the partial week is worth keeping, then dispatch
`pages-deploy.yml` to publish it.

**d. Confirm the week landed.** The workflow asserts this per author, but to
check by hand after a manual merge:

```bash
cd /Users/sashaorlyk/LinkedInStatistic && git pull
for a in dashboards/li-stats/*/; do
  [ -f "$a/account.json" ] || continue
  echo "$a -> $(python3 -c 'import json,sys;print(sorted(json.load(open(sys.argv[1]))["weeks"])[-1])' "$a/account.json")"
done
```

The newest key must be this week's Monday, for **every** author.

**e. Publishing.** `https://speedandfunction.github.io/LinkedInStatistic/<author>/stats.json`
should carry the new week, and the Grafana `$post` picker on
`linkedin-<author>-posts` should list the week's new posts.
