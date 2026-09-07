"""Тести session_report і mint_invite: форма звіту, кому мінтиться лінк,
і що Live View URL не витікає у stdout."""
import json
import stat

import pytest

from lifleet import cli, invite, registry

import session_report


def run(*argv) -> int:
    return session_report.main(list(argv))


def _seed(slug, name, *, context=True, last_ok="2026-09-01T10:00:00+00:00"):
    """Автор у реєстрі. context=False відтворює olga: доданий, але не логінений."""
    cli.main(["add", slug, "--name", name])
    if context:
        registry.patch(slug, context_id=f"ctx_{slug}", status="live", last_ok=last_ok)


def _probe_by_author(env, statuses):
    """probe() не знає, кого перевіряє, — але sessions.create щойно записав
    user_metadata, тож автора беремо з останньої створеної сесії. Так один
    прогін може мати і живих, і мертвих, не залежачи від порядку реєстру."""
    def fake_probe(page):
        slug = env.bb.sessions.create_calls[-1]["user_metadata"]["author"]
        return statuses.get(slug, "live"), None

    return fake_probe


# ------------------------------------------------------------------ форма звіту

def test_report_shape_for_live_dead_and_new_authors(env, monkeypatch, tmp_path):
    _seed("alex", "Alex")
    _seed("peter", "Peter Ovchynnikov")
    _seed("olga", "Olga Michai", context=False)
    monkeypatch.setattr("lifleet.probe.probe", _probe_by_author(env, {"peter": "dead"}))

    out = tmp_path / "report.json"
    assert run(f"--out={out}") == 0
    report = json.loads(out.read_text(encoding="utf-8"))
    assert report["checked_at"]
    by_slug = {a["slug"]: a for a in report["authors"]}
    assert set(by_slug) == {"alex", "peter", "olga"}

    live = by_slug["alex"]
    assert live["status"] == "live"
    assert live["name"] == "Alex"
    assert live["last_ok"]
    # Ключі лінка є ТІЛЬКИ в тих, кому треба перелогінитись — нотифаєр
    # розрізняє випадки за наявністю ключа, а не за null.
    assert "invite_url" not in live

    dead = by_slug["peter"]
    assert dead["status"] == "dead"
    assert dead["name"] == "Peter Ovchynnikov"
    assert dead["invite_url"].startswith("https://fake.debug/")
    assert dead["invite_expires_at"]
    assert dead["session_id"]

    new = by_slug["olga"]
    assert new["status"] == "new"
    assert "invite_url" not in new


def test_stale_last_ok_is_labelled_as_a_registry_snapshot(env, monkeypatch, tmp_path):
    """last_ok вилогіненого автора — це поле реєстру, а не спостереження цього
    прогону: _check_one оновлює його лише живому (cli.py:238-239), а в CI сам
    реєстр приїжджає з секрету і знищується після прогону. Тому дата мусить
    їхати з позначкою джерела — інакше нотифаєр подасть тримісячний штамп як
    «остання успішна перевірка» під щоденним монітором."""
    _seed("alex", "Alex", last_ok="2026-06-02T10:55:32+00:00")
    _seed("peter", "Peter", last_ok="2026-06-02T10:55:32+00:00")
    monkeypatch.setattr("lifleet.probe.probe", _probe_by_author(env, {"peter": "dead"}))
    out = tmp_path / "report.json"
    assert run(f"--out={out}") == 0
    by_slug = {a["slug"]: a for a in json.loads(out.read_text(encoding="utf-8"))["authors"]}
    assert by_slug["peter"]["last_ok"] == "2026-06-02T10:55:32+00:00"
    assert by_slug["peter"]["last_ok_source"] == "registry-snapshot"
    # Живого автора цей самий прогін щойно бачив — тут дата справді наша.
    assert by_slug["alex"]["last_ok_source"] == "this-run"
    assert by_slug["alex"]["last_ok"] != "2026-06-02T10:55:32+00:00"


def test_author_without_context_costs_nothing_and_gets_no_link(env, tmp_path):
    # olga на паузі свідомо: жодної сесії, жодного нового context.
    _seed("olga", "Olga Michai", context=False)
    out = tmp_path / "report.json"
    assert run(f"--out={out}") == 0
    assert env.bb.sessions.create_calls == []
    assert env.bb.contexts.create_calls == []
    item = json.loads(out.read_text(encoding="utf-8"))["authors"][0]
    assert item["status"] == "new"
    assert "invite_url" not in item


def test_exit_zero_even_when_someone_is_logged_out(env, monkeypatch, tmp_path):
    """Розлогінений автор — це результат перевірки, а не її збій:
    повідомляє Slack, а не червоний прогін щодня."""
    _seed("peter", "Peter")
    monkeypatch.setattr("lifleet.probe.probe", _probe_by_author(env, {"peter": "dead"}))
    out = tmp_path / "report.json"
    assert run(f"--out={out}") == 0


def test_challenge_also_gets_a_link(env, monkeypatch, tmp_path):
    _seed("maria", "Maria")
    monkeypatch.setattr("lifleet.probe.probe", _probe_by_author(env, {"maria": "challenge"}))
    out = tmp_path / "report.json"
    assert run(f"--out={out}") == 0
    item = json.loads(out.read_text(encoding="utf-8"))["authors"][0]
    assert item["status"] == "challenge"
    assert item["invite_url"]


def test_error_status_gets_no_link(env, monkeypatch, tmp_path):
    # error — це «не змогли поставити діагноз». Лінк на такому діагнозі спалив
    # би 25 хв оплаченого часу і смикнув людину даремно.
    _seed("alex", "Alex")
    monkeypatch.setattr("lifleet.probe.probe", _probe_by_author(env, {"alex": "error"}))
    out = tmp_path / "report.json"
    assert run(f"--out={out}") == 0
    item = json.loads(out.read_text(encoding="utf-8"))["authors"][0]
    assert item["status"] == "error"
    assert "invite_url" not in item
    kinds = {c["user_metadata"]["kind"] for c in env.bb.sessions.create_calls}
    assert kinds == {"check"}


# --------------------------------------------------------------------- аргументи

def test_only_filters_the_roster(env, monkeypatch, tmp_path):
    _seed("alex", "Alex")
    _seed("peter", "Peter")
    monkeypatch.setattr("lifleet.probe.probe", _probe_by_author(env, {}))
    out = tmp_path / "report.json"
    assert run(f"--out={out}", "--only=alex") == 0
    report = json.loads(out.read_text(encoding="utf-8"))
    assert [a["slug"] for a in report["authors"]] == ["alex"]
    touched = {c["user_metadata"]["author"] for c in env.bb.sessions.create_calls}
    assert touched == {"alex"}  # за peter не платили


def test_only_with_unknown_slug_fails_before_any_session(env, tmp_path):
    _seed("alex", "Alex")
    out = tmp_path / "report.json"
    assert run(f"--out={out}", "--only=ghost") == 2
    assert not out.exists()
    assert env.bb.sessions.create_calls == []


def test_space_separated_args_are_rejected(env, tmp_path):
    # Форма `--out path` у репо вже коштувала одного мовчазного провалу.
    _seed("alex", "Alex")
    out = tmp_path / "report.json"
    assert run("--out", str(out)) == 2
    assert not out.exists()
    assert env.bb.sessions.create_calls == []


def test_missing_out_argument_fails(env):
    _seed("alex", "Alex")
    assert run() == 2


def test_no_invite_skips_link_minting(env, monkeypatch, tmp_path):
    _seed("peter", "Peter")
    monkeypatch.setattr("lifleet.probe.probe", _probe_by_author(env, {"peter": "dead"}))
    out = tmp_path / "report.json"
    assert run(f"--out={out}", "--no-invite") == 0
    item = json.loads(out.read_text(encoding="utf-8"))["authors"][0]
    assert item["status"] == "dead"
    assert "invite_url" not in item
    kinds = {c["user_metadata"]["kind"] for c in env.bb.sessions.create_calls}
    assert kinds == {"check"}


def test_minutes_argument_reaches_the_link(env, monkeypatch, tmp_path):
    _seed("peter", "Peter")
    monkeypatch.setattr("lifleet.probe.probe", _probe_by_author(env, {"peter": "dead"}))
    out = tmp_path / "report.json"
    assert run(f"--out={out}", "--minutes=30") == 0
    assert env.bb.sessions.debug_calls[-1]["expires_in"] == 30 * 60
    assert env.bb.sessions.create_calls[-1]["api_timeout"] == 30 * 60 + 300


def test_lifleet_authors_is_honoured_as_registry_alias(env, monkeypatch, tmp_path):
    """Weekly-воркфлоу виставляє LIFLEET_AUTHORS; registry.py читає лише
    LIFLEET_REGISTRY. Без трансляції прогін бачив би порожній реєстр."""
    _seed("alex", "Alex")
    monkeypatch.setenv("LIFLEET_AUTHORS", str(env.registry))
    monkeypatch.delenv("LIFLEET_REGISTRY")
    out = tmp_path / "report.json"
    assert run(f"--out={out}") == 0
    report = json.loads(out.read_text(encoding="utf-8"))
    assert [a["slug"] for a in report["authors"]] == ["alex"]


# ------------------------------------------------------------------- секретність

def test_liveview_url_never_reaches_stdout(env, monkeypatch, tmp_path, capsys):
    """URL Live View — це доступ до залогіненого браузера автора. Логи CI
    бачить кожен, хто має доступ до репо, тож URL живе лише у файлі звіту."""
    _seed("peter", "Peter")
    monkeypatch.setattr("lifleet.probe.probe", _probe_by_author(env, {"peter": "dead"}))
    out = tmp_path / "report.json"
    assert run(f"--out={out}") == 0
    captured = capsys.readouterr()
    url = json.loads(out.read_text(encoding="utf-8"))["authors"][0]["invite_url"]
    assert url
    assert url not in captured.out
    assert url not in captured.err
    assert "fake.debug" not in captured.out


def test_report_file_is_not_world_readable(env, monkeypatch, tmp_path):
    _seed("alex", "Alex")
    monkeypatch.setattr("lifleet.probe.probe", _probe_by_author(env, {}))
    out = tmp_path / "report.json"
    assert run(f"--out={out}") == 0
    assert stat.S_IMODE(out.stat().st_mode) == 0o600
    assert not out.with_suffix(".json.tmp").exists()  # тимчасовий файл прибрано


# ----------------------------------------------------------------- відмови мережі

def test_browserbase_402_aborts_without_writing_a_partial_report(
    env, monkeypatch, tmp_path, capsys
):
    """Часткова картина, подана як повна, гірша за її відсутність:
    автори до помилки виглядали б живими, автори після неї просто зникли б."""
    _seed("alex", "Alex")
    _seed("peter", "Peter")

    class BBError(Exception):
        status_code = 402

    def raise_minutes(**kwargs):
        raise BBError("Error code: 402 - Free plan browser minutes limit reached")

    monkeypatch.setattr(env.bb.sessions, "create", raise_minutes)
    out = tmp_path / "report.json"
    assert run(f"--out={out}") == 2
    assert not out.exists()
    err = capsys.readouterr().err
    assert "browser minutes" in err.lower()
    assert "Traceback" not in err


def test_failed_link_is_recorded_but_does_not_fail_the_run(env, monkeypatch, tmp_path):
    _seed("peter", "Peter")
    monkeypatch.setattr("lifleet.probe.probe", _probe_by_author(env, {"peter": "dead"}))

    def boom(slug, minutes=20, *, bb=None):
        raise RuntimeError("429 concurrency")

    monkeypatch.setattr(session_report.invite_mod, "mint_invite", boom)
    out = tmp_path / "report.json"
    assert run(f"--out={out}") == 0
    item = json.loads(out.read_text(encoding="utf-8"))["authors"][0]
    # Автор усе одно розлогінений — Slack має сказати про це навіть без лінка.
    assert item["status"] == "dead"
    assert "invite_url" not in item
    assert "429" in item["invite_error"]


def test_empty_registry_is_a_failure_not_an_all_clear(env, tmp_path):
    # Порожній реєстр у CI = секрет не доїхав. Зелений прогін, який нічого не
    # перевірив, — рівно та тиша, заради якої монітор і будували.
    out = tmp_path / "report.json"
    assert run(f"--out={out}") == 2
    assert not out.exists()


def test_default_cap_holds_at_most_one_concurrency_slot(env, monkeypatch, tmp_path):
    """Дефолт — рівно один лінк за прогін, і це не косметика.

    Кожен keep_alive лінк тримає слот одночасності 25 хв ПІСЛЯ завершення
    прогону. Дефолт 3 обіцяв три лінки на акаунті, де їх стільки може не бути:
    на free plan другий мінт — гарантований 429, а на базовому плані три лінки
    саджають увесь акаунт до 07:31 і 429-ять ручний перезапуск weekly."""
    monkeypatch.delenv("LIFLEET_MAX_INVITES_PER_RUN", raising=False)
    assert session_report.max_invites() == 1
    _seed("peter", "Peter")
    _seed("maria", "Maria")
    monkeypatch.setattr(
        "lifleet.probe.probe",
        _probe_by_author(env, {"peter": "dead", "maria": "dead"}),
    )
    out = tmp_path / "report.json"
    assert run(f"--out={out}") == 0
    invites = [c for c in env.bb.sessions.create_calls if c["user_metadata"]["kind"] == "invite"]
    assert len(invites) == 1


def test_capped_author_is_told_when_the_slot_frees_up(env, monkeypatch, tmp_path, capsys):
    """«Підніми сам» під час зайнятого слота дає 429, а START-HERE радить у
    відповідь зупинити RUNNING-сесію — тобто вбити чужий живий лінк. Тому
    пропущеному авторові кажемо час, а не інструкцію."""
    monkeypatch.delenv("LIFLEET_MAX_INVITES_PER_RUN", raising=False)
    _seed("peter", "Peter")
    _seed("maria", "Maria")
    monkeypatch.setattr(
        "lifleet.probe.probe",
        _probe_by_author(env, {"peter": "dead", "maria": "dead"}),
    )
    out = tmp_path / "report.json"
    assert run(f"--out={out}") == 0
    authors = json.loads(out.read_text(encoding="utf-8"))["authors"]
    linked = next(a for a in authors if a.get("invite_url"))
    skipped = next(a for a in authors if a.get("invite_error"))
    assert skipped["invite_wait_until"] == linked["session_expires_at"]
    # І причина мусить лишити слід у stderr: звіт воркфлоу свідомо не друкує,
    # тож без цього «чому немає лінка» не має відповіді ніде.
    assert skipped["slug"] in capsys.readouterr().err


def test_invite_cap_names_who_was_skipped(env, monkeypatch, tmp_path):
    """Кожен keep_alive лінк тримає слот одночасності 25 хв, тож ліміт є —
    але пропущений автор мусить бути названий, а не зникнути мовчки."""
    monkeypatch.setenv("LIFLEET_MAX_INVITES_PER_RUN", "1")
    _seed("peter", "Peter")
    _seed("maria", "Maria")
    monkeypatch.setattr(
        "lifleet.probe.probe",
        _probe_by_author(env, {"peter": "dead", "maria": "dead"}),
    )
    out = tmp_path / "report.json"
    assert run(f"--out={out}") == 0
    authors = json.loads(out.read_text(encoding="utf-8"))["authors"]
    linked = [a for a in authors if a.get("invite_url")]
    skipped = [a for a in authors if a.get("invite_error")]
    assert len(linked) == 1
    assert len(skipped) == 1
    assert "LIFLEET_MAX_INVITES_PER_RUN" in skipped[0]["invite_error"]


# ---------------------------------------------------------------- mint_invite

def test_mint_invite_disables_recording_and_persists_context(env):
    _seed("alex", "Alex")
    link = invite.mint_invite("alex", 20)
    call = env.bb.sessions.create_calls[-1]
    assert call["browser_settings"]["record_session"] is False
    assert call["browser_settings"]["context"]["persist"] is True
    # Капчу в invite розв'язує людина — авто-солвер перехоплює кліки у віджеті.
    assert call["browser_settings"]["solve_captchas"] is False
    assert call["keep_alive"] is True
    assert call["user_metadata"] == {"author": "alex", "kind": "invite"}
    assert call["api_timeout"] == 20 * 60 + 300
    assert env.bb.sessions.debug_calls[-1]["expires_in"] == 20 * 60
    # Лінк помирає на 300 с раніше за сесію — людині кажемо саме перше число.
    assert link["expires_at"] < link["session_expires_at"]
    assert link["minutes"] == 20
    assert link["name"] == "Alex"


def test_mint_invite_neither_releases_nor_closes_the_session(env):
    # Реліз або close убили б лінк, який автор ще навіть не відкрив.
    _seed("alex", "Alex")
    link = invite.mint_invite("alex", 20)
    released = [u["id"] for u in env.bb.sessions.update_calls]
    assert link["session_id"] not in released
    assert env.pw.stopped is True


def test_mint_invite_refuses_author_without_context(env):
    """CI не має права мовчки створити context і «розпаузити» автора,
    якого свідомо не логінили."""
    _seed("olga", "Olga", context=False)
    with pytest.raises(invite.NoContext):
        invite.mint_invite("olga")
    assert env.bb.sessions.create_calls == []
    assert env.bb.contexts.create_calls == []


def test_mint_invite_viewport_is_tunable_by_env(env, monkeypatch):
    _seed("alex", "Alex")
    monkeypatch.setenv("LIFLEET_VIEW_W", "900")
    monkeypatch.setenv("LIFLEET_VIEW_H", "700")
    invite.mint_invite("alex", 20)
    assert env.bb.sessions.create_calls[-1]["browser_settings"]["viewport"] == {
        "width": 900, "height": 700,
    }


def test_every_session_of_a_full_run_persists_context(env, monkeypatch, tmp_path):
    """Головна гарантія проєкту, тепер і для щоденного прогону:
    persist=True у КОЖНІЙ сесії — і в перевірці, і в мінті лінка."""
    _seed("alex", "Alex")
    _seed("peter", "Peter")
    monkeypatch.setattr("lifleet.probe.probe", _probe_by_author(env, {"peter": "dead"}))
    out = tmp_path / "report.json"
    assert run(f"--out={out}") == 0
    kinds = [c["user_metadata"]["kind"] for c in env.bb.sessions.create_calls]
    assert kinds == ["check", "check", "invite"]  # спочатку всі перевірки, потім лінк
    for call in env.bb.sessions.create_calls:
        assert call["browser_settings"]["context"]["persist"] is True
