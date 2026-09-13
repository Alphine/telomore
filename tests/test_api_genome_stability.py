"""API contract for genome stability (docs/MODEL.md §2.3):

* ``POST /api/simulate`` accepts the 4 new plain-scalar ``ModelConfig``
  fields with zero schema changes (``ModelConfigBody`` has ``extra="allow"``)
  and returns ``mean_mutation_burden``/``apoptotic_fraction`` in
  ``timeseries`` and ``final_mutation_burden``/``genomic_instability_index``
  in ``terminal_metrics`` with zero ``SimulationRunResponse`` schema changes
  (both are generic passthrough dicts);
* leaving the fields unset reports all-zero/absent-equivalent values and
  does not change any other field of the response.

Same isolated-DB / isolated-ledger fixtures as tests/test_api_subclones.py.
"""

from __future__ import annotations

import sys
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

GENOME_STABILITY = {
    "replication_error_rate": 0.02,
    "oxidative_mutation_sensitivity": 0.02,
    "checkpoint_strength": 0.3,
    "mutation_threshold": 0.5,
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


def _token(client, username="genome_user", email="genome_user@example.com", password="hunter22") -> str:
    reg = client.post("/api/auth/register", json={"username": username, "email": email, "password": password})
    verify_token = reg.json()["dev_verification_link"].split("token=")[1]
    client.get("/api/auth/verify", params={"token": verify_token})
    return client.post("/api/auth/login", json={"username": username, "password": password}).json()["access_token"]


def _headers(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def test_simulate_with_genome_stability_returns_new_timeseries_and_terminal_metrics(client):
    token = _token(client)
    resp = client.post("/api/simulate", json={"config": {**FAST_MODEL, **GENOME_STABILITY}},
                       headers=_headers(token))
    assert resp.status_code == 200, resp.text
    run = resp.json()["run"]
    assert run["valid"] is True
    for key, value in GENOME_STABILITY.items():
        assert run["config"][key] == pytest.approx(value)
    cycles = FAST_MODEL["cycles"]
    ts = run["timeseries"]
    assert len(ts["mean_mutation_burden"]) == cycles + 1 == len(ts["cycle"])
    assert len(ts["apoptotic_fraction"]) == cycles + 1
    assert ts["mean_mutation_burden"][-1] > 0.0
    assert "final_mutation_burden" in run["terminal_metrics"]
    assert "genomic_instability_index" in run["terminal_metrics"]


def test_simulate_without_genome_stability_reports_zero_values(client):
    token = _token(client)
    resp = client.post("/api/simulate", json={"config": FAST_MODEL}, headers=_headers(token))
    assert resp.status_code == 200, resp.text
    run = resp.json()["run"]
    ts = run["timeseries"]
    assert all(v == 0.0 for v in ts["mean_mutation_burden"])
    assert all(v == 0.0 for v in ts["apoptotic_fraction"])
    assert run["terminal_metrics"]["final_mutation_burden"] == 0.0
    assert run["terminal_metrics"]["genomic_instability_index"] == 0.0
    assert run["config"]["replication_error_rate"] == 0.0
    assert run["config"]["checkpoint_strength"] == 0.0


def test_simulate_invalid_genome_stability_value_is_400(client):
    token = _token(client)
    resp = client.post("/api/simulate",
                       json={"config": {**FAST_MODEL, "checkpoint_strength": 5.0}},
                       headers=_headers(token))
    assert resp.status_code == 400, resp.text
    assert "checkpoint_strength" in resp.json()["detail"]


def test_bounds_exposes_genome_stability_parameters(client):
    body = client.get("/api/meta/bounds").json()
    for key in GENOME_STABILITY:
        assert key in body["bounds"]
    assert body["defaults"]["checkpoint_strength"] == 0.0
