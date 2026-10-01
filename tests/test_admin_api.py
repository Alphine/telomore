"""Pro-plan enforcement, access requests, admin API and usage logging."""

from __future__ import annotations

import csv
import datetime as dt
import io
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

SRC = Path(__file__).resolve().parents[1] / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from telomere_lab import db as db_module  # noqa: E402


@pytest.fixture(autouse=True)
def _env(tmp_path, monkeypatch):
    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.delenv("RESEND_API_KEY", raising=False)
    monkeypatch.setattr(db_module, "DATA_DIR", tmp_path / "data")
    monkeypatch.setenv("TELOMERE_REQUIRE_PRO", "1")
    monkeypatch.setenv("TELOMERE_ADMIN_USERS", "root")
    from telomere_lab import config as config_module
    monkeypatch.setattr(config_module, "RUNS_DIR", tmp_path / "runs")
    db_module.reset_engine()
    yield
    from backend import usage
    usage.flush()
    db_module.reset_engine()


@pytest.fixture()
def client():
    from backend.main import create_app
    return TestClient(create_app())


def make_user(name, *, verified=True, plan="free", admin=False, expires=None, disabled=False):
    u = db_module.create_user(name, f"{name}@example.com", "hunter22")
    s = db_module.get_session()
    try:
        row = s.get(db_module.User, u.id)
        row.is_verified, row.plan, row.is_admin = verified, plan, admin
        row.plan_expires_at, row.is_disabled = expires, disabled
        s.commit()
        s.refresh(row)
        return row
    finally:
        s.close()


def auth(user):
    from backend.auth import create_access_token
    return {"Authorization": f"Bearer {create_access_token(user)}"}


def make_admin(name="root"):
    """The only way to get an admin: be listed in TELOMERE_ADMIN_USERS."""
    u = make_user(name)
    db_module.apply_admin_bootstrap()
    s = db_module.get_session()
    try:
        return s.get(db_module.User, u.id)
    finally:
        s.close()


def utcnow():
    return db_module.utcnow()


# ------------------------------------------------------------ require_pro
COMPUTE = ["/api/simulate", "/api/simulate/ensemble", "/api/evolve", "/api/pareto", "/api/sensitivity",
           "/api/gxe", "/api/active-learning", "/api/benchmark", "/api/compare",
           "/api/llm/interpret", "/api/llm/propose-protocol"]


@pytest.mark.parametrize("path", COMPUTE)
def test_free_user_gets_pro_required_on_every_compute_endpoint(client, path):
    u = make_user("freebie")
    r = client.post(path, json={}, headers=auth(u))
    assert r.status_code == 403
    assert r.json()["detail"]["code"] == "pro_required"


@pytest.mark.parametrize("path", COMPUTE)
def test_pro_user_passes_the_gate(client, path):
    u = make_user("proguy", plan="pro")
    r = client.post(path, json={}, headers=auth(u))
    assert r.status_code != 403  # empty body is invalid -> 422, but the plan gate let it through


def test_plan_matrix(client):
    cases = {
        "free": (make_user("a_free"), 403),
        "pro": (make_user("b_pro", plan="pro"), 200),
        "pro_future": (make_user("c_fut", plan="pro", expires=utcnow() + dt.timedelta(days=3)), 200),
        "pro_expired": (make_user("d_exp", plan="pro", expires=utcnow() - dt.timedelta(days=1)), 403),
        "admin": (make_user("e_adm", admin=True), 200),
        "disabled_pro": (make_user("f_dis", plan="pro", disabled=True), 403),
        "unverified_pro": (make_user("g_unv", plan="pro", verified=False), 403),
    }
    for name, (u, expected) in cases.items():
        r = client.post("/api/simulate", json={}, headers=auth(u))
        assert r.status_code == expected, name
    assert client.post("/api/simulate", json={}).status_code == 401
    r = client.post("/api/simulate", json={}, headers=auth(cases["disabled_pro"][0]))
    assert r.json()["detail"]["code"] == "account_disabled"


def test_require_pro_env_off_lets_free_users_through(client, monkeypatch):
    monkeypatch.setenv("TELOMERE_REQUIRE_PRO", "0")
    u = make_user("freebie")
    assert client.post("/api/simulate", json={}, headers=auth(u)).status_code == 200


def test_free_endpoints_stay_free(client):
    u = make_user("freebie")
    assert client.get("/api/jobs", headers=auth(u)).status_code == 200
    assert client.get("/api/sequence/genome", headers=auth(u)).status_code == 200


def test_disabled_user_blocked_everywhere_and_on_login(client):
    make_user("gone", disabled=True)
    r = client.post("/api/auth/login", json={"username": "gone", "password": "hunter22"})
    assert r.status_code == 403 and r.json()["detail"]["code"] == "account_disabled"
    u = make_user("gone2", disabled=True)
    assert client.get("/api/jobs", headers=auth(u)).json()["detail"]["code"] == "account_disabled"
    assert client.get("/api/auth/me", headers=auth(u)).status_code == 403


def test_disabled_check_stays_on_when_pro_check_is_off(client, monkeypatch):
    monkeypatch.setenv("TELOMERE_REQUIRE_PRO", "0")
    u = make_user("gone", disabled=True)
    assert client.post("/api/simulate", json={}, headers=auth(u)).status_code == 403


# ------------------------------------------------------- login / me / admin env
def test_login_and_me_shape(client):
    make_user("alice")
    r = client.post("/api/auth/login", json={"username": "alice", "password": "hunter22"})
    body = r.json()
    assert body["plan"] == "free" and body["is_admin"] is False and body["token_type"] == "bearer"
    me = client.get("/api/auth/me", headers={"Authorization": f"Bearer {body['access_token']}"}).json()
    assert me == {"id": me["id"], "username": "alice", "email": "alice@example.com", "is_verified": True,
                  "plan": "free", "is_admin": False, "plan_expires_at": None, "pending_request": False}
    s = db_module.get_session()
    try:
        assert s.get(db_module.User, me["id"]).last_login_at is not None
    finally:
        s.close()


def test_admin_bootstrap_on_login_and_startup(client, monkeypatch):
    make_user("root")
    make_user("other")
    r = client.post("/api/auth/login", json={"username": "root", "password": "hunter22"})
    assert r.status_code == 200 and r.json()["is_admin"] is True


def test_create_user_returns_password_once(client):
    admin = make_admin()
    h = auth(admin)
    r = client.post("/api/admin/users", json={"username": "newbie", "email": "n@x.org", "plan": "pro",
                                              "plan_days": 10}, headers=h)
    assert r.status_code == 201
    body = r.json()
    pw = body["temporary_password"]
    assert body["user"]["is_verified"] is True and body["user"]["plan"] == "pro" and body["user"]["plan_expires_at"]
    login = client.post("/api/auth/login", json={"username": "newbie", "password": pw})
    assert login.status_code == 200 and login.json()["plan"] == "pro"
    uid = body["user"]["id"]
    assert pw not in client.get(f"/api/admin/users/{uid}", headers=h).text
    assert pw not in client.get("/api/admin/audit", headers=h).text
    dup = client.post("/api/admin/users", json={"username": "newbie", "email": "q@x.org"}, headers=h)
    assert dup.status_code == 409 and dup.json()["detail"]["code"] == "duplicate"
    assert client.post("/api/admin/users", json={"username": "short1", "email": "s@x.org", "password": "abc"},
                       headers=h).status_code == 422


def test_users_pagination_filters_sorting(client):
    admin = make_admin()
    h = auth(admin)
    for i in range(7):
        make_user(f"user{i}", plan="pro" if i % 2 else "free", disabled=(i == 6))
    p1 = client.get("/api/admin/users?page_size=3&sort=username", headers=h).json()
    assert p1["total"] == 8 and p1["pages"] == 3 and len(p1["items"]) == 3 and p1["page"] == 1
    names = [u["username"] for u in p1["items"]]
    assert names == sorted(names)
    p3 = client.get("/api/admin/users?page_size=3&page=3&sort=username", headers=h).json()
    assert len(p3["items"]) == 2
    assert client.get("/api/admin/users?plan=pro", headers=h).json()["total"] == 4  # 3 + root
    assert client.get("/api/admin/users?status=disabled", headers=h).json()["total"] == 1
    assert client.get("/api/admin/users?query=USER3", headers=h).json()["total"] == 1
    assert client.get("/api/admin/users?sort=nope", headers=h).status_code == 422
    assert client.get("/api/admin/users?page_size=1000", headers=h).status_code == 422
    one = client.get("/api/admin/users?query=user1", headers=h).json()["items"][0]
    detail = client.get(f"/api/admin/users/{one['id']}", headers=h).json()
    assert {"runs_count", "recent_usage", "requests"} <= set(detail)


def test_stats_on_empty_db(client):
    admin = make_admin()
    s = client.get("/api/admin/stats", headers=auth(admin)).json()
    assert s["users"] == {"total": 1, "verified": 1, "free": 0, "pro": 1, "disabled": 0}
    assert len(s["signups_per_day"]) == 30 and sum(d["count"] for d in s["signups_per_day"]) == 1
    assert s["requests"] == {"pending": 0, "last_24h": 0, "last_7d": 0}
    assert s["latency_by_endpoint"] == [] and s["top_users"] == []
    assert s["error_rate"]["rate"] == 0.0 and set(s["jobs"]) == {"running", "queued"}
    summ = client.get("/api/admin/usage/summary", headers=auth(admin)).json()
    assert summ["total"] == 0 and summ["by_endpoint"] == []


def test_stats_with_usage(client, monkeypatch):
    from backend import usage
    monkeypatch.setenv("TELOMERE_USAGE_LOG", "on")
    admin = make_admin()
    pro = make_user("pro1", plan="pro")
    for _ in range(3):
        client.post("/api/simulate", json={}, headers=auth(pro))
    client.post("/api/simulate", json={}, headers=auth(make_user("fr")))
    usage.flush()
    s = client.get("/api/admin/stats", headers=auth(admin)).json()
    ep = {e["endpoint"]: e for e in s["latency_by_endpoint"]}
    assert ep["/api/simulate"]["count"] == 4 and ep["/api/simulate"]["p95_ms"] >= ep["/api/simulate"]["p50_ms"]
    assert s["top_users"][0]["username"] == "pro1" and s["top_users"][0]["count"] == 3
    assert s["compute_events_per_day"][-1]["count"] == 4


# ------------------------------------------------------------ usage logging
def _events():
    from backend import usage
    usage.flush()
    s = db_module.get_session()
    try:
        return s.execute(select(db_module.UsageEvent)).scalars().all()
    finally:
        s.close()


def test_usage_logging_privacy(client, monkeypatch):
    monkeypatch.setenv("TELOMERE_USAGE_LOG", "on")
    u = make_user("alice", plan="pro")
    h = auth(u)
    token = h["Authorization"].split()[1]
    secret = "SUPERSECRETBODYVALUE"
    xff = {"X-Forwarded-For": "203.0.113.77"}
    client.post("/api/simulate", json={"note": secret, "password": secret}, headers={**h, **xff})
    client.get("/api/jobs/some-job-id-123?token=" + secret, headers={**h, **xff})
    client.get("/api/health")
    client.options("/api/simulate")
    client.get("/api/admin/stats", headers=h)
    client.get("/api/jobs", headers={"Authorization": "Bearer not-a-token"})
    ev = _events()
    assert sorted(e.endpoint for e in ev) == ["/api/jobs", "/api/jobs/{job_id}", "/api/simulate"]
    for e in ev:
        blob = " ".join(str(getattr(e, c.name)) for c in e.__table__.columns)
        for banned in (secret, token, "203.0.113.77", "some-job-id-123"):
            assert banned not in blob
        assert len(e.ip_hash) == 16
    sim = next(e for e in ev if e.endpoint == "/api/simulate")
    assert sim.user_id == u.id and sim.kind == "compute" and sim.req_bytes > 0 and sim.method == "POST"
    anon = next(e for e in ev if e.endpoint == "/api/jobs")
    assert anon.user_id is None and anon.status_code == 401
    assert len({e.ip_hash for e in ev if e.user_id == u.id}) == 1  # same IP -> same hash


def test_usage_logging_survives_db_failure(client, monkeypatch):
    from backend import usage

    def boom(*a, **k):
        raise RuntimeError("db down")

    monkeypatch.setenv("TELOMERE_USAGE_LOG", "on")
    monkeypatch.setattr(usage._db, "get_session", boom)
    r = client.get("/api/meta/version")
    assert r.status_code == 200
    usage.flush()
    assert not usage._Q.unfinished_tasks


def test_usage_prune(monkeypatch):
    from backend import usage
    s = db_module.get_session()
    old = utcnow() - dt.timedelta(days=100)
    s.add_all([db_module.UsageEvent(ts=old, endpoint="/api/x", method="GET", status_code=200, duration_ms=1.0),
               db_module.UsageEvent(endpoint="/api/y", method="GET", status_code=200, duration_ms=1.0)])
    s.commit()
    s.close()
    monkeypatch.setenv("TELOMERE_USAGE_RETENTION_DAYS", "0")
    assert usage.prune() == 0
    monkeypatch.setenv("TELOMERE_USAGE_RETENTION_DAYS", "90")
    assert usage.prune() == 1
    assert len(_events()) == 1


def test_usage_list_filters_and_csv_export(client, monkeypatch):
    monkeypatch.setenv("TELOMERE_USAGE_LOG", "on")
    admin = make_admin()
    pro = make_user("pro1", plan="pro")
    free = make_user("fr")
    for _ in range(4):
        client.post("/api/simulate", json={}, headers=auth(pro))
    client.post("/api/simulate", json={}, headers=auth(free))
    client.get("/api/meta/version")
    _events()
    h = auth(admin)
    allp = client.get("/api/admin/usage?page_size=2", headers=h).json()
    assert allp["total"] == 6 and len(allp["items"]) == 2 and allp["pages"] == 3
    assert allp["items"][0]["ts"] >= allp["items"][1]["ts"]
    assert client.get(f"/api/admin/usage?user_id={pro.id}", headers=h).json()["total"] == 4
    assert client.get("/api/admin/usage?status=4xx", headers=h).json()["total"] == 1  # free user 403
    assert client.get("/api/admin/usage?status=200", headers=h).json()["total"] == 5
    assert client.get("/api/admin/usage?endpoint=/api/meta/version", headers=h).json()["total"] == 1
    assert client.get("/api/admin/usage?from=2999-01-01", headers=h).json()["total"] == 0
    assert client.get("/api/admin/usage?status=abc", headers=h).status_code == 422
    assert client.get("/api/admin/usage?from=garbage", headers=h).status_code == 422

    r = client.get("/api/admin/usage/export.csv?status=200", headers=h)
    assert r.headers["content-type"].startswith("text/csv") and "attachment" in r.headers["content-disposition"]
    rows = list(csv.reader(io.StringIO(r.text)))
    assert rows[0] == ["id", "ts", "user_id", "endpoint", "method", "status_code", "duration_ms",
                       "ip_hash", "req_bytes", "kind"]
    assert len(rows) == 6 and rows[2][3] == "/api/simulate"
    assert "usage_export" in [i["action"] for i in client.get("/api/admin/audit", headers=h).json()["items"]]
    summ = client.get("/api/admin/usage/summary?days=1", headers=h).json()
    assert summ["total"] == 6 and summ["unique_users"] == 2
    assert {e["endpoint"] for e in summ["by_endpoint"]} == {"/api/simulate", "/api/meta/version"}
