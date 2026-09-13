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
from telomere_lab.adapters.chip import ChipConditions, chip_to_model_params, list_chip_presets
from telomere_lab.config import CONFIG_DIR, load_model_config
from telomere_lab.experiments.registry import environment_metadata
from telomere_lab.schemas import (
    ENVIRONMENT_OVERRIDABLE_PARAMETERS,
    EVOLVABLE_PARAMETERS,
    MAX_PHASES,
    OBJECTIVES,
    PARAMETER_BOUNDS,
    SCHEDULABLE_PARAMETERS,
    SUBCLONE_OVERRIDABLE_PARAMETERS,
    EvolutionConfig,
    FitnessWeights,
    ModelConfig,
)

from .. import llm as _llm
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


#: Named example protocols exposed as ``presets`` (name -> configs/<file>.yaml).
#: Only files that exist are listed, so a missing YAML degrades to no preset.
PRESET_FILES = {
    "demo_fasting": "demo_fasting.yaml",
    "demo_fasting_evolved": "demo_fasting_evolved.yaml",
}


def _presets() -> Dict[str, Dict[str, Any]]:
    out: Dict[str, Dict[str, Any]] = {}
    for name, filename in PRESET_FILES.items():
        path = CONFIG_DIR / filename
        if path.exists():
            out[name] = _plain(load_model_config(path).to_dict())
    return out


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
        # OBJECTIVES values are (direction, description) tuples (Pareto page multiselect).
        objectives={name: api_schemas.ObjectiveInfo(direction=direction, description=description)
                    for name, (direction, description) in OBJECTIVES.items()},
        schedulable=list(SCHEDULABLE_PARAMETERS),
        max_phases=MAX_PHASES,
        presets=_presets(),
        subclone_overridable=list(SUBCLONE_OVERRIDABLE_PARAMETERS),
        environment_overridable=list(ENVIRONMENT_OVERRIDABLE_PARAMETERS),
    )


@router.get("/llm", response_model=api_schemas.LLMMetaResponse)
def llm_meta() -> api_schemas.LLMMetaResponse:
    """Providers / models / list prices / efforts of the results interpreter
    (backend/llm.py is the single source; the React InterpretPanel renders
    its selects from this). Public: static, non-sensitive."""
    return api_schemas.LLMMetaResponse(
        providers=list(_llm.PROVIDERS),
        models=[api_schemas.LLMModelInfo(id=model_id, label=info["label"],
                                         input_usd_per_mtok=info["input_usd_per_mtok"],
                                         output_usd_per_mtok=info["output_usd_per_mtok"])
                for model_id, info in _llm.MODELS.items()],
        default_model=_llm.DEFAULT_MODEL,
        efforts=list(_llm.EFFORTS),
        default_effort=_llm.DEFAULT_EFFORT,
        rate_limit={"calls": _llm.RATE_LIMIT_CALLS, "window_seconds": _llm.RATE_LIMIT_WINDOW_SECONDS},
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


@router.get("/chip-presets", response_model=api_schemas.ChipPresetsResponse)
def chip_presets() -> api_schemas.ChipPresetsResponse:
    """Named, illustrative organ-chip condition profiles (ROADMAP.md candidate
    feature #3: multi-chip comparison) plus their derived model parameters, so
    the Compare page can show stress/repair/cycles per preset without one
    ``/chip-to-params`` round trip each. Public, like ``/bounds``: static,
    non-sensitive metadata. Kept as its own route rather than folded into
    ``/bounds`` -- the presets are compare-specific and would otherwise
    inflate a response every page loads on every visit."""
    out = {}
    for name, entry in list_chip_presets().items():
        derived = chip_to_model_params(ChipConditions(**entry["conditions"]))
        out[name] = api_schemas.ChipPresetInfo(
            conditions=api_schemas.ChipConditionsRequest(**entry["conditions"]),
            label=entry["label"],
            description=entry["description"],
            derived=api_schemas.ChipParamsResponse(**_plain(derived)),
        )
    return api_schemas.ChipPresetsResponse(presets=out)
