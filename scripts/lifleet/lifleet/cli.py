"""CLI lifleet: add / invite / check / list / drop.

Запуск: `python -m lifleet <команда>` або просто `lifleet <команда>`
після `pip install -e .`.
"""
import argparse
import os
import random
import sys
import time

from . import browser, cookies as cookies_mod, registry
from . import probe as probe_mod

# Окреме ім'я, щоб тести могли підмінити паузу без монкіпатчу модуля time.
_sleep = time.sleep

REGIONS = ["us-west-2", "us-east-1", "eu-central-1", "ap-southeast-1"]


def cmd_add(args) -> int:
    data = registry.load()
    if args.slug in data:
        print(f"Помилка: автор '{args.slug}' вже є в реєстрі.", file=sys.stderr)
        return 1
    data[args.slug] = {
        "name": args.name,
        "context_id": None,
        "country": args.country,
        "region": args.region,
        "status": "new",
        "identity": None,
        "last_ok": None,
        "last_check": None,
    }
    registry.save(data)
    print(f"Додано '{args.slug}'. Наступний крок: lifleet invite {args.slug}")
    return 0


def _ensure_context(bb, project_id, slug, rec):
    """Гарантує, що в автора є context. Створює один раз, повертає свіжий rec."""
    if rec.get("context_id"):
        return rec
    ctx = bb.contexts.create(name=f"lifleet-{slug}", project_id=project_id)
    registry.patch(slug, context_id=ctx.id)
    print(f"Створено новий context: {ctx.id}")
    return registry.get(slug)


def cmd_invite(args) -> int:
    slug = args.slug
    rec = registry.get(slug)
    bb = browser.get_client()
    project_id = browser.get_project_id()
    rec = _ensure_context(bb, project_id, slug, rec)

    session = browser.open_session(
        bb, project_id, slug, rec,
        keep_alive=True,
        # Обіцянка інструменту: replay того, що вводить автор, не існує.
        record_session=False,
        # Капчу в invite розв'язує людина — авто-солвер лише перехоплює кліки.
        solve_captchas=False,
        # Сесія має пережити весь вікно лінка + запас на probe, інакше
        # project defaultTimeout (300 с) вб'є її посеред логіну.
        timeout_seconds=args.minutes * 60 + 300,
        kind="invite",
    )
    pw = br = None
    try:
        pw, br, page = browser.connect_page(session)
        try:
            page.goto(browser.LOGIN_URL, wait_until="domcontentloaded")
        except Exception:
            pass  # сторінку входу автор побачить у будь-якому разі
        urls = bb.sessions.debug(session.id, expires_in=args.minutes * 60)
        line = "=" * 72
        print(f"""
{line}
  ПОСИЛАННЯ ДЛЯ АВТОРА ({rec['name']}) — живе {args.minutes} хв,
  запис сесії ВИМКНЕНО (record_session=False):

  {urls.debugger_fullscreen_url}

  1. Надішли це посилання автору (готовий текст — у START-HERE.md, крок 6).
  2. НЕ відкривай його сам, поки автор працює.
  3. Автор логіниться, проходить 2FA і відписує тобі «готово».
{line}
""")
        input("Коли автор відписав «готово» — натисни Enter для перевірки... ")
        status, identity = probe_mod.probe(page)
        fields = {"status": status, "last_check": registry.utcnow_iso()}
        if identity:
            fields["identity"] = identity
        if status == "live":
            fields["last_ok"] = fields["last_check"]
        registry.patch(slug, **fields)
        if status == "live":
            who = f", профіль: {identity}" if identity else ""
            print(f"OK {slug}: live{who}. Куки збережено в context.")
            return 0
        print(
            f"FAIL {slug}: статус '{status}'. Спробуй invite ще раз "
            "або дивись START-HERE.md, розділ «коли щось зламалось»."
        )
        return 1
    except KeyboardInterrupt:
        print("\nПерервано. Сесію буде звільнено.")
        return 130
    finally:
        # Реліз навіть при Ctrl+C — інакше висяча сесія з'їсть єдиний слот плану.
        browser.close_all(pw, br)
        browser.release(bb, session.id, project_id)


def cmd_import(args) -> int:
    """Залити куки LinkedIn у профіль автора замість інтерактивного логіну.

    Обхід капчі логіну на планах без проксі: автор логіниться у себе,
    експортує куки через Cookie-Editor і надсилає файл; пароль не передається.
    """
    slug = args.slug
    rec = registry.get(slug)
    try:
        cookie_list = cookies_mod.load_cookies(args.cookies_file)
    except (OSError, cookies_mod.NoCookies, ValueError) as exc:
        print(f"Помилка з файлом куків: {exc}", file=sys.stderr)
        return 1

    bb = browser.get_client()
    project_id = browser.get_project_id()
    rec = _ensure_context(bb, project_id, slug, rec)

    session = browser.open_session(
        bb, project_id, slug, rec,
        keep_alive=True,
        # Куки — це auth-матеріал; replay сесії не пишемо.
        record_session=False,
        timeout_seconds=300,
        kind="import",
    )
    pw = br = None
    try:
        pw, br, page = browser.connect_page(session)
        # Куки кладемо в контекст браузера, persist=True запише їх назад у context.
        page.context.add_cookies(cookie_list)
        print(f"Залито {len(cookie_list)} куків. Перевіряю сесію...")
        status, identity = probe_mod.probe(page)
        fields = {"status": status, "last_check": registry.utcnow_iso()}
        if identity:
            fields["identity"] = identity
        if status == "live":
            fields["last_ok"] = fields["last_check"]
        registry.patch(slug, **fields)
        if status == "live":
            who = f", профіль: {identity}" if identity else ""
            print(f"OK {slug}: live{who}. Куки збережено в context.")
            return 0
        print(
            f"FAIL {slug}: статус '{status}'. Найімовірніше куки протухли або "
            "неповні — попроси автора експортувати їх заново з відкритого "
            "linkedin.com (має бути залогінений)."
        )
        return 1
    finally:
        browser.close_all(pw, br)
        browser.release(bb, session.id, project_id)


def cmd_check(args) -> int:
    data = registry.load()
    # Без аргументів поводимось як --all: зручно для cron.
    slugs = list(data) if (args.all or not args.slugs) else list(args.slugs)
    unknown = [s for s in slugs if s not in data]
    if unknown:
        print(f"Помилка: немає в реєстрі: {', '.join(unknown)}", file=sys.stderr)
        return 1
    if not slugs:
        print("Реєстр порожній — нема кого перевіряти.")
        return 0

    bb = browser.get_client()
    project_id = browser.get_project_id()
    fmt = "{:<14} {:<10} {:<24} {}"
    print(fmt.format("slug", "status", "identity", "last_ok"))
    failed = []
    for i, slug in enumerate(slugs):
        if i:
            _sleep(random.uniform(4, 9))  # не довбемо LinkedIn чергою запитів
        rec = registry.get(slug)
        status, _ = _check_one(bb, project_id, slug, rec)
        rec = registry.get(slug)
        print(fmt.format(slug, status, rec.get("identity") or "-", rec.get("last_ok") or "-"))
        if status != "live":
            failed.append((slug, status))

    if failed:
        print("\nПотрібен invite:")
        for slug, status in failed:
            hint = ""
            if status == "challenge":
                hint = "  # спершу автор проходить верифікацію з телефона"
            print(f"  lifleet invite {slug}{hint}")
        return 1
    print("\nУсі живі.")
    return 0


def _check_one(bb, project_id, slug, rec):
    """Перевірка одного автора. Сесія релізиться завжди, навіть при винятку."""
    if not rec.get("context_id"):
        registry.patch(slug, status="new", last_check=registry.utcnow_iso())
        return "new", None

    session = browser.open_session(
        bb, project_id, slug, rec,
        keep_alive=False,
        record_session=True,
        kind="check",
        timeout_seconds=300,  # probe вкладається з великим запасом
    )
    pw = br = None
    status, identity = "error", None
    try:
        pw, br, page = browser.connect_page(session)
        status, identity = probe_mod.probe(page)
    except Exception as exc:
        print(f"[warn] {slug}: {exc}", file=sys.stderr)
        status, identity = "error", None
    finally:
        browser.close_all(pw, br)
        browser.release(bb, session.id, project_id)

    fields = {"status": status, "last_check": registry.utcnow_iso()}
    if identity:
        fields["identity"] = identity
    if status == "live":
        fields["last_ok"] = fields["last_check"]
    registry.patch(slug, **fields)
    return status, identity


def cmd_list(args) -> int:
    data = registry.load()
    if not data:
        print('Реєстр порожній. Додай автора: lifleet add <slug> --name "Ім\'я"')
        return 0
    fmt = "{:<14} {:<10} {:<27} {}"
    print(fmt.format("slug", "status", "last_ok", "context_id"))
    for slug, rec in data.items():
        print(fmt.format(
            slug,
            rec.get("status") or "-",
            rec.get("last_ok") or "-",
            rec.get("context_id") or "-",
        ))
    return 0


def cmd_drop(args) -> int:
    data = registry.load()
    if args.slug not in data:
        print(f"Помилка: автора '{args.slug}' немає в реєстрі.", file=sys.stderr)
        return 1
    rec = data.pop(args.slug)
    registry.save(data)
    print(f"'{args.slug}' прибрано з реєстру.")
    if rec.get("context_id"):
        print(
            f"Увага: context {rec['context_id']} лишився в Browserbase — "
            "якщо він більше не потрібен, видали його вручну в дашборді."
        )
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="lifleet",
        description="Пул LinkedIn-акаунтів через Browserbase Contexts. "
                    "Один автор = один персистентний профіль браузера в хмарі.",
    )
    sub = p.add_subparsers(dest="command", required=True)

    sp = sub.add_parser("add", help="додати автора в реєстр (без мережі)")
    sp.add_argument("slug", help="короткий ідентифікатор, напр. alex")
    sp.add_argument("--name", required=True, help="ім'я автора для людей")
    sp.add_argument("--country", default="UA", help="країна проксі (дефолт UA)")
    sp.add_argument(
        "--region",
        default=os.environ.get("LIFLEET_REGION", "eu-central-1"),
        choices=REGIONS,
        help="регіон Browserbase (дефолт LIFLEET_REGION або eu-central-1)",
    )
    sp.set_defaults(func=cmd_add)

    sp = sub.add_parser("invite", help="дати автору лінк на самостійний логін")
    sp.add_argument("slug")
    sp.add_argument("--minutes", type=int, default=20, help="час життя лінка (дефолт 20)")
    sp.set_defaults(func=cmd_invite)

    sp = sub.add_parser(
        "import",
        help="залити куки LinkedIn у профіль автора (обхід капчі логіну)",
    )
    sp.add_argument("slug")
    sp.add_argument("cookies_file", help="JSON-експорт куків із Cookie-Editor")
    sp.set_defaults(func=cmd_import)

    sp = sub.add_parser("check", help="перевірити живість сесій (exit 1, якщо хтось не live)")
    sp.add_argument("slugs", nargs="*", help="конкретні автори; без аргументів — усі")
    sp.add_argument("--all", action="store_true", help="перевірити всіх")
    sp.set_defaults(func=cmd_check)

    sp = sub.add_parser("list", help="показати реєстр (без мережі)")
    sp.set_defaults(func=cmd_list)

    sp = sub.add_parser("drop", help="прибрати автора з реєстру (без мережі)")
    sp.add_argument("slug")
    sp.set_defaults(func=cmd_drop)
    return p


def _friendly_browserbase(exc):
    """Перекладає помилку Browserbase API у зрозумілий текст.
    Повертає None, якщо це не помилка Browserbase — тоді хай спливає трейсбек."""
    code = getattr(exc, "status_code", None)
    if code is None:
        return None
    text = str(exc)
    low = text.lower()
    if code == 402 and "minute" in low:
        return (
            "Ліміт безкоштовного плану Browserbase вичерпано (browser minutes).\n"
            "Це НЕ втрата даних: залогінені профілі збережені в хмарі й нікуди не ділись.\n"
            "Далі: або дочекайся оновлення ліміту наступного місяця, або апгрейдни план — "
            "https://browserbase.com/plans (там же вмикаються проксі, що приберуть капчу)."
        )
    if code == 402:
        return f"Browserbase: ця дія потребує платного плану.\n{text}"
    if code == 429:
        return (
            "Browserbase 429: перевищено ліміт одночасних сесій (free plan = 1).\n"
            "Десь висить активна сесія — зупини її в дашборді (Sessions) і повтори."
        )
    return f"Browserbase API помилка {code}:\n{text}"


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except registry.UnknownAuthor as exc:
        print(
            f"Помилка: автора {exc.args[0]!r} немає в реєстрі. Дивись: lifleet list",
            file=sys.stderr,
        )
        return 1
    except browser.MissingCredentials as exc:
        print(f"Помилка: {exc}", file=sys.stderr)
        return 2
    except Exception as exc:
        friendly = _friendly_browserbase(exc)
        if friendly is None:
            raise  # невідома помилка — хай видно трейсбек для дебагу
        print(friendly, file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
