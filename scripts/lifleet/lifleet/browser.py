"""Обгортки над Browserbase SDK + публічний API author_page.

Усе послідовно: безкоштовний план Browserbase дає 1 одночасну сесію,
будь-який паралелізм гарантовано ловить 429. Тому тут немає і не буде
ThreadPoolExecutor.
"""
import os
from contextlib import contextmanager

from . import registry
from . import probe as probe_mod

DEFAULT_REGION = "eu-central-1"
LOGIN_URL = "https://www.linkedin.com/login"


class MissingCredentials(RuntimeError):
    """Немає BROWSERBASE_API_KEY / BROWSERBASE_PROJECT_ID в оточенні."""


class SessionDead(RuntimeError):
    """Сесія автора не live — потрібен повторний invite."""


def get_client(bb=None):
    """Повертає клієнт Browserbase. Приймає готовий клієнт для тестів."""
    if bb is not None:
        return bb
    api_key = os.environ.get("BROWSERBASE_API_KEY")
    if not api_key:
        raise MissingCredentials(
            "не задано BROWSERBASE_API_KEY. Поклади ключі в .env і запусти через "
            "`op run --env-file .env -- <команда>`, або зроби "
            "`export BROWSERBASE_API_KEY=...` у поточній сесії терміналу. "
            "Дивись START-HERE.md, крок 3."
        )
    # Лінивий імпорт: add/list/drop і тести працюють без встановленого SDK.
    from browserbase import Browserbase

    return Browserbase(api_key=api_key)


def get_project_id() -> str:
    pid = os.environ.get("BROWSERBASE_PROJECT_ID")
    if not pid:
        raise MissingCredentials(
            "не задано BROWSERBASE_PROJECT_ID. Дивись START-HERE.md, кроки 1 і 3."
        )
    return pid


def _settings(context_id: str, *, record_session: bool, solve_captchas: bool = True,
              viewport: dict = None) -> dict:
    """browser_settings для sessions.create.

    persist=True обов'язковий у КОЖНІЙ сесії: без нього оновлені куки
    не пишуться назад у context і профіль протухає за тиждень.

    solve_captchas вимикаємо в invite: там капчу розв'язує жива людина,
    і авто-солвер Browserbase лише заважає (перехоплює кліки в віджеті).

    viewport={"width","height"} — менший viewport робить сторінку в Live View
    крупнішою (людині зручніше вводити логін/капчу). Зберігається на весь
    процес логіну, на відміну від CSS-зуму, який злітає при навігації.
    """
    s = {
        "context": {"id": context_id, "persist": True},
        "record_session": record_session,
        "solve_captchas": solve_captchas,
    }
    if viewport:
        s["viewport"] = viewport
    return s


def _proxies(country: str) -> list:
    """Проксі Browserbase з геолокацією країни автора."""
    return [{"type": "browserbase", "geolocation": {"country": country}}]


def _proxies_enabled() -> bool:
    """LIFLEET_PROXIES=off/0/false/no вимикає проксі (free plan їх не має)."""
    return os.environ.get("LIFLEET_PROXIES", "on").lower() not in ("off", "0", "false", "no")


def _is_proxy_payment_error(exc) -> bool:
    """402 від Browserbase: проксі не входять у поточний план."""
    if getattr(exc, "status_code", None) == 402:
        return True
    text = str(exc)
    return "402" in text and "prox" in text.lower()


# Після першого 402 більше не пробуємо проксі до кінця процесу,
# щоб check --all не ловив ту саму помилку на кожному авторі.
_proxy_fallback_active = False


def open_session(bb, project_id, slug, rec, *, keep_alive, record_session, kind,
                 solve_captchas=True, timeout_seconds=None, viewport=None):
    """Створює сесію на context автора. kind іде в user_metadata для дашборда.

    Проксі вмикаються, якщо дозволені (LIFLEET_PROXIES != off) і план їх має.
    На 402 «Proxies are not included» — автоматичний повтор без проксі.

    timeout_seconds → api_timeout: без нього сесія живе project defaultTimeout
    (типово 300 с) і вмирає посеред логіну автора — keep_alive на безкоштовному
    плані цього не рятує. Мінімум API — 60 с, максимум 21600 с.
    """
    global _proxy_fallback_active
    kwargs = dict(
        project_id=project_id,
        browser_settings=_settings(
            rec["context_id"],
            record_session=record_session,
            solve_captchas=solve_captchas,
            viewport=viewport,
        ),
        keep_alive=keep_alive,
        region=rec.get("region") or DEFAULT_REGION,
        user_metadata={"author": slug, "kind": kind},
    )
    if timeout_seconds is not None:
        kwargs["api_timeout"] = max(60, min(int(timeout_seconds), 21600))
    if _proxies_enabled() and not _proxy_fallback_active:
        try:
            return bb.sessions.create(
                proxies=_proxies(rec.get("country") or "UA"), **kwargs
            )
        except Exception as exc:
            if not _is_proxy_payment_error(exc):
                raise
            _proxy_fallback_active = True
            print(
                "[warn] план Browserbase не включає проксі — працюємо без них "
                "(трафік піде з датацентр-IP регіону сесії; вищий шанс challenge "
                "від LinkedIn). Платний план поверне проксі автоматично, "
                "а LIFLEET_PROXIES=off прибере це попередження."
            )
    return bb.sessions.create(**kwargs)


def connect_page(session):
    """CDP-підключення Playwright. Повертає (playwright, browser, page)."""
    # Лінивий імпорт з тієї ж причини, що й browserbase.
    from playwright.sync_api import sync_playwright

    pw = sync_playwright().start()
    try:
        b = pw.chromium.connect_over_cdp(session.connect_url)
        ctx = b.contexts[0]
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        return pw, b, page
    except Exception:
        pw.stop()
        raise


def close_all(pw, browser_obj):
    """Закриває браузер і зупиняє Playwright. Терпить None і помилки."""
    if browser_obj is not None:
        try:
            browser_obj.close()
        except Exception:
            pass
    if pw is not None:
        try:
            pw.stop()
        except Exception:
            pass


def release(bb, session_id, project_id):
    """REQUEST_RELEASE сесії. Помилки ковтаємо: подвійний реліз чи вже
    завершена сесія не мають валити прогін."""
    try:
        bb.sessions.update(session_id, status="REQUEST_RELEASE", project_id=project_id)
    except Exception as exc:
        print(f"[warn] не вдалося звільнити сесію {session_id}: {exc}")


@contextmanager
def author_page(slug: str, *, bb=None):
    """Контекст-менеджер для щоденних скриптів.

    Піднімає сесію на context автора, робить probe, кидає SessionDead,
    якщо статус не live, віддає page. У finally закриває браузер,
    зупиняє Playwright і релізить сесію. Оновлює реєстр по дорозі.
    """
    rec = registry.get(slug)
    if not rec.get("context_id"):
        raise SessionDead(f"{slug}: немає context_id — спочатку виконай invite")

    client = get_client(bb)
    project_id = get_project_id()
    session = open_session(
        client, project_id, slug, rec,
        keep_alive=False,
        record_session=True,
        kind="daily",
        # Скільки живе щоденна робоча сесія (дефолт 15 хв, налаштовується).
        timeout_seconds=int(os.environ.get("LIFLEET_SESSION_TIMEOUT", "900")),
    )
    pw = br = None
    try:
        pw, br, page = connect_page(session)
        status, identity = probe_mod.probe(page)
        fields = {"status": status, "last_check": registry.utcnow_iso()}
        if identity:
            fields["identity"] = identity
        if status == "live":
            fields["last_ok"] = fields["last_check"]
        registry.patch(slug, **fields)
        if status != "live":
            raise SessionDead(f"{slug}: статус '{status}' — потрібен invite")
        yield page
    finally:
        close_all(pw, br)
        release(client, session.id, project_id)
