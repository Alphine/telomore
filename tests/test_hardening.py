"""Security hardening for the Pro/admin work: escalation, tokens, injection, usage, DDL."""

from __future__ import annotations

import csv
import datetime as dt
import io

from sqlalchemy.dialects import postgresql

from tests.test_admin_api import _env, auth, client, make_admin, make_user, utcnow  # noqa: F401  (fixtures)

from telomere_lab import db as db_module


# ------------------------------------------------------------- escalation
def test_non_admin_cannot_reach_any_admin_route(client):
    h = auth(make_user("mallory", plan="pro"))
    for method, path in [("get", "/api/admin/stats"), ("get", "/api/admin/users"), ("get", "/api/admin/users/1"),
                         ("patch", "/api/admin/users/1"), ("post", "/api/admin/users"),
                         ("get", "/api/admin/requests"), ("post", "/api/admin/requests/1/approve"),
                         ("post", "/api/admin/requests/1/reject"), ("get", "/api/admin/usage"),
                         ("get", "/api/admin/usage/summary"), ("get", "/api/admin/usage/export.csv"),
                         ("get", "/api/admin/audit")]:
        assert getattr(client, method)(path, headers=h).status_code == 403, (method, path)
        assert getattr(client, method)(path).status_code == 401, (method, path)


def test_mass_assignment_is_rejected(client):
    admin = make_admin()
    u = make_user("victim")
    h = auth(admin)
    for field in ("is_admin", "is_verified", "password_hash", "id", "email"):
        r = client.patch(f"/api/admin/users/{u.id}", json={field: True}, headers=h)
        assert r.status_code == 422, field
    r = client.post("/api/admin/users", json={"username": "newbie", "email": "n@example.com", "is_admin": True},
                    headers=h)
    assert r.status_code == 422
    r = client.post("/api/access-requests", json={"message": "hi", "status": "approved"}, headers=auth(u))
    assert r.status_code == 201 and r.json()["status"] == "pending"


def test_admin_cannot_lock_out_admins(client):
    admin = make_admin()
    h = auth(admin)
    r = client.patch(f"/api/admin/users/{admin.id}", json={"is_disabled": True}, headers=h)
    assert r.status_code == 409 and r.json()["detail"]["code"] == "admin_protected"
    assert client.patch(f"/api/admin/users/{admin.id}", json={"plan": "free"}, headers=h).status_code == 409


def test_unverified_squatter_of_admin_username_is_not_promoted(client):
    squatter = make_user("root", verified=False)
    assert db_module.apply_admin_bootstrap() == 0
    s = db_module.get_session()
    try:
        assert s.get(db_module.User, squatter.id).is_admin is False
    finally:
        s.close()
    assert db_module.is_env_admin(squatter) is False


# ------------------------------------------------------------------ tokens
def test_disabled_user_with_valid_token_is_locked_out(client):
    admin = make_admin()
    u = make_user("bob", plan="pro")
    h = auth(u)
    assert client.get("/api/auth/me", headers=h).status_code == 200
    assert client.patch(f"/api/admin/users/{u.id}", json={"is_disabled": True}, headers=auth(admin)).status_code == 200
    for path in ("/api/auth/me", "/api/access-requests/mine"):
        r = client.get(path, headers=h)
        assert r.status_code == 403 and r.json()["detail"]["code"] == "account_disabled"


def test_pro_expiry_applies_to_an_already_issued_token(client):
    u = make_user("carl", plan="pro", expires=utcnow() + dt.timedelta(hours=1))
    h = auth(u)
    assert client.get("/api/auth/me", headers=h).json()["plan"] == "pro"
    s = db_module.get_session()
    try:
        row = s.get(db_module.User, u.id)
        row.plan_expires_at = utcnow() - dt.timedelta(seconds=1)
        s.commit()
    finally:
        s.close()
    r = client.post("/api/simulate", json={}, headers=h)
    assert r.status_code == 403 and r.json()["detail"]["code"] == "pro_required"
    assert client.get("/api/auth/me", headers=h).json()["plan"] == "free"


def test_password_reset_invalidates_old_tokens(client):
    u = make_user("dana")
    old = auth(u)
    assert client.get("/api/auth/me", headers=old).status_code == 200
    _, token = db_module.request_password_reset(u.email)
    assert db_module.reset_password(token, "a-brand-new-pass1")
    assert client.get("/api/auth/me", headers=old).status_code == 401
    r = client.post("/api/auth/login", json={"username": "dana", "password": "a-brand-new-pass1"})
    assert r.status_code == 200
    assert client.get("/api/auth/me", headers={"Authorization": f"Bearer {r.json()['access_token']}"}).status_code == 200


def test_tampered_or_alg_none_token_rejected(client):
    import jwt as pyjwt
    u = make_user("erin")
    forged = pyjwt.encode({"sub": str(u.id)}, "", algorithm="none")
    wrong_key = pyjwt.encode({"sub": str(u.id)}, "x" * 40, algorithm="HS256")
    for tok in (forged, wrong_key, "garbage"):
        assert client.get("/api/auth/me", headers={"Authorization": f"Bearer {tok}"}).status_code == 401


def test_register_does_not_reveal_registered_email(client):
    make_user("frank")
    fresh = client.post("/api/auth/register", json={"username": "gina1", "email": "new@example.com",
                                                    "password": "longenough1"})
    dup = client.post("/api/auth/register", json={"username": "gina2", "email": "FRANK@example.com",
                                                  "password": "longenough1"})
    assert fresh.status_code == dup.status_code == 201
    assert not dup.json().get("dev_verification_link")


# -------------------------------------------------------- admin params/CSV
def test_users_sort_query_and_pagination_are_safe(client):
    admin = make_admin()
    make_user("a_b")
    make_user("axb")
    h = auth(admin)
    assert client.get("/api/admin/users?sort=username;DROP TABLE users", headers=h).status_code == 422
    assert client.get("/api/admin/users?sort=password_hash", headers=h).status_code == 422
    assert client.get("/api/admin/users?page=0", headers=h).status_code == 422
    assert client.get("/api/admin/users?page_size=101", headers=h).status_code == 422
    assert client.get("/api/admin/users?page_size=0", headers=h).status_code == 422
    assert client.get("/api/admin/users/99999999999", headers=h).status_code == 422
    assert client.get("/api/admin/users?page=999999", headers=h).json()["items"] == []

    def names(q):
        return [i["username"] for i in client.get("/api/admin/users", params={"query": q}, headers=h).json()["items"]]

    assert names("a_b") == ["a_b"]  # '_' is not a wildcard
    assert names("%") == []
    assert names("' OR 1=1 --") == []


def test_usage_export_neutralises_formula_cells(client):
    admin = make_admin()
    s = db_module.get_session()
    try:
        for ep in ('=HYPERLINK("http://evil")', "+1+1", "-2", "@SUM(A1)", "/api/ok"):
            s.add(db_module.UsageEvent(endpoint=ep, method="GET", status_code=200, duration_ms=1.0,
                                       ip_hash="ab", kind="other"))
        s.commit()
    finally:
        s.close()
    r = client.get("/api/admin/usage/export.csv", headers=auth(admin))
    rows = list(csv.reader(io.StringIO(r.text)))[1:]
    eps = sorted(row[3] for row in rows)
    assert len(eps) == 5 and "/api/ok" in eps
    for e in eps:
        assert e[:1] not in ("=", "+", "-", "@")
    assert any(e.startswith("'=HYPERLINK") for e in eps)


def test_usage_status_filter_rejects_junk(client):
    h = auth(make_admin())
    for bad in ("²", "abcd", "99999999999999", "5xxx"):
        assert client.get("/api/admin/usage", params={"status": bad}, headers=h).status_code == 422, bad
    assert client.get("/api/admin/usage?status=5xx", headers=h).status_code == 200
    assert client.get("/api/admin/usage?user_id=99999999999", headers=h).status_code == 422


# --------------------------------------------------------- access requests
def test_access_request_idor_and_daily_limit(client):
    a, b = make_user("alice"), make_user("bobby")
    admin = make_admin()
    assert client.post("/api/access-requests", json={"message": "<script>x</script>"}, headers=auth(a)).status_code == 201
    assert client.get("/api/access-requests/mine", headers=auth(b)).json() == []
    assert client.post("/api/access-requests", json={}, headers=auth(a)).status_code == 409  # still pending

    def reject_latest():
        rid = client.get("/api/access-requests/mine", headers=auth(a)).json()[0]["id"]
        assert client.post(f"/api/admin/requests/{rid}/reject", headers=auth(admin)).status_code == 200

    for _ in range(2):
        reject_latest()
        assert client.post("/api/access-requests", json={}, headers=auth(a)).status_code == 201
    reject_latest()  # three requests in 24 h
    r = client.post("/api/access-requests", json={}, headers=auth(a))
    assert r.status_code == 429 and r.json()["detail"]["code"] == "too_many_requests"
    assert client.post("/api/access-requests", json={"message": "x" * 501}, headers=auth(b)).status_code == 422


def test_cors_allows_studylab_only(client):
    ok = client.options("/api/auth/login", headers={"Origin": "https://studylab.id",
                                                    "Access-Control-Request-Method": "POST",
                                                    "Access-Control-Request-Headers": "authorization,content-type"})
    assert ok.headers.get("access-control-allow-origin") == "https://studylab.id"
    assert ok.headers.get("access-control-allow-credentials") == "true"
    bad = client.options("/api/auth/login", headers={"Origin": "https://evil.example",
                                                     "Access-Control-Request-Method": "POST"})
    assert "access-control-allow-origin" not in bad.headers


# ----------------------------------------------------------------- usage
def test_usage_survives_database_failure(client, monkeypatch):
    from backend import usage
    monkeypatch.setenv("TELOMERE_USAGE_LOG", "on")
    usage.flush()

    def boom(*a, **k):
        raise RuntimeError("db down")

    monkeypatch.setattr(usage._db, "get_session", boom)
    for _ in range(3):
        assert client.get("/api/health").status_code == 200
        assert client.get("/api/jobs").status_code == 401  # logged (anonymous) without ever needing the DB
    usage.flush(5.0)
    assert usage._Q.unfinished_tasks == 0


def test_usage_queue_is_bounded(monkeypatch):
    import queue

    from backend import usage
    assert usage._Q.maxsize > 0
    monkeypatch.setattr(usage, "_ensure_thread", lambda: None)
    monkeypatch.setattr(usage, "_Q", queue.Queue(maxsize=2))
    for _ in range(5):
        usage.record({"x": 1})  # must neither raise nor block
    assert usage._Q.qsize() == 2


def test_forwarded_for_hops(monkeypatch):
    from starlette.requests import Request

    from backend.ratelimit import client_ip

    def req(xff):
        return Request({"type": "http", "headers": [(b"x-forwarded-for", xff.encode())], "client": ("9.9.9.9", 1)})

    spoof = "6.6.6.6, 203.0.113.5"
    monkeypatch.delenv("TELOMERE_TRUSTED_HOPS", raising=False)
    assert client_ip(req(spoof)) == "6.6.6.6"  # legacy: first entry
    monkeypatch.setenv("TELOMERE_TRUSTED_HOPS", "1")
    assert client_ip(req(spoof)) == "203.0.113.5"  # forged prefix ignored
    assert client_ip(req("203.0.113.5")) == "203.0.113.5"
    monkeypatch.setenv("TELOMERE_TRUSTED_HOPS", "5")
    assert client_ip(req(spoof)) == "6.6.6.6"
    monkeypatch.setenv("TELOMERE_TRUST_PROXY", "0")
    assert client_ip(req(spoof)) == "9.9.9.9"


# --------------------------------------------------------- Postgres DDL
def test_postgres_migration_ddl_renders_valid_statements():
    dialect = postgresql.dialect()
    by = {}
    for table in db_module.Base.metadata.sorted_tables:
        for col in table.columns:
            if not col.primary_key:
                by[(table.name, col.name)] = db_module.column_ddl(table, col, dialect)
    assert by[("users", "is_admin")][0] == \
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT FALSE"
    assert by[("users", "plan")][0] == \
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS plan VARCHAR(16) DEFAULT 'free'"
    assert by[("users", "plan_expires_at")][0].endswith("plan_expires_at TIMESTAMP WITHOUT TIME ZONE")
    assert by[("admin_audit_log", "detail")][0].endswith("detail TEXT")
    assert by[("usage_events", "ts")][1] == "CREATE INDEX IF NOT EXISTS ix_usage_events_ts ON usage_events (ts)"
    assert by[("users", "email")][1].startswith("CREATE UNIQUE INDEX IF NOT EXISTS ix_users_email")
    for stmts in by.values():
        for s in stmts:
            assert ";" not in s
            for tok in s.replace("(", " ").replace(")", " ").split():
                assert len(tok) <= 63  # Postgres identifier limit


def test_reserved_words_are_quoted():
    from sqlalchemy import Column, Integer, MetaData, Table
    t = Table("user", MetaData(), Column("order", Integer, default=0, index=True))
    out = db_module.column_ddl(t, t.c.order, postgresql.dialect())
    assert out[0] == 'ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "order" INTEGER DEFAULT 0'
    assert '"user"' in out[1] and '"order"' in out[1]
