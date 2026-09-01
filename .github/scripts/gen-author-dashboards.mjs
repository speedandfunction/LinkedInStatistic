#!/usr/bin/env node
// Генерує Grafana-дашборд на кожного автора з profiles.json, використовуючи
// дашборди Олександра як шаблон. Для кожного автора:
//   linkedin-<author>.json        (основний)   uid=linkedin-<author>
//   linkedin-<author>-posts.json  (per-post)   uid=linkedin-<author>-posts
// з даними з його URL .../LinkedInStatistic/<author>/stats.json.
//
// Кількість авторів не зашита — усе з profiles.json. Після генерації
// пушити у Grafana через push-dashboard.mjs (потрібен GRAFANA_SERVICE_ACCOUNT_TOKEN).
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
// за шаблон дашборд якогось автора, друга генерація успадкує його URL —
// саме так у peter-posts колись потрапив фід oleksandr.
const TPL_DIR = join(GRAFANA_DIR, "_template");
const MAIN_TPL = readFileSync(join(TPL_DIR, "author.json"), "utf8");
const POSTS_TPL = readFileSync(join(TPL_DIR, "author-posts.json"), "utf8");

// Перекласти шаблон на конкретного автора: підмінити uid/title, URL даних і
// внутрішні крос-лінки між дашбордами.
function render(tplText, { uid, title, author }) {
  const d = JSON.parse(tplText);
  d.uid = uid;
  d.title = title;
  // $post — це статичний Custom-список, «запечений» у шаблоні. Без очистки
  // кожен автор успадкував би чужі пости. Список наповнює update-post-variable
  // з dashboards/li-stats/<author>/posts/ вже після публікації.
  for (const v of d.templating?.list ?? []) {
    if (v.name === "post") { v.query = ""; v.options = []; v.current = {}; }
  }
  let s = JSON.stringify(d, null, 2);
  // Заміни ідемпотентні: ловлять і кореневий URL шаблону, і вже підставленого
  // автора — тож повторний прогін не «прилипає» до чужого фіда.
  s = s.replace(
    /github\.io\/LinkedInStatistic\/(?:[a-z0-9_-]+\/)?stats\.json/g,
    `github.io/LinkedInStatistic/${author}/stats.json`);
  // Крос-лінки: спершу per-post (довший токен), потім основний.
  s = s.replace(/\/d\/linkedin-post(?![a-z0-9_-])/g, `/d/linkedin-${author}-posts`);
  s = s.replace(/\/d\/linkedin-[a-z0-9_-]+-posts(?![a-z0-9_-])/g, `/d/linkedin-${author}-posts`);
  // Основний лінк: не чіпати linkedin-page і вже підставлені *-posts.
  s = s.replace(
    /\/d\/linkedin-(?!page(?![a-z0-9_-]))(?![a-z0-9_-]*-posts(?![a-z0-9_-]))[a-z0-9_-]+(?![a-z0-9_-])/g,
    `/d/linkedin-${author}`);
  return s + "\n";
}

const authors = Object.keys(PROFILES).filter((k) => !k.startsWith("_"));
for (const author of authors) {
  const name = PROFILES[author].name || author;
  const main = render(MAIN_TPL, {
    uid: `linkedin-${author}`,
    title: `LinkedIn Stats — ${name}`,
    author,
  });
  const posts = render(POSTS_TPL, {
    uid: `linkedin-${author}-posts`,
    title: `LinkedIn Stats — ${name} · Per-post`,
    author,
  });
  writeFileSync(join(GRAFANA_DIR, `linkedin-${author}.json`), main);
  writeFileSync(join(GRAFANA_DIR, `linkedin-${author}-posts.json`), posts);
  console.log(`generated linkedin-${author}.json (+ -posts) -> .../${author}/stats.json`);
}
console.log(`\n${authors.length} author dashboard pair(s): ${authors.join(", ")}`);
