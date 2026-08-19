#!/usr/bin/env bash
# Weekly LinkedIn-stats scrape, driven non-interactively by the
# linkedin-stats-weekly GitHub Actions workflow on a self-hosted macOS runner.
#
# Built on .claude/skills/pipeline-shared/lib.sh (Template Method + Strategy:
# the lib owns the attempt-loop skeleton, watchdogs, heal-session runner and
# Slack micro-call; this driver supplies the policy hooks and owns trap
# composition, commit strategy, and the main_updated output).
#
# Self-healing flow:
#   1. Branch off origin/main (suffixed if a same-week PR is still open).
#   2. Up to MAX_ATTEMPTS runs of the deterministic scraper
#      (.claude/skills/linkedin-stats/fast/scrape-weekly.mjs), each under a
#      hard watchdog (the scraper's own deadline is soft — a stuck browser
#      ignores it). Acceptable = exit 0, or exit 10 (partial) whose contract
#      shows no phase-level ERROR and >=80% per-post coverage.
#   3. Between failed attempts, a headless `claude -p` heal session diagnoses
#      and fixes the pipeline following pipeline-shared/references/
#      self-heal-core.md + this skill's references/self-heal.md overlay:
#      evidence, a codex validation round, triage, fix, spot-verify, incident
#      write-up in doc/incidents/. Exceptions: exit 22 sleeps once (second
#      consecutive 429 stops the loop — only time helps), exit 21 sweeps the
#      orphan Chrome once (second consecutive lock goes to a heal session).
#      A heal session can stop the loop via $HEAL_ROOT/ABORT. Before each
#      retry, dashboards/li-stats is reset to the committed baseline so the
#      final tree is one attempt's coherent output, never a cross-attempt
#      hybrid.
#   4. jq-validate snapshots, then commit + push + PR via the common-pr-*
#      scripts. ONLY a no-heal exit-0 run auto-merges (and flips the
#      main_updated output that gates the Pages publish job). Everything
#      else — healed, partial, aborted, exhausted — leaves the PR OPEN for
#      review; a healed success first gets a read-only codex critique
#      session (references/self-heal-review.md overlay on the shared core).
#   5. Slack bookends on $SLACK_CHANNEL_ID (unset = no Slack): a 🟢 run-started
#      single EXIT trap posts the ✅/⚠️/❌ run-finished summary (attempts,
#      heals, coverage, followers, PR URL, duration) on every exit path —
#      best-effort pinned-haiku micro-calls that never fail the run.
#
# Test hooks (all default to production values): FAST_DIR, MAX_ATTEMPTS,
# MAX_HEALS, DEADLINE_SECS, HEAL_TIMEOUT_SECS, HEAL_CUTOFF_SECS,
# REVIEW_TIMEOUT_SECS, RATE_LIMIT_SLEEP_SECS, CLAUDE_BIN, and DRY_RUN=1
# (skip branch checkout and the commit/PR chain). NOTE: bookends still post
# unless CLAUDE_BIN points at a stub — the offline harness always stubs it.
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

WEEK=$(date -u -v-Mon "+%Y-%m-%d" 2>/dev/null || date -u -d "last monday" "+%Y-%m-%d")
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

    local measured="" failed="" followers=""
    if [ -n "${PL_ATTEMPT_LOG:-}" ] && [ -f "${PL_ATTEMPT_LOG:-}" ]; then
        measured=$(grep -Eo 'POSTS_MEASURED=[0-9]+' "$PL_ATTEMPT_LOG" 2>/dev/null | tail -1 | cut -d= -f2)
        failed=$(grep -Eo 'POSTS_FAILED=[0-9]+' "$PL_ATTEMPT_LOG" 2>/dev/null | tail -1 | cut -d= -f2)
        followers=$(grep -Eo 'FOLLOWERS=[0-9]+' "$PL_ATTEMPT_LOG" 2>/dev/null | tail -1 | cut -d= -f2)
    fi
    local summary="week ${WEEK}, attempts ${PL_ATTEMPT:-0}, heals ${PL_HEAL_COUNT:-0}"
    [ -n "$measured" ] && summary="${summary}, ${measured} posts measured / ${failed:-?} failed"
    [ -n "$followers" ] && summary="${summary}, followers ${followers}"
    [ -n "$PR_URL" ] && summary="${summary} — PR: ${PR_URL}"

    local msg
    if [ "$ec" -eq 0 ]; then
        if [ "$MERGED" = 1 ]; then
            msg="✅ linkedin-stats-weekly: scrape finished in ${dur} — ${summary}; merged to main"
        else
            local kind="recovered after self-heal"
            if [ "${PL_HEAL_COUNT:-0}" -eq 0 ]; then
                kind="accepted partial"
            elif [ "${PL_PARTIAL:-0}" = 1 ]; then
                kind="recovered (accepted partial)"
            fi
            msg="⚠️ linkedin-stats-weekly: ${kind} in ${dur} — ${summary}; PR left open for review (${INCIDENT_FILE})"
        fi
    else
        local why="${RUN_ERRORS:-failed during ${RUN_STAGE}}"
        case "$ec" in
            (143) why="terminated (SIGTERM) during ${RUN_STAGE}${RUN_ERRORS:+ — ${RUN_ERRORS}}";;
            (130) why="interrupted (SIGINT) during ${RUN_STAGE}${RUN_ERRORS:+ — ${RUN_ERRORS}}";;
        esac
        if [ "${PL_ABORTED:-0}" = 1 ]; then
            msg="❌ linkedin-stats-weekly: run aborted by heal session in ${dur} — $(pl_oneline "${PL_ABORT_REASON:-see incident}"); ${summary}"
        else
            msg="❌ linkedin-stats-weekly: run failed in ${dur} — $(pl_oneline "$why"); ${summary} (exit ${ec})"
        fi
    fi
    [ "$DRY_RUN" = 1 ] && msg="${msg} [DRY_RUN]"
    pl_post_slack "$msg"
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
emit_output "main_updated=false"

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
pl_npm_ensure "$FAST_DIR"

# Exit 10 keeps partial data, but the contract must show the run was healthy
# enough to accept: no phase-level ERROR (a dead posts/account/comments phase
# means a whole surface is missing however good the per-post counters look —
# the 2026-07-20 nav-slowdown runs died exactly there), POSTS_MEASURED > 0,
# and >=80% per-post coverage (measured >= 4x the failed+unprocessed rest).
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

# ------------------------------------------------------------ strategy hooks

pipeline_heal_prompt() {
  PL_HEAL_PROMPT=$(cat <<EOF
You are the self-healing layer of the linkedin-stats weekly pipeline, invoked
headless by run-weekly.sh on the self-hosted runner after a failed scrape
attempt. Read ${SHARED_DIR}/references/self-heal-core.md first, then the
overlay at OVERLAY_FILE, and follow them exactly.
Context:
PIPELINE_NAME=linkedin-stats-weekly
OVERLAY_FILE=${SKILL_DIR}/references/self-heal.md
WRAPPER=${SKILL_DIR}/run-weekly.sh
ATTEMPT=${PL_ATTEMPT}/${MAX_ATTEMPTS}
HEAL_COUNT=${PL_HEAL_COUNT}
EXIT_CODE=${PL_ATTEMPT_EXIT}
LOG_FILE=${PL_ATTEMPT_LOG}
HEAL_DIR=${HEAL_ROOT}
INCIDENT_FILE=${INCIDENT_FILE}
CODEX_AVAILABLE=${PL_CODEX_AVAILABLE}
WEEK=${WEEK}
FAST_DIR=${FAST_DIR}
EOF
)
}

review_prompt() {
  local acceptance="complete"
  [ "$PL_ATTEMPT_EXIT" -eq 10 ] && acceptance="accepted_partial"
  cat <<EOF
You are the review layer of the linkedin-stats weekly pipeline. Heal
sessions ran and the outer acceptance gate accepted the final scrape attempt
(see FINAL_ACCEPTANCE — "accepted_partial" means exit 10 with gaps, NOT a
full success; describe it accordingly). Read
${SHARED_DIR}/references/self-heal-review-core.md first, then the overlay at
OVERLAY_FILE, and follow them exactly. This session is READ-ONLY for code:
critique goes into the incident doc, not into files under version control
other than ${INCIDENT_FILE} and CLAUDE.md.
Context:
PIPELINE_NAME=linkedin-stats-weekly
OVERLAY_FILE=${SKILL_DIR}/references/self-heal-review.md
WRAPPER=${SKILL_DIR}/run-weekly.sh
ATTEMPTS_USED=${PL_ATTEMPT}
HEAL_COUNT=${PL_HEAL_COUNT}
FINAL_EXIT_CODE=${PL_ATTEMPT_EXIT}
FINAL_ACCEPTANCE=${acceptance}
FINAL_LOG_FILE=${PL_ATTEMPT_LOG}
HEAL_DIR=${HEAL_ROOT}
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
  git checkout -q "$BASE_SHA" -- dashboards/li-stats/
  git clean -qfd dashboards/li-stats/
  if [ -n "$(git status --porcelain -- dashboards/li-stats/)" ]; then
    echo "run-weekly: dashboards/li-stats/ did not reset cleanly to ${BASE_SHA} — aborting." >&2
    exit 1
  fi
}

pipeline_run_attempt() {
  local marker="$HEAL_ROOT/timeout-scrape-${PL_ATTEMPT}" pid wd attempt_start
  attempt_start=$SECONDS
  echo "run-weekly: scrape attempt ${PL_ATTEMPT}/${MAX_ATTEMPTS} starting ($(date -u +%H:%M:%SZ))"
  # The scraper's --deadline is soft (checked between navigations); a hung
  # browser sails past it. The killer is the hard cap.
  set +e
  (
    node "$FAST_DIR/scrape-weekly.mjs" --deadline-secs="$DEADLINE_SECS" 2>&1 | tee "$PL_ATTEMPT_LOG"
    exit "${PIPESTATUS[0]}"
  ) &
  pid=$!
  pl_spawn_killer "$(( DEADLINE_SECS + HARD_CAP_EXTRA_SECS ))" "$pid" "scraper (attempt ${PL_ATTEMPT})" "$marker"
  wd=$!
  pl_await_target "$pid" "$wd" "$marker"
  PL_ATTEMPT_EXIT=$?
  set -e
  local timed_out_note=""
  [ -f "$marker" ] && timed_out_note=", KILLED at hard cap"
  attempt_summaries+=("attempt ${PL_ATTEMPT}: exit ${PL_ATTEMPT_EXIT}, $(( SECONDS - attempt_start ))s${timed_out_note}")
  echo "run-weekly: attempt ${PL_ATTEMPT} exited ${PL_ATTEMPT_EXIT} ($(date -u +%H:%M:%SZ))"
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
        echo "run-weekly: partial with acceptable coverage — keeping it (PR will stay unmerged)."
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
        echo "run-weekly: second consecutive rate-limit — stopping the loop." >&2
        RUN_ERRORS="${RUN_ERRORS:+${RUN_ERRORS}; }second consecutive rate-limit"
        PL_VERDICT=fail
      else
        echo "run-weekly: rate-limited — sleeping ${RATE_LIMIT_SLEEP_SECS}s before the next attempt."
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
        echo "run-weekly: profile locked — sweeping orphaned Chrome and retrying in ${LOCK_RETRY_SLEEP_SECS}s."
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

# ---------------------------------------------------------------- scrape loop

attempt_summaries=()
consecutive_rate=0
consecutive_lock=0
RUN_STAGE="scrape"
pl_attempt_loop
scrape_ok=$PL_OK
fast_exit=$PL_ATTEMPT_EXIT

# ------------------------------------------------------------------- commit

RUN_STAGE="commit"

# A kill/deadline can land mid-write; never commit a truncated snapshot.
# Always revert the corrupt file (the PR must stay parseable), and demote the
# whole run to failed — a run that silently discarded one of its outputs must
# not be called clean, partial, or recovered.
invalid_json=0
while IFS= read -r -d '' f; do
  if ! jq empty "$f" 2>/dev/null; then
    invalid_json=1
    git checkout -- "$f" 2>/dev/null || rm -f "$f"
    echo "run-weekly: $f was not valid JSON — reverted." >&2
    PL_SESSION_NOTES+=("invalid JSON reverted: $f")
  fi
done < <(find dashboards/li-stats -name '*.json' -print0)
if [ "$invalid_json" -eq 1 ] && [ "$scrape_ok" -eq 1 ]; then
  echo "run-weekly: truncated snapshot detected — demoting the run to UNRESOLVED." >&2
  scrape_ok=0
fi

# Auto-merge ONLY the boring case: first-grade success with no healing. A
# healed run's fix and an accepted partial's gaps both deserve human eyes —
# and a permanent regression must not quietly auto-merge partial data every
# Monday (that's how 2026-07-20 would have looked with a laxer gate).
if [ "$scrape_ok" -eq 1 ] && [ "$PL_HEALED" -eq 0 ] && [ "$fast_exit" -eq 0 ]; then
  # git diff --quiet only sees TRACKED changes; new posts create untracked
  # JSON files, so use git status --porcelain. A weekly run must at minimum
  # add a weeks[WEEK] entry to account.json — "no changes" means the scrape
  # produced nothing, so fail loudly instead of green.
  if [ -z "$(git status --porcelain -- dashboards/li-stats/)" ]; then
    echo "run-weekly: no changes under dashboards/li-stats/ after scrape — failing the run." >&2
    exit 1
  fi
  if [ "$DRY_RUN" = 1 ]; then
    echo "run-weekly: DRY_RUN — would commit + PR + merge."
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
# CLAUDE.md, optionally run the read-only critique, then commit + PR WITHOUT
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
  printf -- '- %s\n' "${attempt_summaries[@]}"
  if [ "${#PL_SESSION_NOTES[@]}" -gt 0 ]; then
    printf -- '- note: %s\n' "${PL_SESSION_NOTES[@]}"
  fi
  if [ "$scrape_ok" -eq 1 ] && [ "$PL_HEAL_COUNT" -gt 0 ]; then
    if [ "$fast_exit" -eq 0 ]; then acceptance="full success"; else acceptance="accepted partial, exit 10"; fi
    printf -- '- outcome: RECOVERED — outer gate accepted attempt %s (%s) after %s heal session(s); PR left unmerged for review\n' "$PL_ATTEMPT" "$acceptance" "$PL_HEAL_COUNT"
  elif [ "$scrape_ok" -eq 1 ]; then
    printf -- '- outcome: PARTIAL — exit 10 accepted with reduced coverage; PR left unmerged for review\n'
  elif [ "$PL_ABORTED" -eq 1 ]; then
    printf -- '- outcome: ABORTED by heal session — %s\n' "$PL_ABORT_REASON"
  else
    printf -- '- outcome: UNRESOLVED — stopped after %s of %s attempts (last exit %s)\n' "$PL_ATTEMPT" "$MAX_ATTEMPTS" "$fast_exit"
  fi
} >> "$INCIDENT_FILE"

if [ "$scrape_ok" -eq 1 ] && [ "$PL_HEAL_COUNT" -gt 0 ]; then
  outcome="recovered after ${PL_ATTEMPT} attempts / ${PL_HEAL_COUNT} heal(s), PR review pending"
  [ "$fast_exit" -eq 10 ] && outcome="recovered (accepted partial) after ${PL_ATTEMPT} attempts / ${PL_HEAL_COUNT} heal(s), PR review pending"
elif [ "$scrape_ok" -eq 1 ]; then
  outcome="partial coverage accepted, PR review pending"
elif [ "$PL_ABORTED" -eq 1 ]; then
  outcome="heal aborted: $(printf '%s' "$PL_ABORT_REASON" | head -c 80)"
else
  outcome="UNRESOLVED after ${PL_ATTEMPT} attempts (last exit ${fast_exit})"
fi
pl_link_incident_in_claude_md "- ${TODAY} — weekly scrape: ${outcome} — [${INCIDENT_FILE}](${INCIDENT_FILE})"

if [ "$scrape_ok" -eq 1 ] && [ "$PL_HEALED" -eq 1 ]; then
  echo "run-weekly: rerun succeeded after healing — starting read-only critique session."
  pl_run_claude_with_watchdog "$REVIEW_TIMEOUT_SECS" stats-heal-review "$(review_prompt)"
  pl_sweep_profile_chrome
fi

if [ -z "$(git status --porcelain)" ]; then
  echo "run-weekly: nothing to commit even after incident write-up — failing." >&2
  exit 1
fi

if [ "$DRY_RUN" = 1 ]; then
  echo "run-weekly: DRY_RUN — would commit + PR (no merge); scrape_ok=${scrape_ok} heal_count=${PL_HEAL_COUNT} aborted=${PL_ABORTED}."
else
  ./.claude/skills/common-pr-commit/commit.sh
  ./.claude/skills/common-pr-update/pr-update.sh
  PR_URL=$(gh pr view "$BRANCH" --json url -q .url 2>/dev/null || true)
  echo "run-weekly: PR left OPEN for review — merge manually after reading ${INCIDENT_FILE}, then dispatch pages-deploy.yml."
fi
RUN_STAGE="done"

# Recovered/partial runs are green (the PR is the review surface);
# aborted/exhausted runs are red so the missed week is visible.
[ "$scrape_ok" -eq 1 ] || exit 1
