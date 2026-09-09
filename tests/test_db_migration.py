"""Additive schema sync: a database created by an older release must gain the
columns newer models need, without touching existing rows.

Regression for the production failure ``column users.email does not exist``:
the ``users`` table had been created before email verification existed and
``create_all`` never alters existing tables.
"""

from __future__ import annotations

import sqlite3

from telomere_lab import db as db_module


def _legacy_users_db(path) -> None:
    conn = sqlite3.connect(path)
    conn.execute(
        "CREATE TABLE users (id INTEGER PRIMARY KEY, username VARCHAR(150) NOT NULL UNIQUE, "
        "password_hash VARCHAR(255) NOT NULL, created_at DATETIME)"
    )
    conn.execute(
        "INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, '2026-09-09 00:00:00')",
        ("legacy", db_module._hash_password("old-pass")),
    )
    conn.commit()
    conn.close()


def test_legacy_users_table_gains_new_columns_and_keeps_rows(tmp_path, monkeypatch):
    monkeypatch.delenv("DATABASE_URL", raising=False)
    db_path = tmp_path / "legacy.db"
    _legacy_users_db(db_path)
    url = f"sqlite:///{db_path.as_posix()}"

    engine = db_module.get_engine(database_url=url)
    cols = {c["name"] for c in db_module.sa_inspect(engine).get_columns("users")}
    assert {"email", "is_verified", "verification_token", "reset_token", "reset_token_expires_at"} <= cols

    session = db_module.get_session(database_url=url)
    legacy = db_module.authenticate("legacy", "old-pass", session=session)
    assert legacy is not None and legacy.email is None and legacy.is_verified is False

    # The exact query that crashed in production.
    assert db_module.verify_email("bogus-token", session=session) is None

    new = db_module.create_user("newbie", "new@example.com", "pw", session=session)
    assert new.email == "new@example.com"
    session.close()


def test_sync_is_idempotent_and_reports_nothing_on_current_schema(tmp_path, monkeypatch):
    monkeypatch.delenv("DATABASE_URL", raising=False)
    url = f"sqlite:///{(tmp_path / 'fresh.db').as_posix()}"
    engine = db_module.get_engine(database_url=url)
    assert db_module._add_missing_columns(engine) == []
    assert db_module._add_missing_columns(engine) == []
