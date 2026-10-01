"""Existing databases (users table without the plan/admin columns) migrate in place."""

from __future__ import annotations

import sys
from pathlib import Path

from sqlalchemy import create_engine, inspect, text
from sqlalchemy.dialects import postgresql

SRC = Path(__file__).resolve().parents[1] / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from telomere_lab import db as db_module  # noqa: E402


def test_old_users_table_gets_new_columns(tmp_path):
    url = f"sqlite:///{(tmp_path / 'old.db').as_posix()}"
    eng = create_engine(url)
    with eng.begin() as c:
        c.execute(text("CREATE TABLE users (id INTEGER PRIMARY KEY, username VARCHAR(150) NOT NULL, "
                       "email VARCHAR(255) NOT NULL, password_hash VARCHAR(255) NOT NULL, created_at DATETIME, "
                       "is_verified BOOLEAN NOT NULL DEFAULT 0, verification_token VARCHAR(64), "
                       "verification_token_created_at DATETIME, reset_token VARCHAR(64), "
                       "reset_token_expires_at DATETIME)"))
        c.execute(text("INSERT INTO users (id, username, email, password_hash, is_verified) "
                       "VALUES (1, 'old', 'old@x.org', 'h', 1)"))
    eng.dispose()

    engine = db_module.get_engine(url)
    cols = {c["name"] for c in inspect(engine).get_columns("users")}
    assert {"is_admin", "plan", "is_disabled", "plan_expires_at", "last_login_at", "last_seen_at"} <= cols
    tables = set(inspect(engine).get_table_names())
    assert {"access_requests", "usage_events", "admin_audit_log"} <= tables
    s = db_module.get_session(url)
    try:
        u = s.get(db_module.User, 1)
        assert (u.is_admin, u.is_disabled, u.plan, u.plan_expires_at) == (False, False, "free", None)
        assert db_module.effective_plan(u) == "free"
        s.add(db_module.AccessRequest(user_id=1, message="hi"))
        s.commit()
    finally:
        s.close()
    # idempotent
    assert db_module._add_missing_columns(engine) == []


def test_new_column_ddl_is_valid_for_postgres():
    """No Postgres server in CI: check the generated types/defaults are Postgres-legal."""
    pg = postgresql.dialect()
    t = db_module.User.__table__
    assert t.c.is_admin.type.compile(dialect=pg) == "BOOLEAN"
    assert t.c.plan.type.compile(dialect=pg) == "VARCHAR(16)"
    assert t.c.plan_expires_at.type.compile(dialect=pg) == "TIMESTAMP WITHOUT TIME ZONE"
    for name, default in (("is_admin", False), ("is_disabled", False), ("plan", "free")):
        assert t.c[name].default.arg == default  # rendered as DEFAULT FALSE / DEFAULT 'free'
    ev = db_module.UsageEvent.__table__
    assert {i.name for i in ev.indexes} >= {"ix_usage_events_ts", "ix_usage_events_user_id"}
