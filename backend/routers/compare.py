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

ROADMAP.md candidate feature #3 (multi-chip comparison) extends a scenario to
optionally be specified as ``{name, chip: {...ChipConditions}}`` instead of
``{name, config: {...ModelConfig}}``: exactly one of the two per scenario.
A ``chip`` scenario is mapped through the existing, unmodified
``chip_to_model_params`` (the same core function ``/api/meta/chip-to-params``
and ``/api/meta/chip-presets`` use) and merged onto ``body.base_config`` with
the same ``{...config, ...derived}`` override semantics the ``ChipMapper``
component already uses client-side on the Simulate page -- so `/api/compare`
stays the single comparison engine; nothing new is added to
``runner.compare_scenarios`` itself.
"""

from __future__ import annotations

import math
from typing import Dict, Optional

from fastapi import APIRouter, Depends, HTTPException, status

from telomere_lab import db as _db
from telomere_lab.adapters.chip import ChipConditions, chip_to_model_params
from telomere_lab.experiments.runner import compare_scenarios, deltas
from telomere_lab.schemas import ConfigError, ModelConfig

from .. import schemas as api_schemas
from .. import limits
from ..auth import get_current_user

router = APIRouter(tags=["compare"])

MAX_SCENARIOS = 6


def _finite(values: Dict[str, float]) -> Dict[str, Optional[float]]:
    """runner.deltas yields NaN for an undefined percentage; JSON has no NaN."""
    return {k: (None if (v is None or not math.isfinite(v)) else float(v)) for k, v in values.items()}


def _scenario_config(sc: api_schemas.CompareScenario, base_config: dict) -> dict:
    """The plain ``ModelConfig`` dict for one scenario, before seeding/validation.

    Exactly one of ``config`` / ``chip`` must be set (400 otherwise, both-or-
    neither). A ``chip`` scenario merges the derived ``{stress_level,
    repair_rate, cycles}`` onto ``base_config`` -- the request's shared base,
    not the scenario's own (a chip scenario never carries a full config).
    """
    has_config, has_chip = sc.config is not None, sc.chip is not None
    if has_config == has_chip:  # both or neither
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"{sc.name}: a scenario must specify exactly one of `config` or `chip`.",
        )
    if has_chip:
        derived = chip_to_model_params(ChipConditions(**sc.chip.model_dump()))
        return {**base_config, **derived}
    return sc.config.to_plain()


@router.post("/compare", response_model=api_schemas.CompareResponse)
def compare(body: api_schemas.CompareRequest, user: _db.User = Depends(get_current_user)
            ) -> api_schemas.CompareResponse:
    del user  # auth gate only -- nothing is recorded per user here
    if len(body.scenarios) > MAX_SCENARIOS:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"At most {MAX_SCENARIOS} scenarios per comparison.")

    base_config = body.base_config.to_plain()
    scenarios: Dict[str, ModelConfig] = {}
    for sc in body.scenarios:
        if sc.name in scenarios:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Duplicate scenario name: {sc.name!r}")
        try:
            cfg = ModelConfig.from_dict(_scenario_config(sc, base_config))
            if body.seed is not None:
                cfg = cfg.replace(seed=int(body.seed))
            scenarios[sc.name] = cfg.validate()
        except ConfigError as exc:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, f"{sc.name}: {exc}")
        except (TypeError, ValueError) as exc:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, f"{sc.name}: {exc}")

    limits.check_compare(scenarios.values())

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
