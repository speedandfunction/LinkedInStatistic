# Handover: taking over LinkedInStatistic

Two readers: the **outgoing operator** (the checklist in §6) and the **incoming
operator** (everything else). This file holds names only, never values — no
keys, DSNs, tokens or Slack IDs belong here, and the repo is public.

## 1. What runs, and where

Everything scheduled runs in GitHub Actions. There is no server and no cron or
launchd job on anyone's laptop, and CI needs no Claude/Anthropic credential
(the `.claude/skills/` are for interactive local use only).

| What | When | Workflow |
|---|---|---|
| Scrape every active author, open a PR | Mon 00:00 UTC | `linkedin-stats-weekly.yml` |
| Session check (are the LinkedIn logins still alive), plus a database keep-alive | daily 07:00 UTC | `linkedin-session-check.yml` |
| Publish to Pages, sync into Postgres, back up | after a merged week, or by hand | `pages-deploy.yml` |

The keep-alive matters: the managed Postgres pauses idle projects, and the
daily session check is what keeps it awake. Do not disable that workflow.

Roster (`.claude/skills/linkedin-stats/profiles.json`): one author is scraped
today; two are `retired` (their data and dashboards stay, they are no longer
visited). One more slug sits in the login registry without a login yet.

## 2. What lives only on the outgoing operator's machine

None of this is in git, and **none of it can be read back from GitHub**
(secrets are write-only).

| File | Holds | If lost |
|---|---|---|
| `scripts/lifleet/authors.json` | registry: author slug → Browserbase `context_id` | a copy exists in the secret `LIFLEET_AUTHORS_JSON`, but only CI can read it. Lose both and every author must log in again |
| `scripts/lifleet/.env` | Browserbase API key, project id, region | issue a new key in the Browserbase dashboard |
| `.env` (repo root) | Grafana URL + token, folder/datasource uids, the database DSNs, `LI_OPT_OUT` | new Grafana service-account token; database role passwords from the Supabase side (`db/README.md`) |

Shapes: `.env.example`, `scripts/lifleet/.env.example`,
`scripts/lifleet/authors.example.json` (fake values on purpose).

Hand these over through a password manager, never chat or email. Better still,
issue the successor **their own** Grafana service account and Browserbase key,
then revoke the old ones — a leak then costs one key, not the whole setup.

## 3. Accounts and who owns them

The repo cannot tell you who owns these. **Fill in the last column before the
handover**; anything on a personal account has to be moved or recreated.

| Service | Used for | Names (CI secret / variable) | Owner |
|---|---|---|---|
| GitHub repo | code, Actions, Pages, the secrets | several admins; `GITHUB_TOKEN` is automatic | |
| Browserbase | the remote browser; holds each author's logged-in LinkedIn session | `BROWSERBASE_API_KEY`, `BROWSERBASE_PROJECT_ID`, `LIFLEET_AUTHORS_JSON` | |
| Supabase (Postgres) | project `linkedin-stats`, region `eu-central-1` | `LI_SYNC_DATABASE_URL`, `LI_BACKUP_DATABASE_URL` | |
| Grafana | dashboards reading Postgres | `GRAFANA_SERVICE_ACCOUNT_TOKEN`, var `GRAFANA_URL` | |
| Slack app | weekly report, session alerts, channel `#linkedin-session-bot` | `SLACK_BOT_TOKEN`, var `SLACK_CHANNEL_ID`, `SLACK_PEOPLE_JSON` | |
| Backups | dumps pushed to a private backup repo | `LI_BACKUP_DEPLOY_KEY` (see "Резервна копія" in `db/README.md`) | |

The LinkedIn accounts belong to the people being tracked. Their logins live as
cookies in Browserbase and only they can renew them (password and 2FA), via the
live-view link `lifleet invite <slug>` produces.

## 4. People the bot pings

`SLACK_PEOPLE_JSON` maps names to Slack member IDs. Only the `_operator` entry
is ever tagged — on a failed or partial run. Authors are never tagged.
**It must point at the current operator**; otherwise failures page someone who
no longer reads them. Which of the secret and the variable of that name is
authoritative: `WEEKLY-CADENCE.md` §2.

## 5. Routine duties

- **Clean Monday:** nothing to do. The PR merges itself and publishes.
- **Not clean** (an author partial, rate-limited, logged out, …): the data
  waits on an open PR and the operator is tagged in Slack. Review it, merge it,
  then publish: `gh workflow run pages-deploy.yml --repo speedandfunction/LinkedInStatistic --ref main`.
  How to read a run: `WEEKLY-CADENCE.md` §8.
- **A LinkedIn login dies:** the daily check posts a re-login link; the author
  logs in. Recovery drill: §6 of `WEEKLY-CADENCE.md`.
- **Adding or retiring an author:** §5 of `WEEKLY-CADENCE.md` and its
  "Retiring a person" paragraph. Land the `profiles.json` change on `main`
  **before** touching the registry secret, or the preflight fails the whole run.

## 6. Checklist for the outgoing operator

- [ ] Successor has write access to the repo and permission to run workflows.
- [ ] The three local files in §2 handed over; successor ran
      `lifleet list` from `scripts/lifleet/` and sees the same author slugs.
- [ ] Successor holds **their own** Browserbase key and Grafana service-account
      token; yours are revoked.
- [ ] The Owner column in §3 is filled in, and nothing important sits on a
      personal account.
- [ ] `_operator` in `SLACK_PEOPLE_JSON` is the successor's Slack ID.
- [ ] Successor started one manual run (`WEEKLY-CADENCE.md` §7) and read the
      result (§8).

## 7. Getting a machine running

Install steps, the four read-only checks that prove the setup (registry,
database parity, every Grafana panel, Grafana token) and the file list:
`.claude/skills/linkedin-stats/MOVING-MACHINES.md` (in Ukrainian), §2 and §3.

## 8. Where the detail lives

| Topic | File |
|---|---|
| The weekly run, secrets table, recovery drill, health reading | `.claude/skills/linkedin-stats/WEEKLY-CADENCE.md` |
| Moving to another machine | `.claude/skills/linkedin-stats/MOVING-MACHINES.md` |
| Running the scrape on your own server instead | `.claude/skills/linkedin-stats/SERVER-HANDOVER.md` |
| Login registry (lifleet) | `scripts/lifleet/START-HERE.md`, `scripts/lifleet/DECISIONS.md` |
| Database, roles, backups, restore drill | `db/README.md` |
| Past incidents | `doc/incidents/` |
