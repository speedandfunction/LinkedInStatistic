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

# Чому останній probe() віддав "error" / "unknown" — один рядок, без секретів.
# None після живого вердикту. Читають cli._check_one і session_report, бо
# "error" без причини у Slack читається як «не змогли — і не знаємо чому»
# (2026-10-11: один збій навігації у Марії, у звіті — лише знак питання).
last_error = None

# Дві спроби: звичайна й «коротша» — лише до першого байта відповіді. Один
# таймаут на проксі-сесії — не ознака розлогіненого акаунта, а на другий
# спробі сторінка вже зазвичай у кеші контексту.
GOTO_ATTEMPTS = (("domcontentloaded", 45_000), ("commit", 60_000))


def _from_url(url):
    """Вердикт лише з адреси, якщо вона вже все каже; інакше None."""
    url = url or ""
    if any(m in url for m in CHALLENGE_MARKERS):
        return "challenge"
    if any(m in url for m in DEAD_MARKERS):
        return "dead"
    if "/feed" in url:
        return "live"
    return None


def probe(page):
    """Повертає (status, identity).

    status: "live" | "dead" | "challenge" | "error" | "unknown"
    identity: alt аватарки з глобального меню — щоб переконатися,
    що context "andy" це справді Andy. None, якщо не вдалося витягти.
    """
    global last_error
    last_error = None
    exc = None
    for attempt, (wait_until, timeout) in enumerate(GOTO_ATTEMPTS, 1):
        try:
            page.goto(FEED_URL, wait_until=wait_until, timeout=timeout)
            page.wait_for_timeout(2_500)  # даємо редіректам і скриптам відпрацювати
            exc = None
            break
        except Exception as e:
            exc = e
            # Завантаження не дочекались, але редірект міг уже відбутись:
            # /login або /feed в адресі — вердикт і без повного завантаження.
            verdict = _from_url(getattr(page, "url", "") or "")
            if verdict:
                last_error = None
                return verdict, (_identity(page) if verdict == "live" else None)
    if exc is not None:
        last_error = "%s after %d attempt(s): %s" % (
            type(exc).__name__, len(GOTO_ATTEMPTS), str(exc).splitlines()[0][:160] if str(exc) else "")
        return "error", None

    url = page.url or ""
    verdict = _from_url(url)
    if verdict in ("challenge", "dead"):
        return verdict, None

    live = verdict == "live"
    if not live:
        try:
            live = page.query_selector("#global-nav") is not None
        except Exception:
            live = False
    if live:
        return "live", _identity(page)
    last_error = "landed on %s without a feed or a global nav" % (url or "an empty page")
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
