"""Разова демонстрація: залити куки в сесію і віддати Live View посилання.

Тримає сесію живою (keep_alive) і НЕ релізить її — щоб людина встигла
відкрити посилання й подивитися на залогінений LinkedIn на власні очі.
Сесія сама завершиться за api_timeout (10 хв).

Запуск: python demo_liveview.py <slug> <cookies.json>
"""
import sys

from lifleet import browser, registry
from lifleet import cookies as cookies_mod

slug = sys.argv[1] if len(sys.argv) > 1 else "oleksandr"
cookies_file = sys.argv[2] if len(sys.argv) > 2 else None

rec = registry.get(slug)
bb = browser.get_client()
project = browser.get_project_id()

# Створити профіль, якщо його ще нема (демо може бігти без попереднього import).
if not rec.get("context_id"):
    ctx = bb.contexts.create(name=f"lifleet-{slug}", project_id=project)
    registry.patch(slug, context_id=ctx.id)
    rec = registry.get(slug)
    print("NEW_CONTEXT:", ctx.id)

session = browser.open_session(
    bb, project, slug, rec,
    keep_alive=True, record_session=False,
    timeout_seconds=600, kind="liveview",
)
pw, br, page = browser.connect_page(session)
if cookies_file:
    page.context.add_cookies(cookies_mod.load_cookies(cookies_file))

try:
    page.goto("https://www.linkedin.com/feed/", wait_until="domcontentloaded", timeout=45000)
    page.wait_for_timeout(4000)
except Exception as exc:
    print("nav error:", exc)

urls = bb.sessions.debug(session.id, expires_in=600)
print("FINAL_URL:", page.url)
print("SESSION_ID:", session.id)
print("LIVEVIEW_URL:", urls.debugger_fullscreen_url)

# НЕ релізимо і не закриваємо браузер: keep_alive тримає сесію живою,
# щоб користувач устиг відкрити Live View. Просто виходимо.
