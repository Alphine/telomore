"""API contract for sub-clone competition (docs/MODEL.md §2.2, ROADMAP.md
candidate feature #4):

* ``POST /api/simulate`` accepts ``config.subclones`` and returns
  ``clone_fraction`` (one ``cycles + 1``-long array per clone);
* an invalid subclones block surfaces the core ``ConfigError`` as a 400;
* ``GET /api/meta/bounds`` exposes ``subclone_overridable``;
* ``POST /api/simulate/ensemble`` and ``POST /api/compare`` pass a
  sub-clone-competition config through transparently.

Same isolated-DB / isolated-ledger fixtures as tests/test_api_schedule.py.
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
from telomere_lab.schemas import SUBCLONE_OVERRIDABLE_PARAMETERS  # noqa: E402

FAST_MODEL = {
    "cycles": 20,
    "population_size": 20,
    "carrying_capacity": 40,
    "telomeres_per_cell": 6,
}

SUBCLONES = [
    {"name": "resilient", "initial_fraction": 0.5, "overrides": {"maintenance_rate": 0.6, "repair_rate": 0.6}},
    {"name": "fragile", "initial_fraction": 0.5, "overrides": {}},
]


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


def _token(client, username="clone_user", email="clone_user@example.com", password="hunter22") -> str:
    reg = client.post("/api/auth/register", json={"username": username, "email": email, "password": password})
    verify_token = reg.json()["dev_verification_link"].split("token=")[1]
    client.get("/api/auth/verify", params={"token": verify_token})
    return client.post("/api/auth/login", json={"username": username, "password": password}).json()["access_token"]


def _headers(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


# ------------------------------------------------------------------ simulate
def test_simulate_with_subclones_returns_clone_fraction(client):
    token = _token(client)
    resp = client.post("/api/simulate", json={"config": {**FAST_MODEL, "subclones": SUBCLONES}},
                       headers=_headers(token))
    assert resp.status_code == 200, resp.text
    run = resp.json()["run"]
    assert run["valid"] is True
    assert run["config"]["subclones"] == SUBCLONES
    clone_fraction = run["clone_fraction"]
    assert set(clone_fraction) == {"resilient", "fragile"}
    cycles = FAST_MODEL["cycles"]
    for name in clone_fraction:
        assert len(clone_fraction[name]) == cycles + 1 == len(run["timeseries"]["cycle"])
    assert clone_fraction["resilient"][0] == pytest.approx(0.5)
    assert clone_fraction["fragile"][0] == pytest.approx(0.5)


def test_simulate_without_subclones_reports_empty_clone_fraction(client):
    token = _token(client)
    resp = client.post("/api/simulate", json={"config": FAST_MODEL}, headers=_headers(token))
    assert resp.status_code == 200, resp.text
    run = resp.json()["run"]
    assert run["clone_fraction"] == {}
    assert run["config"]["subclones"] is None
    resp2 = client.post("/api/simulate", json={"config": {**FAST_MODEL, "subclones": None}}, headers=_headers(token))
    assert resp2.status_code == 200, resp2.text
    assert resp2.json()["run"]["clone_fraction"] == {}


@pytest.mark.parametrize(
    "subclones, fragment",
    [
        ([{"name": "solo", "initial_fraction": 1.0, "overrides": {}}], "needs >= 2 clones"),
        ([{"name": "a", "initial_fraction": 0.5, "overrides": {}},
          {"name": "b", "initial_fraction": 0.6, "overrides": {}}], "must sum to 1.0"),
        ([{"name": "a", "initial_fraction": 0.5, "overrides": {"senescence_threshold": 4000.0}},
          {"name": "b", "initial_fraction": 0.5, "overrides": {}}], "cannot override"),
        ([{"name": "a", "initial_fraction": 0.5, "overrides": {"repair_rate": 5.0}},
          {"name": "b", "initial_fraction": 0.5, "overrides": {}}], "outside [0.0, 1.0]"),
        ([{"name": "a", "initial_fraction": 0.5, "overrides": {}},
          {"name": "a", "initial_fraction": 0.5, "overrides": {}}], "must be unique"),
    ],
)
def test_simulate_invalid_subclones_is_400_with_config_error_text(client, subclones, fragment):
    token = _token(client)
    resp = client.post("/api/simulate", json={"config": {**FAST_MODEL, "subclones": subclones}},
                       headers=_headers(token))
    assert resp.status_code == 400, resp.text
    assert fragment in resp.json()["detail"]


def test_simulate_malformed_subclones_shape_is_422(client):
    token = _token(client)
    resp = client.post("/api/simulate",
                       json={"config": {**FAST_MODEL, "subclones": [{"name": "a"}]}},
                       headers=_headers(token))
    assert resp.status_code == 422


# ---------------------------------------------------------------------- meta
def test_bounds_exposes_subclone_overridable(client):
    body = client.get("/api/meta/bounds").json()
    assert body["subclone_overridable"] == list(SUBCLONE_OVERRIDABLE_PARAMETERS)
    assert body["defaults"]["subclones"] is None


# ---------------------------------------------------------------- ensemble
def test_ensemble_passes_subclones_through(client):
    token = _token(client)
    resp = client.post("/api/simulate/ensemble",
                       json={"config": {**FAST_MODEL, "subclones": SUBCLONES}, "n_seeds": 2},
                       headers=_headers(token))
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["config"]["subclones"] == SUBCLONES
    assert all(s["valid"] for s in body["series"])


# ------------------------------------------------------------------- compare
def test_compare_passes_subclone_scenario_through(client):
    token = _token(client)
    body = {
        "scenarios": [
            {"name": "Baseline", "config": FAST_MODEL},
            {"name": "Competition", "config": {**FAST_MODEL, "subclones": SUBCLONES}},
        ],
        "seed": 3,
    }
    resp = client.post("/api/compare", json=body, headers=_headers(token))
    assert resp.status_code == 200, resp.text
    base, comp = resp.json()["scenarios"]
    assert base["result"]["clone_fraction"] == {}
    assert comp["result"]["config"]["subclones"] == SUBCLONES
    assert set(comp["result"]["clone_fraction"]) == {"resilient", "fragile"}

    bad = client.post("/api/compare", json={"scenarios": [
        {"name": "Bad", "config": {**FAST_MODEL, "subclones": [
            {"name": "solo", "initial_fraction": 1.0, "overrides": {}}]}},
    ]}, headers=_headers(token))
    assert bad.status_code == 400
    assert bad.json()["detail"].startswith("Bad: ")
