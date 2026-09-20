#!/usr/bin/env node
// Генерує Grafana-дашборд на кожного автора з profiles.json, використовуючи
// дашборди Олександра як шаблон. Для кожного автора:
//   linkedin-<author>.json        (основний)   uid=linkedin-<author>
//   linkedin-<author>-posts.json  (per-post)   uid=linkedin-<author>-posts
// з даними з Postgres: кожен rawSql читає dash.feed_* з умовою
// author = '<author>'. У шаблоні на місці слага стоїть токен __AUTHOR__.
//
// Кількість авторів не зашита — усе з profiles.json. Після генерації
// пушити у Grafana через push-dashboard.mjs (потрібні
// GRAFANA_SERVICE_ACCOUNT_TOKEN і GRAFANA_PG_DATASOURCE_UID).
//
//   node .github/scripts/gen-author-dashboards.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const GRAFANA_DIR = join(REPO_ROOT, "dashboards", "grafana");
const PROFILES = JSON.parse(readFileSync(
  join(REPO_ROOT, ".claude", "skills", "linkedin-stats", "profiles.json"), "utf8"));

// Шаблони лежать окремо в _template/ і НЕ є виходом генерації. Якщо брати
// за шаблон дашборд якогось автора, друга генерація успадкує його слаг —
// саме так у peter-posts колись потрапив фід іншого автора.
const TPL_DIR = join(GRAFANA_DIR, "_template");
const MAIN_TPL = readFileSync(join(TPL_DIR, "author.json"), "utf8");
const POSTS_TPL = readFileSync(join(TPL_DIR, "author-posts.json"), "utf8");

// Токен автора в rawSql шаблону ("where author = '__AUTHOR__' ...").
const AUTHOR_TOKEN = "__AUTHOR__";
// Слаг підставляється в SQL-літерал як є, тож нічого, крім [a-z0-9-], сюди
// потрапити не може — ні лапка, ні пробіл.
const SLUG_RE = /^[a-z0-9-]+$/;

// Усі SQL-рядки дашборда: rawSql панелей + query/definition query-змінних.
function sqlStrings(d) {
  const out = [];
  const walk = (panels) => {
    for (const p of panels ?? []) {
      for (const t of p.targets ?? []) {
        if (typeof t.rawSql === "string") out.push({ where: `panel #${p.id}/${t.refId}`, sql: t.rawSql });
      }
      walk(p.panels);
    }
  };
  walk(d.panels);
  for (const v of d.templating?.list ?? []) {
    if (v.type !== "query") continue;
    for (const k of ["query", "definition"]) {
      if (typeof v[k] === "string") out.push({ where: `$${v.name}.${k}`, sql: v[k] });
    }
  }
  return out;
}

// Кожен rawSql мусить читати рівно ОДНОГО автора — цього. Запит без умови на
// автора показав би всіх авторів упереміш, а з чужим слагом — чужі цифри під
// цим іменем; і те, і те мовчки виглядає як «просто графік».
function assertOnlyThisAuthor(text, { uid, author, others }) {
  // Без урахування регістру: "__author__" у шаблоні — це одрук, який заміна
  // не зловить, а не інший токен.
  if (text.toUpperCase().includes(AUTHOR_TOKEN)) {
    throw new Error(`${uid}: ${AUTHOR_TOKEN} is still present after rendering`);
  }
  const sqls = sqlStrings(JSON.parse(text));
  if (!sqls.length) throw new Error(`${uid}: no rawSql at all — is the template still the SQL one?`);
  for (const { where, sql } of sqls) {
    const scoped = [...sql.matchAll(/\bauthor\s*=\s*'([^']*)'/g)].map((m) => m[1]);
    if (!scoped.length) throw new Error(`${uid} ${where}: rawSql has no author = '${author}' condition`);
    const foreign = scoped.find((a) => a !== author) ?? others.find((o) => sql.includes(`'${o}'`));
    if (foreign !== undefined) {
      throw new Error(`${uid} ${where}: rawSql reads author '${foreign}', expected '${author}'`);
    }
  }
}

// Перекласти шаблон на конкретного автора: підмінити uid/title, слаг автора в
// SQL і внутрішні крос-лінки між дашбордами.
function render(tplText, { uid, title, author, others, isPosts }) {
  const d = JSON.parse(tplText);
  d.uid = uid;
  d.title = title;
  // Крос-лінки задаємо ЯВНО, а не заміною по тексту: у шаблоні вони вказують
  // на дашборди апстріму (kiqz2fk / linkedin-post), яких у нас немає — і саме
  // тому кнопка "Account view" вела в нікуди.
  for (const l of d.links ?? []) {
    if (typeof l.url === 'string' && l.url.startsWith('/d/')) {
      l.url = isPosts ? `/d/linkedin-${author}` : `/d/linkedin-${author}-posts`;
    }
  }
  // $post — це статичний Custom-список, «запечений» у шаблоні. Без очистки
  // кожен автор успадкував би чужі пости. Список наповнює update-post-variable
  // з dashboards/li-stats/<author>/posts/ вже після публікації.
  for (const v of d.templating?.list ?? []) {
    if (v.name === "post") { v.query = ""; v.options = []; v.current = {}; }
  }
  let s = JSON.stringify(d, null, 2);
  // Шаблон завжди несе токен, а не чийсь слаг, тож повторний прогін не може
  // «прилипнути» до чужого автора. Слаг уже перевірено SLUG_RE — екранувати
  // його ні для JSON, ні для SQL не треба.
  s = s.replaceAll(AUTHOR_TOKEN, author);
  // Крос-лінки: спершу per-post (довший токен), потім основний.
  s = s.replace(/\/d\/linkedin-post(?![a-z0-9_-])/g, `/d/linkedin-${author}-posts`);
  s = s.replace(/\/d\/linkedin-[a-z0-9_-]+-posts(?![a-z0-9_-])/g, `/d/linkedin-${author}-posts`);
  // Основний лінк: не чіпати linkedin-page і вже підставлені *-posts.
  s = s.replace(
    /\/d\/linkedin-(?!page(?![a-z0-9_-]))(?![a-z0-9_-]*-posts(?![a-z0-9_-]))[a-z0-9_-]+(?![a-z0-9_-])/g,
    `/d/linkedin-${author}`);
  assertOnlyThisAuthor(s, { uid, author, others });
  return s + "\n";
}

const authors = Object.keys(PROFILES).filter((k) => !k.startsWith("_"));
for (const author of authors) {
  if (!SLUG_RE.test(author)) {
    throw new Error(`profiles.json: author slug ${JSON.stringify(author)} does not match ${SLUG_RE} — refusing to put it into SQL`);
  }
}

// Спершу відрендерити й перевірити ВСЕ, і лише потім писати: помилка на
// третьому авторі не повинна лишати в репозиторії два оновлені дашборди з шести.
const rendered = [];
for (const author of authors) {
  const name = PROFILES[author].name || author;
  const others = authors.filter((a) => a !== author);
  rendered.push({
    author,
    main: render(MAIN_TPL, {
      uid: `linkedin-${author}`,
      title: `LinkedIn Stats — ${name}`,
      author,
      others,
      isPosts: false,
    }),
    posts: render(POSTS_TPL, {
      uid: `linkedin-${author}-posts`,
      title: `LinkedIn Stats — ${name} · Per-post`,
      author,
      others,
      isPosts: true,
    }),
  });
}
for (const { author, main, posts } of rendered) {
  writeFileSync(join(GRAFANA_DIR, `linkedin-${author}.json`), main);
  writeFileSync(join(GRAFANA_DIR, `linkedin-${author}-posts.json`), posts);
  console.log(`generated linkedin-${author}.json (+ -posts) -> dash.feed_* where author = '${author}'`);
}
console.log(`\n${authors.length} author dashboard pair(s): ${authors.join(", ")}`);
