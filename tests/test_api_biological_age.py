"""API tests for the synthetic "biological age" biomarker score
(ROADMAP.md candidate feature #5): wired into /api/simulate, /api/simulate/
ensemble and /api/compare wherever a SimulationResult/terminal metrics
already flow. Same isolated-DB / isolated-ledger fixtures as
tests/test_api_simulate.py.
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


def test_simulate_response_carries_biological_age(client):
    token = _registered_and_verified_token(client, "ba_sim_user", "ba_sim_user@example.com")
    resp = client.post("/api/simulate", json={"config": FAST_MODEL}, headers=_auth_headers(token))
    assert resp.status_code == 200, resp.text
    run = resp.json()["run"]
    ba = run["biological_age"]
    assert ba["valid"] is True
    assert isinstance(ba["final_score"], float)
    assert 0.0 <= ba["final_score"] <= 100.0
    assert len(ba["score_over_time"]) == len(run["timeseries"]["cycle"])
    assert "0" in ba["scale_label"] and "100" in ba["scale_label"]
    assert ba["formula_note"]


def test_invalid_simulate_config_never_reaches_biological_age(client):
    # An invalid config is rejected with 400 before any SimulationResult (and
    # therefore any biological_age) exists -- confirms no crash on that path.
    token = _registered_and_verified_token(client, "ba_bad_user", "ba_bad_user@example.com")
    bad = dict(FAST_MODEL)
    bad["senescence_threshold"] = -1.0
    resp = client.post("/api/simulate", json={"config": bad}, headers=_auth_headers(token))
    assert resp.status_code == 400


def test_ensemble_response_carries_per_seed_biological_age_final(client):
    token = _registered_and_verified_token(client, "ba_ens_user", "ba_ens_user@example.com")
    resp = client.post(
        "/api/simulate/ensemble",
        json={"config": FAST_MODEL, "n_seeds": 3},
        headers=_auth_headers(token),
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert len(body["series"]) == 3
    for seed_result in body["series"]:
        assert seed_result["valid"] is True
        score = seed_result["biological_age_final"]
        assert score is not None
        assert 0.0 <= score <= 100.0


def test_compare_response_carries_biological_age_per_scenario(client):
    token = _registered_and_verified_token(client, "ba_cmp_user", "ba_cmp_user@example.com")
    resp = client.post(
        "/api/compare",
        json={
            "scenarios": [
                {"name": "baseline", "config": FAST_MODEL},
                {"name": "stressed", "config": {**FAST_MODEL, "stress_level": 0.9, "maintenance_rate": 0.0}},
            ],
        },
        headers=_auth_headers(token),
    )
    assert resp.status_code == 200, resp.text
    scenarios = resp.json()["scenarios"]
    assert len(scenarios) == 2
    scores = {}
    for sc in scenarios:
        ba = sc["result"]["biological_age"]
        assert ba["valid"] is True
        scores[sc["name"]] = ba["final_score"]
    # The heavily stressed, non-maintained scenario should read as "older".
    assert scores["stressed"] > scores["baseline"]
