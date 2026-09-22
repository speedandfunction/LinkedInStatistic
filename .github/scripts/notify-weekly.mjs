#!/usr/bin/env node
// Публікує в #linkedin-session-bot ОДНЕ повідомлення на кожен прогін
// щотижневого збору (linkedin-stats-weekly.yml) — щоб неповний тиждень побачила
// людина, а не лише червоний прогін, який ніхто не відкриває.
//
// Навіщо: 14.09 воркфлоу правильно відмовився мерджити неповний тиждень
// (peter:partial maria:exit1), відкрив PR і впав червоним — і два дні цього не
// бачив ніхто. LinkedIn не зберігає історії, тож тиждень, не змерджений до
// наступного понеділка, втрачено назавжди.
//
// Рівно одне повідомлення на прогін. Звідки воно приходить: окремий job
// `notify` у самому кінці воркфлоу (needs: [scrape, publish], if: always()) —
// тож бачить і результат збору, і результат публікації.
//
// Тиждень змерджено (MAIN_UPDATED=true) — далі вирішує publish:
//   1a. задеплоєно і publish зелений — «collected and published», без пінгу;
//   1b. задеплоєно, але publish червоний/недоїхав — впав лише рефреш $post у
//       Grafana: дані ЖИВІ, пікер постів може не мати постів тижня. Без пінгу і
//       без дедлайну (обґрунтування — біля коду);
//   1c. НЕ задеплоєно (publish failure/cancelled) — тиждень у безпеці на main,
//       але на GitHub Pages НЕ опублікований (публічний JSON-фід і пікер $post
//       лишились старі): @оператор, «запусти pages-deploy», і прямим текстом —
//       дедлайну втрати даних тут НЕМАЄ. Про дашборди тут НЕ кажемо «не
//       оновлені»: Grafana читає базу, а не Pages (див. 1e);
//   1d. publish SKIPPED, хоча main оновлено — не мав так поводитись; чесно
//       кажемо «не опубліковано», @оператор, pages-deploy;
//   1e. sync у базу не "ok" (або parity не "ok") — ДАШБОРДИ НЕ ОНОВЛЕНІ або
//       можуть брехати, хоч би що сталося з publish: Grafana читає Postgres
//       (dash.feed_*). Тиждень у безпеці в git, але @оператор і «що робити» —
//       без людини дашборди так і лишаться на минулому синку.
// Тиждень НЕ змерджено:
//   2. PR відкритий — тиждень не опублікований: посилання на PR, проблема
//      кожного автора людськими словами, дедлайн (жорсткий, понеділок) і
//      @-згадка оператора;
//   3. прогін упав до того, як з'явився PR — @-згадка оператора і посилання на
//      сам прогін.
//
// Окремий режим NOTIFY_MODE=pages-deploy — для ручного pages-deploy.yml
// (buildPagesDeployMessage): провал деплою пінгує оператора, успіх закриває
// петлю одним рядком без пінгу.
//
// Рядок бази даних (етап dual-write, databaseLine): JSON у git лишається
// джерелом правди для ЗІБРАНОГО ТИЖНЯ, а після мерджу ті самі дані
// синхронізуються в Postgres, звіряються (parity) і бекапляться. Але ДАШБОРДИ
// Grafana тепер читають саме базу (dash.feed_*), а не JSON на Pages — тож
// наслідки діляться на два класи:
//   (а) дашборди зачеплені — sync не "ok" (зокрема порожньо = «невідомо») або
//       parity не "ok" після синку, що пройшов. Grafana показує минулий синк
//       (або числа, які не звірено з JSON). Це 1e: заголовок усього повідомлення
//       каже «dashboards NOT updated / may be WRONG», @оператор, червоний рядок
//       бази з причиною, ДІЄЮ (найчастіше — розбудити приспаний проєкт Supabase
//       і запустити pages-deploy) і реченням, що тиждень у git цілий;
//   (б) лише бекап — sync і parity "ok", а backup ні. Тиждень і дашборди в
//       порядку, бракує тільки точки відновлення: помаранчевий рядок, без пінгу.
// Коли всі три пройшли — лише сірий рядок-підтвердження в кінці: відсутність
// рядка нічого не доводить (так само виглядає прогін, де DB_* не доїхали).
// Обидва класи однакові в обох режимах (щотижневий і pages-deploy).
//
// Авторів (Peter, Andy, Maria) НЕ тегаємо ніколи, навіть мапнутих у
// SLACK_PEOPLE_JSON: скрап вони полагодити не можуть, а пінг, з яким нічого не
// зробиш, привчає глушити бота. Тегаємо тільки `_operator`.
//
// Транспорт, ретраї на 429, escape/safeUrl і підказки до кодів помилок —
// спільні з notify-session-check.mjs (звідти й імпорт), бо канал той самий.
//
// Мова: усе, що бачить Slack і лог, — англійською; коментарі — українською,
// як у решті репозиторію.
//
//   node .github/scripts/notify-weekly.mjs
//   SLACK_DRY_RUN=1 NOTIFY_MODE=pages-deploy DEPLOY_RESULT=failure node .github/scripts/notify-weekly.mjs
//   SLACK_DRY_RUN=1 WEEK=2026-09-14 CLEAN=0 NOTES="peter:partial" PR_URL=… node .github/scripts/notify-weekly.mjs
//
// Env (у CI все приходить через `env:` кроку, НІКОЛИ не через ${{ }} у run:):
//   SLACK_BOT_TOKEN    xoxb-…; без нього — ::warning:: і нічого не шлемо
//   SLACK_CHANNEL_ID   C… каналу #linkedin-session-bot
//   SLACK_PEOPLE_JSON  {"_operator": "U…", …} — звідси беремо ТІЛЬКИ _operator
//   SLACK_DRY_RUN      "1" — stdout = JSON-масив payload'ів, нічого не шле
//   WEEK               ISO-понеділок прогону (steps.week.outputs.week)
//   CLEAN              "1"/"0" зі скрапу (steps.scrape.outputs.clean)
//   NOTES              "peter:partial maria:exit1" (steps.scrape.outputs.notes)
//   INVALID_JSON       "1", якщо снапшот обрізало і його відкотили
//   BRANCH             гілка, яку вдалося запушити (steps.commit.outputs.branch)
//   PR_URL             PR, існування якого перевірено (steps.commit.outputs.pr_url)
//   MAIN_UPDATED       "true" лише після успішного мерджу
//   SCRAPE_RESULT      needs.scrape.result — success/failure/cancelled; таймаут
//                      job'а теж приходить як "cancelled"
//   PUBLISH_RESULT     needs.publish.result — success/failure/cancelled/skipped
//   DEPLOYED           needs.publish.outputs.deployed — "true" ЛИШЕ якщо крок
//                      actions/deploy-pages пройшов; порожньо, якщо він упав
//                      або publish не запускався
//   PAGE_URL           needs.publish.outputs.page_url
//   NOTIFY_MODE        "pages-deploy" — повідомлення ручного pages-deploy.yml;
//                      тоді читаються BUILD_RESULT, DEPLOY_RESULT,
//                      REFRESH_RESULT, PAGE_URL і GITHUB_ACTOR замість полів вище
//   DB_SYNC            needs.db-sync.outputs.sync — "ok" | "skipped-no-secret" |
//                      "failed:<phase>" (connect = база не відповіла: найчастіше
//                      пауза Supabase) | "timeout:<phase>"; порожньо — job не
//                      дійшов до кінця (це НЕ «добре», а «невідомо»)
//   DB_PARITY          needs.db-sync.outputs.parity — "ok" | "differs" | "incomplete" |
//                      "error" | "timeout"; порожньо — не запускалась
//   DB_BACKUP          needs.db-backup.outputs.backup — "ok" | "skipped-no-secret" |
//                      "failed:<phase>" | "timeout:<phase>"; порожньо — не запускався
//   DB_BACKUP_EXPECTED "true", якщо цей прогін мав робити бекап (щотижневий —
//                      завжди; pages-deploy — лише з галочкою backup)
//                      Якщо ЖОДНОЇ з чотирьох DB_* змінних немає в env зовсім —
//                      стан бази для цього виклику НЕВІДОМИЙ (локальний dry-run;
//                      у CI вони визначені завжди). Тоді повідомлення нічого не
//                      стверджує про дашборди («up to date» без доказу — той
//                      самий тихий нуль) і каже це одним сірим рядком, без пінгу.
//   PROFILES_FILE      profiles.json — імена авторів (за замовчуванням шлях репо)
//   GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID — посилання на прогін
//
// Коди виходу: 0 — завжди, коли проблема на боці Slack (нема токена, мертвий
// токен, 429, мережа). Це свідомо інакше, ніж у notify-session-check.mjs:
// висновок щотижневого прогону означає «тиждень доїхав чи ні» (WEEKLY-CADENCE.md
// §8), і збій сповіщення не має права перефарбувати зелений тиждень у червоний.
// Тому кожен такий збій — гучний ::warning:: у лозі, а не exit-код.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import {
  escape, safeUrl, kyivTime, relative, section, context, slackPost, remedy, MEMBER_ID,
} from "./notify-session-check.mjs";

const TOKEN = process.env.SLACK_BOT_TOKEN ?? "";
const CHANNEL = process.env.SLACK_CHANNEL_ID ?? "";
const DRY_RUN = process.env.SLACK_DRY_RUN === "1";
const DEFAULT_PROFILES = ".claude/skills/linkedin-stats/profiles.json";
const DAY_MS = 86400e3;

// ------------------------------------------------------------- коди нотаток

// Коди — з кроку "Scrape every author" у linkedin-stats-weekly.yml (і таблиця
// в WEEKLY-CADENCE.md §8). Людські слова — для каналу; сам код лишаємо в
// бектиках поруч, бо саме за ним оператор шукає рядок у лозі.
// Додаєш код у воркфлоу — додай і сюди, інакше він прийде як «unexpected problem».
const LABELS = {
  // exit 10 — це не лише реакції: частина постів чи сторінок теж могла не
  // дочитатись (або спрацював м'який дедлайн). Формулювання не обіцяє більше,
  // ніж знає.
  partial: [":warning:", "some posts or reactions not fully read"],
  // exit 11 — тиждень ПОВНИЙ: не дочиталися лише списки тих, хто реагував, і
  // саме ці пости наступний прогін відкриє знову (`short_read` на цілі). Тому
  // це не :warning: і не привід тримати тиждень у ревʼю — просто сказано вголос.
  // Фраза НЕ починається з «collected»: authorRows зшиває нотатки одного
  // автора крапкою з комою, і поруч із червоним `nodata` («nothing collected»)
  // вийшло б «collected …; nothing collected».
  "reactors-short": [":white_check_mark:", "a reaction list was incomplete, it is re-read next run"],
  auth: [":red_circle:", "logged out of LinkedIn"],
  ratelimit: [":red_circle:", "rate-limited by LinkedIn"],
  hardcap: [":red_circle:", "timed out"],
  nodata: [":red_circle:", "nothing collected"],
  noweek: [":red_circle:", "nothing collected"],
  "skipped-budget": [":red_circle:", "not reached, time budget spent"],
  drift: [":red_circle:", "scrape failed"],
  locked: [":red_circle:", "scrape failed"],
  fs: [":red_circle:", "scrape failed"],
};

export function describe(code) {
  if (Object.prototype.hasOwnProperty.call(LABELS, code)) return LABELS[code];
  if (/^exit\d+$/.test(code)) return [":red_circle:", "scrape failed"];
  return [":grey_question:", "unexpected problem"];
}

// "peter:partial maria:exit1" -> [{slug: "peter", code: "partial"}, …]
export function parseNotes(notes) {
  return String(notes ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .map((tok) => {
      const i = tok.indexOf(":");
      return i > 0 ? { slug: tok.slice(0, i), code: tok.slice(i + 1) } : { slug: null, code: tok };
    });
}

// Один рядок на автора. `assumeCollected` — чи можна чесно сказати «collected»
// про автора без нотатки. Можна лише тоді, коли цикл скрапу дійшов до кінця
// (є PR): там кожен автор або отримав нотатку, або пройшов усі перевірки. Після
// краху мовчання про автора означає «невідомо», а не «все добре».
export function authorRows(profiles, notes, { assumeCollected }) {
  const bySlug = new Map();
  const loose = [];
  for (const n of notes) {
    if (!n.slug) { loose.push(n.code); continue; }
    if (!bySlug.has(n.slug)) bySlug.set(n.slug, []);
    bySlug.get(n.slug).push(n.code);
  }
  // Спершу — порядок profiles.json (так їх скрапить воркфлоу), потім ті, кого
  // нотатки називають, а профілі ні: загубити проблему гірше, ніж показати slug.
  const names = new Map(profiles.map((p) => [p.slug, p.name || p.slug]));
  const slugs = [...profiles.map((p) => p.slug), ...[...bySlug.keys()].filter((s) => !names.has(s))];

  const rows = [];
  for (const slug of slugs) {
    const who = `*${escape(names.get(slug) ?? slug)}*`;
    const codes = bySlug.get(slug) ?? [];
    if (!codes.length) {
      if (assumeCollected) rows.push(`:white_check_mark: ${who} — collected`);
      continue;
    }
    const described = codes.map(describe);
    const icon = described.find(([i]) => i === ":red_circle:")?.[0] ?? described[0][0];
    const words = [...new Set(described.map(([, w]) => w))].join("; ");
    const raw = codes.map((c) => `\`${escape(c)}\``).join(", ");
    rows.push(`${icon} ${who} — ${words} (${raw})`);
  }
  for (const code of loose) rows.push(`${describe(code)[0]} ${escape(describe(code)[1])} (\`${escape(code)}\`)`);
  return rows;
}

// ------------------------------------------------------------- дедлайн

// Той самий вираз, що isoWeekMonday() у scrape-weekly.mjs і крок "Resolve ISO
// week" у воркфлоу — фолбек на випадок краху до того кроку.
function isoMonday(now) {
  const d = new Date(now);
  const day = (d.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day)).toISOString().slice(0, 10);
}

export const validWeek = (w) => /^\d{4}-\d{2}-\d{2}$/.test(w ?? "") && !Number.isNaN(Date.parse(`${w}T00:00:00Z`));

// Наступний понеділок 00:00 UTC — рівно cron "0 0 * * 1" цього воркфлоу. Тоді
// стартує новий прогін з main, і тиждень, якого там немає, дозібрати вже нічим.
// Міняєш cron — міняй і тут.
export function deadlineFor(week, now = Date.now()) {
  const monday = validWeek(week) ? week : isoMonday(now);
  return new Date(Date.parse(`${monday}T00:00:00Z`) + 7 * DAY_MS).toISOString();
}

function deadlineLine(week, now, action) {
  const at = deadlineFor(week, now);
  const when = escape(kyivTime(at));
  if (Date.parse(at) <= now) {
    // Перезапуск старого прогону: «до понеділка» у минулому читається як баг бота.
    return `:warning: *The deadline has already passed* — the next weekly run started on Monday ${when}. This week may already be lost.`;
  }
  return `:alarm_clock: *Deadline: Monday ${when}* (${escape(relative(at, now))}) — that is when the next weekly run ` +
    `starts from main, and LinkedIn keeps no history. ${action}, or this week is lost for good.`;
}

// ------------------------------------------------------------- дрібниці

export function operatorId(raw) {
  // Значення мапи НЕ друкуємо ніде: це реєстр людей, а репозиторій публічний.
  if (!raw || !String(raw).trim()) return { id: null, problem: "SLACK_PEOPLE_JSON is not set" };
  let people;
  try {
    people = JSON.parse(raw);
  } catch {
    return { id: null, problem: "SLACK_PEOPLE_JSON is not valid JSON" };
  }
  if (!people || typeof people !== "object" || Array.isArray(people)) {
    return { id: null, problem: "SLACK_PEOPLE_JSON is not a JSON object" };
  }
  const id = people._operator;
  if (id == null || id === "") return { id: null, problem: "SLACK_PEOPLE_JSON has no _operator entry" };
  if (!MEMBER_ID.test(String(id))) {
    return { id: null, problem: "SLACK_PEOPLE_JSON _operator does not look like a member id (U… or W… expected)" };
  }
  return { id: String(id), problem: null };
}

export function readProfiles(path) {
  try {
    const p = JSON.parse(readFileSync(resolve(path), "utf8"));
    return Object.keys(p)
      .filter((k) => !k.startsWith("_"))
      .map((slug) => ({ slug, name: typeof p[slug]?.name === "string" ? p[slug].name : "" }));
  } catch {
    return null;
  }
}

const isHttpUrl = (u) => /^https?:\/\/\S+$/.test(u ?? "");

function runUrl(env) {
  const { GITHUB_SERVER_URL: s, GITHUB_REPOSITORY: r, GITHUB_RUN_ID: id } = env;
  return s && r && id ? `${s}/${r}/actions/runs/${id}` : null;
}

const prLabel = (url) => {
  const m = String(url).match(/\/pull\/(\d+)/);
  return m ? `pull request #${m[1]}` : "the pull request";
};

const link = (url, label) => (isHttpUrl(url) ? `<${safeUrl(url)}|${label}>` : label);

const dashboardsRef = (pageUrl) => (isHttpUrl(pageUrl) ? `Published to ${link(pageUrl, "GitHub Pages")}. ` : "");

// Що сталося з публікацією змердженого тижня. Два НЕЗАЛЕЖНІ сигнали, бо
// needs.publish.result один їх не розрізняє: червоний publish — це і «деплой
// упав» (дашборди старі), і «деплой пройшов, упав лише рефреш Grafana» (дані
// живі). DEPLOYED="true" пише окремий крок одразу після actions/deploy-pages,
// тож він є лише тоді, коли деплой справді пройшов; якщо деплой упав, крок не
// запускається і output порожній — тобто «не підтверджено», а не «так».
//   published     — задеплоєно і publish зелений
//   picker-stale  — задеплоєно, але publish не зелений (лише рефреш $post)
//   not-deployed  — publish запускався (failure/cancelled, або success без
//                   маркера — не підтверджено), а деплою немає
//   skipped       — publish не запускався зовсім (skipped або результату нема)
export function publishState(publishResult, deployed) {
  if (deployed === "true") return publishResult === "success" ? "published" : "picker-stale";
  if (publishResult === "skipped" || !publishResult) return "skipped";
  return "not-deployed";
}

// ------------------------------------------------------------- база даних

// Етап dual-write. Стан кожного кроку приходить з воркфлоу як "<state>[:<phase>]".
// Порожній рядок — «job не дописав output»: впав раніше, був скасований, не
// стартував. Це НІКОЛИ не «все добре» — звичний для цього репозиторію тихий нуль
// виглядає саме так.
const DB_PHASES = {
  checkout: "checking out main",
  "script-missing": "a db/ script is missing on main",
  deps: "installing the db/ dependencies",
  connect: "could not connect to the database",
  import: "the import",
  client: "installing the PostgreSQL 17 client",
  dump: "pg_dump",
  push: "pushing to the backup repository",
};

// Що робити. Крон ходить рівно раз на 7 днів, а безкоштовний Supabase присипляє
// проєкт після 7 днів без запитів — тож «база не відповіла в понеділок» майже
// завжди означає «проєкт на паузі». Без цього речення рядок у Slack називав
// збій, але не причину й не дію. Тримати в парі з RESUME у db-ci.mjs.
export const RESUME_ACTION = "Most likely the Supabase project is *paused* (the free tier pauses after 7 idle days) — resume it in the Supabase dashboard, then run `pages-deploy` to re-sync; the import is idempotent";
const IMPORT_ACTION = "The import connected and then rolled back, so the database is as it was — the hints in the `db-sync` job name the cause (a permission, a constraint); fix it, then run `pages-deploy` to re-sync";
const INCOMPLETE_ACTION = "Compare the author folders under `dashboards/li-stats/` with `profiles.json`: a folder that is not in `profiles.json` is published to Pages but never imported. The counts are in the `db-sync` job. *This week does not count as verified*";
const RECHECK_ACTION = "Run `pages-deploy` to re-sync and re-check (the import is idempotent); if the database does not answer, check in the Supabase dashboard that the project is not paused. *This week does not count as verified*";
const SECRET_ACTION = "Create the `LI_SYNC_DATABASE_URL` repository secret (the DSN of the `li_sync` role — WEEKLY-CADENCE.md section 9), then run `pages-deploy` to sync";
const DEPS_ACTION = "Usually the npm registry had a bad moment — run `pages-deploy` to re-sync (the import is idempotent); if it fails again, the `db-sync` job shows npm's own error";
const LOOK_ACTION = "Open the `db-sync` job of the run to see where it stopped, fix the cause, then run `pages-deploy` to re-sync (the import is idempotent)";
// Дві різниці, які НЕ є багом даних і які не лагодить жодна правка коду, названі
// першими: інакше оператор з пінгом «may be WRONG» іде шукати баг, якого нема.
// Тримати в парі з SCHEMA_HINT у db-ci.mjs.
const DIFFERS_ACTION = "Look at the `db-sync` job of the run: it lists every differing path (values are hashed, never shown). " +
  "If every line is `[feed-absent]` on a `dash.feed_*` view, the schema in the database is older than `main` — re-apply it (`apply-schema --force`, then `import --publish`; db/README.md), there is no data bug to look for. " +
  "`[grant-missing]` means the role Grafana logs in as (`grafana_ro`) lost a privilege and the panels answer `permission denied` — re-apply the ROLES section of `db/schema.sql`. " +
  "Anything else: reproduce it locally with `node db/verify.mjs --show-values`, fix the cause, then run `pages-deploy` to re-sync and re-check";

// Дія для стану sync / parity. Кожен не-"ok" стан тут — клас (а): оператора
// пінгують, а пінг без «що робити» — це пінг, з яким нічого не зробиш. Тому дія
// є ЗАВЖДИ; null — лише для "ok". Невідомий стан чи фаза — «відкрий job».
function syncAction(raw) {
  const { state, phase } = splitState(raw);
  if (state === "ok") return null;
  if (state === "timeout" && (phase === "import" || phase === "connect")) return RESUME_ACTION;
  if (state === "failed" && phase === "connect") return `${RESUME_ACTION}. If the \`db-sync\` job shows \`password authentication failed\` or \`does not exist\` instead of a timeout, the \`LI_SYNC_DATABASE_URL\` secret is wrong`;
  // failed:import — імпорт ПІДКЛЮЧИВСЯ і впав усередині транзакції (db-ci.mjs
  // відрізняє це від failed:connect за власним рядком імпортера). Пауза так не
  // виглядає, тож і радити «розбудіть проєкт» тут було б брехнею.
  if (state === "failed" && phase === "import") return IMPORT_ACTION;
  if (state === "skipped-no-secret") return SECRET_ACTION;
  if ((state === "failed" || state === "timeout") && phase === "deps") return DEPS_ACTION;
  return LOOK_ACTION;
}

function parityAction(raw) {
  const { state } = splitState(raw);
  if (state === "ok") return null;
  if (state === "differs") return DIFFERS_ACTION;
  if (state === "incomplete") return INCOMPLETE_ACTION;
  // error / timeout / порожньо (не запускалась) — перевірка нічого не порівняла:
  // це не доказ різниці й не доказ збігу, тож просто повторити.
  if (state === "error" || state === "timeout" || state === "") return RECHECK_ACTION;
  return LOOK_ACTION;
}

// Що sync / parity означають для ДАШБОРДІВ. Grafana читає Postgres (dash.feed_*),
// тож саме ці два стани, а не деплой Pages, вирішують, що людина побачить у Grafana:
//   null        — етапу бази для цього виклику немає (локальний dry-run): невідомо;
//   "fresh"     — sync ok і parity ok: дашборди показують цей тиждень, і він звірений;
//   "stale"     — sync не "ok" (зокрема порожньо): база лишилась на минулому синку;
//   "unverified" — sync ok, parity ні: база оновлена, але не доведено, що вона
//                 збігається з JSON-збіркою, — числа можуть відрізнятись.
// Бекап сюди не входить свідомо: він нічого не змінює в тому, що читає Grafana.
export function dashboardsState(db) {
  if (db == null) return null;
  if (splitState(db.sync).state !== "ok") return "stale";
  return splitState(db.parity).state === "ok" ? "fresh" : "unverified";
}

// База НЕ ВІДПОВІЛА (не підключились або зависли до капа) — це не «stale».
// Grafana читає ТУ САМУ базу: приспаний проєкт не відповідає і їй, тож панелі
// показують помилку датасорса, а не числа минулого тижня. Поруч із порадою
// «розбудіть проєкт» речення «дашборди показують минулий синк» було б
// суперечністю. failed:import сюди НЕ входить: там база відповіла й відмовила.
// Тримати в парі з DASHBOARDS_DOWN у db-ci.mjs.
export function databaseUnreachable(sync) {
  const { state, phase } = splitState(sync);
  return (state === "failed" && phase === "connect") || (state === "timeout" && (phase === "connect" || phase === "import"));
}
const UNTIL_DOWN = "so while the project is paused or unreachable Grafana cannot read it either: every panel shows a datasource error — *not* last week's numbers — until the database answers again; after that the dashboards show the previous sync until `pages-deploy` has re-run";

// Слова для класу (а) — одні на обидва режими і на заголовок, summary та fallback.
const DASHBOARDS = {
  stale: {
    verdict: "were NOT updated",
    why: "they read the database, and the database sync did not succeed",
    short: "the Grafana dashboards were NOT updated",
    fix: "fix the database sync, then run pages-deploy",
    until: "so the dashboards keep showing the previous sync (last week's numbers) until this is fixed and `pages-deploy` has re-run",
  },
  unverified: {
    verdict: "may be WRONG",
    why: "they read the database, and the parity check did not confirm that it matches the JSON build",
    short: "the Grafana dashboards may be WRONG",
    fix: "check the parity result in the db-sync job, then run pages-deploy",
    until: "and this sync is not confirmed to match the JSON build — so the dashboards may show numbers that differ from it until this is fixed and `pages-deploy` has re-run with a clean parity check",
  },
};

// Пікер $post пушиться лише ПІСЛЯ успішного синку (if: у обох воркфлоу):
// update-post-variable.mjs робить дефолтом найновіший пост із метриками, а його
// в базі ще немає — кожна панель -posts дашбордів відкривалась би як «No data».
const PICKER_HELD_BACK = ":information_source: The `$post` picker was deliberately *not* refreshed: it is pushed only after a successful database sync, " +
  "so it cannot default to a post the database does not have yet. It still lists last week's posts; the `pages-deploy` re-run refreshes it.";

// Стан бази до нотифаєра не доїхав зовсім (жодної DB_* змінної).
const DB_UNKNOWN = ":grey_question: No database result reached this message (no `DB_*` inputs), so it says nothing about the Grafana dashboards — they read the database, not GitHub Pages.";
const DB_UNKNOWN_PLAIN = "database: no result reached the notifier, so nothing is claimed about the Grafana dashboards";

function splitState(raw) {
  const s = String(raw ?? "").trim();
  const i = s.indexOf(":");
  return i > 0 ? { state: s.slice(0, i), phase: s.slice(i + 1) } : { state: s, phase: "" };
}

const phaseWords = (phase) => (phase
  ? ` (${Object.prototype.hasOwnProperty.call(DB_PHASES, phase) ? DB_PHASES[phase] : `\`${escape(phase)}\``})`
  : "");

// Один крок (sync або backup) -> фраза або null, якщо він пройшов.
function stepProblem(what, raw, missingSecrets) {
  const { state, phase } = splitState(raw);
  if (state === "ok") return null;
  if (state === "skipped-no-secret") return `the ${what} was *skipped* — ${missingSecrets}`;
  if (state === "failed") return `the ${what} *FAILED*${phaseWords(phase)}`;
  if (state === "timeout") return `the ${what} *timed out*${phaseWords(phase)} — the database did not answer in time`;
  if (state === "") return `the ${what} *did not run or did not finish*`;
  return `the ${what} ended in an unexpected state (\`${escape(state)}\`)`;
}

function parityProblem(raw) {
  const { state } = splitState(raw);
  if (state === "ok") return null;
  if (state === "differs") return "the parity check found a *DIFFERENCE* between the database and the JSON build";
  if (state === "incomplete") return "the parity check was *INCOMPLETE* — it found no difference, but it compared fewer feeds than `main` publishes, so a feed that is on Pages was never checked against the database";
  if (state === "error") return "the parity check *could not be completed* (it failed before it compared anything)";
  if (state === "timeout") return "the parity check *timed out* — the database did not answer in time";
  if (state === "") return "the parity check *did not run*";
  return `the parity check ended in an unexpected state (\`${escape(state)}\`)`;
}

// db === undefined/null — для цього виклику етапу бази не існує (старі тести,
// локальний dry-run): нічого не додаємо. Інакше:
//   { problems: [], ok }        — sync, parity і backup пройшли: лише сірий рядок ok;
//   { problems: [...], text }   — один рядок для Slack; plain — він же без розмітки
//                                 (для логу, summary і fallback-тексту пуша).
// dashboards — dashboardsState(db): "stale"/"unverified" = клас (а), дашборди
// зачеплені (пінг ставить білдер повідомлення, не цей рядок); "fresh" з
// проблемами = клас (б), лише бекап.
// Parity і backup залежать від sync: якщо sync не пройшов, їхній стан не
// перераховуємо окремо, а кажемо одним реченням, що вони через це не запускались.
export function databaseLine(db) {
  if (db == null) return { problems: [], actions: [], text: null, plain: null, dashboards: null };
  const { sync = "", parity = "", backup = "", backupExpected = false } = db;
  const dashboards = dashboardsState(db);
  const problems = [];

  const syncProblem = stepProblem("sync", sync, "the `LI_SYNC_DATABASE_URL` secret is not set");
  const actions = [];
  let backupProblem = null;
  if (syncProblem) {
    // НЕВІДОМИЙ стан sync (не failed / timeout / skipped / порожньо) поруч із
    // parity=ok давав речення, що суперечило власним входам: «…did not run
    // either», хоча вони відзвітували. У CI так не буває (db-ci.mjs пише parity
    // лише після sync=ok, backup має needs на sync == 'ok'), тож для відомих
    // станів речення лишається як було; для невідомого кажемо, що саме приїхало.
    const known = ["failed", "timeout", "skipped-no-secret", ""].includes(splitState(sync).state);
    const downstream = [["parity check", parity], ...(backupExpected ? [["backup", backup]] : [])];
    const reported = known ? [] : downstream.filter(([, v]) => String(v ?? "").trim() !== "");
    problems.push(reported.length
      ? `${syncProblem} — although ${reported.map(([k, v]) => `the ${k} reported \`${escape(String(v).trim())}\``).join(" and ")}, which cannot be trusted without a successful sync`
      : `${syncProblem}, so the parity check${backupExpected ? " and the backup" : ""} did not run either`);
    const a = syncAction(sync);
    if (a) actions.push(a);
  } else {
    const p = parityProblem(parity);
    if (p) problems.push(p);
    const a = parityAction(parity);
    if (a) actions.push(a);
    if (backupExpected) {
      backupProblem = stepProblem("backup", backup, "`LI_BACKUP_DATABASE_URL` and/or `LI_BACKUP_DEPLOY_KEY` is not set");
      if (backupProblem) problems.push(backupProblem);
    }
  }
  if (!problems.length) {
    // Один сірий рядок-підтвердження. «Все добре» колись означало «про базу ані
    // слова» — а так само виглядає і прогін, де DB_* до нотифаєра не доїхали.
    // Відсутність рядка — не доказ; це знову той самий тихий нуль. Відколи
    // Grafana читає базу, цей рядок — ще й єдиний позитивний запис у каналі, що
    // дашборди справді оновлені. Сірий (context), бо дії не потребує.
    const bits = ["synced", "parity byte-identical", backupExpected ? "backup pushed" : "backup not requested for this run"];
    return {
      problems, actions: [], text: null, plain: null, dashboards,
      ok: `:white_check_mark: Database (Grafana reads it): ${bits.join(" · ")}`,
      okPlain: `database (dual-write): ${bits.join(", ")}`,
    };
  }

  const strip = (t) => t.replace(/[*`]/g, "");
  const what = actions.length ? `:point_right: ${actions.join(". ")}.\n` : "";

  // Клас (б): sync і parity "ok", не вдався лише бекап. Те, що читає Grafana,
  // оновлене і звірене, тиждень у git — бракує тільки точки відновлення.
  if (dashboards === "fresh") {
    const text = `:large_orange_diamond: *Database (dual-write stage):* ${problems.join("; ")}.\n` +
      "*The week and the dashboards are not affected* — the week is safe in git, and the database Grafana reads was synced and matches the JSON build; " +
      "only this run's backup (the restore point) is missing. Nobody is pinged for this; the details are in the `db-backup` job of the run.";
    const plain = `database (dual-write): ${strip(problems.join("; "))} — the week and the dashboards are not affected (synced, parity ok), only the backup is missing`;
    return { problems, actions, text, plain, dashboards };
  }

  // Клас (а): Grafana читає базу, тож це вже не «тиждень не постраждав, крапка».
  // Три речі, і всі три обов'язкові: що сталося, ЩО РОБИТИ, і що сам тиждень у
  // git цілий (без останнього це читається як втрата даних, а її тут немає).
  const dash = DASHBOARDS[dashboards];
  const text = `:red_circle: *Database (dual-write stage):* ${problems.join("; ")}.\n` + what +
    ":shield: *The collected week is safe in git* — nothing is lost and there is no data-loss deadline. " +
    `But Grafana reads the database, ${dashboards === "stale" && databaseUnreachable(sync) ? UNTIL_DOWN : dash.until}. ` +
    `The details are in the ${backupProblem ? "`db-sync` / `db-backup` jobs" : "`db-sync` job"} of the run.`;
  const plain = `database (dual-write): ${strip(problems.join("; "))} — ${dash.short}` +
    (dashboards === "stale" && databaseUnreachable(sync) ? " (and cannot be read at all while the database does not answer)" : "") +
    "; the collected week is safe in git" +
    (actions.length ? `. What to do: ${strip(actions.join(". "))}` : "");
  return { problems, actions, text, plain, dashboards };
}

// Вбудовує рядок бази в готове повідомлення: окремий section одразу під
// головним (не context — той сірий і дрібний, а рядок має бути видно), хвіст у
// fallback-тексті пуша і в summary для логу. Коли з базою все добре — головний
// блок, fallback-текст і вердикт НЕ змінюються; додається лише сірий context у
// самому кінці (позитивний запис) і хвіст у summary для логу. Без
// ::warning:: — built.database лишається порожнім.
// Клас (а) сюди приходить уже з «дашбордним» заголовком, пінгом і fallback-
// текстом: їх ставить weeklyCore/pagesCore за line.dashboards, бо пінг живе в
// головному блоці, а не в рядку бази. Тут fallback доповнюємо лише для класу (б).
function withDatabase(built, line) {
  // Жодної DB_* змінної: про базу невідомо НІЧОГО. Grafana читає базу, тож
  // головний блок у цьому разі про дашборди мовчить (див. weeklyCore/pagesCore),
  // а тут кажемо чому — інакше мовчання читалось би як «усе добре». Без пінгу і
  // без ::warning::: у CI так не буває, це локальний dry-run.
  if (line.dashboards === null) {
    return {
      ...built,
      summary: `${built.summary}; ${DB_UNKNOWN_PLAIN}`,
      payload: { ...built.payload, blocks: [...built.payload.blocks, context(DB_UNKNOWN)] },
    };
  }
  if (!line.text && line.ok) {
    return {
      ...built,
      summary: `${built.summary}; ${line.okPlain}`,
      payload: { ...built.payload, blocks: [...built.payload.blocks, context(line.ok)] },
    };
  }
  if (!line.text) return built;
  const blocks = [built.payload.blocks[0], section(line.text), ...built.payload.blocks.slice(1)];
  const text = line.dashboards === "fresh"
    ? `${built.payload.text} — the database backup needs a look (the week and the dashboards are fine)`
    : built.payload.text;
  return {
    ...built,
    database: line.plain,
    summary: `${built.summary}; ${line.plain}`,
    payload: { ...built.payload, text, blocks },
  };
}

// ------------------------------------------------------------- збірка

// Чистий білдер: жодного env, мережі чи файлів — усе приходить аргументом.
// summary — той самий вердикт без @-згадки: він іде в лог, а id оператора —
// зі секрету, і в публічний лог Actions йому не можна (маска GitHub ловить
// лише ЦІЛЕ значення секрету, а не шматок мапи).
export function buildWeeklyMessage(input) {
  // Синк запускається ЛИШЕ з main після мерджу (needs.scrape.outputs.main_updated
  // == 'true'): тільки тоді він «очікувався». Незмерджений тиждень у базу й не
  // мав потрапити — там про базу мовчимо, щоб «did not run» не читалось як збій.
  if (input.mainUpdated !== "true") return weeklyCore(input);
  const line = databaseLine(input.db);
  return withDatabase(weeklyCore({ ...input, dashboards: line.dashboards }), line);
}

function weeklyCore(input) {
  const {
    channel, week, clean, notes, invalidJson, branch, prUrl, mainUpdated,
    scrapeResult, publishResult = "", deployed = "", pageUrl = "",
    profiles, operator, runLink, now = Date.now(), dashboards = null,
  } = input;

  const parsed = parseNotes(notes);
  const weekName = validWeek(week) ? `Week ${escape(week)}` : "This week";
  const runRef = runLink ? `<${safeUrl(runLink)}|run log>` : "run log";
  const opPing = operator ? `<@${operator}> ` : "";
  const noOperator = operator
    ? null
    : context(":information_source: No `_operator` id is mapped in SLACK_PEOPLE_JSON, so nobody was pinged — someone has to pick this up by hand.");

  // 1. Змерджений. MAIN_UPDATED пишеться ЛИШЕ після успішного `gh pr merge`,
  // тож це єдиний надійний доказ, що тиждень на main. Що сталося далі — вирішує
  // publishState(): «published» пишемо лише тоді, коли деплой ПІДТВЕРДЖЕНО.
  if (mainUpdated === "true") {
    const rows = authorRows(profiles, parsed, { assumeCollected: true });
    const merged = isHttpUrl(prUrl) ? `${link(prUrl, prLabel(prUrl))} was merged automatically. ` : "";
    const state = publishState(publishResult, deployed);
    const withRows = (head) => section(rows.length ? `${head}\n${rows.join("\n")}` : head);
    const payloadOf = (text, blocks) => ({ channel, text, unfurl_links: false, unfurl_media: false, blocks });
    const pickerHow = publishResult === "failure" ? "failed" : "did not finish";
    // Чому тиждень не на Pages (для not-deployed / skipped).
    const why = {
      "not-deployed": publishResult === "cancelled"
        ? "the publish job was cancelled before the deploy finished"
        : publishResult === "success"
          ? "the publish job did not confirm the deploy"
          : "the deploy to GitHub Pages failed",
      skipped: `the publish job did not run (result: \`${escape(publishResult || "unknown")}\`), although it should after a merge`,
    }[state];

    // 1e. Клас (а): sync або parity не "ok". Перевіряється ПЕРШИМ, бо Grafana
    // читає базу: хоч би яким зеленим був publish, дашборди лишились на минулому
    // синку (або не звірені), і заголовок не має права казати «up to date».
    // Пінгуємо з тієї ж причини, що й 1c: без людини це не мине саме. Причина,
    // дія і «тиждень у git цілий» — у рядку бази одразу під заголовком
    // (withDatabase); що сталося з Pages — окремою приміткою нижче, бо той самий
    // прогін pages-deploy лагодить і те, і те.
    const dash = DASHBOARDS[dashboards];
    if (dash) {
      const head = `${opPing}:warning: *${weekName} is collected and safe on main, but the Grafana dashboards ${dash.verdict}* — ${dash.why}.`;
      const blocks = [withRows(head)];
      const onPages = state === "published" || state === "picker-stale";
      if (state === "picker-stale") {
        blocks.push(section(
          `:information_source: Separately, the Grafana post picker refresh ${pickerHow}: the \`$post\` picker on the per-author posts dashboards ` +
          "may not list this week's new posts yet. The next successful publish rebuilds it.",
        ));
      } else if (onPages && dashboards === "stale") {
        // publish пройшов, але крок рефрешу у воркфлоу має if: sync == 'ok'.
        blocks.push(section(PICKER_HELD_BACK));
      } else if (!onPages) {
        blocks.push(section(
          `:information_source: Separately, the week was *not published to GitHub Pages* — ${why}. ` +
          "The same `pages-deploy` run takes care of it.",
        ));
      }
      blocks.push(context(`${merged}${onPages ? dashboardsRef(pageUrl) : ""}Details in the ${runRef}.`));
      if (noOperator) blocks.push(noOperator);
      return {
        kind: `dashboards-${dashboards}`,
        summary: `${weekName} is merged, but ${dash.short}`,
        payload: payloadOf(
          `${opPing}LinkedIn ${weekName.toLowerCase()} is merged, but ${dash.short} — ${dash.fix} (no data-loss deadline)`,
          blocks,
        ),
      };
    }

    // 1a. Усе доїхало — день, коли робити нічого, тож і пінгувати нікого.
    // «the dashboards are up to date» кажемо ЛИШЕ коли sync і parity "ok"
    // (dashboards === "fresh"): 1e вище вже відсіяв усе, де вони не "ok", а
    // «невідомо» (жодної DB_* змінної) — це не «добре».
    // Без жодного стану бази (dashboards === null) про дашборди не кажемо нічого:
    // Pages їх не годує, а доказу, що синк пройшов, немає.
    const vouched = dashboards === "fresh";
    if (state === "published") {
      const head = vouched
        ? `:white_check_mark: *${weekName} collected and published* — the dashboards are up to date.`
        : `:white_check_mark: *${weekName} collected and published to GitHub Pages.*`;
      return {
        kind: "published",
        summary: `${weekName} collected and published`,
        payload: payloadOf(`LinkedIn ${weekName.toLowerCase()} collected and published`, [
          withRows(head),
          context(`${merged}${dashboardsRef(pageUrl)}Details in the ${runRef}.`),
        ]),
      };
    }

    // 1b. Деплой пройшов, упав (або не доїхав) лише рефреш $post у Grafana.
    // БЕЗ пінгу, свідомо: дані вже живі, втратити нічого, дедлайну немає, а
    // update-post-variable.mjs щоразу перебудовує список з УСІХ постів — тож
    // наступна успішна публікація (найпізніше наступного понеділка) лагодить
    // пікер сама. Пінг за те, що само минає і нічого не коштує, привчає глушити
    // бота — і тоді глушиться той пінг, за яким справді горить тиждень. Людина,
    // якій потрібен пікер раніше, побачить жовтий рядок у каналі і червоний
    // publish у прогоні.
    if (state === "picker-stale") {
      const how = pickerHow;
      const head = `:large_yellow_circle: *${weekName} collected and published${vouched ? " — the dashboards show the new data" : " to GitHub Pages"}*, ` +
        `but the Grafana post picker refresh ${how}.`;
      return {
        kind: "published-picker-stale",
        summary: `${weekName} collected and published, but the Grafana post picker refresh ${how}`,
        payload: payloadOf(`LinkedIn ${weekName.toLowerCase()} published; the Grafana post picker was not refreshed`, [
          withRows(head),
          section(
            ":information_source: The `$post` picker on the per-author posts dashboards may not list this week's new posts yet. " +
            `*Nothing is lost and there is no deadline* — the data is merged${vouched ? " and live" : ""}, and the next successful publish rebuilds the picker ` +
            "from all posts. To fix it sooner, run the *pages-deploy* workflow.",
          ),
          context(`${merged}${dashboardsRef(pageUrl)}The failing step is in the ${runRef}.`),
        ]),
      };
    }

    // 1c/1d. Тиждень у безпеці на main, але на GitHub Pages НЕ опублікований.
    // Пінгуємо: без людини публічний фід і пікер $post так і лишаться старими.
    // Раніше тут стояло «the dashboards were NOT updated» — відколи Grafana читає
    // базу, це неправда: деплой Pages дашбордів не годує (їх годує sync, і якщо
    // він не пройшов, це вже 1e вище). Тож кажемо рівно те, що сталося, а коли
    // стан бази відомий і добрий — прямо, що дашборди цей тиждень уже показують.
    // І саме тут найлегше збрехати в обидва боки: сказати «дедлайн» — паніка
    // через те, що нічого не ризикує; промовчати про різницю з випадком 2 — і
    // наступного разу непомерджений тиждень теж здасться «не горить». Тому
    // прямо: дедлайну втрати даних НЕМАЄ.
    const head = `${opPing}:warning: *${weekName} is collected and safe on main, but it was NOT published to GitHub Pages* — ${why}.`;
    const stale = "the public JSON feed on Pages and the Grafana `$post` picker stay on the previous publish";
    const blocks = [
      withRows(head),
      section(
        ":point_right: Run the *pages-deploy* workflow on `main` (Actions → pages-deploy → Run workflow) to publish it. " +
        `If that fails too, open the ${runLink ? `<${safeUrl(runLink)}|workflow run>` : "workflow run"} to see why.`,
      ),
      section(
        ":shield: *No data-loss deadline here* — the week is already merged into main, so nothing is lost if this waits. " +
        (dashboards === "fresh"
          ? `The Grafana dashboards read the database, which was synced and checked, so they already show this week; until pages-deploy succeeds, only ${stale}.`
          : `Until pages-deploy succeeds, ${stale}.`),
      ),
      context(`${merged}Details in the ${runRef}.`),
    ];
    if (noOperator) blocks.push(noOperator);
    return {
      kind: state === "skipped" ? "merged-publish-skipped" : "merged-not-deployed",
      summary: `${weekName} is merged but NOT published — ${why.replace(/`/g, "")}; run pages-deploy (no data-loss deadline)`,
      payload: payloadOf(
        `${opPing}LinkedIn ${weekName.toLowerCase()} is merged but NOT published — run pages-deploy (no data-loss deadline)`,
        blocks,
      ),
    };
  }

  // 2. PR є, мерджу немає — тиждень НЕ опублікований і чекає людину.
  if (isHttpUrl(prUrl)) {
    const rows = authorRows(profiles, parsed, { assumeCollected: true });
    if (invalidJson === "1") rows.push(":red_circle: a snapshot file was cut off mid-write and was reverted (`invalid-json`)");
    // Чистий скрап без мерджу: впав сам `gh pr merge` (конфлікт, захист гілки).
    if (!parsed.length && invalidJson !== "1") {
      rows.push(clean === "1"
        ? ":red_circle: every author was collected, but the automatic merge did not go through"
        : ":grey_question: the run did not record why it stopped short of merging");
    }
    const head = `${opPing}:rotating_light: *${weekName} is NOT published — it is waiting for review.*`;
    const blocks = [
      section(`${head}\n${rows.join("\n")}`),
      section(
        `:mag: Review ${link(prUrl, prLabel(prUrl))}. Merge it by hand if the data collected so far is worth keeping, ` +
        "then run the *pages-deploy* workflow to publish it — or fix the cause and re-run the weekly workflow.",
      ),
      section(deadlineLine(week, now, "It must be merged before that")),
      context(`Per-author details are in the ${runRef}.`),
    ];
    if (noOperator) blocks.push(noOperator);
    return {
      kind: "review",
      summary: `${weekName} is NOT published — waiting for review`,
      payload: {
        channel,
        // Fallback пуша: без посилань, але з пінгом — це повідомлення для людини.
        text: `${opPing}LinkedIn ${weekName.toLowerCase()} is NOT published — the pull request needs review before next Monday`,
        unfurl_links: false,
        unfurl_media: false,
        blocks,
      },
    };
  }

  // 3. PR немає: прогін упав раніше. Нічого не опубліковано і нічого не чекає ревʼю.
  const lines = [
    `${opPing}:x: *The weekly LinkedIn run crashed before it opened a pull request* (${weekName.toLowerCase()}).`,
    "Nothing was published and nothing is waiting for review.",
  ];
  if (scrapeResult === "cancelled") lines.push("The run was cancelled or hit its time limit.");
  if (branch) {
    lines.push(`Some data was pushed to branch \`${escape(branch)}\`, but no pull request exists for it.`);
  }
  const rows = authorRows(profiles, parsed, { assumeCollected: false });
  if (invalidJson === "1") rows.push(":red_circle: a snapshot file was cut off mid-write and was reverted (`invalid-json`)");
  if (rows.length) lines.push("What the scrape reported before it stopped:", ...rows);

  const blocks = [
    section(lines.join("\n")),
    section(`:mag: Open the ${runLink ? `<${safeUrl(runLink)}|workflow run>` : "workflow run"} to see which step failed, fix it and re-run the weekly workflow.`),
    section(deadlineLine(week, now, "It has to be collected and merged before that")),
  ];
  if (noOperator) blocks.push(noOperator);
  return {
    kind: "crash",
    summary: "the weekly run crashed before opening a pull request — nothing was published",
    payload: {
      channel,
      text: `${opPing}LinkedIn weekly run crashed before opening a pull request — nothing was published`,
      unfurl_links: false,
      unfurl_media: false,
      blocks,
    },
  };
}

// ------------------------------------------------------------- ручний pages-deploy

// pages-deploy.yml — це шлях відновлення, до якого бот сам відсилає оператора
// («merge by hand, then run pages-deploy»). Без повідомлення його провал знову
// тихий. Три job'и: build -> deploy -> refresh-post-variable; результат кожного
// приходить окремо, тож ті самі два сигнали, що й у щотижневому publish.
//
// Успіх теж постимо — одним рядком і БЕЗ пінгу. Так, оператор зазвичай щойно
// сам натиснув кнопку і дивиться на прогін. Але останнім словом каналу про цей
// тиждень лишилось би «dashboards were NOT updated» з @-згадкою: хто читає
// канал, а не Actions (інші учасники, той самий оператор завтра), вважатиме, що
// все ще зламано. Ручний деплой рідкісний, тож рядок-закриття коштує майже
// нічого, а петлю закриває там, де її відкрили.
export function buildPagesDeployMessage(input) {
  // Синк у pages-deploy.yml не залежить від деплою (дані на main змерджені
  // незалежно від того, чи доїхав Pages) і запускається в КОЖНОМУ прогоні — тобто
  // тут він «очікувався» завжди. Рядок бази додаємо до всіх варіантів.
  const line = databaseLine(input.db);
  return withDatabase(pagesCore({ ...input, dashboards: line.dashboards }), line);
}

function pagesCore(input) {
  const {
    channel, buildResult = "", deployResult = "", refreshResult = "", pageUrl = "", operator, runLink, actor = "", dashboards = null,
  } = input;
  const runRef = runLink ? `<${safeUrl(runLink)}|run log>` : "run log";
  const who = actor ? `Triggered by \`${escape(actor)}\`. ` : "";
  const payloadOf = (text, blocks) => ({ channel, text, unfurl_links: false, unfurl_media: false, blocks });
  const opPing = operator ? `<@${operator}> ` : "";
  const noOperator = operator
    ? null
    : context(":information_source: No `_operator` id is mapped in SLACK_PEOPLE_JSON, so nobody was pinged — someone has to pick this up by hand.");
  const deployed = deployResult === "success";
  const where = buildResult !== "success"
    ? `the build job ${buildResult === "cancelled" ? "was cancelled" : "failed"}`
    : deployResult === "cancelled"
      ? "the deploy job was cancelled"
      : "the deploy to GitHub Pages failed";
  const openRun = `:mag: Open the ${runLink ? `<${safeUrl(runLink)}|workflow run>` : "workflow run"} to see which step failed, fix it and run *pages-deploy* again.`;

  // Клас (а) — той самий, що 1e у щотижневому: sync або parity не "ok", тож
  // дашборди Grafana НЕ оновлені (або не звірені), хоч би що сталося з Pages.
  // Людина запустила pages-deploy саме щоб їх оновити — «succeeded» тут було б
  // брехнею. Причина, дія і «тиждень у git цілий» — у рядку бази під заголовком.
  const dash = DASHBOARDS[dashboards];
  if (dash) {
    const head = deployed
      ? `${opPing}:warning: *Manual pages-deploy published to GitHub Pages, but the Grafana dashboards ${dash.verdict}* — ${dash.why}.`
      : `${opPing}:x: *Manual pages-deploy FAILED (${where}), and the Grafana dashboards ${dash.verdict}* — ${dash.why}.`;
    const blocks = [section(head)];
    if (!deployed) {
      blocks.push(section(openRun));
    } else if (refreshResult === "skipped" && dashboards === "stale") {
      // Не збій: refresh-post-variable має if: needs.db-sync.outputs.sync == 'ok'.
      blocks.push(section(PICKER_HELD_BACK));
    } else if (refreshResult !== "success") {
      blocks.push(section(
        `:information_source: Separately, the Grafana post picker refresh ${refreshResult === "failure" ? "failed" : "did not finish"}: ` +
        "the `$post` picker may not list the newest posts yet. The next successful publish rebuilds it.",
      ));
    }
    blocks.push(context(`${who}${deployed ? dashboardsRef(pageUrl) : ""}Details in the ${runRef}.`));
    if (noOperator) blocks.push(noOperator);
    return {
      kind: `pages-dashboards-${dashboards}`,
      summary: `manual pages-deploy ${deployed ? "published to GitHub Pages, but" : `FAILED (${where}), and`} ${dash.short}`,
      payload: payloadOf(deployed
        ? `${opPing}LinkedIn manual pages-deploy: ${dash.short} — ${dash.fix} again`
        : `${opPing}LinkedIn manual pages-deploy FAILED (${where}), and ${dash.short} — ${dash.fix} again`, blocks),
    };
  }

  // deploy-джоба складається з одного кроку actions/deploy-pages, тож її
  // success і є «деплой пройшов» — окремий маркер тут не потрібен.
  if (deployed) {
    // Як і в 1a: без стану бази (dashboards === null) за дашборди не ручаємось.
    const vouched = dashboards === "fresh";
    if (refreshResult === "success") {
      return {
        kind: "pages-deployed",
        summary: vouched ? "manual pages-deploy succeeded — the dashboards are up to date" : "manual pages-deploy published to GitHub Pages",
        payload: payloadOf(vouched ? "LinkedIn dashboards published (manual pages-deploy)" : "LinkedIn data published to GitHub Pages (manual pages-deploy)", [
          section(vouched
            ? ":white_check_mark: *Manual pages-deploy succeeded* — the dashboards now show everything merged into main."
            : ":white_check_mark: *Manual pages-deploy published everything merged into main to GitHub Pages.*"),
          context(`${who}${dashboardsRef(pageUrl)}Details in the ${runRef}.`),
        ]),
      };
    }
    // Без пінгу — з тієї ж причини, що й 1b у щотижневому: дані живі, нічого не
    // горить, наступна успішна публікація перебудує пікер.
    const how = refreshResult === "failure" ? "failed" : "did not finish";
    return {
      kind: "pages-picker-stale",
      summary: `manual pages-deploy published the data, but the Grafana post picker refresh ${how}`,
      payload: payloadOf(`LinkedIn ${vouched ? "dashboards published" : "data published to GitHub Pages"}; the Grafana post picker was not refreshed (manual pages-deploy)`, [
        section(
          `:large_yellow_circle: *Manual pages-deploy published the data*, but the Grafana post picker refresh ${how}.\n` +
          "The `$post` picker on the per-author posts dashboards may not list the newest posts yet. " +
          "*Nothing is lost and there is no deadline* — the next successful publish rebuilds the picker from all posts.",
        ),
        context(`${who}${dashboardsRef(pageUrl)}The failing step is in the ${runRef}.`),
      ]),
    };
  }

  // Деплою немає. Пінг: людина запустила відновлення, і воно не вдалося.
  // Тут теж більше не кажемо «the dashboards were NOT updated»: Grafana читає
  // базу, а db-sync у pages-deploy.yml від деплою не залежить. Якщо він не
  // пройшов — це клас (а) вище; якщо пройшов — дашборди свіжі, старими лишились
  // тільки публічний фід на Pages і пікер $post.
  const stale = "the public JSON feed on Pages and the Grafana `$post` picker stay on the previous publish";
  const blocks = [
    section(
      `${opPing}:x: *Manual pages-deploy FAILED — nothing was published to GitHub Pages* (${where}).\n` +
      "Whatever is merged into main is safe: a failed deploy loses no data. " +
      (dashboards === "fresh"
        ? `The Grafana dashboards read the database, which this run synced and checked, so they are current; only ${stale}.`
        : `Until it succeeds, ${stale}.`),
    ),
    section(openRun),
  ];
  if (who) blocks.push(context(who.trim()));
  if (noOperator) blocks.push(noOperator);
  return {
    kind: "pages-failed",
    summary: `manual pages-deploy FAILED — ${where}; nothing was published to GitHub Pages`,
    payload: payloadOf(`${opPing}LinkedIn manual pages-deploy FAILED — nothing was published to GitHub Pages`, blocks),
  };
}

// ------------------------------------------------------------- main

async function main(env = process.env) {
  const pagesMode = env.NOTIFY_MODE === "pages-deploy";
  const what = pagesMode ? "the pages-deploy result" : "the weekly result";

  // Етап бази існує для цього виклику, якщо воркфлоу передав хоч одну DB_*
  // змінну (у CI — завжди всі чотири, навіть порожні: порожньо = «невідомо»).
  const dbKeys = ["DB_SYNC", "DB_PARITY", "DB_BACKUP", "DB_BACKUP_EXPECTED"];
  const db = dbKeys.some((k) => env[k] !== undefined)
    ? {
      sync: env.DB_SYNC ?? "",
      parity: env.DB_PARITY ?? "",
      backup: env.DB_BACKUP ?? "",
      backupExpected: env.DB_BACKUP_EXPECTED === "true",
    }
    : undefined;

  const op = operatorId(env.SLACK_PEOPLE_JSON);
  if (op.problem) console.error(`::warning::${op.problem} — ${what} will not ping the operator`);

  let built;
  if (pagesMode) {
    built = buildPagesDeployMessage({
      channel: CHANNEL,
      buildResult: env.BUILD_RESULT ?? "",
      deployResult: env.DEPLOY_RESULT ?? "",
      refreshResult: env.REFRESH_RESULT ?? "",
      pageUrl: env.PAGE_URL ?? "",
      operator: op.id,
      runLink: runUrl(env),
      actor: env.GITHUB_ACTOR ?? "",
      db,
    });
    console.error(`pages-deploy result: ${built.kind}`);
  } else {
    const profilesPath = env.PROFILES_FILE || DEFAULT_PROFILES;
    let profiles = readProfiles(profilesPath);
    if (!profiles) {
      console.error(`::warning::cannot read ${escape(profilesPath)} — authors are listed by slug, and only those with a problem`);
      profiles = [];
    }
    built = buildWeeklyMessage({
      channel: CHANNEL,
      week: env.WEEK ?? "",
      clean: env.CLEAN ?? "",
      notes: env.NOTES ?? "",
      invalidJson: env.INVALID_JSON ?? "",
      branch: env.BRANCH ?? "",
      prUrl: env.PR_URL ?? "",
      mainUpdated: env.MAIN_UPDATED ?? "",
      scrapeResult: env.SCRAPE_RESULT ?? "",
      publishResult: env.PUBLISH_RESULT ?? "",
      deployed: env.DEPLOYED ?? "",
      pageUrl: env.PAGE_URL ?? "",
      profiles,
      operator: op.id,
      runLink: runUrl(env),
      now: Date.now(),
      db,
    });
    console.error(`weekly result for ${escape(env.WEEK || "an unresolved week")}: ${built.kind}`);
  }
  const { summary, payload } = built;
  // Навіть якщо Slack не відповість, проблема з базою лишається анотацією прогону.
  if (built.database) console.error(`::warning::${built.database}`);

  if (DRY_RUN) {
    // Контракт той самий, що в notify-session-check.mjs: stdout — рівно
    // JSON-масив payload'ів.
    console.log(JSON.stringify([payload], null, 2));
    console.error("dry run — 1 payload, nothing was sent");
    return;
  }

  // Криво налаштований Slack мусить бути видно в лозі, але не фарбувати прогін:
  // висновок прогону — про тиждень, а не про сповіщення.
  const missing = [!TOKEN && "SLACK_BOT_TOKEN", !CHANNEL && "SLACK_CHANNEL_ID"].filter(Boolean);
  if (missing.length) {
    console.error(`::warning::${missing.join(" and ")} not set — ${what} was NOT posted to Slack. It would have said: ${summary}`);
    return;
  }

  let res;
  try {
    res = await slackPost(payload);
  } catch (e) {
    // fetch кидає на DNS/обрив з'єднання — це та сама транзієнтна гикавка, що й
    // 5xx. Текст винятку не друкуємо цілком: лише його код.
    res = { ok: false, error: `network_error:${e?.cause?.code ?? e?.name ?? "unknown"}`, kind: "transient" };
  }

  if (res.ok) {
    if (res.warning) console.error(`  warning: ${res.warning}`);
    console.error(`posted -> ${res.channel ?? CHANNEL} (${res.ts ?? "?"})`);
    return;
  }
  const bug = res.kind === "bug" ? " (Slack rejected the payload itself — a bug in notify-weekly.mjs)" : "";
  console.error(`::warning::${what} was NOT posted to Slack: ${res.error}${bug} — ${remedy(res.error)} It would have said: ${summary}`);
}

// Імпорт віддає чисті білдери для тестів; main() — тільки при прямому запуску.
const IS_MAIN = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (IS_MAIN) await main();
