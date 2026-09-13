"""API contract for GET /api/jobs (list active jobs) -- the fix for jobs
appearing to vanish when the frontend navigates away from a job's page
(the job itself keeps running server-side on a detached daemon thread;
only the page's local jobId state is lost on unmount, see docs/API.md's
"Long-running jobs" section):

* a started job appears in the list while pending/running;
* a job belonging to a different user is never visible;
* a completed job drops out of the list on the next call;
* the endpoint is owner-scoped like every other job route (401 without auth).

Same isolated-DB / isolated-ledger fixtures and ``_poll_job`` helper as
tests/test_api_schedule.py. Uses /api/sensitivity as a cheap job to start
(small OAT sweep over one parameter, fast to complete).
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

CHEAP_SENSITIVITY = {"parameters": ["stress_level"], "eval_seeds": [1]}


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


def _token(client, username="jobs_user", email="jobs_user@example.com", password="hunter22") -> str:
    reg = client.post("/api/auth/register", json={"username": username, "email": email, "password": password})
    verify_token = reg.json()["dev_verification_link"].split("token=")[1]
    client.get("/api/auth/verify", params={"token": verify_token})
    return client.post("/api/auth/login", json={"username": username, "password": password}).json()["access_token"]


def _headers(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def _poll_job(client, token, job_id, timeout=60):
    deadline = time.time() + timeout
    while time.time() < deadline:
        body = client.get(f"/api/jobs/{job_id}", headers=_headers(token)).json()
        if body["status"] in ("completed", "failed", "stopped"):
            return body
        time.sleep(0.05)
    raise AssertionError("job did not finish within timeout")


def test_active_job_appears_in_list_while_running_or_pending(client):
    token = _token(client)
    resp = client.post("/api/sensitivity", json={"model": FAST_MODEL, "sensitivity": CHEAP_SENSITIVITY},
                       headers=_headers(token))
    assert resp.status_code == 200, resp.text
    job_id = resp.json()["job_id"]

    listing = client.get("/api/jobs", headers=_headers(token)).json()
    assert any(j["job_id"] == job_id for j in listing)
    matched = next(j for j in listing if j["job_id"] == job_id)
    assert matched["kind"] == "sensitivity"
    assert matched["status"] in ("pending", "running")


def test_completed_job_drops_out_of_the_list(client):
    token = _token(client)
    resp = client.post("/api/sensitivity", json={"model": FAST_MODEL, "sensitivity": CHEAP_SENSITIVITY},
                       headers=_headers(token))
    job_id = resp.json()["job_id"]
    final = _poll_job(client, token, job_id)
    assert final["status"] == "completed"

    listing = client.get("/api/jobs", headers=_headers(token)).json()
    assert all(j["job_id"] != job_id for j in listing)


def test_another_users_job_is_not_visible(client):
    token_a = _token(client, "jobs_user_a", "a@example.com")
    token_b = _token(client, "jobs_user_b", "b@example.com")
    resp = client.post("/api/sensitivity", json={"model": FAST_MODEL, "sensitivity": CHEAP_SENSITIVITY},
                       headers=_headers(token_a))
    job_id = resp.json()["job_id"]

    listing_b = client.get("/api/jobs", headers=_headers(token_b)).json()
    assert all(j["job_id"] != job_id for j in listing_b)

    listing_a = client.get("/api/jobs", headers=_headers(token_a)).json()
    assert any(j["job_id"] == job_id for j in listing_a)


def test_list_jobs_requires_auth(client):
    resp = client.get("/api/jobs")
    assert resp.status_code == 401
