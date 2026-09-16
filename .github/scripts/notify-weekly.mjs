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
//       але дашборди НЕ оновлені: @оператор, «запусти pages-deploy», і прямим
//       текстом — дедлайну втрати даних тут НЕМАЄ;
//   1d. publish SKIPPED, хоча main оновлено — не мав так поводитись; чесно
//       кажемо «не опубліковано», @оператор, pages-deploy.
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

// ------------------------------------------------------------- збірка

// Чистий білдер: жодного env, мережі чи файлів — усе приходить аргументом.
// summary — той самий вердикт без @-згадки: він іде в лог, а id оператора —
// зі секрету, і в публічний лог Actions йому не можна (маска GitHub ловить
// лише ЦІЛЕ значення секрету, а не шматок мапи).
export function buildWeeklyMessage(input) {
  const {
    channel, week, clean, notes, invalidJson, branch, prUrl, mainUpdated,
    scrapeResult, publishResult = "", deployed = "", pageUrl = "",
    profiles, operator, runLink, now = Date.now(),
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

    // 1a. Усе доїхало — день, коли робити нічого, тож і пінгувати нікого.
    if (state === "published") {
      const head = `:white_check_mark: *${weekName} collected and published* — the dashboards are up to date.`;
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
      const how = publishResult === "failure" ? "failed" : "did not finish";
      const head = `:large_yellow_circle: *${weekName} collected and published — the dashboards show the new data*, ` +
        `but the Grafana post picker refresh ${how}.`;
      return {
        kind: "published-picker-stale",
        summary: `${weekName} collected and published, but the Grafana post picker refresh ${how}`,
        payload: payloadOf(`LinkedIn ${weekName.toLowerCase()} published; the Grafana post picker was not refreshed`, [
          withRows(head),
          section(
            ":information_source: The `$post` picker on the per-author posts dashboards may not list this week's new posts yet. " +
            "*Nothing is lost and there is no deadline* — the data is merged and live, and the next successful publish rebuilds the picker " +
            "from all posts. To fix it sooner, run the *pages-deploy* workflow.",
          ),
          context(`${merged}${dashboardsRef(pageUrl)}The failing step is in the ${runRef}.`),
        ]),
      };
    }

    // 1c/1d. Тиждень у безпеці на main, але дашборди НЕ оновлені. Пінгуємо:
    // без людини вони так і лишаться старими. Але саме тут найлегше збрехати в
    // обидва боки: сказати «дедлайн» — паніка через те, що нічого не ризикує;
    // промовчати про різницю з випадком 2 — і наступного разу непомерджений
    // тиждень теж здасться «не горить». Тому прямо: дедлайну втрати даних НЕМАЄ.
    const why = {
      "not-deployed": publishResult === "cancelled"
        ? "the publish job was cancelled before the deploy finished"
        : publishResult === "success"
          ? "the publish job did not confirm the deploy"
          : "the deploy to GitHub Pages failed",
      skipped: `the publish job did not run (result: \`${escape(publishResult || "unknown")}\`), although it should after a merge`,
    }[state];
    const head = `${opPing}:warning: *${weekName} is collected and safe on main, but the dashboards were NOT updated* — ${why}.`;
    const blocks = [
      withRows(head),
      section(
        ":point_right: Run the *pages-deploy* workflow on `main` (Actions → pages-deploy → Run workflow) to publish it. " +
        `If that fails too, open the ${runLink ? `<${safeUrl(runLink)}|workflow run>` : "workflow run"} to see why.`,
      ),
      section(
        ":shield: *No data-loss deadline here* — the week is already merged into main, so nothing is lost if this waits. " +
        "Until pages-deploy succeeds, the dashboards keep showing the previous data.",
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
  const { channel, buildResult = "", deployResult = "", refreshResult = "", pageUrl = "", operator, runLink, actor = "" } = input;
  const runRef = runLink ? `<${safeUrl(runLink)}|run log>` : "run log";
  const who = actor ? `Triggered by \`${escape(actor)}\`. ` : "";
  const payloadOf = (text, blocks) => ({ channel, text, unfurl_links: false, unfurl_media: false, blocks });

  // deploy-джоба складається з одного кроку actions/deploy-pages, тож її
  // success і є «деплой пройшов» — окремий маркер тут не потрібен.
  if (deployResult === "success") {
    if (refreshResult === "success") {
      return {
        kind: "pages-deployed",
        summary: "manual pages-deploy succeeded — the dashboards are up to date",
        payload: payloadOf("LinkedIn dashboards published (manual pages-deploy)", [
          section(":white_check_mark: *Manual pages-deploy succeeded* — the dashboards now show everything merged into main."),
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
      payload: payloadOf("LinkedIn dashboards published; the Grafana post picker was not refreshed (manual pages-deploy)", [
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
  const opPing = operator ? `<@${operator}> ` : "";
  const where = buildResult !== "success"
    ? `the build job ${buildResult === "cancelled" ? "was cancelled" : "failed"}`
    : deployResult === "cancelled"
      ? "the deploy job was cancelled"
      : "the deploy to GitHub Pages failed";
  const blocks = [
    section(
      `${opPing}:x: *Manual pages-deploy FAILED — the dashboards were NOT updated* (${where}).\n` +
      "Whatever is merged into main is safe: a failed deploy loses no data, the dashboards just keep showing the previous publish.",
    ),
    section(`:mag: Open the ${runLink ? `<${safeUrl(runLink)}|workflow run>` : "workflow run"} to see which step failed, fix it and run *pages-deploy* again.`),
  ];
  if (who) blocks.push(context(who.trim()));
  if (!operator) {
    blocks.push(context(":information_source: No `_operator` id is mapped in SLACK_PEOPLE_JSON, so nobody was pinged — someone has to pick this up by hand."));
  }
  return {
    kind: "pages-failed",
    summary: `manual pages-deploy FAILED — ${where}; the dashboards were NOT updated`,
    payload: payloadOf(`${opPing}LinkedIn manual pages-deploy FAILED — the dashboards were NOT updated`, blocks),
  };
}

// ------------------------------------------------------------- main

async function main(env = process.env) {
  const pagesMode = env.NOTIFY_MODE === "pages-deploy";
  const what = pagesMode ? "the pages-deploy result" : "the weekly result";

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
    });
    console.error(`weekly result for ${escape(env.WEEK || "an unresolved week")}: ${built.kind}`);
  }
  const { summary, payload } = built;

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
