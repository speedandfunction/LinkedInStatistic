#!/usr/bin/env node
// Офлайн-регресія нотифаєра щотижневого збору. Жодного мережевого виклику:
// усе ганяємо через SLACK_DRY_RUN=1 (stdout — JSON-масив payload'ів), а гілку
// «нема токена» — без dry-run, бо вона виходить до будь-якого fetch.
//
//   node --test .github/scripts/tests/notify-weekly.test.mjs
//   node --test ".github/scripts/tests/*.test.mjs"
//
// Перевіряємо те, що ламається тихо: неповний тиждень названо «опублікованим»,
// оператора не пінгнули, пінгнули автора, який нічого не може зробити, або
// сповіщення про збій саме стало причиною червоного прогону.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildWeeklyMessage, describe, deadlineFor, operatorId, parseNotes } from "../notify-weekly.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(HERE, "..", "notify-weekly.mjs");
const TMP = mkdtempSync(join(tmpdir(), "notify-weekly-"));

const CHANNEL = "C0FAKECHANNEL";
// Ніколи не справжній токен (і не в формі xoxb-<цифри>-<цифри>: її блокує push protection).
const FAKE_TOKEN = "xoxb-not-a-real-token";
const OPERATOR = "U09OPS";
const AUTHOR_IDS = ["U02DEF", "U03GHI", "U04JKL"];
const PEOPLE = JSON.stringify({ peter: "U02DEF", andy: "U03GHI", maria: "U04JKL", _operator: OPERATOR });
const RUN_URL = "https://github.com/speedandfunction/LinkedInStatistic/actions/runs/123456";
const PR = "https://github.com/speedandfunction/LinkedInStatistic/pull/36";

const PROFILES = join(TMP, "profiles.json");
writeFileSync(PROFILES, JSON.stringify({
  _note: "fixture",
  peter: { name: "Peter Ovchynnikov" },
  andy: { name: "Andy Rozhylo" },
  maria: { name: "Maria Umen" },
}));

// Поточний ISO-понеділок: дедлайн у spawn-тестах мусить бути в майбутньому
// незалежно від дати запуску. Точні дати перевіряються на чистому білдері нижче.
const THIS_WEEK = (() => {
  const d = new Date();
  const day = (d.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day)).toISOString().slice(0, 10);
})();

// Середовище з нуля: у шелі розробника може лежати справжній SLACK_BOT_TOKEN.
function run(env = {}, { dry = true } = {}) {
  const r = spawnSync(process.execPath, [SCRIPT], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      ...(dry ? { SLACK_DRY_RUN: "1" } : {}),
      SLACK_BOT_TOKEN: FAKE_TOKEN,
      SLACK_CHANNEL_ID: CHANNEL,
      SLACK_PEOPLE_JSON: PEOPLE,
      PROFILES_FILE: PROFILES,
      GITHUB_SERVER_URL: "https://github.com",
      GITHUB_REPOSITORY: "speedandfunction/LinkedInStatistic",
      GITHUB_RUN_ID: "123456",
      WEEK: THIS_WEEK,
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

const CLEAN_RUN = { CLEAN: "1", NOTES: "", INVALID_JSON: "0", PR_URL: PR, BRANCH: `chore/linkedin-stats-${THIS_WEEK}`, MAIN_UPDATED: "true", JOB_STATUS: "success" };
const REVIEW_RUN = { CLEAN: "0", NOTES: "peter:partial maria:exit1", INVALID_JSON: "0", PR_URL: PR, BRANCH: `chore/linkedin-stats-${THIS_WEEK}`, MAIN_UPDATED: "false", JOB_STATUS: "failure" };
const CRASH_RUN = { CLEAN: "", NOTES: "", INVALID_JSON: "", PR_URL: "", BRANCH: "", MAIN_UPDATED: "", JOB_STATUS: "failure" };

const body = (r) => JSON.stringify(r.payloads);
const firstText = (r) => r.payloads[0].blocks[0].text.text;

function assertNoAuthorPing(text) {
  for (const id of AUTHOR_IDS) assert.doesNotMatch(text, new RegExp(id), `автор ${id} не тегається ніколи`);
}

// ------------------------------------------------------------- три випадки

test("a clean, merged week posts one short message with per-author status and no ping", () => {
  const r = run(CLEAN_RUN);
  assert.equal(r.code, 0);
  assert.equal(r.payloads.length, 1, "рівно одне повідомлення на прогін");
  const p = r.payloads[0];
  assert.equal(p.channel, CHANNEL);
  assert.match(firstText(r), new RegExp(`Week ${THIS_WEEK} collected and merged into main`));
  for (const name of ["Peter Ovchynnikov", "Andy Rozhylo", "Maria Umen"]) {
    assert.match(firstText(r), new RegExp(`:white_check_mark: \\*${name}\\* — collected`));
  }
  assert.doesNotMatch(body(r), /<@/, "у день, коли робити нічого, пінгувати нікого");
  assert.doesNotMatch(body(r), /!here|!channel|!everyone/);
  assert.doesNotMatch(body(r), /NOT published|Deadline/);
  assert.equal(p.unfurl_links, false);
  assert.equal(p.unfurl_media, false);
});

test("an unmerged week says NOT published, links the PR, names each problem, sets the deadline and pings the operator", () => {
  const r = run(REVIEW_RUN);
  assert.equal(r.code, 0);
  assert.equal(r.payloads.length, 1);
  const text = body(r);
  assert.match(firstText(r), new RegExp(`^<@${OPERATOR}> :rotating_light: \\*Week ${THIS_WEEK} is NOT published — it is waiting for review\\.\\*`));
  assert.match(firstText(r), /:warning: \*Peter Ovchynnikov\* — some posts or reactions not fully read \(`partial`\)/);
  assert.match(firstText(r), /:red_circle: \*Maria Umen\* — scrape failed \(`exit1`\)/);
  assert.match(firstText(r), /:white_check_mark: \*Andy Rozhylo\* — collected/, "решта авторів — з чесним статусом");
  assert.match(text, /<https:\/\/github\.com\/speedandfunction\/LinkedInStatistic\/pull\/36\|pull request #36>/);
  assert.match(text, /Deadline: Monday .* Kyiv time/);
  assert.match(text, /lost for good/);
  assert.match(text, /actions\/runs\/123456/);
  assert.match(r.payloads[0].text, new RegExp(`<@${OPERATOR}>`), "пінг і в fallback-тексті пуша");
  assert.doesNotMatch(r.payloads[0].text, /https?:/, "без посилань у пуші");
  assertNoAuthorPing(text);
});

test("a run that crashed before a PR existed pings the operator and links the run", () => {
  const r = run(CRASH_RUN);
  assert.equal(r.code, 0);
  assert.equal(r.payloads.length, 1);
  const text = body(r);
  assert.match(firstText(r), new RegExp(`^<@${OPERATOR}> :x: \\*The weekly LinkedIn run crashed before it opened a pull request\\*`));
  assert.match(text, /Nothing was published and nothing is waiting for review/);
  assert.match(text, new RegExp(`<${RUN_URL.replace(/[./]/g, "\\$&")}\\|workflow run>`));
  assert.match(text, /Deadline: Monday/);
  // Після краху мовчання про автора — це «невідомо», а не «collected».
  assert.doesNotMatch(text, /collected\b(?! and merged)/);
  assert.doesNotMatch(text, /pull request #/);
  assertNoAuthorPing(text);
});

test("a crash keeps whatever the scrape did report, plus a pushed branch and a cancellation", () => {
  const r = run({ ...CRASH_RUN, NOTES: "andy:auth", BRANCH: "chore/linkedin-stats-x", JOB_STATUS: "cancelled" });
  const t = firstText(r);
  assert.match(t, /What the scrape reported before it stopped:/);
  assert.match(t, /:red_circle: \*Andy Rozhylo\* — logged out of LinkedIn \(`auth`\)/);
  assert.doesNotMatch(t, /Peter|Maria/, "без нотатки — не вигадуємо статус");
  assert.match(t, /pushed to branch `chore\/linkedin-stats-x`/);
  assert.match(t, /cancelled or hit its time limit/);
});

test("a crash before the week was even resolved still posts, with a computed deadline", () => {
  const r = run({ ...CRASH_RUN, WEEK: "" });
  assert.equal(r.code, 0);
  assert.match(firstText(r), /\(this week\)/);
  assert.match(body(r), /Deadline: Monday .* Kyiv time/);
});

// ------------------------------------------------------------- оператор

test("a missing _operator mapping still posts the alert, without a ping, and says so", () => {
  const r = run({ ...REVIEW_RUN, SLACK_PEOPLE_JSON: JSON.stringify({ peter: "U02DEF", maria: "U04JKL" }) });
  assert.equal(r.code, 0);
  assert.equal(r.payloads.length, 1);
  assert.doesNotMatch(body(r), /<@/, "жодного пінгу — і автори як фолбек теж ні");
  assert.match(body(r), /NOT published/);
  assert.match(body(r), /No `_operator` id is mapped/);
  assert.match(r.stderr, /::warning::SLACK_PEOPLE_JSON has no _operator entry/);
});

test("an unset, malformed or non-member-id operator degrades the same way without echoing the map", () => {
  for (const raw of [undefined, '{"_operator": "U09OPS"', JSON.stringify({ _operator: "@sasha" }), '["U09OPS"]']) {
    const env = { ...CRASH_RUN };
    if (raw === undefined) env.SLACK_PEOPLE_JSON = "";
    else env.SLACK_PEOPLE_JSON = raw;
    const r = run(env);
    assert.equal(r.code, 0, `people=${raw}`);
    assert.doesNotMatch(body(r), /<@/, `people=${raw}`);
    assert.match(r.stderr, /::warning::SLACK_PEOPLE_JSON/);
    assert.doesNotMatch(r.stderr, /U09OPS|@sasha/, "значення мапи в лог не йде");
  }
});

// ------------------------------------------------------------- інші не-мерджі

test("a clean scrape whose auto-merge failed is still NOT published", () => {
  const r = run({ ...REVIEW_RUN, CLEAN: "1", NOTES: "", MAIN_UPDATED: "" });
  assert.match(firstText(r), /NOT published/);
  assert.match(firstText(r), /the automatic merge did not go through/);
  assert.match(body(r), new RegExp(`<@${OPERATOR}>`));
});

test("a truncated snapshot alone is named, not hidden", () => {
  const r = run({ ...REVIEW_RUN, NOTES: "", INVALID_JSON: "1" });
  assert.match(firstText(r), /cut off mid-write and was reverted \(`invalid-json`\)/);
});

test("every note code the workflow writes maps to human words", () => {
  const expected = {
    partial: "some posts or reactions not fully read",
    exit1: "scrape failed",
    exit137: "scrape failed",
    drift: "scrape failed",
    locked: "scrape failed",
    fs: "scrape failed",
    auth: "logged out of LinkedIn",
    nodata: "nothing collected",
    noweek: "nothing collected",
    "skipped-budget": "not reached, time budget spent",
    hardcap: "timed out",
    ratelimit: "rate-limited by LinkedIn",
  };
  for (const [code, words] of Object.entries(expected)) assert.equal(describe(code)[1], words, code);
  assert.equal(describe("banana")[1], "unexpected problem");
  assert.deepEqual(parseNotes(" peter:partial  maria:exit1 "), [
    { slug: "peter", code: "partial" }, { slug: "maria", code: "exit1" },
  ]);
});

test("two problems for one author collapse into one line", () => {
  const r = run({ ...REVIEW_RUN, NOTES: "maria:partial maria:noweek" });
  const lines = firstText(r).split("\n").filter((l) => l.includes("Maria Umen"));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^:red_circle: .*some posts or reactions not fully read; nothing collected \(`partial`, `noweek`\)/);
});

// ------------------------------------------------------------- дедлайн

test("the deadline is next Monday 00:00 UTC, printed in Kyiv time with a countdown", () => {
  const now = Date.parse("2026-09-16T10:00:00Z");
  assert.equal(deadlineFor("2026-09-14", now), "2026-09-21T00:00:00.000Z");
  const { payload } = buildWeeklyMessage({
    channel: CHANNEL, week: "2026-09-14", clean: "0", notes: "peter:partial maria:exit1",
    prUrl: PR, mainUpdated: "false", profiles: [], operator: OPERATOR, runLink: RUN_URL, now,
  });
  const text = JSON.stringify(payload);
  assert.match(text, /Deadline: Monday 21 Sept?, 03:00 Kyiv time\* \(in 5 days\) — that is when the next weekly run starts from main/);
  assert.match(text, /It must be merged before that, or this week is lost for good\./);
});

test("a deadline already in the past says so instead of counting backwards", () => {
  const now = Date.parse("2026-09-23T10:00:00Z");
  const { payload } = buildWeeklyMessage({
    channel: CHANNEL, week: "2026-09-14", clean: "0", notes: "maria:auth",
    prUrl: PR, mainUpdated: "false", profiles: [], operator: OPERATOR, runLink: RUN_URL, now,
  });
  const text = JSON.stringify(payload);
  assert.match(text, /deadline has already passed/);
  assert.doesNotMatch(text, /ago\)/);
});

// ------------------------------------------------------------- Slack не має фарбувати прогін

test("a missing token is a ::warning:: and exit 0, and nothing is sent", () => {
  const r = run({ ...REVIEW_RUN, SLACK_BOT_TOKEN: "" }, { dry: false });
  assert.equal(r.code, 0, "зелений тиждень не має ставати червоним через Slack");
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /::warning::SLACK_BOT_TOKEN not set — the weekly result was NOT posted to Slack/);
  assert.match(r.stderr, /It would have said: Week .* is NOT published/);
  assert.doesNotMatch(r.stderr, new RegExp(OPERATOR), "id оператора з секрету в лог не йде");
});

test("a missing channel is a ::warning:: too", () => {
  const r = run({ ...CLEAN_RUN, SLACK_CHANNEL_ID: "" }, { dry: false });
  assert.equal(r.code, 0);
  assert.match(r.stderr, /::warning::SLACK_CHANNEL_ID not set/);
});

test("the bot token never reaches stdout or stderr", () => {
  for (const env of [REVIEW_RUN, CLEAN_RUN, CRASH_RUN]) {
    const r = run(env);
    assert.doesNotMatch(r.stdout + r.stderr, /xoxb-/);
  }
  const r = run({ ...CRASH_RUN, SLACK_CHANNEL_ID: "" }, { dry: false });
  assert.doesNotMatch(r.stdout + r.stderr, /xoxb-/);
});

// ------------------------------------------------------------- мова і mrkdwn

test("nothing that reaches Slack or the log is written in Ukrainian", () => {
  for (const env of [REVIEW_RUN, CLEAN_RUN, CRASH_RUN]) {
    const r = run(env);
    assert.doesNotMatch(r.stdout + r.stderr, /[Ѐ-ӿ]/);
  }
});

test("names and codes are escaped before they reach mrkdwn", () => {
  const profiles = join(TMP, "evil.json");
  writeFileSync(profiles, JSON.stringify({ evil: { name: "A & <B>" } }));
  const r = run({ ...REVIEW_RUN, PROFILES_FILE: profiles, NOTES: "evil:<!channel>" });
  const t = firstText(r);
  assert.match(t, /A &amp; &lt;B&gt;/);
  assert.doesNotMatch(t, /<!channel>/);
});

test("operatorId accepts only a member id", () => {
  assert.equal(operatorId(JSON.stringify({ _operator: "U0FAKEOP01" })).id, "U0FAKEOP01");
  assert.equal(operatorId(JSON.stringify({ _operator: "@op" })).id, null);
  assert.equal(operatorId("").id, null);
});
