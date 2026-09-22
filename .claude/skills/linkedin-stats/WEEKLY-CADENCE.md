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
   are `continue-on-error` and can neither fail the run nor cost the week —
   but **`db-sync` is what the Grafana dashboards read** (section 10): Pages no
   longer feeds them, so a week reaches the dashboards only when the sync and
   its parity check end `ok`;
9. **always** — success, failure, cancellation or a `scrape` timeout — a
   separate final job, `notify` (`needs: [scrape, publish, db-sync, db-backup]`,
   `if: always()`, `continue-on-error: true`), posts **one** message to
   `#linkedin-session-bot` (`.github/scripts/notify-weekly.mjs`). Because it
   runs after `publish`, it can tell these apart:

   | outcome | ping | deadline |
   |---|---|---|
   | *collected and published — the dashboards are up to date* — merged, deployed, `publish` green, **and** the database sync + parity check `ok` | no | — |
   | *published, but the Grafana post picker refresh failed* — merged, deployed, `publish` red | no | none — data is live; the next successful publish rebuilds the picker |
   | *safe on main, but the Grafana dashboards were NOT updated* / *may be WRONG* — merged, but the database sync (or its parity check) did not end `ok`, **whatever happened to Pages** | operator | **none** — the week is merged; fix the database (usually: resume the paused Supabase project), then run `pages-deploy` (section 9) |
   | *safe on main, NOT published to GitHub Pages* — merged, deploy failed / cancelled / unconfirmed; or `publish` skipped after a merge. The dashboards are fine if the database line says so: only the public JSON feed and the `$post` picker are stale | operator | **none** — the week is merged; run `pages-deploy` |
   | *NOT published, waiting for review* — PR open, not merged (PR link, each author's problem) | operator | **next Monday 00:00 UTC** — merge before it or the week is lost |
   | *crashed before a PR existed* (run link) | operator | **next Monday 00:00 UTC** |

   The two "no deadline" rows and the two "Monday" rows are deliberately
   different: an unmerged week is lost for good at the next run; a merged week
   whose sync or deploy failed only means stale dashboards or a stale Pages
   feed. Authors are never tagged.
   Every *merged* outcome carries a **database line**: grey (*Database (Grafana
   reads it): synced · parity byte-identical · backup pushed*) when all is
   well; **red, with the operator pinged and the headline changed**, when the
   sync or the parity check did not end `ok` — the dashboards are then stale or
   unverified; **orange, no ping**, when only the backup failed — neither the
   week nor the dashboards are affected. See section 9.
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
| `LI_SYNC_DATABASE_URL` | secret | DSN of the least-privilege `li_sync` role. Unset → the `db-sync` job **skips with a `::warning::`**; the collected week is unaffected, but **the Grafana dashboards are not updated** (they read this database), so Slack says *the sync was skipped … the Grafana dashboards were NOT updated* and pings the operator — every week, until the secret exists. |
| `LI_BACKUP_DATABASE_URL` | secret | DSN of the read-only `li_backup` role. Unset → the backup is skipped, with a warning and a Slack line. |
| `LI_BACKUP_DEPLOY_KEY` | secret | SSH **private** key whose public half is a deploy key **with write access** on the private repo `speedandfunction/linkedin-stats-backup`. Unset → same skip. |

None of the three is an owner credential, and none is required *for the week*:
the JSON path, the PR, the Pages deploy and the run's red/green are identical
with or without them. `LI_SYNC_DATABASE_URL` is required *for the dashboards*,
though: Grafana reads the database, not Pages. Setup and reading the Slack line
are in section 9; what Grafana reads, in section 10.

### Operator-local — NOT in GitHub at all

| Name | Where | Notes |
|---|---|---|
| `GRAFANA_PG_DATASOURCE_UID` | your gitignored `~/LinkedInStatistic/.env` only | uid of the Grafana PostgreSQL datasource (role `grafana_ro`). The checked-in dashboards carry the placeholder `${DS_LINKEDIN_PG}` instead — this repository is public and the real uid must never be committed. `push-dashboard.mjs --file` swaps it in at push time and refuses without it. **Do not create a repo secret or variable for it: no workflow pushes dashboards** (CI only refreshes the `$post` list, which needs no datasource uid). Section 10. |

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
| `~/LinkedInStatistic/.env` | `GRAFANA_URL`, `GRAFANA_SERVICE_ACCOUNT_TOKEN`; `GRAFANA_PG_DATASOURCE_UID` (stays local — not copied to GitHub) |
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
   set -a; . ./.env; set +a      # GRAFANA_URL, GRAFANA_SERVICE_ACCOUNT_TOKEN, GRAFANA_PG_DATASOURCE_UID
   # a. generate: two dashboards per author in profiles.json, from _template/
   node .github/scripts/gen-author-dashboards.mjs
   # b. push the new author's two dashboards (placeholder -> real uid at push time)
   node .github/scripts/push-dashboard.mjs --uid linkedin-<slug>       --file dashboards/grafana/linkedin-<slug>.json
   node .github/scripts/push-dashboard.mjs --uid linkedin-<slug>-posts --file dashboards/grafana/linkedin-<slug>-posts.json
   # c. fill the $post picker - live AND in the checked-in file - for EVERY author
   for a in $(jq -r 'keys[] | select(startswith("_") | not)' .claude/skills/linkedin-stats/profiles.json); do
     node .github/scripts/update-post-variable.mjs --author "$a" --snapshot "dashboards/grafana/linkedin-$a-posts.json"
   done
   git diff --stat dashboards/grafana/   # expect: the new author's two files, nothing lost elsewhere
   ```
   **Step c is not optional.** `gen-author-dashboards.mjs` regenerates *every*
   author's files and **wipes the committed `$post` list in every
   `linkedin-<author>-posts.json`** (the list is baked per author and must not
   be inherited from the template). Until `update-post-variable.mjs --snapshot`
   has been re-run for an author, that author's checked-in file has an empty
   picker — and pushing it would empty the live one. The live dashboards of
   authors you did not push are untouched; step c only restores their files.
   The panels of the new dashboards read `dash.feed_*` with
   `author = '<slug>'`, so they stay empty until the author's first week has
   been merged **and synced** (section 10).
   Commit `profiles.json` + the generated dashboards — check first that no
   file contains a datasource uid other than `${DS_LINKEDIN_PG}`. The scrape
   loop, `build-pages.mjs`, the database import and the Grafana refresh all
   derive the author list from the data — **no workflow edit needed**.

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
"dashboards were NOT updated" alert is not left standing. Every `pages-deploy`
run also re-syncs `main` into the database, and the same two classes apply: a
sync or parity result other than `ok` turns the headline into *…but the Grafana
dashboards were NOT updated / may be WRONG* and pings the operator even when the
deploy itself succeeded; a failed backup alone is an orange line, no ping. Like
the weekly, a Slack failure there never changes the run's red/green.

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
deploy failed (Slack says *NOT published to GitHub Pages* — dispatch
`pages-deploy.yml`, no deadline) or only the Grafana refresh failed (Slack
says *post picker refresh failed* — the data is live). Only a red `scrape`
carries the next-Monday deadline.

**A green run does not prove the dashboards moved.** The database jobs are
`continue-on-error`, so a Monday whose sync failed is still green. The signal
is the Slack message: *the Grafana dashboards were NOT updated* / *may be WRONG*
with a ping (act — section 9), or the grey *Database (Grafana reads it): synced
· parity byte-identical* line (nothing to do).

**e. Publishing.** `https://speedandfunction.github.io/LinkedInStatistic/<author>/stats.json`
should carry the new week, and the Grafana `$post` picker on
`linkedin-<author>-posts` should list the week's new posts. The dashboards
themselves show the new week once `db-sync` ended `ok` — they read Postgres,
not that URL (section 10).

## 9. The dual-write stage (JSON + Postgres, in parallel)

**JSON in git is still the source of truth for the collected week.** Once a
week's data is **on `main`**, the same data is imported into Postgres, the
database's view of it is compared byte-for-byte with the JSON build, and the
database is backed up.

**Grafana reads this database** — every panel queries a `dash.feed_*` view
(section 10); no dashboard reads the JSON on Pages any more. So the stage is no
longer a harmless shadow: the week cannot be lost here, but **a sync that does
not end `ok` leaves the dashboards on the previous sync**, and a parity check
that does not end `ok` leaves them unverified. The JSON feed on Pages is still
built and published — it is the oracle the database is checked against.

The git PR stays **the** quality gate. An incomplete week sits in an open PR, is
not on `main`, and is therefore never synced. Whatever `main` contains is, by
definition, published — so the sync publishes what it imports.

### What runs where

| Job | In | Runs when | Does |
|---|---|---|---|
| `db-sync` | `linkedin-stats-weekly.yml` | `main_updated == 'true'` (a clean, auto-merged week). Needs only `scrape` — **not** `publish`: a failed Pages deploy does not make `main` any less merged. The dependency runs the other way: `publish` **waits for `db-sync`** (normally 1–3 min, at worst its 45 min of caps), because its last step, the `$post` picker, is pushed only when `sync == 'ok'` — see §10 | checkout `main` → `npm ci --prefix db` → `LI_DSN=… node db/import.mjs --publish` → `LI_DSN=… node db/verify.mjs` |
| `db-sync` | `pages-deploy.yml` | every dispatch, in parallel with `build`. This is how a **hand-merged** week reaches the database. `refresh-post-variable` needs it and runs only on `sync == 'ok'` | the same; always syncs `main`, whatever ref was dispatched |
| `db-backup` | `linkedin-stats-weekly.yml` | after `db-sync` reported `sync == 'ok'` (whatever parity said — a week where the two sides disagree is worth keeping) | PostgreSQL 17 client from apt.postgresql.org (key fingerprint pinned) → `db/backup.sh` → one file, `linkedin.sql`, committed over the previous one and pushed over SSH to the private repo |
| `db-backup` | `pages-deploy.yml` | **only** if the `backup` box is ticked on the dispatch form (default off) | the same |
| `notify` | both | always | one Slack message. Sync or parity not `ok` → the **headline** says the dashboards were NOT updated / may be WRONG, the operator is pinged, and a red database line says **what to do**; only the backup failed → an orange line, no ping; all well → a grey one-line confirmation (*Database (Grafana reads it): synced · parity byte-identical · backup pushed*) |
| `db-keepalive` | `linkedin-session-check.yml` (daily, 07:00 UTC) | every scheduled run; skipped on a dry-run dispatch | `db/ping.mjs` as `li_sync`: one read, nothing written. See *Why the project must be kept awake* below. Never red, **no Slack line of its own — although it is now the only daily probe of the database the dashboards read** (see below) |

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

**A failed keep-alive means the dashboards are down NOW — do not wait for
Monday.** Grafana reads this same database: a project that does not answer
`db/ping.mjs` at 07:00 does not answer Grafana either, and every panel shows a
datasource error (a pause, a changed `li_sync` password and a Supabase incident
all look alike from here). The `::warning::` of the job says exactly that.
**Nobody is told, though:** the job is never red and has no `outputs`, and
`notify-session-check.mjs` does not know it exists — the warning sits on a green
daily run until Monday's sync fails and pings. Forwarding it (an `outputs: touch`
on the job, one operator-pinged Slack line when it is neither `ok` nor
`skipped-no-secret`) is an **open operator decision**: it touches
`linkedin-session-check.yml` and `notify-session-check.mjs`, which the move to SQL
left alone. Two fallback `echo` lines in that workflow still say *"Nothing else
is affected"* for the same reason — read them as "the dashboards may be down".
Whether one `SELECT` a day counts as "activity" for Supabase's pause timer is
also unverified from here; a Monday that starts paused despite a green keep-alive
is the evidence that it does not.

Why the backup is weekly-only by default: its git history is meant to read one
entry per week, a manual deploy is often re-run several times while something is
being fixed, and during dual-write the database can always be rebuilt from git
with `db/import.mjs`. A hand-merged week loses nothing by waiting for Monday's
backup — that is a full dump and includes it. Tick `backup` when you want a
restore point *now* (before a schema change, after a repair).

### The three guarantees

1. **A database problem never costs a week and never turns the run red** (it
   does cost the *dashboards* their update — that is what the Slack ping is
   for). Every
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

No owner credential goes into CI. Until `LI_SYNC_DATABASE_URL` exists, every
merged run says *the sync was skipped … the Grafana dashboards were NOT updated*
and pings the operator — correctly: Grafana reads the database, and nothing is
filling it. The week itself is unaffected.

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
the Slack message should end with the grey line *Database (Grafana reads it):
synced · parity byte-identical · backup pushed*. The backup repo then has its
first commit, whose subject reads `… - parity ok 4/4 - …`.

### Reading the database line in Slack

When the sync, the parity check and the backup all succeeded, the message ends
with one small grey line — *:white_check_mark: Database (Grafana reads it): synced
· parity byte-identical · backup pushed*. It is the only positive record in the
channel that the dashboards really moved: "no line" is also what a run looks like
when the database outputs never reached the notifier. Absence proves nothing.
(The durable record is not Slack at all — see *The ledger* below.)

Otherwise there is exactly one extra block, directly under the headline, and
which one depends on **what the problem costs**:

**(a) Sync or parity not `ok` — the dashboards are affected. The operator is
pinged.** The headline itself changes — *Week … is collected and safe on main,
but the Grafana dashboards were NOT updated* (sync) or *…may be WRONG* (parity) —
whatever happened to Pages, and in `pages-deploy` too. Under it:

> :red_circle: **Database (dual-write stage):** *…what happened…*.
> :point_right: *…what to do…* (always present)
> :shield: **The collected week is safe in git** — nothing is lost and there is no data-loss deadline. But Grafana reads the database, so the dashboards keep showing the previous sync … until this is fixed and `pages-deploy` has re-run.

When the database **did not answer** (`could not connect`, or a timeout) the last
sentence is a different one, because "paused" and "still showing last week"
cannot both be true: *…so while the project is paused or unreachable Grafana
cannot read it either: every panel shows a datasource error — not last week's
numbers — until the database answers again; after that the dashboards show the
previous sync until `pages-deploy` has re-run.*

There is no data-loss deadline, but it does not go away on its own: until
someone acts, Grafana shows last week, nothing at all (a paused project), or
numbers nobody has verified. An
**empty** output (the job crashed, was cancelled, never started) counts as *not
ok* — unknown is never fine.

**(b) Only the backup failed — neither the week nor the dashboards are
affected. Nobody is pinged.**

> :large_orange_diamond: **Database (dual-write stage):** *the backup FAILED (…)*.
> **The week and the dashboards are not affected** — … only this run's backup (the restore point) is missing.

It is not small grey print either: it sits under the headline every week until
it is fixed. The `::warning::` annotations on the run (from `db-ci.mjs`, the
two composite actions and `push.sh`) say the same two things in the same words.

| The line says | Meaning | What to do |
|---|---|---|
| **Class (a) — dashboards stale or unverified, operator pinged** | | |
| *the sync was skipped — the `LI_SYNC_DATABASE_URL` secret is not set* | setup not done yet; nothing fills the database Grafana reads | the three secrets above, then dispatch `pages-deploy.yml` |
| *the sync FAILED (could not connect to the database)* | **the dashboards are DOWN, not stale**: Grafana reads the same database, so every panel shows a datasource error until it answers. The importer never got a connection (it gives up after 20 s). **Almost always a paused Supabase project** — the free tier pauses after 7 idle days, and the cron is 7 days apart. The `db-sync` log shows the importer's own line: `connection timeout`, `ETIMEDOUT`, `ECONNREFUSED`, or `SQLSTATE XX000 — Tenant or user not found` (the pooler cannot route to a paused/deleted project, or the `<role>.<project-ref>` user name is wrong). `password authentication failed` / `database "<redacted>" does not exist` mean the DSN secret is wrong instead | **resume the project in the Supabase dashboard**, then dispatch `pages-deploy.yml` — it re-syncs `main`, and the import is idempotent. Then check why `db-keepalive` in the daily run did not keep it awake |
| *the sync timed out (the import)* | no answer within 15 min: the connection opened and then hung. Same first suspect — a project that is pausing or resuming — and the same consequence: the dashboards are most likely down too | the same: resume, then dispatch `pages-deploy.yml` |
| *the sync FAILED (the import)* | the importer **connected** and then failed; its transaction rolled back, the database is as it was. Not a pause | open the `db-sync` job: the hints name the cause (`SQLSTATE …`, `permission denied for table …`, a constraint name). For the withheld lines, run the same command locally. Fix, then dispatch `pages-deploy.yml` |
| *the sync FAILED (installing the db/ dependencies)* | `npm ci --prefix db` failed | usually the registry; re-dispatch |
| *the sync did not run or did not finish* | the job wrote no output: crashed early, was cancelled, or checkout failed | open the run; re-dispatch `pages-deploy.yml` |
| *the parity check found a DIFFERENCE* | the import worked, but the database is **not** byte-identical to the JSON build — either the export (`<author>/stats.json`) or a `dash.feed_*` view a panel reads (`<author>/dash.feed`, FEED PARITY). **Grafana may be showing different numbers than the JSON build right now** | the `db-sync` log lists each differing path with type, length and a per-run salted digest — never the value. **Two cases are not a data bug and no code change fixes them:** every line `[feed-absent]` on `<author>/dash.feed` = the schema in the database is **older than `main`** (the PR was merged before the schema was re-applied, §10 *First rollout*) → `apply-schema --force && import --publish` as the owner; `[grant-missing]` under `dash.reader_grants` = `grafana_ro` lost a privilege and the panels answer *permission denied* → re-apply the ROLES section of `db/schema.sql`. Anything else: reproduce locally with `LI_DSN=… node db/verify.mjs --show-values`, fix `db/export.mjs` / the view / the merge rules, re-dispatch `pages-deploy.yml`. Not a clean week in the ledger |
| *the parity check was INCOMPLETE* | it found no difference, but compared **fewer feeds than `main` publishes**. Pages builds a feed for every folder under `dashboards/li-stats/` with an `account.json`; the importer takes its authors from `profiles.json`. A folder that is not in `profiles.json` is published and never imported | the `db-sync` log has both counts. Add the author to `profiles.json` (or remove the stray folder), re-dispatch. Does not count as a clean week |
| *the parity check could not be completed* / *timed out* | it crashed or hung before comparing anything — not evidence of a difference, not evidence of parity either | dispatch `pages-deploy.yml` to re-sync and re-check; if the database does not answer, check that the project is not paused. Does not count as a clean week |
| **Class (b) — backup only, nobody pinged** | | |
| *the backup was skipped — … not set* | one or both backup secrets are missing | setup step 2–3 |
| *the backup FAILED (installing the PostgreSQL 17 client)* | apt.postgresql.org unreachable, or its signing key no longer matches the pinned fingerprint | if PostgreSQL rotated the key, update the fingerprint in `.github/actions/db-backup/action.yml` |
| *the backup FAILED (pg_dump)* | `db/backup.sh` refused: database unreachable, `pg_dump` older than the server, an empty dump, or dump/source row counts disagree | the `db-backup` log shows the per-table counts and the script's own reason |
| *the backup FAILED (pushing to the backup repository)* | the repo does not exist, or the deploy key lacks **write** access (that fails exactly at the push) | fix the deploy key; re-dispatch with `backup` ticked |

**The ledger.** The backup repo's history is the backup history *and* the
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

### The switch has been made — what still guards it

The checked-in dashboards read this database, not the JSON feeds on Pages
(section 10; the live Grafana follows once the operator has pushed them — *First
rollout* there). The soak criteria that used to stand here (three consecutive `parity ok N/N`
weeks, both sync paths seen working, one restore drill, `grafana_ro` sees `dash`
only) are no longer a gate — they are the **weekly health check of what the
dashboards read**:

1. **Every week should leave a POSITIVE record**: a commit in the backup repo
   whose subject says `parity ok N/N` (N = every feed `main` publishes). That one
   commit proves the sync, the parity check (exports **and** every `dash.feed_*`
   view) and the push at once. **The absence of a database line in Slack is not
   evidence.** A week with `DIFFERS`, `INCOMPLETE`, `ERROR`, `TIMEOUT`, `NOT
   RECORDED`, or with no commit at all, is a week in which the dashboards were
   stale or unverified for some time — the Slack ping of that run says which.
2. **Both paths into the database stay exercised**: `Via: linkedin-stats-weekly
   (schedule)` for auto-merged weeks, `Via: pages-deploy (workflow_dispatch)`
   (with `backup` ticked) after a hand-merge. A hand-merged week synced *without*
   `backup` ticked reaches the dashboards but leaves no record: tick it.
3. **Any change to `db/schema.sql`, `db/import.mjs`, `db/export.mjs`,
   `db/verify.mjs`, `build-stats-json.mjs` / `build-page-stats.mjs` or a
   dashboard** is now a change to what viewers see. Before it: `node db/verify.mjs`
   and `node db/verify-panels.mjs --baseline caf2834` on a local database; rolling
   a schema change out to the live database empties the dashboards for about a
   minute — the order is in `db/README.md` («Зміна схеми, коли ЖИВІ дашборди вже
   читають `dash`»).
4. The row counts in the ledger are plausible and non-decreasing, and a restore
   drill (`db/restore-drill.sh`) is repeated now and then. A database restored
   from a dump has **no grants** (`--no-privileges`): re-apply the `roles`
   section of `db/schema.sql` before pointing Grafana at it (`db/README.md`).
5. `grafana_ro` sees `dash` only (`node db/test-roles.mjs`).

The dual-write jobs stay on, so the JSON build keeps acting as the parity
reference for as long as the scraper still writes JSON. Going back to the JSON
feeds is possible at any time — section 10, *Rollback*.

---

## 10. Grafana reads Postgres

Every panel and every query variable of our seven dashboards
(`linkedin-<author>`, `linkedin-<author>-posts` per author, `linkedin-page`) is a
`rawSql` against Grafana's **PostgreSQL datasource**, role `grafana_ro`, and reads
**only** the `dash.feed_*` views — one view per section of the old JSON feed, same
columns, same order (`db/README.md`, «Що читає Grafana»). Nothing reads
`https://speedandfunction.github.io/LinkedInStatistic/…` through the Infinity
datasource any more. Out of scope and unchanged: `linkedin-stats.json`,
`linkedin-stats-posts.json` and `_archive/` (upstream leftovers).

What still comes from where:

| Thing on the dashboard | Source | Updated by |
|---|---|---|
| every panel, `$month`, the hidden `account_latest_week` | Postgres, `dash.feed_*` | `db-sync` (weekly run after an auto-merge; every `pages-deploy`) |
| the `$post` picker (a Custom list baked into the dashboard) | the post files on `main` | `update-post-variable.mjs`, in `publish` / `refresh-post-variable`, after a successful Pages deploy **and only when `db-sync` reported `sync == 'ok'`** |
| the public JSON feed on Pages | `build-pages.mjs` from `main` | `publish` / `pages-deploy`. No dashboard reads it; it is the parity oracle's public copy |

### What a failed or skipped sync means now

Before, a database problem was invisible to viewers. Now:

- **Sync not `ok`, and the database ANSWERED** (the import rolled back, npm
  failed, the secret is missing, no output at all): the dashboards **stay on the
  previous sync** — last week's numbers, this week's posts missing from every
  panel. Slack: *…the Grafana dashboards were NOT updated*, operator pinged.
- **Sync not `ok` because the database did NOT answer** (`could not connect`, a
  timeout — most often a **paused Supabase project**): the dashboards are **down**,
  not stale. Grafana reads the same database, so every panel shows a datasource
  error until the project answers again; only then do they show the previous
  sync. Same headline in Slack, and the database line says so. **Resume the
  project, then dispatch `pages-deploy.yml`** (the import is idempotent). A wrong
  `LI_SYNC_DATABASE_URL` shows as `password authentication failed` / `does not
  exist` in the `db-sync` job instead of a timeout — that one leaves the
  dashboards up.
- **The `$post` picker is held back with the sync.** `update-post-variable.mjs`
  makes the newest post that has metrics the **default** of `$post`, and a new
  post gets its first week in the very merge being published — in most weeks the
  default moves. Pushed without the sync, every viewer would **open** the three
  `-posts` dashboards on a post the database does not have: twelve panels of *No
  data*, until somebody repaired the database. So both workflows push the picker
  only when `sync == 'ok'` (the weekly `publish` job waits for `db-sync` for that
  one step); otherwise it keeps last week's list and default, and Slack says
  *The `$post` picker was deliberately not refreshed*. The `pages-deploy` re-run
  that fixes the sync refreshes it. Parity is not a condition: once the import
  went through, the post is in the database.
- **Sync `ok`, parity not `ok`**: the database *was* updated, but it is not
  proven to match the JSON build — a `DIFFERENCE` means some panel may show a
  different number than the feed did. Slack: *…may be WRONG*, operator pinged;
  the differing paths are in the `db-sync` job (hashed, never the values).
- **Only the backup failed**: nothing a viewer can see. Orange line, no ping.
- **The week was not merged** (open PR): nothing is synced, by design — the
  dashboards stay on the last merged week, exactly as the JSON feed did.
- **Pages deploy failed, sync `ok`**: the dashboards are current; only the public
  JSON feed and the `$post` picker are stale. Run `pages-deploy`.
- **`grafana_ro` lost a privilege** (a regression of the ROLES section, a manual
  `REVOKE`): every panel answers *permission denied* while the data is perfect.
  The weekly parity check asks the catalog about that role as `li_sync` and
  reports it as a difference (`[grant-missing]`, class (a)). What **nothing**
  checks: the datasource inside Grafana (its password, its uid) and whether the
  live dashboards are the files in this repository — look at them after a push.

A green run does **not** prove the sync worked (the database jobs are
`continue-on-error`). The Slack message does.

### The datasource uid: `${DS_LINKEDIN_PG}` and `GRAFANA_PG_DATASOURCE_UID`

This repository is public, so the dashboards in `dashboards/grafana/` never carry
the uid of the Postgres datasource. Every `datasource` is
`{ "type": "grafana-postgresql-datasource", "uid": "${DS_LINKEDIN_PG}" }` — a
literal placeholder, not a Grafana variable.

- `push-dashboard.mjs --file` replaces the placeholder with
  `$GRAFANA_PG_DATASOURCE_UID` just before the POST, and **refuses** (exit 2,
  nothing sent — also with `--dry-run`) when the file has the placeholder and the
  variable is unset or is not a plain uid. Its messages never echo the uid.
- `push-dashboard.mjs --dump` does the reverse — and **refuses too** (exit 2,
  nothing written) when the live dashboard reads Postgres and the variable is
  unset: without the uid in hand only the `{ type, uid }` form is recognisable,
  and a type-less `{ uid }`, a legacy `"datasource": "<uid>"` or a uid quoted in
  a link would be written as they are. With the variable set it also refuses a
  `datasource` that is still untyped after the swap (the variable may hold
  another datasource's uid). Set the variable for both directions.
- `GRAFANA_PG_DATASOURCE_UID` is **operator-local**: it lives in your gitignored
  `.env` (placeholder in `.env.example`). It is **not** a repo secret or variable
  — no workflow pushes dashboards. CI only runs `update-post-variable.mjs`, which
  patches `$post` on the live dashboard and never touches a datasource.
- Find the value in Grafana: *Connections → Data sources →* the PostgreSQL one;
  the uid is the last segment of that page's URL. The datasource must log in as
  `grafana_ro` (TLS, Session-pooler host — `db/README.md`).
- Before committing anything under `dashboards/grafana/`:
  `grep -o '"uid": *"[^"]*"' dashboards/grafana/linkedin-*.json | sort | uniq -c`
  — the only datasource uid may be `${DS_LINKEDIN_PG}` (the others are the
  dashboards' own uids and `-- Grafana --`).

### Pushing dashboards

```bash
cd ~/LinkedInStatistic
set -a; . ./.env; set +a     # GRAFANA_URL, GRAFANA_SERVICE_ACCOUNT_TOKEN, GRAFANA_PG_DATASOURCE_UID
# 1. prove the SQL first (local database, or LI_DSN=<grafana_ro dsn> against the live one)
node db/verify-panels.mjs --baseline caf2834
# 2. see what would change, then push
node .github/scripts/push-dashboard.mjs --uid linkedin-page --file dashboards/grafana/linkedin-page.json --dry-run
node .github/scripts/push-dashboard.mjs --uid linkedin-page --file dashboards/grafana/linkedin-page.json
for a in $(jq -r 'keys[] | select(startswith("_") | not)' .claude/skills/linkedin-stats/profiles.json); do
  node .github/scripts/push-dashboard.mjs --uid "linkedin-$a"       --file "dashboards/grafana/linkedin-$a.json"
  node .github/scripts/push-dashboard.mjs --uid "linkedin-$a-posts" --file "dashboards/grafana/linkedin-$a-posts.json"
  # the checked-in $post list is only as fresh as its last --snapshot: refresh it right after the push
  node .github/scripts/update-post-variable.mjs --author "$a" --snapshot "dashboards/grafana/linkedin-$a-posts.json"
done
```

Never edit these dashboards in the Grafana UI: the next push overwrites the
whole dashboard. Author dashboards are generated — edit
`dashboards/grafana/_template/author*.json` (the slug is the token `__AUTHOR__`
inside each `rawSql`) and re-run `gen-author-dashboards.mjs`; the page dashboard
is generated by `build-page-dashboard.mjs`. **Regenerating wipes the committed
`$post` lists** — re-run `update-post-variable.mjs --snapshot` for every author
before committing (§5, step c). Inside a `rawSql`, variables appear only as
`${post:sqlstring}` / `${month:sqlstring}`.

**First rollout** (once, when this change goes live). **Order relative to the
MERGE matters — steps 1–3 come BEFORE the PR is merged, from a checkout of its
branch:**

1. take a backup (`pages-deploy` with `backup` ticked);
2. the live database does not have the `dash.feed_*` views yet — re-apply the
   schema and re-import as the owner, in one line
   (`node db/apply-schema.mjs --force && node db/import.mjs --publish`;
   `db/README.md`, «Зміна схеми…»). Nobody is affected while the live dashboards
   still read Pages, and the old `verify.mjs` / `import.mjs` on `main` keep working
   against the new schema: the change only ADDS views;
3. `node db/verify.mjs`, then `LI_DSN=<grafana_ro dsn> node db/verify-panels.mjs`
   (add `--baseline caf2834` once this change is on `main`);
4. **merge the PR**, and the same day — not "after Monday 00:00 UTC" —
5. make sure the PostgreSQL datasource exists in Grafana and put its uid in your
   `.env`; push the seven dashboards and refresh `$post` as above.

**If the PR was merged first:** the next `db-sync` (Monday, or any
`pages-deploy`) runs the new `verify.mjs` against the old schema and pings
*…the Grafana dashboards may be WRONG* — a parity DIFFERENCE with `[feed-absent]`
on every `<author>/dash.feed`. Nothing is wrong with the data and no code change
fixes it: do step 2, then dispatch `pages-deploy`.

**Between the merge and step 5** (and after a *Rollback*) the Slack texts are
ahead of reality: they assume the live dashboards read the database. While they
still read Pages, read the message the other way round — a failed Pages deploy
with a green database line DOES leave the dashboards stale, and a database
problem does NOT touch them.

### Rollback

Two ways back, both leave the data alone:

- **One dashboard, quickly:** Grafana keeps a version history per dashboard —
  *Dashboard settings → Versions → Restore* the last version before the push.
  Every scripted push and every `$post` refresh is a version with a message.
- **Back to the JSON feed, from git:** the last commit whose dashboards still
  read Pages through Infinity is `caf2834`. Those files contain no placeholder,
  so no datasource uid is needed:
  ```bash
  git show caf2834:dashboards/grafana/linkedin-page.json > /tmp/linkedin-page.json
  node .github/scripts/push-dashboard.mjs --uid linkedin-page --file /tmp/linkedin-page.json
  # same for linkedin-<author>.json / linkedin-<author>-posts.json, then
  # update-post-variable.mjs --author <slug> (the old files carry an old $post list)
  ```
  The JSON feed on Pages is still built and deployed every week, so the old
  dashboards work immediately. The database jobs can stay on — but while the
  dashboards are rolled back to Infinity, Slack keeps saying *"Grafana reads the
  database"*: read it the other way round (see *First rollout*), or roll the
  notifier back as well.

### The live clock: what a viewer sees around midnight UTC

The old JSON feed was **frozen at publish time**: "last week" and the month
range were computed once, during Monday's build, and did not move until the next
publish. The views compute both from `now()` on every query. Two things
therefore roll over **by themselves, at 00:00 UTC** — before Monday's run has
collected anything:

- **On the 1st of a month, 00:00 UTC** — *Posts published per month* and the
  three *…comments per month* panels on every author dashboard grow a new
  right-most month with **zeros** (0 posts, 0 impressions, 0 comments). With the JSON feed that bar appeared
  only at the first publish of the month. It fills in at the first Monday sync
  that carries a post or comment of that month.
- **On Monday, 00:00 UTC** — the boundary of "a week that is already over"
  moves forward by one week. *Last week* is the newest week **present in the
  data** that lies before that boundary, so:
  - **normally nothing changes** between midnight and the sync (roughly
    00:00–03:00 UTC, longer if the PR needs a hand-merge). Reactions are always
    attributed to the week *before* the run, so the newest week in the database
    is already "over": the four *Engagement score (last week)* tiles and the
    `score_last_week` column of *Top engagers* keep showing the same week as on
    Sunday. When the sync lands, they jump to
    the week just collected — as they used to at publish time;
  - **the exception**: an outbound comment written on a Monday morning *before
    that day's scrape read it* is attributed to the week that had just begun.
    A week later, at 00:00 UTC, that week becomes "over", and until the sync
    lands the *Engagement score (last week)* tiles and `score_last_week` show
    **that week with only those few comments** — a near-zero score where Sunday
    showed a full week. *Engagement score per week* is unaffected (it already
    had that small bar). The sync replaces it with the
    full week.
  - if the sync **fails**, or the week is **not merged**, this in-between state
    stays until someone acts: the dashboards do not go blank, they keep the last
    synced data under this week's clock.
- The company page dashboard does not move with the clock: its "last week" is the
  latest **month** of the export, and `$month` lists exactly the months in the
  database.

Parity between the views and the JSON build was proven at the *same* instant on
both sides, on five different clocks — the difference above is not between the
database and the feed, it is between "computed now" and "computed on Monday".
For the same reason **no check can see it**: `verify.mjs` and `verify-panels.mjs`
pin both sides to one instant.

How often, measured on the corpus: the `2026-08-31` scrape carries 4 such
comments (of 812 events, two authors), the `2026-09-14` scrape none. So on
`2026-09-07 00:00 UTC` the *last week* tiles of two authors dropped to a week of
1–3 events (one score 47 → 5) until that Monday's sync landed, and on the coming
Monday nothing flips. Panels involved on each author dashboard: stat 22–25, *Top
engagers* (27, sorted by *Last week*, `limit 15` — the top 15 reshuffles) and
table 36; the month bars are 13, 19, 15, 16.

**This is a product decision that has NOT been taken** — the move to SQL did not
touch the clock semantics. Keep it (the dashboard honestly shows "the last week
that is over", complete or not), or bound "last week" by the newest *published*
scrape week as well, mirrored in the reader so that parity holds — the exact
change is spelled out in `db/README.md`, «Живий годинник у Grafana».
