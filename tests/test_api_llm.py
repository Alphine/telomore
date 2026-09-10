"""API + unit tests for LLM Layer 1 (backend/llm.py, backend/routers/llm.py,
GET /api/meta/llm). No network: the Anthropic client factory is replaced by
a fake that returns canned content or raises the real ``anthropic`` exception
classes, and ``ANTHROPIC_API_KEY`` is unset so nothing could fall back to a
server-side key.

Same isolated-DB / isolated-ledger fixtures as tests/test_api_artifacts.py.
"""

from __future__ import annotations

import json
import logging
import re
import sys
from pathlib import Path
from types import SimpleNamespace

import anthropic
import httpx2
import pytest
from fastapi.testclient import TestClient

SRC = Path(__file__).resolve().parents[1] / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from telomere_lab import db as db_module  # noqa: E402

from backend import llm  # noqa: E402

FAST_MODEL = {"cycles": 20, "population_size": 20, "carrying_capacity": 40, "telomeres_per_cell": 6}
FAKE_KEY = "sk-ant-api03-FAKE-KEY-FOR-TESTS-0123456789"
NARRATIVE = "### Problem\nA stressed culture.\n\n### Method\nGA.\n\n### AI contribution\nx\n\n### Evidence\ny\n\n### Trade-offs & caveats\nz"


@pytest.fixture(autouse=True)
def _isolated(tmp_path, monkeypatch):
    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.delenv("RESEND_API_KEY", raising=False)
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.setattr(db_module, "DATA_DIR", tmp_path / "data")
    db_module.reset_engine()
    llm.interpret_rate_limiter.reset()
    yield
    db_module.reset_engine()
    llm.interpret_rate_limiter.reset()


@pytest.fixture()
def runs_dir(tmp_path, monkeypatch):
    from telomere_lab import config as config_module

    runs = tmp_path / "runs"
    monkeypatch.setattr(config_module, "RUNS_DIR", runs)
    return runs


@pytest.fixture()
def client(runs_dir):
    from backend.main import create_app

    return TestClient(create_app())


def _token(client, username="llm_user", email="llm_user@example.com", password="hunter22") -> str:
    reg = client.post("/api/auth/register", json={"username": username, "email": email, "password": password})
    verify_token = reg.json()["dev_verification_link"].split("token=")[1]
    client.get("/api/auth/verify", params={"token": verify_token})
    return client.post("/api/auth/login", json={"username": username, "password": password}).json()["access_token"]


def _headers(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def _simulate(client, token) -> dict:
    resp = client.post("/api/simulate", json={"config": FAST_MODEL}, headers=_headers(token))
    assert resp.status_code == 200, resp.text
    return resp.json()["run"]


# --------------------------------------------------------------------------- #
# fake Anthropic client
# --------------------------------------------------------------------------- #
def _http_response(status: int, headers: dict | None = None) -> httpx2.Response:
    return httpx2.Response(status, headers=headers or {},
                           request=httpx2.Request("POST", "https://api.anthropic.com/v1/messages"))


def _message(text=NARRATIVE, stop_reason="end_turn", stop_details=None, model="claude-opus-5",
             input_tokens=1200, output_tokens=800, cache_read=None):
    return SimpleNamespace(
        content=[SimpleNamespace(type="thinking", thinking="..."), SimpleNamespace(type="text", text=text)],
        stop_reason=stop_reason, stop_details=stop_details, model=model,
        usage=SimpleNamespace(input_tokens=input_tokens, output_tokens=output_tokens,
                              cache_read_input_tokens=cache_read),
    )


class FakeClient:
    """Records every call; ``outcome`` is a message to return or an exception to raise."""

    def __init__(self, api_key: str, outcome, calls: list):
        self.api_key = api_key
        self._outcome = outcome
        self._calls = calls
        self.messages = SimpleNamespace(create=self._create)
        self.models = SimpleNamespace(retrieve=self._retrieve)

    def _create(self, **kwargs):
        self._calls.append(("messages.create", self.api_key, kwargs))
        if isinstance(self._outcome, Exception):
            raise self._outcome
        return self._outcome

    def _retrieve(self, model_id, **kwargs):
        self._calls.append(("models.retrieve", self.api_key, {"model_id": model_id}))
        if isinstance(self._outcome, Exception):
            raise self._outcome
        return SimpleNamespace(id=model_id, display_name="Claude Opus 5")


@pytest.fixture()
def fake(monkeypatch):
    """``fake(outcome)`` installs a factory; ``fake.calls`` holds what was sent."""
    calls: list = []

    def install(outcome):
        def factory(api_key: str):
            return FakeClient(api_key, outcome, calls)

        monkeypatch.setattr(llm.interpret, "__defaults__", (factory,))
        monkeypatch.setattr(llm.validate_key, "__defaults__", (llm.DEFAULT_MODEL, factory))
        return factory

    install.calls = calls  # type: ignore[attr-defined]
    return install


def _interpret(client, token, run_id, **extra):
    body = {"run_id": run_id, "api_key": FAKE_KEY, "provider": "anthropic", **extra}
    return client.post("/api/llm/interpret", json=body, headers=_headers(token))


# --------------------------------------------------------------------------- #
# meta + prompt
# --------------------------------------------------------------------------- #
def test_meta_llm_is_public_and_mirrors_the_price_table(client):
    body = client.get("/api/meta/llm").json()
    assert body["providers"] == ["anthropic"]
    assert body["default_model"] == "claude-opus-5" == llm.DEFAULT_MODEL
    assert body["efforts"] == ["low", "medium", "high"]
    assert body["default_effort"] == "medium"
    assert [m["id"] for m in body["models"]] == ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"]
    prices = {m["id"]: (m["input_usd_per_mtok"], m["output_usd_per_mtok"]) for m in body["models"]}
    assert prices == {"claude-opus-5": (5.0, 25.0), "claude-sonnet-5": (2.0, 10.0), "claude-haiku-4-5": (1.0, 5.0)}
    assert body["rate_limit"] == {"calls": 10, "window_seconds": 600}


def test_system_prompt_quotes_the_language_policy_verbatim():
    policy = llm.load_language_policy()
    scope = (Path(__file__).resolve().parents[1] / "docs" / "SCIENTIFIC_SCOPE.md").read_text(encoding="utf-8")
    assert policy in scope
    assert policy.startswith('Avoid: "AI discovered how to extend lifespan"')
    assert "AI identified parameter configurations that optimise the chosen" in policy
    # The embedded fallback (used inside the Docker image if the file is missing) cannot drift.
    assert llm._LANGUAGE_POLICY_FALLBACK == policy
    prompt = llm.build_system_prompt()
    assert policy in prompt
    for heading in ("### Problem", "### Method", "### AI contribution", "### Evidence", "### Trade-offs & caveats"):
        assert heading in prompt
    assert "does not provide\nmedical advice" in prompt or "does not provide medical advice" in prompt.replace("\n", " ")
    assert "Negative results are legitimate" in prompt


def test_missing_scope_file_falls_back_to_the_embedded_policy(tmp_path):
    assert llm.load_language_policy(tmp_path / "nope.md") == llm._LANGUAGE_POLICY_FALLBACK


# --------------------------------------------------------------------------- #
# interpret: happy path + error mapping
# --------------------------------------------------------------------------- #
def test_interpret_requires_auth(client):
    resp = client.post("/api/llm/interpret", json={"run_id": "TEL-1", "api_key": FAKE_KEY})
    assert resp.status_code == 401
    assert resp.json()["detail"] == "Could not validate credentials"  # the JWT 401, a plain string


def test_interpret_happy_path(client, fake):
    fake(_message())
    token = _token(client)
    run = _simulate(client, token)
    resp = _interpret(client, token, run["run_id"])
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["run_id"] == run["run_id"]
    assert body["model"] == "claude-opus-5"
    assert body["narrative_markdown"] == NARRATIVE
    assert body["usage"] == {"input_tokens": 1200, "output_tokens": 800, "cache_read_input_tokens": None}
    assert body["estimated_cost_usd"] == pytest.approx((1200 * 5 + 800 * 25) / 1e6)
    assert body["warnings"] == []
    assert resp.headers["cache-control"] == "no-store"

    name, key_used, kwargs = fake.calls[-1]
    assert name == "messages.create"
    assert key_used == FAKE_KEY
    assert kwargs["model"] == "claude-opus-5"
    assert kwargs["max_tokens"] == llm.MAX_OUTPUT_TOKENS
    assert kwargs["output_config"] == {"effort": "medium"}
    assert "thinking" not in kwargs  # adaptive by default; never budget_tokens
    assert llm.load_language_policy() in kwargs["system"]
    assert kwargs["messages"][0]["role"] == "user"
    context = json.loads(kwargs["messages"][0]["content"].split("```json\n")[1].rsplit("```", 1)[0])
    assert context["run_id"] == run["run_id"]
    assert context["kind"] == "simulation"
    assert context["fitness"] == pytest.approx(run["fitness"]["total"], abs=1e-4)
    assert context["configuration"]["model"]["cycles"] == 20
    assert context["results"]["terminal_metrics"]["final_population_size"] == run["terminal_metrics"]["final_population_size"]
    assert "timeseries" in context["results"]


def test_interpret_honours_model_and_effort_and_prices_them(client, fake):
    fake(_message(model="claude-haiku-4-5", input_tokens=10_000, output_tokens=2_000, cache_read=5_000))
    token = _token(client)
    run = _simulate(client, token)
    resp = _interpret(client, token, run["run_id"], model="claude-haiku-4-5", effort="low")
    assert resp.status_code == 200, resp.text
    kwargs = fake.calls[-1][2]
    assert kwargs["model"] == "claude-haiku-4-5" and kwargs["output_config"] == {"effort": "low"}
    body = resp.json()
    assert body["usage"]["cache_read_input_tokens"] == 5_000
    assert body["estimated_cost_usd"] == pytest.approx((10_000 * 1 + 5_000 * 0.1 + 2_000 * 5) / 1e6)


def test_unknown_model_or_effort_is_422_without_echoing_the_key(client, fake):
    fake(_message())
    token = _token(client)
    run = _simulate(client, token)
    for extra in ({"model": "claude-opus-4-1-20250805"}, {"effort": "max"}, {"provider": "openai"}):
        resp = _interpret(client, token, run["run_id"], **extra)
        assert resp.status_code == 422, resp.text
        assert FAKE_KEY not in resp.text
    assert fake.calls == []


def test_invalid_key_is_401_llm_auth_failed(client, fake):
    fake(anthropic.AuthenticationError("invalid x-api-key", response=_http_response(401), body=None))
    token = _token(client)
    run = _simulate(client, token)
    resp = _interpret(client, token, run["run_id"])
    assert resp.status_code == 401
    detail = resp.json()["detail"]
    assert detail["code"] == "llm_auth_failed"
    assert "API key" in detail["message"]
    assert detail != "Could not validate credentials"  # distinct from our own JWT 401


def test_permission_denied_is_403(client, fake):
    fake(anthropic.PermissionDeniedError("no access", response=_http_response(403), body=None))
    token = _token(client)
    run = _simulate(client, token)
    resp = _interpret(client, token, run["run_id"])
    assert resp.status_code == 403 and resp.json()["detail"]["code"] == "llm_permission_denied"


def test_upstream_rate_limit_is_429_with_retry_after(client, fake):
    fake(anthropic.RateLimitError("slow down", response=_http_response(429, {"retry-after": "7"}), body=None))
    token = _token(client)
    run = _simulate(client, token)
    resp = _interpret(client, token, run["run_id"])
    assert resp.status_code == 429
    assert resp.json()["detail"]["code"] == "llm_rate_limited"
    assert resp.headers["retry-after"] == "7"


def test_refusal_is_422_with_category(client, fake):
    fake(_message(text="", stop_reason="refusal", stop_details=SimpleNamespace(type="refusal", category="bio")))
    token = _token(client)
    run = _simulate(client, token)
    resp = _interpret(client, token, run["run_id"])
    assert resp.status_code == 422
    detail = resp.json()["detail"]
    assert detail["code"] == "llm_refusal" and detail["category"] == "bio"


@pytest.mark.parametrize("exc", [
    anthropic.APIConnectionError(request=httpx2.Request("POST", "https://api.anthropic.com")),
    anthropic.APITimeoutError(request=httpx2.Request("POST", "https://api.anthropic.com")),
    anthropic.InternalServerError("boom", response=_http_response(500), body=None),
])
def test_connection_timeout_and_5xx_are_502(client, fake, exc):
    fake(exc)
    token = _token(client)
    run = _simulate(client, token)
    resp = _interpret(client, token, run["run_id"])
    assert resp.status_code == 502 and resp.json()["detail"]["code"] == "llm_upstream_error"


def test_bad_request_is_400(client, fake):
    fake(anthropic.BadRequestError("max_tokens too large", response=_http_response(400), body=None))
    token = _token(client)
    run = _simulate(client, token)
    resp = _interpret(client, token, run["run_id"])
    assert resp.status_code == 400 and resp.json()["detail"]["code"] == "llm_bad_request"


def test_max_tokens_stop_adds_a_warning(client, fake):
    fake(_message(stop_reason="max_tokens"))
    token = _token(client)
    run = _simulate(client, token)
    body = _interpret(client, token, run["run_id"]).json()
    assert any("cut off" in w for w in body["warnings"])


def test_per_user_rate_limit(client, fake, monkeypatch):
    fake(_message())
    monkeypatch.setattr(llm.interpret_rate_limiter, "max_calls", 2)
    token = _token(client)
    run = _simulate(client, token)
    assert _interpret(client, token, run["run_id"]).status_code == 200
    assert _interpret(client, token, run["run_id"]).status_code == 200
    third = _interpret(client, token, run["run_id"])
    assert third.status_code == 429
    assert third.json()["detail"]["code"] == "llm_rate_limited"
    assert int(third.headers["retry-after"]) >= 1
    assert len([c for c in fake.calls if c[0] == "messages.create"]) == 2  # the third never reached the SDK
    # Another user has their own budget.
    other = _token(client, "llm_other", "llm_other@example.com")
    assert _interpret(client, other, run["run_id"]).status_code == 200


def test_rate_limiter_window_slides():
    limiter = llm.RateLimiter(max_calls=2, window_seconds=600)
    limiter.check(1, now=0.0)
    limiter.check(1, now=1.0)
    with pytest.raises(llm.LLMRateLimited) as exc:
        limiter.check(1, now=2.0)
    assert exc.value.extra["retry_after"] == pytest.approx(598.0)
    limiter.check(1, now=600.5)  # the first call has aged out


# --------------------------------------------------------------------------- #
# ownership / not found -- same rule as the experiments router
# --------------------------------------------------------------------------- #
def test_other_users_run_is_readable_like_the_record_route(client, fake):
    fake(_message())
    token_a = _token(client, "llm_a", "llm_a@example.com")
    token_b = _token(client, "llm_b", "llm_b@example.com")
    run = _simulate(client, token_a)
    assert client.get(f"/api/experiments/{run['run_id']}", headers=_headers(token_b)).status_code == 200
    assert _interpret(client, token_b, run["run_id"]).status_code == 200


def test_missing_or_malformed_run_id(client, fake):
    fake(_message())
    token = _token(client)
    assert _interpret(client, token, "TEL-99999999-999").status_code == 404
    assert _interpret(client, token, "..%2Fregistry").status_code in (400, 404)
    assert _interpret(client, token, ".hidden").status_code in (400, 404)
    assert fake.calls == []


# --------------------------------------------------------------------------- #
# the key is never persisted or logged
# --------------------------------------------------------------------------- #
def test_api_key_is_never_written_or_logged(client, fake, runs_dir, tmp_path, caplog):
    fake(_message())
    caplog.set_level(logging.DEBUG)
    token = _token(client)
    run = _simulate(client, token)
    ok = _interpret(client, token, run["run_id"])
    assert ok.status_code == 200
    bad = _interpret(client, token, run["run_id"], effort="max")  # 422 path
    assert bad.status_code == 422
    fake(anthropic.AuthenticationError("invalid x-api-key", response=_http_response(401), body=None))
    assert _interpret(client, token, run["run_id"]).status_code == 401

    needle = FAKE_KEY.encode()
    assert FAKE_KEY not in caplog.text
    assert FAKE_KEY not in ok.text and FAKE_KEY not in bad.text
    for path in tmp_path.rglob("*"):
        if path.is_file():
            assert needle not in path.read_bytes(), f"key found in {path}"
    # The ledger did not grow: interpretations are not runs.
    assert len(list(runs_dir.glob("TEL-*"))) == 1
    # And the request models mask it.
    from backend import schemas as api_schemas

    req = api_schemas.LLMInterpretRequest(run_id="x", api_key=FAKE_KEY)
    assert FAKE_KEY not in repr(req) and FAKE_KEY not in str(req)


def test_real_factory_binds_the_users_key_only(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-SERVER-KEY-MUST-NOT-BE-USED")
    c = llm.anthropic_client_factory("sk-user")
    assert c.api_key == "sk-user"
    assert c.max_retries == 1


# --------------------------------------------------------------------------- #
# validate-key
# --------------------------------------------------------------------------- #
def test_validate_key(client, fake):
    token = _token(client)
    fake(None)  # models.retrieve succeeds
    resp = client.post("/api/llm/validate-key", json={"api_key": FAKE_KEY, "provider": "anthropic"},
                       headers=_headers(token))
    assert resp.status_code == 200 and resp.json()["valid"] is True
    assert fake.calls[-1][0] == "models.retrieve" and fake.calls[-1][2]["model_id"] == llm.DEFAULT_MODEL

    fake(anthropic.AuthenticationError("invalid x-api-key", response=_http_response(401), body=None))
    resp = client.post("/api/llm/validate-key", json={"api_key": FAKE_KEY}, headers=_headers(token))
    assert resp.status_code == 200 and resp.json() == {"valid": False, "detail": "Anthropic rejected the API key (401)."}

    fake(anthropic.APIConnectionError(request=httpx2.Request("GET", "https://api.anthropic.com")))
    resp = client.post("/api/llm/validate-key", json={"api_key": FAKE_KEY}, headers=_headers(token))
    assert resp.status_code == 502

    assert client.post("/api/llm/validate-key", json={"api_key": FAKE_KEY}).status_code == 401


# --------------------------------------------------------------------------- #
# context builder: per kind + size cap
# --------------------------------------------------------------------------- #
RUNS = Path(__file__).resolve().parents[1] / "experiments" / "runs"


def _ledger(run_id: str, artifact: str):
    rec = json.loads((RUNS / run_id / "record.json").read_text(encoding="utf-8"))
    art = json.loads((RUNS / run_id / artifact).read_text(encoding="utf-8"))
    return rec, art


@pytest.mark.skipif(not (RUNS / "TEL-20260907-001").is_dir(), reason="reference ledger not present")
def test_evolution_context_from_the_reference_ledger():
    rec, art = _ledger("TEL-20260907-001", "evolution.json")
    ctx = llm.build_context(rec, {"evolution_json": art})
    assert llm._serialized_size(ctx) <= llm.CONTEXT_BYTE_CAP
    res = ctx["results"]
    assert res["best"]["genome"]["maintenance_rate"] == pytest.approx(0.6541, abs=1e-4)
    assert res["baseline_fitness"] == pytest.approx(-0.1337, abs=1e-4)
    assert res["history"]["generations_recorded"] == 21
    assert res["history"]["first"]["generation"] == 0 and res["history"]["last"]["generation"] == 20
    assert res["history"]["best_generation"]["best_fitness"] == pytest.approx(0.6254, abs=1e-4)
    assert "(truncated)" in res["history"]["note"]
    assert ctx["configuration"]["evolution"]["weights"]["w_survival"] == 0.4


@pytest.mark.skipif(not (RUNS / "TEL-20260907-005").is_dir(), reason="reference ledger not present")
def test_pareto_context_from_the_reference_ledger():
    rec, art = _ledger("TEL-20260907-005", "pareto.json")
    ctx = llm.build_context(rec, {"pareto_json": art})
    assert llm._serialized_size(ctx) <= llm.CONTEXT_BYTE_CAP
    res = ctx["results"]
    assert res["objectives"] == ["survival", "cost"]
    assert res["front_size"] == 40 and len(res["front"]) == 40
    assert res["final_hypervolume"] == pytest.approx(0.984, abs=1e-3)
    assert res["history"]["last"]["hypervolume"] == pytest.approx(0.984, abs=1e-3)


def test_sensitivity_and_active_learning_contexts():
    sens_rec = {"run_id": "TEL-1", "kind": "sensitivity", "fitness": 0.1, "most_sensitive_parameter": "stress_level",
                "max_swing": -0.5, "configuration": {"model": {}, "sensitivity": {"parameters": ["a", "b"]}}}
    sens_art = {"baseline_fitness": 0.1, "items": [
        {"parameter": "a", "baseline_value": 1, "low_value": 0.8, "high_value": 1.2, "fitness_low": 0.2,
         "fitness_baseline": 0.1, "fitness_high": 0.05, "swing": -0.15},
        {"parameter": "stress_level", "baseline_value": 0.6, "low_value": 0.48, "high_value": 0.72, "fitness_low": 0.3,
         "fitness_baseline": 0.1, "fitness_high": -0.2, "swing": -0.5}]}
    ctx = llm.build_context(sens_rec, {"sensitivity_json": sens_art})
    assert [s["parameter"] for s in ctx["results"]["swings"]] == ["stress_level", "a"]  # sorted by |swing|

    al_rec = {"run_id": "TEL-2", "kind": "active_learning", "fitness": 0.5, "best_genome": {"x": 1},
              "n_initial": 2, "n_iterations": 2, "evaluations": 4, "configuration": {"model": {}}}
    al_art = {"records": [
        {"iteration": 0, "phase": "initial", "genome": {"x": 0}, "real_fitness": 0.1, "best_so_far": 0.1, "n_real_evaluations": 1},
        {"iteration": 1, "phase": "initial", "genome": {"x": 2}, "real_fitness": 0.3, "best_so_far": 0.3, "n_real_evaluations": 2},
        {"iteration": 2, "phase": "active", "genome": {"x": 1}, "real_fitness": 0.5, "best_so_far": 0.5, "n_real_evaluations": 3},
        {"iteration": 3, "phase": "active", "genome": {"x": 1.1}, "real_fitness": 0.4, "best_so_far": 0.5, "n_real_evaluations": 4}]}
    ctx = llm.build_context(al_rec, {"active_learning_json": al_art})
    conv = ctx["results"]["convergence"]
    assert conv == {"best_after_initial_design": 0.3, "best_final": 0.5, "first_evaluation_reaching_final_best": 3}


def test_context_size_cap_truncates_huge_artifacts():
    rec = {"run_id": "TEL-BIG", "kind": "evolution", "fitness": 0.5, "configuration": {"model": {"cycles": 120}},
           "artifacts": {"evolution_json": "/x/evolution.json"}}
    art = {
        "history": [{"generation": g, "best_fitness": g / 5000, "mean_fitness": 0.1, "diversity": 0.2,
                     "n_invalid": 0, "evaluations_so_far": 32 * g, "junk": "z" * 500} for g in range(5000)],
        "best": {"genome": {f"g{i}": i * 0.001 for i in range(3000)}, "fitness": 0.5},
        "baseline": {"genome": {f"g{i}": 0.0 for i in range(3000)}, "fitness": -0.1},
    }
    ctx = llm.build_context(rec, {"evolution_json": art})
    dumped = json.dumps(ctx, default=str)
    assert len(dumped.encode()) <= llm.CONTEXT_BYTE_CAP
    assert "(truncated)" in dumped
    assert ctx["results"]["history"]["generations_recorded"] == 5000  # the count survives, the rows are sampled
    assert len(ctx["results"]["history"]["rows"]) <= llm._HISTORY_KEEP


def test_interpret_warns_when_context_was_truncated(fake):
    fake(_message())
    ctx = {"run_id": "TEL-X", "truncated": "(truncated): arrays were shortened"}
    result = llm.interpret(llm.InterpretRequestData(run_id="TEL-X", api_key="k", context=ctx))
    assert any("truncated" in w for w in result.warnings)
    assert re.search(r"\(truncated\)", fake.calls[-1][2]["messages"][0]["content"])
