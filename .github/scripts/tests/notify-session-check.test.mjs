#!/usr/bin/env node
// Офлайн-регресія нотифаєра сесій. Жодного мережевого виклику: усе ганяємо
// через SLACK_DRY_RUN=1, де stdout — рівно JSON-масив payload'ів, які пішли б
// у Slack.
//
//   node --test .github/scripts/tests/notify-session-check.test.mjs
//   node --test ".github/scripts/tests/*.test.mjs"     # у лапках: глоб розкриває node
//
// Передавати сюди ПАПКУ не можна: раннер node --test пропускає теки, чиє ім'я
// починається з крапки, тож `.github/…` він не обходить — і мовчки вважає шлях
// модулем, падаючи з MODULE_NOT_FOUND замість того, щоб щось запустити.
//
// Перевіряємо не «чи не впало», а те, що ламається тихо: зник пінг, зник лінк,
// бот розбудив канал даремно, або алерт пішов людині, яку свідомо не логінили.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { classify, escape, safeUrl, partition } from "../notify-session-check.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(HERE, "..", "notify-session-check.mjs");
const TMP = mkdtempSync(join(tmpdir(), "notify-session-check-"));

const CHANNEL = "C0FAKECHANNEL";
const PEOPLE = JSON.stringify({ maria: "U04JKL", peter: "U02DEF" });
// Ніколи не справжній токен: у dry-run він не потрібен, і тест не має жодної
// причини тримати в собі щось, що можна злити.
const FAKE_TOKEN = "xoxb-not-a-real-token";

const NOW = Date.now();
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();

function reportFile(name, authors) {
  const p = join(TMP, `${name}.json`);
  writeFileSync(p, JSON.stringify({ checked_at: iso(0), authors }, null, 2));
  return p;
}

// Середовище збираємо з нуля: у розробника в шелі цілком може лежати
// справжній SLACK_BOT_TOKEN, і тест не сміє його підхопити.
function run(reportPath, env = {}) {
  const r = spawnSync(process.execPath, [SCRIPT, `--report=${reportPath}`], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      SLACK_DRY_RUN: "1",
      SLACK_BOT_TOKEN: FAKE_TOKEN,
      SLACK_CHANNEL_ID: CHANNEL,
      ...env,
    },
  });
  return {
    code: r.status,
    stderr: r.stderr,
    stdout: r.stdout,
    payloads: r.stdout.trim() ? JSON.parse(r.stdout) : null,
  };
}

const allText = (payload) => JSON.stringify(payload);

const DEAD_MARIA = {
  slug: "maria", name: "Maria Umen", status: "dead",
  last_ok: iso(26 * 3600e3),
  invite_url: "https://www.browserbase.com/devtools-fullscreen/inspector.html?sessionId=abc&debug=1",
  invite_expires_at: new Date(NOW + 28 * 60e3).toISOString(),
  session_id: "abc-123",
};
const LIVE_PETER = { slug: "peter", name: "Peter Ovchynnikov", status: "live", last_ok: iso(60e3) };
const NEW_OLGA = { slug: "olga", name: "Olga", status: "new", last_ok: null };

// ------------------------------------------------------------- пінг і лінк

test("a dead author gets a pinged message with the link and its expiry", () => {
  const r = run(reportFile("dead", [DEAD_MARIA, LIVE_PETER]), { SLACK_PEOPLE_JSON: PEOPLE });
  assert.equal(r.code, 0);
  assert.equal(r.payloads.length, 1, "один впав — рівно одне повідомлення");

  const p = r.payloads[0];
  const body = allText(p);
  assert.equal(p.channel, CHANNEL);
  // Пінг мусить бути escape-послідовністю Slack, а не текстом «@maria».
  assert.match(body, /<@U04JKL>/);
  // …і НЕ всередині бектиків: у інлайн-коді Slack не парсить згадки взагалі.
  assert.doesNotMatch(body, /`[^`]*<@U04JKL>/);
  assert.match(body, /browserbase\.com\/devtools-fullscreen/, "лінк на місці");
  assert.match(body, /дійсне до/, "строк життя лінка названий");
  assert.match(body, /за Києвом/, "час у київському поясі, не UTC");
  assert.match(body, /поштою і паролем/, "інструкція про email+пароль");
  assert.match(body, /Google\/Apple/, "і чому не через OAuth");
  // Обидва unfurl мусять бути явно вимкнені: інакше краулер Slack серверно
  // смикне одноразовий debugger-URL.
  assert.equal(p.unfurl_links, false);
  assert.equal(p.unfurl_media, false);
  // Лінк не має протікати у fallback-текст пуш-нотифікації.
  assert.doesNotMatch(p.text, /browserbase/);
});

test("the link is a mrkdwn link, not a button", () => {
  const r = run(reportFile("nobutton", [DEAD_MARIA]), { SLACK_PEOPLE_JSON: PEOPLE });
  const body = allText(r.payloads[0]);
  // url-кнопка все одно шле interaction payload, який нікому ack-ати.
  assert.doesNotMatch(body, /"type":"actions"/);
  assert.match(body, /<https:\/\/www\.browserbase\.com[^|]*\|Увійти в LinkedIn>/);
});

test("challenge is alerted the same way as dead", () => {
  const r = run(reportFile("challenge", [{ ...DEAD_MARIA, slug: "alex", status: "challenge" }]));
  assert.equal(r.payloads.length, 1);
  assert.match(allText(r.payloads[0]), /challenge/);
});

// ------------------------------------------------------------- тиша

test("everyone live means no payload at all", () => {
  const r = run(reportFile("live", [LIVE_PETER, { ...LIVE_PETER, slug: "maria" }]), { SLACK_PEOPLE_JSON: PEOPLE });
  assert.equal(r.code, 0);
  assert.deepEqual(r.payloads, [], "тиша — нормальний стан, канал не будимо");
});

test("SLACK_REPORT_ALL=1 turns the silence into one all-clear", () => {
  const r = run(reportFile("reportall", [LIVE_PETER]), { SLACK_REPORT_ALL: "1" });
  assert.equal(r.payloads.length, 1);
  assert.match(allText(r.payloads[0]), /Усі сесії LinkedIn живі/);
});

test("a never-logged-in author is skipped, not alerted", () => {
  // olga свідомо на паузі (context_id === null). Щоденний алерт про неї — це
  // те, від чого канал глушать назавжди.
  const r = run(reportFile("new", [LIVE_PETER, NEW_OLGA]));
  assert.deepEqual(r.payloads, []);
  assert.match(r.stderr, /1 skipped/);
});

// ------------------------------------------------------------- деградації

test("a slug missing from SLACK_PEOPLE_JSON degrades to a plain name", () => {
  // Один звільнений колега не має права знімати алерт з усієї команди.
  const r = run(reportFile("unmapped", [DEAD_MARIA]), { SLACK_PEOPLE_JSON: JSON.stringify({ peter: "U02DEF" }) });
  assert.equal(r.code, 0);
  const body = allText(r.payloads[0]);
  assert.doesNotMatch(body, /<@/, "жодного пінгу — і жодного @channel як фолбеку");
  assert.match(body, /Maria Umen/, "ім'я названо відкрито");
  assert.match(body, /не змаплено/, "і сказано, що мапінгу бракує");
  assert.match(body, /browserbase\.com/, "лінк усе одно віддали");
});

test("no SLACK_PEOPLE_JSON at all still delivers the alert", () => {
  const r = run(reportFile("nopeople", [DEAD_MARIA]));
  assert.equal(r.code, 0);
  assert.equal(r.payloads.length, 1);
  assert.doesNotMatch(allText(r.payloads[0]), /<@/);
});

test("a dead author with no minted link is told to wait, and the operator is told to act", () => {
  const { invite_url, invite_expires_at, ...noLink } = DEAD_MARIA;
  noLink.invite_error = "ліміт лінків на прогін (LIFLEET_MAX_INVITES_PER_RUN=1)";
  const r = run(reportFile("nolink", [noLink]), { SLACK_PEOPLE_JSON: PEOPLE });
  assert.equal(r.payloads.length, 2, "адресне повідомлення автору + наряд оператору");

  const toAuthor = allText(r.payloads[0]);
  assert.match(toAuthor, /<@U04JKL>/, "людину все одно пінгуємо");
  // Команда репо в повідомленні, що @-тегає власника LinkedIn-акаунта, — це
  // інструкція, яку адресат не може виконати: ні чекауту, ні ключа, ні прав.
  assert.doesNotMatch(toAuthor, /invite_link\.py/, "автору — жодних команд репо");
  assert.match(toAuthor, /підніме оператор/);
  assert.doesNotMatch(toAuthor, /дійсне до/);

  const toOperator = allText(r.payloads[1]);
  assert.match(toOperator, /invite_link\.py <slug>/, "оператору — рівно та команда, яку він запускає");
  assert.match(toOperator, /maria/);
  assert.match(toOperator, /LIFLEET_MAX_INVITES_PER_RUN/, "і причина, чому лінка немає");
});

test("the no-link message names when the browser slot frees up", () => {
  // «підніми сам» під час зайнятого слота дає 429; час звільнення — єдина
  // відповідь, з якою можна щось зробити.
  const { invite_url, invite_expires_at, ...noLink } = DEAD_MARIA;
  noLink.invite_wait_until = new Date(NOW + 22 * 60e3).toISOString();
  const r = run(reportFile("nolinkwait", [noLink]), { SLACK_PEOPLE_JSON: PEOPLE });
  assert.match(allText(r.payloads[0]), /з'явиться після/);
  assert.match(allText(r.payloads[0]), /за Києвом/);
});

test("the operator gets pinged when SLACK_PEOPLE_JSON carries _operator", () => {
  const { invite_url, invite_expires_at, ...noLink } = DEAD_MARIA;
  const r = run(reportFile("nolinkop", [noLink]), {
    SLACK_PEOPLE_JSON: JSON.stringify({ maria: "U04JKL", _operator: "U09OPS" }),
  });
  assert.match(allText(r.payloads[1]), /<@U09OPS>/);
  // …і сам оператор не має потрапити в адресне повідомлення автора.
  assert.doesNotMatch(allText(r.payloads[0]), /<@U09OPS>/);
});

test("an already-expired link says so instead of a backwards countdown", () => {
  // Прогін міг простояти в черзі CI довше, ніж живе keep_alive сесія.
  // «дійсне до 09:33» з часом у минулому читається як зламаний бот.
  const stale = { ...DEAD_MARIA, invite_expires_at: new Date(NOW - 40 * 60e3).toISOString() };
  const r = run(reportFile("expired", [stale]), { SLACK_PEOPLE_JSON: PEOPLE });
  const body = allText(r.payloads[0]);
  assert.match(body, /строк вийшов/);
  assert.doesNotMatch(body, /invite_link\.py/, "автору — жодних команд репо");
  assert.doesNotMatch(body, /дійсне до/);
  // Протухлий лінк для автора — те саме, що його відсутність, тож оператор
  // мусить дізнатись: інакше «свіжий підніме оператор» нікому не адресовано.
  assert.equal(r.payloads.length, 2);
  assert.match(allText(r.payloads[1]), /invite_link\.py <slug>/);
});

test("a registry-snapshot last_ok is not presented as an observation", () => {
  // У CI реєстр приїжджає з секрету і знищується після прогону, тож для
  // вилогіненого автора last_ok — це дата останнього ручного експорту. Подати
  // її як «остання успішна перевірка (97 днів тому)» означає збрехати рівно в
  // тому повідомленні, заради якого все будувалось.
  const stale = {
    ...DEAD_MARIA,
    last_ok: iso(97 * 86400e3),
    last_ok_source: "registry-snapshot",
  };
  const body = allText(run(reportFile("snapshot", [stale])).payloads[0]);
  assert.match(body, /за знімком реєстру/i, "джерело названо");
  assert.match(body, /може бути сильно застарілою/);
  assert.doesNotMatch(body, /Остання успішна перевірка/, "жодної обіцянки, якої монітор не робив");
  // Час, який прогін СПРАВДІ спостерігав, — це checked_at, і він тут є.
  assert.match(body, /Перевірено:/);
});

test("a null last_ok does not render as Invalid Date", () => {
  const r = run(reportFile("nolastok", [{ ...DEAD_MARIA, last_ok: null }]));
  const body = allText(r.payloads[0]);
  assert.doesNotMatch(body, /Invalid Date|NaN|null/);
  assert.match(body, /Успішних перевірок ще не було/);
});

// ------------------------------------------------------------- помилки перевірки

test("errored authors get one summary and no link", () => {
  const r = run(reportFile("errored", [
    { slug: "alex", name: "Andrii Rozhylo", status: "error", last_ok: iso(3 * 86400e3) },
    { slug: "author2", name: "Second Author", status: "unknown", last_ok: null },
    LIVE_PETER,
  ]));
  assert.equal(r.payloads.length, 1, "одна зведена картка, а не лист на кожного");
  const body = allText(r.payloads[0]);
  assert.match(body, /alex/);
  assert.match(body, /author2/);
  assert.doesNotMatch(body, /browserbase/);
  assert.match(body, /НЕ означає «залогінені»/, "невідомий статус не читається як «все добре»");
});

test("dead and errored authors coexist as separate messages", () => {
  const r = run(reportFile("mixed", [
    DEAD_MARIA,
    { slug: "alex", name: "Andrii Rozhylo", status: "error", last_ok: iso(7200e3) },
    LIVE_PETER, NEW_OLGA,
  ]), { SLACK_PEOPLE_JSON: PEOPLE });
  assert.equal(r.payloads.length, 2);
  assert.match(allText(r.payloads[0]), /<@U04JKL>/);
  assert.match(allText(r.payloads[1]), /Перевірку не вдалося завершити/);
});

// ------------------------------------------------------------- конфігурація

test("a missing --report is an operator error, not a crash", () => {
  const r = spawnSync(process.execPath, [SCRIPT], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, SLACK_DRY_RUN: "1" },
  });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage: notify-session-check\.mjs --report=/);
});

test("a malformed SLACK_PEOPLE_JSON fails loudly without echoing itself", () => {
  const r = run(reportFile("badpeople", [DEAD_MARIA]), { SLACK_PEOPLE_JSON: '{"maria": "U04JKL"' });
  assert.equal(r.status ?? r.code, 2);
  assert.match(r.stderr, /SLACK_PEOPLE_JSON is not valid JSON/);
  // Повідомлення JSON.parse цитує вхід, а вхід — це реєстр людей.
  assert.doesNotMatch(r.stderr, /U04JKL/);
});

test("a people mapping that is not a member id degrades that slug, nothing else", () => {
  // Раніше цей рядок валив увесь прогін (exit 2, нуль повідомлень). Одруківка
  // в чужому рядку не має права знімати алерт з людини, чий рядок написаний
  // правильно, — її свіжий 20-хвилинний лінк протухав би невідкритим.
  const r = run(reportFile("nonid", [DEAD_MARIA, { ...DEAD_MARIA, slug: "peter", name: "Peter" }]), {
    SLACK_PEOPLE_JSON: JSON.stringify({ maria: "U04JKL", peter: "@peter" }),
  });
  assert.equal(r.code, 0);
  assert.equal(r.payloads.length, 2, "обидва вилогінені отримали своє повідомлення");
  assert.match(allText(r.payloads[0]), /<@U04JKL>/, "справний мапінг пінгує як завжди");
  assert.doesNotMatch(allText(r.payloads[1]), /<@/, "битий — деградує до імені, як і відсутній");
  assert.match(allText(r.payloads[1]), /не змаплено/);
  assert.match(r.stderr, /::warning::SLACK_PEOPLE_JSON/);
  assert.match(r.stderr, /peter/);
  // Значення — це реєстр людей; у лог іде тільки slug.
  assert.doesNotMatch(r.stderr, /@peter/);
});

test("a people map that is not an object at all is still fatal", () => {
  // Тут деградувати нема від чого: мапи просто немає, і мовчазний прогін без
  // жодного пінгу мусить бути гучним.
  const r = run(reportFile("arraypeople", [DEAD_MARIA]), { SLACK_PEOPLE_JSON: '["U04JKL"]' });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /not a JSON object/);
});

test("the bot token never reaches stdout or stderr", () => {
  const r = run(reportFile("notoken", [DEAD_MARIA]), { SLACK_PEOPLE_JSON: PEOPLE });
  assert.doesNotMatch(r.stdout + r.stderr, /xoxb-/);
});

// ------------------------------------------------------------- чисті функції

test("interpolated values are escaped before they reach mrkdwn", () => {
  assert.equal(escape("a & b < c > d"), "a &amp; b &lt; c &gt; d");
  assert.equal(escape(null), "");
});

test("safeUrl neutralises only what would close the link construct", () => {
  // & мусить лишитись сирим — це реальний query-параметр Live View URL.
  assert.equal(safeUrl("https://x/?a=1&b=2"), "https://x/?a=1&b=2");
  assert.equal(safeUrl("https://x/?a=<b>|c"), "https://x/?a=%3Cb%3E%7Cc");
});

test("every documented Slack error lands in a handled bucket", () => {
  assert.equal(classify("invalid_auth"), "fatal");
  assert.equal(classify("not_in_channel"), "target");
  // Обидва написання існують і означають різне — ловимо обидва.
  assert.equal(classify("ratelimited"), "transient");
  assert.equal(classify("rate_limited"), "transient");
  assert.equal(classify("invalid_blocks"), "bug");
  assert.equal(classify("something_new_slack_invented"), "unknown");
});

test("partition never puts new or live authors in the alert buckets", () => {
  const p = partition([DEAD_MARIA, LIVE_PETER, NEW_OLGA, { slug: "x", status: "error" }]);
  assert.deepEqual(p.needsRelogin.map((a) => a.slug), ["maria"]);
  assert.deepEqual(p.errored.map((a) => a.slug), ["x"]);
  assert.deepEqual(p.fine.map((a) => a.slug), ["peter"]);
  assert.deepEqual(p.skipped.map((a) => a.slug), ["olga"]);
});
