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

The `scrape` job, step by step (then `publish`, then `notify`):

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
   job (build Pages `stats.json` → deploy → mark `deployed=true` → refresh
   the Grafana `$post` variable). `deployed` is written by its own step right
   after `actions/deploy-pages`, so it exists only when the deploy itself
   succeeded — a red `publish` with `deployed=true` means only the Grafana
   refresh failed. The same `main_updated=true` also starts the **dual-write**
   jobs `db-sync` → `db-backup` (section 9), side by side with `publish`. They
   are `continue-on-error` and can neither fail the run nor cost the week;
9. **always** — success, failure, cancellation or a `scrape` timeout — a
   separate final job, `notify` (`needs: [scrape, publish, db-sync, db-backup]`,
   `if: always()`, `continue-on-error: true`), posts **one** message to
   `#linkedin-session-bot` (`.github/scripts/notify-weekly.mjs`). Because it
   runs after `publish`, it can tell these apart:

   | outcome | ping | deadline |
   |---|---|---|
   | *collected and published* — merged, deployed, `publish` green | no | — |
   | *published, but the Grafana post picker refresh failed* — merged, deployed, `publish` red | no | none — data is live; the next successful publish rebuilds the picker |
   | *safe on main, dashboards NOT updated* — merged, deploy failed / cancelled / unconfirmed; or `publish` skipped after a merge | operator | **none** — the week is merged; run `pages-deploy` |
   | *NOT published, waiting for review* — PR open, not merged (PR link, each author's problem) | operator | **next Monday 00:00 UTC** — merge before it or the week is lost |
   | *crashed before a PR existed* (run link) | operator | **next Monday 00:00 UTC** |

   The two "no deadline" rows and the two "Monday" rows are deliberately
   different: an unmerged week is lost for good at the next run; a merged but
   unpublished week only means stale dashboards. Authors are never tagged.
   Any of the three *merged* outcomes can carry one extra **database line**
   (no ping) when the dual-write sync, parity check or backup did not all
   succeed — and carries nothing when they did. See section 9.
   If the `notify` job cannot check out its script (it retries once), it
   leaves an `::error::` annotation on the run and posts nothing.

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
| `SLACK_BOT_TOKEN` | secret | The session-check bot, reused by the weekly result message. Also read by `pages-deploy.yml`. Unset or revoked → a `::warning::` in the "Post the weekly result to Slack" step of the `notify` job (or "Post the pages-deploy result to Slack") and **no message**; the run's conclusion is unaffected. |
| `SLACK_CHANNEL_ID` | variable | The `C…` id of `#linkedin-session-bot` — the same variable the daily session check reads. Unset → same warning, no message. |
| `SLACK_PEOPLE_JSON` | secret | Only its `_operator` key is read here: the member id pinged when a week is not published or a deploy failed. Missing or not a `U…`/`W…` id → the message still posts, says nobody was pinged, and the log carries a `::warning::`. |

### Optional — the dual-write database stage (section 9)

| Name | Kind | Notes |
|---|---|---|
| `LI_SYNC_DATABASE_URL` | secret | DSN of the least-privilege `li_sync` role. Unset → the `db-sync` job **skips with a `::warning::`**, Slack says *the sync was skipped*; the week is unaffected. |
| `LI_BACKUP_DATABASE_URL` | secret | DSN of the read-only `li_backup` role. Unset → the backup is skipped, with a warning and a Slack line. |
| `LI_BACKUP_DEPLOY_KEY` | secret | SSH **private** key whose public half is a deploy key **with write access** on the private repo `speedandfunction/linkedin-stats-backup`. Unset → same skip. |

None of the three is an owner credential, and none is required: the JSON path,
the PR, the Pages deploy and the run's red/green are identical with or without
them. Setup, reading the Slack line and the exit criteria are in section 9.

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
- **The Slack bookends.** The run-started / run-finished bookends live in
  `run-weekly.sh` and post through the claude.ai connector
  `mcp__claude_ai_Slack_Bot__postMessage`, which only exists inside an
  OAuth-authenticated Claude Code session; CI never posts them. CI posts only
  the one result message above (§1 step 9), plus one message per manual
  `pages-deploy` run (§7). A failed post is a `::warning::`,
  not a red run, so **do not treat Slack silence as a health signal** —
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
| `~/LinkedInStatistic/.env` | `GRAFANA_URL`, `GRAFANA_SERVICE_ACCOUNT_TOKEN` |
| `~/LinkedInStatistic/scripts/lifleet/.env` | `BROWSERBASE_API_KEY`, `BROWSERBASE_PROJECT_ID`, `LIFLEET_REGISTRY`, `LIFLEET_REGION` |
| `~/LinkedInStatistic/scripts/lifleet/authors.json` | the whole file → `LIFLEET_AUTHORS_JSON` |

---

## 4. Commands to run (placeholders only — substitute real values)

Read the local names without echoing any value into your shell history:

```bash
grep -oE '^[A-Za-z_][A-Za-z0-9_]*' ~/LinkedInStatistic/.env
grep -oE '^[A-Za-z_][A-Za-z0-9_]*' ~/LinkedInStatistic/scripts/lifleet/.env
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
  < ~/LinkedInStatistic/scripts/lifleet/authors.json

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
   cd ~/LinkedInStatistic/scripts/lifleet
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
     < ~/LinkedInStatistic/scripts/lifleet/authors.json
   ```
3. **Identity + dashboards** — add the same slug to
   `.claude/skills/linkedin-stats/profiles.json` (`name`, `profile_slug` as
   `in/<slug>`, `company_id`, `posts_cutoff`), then:
   ```bash
   cd ~/LinkedInStatistic
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
cd ~/LinkedInStatistic/scripts/lifleet
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
  < ~/LinkedInStatistic/scripts/lifleet/authors.json
```

Then re-run the week manually (§7) *before* the next Monday, so the missed
snapshot is only late rather than lost.

Local registry snapshot at the time of writing: `peter`, `andy`, `maria`
have a `context_id`; `olga` does not. Every entry reads
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

`pages-deploy` also ends with a `notify` job (same script,
`NOTIFY_MODE=pages-deploy`) that posts one message to
`#linkedin-session-bot`: a **failed or cancelled** build/deploy @-mentions
the operator with the run link; a deploy whose only failure is the Grafana
`$post` refresh posts a yellow line without a ping; a **successful** run posts
one closing line without a ping — so the channel's last word after a
"dashboards were NOT updated" alert is not left standing. Like the weekly,
a Slack failure there never changes the run's red/green.

---

## 8. Was the run healthy?

**The short version: green = the week landed. Red = it did not.** The workflow
fails on purpose when any author is incomplete, so a failure email is the
detector. You do not have to read logs to know something is wrong — but you
do have to read them to know *what*.

**The one exception, since 2026-09-21: `reactors-short` (exit 11).** Every
phase that decides the week is complete and only a reaction list came back
short, so the run stays green and publishes. It is not silent — the Monday
message carries a line per affected author — and it is not a shrug either:
each short target is flagged `short_read` in `engagement.json`, which is what
makes the next run reopen it. An incomplete read also never lowers a stored
`reactor_count`. A week is worth far more than a handful of reactor names: the
account snapshot in it cannot be backfilled, the names can.

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
| `<a>:partial` | exit 10 — the soft deadline fired mid-run, a target failed, or targets were dropped over the cap | usually re-dispatchable as-is |
| `<a>:reactors-short` | exit 11 — **not a failure.** Only reaction lists came back short; the week publishes and the flagged targets are reopened next run | nothing to do. If it repeats on the same post every week, read `TARGETS_SHORT_READ` in the log |
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
cd ~/LinkedInStatistic && git pull
for a in dashboards/li-stats/*/; do
  [ -f "$a/account.json" ] || continue
  echo "$a -> $(python3 -c 'import json,sys;print(sorted(json.load(open(sys.argv[1]))["weeks"])[-1])' "$a/account.json")"
done
```

The newest key must be this week's Monday, for **every** author.

**Publish failures are not week failures.** A red run whose `scrape` job is
green and whose `publish` job is red means the week IS merged: either the
deploy failed (Slack says *dashboards NOT updated* — dispatch
`pages-deploy.yml`, no deadline) or only the Grafana refresh failed (Slack
says *post picker refresh failed* — the data is live). Only a red `scrape`
carries the next-Monday deadline.

**e. Publishing.** `https://speedandfunction.github.io/LinkedInStatistic/<author>/stats.json`
should carry the new week, and the Grafana `$post` picker on
`linkedin-<author>-posts` should list the week's new posts.

## 9. The dual-write stage (JSON + Postgres, in parallel)

**JSON in git is still the source of truth.** Nothing in sections 1–8 changed.
What was added: once a week's data is **on `main`**, the same data is imported
into Postgres, the database's view of it is compared byte-for-byte with the
JSON build, and the database is backed up. For a few weeks the two run side by
side; Grafana keeps reading the JSON on Pages until the exit criteria at the end
of this section are met.

The git PR stays **the** quality gate. An incomplete week sits in an open PR, is
not on `main`, and is therefore never synced. Whatever `main` contains is, by
definition, published — so the sync publishes what it imports.

### What runs where

| Job | In | Runs when | Does |
|---|---|---|---|
| `db-sync` | `linkedin-stats-weekly.yml` | `main_updated == 'true'` (a clean, auto-merged week). Needs only `scrape` — **not** `publish`: a failed Pages deploy does not make `main` any less merged | checkout `main` → `npm ci --prefix db` → `LI_DSN=… node db/import.mjs --publish` → `LI_DSN=… node db/verify.mjs` |
| `db-sync` | `pages-deploy.yml` | every dispatch, in parallel with `build`. This is how a **hand-merged** week reaches the database | the same; always syncs `main`, whatever ref was dispatched |
| `db-backup` | `linkedin-stats-weekly.yml` | after `db-sync` reported `sync == 'ok'` (whatever parity said — a week where the two sides disagree is worth keeping) | PostgreSQL 17 client from apt.postgresql.org (key fingerprint pinned) → `db/backup.sh` → one file, `linkedin.sql`, committed over the previous one and pushed over SSH to the private repo |
| `db-backup` | `pages-deploy.yml` | **only** if the `backup` box is ticked on the dispatch form (default off) | the same |
| `notify` | both | always | one Slack message: an orange database line with **what to do** when something is off, a grey one-line confirmation (*synced · parity byte-identical · backup pushed*) when nothing is |
| `db-keepalive` | `linkedin-session-check.yml` (daily, 07:00 UTC) | every scheduled run; skipped on a dry-run dispatch | `db/ping.mjs` as `li_sync`: one read, nothing written. See *Why the project must be kept awake* below. Never red, no Slack line of its own |

The logic lives once: `.github/actions/db-sync`, `.github/actions/db-backup`
(composite actions, `push.sh` next to the second) and `.github/scripts/db-ci.mjs`.
Composite actions rather than a reusable workflow, deliberately: a job that calls
a reusable workflow cannot carry `continue-on-error` / `timeout-minutes`, and a
mistake in a called workflow file is a *startup failure of the whole weekly run*.
A broken composite action only fails the one job that loads it.

**Why the project must be kept awake.** The weekly cron (`0 0 * * 1`) runs
exactly 7 days apart, and the Supabase free tier pauses a project after 7 days
without activity. Left alone, those two line up: the project falls asleep just
before the one run a week that needs it, and *could not connect* becomes the
normal Monday. The daily `db-keepalive` job keeps the idle clock under a day. If
it has been failing (its `::warning::` is on the daily run), or the secret did
not exist yet, expect the paused-project line on Monday — the fix is the same:
resume the project, re-run `pages-deploy`.

Why the backup is weekly-only by default: its git history is meant to read one
entry per week, a manual deploy is often re-run several times while something is
being fixed, and during dual-write the database can always be rebuilt from git
with `db/import.mjs`. A hand-merged week loses nothing by waiting for Monday's
backup — that is a full dump and includes it. Tick `backup` when you want a
restore point *now* (before a schema change, after a repair).

### The three guarantees

1. **A database problem never costs a week and never turns the run red.** Every
   command that talks to the database runs under a hard cap inside `db-ci.mjs`
   (npm 5 min, import 15 min, parity 10 min, dump 15 min), which always exits 0.
   `uses:` steps carry their own `timeout-minutes` — a *step* timeout is a
   failure, which the job's `continue-on-error: true` covers, whereas the
   *job-level* timeout ends the job as **cancelled**, which `continue-on-error`
   does not cover. The caps add up to less than the job timeout, so it cannot
   fire first. A paused Supabase project therefore costs about 20 seconds of a
   side job (the importer's connect timeout; 15 minutes at the very worst, if
   the connection hangs instead of timing out) — not a week.
2. **It is never silent.** Every non-OK outcome is a `::warning::` annotation on
   the run *and* a line in that run's Slack message. An output that was never
   written (job crashed, cancelled, never started) reads as empty, and empty is
   reported as *did not run or did not finish* — never as fine.
3. **Nothing personal reaches the log.** This repo is public, so its Actions logs
   are world-readable. `db-ci.mjs` captures everything the `db/` commands print
   and shows **only allow-listed lines** — row counts, table names, parity paths
   and hashes. Everything else is *counted* (`N line(s) withheld`), and a short
   list of fixed-vocabulary hints (`ECONNREFUSED`, `password authentication
   failed`, `Tenant or user not found`, a constraint *name*) is lifted out so a
   failure is still diagnosable. The scripts' own failure lines (`IMPORT FAILED —
   could not connect: …`, `PARITY CHECK COULD NOT RUN: …`) are shown too, but only
   in the fixed shapes `db/safe-log.mjs` produces — an errno, a SQLSTATE, canned
   server wording with names replaced by `<redacted>`.
   To read the withheld lines, run the same command locally. The DSN's password
   and host are additionally registered with `::add-mask::`. The dump is **never**
   uploaded as an artifact (artifacts of a public repo are not private); it lives
   under `$RUNNER_TEMP/li-backup` (mode 0700) between dump and push and is removed
   by an `if: always()` step, as is the deploy key.

### Operator setup — three secrets

No owner credential goes into CI. Until these exist, every run says *skipped* in
Slack and changes nothing else — merging this ahead of the secrets is safe.

1. **Roles.** Apply `db/schema.sql` as the owner (it creates `li_sync` and
   `li_backup`), then give each a password, as the owner:
   `ALTER ROLE li_sync WITH LOGIN PASSWORD '…';` and the same for `li_backup`.
2. **Backup repo.** Create the **private** repo
   `speedandfunction/linkedin-stats-backup` (empty is fine — the first push
   creates `main`). Generate a key pair with no passphrase
   (`ssh-keygen -t ed25519 -N "" -C li-backup -f ./li-backup-key`), add
   `li-backup-key.pub` under that repo's *Settings → Deploy keys* with **Allow
   write access** ticked, and delete both files once the secret is stored.
3. **Secrets** (gh prompts for each value; nothing is echoed, nothing lands in
   shell history):

```bash
# Supabase: use the SESSION pooler host (runners have no IPv6 route to the direct
# host; the transaction pooler breaks prepared statements). The user is then
# <role>.<project-ref> - see db/README.md.
gh secret set LI_SYNC_DATABASE_URL    # DSN of li_sync
gh secret set LI_BACKUP_DATABASE_URL  # DSN of li_backup
gh secret set LI_BACKUP_DEPLOY_KEY < ./li-backup-key
gh secret list                        # names only
```

Then dispatch `pages-deploy.yml` once with `backup` ticked: it syncs `main`, and
the Slack message should end with the grey line *Database (dual-write soak):
synced · parity byte-identical · backup pushed*. The backup repo then has its
first commit, whose subject reads `… - parity ok 4/4 - …`.

### Reading the database line in Slack

When the sync, the parity check and the backup all succeeded, the message ends
with one small grey line — *:white_check_mark: Database (dual-write soak): synced
· parity byte-identical · backup pushed*. It is there for the soak only: "no line"
used to be the good outcome, and "no line" is also what a run looks like when the
database outputs never reached the notifier. Absence proves nothing. (The durable
record is not Slack at all — see *The soak ledger* below.)

Otherwise there is exactly one extra block, directly under the headline:

> :large_orange_diamond: **Database (dual-write stage):** *…what happened…*.
> :point_right: *…what to do…* (when there is a specific action)
> **The week itself is not affected** — the JSON in git is still the source of truth…

Nobody is pinged for it; it is not urgent. It is also not small grey print: it
will sit under the headline every week until it is fixed.

| The line says | Meaning | What to do |
|---|---|---|
| *the sync was skipped — the `LI_SYNC_DATABASE_URL` secret is not set* | setup not done yet | the three secrets above |
| *the sync FAILED (could not connect to the database)* | the importer never got a connection (it gives up after 20 s). **Almost always a paused Supabase project** — the free tier pauses after 7 idle days, and the cron is 7 days apart. The `db-sync` log shows the importer's own line: `connection timeout`, `ETIMEDOUT`, `ECONNREFUSED`, or `SQLSTATE XX000 — Tenant or user not found` (the pooler cannot route to a paused/deleted project, or the `<role>.<project-ref>` user name is wrong). `password authentication failed` / `database "<redacted>" does not exist` mean the DSN secret is wrong instead | **resume the project in the Supabase dashboard**, then dispatch `pages-deploy.yml` — it re-syncs `main`, and the import is idempotent. Then check why `db-keepalive` in the daily run did not keep it awake |
| *the sync timed out (the import)* | no answer within 15 min: the connection opened and then hung. Same first suspect — a project that is pausing or resuming | the same: resume, then dispatch `pages-deploy.yml` |
| *the sync FAILED (the import)* | the importer **connected** and then failed; its transaction rolled back, the database is as it was. Not a pause | open the `db-sync` job: the hints name the cause (`SQLSTATE …`, `permission denied for table …`, a constraint name). For the withheld lines, run the same command locally. Fix, then dispatch `pages-deploy.yml` |
| *the sync FAILED (installing the db/ dependencies)* | `npm ci --prefix db` failed | usually the registry; re-dispatch |
| *the sync did not run or did not finish* | the job wrote no output: crashed early, was cancelled, or checkout failed | open the run; re-dispatch `pages-deploy.yml` |
| *the parity check found a DIFFERENCE* | the import worked, but the database's export is **not** byte-identical to the JSON build. **This is the finding the soak exists for** | the `db-sync` log lists each differing path with type, length and a hash — never the value. Reproduce locally: `LI_DSN=… node db/verify.mjs --show-values`. Fix `db/export.mjs` / the merge rules, re-dispatch. **Resets the soak counter** |
| *the parity check was INCOMPLETE* | it found no difference, but compared **fewer feeds than `main` publishes**. Pages builds a feed for every folder under `dashboards/li-stats/` with an `account.json`; the importer takes its authors from `profiles.json`. A folder that is not in `profiles.json` is published and never imported | the `db-sync` log has both counts. Add the author to `profiles.json` (or remove the stray folder), re-dispatch. Does not count as a clean week |
| *the parity check could not be completed* / *timed out* | it crashed or hung before comparing anything — not evidence of a difference, not evidence of parity either | dispatch `pages-deploy.yml` to re-sync and re-check; if the database does not answer, check that the project is not paused. Does not count as a clean week |
| *the backup was skipped — … not set* | one or both backup secrets are missing | setup step 2–3 |
| *the backup FAILED (installing the PostgreSQL 17 client)* | apt.postgresql.org unreachable, or its signing key no longer matches the pinned fingerprint | if PostgreSQL rotated the key, update the fingerprint in `.github/actions/db-backup/action.yml` |
| *the backup FAILED (pg_dump)* | `db/backup.sh` refused: database unreachable, `pg_dump` older than the server, an empty dump, or dump/source row counts disagree | the `db-backup` log shows the per-table counts and the script's own reason |
| *the backup FAILED (pushing to the backup repository)* | the repo does not exist, or the deploy key lacks **write** access (that fails exactly at the push) | fix the deploy key; re-dispatch with `backup` ticked |

**The soak ledger.** The backup repo's history is the backup history *and* the
only durable record that parity held: Slack is quiet on a good week, and the
run's log, annotations and step summary expire with the run (about 90 days).
Each backup commit therefore carries the verdict of the `db-sync` job of the
same run. `git log --oneline` in `speedandfunction/linkedin-stats-backup` reads:

```
backup: 2026-W40 (week of 2026-09-28) - parity ok 4/4 - 29 tables, 8512 rows
backup: 2026-W39 (week of 2026-09-21) - parity DIFFERS - 29 tables, 8410 rows
backup: 2026-W38 (week of 2026-09-14) - parity ok 4/4 - 29 tables, 8307 rows
```

and the body says it in words — `Sync: ok`, `Parity: ok - 4 of 4 feeds
byte-identical …`, `Via: linkedin-stats-weekly (schedule)` or `Via: pages-deploy
(workflow_dispatch)`, the run URL, then the per-table counts. `parity ok N/M`
means N feeds were compared and `main` publishes M; anything else (`DIFFERS`,
`INCOMPLETE`, `ERROR`, `TIMEOUT`, `NOT RECORDED`) is not a clean week. A week
with **no commit** is a week the backup did not run: not clean either. To
restore, see `db/restore-drill.sh`.

### Exit criteria — when Grafana may be switched to the database

The soak is over when **all** of these hold; until then Grafana stays on the
JSON feeds on Pages:

1. **Three consecutive ISO weeks, each with a POSITIVE record**: a commit in the
   backup repo for that week whose subject says `parity ok N/N` (N = every feed
   `main` publishes). That one commit proves all three at once — the backup only
   runs after `sync == ok`, the verdict is the parity check's, and the commit
   exists because the push worked. **The absence of a database line in Slack is
   not evidence**: an unmerged week (the sync never ran) and a week whose Slack
   post failed look exactly the same. No commit for a week = not a clean week.
   *Which run counts:* the week's record may come from either path — the Monday
   scheduled run when the week auto-merged (`Via: linkedin-stats-weekly`), or
   the `pages-deploy` dispatch **with `backup` ticked** that followed a
   hand-merge (`Via: pages-deploy`). A hand-merged week synced *without*
   `backup` ticked leaves no record: tick it. If a week has several commits
   (re-dispatches), the **last** one is the week's verdict.
2. The counter **resets to zero** on: a week whose record says anything other
   than `parity ok N/N` (*DIFFERS*, *INCOMPLETE*, *ERROR*, *TIMEOUT*, *NOT
   RECORDED*); a week with no record at all (sync skipped / failed / could not
   connect, backup failed, week never merged); any change to `db/schema.sql`,
   `db/import.mjs`, `db/export.mjs`, `db/verify.mjs` or `build-stats-json.mjs` /
   `build-page-stats.mjs`.
3. **Both paths into the database have been seen working** within those three
   weeks: at least one record with `Via: linkedin-stats-weekly (schedule)` and at
   least one with `Via: pages-deploy (workflow_dispatch)`. If every week
   auto-merged, make the second one deliberately: dispatch `pages-deploy` with
   `backup` ticked. That extra commit is a record *for criterion 3 only* — it
   neither adds a week to criterion 1 nor resets it (unless it is not `parity
   ok`, which resets like any other).
4. The row counts in those commits are plausible and non-decreasing, and **one
   restore drill** (`db/restore-drill.sh`) from the latest commit has succeeded.
5. `grafana_ro` has been checked to see `dash` only (`node db/test-roles.mjs`).

Switching over is then a Grafana datasource change; the dual-write jobs stay on
afterwards, so the JSON build keeps acting as the parity reference for as long
as the scraper still writes JSON.
