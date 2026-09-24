# Running the weekly scrape on our own server — handover for the admin

Hand this file to whoever administers the box. It assumes nothing about this
project. Everything below was verified on a clean `debian bookworm` container.

## 1. What the job is

Once a week it collects LinkedIn analytics for a handful of our own company
accounts, writes the numbers into JSON files in a git checkout, and opens a
pull request with them. Three accounts today, about **25 minutes** in total,
sequential, once a week.

**The server never talks to LinkedIn.** The scraper drives a *remote* browser
in the Browserbase cloud over a websocket; LinkedIn sees Browserbase's IP, not
ours. That also means: no Chrome on the box, no X server, no display, no
browser downloads.

**Keep everything else where it is.** Publishing, the database sync, the
Grafana dashboards and the Slack reports all run in GitHub Actions and need
secrets this server should never hold. The server's whole job is: scrape →
commit → open a PR. One command afterwards (`gh workflow run pages-deploy.yml`)
hands the rest back to GitHub.

## 2. Machine

| | |
|---|---|
| OS | any current Linux x86_64 (verified on Debian 12) |
| CPU / RAM | 1 vCPU, 1 GB is enough — the browser is remote |
| Disk | ~1 GB: checkout ≈ 210 MB (incl. `.git`) plus `node_modules` |
| Packages | `nodejs` 22, `npm`, `python3` ≥ 3.11 + `python3-venv`, `git`, `jq`, `gh` (GitHub CLI) |
| Browser | **none** — do not install Chrome and do not run `playwright install` |
| Clock | UTC, NTP on. The week is an ISO Monday; a drifting clock files data under the wrong week |

Outbound HTTPS to exactly these hosts (nothing else is needed, and nothing
listens on the box):

```
api.browserbase.com:443        REST: create sessions and contexts
connect.browserbase.com:443    websocket: drive the remote browser
github.com:443, api.github.com:443   clone, push a branch, open a PR
slack.com:443                  optional, only if this server posts the report
```

## 3. What we hand over, and what we do NOT

| Give | Why | If it leaks |
|---|---|---|
| `BROWSERBASE_API_KEY`, `BROWSERBASE_PROJECT_ID` | create the remote browser sessions | someone can open our colleagues' logged-in LinkedIn sessions — **treat as a password**, rotate in the Browserbase dashboard |
| `scripts/lifleet/authors.json` | maps account slug → cloud profile id | same as above; without it nothing can run |
| a GitHub token | push a branch, open the PR | fine-grained, **one repository**, only `contents: write` + `pull requests: write`. Not a personal classic token |
| `SLACK_BOT_TOKEN`, `SLACK_CHANNEL_ID`, `SLACK_PEOPLE_JSON` | optional: post the weekly result | a bot that can only write in one channel |

Deliberately **not** on this server: any database connection string, the
Grafana token, the datasource uid. Nothing here needs them, and the database
owner credentials must never reach an automated host.

All of it goes in one file, `.env`, owned by the service user, mode `600`.
Never on a command line (`ps` shows arguments to everyone) and never in a
shell history.

## 4. Install

```bash
sudo adduser --system --group --home /opt/li linkedin-stats
sudo -u linkedin-stats -H bash
cd /opt/li
git clone https://github.com/speedandfunction/LinkedInStatistic.git repo   # public
cd repo
(cd .claude/skills/linkedin-stats/fast && npm install --no-audit --no-fund)  # 1 package
python3 -m venv /opt/li/venv && /opt/li/venv/bin/pip install -e scripts/lifleet
install -m 600 /dev/null /opt/li/repo/.env      # then paste the values into it
gh auth login --with-token < /path/to/token     # the fine-grained token
git config user.name  "linkedin-stats bot"
git config user.email "linkedin-stats@speedandfunction.com"
```

`scripts/lifleet/authors.json` is gitignored — copy it in by hand (shape:
`scripts/lifleet/authors.example.json`).

## 5. What to schedule

Mirror what GitHub does today: one scrape per account, sequentially, then
commit and open a PR. Weekly, Monday, early morning UTC.

```cron
# m h dom mon dow
0 3 * * 1 cd /opt/li/repo && set -a && . ./.env && set +a && ./ops/weekly.sh >> /var/log/linkedin-stats.log 2>&1
```

`ops/weekly.sh` is in the repository and is what the cron line above runs. It
scrapes each account in turn, then commits, pushes a branch, opens the PR,
merges it when every account came back clean, and dispatches `pages-deploy` so
GitHub publishes and syncs the database. Nothing else to write.

- **Read it before you trust it** — it is ~110 lines of bash and refuses early:
  no `jq`/`gh`, no keys, no registry, no accounts → it says which and stops.
- `DRY_RUN=1 ./ops/weekly.sh` lists what it would do and touches nothing.
  `AUTHORS="peter maria" ./ops/weekly.sh` runs a subset.
- Budgets (override by environment): 1500 s soft deadline per account, 2100 s
  hard kill, 60 s pause between accounts, 90 min for the whole run.
- Exit codes it reports per account: `0` clean, `11` fine (a reaction list was
  incomplete, re-read next run), `10` partial, `20` **logged out of LinkedIn**
  (that account needs a re-invite from the operator), `22` rate-limited, `30`
  **LinkedIn changed its markup** (needs a code fix; every later week fails the
  same way until then).
- It exits non-zero unless the whole week landed, so cron mails you. And it
  checks the FILE, not the exit code: an account that wrote no
  `weeks[<monday>]` entry is a failure even if the scraper said 0.
- The week key is the ISO Monday of the current week, computed by the same
  formula the workflow uses. (`date -d 'last monday'` is wrong here: GNU date
  excludes today, so a Monday run would file everything under the previous
  Monday.)

There is also `.claude/skills/linkedin-stats/run-weekly.sh`, the full driver
with retries and self-repair — but it additionally requires the `claude` CLI
installed and signed in on the server. Start without it.

**If this server takes over the weekly run, turn off the GitHub schedule**
(`.github/workflows/linkedin-stats-weekly.yml`, the `schedule:` block).
Otherwise both scrape the same accounts at the same time, fight over the same
branch, and burn double the Browserbase minutes.

## 6. Check after installing (no secrets needed for the first two)

```bash
node -v && python3 -V && git --version && jq --version && gh --version   # 1. tools
(cd scripts/lifleet && /opt/li/venv/bin/python -m lifleet list)          # 2. registry: one line per account
set -a && . ./.env && set +a                                            # 3. load the keys
(cd scripts/lifleet && /opt/li/venv/bin/python -m lifleet check)         # 4. are the accounts still logged in
```

Run one account by hand before trusting the cron. If a variable is missing,
the first line of the error names it — read the first line, not the stack.

## 7. Security notes

- The Browserbase key plus the registry equals **live control of a colleague's
  logged-in LinkedIn**. That is the sensitivity level of this box.
- Login links (Browserbase "Live View") must never be written to a log file
  that anyone else can read. Our scripts keep them out of the tracked tree;
  do not add logging that prints them.
- The repository is public. Nothing from `.env` may ever be committed.
- No inbound ports. The job only makes outbound connections.

## 8. What "broken" looks like

The run is silent when it works, so plan for the failure mode where **nothing
runs at all**: cron did not fire, the token expired, the disk filled. A missing
weekly PR is the signal — the account snapshot for that week cannot be
collected later, so a silent week is a permanent hole in the data.

Ask for: the cron log shipped somewhere readable, an alert if the job has not
finished by Monday noon UTC, and disk-usage monitoring on `/opt/li`.
