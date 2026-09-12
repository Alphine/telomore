"""API + unit tests for LLM Layer 2, the protocol-proposing agent
(backend/llm.py's propose_protocol/_build_proposed_config,
backend/routers/llm.py's POST /api/llm/propose-protocol). No network: the
Anthropic client factory is replaced by a fake that returns a canned
tool_use block or raises the real ``anthropic`` exception classes, exactly
like tests/test_api_llm.py for Layer 1.

Hard safety boundary under test throughout this file: propose-protocol never
runs a simulation, and every config it returns has already passed
ModelConfig.validate() -- an invalid tool call from the model must come back
as a 422 (ProposalInvalid), never as a "valid-looking" config the frontend
could load and run.
"""

from __future__ import annotations

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

FAST_MODEL = {"cycles": 20, "population_size": 20, "carrying_capacity": 40, "telomeres_per_cell": 6,
             "stress_level": 0.6, "maintenance_rate": 0.1, "repair_rate": 0.15}
FAKE_KEY = "sk-ant-api03-FAKE-KEY-FOR-TESTS-0123456789"

SIX_PHASE_INPUT = {
    "rationale": "Concentrate repair into the high-stress phases, per Experiment G's mechanism.",
    "phases": 6,
    "stress_level": [0.9, 0.3, 0.9, 0.3, 0.9, 0.3],
    "maintenance_rate": [1.0, 0.7, 0.3, 1.0, 1.0, 0.8],
    "repair_rate": [1.0, 0.4, 0.9, 0.0, 0.7, 0.0],
}
CONSTANT_INPUT = {
    "rationale": "A constant response is the best answer here.",
    "phases": 1,
    "stress_level": [0.6],
    "maintenance_rate": [0.9],
    "repair_rate": [0.5],
}


@pytest.fixture(autouse=True)
def _isolated(tmp_path, monkeypatch):
    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.delenv("RESEND_API_KEY", raising=False)
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.setattr(db_module, "DATA_DIR", tmp_path / "data")
    db_module.reset_engine()
    llm.propose_rate_limiter.reset()
    yield
    db_module.reset_engine()
    llm.propose_rate_limiter.reset()


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


def _token(client, username="propose_user", email="propose_user@example.com", password="hunter22") -> str:
    reg = client.post("/api/auth/register", json={"username": username, "email": email, "password": password})
    verify_token = reg.json()["dev_verification_link"].split("token=")[1]
    client.get("/api/auth/verify", params={"token": verify_token})
    return client.post("/api/auth/login", json={"username": username, "password": password}).json()["access_token"]


def _headers(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def _http_response(status: int, headers: dict | None = None) -> httpx2.Response:
    return httpx2.Response(status, headers=headers or {},
                           request=httpx2.Request("POST", "https://api.anthropic.com/v1/messages"))


def _tool_message(tool_input=None, stop_reason="tool_use", stop_details=None, model="claude-opus-5",
                  input_tokens=600, output_tokens=250, cache_read=None, no_tool_block=False):
    content = [] if no_tool_block else [
        SimpleNamespace(type="tool_use", name="propose_protocol", input=tool_input or SIX_PHASE_INPUT),
    ]
    return SimpleNamespace(
        content=content, stop_reason=stop_reason, stop_details=stop_details, model=model,
        usage=SimpleNamespace(input_tokens=input_tokens, output_tokens=output_tokens,
                              cache_read_input_tokens=cache_read),
    )


class FakeClient:
    def __init__(self, api_key: str, outcome, calls: list):
        self.api_key = api_key
        self._outcome = outcome
        self._calls = calls
        self.messages = SimpleNamespace(create=self._create)

    def _create(self, **kwargs):
        self._calls.append(("messages.create", self.api_key, kwargs))
        if isinstance(self._outcome, Exception):
            raise self._outcome
        return self._outcome


@pytest.fixture()
def fake(monkeypatch):
    calls: list = []

    def install(outcome):
        def factory(api_key: str):
            return FakeClient(api_key, outcome, calls)

        monkeypatch.setattr(llm.propose_protocol, "__defaults__", (factory,))
        return factory

    install.calls = calls  # type: ignore[attr-defined]
    return install


def _propose(client, token, goal="try an intermittent-fasting-like protocol", **extra):
    body = {"goal": goal, "base_config": FAST_MODEL, "api_key": FAKE_KEY, "provider": "anthropic", **extra}
    return client.post("/api/llm/propose-protocol", json=body, headers=_headers(token))


# --------------------------------------------------------------------------- #
# happy path
# --------------------------------------------------------------------------- #
def test_propose_requires_auth(client):
    resp = client.post("/api/llm/propose-protocol", json={"goal": "x", "api_key": FAKE_KEY})
    assert resp.status_code == 401


def test_propose_happy_path_returns_a_config_that_validates(client, fake):
    fake(_tool_message())
    token = _token(client)
    resp = _propose(client, token)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["rationale"] == SIX_PHASE_INPUT["rationale"]
    assert body["model"] == "claude-opus-5"
    assert body["config"]["schedule"] == {
        "phases": 6,
        "values": {
            "stress_level": SIX_PHASE_INPUT["stress_level"],
            "maintenance_rate": SIX_PHASE_INPUT["maintenance_rate"],
            "repair_rate": SIX_PHASE_INPUT["repair_rate"],
        },
    }
    # Non-protocol fields pass through from base_config untouched.
    assert body["config"]["cycles"] == 20
    assert body["config"]["population_size"] == 20
    assert resp.headers["cache-control"] == "no-store"

    # The returned config is independently re-validatable by the caller too --
    # it must be exactly as usable as any hand-typed or GA-produced config.
    from telomere_lab.schemas import ModelConfig
    ModelConfig.from_dict(body["config"]).validate()

    name, key_used, kwargs = fake.calls[-1]
    assert name == "messages.create"
    assert key_used == FAKE_KEY
    assert kwargs["tools"] == [llm.PROPOSE_TOOL]
    assert kwargs["tool_choice"] == {"type": "tool", "name": "propose_protocol"}
    assert "Experiment G" in kwargs["system"]
    assert "Experiment E" in kwargs["system"]
    assert llm.load_language_policy() in kwargs["system"]
    assert "try an intermittent-fasting-like protocol" in kwargs["messages"][0]["content"]


def test_propose_constant_phase_has_no_schedule(client, fake):
    fake(_tool_message(CONSTANT_INPUT))
    token = _token(client)
    resp = _propose(client, token)
    assert resp.status_code == 200, resp.text
    config = resp.json()["config"]
    assert "schedule" not in config or config["schedule"] is None
    assert config["stress_level"] == 0.6
    assert config["maintenance_rate"] == 0.9
    assert config["repair_rate"] == 0.5


def test_propose_never_lets_the_model_change_non_protocol_fields(client, fake):
    # Even if the model's tool call somehow tried to smuggle in other keys, the
    # tool's input_schema doesn't accept them, and _build_proposed_config only
    # ever reads phases/stress_level/maintenance_rate/repair_rate off it.
    fake(_tool_message())
    token = _token(client)
    resp = _propose(client, token)
    config = resp.json()["config"]
    assert config["telomeres_per_cell"] == FAST_MODEL["telomeres_per_cell"]
    assert config["carrying_capacity"] == FAST_MODEL["carrying_capacity"]


# --------------------------------------------------------------------------- #
# the hard safety boundary: an invalid tool call never becomes a runnable config
# --------------------------------------------------------------------------- #
def test_mismatched_phase_length_is_422_proposal_invalid(client, fake):
    bad = {**SIX_PHASE_INPUT, "repair_rate": [1.0, 0.4, 0.9]}  # 3 values, phases=6
    fake(_tool_message(bad))
    token = _token(client)
    resp = _propose(client, token)
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "llm_proposal_invalid"


def test_out_of_range_phases_is_422(client, fake):
    bad = {**SIX_PHASE_INPUT, "phases": 99}
    fake(_tool_message(bad))
    token = _token(client)
    resp = _propose(client, token)
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "llm_proposal_invalid"


def test_missing_tool_call_is_502_upstream_error(client, fake):
    fake(_tool_message(no_tool_block=True))
    token = _token(client)
    resp = _propose(client, token)
    assert resp.status_code == 502


def test_malformed_tool_input_types_are_422_not_a_500(client, fake):
    bad = {**SIX_PHASE_INPUT, "stress_level": "not-a-list"}
    fake(_tool_message(bad))
    token = _token(client)
    resp = _propose(client, token)
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "llm_proposal_invalid"


# --------------------------------------------------------------------------- #
# error mapping (mirrors Layer 1's) + rate limiting
# --------------------------------------------------------------------------- #
def test_invalid_key_is_401(client, fake):
    fake(anthropic.AuthenticationError("invalid x-api-key", response=_http_response(401), body=None))
    token = _token(client)
    resp = _propose(client, token)
    assert resp.status_code == 401
    assert resp.json()["detail"]["code"] == "llm_auth_failed"


def test_refusal_is_422(client, fake):
    fake(_tool_message(stop_reason="refusal", stop_details=SimpleNamespace(type="refusal", category="bio")))
    token = _token(client)
    resp = _propose(client, token)
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "llm_refusal"


def test_unknown_model_or_effort_is_422(client, fake):
    fake(_tool_message())
    token = _token(client)
    for extra in ({"model": "claude-opus-4-1-20250805"}, {"effort": "max"}):
        resp = _propose(client, token, **extra)
        assert resp.status_code == 422, resp.text
        assert FAKE_KEY not in resp.text


def test_propose_has_its_own_rate_limit_budget_separate_from_interpret(client, fake, monkeypatch):
    fake(_tool_message())
    monkeypatch.setattr(llm.propose_rate_limiter, "max_calls", 2)
    token = _token(client)
    assert _propose(client, token).status_code == 200
    assert _propose(client, token).status_code == 200
    third = _propose(client, token)
    assert third.status_code == 429
    assert third.json()["detail"]["code"] == "llm_rate_limited"
    # interpret's budget is untouched -- separate RateLimiter instance.
    assert llm.interpret_rate_limiter.max_calls == llm.RATE_LIMIT_CALLS


# --------------------------------------------------------------------------- #
# provenance tagging on the run that actually gets executed from a proposal
# --------------------------------------------------------------------------- #
def test_a_run_loaded_from_a_proposal_can_be_tagged_with_its_provenance_in_the_ledger(client, fake):
    fake(_tool_message())
    token = _token(client)
    proposed = _propose(client, token).json()["config"]

    resp = client.post(
        "/api/simulate",
        json={"config": proposed, "provenance": "LLM-proposed protocol (Layer 2)"},
        headers=_headers(token),
    )
    assert resp.status_code == 200, resp.text
    run_id = resp.json()["run"]["run_id"]

    from telomere_lab.experiments.registry import ExperimentRegistry
    record = ExperimentRegistry().load(run_id)
    assert record["notes"] == "LLM-proposed protocol (Layer 2)"


def test_simulate_without_provenance_still_defaults_to_via_api(client):
    resp = client.post("/api/simulate", json={"config": FAST_MODEL}, headers=_headers(_token(client)))
    run_id = resp.json()["run"]["run_id"]
    from telomere_lab.experiments.registry import ExperimentRegistry
    assert ExperimentRegistry().load(run_id)["notes"] == "via API"
