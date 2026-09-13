"""API contract for the genotype x environment (G×E) study (docs/ROADMAP.md
2026-09-13 follow-up to Genome Stability):

* ``POST /api/gxe`` starts a background job (like sensitivity/evolve/pareto/
  active-learning, not the synchronous ``/api/compare`` pattern);
* a semantically invalid genotype/environment/grid-size config surfaces the
  core ``ConfigError`` as a 400; a malformed JSON shape is a 422;
* the completed job's result carries ``items`` (one per genotype x
  environment cell) and ``reranking_pairs``;
* the run is registered in the ledger with ``kind="gxe"``.

Same isolated-DB / isolated-ledger fixtures and ``_poll_job`` helper as
tests/test_api_schedule.py.
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

GXE_CONFIG = {
    "genotypes": [
        {"name": "A", "overrides": {}},
        {"name": "B", "overrides": {"maintenance_rate": 0.5}},
    ],
    "environments": [
        {"name": "low_stress", "overrides": {"stress_level": 0.3}},
        {"name": "high_stress", "overrides": {"stress_level": 0.7}},
    ],
    "eval_seeds": [1, 2],
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


def _token(client, username="gxe_user", email="gxe_user@example.com", password="hunter22") -> str:
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
        time.sleep(0.2)
    raise AssertionError("job did not finish within timeout")


def test_gxe_job_runs_to_completion_and_registers_in_ledger(client):
    token = _token(client)
    resp = client.post("/api/gxe", json={"model": FAST_MODEL, "gxe": GXE_CONFIG}, headers=_headers(token))
    assert resp.status_code == 200, resp.text
    job_id = resp.json()["job_id"]

    final = _poll_job(client, token, job_id)
    assert final["status"] == "completed", final.get("error")
    result = final["result"]
    assert len(result["items"]) == 4  # 2 genotypes x 2 environments
    assert "reranking_pairs" in result
    assert result["evaluations"] == 4 * 2  # cells x eval_seeds
    assert result["run_id"]

    ledger = client.get(f"/api/experiments/{result['run_id']}", headers=_headers(token))
    assert ledger.status_code == 200, ledger.text
    assert ledger.json()["record"]["kind"] == "gxe"


def test_gxe_reports_progress_while_running(client):
    token = _token(client)
    resp = client.post("/api/gxe", json={"model": FAST_MODEL, "gxe": GXE_CONFIG}, headers=_headers(token))
    job_id = resp.json()["job_id"]
    final = _poll_job(client, token, job_id)
    assert final["progress"] is not None
    assert set(final["progress"]) >= {"genotype", "environment", "fitness"}


@pytest.mark.parametrize(
    "gxe, fragment",
    [
        ({**GXE_CONFIG, "genotypes": []}, "at least one genotype"),
        ({**GXE_CONFIG, "environments": []}, "at least one environment"),
        ({**GXE_CONFIG, "genotypes": [{"name": "A", "overrides": {"stress_level": 0.5}}, GXE_CONFIG["genotypes"][1]]},
         "cannot override"),
        ({**GXE_CONFIG, "environments": [{"name": "e", "overrides": {"maintenance_rate": 0.5}}]}, "cannot override"),
        ({**GXE_CONFIG, "genotypes": [{"name": "dup", "overrides": {}}, {"name": "dup", "overrides": {}}]},
         "must be unique"),
    ],
)
def test_gxe_invalid_config_is_400_with_config_error_text(client, gxe, fragment):
    token = _token(client)
    resp = client.post("/api/gxe", json={"model": FAST_MODEL, "gxe": gxe}, headers=_headers(token))
    assert resp.status_code == 400, resp.text
    assert fragment in resp.json()["detail"]


def test_gxe_malformed_model_shape_is_422(client):
    # `gxe` itself is a free-form dict (like SensitivityRequest.sensitivity) --
    # its shape errors surface as ConfigError -> 400 via GxEConfig.from_dict,
    # not a pydantic 422. The typed `model.schedule` field is where a
    # malformed-JSON-type 422 is actually reachable, exactly like every other
    # job endpoint (test_api_schedule.py's own malformed-shape test).
    token = _token(client)
    resp = client.post(
        "/api/gxe",
        json={"model": {**FAST_MODEL, "schedule": {"phases": "many", "values": {}}}, "gxe": GXE_CONFIG},
        headers=_headers(token),
    )
    assert resp.status_code == 422


def test_gxe_bounds_expose_environment_overridable(client):
    body = client.get("/api/meta/bounds").json()
    assert body["environment_overridable"] == ["stress_level"]
