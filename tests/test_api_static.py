"""Tests for backend/main.py's optional frontend mount (Phase 2): when a built
``frontend/dist/index.html`` exists, non-/api GETs fall back to it (SPA
routing) while unknown /api paths still return FastAPI's JSON 404.

Uses a temporary fake ``dist`` directory (monkeypatching ``FRONTEND_DIST``)
so the test never depends on whether ``npm run build`` has been run.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

SRC = Path(__file__).resolve().parents[1] / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from backend import main as backend_main  # noqa: E402

INDEX_HTML = "<!doctype html><html><body><div id='root'></div>FAKE-SPA</body></html>"


@pytest.fixture()
def fake_dist(tmp_path):
    dist = tmp_path / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text(INDEX_HTML, encoding="utf-8")
    (dist / "assets" / "app.js").write_text("console.log('hi')", encoding="utf-8")
    (dist / "favicon.svg").write_text("<svg/>", encoding="utf-8")
    return dist


@pytest.fixture()
def client_with_frontend(fake_dist, monkeypatch):
    monkeypatch.setattr(backend_main, "FRONTEND_DIST", fake_dist)
    return TestClient(backend_main.create_app())


@pytest.fixture()
def client_without_frontend(tmp_path, monkeypatch):
    monkeypatch.setattr(backend_main, "FRONTEND_DIST", tmp_path / "missing-dist")
    return TestClient(backend_main.create_app())


def test_root_serves_index_html(client_with_frontend):
    resp = client_with_frontend.get("/")
    assert resp.status_code == 200
    assert "FAKE-SPA" in resp.text
    assert resp.headers["content-type"].startswith("text/html")


def test_client_side_routes_fall_back_to_index_html(client_with_frontend):
    for path in ("/login", "/simulate", "/verify?token=abc", "/deep/nested/route"):
        resp = client_with_frontend.get(path)
        assert resp.status_code == 200, path
        assert "FAKE-SPA" in resp.text, path


def test_assets_and_top_level_static_files_are_served(client_with_frontend):
    js = client_with_frontend.get("/assets/app.js")
    assert js.status_code == 200
    assert "console.log" in js.text
    ico = client_with_frontend.get("/favicon.svg")
    assert ico.status_code == 200
    assert "<svg" in ico.text


def test_unknown_api_path_is_json_404_not_index_html(client_with_frontend):
    resp = client_with_frontend.get("/api/nonexistent")
    assert resp.status_code == 404
    assert resp.headers["content-type"].startswith("application/json")
    assert resp.json() == {"detail": "Not Found"}
    assert "FAKE-SPA" not in resp.text


def test_real_api_routes_still_win_over_fallback(client_with_frontend):
    assert client_with_frontend.get("/api/health").json() == {"status": "ok"}


def test_no_dist_means_no_fallback(client_without_frontend):
    assert client_without_frontend.get("/api/health").json() == {"status": "ok"}
    resp = client_without_frontend.get("/login")
    assert resp.status_code == 404
    assert resp.headers["content-type"].startswith("application/json")
