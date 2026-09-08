"""Tests for the user-accounts DB layer (SQLite fallback -- no DATABASE_URL set).

Each test gets its own isolated SQLite file under ``tmp_path`` so nothing
leaks into the real ``data/`` directory used by the running app, and no
test depends on another's state.
"""

from __future__ import annotations

import pytest

from telomere_lab import db as db_module


@pytest.fixture()
def session_factory(tmp_path, monkeypatch):
    """An isolated SQLite database for one test, with a helper to get sessions."""
    monkeypatch.delenv("DATABASE_URL", raising=False)
    db_path = tmp_path / "test.db"
    url = f"sqlite:///{db_path.as_posix()}"
    db_module.get_engine(database_url=url)

    def _get_session():
        return db_module.get_session(database_url=url)

    return _get_session


def test_create_user_and_authenticate(session_factory):
    session = session_factory()
    user = db_module.create_user("alice", "hunter2", session=session)
    assert user.id is not None
    assert user.username == "alice"
    assert user.password_hash != "hunter2"  # never store plaintext

    ok = db_module.authenticate("alice", "hunter2", session=session)
    assert ok is not None
    assert ok.username == "alice"

    wrong = db_module.authenticate("alice", "wrong-password", session=session)
    assert wrong is None

    missing = db_module.authenticate("nobody", "whatever", session=session)
    assert missing is None
    session.close()


def test_duplicate_username_rejected(session_factory):
    session = session_factory()
    db_module.create_user("bob", "password1", session=session)
    with pytest.raises(db_module.DuplicateUsernameError):
        db_module.create_user("bob", "password2", session=session)
    session.close()


def test_record_and_list_user_runs(session_factory):
    session = session_factory()
    user = db_module.create_user("carol", "swordfish", session=session)

    assert db_module.list_user_runs(user.id, session=session) == []

    db_module.record_user_run(user.id, "TEL-20260909-001", session=session)
    db_module.record_user_run(user.id, "TEL-20260909-002", session=session)
    # idempotent: recording the same run twice must not duplicate it
    db_module.record_user_run(user.id, "TEL-20260909-001", session=session)

    runs = db_module.list_user_runs(user.id, session=session)
    assert sorted(runs) == ["TEL-20260909-001", "TEL-20260909-002"]
    session.close()


def test_sqlite_fallback_used_when_no_database_url(tmp_path, monkeypatch):
    """With DATABASE_URL unset, the engine must fall back to a SQLite file
    under <repo>/data/, not require a live Postgres server."""
    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.setattr(db_module, "DATA_DIR", tmp_path / "data")
    db_module.reset_engine()
    try:
        url = db_module._normalized_database_url()
        assert url.startswith("sqlite:///")
        assert (tmp_path / "data").exists()
    finally:
        db_module.reset_engine()


def test_database_url_scheme_translated_for_postgres(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgresql://user:pass@host:5432/dbname")
    url = db_module._normalized_database_url()
    assert url == "postgresql+psycopg2://user:pass@host:5432/dbname"

    monkeypatch.setenv("DATABASE_URL", "postgres://user:pass@host:5432/dbname")
    url = db_module._normalized_database_url()
    assert url == "postgresql+psycopg2://user:pass@host:5432/dbname"
