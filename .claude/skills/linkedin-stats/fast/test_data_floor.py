#!/usr/bin/env python3
"""Нижня межа дат у merge.py — перевірка дією. Запуск: python3 test_data_floor.py

T0 навмисно йде БЕЗ межі і має зберегти старий запис: інакше зелений T1 нічого б
не доводив — старе могло відсіюватись з якоїсь іншої причини.
"""
import json, os, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
MERGE = os.path.join(HERE, "merge.py")
OLD_MS, NEW_MS = 1714521600000, 1768003200000          # 2024-05-01, 2026-01-10 (UTC)
failed = 0

def run(payload, floor):
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
        json.dump({} if floor is None else {"data_floor": floor}, f); cfg = f.name
    try:
        return subprocess.run([sys.executable, MERGE], input=json.dumps(payload), text=True,
                              capture_output=True, env={**os.environ, "LI_CONFIG_FILE": cfg})
    finally:
        os.unlink(cfg)

def check(name, cond, detail=""):
    global failed
    print(f"{'OK  ' if cond else 'FAIL'}  {name}" + (f"  [{detail}]" if detail and not cond else ""))
    failed += 0 if cond else 1

def comment(urn, ms):
    return {"comment_urn": urn, "commented_at_ms": ms, "verb": "commented", "text": "t",
            "comment_author_name": "n", "comment_author_url": "u", "post_urn": "urn:li:activity:1",
            "post_url": "p", "post_author_name": "a", "post_author_url": "au",
            "reactions": 1, "replies_count": 0, "impressions": 5}

with tempfile.TemporaryDirectory() as d:
    # --- T0 / T1: коментарі
    for floor, expect, label in ((None, {"old", "new"}, "T0 без межі старий коментар зберігається (контроль)"),
                                 ("2025-11-01", {"new"}, "T1 з межею старий коментар відкинуто")):
        path = os.path.join(d, f"c-{floor}.json")
        r = run({"mode": "comments", "path": path, "week": "2026-09-14", "snapshot_cutoff_ms": 0,
                 "incoming": [comment("old", OLD_MS), comment("new", NEW_MS)]}, floor)
        got = set(json.load(open(path))["comments"]) if os.path.exists(path) else set()
        check(label, r.returncode == 0 and got == expect, f"rc={r.returncode} got={got} {r.stderr[-200:]}")
        if floor:
            import re
            m = re.search(r"NEW=(\d+) SNAPSHOTTED=(\d+)", r.stdout)     # той самий regex, що у скрейпері
            check("T1 рядок NEW=/SNAPSHOTTED= досі читається скрейпером", bool(m) and m.group(1) == "1", r.stdout)
            check("T1 відкинуте пораховано (BELOW_FLOOR=1)", "BELOW_FLOOR=1" in r.stdout, r.stdout)

    # --- T2: нові файли постів
    old_p, new_p = os.path.join(d, "old-post.json"), os.path.join(d, "new-post.json")
    r = run({"mode": "newfile", "path": old_p, "record": {"id": "1", "posted_date": "2024-05-01"}}, "2025-11-01")
    check("T2 пост до межі: відмова і файл не створено", r.returncode != 0 and not os.path.exists(old_p), f"rc={r.returncode}")
    r = run({"mode": "newfile", "path": new_p, "record": {"id": "2", "posted_date": "2026-01-10"}}, "2025-11-01")
    check("T2 пост після межі: записано", r.returncode == 0 and os.path.exists(new_p), r.stderr[-200:])
    r = run({"mode": "newfile", "path": os.path.join(d, "edge.json"), "record": {"id": "3", "posted_date": "2025-11-01"}}, "2025-11-01")
    check("T2 пост рівно в день межі: записано", r.returncode == 0, r.stderr[-200:])

    # --- T3: події взаємодії
    path = os.path.join(d, "eng.json")
    json.dump({"people": {"in/d": {"key": "in/d", "name": "D", "profile_url": "u", "headline": "h"}},
               "events": {}, "targets": {}}, open(path, "w"))
    person = lambda k: {"key": k, "name": k, "profile_url": "u", "headline": "h"}
    event = lambda eid, who, ms: {"event_id": eid, "kind": "comment" if ms else "reaction", "target_type": "post",
                                  "target_urn": "urn:li:activity:9", "target_url": "p", "person_key": who,
                                  "occurred_at_ms": ms, "attributed_week": "2026-09-14", "backfill": False}
    r = run({"mode": "engagement", "path": path,
             "people": [person("in/a"), person("in/b"), person("in/c"), person("in/d")],
             "events": [event("e-a", "in/a", OLD_MS), event("e-b", "in/b", NEW_MS),
                        event("e-c", "in/c", None), event("e-d", "in/d", OLD_MS)]}, "2025-11-01")
    data = json.load(open(path))
    check("T3 події до межі відкинуто, датована нова й недатована лишились",
          r.returncode == 0 and set(data["events"]) == {"e-b", "e-c"}, f"{set(data['events'])} {r.stderr[-200:]}")
    check("T3 людина лише з відкинутими подіями не записана, наявна — не зачеплена",
          set(data["people"]) == {"in/b", "in/c", "in/d"}, str(set(data["people"])))
    check("T3 відкинуте пораховано (BELOW_FLOOR=2)", "BELOW_FLOOR=2" in r.stdout, r.stdout)

    # --- T4: зіпсована межа не вимикає сторожа мовчки
    r = run({"mode": "newfile", "path": os.path.join(d, "x.json"), "record": {"id": "4", "posted_date": "2026-01-10"}}, "2025-11")
    check("T4 неправильний формат межі — гучна помилка", r.returncode != 0 and "data_floor" in (r.stderr + r.stdout), f"rc={r.returncode}")

print(f"\n{failed} FAILED" if failed else "\nall data-floor checks passed")
sys.exit(1 if failed else 0)
