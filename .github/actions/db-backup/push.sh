#!/usr/bin/env bash
# Pushes ONE dump file to the private backup repository over SSH with a deploy
# key. The file is overwritten on every run, so the backup repo's git history IS
# the backup history.
#
#   LI_BACKUP_DEPLOY_KEY=<private key> push.sh <remote-url> <dump> <file-name-in-repo>
#
# <dump>.msg must hold the commit message (db-ci.mjs dump writes it: ISO week +
# per-table row counts). Always exits 0; the verdict goes to $GITHUB_OUTPUT as
# backup=ok | failed:push | timeout:push, plus a ::warning:: on anything but ok.
#
# Prints nothing from the dump and nothing from the key. git's own stderr is
# shown on failure: it names the repository and the refusal, never file content.
set -uo pipefail

remote="${1:-}"; dump="${2:-}"; name="${3:-linkedin.sql}"
out="${GITHUB_OUTPUT:-/dev/stdout}"
work="$(dirname "${dump:-/nonexistent/x}")"
key="${work}/deploy_key"
UNAFFECTED="The week is NOT affected: JSON in git is still the source of truth."

finish() { echo "backup=$1" >> "${out}"; exit 0; }
fail() { echo "::warning::database backup FAILED - $1 ${UNAFFECTED}"; finish "${2:-failed:push}"; }
# The key never outlives this script, whatever path leaves it.
trap 'rm -f "${key}"' EXIT

# `timeout` is always present on a runner; the fallback only lets this script be
# exercised on a laptop without coreutils.
cap() {
  local secs="$1"; shift
  if command -v timeout >/dev/null 2>&1; then timeout --signal=TERM --kill-after=30 "${secs}" "$@"; else "$@"; fi
}

[ -n "${remote}" ] && [ -f "${dump}" ] && [ -f "${dump}.msg" ] || fail "push.sh was called without a remote, a dump and its commit message."
case "${name}" in
  */*|.*|"") fail "refusing the backup file name given to push.sh." ;;
esac

umask 077
printf '%s\n' "${LI_BACKUP_DEPLOY_KEY:-}" | tr -d '\r' > "${key}"
if ! ssh-keygen -y -P "" -f "${key}" >/dev/null 2>&1; then
  echo "::warning::database backup: LI_BACKUP_DEPLOY_KEY does not parse as an unencrypted SSH private key (truncated paste? passphrase?) - the push will most likely be refused"
fi

# GitHub's ed25519 host key, pinned: a runner must not trust-on-first-use the
# host it is about to hand a database dump to.
# https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints
printf '%s\n' 'github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl' > "${work}/known_hosts"
export GIT_SSH_COMMAND="ssh -F /dev/null -i '${key}' -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile='${work}/known_hosts' -o GlobalKnownHostsFile=/dev/null -o HostKeyAlgorithms=ssh-ed25519 -o ConnectTimeout=20 -o ServerAliveInterval=15 -o ServerAliveCountMax=4"
export GIT_TERMINAL_PROMPT=0

repo="${work}/repo"
rm -rf "${repo}"
git init -q -b main "${repo}" || fail "git init failed."
git -C "${repo}" remote add origin "${remote}"

heads=$(cap 120 git -C "${repo}" ls-remote --heads origin 2>"${work}/git.err"); rc=$?
if [ "${rc}" -ne 0 ]; then
  sed -e 's/^/  git: /' "${work}/git.err" | head -5
  [ "${rc}" -eq 124 ] && fail "the backup repository did not answer within 120s." "timeout:push"
  fail "cannot reach the backup repository (git ls-remote exited ${rc}). Does it exist, and is LI_BACKUP_DEPLOY_KEY registered on it as a deploy key WITH write access?"
fi

# Build on the previous backup when there is one - WITHOUT checking its (large)
# dump out: a mixed reset loads the commit into HEAD and the index only. Other
# files in the backup repo (a README) are therefore kept. A brand-new, empty
# repository has no main yet; the first push creates it.
if printf '%s\n' "${heads}" | grep -q 'refs/heads/main$'; then
  cap 600 git -C "${repo}" fetch -q --depth 1 origin main 2>"${work}/git.err"; rc=$?
  if [ "${rc}" -ne 0 ]; then
    sed -e 's/^/  git: /' "${work}/git.err" | head -5
    [ "${rc}" -eq 124 ] && fail "fetching the previous backup timed out." "timeout:push"
    fail "could not fetch the previous backup (git fetch exited ${rc})."
  fi
  git -C "${repo}" reset -q FETCH_HEAD || fail "could not build on the previous backup."
fi

cp "${dump}" "${repo}/${name}" || fail "could not stage the dump."
git -C "${repo}" add -- "${name}"
msg="${dump}.msg"
if git -C "${repo}" rev-parse -q --verify HEAD >/dev/null 2>&1 && git -C "${repo}" diff --cached --quiet -- "${name}"; then
  # Still commit: three quiet weeks must be three entries, not an absence that
  # looks exactly like a backup that silently stopped running.
  printf '\nDump is byte-identical to the previous backup.\n' >> "${msg}"
  echo "dump unchanged since the previous backup - recording the run with an empty commit"
fi
git -C "${repo}" -c user.name="github-actions[bot]" -c user.email="41898282+github-actions[bot]@users.noreply.github.com" \
  commit -q --allow-empty -F "${msg}" 2>"${work}/git.err" \
  || { sed -e 's/^/  git: /' "${work}/git.err" | head -5; fail "git commit failed."; }

cap 900 git -C "${repo}" push -q origin HEAD:refs/heads/main 2>"${work}/git.err"; rc=$?
if [ "${rc}" -ne 0 ]; then
  sed -e 's/^/  git: /' "${work}/git.err" | head -5
  [ "${rc}" -eq 124 ] && fail "the push to the backup repository timed out." "timeout:push"
  fail "the push to the backup repository was refused (git push exited ${rc}). A deploy key without WRITE access fails exactly here."
fi

echo "pushed: $(git -C "${repo}" log -1 --format=%s)"
echo "::notice::database backup pushed to the private backup repository"
finish ok
