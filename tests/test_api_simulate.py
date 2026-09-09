"""API tests for backend/routers/simulate.py, evolve.py and jobs.py: a
synchronous simulate call, a background evolve job polled to completion, and
cross-user job/experiment ownership enforcement.

Same isolated-DB / isolated-ledger fixtures as tests/test_api_auth.py.
"""

from __future__ import annotations

import sys
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

SRC = Path(__file__).resolve().parents[1] / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from telomere_lab import db as db_module  # noqa: E402

FAST_MODEL = {
    "cycles": 20,
    "population_size": 20,
    "carrying_capacity": 40,
    "telomeres_per_cell": 6,
}


@pytest.fixture(autouse=True)
def _isolated_db(tmp_path, monkeypatch):
    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.delenv("RESEND_API_KEY", raising=False)
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


def _registered_and_verified_token(client, username: str, email: str, password: str = "hunter22") -> str:
    reg = client.post("/api/auth/register", json={"username": username, "email": email, "password": password})
    link = reg.json()["dev_verification_link"]
    verify_token = link.split("token=")[1]
    verify_resp = client.get("/api/auth/verify", params={"token": verify_token})
    assert verify_resp.json()["verified"] is True
    login = client.post("/api/auth/login", json={"username": username, "password": password})
    assert login.status_code == 200
    return login.json()["access_token"]


def _auth_headers(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def test_simulate_requires_auth(client):
    resp = client.post("/api/simulate", json={"config": FAST_MODEL})
    assert resp.status_code == 401


def test_simulate_returns_sane_result(client):
    token = _registered_and_verified_token(client, "sim_user", "sim_user@example.com")
    resp = client.post("/api/simulate", json={"config": FAST_MODEL}, headers=_auth_headers(token))
    assert resp.status_code == 200, resp.text
    run = resp.json()["run"]
    assert run["valid"] is True
    assert run["run_id"].startswith("TEL-")
    assert "fitness" in run and "total" in run["fitness"]
    assert "timeseries" in run and len(run["timeseries"]["cycle"]) > 0


def test_simulate_invalid_config_is_bad_request(client):
    token = _registered_and_verified_token(client, "bad_cfg_user", "bad_cfg_user@example.com")
    bad = dict(FAST_MODEL)
    bad["senescence_threshold"] = -1.0  # out of PARAMETER_BOUNDS
    resp = client.post("/api/simulate", json={"config": bad}, headers=_auth_headers(token))
    assert resp.status_code == 400


def _poll_job(client, token, job_id, timeout=30):
    deadline = time.time() + timeout
    while time.time() < deadline:
        resp = client.get(f"/api/jobs/{job_id}", headers=_auth_headers(token))
        assert resp.status_code == 200
        body = resp.json()
        if body["status"] in ("completed", "failed", "stopped"):
            return body
        time.sleep(0.2)
    raise AssertionError("job did not finish within timeout")


def test_evolve_job_runs_to_completion_and_has_progress(client):
    token = _registered_and_verified_token(client, "evolve_user", "evolve_user@example.com")
    resp = client.post("/api/evolve", json={
        "model": FAST_MODEL,
        "evolution": {"population_size": 8, "generations": 2, "eval_seeds": [1], "checkpoint_every": 0},
    }, headers=_auth_headers(token))
    assert resp.status_code == 200, resp.text
    job_id = resp.json()["job_id"]

    final = _poll_job(client, token, job_id)
    assert final["status"] == "completed"
    assert final["result"]["run_id"].startswith("TEL-")
    assert "best" in final["result"] and "genome" in final["result"]["best"]
    assert len(final["result"]["history"]) >= 1


def test_job_ownership_is_enforced(client):
    token_a = _registered_and_verified_token(client, "owner_a", "owner_a@example.com")
    token_b = _registered_and_verified_token(client, "owner_b", "owner_b@example.com")

    resp = client.post("/api/evolve", json={
        "model": FAST_MODEL,
        "evolution": {"population_size": 4, "generations": 1, "eval_seeds": [1], "checkpoint_every": 0},
    }, headers=_auth_headers(token_a))
    job_id = resp.json()["job_id"]

    # Owner can poll and stop; another user gets 403 on both.
    own_status = client.get(f"/api/jobs/{job_id}", headers=_auth_headers(token_a))
    assert own_status.status_code == 200

    other_status = client.get(f"/api/jobs/{job_id}", headers=_auth_headers(token_b))
    assert other_status.status_code == 403

    other_stop = client.post(f"/api/jobs/{job_id}/stop", headers=_auth_headers(token_b))
    assert other_stop.status_code == 403

    _poll_job(client, token_a, job_id)


def test_experiments_mine_filter_excludes_other_users_runs(client):
    token_a = _registered_and_verified_token(client, "exp_a", "exp_a@example.com")
    token_b = _registered_and_verified_token(client, "exp_b", "exp_b@example.com")

    sim = client.post("/api/simulate", json={"config": FAST_MODEL}, headers=_auth_headers(token_a))
    run_id = sim.json()["run"]["run_id"]

    mine_a = client.get("/api/experiments", params={"mine": True}, headers=_auth_headers(token_a))
    assert any(r["run_id"] == run_id for r in mine_a.json())

    mine_b = client.get("/api/experiments", params={"mine": True}, headers=_auth_headers(token_b))
    assert all(r["run_id"] != run_id for r in mine_b.json())

    all_b = client.get("/api/experiments", params={"mine": False}, headers=_auth_headers(token_b))
    assert any(r["run_id"] == run_id for r in all_b.json())

    detail = client.get(f"/api/experiments/{run_id}", headers=_auth_headers(token_a))
    assert detail.status_code == 200
    assert detail.json()["record"]["run_id"] == run_id


def test_experiment_detail_404_for_unknown_run(client):
    token = _registered_and_verified_token(client, "exp_404", "exp_404@example.com")
    resp = client.get("/api/experiments/TEL-99999999-999", headers=_auth_headers(token))
    assert resp.status_code == 404
