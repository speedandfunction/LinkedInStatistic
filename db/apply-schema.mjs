#!/usr/bin/env node
// Накотити db/schema.sql через драйвер — для баз, куди не дістати psql
// (керований Postgres за TLS із власним CA: див. pg-config.mjs).
//
//   node db/apply-schema.mjs [--dsn <url>] [--force]
//
// Три речі, яких не дає `psql -f`:
//   * АТОМАРНІСТЬ. Увесь файл іде в одній транзакції: помилка на 1500-му рядку
//     не лишає пів-схеми. psql з ON_ERROR_STOP лише зупиняється — усе виконане
//     до помилки вже закомічене. Саме так і сталося б на Supabase з першою
//     версією файлу, яка падала на ALTER ... OWNER TO посередині.
//   * ЗАПОБІЖНИК. schema.sql починається з DROP SCHEMA ... CASCADE. Тижневі
//     зрізи акаунтів неможливо зібрати повторно, тож на базі, де вони вже є,
//     скрипт відмовляється працювати без --force.
//   * TLS з повною перевіркою — через pgConfig, як і решта db/.
//
// psql-метакоманди (рядки з "\") вирізаються: драйвер їх не розуміє, а єдина
// наявна — `\set ON_ERROR_STOP on` — тут замінена транзакцією.
import fs from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { pgConfig } from "./pg-config.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (name, dflt) => { const i = argv.indexOf(`--${name}`); return i > -1 && argv[i + 1] ? argv[i + 1] : dflt; };
const DSN = arg("dsn", process.env.LI_DSN || "postgresql://postgres:devpw@localhost:55432/linkedin");
const FORCE = argv.includes("--force");

const raw = fs.readFileSync(join(HERE, "schema.sql"), "utf8");
const sql = raw.split("\n").filter((l) => !/^\\/.test(l)).join("\n");
if (/^\s*(begin|commit|rollback|start\s+transaction)\s*;/im.test(sql)) {
  console.error("schema.sql керує транзакціями сам — обгортати його другою не можна. Прибери BEGIN/COMMIT із файлу.");
  process.exit(2);
}

const c = new pg.Client(pgConfig(DSN, { connectionTimeoutMillis: 20000 }));
try {
  await c.connect();
  const has = await c.query("select to_regclass('li.account_week') is not null as yes");
  if (has.rows[0].yes) {
    const n = await c.query("select count(*)::int as n from li.account_week");
    if (n.rows[0].n > 0 && !FORCE) {
      console.error(`ВІДМОВА: у li.account_week вже ${n.rows[0].n} тижневих зрізів, а schema.sql дропає схему li.`);
      console.error("Ці зрізи неможливо зібрати повторно. Зроби резервну копію і повтори з --force, якщо справді треба.");
      process.exit(3);
    }
  }
  await c.query("begin");
  await c.query(sql);
  await c.query("commit");
  const r = await c.query(`select
      (select count(*) from pg_tables where schemaname = 'li')::int   as li_tables,
      (select count(*) from pg_views  where schemaname = 'dash')::int as dash_views,
      (select nspowner::regrole::text from pg_namespace where nspname = 'li') as owner`);
  console.log(`schema applied: ${r.rows[0].li_tables} tables in li, ${r.rows[0].dash_views} views in dash, owner ${r.rows[0].owner}`);
} catch (e) {
  await c.query("rollback").catch(() => {});
  console.error(`APPLY FAILED — rolled back, nothing changed: ${e.message}`);
  if (e.where) console.error(`  where: ${String(e.where).slice(0, 300)}`);
  process.exitCode = 1;
} finally {
  await c.end().catch(() => {});
}
