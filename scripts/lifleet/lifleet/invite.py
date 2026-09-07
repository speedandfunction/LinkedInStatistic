"""Мінт живого invite-посилання (Live View) на context автора.

Рецепт сесії логіну був продубльований у `lifleet invite` і в invite_link.py;
тепер він живе тут в одному місці, бо його викликає ще й щоденний монітор
(session_report.py). Дублювати цей рецепт утретє не можна: кожен його рядок —
це або гроші, або обіцянка автору.

Обіцянки, які цей модуль тримає:
  keep_alive=True        — сесія має пережити людину, а не наш процес;
  record_session=False   — людина вводить пароль, тож replay не існує;
  solve_captchas=False   — капчу розв'язує людина, авто-солвер перехоплює кліки;
  api_timeout            — все вікно лінка + 300 с запасу, інакше project
                           defaultTimeout (300 с) вб'є сесію посеред логіну.

Сесію тут НЕ релізимо і НЕ закриваємо: саме keep_alive тримає лінк живим,
а release/close його миттєво вб'ють. Прецедент — repair_login.py.

Context тут НЕ створюється. Автор без context_id — це той, кого свідомо не
логінили; автоматичний прогін не має права «розпаузити» його мовчки, тому
mint_invite кидає NoContext. Створення context лишилось у ручному шляху
оператора (invite_link.py, cli._ensure_context).
"""
import os
from datetime import datetime, timedelta, timezone

from . import browser, registry

# Дефолт як у `lifleet invite` (cli.py) і як у готовому тексті для автора
# в START-HERE.md («посилання живе 20 хвилин») — щоб людям не довелось
# тримати в голові два різні числа.
DEFAULT_MINUTES = 20


class NoContext(RuntimeError):
    """В автора немає context_id — його ще жодного разу не логінили."""


def login_viewport() -> dict:
    """Viewport сторінки входу для Live View.

    Менший viewport робить сторінку в Live View крупнішою — людині зручніше
    вводити логін і тикати в капчу. База 1280x800 при дефолтному зумі 159%
    дає ~805x503, але висоту лишаємо просторішою (капча-модалка висока).
    Підкрутити: LIFLEET_LOGIN_ZOOM / LIFLEET_VIEW_W / LIFLEET_VIEW_H.
    """
    zoom = float(os.environ.get("LIFLEET_LOGIN_ZOOM", "1.59"))
    width = int(os.environ.get("LIFLEET_VIEW_W", str(round(1280 / zoom))))
    height = int(os.environ.get("LIFLEET_VIEW_H", "820"))
    return {"width": width, "height": height}


def _iso_in(seconds: int) -> str:
    """Час «через N секунд» у тому ж форматі, що й registry.utcnow_iso()."""
    moment = datetime.now(timezone.utc) + timedelta(seconds=seconds)
    return moment.isoformat(timespec="seconds")


def mint_invite(slug: str, minutes: int = DEFAULT_MINUTES, *, bb=None) -> dict:
    """Піднімає keep_alive сесію на сторінці входу і повертає лінк для автора.

    Не блокується на input() і нічого не друкує: викликається і з операторського
    скрипта, і з CI, де будь-який print із URL — це витік облікових даних у лог.

    bb приймає готовий клієнт (як browser.get_client) — щоб виклик у циклі не
    плодив по клієнту на автора.

    Дві різні дати протухання, і плутати їх не можна. `expires_at` — це TTL
    самого ЛІНКА (sessions.debug(expires_in=...)); `session_expires_at` — коли
    помре сесія (api_timeout = minutes*60+300). Лінк помирає на 300 с раніше
    за сесію, і людині треба казати саме перше число. SessionLiveURLs власного
    поля протухання не має — рахуємо локально.
    """
    rec = registry.get(slug)
    if not rec.get("context_id"):
        raise NoContext(
            f"{slug}: немає context_id — автора ще не логінили. "
            f"Це навмисно ручна дія: `python invite_link.py {slug}` "
            f"або `lifleet invite {slug}`."
        )

    client = browser.get_client(bb)
    project_id = browser.get_project_id()
    session = browser.open_session(
        client, project_id, slug, rec,
        keep_alive=True,
        record_session=False,   # людина вводить пароль — replay не існує
        solve_captchas=False,   # капчу розв'язує людина
        timeout_seconds=minutes * 60 + 300,
        viewport=login_viewport(),
        kind="invite",
    )
    pw = None
    try:
        pw, _browser_obj, page = browser.connect_page(session)
        try:
            page.goto(browser.LOGIN_URL, wait_until="domcontentloaded")
        except Exception:
            pass  # сторінку входу автор побачить у будь-якому разі
        urls = client.sessions.debug(session.id, expires_in=minutes * 60)
    finally:
        # Тільки pw.stop(). НЕ browser_obj.close() і НЕ browser.release():
        # і те, і те вб'є сесію, а разом з нею — лінк, який автор ще не відкрив.
        # Сесія завершиться сама за api_timeout. Прецедент: repair_login.py.
        if pw is not None:
            try:
                pw.stop()
            except Exception:
                pass

    return {
        "slug": slug,
        "name": rec.get("name") or slug,
        "session_id": session.id,
        "liveview_url": urls.debugger_fullscreen_url,
        "minutes": minutes,
        "expires_at": _iso_in(minutes * 60),
        "session_expires_at": _iso_in(minutes * 60 + 300),
    }
