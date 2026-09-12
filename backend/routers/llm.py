"""POST /api/llm/interpret and /api/llm/validate-key -- LLM Layer 1, the
read-only results interpreter (``backend/llm.py``, docs/ROADMAP.md).

The run is loaded exactly like ``GET /api/experiments/{run_id}`` does
(shared ledger: any authenticated, verified user may read any run; the
record + the JSON artifacts under ``experiments/runs/<run_id>/``, resolved
with the same path guards). The user's API key is relayed to Anthropic for
this one request and is never persisted or logged -- see ``backend/llm.py``.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict

from fastapi import APIRouter, Depends, HTTPException, Response, status

from telomere_lab import db as _db
from telomere_lab.experiments.registry import ExperimentRegistry

from .. import llm as _llm
from .. import schemas as api_schemas
from ..auth import get_current_user
from .experiments import _run_dir_or_404, _safe_segment

router = APIRouter(prefix="/llm", tags=["llm"])

#: Largest artifact file the interpreter will parse (bytes) -- the context is
#: capped far below this anyway, and a hostile/huge file must not be read whole.
_MAX_ARTIFACT_BYTES = 25_000_000


def load_run_for_interpretation(run_id: str) -> tuple[Dict[str, Any], Dict[str, Any]]:
    """The ledger record and its parsed JSON artifacts (``{artifact_key: dict}``).

    Only the kind's known JSON artifacts (``backend.llm.JSON_ARTIFACT_KEYS``)
    are read, and only when the recorded path resolves to a file directly
    inside the run directory -- the same rule as the download route.
    """
    _safe_segment(run_id, "run id")
    registry = ExperimentRegistry()
    run_dir = _run_dir_or_404(registry, run_id)
    try:
        record = registry.load(run_id)
    except (OSError, ValueError):
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"No such run: {run_id!r}")

    artifacts: Dict[str, Any] = {}
    wanted = _llm.JSON_ARTIFACT_KEYS.get(record.get("kind") or "", ())
    for key in wanted:
        recorded = (record.get("artifacts") or {}).get(key)
        if not recorded:
            continue
        # Trust only the file name: the ledger may have been written on
        # another machine (absolute paths in record.json), so re-anchor it.
        path = (run_dir / Path(str(recorded)).name).resolve()
        if path.parent != run_dir or not path.is_file() or path.stat().st_size > _MAX_ARTIFACT_BYTES:
            continue
        try:
            artifacts[key] = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
    return record, artifacts


def _raise_http(exc: _llm.LLMError) -> None:
    headers = {}
    retry_after = exc.extra.get("retry_after")
    if retry_after is not None:
        headers["Retry-After"] = str(int(max(1, round(retry_after))))
    detail: Dict[str, Any] = {"code": exc.detail, "message": exc.message}
    category = exc.extra.get("category")
    if category:
        detail["category"] = category
    raise HTTPException(exc.status_code, detail=detail, headers=headers or None)


@router.post("/interpret", response_model=api_schemas.LLMInterpretResponse)
def interpret_run(body: api_schemas.LLMInterpretRequest, response: Response,
                  user: _db.User = Depends(get_current_user)) -> api_schemas.LLMInterpretResponse:
    try:
        _llm.interpret_rate_limiter.check(user.id)
    except _llm.LLMRateLimited as exc:
        _raise_http(exc)

    record, artifacts = load_run_for_interpretation(body.run_id)
    context = _llm.build_context(record, artifacts)
    model = body.model or _llm.DEFAULT_MODEL
    data = _llm.InterpretRequestData(
        run_id=body.run_id, api_key=body.api_key.get_secret_value(), context=context,
        model=model, effort=body.effort or _llm.DEFAULT_EFFORT,
    )
    try:
        result = _llm.interpret(data)
    except _llm.LLMError as exc:
        _raise_http(exc)
    finally:
        del data  # drop the only other reference to the key

    response.headers["Cache-Control"] = "no-store"
    return api_schemas.LLMInterpretResponse(
        run_id=body.run_id,
        model=result.model,
        narrative_markdown=result.narrative_markdown,
        usage=api_schemas.LLMUsage(**result.usage),
        estimated_cost_usd=_llm.estimate_cost_usd(model, result.usage),
        warnings=result.warnings,
    )


@router.post("/propose-protocol", response_model=api_schemas.LLMProposeResponse)
def propose_protocol(body: api_schemas.LLMProposeRequest, response: Response,
                     user: _db.User = Depends(get_current_user)) -> api_schemas.LLMProposeResponse:
    """LLM Layer 2: propose a protocol, never run one.

    The response's ``config`` has already passed ``ModelConfig.validate()``
    (``backend.llm.propose_protocol`` raises ``ProposalInvalid`` -> 422
    otherwise) -- this route cannot return a proposal the frontend could load
    and run without it being exactly as valid as any human-typed config. The
    caller must still load it into the Simulate form and press "Run
    simulation" themselves; nothing here executes a simulation.
    """
    try:
        _llm.propose_rate_limiter.check(user.id)
    except _llm.LLMRateLimited as exc:
        _raise_http(exc)

    model = body.model or _llm.DEFAULT_MODEL
    data = _llm.ProposeRequestData(
        api_key=body.api_key.get_secret_value(), goal=body.goal, base_config=body.base_config.to_plain(),
        model=model, effort=body.effort or _llm.DEFAULT_EFFORT,
    )
    try:
        result = _llm.propose_protocol(data)
    except _llm.LLMError as exc:
        _raise_http(exc)
    finally:
        del data  # drop the only other reference to the key

    response.headers["Cache-Control"] = "no-store"
    return api_schemas.LLMProposeResponse(
        rationale=result.proposal.rationale,
        config=result.proposal.config,
        model=result.model,
        usage=api_schemas.LLMUsage(**result.usage),
        estimated_cost_usd=_llm.estimate_cost_usd(model, result.usage),
        warnings=result.warnings,
    )


@router.post("/validate-key", response_model=api_schemas.LLMValidateKeyResponse)
def validate_key(body: api_schemas.LLMValidateKeyRequest, response: Response,
                 user: _db.User = Depends(get_current_user)) -> api_schemas.LLMValidateKeyResponse:
    del user  # auth gate only
    try:
        valid, detail = _llm.validate_key(body.api_key.get_secret_value())
    except _llm.LLMError as exc:
        _raise_http(exc)
    response.headers["Cache-Control"] = "no-store"
    return api_schemas.LLMValidateKeyResponse(valid=valid, detail=detail)
