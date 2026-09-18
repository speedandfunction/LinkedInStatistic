#!/usr/bin/env node
// The three merge rules that are NOT plain upserts, checked against merge.py's
// actual behaviour on a batch that contains the same entity twice.
//
// merge.py takes LISTS, so a duplicate inside one payload is reachable for the
// live writer even though today's engagement.json — a dict per key — cannot
// produce one. This is the case where "deduplicate the batch" silently becomes
// "pick the wrong row".
//
// The expected values below were produced by running merge.py itself:
//
//   $ python3 .claude/skills/linkedin-stats/fast/merge.py < payload.json
//   PEOPLE_NEW=1 PEOPLE_UPDATED=0 EVENTS_NEW=1 ICP_SET=0 TARGETS_NEW=1
//   person : {"name":"N","headline":"GOOD HEADLINE"}
//   event  : {"kind":"reaction","urn":"u1","week":"2026-01-05","backfill":true}
//   target : {"first_scanned_week":"2026-01-05","last_scanned_week":"2030-01-07","reactor_count":99}
//
// Everything here runs inside a transaction that is rolled back.
//
//   node db/test-merge-rules.mjs [--dsn <url>]

import { randomUUID } from "node:crypto";
import pg from "pg";
import { pgConfig } from "./pg-config.mjs";
import { foldPeople, foldTargets } from "./merge-rules.mjs";

pg.types.setTypeParser(20, (v) => Number(v));   // int8 -> number, as the other scripts do

function arg(name, def = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : def;
}
const DSN = arg("dsn", process.env.LI_DSN || "postgresql://postgres:devpw@localhost:55432/linkedin");

const c = new pg.Client(pgConfig(DSN));
await c.connect();
const fails = [];
const check = (what, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "OK  " : "FAIL"}  ${what}`);
  if (!ok) { console.log(`        merge.py: ${JSON.stringify(want)}`); console.log(`        db:       ${JSON.stringify(got)}`); fails.push(what); }
};

const run = randomUUID();
const AUTHOR = `__test_${run.slice(0, 8)}`;
try {
  await c.query("begin");
  await c.query(`insert into li.import_run (run_id, source) values ($1,'test-merge-rules')`, [run]);
  await c.query(`insert into li.author (author, display_name, profile_slug) values ($1,'T','in/t')`, [AUTHOR]);

  // ---- people: the first record seeds, an empty later value never overwrites
  const people = foldPeople([
    { key: "in/x", name: "N", profile_url: "https://u", headline: "GOOD HEADLINE" },
    { key: "in/x", name: "", profile_url: "", headline: "" },
  ]);
  await c.query(
    `select li.upsert_person($1,$2,now(),$3::text[],$4::text[],$5::text[],$6::text[],null,null)`,
    [AUTHOR, run, people.map((p) => p.key), people.map((p) => p.name),
     people.map((p) => p.profile_url), people.map((p) => p.headline)]);
  const p = (await c.query(`select name, headline from li.person where author=$1 and person_key='in/x'`, [AUTHOR])).rows[0];
  check("person: a duplicate with empty fields does not erase the headline",
    { name: p.name, headline: p.headline }, { name: "N", headline: "GOOD HEADLINE" });

  // ---- events: not folded at all. DO NOTHING keeps the FIRST of the pair.
  await c.query(
    `insert into li.engagement_event (author,event_id,kind,target_type,target_urn,person_key,
       attributed_week,backfill,first_seen_at,gate_week,run_id)
     values ($1,'E1','reaction','post','u1','in/x','2026-01-05',true ,now(),'2026-01-05',$2),
            ($1,'E1','comment' ,'post','u2','in/x','2030-01-07',false,now(),'2026-01-05',$2)
     on conflict do nothing`, [AUTHOR, run]);
  const e = (await c.query(`select kind, target_urn, to_char(attributed_week,'YYYY-MM-DD') week, backfill
                              from li.engagement_event where author=$1 and event_id='E1'`, [AUTHOR])).rows[0];
  check("event: a replayed id keeps the first sighting, not the last",
    e, { kind: "reaction", target_urn: "u1", week: "2026-01-05", backfill: true });

  // ---- scan targets: first_scanned_week frozen, the rest overwritten
  const targets = foldTargets([
    { target_id: "T1", target_type: "post", target_urn: "u1", target_url: null,
      first_scanned_week: "2026-01-05", last_scanned_week: "2026-01-05", reactor_count: 3 },
    { target_id: "T1", target_type: "post", target_urn: "u1", target_url: null,
      first_scanned_week: "2030-01-07", last_scanned_week: "2030-01-07", reactor_count: 99 },
  ]);
  await c.query(
    `select li.upsert_scan_target($1,$2,$3::text[],$4::text[],$5::text[],$6::text[],$7::date[],$8::date[],$9::bigint[])`,
    [AUTHOR, run, targets.map((t) => t.target_id), targets.map((t) => t.target_type),
     targets.map((t) => t.target_urn), targets.map((t) => t.target_url),
     targets.map((t) => t.first_scanned_week), targets.map((t) => t.last_scanned_week),
     targets.map((t) => t.reactor_count)]);
  const t = (await c.query(`select to_char(first_scanned_week,'YYYY-MM-DD') first, to_char(last_scanned_week,'YYYY-MM-DD') last, reactor_count
                              from li.scan_target where author=$1 and target_id='T1'`, [AUTHOR])).rows[0];
  check("scan target: first_scanned_week frozen, last week and count moved",
    t, { first: "2026-01-05", last: "2030-01-07", reactor_count: 99 });

  // ---- and the freeze survives a SECOND run that claims an earlier first week
  await c.query(
    `select li.upsert_scan_target($1,$2,array['T1'],array['post'],array['u1'],array[null]::text[],
                                  array['2020-01-06']::date[],array['2031-01-06']::date[],array[7]::bigint[])`,
    [AUTHOR, run]);
  const t2 = (await c.query(`select to_char(first_scanned_week,'YYYY-MM-DD') first from li.scan_target where author=$1 and target_id='T1'`, [AUTHOR])).rows[0];
  check("scan target: a later run cannot move first_scanned_week backwards", t2, { first: "2026-01-05" });

  // ---- person.first_seen_at never moves either
  await c.query(`select li.upsert_person($1,$2,now(),array['in/x'],array['N2'],array['https://u'],array['H2'],null,array['2000-01-01T00:00:00Z']::timestamptz[])`, [AUTHOR, run]);
  const p2 = (await c.query(`select to_char(first_seen_at,'YYYY') y, name from li.person where author=$1 and person_key='in/x'`, [AUTHOR])).rows[0];
  check("person: first_seen_at frozen while name still updates",
    p2, { y: String(new Date().getUTCFullYear()), name: "N2" });
} finally {
  await c.query("rollback").catch(() => {});
  await c.end();
}
if (fails.length) { console.error(`\n${fails.length} rule(s) do not match merge.py`); process.exit(1); }
console.log("\nall merge rules match merge.py");
