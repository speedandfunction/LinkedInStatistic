#!/usr/bin/env node
// Щоденний алерт про базу: говорить лише тоді, коли є що робити, і тегає того,
// хто це зробить.
//
// Чому цей файл існує. Джоб db-keepalive закінчується `exit 0`, тому впасти він
// не може за конструкцією: 2026-09-29 база не відповідала, а Actions показував
// зелене з 28-го. Тепер результат несе notify-db, і його поведінка мусить бути
// перевірена саме як поведінка: тиша на «ок», пінг на кожному іншому стані,
// правда в тексті про наслідок (дашборди читають цю базу).
//
//   node --test .github/scripts/tests/notify-db-touch.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(HERE, "..", "notify-db-touch.mjs");
const OPERATOR = "U09OPS";

// Дитині віддаємо ТІЛЬКИ перелічене: справжній токен чи мапа людей із
// оболонки розробника не мають шансу потрапити в тест.
function run(env) {
  return new Promise((ok) => {
    const child = spawn(process.execPath, [SCRIPT], {
      env: {
        PATH: process.env.PATH, HOME: process.env.HOME,
        SLACK_DRY_RUN: "1", SLACK_CHANNEL_ID: "C0TEST",
        SLACK_PEOPLE_JSON: JSON.stringify({ _operator: OPERATOR }),
        ...env,
      },
    });
    let out = ""; let err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("close", (code) => {
      let payloads = null;
      if (out.trim()) { try { payloads = JSON.parse(out); } catch { payloads = "UNPARSEABLE"; } }
      ok({ code, payloads, log: err });
    });
  });
}
const textOf = (p) => (p.blocks ?? []).map((b) => b.text?.text ?? (b.elements ?? []).map((e) => e.text).join(" ")).join("\n");

test("a database that answered says nothing at all", async () => {
  const r = await run({ DB_TOUCH: "ok" });
  assert.equal(r.code, 0);
  assert.equal(r.payloads, null, "silence is the whole point on a good day");
  assert.doesNotMatch(r.log, /::warning::/, "and no warning either");
});

test("every state that is not ok posts exactly one message, pings the operator, and names the consequence", async () => {
  for (const state of ["failed:connect", "timeout:connect", "skipped-no-secret", "failed:script-missing", "deps:npm", "", "something-new"]) {
    const r = await run({ DB_TOUCH: state });
    assert.equal(r.code, 0, state);
    assert.ok(Array.isArray(r.payloads) && r.payloads.length === 1, `${state}: expected one payload`);
    const p = r.payloads[0];
    assert.equal(p.channel, "C0TEST", state);
    assert.equal(p.unfurl_links, false, state);
    const text = textOf(p);
    assert.match(text, new RegExp(`<@${OPERATOR}>`), `${state}: the operator must be pinged`);
    assert.match(p.text, new RegExp(`<@${OPERATOR}>`), `${state}: the fallback must ping too`);
    assert.match(text, /dashboards read this database/, `${state}: must say what it means now`);
    assert.match(text, /safe in git/, `${state}: must say what is NOT lost`);
    assert.match(text, /:point_right:/, `${state}: must say what to do`);
    assert.match(r.log, /::warning::database keep-alive/, `${state}: must annotate the run too`);
  }
});

test("a refused connection sends the operator to Supabase, not to the code", async () => {
  const text = textOf((await run({ DB_TOUCH: "failed:connect" })).payloads[0]);
  assert.match(text, /Supabase dashboard/);
  assert.match(text, /pauses a project after 7 idle days/);
  assert.match(text, /LI_SYNC_DATABASE_URL/, "a rotated password looks the same — say so");
});

test("a missing secret is not dressed up as an outage", async () => {
  const text = textOf((await run({ DB_TOUCH: "skipped-no-secret" })).payloads[0]);
  assert.match(text, /skipped/);
  assert.doesNotMatch(text, /did not answer/);
});

test("an empty result is reported as unknown, which is not the same as fine", async () => {
  const text = textOf((await run({ DB_TOUCH: "" })).payloads[0]);
  assert.match(text, /did not finish/);
  assert.match(text, /not the same as fine/);
});

test("an unknown state still reaches a human instead of being swallowed", async () => {
  const text = textOf((await run({ DB_TOUCH: "invented:state" })).payloads[0]);
  assert.match(text, /unexpected state/);
  assert.match(text, /invented:state/, "name it, so the fix is obvious");
});

test("a broken people map costs the ping, not the alert", async () => {
  const r = await run({ DB_TOUCH: "failed:connect", SLACK_PEOPLE_JSON: "{not json" });
  assert.equal(r.code, 0);
  assert.equal(r.payloads.length, 1, "the alert must still post");
  assert.doesNotMatch(textOf(r.payloads[0]), /<@/, "without a ping");
  assert.match(r.log, /SLACK_PEOPLE_JSON is not valid JSON/);
});

test("an operator id that is not a member id is dropped rather than pasted into the channel", async () => {
  const r = await run({ DB_TOUCH: "failed:connect", SLACK_PEOPLE_JSON: JSON.stringify({ _operator: "@sasha" }) });
  assert.equal(r.payloads.length, 1);
  assert.doesNotMatch(textOf(r.payloads[0]), /@sasha/);
});

test("the run link is included when the workflow provides one, and omitted otherwise", async () => {
  const withLink = await run({
    DB_TOUCH: "failed:connect",
    GITHUB_SERVER_URL: "https://github.com", GITHUB_REPOSITORY: "o/r", GITHUB_RUN_ID: "42",
  });
  assert.match(textOf(withLink.payloads[0]), /actions\/runs\/42/);
  assert.match(textOf(withLink.payloads[0]), /db-keepalive/);
  const without = await run({ DB_TOUCH: "failed:connect" });
  assert.doesNotMatch(textOf(without.payloads[0]), /actions\/runs/);
});
