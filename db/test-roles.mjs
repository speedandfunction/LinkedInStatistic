#!/usr/bin/env node
// Права ролей — перевірка ДІЄЮ, а не читанням грантів.
//
//   node db/test-roles.mjs [--dsn <owner url>]
//        [--ro-dsn <url>] [--writer-dsn <url>] [--sync-dsn <url>] [--backup-dsn <url>]
//        [--no-scratch] [--keep]
//
// DSN-и беруться з прапорців або з env: LI_DSN (власник), LI_GRAFANA_RO_DSN,
// LI_WRITER_DSN, LI_SYNC_DSN, LI_BACKUP_DSN.
//
// ДВА РЕЖИМИ ПРИМІРКИ РОЛІ.
//   * З DSN ролі — справжній вхід цією роллю, як ходитиме Grafana, скрейпер чи CI.
//     Так це перевіряється на керованій базі, де власник не може SET ROLE, і так
//     воно найближче до бойового: session_user теж роль, а не власник.
//   * Без DSN — SET ROLE від імені власника (локальний суперюзер це вміє). Для
//     імпортера, який є окремим процесом, SET ROLE їде в DSN як
//     `options=-c role=li_sync`: привілеї перевіряються за current_user, тож
//     відмови ті самі; відрізняється лише session_user у decided_by.
//
// ДВІ ЧАСТИНИ.
//   A. На базі з --dsn, нічого не змінюючи: кожна роль читає те, що їй належить, і
//      дістає відмову на все зайве. Годинник: пін однієї сесії не видно іншій.
//   B. На ТИМЧАСОВІЙ базі, яку тест створює і видаляє сам (--no-scratch вимикає):
//      справжній `import.mjs --publish` від імені li_sync — на порожній базі
//      (перший синк), повторно (усталений стан, 0 рядків), на виправленому корпусі
//      (перевидання тижня), потім `verify.mjs` тією ж роллю; `--reset` мусить бути
//      ВІДМОВЛЕНИЙ; семантика li.publish_run / p_takeover.
//
// Чому тест проходить ПО ВСІХ dash-в'юхах, а не по одній: виклики функцій у
// в'юсі перевіряються правами того, хто читає. Перший варіант схеми забрав
// EXECUTE у всіх — і 4 з 30 в'юх падали для grafana_ro, хоча паритет (він іде від
// імені власника) був зелений, а вибіркова перевірка однієї в'юхи проходила.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { pgConfig, resolveDsn } from "./pg-config.mjs";
import { openDb } from "./export.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const argv = process.argv.slice(2);
const arg = (name, dflt) => { const i = argv.indexOf(`--${name}`); return i > -1 && argv[i + 1] ? argv[i + 1] : dflt; };
const OWNER = resolveDsn(arg("dsn"));
const DSN_OF = {
  grafana_ro: arg("ro-dsn", process.env.LI_GRAFANA_RO_DSN || ""),
  li_writer: arg("writer-dsn", process.env.LI_WRITER_DSN || ""),
  li_sync: arg("sync-dsn", process.env.LI_SYNC_DSN || ""),
  li_backup: arg("backup-dsn", process.env.LI_BACKUP_DSN || ""),
};

let failed = 0;
const ok = (msg) => console.log(`OK    ${msg}`);
const bad = (msg) => { failed++; console.log(`FAIL  ${msg}`); };
const check = (cond, msg, extra = "") => (cond ? ok(msg) : bad(`${msg}${extra ? ` — ${extra}` : ""}`));

const swapDb = (dsn, db) => { const u = new URL(dsn); u.pathname = `/${db}`; return u.toString(); };
const withRole = (dsn, role) => { const u = new URL(dsn); u.searchParams.set("options", `-c role=${role}`); return u.toString(); };
// DSN, яким окремий процес (імпортер, verify) заходить як `role` у базу `db`.
const dsnFor = (role, db) => (DSN_OF[role] ? swapDb(DSN_OF[role], db) : withRole(swapDb(OWNER, db), role));
const mode = (role) => (DSN_OF[role] ? "login" : "SET ROLE");

async function as(role, db, fn) {
  const dsn = DSN_OF[role];
  const base = dsn || OWNER;
  const c = new pg.Client(pgConfig(db ? swapDb(base, db) : base, { connectionTimeoutMillis: 20000 }));
  await c.connect();
  try {
    if (!dsn) await c.query(`set role ${role}`);
    const who = (await c.query("select current_user")).rows[0].current_user;
    if (who !== role) throw new Error(`expected to act as ${role}, acting as ${who}`);
    await fn(c);
  } finally { await c.end().catch(() => {}); }
}
async function asOwner(db, fn) {
  const c = new pg.Client(pgConfig(db ? swapDb(OWNER, db) : OWNER, { connectionTimeoutMillis: 20000 }));
  await c.connect();
  try { return await fn(c); } finally { await c.end().catch(() => {}); }
}
// Відмова мусить бути саме відмовою в правах (42501), а не помилкою синтаксису,
// яка теж «не дала» — і нічого б не довела.
const denied = async (c, label, sql) => {
  try { await c.query("begin"); await c.query(sql); await c.query("rollback"); bad(`${label}: allowed, must be refused`); }
  catch (e) {
    await c.query("rollback").catch(() => {});
    e.code === "42501" ? ok(`${label}: refused`) : bad(`${label}: failed for the wrong reason — ${e.code} ${e.message}`);
  }
};

const dashViews = async (c) =>
  (await c.query("select viewname from pg_views where schemaname = 'dash' order by 1")).rows.map((r) => r.viewname);
const liTables = async (c) =>
  (await c.query("select tablename from pg_tables where schemaname = 'li' order by 1")).rows.map((r) => r.tablename);

async function sweepViews(c, role) {
  const views = await dashViews(c);
  if (views.length === 0) { bad(`no dash views visible to ${role}`); return; }
  const broken = [];
  for (const v of views) {
    try { await c.query(`select * from dash.${v} limit 1`); }
    catch (e) { broken.push(`${v} (${e.code} ${e.message})`); }
  }
  broken.length ? bad(`${role} cannot read ${broken.length}/${views.length} dash views: ${broken.join("; ")}`)
                : ok(`${role} reads all ${views.length} dash views`);
}

// ============================================================ A. на місці
console.log(`-- A. privileges, in place  (grafana_ro: ${mode("grafana_ro")}, li_writer: ${mode("li_writer")}, li_sync: ${mode("li_sync")}, li_backup: ${mode("li_backup")})`);

async function partA(db = null) {
  await as("grafana_ro", db, async (c) => {
    await sweepViews(c, "grafana_ro");
    await denied(c, "grafana_ro select li.person", "select 1 from li.person limit 1");
    await denied(c, "grafana_ro insert li.author", "insert into li.author(author, name) values ('x', 'x')");
    await denied(c, "grafana_ro create table in dash", "create table dash.nope(i int)");
    await denied(c, "grafana_ro call li.request_week", "select li.request_week('x', '2026-01-05'::date, gen_random_uuid(), 'x')");
  });

  await as("li_writer", db, async (c) => {
    try { await c.query("select 1 from li.person limit 1"); ok("li_writer reads li"); }
    catch (e) { bad(`li_writer cannot read li: ${e.message}`); }
    await denied(c, "li_writer update", "update li.post set preview = preview where false");
    await denied(c, "li_writer delete", "delete from li.engagement_event where false");
    await denied(c, "li_writer truncate", "truncate li.vip_person");
    await denied(c, "li_writer direct gate insert", "insert into li.week_publication(author, week, run_id, status) values ('x', '2026-01-05', gen_random_uuid(), 'published')");
    // Скрейпер ПРОСИТЬ, а не вирішує: двері li_sync для нього зачинені.
    await denied(c, "li_writer call li.publish_run", "select li.publish_run(gen_random_uuid(), 'x')");
    await denied(c, "li_writer call li.set_scoring", "select li.set_scoring(gen_random_uuid(), 'max', '{}', '{}', '{}')");
  });

  await as("li_sync", db, async (c) => {
    const tables = await liTables(c);
    const unreadable = [];
    for (const t of tables) { try { await c.query(`select 1 from li.${t} limit 1`); } catch (e) { unreadable.push(`${t} (${e.code})`); } }
    check(unreadable.length === 0, `li_sync reads all ${tables.length} li tables`, unreadable.join(", "));
    await sweepViews(c, "li_sync");
    // Нічого, крім того, що робить імпортер: жодного прямого UPDATE / DELETE /
    // TRUNCATE, жодного DDL, жодного обходу гейту, жодного піна глобального годинника.
    await denied(c, "li_sync update li.post", "update li.post set preview = preview where false");
    await denied(c, "li_sync update li.week_publication", "update li.week_publication set status = 'published' where false");
    await denied(c, "li_sync update li.dash_config (the global clock)", "update li.dash_config set as_of = now()");
    await denied(c, "li_sync delete", "delete from li.engagement_event where false");
    await denied(c, "li_sync truncate", "truncate li.vip_person");
    await denied(c, "li_sync direct gate insert", "insert into li.week_publication(author, week, run_id, status) values ('x', '2026-01-05', gen_random_uuid(), 'published')");
    await denied(c, "li_sync direct insert li.post (no INSERT beyond import_run + engagement_event)", "insert into li.post(author, post_id, urn, type, posted_at, posted_date, source_file, run_id) select 'x','x','x','post',now(),current_date,'x',gen_random_uuid() where false");
    await denied(c, "li_sync direct insert li.author", "insert into li.author(author, display_name, profile_slug) select 'x','x','x' where false");
    await denied(c, "li_sync create table in li", "create table li.nope(i int)");
    await denied(c, "li_sync create table in dash", "create table dash.nope(i int)");
    await denied(c, "li_sync create schema", "create schema nope");
    await denied(c, "li_sync alter table", "alter table li.post add column nope int");
    await denied(c, "li_sync drop view", "drop view dash.post");
    await denied(c, "li_sync create function in li", "create function li.nope() returns int language sql as 'select 1'");
    // Тільки при справжньому вході: у режимі SET ROLE session_user — власник, і
    // йому SET ROLE дозволено за визначенням, тож перевірка нічого б не сказала.
    if (DSN_OF.li_sync) await denied(c, "li_sync set role li_owner", "set local role li_owner");
    else console.log("SKIP  li_sync set role li_owner: meaningful only with --sync-dsn (a real login)");
  });

  await as("li_backup", db, async (c) => {
    // Те, що робить pg_dump: LOCK TABLE ... ACCESS SHARE і читання кожної таблиці,
    // last_value кожної послідовності, визначення кожної в'юхи й функції з каталогу.
    const tables = await liTables(c);
    const broken = [];
    await c.query("begin");
    for (const t of tables) {
      try { await c.query("savepoint s"); await c.query(`lock table li.${t} in access share mode`); await c.query(`select * from li.${t} limit 1`); await c.query("release savepoint s"); }
      catch (e) { broken.push(`${t} (${e.code})`); await c.query("rollback to savepoint s"); }
    }
    await c.query("rollback");
    check(broken.length === 0, `li_backup locks and reads all ${tables.length} li tables`, broken.join(", "));

    const seqs = (await c.query("select schemaname, sequencename from pg_sequences where schemaname in ('li','dash')")).rows;
    const seqBroken = [];
    for (const s of seqs) { try { await c.query(`select last_value from ${s.schemaname}.${s.sequencename}`); } catch (e) { seqBroken.push(`${s.sequencename} (${e.code})`); } }
    check(seqBroken.length === 0, `li_backup reads all ${seqs.length} sequence(s)`, seqBroken.join(", "));

    const defs = (await c.query(`select count(*)::int as n, count(pg_get_viewdef(c.oid))::int as d
                                   from pg_class c join pg_namespace n on n.oid = c.relnamespace
                                  where n.nspname = 'dash' and c.relkind = 'v'`)).rows[0];
    check(defs.n > 0 && defs.n === defs.d, `li_backup reads the definition of all ${defs.n} dash views`);
    const fns = (await c.query(`select count(*)::int as n, count(pg_get_functiondef(p.oid))::int as d
                                  from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'li'`)).rows[0];
    check(fns.n > 0 && fns.n === fns.d, `li_backup reads the definition of all ${fns.n} li functions`);

    await denied(c, "li_backup insert", "insert into li.import_run(run_id, source) values (gen_random_uuid(), 'x')");
    await denied(c, "li_backup update", "update li.post set preview = preview where false");
    await denied(c, "li_backup delete", "delete from li.engagement_event where false");
    await denied(c, "li_backup truncate", "truncate li.vip_person");
    await denied(c, "li_backup create table", "create table li.nope(i int)");
    await denied(c, "li_backup call li.request_week", "select li.request_week('x', '2026-01-05'::date, gen_random_uuid(), 'x')");
    await denied(c, "li_backup call li.publish_run", "select li.publish_run(gen_random_uuid(), 'x')");
    await denied(c, "li_backup call li.upsert_author", "select li.upsert_author('[]'::jsonb)");
  });
}

// Годинник. Пін живе в транзакції export.mjs і ніде більше.
async function clockChecks(db = null, role = "li_sync") {
  // A pin in the FUTURE, so that it shows in a dash view whatever the corpus
  // holds: posts_per_month is zero-filled up to li.current_month().
  const PIN = "2031-03-01T00:00:00Z";
  const readerDsn = db ? dsnFor(role, db) : (DSN_OF[role] || withRole(OWNER, role));
  const pinned = await openDb(readerDsn, PIN);              // the very code export.mjs and verify.mjs use
  try {
    // li.as_of() itself is granted to nobody: a reader reaches it only through
    // the two helpers the dash views call.
    const mine = (await pinned.q(`select li.current_month()::text as m, li.current_week_monday()::text as w,
                                         (select max(month) from dash.posts_per_month) as tail`))[0];
    check(mine.m === "2031-03-01" && mine.w === "2031-02-24" && mine.tail === "2031-03",
      `pinned session (as ${role}): current_month 2031-03-01, current_week_monday 2031-02-24, posts_per_month runs to 2031-03`, JSON.stringify(mine));
    // A SECOND, independent session — while the first one still holds its pin.
    // grafana_ro cannot even name li.current_month(), so it looks where Grafana looks.
    await as("grafana_ro", db, async (c) => {
      const r = (await c.query("select (select max(month) from dash.posts_per_month) as tail, to_char(now() at time zone 'UTC','YYYY-MM') as real")).rows[0];
      check(r.tail === r.real, `an independent grafana_ro session, WHILE the pin is held, sees posts_per_month end at the real month (${r.real})`, `saw ${r.tail}`);
    });
    await asOwner(db, async (c) => {
      const r = (await c.query("select abs(extract(epoch from (li.as_of() - now()))) < 5 as real, (select as_of from li.dash_config) as row")).rows[0];
      check(r.real, "an independent owner session, WHILE the pin is held, sees li.as_of() = now()");
      check(r.row === null, "li.dash_config.as_of is NULL while an export is pinned");
    });
  } finally { await pinned.close(); }
  // The exporter's own session must also open for a role that cannot even NAME
  // schema li: its "is the global row pinned?" probe once raised 42501 there.
  try {
    const ro = await openDb(db ? dsnFor("grafana_ro", db) : (DSN_OF.grafana_ro || withRole(OWNER, "grafana_ro")), PIN);
    try {
      const tail = (await ro.q("select max(month) as tail from dash.posts_per_month"))[0].tail;
      check(tail === "2031-03", "export.mjs's pinned session opens as grafana_ro (dash only) and the pin reaches its views", `saw ${tail}`);
    } finally { await ro.close(); }
  } catch (e) { bad(`export.mjs's session as grafana_ro: ${e.code} ${e.message}`); }
  await asOwner(db, async (c) => {
    const r = (await c.query("select abs(extract(epoch from (li.as_of() - now()))) < 5 as real, (select as_of from li.dash_config) as row")).rows[0];
    check(r.real && r.row === null, "after the pinned export closed: li.as_of() = now() and li.dash_config.as_of is NULL");
  });
}

await partA();
await clockChecks();

// ======================================================= B. тимчасова база
if (!argv.includes("--no-scratch")) {
  const SCRATCH = `li_roletest_${process.pid}`;
  console.log(`\n-- B. the real importer as li_sync (${mode("li_sync")}), in scratch database ${SCRATCH}`);
  await asOwner(null, (c) => c.query(`create database ${SCRATCH}`));
  const work = mkdtempSync(join(tmpdir(), "li-roletest-"));
  try {
    await asOwner(SCRATCH, async (c) => {
      const sql = readFileSync(join(HERE, "schema.sql"), "utf8").split("\n").filter((l) => !l.startsWith("\\")).join("\n");
      await c.query("begin"); await c.query(sql); await c.query("commit");
    });
    ok("schema.sql applied to the scratch database by the --dsn role");

    const node = (script, args, dsn) => spawnSync("node", [join(HERE, script), ...args],
      { cwd: REPO, encoding: "utf8", env: { ...process.env, LI_DSN: dsn } });
    const written = (r) => Number((r.stdout.match(/^-- (\d+) rows written/m) || [])[1] ?? NaN);
    const gate = () => asOwner(SCRATCH, async (c) => (await c.query(
      `select count(*) filter (where status='published')::int  as published,
              count(*) filter (where status='pending')::int    as pending,
              count(*) filter (where status='superseded')::int as superseded,
              count(distinct decided_by) filter (where status='published')::int as deciders,
              bool_and(decided_by like '% as li_sync') filter (where status='published') as by_sync
         from li.week_publication`)).rows[0]);
    const SYNC = dsnFor("li_sync", SCRATCH);

    // 1. перший синк: порожня база
    let r = node("import.mjs", ["--publish"], SYNC);
    check(r.status === 0 && written(r) > 0, `first sync: import.mjs --publish as li_sync on an EMPTY database — exit ${r.status}, ${written(r)} rows written`, r.stderr.trim().split("\n").pop());
    let g = await gate();
    check(g.published > 0 && g.pending === 0, `first sync: ${g.published} week(s) published, ${g.pending} left pending`);
    if (DSN_OF.li_sync) check(g.by_sync === true, "first sync: every publication is recorded as decided '... as li_sync' (session_user, not a label)");

    // 2. усталений стан: ті самі дані
    r = node("import.mjs", ["--publish"], SYNC);
    check(r.status === 0 && written(r) === 0, `steady state: a second sync of the same main writes ${written(r)} rows`, r.stderr.trim().split("\n").pop());

    // 3. паритет — тією ж роллю, і він нічого не лишає по собі
    r = node("verify.mjs", [], SYNC);
    check(r.status === 0, `verify.mjs as li_sync: byte-identical (exit ${r.status})`, (r.stderr || r.stdout).trim().split("\n").slice(-2).join(" | "));
    await asOwner(SCRATCH, async (c) => {
      const row = (await c.query("select as_of from li.dash_config")).rows[0].as_of;
      check(row === null, "after verify.mjs: li.dash_config.as_of is NULL");
    });

    // 4. виправлений тиждень приїхав на main: дані лягають, публікацію перевидано
    const corpus = join(work, "corpus");
    mkdirSync(join(corpus, ".claude", "skills", "linkedin-stats"), { recursive: true });
    cpSync(join(REPO, "dashboards"), join(corpus, "dashboards"), { recursive: true });
    for (const f of ["profiles.json", "scoring.json", "vip-people.md"]) {
      try { cpSync(join(REPO, ".claude", "skills", "linkedin-stats", f), join(corpus, ".claude", "skills", "linkedin-stats", f)); } catch { /* optional */ }
    }
    const author = readdirSync(join(corpus, "dashboards", "li-stats"))
      .filter((d) => { try { return readdirSync(join(corpus, "dashboards", "li-stats", d, "posts")).length > 0; } catch { return false; } }).sort()[0];
    const pdir = join(corpus, "dashboards", "li-stats", author, "posts");
    const pfile = readdirSync(pdir).filter((f) => f.endsWith(".json")).sort()
      .find((f) => Object.values(JSON.parse(readFileSync(join(pdir, f), "utf8")).weeks ?? {}).some((w) => w.metrics));
    const post = JSON.parse(readFileSync(join(pdir, pfile), "utf8"));
    const week = Object.keys(post.weeks).find((w) => post.weeks[w].metrics);
    post.weeks[week].metrics.impressions += 500;
    writeFileSync(join(pdir, pfile), JSON.stringify(post, null, 2));

    r = node("import.mjs", ["--publish", "--repo", corpus], SYNC);
    // 1 рядок post_week + superseded + published
    check(r.status === 0 && written(r) === 3, `re-scraped week: sync writes exactly 3 rows (the snapshot, the superseded publication, the new one) — wrote ${written(r)}`, r.stderr.trim().split("\n").pop());
    await asOwner(SCRATCH, async (c) => {
      const rows = (await c.query(
        `select status, count(*)::int as n from li.week_publication where author = $1 and week = $2 group by status order by status`,
        [author, week])).rows;
      const m = Object.fromEntries(rows.map((x) => [x.status, x.n]));
      check(m.published === 1 && m.superseded === 1 && !m.pending,
        `re-scraped week: exactly one published row, the previous one superseded`, JSON.stringify(m));
      const same = (await c.query(
        `select (select run_id from li.week_publication where author=$1 and week=$2 and status='published')
              = (select run_id from li.post_week where author=$1 and post_id=$3 and week=$2) as same`,
        [author, week, String(post.id)])).rows[0].same;
      check(same === true, "re-scraped week: the published row now points at the run that wrote the snapshot");
      const dup = (await c.query(`select count(*)::int as n from (select 1 from li.week_publication where status='published' group by author, week having count(*) > 1) x`)).rows[0].n;
      check(dup === 0, "no (author, week) has more than one published row");
    });
    r = node("verify.mjs", ["--repo", corpus], SYNC);
    check(r.status === 0, `verify.mjs as li_sync against the corrected corpus: byte-identical (exit ${r.status})`, (r.stderr || r.stdout).trim().split("\n").slice(-2).join(" | "));
    r = node("import.mjs", ["--publish", "--repo", corpus], SYNC);
    check(r.status === 0 && written(r) === 0, `re-scraped week, replayed: ${written(r)} rows`);

    // 5. --reset — прапорець власника
    const before = await asOwner(SCRATCH, async (c) => (await c.query("select (select count(*) from li.post_week)::int as pw, (select count(*) from li.import_run)::int as runs")).rows[0]);
    r = node("import.mjs", ["--reset", "--publish"], SYNC);
    const after = await asOwner(SCRATCH, async (c) => (await c.query("select (select count(*) from li.post_week)::int as pw, (select count(*) from li.import_run)::int as runs")).rows[0]);
    check(r.status === 2 && /--reset REFUSED/.test(r.stderr) && after.pw === before.pw && after.runs === before.runs,
      `import.mjs --reset as li_sync: REFUSED with a clear message (exit ${r.status}), nothing changed (${after.pw} snapshots before and after)`,
      r.stderr.trim().split("\n").pop());

    // 6. семантика гейту, у транзакції, яка відкочується
    await asOwner(SCRATCH, async (c) => {
      await c.query("begin");
      try {
        const [A, B, C] = [randomUUID(), randomUUID(), randomUUID()];
        const W = "2031-01-06";
        for (const id of [A, B, C]) await c.query("insert into li.import_run(run_id, source) values ($1,'test-roles')", [id]);
        await c.query("select li.upsert_author($1::jsonb)", [JSON.stringify([{ author: "__t", display_name: "T", profile_slug: "in/t" }])]);
        const st = async () => Object.fromEntries((await c.query(
          "select run_id, status from li.week_publication where author='__t' and week=$1", [W])).rows.map((x) => [x.run_id, x.status]));
        const n = async (sql, p) => Number(Object.values((await c.query(sql, p)).rows[0])[0]);

        await n("select li.request_week('__t',$1::date,$2,'a')", [W, A]);
        check(await n("select li.publish_run($1,'t')", [B]) === 0 && (await st())[A] === "pending",
          "publish_run(B) does NOT promote a week requested by run A");
        check(await n("select li.request_week('__t',$1::date,$2,'b')", [W, B]) === 0,
          "request_week without takeover leaves another run's pending request alone (a non-publishing replay writes nothing)");
        check(await n("select li.request_week('__t',$1::date,$2,'b',true)", [W, B]) === 2,
          "request_week with takeover supersedes A's pending request and files B's");
        await n("select li.publish_run($1,'t')", [B]);
        let s = await st();
        check(s[A] === "superseded" && s[B] === "published", "publish_run(B): A superseded, B published", JSON.stringify(s));
        check(await n("select li.request_week('__t',$1::date,$2,'c',true)", [W, C]) === 0,
          "takeover never touches a PUBLISHED week");

        await c.query("select li.upsert_post('__t',$1,$2::jsonb)", [C, JSON.stringify([{ post_id: "1", urn: "u", type: "post", posted_at: "2031-01-06T00:00:00Z", posted_date: "2031-01-06", source_file: "f.json" }])]);
        await c.query("select li.replace_post_week('__t',$1,$2::jsonb)", [C, JSON.stringify([{ post_id: "1", week: W, ord: 0, has_metrics: true, impressions: 1 }])]);
        check(await n("select li.publish_run($1,'t')", [C]) === 2, "publish_run(C) after C rewrote a snapshot of the published week: 2 rows (superseded + published)");
        s = await st();
        check(s[B] === "superseded" && s[C] === "published" && Object.values(s).filter((x) => x === "published").length === 1,
          "republish: B superseded, C published, exactly one published row", JSON.stringify(s));
        check(await n("select li.publish_run($1,'t')", [C]) === 0, "publish_run(C) replayed: 0 rows");
        try { await c.query("savepoint u"); await c.query("select li.publish_run($1,'t')", [randomUUID()]); bad("publish_run(unknown run): allowed"); }
        catch (e) { await c.query("rollback to savepoint u"); check(e.code === "22023", "publish_run(unknown run): refused"); }
      } finally { await c.query("rollback"); }
    });

    // 7. ті самі відмови — на базі, де li_sync щойно справді писав
    await partA(SCRATCH);
    await clockChecks(SCRATCH);
  } finally {
    rmSync(work, { recursive: true, force: true });
    if (argv.includes("--keep")) console.log(`-- kept ${SCRATCH}`);
    else await asOwner(null, (c) => c.query(`drop database if exists ${SCRATCH} with (force)`)).catch((e) => bad(`could not drop ${SCRATCH}: ${e.code}`));
  }
}

console.log(failed ? `\n${failed} role check(s) FAILED` : "\nall role checks passed");
process.exit(failed ? 1 : 0);
