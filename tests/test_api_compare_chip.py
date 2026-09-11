"""API tests for the multi-chip comparison extension (ROADMAP.md candidate
feature #3): GET /api/meta/chip-presets and the `chip` scenario shape on
POST /api/compare (backend/schemas.py::CompareScenario, backend/routers/compare.py).

Same isolated-DB / isolated-ledger fixtures as tests/test_api_compare.py.
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
from telomere_lab.adapters.chip import CHIP_PRESETS, ChipConditions, chip_to_model_params  # noqa: E402

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


def _token(client, username="cmp_chip_user", email="cmp_chip_user@example.com", password="hunter22") -> str:
    reg = client.post("/api/auth/register", json={"username": username, "email": email, "password": password})
    verify_token = reg.json()["dev_verification_link"].split("token=")[1]
    client.get("/api/auth/verify", params={"token": verify_token})
    return client.post("/api/auth/login", json={"username": username, "password": password}).json()["access_token"]


def _headers(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


# --------------------------------------------------------------------- meta
def test_chip_presets_is_public_and_returns_all_presets(client):
    resp = client.get("/api/meta/chip-presets")
    assert resp.status_code == 200, resp.text
    presets = resp.json()["presets"]
    assert set(presets) == set(CHIP_PRESETS)
    for name, preset in CHIP_PRESETS.items():
        entry = presets[name]
        assert entry["label"] == preset.label
        assert entry["description"] == preset.description
        expected = chip_to_model_params(preset.conditions)
        assert entry["derived"]["stress_level"] == pytest.approx(expected["stress_level"])
        assert entry["derived"]["repair_rate"] == pytest.approx(expected["repair_rate"])
        assert entry["derived"]["cycles"] == expected["cycles"]


# ------------------------------------------------------------------ compare
def test_compare_mixes_chip_and_config_scenarios(client):
    token = _token(client)
    preset = CHIP_PRESETS["liver_chip_like"]
    body = {
        "scenarios": [
            {"name": "Baseline", "config": FAST_MODEL},
            {"name": "Liver-chip-like", "chip": preset.conditions.to_dict()},
        ],
        "base_config": FAST_MODEL,
        "seed": 7,
    }
    resp = client.post("/api/compare", json=body, headers=_headers(token))
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert [s["name"] for s in data["scenarios"]] == ["Baseline", "Liver-chip-like"]

    base, chip_sc = data["scenarios"]
    assert base["result"]["valid"] and chip_sc["result"]["valid"]
    assert chip_sc["deltas"] is not None
    assert base["result"]["config"]["seed"] == 7 == chip_sc["result"]["config"]["seed"]

    derived = chip_to_model_params(preset.conditions)
    assert chip_sc["result"]["config"]["stress_level"] == pytest.approx(derived["stress_level"])
    assert chip_sc["result"]["config"]["repair_rate"] == pytest.approx(derived["repair_rate"])
    # cycles is capped by base_config's FAST_MODEL override? No -- chip derives
    # its own cycles from culture_days and that overrides base_config's cycles.
    assert chip_sc["result"]["config"]["cycles"] == derived["cycles"]
    # Non-chip-derived fields are inherited from base_config, not defaults.
    assert chip_sc["result"]["config"]["population_size"] == FAST_MODEL["population_size"]


def test_compare_multiple_chip_presets_in_one_request(client):
    token = _token(client)
    scenarios = [{"name": "Baseline", "config": FAST_MODEL}]
    for name in ("liver_chip_like", "lung_chip_like", "gut_chip_like"):
        scenarios.append({"name": name, "chip": CHIP_PRESETS[name].conditions.to_dict()})
    resp = client.post("/api/compare", json={"scenarios": scenarios, "base_config": FAST_MODEL},
                        headers=_headers(token))
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert len(data["scenarios"]) == 4
    assert all(s["result"]["valid"] for s in data["scenarios"])
    # Liver-like and lung-like presets must produce visibly different stress.
    by_name = {s["name"]: s for s in data["scenarios"]}
    assert (by_name["liver_chip_like"]["result"]["config"]["stress_level"]
            != by_name["lung_chip_like"]["result"]["config"]["stress_level"])


def test_compare_scenario_requires_exactly_one_of_config_or_chip(client):
    token = _token(client)
    # Both.
    resp = client.post("/api/compare", json={"scenarios": [
        {"name": "Both", "config": FAST_MODEL, "chip": ChipConditions().to_dict()},
    ]}, headers=_headers(token))
    assert resp.status_code == 400
    assert "Both" in resp.json()["detail"]

    # Neither.
    resp = client.post("/api/compare", json={"scenarios": [{"name": "Neither"}]}, headers=_headers(token))
    assert resp.status_code == 400
    assert "Neither" in resp.json()["detail"]


def test_compare_chip_scenario_with_malformed_field_is_bad_request(client):
    token = _token(client)
    resp = client.post("/api/compare", json={"scenarios": [
        {"name": "Baseline", "config": FAST_MODEL},
        {"name": "BadChip", "chip": {"flow_rate": "not-a-number"}},
    ]}, headers=_headers(token))
    # pydantic 422 on a malformed ChipConditionsRequest field (the core's own
    # wire-shape validation), same contract as a malformed `config` field.
    assert resp.status_code == 422


def test_compare_requires_auth_still_applies_to_chip_scenarios(client):
    resp = client.post("/api/compare", json={"scenarios": [
        {"name": "Liver", "chip": ChipConditions().to_dict()},
    ]})
    assert resp.status_code == 401
