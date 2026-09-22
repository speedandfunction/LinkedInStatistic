#!/usr/bin/env python3
"""Неповний зчит списку реакцій — перевірка дією. Запуск: python3 test_short_read.py

2026-09-21: діалог реакцій відкрився, віддав нуль людей, і merge.py записав
reactor_count 14 -> 0 поверх доброго числа. Ніхто б по цю ціль не повернувся:
збережена ціль виглядає прочитаною. Правило тепер таке:

  short_read=True  -> лічильник НЕ опускається (max зі старим), прапорець стоїть
  short_read=False -> лічильник просто перезаписується, прапорець знімається

Прапорець читає selectPostTargets (people.mjs) — саме він повертає ціль у чергу
наступного прогону. T0 навмисно йде БЕЗ прапорця: інакше зелений T1 нічого не
доводив би, бо лічильник міг не впасти з якоїсь іншої причини.
"""
import json, os, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
MERGE = os.path.join(HERE, "merge.py")
failed = 0


def check(name, cond, detail=""):
    global failed
    print(f"{'OK  ' if cond else 'FAIL'}  {name}" + (f"  [{detail}]" if detail and not cond else ""))
    failed += 0 if cond else 1


def target(count, week, short=None):
    t = {"target_id": "post:urn:li:activity:1", "target_type": "post",
         "target_urn": "urn:li:activity:1", "target_url": "https://x/p",
         "week": week, "reactor_count": count}
    if short is not None:
        t["short_read"] = short
    return t


def merge(path, targets):
    r = subprocess.run([sys.executable, MERGE], text=True, capture_output=True,
                       input=json.dumps({"mode": "engagement", "path": path,
                                         "people": [], "events": [], "targets": targets}))
    if r.returncode != 0:
        check("merge.py ran", False, r.stderr.strip()[:200])
    with open(path) as f:
        return json.load(f)["targets"]["post:urn:li:activity:1"]


with tempfile.TemporaryDirectory() as d:
    # T0 (контроль): без прапорця лічильник падає, як і раніше — правило не
    # «ніколи не зменшувати», а «не зменшувати з неповного зчиту».
    p = os.path.join(d, "ctrl.json")
    merge(p, [target(14, "2026-09-14")])
    e = merge(p, [target(0, "2026-09-21")])
    check("T0 звичайний зчит, що віддав 0, лічильник опускає (контроль)",
          e["reactor_count"] == 0 and "short_read" not in e, json.dumps(e))

    # T1: те саме число, але зчит позначено неповним.
    p = os.path.join(d, "short.json")
    merge(p, [target(14, "2026-09-14")])
    e = merge(p, [target(0, "2026-09-21", short=True)])
    check("T1 неповний зчит НЕ опускає лічильник", e["reactor_count"] == 14, json.dumps(e))
    check("T1 ціль позначена short_read", e.get("short_read") is True, json.dumps(e))
    check("T1 last_scanned_week усе одно посунувся (ціль таки відкривали)",
          e["last_scanned_week"] == "2026-09-21", json.dumps(e))
    check("T1 first_scanned_week лишився замороженим",
          e["first_scanned_week"] == "2026-09-14", json.dumps(e))

    # T2: неповний зчит, що побачив БІЛЬШЕ за збережене, все одно підіймає число.
    e = merge(p, [target(20, "2026-09-28", short=True)])
    check("T2 неповний зчит із більшим числом підіймає лічильник",
          e["reactor_count"] == 20 and e.get("short_read") is True, json.dumps(e))

    # T3: повний зчит знімає прапорець — інакше ціль перечитувалась би вічно.
    e = merge(p, [target(17, "2026-10-05", short=False)])
    check("T3 повний зчит знімає прапорець і перезаписує лічильник",
          e["reactor_count"] == 17 and "short_read" not in e, json.dumps(e))

    # T4: перша поява цілі неповним зчитом — прапорець мусить бути одразу,
    # бо саме baseline-зчит найважливіше перечитати.
    p = os.path.join(d, "first.json")
    e = merge(p, [target(3, "2026-09-21", short=True)])
    check("T4 нова ціль із неповного зчиту одразу позначена",
          e["reactor_count"] == 3 and e.get("short_read") is True, json.dumps(e))

    # T5: нова ціль із повного зчиту прапорця не несе.
    p = os.path.join(d, "first-ok.json")
    e = merge(p, [target(3, "2026-09-21", short=False)])
    check("T5 нова ціль із повного зчиту без прапорця",
          e["reactor_count"] == 3 and "short_read" not in e, json.dumps(e))

    # T6: старі корпуси без ключа мають поводитись як повний зчит.
    p = os.path.join(d, "legacy.json")
    merge(p, [target(9, "2026-09-14", short=True)])
    e = merge(p, [target(4, "2026-09-21")])
    check("T6 запис без ключа short_read = повний зчит (знімає прапорець)",
          e["reactor_count"] == 4 and "short_read" not in e, json.dumps(e))

print(f"\n{'all short-read rules hold' if not failed else str(failed) + ' FAILED'}")
sys.exit(1 if failed else 0)
