#!/usr/bin/env python3
"""Opt-out — перевірка дією. Запуск: python3 test_opt_out.py

Людина, яка попросила себе видалити (#30), поверталась у корпус із кожним
читанням списку реакцій, де вона є: 2026-10-01 один прогін знову створив її
запис, дві події, два рядки у списках і файл профілю. Тепер merge.py — єдиний,
хто пише dashboards/li-stats/ — вирізає все, що належить ключам із LI_OPT_OUT,
у ЄДИНІЙ точці запису (write_atomic), для кожного режиму злиття. Лічильники не
чіпає: reactor_count лишається тим, що показує LinkedIn.

Ключ у тестах вигаданий. Справжні ключі живуть лише в змінній середовища.
"""
import io, json, os, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
MERGE = os.path.join(HERE, "merge.py")
sys.path.insert(0, HERE)
import merge  # noqa: E402  (person_key / scrub_opt_out — чисті функції)

failed = 0


def check(name, cond, detail=""):
    global failed
    print(f"{'OK  ' if cond else 'FAIL'}  {name}" + (f"  [{detail}]" if detail and not cond else ""))
    failed += 0 if cond else 1


def run(payload, env_extra):
    env = {**os.environ, **env_extra}
    r = subprocess.run([sys.executable, MERGE], input=json.dumps(payload), capture_output=True, text=True, env=env)
    if r.returncode != 0:
        raise SystemExit(f"merge.py failed: {r.stderr[-800:]}")
    return r.stdout


def load(path):
    with io.open(path, encoding="utf-8") as f:
        return json.load(f)


OUT = "in/gone-person"                     # вигаданий; у LI_OPT_OUT — як URL, щоб перевірити нормалізацію
KEEP = "in/stays-person"
U = lambda k: f"https://www.linkedin.com/{k}"
ENV = {"LI_OPT_OUT": " https://www.linkedin.com/IN/Gone-Person/ , in/other-gone "}

# ---- person_key: усі форми одного ключа збігаються ----
check("person_key: slug / in/slug / URL / percent-encoded / case", all(
    merge.person_key(v) == "in/gone-person" for v in
    ["gone-person", "in/gone-person", "IN/GONE-PERSON", "https://www.linkedin.com/in/Gone-Person/",
     "https://linkedin.com/in/gone%2Dperson?x=1", "/in/gone-person/recent-activity/"]))
check("person_key: не-особа → ''", all(merge.person_key(v) == "" for v in
      ["", "post:urn:li:activity:1", "https://www.linkedin.com/company/acme", "urn:li:comment:(1,2)"]))
check("opt_out_keys: розбір змінної", merge.opt_out_keys(ENV) == {"in/gone-person", "in/other-gone"})
check("opt_out_keys: порожньо → нікого", merge.opt_out_keys({"LI_OPT_OUT": ""}) == set() and merge.opt_out_keys({}) == set())

# ---- scrub: чиста функція ----
data = {"people": {OUT: {"key": OUT}, KEEP: {"key": KEEP}},
        "events": {"e1": {"person_key": OUT}, "e2": {"person_key": KEEP}},
        "weeks": {"2026-09-28": {"reactors": [U(OUT), U(KEEP)], "metrics": {"reactions": 13},
                                 "comments": [{"author_url": U(OUT), "text": "x"}, {"author_url": U(KEEP), "text": "y"}]}}}
s = merge.scrub_opt_out(data, {OUT})
check("scrub: запис people, подія, рядок списку, картка коментаря — зникли",
      OUT not in s["people"] and "e1" not in s["events"] and s["weeks"]["2026-09-28"]["reactors"] == [U(KEEP)]
      and [c["author_url"] for c in s["weeks"]["2026-09-28"]["comments"]] == [U(KEEP)])
check("scrub: решта і лічильники — як були", KEEP in s["people"] and "e2" in s["events"] and s["weeks"]["2026-09-28"]["metrics"]["reactions"] == 13)
check("scrub: вхід не змінено", OUT in data["people"] and len(data["weeks"]["2026-09-28"]["reactors"]) == 2)
check("scrub: без ключів — той самий об'єкт", merge.scrub_opt_out(data, set()) is data)

# ---- через merge.py, кожен режим, у тимчасовій теці ----
with tempfile.TemporaryDirectory() as d:
    eng = os.path.join(d, "engagement.json")
    with open(eng, "w") as f:
        json.dump({"people": {}, "events": {}, "targets": {}}, f)
    person = lambda k: {"key": k, "name": "Test Person", "profile_url": U(k), "headline": "h"}
    event = lambda i, k: {"event_id": f"reaction:urn:li:activity:1:{k}", "kind": "reaction", "target_type": "post",
                          "target_urn": "urn:li:activity:1", "target_url": "https://x/p", "person_key": k,
                          "occurred_at_ms": None, "attributed_week": "2026-09-21", "backfill": False}
    run({"mode": "engagement", "path": eng, "people": [person(OUT), person(KEEP)],
         "events": [event(1, OUT), event(2, KEEP)],
         "targets": [{"target_id": "post:urn:li:activity:1", "target_type": "post", "target_urn": "urn:li:activity:1",
                      "target_url": "https://x/p", "week": "2026-09-28", "reactor_count": 2}]}, ENV)
    e = load(eng)
    check("engagement: людини немає, її події немає, інша людина є",
          OUT not in e["people"] and KEEP in e["people"]
          and all(ev["person_key"] != OUT for ev in e["events"].values()) and len(e["events"]) == 1)
    check("engagement: reactor_count лишився 2 (лічильник не чіпаємо)",
          e["targets"]["post:urn:li:activity:1"]["reactor_count"] == 2)

    post = os.path.join(d, "post.json")
    with open(post, "w") as f:
        json.dump({"id": "1", "urn": "urn:li:activity:1", "weeks": {"2026-09-28": {"metrics": {"reactions": 2}}}}, f)
    run({"mode": "week_people", "week": "2026-09-28",
         "posts": [{"path": post, "reactors": [U(OUT), U(KEEP)], "commenters": [U(OUT)]}], "comments": []}, ENV)
    p = load(post)
    w = p["weeks"]["2026-09-28"]
    check("week_people: у списках лише ті, хто лишається", w.get("reactors") == [U(KEEP)] and w.get("commenters") == [])

    run({"mode": "post", "path": post, "week": "2026-10-05", "snapshot": {"metrics": {"reactions": 3},
         "comments": [{"author_url": U(OUT), "author_name": "Test Person", "text": "a"},
                      {"author_url": U(KEEP), "author_name": "Test Person", "text": "b"}]}}, ENV)
    p = load(post)
    check("post snapshot: картка коментаря людини вирізана, лічильник 3 лишився",
          [c["author_url"] for c in p["weeks"]["2026-10-05"]["comments"]] == [U(KEEP)]
          and p["weeks"]["2026-10-05"]["metrics"]["reactions"] == 3)
    check("post snapshot: попередній тиждень, уже чистий, таким і лишився", p["weeks"]["2026-09-28"]["reactors"] == [U(KEEP)])

    # без змінної — нічого не вирізається (той самий payload)
    post2 = os.path.join(d, "post2.json")
    with open(post2, "w") as f:
        json.dump({"id": "2", "urn": "urn:li:activity:2", "weeks": {}}, f)
    run({"mode": "week_people", "week": "2026-09-28",
         "posts": [{"path": post2, "reactors": [U(OUT), U(KEEP)], "commenters": None}], "comments": []},
        {"LI_OPT_OUT": ""})
    check("без LI_OPT_OUT: список повний", load(post2)["weeks"]["2026-09-28"]["reactors"] == [U(OUT), U(KEEP)])

print(f"\n{'FAILED ' + str(failed) if failed else 'all opt-out checks passed'}")
sys.exit(1 if failed else 0)
