"""API tests for backend/routers/meta.py: the read-only metadata the React
forms are driven by (bounds / defaults / version) and the organ-on-chip
condition -> model-parameter mapping.

Same isolated-DB fixtures as tests/test_api_auth.py (needed for the
protected chip-to-params route).
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
from telomere_lab.adapters.chip import ChipConditions, chip_to_model_params  # noqa: E402
from telomere_lab.schemas import (  # noqa: E402
    EVOLVABLE_PARAMETERS,
    PARAMETER_BOUNDS,
    EvolutionConfig,
    FitnessWeights,
    ModelConfig,
)


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


def _token(client, username="meta_user", email="meta_user@example.com", password="hunter22") -> str:
    reg = client.post("/api/auth/register", json={"username": username, "email": email, "password": password})
    verify_token = reg.json()["dev_verification_link"].split("token=")[1]
    client.get("/api/auth/verify", params={"token": verify_token})
    return client.post("/api/auth/login", json={"username": username, "password": password}).json()["access_token"]


def test_bounds_is_public_and_mirrors_parameter_bounds(client):
    resp = client.get("/api/meta/bounds")
    assert resp.status_code == 200, resp.text
    body = resp.json()

    assert set(body["bounds"]) == set(PARAMETER_BOUNDS)
    for name, (lo, hi, unit, label, description) in PARAMETER_BOUNDS.items():
        b = body["bounds"][name]
        assert b == {"min": lo, "max": hi, "unit": unit, "label": label, "description": description}

    assert body["evolvable"] == list(EVOLVABLE_PARAMETERS)
    for gene in EVOLVABLE_PARAMETERS:
        assert gene in body["bounds"]


def test_bounds_defaults_validate_and_match_dataclasses(client):
    body = client.get("/api/meta/bounds").json()

    assert body["defaults"] == ModelConfig().to_dict()
    ModelConfig.from_dict(body["defaults"]).validate()
    ModelConfig.from_dict(body["demo"]).validate()
    assert body["demo"]["stress_level"] == 0.60  # configs/demo.yaml, the stressed baseline

    assert body["fitness_weights_default"] == FitnessWeights().to_dict()
    assert body["evolution_default"] == EvolutionConfig().to_dict()
    EvolutionConfig.from_dict(body["evolution_default"]).validate()
    assert body["evolution_default"]["weights"] == FitnessWeights().to_dict()


def test_version_has_expected_keys(client):
    import numpy as np

    from telomere_lab import __version__
    from telomere_lab.schemas import MODEL_VERSION, OPTIMIZER_VERSION

    resp = client.get("/api/meta/version")
    assert resp.status_code == 200
    body = resp.json()
    assert set(body) == {"package", "model", "optimizer", "python", "numpy", "git_commit"}
    assert body["package"] == __version__
    assert body["model"] == MODEL_VERSION
    assert body["optimizer"] == OPTIMIZER_VERSION
    assert body["numpy"] == np.__version__
    assert body["python"].count(".") == 2


def test_chip_to_params_requires_auth(client):
    assert client.post("/api/meta/chip-to-params", json={}).status_code == 401


def test_chip_to_params_round_trips_known_input(client):
    token = _token(client)
    chip = ChipConditions(flow_rate=0.3, oxygen_tension=0.10, nutrient_state=0.6,
                          stress_exposure=0.5, culture_days=45.0)
    resp = client.post("/api/meta/chip-to-params", json=chip.to_dict(),
                       headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    expected = chip_to_model_params(chip)
    assert set(body) == {"stress_level", "repair_rate", "cycles"}
    assert body["cycles"] == expected["cycles"] == 45
    assert body["stress_level"] == pytest.approx(expected["stress_level"])
    assert body["repair_rate"] == pytest.approx(expected["repair_rate"])
    # Derived values must be usable as ModelConfig overrides as-is.
    ModelConfig.from_dict({**ModelConfig().to_dict(), **body}).validate()


def test_chip_to_params_defaults_match_dataclass_defaults(client):
    token = _token(client, "meta_defaults", "meta_defaults@example.com")
    resp = client.post("/api/meta/chip-to-params", json={}, headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 200
    expected = chip_to_model_params(ChipConditions())
    assert resp.json()["cycles"] == expected["cycles"]
    assert resp.json()["stress_level"] == pytest.approx(expected["stress_level"])
