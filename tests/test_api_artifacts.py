"""API tests for the Phase 4 artifact routes in backend/routers/experiments.py:
``GET /api/experiments/{run_id}/artifacts`` (list) and
``GET /api/experiments/{run_id}/artifacts/{name}`` (download), exercised on
a run produced by a real ``POST /api/simulate`` against the isolated ledger,
plus path-traversal attempts, the ledger summary's new columns and the
``objectives`` key on ``GET /api/meta/bounds``.

Same isolated-DB / isolated-ledger fixtures as tests/test_api_simulate.py.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

SRC = Path(__file__).resolve().parents[1] / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from telomere_lab import db as db_module  # noqa: E402
from telomere_lab.schemas import OBJECTIVES  # noqa: E402

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
def runs_dir(tmp_path, monkeypatch):
    from telomere_lab import config as config_module
    from telomere_lab.experiments.registry import ExperimentRegistry

    runs = tmp_path / "runs"
    monkeypatch.setattr(config_module, "RUNS_DIR", runs)
    # ExperimentRegistry(runs_dir=RUNS_DIR) binds its default at import time,
    # so the module attribute above is not enough for the routers' bare
    # ExperimentRegistry() calls: pin the default itself so this test's runs
    # (and the files the artifact routes serve) really live under tmp_path.
    monkeypatch.setattr(ExperimentRegistry.__init__, "__defaults__", (runs,))
    return runs


@pytest.fixture()
def client(runs_dir):
    from backend.main import create_app

    return TestClient(create_app())


def _token(client, username="art_user", email="art_user@example.com", password="hunter22") -> str:
    reg = client.post("/api/auth/register", json={"username": username, "email": email, "password": password})
    verify_token = reg.json()["dev_verification_link"].split("token=")[1]
    client.get("/api/auth/verify", params={"token": verify_token})
    return client.post("/api/auth/login", json={"username": username, "password": password}).json()["access_token"]


def _headers(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def _simulate(client, token) -> str:
    resp = client.post("/api/simulate", json={"config": FAST_MODEL}, headers=_headers(token))
    assert resp.status_code == 200, resp.text
    return resp.json()["run"]["run_id"]


def test_artifact_routes_require_auth(client):
    assert client.get("/api/experiments/TEL-20260101-001/artifacts").status_code == 401
    assert client.get("/api/experiments/TEL-20260101-001/artifacts/record.json").status_code == 401


def test_list_and_download_artifacts_of_a_real_run(client, runs_dir):
    token = _token(client)
    run_id = _simulate(client, token)

    listing = client.get(f"/api/experiments/{run_id}/artifacts", headers=_headers(token))
    assert listing.status_code == 200, listing.text
    items = {a["name"]: a for a in listing.json()}
    # write_simulation_artifacts + the registry's own record.json
    assert set(items) == {"simulation.json", "timeseries.csv", "config.json", "record.json"}
    assert items["timeseries.csv"]["key"] == "timeseries_csv"
    assert items["simulation.json"]["key"] == "result_json"
    assert items["record.json"]["key"] is None
    assert items["timeseries.csv"]["media_type"] == "text/csv"
    assert items["simulation.json"]["media_type"] == "application/json"
    for a in items.values():
        assert a["size_bytes"] > 0

    csv = client.get(f"/api/experiments/{run_id}/artifacts/timeseries.csv", headers=_headers(token))
    assert csv.status_code == 200
    assert csv.headers["content-type"].startswith("text/csv")
    assert "attachment" in csv.headers.get("content-disposition", "")
    assert "timeseries.csv" in csv.headers.get("content-disposition", "")
    assert csv.text.splitlines()[0].startswith("cycle,mean_length_bp")
    assert csv.content == (runs_dir / run_id / "timeseries.csv").read_bytes()

    rec = client.get(f"/api/experiments/{run_id}/artifacts/record.json", headers=_headers(token))
    assert rec.status_code == 200
    assert rec.headers["content-type"].startswith("application/json")
    assert json.loads(rec.content)["run_id"] == run_id


def test_artifacts_are_readable_by_other_users_like_the_record(client):
    """Ownership rule matches GET /api/experiments/{run_id}: shared ledger, auth only."""
    token_a = _token(client, "art_a", "art_a@example.com")
    token_b = _token(client, "art_b", "art_b@example.com")
    run_id = _simulate(client, token_a)
    assert client.get(f"/api/experiments/{run_id}", headers=_headers(token_b)).status_code == 200
    assert client.get(f"/api/experiments/{run_id}/artifacts", headers=_headers(token_b)).status_code == 200
    assert client.get(f"/api/experiments/{run_id}/artifacts/config.json",
                      headers=_headers(token_b)).status_code == 200


def test_missing_run_or_artifact_is_404(client):
    token = _token(client)
    run_id = _simulate(client, token)
    assert client.get("/api/experiments/TEL-99999999-999/artifacts", headers=_headers(token)).status_code == 404
    assert client.get("/api/experiments/TEL-99999999-999/artifacts/record.json",
                      headers=_headers(token)).status_code == 404
    assert client.get(f"/api/experiments/{run_id}/artifacts/nope.csv", headers=_headers(token)).status_code == 404


# A bare ".." segment never reaches the server (HTTP clients resolve it before
# sending, as browsers do), so only encoded/odd variants are meaningful here.
@pytest.mark.parametrize("name", ["..%2F..%2Fregistry.jsonl", "%2E%2E%2Frecord.json", "%2E%2E",
                                  "a%5Cb.json", ".hidden", "sub%2Frecord.json"])
def test_traversal_in_artifact_name_is_rejected(client, runs_dir, name):
    token = _token(client)
    run_id = _simulate(client, token)
    # A sibling file outside the run dir that a traversal would reach.
    (runs_dir.parent / "registry.jsonl").write_text("secret\n", encoding="utf-8")
    resp = client.get(f"/api/experiments/{run_id}/artifacts/{name}", headers=_headers(token))
    assert resp.status_code in (400, 404), (name, resp.status_code, resp.text)
    assert "secret" not in resp.text


@pytest.mark.parametrize("run_id", ["%2E%2E", "..%2Fruns", "x%5Cy", ".TEL"])
def test_traversal_in_run_id_is_rejected(client, run_id):
    token = _token(client)
    assert client.get(f"/api/experiments/{run_id}/artifacts", headers=_headers(token)).status_code in (400, 404)
    assert client.get(f"/api/experiments/{run_id}/artifacts/record.json",
                      headers=_headers(token)).status_code in (400, 404)


def test_ledger_summary_carries_table_columns(client):
    token = _token(client)
    run_id = _simulate(client, token)
    rows = client.get("/api/experiments", params={"mine": True}, headers=_headers(token)).json()
    row = next(r for r in rows if r["run_id"] == run_id)
    detail = client.get(f"/api/experiments/{run_id}", headers=_headers(token)).json()["record"]
    assert row["seed"] == detail["seed"]
    assert row["configuration_hash"] == detail["configuration_hash"]
    assert row["git_commit"] == detail["git_commit"]
    assert row["model_version"] == detail["model_version"]
    assert row["kind"] == "simulation"


def test_bounds_exposes_objectives(client):
    body = client.get("/api/meta/bounds").json()
    assert set(body["objectives"]) == set(OBJECTIVES)
    for name, (direction, description) in OBJECTIVES.items():
        assert body["objectives"][name] == {"direction": direction, "description": description}
