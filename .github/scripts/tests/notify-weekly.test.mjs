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

import {
  buildPagesDeployMessage, buildWeeklyMessage, databaseLine, describe, deadlineFor, operatorId, parseNotes, publishState,
} from "../notify-weekly.mjs";

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

const PAGE = "https://speedandfunction.github.io/LinkedInStatistic/";
// Так env приходить з job'а `notify`: needs.scrape.outputs.*, needs.*.result і
// needs.publish.outputs.* (deployed порожній, якщо deploy-pages не пройшов).
const CLEAN_RUN = {
  CLEAN: "1", NOTES: "", INVALID_JSON: "0", PR_URL: PR, BRANCH: `chore/linkedin-stats-${THIS_WEEK}`, MAIN_UPDATED: "true",
  SCRAPE_RESULT: "success", PUBLISH_RESULT: "success", DEPLOYED: "true", PAGE_URL: PAGE,
};
const REVIEW_RUN = {
  CLEAN: "0", NOTES: "peter:partial maria:exit1", INVALID_JSON: "0", PR_URL: PR, BRANCH: `chore/linkedin-stats-${THIS_WEEK}`, MAIN_UPDATED: "false",
  SCRAPE_RESULT: "failure", PUBLISH_RESULT: "skipped", DEPLOYED: "", PAGE_URL: "",
};
const CRASH_RUN = {
  CLEAN: "", NOTES: "", INVALID_JSON: "", PR_URL: "", BRANCH: "", MAIN_UPDATED: "",
  SCRAPE_RESULT: "failure", PUBLISH_RESULT: "skipped", DEPLOYED: "", PAGE_URL: "",
};
// Змерджений тиждень, у якого publish деплой НЕ підтвердив.
const MERGED_NOT_DEPLOYED = { ...CLEAN_RUN, PUBLISH_RESULT: "failure", DEPLOYED: "" };
const PAGES_OK = { NOTIFY_MODE: "pages-deploy", BUILD_RESULT: "success", DEPLOY_RESULT: "success", REFRESH_RESULT: "success", PAGE_URL: PAGE, GITHUB_ACTOR: "octo-operator" };

const body = (r) => JSON.stringify(r.payloads);
const firstText = (r) => r.payloads[0].blocks[0].text.text;

function assertNoAuthorPing(text) {
  for (const id of AUTHOR_IDS) assert.doesNotMatch(text, new RegExp(id), `автор ${id} не тегається ніколи`);
}

// ------------------------------------------------------------- три випадки

test("a clean, merged and deployed week posts one short 'collected and published' message with per-author status and no ping", () => {
  const r = run(CLEAN_RUN);
  assert.equal(r.code, 0);
  assert.equal(r.payloads.length, 1, "рівно одне повідомлення на прогін");
  const p = r.payloads[0];
  assert.equal(p.channel, CHANNEL);
  assert.match(firstText(r), new RegExp(`^:white_check_mark: \\*Week ${THIS_WEEK} collected and published\\* — the dashboards are up to date\\.`));
  assert.match(r.stderr, /: published\n/);
  assert.match(body(r), /Published to <https:\/\/speedandfunction\.github\.io\/LinkedInStatistic\/\|GitHub Pages>/);
  assert.match(body(r), /pull request #36> was merged automatically/);
  for (const name of ["Peter Ovchynnikov", "Andy Rozhylo", "Maria Umen"]) {
    assert.match(firstText(r), new RegExp(`:white_check_mark: \\*${name}\\* — collected`));
  }
  assert.doesNotMatch(body(r), /<@/, "у день, коли робити нічого, пінгувати нікого");
  assert.doesNotMatch(body(r), /!here|!channel|!everyone/);
  assert.doesNotMatch(body(r), /NOT published|NOT updated|Deadline|deadline|picker/);
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
  const r = run({ ...CRASH_RUN, NOTES: "andy:auth", BRANCH: "chore/linkedin-stats-x", SCRAPE_RESULT: "cancelled" });
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

// ------------------------------------------------------------- змерджено: що сталося з publish

test("merged + deployed + publish failure: data is LIVE, only the $post picker is stale — no ping, no deadline", () => {
  const r = run({ ...CLEAN_RUN, PUBLISH_RESULT: "failure", DEPLOYED: "true" });
  assert.equal(r.code, 0);
  assert.equal(r.payloads.length, 1);
  const text = body(r);
  assert.match(firstText(r), new RegExp(`^:large_yellow_circle: \\*Week ${THIS_WEEK} collected and published — the dashboards show the new data\\*, but the Grafana post picker refresh failed\\.`));
  assert.match(firstText(r), /:white_check_mark: \*Andy Rozhylo\* — collected/);
  assert.match(text, /`\$post` picker .* may not list this week's new posts yet/);
  assert.match(text, /Nothing is lost and there is no deadline/);
  assert.match(text, /Published to <https:\/\/speedandfunction\.github\.io/, "дані живі — кажемо, де");
  assert.match(r.payloads[0].text, /published; the Grafana post picker was not refreshed/);
  assert.doesNotMatch(text, /<@/, "нічого не горить — без пінгу");
  assert.doesNotMatch(text, /NOT updated|NOT published|Deadline: Monday|lost for good/);
  assert.match(r.stderr, /: published-picker-stale\n/);
});

test("merged + deployed + publish cancelled after the deploy: still live, the refresh 'did not finish'", () => {
  const r = run({ ...CLEAN_RUN, PUBLISH_RESULT: "cancelled", DEPLOYED: "true" });
  assert.match(firstText(r), /collected and published — the dashboards show the new data\*, but the Grafana post picker refresh did not finish\./);
  assert.doesNotMatch(body(r), /<@/);
});

test("merged + NOT deployed + publish failure: safe on main, dashboards NOT updated, ping, run pages-deploy, NO deadline", () => {
  const r = run(MERGED_NOT_DEPLOYED);
  assert.equal(r.code, 0);
  assert.equal(r.payloads.length, 1);
  const text = body(r);
  assert.match(firstText(r), new RegExp(`^<@${OPERATOR}> :warning: \\*Week ${THIS_WEEK} is collected and safe on main, but the dashboards were NOT updated\\* — the deploy to GitHub Pages failed\\.`));
  assert.match(text, /Run the \*pages-deploy\* workflow on `main`/);
  assert.match(text, /No data-loss deadline here\* — the week is already merged into main/);
  // Головна різниця з випадком «waiting for review»: тут жорсткого дедлайну НЕМАЄ.
  assert.doesNotMatch(text, /Deadline: Monday|lost for good|deadline has already passed/);
  assert.doesNotMatch(text, /collected and published|up to date|Published to/, "не задеплоєно — «published» не кажемо");
  assert.match(text, /actions\/runs\/123456\|workflow run>/);
  assert.match(r.payloads[0].text, new RegExp(`^<@${OPERATOR}> LinkedIn week .* is merged but NOT published — run pages-deploy \\(no data-loss deadline\\)$`));
  assert.doesNotMatch(r.payloads[0].text, /https?:/);
  assertNoAuthorPing(text);
  assert.match(r.stderr, /: merged-not-deployed\n/);
});

test("merged + NOT deployed + publish cancelled: same alert, says it was cancelled", () => {
  const r = run({ ...MERGED_NOT_DEPLOYED, PUBLISH_RESULT: "cancelled" });
  assert.match(firstText(r), new RegExp(`^<@${OPERATOR}> :warning: .*dashboards were NOT updated\\* — the publish job was cancelled before the deploy finished\\.`));
  assert.match(body(r), /No data-loss deadline here/);
  assert.doesNotMatch(body(r), /Deadline: Monday/);
});

test("publish success WITHOUT the deployed marker is not trusted as published", () => {
  const r = run({ ...CLEAN_RUN, DEPLOYED: "" });
  assert.match(firstText(r), /dashboards were NOT updated\* — the publish job did not confirm the deploy\./);
  assert.match(body(r), new RegExp(`<@${OPERATOR}>`));
  assert.doesNotMatch(body(r), /collected and published/);
});

test("merged but publish SKIPPED is reported honestly, never as published", () => {
  const r = run({ ...CLEAN_RUN, PUBLISH_RESULT: "skipped", DEPLOYED: "", PAGE_URL: "" });
  const text = body(r);
  assert.match(firstText(r), new RegExp(`^<@${OPERATOR}> :warning: \\*Week ${THIS_WEEK} is collected and safe on main, but the dashboards were NOT updated\\* — the publish job did not run \\(result: \`skipped\`\\), although it should after a merge\\.`));
  assert.match(text, /pages-deploy/);
  assert.match(text, /No data-loss deadline here/);
  assert.doesNotMatch(text, /collected and published|Deadline: Monday/);
  assert.match(r.stderr, /: merged-publish-skipped\n/);
});

test("a missing publish result (unknown) is treated like skipped, not as published", () => {
  const r = run({ ...CLEAN_RUN, PUBLISH_RESULT: "", DEPLOYED: "" });
  assert.match(firstText(r), /did not run \(result: `unknown`\)/);
});

test("merged-but-not-deployed without an operator mapping still posts and says nobody was pinged", () => {
  const r = run({ ...MERGED_NOT_DEPLOYED, SLACK_PEOPLE_JSON: JSON.stringify({ peter: "U02DEF" }) });
  assert.doesNotMatch(body(r), /<@/);
  assert.match(body(r), /No `_operator` id is mapped/);
});

test("publishState covers every publish result x deployed combination", () => {
  const cases = [
    ["success", "true", "published"],
    ["failure", "true", "picker-stale"],
    ["cancelled", "true", "picker-stale"],
    ["failure", "", "not-deployed"],
    ["cancelled", "", "not-deployed"],
    ["success", "", "not-deployed"],
    ["failure", "false", "not-deployed"],
    ["skipped", "", "skipped"],
    ["", "", "skipped"],
  ];
  for (const [result, deployed, want] of cases) assert.equal(publishState(result, deployed), want, `${result}/${deployed}`);
});

test("an unmerged week ignores publish outputs entirely and keeps its hard deadline", () => {
  // Навіть якщо хтось колись задеплоїть старий main — непомерджений тиждень лишається під дедлайном.
  const r = run({ ...REVIEW_RUN, PUBLISH_RESULT: "success", DEPLOYED: "true" });
  assert.match(firstText(r), /is NOT published — it is waiting for review/);
  assert.match(body(r), /Deadline: Monday/);
  assert.doesNotMatch(body(r), /No data-loss deadline/);
});

// ------------------------------------------------------------- ручний pages-deploy

test("pages-deploy success posts one closing line without a ping", () => {
  const r = run(PAGES_OK);
  assert.equal(r.code, 0);
  assert.equal(r.payloads.length, 1);
  const text = body(r);
  assert.match(firstText(r), /^:white_check_mark: \*Manual pages-deploy succeeded\* — the dashboards now show everything merged into main\.$/);
  assert.match(text, /Triggered by `octo-operator`/);
  assert.match(text, /GitHub Pages>/);
  assert.match(text, /actions\/runs\/123456\|run log>/);
  assert.doesNotMatch(text, /<@|FAILED|Deadline/);
  assert.match(r.stderr, /pages-deploy result: pages-deployed/);
  assert.doesNotMatch(r.stderr, /profiles/, "у цьому режимі profiles.json не читаємо");
});

test("pages-deploy failure pings the operator with the run link and says no data is lost", () => {
  const r = run({ ...PAGES_OK, DEPLOY_RESULT: "failure", REFRESH_RESULT: "skipped", PAGE_URL: "" });
  assert.equal(r.code, 0);
  assert.equal(r.payloads.length, 1);
  const text = body(r);
  assert.match(firstText(r), new RegExp(`^<@${OPERATOR}> :x: \\*Manual pages-deploy FAILED — the dashboards were NOT updated\\* \\(the deploy to GitHub Pages failed\\)\\.`));
  assert.match(text, /a failed deploy loses no data/);
  assert.match(text, new RegExp(`<${RUN_URL.replace(/[./]/g, "\\$&")}\\|workflow run>`));
  assert.match(r.payloads[0].text, new RegExp(`^<@${OPERATOR}> LinkedIn manual pages-deploy FAILED`));
  assert.doesNotMatch(text, /succeeded|Deadline: Monday/);
  assertNoAuthorPing(text);
  assert.match(r.stderr, /pages-deploy result: pages-failed/);
});

test("pages-deploy build failure and deploy cancellation are both failures, named correctly", () => {
  const build = run({ ...PAGES_OK, BUILD_RESULT: "failure", DEPLOY_RESULT: "skipped", REFRESH_RESULT: "skipped" });
  assert.match(firstText(build), /FAILED — the dashboards were NOT updated\* \(the build job failed\)/);
  assert.match(body(build), new RegExp(`<@${OPERATOR}>`));
  const cancelled = run({ ...PAGES_OK, DEPLOY_RESULT: "cancelled", REFRESH_RESULT: "skipped" });
  assert.match(firstText(cancelled), /\(the deploy job was cancelled\)/);
  assert.match(body(cancelled), new RegExp(`<@${OPERATOR}>`));
});

test("pages-deploy with only the refresh failing is live data and a stale picker — no ping", () => {
  const r = run({ ...PAGES_OK, REFRESH_RESULT: "failure" });
  assert.match(firstText(r), /^:large_yellow_circle: \*Manual pages-deploy published the data\*, but the Grafana post picker refresh failed\./);
  assert.match(firstText(r), /Nothing is lost and there is no deadline/);
  assert.doesNotMatch(body(r), /<@|FAILED/);
  assert.match(r.stderr, /pages-deploy result: pages-picker-stale/);
});

test("pages-deploy Slack problems never change the exit code, and name the right result", () => {
  const r = run({ ...PAGES_OK, DEPLOY_RESULT: "failure", SLACK_BOT_TOKEN: "" }, { dry: false });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /::warning::SLACK_BOT_TOKEN not set — the pages-deploy result was NOT posted to Slack\. It would have said: manual pages-deploy FAILED/);
  assert.doesNotMatch(r.stderr, new RegExp(OPERATOR));
});

test("the pages-deploy builder escapes the actor", () => {
  const { payload } = buildPagesDeployMessage({
    channel: CHANNEL, buildResult: "success", deployResult: "success", refreshResult: "success",
    operator: OPERATOR, runLink: RUN_URL, actor: "<!channel>",
  });
  assert.doesNotMatch(JSON.stringify(payload), /<!channel>/);
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
    "reactors-short": "a reaction list was incomplete, it is re-read next run",
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
  // Нотатки одного автора зшиваються в один рядок, тож жодна фраза не сміє
  // починатися словом, яке суперечитиме сусідній: `reactors-short` разом із
  // `nodata` давало «collected …; nothing collected».
  for (const [code, words] of Object.entries(expected)) {
    assert.ok(!/^collected\b/i.test(words), `${code}: фраза не має починатися з "collected"`);
  }
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
  for (const env of [REVIEW_RUN, CLEAN_RUN, CRASH_RUN, MERGED_NOT_DEPLOYED, PAGES_OK, { ...PAGES_OK, DEPLOY_RESULT: "failure" }]) {
    const r = run(env);
    assert.doesNotMatch(r.stdout + r.stderr, /xoxb-/);
  }
  const r = run({ ...CRASH_RUN, SLACK_CHANNEL_ID: "" }, { dry: false });
  assert.doesNotMatch(r.stdout + r.stderr, /xoxb-/);
});

// ------------------------------------------------------------- мова і mrkdwn

test("nothing that reaches Slack or the log is written in Ukrainian", () => {
  const variants = [
    REVIEW_RUN, CLEAN_RUN, CRASH_RUN, MERGED_NOT_DEPLOYED,
    { ...CLEAN_RUN, PUBLISH_RESULT: "failure" }, { ...CLEAN_RUN, PUBLISH_RESULT: "skipped", DEPLOYED: "" },
    PAGES_OK, { ...PAGES_OK, DEPLOY_RESULT: "failure" }, { ...PAGES_OK, REFRESH_RESULT: "failure" },
  ];
  for (const env of variants) {
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

// ------------------------------------------------------------- база даних (dual-write)

// Так DB_* приходять з воркфлоу: needs.db-sync.outputs.* і needs.db-backup.outputs.*.
const DB_OK = { DB_SYNC: "ok", DB_PARITY: "ok", DB_BACKUP: "ok", DB_BACKUP_EXPECTED: "true" };
const SYNC_STATES = ["ok", "skipped-no-secret", "failed:connect", "failed:import", "failed:deps", "timeout:import", "", "banana"];
const PARITY_STATES = ["ok", "differs", "incomplete", "error", "timeout", "", "banana"];
const BACKUP_STATES = ["ok", "skipped-no-secret", "failed:push", "failed:dump", "failed:client", "timeout:dump", "", "banana"];
const dbBlocks = (payload) => payload.blocks.filter((b) => /Database \(dual-write stage\)/.test(JSON.stringify(b)));

const weeklyInput = (db, extra = {}) => ({
  channel: CHANNEL, week: "2026-09-14", clean: "1", notes: "", prUrl: PR, mainUpdated: "true",
  scrapeResult: "success", publishResult: "success", deployed: "true", pageUrl: PAGE,
  profiles: [{ slug: "peter", name: "Peter Ovchynnikov" }], operator: OPERATOR, runLink: RUN_URL,
  now: Date.parse("2026-09-14T03:00:00Z"), db, ...extra,
});
const pagesInput = (db, extra = {}) => ({
  channel: CHANNEL, buildResult: "success", deployResult: "success", refreshResult: "success",
  pageUrl: PAGE, operator: OPERATOR, runLink: RUN_URL, actor: "octo-operator", db, ...extra,
});

test("an all-good database state changes NOTHING about the verdict — it only appends one grey soak confirmation, with no ping and no warning", () => {
  const good = { sync: "ok", parity: "ok", backup: "ok", backupExpected: true };
  const goodNoBackup = { sync: "ok", parity: "ok", backup: "", backupExpected: false };
  // Порівнюємо з повідомленням БЕЗ етапу бази: усе те саме плюс один context у кінці.
  const sameButConfirmed = (built, bare, db) => {
    const id = JSON.stringify(db);
    assert.equal(built.kind, bare.kind, id);
    assert.equal(built.payload.text, bare.payload.text, "fallback-текст пуша не змінюється");
    assert.equal(built.database, undefined, "жодного ::warning::");
    assert.deepEqual(built.payload.blocks.slice(0, -1), bare.payload.blocks, id);
    const last = built.payload.blocks.at(-1);
    assert.equal(last.type, "context", "сірий рядок, а не section");
    assert.equal(last.elements[0].text, db.backupExpected
      ? ":white_check_mark: Database (dual-write soak): synced · parity byte-identical · backup pushed"
      : ":white_check_mark: Database (dual-write soak): synced · parity byte-identical · backup not requested for this run");
    assert.equal(built.summary, `${bare.summary}; database (dual-write): synced, parity byte-identical, ${db.backupExpected ? "backup pushed" : "backup not requested for this run"}`);
    assert.doesNotMatch(JSON.stringify(last), /<@|<!/);
  };
  const weeklyVariants = [
    {}, { publishResult: "failure" }, { publishResult: "failure", deployed: "" }, { publishResult: "skipped", deployed: "" },
  ];
  for (const extra of weeklyVariants) {
    for (const db of [good, goodNoBackup]) {
      sameButConfirmed(buildWeeklyMessage(weeklyInput(db, extra)), buildWeeklyMessage(weeklyInput(undefined, extra)), db);
    }
  }
  for (const extra of [{}, { refreshResult: "failure" }, { deployResult: "failure" }, { buildResult: "failure", deployResult: "skipped" }]) {
    for (const db of [good, goodNoBackup]) {
      sameButConfirmed(buildPagesDeployMessage(pagesInput(db, extra)), buildPagesDeployMessage(pagesInput(undefined, extra)), db);
    }
  }
  const line = databaseLine(good);
  assert.deepEqual([line.problems, line.actions, line.text, line.plain], [[], [], null, null]);
  // Без етапу бази (локальний dry-run) — справді нічого.
  assert.deepEqual(databaseLine(undefined), { problems: [], actions: [], text: null, plain: null });

  // І наскрізно, через env, як у CI.
  const r = run({ ...CLEAN_RUN, ...DB_OK });
  const bare = run(CLEAN_RUN);
  assert.deepEqual(r.payloads[0].blocks.slice(0, -1), bare.payloads[0].blocks);
  assert.match(r.payloads[0].blocks.at(-1).elements[0].text, /synced · parity byte-identical · backup pushed$/);
  assert.doesNotMatch(r.stderr, /::warning::/);
  assert.doesNotMatch(bare.stdout + bare.stderr, /[Dd]atabase|dual-write/);
  const pr = run({ ...PAGES_OK, DB_SYNC: "ok", DB_PARITY: "ok", DB_BACKUP: "", DB_BACKUP_EXPECTED: "false" });
  assert.deepEqual(pr.payloads[0].blocks.slice(0, -1), run(PAGES_OK).payloads[0].blocks);
  assert.match(pr.payloads[0].blocks.at(-1).elements[0].text, /backup not requested for this run$/);
});

test("an unreachable database names the likeliest cause and the action: a paused Supabase project, resume, re-run pages-deploy", () => {
  const say = (db) => databaseLine({ sync: "ok", parity: "ok", backup: "ok", backupExpected: true, ...db });
  const PAUSED = /Most likely the Supabase project is \*paused\* \(the free tier pauses after 7 idle days\) — resume it in the Supabase dashboard, then run `pages-deploy` to re-sync; the import is idempotent/;
  for (const sync of ["failed:connect", "timeout:import"]) {
    const line = say({ sync });
    assert.match(line.text, PAUSED, sync);
    assert.match(line.text, /\n:point_right: /, sync);
    assert.match(line.plain, /What to do: Most likely the Supabase project is paused/, sync);
    assert.doesNotMatch(line.plain, /[*`]/, sync);
  }
  assert.match(say({ sync: "failed:connect" }).text, /the sync \*FAILED\* \(could not connect to the database\)/);
  assert.match(say({ sync: "failed:connect" }).text, /the import is idempotent\. If the `db-sync` job shows `password authentication failed` or `does not exist` instead of a timeout, the `LI_SYNC_DATABASE_URL` secret is wrong\.\n/);
  assert.doesNotMatch(say({ sync: "timeout:import" }).text, /secret is wrong/);
  // Імпорт, що ПІДКЛЮЧИВСЯ і відкотився, — не пауза: радимо дивитись підказки.
  const rolledBack = say({ sync: "failed:import" });
  assert.doesNotMatch(rolledBack.text, /paused/);
  assert.match(rolledBack.text, /connected and then rolled back.*hints in the `db-sync` job/);
  // Parity, що не відпрацювала: перезапуск + тиждень не рахується.
  for (const parity of ["error", "timeout"]) {
    const line = say({ parity });
    assert.match(line.text, /Run `pages-deploy` to re-sync and re-check .* project is not paused\. \*This week does not count as verified\*/, parity);
  }
  // Де дії немає — немає й рядка з нею.
  for (const db of [{ sync: "skipped-no-secret" }, { sync: "failed:deps" }, { parity: "differs" }, { backup: "failed:push" }, { sync: "" }]) {
    assert.doesNotMatch(say(db).text, /:point_right:/, JSON.stringify(db));
    assert.deepEqual(say(db).actions, [], JSON.stringify(db));
  }
  // Наскрізно: у Slack і в ::warning:: логу.
  const r = run({ ...CLEAN_RUN, DB_SYNC: "failed:connect", DB_PARITY: "", DB_BACKUP: "", DB_BACKUP_EXPECTED: "true" });
  assert.match(r.payloads[0].blocks[1].text.text, PAUSED);
  assert.match(r.stderr, /::warning::database \(dual-write\): the sync FAILED \(could not connect to the database\).*What to do: Most likely the Supabase project is paused/);
  assert.doesNotMatch(body(r), /<@/);
});

test("every combination of sync / parity / backup outcome: silent only when all three held, otherwise exactly the broken ones are named", () => {
  let combos = 0;
  for (const backupExpected of [true, false]) {
    for (const sync of SYNC_STATES) for (const parity of PARITY_STATES) for (const backup of BACKUP_STATES) {
      combos += 1;
      const id = JSON.stringify({ sync, parity, backup, backupExpected });
      const line = databaseLine({ sync, parity, backup, backupExpected });
      const allGood = sync === "ok" && parity === "ok" && (!backupExpected || backup === "ok");
      if (allGood) { assert.equal(line.text, null, id); continue; }

      assert.ok(line.text, `мовчати не можна: ${id}`);
      assert.match(line.text, /^:large_orange_diamond: \*Database \(dual-write stage\):\*/, id);
      assert.match(line.text, /The week itself is not affected\* — the JSON in git is still the source of truth/, id);
      assert.doesNotMatch(line.text, /<@|<!/, `без пінгу: ${id}`);
      assert.doesNotMatch(line.plain, /[*`]/, id);

      if (sync !== "ok") {
        // Parity і backup від sync залежать: окремо їх не перелічуємо.
        assert.equal(line.problems.length, 1, id);
        assert.match(line.text, /the sync /, id);
        assert.match(line.text, backupExpected
          ? /so the parity check and the backup did not run either/
          : /so the parity check did not run either/, id);
        if (!backupExpected) assert.doesNotMatch(line.text, /backup/, id);
      } else {
        assert.doesNotMatch(line.text, /the sync /, id);
        assert.equal(/the parity check/.test(line.text), parity !== "ok", id);
        assert.equal(/the backup/.test(line.text), backupExpected && backup !== "ok", id);
        assert.equal(line.problems.length, (parity !== "ok" ? 1 : 0) + (backupExpected && backup !== "ok" ? 1 : 0), id);
      }

      // Те саме — у готових повідомленнях обох режимів: рівно один рядок бази,
      // одразу під головним блоком, і вердикт про тиждень не змінюється.
      for (const [built, bare] of [
        [buildWeeklyMessage(weeklyInput({ sync, parity, backup, backupExpected })), buildWeeklyMessage(weeklyInput(undefined))],
        [buildPagesDeployMessage(pagesInput({ sync, parity, backup, backupExpected })), buildPagesDeployMessage(pagesInput(undefined))],
      ]) {
        assert.equal(dbBlocks(built.payload).length, 1, id);
        assert.equal(built.payload.blocks[1].type, "section", "section, а не сірий context");
        assert.equal(built.payload.blocks[1].text.text, line.text, id);
        assert.equal(built.kind, bare.kind, "база не змінює вердикт про тиждень");
        assert.deepEqual(built.payload.blocks[0], bare.payload.blocks[0], id);
        assert.equal(built.payload.blocks.length, bare.payload.blocks.length + 1, id);
        assert.match(built.payload.text, /database sync needs a look \(the week is fine\)$/, id);
        assert.match(built.summary, /; database \(dual-write\): /, id);
        assert.doesNotMatch(JSON.stringify(built.payload), /<@/, "день без дій лишається без пінгу");
      }
    }
  }
  assert.equal(combos, 2 * SYNC_STATES.length * PARITY_STATES.length * BACKUP_STATES.length);
});

test("each database outcome is named in plain English", () => {
  const say = (db) => databaseLine({ sync: "ok", parity: "ok", backup: "ok", backupExpected: true, ...db }).text;
  assert.match(say({ sync: "skipped-no-secret" }), /the sync was \*skipped\* — the `LI_SYNC_DATABASE_URL` secret is not set, so the parity check and the backup did not run either\./);
  assert.match(say({ sync: "failed:import" }), /the sync \*FAILED\* \(the import\)/);
  assert.match(say({ sync: "failed:deps" }), /the sync \*FAILED\* \(installing the db\/ dependencies\)/);
  assert.match(say({ sync: "timeout:import" }), /the sync \*timed out\* \(the import\) — the database did not answer in time/);
  assert.match(say({ sync: "" }), /the sync \*did not run or did not finish\*/);
  assert.match(say({ parity: "differs" }), /the parity check found a \*DIFFERENCE\* between the database and the JSON build\.\n/);
  assert.match(say({ parity: "incomplete" }), /the parity check was \*INCOMPLETE\* — it found no difference, but it compared fewer feeds than `main` publishes/);
  assert.match(say({ parity: "incomplete" }), /:point_right: Compare the author folders under `dashboards\/li-stats\/` with `profiles\.json`.*\*This week does not count as verified\*/);
  assert.match(say({ parity: "error" }), /the parity check \*could not be completed\*/);
  assert.match(say({ parity: "timeout" }), /the parity check \*timed out\*/);
  assert.match(say({ parity: "" }), /the parity check \*did not run\*/);
  assert.match(say({ backup: "skipped-no-secret" }), /the backup was \*skipped\* — `LI_BACKUP_DATABASE_URL` and\/or `LI_BACKUP_DEPLOY_KEY` is not set/);
  assert.match(say({ backup: "failed:push" }), /the backup \*FAILED\* \(pushing to the backup repository\)/);
  assert.match(say({ backup: "failed:client" }), /the backup \*FAILED\* \(installing the PostgreSQL 17 client\)/);
  assert.match(say({ backup: "" }), /the backup \*did not run or did not finish\*/);
  assert.match(say({ parity: "differs", backup: "failed:dump" }), /found a \*DIFFERENCE\* .*; the backup \*FAILED\* \(pg_dump\)\./);
  // Невідомий стан чи фаза з воркфлоу — це дані: екрануються і не губляться.
  assert.match(say({ sync: "failed:<!channel>" }), /the sync \*FAILED\* \(`&lt;!channel&gt;`\)/);
  assert.match(say({ parity: "<!here>" }), /unexpected state \(`&lt;!here&gt;`\)/);
});

test("an unmerged or crashed week says nothing about the database — the sync only ever runs from main after a merge", () => {
  const dead = { DB_SYNC: "", DB_PARITY: "", DB_BACKUP: "", DB_BACKUP_EXPECTED: "true" };
  for (const env of [REVIEW_RUN, CRASH_RUN]) {
    const r = run({ ...env, ...dead });
    assert.deepEqual(r.payloads, run(env).payloads);
    assert.doesNotMatch(r.stdout + r.stderr, /[Dd]atabase|dual-write/);
  }
});

test("a merged week whose db jobs wrote nothing is 'did not run', never silence — empty is unknown, not fine", () => {
  const r = run({ ...CLEAN_RUN, DB_SYNC: "", DB_PARITY: "", DB_BACKUP: "", DB_BACKUP_EXPECTED: "true" });
  assert.equal(r.code, 0);
  assert.equal(r.payloads.length, 1, "усе ще рівно одне повідомлення на прогін");
  assert.match(firstText(r), /collected and published/, "вердикт про тиждень не змінюється");
  const text = r.payloads[0].blocks[1].text.text;
  assert.match(text, /the sync \*did not run or did not finish\*, so the parity check and the backup did not run either/);
  assert.match(r.stderr, /::warning::database \(dual-write\): the sync did not run or did not finish/);
  assert.match(r.stderr, /: published\n/);
  assert.doesNotMatch(body(r), /<@/);
});

test("a parity difference shows up end to end: weekly (also when the deploy failed) and pages-deploy, with a ::warning:: and no extra ping", () => {
  const diff = { DB_SYNC: "ok", DB_PARITY: "differs", DB_BACKUP: "ok", DB_BACKUP_EXPECTED: "true" };
  const weekly = run({ ...CLEAN_RUN, ...diff });
  assert.match(weekly.payloads[0].blocks[1].text.text, /parity check found a \*DIFFERENCE\*/);
  assert.match(weekly.stderr, /::warning::database \(dual-write\): the parity check found a DIFFERENCE/);
  assert.doesNotMatch(body(weekly), /<@/);

  // Деплой упав — оператора пінгують ЗА ДЕПЛОЙ, рядок бази лишається окремим.
  const notDeployed = run({ ...MERGED_NOT_DEPLOYED, ...diff });
  assert.match(firstText(notDeployed), new RegExp(`^<@${OPERATOR}> :warning: .*dashboards were NOT updated`));
  assert.match(notDeployed.payloads[0].blocks[1].text.text, /Database \(dual-write stage\)/);
  assert.equal((body(notDeployed).match(/<@/g) || []).length, 2, "пінг лише в головному блоці та fallback-тексті, як і без бази");

  // pages-deploy без галочки backup: про бекап ані слова.
  const pages = run({ ...PAGES_OK, DB_SYNC: "ok", DB_PARITY: "differs", DB_BACKUP: "", DB_BACKUP_EXPECTED: "false" });
  assert.match(firstText(pages), /Manual pages-deploy succeeded/);
  assert.match(pages.payloads[0].blocks[1].text.text, /parity check found a \*DIFFERENCE\*/);
  assert.doesNotMatch(pages.payloads[0].blocks[1].text.text, /backup/);
  const pagesSkipped = run({ ...PAGES_OK, DEPLOY_RESULT: "failure", DB_SYNC: "skipped-no-secret", DB_PARITY: "", DB_BACKUP: "", DB_BACKUP_EXPECTED: "false" });
  assert.match(pagesSkipped.payloads[0].blocks[1].text.text, /the sync was \*skipped\* — the `LI_SYNC_DATABASE_URL` secret is not set, so the parity check did not run either/);
});

test("the database line is English-only and survives a missing Slack token as a ::warning::", () => {
  const broken = { DB_SYNC: "failed:import", DB_PARITY: "", DB_BACKUP: "", DB_BACKUP_EXPECTED: "true" };
  const r = run({ ...CLEAN_RUN, ...broken, SLACK_BOT_TOKEN: "" }, { dry: false });
  assert.equal(r.code, 0);
  assert.match(r.stderr, /::warning::database \(dual-write\): the sync FAILED \(the import\)/);
  assert.match(r.stderr, /It would have said: Week .* collected and published; database \(dual-write\): the sync FAILED/);
  for (const env of [{ ...CLEAN_RUN, ...broken }, { ...PAGES_OK, ...broken }]) {
    const out = run(env);
    assert.doesNotMatch(out.stdout + out.stderr, /[Ѐ-ӿ]/);
  }
});
