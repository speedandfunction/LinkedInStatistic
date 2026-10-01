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

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildPagesDeployMessage, buildWeeklyMessage, dashboardsState, databaseLine, databaseUnreachable, describe, deadlineFor, operatorId, parseNotes, publishState,
} from "../notify-weekly.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(HERE, "..", "notify-weekly.mjs");
const TMP = mkdtempSync(join(tmpdir(), "notify-weekly-"));
// Прибираємо за собою: інакше кожен прогін лишає в $TMPDIR ще одну теку.
after(() => rmSync(TMP, { recursive: true, force: true }));

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
// Так DB_* приходять у CI, коли з базою все гаразд. Без них нотифаєр за дашборди
// НЕ ручається (див. тест про «жодної DB_* змінної»), тож «up to date» перевіряємо з ними.
const DB_OK = { DB_SYNC: "ok", DB_PARITY: "ok", DB_BACKUP: "ok", DB_BACKUP_EXPECTED: "true" };
const PAGES_OK = { NOTIFY_MODE: "pages-deploy", BUILD_RESULT: "success", DEPLOY_RESULT: "success", REFRESH_RESULT: "success", PAGE_URL: PAGE, GITHUB_ACTOR: "octo-operator" };

const body = (r) => JSON.stringify(r.payloads);
const firstText = (r) => r.payloads[0].blocks[0].text.text;

function assertNoAuthorPing(text) {
  for (const id of AUTHOR_IDS) assert.doesNotMatch(text, new RegExp(id), `автор ${id} не тегається ніколи`);
}

// ------------------------------------------------------------- три випадки

test("a clean, merged and deployed week posts one short 'collected and published' message with per-author status and no ping", () => {
  const r = run({ ...CLEAN_RUN, ...DB_OK });
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
  const r = run({ ...CLEAN_RUN, ...DB_OK, PUBLISH_RESULT: "failure", DEPLOYED: "true" });
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
  const r = run({ ...CLEAN_RUN, ...DB_OK, PUBLISH_RESULT: "cancelled", DEPLOYED: "true" });
  assert.match(firstText(r), /collected and published — the dashboards show the new data\*, but the Grafana post picker refresh did not finish\./);
  assert.doesNotMatch(body(r), /<@/);
});

// Відколи Grafana читає базу, провал деплою Pages — це «не опубліковано на Pages»
// (старі публічний фід і пікер $post), а НЕ «дашборди не оновлені»: про дашборди
// вирішує sync (тести класу (а) нижче). Тому заголовок більше не згадує дашборди.
test("merged + NOT deployed + publish failure: safe on main, NOT published to Pages, ping, run pages-deploy, NO deadline", () => {
  const r = run(MERGED_NOT_DEPLOYED);
  assert.equal(r.code, 0);
  assert.equal(r.payloads.length, 1);
  const text = body(r);
  assert.match(firstText(r), new RegExp(`^<@${OPERATOR}> :warning: \\*Week ${THIS_WEEK} is collected and safe on main, but it was NOT published to GitHub Pages\\* — the deploy to GitHub Pages failed\\.`));
  assert.match(text, /Run the \*pages-deploy\* workflow on `main`/);
  assert.match(text, /No data-loss deadline here\* — the week is already merged into main/);
  assert.match(text, /Until pages-deploy succeeds, the public JSON feed on Pages and the Grafana `\$post` picker stay on the previous publish\./);
  assert.doesNotMatch(text, /dashboards were NOT updated|dashboards keep showing/, "деплой Pages дашбордів не годує — про них тут не брешемо");
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
  assert.match(firstText(r), new RegExp(`^<@${OPERATOR}> :warning: .*NOT published to GitHub Pages\\* — the publish job was cancelled before the deploy finished\\.`));
  assert.match(body(r), /No data-loss deadline here/);
  assert.doesNotMatch(body(r), /Deadline: Monday/);
});

test("publish success WITHOUT the deployed marker is not trusted as published", () => {
  const r = run({ ...CLEAN_RUN, DEPLOYED: "" });
  assert.match(firstText(r), /NOT published to GitHub Pages\* — the publish job did not confirm the deploy\./);
  assert.match(body(r), new RegExp(`<@${OPERATOR}>`));
  assert.doesNotMatch(body(r), /collected and published/);
});

test("merged but publish SKIPPED is reported honestly, never as published", () => {
  const r = run({ ...CLEAN_RUN, PUBLISH_RESULT: "skipped", DEPLOYED: "", PAGE_URL: "" });
  const text = body(r);
  assert.match(firstText(r), new RegExp(`^<@${OPERATOR}> :warning: \\*Week ${THIS_WEEK} is collected and safe on main, but it was NOT published to GitHub Pages\\* — the publish job did not run \\(result: \`skipped\`\\), although it should after a merge\\.`));
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
  const r = run({ ...PAGES_OK, ...DB_OK });
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
  // Той самий зсув, що й у щотижневому 1c: провал деплою — це «на Pages нічого
  // не опубліковано», а не «дашборди не оновлені» (їх годує db-sync цього ж прогону).
  assert.match(firstText(r), new RegExp(`^<@${OPERATOR}> :x: \\*Manual pages-deploy FAILED — nothing was published to GitHub Pages\\* \\(the deploy to GitHub Pages failed\\)\\.`));
  assert.match(text, /a failed deploy loses no data/);
  assert.match(text, /the public JSON feed on Pages and the Grafana `\$post` picker stay on the previous publish/);
  assert.doesNotMatch(text, /dashboards were NOT updated|dashboards just keep showing/);
  assert.match(text, new RegExp(`<${RUN_URL.replace(/[./]/g, "\\$&")}\\|workflow run>`));
  assert.match(r.payloads[0].text, new RegExp(`^<@${OPERATOR}> LinkedIn manual pages-deploy FAILED`));
  assert.doesNotMatch(text, /succeeded|Deadline: Monday/);
  assertNoAuthorPing(text);
  assert.match(r.stderr, /pages-deploy result: pages-failed/);
});

test("pages-deploy build failure and deploy cancellation are both failures, named correctly", () => {
  const build = run({ ...PAGES_OK, BUILD_RESULT: "failure", DEPLOY_RESULT: "skipped", REFRESH_RESULT: "skipped" });
  assert.match(firstText(build), /FAILED — nothing was published to GitHub Pages\* \(the build job failed\)/);
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
//
// Grafana читає Postgres (dash.feed_*), а не JSON на Pages. Тому наслідки діляться
// на два класи, і саме їх тут стережемо:
//   (а) sync не "ok" (зокрема порожньо) або parity не "ok" — ДАШБОРДИ зачеплені:
//       заголовок не має права казати «up to date», оператора пінгують, рядок бази
//       називає причину, дію і те, що тиждень у git цілий;
//   (б) sync і parity "ok", не вдався лише бекап — як і раніше: помаранчевий
//       рядок, без пінгу, вердикт про тиждень не змінюється.
const SYNC_STATES = ["ok", "skipped-no-secret", "failed:connect", "failed:import", "failed:deps", "timeout:import", "", "banana"];
const PARITY_STATES = ["ok", "differs", "incomplete", "error", "timeout", "", "banana"];
const BACKUP_STATES = ["ok", "skipped-no-secret", "failed:push", "failed:dump", "failed:client", "timeout:dump", "", "banana"];
const dbBlocks = (payload) => payload.blocks.filter((b) => /Database \(dual-write stage\)/.test(JSON.stringify(b)));
const pings = (payload) => (JSON.stringify(payload).match(/<@/g) || []).length;
// Те, чого заголовок класу (а) казати не має права — в обох режимах.
const CLAIMS_FRESH = /up to date|collected and published|show the new data|now show everything|pages-deploy succeeded/;
// Без жодної DB_* змінної стан бази НЕВІДОМИЙ: повідомлення каже це сірим рядком
// і не має права ручатись за дашборди жодним із цих формулювань.
const UNKNOWN_DB = ":grey_question: No database result reached this message (no `DB_*` inputs), so it says nothing about the Grafana dashboards — they read the database, not GitHub Pages.";
const VOUCHES_FOR_DASHBOARDS = /dashboards are up to date|dashboards show the new data|dashboards now show|they already show this week|they are current|merged and live|dashboards published|dashboards are (?:fine|not affected)/;

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
// Усі стани publish змердженого тижня і всі стани ручного pages-deploy.
const WEEKLY_VARIANTS = [
  {}, { publishResult: "failure" }, { publishResult: "failure", deployed: "" }, { publishResult: "skipped", deployed: "" },
];
const PAGES_VARIANTS = [{}, { refreshResult: "failure" }, { deployResult: "failure" }, { buildResult: "failure", deployResult: "skipped" }];

test("class (a) with a failed sync: the $post picker is reported as HELD BACK on purpose, never as a failure", () => {
  const stale = { sync: "failed:import", parity: "", backup: "", backupExpected: true };
  const HELD = /The `\$post` picker was deliberately \*not\* refreshed: it is pushed only after a successful database sync, so it cannot default to a post the database does not have yet\./;
  const texts = (m) => m.payload.blocks.map((b) => b.text?.text ?? "").join("\n");
  // pages-deploy: refresh-post-variable has `if: sync == 'ok'`, so it arrives as "skipped".
  const pages = texts(buildPagesDeployMessage(pagesInput(stale, { refreshResult: "skipped" })));
  assert.match(pages, HELD);
  assert.doesNotMatch(pages, /picker refresh (?:failed|did not finish)/);
  // weekly: the step is skipped inside a green publish job.
  const weekly = texts(buildWeeklyMessage(weeklyInput(stale)));
  assert.match(weekly, HELD);
  // sync ok, only parity not: the picker WAS refreshed — nothing to say about it.
  const unverified = { sync: "ok", parity: "differs", backup: "ok", backupExpected: true };
  assert.doesNotMatch(texts(buildWeeklyMessage(weeklyInput(unverified))), HELD);
  assert.doesNotMatch(texts(buildPagesDeployMessage(pagesInput(unverified))), HELD);
  // a refresh that really failed after a good sync is still called a failure
  assert.match(texts(buildPagesDeployMessage(pagesInput(unverified, { refreshResult: "failure" }))), /picker refresh failed/);
  // the week never reached Pages: that note wins, the picker is the smaller story
  assert.doesNotMatch(texts(buildWeeklyMessage(weeklyInput(stale, { publishResult: "failure", deployed: "" }))), HELD);
});

test("pages-deploy, class (a): the push fallback says that the DEPLOY failed too, when it did", () => {
  const db = { sync: "ok", parity: "timeout", backup: "", backupExpected: false };
  const failed = buildPagesDeployMessage(pagesInput(db, { deployResult: "failure", refreshResult: "skipped" }));
  assert.match(failed.payload.text, /LinkedIn manual pages-deploy FAILED \(the deploy to GitHub Pages failed\), and the Grafana dashboards may be WRONG — /);
  const fine = buildPagesDeployMessage(pagesInput(db));
  assert.match(fine.payload.text, /LinkedIn manual pages-deploy: the Grafana dashboards may be WRONG — /);
  assert.doesNotMatch(fine.payload.text, /FAILED/);
});

test("dashboardsState: only sync and parity decide what Grafana shows — empty is unknown, never fine, and the backup never counts", () => {
  assert.equal(dashboardsState(undefined), null, "без етапу бази — невідомо");
  assert.equal(dashboardsState({ sync: "ok", parity: "ok", backup: "failed:push", backupExpected: true }), "fresh");
  for (const sync of SYNC_STATES.filter((s) => s !== "ok")) {
    assert.equal(dashboardsState({ sync, parity: "ok", backup: "ok" }), "stale", `sync=${sync}`);
  }
  for (const parity of PARITY_STATES.filter((s) => s !== "ok")) {
    assert.equal(dashboardsState({ sync: "ok", parity, backup: "ok" }), "unverified", `parity=${parity}`);
  }
  assert.equal(dashboardsState({}), "stale", "жодного output — sync невідомий, тобто не ok");
});

test("an all-good database state changes NOTHING about the verdict — it only appends one grey confirmation, with no ping and no warning", () => {
  const good = { sync: "ok", parity: "ok", backup: "ok", backupExpected: true };
  const goodNoBackup = { sync: "ok", parity: "ok", backup: "", backupExpected: false };
  // Порівнюємо з повідомленням БЕЗ жодної DB_* (стан бази невідомий): ті самі
  // блоки, той самий вердикт і пінг. Різниця — лише в тому, за що можна ручатись
  // ТІЛЬКИ з доказом: речення про свіжі дашборди (VOUCH / FRESH) і останній сірий
  // рядок («synced …» проти «no database result reached this message»).
  const FRESH = /The Grafana dashboards read the database, which (?:was|this run) synced and checked, so they (?:already show this week|are current); (?:until pages-deploy succeeds, )?only the public JSON feed on Pages and the Grafana `\$post` picker stay on the previous publish\./;
  const VOUCH = / — the dashboards are up to date\.| — the dashboards show the new data\*| — the dashboards now show everything merged into main\.|the data is merged and live,/;
  const sameButConfirmed = (built, bare, db) => {
    const id = JSON.stringify(db);
    assert.equal(built.kind, bare.kind, id);
    if (built.payload.text !== bare.payload.text) {
      // Єдиний fallback, що сам ручається за дашборди, — ручний pages-deploy.
      assert.match(built.payload.text, /^LinkedIn dashboards published/, id);
      assert.match(bare.payload.text, /^LinkedIn data published to GitHub Pages/, id);
    }
    assert.equal(built.database, undefined, "жодного ::warning::");
    assert.equal(bare.database, undefined, "і без DB_* теж: це локальний dry-run, а не збій");
    assert.equal(built.payload.blocks.length, bare.payload.blocks.length, id);
    assert.equal(bare.payload.blocks.at(-1).elements[0].text, UNKNOWN_DB, id);
    assert.doesNotMatch(JSON.stringify(bare.payload) + bare.summary, VOUCHES_FOR_DASHBOARDS, `${id}: без DB_* за дашборди не ручаємось`);
    const head = built.payload.blocks.slice(0, -1);
    const notOnPages = /NOT published to GitHub Pages|nothing was published to GitHub Pages/.test(JSON.stringify(bare.payload.blocks[0]));
    let differing = 0;
    head.forEach((b, i) => {
      if (JSON.stringify(b) === JSON.stringify(bare.payload.blocks[i])) return;
      differing += 1;
      assert.match(b.text?.text ?? "", notOnPages ? FRESH : VOUCH, id);
    });
    if (notOnPages) assert.equal(differing, 1, `${id}: лише речення про свіжі дашборди`);
    const last = built.payload.blocks.at(-1);
    assert.equal(last.type, "context", "сірий рядок, а не section");
    assert.equal(last.elements[0].text, db.backupExpected
      ? ":white_check_mark: Database (Grafana reads it): synced · parity byte-identical · backup pushed"
      : ":white_check_mark: Database (Grafana reads it): synced · parity byte-identical · backup not requested for this run");
    const bareSummary = bare.summary.replace(/; database: no result reached the notifier, so nothing is claimed about the Grafana dashboards$/, "");
    assert.notEqual(bareSummary, bare.summary, "summary без DB_* теж каже «невідомо»");
    if (!VOUCH.test(JSON.stringify(head))) assert.ok(built.summary.startsWith(`${bareSummary}; `), id);
    assert.ok(built.summary.endsWith(`; database (dual-write): synced, parity byte-identical, ${db.backupExpected ? "backup pushed" : "backup not requested for this run"}`), id);
    assert.doesNotMatch(JSON.stringify(last), /<@|<!/);
  };
  for (const extra of WEEKLY_VARIANTS) {
    for (const db of [good, goodNoBackup]) {
      sameButConfirmed(buildWeeklyMessage(weeklyInput(db, extra)), buildWeeklyMessage(weeklyInput(undefined, extra)), db);
    }
  }
  for (const extra of PAGES_VARIANTS) {
    for (const db of [good, goodNoBackup]) {
      sameButConfirmed(buildPagesDeployMessage(pagesInput(db, extra)), buildPagesDeployMessage(pagesInput(undefined, extra)), db);
    }
  }
  const line = databaseLine(good);
  assert.deepEqual([line.problems, line.actions, line.text, line.plain, line.dashboards], [[], [], null, null, "fresh"]);
  // Без етапу бази (локальний dry-run) — справді нічого.
  assert.deepEqual(databaseLine(undefined), { problems: [], actions: [], text: null, plain: null, dashboards: null });

  // І наскрізно, через env, як у CI.
  const r = run({ ...CLEAN_RUN, ...DB_OK });
  const bare = run(CLEAN_RUN);
  assert.deepEqual(r.payloads[0].blocks.slice(1, -1), bare.payloads[0].blocks.slice(1, -1));
  assert.match(r.payloads[0].blocks.at(-1).elements[0].text, /synced · parity byte-identical · backup pushed$/);
  assert.doesNotMatch(r.stderr, /::warning::/);
  const pr = run({ ...PAGES_OK, DB_SYNC: "ok", DB_PARITY: "ok", DB_BACKUP: "", DB_BACKUP_EXPECTED: "false" });
  assert.deepEqual(pr.payloads[0].blocks.slice(1, -1), run(PAGES_OK).payloads[0].blocks.slice(1, -1));
  assert.match(pr.payloads[0].blocks.at(-1).elements[0].text, /backup not requested for this run$/);
});

test("with NO DB_* input at all the state of the database is unknown: the message never vouches for the dashboards, says so in one grey line, pings nobody extra and warns nobody", () => {
  // Grafana читає базу. «the dashboards are up to date» без жодного стану бази —
  // той самий тихий нуль, від якого цей файл і боронить: так виглядав би й прогін,
  // де DB_* до нотифаєра просто не доїхали.
  for (const [mode, build, input, variants] of [
    ["weekly", buildWeeklyMessage, weeklyInput, WEEKLY_VARIANTS],
    ["pages", buildPagesDeployMessage, pagesInput, PAGES_VARIANTS],
  ]) {
    for (const extra of variants) {
      const at = `${mode} ${JSON.stringify(extra)}`;
      const bare = build(input(undefined, extra));
      const fine = build(input({ sync: "ok", parity: "ok", backup: "ok", backupExpected: true }, extra));
      assert.doesNotMatch(JSON.stringify(bare.payload) + bare.summary, VOUCHES_FOR_DASHBOARDS, at);
      assert.match(JSON.stringify(fine.payload) + fine.summary, /dashboards|Database \(Grafana reads it\)/, at);
      const grey = bare.payload.blocks.filter((b) => b.type === "context" && b.elements[0].text === UNKNOWN_DB);
      assert.equal(grey.length, 1, at);
      assert.equal(bare.payload.blocks.at(-1).elements[0].text, UNKNOWN_DB, "останнім рядком, як і підтвердження");
      assert.equal(dbBlocks(bare.payload).length, 0, at);
      assert.equal(pings(bare.payload), pings(fine.payload), `невідомо — не привід пінгувати: ${at}`);
      assert.equal(bare.kind, fine.kind, at);
      assert.equal(bare.database, undefined, "локальний dry-run — без ::warning::");
      assert.match(bare.summary, /; database: no result reached the notifier, so nothing is claimed about the Grafana dashboards$/, at);
    }
  }
  assert.match(buildWeeklyMessage(weeklyInput(undefined)).payload.blocks[0].text.text, /^:white_check_mark: \*Week 2026-09-14 collected and published to GitHub Pages\.\*\n/);
  assert.match(buildWeeklyMessage(weeklyInput(undefined, { publishResult: "failure" })).payload.blocks[0].text.text,
    /^:large_yellow_circle: \*Week 2026-09-14 collected and published to GitHub Pages\*, but the Grafana post picker refresh failed\./);
  assert.equal(buildPagesDeployMessage(pagesInput(undefined)).payload.blocks[0].text.text,
    ":white_check_mark: *Manual pages-deploy published everything merged into main to GitHub Pages.*");
  // Незмерджений тиждень у базу й не мав потрапити: там про базу — ані слова.
  for (const extra of [{ mainUpdated: "false" }, { mainUpdated: "", prUrl: "" }]) {
    assert.doesNotMatch(JSON.stringify(buildWeeklyMessage(weeklyInput(undefined, extra)).payload), /[Dd]atabase/, JSON.stringify(extra));
  }

  // Наскрізно через env: жодної DB_* змінної, як у локальному dry-run.
  const r = run(CLEAN_RUN);
  assert.equal(r.code, 0);
  assert.match(firstText(r), /collected and published to GitHub Pages\.\*/);
  assert.equal(r.payloads[0].blocks.at(-1).elements[0].text, UNKNOWN_DB);
  assert.doesNotMatch(r.stdout, VOUCHES_FOR_DASHBOARDS);
  assert.doesNotMatch(r.stdout, /<@/);
  assert.doesNotMatch(r.stderr, /::warning::/);
  const p = run(PAGES_OK);
  assert.equal(p.code, 0);
  assert.equal(p.payloads[0].blocks.at(-1).elements[0].text, UNKNOWN_DB);
  assert.doesNotMatch(p.stdout, VOUCHES_FOR_DASHBOARDS);
  // А ПОРОЖНІ DB_* (так вони приходять у CI, коли job не дописав output) — це вже
  // «did not run», клас (а): окремий тест нижче.
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
  // «Проєкт на паузі» і «дашборди показують минулий синк» не можуть бути правдою
  // водночас: Grafana читає ТУ САМУ базу. Коли база не відповіла — панелі лежать.
  for (const sync of ["failed:connect", "timeout:import", "timeout:connect"]) {
    const line = say({ sync });
    assert.match(line.text, /But Grafana reads the database, so while the project is paused or unreachable Grafana cannot read it either: every panel shows a datasource error — \*not\* last week's numbers — until the database answers again; after that the dashboards show the previous sync until `pages-deploy` has re-run\./, sync);
    assert.doesNotMatch(line.text, /keep showing the previous sync/, sync);
    assert.match(line.plain, /the Grafana dashboards were NOT updated \(and cannot be read at all while the database does not answer\); the collected week is safe in git/, sync);
  }
  // …а коли база ВІДПОВІЛА (відкат імпорту, npm, секрет, невідомо що) — вони
  // живі й показують минулий синк: тут старе речення правдиве і лишається.
  for (const sync of ["failed:import", "failed:deps", "timeout:deps", "skipped-no-secret", "failed:script-missing", ""]) {
    const line = say({ sync });
    assert.match(line.text, /so the dashboards keep showing the previous sync \(last week's numbers\) until this is fixed/, JSON.stringify(sync));
    assert.doesNotMatch(line.text + line.plain, /datasource error|cannot be read at all/, JSON.stringify(sync));
  }
  assert.match(say({ sync: "failed:connect" }).text, /the sync \*FAILED\* \(could not connect to the database\)/);
  assert.match(say({ sync: "failed:connect" }).text, /the import is idempotent\. If the `db-sync` job shows `password authentication failed` or `does not exist` instead of a timeout, the `LI_SYNC_DATABASE_URL` secret is wrong\.\n/);
  assert.doesNotMatch(say({ sync: "timeout:import" }).text, /secret is wrong/);
  // Імпорт, що ПІДКЛЮЧИВСЯ і відкотився, — не пауза: радимо дивитись підказки.
  const rolledBack = say({ sync: "failed:import" });
  assert.doesNotMatch(rolledBack.text, /paused/);
  assert.match(rolledBack.text, /connected and then rolled back.*hints in the `db-sync` job/);
  // Parity, що не відпрацювала (зокрема взагалі не запускалась): перезапуск + тиждень не рахується.
  for (const parity of ["error", "timeout", ""]) {
    const line = say({ parity });
    assert.match(line.text, /Run `pages-deploy` to re-sync and re-check .* project is not paused\. \*This week does not count as verified\*/, JSON.stringify(parity));
  }
  // Клас (а) ПІНГУЄ — а пінг без «що робити» привчає глушити бота. Тож дія є в
  // КОЖНОГО стану sync / parity, і в кожній — чим це закінчити: pages-deploy.
  // (Раніше skip, збій npm, різниця parity і «не запускався» лишались без дії.)
  assert.match(say({ sync: "skipped-no-secret" }).text, /:point_right: Create the `LI_SYNC_DATABASE_URL` repository secret .* then run `pages-deploy` to sync\.\n/);
  assert.match(say({ sync: "failed:deps" }).text, /:point_right: Usually the npm registry had a bad moment — run `pages-deploy` to re-sync/);
  assert.match(say({ sync: "timeout:deps" }).text, /:point_right: Usually the npm registry/);
  // Різниця parity: спершу дві причини, які НЕ лагодяться правкою коду (схема на
  // базі старіша за main; grafana_ro втратив право), потім — загальний шлях.
  assert.match(say({ parity: "differs" }).text, /:point_right: Look at the `db-sync` job of the run: it lists every differing path \(values are hashed, never shown\)\. If every line is `\[feed-absent\]` on a `dash\.feed_\*` view, the schema in the database is older than `main` — re-apply it \(`apply-schema --force`, then `import --publish`; db\/README\.md\), there is no data bug to look for\. `\[grant-missing\]` means the role Grafana logs in as \(`grafana_ro`\) lost a privilege .* Anything else: reproduce it locally with `node db\/verify\.mjs --show-values`, fix the cause, then run `pages-deploy` to re-sync and re-check\.\n/);
  for (const sync of ["", "failed:script-missing", "failed:checkout", "banana", "failed:<!channel>"]) {
    assert.match(say({ sync }).text, /:point_right: Open the `db-sync` job of the run to see where it stopped, fix the cause, then run `pages-deploy` to re-sync/, JSON.stringify(sync));
  }
  assert.match(say({ parity: "banana" }).text, /:point_right: Open the `db-sync` job of the run/);
  for (const sync of SYNC_STATES.filter((s) => s !== "ok")) {
    const line = say({ sync });
    assert.equal(line.actions.length, 1, JSON.stringify(sync));
    assert.match(line.actions[0], /`pages-deploy`/, JSON.stringify(sync));
  }
  for (const parity of PARITY_STATES.filter((s) => s !== "ok")) {
    const line = say({ parity });
    assert.equal(line.actions.length, 1, JSON.stringify(parity));
    assert.match(line.actions[0], /`pages-deploy`|`profiles\.json`/, JSON.stringify(parity));
  }
  // Лише бекап (клас (б)) — без окремої дії, як і було.
  assert.doesNotMatch(say({ backup: "failed:push" }).text, /:point_right:/);
  assert.deepEqual(say({ backup: "failed:push" }).actions, []);

  // Наскрізно: у Slack і в ::warning:: логу — і тепер з пінгом оператора.
  const r = run({ ...CLEAN_RUN, DB_SYNC: "failed:connect", DB_PARITY: "", DB_BACKUP: "", DB_BACKUP_EXPECTED: "true" });
  assert.match(r.payloads[0].blocks[1].text.text, PAUSED);
  assert.match(r.stderr, /::warning::database \(dual-write\): the sync FAILED \(could not connect to the database\).*the Grafana dashboards were NOT updated \(and cannot be read at all while the database does not answer\); the collected week is safe in git\. What to do: Most likely the Supabase project is paused/);
  assert.match(firstText(r), new RegExp(`^<@${OPERATOR}> :warning: `));
  assertNoAuthorPing(body(r));
});

test("every combination of sync / parity / backup outcome: silent only when all three held; sync or parity trouble is the DASHBOARDS class (ping), a backup alone is not", () => {
  let combos = 0;
  const seen = { a: 0, b: 0, good: 0 };
  for (const backupExpected of [true, false]) {
    for (const sync of SYNC_STATES) for (const parity of PARITY_STATES) for (const backup of BACKUP_STATES) {
      combos += 1;
      const db = { sync, parity, backup, backupExpected };
      const id = JSON.stringify(db);
      const line = databaseLine(db);
      const allGood = sync === "ok" && parity === "ok" && (!backupExpected || backup === "ok");
      if (allGood) { seen.good += 1; assert.equal(line.text, null, id); continue; }
      const classA = sync !== "ok" || parity !== "ok";
      seen[classA ? "a" : "b"] += 1;

      assert.ok(line.text, `мовчати не можна: ${id}`);
      assert.doesNotMatch(line.text, /<@|<!/, `пінг живе в заголовку, не в рядку бази: ${id}`);
      assert.doesNotMatch(line.plain, /[*`]/, id);
      // Стара фраза стала неправдою в ОБОХ класах: дашборди з JSON більше не будуються.
      assert.doesNotMatch(line.text + line.plain, /the dashboards are built from it|JSON in git is still the source of truth/, id);

      if (classA) {
        assert.equal(line.dashboards, sync !== "ok" ? "stale" : "unverified", id);
        assert.match(line.text, /^:red_circle: \*Database \(dual-write stage\):\*/, id);
        // Три обов'язкові речі: дія, «тиждень у git цілий» і що буде з дашбордами.
        assert.match(line.text, /\n:point_right: /, id);
        assert.match(line.text, /:shield: \*The collected week is safe in git\* — nothing is lost and there is no data-loss deadline\. But Grafana reads the database, /, id);
        // База не відповіла -> панелі лежать; відповіла й відмовила -> минулий синк.
        assert.match(line.text, sync !== "ok"
          ? (databaseUnreachable(sync)
            ? /every panel shows a datasource error — \*not\* last week's numbers — until the database answers again; after that the dashboards show the previous sync until `pages-deploy` has re-run\./
            : /so the dashboards keep showing the previous sync \(last week's numbers\) until this is fixed and `pages-deploy` has re-run\./)
          : /this sync is not confirmed to match the JSON build — so the dashboards may show numbers that differ from it until this is fixed and `pages-deploy` has re-run with a clean parity check\./, id);
        assert.match(line.plain, sync !== "ok"
          ? / — the Grafana dashboards were NOT updated(?: \(and cannot be read at all while the database does not answer\))?; the collected week is safe in git\. What to do: /
          : / — the Grafana dashboards may be WRONG; the collected week is safe in git\. What to do: /, id);
        assert.doesNotMatch(line.text, /not affected|Nobody is pinged/, id);
      } else {
        assert.equal(line.dashboards, "fresh", id);
        assert.match(line.text, /^:large_orange_diamond: \*Database \(dual-write stage\):\* the backup /, id);
        assert.match(line.text, /\*The week and the dashboards are not affected\* — the week is safe in git, and the database Grafana reads was synced and matches the JSON build; only this run's backup \(the restore point\) is missing\. Nobody is pinged for this; the details are in the `db-backup` job of the run\.$/, id);
        assert.match(line.plain, / — the week and the dashboards are not affected \(synced, parity ok\), only the backup is missing$/, id);
        assert.doesNotMatch(line.text, /:point_right:|:red_circle:|NOT updated|WRONG/, id);
      }

      if (sync !== "ok") {
        // Parity і backup від sync залежать: окремо їх не перелічуємо.
        assert.equal(line.problems.length, 1, id);
        assert.match(line.text, /the sync /, id);
        // Невідомий стан sync, а parity / backup при цьому ВІДЗВІТУВАЛИ: «did not
        // run either» суперечило б входам. (У CI недосяжно: db-ci.mjs пише parity
        // лише після sync=ok, backup має needs на sync == 'ok'.)
        const unknownButReported = sync === "banana" && (parity !== "" || (backupExpected && backup !== ""));
        if (unknownButReported) {
          assert.match(line.text, /unexpected state \(`banana`\) — although the .* reported `[^`]*`.*, which cannot be trusted without a successful sync\./, id);
          assert.doesNotMatch(line.text, /did not run either/, id);
        } else {
          assert.match(line.text, backupExpected
            ? /so the parity check and the backup did not run either/
            : /so the parity check did not run either/, id);
        }
        if (!backupExpected) assert.doesNotMatch(line.text, /backup/, id);
        assert.match(line.text, /The details are in the `db-sync` job of the run\.$/, id);
      } else {
        assert.doesNotMatch(line.text, /the sync /, id);
        assert.equal(/the parity check/.test(line.text), parity !== "ok", id);
        assert.equal(/the backup/.test(line.text), backupExpected && backup !== "ok", id);
        assert.equal(line.problems.length, (parity !== "ok" ? 1 : 0) + (backupExpected && backup !== "ok" ? 1 : 0), id);
      }

      // Те саме — у готових повідомленнях обох режимів: рівно один рядок бази,
      // одразу під головним блоком.
      for (const [mode, built, bare] of [
        ["weekly", buildWeeklyMessage(weeklyInput(db)), buildWeeklyMessage(weeklyInput(undefined))],
        ["pages", buildPagesDeployMessage(pagesInput(db)), buildPagesDeployMessage(pagesInput(undefined))],
      ]) {
        const at = `${mode} ${id}`;
        assert.equal(dbBlocks(built.payload).length, 1, at);
        assert.equal(built.payload.blocks[1].type, "section", "section, а не сірий context");
        assert.equal(built.payload.blocks[1].text.text, line.text, at);
        assert.match(built.summary, /; database \(dual-write\): /, at);
        assert.equal(built.database, line.plain, "і ::warning:: у лог");
        const head = built.payload.blocks[0].text.text;
        if (classA) {
          // Заголовок УСЬОГО повідомлення: дашборди НЕ оновлені / можуть брехати,
          // оператор пінгнутий рівно двічі (заголовок + fallback пуша), як у 1c.
          assert.equal(built.kind, `${mode === "pages" ? "pages-" : ""}dashboards-${line.dashboards}`, at);
          assert.match(head, new RegExp(`^<@${OPERATOR}> :warning: `), at);
          assert.match(head, sync !== "ok"
            ? /but the Grafana dashboards were NOT updated\* — they read the database, and the database sync did not succeed\./
            : /but the Grafana dashboards may be WRONG\* — they read the database, and the parity check did not confirm that it matches the JSON build\./, at);
          assert.doesNotMatch(JSON.stringify(built.payload), CLAIMS_FRESH, `заголовок не бреше: ${at}`);
          assert.doesNotMatch(built.summary, CLAIMS_FRESH, at);
          assert.equal(pings(built.payload), 2, at);
          assert.match(built.payload.text, new RegExp(`^<@${OPERATOR}> LinkedIn .*the Grafana dashboards (?:were NOT updated|may be WRONG) — .*run pages-deploy`), at);
          assert.doesNotMatch(built.payload.text, /https?:|the week is fine/, at);
          if (mode === "weekly") {
            assert.match(head, /^<@\w+> :warning: \*Week 2026-09-14 is collected and safe on main, but /, at);
            assert.match(head, /:white_check_mark: \*Peter Ovchynnikov\* — collected/, "статус авторів лишається");
          } else {
            assert.match(head, /\*Manual pages-deploy published to GitHub Pages, but /, at);
          }
        } else {
          // Клас (б): вердикт, заголовок і відсутність пінгу — як у прогоні, де
          // з базою все гаразд (помаранчевий section замість сірого context).
          const fine = (mode === "weekly" ? buildWeeklyMessage : buildPagesDeployMessage)(
            (mode === "weekly" ? weeklyInput : pagesInput)({ sync: "ok", parity: "ok", backup: "ok", backupExpected: true }));
          assert.equal(built.kind, fine.kind, "бекап не змінює вердикт");
          assert.equal(built.kind, bare.kind, at);
          assert.deepEqual(built.payload.blocks[0], fine.payload.blocks[0], at);
          assert.equal(built.payload.blocks.length, fine.payload.blocks.length, at);
          assert.equal(built.payload.text, `${fine.payload.text} — the database backup needs a look (the week and the dashboards are fine)`, at);
          assert.equal(pings(built.payload), 0, "день без дій лишається без пінгу");
        }
      }
    }
  }
  assert.equal(combos, 2 * SYNC_STATES.length * PARITY_STATES.length * BACKUP_STATES.length);
  assert.ok(seen.a > 0 && seen.b > 0 && seen.good > 0, JSON.stringify(seen));
});

test("the dashboards class outranks every publish outcome, in both modes — and still says what happened to Pages", () => {
  const stale = { sync: "failed:connect", parity: "", backup: "", backupExpected: true };
  const unverified = { sync: "ok", parity: "differs", backup: "ok", backupExpected: true };
  for (const db of [stale, unverified]) {
    const state = db === stale ? "stale" : "unverified";
    for (const extra of WEEKLY_VARIANTS) {
      const built = buildWeeklyMessage(weeklyInput(db, extra));
      const at = `${state} ${JSON.stringify(extra)}`;
      const text = JSON.stringify(built.payload);
      assert.equal(built.kind, `dashboards-${state}`, at);
      assert.match(built.payload.blocks[0].text.text, new RegExp(`^<@${OPERATOR}> :warning: \\*Week 2026-09-14 is collected and safe on main, but the Grafana dashboards `), at);
      assert.doesNotMatch(text, CLAIMS_FRESH, at);
      assert.equal(pings(built.payload), 2, at);
      assert.equal(dbBlocks(built.payload).length, 1, at);
      assert.doesNotMatch(text, /Deadline: Monday|lost for good/, "тиждень змерджено — жорсткого дедлайну немає");
      // Що сталося з Pages — окремою приміткою, а не заголовком.
      const onPages = extra.deployed !== "";
      assert.equal(/Separately, the week was \*not published to GitHub Pages\*/.test(text), !onPages, at);
      assert.equal(/Published to </.test(text), onPages, at);
      assert.equal(/Separately, the Grafana post picker refresh failed/.test(text), onPages && extra.publishResult === "failure", at);
    }
    for (const extra of PAGES_VARIANTS) {
      const built = buildPagesDeployMessage(pagesInput(db, extra));
      const at = `pages ${state} ${JSON.stringify(extra)}`;
      const head = built.payload.blocks[0].text.text;
      const deployed = (extra.deployResult ?? "success") === "success";
      assert.equal(built.kind, `pages-dashboards-${state}`, at);
      assert.match(head, deployed
        ? new RegExp(`^<@${OPERATOR}> :warning: \\*Manual pages-deploy published to GitHub Pages, but the Grafana dashboards `)
        : new RegExp(`^<@${OPERATOR}> :x: \\*Manual pages-deploy FAILED \\((?:the deploy to GitHub Pages failed|the build job failed)\\), and the Grafana dashboards `), at);
      assert.doesNotMatch(JSON.stringify(built.payload), CLAIMS_FRESH, at);
      assert.equal(pings(built.payload), 2, at);
      assert.equal(/to see which step failed/.test(JSON.stringify(built.payload)), !deployed, at);
      assert.match(JSON.stringify(built.payload), /Triggered by `octo-operator`/, at);
    }
  }
  // Pages не доїхав, а база в порядку: дашборди свіжі — і це сказано прямо.
  const good = { sync: "ok", parity: "ok", backup: "ok", backupExpected: true };
  const notDeployed = JSON.stringify(buildWeeklyMessage(weeklyInput(good, { publishResult: "failure", deployed: "" })).payload);
  assert.match(notDeployed, /NOT published to GitHub Pages\* — the deploy to GitHub Pages failed/);
  assert.match(notDeployed, /The Grafana dashboards read the database, which was synced and checked, so they already show this week/);
  const pagesFailed = JSON.stringify(buildPagesDeployMessage(pagesInput(good, { deployResult: "failure" })).payload);
  assert.match(pagesFailed, /FAILED — nothing was published to GitHub Pages/);
  assert.match(pagesFailed, /The Grafana dashboards read the database, which this run synced and checked, so they are current/);
});

test("the dashboards class without an operator mapping still posts, pings nobody and says so", () => {
  const db = { sync: "timeout:import", parity: "", backup: "", backupExpected: true };
  for (const built of [buildWeeklyMessage(weeklyInput(db, { operator: null })), buildPagesDeployMessage(pagesInput(db, { operator: null }))]) {
    assert.equal(pings(built.payload), 0);
    assert.match(built.payload.blocks[0].text.text, /^:warning: /);
    assert.match(JSON.stringify(built.payload.blocks.at(-1)), /No `_operator` id is mapped in SLACK_PEOPLE_JSON, so nobody was pinged/);
  }
  const r = run({ ...CLEAN_RUN, DB_SYNC: "timeout:import", DB_PARITY: "", DB_BACKUP: "", DB_BACKUP_EXPECTED: "true", SLACK_PEOPLE_JSON: JSON.stringify({ peter: "U02DEF" }) });
  assert.equal(r.code, 0);
  assert.doesNotMatch(body(r), /<@/, "автори як фолбек — теж ні");
  assert.match(body(r), /No `_operator` id is mapped/);
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
  // Проблема з parity І з бекапом — клас (а), і деталі в обох job'ах.
  assert.match(say({ parity: "differs", backup: "failed:dump" }), /The details are in the `db-sync` \/ `db-backup` jobs of the run\.$/);
  assert.match(say({ parity: "differs" }), /The details are in the `db-sync` job of the run\.$/);
  // Невідомий стан чи фаза з воркфлоу — це дані: екрануються і не губляться.
  assert.match(say({ sync: "failed:<!channel>" }), /the sync \*FAILED\* \(`&lt;!channel&gt;`\)/);
  assert.match(say({ parity: "<!here>" }), /unexpected state \(`&lt;!here&gt;`\)/);
});

test("an unmerged or crashed week says nothing about the database — the sync only ever runs from main after a merge", () => {
  const dead = { DB_SYNC: "", DB_PARITY: "", DB_BACKUP: "", DB_BACKUP_EXPECTED: "true" };
  for (const env of [REVIEW_RUN, CRASH_RUN]) {
    const r = run({ ...env, ...dead });
    assert.deepEqual(r.payloads, run(env).payloads, "синк тут не очікувався — порожні DB_* не роблять з цього клас (а)");
    assert.doesNotMatch(r.stdout + r.stderr, /[Dd]atabase|dual-write/);
  }
});

// Раніше тут вердикт лишався «collected and published» без пінгу. Відколи Grafana
// читає базу, «sync невідомий» = «дашборди, найпевніше, на минулому тижні»: це вже
// не примітка, а причина покликати людину.
test("a merged week whose db jobs wrote nothing is 'did not run', never silence — empty is unknown, not fine, and the dashboards are NOT called up to date", () => {
  const r = run({ ...CLEAN_RUN, DB_SYNC: "", DB_PARITY: "", DB_BACKUP: "", DB_BACKUP_EXPECTED: "true" });
  assert.equal(r.code, 0);
  assert.equal(r.payloads.length, 1, "усе ще рівно одне повідомлення на прогін");
  assert.match(firstText(r), new RegExp(`^<@${OPERATOR}> :warning: \\*Week ${THIS_WEEK} is collected and safe on main, but the Grafana dashboards were NOT updated\\*`));
  assert.doesNotMatch(body(r), CLAIMS_FRESH);
  const text = r.payloads[0].blocks[1].text.text;
  assert.match(text, /the sync \*did not run or did not finish\*, so the parity check and the backup did not run either/);
  assert.match(text, /:point_right: Open the `db-sync` job of the run/);
  assert.match(text, /The collected week is safe in git/);
  assert.match(r.stderr, /::warning::database \(dual-write\): the sync did not run or did not finish/);
  assert.match(r.stderr, /: dashboards-stale\n/);
  assert.match(r.payloads[0].text, new RegExp(`^<@${OPERATOR}> LinkedIn week .* is merged, but the Grafana dashboards were NOT updated — fix the database sync, then run pages-deploy \\(no data-loss deadline\\)$`));
  assertNoAuthorPing(body(r));
});

test("a parity difference shows up end to end: weekly (also when the deploy failed) and pages-deploy, with a ::warning:: and the operator pinged once per message", () => {
  const diff = { DB_SYNC: "ok", DB_PARITY: "differs", DB_BACKUP: "ok", DB_BACKUP_EXPECTED: "true" };
  const weekly = run({ ...CLEAN_RUN, ...diff });
  assert.match(firstText(weekly), new RegExp(`^<@${OPERATOR}> :warning: \\*Week ${THIS_WEEK} is collected and safe on main, but the Grafana dashboards may be WRONG\\*`));
  assert.match(weekly.payloads[0].blocks[1].text.text, /parity check found a \*DIFFERENCE\*/);
  assert.match(weekly.payloads[0].blocks[1].text.text, /Look at the `db-sync` job of the run/);
  assert.match(weekly.stderr, /::warning::database \(dual-write\): the parity check found a DIFFERENCE/);
  assert.match(weekly.stderr, /: dashboards-unverified\n/);
  assert.equal((body(weekly).match(/<@/g) || []).length, 2, "пінг у заголовку та у fallback-тексті — і ніде більше");

  // Деплой теж упав: заголовок — про дашборди, Pages — окремою приміткою, пінг усе одно один.
  const notDeployed = run({ ...MERGED_NOT_DEPLOYED, ...diff });
  assert.match(firstText(notDeployed), new RegExp(`^<@${OPERATOR}> :warning: .*the Grafana dashboards may be WRONG`));
  assert.match(notDeployed.payloads[0].blocks[1].text.text, /Database \(dual-write stage\)/);
  assert.match(notDeployed.payloads[0].blocks[2].text.text, /Separately, the week was \*not published to GitHub Pages\* — the deploy to GitHub Pages failed\. The same `pages-deploy` run takes care of it\./);
  assert.equal((body(notDeployed).match(/<@/g) || []).length, 2);

  // pages-deploy без галочки backup: про бекап ані слова.
  const pages = run({ ...PAGES_OK, DB_SYNC: "ok", DB_PARITY: "differs", DB_BACKUP: "", DB_BACKUP_EXPECTED: "false" });
  assert.match(firstText(pages), new RegExp(`^<@${OPERATOR}> :warning: \\*Manual pages-deploy published to GitHub Pages, but the Grafana dashboards may be WRONG\\*`));
  assert.doesNotMatch(body(pages), /pages-deploy succeeded/);
  assert.match(pages.payloads[0].blocks[1].text.text, /parity check found a \*DIFFERENCE\*/);
  assert.doesNotMatch(pages.payloads[0].blocks[1].text.text, /backup/);
  assert.match(pages.stderr, /pages-deploy result: pages-dashboards-unverified/);
  const pagesSkipped = run({ ...PAGES_OK, DEPLOY_RESULT: "failure", DB_SYNC: "skipped-no-secret", DB_PARITY: "", DB_BACKUP: "", DB_BACKUP_EXPECTED: "false" });
  assert.match(firstText(pagesSkipped), new RegExp(`^<@${OPERATOR}> :x: \\*Manual pages-deploy FAILED \\(the deploy to GitHub Pages failed\\), and the Grafana dashboards were NOT updated\\*`));
  assert.match(pagesSkipped.payloads[0].blocks[1].text.text, /the sync was \*skipped\* — the `LI_SYNC_DATABASE_URL` secret is not set, so the parity check did not run either/);
});

test("a failed backup alone is the old orange line end to end: no ping, the verdict and the 'up to date' headline stay", () => {
  const env = { DB_SYNC: "ok", DB_PARITY: "ok", DB_BACKUP: "failed:push", DB_BACKUP_EXPECTED: "true" };
  const weekly = run({ ...CLEAN_RUN, ...env });
  assert.match(firstText(weekly), /^:white_check_mark: \*Week .* collected and published\* — the dashboards are up to date\./);
  assert.match(weekly.payloads[0].blocks[1].text.text, /^:large_orange_diamond: \*Database \(dual-write stage\):\* the backup \*FAILED\* \(pushing to the backup repository\)\.\n\*The week and the dashboards are not affected\*/);
  assert.doesNotMatch(body(weekly), /<@/);
  assert.match(weekly.stderr, /::warning::database \(dual-write\): the backup FAILED \(pushing to the backup repository\) — the week and the dashboards are not affected/);
  assert.match(weekly.stderr, /: published\n/);
  const pages = run({ ...PAGES_OK, ...env });
  assert.match(firstText(pages), /^:white_check_mark: \*Manual pages-deploy succeeded\*/);
  assert.doesNotMatch(body(pages), /<@/);
  assert.match(pages.stderr, /pages-deploy result: pages-deployed/);
});

test("the database line is English-only and survives a missing Slack token as a ::warning::, exit 0, without the operator id", () => {
  const broken = { DB_SYNC: "failed:import", DB_PARITY: "", DB_BACKUP: "", DB_BACKUP_EXPECTED: "true" };
  const r = run({ ...CLEAN_RUN, ...broken, SLACK_BOT_TOKEN: "" }, { dry: false });
  assert.equal(r.code, 0, "і клас (а) не фарбує прогін: Slack-збій — це ::warning::");
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /::warning::database \(dual-write\): the sync FAILED \(the import\)/);
  assert.match(r.stderr, /It would have said: Week .* is merged, but the Grafana dashboards were NOT updated; database \(dual-write\): the sync FAILED/);
  assert.doesNotMatch(r.stderr, new RegExp(OPERATOR), "id оператора з секрету в лог не йде — summary без @-згадки");
  const variants = [
    { ...CLEAN_RUN, ...broken }, { ...PAGES_OK, ...broken }, { ...MERGED_NOT_DEPLOYED, ...broken },
    { ...CLEAN_RUN, DB_SYNC: "ok", DB_PARITY: "incomplete", DB_BACKUP: "ok", DB_BACKUP_EXPECTED: "true" },
    { ...PAGES_OK, DEPLOY_RESULT: "failure", DB_SYNC: "ok", DB_PARITY: "ok", DB_BACKUP: "timeout:dump", DB_BACKUP_EXPECTED: "true" },
  ];
  for (const env of variants) {
    const out = run(env);
    assert.equal(out.code, 0);
    assert.doesNotMatch(out.stdout + out.stderr, /[Ѐ-ӿ]/);
    assert.doesNotMatch(out.stdout + out.stderr, /xoxb-/);
  }
});
