#!/usr/bin/env node
// Права ролей — перевірка ДІЄЮ, а не читанням грантів.
//
//   node db/test-roles.mjs [--dsn <owner url>] [--ro-dsn <url>] [--writer-dsn <url>]
//
// Без --ro-dsn/--writer-dsn ролі приміряються через SET ROLE (локальний
// суперюзер це вміє). З ними — справжній вхід цією роллю, як ходитиме Grafana
// чи скрейпер; так це перевіряється на керованій базі, де власник не може SET ROLE.
//
// Чому тест проходить ПО ВСІХ dash-в'юхах, а не по одній: виклики функцій у
// в'юсі перевіряються правами того, хто читає. Перший варіант схеми забрав
// EXECUTE у всіх — і 4 з 30 в'юх падали для grafana_ro, хоча паритет (він іде від
// імені власника) був зелений, а вибіркова перевірка однієї в'юхи проходила.
import pg from "pg";
import { pgConfig } from "./pg-config.mjs";

const argv = process.argv.slice(2);
const arg = (name, dflt) => { const i = argv.indexOf(`--${name}`); return i > -1 && argv[i + 1] ? argv[i + 1] : dflt; };
const OWNER = arg("dsn", process.env.LI_DSN || "postgresql://postgres:devpw@localhost:55432/linkedin");
const RO = arg("ro-dsn", process.env.LI_GRAFANA_RO_DSN || "");
const WRITER = arg("writer-dsn", process.env.LI_WRITER_DSN || "");

let failed = 0;
const ok = (msg) => console.log(`OK    ${msg}`);
const bad = (msg) => { failed++; console.log(`FAIL  ${msg}`); };

async function as(role, dsn, fn) {
  const c = new pg.Client(pgConfig(dsn || OWNER, { connectionTimeoutMillis: 20000 }));
  await c.connect();
  try {
    if (!dsn) await c.query(`set role ${role}`);
    const who = (await c.query("select current_user")).rows[0].current_user;
    if (who !== role) throw new Error(`expected to act as ${role}, acting as ${who}`);
    await fn(c);
  } finally { await c.end().catch(() => {}); }
}
const denied = async (c, label, sql) => {
  try { await c.query(sql); bad(`${label}: allowed, must be refused`); }
  catch (e) { e.code === "42501" ? ok(`${label}: refused`) : bad(`${label}: failed for the wrong reason — ${e.code} ${e.message}`); }
};

await as("grafana_ro", RO, async (c) => {
  const views = (await c.query("select viewname from pg_views where schemaname = 'dash' order by 1")).rows.map((r) => r.viewname);
  if (views.length === 0) bad("no dash views visible to grafana_ro");
  const broken = [];
  for (const v of views) {
    try { await c.query(`select * from dash.${v} limit 1`); }
    catch (e) { broken.push(`${v} (${e.code} ${e.message})`); }
  }
  broken.length ? bad(`grafana_ro cannot read ${broken.length}/${views.length} dash views: ${broken.join("; ")}`)
                : ok(`grafana_ro reads all ${views.length} dash views`);
  await denied(c, "grafana_ro select li.person", "select 1 from li.person limit 1");
  await denied(c, "grafana_ro insert li.author", "insert into li.author(author, name) values ('x', 'x')");
  await denied(c, "grafana_ro create table in dash", "create table dash.nope(i int)");
  await denied(c, "grafana_ro call li.request_week", "select li.request_week('x', '2026-01-05'::date, gen_random_uuid(), 'x')");
});

await as("li_writer", WRITER, async (c) => {
  try { await c.query("select 1 from li.person limit 1"); ok("li_writer reads li"); }
  catch (e) { bad(`li_writer cannot read li: ${e.message}`); }
  await denied(c, "li_writer update", "update li.post set preview = preview where false");
  await denied(c, "li_writer delete", "delete from li.engagement_event where false");
  await denied(c, "li_writer truncate", "truncate li.vip_person");
  await denied(c, "li_writer direct gate insert", "insert into li.week_publication(author, week, run_id, status) values ('x', '2026-01-05', gen_random_uuid(), 'published')");
});

console.log(failed ? `\n${failed} role check(s) FAILED` : "\nall role checks passed");
process.exit(failed ? 1 : 0);
