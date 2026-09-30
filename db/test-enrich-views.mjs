#!/usr/bin/env node
// В'юхи dash.enrich_* — перевірка на ДАНИХ, яких у корпусі немає.
//
//   node db/test-enrich-views.mjs [--dsn <owner url>] [--ro-dsn <url>] [--sync-dsn <url>] [--backup-dsn <url>] [--keep]
//
// DSN-и — з прапорців або з env: LI_DSN (власник, мусить уміти CREATE DATABASE),
// LI_GRAFANA_RO_DSN, LI_SYNC_DSN, LI_BACKUP_DSN. Без DSN ролі — SET ROLE від імені
// власника (так уміє лише суперкористувач; див. db/test-roles.mjs, «два режими»).
//
// НАВІЩО. У ICP-панелей немає JSON-оракула: verify.mjs і verify-panels.mjs не мають
// із чим їх порівняти. Лишається те, що можна довести з самої бази:
//   * кожен кошик є в кожного автора, і з нулем теж;
//   * персона рахується за старшинством P3 > P1 > P2 («Founder & CTO» — це P3), а
//     складений титул, у якому слово зі списку P3 лише Є («Product Owner», «Principal
//     Engineer», «Vice President», «Assistant to the CEO»), у P3 не потрапляє;
//   * бали за кошиками сходяться З ТОЧНІСТЮ ДО ОДИНИЦІ із загальним all_time, який
//     дашборд показує вже сьогодні (dash.feed_engagement_score_totals), — тобто
//     це той самий підрахунок, розкладений інакше, а не другий підрахунок;
//   * адвокати — рівно ті, хто працював у клієнта, і ніхто більше;
//   * grafana_ro читає СІМ в'юх контракту і більше нічого про збагачення: ні схеми
//     enrich, ні li.enrich_person (рядок на людину); li_sync не читає жодної;
//     li_backup читає схему enrich усю;
//   * li.persona_of не можна підмінити власною btrim() зі свого search_path;
//   * кожен rawSql рядка «ICP» авторських дашбордів виконується роллю grafana_ro і
//     віддає рівно ті колонки, які вибирає; stat-панель показує кожне поле, яке вибирає.
//
// ДЕ. У ТИМЧАСОВІЙ базі, яку тест створює і видаляє сам: enrich-schema.sql +
// schema.sql, справжній `import.mjs --publish` із корпусу цього дерева, і жменя
// ВИГАДАНИХ рядків enrich.profile для ключів, які створив імпорт. База з --dsn
// не змінюється взагалі: збагачення в ній — єдина копія, тестові рядки їй не сусіди.
//
// КЛІЄНТИ теж вигадані. enrich-schema.sql списку клієнтів не несе (репозиторій
// публічний) — його вписує власник у базу. Тож тест кладе в enrich.advocate_company
// власні патерни, і жодної справжньої назви клієнта в цьому файлі немає й не має бути.
//
// У лог — лише числа й вигадані імена. Ключі людей із корпусу не друкуються.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { pgConfig, resolveDsn } from "./pg-config.mjs";
import { schemaSql } from "./apply-schema.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const argv = process.argv.slice(2);
const arg = (name, dflt) => { const i = argv.indexOf(`--${name}`); return i > -1 && argv[i + 1] ? argv[i + 1] : dflt; };
const OWNER = resolveDsn(arg("dsn"));
const DSN_OF = {
  grafana_ro: arg("ro-dsn", process.env.LI_GRAFANA_RO_DSN || ""),
  li_sync: arg("sync-dsn", process.env.LI_SYNC_DSN || ""),
  li_backup: arg("backup-dsn", process.env.LI_BACKUP_DSN || ""),
};
const SCRATCH = `li_enrichtest_${process.pid}`;
const MARK = "test-enrich-views";                 // visited_by кожного вигаданого рядка

let failed = 0;
const ok = (msg) => console.log(`OK    ${msg}`);
const bad = (msg) => { failed++; console.log(`FAIL  ${msg}`); };
const check = (cond, msg, extra = "") => (cond ? ok(msg) : bad(`${msg}${extra ? ` — ${extra}` : ""}`));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const swapDb = (dsn, db) => { const u = new URL(dsn); u.pathname = `/${db}`; return u.toString(); };
const mode = (role) => (DSN_OF[role] ? "login" : "SET ROLE");
async function connect(dsn) {
  const c = new pg.Client(pgConfig(dsn, { connectionTimeoutMillis: 20000 }));
  await c.connect();
  return c;
}
async function as(role, fn) {
  const c = await connect(swapDb(DSN_OF[role] || OWNER, SCRATCH));
  try {
    if (!DSN_OF[role]) await c.query(`set role ${role}`);
    const who = (await c.query("select current_user")).rows[0].current_user;
    if (who !== role) throw new Error(`expected to act as ${role}, acting as ${who}`);
    await fn(c);
  } finally { await c.end().catch(() => {}); }
}
// Відмова мусить бути саме відмовою в правах, а не будь-якою помилкою.
const denied = async (c, label, sql) => {
  try { await c.query(sql); bad(`${label}: allowed, must be refused`); }
  catch (e) { e.code === "42501" ? ok(`${label}: refused`) : bad(`${label}: failed for the wrong reason — ${e.code} ${e.message}`); }
};

// ------------------------------------------------------------ контракт
const GEO = ["US", "TEAM", "ANTI", "OTHER", "not opened"];
const PERSONA = ["P3", "P1", "P2", "other", "unknown"];
const COVERAGE = ["opened", "not opened"];
const CONTRACT = {
  enrich_coverage: ["author text", "ord integer", "bucket text", "people integer"],
  enrich_geo: ["author text", "ord integer", "bucket text", "people integer"],
  enrich_persona: ["author text", "ord integer", "persona text", "people integer"],
  enrich_score_by_geo: ["author text", "ord integer", "bucket text", "score numeric", "reactions integer", "comments integer"],
  enrich_score_by_persona: ["author text", "ord integer", "persona text", "score numeric", "reactions integer", "comments integer"],
  enrich_advocates: ["author text", "ord integer", "name text", "headline text", "client_company text", "title text", "dates text"],
  enrich_state: ["author text", "ord integer", "opened integer", "total integer", "last_visit timestamp with time zone"],
};

// Рубрика — таблицею «текст -> персона». Старшинство, межі слів, регістр, пробіли.
const PERSONA_CASES = [
  ["Founder & CTO", "P3"], ["CTO and Co-Founder", "P3"], ["co-founder", "P3"], ["CEO", "P3"], ["ceo at an invented company", "P3"],
  ["Chief Executive Officer", "P3"], ["Managing Partner", "P3"], ["EVP, Sales", "P3"], ["Product Manager & Owner", "P3"],
  ["CTO", "P1"], ["Chief Technology Officer", "P1"], ["VP of IT", "P1"], ["VP IT", "P1"], ["vp  of\tit", "P1"],
  ["Head of Engineering", "P1"], ["Solution Architect", "P1"], ["Head of Product, formerly Program Manager", "P1"],
  ["Director of Operations", "P2"], ["Program Manager", "P2"], ["Chief   of   Staff", "P2"],
  ["Software Engineer", "other"], ["Cooperative bank teller", "other"], ["Scooter mechanic", "other"], ["Octopus wrangler", "other"],
  ["", "unknown"], ["   ", "unknown"], [null, "unknown"],
  // Складений титул, у якому слово зі списку P3 лише Є. До правки всі давали P3 —
  // і через старшинство не доходили до свого кошика.
  ["Product Owner", "other"], ["Senior Product Owner at an invented bank", "other"],
  ["Principal Engineer", "other"], ["Principal Software Engineer", "other"], ["Principal Consultant", "other"],
  ["Principal Product Manager", "P1"], ["Principal Solution Architect", "P1"], ["Principal Program Manager", "P2"],
  ["Vice President of Sales", "other"], ["Vice-President, Sales", "other"], ["Senior Vice President, Engineering", "other"],
  ["Assistant to the CEO", "other"], ["Executive Assistant to CEO", "other"], ["Advisor to the Founder", "other"],
  ["Assistant to the Managing Director", "other"], ["Chief of Staff to the CEO", "P2"],
  // …а справжні P3 поруч із ними лишаються P3: винятки прибирають титул, а не людину.
  ["Owner", "P3"], ["Business Owner", "P3"], ["Product Owner & Founder", "P3"], ["Principal", "P3"],
  ["Principal at Invented Partners", "P3"], ["Principal and Architect", "P3"], ["President", "P3"],
  ["Vice President & Founder", "P3"], ["Executive Vice President", "P3"], ["EVP", "P3"], ["From intern to CEO", "P3"],
  // Два написання титулів, які у списках уже є.
  ["Cofounder", "P3"], ["cofounder & cto", "P3"], ["VP, IT", "P1"],
  // Пробіли, яких [[:space:]] не бачить: нерозривний і нульової ширини.
  ["Product\u00a0Manager", "P1"], ["Chief\u200bof\u2009Staff", "P2"], ["Foun\u00adder", "P3"],
  // Нема чого читати: самі розділові знаки (так LinkedIn показує відсутній підпис) і невидимі символи.
  ["--", "unknown"], ["...", "unknown"], [" - ", "unknown"], ["\u2014", "unknown"], ["\u2026", "unknown"], ["\u2022 | \u00b7", "unknown"],
  ["\u00a0", "unknown"], ["\u200b", "unknown"],
  // Є що читати, але титулу зі списків немає: не англійською — це 'other', не 'unknown'.
  ["\u0417\u0430\u0441\u043d\u043e\u0432\u043d\u0438\u043a", "other"], ["123", "other"],
  // Чого рубрика НЕ ловить (і панелі про це кажуть): слово зі списку поруч із дефісом.
  ["Founder-led sales", "P3"],
];

// Клієнти — вигадані. Патерн — частина назви, як його вписав би власник.
const CLIENTS = ["fictional supply hub", "imaginary gazette", "madeup encyclopedia", "pretend kiosk"];
// Скільки рядків сіє сам файл схеми: рахується З ФАЙЛА, без коментарів. Сьогодні 0.
const seededByFile = () => {
  const sql = readFileSync(join(HERE, "enrich-schema.sql"), "utf8").split("\n").filter((l) => !/^\s*--/.test(l)).join("\n");
  const block = /insert\s+into\s+enrich\.advocate_company\b[\s\S]*?;/i.exec(sql)?.[0] ?? "";
  return (block.match(/^\s*\(\s*'/gm) ?? []).length;
};

const node = (script, args, dsn) => spawnSync("node", [join(HERE, script), ...args],
  { cwd: REPO, encoding: "utf8", env: { ...process.env, LI_DSN: dsn } });

const flatPanels = (ps) => (ps ?? []).flatMap((p) => [p, ...flatPanels(p.panels)]);
const rowsOf = async (c, view, cols) =>
  (await c.query(`select author, ord, ${cols} from dash.${view} order by author collate "C", ord`)).rows;
const byAuthor = (rows) => { const m = new Map(); for (const r of rows) (m.get(r.author) ?? m.set(r.author, []).get(r.author)).push(r); return m; };

// Кожен автор має рівно ці кошики, в цьому порядку, з ord 0..n-1.
function everyBucket(rows, authors, key, names, label) {
  const m = byAuthor(rows);
  const wrong = authors.filter((a) => !same((m.get(a) ?? []).map((r) => [r.ord, r[key]]), names.map((n, i) => [i, n])));
  check(wrong.length === 0 && m.size === authors.length,
    `${label}: every author has all ${names.length} rows (${names.join(", ")}), ord 0..${names.length - 1}`,
    `wrong for ${wrong.length} author(s), ${m.size} author(s) in the view`);
}

// sum(score) за кошиками == all_time із фіда, який дашборд уже показує.
async function sumsMatch(c, authors, when) {
  const totals = new Map((await c.query(
    "select author, score::text as score, reactions::int as reactions, comments::int as comments from dash.feed_engagement_score_totals where scope = 'all_time'")).rows.map((r) => [r.author, r]));
  for (const [view, key] of [["enrich_score_by_geo", "bucket"], ["enrich_score_by_persona", "persona"]]) {
    const got = new Map((await c.query(
      `select author, sum(score)::text as score, sum(reactions)::int as reactions, sum(comments)::int as comments from dash.${view} group by author`)).rows.map((r) => [r.author, r]));
    const off = authors.filter((a) => {
      const t = totals.get(a); const g = got.get(a);
      return !t || !g || Number(t.score) !== Number(g.score) || t.reactions !== g.reactions || t.comments !== g.comments;
    });
    const shown = authors.map((a) => `${a} ${got.get(a)?.score ?? "?"}=${totals.get(a)?.score ?? "?"}`).join(", ");
    check(off.length === 0, `${when}: sum(score) over dash.${view} (by ${key}) = all_time of dash.feed_engagement_score_totals, reactions and comments too — ${shown}`,
      `differs for ${off.join(", ")}`);
  }
}

console.log(`-- dash.enrich_* on invented enrichment, in scratch database ${SCRATCH}  (grafana_ro: ${mode("grafana_ro")}, li_sync: ${mode("li_sync")}, li_backup: ${mode("li_backup")})`);
const admin = await connect(OWNER);
await admin.query(`create database ${SCRATCH}`);
let c;
try {
  c = await connect(swapDb(OWNER, SCRATCH));
  const su = (await c.query("select rolsuper from pg_roles where rolname = current_user")).rows[0].rolsuper;
  console.log(`-- the owner role is ${su ? "a SUPERUSER (not how production runs)" : "NOT a superuser"}`);

  // ------------------------------------------------ 1. порожня база, одна команда
  await c.query("begin"); await c.query(schemaSql()); await c.query("commit");
  ok("enrich-schema.sql, then schema.sql, applied to an empty database");
  const r = node("import.mjs", ["--publish"], swapDb(OWNER, SCRATCH));
  const written = Number((r.stdout.match(/^-- (\d+) rows written/m) || [])[1] ?? NaN);
  check(r.status === 0 && written > 0, `import.mjs --publish: exit ${r.status}, ${written} rows written`, r.stderr.trim().split("\n").pop());

  const authors = (await c.query('select author from li.author order by author collate "C"')).rows.map((x) => x.author);
  check(authors.length > 0, `${authors.length} author(s) in the corpus`);

  // ------------------------------------------------ 2. форма в'юх
  const cat = new Map();
  for (const x of (await c.query(`
      select c.relname as view, a.attname || ' ' || format_type(a.atttypid, null) as col
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
       where n.nspname = 'dash' and c.relkind = 'v' and c.relname like 'enrich\\_%'
       order by c.relname, a.attnum`)).rows) (cat.get(x.view) ?? cat.set(x.view, []).get(x.view)).push(x.col);
  for (const [view, cols] of Object.entries(CONTRACT)) {
    check(same(cat.get(view), cols), `dash.${view}(${cols.map((x) => x.split(" ")[0]).join(", ")}) — names, order and types as agreed`, `found ${JSON.stringify(cat.get(view) ?? "no such view")}`);
  }

  // ------------------------------------------------ 3. рубрика персон
  const wrongPersona = [];
  for (const [text, want] of PERSONA_CASES) {
    const got = (await c.query("select li.persona_of($1) as p", [text])).rows[0].p;
    if (got !== want) wrongPersona.push(`${JSON.stringify(text)} -> ${got}, expected ${want}`);
  }
  check(wrongPersona.length === 0, `li.persona_of: ${PERSONA_CASES.length} titles classified as expected (precedence P3 > P1 > P2, word-bounded, case-insensitive)`, wrongPersona.join("; "));
  check((await c.query("select li.persona_of('Founder & CTO') as p")).rows[0].p === "P3", "persona precedence: a \"Founder & CTO\" headline is P3, not P1");

  // ------------------------------------------------ 4. до збагачення: усі кошики, з нулями
  const people = new Map((await c.query(
    "select author, count(*)::int as n from dash.person where person_key like 'in/%' group by author")).rows.map((x) => [x.author, x.n]));
  const total = (a) => people.get(a) ?? 0;
  check((await c.query("select count(*)::int as n from enrich.profile")).rows[0].n === 0, "enrich.profile is empty after the import: enrichment has no JSON to come from");
  {
    const geo = await rowsOf(c, "enrich_geo", "bucket, people");
    everyBucket(geo, authors, "bucket", GEO, "no enrichment yet, dash.enrich_geo");
    check(geo.every((x) => x.people === (x.bucket === "not opened" ? total(x.author) : 0)),
      "no enrichment yet, dash.enrich_geo: US, TEAM, ANTI, OTHER are present with people = 0; everybody is 'not opened'");
    everyBucket(await rowsOf(c, "enrich_persona", "persona, people"), authors, "persona", PERSONA, "no enrichment yet, dash.enrich_persona");
    const cov = await rowsOf(c, "enrich_coverage", "bucket, people");
    everyBucket(cov, authors, "bucket", COVERAGE, "no enrichment yet, dash.enrich_coverage");
    check(cov.every((x) => x.people === (x.bucket === "opened" ? 0 : total(x.author))), "no enrichment yet, dash.enrich_coverage: opened 0, not opened = everybody");
    everyBucket(await rowsOf(c, "enrich_score_by_geo", "bucket, score"), authors, "bucket", GEO, "no enrichment yet, dash.enrich_score_by_geo");
    everyBucket(await rowsOf(c, "enrich_score_by_persona", "persona, score"), authors, "persona", PERSONA, "no enrichment yet, dash.enrich_score_by_persona");
    const st = await rowsOf(c, "enrich_state", "opened, total, last_visit");
    check(st.length === authors.length && st.every((x) => x.ord === 0 && x.opened === 0 && x.total === total(x.author) && x.last_visit === null),
      `no enrichment yet, dash.enrich_state: one row per author, opened 0 of ${authors.map(total).join(" / ")}, last_visit NULL`);
    check((await c.query("select count(*)::int as n from dash.enrich_advocates")).rows[0].n === 0, "no enrichment yet, dash.enrich_advocates: empty");
    await sumsMatch(c, authors, "no enrichment yet");
  }

  // ------------------------------------------------ 5. вигадане збагачення
  // Автор із найбільшою кількістю людей; ключі — його, справжні (їх створив
  // імпорт), усе інше — вигадане. Порядок вибору байтовий, тож прогін повторюваний.
  const A = [...authors].sort((x, y) => total(y) - total(x))[0];
  const withHeadline = (await c.query(
    `select person_key, headline from dash.person where author = $1 and person_key like 'in/%' and btrim(coalesce(headline, '')) <> ''
      order by person_key collate "C" limit 6`, [A])).rows;
  const noHeadline = (await c.query(
    `select person_key from dash.person where author = $1 and person_key like 'in/%' and btrim(coalesce(headline, '')) = ''
      order by person_key collate "C" limit 1`, [A])).rows;
  const company = (await c.query(
    `select person_key from dash.person where person_key not like 'in/%' order by author collate "C", person_key collate "C" limit 1`)).rows;
  if (withHeadline.length < 6 || noHeadline.length < 1) {
    bad(`the corpus of ${A} has ${withHeadline.length} people with a headline and ${noHeadline.length} without — 6 and 1 are needed; nothing below was tested`);
    throw new Error("not enough people to seed");
  }
  const [k1, k2, k3, k5, k6, k7] = withHeadline.map((x) => x.person_key);
  const k4 = noHeadline[0].person_key;
  const H6 = withHeadline[4].headline;                      // справжній підпис k6: має вижити, коли enrich.headline = ''
  const job = (title, companyName, dates) => ({ title, company: companyName, dates });
  const SEED = [
    // key, name, headline, location, bucket, title, company, work_history, status  -> persona
    { key: k1, name: "Invented Person One", headline: "Building invented things", location: "Greater Invented Bay Area", bucket: "US",
      title: "Chief Executive Officer", company: "Invented Widgets Ltd", work: [job("Chief Executive Officer", "Invented Widgets Ltd", "2020 - Present")], persona: "P3" },
    { key: k2, name: "Invented Person Two", headline: "Platforms, mostly", location: "Inventedville, Ukraine", bucket: "TEAM",
      title: "Head of Engineering", company: "Invented Gadgets LLC", work: [job("Head of Engineering", "Invented Gadgets LLC", "2021 - Present")], persona: "P1" },
    { key: k3, name: "Invented Person Three", headline: "Keeps the trains running", location: "Inventedburg, Germany", bucket: "OTHER",
      title: "Director of Operations", company: "Fictional Supply Pub", work: [job("Director of Operations", "Fictional Supply Pub", "2018 - Present"), job("Analyst", "Supply Hub Fictionals", "2015 - 2018")], persona: "P2" },
    // сторінка відкрилась, а на ній ні підпису, ні посади, ні локації: persona unknown, і «де живе» — невідомо
    { key: k4, name: "Invented Person Four", headline: "", location: "", bucket: null,
      title: "", company: "", work: [], status: "partial", persona: "unknown" },
    // адвокат: працював у клієнта. І старшинство: «Founder & CTO» — це P3
    { key: k5, name: "Invented Person Five", headline: "Founder & CTO at Invented Labs", location: "Invented City", bucket: "US",
      title: "", company: "Invented Labs", work: [job("Founder & CTO", "Invented Labs", "2022 - Present"), job("Data Analyst", "Fictional Supply Hub", "2019 - 2022"), job("Intern", "Invented Widgets Ltd", "2017 - 2019")], persona: "P3" },
    // enrich.headline порожній -> персона зі справжнього підпису li.person
    { key: k6, name: "Invented Person Six", headline: "", location: "Inventedabad, India", bucket: "ANTI",
      title: "", company: "", work: [], status: "partial", persona: null },
    { key: k7, name: "Invented Person Seven", headline: "Octopus wrangler", location: "Invented Falls", bucket: "US",
      title: "Octopus wrangler", company: "Invented Aquarium", work: [job("Octopus wrangler", "Invented Aquarium", "2019 - Present")], persona: "other" },
  ];
  // Двоє, кого рахувати НЕ можна, хоч обоє «працювали в клієнта»: сторінка
  // компанії (не людина) і людина, яка ні з ким із авторів не взаємодіяла.
  const OUTSIDERS = [
    ...(company.length ? [{ key: company[0].person_key, name: "Invented Company Page", headline: "Founder of everything", location: "Invented City", bucket: "US",
      title: "Founder", company: "Madeup Encyclopedia Foundation", work: [job("Founder", "Madeup Encyclopedia Foundation", "2001 - Present")] }] : []),
    { key: "in/invented-nobody-who-never-engaged", name: "Invented Stranger", headline: "CEO", location: "Invented City", bucket: "US",
      title: "CEO", company: "Pretend Kiosk", work: [job("CEO", "Pretend Kiosk", "2010 - Present")] },
  ];
  // Список клієнтів — дані, і кладе їх власник: файл схеми їх не несе.
  const fromFile = (await c.query("select count(*)::int as n from enrich.advocate_company")).rows[0].n;
  check(fromFile === seededByFile() && fromFile === 0,
    "enrich.advocate_company comes up EMPTY: enrich-schema.sql names no client (the repository is public) — the owner inserts them",
    `${fromFile} row(s) in the table, ${seededByFile()} in the file`);
  for (const pattern of CLIENTS) await c.query("insert into enrich.advocate_company (pattern, note) values ($1, $2)", [pattern, MARK]);
  const T0 = Date.parse("2026-09-01T10:00:00Z");
  let i = 0;
  for (const s of [...SEED, ...OUTSIDERS]) {
    await c.query(
      `insert into enrich.profile (person_key, name, headline, location_raw, geo_bucket, current_title, current_company,
                                   work_history, parse_status, visited_at, visited_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11)`,
      [s.key, s.name, s.headline, s.location, s.bucket, s.title, s.company, JSON.stringify(s.work), s.status ?? "ok",
        new Date(T0 + 3600e3 * i++).toISOString(), MARK]);
    await c.query("insert into enrich.visit (person_key, visited_by, outcome) values ($1,$2,$3)", [s.key, MARK, s.status ?? "ok"]);
  }
  ok(`seeded ${SEED.length} invented profiles for people of ${A} (US x3, TEAM, ANTI, OTHER, one with no location) and ${OUTSIDERS.length} that must not be counted`);
  const expectedPersona6 = (await c.query("select li.persona_of($1) as p", [H6])).rows[0].p;
  SEED.find((s) => s.key === k6).persona = expectedPersona6;

  // Ті самі ключі можуть бути людьми й іншого автора (тоді збагачення стосується
  // обох) — очікуване рахується з бази, а не з припущення, що вони лише в A.
  const seededOf = new Map();                                // author -> [seed]
  for (const a of authors) {
    const keys = new Set((await c.query("select person_key from dash.person where author = $1 and person_key = any($2)", [a, SEED.map((s) => s.key)])).rows.map((x) => x.person_key));
    seededOf.set(a, SEED.filter((s) => keys.has(s.key)));
  }
  check(seededOf.get(A).length === SEED.length, `all ${SEED.length} seeded people are people of ${A}`);

  // ------------------------------------------------ 6. кошики після збагачення
  {
    const geo = await rowsOf(c, "enrich_geo", "bucket, people");
    everyBucket(geo, authors, "bucket", GEO, "dash.enrich_geo");
    const want = (a, b) => (b === "not opened"
      ? total(a) - seededOf.get(a).filter((s) => s.bucket !== null).length
      : seededOf.get(a).filter((s) => s.bucket === b).length);
    const off = geo.filter((x) => x.people !== want(x.author, x.bucket));
    const mine = geo.filter((x) => x.author === A).map((x) => `${x.bucket} ${x.people}`).join(", ");
    check(off.length === 0, `dash.enrich_geo, ${A}: ${mine} — the company page and the stranger are not counted`, `${off.length} row(s) differ`);
    const anti = geo.find((x) => x.author === A && x.bucket === "ANTI");
    check(anti.people === 1 && geo.filter((x) => x.author !== A && seededOf.get(x.author).length === 0).every((x) => x.bucket === "not opened" || x.people === 0),
      "dash.enrich_geo: a bucket nobody is in stays in the view with people = 0");

    const cov = await rowsOf(c, "enrich_coverage", "bucket, people");
    everyBucket(cov, authors, "bucket", COVERAGE, "dash.enrich_coverage");
    check(cov.every((x) => x.people === (x.bucket === "opened" ? seededOf.get(x.author).length : total(x.author) - seededOf.get(x.author).length)),
      `dash.enrich_coverage, ${A}: opened ${seededOf.get(A).length}, not opened ${total(A) - seededOf.get(A).length}`);
    const geoOpened = geo.filter((x) => x.author === A && x.bucket !== "not opened").reduce((n, x) => n + x.people, 0);
    check(geoOpened === seededOf.get(A).length - 1,
      `an opened profile with NO location is 'opened' in coverage and 'not opened' in geography (${seededOf.get(A).length} opened, ${geoOpened} placed): unknown is not OTHER`);

    const st = await rowsOf(c, "enrich_state", "opened, total, last_visit");
    const lastOf = (a) => { const s = seededOf.get(a); return s.length ? Math.max(...s.map((x) => T0 + 3600e3 * SEED.indexOf(x))) : null; };
    check(st.length === authors.length && st.every((x) => x.ord === 0 && x.opened === seededOf.get(x.author).length && x.total === total(x.author)
      && (x.last_visit === null ? lastOf(x.author) === null : x.last_visit.getTime() === lastOf(x.author))),
      `dash.enrich_state: one row per author, ord 0; ${A} opened ${seededOf.get(A).length} of ${total(A)}, last_visit is the latest of THEIR profiles`);
  }
  {
    const per = await rowsOf(c, "enrich_persona", "persona, people");
    everyBucket(per, authors, "persona", PERSONA, "dash.enrich_persona");
    check(PERSONA.every((name) => byAuthor(per).get(A).find((x) => x.persona === name) !== undefined)
      && authors.every((a) => byAuthor(per).get(a).reduce((n, x) => n + x.people, 0) === total(a)),
      `dash.enrich_persona: the five rows add up to everybody (${authors.map((a) => `${a} ${total(a)}`).join(", ")})`);
    const got = new Map((await c.query("select person_key, persona, bucket, opened from li.enrich_person where author = $1 and person_key = any($2)", [A, SEED.map((s) => s.key)])).rows.map((x) => [x.person_key, x]));
    const wrong = SEED.filter((s) => got.get(s.key)?.persona !== s.persona).map((s) => `${s.name}: ${got.get(s.key)?.persona}, expected ${s.persona}`);
    check(wrong.length === 0, `personas of the seeded people: ${SEED.map((s) => s.persona).join(", ")}`, wrong.join("; "));
    check(got.get(k5)?.persona === "P3", "persona precedence on a row: \"Founder & CTO at Invented Labs\" is counted as P3");
    check(got.get(k4)?.persona === "unknown" && got.get(k4)?.opened === true, "no text at all (no title, no headline anywhere): 'unknown', although the profile was opened");
    check(got.get(k6)?.persona === expectedPersona6, `an EMPTY enrich headline does not hide the headline li.person has: persona '${expectedPersona6}' comes from it`);
  }

  // ------------------------------------------------ 7. бали
  await sumsMatch(c, authors, "with enrichment");
  {
    // Не лише сума: бали саме ТИХ людей лежать саме в ЇХНЬОМУ кошику.
    const pts = async (keys) => (await c.query(
      "select coalesce(sum(points), 0)::text as score, count(*)::int as events from dash.engagement_scored where author = $1 and person_key = any($2)", [A, keys])).rows[0];
    const geo = new Map((await c.query("select bucket, score::text as score, reactions + comments as events from dash.enrich_score_by_geo where author = $1", [A])).rows.map((x) => [x.bucket, x]));
    const placed = [];
    for (const b of ["US", "TEAM", "ANTI", "OTHER"]) {
      const w = await pts(SEED.filter((s) => s.bucket === b).map((s) => s.key));
      if (Number(w.score) !== Number(geo.get(b).score) || w.events !== geo.get(b).events) placed.push(`${b}: ${geo.get(b).score}/${geo.get(b).events}, expected ${w.score}/${w.events}`);
    }
    check(placed.length === 0, `dash.enrich_score_by_geo, ${A}: US ${geo.get("US").score}, TEAM ${geo.get("TEAM").score}, ANTI ${geo.get("ANTI").score}, OTHER ${geo.get("OTHER").score} — each is the score of the people seeded into it`, placed.join("; "));
    const per = new Map((await c.query("select persona, score::text as score from dash.enrich_score_by_persona where author = $1", [A])).rows.map((x) => [x.persona, x.score]));
    const before = new Map((await c.query(
      `select li.persona_of(coalesce(p.headline, '')) as persona, coalesce(sum(s.points), 0)::text as score
         from dash.engagement_scored s join dash.person p on p.author = s.author and p.person_key = s.person_key
        where s.author = $1 and s.person_key like 'in/%' and s.person_key <> all($2) group by 1`, [A, SEED.map((x) => x.key)])).rows.map((x) => [x.persona, Number(x.score)]));
    const wrong = [];
    for (const name of ["P3", "P1", "P2", "other"]) {
      const w = (before.get(name) ?? 0) + Number((await pts(SEED.filter((s) => s.persona === name).map((s) => s.key))).score);
      if (w !== Number(per.get(name))) wrong.push(`${name}: ${per.get(name)}, expected ${w}`);
    }
    check(wrong.length === 0, `dash.enrich_score_by_persona, ${A}: P3 ${per.get("P3")}, P1 ${per.get("P1")}, P2 ${per.get("P2")}, other ${per.get("other")} — the seeded people moved with their points`, wrong.join("; "));
    if (company.length) {
      const co = (await c.query("select author, coalesce(sum(points), 0)::text as score from dash.engagement_scored where person_key not like 'in/%' group by author")).rows;
      check(co.length > 0, `company pages earn points too (${co.map((x) => `${x.author} ${x.score}`).join(", ")}): they stay under 'not opened' / 'unknown', which is why the buckets add up`);
    }
  }

  // ------------------------------------------------ 8. адвокати
  {
    const adv = (await c.query('select * from dash.enrich_advocates order by author collate "C", ord')).rows;
    const hosts = authors.filter((a) => seededOf.get(a).some((s) => s.key === k5));
    check(adv.length === hosts.length && adv.every((x) => x.name === "Invented Person Five" && x.client_company === "Fictional Supply Hub"
      && x.title === "Data Analyst" && x.dates === "2019 - 2022" && x.headline === "Founder & CTO at Invented Labs" && x.ord === 0),
      `dash.enrich_advocates: ${adv.length} row(s) — Invented Person Five, Data Analyst at Fictional Supply Hub, 2019 - 2022 — and nobody else`,
      `${adv.length} row(s): ${adv.map((x) => `${x.name} @ ${x.client_company}`).join("; ")}`);
    check(!adv.some((x) => /Pub|Fictionals|Encyclopedia|Kiosk/.test(x.client_company)),
      "not advocates: \"Fictional Supply Pub\" and \"Supply Hub Fictionals\" (near misses), the company page at Madeup Encyclopedia Foundation, the stranger at Pretend Kiosk");
    // Другий клієнт у тієї ж людини — другий рядок, ord іде за іменем.
    await c.query("begin");
    await c.query(`update enrich.profile set work_history = work_history || '[{"title":"Editor","company":"IMAGINARY GAZETTE Media Company","dates":"2014 - 2017"}]'::jsonb where person_key = $1`, [k5]);
    await c.query(`update enrich.profile set work_history = '[{"title":"Chief Executive Officer","company":"Pretend Kiosk Association","dates":"2020 - Present"}]'::jsonb where person_key = $1`, [k1]);
    const two = (await c.query("select ord, name, client_company from dash.enrich_advocates where author = $1 order by ord", [A])).rows;
    await c.query("rollback");
    check(same(two, [{ ord: 0, name: "Invented Person Five", client_company: "Fictional Supply Hub" }, { ord: 1, name: "Invented Person Five", client_company: "IMAGINARY GAZETTE Media Company" },
      { ord: 2, name: "Invented Person One", client_company: "Pretend Kiosk Association" }]),
      "dash.enrich_advocates: one row per matching job, case-insensitive, ordered by name, ord 0..n-1", JSON.stringify(two));
    // Без жодного клієнта в таблиці панель порожня — і це «ще не вписали», а не помилка.
    await c.query("begin");
    await c.query("delete from enrich.advocate_company");
    const none = (await c.query("select count(*)::int as n from dash.enrich_advocates")).rows[0].n;
    await c.query("rollback");
    check(none === 0, "dash.enrich_advocates with no client in enrich.advocate_company: empty, not an error — the panel says \"none found yet\"");
    for (const [label, pattern, code] of [["a pattern that is not a regular expression", "open (supply", "2201B"], ["an empty pattern", "  ", "23514"]]) {
      try { await c.query("insert into enrich.advocate_company(pattern) values ($1)", [pattern]); bad(`enrich.advocate_company accepted ${label}`); }
      catch (e) { check(e.code === code, `enrich.advocate_company refuses ${label} (it would break, or flood, the panel)`, `${e.code} ${e.message}`); }
    }
  }

  // ------------------------------------------------ 9. ідемпотентність: повторне накочування нічого не губить
  {
    const n0 = (await c.query("select (select count(*) from enrich.profile)::int as p, (select count(*) from enrich.visit)::int as v, (select count(*) from enrich.advocate_company)::int as a")).rows[0];
    await c.query("begin"); await c.query(schemaSql()); await c.query("commit");
    const n1 = (await c.query("select (select count(*) from enrich.profile)::int as p, (select count(*) from enrich.visit)::int as v, (select count(*) from enrich.advocate_company)::int as a, (select count(*) from li.person)::int as people")).rows[0];
    check(n1.p === n0.p && n1.v === n0.v && n1.a === n0.a && n1.people === 0,
      `re-applying both files (schema.sql drops li and dash): enrich keeps its ${n1.p} profiles, ${n1.v} visits and the ${n1.a} clients the owner inserted; li is empty again`, JSON.stringify({ n0, n1 }));
    check(n1.a === CLIENTS.length + seededByFile(), `…and the file added no client of its own (${n1.a} = ${CLIENTS.length} inserted + ${seededByFile()} seeded)`);
    const r2 = node("import.mjs", ["--publish"], swapDb(OWNER, SCRATCH));
    check(r2.status === 0, `import.mjs --publish after the re-apply: exit ${r2.status}`, r2.stderr.trim().split("\n").pop());
    const geo = (await c.query("select bucket, people from dash.enrich_geo where author = $1 order by ord", [A])).rows.map((x) => `${x.bucket} ${x.people}`).join(", ");
    check((await c.query("select count(*)::int as n from dash.enrich_advocates")).rows[0].n > 0, `after re-apply + import the panels are back without a single profile re-opened: ${geo}`);
    await sumsMatch(c, authors, "after re-apply + import");
  }

  // ------------------------------------------------ 10. ролі
  // Усе, що лежить у схемі dash, читає кожен, хто може надіслати запит у датасорс
  // Grafana, — не лише закомічені панелі. Тому збагачення в dash — це рівно сім в'юх
  // контракту, а рядок на людину (кошик, персона, час візиту) живе в li.enrich_person.
  const views = (await c.query("select viewname from pg_views where schemaname = 'dash' and viewname like 'enrich\\_%' order by 1")).rows.map((x) => x.viewname);
  check(same([...views].sort(), Object.keys(CONTRACT).sort()), `schema dash holds the ${Object.keys(CONTRACT).length} enrich views of the contract and no other`, views.join(", "));
  const perPerson = (await c.query(`select n.nspname || '.' || c.relname as rel, coalesce(c.reloptions::text, '') like '%security_barrier=true%' as barrier
                                      from pg_class c join pg_namespace n on n.oid = c.relnamespace
                                     where c.relkind = 'v' and c.relname = 'enrich_person'`)).rows;
  check(same(perPerson, [{ rel: "li.enrich_person", barrier: true }]), "the per-person block is li.enrich_person — in schema li, a security_barrier view — and is nowhere else", JSON.stringify(perPerson));
  await c.query(`create view dash.zz_enrich_leak_control as
                   select p.author, w.job ->> 'title' as title
                     from dash.person p join enrich.profile e on e.person_key = p.person_key
                    cross join lateral jsonb_array_elements(e.work_history) as w(job)
                    where exists (select 1 from enrich.advocate_company a where w.job ->> 'company' ~* a.pattern)`);
  await c.query("alter view dash.zz_enrich_leak_control owner to li_owner");
  await c.query("grant select on dash.zz_enrich_leak_control to grafana_ro");
  // Підміна функції через search_path. Читач не може створити функцію ні в dash, ні
  // в public — але якби міг бодай у ЯКІЙСЬ схемі зі свого шляху (public до PG15, і
  // після pg_upgrade), то його btrim() отримала б текст, якого немає в жодній в'юсі:
  // enrich.profile.current_title. Тут таку схему йому дають навмисно.
  await c.query("create schema zz_hijack");
  await c.query(`create function zz_hijack.btrim(text) returns text language plpgsql
                 as $f$ begin raise notice 'hijacked'; return pg_catalog.btrim($1); end $f$`);
  await c.query("create function zz_hijack.unpinned(p text) returns text language sql immutable as $f$ select (select btrim(p)) $f$");
  await c.query("grant usage on schema zz_hijack to grafana_ro");
  await c.query("grant execute on all functions in schema zz_hijack to grafana_ro");
  const pinned = (await c.query("select proconfig, prosecdef from pg_proc where oid = 'li.persona_of(text)'::regprocedure")).rows[0];
  check(!pinned.prosecdef && (pinned.proconfig ?? []).some((x) => /^search_path=pg_catalog, ?pg_temp$/.test(x)),
    "li.persona_of pins its search_path to pg_catalog, pg_temp", JSON.stringify(pinned.proconfig));
  const personaBefore = (await c.query("select persona, people from dash.enrich_persona where author = $1 order by ord", [A])).rows;

  await as("grafana_ro", async (ro) => {
    const broken = [];
    for (const v of views) {
      try {
        const got = (await ro.query(`select * from dash.${v} where author = $1 order by ord`, [A])).fields.map((f) => f.name);
        const want = (CONTRACT[v] ?? []).map((x) => x.split(" ")[0]);
        if (!same(got, want)) broken.push(`${v} returns (${got.join(", ")})`);
      } catch (e) { broken.push(`${v} (${e.code})`); }
    }
    check(views.length === Object.keys(CONTRACT).length && broken.length === 0,
      `grafana_ro (${mode("grafana_ro")}) reads all ${views.length} dash.enrich_* views, and each returns exactly the columns of the contract`, broken.join(", ") || views.join(", "));
    await ro.query("set default_transaction_read_only = off");     // інакше запис відбивається кодом 25006 ще до перевірки прав
    for (const t of ["profile", "visit", "advocate_company", "today"]) await denied(ro, `grafana_ro select enrich.${t}`, `select 1 from enrich.${t} limit 1`);
    await denied(ro, "grafana_ro insert enrich.profile", "insert into enrich.profile (person_key, parse_status, visited_at, visited_by) select 'x', 'ok', now(), 'x' where false");
    // Рядок на людину: «ім'я + URL профілю + US/TEAM/ANTI/OTHER + персона + коли ми
    // дивились» — через join з dash.person. Жодна панель цього не показує.
    await denied(ro, "grafana_ro select li.enrich_person (the bucket, the persona and the visit time of each person)", "select 1 from li.enrich_person limit 1");
    await denied(ro, "grafana_ro call li.persona_of by name", "select li.persona_of('CEO')");
    const gone = (await ro.query("select to_regclass('dash.enrich_person') is null as yes")).rows[0].yes;
    check(gone === true, "there is no dash.enrich_person for a reader to find");
    const cols = (await ro.query(`select string_agg(distinct a.attname, ', ' order by a.attname) as cols
                                    from pg_class c join pg_namespace n on n.oid = c.relnamespace
                                    join pg_attribute a on a.attrelid = c.oid and a.attnum > 0
                                   where n.nspname = 'dash' and c.relname like 'enrich\\_%'
                                     and a.attname in ('person_key', 'profile_url', 'location_raw', 'geo_bucket', 'work_history', 'current_title',
                                                       'current_company', 'visited_at', 'visited_by', 'note')`)).rows[0].cols;
    check(cols === null, "no dash.enrich_* view has a column for a person's key, the raw location, the whole work history, the current title or company, or the visit log", cols ?? "");

    // Побічний канал: предикат читача не має виконуватись на рядках, яких в'юха не показує.
    let notices = 0;
    ro.on("notice", () => { notices++; });

    // Підміна btrim(): контрольна функція без закріпленого search_path її підхоплює
    // (інакше проба нічого не доводить), li.persona_of під в'юхами — ні.
    await ro.query("set search_path = zz_hijack, pg_catalog");
    notices = 0;
    await ro.query("select zz_hijack.unpinned(' x ')");
    check(notices > 0, "hijack probe is sensitive: a function WITHOUT a pinned search_path runs the reader's own btrim()");
    notices = 0;
    const personaNow = (await ro.query("select persona, people from dash.enrich_persona where author = $1 order by ord", [A])).rows;
    const scoreNow = (await ro.query("select count(*)::int as n from dash.enrich_score_by_persona where author = $1", [A])).rows[0].n;
    check(notices === 0 && same(personaNow, personaBefore) && scoreNow === PERSONA.length,
      `li.persona_of is not hijacked through the reader's search_path: its own btrim() never ran, and the personas are the same (${personaNow.map((x) => `${x.persona} ${x.people}`).join(", ")})`,
      `${notices} call(s) of the reader's btrim()`);
    await ro.query("reset search_path");

    try {
      await ro.query(`create function pg_temp.leak(anyelement) returns boolean language plpgsql cost 0.0000001
                      as $f$ begin raise notice 'seen'; return true; end $f$`);
    } catch (e) {
      if (e.code !== "42501") throw e;
      console.log("SKIP  leak probe: grafana_ro cannot create a function in pg_temp here");
      return;
    }
    const probe = async (view, col) => {
      notices = 0;
      const visible = (await ro.query(`select count(*)::int as n from dash.${view} where pg_temp.leak(${col})`)).rows[0].n;
      return { visible, evaluated: notices };
    };
    const control = await probe("zz_enrich_leak_control", "title");
    check(control.evaluated > control.visible,
      `leak probe is sensitive: on a barrier-less copy of the advocates view the predicate ran on ${control.evaluated - control.visible} job(s) of people who never worked at a client`);
    const adv = await probe("enrich_advocates", "title");
    check(adv.visible > 0 && adv.evaluated === adv.visible, `dash.enrich_advocates: a leaky predicate sees the ${adv.visible} visible row(s) and nothing else`, `evaluated on ${adv.evaluated}`);
    // Кошики — це агрегати: предикат на назві кошика бачить п'ять назв, а не людей.
    const geo = await probe("enrich_geo", "bucket");
    check(geo.visible > 0 && geo.evaluated <= geo.visible, `dash.enrich_geo: a leaky predicate on the bucket runs on the ${geo.visible} bucket row(s) it is shown, never once per person`, `evaluated on ${geo.evaluated}`);
  });
  await c.query("drop view dash.zz_enrich_leak_control");
  await c.query("drop schema zz_hijack cascade");

  // li_sync — роль CI публічного репозиторію. Вона відтворює main і звіряє фіди;
  // збагачення немає ні там, ні там, тож і читати його їй нічим.
  await as("li_sync", async (sy) => {
    for (const v of views) await denied(sy, `li_sync select dash.${v}`, `select 1 from dash.${v} limit 1`);
    await denied(sy, "li_sync select li.enrich_person", "select 1 from li.enrich_person limit 1");
    await denied(sy, "li_sync call li.persona_of", "select li.persona_of('CEO')");
    try {
      const n = (await sy.query("select count(*)::int as n from dash.feed_engagement_score_totals")).rows[0].n;
      check(n > 0, `li_sync (${mode("li_sync")}) still reads the feed views it verifies (${n} row(s) of dash.feed_engagement_score_totals)`);
    } catch (e) { bad(`li_sync cannot read a feed view: ${e.code} ${e.message}`); }
  });

  await as("li_backup", async (b) => {
    const n = {};
    try {
      for (const t of ["profile", "visit", "advocate_company", "today"]) n[t] = (await b.query(`select count(*)::int as n from enrich.${t}`)).rows[0].n;
      n.seq = Number((await b.query("select last_value from enrich.visit_visit_id_seq")).rows[0].last_value);
      check(n.profile === SEED.length + OUTSIDERS.length && n.visit === n.profile && n.advocate_company === CLIENTS.length && n.seq >= n.visit,
        `li_backup (${mode("li_backup")}) reads enrich: ${n.profile} profiles, ${n.visit} visits, ${n.advocate_company} clients, the visit sequence`, JSON.stringify(n));
    } catch (e) { bad(`li_backup cannot read enrich: ${e.code} ${e.message}`); }
    await denied(b, "li_backup insert enrich.visit", "insert into enrich.visit (person_key, visited_by, outcome) select 'x', 'x', 'skipped' where false");
    await denied(b, "li_backup delete enrich.profile", "delete from enrich.profile where false");
  });

  // ------------------------------------------------ 10a. панелі: той самий SQL, який надішле Grafana
  // verify-panels.mjs enrich-таргети рахує, але в базу не відправляє: порівняти їх нема
  // з чим. Тож перейменована колонка в'юхи чи втрачений грант пройшли б і його, і
  // перевірки вище. Тут кожен rawSql рядка «ICP» — із шаблону і з дашборда кожного
  // автора — виконується роллю grafana_ro: колонки мусять прийти ті, що у SELECT, у
  // байтовому порядку імен, і кошики — усі, з нулями.
  {
    const flat = (ps) => (ps ?? []).flatMap((p) => [p, ...flat(p.panels)]);
    const targetsOf = (file) => flat(JSON.parse(readFileSync(join(REPO, "dashboards", "grafana", file), "utf8")).panels)
      .flatMap((p) => (p.targets ?? []).filter((t) => /\bdash\.enrich_/.test(t.rawSql ?? "")).map((t) => ({ panel: p.id, sql: t.rawSql })));
    const ROWS = { enrich_state: 1, enrich_geo: GEO.length, enrich_persona: PERSONA.length, enrich_score_by_geo: GEO.length, enrich_score_by_persona: PERSONA.length };
    const bytes = (x, y) => Buffer.compare(Buffer.from(x), Buffer.from(y));
    const wrong = [];
    let ran = 0, tpl = [];
    try { tpl = targetsOf(join("_template", "author.json")); } catch (e) { wrong.push(`_template/author.json: ${e.message}`); }
    await as("grafana_ro", async (ro) => {
      for (const a of authors) {
        let gen = [];
        try { gen = targetsOf(`linkedin-${a}.json`); } catch (e) { wrong.push(`linkedin-${a}.json: ${e.message}`); continue; }
        if (!same(gen.map((t) => [t.panel, t.sql]), tpl.map((t) => [t.panel, t.sql.replaceAll("__AUTHOR__", a)]))) {
          wrong.push(`linkedin-${a}.json: its enrich targets are not the template's with the author filled in — regenerate`);
        }
        for (const t of gen) {
          const view = (t.sql.match(/\bdash\.(enrich_\w+)/) ?? [])[1];
          const asked = (t.sql.match(/^\s*select\s+([\s\S]*?)\s+from\s/i) ?? [, ""])[1].split(",").map((x) => x.trim());
          try {
            const r = await ro.query(t.sql);
            ran++;
            const got = r.fields.map((f) => f.name);
            const known = (CONTRACT[view] ?? []).map((x) => x.split(" ")[0]);
            if (!same(got, asked)) wrong.push(`panel #${t.panel} of ${a}: returns (${got.join(", ")}), selects (${asked.join(", ")})`);
            if (!same(got, [...got].sort(bytes))) wrong.push(`panel #${t.panel} of ${a}: columns are not in byte order of their names (${got.join(", ")})`);
            if (!got.every((x) => known.includes(x))) wrong.push(`panel #${t.panel} of ${a}: a column dash.${view} does not have by contract (${got.join(", ")})`);
            if (view in ROWS && r.rows.length !== ROWS[view]) wrong.push(`panel #${t.panel} of ${a}: ${r.rows.length} row(s) from dash.${view}, expected ${ROWS[view]}`);
          } catch (e) { wrong.push(`panel #${t.panel} of ${a}: ${e.code ?? ""} ${e.message}`); }
        }
      }
    });
    // Stat-панель малює поле, лише якщо його ВІДОБРАЖУВАНЕ ім'я проходить фільтр
    // options.reduceOptions.fields, а override displayName це ім'я міняє: поле `total`,
    // перейменоване на «of engagers in total», під /^(opened|total)$/ уже не підпадає —
    // і на панелі лишається чисельник без знаменника, хоча SQL віддає обидва числа.
    const notDrawn = [];
    let stats = 0;
    for (const file of [join("_template", "author.json"), ...authors.map((a) => `linkedin-${a}.json`)]) {
      let panels = [];
      try { panels = flat(JSON.parse(readFileSync(join(REPO, "dashboards", "grafana", file), "utf8")).panels); } catch { continue; }   // уже названо вище
      for (const p of panels) {
        const sql = (p.targets ?? []).map((t) => t.rawSql ?? "").find((x) => /\bdash\.enrich_/.test(x));
        if (p.type !== "stat" || !sql) continue;
        stats++;
        const filter = p.options?.reduceOptions?.fields ?? "";
        const m = /^\/(.*)\/([a-z]*)$/.exec(filter);
        if (!m) { notDrawn.push(`${file} #${p.id}: its fields filter ${JSON.stringify(filter)} is not a /regex/ — which fields are drawn is left to a default`); continue; }
        const shownAs = (col) => (p.fieldConfig?.overrides ?? []).filter((o) => o.matcher?.id === "byName" && o.matcher.options === col)
          .flatMap((o) => o.properties ?? []).filter((x) => x.id === "displayName").map((x) => x.value).pop() ?? col;
        for (const col of (sql.match(/^\s*select\s+([\s\S]*?)\s+from\s/i) ?? [, ""])[1].split(",").map((x) => x.trim())) {
          if (!new RegExp(m[1], m[2]).test(shownAs(col))) notDrawn.push(`${file} #${p.id}: selects "${col}", shows it as "${shownAs(col)}", which the filter ${filter} does not match`);
        }
      }
    }
    check(stats === 1 + authors.length && notDrawn.length === 0,
      `the stat panel of the ICP row draws every field it selects — the name a field is SHOWN under passes its fields filter (${stats} panel(s): the template and ${authors.length} author(s))`,
      notDrawn.join("; ") || `${stats} stat panel(s) found`);
    check(tpl.length === 6 && ran === tpl.length * authors.length && wrong.length === 0,
      `the ICP row: all ${tpl.length} enrich targets of _template/author.json, as generated for ${authors.length} author(s), run as grafana_ro (${mode("grafana_ro")}) — ${ran} queries, the columns each selects, in byte order, every bucket row present`,
      wrong.join("; ") || `${tpl.length} target(s) in the template, ${ran} ran`);
  }

  // ------------------------------------------------ 10b. найгірший план
  // Щойно імпортована база ще не проаналізована, і планувальник бере nested loop:
  // рубрика персон виконувалась раз на ПОДІЮ і ЛЮДИНУ (172 000 разів на одного
  // автора), а панель упиралась у statement_timeout читача — 22 с, виміряно. Тут такий
  // план нав'язано (hash- і merge-join вимкнено, як і Materialize), а ліміт — той, з
  // яким входить grafana_ro: кожна панель мусить відповісти, і з великим запасом.
  {
    const tpl = flatPanels(JSON.parse(readFileSync(join(REPO, "dashboards", "grafana", "_template", "author.json"), "utf8")).panels)
      .flatMap((p) => (p.targets ?? []).filter((t) => /\bdash\.enrich_/.test(t.rawSql ?? "")).map((t) => ({ panel: p.id, sql: t.rawSql.replaceAll("__AUTHOR__", A) })));
    const slow = [];
    let worst = 0;
    await as("grafana_ro", async (ro) => {
      await ro.query("set statement_timeout = '15s'");
      for (const g of ["enable_hashjoin", "enable_mergejoin", "enable_material"]) await ro.query(`set ${g} = off`);
      for (const t of tpl) {
        const t0 = process.hrtime.bigint();
        try { await ro.query(t.sql); } catch (e) { slow.push(`panel #${t.panel}: ${e.code} ${e.message}`); continue; }
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        worst = Math.max(worst, ms);
        if (ms > 5000) slow.push(`panel #${t.panel}: ${Math.round(ms)} ms`);
      }
    });
    check(tpl.length === 6 && slow.length === 0,
      `the worst join plan (nested loops only, as on a database not analyzed yet): all ${tpl.length} panels of ${A} answer inside the reader's statement_timeout — slowest ${Math.round(worst)} ms of 15000`,
      slow.join("; "));
  }

  // ------------------------------------------------ 11. гейт: знятий з публікації тиждень зникає і звідси
  {
    // Тиждень, у який уперше побачили найбільше людей автора, — і скільки з них відкрито.
    const w = (await c.query(
      `select p.gate_week::text as week, count(*)::int as n,
              (count(*) filter (where p.person_key = any($2)))::int as opened
         from li.person p
        where p.author = $1 and p.person_key like 'in/%'
        group by 1 order by 2 desc, 1 limit 1`, [A, SEED.map((s) => s.key)])).rows[0];
    await c.query("begin");
    await c.query("update li.week_publication set status = 'rejected' where status = 'published' and author = $1 and week = $2::date", [A, w.week]);
    const st = (await c.query("select opened, total from dash.enrich_state where author = $1", [A])).rows[0];
    const geoSum = (await c.query("select sum(people)::int as n from dash.enrich_geo where author = $1", [A])).rows[0].n;
    const adv = (await c.query("select count(*)::int as n from dash.enrich_advocates where author = $1", [A])).rows[0].n;
    check(st.total === total(A) - w.n && st.opened === SEED.length - w.opened && geoSum === st.total,
      `a week taken off publication: its ${w.n} people (${w.opened} of them opened) leave the head counts — ${A} ${total(A)} -> ${st.total}, opened ${SEED.length} -> ${st.opened} — in dash.enrich_state and dash.enrich_geo alike`,
      JSON.stringify({ st, geoSum }));
    const k5Hidden = (await c.query("select gate_week::text = $2 as hidden from li.person where author = $1 and person_key = $3", [A, w.week, k5])).rows[0].hidden;
    check(adv === (k5Hidden ? 0 : 1), `a week taken off publication: the advocate is ${k5Hidden ? "hidden with the week they were first seen in" : "still visible (first seen in another week)"} — enrichment does not open a side door past the gate`, `${adv} row(s)`);
    await sumsMatch(c, authors, "with a week off publication");
    await c.query("rollback");
  }
} catch (e) {
  bad(`the run stopped: ${e.code ?? ""} ${e.message}`);
} finally {
  await c?.end().catch(() => {});
  if (argv.includes("--keep")) console.log(`-- kept ${SCRATCH}`);
  else await admin.query(`drop database if exists ${SCRATCH} with (force)`).catch((e) => bad(`could not drop ${SCRATCH}: ${e.code}`));
  await admin.end().catch(() => {});
}

console.log(failed ? `\n${failed} enrich check(s) FAILED` : "\nall enrich checks passed");
process.exit(failed ? 1 : 0);
