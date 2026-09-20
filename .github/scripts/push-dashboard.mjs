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
//
// The repository is public, so the checked-in dashboards never carry the uid
// of the Postgres datasource: they carry the placeholder ${DS_LINKEDIN_PG}.
// --file swaps it for GRAFANA_PG_DATASOURCE_UID just before the POST (and
// refuses to push if the file has the placeholder but the variable is missing
// or malformed); --dump swaps the real uid back — and REFUSES, writing nothing,
// when the live dashboard reads Postgres and the variable is missing: without
// the uid in hand only the { type, uid } form can be recognised, and a type-less
// { uid }, a legacy "datasource": "<uid>" string or a uid quoted in a link would
// be written to the file as they are. Both directions need the variable.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PG_DS_PLACEHOLDER = "${DS_LINKEDIN_PG}";
export const PG_DS_TYPE = "grafana-postgresql-datasource";
// A Grafana uid. Anything else (a quote, a space, a stray newline from a
// pasted secret) is refused rather than spliced into the dashboard JSON.
const PG_UID_RE = /^[A-Za-z0-9_-]+$/;

// Error messages below never quote the uid: they end up in CI logs, and CI
// logs of a public repository are public too.

// File text -> the text to push. A file without the placeholder (the Infinity
// leftovers) comes back untouched and needs no variable at all.
export function placeholderToUid(text, pgUid) {
  if (!text.includes(PG_DS_PLACEHOLDER)) return text;
  if (!pgUid) {
    throw new Error(`the dashboard reads Postgres (${PG_DS_PLACEHOLDER}) but GRAFANA_PG_DATASOURCE_UID is not set — nothing pushed`);
  }
  if (!PG_UID_RE.test(pgUid)) {
    throw new Error(`GRAFANA_PG_DATASOURCE_UID is not a datasource uid (expected ${PG_UID_RE}, check for stray whitespace) — nothing pushed`);
  }
  return text.replaceAll(PG_DS_PLACEHOLDER, () => pgUid);
}

// Does this dashboard read Postgres at all? A typed reference, or a target that
// carries rawSql (which is how a panel looks when its reference is type-less or
// the legacy string). The Infinity leftovers answer no and dump as before.
export function readsPostgres(dashboard) {
  let yes = false;
  JSON.parse(JSON.stringify(dashboard ?? null), (_key, value) => {
    if (value && typeof value === "object" && (value.type === PG_DS_TYPE || typeof value.rawSql === "string")) yes = true;
    return value;
  });
  return yes;
}

// Names Grafana itself uses in the legacy string form — not uids of ours.
const BUILTIN_DS = /^-- (?:Grafana|Mixed|Dashboard) --$/;

// Live dashboard object -> a copy that is safe to write into the repo.
//
// A dashboard that reads Postgres is dumped ONLY with the variable set. The uid
// is recognisable without it in one form out of several — { type, uid } — and the
// others (a type-less { uid }, "datasource": "<uid>", the uid inside a link or a
// description) would go to disk untouched, in a public repository. With the
// variable: every typed reference gets the placeholder, every string that IS the
// uid is swapped, a uid buried in a longer string is a refusal — and so is a
// `datasource` that is still untyped afterwards (the variable may hold the uid of
// ANOTHER datasource; an untyped reference cannot be told apart from ours).
export function uidToPlaceholder(dashboard, pgUid) {
  if (pgUid && !PG_UID_RE.test(pgUid)) {
    throw new Error(`GRAFANA_PG_DATASOURCE_UID is not a datasource uid (expected ${PG_UID_RE}, check for stray whitespace) — nothing dumped`);
  }
  const pg = readsPostgres(dashboard);
  if (pg && !pgUid) {
    throw new Error("the live dashboard reads Postgres but GRAFANA_PG_DATASOURCE_UID is not set — nothing dumped (without it the datasource uid cannot be recognised in every place it can appear)");
  }
  const out = JSON.parse(JSON.stringify(dashboard), (_key, value) => {
    if (value && typeof value === "object" && value.type === PG_DS_TYPE && typeof value.uid === "string") {
      value.uid = PG_DS_PLACEHOLDER;
    }
    return pgUid && value === pgUid ? PG_DS_PLACEHOLDER : value;
  });
  if (pgUid && JSON.stringify(out).includes(pgUid)) {
    throw new Error("the datasource uid still appears inside the dashboard after the swap (as part of a longer string) — nothing dumped");
  }
  if (pg) {
    let untyped = 0;
    JSON.parse(JSON.stringify(out), (key, value) => {
      if (key !== "datasource" || value === null || value === undefined) return value;
      const ref = typeof value === "string" ? value : (typeof value === "object" && !value.type ? value.uid : null);
      if (typeof ref === "string" && ref !== PG_DS_PLACEHOLDER && !BUILTIN_DS.test(ref) && !ref.startsWith("$")) untyped++;
      return value;
    });
    if (untyped) {
      throw new Error(`${untyped} datasource reference(s) have no type and are not the uid in GRAFANA_PG_DATASOURCE_UID — they may be another Postgres datasource's uid — nothing dumped`);
    }
  }
  return out;
}

async function main() {
  function arg(name) {
    const i = process.argv.indexOf(`--${name}`);
    return i > -1 ? process.argv[i + 1] : undefined;
  }
  const has = (name) => process.argv.includes(`--${name}`);

  const GRAFANA_URL = (process.env.GRAFANA_URL ?? "").replace(/\/+$/, "");
  const TOKEN = process.env.GRAFANA_SERVICE_ACCOUNT_TOKEN;
  const PG_UID = process.env.GRAFANA_PG_DATASOURCE_UID;
  const uid = arg("uid");
  const file = arg("file");
  const dump = arg("dump");

  if (!TOKEN) { console.error("GRAFANA_SERVICE_ACCOUNT_TOKEN is not set"); process.exit(2); }
  if (!GRAFANA_URL) { console.error("GRAFANA_URL is not set"); process.exit(2); }
  if (!uid || (!file && !dump)) {
    console.error("usage: push-dashboard.mjs --uid <uid> (--file <snapshot.json> [--dry-run] | --dump <out.json>)");
    process.exit(2);
  }

  // Resolve the placeholder BEFORE the first request: a refusal must not have
  // touched Grafana at all, and --dry-run should refuse exactly when the real
  // push would.
  let snapshot;
  if (!dump) {
    const text = readFileSync(file, "utf8");
    try {
      // Parse the file as committed first: a syntax error then quotes the
      // public text, never a snippet that already holds the uid.
      JSON.parse(text);
      snapshot = JSON.parse(placeholderToUid(text, PG_UID));
    } catch (e) {
      console.error(`${file}: ${e.message}`);
      process.exit(2);
    }
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
    if (!live.dashboard) { console.error(`no live dashboard for ${uid} — nothing to dump`); process.exit(1); }
    let safe;
    try {
      safe = uidToPlaceholder(live.dashboard, PG_UID);
    } catch (e) {
      console.error(`${dump}: ${e.message}`);
      process.exit(2);
    }
    writeFileSync(dump, JSON.stringify(safe, null, 2) + "\n");
    console.error(`dumped ${uid} -> ${dump} (version ${live.dashboard?.version ?? "?"}, ${live.dashboard?.panels?.length ?? 0} panels)`);
    process.exit(0);
  }

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
}

// Importing this file (the tests do) must not run the CLI.
const IS_MAIN = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (IS_MAIN) await main();
