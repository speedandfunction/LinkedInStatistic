"""Переводить уже запущену Browserbase-сесію на форму email/пароль LinkedIn.

Соціальні кнопки (Google/Apple) у хмарному браузері не працюють (OAuth-попап
блокується). Цей скрипт під'єднується до наявної сесії за її id і веде її на
класичну сторінку входу з полями email+пароль.

Запуск: python repair_login.py <session_id>
"""
import os
import sys

from playwright.sync_api import sync_playwright

sid = sys.argv[1]
key = os.environ["BROWSERBASE_API_KEY"]
# Регіональний хост (сесії lifleet у eu-central-1 => euc1).
host = os.environ.get("BB_CONNECT_HOST", "connect.euc1.browserbase.com")
connect_url = f"wss://{host}?apiKey={key}&sessionId={sid}"

pw = sync_playwright().start()
try:
    browser = pw.chromium.connect_over_cdp(connect_url)
    ctx = browser.contexts[0]
    page = ctx.pages[0] if ctx.pages else ctx.new_page()
    print("BEFORE:", page.url)

    # Класична форма входу з email+паролем.
    page.goto("https://www.linkedin.com/login", wait_until="domcontentloaded", timeout=45000)
    page.wait_for_timeout(2500)
    try:
        page.evaluate("window.scrollTo(0, 0)")
    except Exception:
        pass

    has_email = False
    for sel in ("#username", "input[name='session_key']", "input[autocomplete='username']"):
        try:
            if page.query_selector(sel):
                has_email = True
                break
        except Exception:
            pass
    print("AFTER:", page.url)
    print("EMAIL_FIELD_PRESENT:", has_email)
finally:
    # Не закриваємо браузер і не релізимо: сесія лишається живою для користувача.
    try:
        pw.stop()
    except Exception:
        pass
