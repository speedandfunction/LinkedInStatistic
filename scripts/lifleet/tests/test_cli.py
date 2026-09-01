"""Тести CLI та author_page: гарантії persist/record_session/release, exit codes."""
import json

import pytest

from lifleet import cli, registry
from lifleet.browser import SessionDead, author_page


def run(*argv) -> int:
    return cli.main(list(argv))


def _cookies_file(tmp_path, name="cookies.json"):
    p = tmp_path / name
    p.write_text(json.dumps([
        {"name": "li_at", "value": "AQED", "domain": ".linkedin.com",
         "expirationDate": 1793000000, "secure": True, "httpOnly": True,
         "sameSite": "no_restriction"},
    ]), encoding="utf-8")
    return str(p)


# --------------------------------------------------------------- add/list/drop

def test_add_creates_record_with_new_status(registry_file):
    assert run("add", "alex", "--name", "Alex") == 0
    rec = registry.get("alex")
    assert rec["status"] == "new"
    assert rec["context_id"] is None
    assert rec["country"] == "UA"
    assert rec["region"] == "eu-central-1"


def test_add_duplicate_slug_fails(registry_file):
    run("add", "alex", "--name", "Alex")
    assert run("add", "alex", "--name", "Alex Two") == 1


def test_list_and_drop_work_offline_without_keys(registry_file, monkeypatch, capsys):
    # Жодних ключів в оточенні — add/list/drop все одно працюють.
    monkeypatch.delenv("BROWSERBASE_API_KEY", raising=False)
    monkeypatch.delenv("BROWSERBASE_PROJECT_ID", raising=False)
    run("add", "alex", "--name", "Alex")
    assert run("list") == 0
    assert "alex" in capsys.readouterr().out
    assert run("drop", "alex") == 0
    assert "alex" not in registry.load()


def test_drop_unknown_slug_fails(registry_file):
    assert run("drop", "ghost") == 1


# --------------------------------------------------------------------- invite

def test_invite_creates_context_only_when_missing(env):
    run("add", "alex", "--name", "Alex")
    assert run("invite", "alex") == 0
    assert len(env.bb.contexts.create_calls) == 1
    ctx_id = registry.get("alex")["context_id"]
    assert ctx_id == "ctx_fake_1"

    # Повторний invite: context уже є — новий не створюється.
    assert run("invite", "alex") == 0
    assert len(env.bb.contexts.create_calls) == 1
    assert registry.get("alex")["context_id"] == ctx_id


def test_invite_disables_recording_check_enables_it(env):
    run("add", "alex", "--name", "Alex")
    run("invite", "alex")
    invite_call = env.bb.sessions.create_calls[0]
    assert invite_call["browser_settings"]["record_session"] is False
    # У invite капчу розв'язує людина — авто-солвер вимкнено.
    assert invite_call["browser_settings"]["solve_captchas"] is False
    assert invite_call["keep_alive"] is True
    assert invite_call["user_metadata"] == {"author": "alex", "kind": "invite"}
    # Лінк живе стільки, скільки замовили (дефолт 20 хв).
    assert env.bb.sessions.debug_calls[0]["expires_in"] == 20 * 60
    # І сесія переживає все вікно лінка + запас (інакше вб'є defaultTimeout).
    assert invite_call["api_timeout"] == 20 * 60 + 300

    run("check", "alex")
    check_call = env.bb.sessions.create_calls[-1]
    assert check_call["browser_settings"]["record_session"] is True
    assert check_call["browser_settings"]["solve_captchas"] is True
    assert check_call["keep_alive"] is False


def test_invite_updates_registry_after_probe(env):
    env.page.selectors["img.global-nav__me-photo"] = "Alex Orlyk"
    run("add", "alex", "--name", "Alex")
    assert run("invite", "alex") == 0
    rec = registry.get("alex")
    assert rec["status"] == "live"
    assert rec["identity"] == "Alex Orlyk"
    assert rec["last_ok"] is not None


def test_invite_session_released_even_on_failure(env):
    env.page.goto_url = "https://www.linkedin.com/login"
    run("add", "alex", "--name", "Alex")
    assert run("invite", "alex") == 1  # автор так і не залогінився
    assert env.bb.sessions.update_calls[-1]["status"] == "REQUEST_RELEASE"


# --------------------------------------------------------------------- import

def test_import_creates_context_loads_cookies_and_goes_live(env, tmp_path):
    env.page.selectors["img.global-nav__me-photo"] = "Alex Orlyk"
    run("add", "alex", "--name", "Alex")
    assert run("import", "alex", _cookies_file(tmp_path)) == 0
    # Context створено, куки залито в браузер, реєстр оновлено.
    assert len(env.bb.contexts.create_calls) == 1
    assert env.page.context.added_cookies[0]["name"] == "li_at"
    rec = registry.get("alex")
    assert rec["status"] == "live"
    assert rec["identity"] == "Alex Orlyk"


def test_import_session_persists_and_no_recording(env, tmp_path):
    run("add", "alex", "--name", "Alex")
    run("import", "alex", _cookies_file(tmp_path))
    call = env.bb.sessions.create_calls[0]
    assert call["browser_settings"]["context"]["persist"] is True
    # Куки — auth-матеріал: запис сесії вимкнено.
    assert call["browser_settings"]["record_session"] is False


def test_import_releases_session_when_not_live(env, tmp_path):
    env.page.goto_url = "https://www.linkedin.com/login"
    run("add", "alex", "--name", "Alex")
    assert run("import", "alex", _cookies_file(tmp_path)) == 1
    assert env.bb.sessions.update_calls[-1]["status"] == "REQUEST_RELEASE"


def test_import_bad_file_fails_without_network(env, tmp_path):
    run("add", "alex", "--name", "Alex")
    bad = tmp_path / "bad.json"
    bad.write_text('[{"name":"a","value":"1","domain":".google.com"}]', encoding="utf-8")
    n = len(env.bb.sessions.create_calls)
    assert run("import", "alex", str(bad)) == 1  # немає куків LinkedIn
    assert len(env.bb.sessions.create_calls) == n  # сесію не піднімали


# ---------------------------------------------------------- friendly errors

def test_minutes_limit_prints_clean_message_not_traceback(env, monkeypatch, capsys):
    run("add", "alex", "--name", "Alex")
    run("invite", "alex")

    class BBError(Exception):
        status_code = 402

    def raise_minutes(**kwargs):
        raise BBError("Error code: 402 - Free plan browser minutes limit reached")

    monkeypatch.setattr(env.bb.sessions, "create", raise_minutes)
    assert run("check", "alex") == 2
    err = capsys.readouterr().err
    assert "browser minutes" in err.lower()
    assert "Traceback" not in err


def test_unknown_exception_still_raises(env, monkeypatch):
    run("add", "alex", "--name", "Alex")
    run("invite", "alex")

    def boom(**kwargs):
        raise ValueError("щось геть інше")

    monkeypatch.setattr(env.bb.sessions, "create", boom)
    with pytest.raises(ValueError):
        run("check", "alex")


# ---------------------------------------------------------------------- check

def test_check_exit_1_when_dead(env):
    run("add", "alex", "--name", "Alex")
    run("invite", "alex")
    env.page.goto_url = "https://www.linkedin.com/login"
    assert run("check", "alex") == 1
    assert registry.get("alex")["status"] == "dead"


def test_check_all_exit_0_when_everyone_live(env):
    run("add", "alex", "--name", "Alex")
    run("add", "bob", "--name", "Bob")
    run("invite", "alex")
    run("invite", "bob")
    assert run("check", "--all") == 0


def test_check_without_args_means_all(env):
    run("add", "alex", "--name", "Alex")
    run("invite", "alex")
    assert run("check") == 0


def test_check_flags_author_without_context(env):
    # Автор доданий, але invite ще не було → не live → exit 1, без мережі.
    run("add", "alex", "--name", "Alex")
    n_sessions = len(env.bb.sessions.create_calls)
    assert run("check", "--all") == 1
    assert len(env.bb.sessions.create_calls) == n_sessions  # сесію не створювали


def test_check_releases_session_even_when_probe_raises(env, monkeypatch):
    run("add", "alex", "--name", "Alex")
    run("invite", "alex")

    def boom(page):
        raise RuntimeError("probe exploded")

    monkeypatch.setattr("lifleet.probe.probe", boom)
    assert run("check", "alex") == 1
    assert env.bb.sessions.update_calls[-1]["status"] == "REQUEST_RELEASE"
    assert registry.get("alex")["status"] == "error"


# --------------------------------------------------------- persist скрізь

def test_every_session_create_persists_context(env, tmp_path):
    """Головна гарантія: persist=True у КОЖНОМУ sessions.create —
    invite, check і щоденний author_page."""
    run("add", "alex", "--name", "Alex")
    run("invite", "alex")
    run("import", "alex", _cookies_file(tmp_path))
    run("check", "alex")
    with author_page("alex"):
        pass
    assert len(env.bb.sessions.create_calls) == 4
    for call in env.bb.sessions.create_calls:
        assert call["browser_settings"]["context"]["persist"] is True


# --------------------------------------------------------------------- proxies

def test_proxies_sent_by_default(env, monkeypatch):
    monkeypatch.delenv("LIFLEET_PROXIES", raising=False)
    run("add", "alex", "--name", "Alex")
    run("invite", "alex")
    call = env.bb.sessions.create_calls[0]
    assert call["proxies"] == [{"type": "browserbase", "geolocation": {"country": "UA"}}]


def test_proxies_env_off_skips_proxies(env, monkeypatch):
    monkeypatch.setenv("LIFLEET_PROXIES", "off")
    run("add", "alex", "--name", "Alex")
    run("invite", "alex")
    assert "proxies" not in env.bb.sessions.create_calls[0]


def test_proxy_402_falls_back_without_proxies(env, monkeypatch):
    """Free plan без проксі: на 402 сесія створюється повторно без proxies,
    і решта сесій процесу одразу йдуть без них."""
    run("add", "alex", "--name", "Alex")
    real_create = env.bb.sessions.create

    def create_402_on_proxies(**kwargs):
        if "proxies" in kwargs:
            raise RuntimeError(
                "Error code: 402 - Proxies are not included in the free plan"
            )
        return real_create(**kwargs)

    monkeypatch.setattr(env.bb.sessions, "create", create_402_on_proxies)
    assert run("invite", "alex") == 0
    assert run("check", "alex") == 0
    # Усі успішні сесії — без проксі, і після першого 402 повторних спроб немає.
    assert len(env.bb.sessions.create_calls) == 2
    assert all("proxies" not in call for call in env.bb.sessions.create_calls)


# ---------------------------------------------------------------- author_page

def test_author_page_yields_page_and_releases(env):
    run("add", "alex", "--name", "Alex")
    run("invite", "alex")
    n_updates = len(env.bb.sessions.update_calls)
    with author_page("alex") as page:
        assert page is env.page
    assert len(env.bb.sessions.update_calls) == n_updates + 1
    assert env.bb.sessions.update_calls[-1]["status"] == "REQUEST_RELEASE"


def test_author_page_raises_session_dead_and_releases(env):
    run("add", "alex", "--name", "Alex")
    run("invite", "alex")
    env.page.goto_url = "https://www.linkedin.com/login"
    n_updates = len(env.bb.sessions.update_calls)
    with pytest.raises(SessionDead):
        with author_page("alex"):
            pass
    assert len(env.bb.sessions.update_calls) == n_updates + 1
    assert env.bb.sessions.update_calls[-1]["status"] == "REQUEST_RELEASE"


def test_author_page_without_context_raises_without_network(env):
    run("add", "alex", "--name", "Alex")
    with pytest.raises(SessionDead):
        with author_page("alex"):
            pass
    assert env.bb.sessions.create_calls == []


# ------------------------------------------------------------------ env-ключі

def test_missing_keys_give_clear_error_not_traceback(registry_file, monkeypatch, capsys):
    monkeypatch.delenv("BROWSERBASE_API_KEY", raising=False)
    monkeypatch.delenv("BROWSERBASE_PROJECT_ID", raising=False)
    run("add", "alex", "--name", "Alex")
    assert run("check", "alex") == 2
    err = capsys.readouterr().err
    assert "BROWSERBASE_API_KEY" in err


def test_unknown_author_gives_exit_1(registry_file):
    assert run("invite", "ghost") == 1
