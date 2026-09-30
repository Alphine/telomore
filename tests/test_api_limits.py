"""Abuse-protection tests for the API layer: job-size caps, job concurrency /
per-user caps / eviction, rate limiting, password + username validation,
experiment run-id sanitising and the SECRET_KEY guard on Railway.

The core library stays unrestricted -- see ``test_library_is_not_limited``.
"""

from __future__ import annotations

import os
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from telomere_lab import db as db_module  # noqa: E402

FAST_MODEL = {"cycles": 20, "population_size": 20, "carrying_capacity": 40, "telomeres_per_cell": 6}


@pytest.fixture(autouse=True)
def _isolated_db(tmp_path, monkeypatch):
    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.delenv("RESEND_API_KEY", raising=False)
    monkeypatch.delenv("TELOMERE_DISABLE_LIMITS", raising=False)
    monkeypatch.setattr(db_module, "DATA_DIR", tmp_path / "data")
    db_module.reset_engine()
    yield
    db_module.reset_engine()


@pytest.fixture()
def client(tmp_path, monkeypatch):
    from telomere_lab import config as config_module

    monkeypatch.setattr(config_module, "RUNS_DIR", tmp_path / "runs")
    from backend.main import create_app

    return TestClient(create_app())


def _token(client, username="limits_user", email=None, password="hunter22") -> str:
    email = email or f"{username}@example.com"
    reg = client.post("/api/auth/register", json={"username": username, "email": email, "password": password})
    assert reg.status_code == 201, reg.text
    client.get("/api/auth/verify", params={"token": reg.json()["dev_verification_link"].split("token=")[1]})
    return client.post("/api/auth/login", json={"username": username, "password": password}).json()["access_token"]


def _h(token):
    return {"Authorization": f"Bearer {token}"}


# ----------------------------------------------------------------- size caps
def test_library_is_not_limited():
    from telomere_lab.schemas import EvolutionConfig, ModelConfig

    ModelConfig(population_size=100_000, carrying_capacity=400_000, telomeres_per_cell=500, cycles=50_000).validate()
    EvolutionConfig(population_size=5000, generations=5000).validate()


def test_frontend_form_maxima_are_accepted(client):
    token = _token(client)
    body = {"config": {"population_size": 2000, "carrying_capacity": 5000, "telomeres_per_cell": 92, "cycles": 5}}
    assert client.post("/api/simulate", json=body, headers=_h(token)).status_code == 200


def test_oversized_population_rejected_with_env_var_name(client):
    token = _token(client)
    r = client.post("/api/simulate", json={"config": {"population_size": 6000, "carrying_capacity": 7000, "cycles": 5}},
                    headers=_h(token))
    assert r.status_code == 422
    assert "TELOMERE_MAX_POPULATION_SIZE" in r.json()["detail"]


def test_run_cost_budget_rejected(client):
    token = _token(client)
    cfg = {"population_size": 5000, "carrying_capacity": 20000, "telomeres_per_cell": 92, "cycles": 1000}
    r = client.post("/api/simulate", json={"config": cfg}, headers=_h(token))
    assert r.status_code == 422
    assert "TELOMERE_MAX_RUN_COST" in r.json()["detail"]


def test_optimizer_caps(client):
    token = _token(client)
    r = client.post("/api/evolve", json={"model": FAST_MODEL, "evolution": {"generations": 5000}}, headers=_h(token))
    assert r.status_code == 422 and "TELOMERE_MAX_GA_GENERATIONS" in r.json()["detail"]
    r = client.post("/api/evolve", json={"model": FAST_MODEL, "evolution": {"eval_seeds": list(range(100))}},
                    headers=_h(token))
    assert r.status_code == 422 and "TELOMERE_MAX_EVAL_SEEDS" in r.json()["detail"]
    r = client.post("/api/active-learning",
                    json={"model": FAST_MODEL, "active_learning": {"candidate_pool_size": 10**7}}, headers=_h(token))
    assert r.status_code == 422 and "TELOMERE_MAX_CANDIDATE_POOL" in r.json()["detail"]
    r = client.post("/api/simulate/ensemble", json={"config": FAST_MODEL, "n_seeds": 50}, headers=_h(token))
    assert r.status_code == 200


def test_job_cost_budget_and_env_override(client, monkeypatch):
    token = _token(client)
    body = {"model": FAST_MODEL, "sensitivity": {"parameters": ["stress_level"], "eval_seeds": [1]}}
    monkeypatch.setenv("TELOMERE_MAX_JOB_COST", "1000")
    r = client.post("/api/sensitivity", json=body, headers=_h(token))
    assert r.status_code == 422 and "TELOMERE_MAX_JOB_COST" in r.json()["detail"]
    monkeypatch.setenv("TELOMERE_MAX_JOB_COST", "off")
    assert client.post("/api/sensitivity", json=body, headers=_h(token)).status_code == 200


def test_disable_limits_switch(monkeypatch):
    from fastapi import HTTPException

    from backend import limits
    from telomere_lab.schemas import ModelConfig

    cfg = ModelConfig(population_size=10_000, carrying_capacity=40_000, cycles=2000)
    with pytest.raises(HTTPException):
        limits.check_model(cfg)
    monkeypatch.setenv("TELOMERE_DISABLE_LIMITS", "1")
    limits.check_model(cfg)


# ---------------------------------------------------------------------- jobs
def _wait(pred, timeout=5.0):
    deadline = time.time() + timeout
    while not pred() and time.time() < deadline:
        time.sleep(0.05)


def test_concurrency_limit_queues_jobs_as_pending(monkeypatch):
    from backend import jobs

    monkeypatch.setenv("TELOMERE_MAX_CONCURRENT_JOBS", "1")
    monkeypatch.setenv("TELOMERE_MAX_ACTIVE_JOBS_PER_USER", "10")
    gate = threading.Event()
    first = jobs.create_job("t", 1)
    second = jobs.create_job("t", 1)
    jobs.run_job(first, lambda j: (gate.wait(10), {"ok": 1})[1])
    _wait(lambda: first.status == "running")
    jobs.run_job(second, lambda j: {"ok": 2})
    time.sleep(0.5)
    assert first.status == "running"
    assert second.status == "pending"  # queued, not running
    gate.set()
    _wait(lambda: second.status == "completed")
    assert first.status == second.status == "completed"


def test_stopping_a_queued_job_never_runs_it(monkeypatch):
    from backend import jobs

    monkeypatch.setenv("TELOMERE_MAX_CONCURRENT_JOBS", "1")
    monkeypatch.setenv("TELOMERE_MAX_ACTIVE_JOBS_PER_USER", "10")
    gate = threading.Event()
    ran = []
    a, b = jobs.create_job("t", 2), jobs.create_job("t", 2)
    jobs.run_job(a, lambda j: (gate.wait(10), {})[1])
    _wait(lambda: a.status == "running")
    jobs.run_job(b, lambda j: ran.append(1) or {})
    jobs.request_stop(b)
    _wait(lambda: b.status == "stopped")
    gate.set()
    assert b.status == "stopped" and not ran


def test_per_user_active_job_cap_returns_429(client, monkeypatch):
    monkeypatch.setenv("TELOMERE_MAX_ACTIVE_JOBS_PER_USER", "1")
    token = _token(client)
    body = {"model": {"cycles": 60, "population_size": 200, "carrying_capacity": 400, "telomeres_per_cell": 16},
            "evolution": {"population_size": 8, "generations": 6, "eval_seeds": [1, 2]}}
    first = client.post("/api/evolve", json=body, headers=_h(token))
    assert first.status_code == 200, first.text
    second = client.post("/api/evolve", json=body, headers=_h(token))
    assert second.status_code == 429
    assert "TELOMERE_MAX_ACTIVE_JOBS_PER_USER" in second.json()["detail"]
    assert second.headers.get("retry-after")
    client.post(f"/api/jobs/{first.json()['job_id']}/stop", headers=_h(token))


def test_finished_jobs_are_evicted(monkeypatch):
    from backend import jobs

    monkeypatch.setenv("TELOMERE_MAX_ACTIVE_JOBS_PER_USER", "100")
    monkeypatch.setenv("TELOMERE_MAX_FINISHED_JOBS", "2")
    made = []
    for _ in range(4):
        j = jobs.create_job("t", 3)
        jobs.run_job(j, lambda _j: {})
        made.append(j)
    _wait(lambda: all(j.status == "completed" for j in made))
    jobs.create_job("t", 3)  # triggers eviction
    kept = [j for j in made if jobs.get_job(j.job_id) is not None]
    assert len(kept) <= 2
    # TTL eviction
    monkeypatch.setenv("TELOMERE_MAX_FINISHED_JOBS", "off")
    monkeypatch.setenv("TELOMERE_JOB_TTL_SECONDS", "1")
    for j in kept:
        j.finished_at = time.time() - 100
    jobs.create_job("t", 3)
    assert all(jobs.get_job(j.job_id) is None for j in kept)


# ------------------------------------------------------------- rate limiting
def test_login_rate_limit_429_with_retry_after(client, monkeypatch):
    monkeypatch.setenv("TELOMERE_RATE_LIMIT", "on")
    monkeypatch.setenv("TELOMERE_RATE_LIMIT_LOGIN", "3")
    codes = [client.post("/api/auth/login", json={"username": "x", "password": "y"}).status_code for _ in range(4)]
    assert codes == [401, 401, 401, 429]
    r = client.post("/api/auth/login", json={"username": "x", "password": "y"})
    assert r.status_code == 429 and int(r.headers["retry-after"]) >= 1


def test_rate_limit_is_per_forwarded_client_ip(client, monkeypatch):
    monkeypatch.setenv("TELOMERE_RATE_LIMIT", "on")
    monkeypatch.setenv("TELOMERE_RATE_LIMIT_FORGOT_PASSWORD", "1")
    body = {"email": "nobody@example.com"}
    a = {"X-Forwarded-For": "1.1.1.1, 10.0.0.1"}
    assert client.post("/api/auth/forgot-password", json=body, headers=a).status_code == 200
    assert client.post("/api/auth/forgot-password", json=body, headers=a).status_code == 429
    assert client.post("/api/auth/forgot-password", json=body, headers={"X-Forwarded-For": "2.2.2.2"}).status_code == 200


def test_register_and_foci_overlay_are_limited(client, monkeypatch):
    monkeypatch.setenv("TELOMERE_RATE_LIMIT", "on")
    monkeypatch.setenv("TELOMERE_RATE_LIMIT_REGISTER", "1")
    monkeypatch.setenv("TELOMERE_RATE_LIMIT_FOCI_OVERLAY", "2")
    ok = {"username": "abc", "email": "abc@example.com", "password": "longenough1"}
    assert client.post("/api/auth/register", json=ok).status_code == 201
    assert client.post("/api/auth/register", json={**ok, "username": "abd"}).status_code == 429
    assert [client.get("/api/foci/overlay", params={"well": "bad"}).status_code for _ in range(3)] == [400, 400, 429]


# ------------------------------------------------- password / username checks
def test_register_password_and_username_validation(client):
    def reg(**kw):
        body = {"username": "validuser", "email": "v@example.com", "password": "goodpass1"}
        body.update(kw)
        return client.post("/api/auth/register", json=body)

    assert reg(password="short").status_code == 422
    assert reg(password="a" * 73).status_code == 422
    assert reg(password="é" * 37).status_code == 422       # 37 chars but 74 bytes
    assert reg(username="ab").status_code == 422
    assert reg(username="u" * 151).status_code == 422
    assert reg(password="a" * 72).status_code == 201             # exactly 72 bytes is fine


def test_reset_password_enforces_new_rules_login_keeps_legacy(client):
    user = db_module.create_user("legacy", "legacy@example.com", "abc")  # short legacy password
    db_module.verify_email(db_module.generate_verification_token(user.id))
    assert client.post("/api/auth/login", json={"username": "legacy", "password": "abc"}).status_code == 200
    assert client.post("/api/auth/login", json={"username": "legacy", "password": "z" * 200}).status_code == 401
    r = client.post("/api/auth/reset-password", json={"token": "whatever", "new_password": "short"})
    assert r.status_code == 422
    r = client.post("/api/auth/reset-password", json={"token": "whatever", "new_password": "x" * 80})
    assert r.status_code == 422


# ---------------------------------------------------------------- misc fixes
def test_get_experiment_rejects_unsafe_run_id(client):
    token = _token(client)
    assert client.get("/api/experiments/.hidden", headers=_h(token)).status_code == 400
    assert client.get("/api/experiments/nope", headers=_h(token)).status_code == 404


def _import_auth(env_extra: dict, drop: tuple = ()) -> subprocess.CompletedProcess:
    env = {k: v for k, v in os.environ.items() if k not in drop}
    env.update(env_extra)
    env["PYTHONPATH"] = os.pathsep.join([str(SRC), str(ROOT)])
    return subprocess.run([sys.executable, "-c", "import backend.auth"], env=env, cwd=ROOT,
                          capture_output=True, text=True, timeout=120)


def test_missing_secret_key_fails_hard_on_railway_only():
    bad = _import_auth({"RAILWAY_ENVIRONMENT": "production"}, drop=("SECRET_KEY",))
    assert bad.returncode != 0 and "SECRET_KEY" in bad.stderr
    assert _import_auth({"RAILWAY_ENVIRONMENT": "production", "SECRET_KEY": "x" * 32}).returncode == 0
    assert _import_auth({}, drop=("SECRET_KEY", "RAILWAY_ENVIRONMENT")).returncode == 0
