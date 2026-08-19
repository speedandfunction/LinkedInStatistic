#!/usr/bin/env node
// Regenerates the $post Custom-variable list on the linkedin-post Grafana
// dashboard from dashboards/li-stats/posts/*.json, so every published week
// automatically surfaces new posts in the picker. The variable must stay a
// Custom (static) list — Query variables silently fail to populate in
// Grafana 12 v0alpha1 dashboards — so someone has to push the list; that
// someone is the Pages publish jobs (linkedin-stats-weekly.yml publish job
// + pages-deploy.yml), keeping the picker exactly in sync with the
// stats.json the panels read.
//
// Env: GRAFANA_SERVICE_ACCOUNT_TOKEN and GRAFANA_URL (both required).
// Optional --snapshot <path> also rewrites
// the templating block of the checked-in dashboard export.

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const POSTS_DIR = join(REPO_ROOT, "dashboards", "li-stats", "posts");
const DASHBOARD_UID = "linkedin-post";
const VAR_NAME = "post";

const GRAFANA_URL = (process.env.GRAFANA_URL ?? "").replace(/\/+$/, "");
const TOKEN = process.env.GRAFANA_SERVICE_ACCOUNT_TOKEN;
if (!TOKEN) {
  console.error("GRAFANA_SERVICE_ACCOUNT_TOKEN is not set");
  process.exit(2);
}
if (!GRAFANA_URL) {
  console.error("GRAFANA_URL is not set");
  process.exit(2);
}

let snapshotPath = null;
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--snapshot" && argv[i + 1]) snapshotPath = resolve(argv[++i]);
}

// Display text lives inside a "label : value, label : value" query string, so
// commas and colons in the post text would corrupt the option parsing.
function displayText(d) {
  const body = (d.text ?? d.preview ?? "").replace(/\s+/g, " ").replace(/[,:]/g, "").trim();
  const prefix = [...body].slice(0, 60).join("").trimEnd(); // code-point slice — UTF-16 slice can split an emoji
  return `${d.posted_date} — ${prefix}`;
}

const entries = readdirSync(POSTS_DIR)
  .filter(f => f.endsWith(".json"))
  .map(f => JSON.parse(readFileSync(join(POSTS_DIR, f), "utf8")))
  .filter(d => d.id && d.posted_date)
  .sort((a, b) => b.posted_date.localeCompare(a.posted_date) || b.id.localeCompare(a.id))
  .map(d => ({ text: displayText(d), value: d.id }));

if (!entries.length) {
  console.error(`no posts found in ${POSTS_DIR}`);
  process.exit(2);
}

const query = entries.map(e => `${e.text} : ${e.value}`).join(", ");
const options = entries.map((e, i) => ({ selected: i === 0, text: e.text, value: e.value }));
const current = { text: entries[0].text, value: entries[0].value };

function patchVariable(dashboard) {
  const v = (dashboard.templating?.list ?? []).find(x => x.name === VAR_NAME);
  if (!v) throw new Error(`variable "${VAR_NAME}" not found on dashboard`);
  const changed = v.query !== query;
  v.query = query;
  v.options = options;
  v.current = current;
  return changed;
}

async function api(path, init = {}) {
  const res = await fetch(`${GRAFANA_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
  });
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} -> ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

const { dashboard, meta } = await api(`/api/dashboards/uid/${DASHBOARD_UID}`);
const changed = patchVariable(dashboard);
if (changed) {
  await api("/api/dashboards/db", {
    method: "POST",
    body: JSON.stringify({
      dashboard,
      folderUid: meta?.folderUid || undefined,
      message: `auto: refresh $post variable (${entries.length} posts, newest ${entries[0].value})`,
      overwrite: true,
    }),
  });
  console.error(`updated $post variable — ${entries.length} posts, newest ${entries[0].text}`);
} else {
  console.error(`$post variable already up to date — ${entries.length} posts`);
}

if (snapshotPath) {
  const snap = JSON.parse(readFileSync(snapshotPath, "utf8"));
  patchVariable(snap);
  writeFileSync(snapshotPath, JSON.stringify(snap, null, 2) + "\n");
  console.error(`snapshot refreshed — ${snapshotPath}`);
}
