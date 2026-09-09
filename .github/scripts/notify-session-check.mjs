#!/usr/bin/env node
// Читає звіт денної перевірки LinkedIn-сесій і публікує в Slack статус УСІХ
// акаунтів (ростер — по рядку на людину, без жодної @-згадки), а слідом пінгує
// тих, у кого сесія впала — одне повідомлення на людину, з її @-згадкою і
// свіжим Live View посиланням на повторний вхід.
//
// Ростер іде КОЖЕН прогін, включно з днем, коли всі живі: власник хоче бачити
// стан кожного акаунта, а не здогадуватись, чи бот мовчить від того, що все
// добре, чи від того, що зламався. Але тегаємо ВИКЛЮЧНО тих, кому треба щось
// зробити — щоденний пінг «усе добре» глушить канал за тиждень, а глушений
// канал ховає той єдиний алерт, заради якого все це існує. Тому будь-яка
// НЕвідправка мусить бути гучною: кожен збій Slack валить прогін у червоне.
//
// УВАГА щодо мови: увесь текст, який бачить Slack і оператор у логах, —
// АНГЛІЙСЬКОЮ (канал ведеться англійською). Коментарі і докстрінги лишаються
// українською — це конвенція репозиторію.
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
//   SLACK_DRY_RUN      (опційно)     "1" — друкує payload'и в stdout, нічого не шле
//
// Коди виходу: 0 — відпрацював, усе потрібне відправлено;
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
// SLACK_REPORT_ALL більше немає. Він вмикав all-clear на день, коли всі живі;
// тепер ростер іде завжди, тож змінна не має що вмикати. Її не перепризначено
// на «глушити ростер» свідомо: та сама назва з протилежним змістом — пастка
// для того, хто пам'ятає стару семантику, а вимикач щоденного статусу — це
// просто повернення до тиші, від якої ми щойно пішли. Прибрано і з
// .env.example, і з linkedin-session-check.yml (Actions-змінної з такою
// назвою ніколи не існувало, тож мігрувати нема чого).

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

// Локаль англійська — разом з усім, що бачить канал. Місяць саме "short", а не
// "2-digit": в англомовному тексті "07/09" читається як 7 вересня і як 9 липня
// залежно від читача, а "07 Sept" — однозначно.
const KYIV = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Kyiv",
  day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false,
});
const REL = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
const UNITS = [["day", 86400e3], ["hour", 3600e3], ["minute", 60e3]];

// Час у звіті — UTC ISO. Люди в команді живуть за Києвом і читають алерт о 3
// ночі за UTC; голий Z-штамп змушує їх рахувати різницю в голові.
export function kyivTime(iso) {
  const t = Date.parse(iso ?? "");
  return Number.isNaN(t) ? null : `${KYIV.format(t)} Kyiv time`;
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
  invalid_auth: "SLACK_BOT_TOKEN is invalid or revoked — reissue the xoxb token and update the repository secret.",
  not_authed: "SLACK_BOT_TOKEN is empty — the secret never reached the workflow step.",
  token_revoked: "The token was revoked (the app was removed from the workspace) — reinstall the app and update SLACK_BOT_TOKEN.",
  token_expired: "The token expired — reissue it and update SLACK_BOT_TOKEN.",
  account_inactive: "The bot account is deactivated in the workspace.",
  missing_scope: "The chat:write scope is missing (and chat:write.public for a public channel) — add it in the app settings and REINSTALL the app, otherwise the token keeps the old scopes.",
  no_permission: "The token is not allowed to do this — check the app scopes.",
  channel_not_found: "SLACK_CHANNEL_ID is wrong OR the channel is private and the bot cannot see it — set the right C-id and run `/invite @<bot>` in #linkedin-session-bot.",
  not_in_channel: "The bot is not in the channel — `/invite @<bot>` in #linkedin-session-bot (chat:write.public covers public channels only).",
  is_archived: "The channel is archived — unarchive it or point SLACK_CHANNEL_ID somewhere else.",
  messages_tab_disabled: "The app has the Messages tab (App Home) turned off — turn it on in the app settings.",
  restricted_action: "Workspace settings forbid this post — take it to a Slack admin.",
  ratelimited: "Slack is throttling us (HTTP 429) — every attempt is used up.",
  rate_limited: "Too many messages from the app — every attempt is used up.",
  internal_error: "A temporary failure on Slack's side — every attempt is used up.",
  service_unavailable: "Slack is unavailable — every attempt is used up.",
};
const remedy = (code) => REMEDY[code] ?? "See https://docs.slack.dev/reference/methods/chat.postMessage/ (the Errors section).";

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
  if (!seen) return "There has never been a successful check, so there is nothing to date the logout from.";
  if (author.last_ok_source === "registry-snapshot") {
    return `The registry snapshot says last seen logged in *${escape(seen)}* — this run did not observe that, ` +
      "and in CI the registry does not survive a run, so the date can be badly out of date.";
  }
  return `Last successful check: *${escape(seen)}* (${escape(relative(author.last_ok, now))}).`;
}

export function buildReloginMessage(author, { channel, people, now = Date.now(), checkedAt = null }) {
  const { who, mapped } = mention(author, people);
  const slug = escape(author.slug);
  const status = escape(author.status);

  const checked = kyivTime(checkedAt);
  const when = checked ? `Checked: *${escape(checked)}*. ` : "";

  const blocks = [
    section(`${who}, the LinkedIn session for *${slug}* is no longer active — status \`${status}\`.\n${when}${lastSeenLine(author, now)}`),
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
      until = ` — :warning: it has expired (${escape(exp)}), the operator will mint a fresh one`;
    } else if (exp) {
      until = ` — valid until *${escape(exp)}*, that is ${escape(relative(author.invite_expires_at, now))}.`;
    }
    blocks.push(section(`:key: <${safeUrl(author.invite_url)}|Log in to LinkedIn>${until}`));
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
      ? ` It will appear after *${escape(wait)}* — that is when a browser slot frees up.`
      : "";
    blocks.push(section(
      `:hourglass_flowing_sand: A fresh link has not been minted yet — the operator will mint one and post it here.${when} Nothing is needed from you right now.`,
    ));
  }

  blocks.push(context(
    "Log in with *email and password*. Not through Google/Apple — the OAuth popup does not open in a cloud browser, and the login hangs.",
  ));

  if (!mapped) {
    blocks.push(context(
      `:information_source: No Slack id is mapped for \`${slug}\`, so there is no ping. Add one to SLACK_PEOPLE_JSON and reach the person by hand.`,
    ));
  }

  return {
    channel,
    // text — це fallback для пуш-нотифікації. Посилання сюди НЕ кладемо:
    // прев'ю пуша розходиться по пристроях і перевідкривається де завгодно.
    text: `${who} the LinkedIn session for ${slug} is down — a re-login is needed`,
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
      : (a.invite_url ? "the link expired before anyone opened it" : "no reason was recorded");
    return `• *${escape(a.slug)}* — \`${escape(a.status)}\`: ${why}`;
  });
  return {
    channel,
    text: "LinkedIn: someone is missing a re-login link",
    unfurl_links: false,
    unfurl_media: false,
    blocks: [
      section(`${op}:hammer_and_wrench: *A re-login link has to be minted by hand:*\n${lines.join("\n")}`),
      // Рівно та команда, яку в цьому репо запускає оператор. В автора вона не
      // працює — тому й живе тільки тут.
      context("`python3 scripts/lifleet/invite_link.py <slug>` — then post the link in that person's thread above. If the reason is a busy Browserbase slot, wait until the time named in that person's message above: minting earlier returns 429."),
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
        ? `the registry snapshot says last seen logged in ${escape(seen)}, and that date may be out of date`
        : `last successful check ${escape(seen)}, ${escape(relative(a.last_ok, now))}`)
      : "there has never been a successful check";
    return `• *${escape(a.slug)}* — \`${escape(a.status)}\` (${tail})`;
  });
  return {
    channel,
    text: "LinkedIn: the session check could not be completed",
    unfurl_links: false,
    unfurl_media: false,
    blocks: [
      section(`:grey_question: *The check could not be completed:*\n${lines.join("\n")}`),
      // Найнебезпечніша інтерпретація цього повідомлення — «ну значить живі».
      context("This does NOT mean \"logged in\" — the status is simply unknown. The next run checks again; if it keeps repeating, read the log of the session check step."),
    ],
  };
}

// ------------------------------------------------------------- ростер

// Емодзі і формулювання на статус. Ростер читають щодня і по діагоналі, тому
// рядок мусить давати відповідь «мені треба щось робити?» з першого символу.
const ROSTER = {
  live: [":white_check_mark:", "logged in"],
  dead: [":red_circle:", "logged out"],
  // challenge — це не «впав пароль»: LinkedIn просить пройти перевірку, і
  // людина мусить знати, що саме її чекає, інакше вона відкриє лінк, побачить
  // капчу і вирішить, що лінк битий.
  challenge: [":red_circle:", "logged out, LinkedIn is asking for a verification step"],
  error: [":grey_question:", "could not be checked"],
  unknown: [":grey_question:", "could not be checked"],
  // olga: контексту немає, її свідомо не логінили. «not monitored» — щоб цей
  // рядок ніхто не прочитав як тихий провал перевірки.
  new: [":double_vertical_bar:", "never logged in, not monitored"],
};

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// Статус за межами контракту чекера. partition() не кладе його в жоден кошик,
// тобто до появи ростера така людина зникала з каналу повністю — ростер це
// закриває: він іде по САМОМУ звіту, а не по кошиках.
const known = (s) => Object.prototype.hasOwnProperty.call(ROSTER, s);

// Статус УСІХ акаунтів, один рядок на людину, КОЖЕН прогін.
//
// Жодної @-згадки тут бути не може, і це не стилістика: ростер іде щодня, а
// щоденний пінг вчить канал ігнорувати бота — після чого зникає й той алерт,
// заради якого все будувалось. Тегаємо тільки того, хто мусить діяти, і робимо
// це окремим повідомленням (buildReloginMessage).
export function buildRosterMessage(authors, { channel, checkedAt = null }) {
  const { needsRelogin, errored, fine } = partition(authors);
  const odd = authors.filter((a) => !known(a.status));

  const rows = authors.map((a) => {
    const [icon, label] = ROSTER[a.status] ?? [":grey_question:", `unexpected status \`${escape(a.status)}\``];
    // Куди дивитись далі. Ростер не несе ні лінка, ні пінга, тож без цього
    // хвоста «logged out» виглядає як тупик. Формулювання навмисно «see the
    // message», а не «tagged»: для slug без мапінгу повідомлення нижче нікого
    // не тегає, і обіцяти тег там означало б обіцяти пінг, якого не буде.
    let tail = "";
    if (a.status === "dead" || a.status === "challenge") tail = " (see the message below)";
    else if (a.status === "error" || a.status === "unknown") tail = " (details below)";
    // Ім'я, а не slug. Ростер читають люди в каналі, а slug — це операторська
    // ручка: він потрібен рівно там, де його вводять у команду
    // (buildNoLinkMessage). Поки тут стояв slug, канал бачив рядок про "alex",
    // хоча всі в компанії знають цю людину як Andy — тобто повідомлення про
    // конкретну людину не називало її впізнавано. Фолбек на slug лишаємо:
    // звіт без name зламати ростер не має.
    const who = a.name || a.slug;
    return `${icon} *${escape(who)}* — ${label}${tail}`;
  });

  const problems = [];
  if (needsRelogin.length) problems.push(`${plural(needsRelogin.length, "account", "accounts")} logged out`);
  if (errored.length) problems.push(`${plural(errored.length, "account", "accounts")} could not be checked`);
  if (odd.length) problems.push(`${plural(odd.length, "account", "accounts")} with an unexpected status`);

  // Заголовок мусить бути правдивим у кожній з цих гілок окремо. «Everything is
  // fine» над порожнім звітом або над самими лише паузами — це та сама тиша, від
  // якої ми пішли, тільки з галочкою.
  let head;
  // summary — той самий вердикт голим текстом. Він іде у fallback пуша, тож
  // мусить рахуватись рівно з тих самих гілок: розійдуться — і пуш скаже
  // «everyone is logged in» над звітом, у якому взагалі нікого немає.
  let summary;
  if (!authors.length) {
    summary = "the report contains no accounts";
    head = ":grey_question: *The report contains no accounts — this check covered nobody.*";
  } else if (problems.length) {
    summary = problems.join(", ");
    head = `${needsRelogin.length ? ":red_circle:" : ":grey_question:"} *LinkedIn sessions: ${summary}.*`;
  } else if (!fine.length) {
    summary = "no account is being monitored";
    head = ":double_vertical_bar: *No account is being monitored — every one of them is paused.*";
  } else {
    summary = "everyone is logged in";
    head = fine.length === 1
      ? ":white_check_mark: *The one monitored LinkedIn account is logged in. Nothing to do.*"
      : `:white_check_mark: *All ${fine.length} monitored LinkedIn accounts are logged in. Nothing to do.*`;
  }

  const checked = kyivTime(checkedAt);
  const foot = checked ? `Checked ${escape(checked)}.` : "The check time is not recorded in the report.";

  return {
    channel,
    // Без посилань і без згадок — у пуші це рівно один рядок статусу.
    text: `LinkedIn session status: ${summary}`,
    unfurl_links: false,
    unfurl_media: false,
    blocks: [
      section(rows.length ? `${head}\n${rows.join("\n")}` : head),
      context(`${foot} Every account the check covered is listed here; only people who have to act get tagged.`),
    ],
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
      console.error(`  429 — waiting ${wait}s, attempt ${attempt + 1}/${MAX_ATTEMPTS}`);
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
        `::warning::SLACK_PEOPLE_JSON: the value for ${bad.join(", ")} does not look like a member id (U… or W… expected) — ` +
        "those slugs will post as a plain name, with no ping",
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
  // Ростер — ПЕРШИМ і завжди. Він задає контекст для всього, що йде нижче
  // («logged out (tagged in a message below)» мусить показувати вниз, а не
  // вгору), і він же єдине повідомлення в дні, коли робити нічого не треба.
  payloads.push(buildRosterMessage(authors, { channel: CHANNEL, checkedAt: report?.checked_at }));
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

  if (DRY_RUN) {
    // stdout у dry-run — рівно масив payload'ів і нічого більше (порожній теж
    // друкуємо, щоб контракт «stdout = JSON-масив» тримався завжди). Live View
    // URL тут відкритий свідомо: оператор саме його і прийшов подивитись.
    console.log(JSON.stringify(payloads, null, 2));
    console.error(`dry run — ${payloads.length} payload(s), nothing was sent`);
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
      console.error(`::error::Slack configuration failure — the remaining ${payloads.length - i - 1} message(s) were not sent`);
      process.exit(2);
    }
  }

  // ЗЕЛЕНИЙ ПРОГІН МУСИТЬ ОЗНАЧАТИ, ЩО ЛЮДИНУ СПОВІСТИЛИ.
  // Тут навмисна інверсія контракту `lifleet check` (той віддає 1, коли хтось
  // не live). Для монітора результат, який має «доїхати» — це САМЕ СПОВІЩЕННЯ,
  // а не те, що всі живі. Тому мертві сесії лишають нас зеленими, і тільки
  // недоставлений Slack робить прогін червоним.
  if (failures) {
    console.error(`::error::${failures} slack message(s) not delivered — work through the hints above`);
    process.exit(1);
  }
  console.error(`ok — ${payloads.length} message(s) delivered`);
}

// Сімка для тестів: імпорт віддає чисті білдери payload'ів, і жоден із них не
// торкається мережі. Прямий запуск — і тільки він — виконує main().
const IS_MAIN = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (IS_MAIN) await main();
