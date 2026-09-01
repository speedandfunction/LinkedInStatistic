"""Визначення живості LinkedIn-сесії.

Йдемо на стрічку і дивимось, куди нас у підсумку перекинуло.
"""

FEED_URL = "https://www.linkedin.com/feed/"

# Порядок перевірки важливий: challenge дивимось перед dead,
# бо checkpoint-URL може містити й інші маркери.
CHALLENGE_MARKERS = ("/checkpoint", "/challenge")
DEAD_MARKERS = ("/login", "/uas/login", "/authwall", "/signup")

# Селектори LinkedIn плавають, тому кілька варіантів і все у try/except.
IDENTITY_SELECTORS = (
    "img.global-nav__me-photo",
    "button.global-nav__primary-link-me-menu-trigger img",
)


def probe(page):
    """Повертає (status, identity).

    status: "live" | "dead" | "challenge" | "error" | "unknown"
    identity: alt аватарки з глобального меню — щоб переконатися,
    що context "alex" це справді Alex. None, якщо не вдалося витягти.
    """
    try:
        page.goto(FEED_URL, wait_until="domcontentloaded", timeout=45_000)
        page.wait_for_timeout(2_500)  # даємо редіректам і скриптам відпрацювати
    except Exception:
        return "error", None

    url = page.url or ""
    if any(m in url for m in CHALLENGE_MARKERS):
        return "challenge", None
    if any(m in url for m in DEAD_MARKERS):
        return "dead", None

    live = "/feed" in url
    if not live:
        try:
            live = page.query_selector("#global-nav") is not None
        except Exception:
            live = False
    if live:
        return "live", _identity(page)
    return "unknown", None


def _identity(page):
    """Спроба витягнути ім'я профілю з alt аватарки. Ніколи не кидає."""
    for sel in IDENTITY_SELECTORS:
        try:
            el = page.query_selector(sel)
            if el:
                alt = el.get_attribute("alt")
                if alt and alt.strip():
                    return alt.strip()
        except Exception:
            continue
    return None
