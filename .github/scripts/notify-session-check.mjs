#!/usr/bin/env node
// Читає звіт денної перевірки LinkedIn-сесій і пінгує в Slack тих, у кого
// сесія впала — одне повідомлення на людину, з її @-згадкою і свіжим
// Live View посиланням на повторний вхід.
//
// Мовчить, коли всі живі. Тиша — це нормальний стан, і саме тому будь-яка
// НЕвідправка мусить бути гучною: втрачений алерт — єдиний сценарій, який
// повністю знецінює всю фічу. Тому кожен збій Slack валить прогін у червоне.
//
// Приймає ТІЛЬКИ форму --key=value (у репозиторії співіснують два несумісні
// парсери; цей файл — з табору scrape-weekly.mjs):
//
//   node .github/scripts/notify-session-check.mjs --report=session-report.json
//   SLACK_DRY_RUN=1 node .github/scripts/notify-session-check.mjs --report=fixture.json
//
// Env:
//   SLACK_BOT_TOKEN    (обов'язково) xoxb-…, скоупи chat:write + chat:write.public
//   SLACK_CHANNEL_ID   (обов'язково) C… каналу #linkedin-session-bot
//   SLACK_PEOPLE_JSON  (опційно)     {"<slug>": "U…"} — slug без мапінгу або з
//                                    битим id деградує до простого імені без
//                                    пінгу; ключ "_operator" — id оператора
//   SLACK_REPORT_ALL   (опційно)     "1" — писати і коли всі живі
//   SLACK_DRY_RUN      (опційно)     "1" — друкує payload'и в stdout, нічого не шле
//
// Коди виходу: 0 — відпрацював (відправив усе потрібне або промовчав);
// 2 — оператор налаштував криво (нема env, битий JSON, мертвий токен);
// 1 — хоч одне повідомлення не доїхало.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const SLACK_API = "https://slack.com/api/chat.postMessage";
const MAX_ATTEMPTS = 3;
// Slack рахує ліміт «одне повідомлення на секунду на канал». Ми пишемо в один
// канал, тож пауза між постами не косметична, а єдине, що тримає нас під
// лімітом при 5 авторах, які впали одночасно.
const PAUSE_BETWEEN_POSTS_MS = 1200;
// Стеля на Retry-After: Slack може попросити чекати довго, а прогін CI має
// померти від власного timeout-minutes, а не висіти в sleep пів години.
const MAX_RETRY_WAIT_SECS = 60;
// Ліміт Block Kit — 3000 символів на текстовий об'єкт. Перевищення повертає
// ok:false invalid_blocks, тобто алерт просто зникає. Ріжемо із запасом.
const TEXT_CAP = 2800;
// Форма member-id Slack: U… для людини, W… для Enterprise Grid. Той самий вираз
// продубльований у прифлайті воркфлоу (linkedin-session-check.yml, крок "Check
// required secrets") — свідомо, щоб одруківку в мапі було видно за 5 секунд, а
// не після того, як прогін уже спалив хвилини Browserbase. Міняєш тут — міняй і там.
const MEMBER_ID = /^[UW][A-Z0-9]{2,}$/i;

// ------------------------------------------------------------- аргументи/env

function args(argv) {
  const out = {};
  for (const a of argv) {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (m) out[m[1]] = m[2] ?? "true";
  }
  return out;
}

const TOKEN = process.env.SLACK_BOT_TOKEN ?? "";
const CHANNEL = process.env.SLACK_CHANNEL_ID ?? "";
const DRY_RUN = process.env.SLACK_DRY_RUN === "1";
const REPORT_ALL = process.env.SLACK_REPORT_ALL === "1";

// ------------------------------------------------------------- mrkdwn-хелпери

// Slack тригериться на & < > при розборі тексту, тож будь-яке значення, що
// прийшло ззовні (ім'я, статус, текст помилки), мусить пройти через це перед
// потраплянням у повідомлення.
export const escape = (s) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// URL живе всередині конструкції <url|підпис>, тому < > | всередині нього
// закрили б її і перетворили посилання на сміття. Амперсанд НЕ чіпаємо:
// Live View URL несе query-параметри, і &amp; в них зламав би сам лінк.
export const safeUrl = (u) =>
  String(u ?? "").replace(/[<>|]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

const cap = (s, n = TEXT_CAP) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

const KYIV = new Intl.DateTimeFormat("uk-UA", {
  timeZone: "Europe/Kyiv",
  day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
});
const REL = new Intl.RelativeTimeFormat("uk", { numeric: "auto" });
const UNITS = [["day", 86400e3], ["hour", 3600e3], ["minute", 60e3]];

// Час у звіті — UTC ISO. Люди в команді живуть за Києвом і читають алерт о 3
// ночі за UTC; голий Z-штамп змушує їх рахувати різницю в голові.
export function kyivTime(iso) {
  const t = Date.parse(iso ?? "");
  return Number.isNaN(t) ? null : `${KYIV.format(t)} за Києвом`;
}

// «о 09:03» саме по собі не каже, це 20 хвилин тому чи третій день.
export function relative(iso, now = Date.now()) {
  const t = Date.parse(iso ?? "");
  if (Number.isNaN(t)) return null;
  const diff = t - now;
  for (const [unit, ms] of UNITS) {
    if (Math.abs(diff) >= ms) return REL.format(Math.round(diff / ms), unit);
  }
  return REL.format(Math.round(diff / 60e3), "minute");
}

// ------------------------------------------------------------- класифікація помилок

// Токен/застосунок зламані: наступні автори впадуть так само, тож ітерацію
// припиняємо — інакше в лог насиплеться п'ять однакових простирадл.
const FATAL = new Set([
  "not_authed", "invalid_auth", "token_revoked", "token_expired", "account_inactive",
  "missing_scope", "no_permission", "team_access_not_granted", "not_allowed_token_type",
  "access_denied", "app_access_restricted", "two_factor_setup_required",
  "enterprise_is_restricted", "org_login_required", "team_added_to_org",
  "accesslimited", "ekm_access_denied",
]);
// Проблема з конкретним отримувачем — решту роздачі це не має зупиняти.
const TARGET = new Set([
  "channel_not_found", "not_in_channel", "is_archived", "messages_tab_disabled",
  "restricted_action", "restricted_action_read_only_channel", "restricted_action_thread_locked",
  "restricted_action_non_threadable_channel", "restricted_action_thread_only_channel",
  "team_not_found", "send_on_behalf_not_allowed", "message_limit_exceeded",
]);
// Мине саме — але тільки якщо ми справді почекаємо і повторимо.
const TRANSIENT = new Set([
  "ratelimited", "rate_limited", "internal_error", "service_unavailable",
  "fatal_error", "request_timeout",
]);
// Це НАШ payload. Такі коди має ловити тест, а не продакшн, тому вони летять
// вгору трейсбеком, а не м'яким повідомленням у лог.
const BUG = new Set([
  "no_text", "invalid_blocks", "invalid_blocks_format", "msg_blocks_too_long",
  "markdown_text_conflict", "too_many_attachments", "attachment_payload_limit_exceeded",
  "invalid_arguments", "invalid_arg_name", "invalid_array_arg", "invalid_charset",
  "invalid_post_type", "missing_post_type", "invalid_form_data",
  "invalid_metadata_format", "invalid_metadata_schema", "metadata_too_large",
  "cannot_reply_to_message",
]);

export function classify(code) {
  if (FATAL.has(code)) return "fatal";
  if (TARGET.has(code)) return "target";
  if (TRANSIENT.has(code)) return "transient";
  if (BUG.has(code)) return "bug";
  return "unknown";
}

// Кожен рядок — що саме піти зробити. «Slack повернув not_in_channel» без
// цього змушує чергового гуглити о третій ночі.
const REMEDY = {
  invalid_auth: "SLACK_BOT_TOKEN невалідний або відкликаний — перевипусти xoxb-токен і онови секрет репозиторію.",
  not_authed: "SLACK_BOT_TOKEN порожній — секрет не доїхав у крок workflow.",
  token_revoked: "Токен відкликано (застосунок видалили з воркспейсу) — перевстанови застосунок і онови SLACK_BOT_TOKEN.",
  token_expired: "Токен протух — перевипусти і онови SLACK_BOT_TOKEN.",
  account_inactive: "Акаунт бота деактивовано у воркспейсі.",
  missing_scope: "Бракує скоупу chat:write (і chat:write.public для публічного каналу) — додай у налаштуваннях застосунку і ПЕРЕВСТАНОВИ його, інакше токен лишиться старим.",
  no_permission: "Токен не має прав на цю дію — перевір скоупи застосунку.",
  channel_not_found: "SLACK_CHANNEL_ID неправильний АБО канал приватний і бот його не бачить — постав правильний C-id і зроби `/invite @<бот>` у #linkedin-session-bot.",
  not_in_channel: "Бота немає в каналі — `/invite @<бот>` у #linkedin-session-bot (chat:write.public покриває лише публічні канали).",
  is_archived: "Канал заархівовано — розархівуй або постав інший SLACK_CHANNEL_ID.",
  messages_tab_disabled: "У застосунку вимкнено вкладку Messages (App Home) — увімкни її в налаштуваннях застосунку.",
  restricted_action: "Налаштування воркспейсу забороняють цей пост — питання до адміна Slack.",
  ratelimited: "Slack тротлить (HTTP 429) — усі спроби вичерпано.",
  rate_limited: "Забагато повідомлень від застосунку — усі спроби вичерпано.",
  internal_error: "Тимчасова помилка на боці Slack — усі спроби вичерпано.",
  service_unavailable: "Slack недоступний — усі спроби вичерпано.",
};
const remedy = (code) => REMEDY[code] ?? "Дивись https://docs.slack.dev/reference/methods/chat.postMessage/ (розділ Errors).";

// ------------------------------------------------------------- збірка payload'ів

const section = (text) => ({ type: "section", text: { type: "mrkdwn", text: cap(text) } });
const context = (text) => ({ type: "context", elements: [{ type: "mrkdwn", text: cap(text) }] });

// Пінгуємо ВИКЛЮЧНО по member-id зі SLACK_PEOPLE_JSON. Docs прямо кажуть, що
// display name «may change at any time», а @channel як фолбек заборонений —
// щоденний бот, який будить увесь канал, вимкнуть через тиждень.
function mention(author, people) {
  const id = people[author.slug];
  if (id) return { who: `<@${id}>`, mapped: true };
  return { who: `*${escape(author.name || author.slug)}*`, mapped: false };
}

// last_ok — це поле РЕЄСТРУ, а не спостереження цього прогону, і подавати його
// як спостереження не можна. _check_one оновлює last_ok лише живому автору
// (cli.py:238-239), а в CI сам реєстр матеріалізується з секрету на початку
// прогону і знищується наприкінці — тобто для вилогіненої людини тут завжди
// лежить дата, коли секрет експортували востаннє, і вона тільки старішає.
// «Остання успішна перевірка: 02.06 (97 днів тому)» під щоденним монітором
// читається або як «акаунт мертвий три місяці», або як «бот зламався» — обидва
// висновки хибні, обидва о 09:00 під час єдиного інциденту, заради якого все це
// існує. Тому знімок реєстру називаємо знімком, а єдиний час, який ми справді
// спостерігали (checked_at), друкуємо окремо. build_report ставить
// last_ok_source: "registry-snapshot" саме там, де прогін цієї дати не бачив.
export function lastSeenLine(author, now) {
  const seen = kyivTime(author.last_ok);
  if (!seen) return "Успішних перевірок ще не було — коли саме випав, сказати нема по чому.";
  if (author.last_ok_source === "registry-snapshot") {
    return `За знімком реєстру востаннє живий *${escape(seen)}* — цей прогін такого не бачив, ` +
      "у CI реєстр не переживає прогін, тож дата може бути сильно застарілою.";
  }
  return `Остання успішна перевірка: *${escape(seen)}* (${escape(relative(author.last_ok, now))}).`;
}

export function buildReloginMessage(author, { channel, people, now = Date.now(), checkedAt = null }) {
  const { who, mapped } = mention(author, people);
  const slug = escape(author.slug);
  const status = escape(author.status);

  const checked = kyivTime(checkedAt);
  const when = checked ? `Перевірено: *${escape(checked)}*. ` : "";

  const blocks = [
    section(`${who}, сесія LinkedIn для *${slug}* більше не активна — статус \`${status}\`.\n${when}${lastSeenLine(author, now)}`),
  ];

  if (author.invite_url) {
    const exp = kyivTime(author.invite_expires_at);
    const expMs = Date.parse(author.invite_expires_at ?? "");
    // Строк життя лінка — не дрібниця: keep_alive сесія Browserbase помирає за
    // api_timeout, і людина, яка відкриє його завтра, побачить білий екран і
    // вирішить, що зламався бот. Прострочений лінк називаємо простроченим
    // прямо: прогін міг простояти в черзі CI довше, ніж живе сесія, і
    // «дійсне до» в минулому читається як баг бота.
    let until = "";
    if (exp && expMs <= now) {
      until = ` — :warning: строк вийшов (${escape(exp)}), свіжий підніме оператор`;
    } else if (exp) {
      until = ` — дійсне до *${escape(exp)}*, це ${escape(relative(author.invite_expires_at, now))}.`;
    }
    blocks.push(section(`:key: <${safeUrl(author.invite_url)}|Увійти в LinkedIn>${until}`));
  } else {
    // Чекер не зміг підняти сесію. Мовчати не можна: людина все одно вилогінена.
    //
    // Але й КОМАНДИ тут бути не може. Це повідомлення @-тегає власника
    // LinkedIn-акаунта: у нього немає ні чекауту цього репо, ні ключа
    // Browserbase, ні прав щось тут запускати. `python invite_link.py <slug>`,
    // адресована йому, — це інструкція, яку адресат фізично не може виконати, а
    // отже вона читається як «бот зламався» і гарантує, що не зробить ніхто.
    // Роботу оператора віддаємо оператору окремим повідомленням
    // (buildNoLinkMessage), а тут кажемо людині рівно те, що її стосується.
    const wait = kyivTime(author.invite_wait_until);
    const when = wait
      ? ` Воно з'явиться після *${escape(wait)}* — саме тоді звільниться браузерний слот.`
      : "";
    blocks.push(section(
      `:hourglass_flowing_sand: Свіже посилання ще не створено — його підніме оператор і кине сюди.${when} Від тебе зараз нічого не потрібно.`,
    ));
  }

  blocks.push(context(
    "Входь *поштою і паролем*. Не через Google/Apple — попап OAuth у хмарному браузері не відкривається, і вхід зависне.",
  ));

  if (!mapped) {
    blocks.push(context(
      `:information_source: Slack-id для \`${slug}\` не змаплено — пінгу не буде. Додай його в SLACK_PEOPLE_JSON і гукни людину вручну.`,
    ));
  }

  return {
    channel,
    // text — це fallback для пуш-нотифікації. Посилання сюди НЕ кладемо:
    // прев'ю пуша розходиться по пристроях і перевідкривається де завгодно.
    text: `${who} сесія LinkedIn для ${slug} впала — потрібен повторний вхід`,
    // Обидва unfurl за замовчуванням УВІМКНЕНІ. Лишити їх — означає дозволити
    // краулеру Slack серверно смикнути одноразовий debugger-URL Browserbase.
    unfurl_links: false,
    unfurl_media: false,
    blocks,
  };
}

// Лінк протух ще до того, як людина його відкрила: прогін міг простояти в
// черзі CI довше, ніж живе keep_alive сесія. Для автора це те саме, що лінка
// немає, тож оператор має дізнатись і про такі випадки.
const linkExpired = (a, now) => {
  const t = Date.parse(a.invite_expires_at ?? "");
  return Number.isFinite(t) && t <= now;
};

// Кому потрібне втручання оператора, а не автора.
export const needsOperator = (needsRelogin, now = Date.now()) =>
  needsRelogin.filter((a) => !a.invite_url || linkExpired(a, now));

// Окреме повідомлення для оператора — єдиної людини в каналі, яка має чекаут
// репо і ключ Browserbase. Автор у своєму повідомленні бачить «лінк підніме
// оператор»; ця обіцянка мусить мати адресата, інакше вона гірша за мовчання.
export function buildNoLinkMessage(authors, { channel, people = {}, now = Date.now() }) {
  const op = people._operator ? `<@${people._operator}> ` : "";
  const lines = authors.map((a) => {
    // Текст винятку може прийти з переводами рядків — у списку-буліті це
    // ламає читабельність, тож зводимо в один рядок.
    const why = a.invite_error
      ? escape(String(a.invite_error).replace(/\s+/g, " ").trim())
      : (a.invite_url ? "лінк протух до того, як його відкрили" : "причина не записана");
    return `• *${escape(a.slug)}* — \`${escape(a.status)}\`: ${why}`;
  });
  return {
    channel,
    text: "LinkedIn: комусь бракує лінка на повторний вхід",
    unfurl_links: false,
    unfurl_media: false,
    blocks: [
      section(`${op}:hammer_and_wrench: *Лінк на повторний вхід треба підняти вручну:*\n${lines.join("\n")}`),
      // Рівно та команда, яку в цьому репо запускає оператор. В автора вона не
      // працює — тому й живе тільки тут.
      context("`python3 scripts/lifleet/invite_link.py <slug>` — і кинути лінк людині в її тред вище. Якщо причина в зайнятому слоті Browserbase, спершу дочекайся названого часу: раніше буде 429."),
    ],
  };
}

export function buildErrorMessage(authors, { channel, now = Date.now() }) {
  const lines = authors.map((a) => {
    const seen = kyivTime(a.last_ok);
    // Той самий застережений знімок, що і в buildReloginMessage: у CI ця дата
    // приходить із секрету, а не з цього прогону.
    const snapshot = a.last_ok_source === "registry-snapshot";
    const tail = seen
      ? (snapshot
        ? `за знімком реєстру востаннє живий ${escape(seen)}, дата може бути застарілою`
        : `остання успішна перевірка ${escape(seen)}, ${escape(relative(a.last_ok, now))}`)
      : "успішних перевірок ще не було";
    return `• *${escape(a.slug)}* — \`${escape(a.status)}\` (${tail})`;
  });
  return {
    channel,
    text: "LinkedIn: перевірку сесій не вдалося завершити",
    unfurl_links: false,
    unfurl_media: false,
    blocks: [
      section(`:grey_question: *Перевірку не вдалося завершити:*\n${lines.join("\n")}`),
      // Найнебезпечніша інтерпретація цього повідомлення — «ну значить живі».
      context("Це НЕ означає «залогінені» — статус просто невідомий. Наступний прогін перевірить ще раз; якщо повторюється, дивись лог кроку session check."),
    ],
  };
}

export function buildAllClearMessage(fine, { channel }) {
  return {
    channel,
    text: "LinkedIn: усі сесії живі",
    unfurl_links: false,
    unfurl_media: false,
    blocks: [section(`:white_check_mark: Усі сесії LinkedIn живі (${fine.length}). Робити нічого не треба.`)],
  };
}

export function partition(authors) {
  const by = (...s) => authors.filter((a) => s.includes(a.status));
  return {
    // Тільки ці двоє отримують лінк — контракт чекера гарантує invite_url саме тут.
    needsRelogin: by("dead", "challenge"),
    errored: by("error", "unknown"),
    fine: by("live"),
    // context_id === null: людину свідомо ще не логінили (olga). Смикати її
    // алертом щодня — найшвидший спосіб привчити канал ігнорувати бота.
    skipped: by("new"),
  };
}

// ------------------------------------------------------------- транспорт

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Retry-After задокументований, але не гарантований на КОЖНІЙ 429 — а голий
// парс заголовка впаде саме під час інциденту, тобто рівно тоді, коли треба.
function retryAfterSecs(header) {
  const n = Number.parseInt(header ?? "", 10);
  if (!Number.isFinite(n) || n <= 0) return 30;
  return Math.min(n, MAX_RETRY_WAIT_SECS);
}

async function slackPost(payload) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const res = await fetch(SLACK_API, {
      method: "POST",
      headers: {
        // Токен ТІЛЬКИ в заголовку: для JSON-тіла Slack його там не приймає.
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(payload),
    });

    // Єдиний випадок, коли Slack віддає справжній http-статус замість
    // конверта ok/error — тому статус треба дивитись ДО json-розбору.
    if (res.status === 429) {
      if (attempt === MAX_ATTEMPTS) return { ok: false, error: "ratelimited", kind: "transient" };
      const wait = retryAfterSecs(res.headers.get("retry-after"));
      console.error(`  429 — пауза ${wait}s, спроба ${attempt + 1}/${MAX_ATTEMPTS}`);
      await sleep(wait * 1000);
      continue;
    }
    if (!res.ok) {
      if (attempt === MAX_ATTEMPTS) return { ok: false, error: `http_${res.status}`, kind: "transient" };
      await sleep(2000 * attempt);
      continue;
    }

    const body = await res.json().catch(() => null);
    if (!body) return { ok: false, error: "non_json_response", kind: "transient" };
    // HTTP 200 приходить майже на КОЖЕН провал. Хто перевіряє лише res.ok,
    // отримує зелений прогін і жодного сповіщеного автора.
    if (body.ok) return { ok: true, channel: body.channel, ts: body.ts, warning: body.warning };

    const kind = classify(body.error);
    if (kind === "transient" && attempt < MAX_ATTEMPTS) {
      await sleep(2000 * attempt);
      continue;
    }
    return { ok: false, error: body.error, kind };
  }
  return { ok: false, error: "retries_exhausted", kind: "transient" };
}

// ------------------------------------------------------------- main

async function main() {
  const a = args(process.argv.slice(2));
  const reportPath = a.report;
  if (!reportPath) {
    console.error("usage: notify-session-check.mjs --report=<path>");
    process.exit(2);
  }
  if (!DRY_RUN && !TOKEN) { console.error("SLACK_BOT_TOKEN is not set"); process.exit(2); }
  if (!DRY_RUN && !CHANNEL) { console.error("SLACK_CHANNEL_ID is not set"); process.exit(2); }

  // Мапінг slug -> member-id лежить у секреті, бо репозиторій публічний.
  // Помилку розбору друкуємо фіксованим рядком: повідомлення JSON.parse цитує
  // вхід, а вхід тут — реєстр людей.
  let people = {};
  const rawPeople = process.env.SLACK_PEOPLE_JSON;
  if (rawPeople && rawPeople.trim()) {
    try {
      people = JSON.parse(rawPeople);
    } catch {
      console.error("SLACK_PEOPLE_JSON is not valid JSON");
      process.exit(2);
    }
    if (!people || typeof people !== "object" || Array.isArray(people)) {
      console.error("SLACK_PEOPLE_JSON is not a JSON object of {slug: member_id}");
      process.exit(2);
    }
    // Битий id мовчки з'їдає пінг — а пінг і є вся суть фічі. Але з'їдає ВІН
    // ОДИН, і саме так це має боліти: викидаємо тільки зіпсований рядок, решта
    // мапи працює. Раніше тут стояв process.exit(2) на всю мапу — тобто
    // одруківка в чужому рядку (навіть у slug, якого немає у звіті) глушила
    // алерт людині, яка справді вилогінена, і її 20-хвилинний лінк протухав
    // невідкритим. Ціна помилки конфігурації не має падати на того, чий рядок
    // написаний правильно. Деградація до простого імені вже задокументована
    // для slug БЕЗ мапінгу (.env.example) — битий id іде рівно тим самим шляхом.
    // Називаємо slug (він і так у звіті), сам id не друкуємо: мапа — секрет.
    const bad = Object.keys(people).filter((k) => !MEMBER_ID.test(String(people[k] ?? "")));
    for (const k of bad) delete people[k];
    if (bad.length) {
      console.error(
        `::warning::SLACK_PEOPLE_JSON: значення для ${bad.join(", ")} не схоже на member-id (очікується U… або W…) — ` +
        "ці слаги підуть простим іменем, без пінгу",
      );
    }
  }

  let report;
  try {
    report = JSON.parse(readFileSync(resolve(reportPath), "utf8"));
  } catch (e) {
    console.error(`cannot read report ${reportPath}: ${e.message}`);
    process.exit(2);
  }
  const authors = Array.isArray(report?.authors) ? report.authors : [];
  const { needsRelogin, errored, fine, skipped } = partition(authors);
  const now = Date.now();

  console.error(
    `report ${escape(reportPath)}: ${authors.length} author(s) — ` +
    `${needsRelogin.length} need re-login (${needsOperator(needsRelogin, now).length} without a usable link), ` +
    `${errored.length} errored, ${fine.length} live, ${skipped.length} skipped`,
  );

  const payloads = [];
  const quiet = !needsRelogin.length && !errored.length && !REPORT_ALL;
  if (quiet) {
    console.error("нема про що писати — Slack мовчить");
  } else {
    // Одне повідомлення на людину, а не спільний список: @-згадка адресна,
    // кожен відповідає у власному треді, і ліміт 3000 символів на текстовий
    // об'єкт не може з'їсти чужий алерт.
    for (const author of needsRelogin) {
      payloads.push(buildReloginMessage(author, { channel: CHANNEL, people, now, checkedAt: report?.checked_at }));
    }
    // Після адресних повідомлень, а не замість них: автор мусить знати, що він
    // вилогінений, навіть коли лінка для нього немає.
    const forOperator = needsOperator(needsRelogin, now);
    if (forOperator.length) {
      payloads.push(buildNoLinkMessage(forOperator, { channel: CHANNEL, people, now }));
    }
    if (errored.length) payloads.push(buildErrorMessage(errored, { channel: CHANNEL, now }));
    if (!needsRelogin.length && !errored.length) {
      payloads.push(buildAllClearMessage(fine, { channel: CHANNEL }));
    }
  }

  if (DRY_RUN) {
    // stdout у dry-run — рівно масив payload'ів і нічого більше (порожній теж
    // друкуємо, щоб контракт «stdout = JSON-масив» тримався завжди). Live View
    // URL тут відкритий свідомо: оператор саме його і прийшов подивитись.
    console.log(JSON.stringify(payloads, null, 2));
    console.error(`dry run — ${payloads.length} payload(s), нічого не відправлено`);
    process.exit(0);
  }

  let failures = 0;
  for (const [i, payload] of payloads.entries()) {
    if (i) await sleep(PAUSE_BETWEEN_POSTS_MS);
    const res = await slackPost(payload);

    if (res.ok) {
      if (res.warning) console.error(`  warning: ${res.warning}`);
      console.error(`posted -> ${res.channel ?? CHANNEL} (${res.ts ?? "?"})`);
      continue;
    }

    // BUG — це наш JSON, а не середовище. Хай падає трейсбеком: тест мусив
    // спіймати це до релізу, і м'який лог лише сховає причину.
    if (res.kind === "bug") {
      throw new Error(`Slack rejected our payload: ${res.error} — ${remedy(res.error)}`);
    }

    failures += 1;
    console.error(`::error::slack ${res.error} — ${remedy(res.error)}`);

    // Токен/застосунок зламані: решта постів провалиться так само.
    if (res.kind === "fatal") {
      console.error(`::error::аварія конфігурації Slack — решту (${payloads.length - i - 1}) не відправлено`);
      process.exit(2);
    }
  }

  // ЗЕЛЕНИЙ ПРОГІН МУСИТЬ ОЗНАЧАТИ, ЩО ЛЮДИНУ СПОВІСТИЛИ.
  // Тут навмисна інверсія контракту `lifleet check` (той віддає 1, коли хтось
  // не live). Для монітора результат, який має «доїхати» — це САМЕ СПОВІЩЕННЯ,
  // а не те, що всі живі. Тому мертві сесії лишають нас зеленими, і тільки
  // недоставлений Slack робить прогін червоним.
  if (failures) {
    console.error(`::error::${failures} slack message(s) not delivered — розберись за підказками вище`);
    process.exit(1);
  }
  console.error(`ok — ${payloads.length} message(s) delivered`);
}

// Сімка для тестів: імпорт віддає чисті білдери payload'ів, і жоден із них не
// торкається мережі. Прямий запуск — і тільки він — виконує main().
const IS_MAIN = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (IS_MAIN) await main();
