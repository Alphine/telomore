"""Shared test setup: keep the API's abuse-protection switched off by default
(the suite registers/logs in from a single client address many times). Tests
that exercise the limiter re-enable it explicitly via monkeypatch."""

import pytest


@pytest.fixture(autouse=True)
def _api_rate_limit_off(monkeypatch):
    monkeypatch.setenv("TELOMERE_RATE_LIMIT", "off")
    try:
        from backend import ratelimit
        ratelimit.reset()
    except Exception:  # backend not importable in library-only environments
        pass
