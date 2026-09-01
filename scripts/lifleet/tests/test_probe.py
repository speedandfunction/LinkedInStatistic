"""Тести probe: усі п'ять статусів + identity з фолбеком."""
from conftest import FakeElement, FakePage

from lifleet.probe import probe


def test_live_by_feed_url_with_identity():
    page = FakePage(selectors={"img.global-nav__me-photo": "Alex Orlyk"})
    assert probe(page) == ("live", "Alex Orlyk")


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


def test_error_when_goto_raises():
    page = FakePage(goto_exc=TimeoutError("navigation timeout"))
    assert probe(page) == ("error", None)


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
