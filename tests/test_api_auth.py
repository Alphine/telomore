"""API tests for backend/routers/auth.py: register -> verify -> login -> /me,
forgot/reset-password round trip, and the 401/403 auth-gate behavior.

Uses FastAPI's TestClient with the same SQLite-per-test isolation pattern
already established in tests/test_app.py / tests/test_db.py (temp DATA_DIR,
db_module.reset_engine()). No real Resend network call is ever made: no
RESEND_API_KEY is set, so telomere_lab.email.send_email is a guaranteed
no-op and every response falls into the dev-mode-fallback branch.
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
    # Route the experiment ledger's file artifacts to a throwaway directory
    # too, so tests never touch the real experiments/ tree.
    from telomere_lab import config as config_module

    monkeypatch.setattr(config_module, "RUNS_DIR", tmp_path / "runs")

    from backend.main import create_app

    return TestClient(create_app())


def _register(client, username="alice", email="alice@example.com", password="hunter22"):
    return client.post("/api/auth/register", json={
        "username": username, "email": email, "password": password,
    })


def test_register_returns_dev_verification_link(client):
    resp = _register(client)
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["dev_verification_link"]
    assert "token=" in body["dev_verification_link"]


def test_register_duplicate_username_conflicts(client):
    _register(client, username="bob", email="bob1@example.com")
    resp = _register(client, username="bob", email="bob2@example.com")
    assert resp.status_code == 409


def test_register_duplicate_email_conflicts(client):
    _register(client, username="carol1", email="carol@example.com")
    resp = _register(client, username="carol2", email="carol@example.com")
    assert resp.status_code == 409


def _verify_token(link: str) -> str:
    return link.split("token=")[1]


def test_login_before_verification_is_forbidden(client):
    _register(client, username="dave")
    resp = client.post("/api/auth/login", json={"username": "dave", "password": "hunter22"})
    assert resp.status_code == 403


def test_login_wrong_password_is_unauthorized(client):
    _register(client, username="erin")
    resp = client.post("/api/auth/login", json={"username": "erin", "password": "wrong"})
    assert resp.status_code == 401


def test_full_register_verify_login_me_flow(client):
    reg = _register(client, username="frank", email="frank@example.com")
    token = _verify_token(reg.json()["dev_verification_link"])

    verify_resp = client.get("/api/auth/verify", params={"token": token})
    assert verify_resp.status_code == 200
    assert verify_resp.json()["verified"] is True

    login_resp = client.post("/api/auth/login", json={"username": "frank", "password": "hunter22"})
    assert login_resp.status_code == 200
    access_token = login_resp.json()["access_token"]
    assert login_resp.json()["token_type"] == "bearer"

    me_resp = client.get("/api/auth/me", headers={"Authorization": f"Bearer {access_token}"})
    assert me_resp.status_code == 200
    me = me_resp.json()
    assert me["username"] == "frank"
    assert me["email"] == "frank@example.com"
    assert me["is_verified"] is True


def test_protected_route_without_token_is_unauthorized(client):
    resp = client.get("/api/auth/me")
    assert resp.status_code == 401


def test_protected_route_with_garbage_token_is_unauthorized(client):
    resp = client.get("/api/auth/me", headers={"Authorization": "Bearer not-a-real-token"})
    assert resp.status_code == 401


def test_forgot_password_generic_message_for_unknown_email(client):
    resp = client.post("/api/auth/forgot-password", json={"email": "nobody@example.com"})
    assert resp.status_code == 200
    body = resp.json()
    assert "if an account" in body["message"].lower()
    assert body.get("dev_reset_link") is None


def test_forgot_and_reset_password_round_trip(client):
    _register(client, username="grace", email="grace@example.com")
    forgot_resp = client.post("/api/auth/forgot-password", json={"email": "grace@example.com"})
    assert forgot_resp.status_code == 200
    link = forgot_resp.json()["dev_reset_link"]
    assert link and "reset_token=" in link
    reset_token = link.split("reset_token=")[1]

    reset_resp = client.post("/api/auth/reset-password", json={
        "token": reset_token, "new_password": "new-hunter-99",
    })
    assert reset_resp.status_code == 200

    # Directly mark grace verified via the DB layer (register/login flow is
    # already covered by test_full_register_verify_login_me_flow above; here
    # we only care that the new password is accepted).
    user = db_module.authenticate("grace", "new-hunter-99")
    assert user is not None
    token = db_module.generate_verification_token(user.id)
    db_module.verify_email(token)

    login_resp = client.post("/api/auth/login", json={"username": "grace", "password": "new-hunter-99"})
    assert login_resp.status_code == 200


def test_reset_password_with_invalid_token_fails(client):
    resp = client.post("/api/auth/reset-password", json={"token": "bogus", "new_password": "whatever123"})
    assert resp.status_code == 400
