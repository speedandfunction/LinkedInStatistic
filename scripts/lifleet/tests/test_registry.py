"""Тести реєстру: roundtrip, patch, атомарність, невідомий slug."""
import json

import pytest

from lifleet import registry


def test_load_missing_file_returns_empty(registry_file):
    assert registry.load() == {}


def test_save_and_load_roundtrip(registry_file):
    registry.save({"alex": {"name": "Alex", "context_id": None}})
    data = registry.load()
    assert data["alex"]["name"] == "Alex"
    assert data["alex"]["context_id"] is None


def test_patch_updates_and_persists(registry_file):
    registry.save({"alex": {"name": "Alex", "status": "new"}})
    rec = registry.patch("alex", status="live", identity="Alex Orlyk")
    assert rec["status"] == "live"
    # patch зберігає на диск, не лише в пам'яті
    assert registry.load()["alex"]["identity"] == "Alex Orlyk"


def test_get_unknown_slug_raises(registry_file):
    registry.save({})
    with pytest.raises(registry.UnknownAuthor):
        registry.get("ghost")


def test_patch_unknown_slug_raises(registry_file):
    registry.save({})
    with pytest.raises(registry.UnknownAuthor):
        registry.patch("ghost", status="live")


def test_save_leaves_no_tmp_and_valid_json(registry_file):
    registry.save({"a": {"x": 1}})
    assert not registry_file.with_suffix(".tmp").exists()
    assert json.loads(registry_file.read_text(encoding="utf-8")) == {"a": {"x": 1}}


def test_save_goes_through_tmp_and_replace(registry_file, monkeypatch):
    """Запис атомарний: спочатку .tmp, потім os.replace на цільовий файл."""
    seen = {}
    real_replace = registry.os.replace

    def spy(src, dst):
        seen["src"], seen["dst"] = str(src), str(dst)
        real_replace(src, dst)

    monkeypatch.setattr(registry.os, "replace", spy)
    registry.save({"a": {}})
    assert seen["src"].endswith(".tmp")
    assert seen["dst"] == str(registry_file)
