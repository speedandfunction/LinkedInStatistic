#!/usr/bin/env node
// Щоденна перевірка живості БАЗИ — у Slack, і лише коли є що робити.
//
// Чому це окремий скрипт. Щоденний воркфлоу має джоб `db-keepalive`: одне
// читання з бази на добу, щоб безкоштовний Supabase не заснув. Джоб писав
// результат у власний output і на цьому все — `db-ci.mjs touch` завжди виходить
// нулем, тож джоб ЗАВЖДИ зелений, навіть коли база не відповіла. 2026-09-29
// база лягла (TCP до пулера відкривається, хендшейк обривається), а Actions
// показував success із 28-го: аварію знайшли випадково, руками. До понеділка її
// б ніхто не побачив — а в понеділок на ній падає тижневий синк.
//
// Відтепер: молчання, коли база відповіла; одне повідомлення з пінгом оператора,
// коли ні. Це та сама дисциплінa, що в решті каналу — ростер завжди, тег лише
// тому, хто має діяти.
//
//   DB_TOUCH=<стан> node .github/scripts/notify-db-touch.mjs
//
//   DB_TOUCH            стан із `db-ci.mjs touch`: ok | skipped-no-secret |
//                       failed:connect | timeout:connect | failed:script-missing |
//                       deps:* ; порожньо — джоб не дійшов до кінця, це НЕ «ок»
//   SLACK_BOT_TOKEN     як у решті каналу
//   SLACK_CHANNEL_ID    C… каналу #linkedin-session-bot
//   SLACK_PEOPLE_JSON   {"_operator": "U…"} — звідси беремо ЛИШЕ _operator
//   SLACK_DRY_RUN=1     друкує payload у stdout, нічого не шле
//
// Код виходу завжди 0: збій Slack не має перефарбовувати прогін. Кожна проблема
// на боці Slack — гучний ::warning:: у лозі.

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { section, context, slackPost, remedy, MEMBER_ID } from "./notify-session-check.mjs";

const TOKEN = process.env.SLACK_BOT_TOKEN ?? "";
const CHANNEL = process.env.SLACK_CHANNEL_ID ?? "";
const DRY_RUN = process.env.SLACK_DRY_RUN === "1";

const TOUCH = String(process.env.DB_TOUCH ?? "").trim();
const RUN_URL = process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
  ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
  : "";

// Що саме сталося і що з цим робити. Формулювання говорить про НАСЛІДОК, а не
// про джоб: дашборди Grafana читають цю базу, тож «база не відповіла» означає
// «дашборди зараз показують помилку», а не «щось у CI».
const CASES = {
  "ok": null,
  "skipped-no-secret": {
    what: "the daily database check was *skipped* — the `LI_SYNC_DATABASE_URL` secret is not set",
    do: "Set the secret (WEEKLY-CADENCE.md section 9). Until then nothing watches the database between Mondays.",
    icon: ":large_orange_diamond:",
  },
  "failed:connect": {
    what: "the database *did not answer* today",
    do: "Open the Supabase dashboard. The free tier pauses a project after 7 idle days and only a human can resume it; "
      + "a project that answers on the port but drops the connection is usually paused or restarting. "
      + "If it shows healthy, check `LI_SYNC_DATABASE_URL` — a rotated password looks exactly like this.",
    icon: ":red_circle:",
  },
  "timeout:connect": {
    what: "the database *timed out* today",
    do: "Same first step as a refused connection: check the Supabase dashboard. A pooler under load times out; a paused project usually refuses.",
    icon: ":red_circle:",
  },
  "failed:script-missing": {
    what: "the daily check could not run — its script is missing from `main`",
    do: "Someone removed `.github/scripts/db-ci.mjs` or `db/ping.mjs`. Nothing is watching the database until it is back.",
    icon: ":red_circle:",
  },
};
function describe(state) {
  if (state in CASES) return CASES[state];
  if (state.startsWith("deps")) {
    return {
      what: "the daily database check could not install its dependencies",
      do: "Read the `db-keepalive` job of the run. The database itself was never reached, so its state is unknown.",
      icon: ":large_orange_diamond:",
    };
  }
  if (!state) {
    return {
      what: "the daily database check *did not finish* — its result is unknown, which is not the same as fine",
      do: "Read the `db-keepalive` job of the run: the job was cancelled or died before it could report.",
      icon: ":large_orange_diamond:",
    };
  }
  return {
    what: `the daily database check reported an unexpected state (\`${state}\`)`,
    do: "Read the `db-keepalive` job of the run. An unknown state means this notifier is out of date with `db-ci.mjs`.",
    icon: ":grey_question:",
  };
}

function operatorId() {
  const raw = process.env.SLACK_PEOPLE_JSON;
  if (!raw || !raw.trim()) return "";
  try {
    const map = JSON.parse(raw);
    const id = String(map?._operator ?? "");
    return MEMBER_ID.test(id) ? id : "";
  } catch {
    console.error("::warning::SLACK_PEOPLE_JSON is not valid JSON — the database alert will post without a ping");
    return "";
  }
}

async function main() {
  const c = describe(TOUCH);
  if (!c) { console.error(`database keep-alive ok — nothing to post`); return; }

  const op = operatorId();
  const ping = op ? `<@${op}> ` : "";
  const blocks = [
    section(`${ping}${c.icon} *Database:* ${c.what}.`),
    section(":point_right: " + c.do),
    section(":bar_chart: *What it means right now:* the Grafana dashboards read this database, so while it does not answer "
      + "they show a datasource error rather than numbers. The collected weeks are safe in git — nothing is lost — and "
      + "Monday's scrape will still run, but its sync and every dashboard stay broken until the database is back."),
  ];
  if (RUN_URL) blocks.push(context(`Details in the <${RUN_URL}|run log>, job \`db-keepalive\`.`));

  const fallback = `${ping}LinkedIn database: ${c.what.replace(/\*/g, "")}`;
  // Той самий конверт, що в решті каналу: без розгортання посилань — у них
  // бувають адреси, яким не місце в прев'ю.
  const payload = { channel: CHANNEL, text: fallback, unfurl_links: false, unfurl_media: false, blocks };

  // Проблема з базою мусить бути видна в лозі прогону навіть тоді, коли Slack
  // не відповість.
  console.error(`::warning::database keep-alive: ${c.what.replace(/\*/g, "")}`);

  if (DRY_RUN) {
    // Контракт той самий, що в notify-session-check.mjs і notify-weekly.mjs:
    // stdout — рівно JSON-масив payload'ів.
    console.log(JSON.stringify([payload], null, 2));
    console.error("dry run — 1 payload, nothing was sent");
    return;
  }
  const missing = [!TOKEN && "SLACK_BOT_TOKEN", !CHANNEL && "SLACK_CHANNEL_ID"].filter(Boolean);
  if (missing.length) {
    console.error(`::warning::${missing.join(" and ")} not set — the database alert was NOT posted. It would have said: ${fallback}`);
    return;
  }
  let res;
  try {
    res = await slackPost(payload);
  } catch (e) {
    res = { ok: false, error: `network_error:${e?.cause?.code ?? e?.name ?? "unknown"}`, kind: "transient" };
  }
  if (res.ok) { console.error(`posted -> ${res.channel ?? CHANNEL} (${res.ts ?? "?"})`); return; }
  console.error(`::warning::the database alert was NOT posted to Slack: ${res.error} — ${remedy(res.error)} It would have said: ${fallback}`);
}

// Імпорт віддає чисті будівники для тестів; main() — лише при прямому запуску.
export { describe, CASES };
const IS_MAIN = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (IS_MAIN) { await main(); process.exit(0); }
