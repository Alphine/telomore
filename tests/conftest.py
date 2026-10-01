"""Shared test setup: keep the API's abuse-protection switched off by default
(the suite registers/logs in from a single client address many times). Tests
that exercise the limiter re-enable it explicitly via monkeypatch."""

import pytest


@pytest.fixture(autouse=True)
def _api_rate_limit_off(monkeypatch):
    monkeypatch.setenv("TELOMERE_RATE_LIMIT", "off")
    # Plan gating and usage logging have their own tests (test_admin_*.py),
    # which switch them back on; the legacy API tests exercise compute as plain users.
    monkeypatch.setenv("TELOMERE_REQUIRE_PRO", "0")
    monkeypatch.setenv("TELOMERE_USAGE_LOG", "off")
    monkeypatch.delenv("TELOMERE_ADMIN_USERS", raising=False)
    try:
        from backend import ratelimit
        ratelimit.reset()
    except Exception:  # backend not importable in library-only environments
        pass
