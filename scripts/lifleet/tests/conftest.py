"""Фейки для офлайн-тестів: жодної мережі, жодних env-ключів.

FakeBrowserbase повторює сигнатури реального SDK (перевірені інтроспекцією),
FakePage — мінімум Playwright Page, потрібний для probe.
"""
from types import SimpleNamespace

import pytest

from lifleet import browser as browser_mod
from lifleet import cli as cli_mod


# ---------------------------------------------------------------- Browserbase

class FakeContexts:
    def __init__(self):
        self.create_calls = []
        self._n = 0

    def create(self, *, name=None, project_id=None):
        self._n += 1
        self.create_calls.append({"name": name, "project_id": project_id})
        return SimpleNamespace(id=f"ctx_fake_{self._n}")


class FakeSessions:
    def __init__(self):
        self.create_calls = []
        self.update_calls = []
        self.debug_calls = []
        self._n = 0

    def create(self, **kwargs):
        self._n += 1
        self.create_calls.append(kwargs)
        ctx = (kwargs.get("browser_settings") or {}).get("context") or {}
        return SimpleNamespace(
            id=f"sess_fake_{self._n}",
            connect_url=f"ws://fake-connect/{self._n}",
            context_id=ctx.get("id"),
            status="RUNNING",
        )

    def debug(self, id, *, expires_in):
        self.debug_calls.append({"id": id, "expires_in": expires_in})
        return SimpleNamespace(
            debugger_url=f"https://fake.debug/{id}",
            debugger_fullscreen_url=f"https://fake.debug/{id}/full",
            pages=[],
            ws_url=f"ws://fake.debug/{id}",
        )

    def update(self, id, *, status, project_id):
        self.update_calls.append({"id": id, "status": status, "project_id": project_id})

    def retrieve(self, id):
        return SimpleNamespace(id=id, status="RUNNING")


class FakeBrowserbase:
    def __init__(self, api_key="fake"):
        self.api_key = api_key
        self.contexts = FakeContexts()
        self.sessions = FakeSessions()


# ------------------------------------------------------------------ Playwright

class FakeElement:
    def __init__(self, attrs=None, raise_on_get=False):
        self.attrs = attrs or {}
        self.raise_on_get = raise_on_get

    def get_attribute(self, name):
        if self.raise_on_get:
            raise RuntimeError("selector detached")
        return self.attrs.get(name)


class FakeContext:
    """Мінімальний BrowserContext: записує залиті куки."""

    def __init__(self):
        self.added_cookies = None

    def add_cookies(self, cookies):
        self.added_cookies = list(cookies)


class FakePage:
    """Мінімальний Page: налаштовується url, редірект після goto,
    виняток при goto і наявність селекторів."""

    def __init__(self, url="about:blank", goto_url=None, goto_exc=None, selectors=None):
        self.url = url
        self.goto_url = goto_url  # куди «перекидає» після будь-якого goto
        self.goto_exc = goto_exc  # виняток, який кидає goto
        self.selectors = dict(selectors or {})  # селектор -> alt-рядок або FakeElement
        self.goto_calls = []
        self.context = FakeContext()

    def goto(self, url, **kwargs):
        self.goto_calls.append((url, kwargs))
        if self.goto_exc is not None:
            raise self.goto_exc
        self.url = self.goto_url or url

    def wait_for_timeout(self, ms):
        pass

    def query_selector(self, selector):
        value = self.selectors.get(selector)
        if value is None:
            return None
        if isinstance(value, FakeElement):
            return value
        return FakeElement({"alt": value})


class FakeBrowser:
    def __init__(self):
        self.closed = False

    def close(self):
        self.closed = True


class FakePlaywright:
    def __init__(self):
        self.stopped = False

    def stop(self):
        self.stopped = True


# ------------------------------------------------------------------- фікстури

@pytest.fixture(autouse=True)
def _reset_proxy_fallback(monkeypatch):
    """Глобальний фолбек «без проксі» не має перетікати між тестами."""
    monkeypatch.setattr(browser_mod, "_proxy_fallback_active", False)


@pytest.fixture
def registry_file(tmp_path, monkeypatch):
    """Ізольований реєстр у tmp — тести не чіпають реальний authors.json."""
    p = tmp_path / "authors.json"
    monkeypatch.setenv("LIFLEET_REGISTRY", str(p))
    return p


@pytest.fixture
def fake_bb():
    return FakeBrowserbase()


@pytest.fixture
def fake_page():
    return FakePage()


@pytest.fixture
def env(monkeypatch, registry_file, fake_bb, fake_page):
    """Повністю запряжене офлайн-середовище для CLI та author_page."""
    fb = FakeBrowser()
    fpw = FakePlaywright()
    monkeypatch.setattr(browser_mod, "get_client", lambda bb=None: fake_bb)
    monkeypatch.setattr(browser_mod, "get_project_id", lambda: "proj_fake")
    monkeypatch.setattr(browser_mod, "connect_page", lambda session: (fpw, fb, fake_page))
    monkeypatch.setattr(cli_mod, "_sleep", lambda seconds: None)
    monkeypatch.setattr("builtins.input", lambda *a, **k: "")
    return SimpleNamespace(
        bb=fake_bb, page=fake_page, browser=fb, pw=fpw, registry=registry_file
    )
