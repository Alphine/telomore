"""Pydantic request/response models -- the API's own contract layer.

Deliberately separate from ``telomere_lab.schemas`` (the dataclasses used by
the simulation/optimization engines): those stay engine-internal and
dependency-light, these are the wire format. Routers convert between the two
at the boundary (``telomere_lab.schemas.ModelConfig.from_dict(...)`` etc.).

Config blocks (``model``, ``evolution``, ``multiobjective``, ``sensitivity``,
``active_learning``) are accepted as free-form dicts rather than being
re-typed field-by-field here: ``telomere_lab.schemas`` is the single source
of truth for field names/bounds (``PARAMETER_BOUNDS``, ``EVOLVABLE_PARAMETERS``),
and each dataclass's own ``.from_dict().validate()` already does full
validation, raising ``ConfigError`` (mapped to HTTP 400 by the routers).
Re-declaring every field here would just be a second copy of that contract
to keep in sync.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


# --------------------------------------------------------------------------- #
# auth
# --------------------------------------------------------------------------- #
class RegisterRequest(BaseModel):
    username: str = Field(min_length=1)
    email: str = Field(min_length=3)
    password: str = Field(min_length=1)


class RegisterResponse(BaseModel):
    message: str
    dev_verification_link: Optional[str] = None


class VerifyResponse(BaseModel):
    message: str
    verified: bool


class LoginRequest(BaseModel):
    username: str
    password: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"


class ForgotPasswordRequest(BaseModel):
    email: str = Field(min_length=3)


class ForgotPasswordResponse(BaseModel):
    message: str
    dev_reset_link: Optional[str] = None


class ResetPasswordRequest(BaseModel):
    token: str
    new_password: str = Field(min_length=1)


class MessageResponse(BaseModel):
    message: str


class UserResponse(BaseModel):
    id: int
    username: str
    email: str
    is_verified: bool


# --------------------------------------------------------------------------- #
# simulate
# --------------------------------------------------------------------------- #
class SimulateRequest(BaseModel):
    config: Dict[str, Any] = Field(default_factory=dict)


class SimulateResponse(BaseModel):
    run: Dict[str, Any]


# --------------------------------------------------------------------------- #
# long-running jobs (evolve / pareto / sensitivity / active-learning / benchmark)
# --------------------------------------------------------------------------- #
class EvolveRequest(BaseModel):
    model: Dict[str, Any] = Field(default_factory=dict)
    evolution: Dict[str, Any] = Field(default_factory=dict)
    notes: str = ""


class ParetoRequest(BaseModel):
    model: Dict[str, Any] = Field(default_factory=dict)
    multiobjective: Dict[str, Any] = Field(default_factory=dict)
    notes: str = ""


class SensitivityRequest(BaseModel):
    model: Dict[str, Any] = Field(default_factory=dict)
    sensitivity: Dict[str, Any] = Field(default_factory=dict)
    notes: str = ""


class ActiveLearningRequest(BaseModel):
    model: Dict[str, Any] = Field(default_factory=dict)
    active_learning: Dict[str, Any] = Field(default_factory=dict)
    notes: str = ""


class BenchmarkRequest(BaseModel):
    model: Dict[str, Any] = Field(default_factory=dict)
    evolution: Dict[str, Any] = Field(default_factory=dict)
    multiobjective: Dict[str, Any] = Field(default_factory=dict)
    notes: str = ""


class JobStartResponse(BaseModel):
    job_id: str


class JobStatusResponse(BaseModel):
    job_id: str
    kind: str
    status: str  # pending | running | completed | failed | stopped
    progress: Optional[Dict[str, Any]] = None
    result: Optional[Dict[str, Any]] = None
    error: Optional[str] = None
    created_at: str
    updated_at: str


# --------------------------------------------------------------------------- #
# meta (read-only metadata mirrored from telomere_lab.schemas / adapters.chip)
# --------------------------------------------------------------------------- #
class ParameterBound(BaseModel):
    """One PARAMETER_BOUNDS entry: (min, max, unit, label, description)."""

    min: float
    max: float
    unit: str
    label: str
    description: str


class ObjectiveInfo(BaseModel):
    """One telomere_lab.schemas.OBJECTIVES entry: (direction, description)."""

    direction: str  # "max" | "min"
    description: str


class BoundsResponse(BaseModel):
    bounds: Dict[str, ParameterBound]
    evolvable: List[str]
    defaults: Dict[str, Any]            # ModelConfig().to_dict()
    demo: Dict[str, Any]                # configs/demo.yaml model block
    fitness_weights_default: Dict[str, float]
    evolution_default: Dict[str, Any]   # EvolutionConfig().to_dict() (includes nested weights)
    objectives: Dict[str, ObjectiveInfo] = Field(default_factory=dict)  # OBJECTIVES (Phase 4, Pareto page)


class VersionResponse(BaseModel):
    package: str
    model: str
    optimizer: str
    python: str
    numpy: str
    git_commit: Optional[str] = None


class ChipConditionsRequest(BaseModel):
    """Field names/defaults copied from telomere_lab.adapters.chip.ChipConditions."""

    flow_rate: float = 0.5
    oxygen_tension: float = 0.21
    nutrient_state: float = 0.8
    stress_exposure: float = 0.2
    culture_days: float = 60.0


class ChipParamsResponse(BaseModel):
    """Return shape of chip_to_model_params."""

    stress_level: float
    repair_rate: float
    cycles: int


# --------------------------------------------------------------------------- #
# experiments
# --------------------------------------------------------------------------- #
class ExperimentSummary(BaseModel):
    run_id: str
    kind: Optional[str] = None
    created_at: Optional[str] = None
    fitness: Optional[float] = None
    runtime_seconds: Optional[float] = None
    notes: Optional[str] = None
    mine: bool = False
    # Phase 4 (React Experiments ledger table): the remaining columns of
    # registry._index_row, so the table needs no per-row detail request.
    seed: Optional[int] = None
    configuration_hash: Optional[str] = None
    git_commit: Optional[str] = None
    model_version: Optional[str] = None


class ExperimentDetail(BaseModel):
    record: Dict[str, Any]
    artifacts: Dict[str, str] = Field(default_factory=dict)


class ArtifactInfo(BaseModel):
    """One file under experiments/runs/<run_id>/ (GET .../artifacts)."""

    name: str                       # file name, the path segment for the download route
    key: Optional[str] = None       # record["artifacts"] key that points at this file, if any
    size_bytes: int
    media_type: str


# --------------------------------------------------------------------------- #
# compare (synchronous, Phase 4)
# --------------------------------------------------------------------------- #
class CompareScenario(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    config: Dict[str, Any] = Field(default_factory=dict)


class CompareRequest(BaseModel):
    scenarios: List[CompareScenario] = Field(min_length=1, max_length=6)
    #: Common random numbers: when set, every scenario is run with this seed
    #: (the Streamlit Compare page's "Force identical simulator seed").
    seed: Optional[int] = None


class CompareScenarioResult(BaseModel):
    name: str
    result: Dict[str, Any]          # SimulationResult.to_json_dict()
    fitness: Optional[float] = None # breakdown.total (None when the run is invalid)
    breakdown: Dict[str, Any]       # FitnessBreakdown.to_dict()
    deltas: Optional[Dict[str, Optional[float]]] = None  # runner.deltas vs. the first scenario; None for it


class CompareResponse(BaseModel):
    baseline: str                   # name of the first scenario, the reference for `deltas`
    scenarios: List[CompareScenarioResult]
