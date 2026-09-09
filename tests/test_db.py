"""Tests for the user-accounts DB layer (SQLite fallback -- no DATABASE_URL set).

Each test gets its own isolated SQLite file under ``tmp_path`` so nothing
leaks into the real ``data/`` directory used by the running app, and no
test depends on another's state.
"""

from __future__ import annotations

import datetime as dt

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
    user = db_module.create_user("alice", "alice@example.com", "hunter2", session=session)
    assert user.id is not None
    assert user.username == "alice"
    assert user.email == "alice@example.com"
    assert user.is_verified is False
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
    db_module.create_user("bob", "bob@example.com", "password1", session=session)
    with pytest.raises(db_module.DuplicateUsernameError):
        db_module.create_user("bob", "bob2@example.com", "password2", session=session)
    session.close()


def test_duplicate_email_rejected(session_factory):
    session = session_factory()
    db_module.create_user("dave", "dave@example.com", "password1", session=session)
    with pytest.raises(db_module.DuplicateEmailError):
        db_module.create_user("dave2", "dave@example.com", "password2", session=session)
    session.close()


def test_record_and_list_user_runs(session_factory):
    session = session_factory()
    user = db_module.create_user("carol", "carol@example.com", "swordfish", session=session)

    assert db_module.list_user_runs(user.id, session=session) == []

    db_module.record_user_run(user.id, "TEL-20260909-001", session=session)
    db_module.record_user_run(user.id, "TEL-20260909-002", session=session)
    # idempotent: recording the same run twice must not duplicate it
    db_module.record_user_run(user.id, "TEL-20260909-001", session=session)

    runs = db_module.list_user_runs(user.id, session=session)
    assert sorted(runs) == ["TEL-20260909-001", "TEL-20260909-002"]
    session.close()


# -------------------------------------------------------- email verification
def test_verify_email_valid_token(session_factory):
    session = session_factory()
    user = db_module.create_user("erin", "erin@example.com", "password1", session=session)
    token = db_module.generate_verification_token(user.id, session=session)
    assert token

    verified = db_module.verify_email(token, session=session)
    assert verified is not None
    assert verified.is_verified is True
    assert verified.verification_token is None
    session.close()


def test_verify_email_invalid_token(session_factory):
    session = session_factory()
    assert db_module.verify_email("does-not-exist", session=session) is None
    session.close()


def test_verify_email_token_cannot_be_reused(session_factory):
    session = session_factory()
    user = db_module.create_user("frank", "frank@example.com", "password1", session=session)
    token = db_module.generate_verification_token(user.id, session=session)
    assert db_module.verify_email(token, session=session) is not None
    # token was cleared after first use -> second attempt fails
    assert db_module.verify_email(token, session=session) is None
    session.close()


# ------------------------------------------------------------- password reset
def test_password_reset_round_trip(session_factory):
    session = session_factory()
    db_module.create_user("grace", "grace@example.com", "old-password", session=session)

    result = db_module.request_password_reset("grace@example.com", session=session)
    assert result is not None
    user, token = result
    assert token

    ok = db_module.reset_password(token, "new-password", session=session)
    assert ok is True

    assert db_module.authenticate("grace", "old-password", session=session) is None
    assert db_module.authenticate("grace", "new-password", session=session) is not None

    # the token is single-use
    assert db_module.reset_password(token, "another-password", session=session) is False
    session.close()


def test_password_reset_unknown_email_returns_none(session_factory):
    session = session_factory()
    assert db_module.request_password_reset("nobody@example.com", session=session) is None
    session.close()


def test_password_reset_expired_token_rejected(session_factory):
    session = session_factory()
    db_module.create_user("heidi", "heidi@example.com", "old-password", session=session)
    _user, token = db_module.request_password_reset("heidi@example.com", session=session)

    # simulate an already-expired token directly via the DB layer, without
    # waiting an hour for RESET_TOKEN_LIFETIME to elapse
    from sqlalchemy import select

    row = session.execute(
        select(db_module.User).where(db_module.User.reset_token == token)
    ).scalar_one()
    row.reset_token_expires_at = dt.datetime.now(dt.timezone.utc) - dt.timedelta(minutes=1)
    session.add(row)
    session.commit()

    assert db_module.reset_password(token, "new-password", session=session) is False
    assert db_module.authenticate("heidi", "old-password", session=session) is not None
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
