"""Tests for the Resend-backed email module (dev-mode fallback + request shape).

No test in this file ever hits the real network: the "no API key" path is
asserted to make zero network calls, and the "API key present" path
monkeypatches ``urllib.request.urlopen`` with a fake response.
"""

from __future__ import annotations

import json

import pytest

from telomere_lab import email as email_module


def test_send_email_without_api_key_is_a_noop(monkeypatch):
    """With no RESEND_API_KEY set, send_email must return False and must
    NOT attempt any network call (this must not flake or hang CI)."""
    monkeypatch.delenv("RESEND_API_KEY", raising=False)

    def _boom(*args, **kwargs):  # pragma: no cover - should never run
        raise AssertionError("send_email must not touch the network when unconfigured")

    monkeypatch.setattr(email_module.urllib.request, "urlopen", _boom)

    result = email_module.send_email("someone@example.com", "Subject", "<p>Body</p>")
    assert result is False


def test_send_email_with_api_key_posts_well_formed_request(monkeypatch):
    monkeypatch.setenv("RESEND_API_KEY", "test-key-123")

    captured = {}

    class _FakeResponse:
        status = 200

        def __enter__(self):
            return self

        def __exit__(self, *exc_info):
            return False

    def _fake_urlopen(request, timeout=None):
        captured["url"] = request.full_url
        captured["method"] = request.get_method()
        captured["headers"] = {k.lower(): v for k, v in request.header_items()}
        captured["body"] = json.loads(request.data.decode("utf-8"))
        captured["timeout"] = timeout
        return _FakeResponse()

    monkeypatch.setattr(email_module.urllib.request, "urlopen", _fake_urlopen)

    ok = email_module.send_email("someone@example.com", "Verify your account", "<p>Click here</p>")

    assert ok is True
    assert captured["url"] == email_module.RESEND_API_URL
    assert captured["method"] == "POST"
    assert captured["headers"]["authorization"] == "Bearer test-key-123"
    assert captured["headers"]["content-type"] == "application/json"
    assert captured["body"]["to"] == ["someone@example.com"]
    assert captured["body"]["subject"] == "Verify your account"
    assert captured["body"]["html"] == "<p>Click here</p>"
    assert captured["body"]["from"] == email_module.DEFAULT_FROM
    assert "resend.dev" in captured["body"]["from"]


def test_send_email_returns_false_on_network_failure(monkeypatch):
    monkeypatch.setenv("RESEND_API_KEY", "test-key-123")

    import urllib.error

    def _fake_urlopen(request, timeout=None):
        raise urllib.error.URLError("boom")

    monkeypatch.setattr(email_module.urllib.request, "urlopen", _fake_urlopen)

    ok = email_module.send_email("someone@example.com", "Subject", "<p>Body</p>")
    assert ok is False
