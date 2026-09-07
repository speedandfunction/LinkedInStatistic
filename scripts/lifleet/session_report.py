"""Щоденна перевірка живості акаунтів + JSON-звіт для Slack-нотифаєра.

Чому не `lifleet check`: check — це таблиця для людини і exit 1, щойно хтось
не live (cli.py:205). Для щоденного монітора червоний прогін кожного дня,
доки людина не перелогінилась, — це шум, який привчає ігнорувати листи про
падіння. Тут повідомлення робить Slack, а exit-код відповідає лише на питання
«чи взагалі відбулась перевірка».

Що робить прогін:
  1. послідовно (інакше 429 — план дає мало одночасних сесій) перевіряє
     кожного автора через cli._check_one, з людською паузою між авторами;
  2. лише ПІСЛЯ всіх перевірок мінтить Live View лінки тим, кого розлогінило
     (dead/challenge), і не більше ніж LIFLEET_MAX_INVITES_PER_RUN (дефолт 1).
     Порядок не косметичний: keep_alive лінк займає слот одночасності на всі
     свої 25 хвилин, тож мінт усередині циклу перевірок гарантовано ловить 429
     на наступному авторі. З тієї ж причини лінк за прогін лише один — див.
     max_invites();
  3. пише звіт у --out і друкує людський підсумок БЕЗ жодного URL.

Live View URL — це фактично ключі від залогіненого браузера автора на
наступні 20 хвилин. Тому він живе тільки у файлі звіту (0600, поза робочим
деревом — шлях дає воркфлоу) і далі в Slack. У stdout його немає ніколи:
логи GitHub Actions бачить кожен, хто має доступ до репо.

Аргументи ТІЛЬКИ у формі --key=value. У репо співіснують два несумісні
парсери аргументів, і пробіл замість `=` вже коштував одного мовчазного
провалу — тому тут пробільна форма не «майже працює», а явно відхиляється.

Запуск:
    python session_report.py --out=/шлях/session-report.json
    python session_report.py --out=... --minutes=20 --only=peter,maria
    python session_report.py --out=... --no-invite   # тільки перевірка, без лінків

Env: BROWSERBASE_API_KEY, BROWSERBASE_PROJECT_ID, LIFLEET_REGISTRY
     (або LIFLEET_AUTHORS — аліас, який уже виставляє weekly-воркфлоу),
     LIFLEET_MAX_INVITES_PER_RUN (дефолт 1 — див. max_invites()).
"""
import json
import os
import random
import re
import sys
from pathlib import Path
from types import SimpleNamespace

from lifleet import browser, cli, invite as invite_mod, registry

USAGE = (
    "Запуск: python session_report.py --out=<файл.json> "
    "[--minutes=20] [--only=slug1,slug2] [--no-invite]"
)

# Кому і тільки кому мінтимо лінк. error/unknown навмисно не тут: людина не
# може нічого зробити з мережевим таймаутом, а лінк на неперевіреному діагнозі
# спалює 25 хвилин оплаченого часу браузера. Про таких авторів нотифаєр каже
# оператору, не смикаючи автора.
RELOGIN_STATUSES = ("dead", "challenge")

MAX_INVITES_ENV = "LIFLEET_MAX_INVITES_PER_RUN"
# ОДИН. Не «поки що один», а один, доки хтось не перевірить ліміт одночасних
# сесій плану руками і не запише результат сюди. Значення більше за 1 —
# обіцянка, якої акаунт не може дотримати: див. max_invites().
MAX_INVITES_DEFAULT = 1

_ARG_RE = re.compile(r"^--([a-z][a-z0-9-]*)(?:=(.*))?$")


class Usage(ValueError):
    """Аргументи командного рядка не такі, як цей скрипт уміє читати."""


class RunAborted(RuntimeError):
    """Перевірка не відбулась цілком — часткову картину в Slack не віддаємо."""


def registry_path_alias() -> None:
    """Дозволяє LIFLEET_AUTHORS як синонім LIFLEET_REGISTRY.

    Пастка, на якій легко згоріти: node-бекенд читає LIFLEET_AUTHORS або
    LIFLEET_REGISTRY (browserbase-backend.mjs:24), а Python-реєстр —
    ТІЛЬКИ LIFLEET_REGISTRY (registry.py:26). Weekly-воркфлоу виставляє
    перше ім'я, тож без цієї трансляції новий крок у тому ж воркфлоу мовчки
    читав би ./authors.json, якого в чекауті немає, і бачив би порожній реєстр.
    """
    if not os.environ.get("LIFLEET_REGISTRY") and os.environ.get("LIFLEET_AUTHORS"):
        os.environ["LIFLEET_REGISTRY"] = os.environ["LIFLEET_AUTHORS"]


def max_invites() -> int:
    """Скільки лінків максимум за один прогін. Дефолт — 1, і це не обережність.

    Кожен keep_alive лінк тримає слот одночасності ВСІ свої minutes+5 хвилин —
    і тримає їх ПІСЛЯ того, як прогін і його concurrency-група вже завершились.
    Ніяка concurrency-група це не серіалізує: група живе, поки живе job, а
    сесія — поки живе api_timeout. Тому:

      * free plan (1 одночасна сесія, START-HERE.md §8) — другий мінт ловить
        429 гарантовано, тобто дефолт 3 обіцяв три лінки, з яких доїжджав один;
      * базовий план (~$39, «кілька одночасних») — три лінки з'їдають увесь
        запас акаунта на 25 хвилин, і наступний, хто попросить сесію, отримає
        429. Найгірший варіант цього «наступного» — ручний перезапуск
        linkedin-stats-weekly вранці в понеділок: він не зробить снапшот, а
        тиждень аналітики LinkedIn не бекфілиться. Монітор, який ламає той
        самий скрейп, який захищає, — це чистий мінус.

    Ліміт заодно тримає найгірший місяць: 25 хв × 30 днів ≈ 12 год із 100
    на акаунт, які ще й ділимо з тижневим скрейпом.

    Підняти вище 1 можна лише після того, як ліміт одночасності плану
    перевірено руками, — і тоді це рішення документується тут, а не в змінній.
    """
    raw = os.environ.get(MAX_INVITES_ENV, str(MAX_INVITES_DEFAULT))
    try:
        return max(0, int(raw))
    except ValueError:
        return MAX_INVITES_DEFAULT


def _need_value(key, value) -> str:
    """Значення обов'язкове. Окремо ловимо пробільну форму: `--out шлях`
    інакше з'їдається як прапорець без значення, а шлях — як зайвий аргумент."""
    if value is None:
        raise Usage(
            f"--{key} без '=': значення пишеться як --{key}=<...>, "
            "пробіл не підтримується"
        )
    if not value:
        raise Usage(f"--{key}= потребує значення")
    return value


def parse_args(argv) -> SimpleNamespace:
    """Розбирає --key=value. Будь-яка інша форма — помилка, не здогадка."""
    out = None
    minutes = invite_mod.DEFAULT_MINUTES
    only = None
    no_invite = False
    for arg in argv:
        m = _ARG_RE.match(arg)
        if not m:
            raise Usage(f"аргумент {arg!r} не у формі --key=value")
        key, value = m.group(1), m.group(2)
        if key == "out":
            out = _need_value(key, value)
        elif key == "minutes":
            raw = _need_value(key, value)  # поза try: Usage — теж ValueError
            try:
                minutes = int(raw)
            except ValueError:
                raise Usage("--minutes= потребує цілого числа хвилин")
            if minutes < 1:
                raise Usage("--minutes= має бути додатнім")
        elif key == "only":
            only = [s.strip() for s in _need_value(key, value).split(",") if s.strip()]
            if not only:
                raise Usage("--only= потребує списку slug через кому")
        elif key == "no-invite":
            if value:
                raise Usage("--no-invite не приймає значення")
            no_invite = True
        else:
            raise Usage(f"невідомий аргумент --{key}")
    if not out:
        raise Usage("не задано --out=<файл.json>")
    return SimpleNamespace(out=out, minutes=minutes, only=only, no_invite=no_invite)


def build_report(slugs, *, minutes, mint=True, invite_cap=None) -> dict:
    """Перевіряє авторів і повертає звіт у форматі, який читає нотифаєр.

    Поля invite_url / invite_expires_at / session_id з'являються ТІЛЬКИ в
    авторів, яким справді треба перелогінитись — нотифаєр розрізняє випадки
    за наявністю ключа, тому порожніх null тут немає.

    invite_error — додаткове поле для чесності: «розлогінений і лінка немає»
    мусить відрізнятися від «розлогінений, ось лінк». Мовчазний пропуск
    автора — це рівно та тиша, проти якої монітор і будували.

    last_ok_source — теж про чесність, і про неї легко забути. last_ok береться
    з реєстру, а _check_one оновлює його ЛИШЕ живому автору (cli.py:238-239).
    У CI реєстр матеріалізується з секрету і знищується після прогону, тож для
    вилогіненого автора це завжди дата останнього ручного експорту секрету —
    вона тільки старішає і жодного стосунку до цього прогону не має. Позначаємо
    її як registry-snapshot, щоб нотифаєр не подавав її як спостереження.
    """
    bb = browser.get_client()
    project_id = browser.get_project_id()

    # Час зняття статусів. Ставимо на початку проходу: все нижче — вже наслідки.
    report = {"checked_at": registry.utcnow_iso(), "authors": []}
    need_link = []

    for i, slug in enumerate(slugs):
        if i:
            cli._sleep(random.uniform(4, 9))  # не довбемо LinkedIn чергою запитів
        rec = registry.get(slug)
        try:
            status, _identity = cli._check_one(bb, project_id, slug, rec)
        except Exception as exc:
            # browser.open_session стоїть ПОЗА try всередині _check_one
            # (cli.py:216-222), тож 402/429 із sessions.create прилітає сюди.
            # Це не «автор впав», а «прогін не відбувся»: автори до помилки
            # виглядали б живими, автори після неї — просто зникли б. Часткова
            # картина, подана як повна, гірша за її відсутність.
            friendly = cli._friendly_browserbase(exc)
            if friendly is None:
                raise  # невідома помилка — хай видно трейсбек для дебагу
            raise RunAborted(friendly)
        rec = registry.get(slug)  # _check_one щойно оновив last_ok/last_check
        item = {
            "slug": slug,
            "name": rec.get("name") or slug,
            "status": status,
            "last_ok": rec.get("last_ok"),
            # "this-run" — цей прогін щойно бачив автора живим і сам поставив
            # цю мітку. "registry-snapshot" — значення прийшло з реєстру, тобто
            # у CI з секрету; йому не можна вірити як спостереженню.
            "last_ok_source": "this-run" if status == "live" else "registry-snapshot",
        }
        report["authors"].append(item)
        if status in RELOGIN_STATUSES:
            need_link.append(item)

    if not mint:
        return report

    minted = 0
    # Коли звільниться браузерний слот, який ми самі й зайняли. Заповнюється
    # після першого ж мінта і потім розходиться в invite_wait_until тим, кому
    # лінка не дісталось: «лінк буде після 10:31» — це відповідь, з якою можна
    # щось зробити, а «спробуй сам» у той самий момент гарантовано дасть 429.
    slot_free_at = None
    for item in need_link:
        if invite_cap is not None and minted >= invite_cap:
            item["invite_error"] = (
                f"ліміт лінків на прогін ({MAX_INVITES_ENV}={invite_cap}) — "
                "лінк створить оператор вручну"
            )
            if slot_free_at:
                item["invite_error"] += f"; браузерний слот зайнятий до {slot_free_at}"
                item["invite_wait_until"] = slot_free_at
            # Раніше ця гілка не друкувала нічого, а звіт воркфлоу свідомо не
            # показує. «Чому для peter немає лінка» ставало питанням без сліду
            # в логах — а це рівно те питання, яке ставлять о 09:00.
            print(
                f"[warn] {item['slug']}: лінк не створено: {item['invite_error']}",
                file=sys.stderr,
            )
            continue
        if minted:
            cli._sleep(random.uniform(4, 9))
        try:
            link = invite_mod.mint_invite(item["slug"], minutes, bb=bb)
        except Exception as exc:
            # Лінк не з'явився, але автор усе одно розлогінений і Slack має про
            # це сказати. Тому прогін не валимо: пишемо причину в звіт.
            item["invite_error"] = str(exc)
            if slot_free_at:
                # Найімовірніша причина падіння тут — 429 від власного ж
                # попереднього лінка цього прогону, тож час звільнення слота
                # для автора корисніший за текст винятку.
                item["invite_wait_until"] = slot_free_at
            print(f"[warn] {item['slug']}: лінк не створено: {exc}", file=sys.stderr)
            continue
        minted += 1
        item["invite_url"] = link["liveview_url"]
        item["invite_expires_at"] = link["expires_at"]
        item["session_expires_at"] = link["session_expires_at"]
        item["session_id"] = link["session_id"]
        slot_free_at = link["session_expires_at"]
    return report


def write_report(report: dict, out_path: str) -> None:
    """Атомарний запис звіту з правами 0600.

    0600 виставляємо явно через os.open, а не покладаємось на umask раннера:
    у файлі лежать Live View URL, тобто повний інтерактивний доступ до
    залогіненого LinkedIn автора. .tmp + os.replace — щоб нотифаєр ніколи не
    прочитав напівзаписаний JSON (той самий прийом, що в registry.save).
    """
    p = Path(out_path)
    tmp = p.with_suffix(p.suffix + ".tmp")
    body = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(body)
    os.replace(tmp, p)


def print_summary(report: dict, out_path: str) -> None:
    """Людський підсумок у stdout. Жодного URL: логи CI читає весь репо."""
    fmt = "{:<14} {:<10} {:<27} {}"
    print(fmt.format("slug", "status", "last_ok", "link"))
    for item in report["authors"]:
        if item.get("invite_url"):
            link = "є (у звіті)"
        elif item.get("invite_error"):
            link = "НЕ створено"
        else:
            link = "-"
        print(fmt.format(item["slug"], item["status"], item.get("last_ok") or "-", link))

    down = [i["slug"] for i in report["authors"] if i["status"] in RELOGIN_STATUSES]
    stuck = [i["slug"] for i in report["authors"] if i["status"] in ("error", "unknown")]
    print(f"\nПеревірено: {len(report['authors'])}. Звіт: {out_path}")
    if down:
        print(f"Треба перелогінитись: {', '.join(down)}")
    if stuck:
        print(f"Не вдалося визначити (питання до оператора): {', '.join(stuck)}")
    if not down and not stuck:
        print("Усі живі.")


def main(argv=None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    try:
        opts = parse_args(argv)
    except Usage as exc:
        print(f"Помилка: {exc}\n{USAGE}", file=sys.stderr)
        return 2

    registry_path_alias()
    data = registry.load()
    if not data:
        # Порожній реєстр у CI означає, що секрет не доїхав. Мовчазний «нікого
        # перевіряти» тут — це зелений прогін, який нічого не перевірив.
        print(
            "Помилка: реєстр порожній або не знайдений "
            f"({registry.path()}). У CI його матеріалізує LIFLEET_AUTHORS_JSON.",
            file=sys.stderr,
        )
        return 2

    slugs = list(data)
    if opts.only:
        unknown = [s for s in opts.only if s not in data]
        if unknown:
            print(f"Помилка: немає в реєстрі: {', '.join(unknown)}", file=sys.stderr)
            return 2
        slugs = [s for s in slugs if s in opts.only]

    try:
        report = build_report(
            slugs,
            minutes=opts.minutes,
            mint=not opts.no_invite,
            invite_cap=max_invites(),
        )
    except KeyboardInterrupt:
        print("\nПерервано.", file=sys.stderr)
        return 130
    except RunAborted as exc:
        print(f"Помилка: {exc}", file=sys.stderr)
        return 2
    except browser.MissingCredentials as exc:
        print(f"Помилка: {exc}", file=sys.stderr)
        return 2
    except Exception as exc:
        friendly = cli._friendly_browserbase(exc)
        if friendly is None:
            raise  # невідома помилка — хай видно трейсбек для дебагу
        print(friendly, file=sys.stderr)
        return 2

    try:
        write_report(report, opts.out)
    except OSError as exc:
        # Звіту немає — нотифаєру нема з чого постити. Це провал прогону.
        print(f"Помилка: не вдалося записати звіт {opts.out}: {exc}", file=sys.stderr)
        return 1

    print_summary(report, opts.out)
    # Exit 0 навіть коли хтось розлогінений: розлогінений автор — це не збій
    # перевірки, це її результат, і сказати про нього має Slack. Ненульовий код
    # лишаємо для «перевірка не відбулась» — свідомо не так, як у lifleet check.
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
