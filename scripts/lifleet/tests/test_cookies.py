"""Тести нормалізації куків Cookie-Editor -> Playwright."""
import json

import pytest

from lifleet import cookies


def _write(tmp_path, data):
    p = tmp_path / "cookies.json"
    p.write_text(json.dumps(data), encoding="utf-8")
    return p


def test_normalizes_cookie_editor_export(tmp_path):
    p = _write(tmp_path, [
        {
            "name": "li_at", "value": "AQED...", "domain": ".www.linkedin.com",
            "path": "/", "expirationDate": 1793000000.5, "httpOnly": True,
            "secure": True, "sameSite": "no_restriction", "hostOnly": False,
            "session": False, "storeId": "0",
        },
    ])
    out = cookies.load_cookies(p)
    assert out == [{
        "name": "li_at", "value": "AQED...", "domain": ".www.linkedin.com",
        "path": "/", "httpOnly": True, "secure": True,
        "sameSite": "None", "expires": 1793000000,
    }]


def test_session_cookie_has_no_expires(tmp_path):
    p = _write(tmp_path, [
        {"name": "bcookie", "value": "x", "domain": ".linkedin.com",
         "session": True, "sameSite": "lax"},
    ])
    out = cookies.load_cookies(p)
    assert "expires" not in out[0]
    assert out[0]["sameSite"] == "Lax"


def test_filters_non_linkedin_cookies(tmp_path):
    p = _write(tmp_path, [
        {"name": "a", "value": "1", "domain": ".google.com"},
        {"name": "li_at", "value": "2", "domain": ".linkedin.com"},
    ])
    out = cookies.load_cookies(p)
    assert [c["name"] for c in out] == ["li_at"]


def test_accepts_wrapped_cookies_key(tmp_path):
    p = _write(tmp_path, {"cookies": [
        {"name": "li_at", "value": "2", "domain": ".linkedin.com"},
    ]})
    assert len(cookies.load_cookies(p)) == 1


def test_unspecified_samesite_becomes_lax(tmp_path):
    p = _write(tmp_path, [
        {"name": "li_at", "value": "2", "domain": ".linkedin.com",
         "sameSite": "unspecified"},
    ])
    assert cookies.load_cookies(p)[0]["sameSite"] == "Lax"


def test_no_linkedin_cookies_raises(tmp_path):
    p = _write(tmp_path, [{"name": "a", "value": "1", "domain": ".google.com"}])
    with pytest.raises(cookies.NoCookies):
        cookies.load_cookies(p)


def test_bad_shape_raises(tmp_path):
    p = _write(tmp_path, "not a list")
    with pytest.raises(cookies.NoCookies):
        cookies.load_cookies(p)


def test_skips_incomplete_entries(tmp_path):
    p = _write(tmp_path, [
        {"name": "li_at", "domain": ".linkedin.com"},  # без value
        {"value": "x", "domain": ".linkedin.com"},       # без name
        {"name": "ok", "value": "1", "domain": ".linkedin.com"},
    ])
    out = cookies.load_cookies(p)
    assert [c["name"] for c in out] == ["ok"]
