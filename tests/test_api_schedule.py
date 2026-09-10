"""API contract for scheduled intervention protocols (stage 6b, docs/MODEL.md §2.1):

* ``POST /api/simulate`` accepts ``config.schedule`` and returns
  ``applied_schedule`` (one ``cycles + 1``-long array per scheduled parameter);
* a semantically invalid schedule surfaces the core ``ConfigError`` as a 400;
* ``POST /api/evolve`` accepts ``evolution.schedule_phases`` and the best genome
  carries ``<gene>@<phase>`` names; out-of-range phases are rejected;
* ``GET /api/meta/bounds`` exposes ``schedulable`` / ``max_phases`` / ``presets``;
* ``POST /api/compare`` passes a scheduled scenario through untouched.

Same isolated-DB / isolated-ledger fixtures as tests/test_api_simulate.py.
"""

from __future__ import annotations

import sys
import time
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient

SRC = Path(__file__).resolve().parents[1] / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from telomere_lab import db as db_module  # noqa: E402
from telomere_lab.config import CONFIG_DIR, load_model_config  # noqa: E402
from telomere_lab.evolution.genome import split_gene_name  # noqa: E402
from telomere_lab.schemas import MAX_PHASES, SCHEDULABLE_PARAMETERS, ModelConfig  # noqa: E402

FAST_MODEL = {
    "cycles": 20,
    "population_size": 20,
    "carrying_capacity": 40,
    "telomeres_per_cell": 6,
}

SCHEDULE = {"phases": 3, "values": {"stress_level": [0.9, 0.3, 0.9], "maintenance_rate": [0.0, 0.5, 1.0]}}


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


def _token(client, username="sched_user", email="sched_user@example.com", password="hunter22") -> str:
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


# ------------------------------------------------------------------ simulate
def test_simulate_with_schedule_returns_applied_schedule(client):
    token = _token(client)
    resp = client.post("/api/simulate", json={"config": {**FAST_MODEL, "schedule": SCHEDULE}}, headers=_headers(token))
    assert resp.status_code == 200, resp.text
    run = resp.json()["run"]
    assert run["valid"] is True
    assert run["config"]["schedule"] == SCHEDULE
    applied = run["applied_schedule"]
    assert set(applied) == {"stress_level", "maintenance_rate"}
    cycles = FAST_MODEL["cycles"]
    for name in applied:
        assert len(applied[name]) == cycles + 1 == len(run["timeseries"]["cycle"])
    # Same phase arithmetic as the core (20 cycles / 3 phases -> blocks of 7, 7, 6, last entry clamped).
    expected = ModelConfig.from_dict({**FAST_MODEL, "schedule": SCHEDULE}).per_cycle_values("stress_level")
    assert applied["stress_level"] == pytest.approx(expected.tolist())
    assert applied["stress_level"][0] == 0.9 and applied["stress_level"][7] == 0.3 and applied["stress_level"][-1] == 0.9
    # Unscheduled parameters are not reported; the cost is on the time-averaged dose.
    assert "repair_rate" not in applied
    assert "fitness" in run and "cost" in run["fitness"]


def test_simulate_without_schedule_reports_empty_applied_schedule(client):
    token = _token(client)
    resp = client.post("/api/simulate", json={"config": FAST_MODEL}, headers=_headers(token))
    assert resp.status_code == 200, resp.text
    run = resp.json()["run"]
    assert run["applied_schedule"] == {}
    assert run["config"]["schedule"] is None
    # An explicit null schedule is the same as no schedule (what to_dict() emits).
    resp2 = client.post("/api/simulate", json={"config": {**FAST_MODEL, "schedule": None}}, headers=_headers(token))
    assert resp2.status_code == 200, resp2.text
    assert resp2.json()["run"]["applied_schedule"] == {}


@pytest.mark.parametrize(
    "schedule, fragment",
    [
        ({"phases": 3, "values": {"stress_level": [0.9, 0.3]}}, "has 2 entries, expected 3"),
        ({"phases": 2, "values": {"repair_rate": [0.1, 1.5]}}, "outside [0.0, 1.0]"),
        ({"phases": 2, "values": {"shortening_rate": [50.0, 60.0]}}, "cannot be scheduled"),
        ({"phases": MAX_PHASES + 1, "values": {}}, f"outside [1, {MAX_PHASES}]"),
    ],
)
def test_simulate_invalid_schedule_is_400_with_config_error_text(client, schedule, fragment):
    token = _token(client)
    resp = client.post("/api/simulate", json={"config": {**FAST_MODEL, "schedule": schedule}}, headers=_headers(token))
    assert resp.status_code == 400, resp.text
    assert fragment in resp.json()["detail"]


def test_simulate_malformed_schedule_shape_is_422(client):
    token = _token(client)
    resp = client.post("/api/simulate", json={"config": {**FAST_MODEL, "schedule": {"phases": "many", "values": {}}}},
                       headers=_headers(token))
    assert resp.status_code == 422


# -------------------------------------------------------------------- evolve
def test_evolve_with_schedule_phases_yields_phase_genes(client):
    token = _token(client)
    resp = client.post("/api/evolve", json={
        "model": FAST_MODEL,
        "evolution": {"population_size": 6, "generations": 2, "eval_seeds": [1], "checkpoint_every": 0,
                      "free_genes": ["maintenance_rate", "repair_rate"], "schedule_phases": 2},
    }, headers=_headers(token))
    assert resp.status_code == 200, resp.text
    final = _poll_job(client, token, resp.json()["job_id"])
    assert final["status"] == "completed", final.get("error")
    genome = final["result"]["best"]["genome"]
    assert set(genome) == {"maintenance_rate@0", "maintenance_rate@1", "repair_rate@0", "repair_rate@1"}
    assert {split_gene_name(g)[0] for g in genome} == {"maintenance_rate", "repair_rate"}
    assert set(final["result"]["baseline"]["genome"]) == set(genome)
    assert final["result"]["history"][-1]["best_genome"].keys() == genome.keys()


def test_evolve_schedule_phases_out_of_range_is_rejected(client):
    token = _token(client)
    for bad in (0, MAX_PHASES + 1):
        resp = client.post("/api/evolve", json={
            "model": FAST_MODEL,
            "evolution": {"population_size": 4, "generations": 1, "eval_seeds": [1], "schedule_phases": bad},
        }, headers=_headers(token))
        assert resp.status_code == 422, resp.text
        assert "schedule_phases" in str(resp.json()["detail"])


def test_pareto_and_active_learning_accept_schedule_phases(client):
    token = _token(client)
    pareto = client.post("/api/pareto", json={
        "model": FAST_MODEL,
        "multiobjective": {"population_size": 4, "generations": 1, "eval_seeds": [1], "checkpoint_every": 0,
                           "free_genes": ["maintenance_rate"], "schedule_phases": 2},
    }, headers=_headers(token))
    assert pareto.status_code == 200, pareto.text
    final = _poll_job(client, token, pareto.json()["job_id"])
    assert final["status"] == "completed", final.get("error")
    assert all(set(c["genome"]) == {"maintenance_rate@0", "maintenance_rate@1"} for c in final["result"]["front"])

    al = client.post("/api/active-learning", json={
        "model": FAST_MODEL,
        "active_learning": {"n_initial": 2, "n_iterations": 1, "eval_seeds": [1], "candidate_pool_size": 10,
                            "free_genes": ["repair_rate"], "schedule_phases": 2},
    }, headers=_headers(token))
    assert al.status_code == 200, al.text
    final = _poll_job(client, token, al.json()["job_id"])
    assert final["status"] == "completed", final.get("error")
    assert set(final["result"]["best_genome"]) == {"repair_rate@0", "repair_rate@1"}


# ---------------------------------------------------------------------- meta
def test_bounds_exposes_schedulable_max_phases_and_presets(client):
    body = client.get("/api/meta/bounds").json()
    assert body["schedulable"] == list(SCHEDULABLE_PARAMETERS)
    assert body["max_phases"] == MAX_PHASES
    assert body["defaults"]["schedule"] is None
    demo_fasting = body["presets"]["demo_fasting"]
    assert demo_fasting == load_model_config(CONFIG_DIR / "demo_fasting.yaml").to_dict()
    assert demo_fasting["schedule"]["phases"] == 6
    assert demo_fasting["schedule"]["values"]["stress_level"] == [0.9, 0.3, 0.9, 0.3, 0.9, 0.3]
    ModelConfig.from_dict(demo_fasting).validate()
    assert body["evolution_default"]["schedule_phases"] == 1


# ------------------------------------------------------------------- compare
def test_compare_passes_scheduled_scenario_through(client):
    token = _token(client)
    body = {
        "scenarios": [
            {"name": "Baseline", "config": FAST_MODEL},
            {"name": "Protocol", "config": {**FAST_MODEL, "schedule": SCHEDULE}},
        ],
        "seed": 3,
    }
    resp = client.post("/api/compare", json=body, headers=_headers(token))
    assert resp.status_code == 200, resp.text
    base, proto = resp.json()["scenarios"]
    assert base["result"]["applied_schedule"] == {}
    assert proto["result"]["config"]["schedule"] == SCHEDULE
    assert proto["result"]["config"]["seed"] == 3
    assert len(proto["result"]["applied_schedule"]["maintenance_rate"]) == FAST_MODEL["cycles"] + 1
    # The time-averaged maintenance dose is what the cost term is charged on.
    mean_m = float(np.mean(proto["result"]["applied_schedule"]["maintenance_rate"][:-1]))
    assert mean_m == pytest.approx(ModelConfig.from_dict({**FAST_MODEL, "schedule": SCHEDULE}).mean_value("maintenance_rate"))

    bad = client.post("/api/compare", json={"scenarios": [
        {"name": "Bad", "config": {**FAST_MODEL, "schedule": {"phases": 2, "values": {"stress_level": [0.1]}}}},
    ]}, headers=_headers(token))
    assert bad.status_code == 400
    assert bad.json()["detail"].startswith("Bad: ")
