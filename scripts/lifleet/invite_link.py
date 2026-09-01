"""Згенерувати живе invite-посилання (Live View) для автора.

На відміну від `lifleet invite`, не блокується на input() — просто піднімає
keep_alive сесію на сторінці входу, друкує посилання і виходить, лишаючи
сесію живою (keep_alive тримає її до api_timeout). Автор відкриває лінк,
логіниться сам. Запис вимкнено; автосолвер капчі вимкнено (розв'язує людина).

Запуск: python invite_link.py <slug> [хвилини]
"""
import os
import sys

from lifleet import browser, registry

slug = sys.argv[1] if len(sys.argv) > 1 else "peter"
minutes = int(sys.argv[2]) if len(sys.argv) > 2 else 30

# Менший viewport => сторінка входу в Live View крупніша (зручніше вводити
# логін/капчу). База 1280x800, дефолтний зум 159% => ~805x503, але висоту
# лишаємо просторішою (капча-модалка висока). Підкрутити: LIFLEET_VIEW_W/H.
zoom = float(os.environ.get("LIFLEET_LOGIN_ZOOM", "1.59"))
view_w = int(os.environ.get("LIFLEET_VIEW_W", str(round(1280 / zoom))))
view_h = int(os.environ.get("LIFLEET_VIEW_H", "820"))
viewport = {"width": view_w, "height": view_h}

rec = registry.get(slug)
bb = browser.get_client()
project = browser.get_project_id()

if not rec.get("context_id"):
    ctx = bb.contexts.create(name=f"lifleet-{slug}", project_id=project)
    registry.patch(slug, context_id=ctx.id)
    rec = registry.get(slug)
    print("NEW_CONTEXT:", ctx.id)

session = browser.open_session(
    bb, project, slug, rec,
    keep_alive=True,
    record_session=False,   # людина вводить пароль — replay не існує
    solve_captchas=False,   # капчу розв'язує людина
    timeout_seconds=minutes * 60 + 300,
    viewport=viewport,      # крупніший вигляд у Live View
    kind="invite",
)
pw, br, page = browser.connect_page(session)
try:
    page.goto(browser.LOGIN_URL, wait_until="domcontentloaded")
except Exception:
    pass

urls = bb.sessions.debug(session.id, expires_in=minutes * 60)
print("AUTHOR:", rec["name"])
print("MINUTES:", minutes)
print("SESSION_ID:", session.id)
print("LIVEVIEW_URL:", urls.debugger_fullscreen_url)

# НЕ релізимо і не закриваємо браузер: keep_alive тримає сесію живою,
# щоб автор устиг залогінитись. Сесія сама завершиться за api_timeout.
