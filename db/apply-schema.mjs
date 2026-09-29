#!/usr/bin/env node
// Накотити db/enrich-schema.sql і db/schema.sql через драйвер — для баз, куди не
// дістати psql (керований Postgres за TLS із власним CA: див. pg-config.mjs).
//
//   node db/apply-schema.mjs [--dsn <url>] [--force]
//   node db/apply-schema.mjs [--dsn <url>] --enrich-only
//
// ПОРЯДОК. Спершу enrich-schema.sql, потім schema.sql — одним викликом, в одній
// транзакції. schema.sql залежить від схеми enrich: в'юхи dash.enrich_* читають
// enrich.profile і enrich.advocate_company, тож на порожній базі без першого файла
// другий упав би на CREATE VIEW. enrich-schema.sql ідемпотентний і нічого не дропає:
// на базі, де збагачення вже зібране, він лише додає нове (таблицю, гранти).
// Порожня база, як і раніше, піднімається ОДНІЄЮ командою.
//
// Три речі, яких не дає `psql -f`:
//   * АТОМАРНІСТЬ. Обидва файли йдуть в одній транзакції: помилка на 1500-му рядку
//     не лишає пів-схеми. psql з ON_ERROR_STOP лише зупиняється — усе виконане
//     до помилки вже закомічене. Саме так і сталося б на Supabase з першою
//     версією файлу, яка падала на ALTER ... OWNER TO посередині.
//   * ЗАПОБІЖНИК. schema.sql починається з DROP SCHEMA ... CASCADE. Тижневі
//     зрізи акаунтів неможливо зібрати повторно, тож на базі, де вони вже є,
//     скрипт відмовляється працювати без --force. Схеми enrich це не стосується:
//     її не дропає ніхто й ніколи, з --force теж — JSON-джерела в неї немає, і
//     база — єдине місце, де ці дані є.
//   * TLS з повною перевіркою — через pgConfig, як і решта db/.
//
// --enrich-only накочує лише enrich-schema.sql: li і dash не чіпає, --force не
// потребує. Це спосіб додати клієнта чи грант у схему enrich на бойовій базі, не
// перезаливаючи дашборди.
//
// psql-метакоманди (рядки з "\") вирізаються: драйвер їх не розуміє, а єдина
// наявна — `\set ON_ERROR_STOP on` — тут замінена транзакцією.
//
// schemaSql() експортується: db/test-roles.mjs піднімає свою тимчасову базу тим
// самим текстом у тому самому порядку, а не власною копією цього правила.
import fs from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { pgConfig } from "./pg-config.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

// Файли в порядку накочування. enrich — ПЕРШИЙ: від нього залежить schema.sql.
export const SCHEMA_FILES = ["enrich-schema.sql", "schema.sql"];

// SQL для порожньої (або наявної) бази одним рядком: без psql-метакоманд, і з
// перевіркою, що жоден файл не керує транзакціями сам.
export function schemaSql({ enrichOnly = false } = {}) {
  const files = enrichOnly ? SCHEMA_FILES.slice(0, 1) : SCHEMA_FILES;
  return files.map((name) => {
    const sql = fs.readFileSync(join(HERE, name), "utf8").split("\n").filter((l) => !/^\\/.test(l)).join("\n");
    if (/^\s*(begin|commit|rollback|start\s+transaction)\s*;/im.test(sql)) {
      throw new Error(`${name} керує транзакціями сам — обгортати його другою не можна. Прибери BEGIN/COMMIT із файлу.`);
    }
    return `-- ---- ${name}\n${sql}`;
  }).join("\n");
}

async function main() {
  const argv = process.argv.slice(2);
  const arg = (name, dflt) => { const i = argv.indexOf(`--${name}`); return i > -1 && argv[i + 1] ? argv[i + 1] : dflt; };
  const DSN = arg("dsn", process.env.LI_DSN || "postgresql://postgres:devpw@localhost:55432/linkedin");
  const FORCE = argv.includes("--force");
  const ENRICH_ONLY = argv.includes("--enrich-only");

  let sql;
  try { sql = schemaSql({ enrichOnly: ENRICH_ONLY }); }
  catch (e) { console.error(e.message); process.exit(2); }

  const c = new pg.Client(pgConfig(DSN, { connectionTimeoutMillis: 20000 }));
  try {
    await c.connect();
    const has = await c.query("select to_regclass('li.account_week') is not null as yes");
    if (has.rows[0].yes && !ENRICH_ONLY) {
      const n = await c.query("select count(*)::int as n from li.account_week");
      if (n.rows[0].n > 0 && !FORCE) {
        console.error(`ВІДМОВА: у li.account_week вже ${n.rows[0].n} тижневих зрізів, а schema.sql дропає схему li.`);
        console.error("Ці зрізи неможливо зібрати повторно. Зроби резервну копію і повтори з --force, якщо справді треба.");
        process.exit(3);
      }
    }
    // Скільки збагачення було ДО: після накочування має бути не менше. Файл
    // нічого не дропає, але «не дропає» — твердження, яке тут перевіряється
    // числом, а не довірою до файла: це єдина копія цих даних.
    const enrichRows = async () => {
      const t = await c.query("select to_regclass('enrich.profile') is not null as yes");
      if (!t.rows[0].yes) return null;
      return (await c.query("select (select count(*) from enrich.profile)::int as profiles, (select count(*) from enrich.visit)::int as visits")).rows[0];
    };
    const before = await enrichRows();
    await c.query("begin");
    await c.query(sql);
    const after = await enrichRows();
    if (before && (after.profiles < before.profiles || after.visits < before.visits)) {
      throw new Error(`enrich втратив би рядки (profile ${before.profiles} -> ${after.profiles}, visit ${before.visits} -> ${after.visits})`);
    }
    await c.query("commit");
    const r = await c.query(`select
        (select count(*) from pg_tables where schemaname = 'li')::int     as li_tables,
        (select count(*) from pg_views  where schemaname = 'dash')::int   as dash_views,
        (select count(*) from pg_tables where schemaname = 'enrich')::int as enrich_tables,
        (select nspowner::regrole::text from pg_namespace where nspname = 'li') as owner`);
    const kept = `${after.profiles} profile(s) and ${after.visits} visit(s) ${before ? "kept" : "(new schema)"}`;
    if (ENRICH_ONLY) console.log(`enrich schema applied: ${r.rows[0].enrich_tables} tables in enrich, ${kept}; li and dash untouched`);
    else {
      console.log(`schema applied: ${r.rows[0].li_tables} tables in li, ${r.rows[0].dash_views} views in dash, owner ${r.rows[0].owner}`);
      console.log(`                ${r.rows[0].enrich_tables} tables in enrich (applied first, never dropped), ${kept}`);
    }
  } catch (e) {
    await c.query("rollback").catch(() => {});
    console.error(`APPLY FAILED — rolled back, nothing changed: ${e.message}`);
    if (e.where) console.error(`  where: ${String(e.where).slice(0, 300)}`);
    process.exitCode = 1;
  } finally {
    await c.end().catch(() => {});
  }
}

// Лише коли файл запущено, а не імпортовано (test-roles.mjs бере звідси schemaSql).
const invoked = process.argv[1] ? fs.realpathSync(process.argv[1]) : "";
if (invoked === fs.realpathSync(fileURLToPath(import.meta.url))) await main();
