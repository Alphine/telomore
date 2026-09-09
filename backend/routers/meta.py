"""GET /api/meta/* -- read-only metadata the React UI renders its forms from.

``telomere_lab.schemas`` is the single source of truth for parameter bounds,
evolvable genes and every default (``PARAMETER_BOUNDS``, ``EVOLVABLE_PARAMETERS``,
``ModelConfig()``, ``FitnessWeights()``, ``EvolutionConfig()``). Exposing them
here means the frontend never hardcodes a bound or default in TypeScript --
it mirrors these structures verbatim.

``/bounds`` and ``/version`` are public (static, non-sensitive metadata that a
form needs before the user has done anything); ``/chip-to-params`` is
protected like every other compute-ish route.
"""

from __future__ import annotations

from typing import Any, Dict

import numpy as np
from fastapi import APIRouter, Depends

from telomere_lab import db as _db
from telomere_lab.adapters.chip import ChipConditions, chip_to_model_params
from telomere_lab.config import CONFIG_DIR, load_model_config
from telomere_lab.experiments.registry import environment_metadata
from telomere_lab.schemas import (
    EVOLVABLE_PARAMETERS,
    PARAMETER_BOUNDS,
    EvolutionConfig,
    FitnessWeights,
    ModelConfig,
)

from .. import schemas as api_schemas
from ..auth import get_current_user

router = APIRouter(prefix="/meta", tags=["meta"])


def _plain(value: Any) -> Any:
    """Recursively turn numpy scalars/arrays into JSON-native Python values."""
    if isinstance(value, dict):
        return {str(k): _plain(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_plain(v) for v in value]
    if isinstance(value, np.ndarray):
        return value.tolist()
    if isinstance(value, np.bool_):
        return bool(value)
    if isinstance(value, np.integer):
        return int(value)
    if isinstance(value, np.floating):
        return float(value)
    return value


def _demo_config() -> ModelConfig:
    # Same fallback as app/ui/components.py::demo_config.
    path = CONFIG_DIR / "demo.yaml"
    return load_model_config(path) if path.exists() else ModelConfig()


@router.get("/bounds", response_model=api_schemas.BoundsResponse)
def bounds() -> api_schemas.BoundsResponse:
    # PARAMETER_BOUNDS values are (min, max, unit, label, description) tuples.
    bounds_dict: Dict[str, api_schemas.ParameterBound] = {
        name: api_schemas.ParameterBound(min=float(lo), max=float(hi), unit=unit, label=label,
                                         description=description)
        for name, (lo, hi, unit, label, description) in PARAMETER_BOUNDS.items()
    }
    return api_schemas.BoundsResponse(
        bounds=bounds_dict,
        evolvable=list(EVOLVABLE_PARAMETERS),
        defaults=_plain(ModelConfig().to_dict()),
        demo=_plain(_demo_config().to_dict()),
        fitness_weights_default=_plain(FitnessWeights().to_dict()),
        evolution_default=_plain(EvolutionConfig().to_dict()),
    )


@router.get("/version", response_model=api_schemas.VersionResponse)
def version() -> api_schemas.VersionResponse:
    env = environment_metadata()
    return api_schemas.VersionResponse(
        package=env["package_version"],
        model=env["model_version"],
        optimizer=env["optimizer_version"],
        python=env["python_version"],
        numpy=env["numpy_version"],
        git_commit=env["git_commit"],
    )


@router.post("/chip-to-params", response_model=api_schemas.ChipParamsResponse)
def chip_to_params(body: api_schemas.ChipConditionsRequest,
                   user: _db.User = Depends(get_current_user)) -> api_schemas.ChipParamsResponse:
    del user  # auth gate only
    derived = chip_to_model_params(ChipConditions(**body.model_dump()))
    return api_schemas.ChipParamsResponse(**_plain(derived))
