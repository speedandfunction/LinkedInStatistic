"""Реєстр авторів (authors.json).

Зберігає лише context_id і службові поля. Ніколи не зберігає пошту,
пароль чи куки — куки живуть усередині Browserbase Context, а не тут.
Запис атомарний: спочатку у файл .tmp, потім os.replace.
"""
import json
import os
from datetime import datetime, timezone
from pathlib import Path

DEFAULT_PATH = "./authors.json"


class UnknownAuthor(KeyError):
    """Автора з таким slug немає в реєстрі."""


def utcnow_iso() -> str:
    """Поточний час у UTC, ISO-8601 із секундами."""
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def path() -> Path:
    """Шлях до реєстру: LIFLEET_REGISTRY або ./authors.json."""
    return Path(os.environ.get("LIFLEET_REGISTRY", DEFAULT_PATH))


def load() -> dict:
    p = path()
    if not p.exists():
        return {}
    with p.open(encoding="utf-8") as f:
        return json.load(f)


def save(data: dict) -> None:
    """Атомарний запис: .tmp + os.replace, щоб не лишити побитий JSON."""
    p = path()
    tmp = p.with_suffix(".tmp")
    tmp.write_text(
        json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    os.replace(tmp, p)


def get(slug: str) -> dict:
    data = load()
    if slug not in data:
        raise UnknownAuthor(slug)
    return data[slug]


def patch(slug: str, **fields) -> dict:
    """Оновлює окремі поля запису автора і зберігає реєстр."""
    data = load()
    if slug not in data:
        raise UnknownAuthor(slug)
    data[slug].update(fields)
    save(data)
    return data[slug]
