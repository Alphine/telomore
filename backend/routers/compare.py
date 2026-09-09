"""POST /api/compare -- run a few named scenarios side by side (Phase 4, the
React port of ``app/pages/03_Compare.py``).

Synchronous like ``/api/simulate``: a scenario is one simulation (sub-second)
and the body is capped at six of them. Wraps ``runner.compare_scenarios``
(a name -> ``ModelConfig`` mapping, scored with the default
``FitnessWeights``) and ``runner.deltas`` (headline deltas of each scenario
against the *first* one, which is therefore the baseline). The optional
``seed`` mirrors the Streamlit page's "Force identical simulator seed"
checkbox: every scenario is re-seeded with it so differences are
attributable to parameters (common random numbers). Nothing is written to
the experiment ledger -- the Streamlit Compare page never recorded either.
"""

from __future__ import annotations

import math
from typing import Dict, Optional

from fastapi import APIRouter, Depends, HTTPException, status

from telomere_lab import db as _db
from telomere_lab.experiments.runner import compare_scenarios, deltas
from telomere_lab.schemas import ConfigError, ModelConfig

from .. import schemas as api_schemas
from ..auth import get_current_user

router = APIRouter(tags=["compare"])

MAX_SCENARIOS = 6


def _finite(values: Dict[str, float]) -> Dict[str, Optional[float]]:
    """runner.deltas yields NaN for an undefined percentage; JSON has no NaN."""
    return {k: (None if (v is None or not math.isfinite(v)) else float(v)) for k, v in values.items()}


@router.post("/compare", response_model=api_schemas.CompareResponse)
def compare(body: api_schemas.CompareRequest, user: _db.User = Depends(get_current_user)
            ) -> api_schemas.CompareResponse:
    del user  # auth gate only -- nothing is recorded per user here
    if len(body.scenarios) > MAX_SCENARIOS:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"At most {MAX_SCENARIOS} scenarios per comparison.")

    scenarios: Dict[str, ModelConfig] = {}
    for sc in body.scenarios:
        if sc.name in scenarios:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Duplicate scenario name: {sc.name!r}")
        try:
            cfg = ModelConfig.from_dict(sc.config)
            if body.seed is not None:
                cfg = cfg.replace(seed=int(body.seed))
            scenarios[sc.name] = cfg.validate()
        except ConfigError as exc:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, f"{sc.name}: {exc}")
        except (TypeError, ValueError) as exc:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, f"{sc.name}: {exc}")

    comps = compare_scenarios(scenarios)
    baseline = comps[0]
    out = []
    for i, c in enumerate(comps):
        out.append(api_schemas.CompareScenarioResult(
            name=c.name,
            result=c.result.to_json_dict(),
            fitness=c.breakdown.total if c.breakdown.valid else None,
            breakdown=c.breakdown.to_dict(),
            deltas=None if i == 0 else _finite(deltas(baseline, c)),
        ))
    return api_schemas.CompareResponse(baseline=baseline.name, scenarios=out)
