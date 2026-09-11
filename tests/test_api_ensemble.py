"""API contract for POST /api/simulate/ensemble (ROADMAP.md candidate feature
#2, ensemble / uncertainty visualization): run N seeds of one config and
return the spread instead of a single trajectory.

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

SCHEDULE = {"phases": 2, "values": {"stress_level": [0.9, 0.3]}}


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


def _token(client, username="ens_user", email="ens_user@example.com", password="hunter22") -> str:
    reg = client.post("/api/auth/register", json={"username": username, "email": email, "password": password})
    verify_token = reg.json()["dev_verification_link"].split("token=")[1]
    client.get("/api/auth/verify", params={"token": verify_token})
    return client.post("/api/auth/login", json={"username": username, "password": password}).json()["access_token"]


def _headers(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def test_ensemble_requires_auth(client):
    resp = client.post("/api/simulate/ensemble", json={"config": FAST_MODEL, "n_seeds": 5})
    assert resp.status_code == 401


def test_ensemble_returns_per_seed_series_and_bands(client):
    token = _token(client)
    resp = client.post("/api/simulate/ensemble", json={"config": FAST_MODEL, "n_seeds": 5, "base_seed": 100},
                       headers=_headers(token))
    assert resp.status_code == 200, resp.text
    body = resp.json()

    assert body["run_id"].startswith("TEL-")
    assert body["n_seeds"] == 5
    assert body["base_seed"] == 100
    assert body["seeds"] == [100, 101, 102, 103, 104]

    cycles = FAST_MODEL["cycles"]
    expected_len = cycles + 1

    bands = body["bands"]
    assert len(bands["cycle"]) == expected_len
    for key in ("p10", "p50", "p90", "mean"):
        assert len(bands[key]) == expected_len
    # Percentile ordering holds at every timestep.
    for lo, mid, hi in zip(bands["p10"], bands["p50"], bands["p90"]):
        assert lo <= mid + 1e-9
        assert mid <= hi + 1e-9

    series = body["series"]
    assert len(series) == 5
    assert [s["seed"] for s in series] == [100, 101, 102, 103, 104]
    for s in series:
        assert s["valid"] is True
        assert len(s["mean_length"]) == expected_len
        assert len(s["shortest_length"]) == expected_len
        assert len(s["population_size"]) == expected_len
        assert len(s["proliferative_count"]) == expected_len
        assert len(s["senescent_fraction"]) == expected_len
        assert "final_mean_length_bp" in s["terminal_metrics"]

    # Different seeds -> not every seed's trajectory is bit-identical.
    assert len({tuple(s["mean_length"]) for s in series}) > 1

    assert body["applied_schedule"] == {}


def test_ensemble_default_base_seed_is_config_seed(client):
    token = _token(client)
    cfg = {**FAST_MODEL, "seed": 7}
    resp = client.post("/api/simulate/ensemble", json={"config": cfg, "n_seeds": 3}, headers=_headers(token))
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["base_seed"] == 7
    assert body["seeds"] == [7, 8, 9]


def test_ensemble_with_schedule_shares_applied_schedule_across_seeds(client):
    token = _token(client)
    resp = client.post("/api/simulate/ensemble", json={"config": {**FAST_MODEL, "schedule": SCHEDULE}, "n_seeds": 3},
                       headers=_headers(token))
    assert resp.status_code == 200, resp.text
    body = resp.json()
    applied = body["applied_schedule"]
    assert set(applied) == {"stress_level"}
    assert len(applied["stress_level"]) == FAST_MODEL["cycles"] + 1


@pytest.mark.parametrize("n_seeds", [0, 1, 51])
def test_ensemble_invalid_n_seeds_is_400(client, n_seeds):
    token = _token(client)
    resp = client.post("/api/simulate/ensemble", json={"config": FAST_MODEL, "n_seeds": n_seeds},
                       headers=_headers(token))
    assert resp.status_code == 400, resp.text
    assert "n_seeds" in resp.json()["detail"]


def test_ensemble_invalid_config_is_400(client):
    token = _token(client)
    bad = dict(FAST_MODEL)
    bad["senescence_threshold"] = -1.0  # out of PARAMETER_BOUNDS
    resp = client.post("/api/simulate/ensemble", json={"config": bad, "n_seeds": 5}, headers=_headers(token))
    assert resp.status_code == 400


def test_ensemble_records_exactly_one_ledger_entry(client):
    token = _token(client)
    before = client.get("/api/experiments", params={"mine": True}, headers=_headers(token)).json()
    resp = client.post("/api/simulate/ensemble", json={"config": FAST_MODEL, "n_seeds": 5}, headers=_headers(token))
    assert resp.status_code == 200, resp.text
    after = client.get("/api/experiments", params={"mine": True}, headers=_headers(token)).json()
    assert len(after) == len(before) + 1
    run_id = resp.json()["run_id"]
    matches = [r for r in after if r["run_id"] == run_id]
    assert len(matches) == 1
    assert matches[0]["kind"] == "ensemble"


def test_ensemble_ownership_matches_simulate(client):
    token_a = _token(client, "ens_a", "ens_a@example.com")
    token_b = _token(client, "ens_b", "ens_b@example.com")

    resp = client.post("/api/simulate/ensemble", json={"config": FAST_MODEL, "n_seeds": 5}, headers=_headers(token_a))
    run_id = resp.json()["run_id"]

    mine_a = client.get("/api/experiments", params={"mine": True}, headers=_headers(token_a)).json()
    assert any(r["run_id"] == run_id for r in mine_a)

    mine_b = client.get("/api/experiments", params={"mine": True}, headers=_headers(token_b)).json()
    assert all(r["run_id"] != run_id for r in mine_b)

    detail = client.get(f"/api/experiments/{run_id}", headers=_headers(token_a))
    assert detail.status_code == 200
    assert detail.json()["record"]["n_seeds"] == 5
