"""Тести probe: усі п'ять статусів + identity з фолбеком."""
from conftest import FakeElement, FakePage

from lifleet import probe as probe_mod
from lifleet.probe import probe


def test_live_by_feed_url_with_identity():
    page = FakePage(selectors={"img.global-nav__me-photo": "Alex Tester"})
    assert probe(page) == ("live", "Alex Tester")


def test_live_by_global_nav_when_url_is_not_feed():
    page = FakePage(
        goto_url="https://www.linkedin.com/",
        selectors={"#global-nav": FakeElement()},
    )
    status, identity = probe(page)
    assert status == "live"
    assert identity is None


def test_dead_on_login_redirect():
    page = FakePage(goto_url="https://www.linkedin.com/uas/login?session_redirect=%2Ffeed%2F")
    assert probe(page) == ("dead", None)


def test_dead_on_authwall():
    page = FakePage(goto_url="https://www.linkedin.com/authwall?trk=x")
    assert probe(page) == ("dead", None)


def test_challenge_on_checkpoint():
    page = FakePage(goto_url="https://www.linkedin.com/checkpoint/challenge/abc123")
    assert probe(page) == ("challenge", None)


def test_error_when_goto_raises_twice_and_the_reason_is_kept():
    page = FakePage(goto_exc=TimeoutError("navigation timeout"))
    assert probe(page) == ("error", None)
    assert len(page.goto_calls) == 2, "one retry, no more"
    assert page.goto_calls[1][1]["wait_until"] == "commit"
    assert probe_mod.last_error.startswith("TimeoutError after 2 attempt(s): navigation timeout")


def test_transient_timeout_then_live():
    # 2026-10-11: one navigation timeout on a proxied session read as "error" —
    # the account was logged in all along. The second attempt settles it.
    page = FakePage(goto_exc=TimeoutError("navigation timeout"), goto_exc_times=1,
                    selectors={"img.global-nav__me-photo": "Alex Tester"})
    assert probe(page) == ("live", "Alex Tester")
    assert probe_mod.last_error is None


def test_timeout_but_the_redirect_already_happened():
    # The load never finished, yet the page already sits on /login — that is a verdict.
    page = FakePage(goto_exc=TimeoutError("navigation timeout"),
                    url_after_exc="https://www.linkedin.com/uas/login?session_redirect=%2Ffeed%2F")
    assert probe(page) == ("dead", None)
    assert len(page.goto_calls) == 1
    assert probe_mod.last_error is None


def test_unknown_keeps_a_reason_too():
    page = FakePage(goto_url="https://www.linkedin.com/404")
    assert probe(page) == ("unknown", None)
    assert "404" in probe_mod.last_error


def test_unknown_on_weird_url_without_nav():
    page = FakePage(goto_url="https://www.linkedin.com/404")
    assert probe(page) == ("unknown", None)


def test_identity_fallback_selector():
    page = FakePage(
        selectors={"button.global-nav__primary-link-me-menu-trigger img": "Bob B"}
    )
    assert probe(page) == ("live", "Bob B")


def test_identity_never_breaks_status():
    # Селектор є, але get_attribute кидає — статус усе одно live.
    page = FakePage(
        selectors={"img.global-nav__me-photo": FakeElement(raise_on_get=True)}
    )
    assert probe(page) == ("live", None)
