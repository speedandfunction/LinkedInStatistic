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

const MAIN_TPL = readFileSync(join(GRAFANA_DIR, "linkedin-oleksandr.json"), "utf8");
const POSTS_TPL = readFileSync(join(GRAFANA_DIR, "linkedin-oleksandr-posts.json"), "utf8");

// Перекласти шаблон на конкретного автора: підмінити uid/title, URL даних і
// внутрішні крос-лінки між дашбордами.
function render(tplText, { uid, title, author }) {
  const d = JSON.parse(tplText);
  d.uid = uid;
  d.title = title;
  let s = JSON.stringify(d, null, 2);
  // URL даних -> папка автора на Pages
  s = s.split("github.io/LinkedInStatistic/stats.json")
       .join(`github.io/LinkedInStatistic/${author}/stats.json`);
  // Крос-лінки (довші токени першими, щоб не порізати частково)
  s = s.split("/d/linkedin-oleksandr-posts").join(`/d/linkedin-${author}-posts`);
  s = s.split("/d/linkedin-oleksandr").join(`/d/linkedin-${author}`);
  s = s.split("/d/linkedin-post/").join(`/d/linkedin-${author}-posts/`);
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
