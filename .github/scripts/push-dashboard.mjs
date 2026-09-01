#!/usr/bin/env node
// Push a checked-in Grafana dashboard snapshot to the live instance, or dump
// the live one back to disk. Same transport as update-post-variable.mjs
// (GET /api/dashboards/uid/<uid> -> POST /api/dashboards/db, overwrite:true),
// so every dashboard change stays a scripted API call with an audit trail —
// never a click in the Grafana UI.
//
//   node .github/scripts/push-dashboard.mjs --uid linkedin-stats --dump dashboards/grafana/linkedin-stats.json
//   node .github/scripts/push-dashboard.mjs --uid linkedin-stats --file dashboards/grafana/linkedin-stats.json
//   ... --file <path> --dry-run     # print what would change, push nothing
//
// Requires GRAFANA_SERVICE_ACCOUNT_TOKEN and GRAFANA_URL.

import { readFileSync, writeFileSync } from "node:fs";

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}
const has = (name) => process.argv.includes(`--${name}`);

const GRAFANA_URL = (process.env.GRAFANA_URL ?? "").replace(/\/+$/, "");
const TOKEN = process.env.GRAFANA_SERVICE_ACCOUNT_TOKEN;
const uid = arg("uid");
const file = arg("file");
const dump = arg("dump");

if (!TOKEN) { console.error("GRAFANA_SERVICE_ACCOUNT_TOKEN is not set"); process.exit(2); }
if (!GRAFANA_URL) { console.error("GRAFANA_URL is not set"); process.exit(2); }
if (!uid || (!file && !dump)) {
  console.error("usage: push-dashboard.mjs --uid <uid> (--file <snapshot.json> [--dry-run] | --dump <out.json>)");
  process.exit(2);
}

async function api(path, init = {}) {
  const res = await fetch(GRAFANA_URL + path, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} -> ${res.status}: ${body.slice(0, 300)}`);
  return body ? JSON.parse(body) : {};
}

// Дашборда може ще не існувати (новий автор) — тоді GET дає 404, і це не
// помилка, а сигнал «створити новий».
let live = {};
try {
  live = await api(`/api/dashboards/uid/${uid}`);
} catch (e) {
  if (!/-> 404/.test(String(e.message))) throw e;
  console.error(`no live dashboard for ${uid} — creating new`);
}

if (dump) {
  writeFileSync(dump, JSON.stringify(live.dashboard, null, 2) + "\n");
  console.error(`dumped ${uid} -> ${dump} (version ${live.dashboard?.version ?? "?"}, ${live.dashboard?.panels?.length ?? 0} panels)`);
  process.exit(0);
}

const snapshot = JSON.parse(readFileSync(file, "utf8"));
// Keep the server's identity fields — a snapshot that carries a stale version
// or a null id would either 412 or fork a second dashboard.
const dashboard = { ...snapshot, uid, id: live.dashboard?.id ?? null, version: live.dashboard?.version };

console.error(`live: ${live.dashboard?.panels?.length ?? 0} panels (version ${live.dashboard?.version})`);
console.error(`file: ${snapshot.panels?.length ?? 0} panels`);

if (has("dry-run")) { console.error("dry run — nothing pushed"); process.exit(0); }

const out = await api("/api/dashboards/db", {
  method: "POST",
  body: JSON.stringify({
    dashboard,
    folderUid: live.meta?.folderUid || undefined,
    message: arg("message") || `auto: push ${file}`,
    overwrite: true,
  }),
});
console.error(`pushed ${uid} -> version ${out.version} (${out.status})`);
