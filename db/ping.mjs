#!/usr/bin/env node
// The keep-alive touch. One connection, one tiny read, nothing written.
//
//   LI_DSN=<li_sync dsn> node db/ping.mjs
//
// WHY. The weekly sync runs on `cron: 0 0 * * 1` — exactly 7 days apart — and the
// Supabase free tier pauses a project after 7 days without activity. Left alone,
// the two line up: the project goes to sleep just before the one run a week that
// needs it, and "the database did not answer" becomes the normal Monday. The
// daily linkedin-session-check workflow runs this, so the idle clock never gets
// past one day. It does not replace the Slack line for a paused project — it
// makes that line rare.
//
// Exit 0 = the database answered. Exit 1 = it did not (shape of the error only —
// this log is public). Exit 2 = LI_DSN missing in CI (pg-config.mjs).
// Prints counts only: how many import runs the database has seen.

import pg from "pg";
import { pgConfig, resolveDsn } from "./pg-config.mjs";
import { safeError } from "./safe-log.mjs";

const DSN = resolveDsn(null);
const client = new pg.Client(pgConfig(DSN, { connectionTimeoutMillis: 20000, query_timeout: 20000 }));
// A server that goes away mid-flight would otherwise be an unhandled 'error'
// event: a stack trace with the host in it.
client.on("error", () => {});
try {
  await client.connect();
  const { rows } = await client.query("select count(*)::int as n from li.import_run");
  console.log(`ping ok — ${rows[0].n} import run(s) on record`);
  await client.end();
} catch (e) {
  console.error("PING FAILED:", safeError(e, { dsn: DSN }));
  await client.end().catch(() => {});
  process.exit(1);
}
