#!/usr/bin/env bash
# The weekly run, for a server that is NOT GitHub Actions.
#
# Mirrors what .github/workflows/linkedin-stats-weekly.yml does, minus the
# parts that belong to GitHub: scrape every account in profiles.json, commit
# the result, open a PR, merge it when the run was clean, then hand publishing
# back to Actions (pages-deploy also syncs the database and refreshes Grafana's
# post picker, and its secrets live there, not here).
#
# Needs in the environment (put them in .env, mode 600, and `set -a; . ./.env`):
#   BROWSERBASE_API_KEY, BROWSERBASE_PROJECT_ID   the remote browser
#   LIFLEET_REGISTRY or scripts/lifleet/authors.json   slug -> cloud profile
#   gh must be authenticated (contents:write + pull_requests:write on this repo)
# Optional: SLACK_* if you also want the Slack line from this host.
#
#   ./ops/weekly.sh                 # the real thing
#   DRY_RUN=1 ./ops/weekly.sh       # print what it would do; no scrape, no git
#   AUTHORS="peter maria" ./ops/weekly.sh   # a subset
#
# Exit code: 0 only when every account came back clean AND the week landed.
# Anything else is non-zero on purpose — cron mails it, and a silent week is a
# hole in the data that cannot be backfilled.
set -uo pipefail

cd "$(dirname "$0")/.."
REPO_ROOT="$PWD"
FAST="$REPO_ROOT/.claude/skills/linkedin-stats/fast"
PROFILES="$REPO_ROOT/.claude/skills/linkedin-stats/profiles.json"
DRY_RUN="${DRY_RUN:-0}"
DEADLINE_SECS="${DEADLINE_SECS:-1500}"
HARD_CAP_SECS="${HARD_CAP_SECS:-2100}"
PAUSE_SECS="${PAUSE_BETWEEN_AUTHORS_SECS:-60}"
RUN_BUDGET_SECS="${RUN_BUDGET_SECS:-5400}"
# The ISO Monday of the CURRENT week, computed exactly as the workflow does
# (.github/workflows/linkedin-stats-weekly.yml, "Resolve ISO week"). Not
# `date -d 'last monday'`: GNU date excludes today, so a Monday run would file
# the whole week under the PREVIOUS Monday and the guard below would then
# declare that the week did not land.
WEEK="${WEEK:-$(node -e 'const d=new Date();const day=(d.getUTCDay()+6)%7;console.log(new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate()-day)).toISOString().slice(0,10))')}"
case "$WEEK" in [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]) ;; *) die "could not resolve the ISO week (got '$WEEK')" ;; esac
BRANCH="chore/linkedin-stats-${WEEK}"
started=$(date +%s)

say() { echo "weekly: $*"; }
die() { echo "weekly: $*" >&2; exit 1; }

for c in node git jq gh; do command -v "$c" >/dev/null || die "missing command: $c"; done
[ -f "$PROFILES" ] || die "no $PROFILES in this checkout"
[ -n "${BROWSERBASE_API_KEY:-}" ] && [ -n "${BROWSERBASE_PROJECT_ID:-}" ] \
  || die "BROWSERBASE_API_KEY / BROWSERBASE_PROJECT_ID are not set (source .env first)"
REGISTRY="${LIFLEET_REGISTRY:-$REPO_ROOT/scripts/lifleet/authors.json}"
[ -f "$REGISTRY" ] || die "no lifleet registry at $REGISTRY — without it no account can be opened"

AUTHORS="${AUTHORS:-$(jq -r 'keys[] | select(startswith("_") | not)' "$PROFILES")}"
[ -n "$AUTHORS" ] || die "no accounts selected from $PROFILES"
say "week ${WEEK} · accounts: $(echo "$AUTHORS" | tr '\n' ' ')· dry_run=${DRY_RUN}"

if [ "$DRY_RUN" != "1" ]; then
  git fetch -q origin main || die "git fetch failed"
  git checkout -q -B "$BRANCH" origin/main || die "could not start branch $BRANCH"
fi

clean=1; notes=""; first=1
for a in $AUTHORS; do
  if [ $(( $(date +%s) - started )) -ge "$RUN_BUDGET_SECS" ]; then
    say "budget spent before ${a} — committing what finished"
    clean=0; notes="${notes} ${a}:skipped-budget"; continue
  fi
  [ "$first" = 1 ] || sleep "$PAUSE_SECS"; first=0
  say "--- ${a}"
  if [ "$DRY_RUN" = "1" ]; then say "would scrape ${a}"; continue; fi
  LI_BACKEND=browserbase LI_AUTHOR="$a" \
    timeout --signal=TERM --kill-after=60 "${HARD_CAP_SECS}s" \
    node "$FAST/scrape-weekly.mjs" --deadline-secs="$DEADLINE_SECS" --week="$WEEK"
  rc=$?
  case "$rc" in
    0)  say "${a}: clean" ;;
    11) say "${a}: clean, a reaction list was incomplete (re-read next run)"
        notes="${notes} ${a}:reactors-short" ;;
    10) say "${a}: PARTIAL"            ; clean=0; notes="${notes} ${a}:partial" ;;
    20) say "${a}: LOGGED OUT of LinkedIn — re-invite with lifleet" ; clean=0; notes="${notes} ${a}:auth" ;;
    22) say "${a}: rate-limited by LinkedIn" ; clean=0; notes="${notes} ${a}:ratelimit" ;;
    23) say "${a}: filesystem/merge failure"  ; clean=0; notes="${notes} ${a}:fs" ;;
    30) say "${a}: LINKEDIN MARKUP CHANGED — the scrapers need updating" ; clean=0; notes="${notes} ${a}:drift" ;;
    124|137) say "${a}: killed at the hard cap" ; clean=0; notes="${notes} ${a}:hardcap" ;;
    *)  say "${a}: exit ${rc}"         ; clean=0; notes="${notes} ${a}:exit${rc}" ;;
  esac
  # An exit code is not evidence that anything was written, and a week that did
  # not land cannot be collected later. Check the file, not the code.
  if [ -z "$(git status --porcelain -- "dashboards/li-stats/${a}")" ]; then
    say "${a}: NOTHING was written — treating as a failed week"
    clean=0; notes="${notes} ${a}:nodata"
  elif ! jq -e --arg w "$WEEK" '.weeks[$w]' "dashboards/li-stats/${a}/account.json" >/dev/null 2>&1; then
    say "${a}: no weeks[${WEEK}] entry — this week did NOT land"
    clean=0; notes="${notes} ${a}:noweek"
  fi
done

if [ "$DRY_RUN" = "1" ]; then say "dry run finished — nothing scraped, nothing committed"; exit 0; fi

git add -A dashboards/li-stats
if git diff --cached --quiet; then die "nothing to commit — no account produced data"; fi
git commit -q -m "chore: linkedin stats for week ${WEEK}" || die "commit failed"
git push -q -u origin "$BRANCH" || die "push failed (is the gh token allowed to write?)"

url=$(gh pr view "$BRANCH" --json url --jq .url 2>/dev/null)
[ -n "$url" ] || url=$(gh pr create --base main --head "$BRANCH" \
  --title "chore: linkedin stats for week ${WEEK}" \
  --body "Automated weekly scrape from the server.${notes:+ Notes:$notes}" 2>&1 | tail -1)
say "PR: ${url}"

if [ "$clean" = "1" ]; then
  gh pr merge "$BRANCH" --squash --delete-branch || die "merge failed — merge it by hand, then run pages-deploy"
  gh workflow run pages-deploy.yml --ref main || say "WARNING: could not dispatch pages-deploy — run it by hand"
  say "week ${WEEK} merged and published${notes:+ (notes:$notes)}"
  exit 0
fi
say "week ${WEEK} needs a human: ${notes# }"
say "read the PR, merge it by hand if the data is worth keeping, then: gh workflow run pages-deploy.yml"
exit 1
