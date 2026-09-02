# Shared pipeline library, sourced by the scheduled-pipeline drivers
# (.claude/skills/linkedin-stats/run-weekly.sh and
# .claude/skills/linkedin-comment-hourly/run-hourly.sh). Not a skill —
# `*-shared` folders hold shared code (see CLAUDE.md conventions).
#
# Design: Template Method + Strategy, in bash 3.2 (the runner's ONLY bash —
# /bin/bash and PATH bash are both 3.2.57; no associative arrays, no
# ${var,,}, and "${empty[@]}" errors under set -u).
#
# - This file owns the INVARIANT machinery: leaf helpers (watchdogs, Chrome
#   sweep, the pinned claude invocations, incident plumbing) and the
#   attempt-loop template `pl_attempt_loop`.
# - Each driver supplies the VARYING policy as plain bash hook functions,
#   defined before calling the template:
#       pipeline_run_attempt    — run ONE attempt; must set PL_ATTEMPT_EXIT
#                                 (and log to PL_ATTEMPT_LOG for heal sessions)
#       pipeline_classify       — read PL_ATTEMPT_EXIT / PL_ATTEMPT_LOG, set
#                                 PL_VERDICT = accept | accept_partial | fail
#                                 | retry | heal | fallback, plus
#                                 PL_RETRY_SECS / PL_RETRY_SWEEP for retry;
#                                 may mutate its own driver-global counters
#       pipeline_reset_baseline — restore this pipeline's data dirs to the
#                                 committed baseline (called before retries so
#                                 the final tree is ONE attempt's coherent
#                                 output and a heal's rerun is real
#                                 verification, never a cross-attempt hybrid)
#       pipeline_heal_prompt    — set PL_HEAL_PROMPT for the heal session
#   Hooks are called DIRECTLY, never via $(...): command substitution would
#   run them in a subshell and silently discard their counter updates on
#   bash 3.2, and a hook's stdout is not a data channel. Hooks communicate
#   ONLY through PL_* globals and must return 0 (a nonzero return aborts the
#   driver under its set -e — fail loud, not wrong).
# - The lib NEVER changes global shell options and NEVER installs traps:
#   drivers own `set -euo pipefail` and their own EXIT/TERM/INT composition.
#
# Config the driver sets before use (no defaults where marked required):
#   PL_LOG_PREFIX          log-line prefix, e.g. "run-weekly"     (required)
#   PL_PIPELINE_NAME       e.g. "linkedin-stats-weekly"           (required)
#   PL_HEAL_ROOT           gitignored scratch dir for this run    (required)
#   PL_INCIDENT_FILE       git-tracked incident doc path          (required)
#   PL_MAX_ATTEMPTS        attempt-loop bound                     (required)
#   PL_MAX_HEALS           heal sessions allowed this run         (required)
#   PL_HEAL_TIMEOUT_SECS   watchdog cap per heal session          (required)
#   PL_HEAL_CUTOFF_SECS    don't START a heal after this elapsed  (required)
#   PL_HEAL_ROLE           CLAUDE_HISTORY_ROLE for heal sessions  (required)
#   PL_SLACK_CHANNEL_ID    bookend channel                        (required for pl_post_slack)
#   PL_SLACK_POST_TIMEOUT_SECS  default 120
#   PL_SLACK_POST_MODEL         default the pinned haiku
#   CLAUDE_BIN                  default claude (test hook)
#
# State the templates expose back: PL_ATTEMPT, PL_ATTEMPT_EXIT,
# PL_ATTEMPT_LOG, PL_OK, PL_PARTIAL, PL_HEAL_COUNT, PL_HEALED, PL_ABORTED,
# PL_ABORT_REASON, PL_OUTCOME, PL_CLAUDE_STATUS, PL_CLAUDE_TIMED_OUT,
# PL_SESSION_NOTES (array — drivers must init `PL_SESSION_NOTES=()` and
# guard expansion with a ${#...} check: bash 3.2 + set -u).

pl_require_cmds() {
  local cmd
  for cmd in "$@"; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
      echo "${PL_LOG_PREFIX}: required command not found in PATH: $cmd" >&2
      exit 1
    fi
  done
}

# Collapse free text (heal ABORT reasons, scraper end-reasons, error notes)
# to one bounded line before it is embedded in a Slack micro-call prompt —
# multiline content could smuggle instructions into the posting model.
pl_oneline() {
  printf '%s' "$1" | tr '\n\r' '  ' | cut -c1-200
}

# codex is the heal sessions' second brain; its absence degrades them, not us.
pl_codex_available() {
  PL_CODEX_AVAILABLE=0
  command -v codex >/dev/null 2>&1 && PL_CODEX_AVAILABLE=1
  return 0
}

# node_modules is gitignored; the runner's clone starts clean every fire.
pl_npm_ensure() {
  if [ ! -d "$1/node_modules/playwright-core" ]; then
    (cd "$1" && npm install --no-audit --no-fund --silent)
  fi
}

# The fast scripts' own launchers close their browsers; this catches
# everything a kill or a crashed probe leaves behind. Any Chrome on the
# shared profile while a job runs is an orphan — the single runner
# serializes jobs. Deliberately the NARROW pattern (user-data-dir=…): a bare
# profile-name match could kill unrelated processes that merely mention it.
pl_sweep_profile_chrome() {
  pkill -f 'user-data-dir=.*mcp-chrome-linkedin-stats' 2>/dev/null || true
}

# pl_spawn_killer <cap-secs> <target-pid> <label> <marker> [cleanup-fn]
# Background watchdog. At the cap it: creates <marker> (so the caller knows
# it fired and the timeout is visible in run state), records the target's
# direct children BEFORE anything dies (kill-by-recorded-PID still reaches a
# TERM-ignoring child after it's been reparented — pkill -P on a dead parent
# finds nothing), TERMs them and the target, runs <cleanup-fn> (default: the
# Chrome sweep; pass `:` for targets that own no browser), then
# KILL-escalates after 15s.
pl_spawn_killer() {
  local cap="$1" target="$2" label="$3" marker="$4" cleanup="${5:-pl_sweep_profile_chrome}" kids
  (
    # Whole-subshell stderr is discarded: reaping this watchdog TERMs its
    # sleep, and the runner's bash prints a "Terminated: 15 sleep" job notice
    # even for background children (observed on the 2026-07-20 fires —
    # backgrounding alone didn't silence it). Individual kills below carry
    # their own redirects; the one legitimate alert goes to stdout.
    sleep "$cap" &
    wait "$!" || exit 0
    kill -0 "$target" 2>/dev/null || exit 0
    touch "$marker"
    echo "${PL_LOG_PREFIX}: $label exceeded ${cap}s — terminating (pid $target)."
    kids=$(pgrep -P "$target" 2>/dev/null || true)
    # word-splitting of $kids is intended: it is a PID list
    kill -TERM $kids "$target" 2>/dev/null || true
    "$cleanup"
    sleep 15
    kill -KILL $kids "$target" 2>/dev/null || true
  ) 2>/dev/null &
}

# pl_await_target <target-pid> <watchdog-pid> <marker>
# Waits for the target and returns its exit status (callers must capture it
# in an errexit-suppressed position: `pl_await_target … ; rc=$?` inside
# set +e, or `pl_await_target … || rc=$?`). If the watchdog fired, WAIT for
# its KILL escalation to finish — cancelling it would let a TERM-ignoring
# child (e.g. a scraper hanging in context.close()) survive into the next
# attempt. Otherwise reap the watchdog, its own sleep first: orphaned, that
# sleep would hold this script's stdout pipe open long after we exit; the
# racing subshell then sees a reaped target and exits harmlessly.
pl_await_target() {
  local target="$1" wd="$2" marker="$3" status=0
  wait "$target" 2>/dev/null || status=$?
  if [ -f "$marker" ]; then
    wait "$wd" 2>/dev/null || true
  else
    pkill -P "$wd" 2>/dev/null || true
    kill "$wd" 2>/dev/null || true
    wait "$wd" 2>/dev/null || true
  fi
  return "$status"
}

# pl_run_claude_with_watchdog <timeout-secs> <history-role> <prompt>
# The heal/review session runner (NOT for bookends — pl_post_slack is its own
# pinned shape, and NOT for drafting — that filter differs and stays in its
# driver). Streams claude's narration into the job log. GH_TOKEN is scrubbed —
# heal and review sessions have no business talking to GitHub (prompt-level
# enforcement: actions/checkout persists a git credential in .git/config, so
# this is a tripwire, not a wall — the protocol's ground rules are the wall).
# Sets PL_CLAUDE_STATUS (pipeline exit) and PL_CLAUDE_TIMED_OUT (0/1).
pl_run_claude_with_watchdog() {
  local cap="$1" role="$2" prompt="$3" pid wd marker
  PL_CLAUDE_STATUS=0
  PL_CLAUDE_TIMED_OUT=0
  # The 600s headless background-task ceiling would kill a 5-8 min codex run.
  (
    printf '%s' "$prompt" \
      | CLAUDE_HISTORY_ROLE="$role" CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0 \
        env -u GH_TOKEN \
        "${CLAUDE_BIN:-claude}" -p --dangerously-skip-permissions --output-format stream-json --verbose \
      | jq -r --unbuffered '
          (select(.type == "result" and .is_error == true)
            | "ERROR: \(.result // .error // "unknown")" | halt_error(3))
          // .description
          // (.message?.content? | arrays | map(select(.type=="text") | .text) | .[])
          // (select(.is_error == true or .error) | "ERROR: \(.error // .message?.content)")
          // empty
        '
  ) &
  pid=$!
  marker="$PL_HEAL_ROOT/timeout-${role}-${pid}"
  pl_spawn_killer "$cap" "$pid" "claude ($role)" "$marker"
  wd=$!
  pl_await_target "$pid" "$wd" "$marker" || PL_CLAUDE_STATUS=$?
  if [ -f "$marker" ]; then
    PL_CLAUDE_TIMED_OUT=1
    # A timed-out session may have left half-done work; the run state and
    # incident must say so instead of pretending the protocol completed.
    PL_SESSION_NOTES+=("claude ${role} session TIMED OUT at ${cap}s — its work may be incomplete")
    echo "${PL_LOG_PREFIX}: claude ($role) timed out — continuing with whatever it left." >&2
  elif [ "$PL_CLAUDE_STATUS" -ne 0 ]; then
    PL_SESSION_NOTES+=("claude ${role} session exited ${PL_CLAUDE_STATUS}")
    echo "${PL_LOG_PREFIX}: claude ($role) exited ${PL_CLAUDE_STATUS} — continuing." >&2
  fi
  return 0
}

# pl_post_slack <message> — bounded by its own bash watchdog (macOS has no
# coreutils timeout). Always returns 0: a Slack failure must never fail a
# fire. The message may be single- or multi-line (multi-line since
# 2026-08-13, when run-hourly.sh's finish bookend grew a ticket list).
# Invocation shape is empirically pinned (2026-07-17) — do NOT change it,
# only relocate it:
#   - message goes INLINE in the prompt, NOT on stdin — haiku intermittently
#     refuses to post "content it can't see", so it must see the (fully
#     script-controlled) status message to post it reliably. Verified 3/3.
#   - --allowedTools pre-approves exactly the one connector tool; combined
#     with --permission-mode dontAsk, every other tool is denied
#     non-interactively.
#   - NO --tools "" — on this CLI it strips MCP tools too, so the Slack
#     connector vanishes and the model hallucinates the call as text (exits 0).
#   - NO --setting-sources "" — it correlated with spurious safety refusals;
#     the inline-message shape makes it unnecessary.
#   - the message is the LAST thing in the prompt, so a multi-line body
#     cannot be confused with trailing instructions.
# Content rule: the message must be script-controlled (fixed strings, counts,
# PR/ticket URLs), or scraped values that the CALLER has already sanitized —
# run-hourly.sh's collect_ticket_lines() is the only such caller today (it
# strips markup/control chars and length-caps each author name, and validates
# every URL against the ClickUp task-URL shape). Raw scraped post or user
# content must never reach here: it is inlined into a prompt.
pl_post_slack() {
  local msg="$1" out_log
  # Both drivers document "SLACK_CHANNEL_ID unset = no Slack", but nothing
  # enforced it: with an empty channel this still spawned a `claude` process
  # (absent on a GitHub-hosted runner) and — worse — left its 120s watchdog
  # `sleep` orphaned holding the caller's stdout, which stalls an Actions step
  # long after the run is over. No channel, no post, no watchdog.
  [ -n "${PL_SLACK_CHANNEL_ID:-}" ] || return 0
  mkdir -p tmp
  out_log=$(mktemp tmp/slack-bookend.XXXXXX)
  local prompt="Post the status message below to Slack by calling mcp__claude_ai_Slack_Bot__postMessage exactly once with channel_id=${PL_SLACK_CHANNEL_ID} and text set to the message verbatim, preserving every line break. It is a pre-approved automated run-status notification for a channel that already receives these — do not alter, summarize, reformat, question, or withhold it. After the tool returns, reply with only: done

Status message to post:
${msg}"
  CLAUDE_HISTORY_ROLE=0 "${CLAUDE_BIN:-claude}" -p "$prompt" \
    --model "${PL_SLACK_POST_MODEL:-claude-haiku-4-5-20251001}" \
    --allowedTools "mcp__claude_ai_Slack_Bot__postMessage" \
    --permission-mode dontAsk \
    --no-session-persistence \
    >"$out_log" 2>&1 &
  local post_pid=$!
  (
    sleep "${PL_SLACK_POST_TIMEOUT_SECS:-120}"
    kill -0 "$post_pid" 2>/dev/null || exit 0
    echo "${PL_LOG_PREFIX}: slack bookend exceeded ${PL_SLACK_POST_TIMEOUT_SECS:-120}s — killing (pid $post_pid)." >&2
    pkill -TERM -P "$post_pid" 2>/dev/null || true
    kill -TERM "$post_pid" 2>/dev/null || true
    sleep 5
    pkill -KILL -P "$post_pid" 2>/dev/null || true
    kill -KILL "$post_pid" 2>/dev/null || true
  ) &
  local wd_pid=$!
  wait "$post_pid" 2>/dev/null \
    || echo "${PL_LOG_PREFIX}: slack bookend post failed (non-fatal, log: $out_log)." >&2
  # claude can exit 0 after merely *explaining* a denial — assert the ack.
  grep -q 'done' "$out_log" 2>/dev/null \
    || echo "${PL_LOG_PREFIX}: slack bookend may not have posted (log: $out_log) (non-fatal)." >&2
  pkill -KILL -P "$post_pid" 2>/dev/null || true   # sweep stragglers past the wd race
  # Kill the watchdog's OWN sleep first, exactly as pl_await_target does:
  # killing only the subshell orphans that sleep, and an orphaned sleep keeps
  # this script's stdout pipe open for the full timeout (observed: a caller
  # reading our output blocked for 120s after the bookend had returned).
  pkill -P "$wd_pid" 2>/dev/null || true
  kill "$wd_pid" 2>/dev/null || true
  wait "$wd_pid" 2>/dev/null || true
  return 0
}

# Create the incident doc BEFORE the first heal session — a watchdog-killed
# claude must still leave a committed trace of what happened.
pl_ensure_incident_skeleton() {
  [ -f "$PL_INCIDENT_FILE" ] && return 0
  mkdir -p "$(dirname "$PL_INCIDENT_FILE")"
  {
    printf '# %s — %s incident\n\n' "$(date -u +%Y-%m-%d)" "$PL_PIPELINE_NAME"
    printf 'Auto-created by %s (attempt %s, exit %s). Log tail:\n\n```\n' \
      "$PL_LOG_PREFIX" "${PL_ATTEMPT:-?}" "${PL_ATTEMPT_EXIT:-?}"
    tail -15 "${PL_ATTEMPT_LOG:-/dev/null}" 2>/dev/null || true
    printf '```\n'
  } > "$PL_INCIDENT_FILE"
}

# pl_link_incident_in_claude_md <link-line>
# Inserts the (fully composed) line under CLAUDE.md's `## Incidents`,
# creating the section when absent. No-op if this incident is already linked.
pl_link_incident_in_claude_md() {
  local link_line="$1"
  if grep -qF "(${PL_INCIDENT_FILE})" CLAUDE.md; then
    return 0
  fi
  if grep -q '^## Incidents' CLAUDE.md; then
    awk -v line="$link_line" '{ print } /^## Incidents/ && !done { print ""; print line; done=1 }' \
      CLAUDE.md > CLAUDE.md.tmp && mv CLAUDE.md.tmp CLAUDE.md
  else
    printf '\n## Incidents\n\n%s\n' "$link_line" >> CLAUDE.md
  fi
}

# One heal session: incident skeleton first (a killed session still leaves a
# trace), then the driver-composed prompt under the watchdog, then the
# browser sweep, then the ABORT check.
pl_run_heal_session() {
  PL_HEALED=1
  PL_HEAL_COUNT=$((PL_HEAL_COUNT + 1))
  pl_ensure_incident_skeleton
  pipeline_heal_prompt
  echo "${PL_LOG_PREFIX}: heal session ${PL_HEAL_COUNT} starting for exit ${PL_ATTEMPT_EXIT} ($(date -u +%H:%M:%SZ))"
  pl_run_claude_with_watchdog "$PL_HEAL_TIMEOUT_SECS" "$PL_HEAL_ROLE" "$PL_HEAL_PROMPT"
  pl_sweep_profile_chrome
  echo "${PL_LOG_PREFIX}: heal session done ($(date -u +%H:%M:%SZ))"
  if [ -f "$PL_HEAL_ROOT/ABORT" ]; then
    PL_ABORT_REASON=$(cat "$PL_HEAL_ROOT/ABORT")
    echo "${PL_LOG_PREFIX}: heal session aborted the loop: ${PL_ABORT_REASON}" >&2
    PL_ABORTED=1
  fi
  return 0
}

# ---------------------------------------------------------------- template
# The attempt loop. Invariant control flow lives here ONCE; all policy comes
# from the driver's hooks (see the header). Terminal PL_OUTCOME values:
#   accept | accept_partial       PL_OK=1 (PARTIAL also set for the latter)
#   fallback                      NOT ok — the driver's fallback branch owns
#                                 what happens next (a fallback is not a
#                                 verified fast-path result)
#   fail                          classify chose a terminal failure (no heal)
#   aborted                       a heal session wrote $PL_HEAL_ROOT/ABORT
#   heal_budget | heal_cutoff     a heal was wanted but PL_MAX_HEALS /
#                                 PL_HEAL_CUTOFF_SECS forbids it
#   exhausted                     attempts ran out
# The `attempt >= PL_MAX_ATTEMPTS` break sits BEFORE the retry/heal dispatch
# on purpose: the final failed attempt gets no heal — a heal whose fix can
# never be rerun is unverifiable spend (pinned weekly behavior).
pl_attempt_loop() {
  PL_ATTEMPT=0
  PL_OK=0
  PL_PARTIAL=0
  PL_HEALED=${PL_HEALED:-0}
  PL_HEAL_COUNT=${PL_HEAL_COUNT:-0}
  PL_ABORTED=0
  PL_ABORT_REASON=""
  PL_OUTCOME=""
  PL_ATTEMPT_EXIT=1
  while [ "$PL_ATTEMPT" -lt "$PL_MAX_ATTEMPTS" ]; do
    PL_ATTEMPT=$((PL_ATTEMPT + 1))
    PL_ATTEMPT_LOG="$PL_HEAL_ROOT/attempt-${PL_ATTEMPT}.log"
    if [ "$PL_ATTEMPT" -gt 1 ]; then
      pipeline_reset_baseline
    fi
    PL_VERDICT=""
    PL_RETRY_SECS=0
    PL_RETRY_SWEEP=0
    pipeline_run_attempt
    pipeline_classify
    case "$PL_VERDICT" in
      accept)         PL_OK=1; PL_OUTCOME=accept; break ;;
      accept_partial) PL_OK=1; PL_PARTIAL=1; PL_OUTCOME=accept_partial; break ;;
      fail)           PL_OUTCOME=fail; break ;;
      fallback)       PL_OUTCOME=fallback; break ;;
    esac
    if [ "$PL_ATTEMPT" -ge "$PL_MAX_ATTEMPTS" ]; then
      PL_OUTCOME=exhausted
      break
    fi
    case "$PL_VERDICT" in
      retry)
        [ "$PL_RETRY_SWEEP" = 1 ] && pl_sweep_profile_chrome
        if [ "${PL_RETRY_SECS:-0}" -gt 0 ] 2>/dev/null; then
          echo "${PL_LOG_PREFIX}: retrying in ${PL_RETRY_SECS}s (attempt $((PL_ATTEMPT + 1)) next)."
          sleep "$PL_RETRY_SECS"
        fi
        ;;
      heal)
        if [ "$PL_HEAL_COUNT" -ge "$PL_MAX_HEALS" ]; then
          echo "${PL_LOG_PREFIX}: heal budget spent (${PL_HEAL_COUNT}/${PL_MAX_HEALS}) — stopping the loop." >&2
          PL_OUTCOME=heal_budget
          break
        fi
        if [ "$SECONDS" -gt "$PL_HEAL_CUTOFF_SECS" ]; then
          echo "${PL_LOG_PREFIX}: past the heal cutoff (${SECONDS}s > ${PL_HEAL_CUTOFF_SECS}s) — stopping the loop." >&2
          PL_OUTCOME=heal_cutoff
          break
        fi
        pl_run_heal_session
        if [ "$PL_ABORTED" = 1 ]; then
          PL_OUTCOME=aborted
          break
        fi
        ;;
      *)
        echo "${PL_LOG_PREFIX}: pipeline_classify produced unknown verdict '${PL_VERDICT}' for exit ${PL_ATTEMPT_EXIT} — failing." >&2
        PL_OUTCOME=fail
        break
        ;;
    esac
  done
  return 0
}
