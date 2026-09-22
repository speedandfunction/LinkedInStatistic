#!/usr/bin/env node
// Offline regression for the datasource-uid handling of push-dashboard.mjs.
// No Grafana and no network beyond loopback: the pure swap functions are
// tested directly, and the CLI runs against a stub server on 127.0.0.1 that
// only records what it was asked.
//
//   node --test .github/scripts/tests/push-dashboard.test.mjs
//
// What must never regress: the repository is public, so the checked-in
// dashboards carry the placeholder ${DS_LINKEDIN_PG} and never the uid of the
// Postgres datasource — a push puts the uid in at the last moment (or refuses,
// before touching Grafana, when it has none), and a dump takes it out again.

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PG_DS_PLACEHOLDER, PG_DS_TYPE, placeholderToUid, readsPostgres, resolveFolder, uidToPlaceholder } from "../push-dashboard.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(HERE, "..", "push-dashboard.mjs");
const GRAFANA_DIR = resolve(HERE, "..", "..", "..", "dashboards", "grafana");

// Made up for the test — not the uid of any real datasource.
const FAKE_UID = "test-pg-uid_01";
const INFINITY = { type: "yesoreyeram-infinity-datasource", uid: "grafanacloud-infinity" };

const TMP = mkdtempSync(join(tmpdir(), "push-dashboard-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

// The shape the SQL dashboards have: the placeholder sits in the panel, in the
// target and in the query variable.
function fixture(uid = PG_DS_PLACEHOLDER) {
  const ds = () => ({ type: PG_DS_TYPE, uid });
  const sql = "select week\nfrom dash.feed_account_weeks\nwhere author = 'test'\norder by ord";
  return {
    annotations: { list: [{ builtIn: 1, datasource: { type: "grafana", uid: "-- Grafana --" }, name: "Annotations & Alerts" }] },
    id: 42,
    panels: [
      { id: 1, panels: [], title: "Row — with a dash", type: "row" },
      {
        datasource: ds(), id: 2, title: "Followers", type: "stat",
        targets: [{ datasource: ds(), editorMode: "code", format: "table", rawQuery: true, rawSql: sql, refId: "A" }],
      },
    ],
    templating: { list: [{ datasource: ds(), definition: sql, name: "account_latest_week", query: sql, type: "query" }] },
    title: "fixture",
    uid: "linkedin-test",
    version: 3,
  };
}
const text = (d) => JSON.stringify(d, null, 2) + "\n";
const count = (s, needle) => s.split(needle).length - 1;

// ------------------------------------------------------------- push: placeholder -> uid

test("importing the script does not run the CLI", () => {
  // If it had, this process would have exited 2 on the missing token already.
  assert.equal(typeof placeholderToUid, "function");
  assert.equal(typeof uidToPlaceholder, "function");
  assert.equal(PG_DS_PLACEHOLDER, "${DS_LINKEDIN_PG}");
});

test("every placeholder becomes the uid, and nothing else in the file changes", () => {
  const before = text(fixture());
  assert.equal(count(before, PG_DS_PLACEHOLDER), 3);
  const pushed = placeholderToUid(before, FAKE_UID);
  assert.equal(count(pushed, PG_DS_PLACEHOLDER), 0);
  assert.equal(count(pushed, `"uid": "${FAKE_UID}"`), 3);
  assert.equal(pushed, text(fixture(FAKE_UID)));
  assert.deepEqual(JSON.parse(pushed), fixture(FAKE_UID));
});

test("the whole allowed uid alphabet is inserted literally", () => {
  // "$&" and friends cannot pass the uid check (see below); "-" and "_" can.
  assert.equal(placeholderToUid(`{"uid": "${PG_DS_PLACEHOLDER}"}`, "aZ09_b-c"), '{"uid": "aZ09_b-c"}');
});

test("a missing uid is a refusal, not a push with the placeholder left in", () => {
  for (const missing of [undefined, null, ""]) {
    assert.throws(() => placeholderToUid(text(fixture()), missing),
      /GRAFANA_PG_DATASOURCE_UID is not set — nothing pushed/);
  }
});

test("a malformed uid is a refusal — and the message never quotes it", () => {
  for (const bad of ["abc def", "abc\n", " abc", 'a"b', "a'b", "${x}", "$&", "a/b", "a.b", "уід"]) {
    assert.throws(() => placeholderToUid(text(fixture()), bad), (e) => {
      assert.match(e.message, /GRAFANA_PG_DATASOURCE_UID is not a datasource uid/);
      assert.match(e.message, /nothing pushed/);
      assert.ok(!e.message.includes(bad.trim()), "the uid must not reach a log");
      return true;
    });
  }
});

test("a file without the placeholder comes back untouched and needs no uid", () => {
  const legacy = fixture();
  legacy.panels[1].datasource = { ...INFINITY };
  legacy.panels[1].targets = [{ datasource: { ...INFINITY }, refId: "A", url: "https://example.invalid/stats.json" }];
  legacy.templating.list = [];
  const before = text(legacy);
  for (const uid of [undefined, "", "not a uid", FAKE_UID]) {
    assert.equal(placeholderToUid(before, uid), before);
  }
});

// ------------------------------------------------------------- dump: uid -> placeholder

test("a dump gets the placeholder back in every Postgres reference", () => {
  const live = fixture(FAKE_UID);
  const safe = uidToPlaceholder(live, FAKE_UID);
  assert.deepEqual(safe, fixture());
  assert.ok(!text(safe).includes(FAKE_UID));
  // pure: the caller's object is not modified
  assert.deepEqual(live, fixture(FAKE_UID));
});

test("push and dump are inverse", () => {
  const committed = text(fixture());
  const back = uidToPlaceholder(JSON.parse(placeholderToUid(committed, FAKE_UID)), FAKE_UID);
  assert.equal(text(back), committed);
});

// Every place a datasource uid can sit in a live dashboard. Only the first is
// recognisable without knowing the uid.
const UID_FORMS = {
  "typed { type, uid }": (d) => d,
  "type-less { uid }": (d) => { d.panels[1].datasource = { uid: FAKE_UID }; return d; },
  'legacy "datasource": "<uid>"': (d) => { d.panels[1].targets[0].datasource = FAKE_UID; return d; },
  "inside rawSql": (d) => { d.panels[1].targets[0].rawSql += ` -- ds ${FAKE_UID}`; return d; },
  "inside a link url": (d) => { d.links = [{ title: "explore", url: `/explore?left={"datasource":"${FAKE_UID}"}` }]; return d; },
};

test("a dump WITHOUT the variable refuses a dashboard that reads Postgres — in every form the uid can take", () => {
  for (const [form, mutate] of Object.entries(UID_FORMS)) {
    for (const missing of [undefined, ""]) {
      assert.throws(() => uidToPlaceholder(mutate(fixture(FAKE_UID)), missing), (e) => {
        assert.match(e.message, /GRAFANA_PG_DATASOURCE_UID is not set — nothing dumped/, form);
        assert.ok(!e.message.includes(FAKE_UID), form);
        return true;
      }, form);
    }
  }
});

test("a dump WITH the variable is safe or refuses, in every form the uid can take", () => {
  for (const [form, mutate] of Object.entries(UID_FORMS)) {
    let safe = null;
    try { safe = uidToPlaceholder(mutate(fixture(FAKE_UID)), FAKE_UID); }
    catch (e) { assert.match(e.message, /nothing dumped/, form); assert.ok(!e.message.includes(FAKE_UID), form); }
    if (safe) assert.ok(!text(safe).includes(FAKE_UID), form);
  }
});

test("a panel that has rawSql but no typed reference still counts as reading Postgres", () => {
  const live = fixture(FAKE_UID);
  live.panels[1].datasource = { uid: FAKE_UID };
  live.panels[1].targets[0].datasource = { uid: FAKE_UID };
  live.templating.list = [];
  assert.equal(readsPostgres(live), true);
  assert.throws(() => uidToPlaceholder(live, undefined), /is not set — nothing dumped/);
  const safe = uidToPlaceholder(live, FAKE_UID);
  assert.ok(!text(safe).includes(FAKE_UID));
});

test("the variable holds ANOTHER uid: an untyped reference it cannot vouch for is a refusal", () => {
  const OTHER = "some-other-pg_02";
  const live = fixture(FAKE_UID);
  live.panels[1].targets[0].datasource = { uid: FAKE_UID };          // type-less, and not the uid we were given
  assert.throws(() => uidToPlaceholder(live, OTHER), (e) => {
    assert.match(e.message, /have no type.*nothing dumped/);
    assert.ok(!e.message.includes(FAKE_UID) && !e.message.includes(OTHER));
    return true;
  });
  live.panels[1].targets[0].datasource = FAKE_UID;                   // legacy string, same story
  assert.throws(() => uidToPlaceholder(live, OTHER), /have no type.*nothing dumped/);
});

test("a dashboard that does NOT read Postgres dumps without the variable, untouched", () => {
  const legacy = { panels: [{ datasource: { ...INFINITY }, id: 1, targets: [{ datasource: "-- Mixed --", refId: "A" }] }], title: "legacy", uid: "linkedin-stats" };
  assert.equal(readsPostgres(legacy), false);
  for (const missing of [undefined, ""]) assert.deepEqual(uidToPlaceholder(legacy, missing), legacy);
});

test("with the variable set, a bare uid string outside a {type, uid} reference is swapped too", () => {
  const live = fixture(FAKE_UID);
  live.panels[1].targets[0].datasource = FAKE_UID;      // legacy string form
  const safe = uidToPlaceholder(live, FAKE_UID);
  assert.equal(safe.panels[1].targets[0].datasource, PG_DS_PLACEHOLDER);
  assert.ok(!text(safe).includes(FAKE_UID));
});

test("a dump leaves every other datasource and the dashboard's own uid alone", () => {
  const live = fixture(FAKE_UID);
  live.panels.push({ datasource: { ...INFINITY }, id: 3, targets: [{ datasource: { ...INFINITY }, refId: "A" }] });
  const safe = uidToPlaceholder(live, FAKE_UID);
  assert.deepEqual(safe.panels[2], live.panels[2]);
  assert.deepEqual(safe.annotations, live.annotations);
  assert.equal(safe.uid, "linkedin-test");
});

test("a dump refuses rather than write a uid it could not take out", () => {
  const live = fixture(FAKE_UID);
  live.title = `see ${FAKE_UID} for details`;            // uid buried in a longer string
  assert.throws(() => uidToPlaceholder(live, FAKE_UID), (e) => {
    assert.match(e.message, /nothing dumped/);
    assert.ok(!e.message.includes(FAKE_UID));
    return true;
  });
  assert.throws(() => uidToPlaceholder(fixture(FAKE_UID), "not a uid"), /not a datasource uid.*nothing dumped/);
});

// ------------------------------------------------------------- the repo itself

test("no checked-in dashboard carries a Postgres datasource uid — only the placeholder", () => {
  const files = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(dir, e.name));
      else if (e.name.endsWith(".json")) files.push(join(dir, e.name));
    }
  };
  walk(GRAFANA_DIR);
  assert.ok(files.length > 0);
  let refs = 0;
  for (const f of files) {
    const raw = readFileSync(f, "utf8");
    JSON.parse(raw, (_k, v) => {
      if (v && typeof v === "object" && v.type === PG_DS_TYPE) {
        refs++;
        assert.equal(v.uid, PG_DS_PLACEHOLDER, `${f}: a Postgres datasource uid is checked in`);
      }
      return v;
    });
    if (!raw.includes(PG_DS_PLACEHOLDER)) continue;
    const back = uidToPlaceholder(JSON.parse(placeholderToUid(raw, FAKE_UID)), FAKE_UID);
    assert.deepEqual(back, JSON.parse(raw), `${f}: push + dump is not the identity`);
  }
  assert.ok(refs > 0, "expected the SQL dashboards to reference the Postgres datasource");
});

// ------------------------------------------------------------- CLI against a loopback stub

function stubGrafana({ live } = {}) {
  const requests = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      requests.push({ method: req.method, url: req.url, body });
      res.setHeader("Content-Type", "application/json");
      if (req.method === "GET") {
        if (!live) { res.statusCode = 404; res.end(JSON.stringify({ message: "Dashboard not found" })); return; }
        res.end(JSON.stringify({ dashboard: live, meta: { folderUid: "folder-1" } }));
        return;
      }
      res.end(JSON.stringify({ status: "success", version: 8 }));
    });
  });
  return new Promise((ok) => {
    server.listen(0, "127.0.0.1", () => ok({
      requests,
      url: `http://127.0.0.1:${server.address().port}`,
      close: () => new Promise((done) => server.close(done)),
    }));
  });
}

// spawn, not spawnSync: the stub lives in this process and has to answer.
// The child gets ONLY the env listed here, so a real uid or token in the
// developer's shell cannot leak into a test.
function run(args, env) {
  return new Promise((ok) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, GRAFANA_SERVICE_ACCOUNT_TOKEN: "test-token", ...env },
    });
    let log = "";
    child.stdout.on("data", (c) => { log += c; });
    child.stderr.on("data", (c) => { log += c; });
    child.on("close", (code) => ok({ code, log }));
  });
}

let seq = 0;
function tmpFile(content) {
  const p = join(TMP, `dash-${++seq}.json`);
  if (content !== undefined) writeFileSync(p, content);
  return p;
}

test("CLI: placeholder in the file and no uid -> non-zero exit, clear message, Grafana never contacted", async () => {
  const g = await stubGrafana({ live: fixture(FAKE_UID) });
  try {
    const file = tmpFile(text(fixture()));
    for (const extra of [[], ["--dry-run"]]) {
      for (const env of [{}, { GRAFANA_PG_DATASOURCE_UID: "" }]) {
        const r = await run(["--uid", "linkedin-test", "--file", file, ...extra], { GRAFANA_URL: g.url, ...env });
        assert.notEqual(r.code, 0);
        assert.match(r.log, /GRAFANA_PG_DATASOURCE_UID is not set — nothing pushed/);
      }
    }
    assert.deepEqual(g.requests, []);
  } finally { await g.close(); }
});

test("CLI: malformed uid -> non-zero exit, Grafana never contacted, the value not logged", async () => {
  const g = await stubGrafana({ live: fixture(FAKE_UID) });
  try {
    const file = tmpFile(text(fixture()));
    const r = await run(["--uid", "linkedin-test", "--file", file], { GRAFANA_URL: g.url, GRAFANA_PG_DATASOURCE_UID: "oops uid\n" });
    assert.notEqual(r.code, 0);
    assert.match(r.log, /GRAFANA_PG_DATASOURCE_UID is not a datasource uid/);
    assert.ok(!r.log.includes("oops uid"));
    assert.deepEqual(g.requests, []);
  } finally { await g.close(); }
});

test("CLI: a push sends the uid, keeps the server's id/version, and leaves the file on disk alone", async () => {
  const g = await stubGrafana({ live: { ...fixture(FAKE_UID), id: 777, version: 5 } });
  try {
    const committed = text(fixture());
    const file = tmpFile(committed);
    const r = await run(["--uid", "linkedin-test", "--file", file], { GRAFANA_URL: g.url, GRAFANA_PG_DATASOURCE_UID: FAKE_UID });
    assert.equal(r.code, 0, r.log);
    assert.deepEqual(g.requests.map((q) => `${q.method} ${q.url}`), ["GET /api/dashboards/uid/linkedin-test", "POST /api/dashboards/db"]);
    const posted = JSON.parse(g.requests[1].body);
    assert.ok(!g.requests[1].body.includes(PG_DS_PLACEHOLDER), "the placeholder must not reach Grafana");
    assert.deepEqual(posted.dashboard, { ...fixture(FAKE_UID), id: 777, version: 5 });
    assert.equal(posted.overwrite, true);
    assert.equal(posted.folderUid, "folder-1");
    assert.equal(readFileSync(file, "utf8"), committed);
    assert.ok(!r.log.includes(FAKE_UID), "the uid must not reach a log");
  } finally { await g.close(); }
});

test("CLI: a dashboard that does not exist yet is created (404 on GET is not an error)", async () => {
  const g = await stubGrafana();
  try {
    const file = tmpFile(text(fixture()));
    const r = await run(["--uid", "linkedin-new", "--file", file], { GRAFANA_URL: g.url, GRAFANA_PG_DATASOURCE_UID: FAKE_UID });
    assert.equal(r.code, 0, r.log);
    const posted = JSON.parse(g.requests[1].body);
    assert.equal(posted.dashboard.uid, "linkedin-new");
    assert.equal(posted.dashboard.id, null);
    assert.ok(!g.requests[1].body.includes(PG_DS_PLACEHOLDER));
  } finally { await g.close(); }
});

test("CLI: --dry-run still reads the live dashboard and pushes nothing", async () => {
  const g = await stubGrafana({ live: fixture(FAKE_UID) });
  try {
    const file = tmpFile(text(fixture()));
    const r = await run(["--uid", "linkedin-test", "--file", file, "--dry-run"], { GRAFANA_URL: g.url, GRAFANA_PG_DATASOURCE_UID: FAKE_UID });
    assert.equal(r.code, 0, r.log);
    assert.match(r.log, /dry run — nothing pushed/);
    assert.deepEqual(g.requests.map((q) => q.method), ["GET"]);
  } finally { await g.close(); }
});

test("CLI: a file without the placeholder pushes exactly as before, no uid needed", async () => {
  const g = await stubGrafana({ live: { id: 9, version: 2, panels: [] } });
  try {
    const legacy = { panels: [{ datasource: { ...INFINITY }, id: 1, targets: [{ datasource: { ...INFINITY }, refId: "A" }] }], title: "legacy", uid: "linkedin-stats" };
    const file = tmpFile(text(legacy));
    const r = await run(["--uid", "linkedin-stats", "--file", file], { GRAFANA_URL: g.url });
    assert.equal(r.code, 0, r.log);
    assert.deepEqual(JSON.parse(g.requests[1].body).dashboard, { ...legacy, id: 9, version: 2 });
  } finally { await g.close(); }
});

test("CLI: --dump with the variable writes the placeholder, never the uid", async () => {
  const g = await stubGrafana({ live: fixture(FAKE_UID) });
  try {
    const out = tmpFile();
    const r = await run(["--uid", "linkedin-test", "--dump", out], { GRAFANA_URL: g.url, GRAFANA_PG_DATASOURCE_UID: FAKE_UID });
    assert.equal(r.code, 0, r.log);
    const dumped = readFileSync(out, "utf8");
    assert.ok(!dumped.includes(FAKE_UID));
    assert.equal(dumped, text(fixture()));
    assert.ok(!r.log.includes(FAKE_UID), "the uid must not reach a log");
  } finally { await g.close(); }
});

test("CLI: --dump WITHOUT the variable refuses (exit 2) and leaves the target file exactly as it was — in every form the uid can take", async () => {
  for (const [form, mutate] of Object.entries(UID_FORMS)) {
    const g = await stubGrafana({ live: mutate(fixture(FAKE_UID)) });
    try {
      for (const env of [{}, { GRAFANA_PG_DATASOURCE_UID: "" }]) {
        const out = tmpFile("COMMITTED\n");
        const r = await run(["--uid", "linkedin-test", "--dump", out], { GRAFANA_URL: g.url, ...env });
        assert.equal(r.code, 2, `${form}: ${r.log}`);
        assert.match(r.log, /GRAFANA_PG_DATASOURCE_UID is not set — nothing dumped/, form);
        assert.equal(readFileSync(out, "utf8"), "COMMITTED\n", `${form}: the file was written`);
        assert.ok(!r.log.includes(FAKE_UID), `${form}: the uid must not reach a log`);
      }
    } finally { await g.close(); }
  }
});

// --------------------------------------------------------------- folders
// Де опиняється дашборд. Наявний лишається там, де він є (щотижневий рефреш
// $post тримає ту саму обіцянку), новий — у налаштованій папці, бо інакше
// дашборд нового автора з'являвся б у General, поки решта лежить разом.

test("folder: a NEW dashboard goes to the configured folder, an existing one keeps its own", () => {
  // `moved` is about an existing dashboard changing folder — a brand-new one
  // is created there, which is not a move and is not worth a line in the log.
  assert.deepEqual(resolveFolder({ wanted: "fold-1", liveFolderUid: undefined, isNew: true }), { folderUid: "fold-1", moved: false });
  assert.deepEqual(resolveFolder({ wanted: "fold-1", liveFolderUid: "other", isNew: false }), { folderUid: "other" });
  assert.deepEqual(resolveFolder({ wanted: "fold-1", liveFolderUid: undefined, isNew: false }), { folderUid: undefined });
});

test("folder: --move is the explicit way to move an existing dashboard, and needs a folder", () => {
  assert.deepEqual(resolveFolder({ wanted: "fold-1", liveFolderUid: "other", isNew: false, move: true }), { folderUid: "fold-1", moved: true });
  // Уже там — не «переїзд», і в лозі про це не пишемо.
  assert.deepEqual(resolveFolder({ wanted: "fold-1", liveFolderUid: "fold-1", isNew: false, move: true }), { folderUid: "fold-1", moved: false });
  assert.throws(() => resolveFolder({ wanted: "", liveFolderUid: "other", isNew: false, move: true }), /--move needs a folder/);
  assert.throws(() => resolveFolder({ wanted: undefined, liveFolderUid: "other", isNew: false, move: true }), /--move needs a folder/);
});

test("folder: a missing variable is a warning for a new dashboard, never a failed onboarding", () => {
  assert.deepEqual(resolveFolder({ wanted: undefined, liveFolderUid: undefined, isNew: true }), { folderUid: undefined, warn: true });
  assert.deepEqual(resolveFolder({ wanted: "", liveFolderUid: undefined, isNew: true }), { folderUid: undefined, warn: true });
});

test("folder: a value that is not a uid is refused, not spliced into the request", () => {
  for (const bad of ["fold 1", "fold\n1", "https://x.grafana.net/dashboards/f/abc123/", "f/abc123", "'fold'", "fold\t"]) {
    assert.throws(() => resolveFolder({ wanted: bad, isNew: true }), /is not a uid/, bad);
  }
});

test("CLI: a new dashboard is created in GRAFANA_FOLDER_UID; --folder wins over the variable", async () => {
  for (const [args, env, want] of [
    [[], { GRAFANA_FOLDER_UID: "fold-env" }, "fold-env"],
    [["--folder", "fold-flag"], { GRAFANA_FOLDER_UID: "fold-env" }, "fold-flag"],
  ]) {
    const g = await stubGrafana();               // немає живого дашборда -> 404 -> новий
    try {
      const file = tmpFile(text(fixture()));
      const r = await run(["--uid", "linkedin-test", "--file", file, ...args], { GRAFANA_URL: g.url, GRAFANA_PG_DATASOURCE_UID: FAKE_UID, ...env });
      assert.equal(r.code, 0, r.log);
      const post = g.requests.find((q) => q.method === "POST");
      assert.equal(JSON.parse(post.body).folderUid, want);
    } finally { await g.close(); }
  }
});

test("CLI: an existing dashboard is NOT moved by the variable alone, and IS moved by --move", async () => {
  for (const [args, want] of [[[], "folder-1"], [["--move"], "fold-env"]]) {
    const g = await stubGrafana({ live: fixture(FAKE_UID) });   // stub reports folderUid "folder-1"
    try {
      const file = tmpFile(text(fixture()));
      const r = await run(["--uid", "linkedin-test", "--file", file, ...args], { GRAFANA_URL: g.url, GRAFANA_PG_DATASOURCE_UID: FAKE_UID, GRAFANA_FOLDER_UID: "fold-env" });
      assert.equal(r.code, 0, r.log);
      assert.equal(JSON.parse(g.requests.find((q) => q.method === "POST").body).folderUid, want);
    } finally { await g.close(); }
  }
});

test("CLI: a malformed folder refuses before anything is sent", async () => {
  const g = await stubGrafana({ live: fixture(FAKE_UID) });
  try {
    const file = tmpFile(text(fixture()));
    const r = await run(["--uid", "linkedin-test", "--file", file, "--move", "--folder", "not a uid"], { GRAFANA_URL: g.url, GRAFANA_PG_DATASOURCE_UID: FAKE_UID });
    assert.equal(r.code, 2, r.log);
    assert.match(r.log, /is not a uid/);
    assert.equal(g.requests.filter((q) => q.method === "POST").length, 0, "nothing may be pushed");
  } finally { await g.close(); }
});
