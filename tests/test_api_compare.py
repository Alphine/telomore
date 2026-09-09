"""API tests for backend/routers/compare.py (POST /api/compare, Phase 4): the
per-scenario result shape, deltas against the first scenario (shape + sign),
common-random-numbers seeding, a 400 on an invalid config, and the
six-scenario cap.

Same isolated-DB / isolated-ledger fixtures as tests/test_api_simulate.py.
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

DELTA_KEYS = {"fitness_abs", "fitness_pct", "senescence_pp", "reserve_kb", "mean_length_kb", "survival_abs"}


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
    from telomere_lab.experiments.registry import ExperimentRegistry

    runs = tmp_path / "runs"
    monkeypatch.setattr(config_module, "RUNS_DIR", runs)
    # See tests/test_api_artifacts.py::runs_dir -- the registry binds its
    # default runs_dir at import time. Compare records nothing, but the
    # registration tests share this process, so keep the isolation real.
    monkeypatch.setattr(ExperimentRegistry.__init__, "__defaults__", (runs,))

    from backend.main import create_app

    return TestClient(create_app())


def _token(client, username="cmp_user", email="cmp_user@example.com", password="hunter22") -> str:
    reg = client.post("/api/auth/register", json={"username": username, "email": email, "password": password})
    verify_token = reg.json()["dev_verification_link"].split("token=")[1]
    client.get("/api/auth/verify", params={"token": verify_token})
    return client.post("/api/auth/login", json={"username": username, "password": password}).json()["access_token"]


def _headers(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def test_compare_requires_auth(client):
    resp = client.post("/api/compare", json={"scenarios": [{"name": "Baseline", "config": FAST_MODEL}]})
    assert resp.status_code == 401


def test_compare_returns_results_and_deltas_vs_first_scenario(client):
    token = _token(client)
    body = {
        "scenarios": [
            {"name": "Baseline", "config": {**FAST_MODEL, "stress_level": 0.6}},
            {"name": "Low stress", "config": {**FAST_MODEL, "stress_level": 0.1}},
        ],
        "seed": 3,
    }
    resp = client.post("/api/compare", json=body, headers=_headers(token))
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["baseline"] == "Baseline"
    assert [s["name"] for s in data["scenarios"]] == ["Baseline", "Low stress"]

    base, low = data["scenarios"]
    # SimulationResult.to_json_dict() + fitness + breakdown per scenario.
    for s in (base, low):
        assert s["result"]["valid"] is True
        assert len(s["result"]["timeseries"]["cycle"]) == FAST_MODEL["cycles"] + 1
        assert s["result"]["config"]["seed"] == 3  # common random numbers applied
        assert "total" in s["breakdown"] and s["fitness"] == pytest.approx(s["breakdown"]["total"])
    assert base["deltas"] is None
    assert set(low["deltas"]) == DELTA_KEYS

    # Deltas are (other - baseline), so their sign follows the raw metrics.
    tm_b, tm_l = base["result"]["terminal_metrics"], low["result"]["terminal_metrics"]
    d = low["deltas"]
    assert d["fitness_abs"] == pytest.approx(low["fitness"] - base["fitness"])
    assert d["mean_length_kb"] == pytest.approx(
        (tm_l["final_mean_length_bp"] - tm_b["final_mean_length_bp"]) / 1000.0)
    assert d["senescence_pp"] == pytest.approx(
        (tm_l["final_senescent_fraction"] - tm_b["final_senescent_fraction"]) * 100.0)
    # Less stress -> longer telomeres in this model; the sign must reflect that.
    assert d["mean_length_kb"] > 0
    if base["fitness"] != 0:
        assert d["fitness_pct"] == pytest.approx(d["fitness_abs"] / abs(base["fitness"]) * 100.0)


def test_compare_matches_runner_functions(client):
    """The endpoint is a thin wrapper: same numbers as runner.compare_scenarios/deltas."""
    from telomere_lab.experiments.runner import compare_scenarios, deltas
    from telomere_lab.schemas import ModelConfig

    token = _token(client)
    cfg_a = ModelConfig.from_dict({**FAST_MODEL, "seed": 5}).validate()
    cfg_b = ModelConfig.from_dict({**FAST_MODEL, "seed": 5, "repair_rate": 0.9}).validate()
    comps = compare_scenarios({"A": cfg_a, "B": cfg_b})
    expected = deltas(comps[0], comps[1])

    resp = client.post("/api/compare", json={"scenarios": [
        {"name": "A", "config": cfg_a.to_dict()}, {"name": "B", "config": cfg_b.to_dict()},
    ]}, headers=_headers(token))
    assert resp.status_code == 200, resp.text
    got = resp.json()["scenarios"][1]["deltas"]
    for k in DELTA_KEYS:
        assert got[k] == pytest.approx(expected[k])


def test_compare_invalid_config_is_bad_request(client):
    token = _token(client)
    resp = client.post("/api/compare", json={"scenarios": [
        {"name": "Baseline", "config": FAST_MODEL},
        {"name": "Broken", "config": {**FAST_MODEL, "senescence_threshold": -1.0}},
    ]}, headers=_headers(token))
    assert resp.status_code == 400
    assert "Broken" in resp.json()["detail"]
    assert "senescence_threshold" in resp.json()["detail"]


def test_compare_rejects_duplicate_names(client):
    token = _token(client)
    resp = client.post("/api/compare", json={"scenarios": [
        {"name": "Same", "config": FAST_MODEL}, {"name": "Same", "config": FAST_MODEL},
    ]}, headers=_headers(token))
    assert resp.status_code == 400


def test_compare_caps_scenarios_at_six(client):
    token = _token(client)
    seven = [{"name": f"S{i}", "config": FAST_MODEL} for i in range(7)]
    resp = client.post("/api/compare", json={"scenarios": seven}, headers=_headers(token))
    assert resp.status_code in (400, 422)  # 422: pydantic max_length; 400: router cap

    six = seven[:6]
    resp = client.post("/api/compare", json={"scenarios": six}, headers=_headers(token))
    assert resp.status_code == 200, resp.text
    assert len(resp.json()["scenarios"]) == 6

    empty = client.post("/api/compare", json={"scenarios": []}, headers=_headers(token))
    assert empty.status_code == 422
