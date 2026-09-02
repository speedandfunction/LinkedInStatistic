#!/usr/bin/env bash
# Weekly LinkedIn-stats scrape for EVERY author in profiles.json, driven
# non-interactively by the linkedin-stats-weekly GitHub Actions workflow.
#
# RUNNER: the scraper drives a REMOTE browser (LI_BACKEND=browserbase — one
# persistent Browserbase context per author, see fast/browserbase-backend.mjs),
# so nothing here touches a local Chrome profile and no self-hosted runner is
# required: a stock ubuntu-latest runner is enough. The local-Chrome paths
# below (profile-lock exit 21, the Chrome sweep) are kept because they cost
# nothing and still apply when LI_BACKEND is overridden to the local backend.
# That backend needs BROWSERBASE_API_KEY, BROWSERBASE_PROJECT_ID and the
# lifleet registry (LIFLEET_AUTHORS / LIFLEET_REGISTRY, default
# scripts/lifleet/authors.json — GITIGNORED, so absent from every fresh
# checkout). All three are checked in a preflight below, before any scraping.
#
# MULTI-PROFILE: the authors are the non-"_" keys of
# .claude/skills/linkedin-stats/profiles.json. Each is scraped SEQUENTIALLY
# with LI_AUTHOR=<slug> exported; the SCRAPER owns the data-path mapping
# (dashboards/li-stats/<slug>/) — this driver never re-derives it, it only
# passes the env var and scopes its own bookkeeping by the same slug.
#
# Built on .claude/skills/pipeline-shared/lib.sh (Template Method + Strategy:
# the lib owns the attempt-loop skeleton, watchdogs, heal-session runner and
# Slack micro-call; this driver supplies the policy hooks and owns trap
# composition, author iteration, commit strategy, and the main_updated output).
#
# Self-healing flow:
#   1. Branch off origin/main (suffixed if a same-week PR is still open).
#   2. FOR EACH AUTHOR, in profiles.json key order: up to MAX_ATTEMPTS runs of
#      the deterministic scraper
#      (.claude/skills/linkedin-stats/fast/scrape-weekly.mjs), each under a
#      hard watchdog (the scraper's own deadline is soft — a stuck browser
#      ignores it). Acceptable = exit 0, or exit 10 (partial) whose contract
#      shows no phase-level ERROR and >=80% per-post coverage.
#   3. Between failed attempts, a headless `claude -p` heal session diagnoses
#      and fixes the pipeline following pipeline-shared/references/
#      self-heal-core.md + this skill's references/self-heal.md overlay:
#      evidence, a codex validation round, triage, fix, spot-verify, incident
#      write-up in doc/incidents/. Exceptions: exit 22 sleeps once (second
#      consecutive 429 stops that author's loop — only time helps), exit 21
#      sweeps the orphan Chrome once (second consecutive lock goes to a heal
#      session). A heal session can stop THAT AUTHOR's loop via
#      $PL_HEAL_ROOT/ABORT. Before each retry, only the CURRENT author's
#      dashboards/li-stats/<author>/ is reset to the committed baseline so the
#      final tree is one attempt's coherent output per author, never a
#      cross-attempt hybrid — and never at the cost of an author who already
#      finished.
#   4. jq-validate snapshots, then commit + push + PR via the common-pr-*
#      scripts. ONLY a run where EVERY author was a no-heal exit-0 with real
#      changes auto-merges (and flips the main_updated output that gates the
#      Pages publish job). Everything else — any healed, partial, aborted or
#      exhausted author — leaves the PR OPEN for review; each healed success
#      first gets its own read-only codex critique session
#      (references/self-heal-review.md overlay on the shared core).
#   5. Slack bookends on $SLACK_CHANNEL_ID (unset = no Slack): a 🟢 run-started
#      single EXIT trap posts the ✅/⚠️/❌ run-finished summary (per-author
#      status, attempts, heals, coverage, followers, PR URL, duration) on every
#      exit path — best-effort pinned-haiku micro-calls that never fail the run.
#
# ------------------------------------------------------------------ AUTHOR
# ISOLATION (the multi-profile contract)
#
# One author failing must never cost another author its run or its data:
#   - attempt logs, heal scratch, watchdog timeout markers and the heal
#     ABORT file all live under $HEAL_ROOT/<author>/ (PL_HEAL_ROOT is
#     re-pointed per author), so an ABORT or a stale timeout marker cannot
#     leak across authors;
#   - pipeline_reset_baseline restores ONLY dashboards/li-stats/<author>/;
#   - the JSON validation and the "did the scrape write anything" check are
#     scoped to that same directory;
#   - the per-author loop runs inside `set +e` so a failure returns a status
#     instead of tripping this script's errexit;
#   - the driver's own counters (attempt_summaries, consecutive_rate,
#     consecutive_lock, PL_SESSION_NOTES, PL_HEALED) are reset per author and
#     folded into run-level, author-prefixed accumulators afterwards.
# The ONE deliberate exception is the heal BUDGET: PL_HEAL_COUNT is left
# cumulative across authors, so MAX_HEALS bounds the whole fire (per-author
# attribution is kept as the delta). The other deliberate exception is a
# failed baseline reset — that means git itself is in an untrustworthy state,
# which endangers every author's data, so it stops the whole run.
#
# ------------------------------------------------------------- EXIT CODES
#
# The SCRAPER's contract is unchanged and is still interpreted per author by
# pipeline_classify(): 0 complete, 10 partial, 20 auth wall, 21 profile
# locked, 22 rate-limited, 23 fs failure, 30 selector drift, anything else
# unknown. Each author gets its own independent verdict from those codes.
#
# THIS WRAPPER's own exit code keeps its pre-existing 2-value contract, because
# the workflow and the publish gate read it that way — what changed is only how
# the value is DERIVED from the set of authors:
#   0  every author was accepted (complete, or exit-10 partial that passed
#      coverage_ok, healed or not) AND wrote data. The PR is the review
#      surface; main_updated=true only on the all-clean-no-heal path.
#   1  at least one author failed, aborted, produced invalid JSON or produced
#      no changes at all — red, so a silently missed author is visible. The
#      other authors' data is still committed to the PR first.
# Aggregation is deliberately worst-wins (no "mostly green"): a week of data
# that cannot be backfilled is missing for someone, and that must be loud.
# For diagnosis only, the per-author scraper exit codes and a single WORST
# headline code (severity order 20 > 23 > 30 > 22 > 21 > other > 10 > 0) are
# recorded in the incident doc and the Slack bookend — they never become this
# script's exit status.
#
# Test hooks (all default to production values): FAST_DIR, MAX_ATTEMPTS,
# MAX_HEALS, DEADLINE_SECS, HEAL_TIMEOUT_SECS, HEAL_CUTOFF_SECS,
# REVIEW_TIMEOUT_SECS, RATE_LIMIT_SLEEP_SECS, CLAUDE_BIN, PROFILES_FILE,
# LI_AUTHORS (space/comma-separated subset of profiles.json keys),
# LI_BACKEND, AUTHOR_GAP_SECS, and DRY_RUN=1 (skip branch checkout and the
# commit/PR chain). NOTE: bookends still post unless CLAUDE_BIN points at a
# stub — the offline harness always stubs it.
set -euo pipefail

# Re-exec from a detached copy so a heal session may safely edit the tracked
# run-weekly.sh (bash reads its script file incrementally — editing the
# executing file corrupts the run; the copy is never edited). Such edits are
# still unverified until the next fire — the incident doc must say so.
# Detection is $0-based (not an env var): a nested invocation of the tracked
# script gets its own copy and its EXIT trap can only remove that own copy.
# The minimal trap here covers a failed lib source; on_exit takes over below.
case "$0" in
  */run-weekly-exec-*.sh)
    trap 'rm -f "$0"' EXIT
    ;;
  *)
    mkdir -p tmp
    cp "$0" "tmp/run-weekly-exec-$$.sh"
    exec bash "tmp/run-weekly-exec-$$.sh" "$@"
    ;;
esac

SKILL_DIR=".claude/skills/linkedin-stats"
SHARED_DIR=".claude/skills/pipeline-shared"
. "$SHARED_DIR/lib.sh"

MAX_ATTEMPTS="${MAX_ATTEMPTS:-5}"
# Heals are effectively bounded by MAX_ATTEMPTS and Monday runs may take
# hours, so the budget/cutoff guards stay out of the way (pre-lib parity).
# With several authors the budget is shared across the whole fire.
MAX_HEALS="${MAX_HEALS:-99}"
HEAL_CUTOFF_SECS="${HEAL_CUTOFF_SECS:-999999}"
DEADLINE_SECS="${DEADLINE_SECS:-1500}"
HEAL_TIMEOUT_SECS="${HEAL_TIMEOUT_SECS:-4500}"
REVIEW_TIMEOUT_SECS="${REVIEW_TIMEOUT_SECS:-1500}"
RATE_LIMIT_SLEEP_SECS="${RATE_LIMIT_SLEEP_SECS:-1200}"
LOCK_RETRY_SLEEP_SECS="${LOCK_RETRY_SLEEP_SECS:-60}"
HARD_CAP_EXTRA_SECS="${HARD_CAP_EXTRA_SECS:-600}"
FAST_DIR="${FAST_DIR:-.claude/skills/linkedin-stats/fast}"
DRY_RUN="${DRY_RUN:-0}"

# ----------------------------------------------------------- multi-profile
PROFILES_FILE="${PROFILES_FILE:-$SKILL_DIR/profiles.json}"
# Remote browser by default — that is what makes ubuntu-latest sufficient.
# Overridable so a local-Chrome debug run still works unchanged.
LI_BACKEND="${LI_BACKEND:-browserbase}"
export LI_BACKEND
# merge.py performs EVERY dashboards/li-stats write and opens its files with no
# explicit encoding=, so it inherits the process locale. The corpus is
# Cyrillic-heavy (Ukrainian/Russian post bodies): under a C/POSIX locale that is
# a UnicodeEncodeError, which the scraper reports as reason FS -> exit 23 -> a
# lost week. PEP 540 UTF-8 mode makes the write locale-independent instead of
# relying on the runner happening to set LANG=C.UTF-8.
export PYTHONUTF8=1
# Test hook: restrict the fire to a subset ("peter", "peter oleksandr",
# "peter,oleksandr"). Empty = every author in profiles.json.
AUTHOR_FILTER="${LI_AUTHORS:-}"
# Breathing room between two authors' cloud sessions. Accounts have separate
# 429 budgets, but back-to-back full scrapes from the same project are the
# kind of pattern worth not looking like. 0 disables.
AUTHOR_GAP_SECS="${AUTHOR_GAP_SECS:-60}"

# ISO-Monday of the CURRENT week, computed identically on BSD and GNU date.
# Do NOT go back to `date -v-Mon` / `date -d "last monday"`: those two idioms
# DISAGREE on a Monday (GNU jumps to the previous Monday) — which is exactly
# when the cron fires — and the scraper's own isoWeekMonday() is
# Monday-inclusive. The weekday-offset form below matches the scraper on
# every day of the week on both platforms.
WEEK_DOW=$(date -u +%u)   # 1=Mon … 7=Sun
WEEK=$(date -u -v-$((WEEK_DOW - 1))d "+%Y-%m-%d" 2>/dev/null \
  || date -u -d "-$((WEEK_DOW - 1)) days" "+%Y-%m-%d")
BRANCH="chore/linkedin-stats-${WEEK}"
TODAY=$(date -u +%Y-%m-%d)
INCIDENT_FILE="doc/incidents/${TODAY}-linkedin-stats-weekly.md"
HEAL_ROOT="tmp/self-heal/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$HEAL_ROOT"

PL_LOG_PREFIX="run-weekly"
PL_PIPELINE_NAME="linkedin-stats-weekly"
PL_HEAL_ROOT="$HEAL_ROOT"
PL_INCIDENT_FILE="$INCIDENT_FILE"
PL_MAX_ATTEMPTS="$MAX_ATTEMPTS"
PL_MAX_HEALS="$MAX_HEALS"
PL_HEAL_TIMEOUT_SECS="$HEAL_TIMEOUT_SECS"
PL_HEAL_CUTOFF_SECS="$HEAL_CUTOFF_SECS"
PL_HEAL_ROLE="stats-heal"
PL_SLACK_CHANNEL_ID="${SLACK_CHANNEL_ID:-}"
PL_SESSION_NOTES=()

# ----------------------------------------------------------- slack bookends
# Finish-message state, updated as the run progresses; read by the EXIT trap.
RUN_STAGE="preflight"        # preflight | scrape | commit | done
RUN_ERRORS=""                # accumulated one-line failure notes
PR_URL=""
MERGED=0
FINISH_POSTED=0

# Per-author records, appended as each author finishes. Parallel indexed
# arrays (bash 3.2 has no associative arrays — see lib.sh's header). Declared
# BEFORE the EXIT trap: on_exit reads them and must never meet an unset name
# under `set -u`, and every expansion below is ${#...}-guarded for the same
# reason (bash 3.2 errors on "${empty[@]}").
AUTHORS=()               # slugs actually scraped, in order
A_STATUS=()              # ok | partial | healed | healed_partial
                         # | failed | aborted | nodata | badjson
A_EXIT=()                # that author's final scraper exit code
A_ATTEMPTS=()            # attempts used
A_HEALS=()               # heal sessions spent on THIS author
A_LOG=()                 # final attempt log (for the review session)
A_LINE=()                # one composed human line, for Slack + incident
A_ABORT=()               # heal ABORT reason, snapshotted per author
RUN_ATTEMPT_LINES=()     # author-prefixed attempt summaries, for the incident
RUN_SESSION_NOTES=()     # author-prefixed PL_SESSION_NOTES, for the incident
WORST_EXIT=0             # headline scraper code across authors (diagnosis only)
CURRENT_AUTHOR=""        # author in flight, for an early-death bookend

# Single EXIT trap: detached-copy self-delete + the finish bookend, on EVERY
# exit path (explicit exit N, set -e aborts, and — via TERM/INT traps —
# signals). Mirrors run-hourly.sh's pinned trap shape: no exit inside the
# trap, so the original status is preserved.
on_exit() {
    local ec=$?
    trap - EXIT
    set +e            # set -e stays live inside traps — an unguarded failure
                      # here would eat the message AND replace the exit code
    # rm before the network call: a hung Slack post must not leak the copy.
    case "$0" in */run-weekly-exec-*.sh) rm -f "$0";; esac
    [ "$FINISH_POSTED" = 1 ] && return 0
    FINISH_POSTED=1
    local dur="$((SECONDS / 60))m$((SECONDS % 60))s"

    # Per-author detail lines (composed as each author finished). If the run
    # died before ANY author finished, fall back to the same counter greps
    # over whatever attempt log the lib last pointed at, so an early death
    # still reports what it managed to measure.
    local detail="" done_n=0 ok_n=0 bad_n=0 healed_any=0 partial_any=0 i=0
    if [ "${#AUTHORS[@]}" -gt 0 ]; then
        done_n=${#AUTHORS[@]}
        while [ "$i" -lt "$done_n" ]; do
            detail="${detail}
• ${A_LINE[$i]}"
            case "${A_STATUS[$i]}" in
                ok)                    ok_n=$((ok_n + 1));;
                partial)               ok_n=$((ok_n + 1)); partial_any=1;;
                healed)                ok_n=$((ok_n + 1)); healed_any=1;;
                healed_partial)        ok_n=$((ok_n + 1)); healed_any=1; partial_any=1;;
                *)                     bad_n=$((bad_n + 1));;
            esac
            i=$((i + 1))
        done
    else
        local measured="" failed="" followers=""
        if [ -n "${PL_ATTEMPT_LOG:-}" ] && [ -f "${PL_ATTEMPT_LOG:-}" ]; then
            measured=$(grep -Eo 'POSTS_MEASURED=[0-9]+' "$PL_ATTEMPT_LOG" 2>/dev/null | tail -1 | cut -d= -f2)
            failed=$(grep -Eo 'POSTS_FAILED=[0-9]+' "$PL_ATTEMPT_LOG" 2>/dev/null | tail -1 | cut -d= -f2)
            followers=$(grep -Eo 'FOLLOWERS=[0-9]+' "$PL_ATTEMPT_LOG" 2>/dev/null | tail -1 | cut -d= -f2)
        fi
        detail=""
        [ -n "$measured" ] && detail="${detail}
• ${CURRENT_AUTHOR:-?} (in flight): ${measured} posts measured / ${failed:-?} failed"
        [ -n "$followers" ] && detail="${detail}, followers ${followers}"
    fi

    local summary="week ${WEEK}, ${ok_n}/${done_n:-0} author(s) accepted"
    [ "$WORST_EXIT" -ne 0 ] && summary="${summary}, worst scraper exit ${WORST_EXIT}"
    [ -n "$PR_URL" ] && summary="${summary} — PR: ${PR_URL}"

    local msg
    if [ "$ec" -eq 0 ]; then
        if [ "$MERGED" = 1 ]; then
            msg="✅ linkedin-stats-weekly: scrape finished in ${dur} — ${summary}; merged to main"
        else
            local kind="accepted partial"
            if [ "$healed_any" = 1 ] && [ "$partial_any" = 1 ]; then
                kind="recovered (accepted partial)"
            elif [ "$healed_any" = 1 ]; then
                kind="recovered after self-heal"
            fi
            msg="⚠️ linkedin-stats-weekly: ${kind} in ${dur} — ${summary}; PR left open for review (${INCIDENT_FILE})"
        fi
    else
        local why="${RUN_ERRORS:-failed during ${RUN_STAGE}}"
        case "$ec" in
            (143) why="terminated (SIGTERM) during ${RUN_STAGE}${RUN_ERRORS:+ — ${RUN_ERRORS}}";;
            (130) why="interrupted (SIGINT) during ${RUN_STAGE}${RUN_ERRORS:+ — ${RUN_ERRORS}}";;
        esac
        [ "$bad_n" -gt 0 ] && summary="${summary}, ${bad_n} author(s) NOT collected"
        msg="❌ linkedin-stats-weekly: run failed in ${dur} — $(pl_oneline "$why"); ${summary} (exit ${ec})"
    fi
    [ "$DRY_RUN" = 1 ] && msg="${msg} [DRY_RUN]"
    pl_post_slack "${msg}${detail}"
}
trap on_exit EXIT
trap 'exit 143' TERM
trap 'exit 130' INT

pl_post_slack "🟢 linkedin-stats-weekly: run started — $(date -u +%FT%TZ)"

pl_require_cmds claude node npm gh git jq
pl_codex_available

# Only the auto-merge path updates main; the workflow's publish job reads
# this to skip republishing stale main after a healed/partial run.
emit_output() {
  # Not best-effort: silently losing main_updated=true would merge main but
  # skip the publish job with no signal. set -e makes a failed write fatal.
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    echo "$1" >> "$GITHUB_OUTPUT"
  fi
}
# Deliberately NOT pre-seeded with "main_updated=false": an output that is
# never written reads as EMPTY, and the publish job gates on == 'true', so
# every non-merge path already fails safe. Writing false here and true later
# would make the gate depend on $GITHUB_OUTPUT duplicate-key precedence, which
# is undocumented — one write, on the one path that earns it.

# ------------------------------------------------------------ author roster
# Keys of profiles.json minus the "_"-prefixed metadata (e.g. "_note").
# jq's `keys` sorts, so the order is deterministic across fires — a run that
# dies halfway always got through the same prefix of the roster.
if [ ! -f "$PROFILES_FILE" ]; then
  echo "run-weekly: $PROFILES_FILE missing from this checkout; failing." >&2
  exit 1
fi
roster_raw=$(jq -r 'keys[] | select(startswith("_") | not)' "$PROFILES_FILE") || {
  echo "run-weekly: could not parse $PROFILES_FILE; failing." >&2
  exit 1
}
while IFS= read -r slug; do
  [ -n "$slug" ] || continue
  # The slug becomes a PATH COMPONENT (dashboards/li-stats/<slug>/,
  # $HEAL_ROOT/<slug>/) and is interpolated into heal/Slack prompts. Anything
  # outside this alphabet is rejected rather than sanitised.
  case "$slug" in
    *[!A-Za-z0-9._-]*|.|..|-*)
      echo "run-weekly: refusing unsafe author key '$slug' in $PROFILES_FILE." >&2
      exit 1
      ;;
  esac
  if [ -n "$AUTHOR_FILTER" ]; then
    case " $(printf '%s' "$AUTHOR_FILTER" | tr ',' ' ') " in
      *" $slug "*) ;;
      *) continue ;;
    esac
  fi
  AUTHORS_TODO="${AUTHORS_TODO:-} $slug"
done <<ROSTER_EOF
$roster_raw
ROSTER_EOF
AUTHORS_TODO="${AUTHORS_TODO:-}"
if [ -z "${AUTHORS_TODO// /}" ]; then
  echo "run-weekly: no authors selected from $PROFILES_FILE (filter='${AUTHOR_FILTER}'); failing." >&2
  exit 1
fi
echo "run-weekly: authors this fire:${AUTHORS_TODO} (backend ${LI_BACKEND}, week ${WEEK})"

if [ "$DRY_RUN" != 1 ]; then
  git fetch origin main
  # A same-week rerun while the previous (healed, unmerged) PR is still open
  # must not collide with its branch.
  if git ls-remote --exit-code origin "refs/heads/$BRANCH" >/dev/null 2>&1; then
    BRANCH="${BRANCH}-$(date -u +%H%M%S)"
  fi
  git checkout -B "$BRANCH" origin/main
fi
# Immutable reset anchor for retries: `git checkout -- <path>` restores from
# the INDEX (which a heal session could have polluted), not from this commit.
BASE_SHA=$(git rev-parse HEAD)

if [ ! -f "$FAST_DIR/scrape-weekly.mjs" ]; then
  echo "run-weekly: $FAST_DIR/scrape-weekly.mjs missing from this checkout; failing." >&2
  exit 1
fi
# Backend preflight. LI_BACKEND=browserbase is the DEFAULT here, and the
# scraper then needs two API credentials plus the lifleet registry that maps
# author -> Browserbase context_id. That registry is gitignored
# (scripts/lifleet/.gitignore) — so it is ABSENT from every fresh clone and CI
# checkout, and browserbase-backend.mjs only discovers that inside the first
# navigation. Without this check a missing key or registry costs MAX_ATTEMPTS
# scrapes plus a heal session per author before anyone learns the file is not
# there. Fail here, in seconds, with the fix in the message.
if [ "$LI_BACKEND" = browserbase ]; then
  missing_env=""
  [ -n "${BROWSERBASE_API_KEY:-}" ]    || missing_env="${missing_env} BROWSERBASE_API_KEY"
  [ -n "${BROWSERBASE_PROJECT_ID:-}" ] || missing_env="${missing_env} BROWSERBASE_PROJECT_ID"
  if [ -n "$missing_env" ]; then
    echo "run-weekly: LI_BACKEND=browserbase but missing:${missing_env}" >&2
    echo "run-weekly: locally they live in scripts/lifleet/.env — source it before running;" >&2
    echo "run-weekly: in CI they are Actions secrets of the SAME two names." >&2
    exit 1
  fi
  # Registry path resolution is done in node so it matches
  # browserbase-backend.mjs's authorsPath() exactly (LIFLEET_AUTHORS /
  # LIFLEET_REGISTRY override, relative paths resolved against the lifleet
  # dir). Parse/lookup failures are reported WITHOUT echoing file contents —
  # the registry is a set of session credentials.
  if ! node -e '
    const fs = require("fs"), path = require("path");
    const lifleetDir = path.resolve("scripts/lifleet");
    const ov = process.env.LIFLEET_AUTHORS || process.env.LIFLEET_REGISTRY;
    const p = ov ? (path.isAbsolute(ov) ? ov : path.resolve(lifleetDir, ov))
                 : path.join(lifleetDir, "authors.json");
    let reg;
    try { reg = JSON.parse(fs.readFileSync(p, "utf8")); }
    catch (e) {
      console.error("lifleet registry unusable at " + p + " (" + (e.code || e.name) + ")");
      console.error("it is gitignored, so a fresh checkout has none: point LIFLEET_AUTHORS at one,");
      console.error("or run `lifleet import <slug> <cookies.json>` to create it.");
      process.exit(1);
    }
    const wanted = process.argv.slice(1);
    const missing = wanted.filter((a) => !reg[a]);
    const noCtx = wanted.filter((a) => reg[a] && !reg[a].context_id);
    if (missing.length) console.error("not in the lifleet registry: " + missing.join(", "));
    if (noCtx.length) console.error("no context_id (lifleet import <slug> <cookies.json>): " + noCtx.join(", "));
    if (missing.length || noCtx.length) process.exit(1);
    console.log("run-weekly: lifleet registry OK for " + wanted.length + " author(s)");
  ' $AUTHORS_TODO; then
    echo "run-weekly: browserbase preflight failed — not scraping." >&2
    exit 1
  fi
fi

pl_npm_ensure "$FAST_DIR"

# The scraper owns the data-path mapping; this is the ONE place the driver
# needs the same answer (baseline reset, JSON validation, change detection),
# so it is derived here once and nowhere else.
author_dir() { printf 'dashboards/li-stats/%s' "$1"; }

# Exit 10 keeps partial data, but the contract must show the run was healthy
# enough to accept: no phase-level ERROR (a dead posts/account/comments phase
# means a whole surface is missing however good the per-post counters look —
# the 2026-07-20 nav-slowdown runs died exactly there), POSTS_MEASURED > 0,
# and >=80% per-post coverage (measured >= 4x the failed+unprocessed rest).
# Unchanged by multi-author: it is handed ONE author's attempt log, which is
# what $PL_ATTEMPT_LOG now is (per-author $PL_HEAL_ROOT).
coverage_ok() {
  local log="$1" measured failed unprocessed
  if grep -q '^ERROR=' "$log"; then
    return 1
  fi
  measured=$(grep -Eo 'POSTS_MEASURED=[0-9]+' "$log" | tail -1 | cut -d= -f2)
  failed=$(grep -Eo 'POSTS_FAILED=[0-9]+' "$log" | tail -1 | cut -d= -f2)
  unprocessed=$(grep -Eo 'POSTS_UNPROCESSED=[0-9]+' "$log" | tail -1 | cut -d= -f2)
  [ -n "$measured" ] && [ "$measured" -gt 0 ] \
    && [ "$measured" -ge $(( 4 * ( ${failed:-0} + ${unprocessed:-0} ) )) ]
}

# The same three counter greps the finish bookend has always used, over ONE
# author's final attempt log. Every pipeline is `|| true`-guarded: `set -o
# pipefail` + `set -e` would otherwise abort the run on a no-match grep.
author_counters() {
  local log="$1" measured failed followers out=""
  [ -n "$log" ] && [ -f "$log" ] || { printf ''; return 0; }
  measured=$(grep -Eo 'POSTS_MEASURED=[0-9]+' "$log" 2>/dev/null | tail -1 | cut -d= -f2 || true)
  failed=$(grep -Eo 'POSTS_FAILED=[0-9]+' "$log" 2>/dev/null | tail -1 | cut -d= -f2 || true)
  followers=$(grep -Eo 'FOLLOWERS=[0-9]+' "$log" 2>/dev/null | tail -1 | cut -d= -f2 || true)
  [ -n "$measured" ] && out="${out}, ${measured} posts measured / ${failed:-?} failed"
  [ -n "$followers" ] && out="${out}, followers ${followers}"
  printf '%s' "$out"
}

# Severity rank for the headline WORST_EXIT (reporting only — never this
# script's exit status). 20 auth needs a human relogin and outranks
# everything; 10 is an accepted partial and outranks only a clean 0.
exit_rank() {
  case "$1" in
    20) printf 70 ;;
    23) printf 60 ;;
    30) printf 50 ;;
    22) printf 40 ;;
    21) printf 30 ;;
    0)  printf 0  ;;
    10) printf 10 ;;
    *)  printf 20 ;;
  esac
}
note_worst_exit() {
  [ "$(exit_rank "$1")" -gt "$(exit_rank "$WORST_EXIT")" ] && WORST_EXIT="$1"
  return 0
}

# ------------------------------------------------------------ strategy hooks
# All four hooks read $LI_AUTHOR (exported by run_one_author) and $PL_HEAL_ROOT
# (re-pointed per author), so they need no author parameter of their own.

# The body lives in its own function and is captured with a plain command
# substitution. Do NOT fold it back into `PL_HEAL_PROMPT=$(cat <<EOF ...)`:
# bash 3.2 mis-parses an apostrophe inside a heredoc that sits inside $( ),
# and this prompt is prose that will grow more of them.
heal_prompt_body() {
  cat <<EOF
You are the self-healing layer of the linkedin-stats weekly pipeline, invoked
headless by run-weekly.sh on a GitHub Actions runner after a failed scrape
attempt. Read ${SHARED_DIR}/references/self-heal-core.md first, then the
overlay at OVERLAY_FILE, and follow them exactly.
This fire scrapes several LinkedIn profiles sequentially, one per AUTHOR. You
were called for AUTHOR only. Its data lives in DATA_DIR and its identity in
PROFILES_FILE; do NOT touch the directory of any other author under
dashboards/li-stats/, and remember that a fix in ${FAST_DIR} applies to every
author scraped after this one.
Context:
PIPELINE_NAME=linkedin-stats-weekly
OVERLAY_FILE=${SKILL_DIR}/references/self-heal.md
WRAPPER=${SKILL_DIR}/run-weekly.sh
AUTHOR=${LI_AUTHOR}
DATA_DIR=$(author_dir "$LI_AUTHOR")
PROFILES_FILE=${PROFILES_FILE}
LI_BACKEND=${LI_BACKEND}
ATTEMPT=${PL_ATTEMPT}/${MAX_ATTEMPTS}
HEAL_COUNT=${PL_HEAL_COUNT}
EXIT_CODE=${PL_ATTEMPT_EXIT}
LOG_FILE=${PL_ATTEMPT_LOG}
HEAL_DIR=${PL_HEAL_ROOT}
INCIDENT_FILE=${INCIDENT_FILE}
CODEX_AVAILABLE=${PL_CODEX_AVAILABLE}
WEEK=${WEEK}
FAST_DIR=${FAST_DIR}
EOF
}

pipeline_heal_prompt() {
  PL_HEAL_PROMPT=$(heal_prompt_body)
}

# review_prompt <author> <attempts> <heals> <final-exit> <final-log> <heal-dir>
# Takes the author's snapshot explicitly: the critique sessions run after the
# whole roster is done, when the live PL_* state belongs to the LAST author.
review_prompt() {
  local r_author="$1" r_attempts="$2" r_heals="$3" r_exit="$4" r_log="$5" r_dir="$6"
  local acceptance="complete"
  [ "$r_exit" -eq 10 ] && acceptance="accepted_partial"
  cat <<EOF
You are the review layer of the linkedin-stats weekly pipeline. Heal
sessions ran and the outer acceptance gate accepted the final scrape attempt
for AUTHOR (see FINAL_ACCEPTANCE — "accepted_partial" means exit 10 with
gaps, NOT a full success; describe it accordingly). Read
${SHARED_DIR}/references/self-heal-review-core.md first, then the overlay at
OVERLAY_FILE, and follow them exactly. This session is READ-ONLY for code:
critique goes into the incident doc, not into files under version control
other than ${INCIDENT_FILE} and CLAUDE.md.
Context:
PIPELINE_NAME=linkedin-stats-weekly
OVERLAY_FILE=${SKILL_DIR}/references/self-heal-review.md
WRAPPER=${SKILL_DIR}/run-weekly.sh
AUTHOR=${r_author}
DATA_DIR=$(author_dir "$r_author")
ATTEMPTS_USED=${r_attempts}
HEAL_COUNT=${r_heals}
FINAL_EXIT_CODE=${r_exit}
FINAL_ACCEPTANCE=${acceptance}
FINAL_LOG_FILE=${r_log}
HEAL_DIR=${r_dir}
INCIDENT_FILE=${INCIDENT_FILE}
CODEX_AVAILABLE=${PL_CODEX_AVAILABLE}
WEEK=${WEEK}
FAST_DIR=${FAST_DIR}
EOF
}

pipeline_reset_baseline() {
  # Retries start from the committed baseline: never hand review a hybrid
  # of partial writes produced by different attempts/code versions. Restore
  # from the immutable BASE_SHA (the index is not trustworthy after a heal
  # session) and fail LOUD — silently scraping on top of mutated data is
  # exactly the hybrid this reset exists to prevent.
  # SCOPED TO THE CURRENT AUTHOR: resetting the whole dashboards/li-stats/
  # tree would throw away the finished data of every author scraped earlier
  # in this fire.
  local dir
  dir=$(author_dir "$LI_AUTHOR")
  if git rev-parse --verify -q "${BASE_SHA}:${dir}" >/dev/null 2>&1; then
    git checkout -q "$BASE_SHA" -- "$dir"
  else
    # A brand-new author has no committed baseline: "reset" means discard
    # everything this fire wrote for them.
    rm -rf "$dir"
  fi
  git clean -qfd "$dir" 2>/dev/null || true
  if [ -n "$(git status --porcelain -- "$dir" 2>/dev/null)" ]; then
    # git itself is untrustworthy now, which endangers EVERY author's data —
    # the one condition that stops the whole fire rather than one author.
    echo "run-weekly: ${dir} did not reset cleanly to ${BASE_SHA} — aborting the run." >&2
    RUN_ERRORS="${RUN_ERRORS:+${RUN_ERRORS}; }${LI_AUTHOR}: baseline reset failed"
    exit 1
  fi
}

pipeline_run_attempt() {
  # Marker under the PER-AUTHOR heal root: a shared path would let author N's
  # stale timeout marker make author N+1's first attempt look watchdog-killed.
  local marker="$PL_HEAL_ROOT/timeout-scrape-${PL_ATTEMPT}" pid wd attempt_start
  attempt_start=$SECONDS
  echo "run-weekly: [${LI_AUTHOR}] scrape attempt ${PL_ATTEMPT}/${MAX_ATTEMPTS} starting ($(date -u +%H:%M:%SZ))"
  # LI_AUTHOR/LI_BACKEND reach the scraper through the exported environment
  # (see run_one_author); the scraper resolves identity and data dir from them.
  # The scraper's --deadline is soft (checked between navigations); a hung
  # browser sails past it. The killer is the hard cap.
  set +e
  (
    node "$FAST_DIR/scrape-weekly.mjs" --deadline-secs="$DEADLINE_SECS" --week="$WEEK" 2>&1 | tee "$PL_ATTEMPT_LOG"
    exit "${PIPESTATUS[0]}"
  ) &
  pid=$!
  pl_spawn_killer "$(( DEADLINE_SECS + HARD_CAP_EXTRA_SECS ))" "$pid" "scraper (${LI_AUTHOR} attempt ${PL_ATTEMPT})" "$marker"
  wd=$!
  pl_await_target "$pid" "$wd" "$marker"
  PL_ATTEMPT_EXIT=$?
  set -e
  local timed_out_note=""
  [ -f "$marker" ] && timed_out_note=", KILLED at hard cap"
  attempt_summaries+=("[${LI_AUTHOR}] attempt ${PL_ATTEMPT}: exit ${PL_ATTEMPT_EXIT}, $(( SECONDS - attempt_start ))s${timed_out_note}")
  echo "run-weekly: [${LI_AUTHOR}] attempt ${PL_ATTEMPT} exited ${PL_ATTEMPT_EXIT} ($(date -u +%H:%M:%SZ))"
}

pipeline_classify() {
  [ "$PL_ATTEMPT_EXIT" -ne 22 ] && consecutive_rate=0
  [ "$PL_ATTEMPT_EXIT" -ne 21 ] && consecutive_lock=0
  case "$PL_ATTEMPT_EXIT" in
    0)
      PL_VERDICT=accept
      ;;
    10)
      if coverage_ok "$PL_ATTEMPT_LOG"; then
        echo "run-weekly: [${LI_AUTHOR}] partial with acceptable coverage — keeping it (PR will stay unmerged)."
        PL_VERDICT=accept_partial
      else
        PL_VERDICT=heal
      fi
      ;;
    22)
      consecutive_rate=$((consecutive_rate + 1))
      if [ "$consecutive_rate" -ge 2 ]; then
        # A second 429 after a 20-min cool-down is not a pacing bug to fix
        # mid-run — it can be an account-level restriction. Stop poking.
        # THIS AUTHOR only: another account has its own budget.
        echo "run-weekly: [${LI_AUTHOR}] second consecutive rate-limit — stopping this author's loop." >&2
        RUN_ERRORS="${RUN_ERRORS:+${RUN_ERRORS}; }${LI_AUTHOR}: second consecutive rate-limit"
        PL_VERDICT=fail
      else
        echo "run-weekly: [${LI_AUTHOR}] rate-limited — sleeping ${RATE_LIMIT_SLEEP_SECS}s before the next attempt."
        PL_VERDICT=retry
        PL_RETRY_SECS="$RATE_LIMIT_SLEEP_SECS"
      fi
      ;;
    21)
      consecutive_lock=$((consecutive_lock + 1))
      if [ "$consecutive_lock" -ge 2 ]; then
        # The sweep didn't free the profile — something is actively holding
        # it; that needs diagnosis, not another blind pkill.
        PL_VERDICT=heal
      else
        echo "run-weekly: [${LI_AUTHOR}] profile locked — sweeping orphaned Chrome and retrying in ${LOCK_RETRY_SLEEP_SECS}s."
        PL_VERDICT=retry
        PL_RETRY_SECS="$LOCK_RETRY_SLEEP_SECS"
        PL_RETRY_SWEEP=1
      fi
      ;;
    *)
      PL_VERDICT=heal
      ;;
  esac
}

# ---------------------------------------------------------------- per author
# One author's complete run: attempt loop, JSON validation and change check,
# then a status record. NEVER returns non-zero for a scrape failure — a bad
# author must not trip this script's errexit and cost the rest the fire.
run_one_author() {
  local slug="$1" dir heals_before a_ok a_exit a_attempts a_heals a_log
  local a_status invalid_json f counters a_abort=""
  dir=$(author_dir "$slug")
  CURRENT_AUTHOR="$slug"

  # The scraper reads BOTH from the environment; exporting (rather than
  # prefixing the node call) also lets the heal session inherit the identity
  # of the author it was called for.
  LI_AUTHOR="$slug"
  export LI_AUTHOR

  # Per-author scratch: attempt logs, watchdog markers and the heal ABORT
  # file. Re-pointing PL_HEAL_ROOT is what isolates one author's heal
  # sessions from the next author's loop.
  PL_HEAL_ROOT="$HEAL_ROOT/$slug"
  mkdir -p "$PL_HEAL_ROOT"

  # Driver-owned counters the hooks mutate — reset so author N+1 does not
  # inherit author N's consecutive-failure state or attempt list.
  attempt_summaries=()
  consecutive_rate=0
  consecutive_lock=0
  PL_SESSION_NOTES=()
  # PL_HEALED persists across pl_attempt_loop calls by design (lib uses
  # ${PL_HEALED:-0}); reset it so "did THIS author heal" stays true. The heal
  # BUDGET (PL_HEAL_COUNT) is deliberately left cumulative — MAX_HEALS bounds
  # the whole fire — and per-author attribution is taken as the delta.
  PL_HEALED=0
  heals_before=${PL_HEAL_COUNT:-0}

  echo "run-weekly: ===== author ${slug} starting ($(date -u +%H:%M:%SZ)) ====="
  pl_attempt_loop

  a_ok=$PL_OK
  a_exit=$PL_ATTEMPT_EXIT
  a_attempts=$PL_ATTEMPT
  a_heals=$(( ${PL_HEAL_COUNT:-0} - heals_before ))
  a_log="${PL_ATTEMPT_LOG:-}"
  a_status=""

  # A kill/deadline can land mid-write; never commit a truncated snapshot.
  # Always revert the corrupt file (the PR must stay parseable), and demote
  # this AUTHOR to failed — an author that silently discarded one of its
  # outputs must not be called clean, partial, or recovered.
  invalid_json=0
  if [ -d "$dir" ]; then
    while IFS= read -r -d '' f; do
      if ! jq empty "$f" 2>/dev/null; then
        invalid_json=1
        git checkout -- "$f" 2>/dev/null || rm -f "$f"
        echo "run-weekly: [${slug}] $f was not valid JSON — reverted." >&2
        PL_SESSION_NOTES+=("invalid JSON reverted: $f")
      fi
    done < <(find "$dir" -name '*.json' -print0)
  fi
  if [ "$invalid_json" -eq 1 ] && [ "$a_ok" -eq 1 ]; then
    echo "run-weekly: [${slug}] truncated snapshot detected — demoting to UNRESOLVED." >&2
    a_ok=0
    a_status=badjson
    RUN_ERRORS="${RUN_ERRORS:+${RUN_ERRORS}; }${slug}: invalid JSON reverted"
  fi

  # git diff --quiet only sees TRACKED changes; new posts create untracked
  # JSON files, so use git status --porcelain. A weekly run must at minimum
  # add a weeks[WEEK] entry to that author's account.json — "no changes"
  # means the scrape produced nothing for them, so it is not a success.
  if [ "$a_ok" -eq 1 ] && [ -z "$(git status --porcelain -- "$dir" 2>/dev/null)" ]; then
    echo "run-weekly: [${slug}] no changes under ${dir} after an accepted scrape — treating as failed." >&2
    a_ok=0
    a_status=nodata
    RUN_ERRORS="${RUN_ERRORS:+${RUN_ERRORS}; }${slug}: scrape wrote no data"
  fi

  if [ -z "$a_status" ]; then
    if [ "$a_ok" -eq 1 ]; then
      if [ "$a_heals" -gt 0 ]; then
        if [ "$a_exit" -eq 0 ]; then a_status=healed; else a_status=healed_partial; fi
      else
        if [ "$a_exit" -eq 0 ]; then a_status=ok; else a_status=partial; fi
      fi
    elif [ "${PL_ABORTED:-0}" -eq 1 ]; then
      a_status=aborted
      a_abort=$(pl_oneline "${PL_ABORT_REASON:-see heal dir}")
      RUN_ERRORS="${RUN_ERRORS:+${RUN_ERRORS}; }${slug}: heal aborted — ${a_abort}"
    else
      a_status=failed
      RUN_ERRORS="${RUN_ERRORS:+${RUN_ERRORS}; }${slug}: unresolved after ${a_attempts} attempt(s), last exit ${a_exit}"
    fi
  fi

  note_worst_exit "$a_exit"

  counters=$(author_counters "$a_log")
  AUTHORS+=("$slug")
  A_STATUS+=("$a_status")
  A_EXIT+=("$a_exit")
  A_ATTEMPTS+=("$a_attempts")
  A_HEALS+=("$a_heals")
  A_LOG+=("$a_log")
  A_ABORT+=("$a_abort")
  A_LINE+=("${slug}: ${a_status} (last exit ${a_exit}) — ${a_attempts} attempt(s), ${a_heals} heal(s)${counters}")

  if [ "${#attempt_summaries[@]}" -gt 0 ]; then
    RUN_ATTEMPT_LINES+=("${attempt_summaries[@]}")
  fi
  if [ "${#PL_SESSION_NOTES[@]}" -gt 0 ]; then
    for f in "${PL_SESSION_NOTES[@]}"; do
      RUN_SESSION_NOTES+=("[${slug}] ${f}")
    done
  fi

  echo "run-weekly: ===== author ${slug} done: ${a_status} ($(date -u +%H:%M:%SZ)) ====="
  return 0
}

# ---------------------------------------------------------------- scrape loop
# Sequential and isolated. TWO independent mechanisms keep one author from
# costing the others their week:
#
#  1. By construction — pl_attempt_loop ALWAYS returns 0 and expresses a
#     failed author as PL_OK=0, and every hook returns 0 too. A failing
#     scrape is data, not a shell error.
#  2. `if ! run_one_author ...` — calling it in an if-condition suppresses
#     errexit for the WHOLE function body, durably. This is deliberately not
#     written as `set +e; run_one_author; set -e`: pipeline_run_attempt does
#     its own `set +e ... set -e` around the watchdog wait, and that inner
#     `set -e` re-arms errexit for the rest of the author (verified on bash
#     3.2), which would silently undo the isolation. The if-condition form is
#     immune to that.
#
# The price of (2) is that an unexpected failure inside run_one_author no
# longer aborts — so every step in there checks its own result explicitly, and
# a non-zero return still gets recorded below instead of vanishing. The ONE
# deliberate whole-fire stop is pipeline_reset_baseline's `exit 1` (see its
# comment): `exit` is unaffected by errexit suppression.

attempt_summaries=()
consecutive_rate=0
consecutive_lock=0
RUN_STAGE="scrape"

first_author=1
for slug in $AUTHORS_TODO; do
  if [ "$first_author" -eq 0 ] && [ "${AUTHOR_GAP_SECS:-0}" -gt 0 ] 2>/dev/null; then
    echo "run-weekly: pausing ${AUTHOR_GAP_SECS}s before the next author."
    sleep "$AUTHOR_GAP_SECS"
  fi
  first_author=0
  if ! run_one_author "$slug"; then
    # Cannot happen today (run_one_author ends in `return 0`), but a heal
    # session may edit this file: record it rather than lose the author.
    case " ${AUTHORS[*]:-} " in
      *" $slug "*) ;;
      *)
        echo "run-weekly: [${slug}] run_one_author returned non-zero — recording as failed." >&2
        RUN_ERRORS="${RUN_ERRORS:+${RUN_ERRORS}; }${slug}: driver error in run_one_author"
        AUTHORS+=("$slug"); A_STATUS+=("failed"); A_EXIT+=("1")
        A_ATTEMPTS+=("0"); A_HEALS+=("0"); A_LOG+=(""); A_ABORT+=("")
        A_LINE+=("${slug}: failed (driver error in run_one_author)")
        ;;
    esac
  fi
done
CURRENT_AUTHOR=""

# --------------------------------------------------------------- aggregate
# Worst-wins over the whole roster (see the EXIT CODES block in the header).
RUN_STAGE="commit"

run_ok=1          # every author accepted (complete or accepted-partial)
merge_ok=1        # every author was a no-heal exit-0 with real changes
healed_any=0
idx=0
while [ "$idx" -lt "${#AUTHORS[@]}" ]; do
  case "${A_STATUS[$idx]}" in
    ok)                        ;;
    partial)                   merge_ok=0 ;;
    healed|healed_partial)     merge_ok=0; healed_any=1 ;;
    *)                         merge_ok=0; run_ok=0 ;;
  esac
  idx=$((idx + 1))
done
if [ "${#AUTHORS[@]}" -eq 0 ]; then
  run_ok=0
  merge_ok=0
fi

# Auto-merge ONLY the boring case: EVERY author a first-grade success with no
# healing. A healed run's fix and an accepted partial's gaps both deserve
# human eyes — and a permanent regression must not quietly auto-merge partial
# data every Monday (that's how 2026-07-20 would have looked with a laxer
# gate). One bad author is enough to hold the whole PR for review: the authors
# share one branch, one commit and one PR.
if [ "$merge_ok" -eq 1 ]; then
  if [ "$DRY_RUN" = 1 ]; then
    echo "run-weekly: DRY_RUN — would commit + PR + merge (${#AUTHORS[@]} author(s) clean)."
    MERGED=1
    RUN_STAGE="done"
    exit 0
  fi
  ./.claude/skills/common-pr-commit/commit.sh
  ./.claude/skills/common-pr-update/pr-update.sh
  PR_URL=$(gh pr view "$BRANCH" --json url -q .url 2>/dev/null || true)
  ./.claude/skills/common-pr-merge/merge.sh
  emit_output "main_updated=true"
  MERGED=1
  RUN_STAGE="done"
  exit 0
fi

# Healed / partial / failed path: finish the incident doc, link it from
# CLAUDE.md, optionally run the read-only critiques, then commit + PR WITHOUT
# merging.
# mkdir must precede the block: bash opens the >> target before running it,
# and a redirect failure on a compound command does NOT trip set -e — the
# incident would silently never be written.
mkdir -p "$(dirname "$INCIDENT_FILE")"
{
  if [ ! -f "$INCIDENT_FILE" ]; then
    printf '# %s — linkedin-stats weekly scrape incident\n' "$TODAY"
  fi
  printf '\n## Run summary — %s\n' "$(date -u +%FT%TZ)"
  printf -- '- week: %s, backend: %s, authors:%s\n' "$WEEK" "$LI_BACKEND" "$AUTHORS_TODO"
  printf -- '- worst scraper exit across authors: %s\n' "$WORST_EXIT"
  if [ "${#RUN_ATTEMPT_LINES[@]}" -gt 0 ]; then
    printf -- '- %s\n' "${RUN_ATTEMPT_LINES[@]}"
  fi
  if [ "${#RUN_SESSION_NOTES[@]}" -gt 0 ]; then
    printf -- '- note: %s\n' "${RUN_SESSION_NOTES[@]}"
  fi
  idx=0
  while [ "$idx" -lt "${#AUTHORS[@]}" ]; do
    case "${A_STATUS[$idx]}" in
      ok)
        printf -- '- outcome[%s]: OK — clean exit 0 in %s attempt(s)\n' \
          "${AUTHORS[$idx]}" "${A_ATTEMPTS[$idx]}" ;;
      partial)
        printf -- '- outcome[%s]: PARTIAL — exit 10 accepted with reduced coverage; PR left unmerged for review\n' \
          "${AUTHORS[$idx]}" ;;
      healed)
        printf -- '- outcome[%s]: RECOVERED — outer gate accepted attempt %s (full success) after %s heal session(s); PR left unmerged for review\n' \
          "${AUTHORS[$idx]}" "${A_ATTEMPTS[$idx]}" "${A_HEALS[$idx]}" ;;
      healed_partial)
        printf -- '- outcome[%s]: RECOVERED — outer gate accepted attempt %s (accepted partial, exit 10) after %s heal session(s); PR left unmerged for review\n' \
          "${AUTHORS[$idx]}" "${A_ATTEMPTS[$idx]}" "${A_HEALS[$idx]}" ;;
      aborted)
        printf -- '- outcome[%s]: ABORTED by heal session — %s\n' \
          "${AUTHORS[$idx]}" "${A_ABORT[$idx]:-see heal dir}" ;;
      nodata)
        printf -- '- outcome[%s]: NO DATA — the scrape was accepted but wrote nothing under %s\n' \
          "${AUTHORS[$idx]}" "$(author_dir "${AUTHORS[$idx]}")" ;;
      badjson)
        printf -- '- outcome[%s]: UNRESOLVED — a truncated snapshot was reverted; run demoted\n' \
          "${AUTHORS[$idx]}" ;;
      *)
        printf -- '- outcome[%s]: UNRESOLVED — stopped after %s of %s attempts (last exit %s)\n' \
          "${AUTHORS[$idx]}" "${A_ATTEMPTS[$idx]}" "$MAX_ATTEMPTS" "${A_EXIT[$idx]}" ;;
    esac
    idx=$((idx + 1))
  done
  # Authors that never got a turn (a fatal reset, or a signal mid-roster).
  for slug in $AUTHORS_TODO; do
    case " ${AUTHORS[*]:-} " in
      *" $slug "*) ;;
      *) printf -- '- outcome[%s]: NOT RUN — the fire stopped before this author\n' "$slug" ;;
    esac
  done
} >> "$INCIDENT_FILE"

accepted=0
idx=0
while [ "$idx" -lt "${#AUTHORS[@]}" ]; do
  case "${A_STATUS[$idx]}" in
    ok|partial|healed|healed_partial) accepted=$((accepted + 1)) ;;
  esac
  idx=$((idx + 1))
done
if [ "$run_ok" -eq 1 ] && [ "$healed_any" -eq 1 ]; then
  outcome="recovered — ${accepted}/${#AUTHORS[@]} author(s) accepted after healing, PR review pending"
elif [ "$run_ok" -eq 1 ]; then
  outcome="partial coverage accepted for ${accepted}/${#AUTHORS[@]} author(s), PR review pending"
else
  outcome="UNRESOLVED — only ${accepted}/${#AUTHORS[@]} author(s) accepted (worst scraper exit ${WORST_EXIT})"
fi
pl_link_incident_in_claude_md "- ${TODAY} — weekly scrape: ${outcome} — [${INCIDENT_FILE}](${INCIDENT_FILE})"

# One read-only critique per author that actually healed AND was accepted:
# the critique is about THAT heal, so it gets THAT author's snapshot.
idx=0
while [ "$idx" -lt "${#AUTHORS[@]}" ]; do
  case "${A_STATUS[$idx]}" in
    healed|healed_partial)
      echo "run-weekly: [${AUTHORS[$idx]}] rerun succeeded after healing — starting read-only critique session."
      # These sessions run AFTER the roster, when the exported LI_AUTHOR still
      # names the LAST author. review_prompt takes the right author explicitly,
      # but the environment must not contradict it: anything the session runs
      # would otherwise resolve identity and data dir for the wrong person.
      LI_AUTHOR="${AUTHORS[$idx]}"
      export LI_AUTHOR
      PL_HEAL_ROOT="$HEAL_ROOT/${AUTHORS[$idx]}"
      mkdir -p "$PL_HEAL_ROOT"
      pl_run_claude_with_watchdog "$REVIEW_TIMEOUT_SECS" stats-heal-review \
        "$(review_prompt "${AUTHORS[$idx]}" "${A_ATTEMPTS[$idx]}" "${A_HEALS[$idx]}" \
                         "${A_EXIT[$idx]}" "${A_LOG[$idx]}" "$PL_HEAL_ROOT")"
      pl_sweep_profile_chrome
      ;;
  esac
  idx=$((idx + 1))
done

if [ -z "$(git status --porcelain)" ]; then
  echo "run-weekly: nothing to commit even after incident write-up — failing." >&2
  exit 1
fi

if [ "$DRY_RUN" = 1 ]; then
  echo "run-weekly: DRY_RUN — would commit + PR (no merge); run_ok=${run_ok} accepted=${accepted}/${#AUTHORS[@]} worst_exit=${WORST_EXIT}."
else
  ./.claude/skills/common-pr-commit/commit.sh
  ./.claude/skills/common-pr-update/pr-update.sh
  PR_URL=$(gh pr view "$BRANCH" --json url -q .url 2>/dev/null || true)
  echo "run-weekly: PR left OPEN for review — merge manually after reading ${INCIDENT_FILE}, then dispatch pages-deploy.yml."
fi
RUN_STAGE="done"

# Recovered/partial runs are green (the PR is the review surface);
# any aborted/exhausted/no-data author makes the fire red so the week it
# missed — which can never be backfilled — is visible.
[ "$run_ok" -eq 1 ] || exit 1
