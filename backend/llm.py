"""LLM Layer 1 -- the read-only results interpreter (docs/ROADMAP.md, "LLM
agentic layer").

Given one ledger record plus its JSON artifacts, this module builds a compact
JSON *context*, a system prompt that quotes ``docs/SCIENTIFIC_SCOPE.md``'s
language policy verbatim, and asks an Anthropic model (bring-your-own-key)
for a plain-language narrative of what the run's numbers show. Nothing here
can run, queue or modify a simulation: the model receives recorded data and
returns Markdown, and that is the whole contract.

Key handling (the same non-persistent-credential posture as the login
system): the user's API key arrives in the request body, is handed to a
per-request ``anthropic.Anthropic(api_key=...)`` client and is otherwise never
stored, logged or echoed -- there is no server-side key at all (no
``ANTHROPIC_API_KEY`` fallback by design; the app never bears LLM cost).

Everything that touches the network goes through an injectable
``client_factory(api_key) -> client`` so the tests substitute a fake client
that returns canned content or raises real ``anthropic`` exception classes.
"""

from __future__ import annotations

import json
import logging
import re
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Deque, Dict, List, Optional, Tuple

import anthropic

from telomere_lab.config import PROJECT_ROOT

logger = logging.getLogger(__name__)

# --------------------------------------------------------------------------- #
# single source of truth for providers / models / prices / efforts
# --------------------------------------------------------------------------- #
PROVIDERS: Tuple[str, ...] = ("anthropic",)

#: Model id -> label + list price in USD per million tokens (input, output).
#: Prices are the public list prices at the time of writing and are only
#: used for the *estimate* shown next to a narrative -- the user's own
#: Anthropic invoice is the authority.
MODELS: Dict[str, Dict[str, Any]] = {
    "claude-opus-5": {"label": "Claude Opus 5 (default, most thorough)",
                      "input_usd_per_mtok": 5.0, "output_usd_per_mtok": 25.0},
    "claude-sonnet-5": {"label": "Claude Sonnet 5 (faster, cheaper)",
                        "input_usd_per_mtok": 2.0, "output_usd_per_mtok": 10.0},
    "claude-haiku-4-5": {"label": "Claude Haiku 4.5 (cheapest)",
                         "input_usd_per_mtok": 1.0, "output_usd_per_mtok": 5.0},
}
DEFAULT_MODEL = "claude-opus-5"
EFFORTS: Tuple[str, ...] = ("low", "medium", "high")
DEFAULT_EFFORT = "medium"

MAX_OUTPUT_TOKENS = 4000
#: Upper bound on the serialised context handed to the model (bytes of JSON).
CONTEXT_BYTE_CAP = 30_000
#: Per-user request budget (in-memory, single process -- see RateLimiter).
RATE_LIMIT_CALLS = 10
RATE_LIMIT_WINDOW_SECONDS = 600

REQUEST_TIMEOUT_SECONDS = 60.0

SCOPE_PATH = PROJECT_ROOT / "docs" / "SCIENTIFIC_SCOPE.md"

#: Verbatim copy of the "## Language policy" section of docs/SCIENTIFIC_SCOPE.md,
#: used only when the file is not on disk (the Docker image excludes docs/;
#: the Dockerfile copies this one file back, so this is a last resort).
#: tests/test_api_llm.py asserts this equals the file, so they cannot drift.
_LANGUAGE_POLICY_FALLBACK = (
    'Avoid: "AI discovered how to extend lifespan", "optimal therapy",\n'
    '"prevents ageing", "optimal dosing regimen", "fasting protocol that works",\n'
    '"this shows the treatment reversed aging", "the culture\'s biological age is\n'
    'now X" (stated as a measurement, not a computed number).\n'
    'Prefer: "AI identified parameter configurations that optimise the chosen\n'
    'objective within the simulation", "model output", "simulation parameter",\n'
    '"scheduled parameter protocol (model result)", "the synthetic age index for\n'
    'this configuration is X, computed from this simulation\'s own survival,\n'
    'telomere-reserve and senescence numbers".'
)


def load_language_policy(path: Path = SCOPE_PATH) -> str:
    """The body of ``## Language policy`` in docs/SCIENTIFIC_SCOPE.md, verbatim."""
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        logger.warning("%s not found; using the embedded copy of the language policy", path)
        return _LANGUAGE_POLICY_FALLBACK
    match = re.search(r"^## Language policy\s*\n(.*?)(?=^## |\Z)", text, flags=re.S | re.M)
    if not match:
        logger.warning("no '## Language policy' section in %s; using the embedded copy", path)
        return _LANGUAGE_POLICY_FALLBACK
    return match.group(1).strip()


def build_system_prompt(policy: Optional[str] = None) -> str:
    policy = policy if policy is not None else load_language_policy()
    return f"""You are the results interpreter of Telomere Evolution Lab, a computational
AI-for-Science demonstration: an evolutionary optimizer searches the parameter
space of a lightweight, stochastic telomere-population model for virtual
experiment conditions that optimise an explicit, user-defined objective. The
system explores behaviour within a computational model and does not provide
medical advice, clinical predictions, or validated therapeutic
recommendations.

You will receive one recorded experiment as JSON: the ledger record (kind,
configuration incl. any intervention schedule, seed, fitness) and a compact
summary of its artifacts. Write a plain-language scientific narrative of what
this run's recorded data shows. You are read-only: you cannot run, re-run or
modify simulations, and you must not propose configurations to run.

Rules you must follow:

1. Interpret only what the data shows. Every claim must be traceable to a
   number in the JSON; quote the numbers you rely on (with units where they
   exist). If the data does not support a statement, say so or leave it out.
   Never invent values that are not in the context.
2. These are MODEL RESULTS, not biology. Parameters called "maintenance",
   "repair" or "stress" are abstract model knobs; "survival", "senescence" and
   "reserve" are metrics of the simulated population under the stated
   objective. Do not translate them into statements about humans, patients,
   lifespan, disease, ageing, therapies or dosing.
3. Fitness is not biological truth. The fitness function is a weighted design
   choice; the optimizer identified parameter configurations that optimise
   that objective within the simulation -- nothing more. Make the weights'
   role visible whenever the run has them.
4. No clinical or therapeutic claims of any kind, and no recommendations
   about real interventions. The only admissible "recommendation" is which
   model configuration might be worth testing next as a virtual or in-vitro
   experiment, and only when the data motivates it.
5. Negative results are legitimate and worth stating plainly (e.g. "the
   protocol search found no benefit over the constant dose within
   seed-to-seed noise"). Do not dress them up.
6. Where the run contains uncertainty (single seed, small population, a
   plateau, an early stop, a truncated context marked "(truncated)"), name it
   as a caveat rather than glossing over it.

Language policy (quoted verbatim from docs/SCIENTIFIC_SCOPE.md -- follow it
literally, including its preferred phrasings):

{policy}

Output format: Markdown, concise (roughly 300-600 words), written for a
scientifically literate reader who has not seen this run. Use exactly these
five level-3 headings, in this order:

### Problem
What question this run asks of the model (from its kind, configuration and
objective) and why it is expensive or difficult to answer by hand.

### Method
How the computational model and this particular search/analysis represent
the question: the free parameters or schedule, the objective and its
weights, the seeds, the budget (generations / evaluations).

### AI contribution
What the evolutionary search, Pareto front, sensitivity sweep or active
learner did here that a static simulator would not: which trade-off it
exploited, which parameter dominates, what the shape of the front or the
convergence implies -- as shown by the numbers.

### Evidence
The reproducible numbers that support the previous section: baseline vs. best,
fitness by generation, front points, swings, convergence -- with the run id,
seed and configuration hash so the reader can reproduce it.

### Trade-offs & caveats
What the result does not show, the assumptions it depends on, the noise or
budget limits, and the honest scope statement: this is a model result, not a
clinical statement.

Do not add a title above the first heading, and do not add sections beyond
these five."""


# --------------------------------------------------------------------------- #
# context construction (record + artifacts -> compact JSON)
# --------------------------------------------------------------------------- #
#: record["artifacts"] keys whose JSON files are worth loading per kind.
JSON_ARTIFACT_KEYS: Dict[str, Tuple[str, ...]] = {
    "simulation": ("result_json",),
    "evolution": ("evolution_json",),
    "pareto": ("pareto_json",),
    "sensitivity": ("sensitivity_json",),
    "active_learning": ("active_learning_json",),
}

_HISTORY_KEEP = 12       # generations kept from a fitness history (first/last + evenly spaced)
_FRONT_CAP = 40          # Pareto front points
_RECORDS_CAP = 60        # active-learning real evaluations
_SERIES_POINTS = 25      # points kept from a simulation time series
_DICT_KEY_CAP = 64       # keys kept per dict by the size-cap fallback (a 64-gene genome is already huge)
_TRUNCATED = "(truncated)"


def _round(value: Any, ndigits: int = 4) -> Any:
    if isinstance(value, bool) or value is None:
        return value
    if isinstance(value, float):
        return round(value, ndigits)
    if isinstance(value, dict):
        return {k: _round(v, ndigits) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_round(v, ndigits) for v in value]
    return value


def _sample(seq: List[Any], keep: int) -> Tuple[List[Any], bool]:
    """Keep ``keep`` evenly spaced items incl. first and last; report truncation."""
    if len(seq) <= keep:
        return list(seq), False
    if keep <= 2:
        return [seq[0], seq[-1]], True
    step = (len(seq) - 1) / (keep - 1)
    idx = sorted({round(i * step) for i in range(keep)} | {0, len(seq) - 1})
    return [seq[i] for i in idx], True


def _config_summary(configuration: Dict[str, Any]) -> Dict[str, Any]:
    """The model block (incl. schedule) plus whichever optimizer/analysis block exists."""
    out: Dict[str, Any] = {}
    model = configuration.get("model")
    if isinstance(model, dict):
        out["model"] = _round(model)
    for key in ("weights", "evolution", "multiobjective", "sensitivity", "active_learning"):
        if key in configuration:
            out[key] = _round(configuration[key])
    return out


def _simulation_context(record: Dict[str, Any], art: Dict[str, Any]) -> Dict[str, Any]:
    out: Dict[str, Any] = {
        "terminal_metrics": _round(record.get("terminal_metrics") or art.get("terminal_metrics") or {}),
        "valid": record.get("valid", art.get("valid")),
        "failure_reason": record.get("failure_reason", art.get("failure_reason")),
    }
    ts = art.get("timeseries")
    if isinstance(ts, dict) and isinstance(ts.get("cycle"), list):
        cycles = ts["cycle"]
        keep, truncated = _sample(list(range(len(cycles))), _SERIES_POINTS)
        series: Dict[str, Any] = {}
        for name in ("cycle", "mean_length_bp", "shortest_length_bp", "mean_shortest_per_cell_bp",
                     "senescent_fraction", "population_size", "proliferative_count"):
            col = ts.get(name)
            if isinstance(col, list) and len(col) == len(cycles):
                series[name] = _round([col[i] for i in keep])
        if truncated:
            series["note"] = f"{_TRUNCATED}: {len(keep)} of {len(cycles)} cycles shown, evenly spaced"
        out["timeseries"] = series
    applied = art.get("applied_schedule")
    if isinstance(applied, dict) and applied:
        out["applied_schedule_time_average"] = {
            k: _round(sum(v[:-1]) / max(1, len(v) - 1)) for k, v in applied.items()
            if isinstance(v, list) and len(v) > 1
        }
    return out


def _candidate(c: Any) -> Any:
    if not isinstance(c, dict):
        return c
    keep = {k: c[k] for k in ("genome", "fitness", "breakdown", "objectives", "scalar_fitness", "valid")
            if k in c}
    tm = c.get("terminal_metrics")
    if isinstance(tm, dict):
        keep["terminal_metrics"] = {k: tm[k] for k in (
            "final_mean_length_bp", "final_mean_shortest_bp", "normalized_survival",
            "final_senescent_fraction", "final_population_size", "time_to_50pct_senescence", "extinct",
        ) if k in tm}
    return _round(keep)


def _history_summary(history: List[Dict[str, Any]], fields: Tuple[str, ...]) -> Dict[str, Any]:
    if not history:
        return {}
    rows, truncated = _sample(history, _HISTORY_KEEP)
    out: Dict[str, Any] = {
        "generations_recorded": len(history),
        "first": _round({k: history[0].get(k) for k in fields}),
        "last": _round({k: history[-1].get(k) for k in fields}),
        "rows": [_round({k: h.get(k) for k in fields}) for h in rows],
    }
    if truncated:
        out["note"] = f"{_TRUNCATED}: {len(rows)} of {len(history)} generations shown, evenly spaced"
    return out


def _evolution_context(record: Dict[str, Any], art: Dict[str, Any]) -> Dict[str, Any]:
    history = art.get("history") or []
    best_gen = None
    if history:
        best_gen = max(history, key=lambda h: (h.get("best_fitness") is not None, h.get("best_fitness") or 0))
    out: Dict[str, Any] = {
        "baseline": _candidate(art.get("baseline")),
        "best": _candidate(art.get("best")),
        "baseline_fitness": _round(record.get("baseline_fitness")),
        "best_genome": _round(record.get("best_genome")),
        "evaluations": record.get("evaluations", art.get("evaluations")),
        "generations_completed": record.get("generations_completed"),
        "stopped_early": record.get("stopped_early", art.get("stopped_early")),
        "stop_reason": record.get("stop_reason", art.get("stop_reason")),
        "history": _history_summary(history, ("generation", "best_fitness", "mean_fitness", "diversity",
                                              "n_invalid", "evaluations_so_far")),
    }
    if best_gen is not None:
        out["history"]["best_generation"] = _round({k: best_gen.get(k) for k in ("generation", "best_fitness")})
    return out


def _pareto_context(record: Dict[str, Any], art: Dict[str, Any]) -> Dict[str, Any]:
    front = art.get("front") or record.get("front") or []
    front_rows, truncated = _sample(front, _FRONT_CAP)
    out: Dict[str, Any] = {
        "algorithm": record.get("algorithm", art.get("algorithm")),
        "objectives": record.get("objectives") or (art.get("mo_config") or {}).get("objectives"),
        "reference_point": _round(art.get("reference_point")),
        "baseline": _candidate(art.get("baseline")),
        "front_size": record.get("front_size", len(front)),
        "final_hypervolume": _round(record.get("final_hypervolume")),
        "front": [_candidate(c) for c in front_rows],
        "evaluations": record.get("evaluations", art.get("evaluations")),
        "generations_completed": record.get("generations_completed"),
        "stopped_early": record.get("stopped_early", art.get("stopped_early")),
        "history": _history_summary(art.get("history") or [], ("generation", "front_size", "hypervolume",
                                                                "n_invalid", "evaluations_so_far")),
    }
    if truncated:
        out["front_note"] = f"{_TRUNCATED}: {len(front_rows)} of {len(front)} front points shown"
    return out


def _sensitivity_context(record: Dict[str, Any], art: Dict[str, Any]) -> Dict[str, Any]:
    items = art.get("items") or []
    swings = sorted(items, key=lambda it: -abs(it.get("swing") or 0.0))
    return {
        "baseline_fitness": _round(art.get("baseline_fitness", record.get("fitness"))),
        "most_sensitive_parameter": record.get("most_sensitive_parameter"),
        "max_swing": _round(record.get("max_swing")),
        "swings": [_round({k: it.get(k) for k in ("parameter", "baseline_value", "low_value", "high_value",
                                                  "fitness_low", "fitness_baseline", "fitness_high", "swing")})
                   for it in swings],
        "evaluations": record.get("evaluations", art.get("evaluations")),
    }


def _active_learning_context(record: Dict[str, Any], art: Dict[str, Any]) -> Dict[str, Any]:
    records = art.get("records") or []
    rows, truncated = _sample(records, _RECORDS_CAP)
    initial = [r for r in records if r.get("phase") == "initial"]
    active = [r for r in records if r.get("phase") == "active"]
    out: Dict[str, Any] = {
        "best_genome": _round(record.get("best_genome", art.get("best_genome"))),
        "best_fitness": _round(record.get("fitness", art.get("best_fitness"))),
        "n_initial": record.get("n_initial", len(initial)),
        "n_iterations": record.get("n_iterations", len(active)),
        "evaluations": record.get("evaluations", art.get("evaluations")),
        "convergence": {
            "best_after_initial_design": _round(initial[-1].get("best_so_far")) if initial else None,
            "best_final": _round(records[-1].get("best_so_far")) if records else None,
            "first_evaluation_reaching_final_best": next(
                (r.get("n_real_evaluations") for r in records
                 if records and r.get("best_so_far") == records[-1].get("best_so_far")), None),
        },
        "records": [_round({k: r.get(k) for k in ("iteration", "phase", "genome", "real_fitness",
                                                  "predicted_mean", "predicted_std", "acquisition_value",
                                                  "best_so_far")}) for r in rows],
    }
    if truncated:
        out["records_note"] = f"{_TRUNCATED}: {len(rows)} of {len(records)} evaluations shown, evenly spaced"
    return out


_KIND_BUILDERS: Dict[str, Callable[[Dict[str, Any], Dict[str, Any]], Dict[str, Any]]] = {
    "simulation": _simulation_context,
    "evolution": _evolution_context,
    "pareto": _pareto_context,
    "sensitivity": _sensitivity_context,
    "active_learning": _active_learning_context,
}


def _serialized_size(obj: Any) -> int:
    return len(json.dumps(obj, default=str, ensure_ascii=False).encode("utf-8"))


def _shrink_lists(obj: Any, factor: float = 0.5, min_len: int = 2) -> Any:
    """Halve every list longer than ``min_len`` (keeping first/last) -- the
    generic fallback when the kind-specific caps still exceed the byte cap."""
    if isinstance(obj, dict):
        if len(obj) > _DICT_KEY_CAP:
            keys = list(obj)[:_DICT_KEY_CAP]
            out = {k: _shrink_lists(obj[k], factor, min_len) for k in keys}
            out["note"] = f"{_TRUNCATED}: {len(keys)} of {len(obj)} keys shown"
            return out
        return {k: _shrink_lists(v, factor, min_len) for k, v in obj.items()}
    if isinstance(obj, list):
        if len(obj) > min_len:
            kept, _ = _sample(obj, max(min_len, int(len(obj) * factor)))
            return [_shrink_lists(v, factor, min_len) for v in kept]
        return [_shrink_lists(v, factor, min_len) for v in obj]
    if isinstance(obj, str) and len(obj) > 2000:
        return obj[:2000] + f" {_TRUNCATED}"
    return obj


def build_context(record: Dict[str, Any], artifacts: Dict[str, Any],
                  byte_cap: int = CONTEXT_BYTE_CAP) -> Dict[str, Any]:
    """Compact, JSON-serialisable view of one run for the model.

    ``artifacts`` maps ``record["artifacts"]`` keys (``evolution_json`` ...)
    to their parsed JSON. Unknown kinds get the record-level summary only.
    The result is guaranteed to serialise to at most ``byte_cap`` bytes;
    anything cut is marked with ``"(truncated)"`` so the model can say so.
    """
    kind = record.get("kind") or "unknown"
    primary_key = next((k for k in JSON_ARTIFACT_KEYS.get(kind, ()) if k in artifacts), None)
    art = artifacts.get(primary_key) if primary_key else {}
    if not isinstance(art, dict):
        art = {}

    ctx: Dict[str, Any] = {
        "run_id": record.get("run_id"),
        "kind": kind,
        "created_at": record.get("created_at"),
        "seed": record.get("seed"),
        "configuration_hash": record.get("configuration_hash"),
        "fitness": _round(record.get("fitness")),
        "runtime_seconds": _round(record.get("runtime_seconds"), 1),
        "notes": record.get("notes") or "",
        "model_version": record.get("model_version"),
        "optimizer_version": record.get("optimizer_version"),
        "git_commit": record.get("git_commit"),
        "configuration": _config_summary(record.get("configuration") or {}),
        "artifacts_available": sorted((record.get("artifacts") or {}).keys()),
    }
    builder = _KIND_BUILDERS.get(kind)
    if builder is not None:
        ctx["results"] = builder(record, art)

    guard = 0
    while _serialized_size(ctx) > byte_cap and guard < 12:
        ctx = _shrink_lists(ctx)
        ctx["truncated"] = f"{_TRUNCATED}: arrays were shortened to fit the {byte_cap}-byte context cap"
        guard += 1
    if _serialized_size(ctx) > byte_cap:  # pathological: drop the results block entirely
        ctx.pop("results", None)
        ctx["truncated"] = f"{_TRUNCATED}: result details omitted to fit the {byte_cap}-byte context cap"
    return ctx


# --------------------------------------------------------------------------- #
# errors (mapped to HTTP by the router)
# --------------------------------------------------------------------------- #
class LLMError(Exception):
    status_code = 502
    detail = "llm_upstream_error"

    def __init__(self, message: str = "", **extra: Any):
        super().__init__(message or self.detail)
        self.message = message or self.detail
        self.extra = extra


class LLMAuthError(LLMError):
    status_code = 401
    detail = "llm_auth_failed"


class LLMPermissionError(LLMError):
    status_code = 403
    detail = "llm_permission_denied"


class LLMRateLimited(LLMError):
    status_code = 429
    detail = "llm_rate_limited"


class LLMRefusal(LLMError):
    status_code = 422
    detail = "llm_refusal"


class LLMBadRequest(LLMError):
    status_code = 400
    detail = "llm_bad_request"


class LLMUpstreamError(LLMError):
    status_code = 502
    detail = "llm_upstream_error"


# --------------------------------------------------------------------------- #
# client + call
# --------------------------------------------------------------------------- #
ClientFactory = Callable[[str], Any]


def anthropic_client_factory(api_key: str) -> Any:
    """A per-request client bound to the *user's* key. Never reads the environment."""
    return anthropic.Anthropic(api_key=api_key, timeout=REQUEST_TIMEOUT_SECONDS, max_retries=1)


@dataclass
class InterpretRequestData:
    run_id: str
    api_key: str = field(repr=False)
    context: Dict[str, Any]
    model: str = DEFAULT_MODEL
    effort: str = DEFAULT_EFFORT
    system_prompt: Optional[str] = None


@dataclass
class InterpretResult:
    narrative_markdown: str
    model: str
    usage: Dict[str, Optional[int]]
    warnings: List[str] = field(default_factory=list)


def _retry_after(exc: anthropic.APIStatusError) -> Optional[float]:
    try:
        value = exc.response.headers.get("retry-after")
        return float(value) if value is not None else None
    except (AttributeError, TypeError, ValueError):
        return None


def _map_sdk_error(exc: Exception) -> LLMError:
    """Most specific first. None of these messages contain the API key."""
    if isinstance(exc, anthropic.AuthenticationError):
        return LLMAuthError("Anthropic rejected the API key (401). Check the key and try again.")
    if isinstance(exc, anthropic.PermissionDeniedError):
        return LLMPermissionError("Anthropic denied access for this key (403), e.g. no access to the model.")
    if isinstance(exc, anthropic.RateLimitError):
        return LLMRateLimited("Anthropic rate limit or spend cap reached (429). Try again later.",
                              retry_after=_retry_after(exc))
    if isinstance(exc, anthropic.BadRequestError):
        return LLMBadRequest(f"Anthropic rejected the request (400): {exc.message}")
    if isinstance(exc, anthropic.APIStatusError):
        return LLMUpstreamError(f"Anthropic returned HTTP {exc.status_code}: {exc.message}")
    if isinstance(exc, anthropic.APITimeoutError):
        return LLMUpstreamError("The request to Anthropic timed out.")
    if isinstance(exc, anthropic.APIConnectionError):
        return LLMUpstreamError("Could not connect to Anthropic.")
    return LLMUpstreamError(f"Unexpected error talking to Anthropic: {type(exc).__name__}")


def _usage_dict(usage: Any) -> Dict[str, Optional[int]]:
    def _get(name: str) -> Optional[int]:
        value = getattr(usage, name, None)
        return int(value) if isinstance(value, (int, float)) else None

    return {
        "input_tokens": _get("input_tokens") or 0,
        "output_tokens": _get("output_tokens") or 0,
        "cache_read_input_tokens": _get("cache_read_input_tokens"),
    }


def estimate_cost_usd(model: str, usage: Dict[str, Optional[int]]) -> Optional[float]:
    price = MODELS.get(model)
    if price is None:
        return None
    inp = usage.get("input_tokens") or 0
    out = usage.get("output_tokens") or 0
    # The API reports cache-read tokens separately from input_tokens and bills
    # them at 10 % of the input price, so they add on top here.
    cached = usage.get("cache_read_input_tokens") or 0
    cost = (inp * price["input_usd_per_mtok"] + cached * price["input_usd_per_mtok"] * 0.1
            + out * price["output_usd_per_mtok"]) / 1_000_000
    return round(cost, 6)


def interpret(data: InterpretRequestData, client_factory: ClientFactory = anthropic_client_factory
              ) -> InterpretResult:
    """One non-streaming ``messages.create`` call; raises ``LLMError`` subclasses."""
    if data.model not in MODELS:
        raise LLMBadRequest(f"Unknown model {data.model!r}")
    if data.effort not in EFFORTS:
        raise LLMBadRequest(f"Unknown effort {data.effort!r}")

    system_prompt = data.system_prompt or build_system_prompt()
    user_content = (
        "Interpret the following recorded experiment. Everything you may rely on is in this JSON; "
        "fields marked \"(truncated)\" were shortened to fit the context.\n\n```json\n"
        + json.dumps(data.context, indent=1, default=str, ensure_ascii=False)
        + "\n```"
    )

    client = client_factory(data.api_key)
    try:
        response = client.messages.create(
            model=data.model,
            max_tokens=MAX_OUTPUT_TOKENS,
            system=system_prompt,
            messages=[{"role": "user", "content": user_content}],
            output_config={"effort": data.effort},
        )
    except Exception as exc:  # noqa: BLE001 - every SDK error is mapped, nothing else is expected
        raise _map_sdk_error(exc) from None

    warnings: List[str] = []
    stop_reason = getattr(response, "stop_reason", None)
    if stop_reason == "refusal":
        details = getattr(response, "stop_details", None)
        category = getattr(details, "category", None) or "unspecified"
        raise LLMRefusal(f"The model declined to answer (refusal, category: {category}).", category=category)
    if stop_reason == "max_tokens":
        warnings.append(f"The narrative was cut off at {MAX_OUTPUT_TOKENS} output tokens.")
    if "truncated" in data.context:
        warnings.append("Parts of the run data were truncated to fit the context cap; the narrative may omit them.")

    text = "".join(getattr(block, "text", "") for block in (getattr(response, "content", None) or [])
                   if getattr(block, "type", None) == "text").strip()
    if not text:
        raise LLMUpstreamError("Anthropic returned no text content.")

    return InterpretResult(narrative_markdown=text, model=str(getattr(response, "model", data.model)),
                           usage=_usage_dict(getattr(response, "usage", None)), warnings=warnings)


# --------------------------------------------------------------------------- #
# Layer 2 -- protocol-designing agent (docs/ROADMAP.md "LLM agentic layer")
# --------------------------------------------------------------------------- #
# Hard safety boundary: this module never runs a simulation. It returns a
# *proposed* ModelConfig (stress_level/maintenance_rate/repair_rate, optionally
# scheduled over up to MAX_PHASES phases) that MUST pass the exact same
# ModelConfig.validate() every other config -- GA-mutated, NSGA-II-mutated, or
# human-typed-in-the-GUI -- already passes, enforced in `propose_protocol`
# below before the caller ever sees it. The user still has to load the
# proposal into the Simulate form and press "Run simulation" themselves; there
# is no path from this module to an executed simulation that skips either the
# human review step or ModelConfig.validate().
PROPOSE_MAX_TOKENS = 1024

PROPOSE_TOOL = {
    "name": "propose_protocol",
    "description": (
        "Propose one candidate stress_level/maintenance_rate/repair_rate protocol "
        "(each optionally piecewise-constant over up to 8 equal phases) for the "
        "telomere-population model to simulate. This call only records a proposal; "
        "it does not run anything."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "rationale": {
                "type": "string",
                "description": (
                    "1-3 sentences: what this protocol tries and the model-mechanistic reason it "
                    "might do better than a constant response, per the language policy below. Not a "
                    "claim that it does better -- that is only known once it is actually simulated."
                ),
            },
            "phases": {
                "type": "integer", "minimum": 1, "maximum": 8,
                "description": "Number of equal phases. 1 = a plain constant (unscheduled) proposal.",
            },
            "stress_level": {
                "type": "array", "items": {"type": "number", "minimum": 0.0, "maximum": 1.0},
                "description": "Exactly `phases` values, one per phase, each in [0, 1].",
            },
            "maintenance_rate": {
                "type": "array", "items": {"type": "number", "minimum": 0.0, "maximum": 1.0},
                "description": "Exactly `phases` values, one per phase, each in [0, 1].",
            },
            "repair_rate": {
                "type": "array", "items": {"type": "number", "minimum": 0.0, "maximum": 1.0},
                "description": "Exactly `phases` values, one per phase, each in [0, 1].",
            },
        },
        "required": ["rationale", "phases", "stress_level", "maintenance_rate", "repair_rate"],
    },
}


def build_propose_system_prompt(policy: Optional[str] = None) -> str:
    policy = policy if policy is not None else load_language_policy()
    return f"""You are the protocol-proposing agent of Telomere Evolution Lab, a computational
AI-for-Science demonstration built around a lightweight, stochastic
telomere-population model. Per cycle, every dividing cell's telomeres change by

    L -= shortening_rate                                  (end-replication loss)
    L -= stress_level * stress_sensitivity * (1 - repair_rate)   (stress-induced loss)
    L += maintenance_rate * maintenance_max_gain * w(L)    (telomerase-like gain)

`repair_rate` only offsets STRESS-induced loss (it multiplies stress_level in
that term); `maintenance_rate` is an independent gain unrelated to the current
stress level. A cell becomes senescent once its shortest telomere drops below
senescence_threshold.

What is already known in this exact model (cite these, do not contradict them
without a mechanistic reason grounded in the equation above):
- Experiment E (docs/EXPERIMENT_PROTOCOL.md Sec 10): scheduling
  maintenance_rate/repair_rate while stress_level is held CONSTANT buys
  essentially nothing over the best constant response -- timing alone does
  not help when the environment does not vary.
- Experiment G (docs/EXPERIMENT_PROTOCOL.md Sec 12): when stress_level itself
  varies (alternates between a high and low phase), a maintenance/repair
  schedule SYNCED to that rhythm clearly beats a constant response to the
  same rhythm, because repair_rate's marginal value is highest exactly when
  stress_level is currently high (it multiplies that term) -- concentrating
  repair into high-stress phases and dropping it in low-stress phases is
  cheaper for the same protection, since the fitness objective's cost term is
  charged on the time-averaged dose.

You will receive the user's own free-text goal and a base configuration (every
field except stress_level/maintenance_rate/repair_rate/schedule is fixed and
not yours to change). Call the propose_protocol tool exactly once with a
protocol you believe is worth actually simulating. You may propose a constant
(phases=1) response if that is genuinely your best answer -- do not manufacture
a schedule where a constant one is more appropriate.

Language policy (quoted verbatim from docs/SCIENTIFIC_SCOPE.md -- your
`rationale` must follow it literally, including its preferred phrasings):

{policy}

You are not running or claiming any biological outcome. Your rationale must
describe a hypothesis about this model's own equations, phrased so a
scientifically literate reader understands it is a proposal to be tested by
simulation, not a result."""


@dataclass
class ProposeRequestData:
    api_key: str = field(repr=False)
    goal: str
    base_config: Dict[str, Any]
    model: str = DEFAULT_MODEL
    effort: str = DEFAULT_EFFORT
    system_prompt: Optional[str] = None


@dataclass
class ProtocolProposal:
    rationale: str
    config: Dict[str, Any]  # a full ModelConfig dict, already validated


@dataclass
class ProposeResult:
    proposal: ProtocolProposal
    model: str
    usage: Dict[str, Optional[int]]
    warnings: List[str] = field(default_factory=list)


class ProposalInvalid(LLMError):
    """The model's tool call did not produce a config that passes validate()."""
    status_code = 422
    detail = "llm_proposal_invalid"


def _build_proposed_config(base_config: Dict[str, Any], tool_input: Dict[str, Any]) -> Dict[str, Any]:
    """Merge a validated tool_use ``input`` onto ``base_config``; raises
    ``ProposalInvalid`` (never a bare ``KeyError``/``TypeError``) for any
    malformed shape -- the model can, in principle, return anything."""
    from telomere_lab.schemas import MAX_PHASES  # local import: keeps this module import-light for tests

    try:
        phases = int(tool_input["phases"])
        rationale = str(tool_input["rationale"]).strip()
        series = {name: [float(v) for v in tool_input[name]]
                  for name in ("stress_level", "maintenance_rate", "repair_rate")}
    except (KeyError, TypeError, ValueError) as exc:
        raise ProposalInvalid(f"Malformed tool call from the model: {exc}") from None

    if not (1 <= phases <= MAX_PHASES):
        raise ProposalInvalid(f"phases={phases} is out of range [1, {MAX_PHASES}].")
    for name, values in series.items():
        if len(values) != phases:
            raise ProposalInvalid(f"{name} has {len(values)} values, expected phases={phases}.")

    config = dict(base_config)
    if phases == 1:
        config.pop("schedule", None)
        for name, values in series.items():
            config[name] = values[0]
    else:
        for name, values in series.items():
            config[name] = values[0]
        config["schedule"] = {"phases": phases, "values": {name: values for name, values in series.items()}}
    return {"rationale": rationale, "config": config}


def propose_protocol(data: ProposeRequestData, client_factory: ClientFactory = anthropic_client_factory
                     ) -> ProposeResult:
    """One forced-tool-call ``messages.create``; raises ``LLMError`` subclasses.

    The returned config has already passed ``ModelConfig.validate()`` --
    callers never see an unvalidated proposal. Import of ``ModelConfig`` is
    local so this module (and its tests) do not need the full schema stack
    just to build a system prompt.
    """
    from telomere_lab.schemas import ConfigError, ModelConfig

    if data.model not in MODELS:
        raise LLMBadRequest(f"Unknown model {data.model!r}")
    if data.effort not in EFFORTS:
        raise LLMBadRequest(f"Unknown effort {data.effort!r}")

    system_prompt = data.system_prompt or build_propose_system_prompt()
    user_content = (
        f"Goal: {data.goal.strip()}\n\n"
        "Base configuration (every field except stress_level/maintenance_rate/repair_rate/schedule "
        "is fixed):\n```json\n" + json.dumps(data.base_config, indent=1, default=str, ensure_ascii=False)
        + "\n```"
    )

    client = client_factory(data.api_key)
    try:
        response = client.messages.create(
            model=data.model,
            max_tokens=PROPOSE_MAX_TOKENS,
            system=system_prompt,
            messages=[{"role": "user", "content": user_content}],
            tools=[PROPOSE_TOOL],
            tool_choice={"type": "tool", "name": "propose_protocol"},
            output_config={"effort": data.effort},
        )
    except Exception as exc:  # noqa: BLE001 - every SDK error is mapped, nothing else is expected
        raise _map_sdk_error(exc) from None

    warnings: List[str] = []
    stop_reason = getattr(response, "stop_reason", None)
    if stop_reason == "refusal":
        details = getattr(response, "stop_details", None)
        category = getattr(details, "category", None) or "unspecified"
        raise LLMRefusal(f"The model declined to propose a protocol (refusal, category: {category}).",
                         category=category)
    if stop_reason == "max_tokens":
        warnings.append(f"The proposal may be incomplete: cut off at {PROPOSE_MAX_TOKENS} output tokens.")

    tool_use = next((b for b in (getattr(response, "content", None) or [])
                     if getattr(b, "type", None) == "tool_use" and getattr(b, "name", None) == "propose_protocol"),
                    None)
    if tool_use is None:
        raise LLMUpstreamError("Anthropic did not return the expected propose_protocol tool call.")

    built = _build_proposed_config(data.base_config, dict(getattr(tool_use, "input", {}) or {}))
    try:
        ModelConfig.from_dict(built["config"]).validate()
    except ConfigError as exc:
        raise ProposalInvalid(f"The proposed configuration failed validation: {exc}") from None

    return ProposeResult(
        proposal=ProtocolProposal(rationale=built["rationale"], config=built["config"]),
        model=str(getattr(response, "model", data.model)),
        usage=_usage_dict(getattr(response, "usage", None)),
        warnings=warnings,
    )


def validate_key(api_key: str, model: str = DEFAULT_MODEL,
                 client_factory: ClientFactory = anthropic_client_factory) -> Tuple[bool, str]:
    """Cheap key check via ``models.retrieve`` (no tokens billed).

    Returns ``(True, detail)`` on success and ``(False, detail)`` for an
    invalid key; every other failure is raised as an ``LLMError`` so the
    router maps it the same way as an interpretation."""
    client = client_factory(api_key)
    try:
        info = client.models.retrieve(model)
    except anthropic.AuthenticationError:
        return False, "Anthropic rejected the API key (401)."
    except Exception as exc:  # noqa: BLE001
        raise _map_sdk_error(exc) from None
    name = getattr(info, "display_name", None) or getattr(info, "id", model)
    return True, f"Key accepted; {name} is available."


# --------------------------------------------------------------------------- #
# in-memory per-user rate limit (single process, like backend/jobs.py)
# --------------------------------------------------------------------------- #
class RateLimiter:
    """Sliding-window counter per user id. Process-local: it neither survives
    a restart nor spans replicas, which matches the one-replica deployment
    (docs/API.md) and is only a courtesy cap on the *user's own* spend."""

    def __init__(self, max_calls: int = RATE_LIMIT_CALLS, window_seconds: float = RATE_LIMIT_WINDOW_SECONDS):
        self.max_calls = max_calls
        self.window = window_seconds
        self._calls: Dict[int, Deque[float]] = {}
        self._lock = threading.Lock()

    def check(self, user_id: int, now: Optional[float] = None) -> None:
        """Record one call or raise ``LLMRateLimited`` with ``retry_after``."""
        now = time.monotonic() if now is None else now
        with self._lock:
            q = self._calls.setdefault(user_id, deque())
            while q and now - q[0] >= self.window:
                q.popleft()
            if len(q) >= self.max_calls:
                raise LLMRateLimited(
                    f"At most {self.max_calls} interpretations per {int(self.window // 60)} minutes per user.",
                    retry_after=round(self.window - (now - q[0]), 1),
                )
            q.append(now)

    def reset(self) -> None:
        with self._lock:
            self._calls.clear()


interpret_rate_limiter = RateLimiter()
#: Separate budget from interpret_rate_limiter -- a courtesy cap on the
#: user's own spend for Layer 2 specifically (docs/ROADMAP.md guardrail:
#: "rate-limit/cap how many proposals an agentic session can queue per run").
propose_rate_limiter = RateLimiter()
