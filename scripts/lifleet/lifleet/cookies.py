"""Нормалізація куків з експорту Cookie-Editor у формат Playwright.

Cookie-Editor (розширення для Chrome/Firefox) експортує масив об'єктів із
полями name/value/domain/path/expirationDate/hostOnly/sameSite/secure/...
Playwright add_cookies хоче трохи інший набір: expires замість expirationDate,
sameSite з великої літери, без службових полів.
"""
import json
from pathlib import Path

# Cookie-Editor -> Playwright
_SAMESITE = {
    "no_restriction": "None",
    "none": "None",
    "lax": "Lax",
    "strict": "Strict",
    "unspecified": "Lax",  # Playwright не приймає unspecified
    "": "Lax",
}


class NoCookies(ValueError):
    """У файлі не знайдено жодного придатного кука."""


def load_cookies(path) -> list:
    """Читає файл експорту і повертає нормалізований список для Playwright.

    Приймає як прямий масив куків, так і обгортку {"cookies": [...]}.
    Лишає тільки куки доменів LinkedIn.
    """
    raw = json.loads(Path(path).read_text(encoding="utf-8"))
    if isinstance(raw, dict):
        raw = raw.get("cookies", [])
    if not isinstance(raw, list):
        raise NoCookies("очікувався масив куків або {'cookies': [...]}")

    out = []
    for c in raw:
        norm = _normalize(c)
        if norm and "linkedin" in norm.get("domain", ""):
            out.append(norm)
    if not out:
        raise NoCookies(
            "не знайдено куків LinkedIn. Переконайся, що автор експортував "
            "куки з відкритого linkedin.com через Cookie-Editor."
        )
    return out


def _normalize(c: dict):
    name = c.get("name")
    value = c.get("value")
    domain = c.get("domain")
    if not name or value is None or not domain:
        return None

    out = {
        "name": name,
        "value": value,
        "domain": domain,
        "path": c.get("path") or "/",
        "httpOnly": bool(c.get("httpOnly", False)),
        "secure": bool(c.get("secure", False)),
        "sameSite": _SAMESITE.get(str(c.get("sameSite", "")).lower(), "Lax"),
    }
    # Сесійні куки (session=True або без expirationDate) лишаємо без expires.
    exp = c.get("expirationDate")
    if exp and not c.get("session", False):
        out["expires"] = int(exp)
    return out
