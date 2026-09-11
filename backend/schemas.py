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

The one exception (stage 6b, scheduled intervention protocols -- docs/MODEL.md
§2.1) is the *shape* of the optional ``schedule`` block and of
``schedule_phases``: ``ModelConfigBody`` / ``OptimizerConfigBody`` type just
those two on top of an ``extra="allow"`` free-form dict, so the OpenAPI schema
documents them and the frontend types can mirror them. Their *semantics*
(schedulable names, phase count vs. value count, bounds) are still checked by
``InterventionSchedule.validate()`` -> ``ConfigError`` -> HTTP 400.
"""

from __future__ import annotations

from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, SecretStr, field_validator

from telomere_lab.schemas import MAX_PHASES


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
# config blocks (free-form dicts; only the schedule contract is typed)
# --------------------------------------------------------------------------- #
class InterventionSchedule(BaseModel):
    """telomere_lab.schemas.InterventionSchedule.to_dict() (docs/MODEL.md §2.1).

    ``values[name]`` must hold exactly ``phases`` entries and ``name`` must be
    one of ``SCHEDULABLE_PARAMETERS``; those rules are enforced by the core
    ``validate()`` (400), this model only fixes the wire shape (422 on a
    malformed body, like every other request model).
    """

    phases: int
    values: Dict[str, List[float]] = Field(default_factory=dict)


class SubcloneSpec(BaseModel):
    """telomere_lab.schemas.SubcloneSpec.to_dict() (docs/MODEL.md §2.2).

    ``overrides`` keys must be one of ``SUBCLONE_OVERRIDABLE_PARAMETERS`` and
    bounds-checked like any other parameter; those rules are enforced by the
    core ``SubcloneSpec.validate()`` (400), this model only fixes the wire
    shape (422 on a malformed body).
    """

    name: str
    initial_fraction: float
    overrides: Dict[str, float] = Field(default_factory=dict)


class ModelConfigBody(BaseModel):
    """A ``ModelConfig`` dict as accepted by ``ModelConfig.from_dict``.

    Every scalar field stays free-form (``extra="allow"``, see the module
    docstring); ``schedule`` and ``subclones`` are the two optional protocol/
    competition blocks. ``None`` / absent means "no schedule" / "no
    sub-clones" -- exactly what ``to_dict()`` emits for a plain config.
    """

    model_config = ConfigDict(extra="allow")

    schedule: Optional[InterventionSchedule] = None
    subclones: Optional[List[SubcloneSpec]] = None

    def to_plain(self) -> Dict[str, Any]:
        """The dict ``ModelConfig.from_dict`` expects (``schedule``/``subclones`` dropped when unset)."""
        data = self.model_dump()
        if data.get("schedule") is None:
            data.pop("schedule", None)
        if data.get("subclones") is None:
            data.pop("subclones", None)
        return data


class OptimizerConfigBody(BaseModel):
    """An ``EvolutionConfig`` / ``MultiObjectiveConfig`` / ``ActiveLearningConfig`` dict.

    ``schedule_phases`` (protocol search, docs/MODEL.md §2.1) is typed and
    range-checked here against the core ``MAX_PHASES``; everything else is
    free-form and validated by the dataclass's own ``validate()``.
    """

    model_config = ConfigDict(extra="allow")

    schedule_phases: int = Field(default=1, ge=1, le=MAX_PHASES)

    def to_plain(self) -> Dict[str, Any]:
        return self.model_dump()


# --------------------------------------------------------------------------- #
# simulate
# --------------------------------------------------------------------------- #
class SimulateRequest(BaseModel):
    config: ModelConfigBody = Field(default_factory=ModelConfigBody)


class SimulationRunResponse(BaseModel):
    """``SimulationResult.to_json_dict()`` (+ ``run_id`` / ``fitness`` on /simulate).

    Free-form apart from ``applied_schedule``: the per-cycle value actually
    applied for every *scheduled* parameter, each array ``cycles + 1`` long on
    the same axis as ``timeseries.cycle`` (docs/MODEL.md §2.1); ``{}`` when the
    config has no schedule.
    """

    model_config = ConfigDict(extra="allow")

    applied_schedule: Dict[str, List[float]] = Field(default_factory=dict)
    #: Per-clone population-fraction-of-total array (docs/MODEL.md §2.2,
    #: sub-clone competition); ``{}`` when ``config.subclones`` is unset.
    clone_fraction: Dict[str, List[float]] = Field(default_factory=dict)


class SimulateResponse(BaseModel):
    run: SimulationRunResponse


# --------------------------------------------------------------------------- #
# ensemble -- run N seeds of one config, show the full spread (ROADMAP.md
# candidate feature #2). Kept separate from SimulateResponse: a full
# to_json_dict() per seed would be n_seeds x the single-run payload, so this
# response ships only what the fan chart / summary table / particle
# visualization actually need.
# --------------------------------------------------------------------------- #
MIN_ENSEMBLE_SEEDS = 2
MAX_ENSEMBLE_SEEDS = 50


class EnsembleRequest(BaseModel):
    """``n_seeds`` / ``base_seed`` are validated in the router (not as pydantic
    field constraints) so an out-of-range value surfaces the same 400 +
    plain-text-detail contract as every other config error, instead of a 422."""

    config: ModelConfigBody = Field(default_factory=ModelConfigBody)
    n_seeds: int = 10
    base_seed: Optional[int] = None


class EnsembleSeedResult(BaseModel):
    """Light-weight per-seed series -- the arrays ``PopulationCanvas``'s
    per-cycle frame mapping and the terminal-metrics summary table need, on the
    shared ``EnsembleBands.cycle`` axis. NOT a full ``SimulationResult.to_json_dict()``
    (no ``final_lengths_bp``, no ``distribution_snapshots``, no per-seed config)."""

    seed: int
    valid: bool
    failure_reason: Optional[str] = None
    mean_length: List[float]
    shortest_length: List[float]
    population_size: List[int]
    proliferative_count: List[int]
    senescent_fraction: List[float]
    terminal_metrics: Dict[str, float] = Field(default_factory=dict)


class EnsembleBands(BaseModel):
    """p10 / p50 (median) / p90 + mean of ``mean_length`` across seeds, taken
    independently at each cycle (see ``telomere_lab.experiments.runner.summarize_ensemble``
    for why this is not a per-trajectory confidence band)."""

    cycle: List[float]
    p10: List[float]
    p50: List[float]
    p90: List[float]
    mean: List[float]


class EnsembleResponse(BaseModel):
    run_id: str
    n_seeds: int
    base_seed: int
    seeds: List[int]
    config: Dict[str, Any]
    config_hash: str
    bands: EnsembleBands
    series: List[EnsembleSeedResult]
    #: Shared by every seed (only the RNG differs), populated only when
    #: ``config.schedule`` is set -- same convention as SimulationRunResponse.
    applied_schedule: Dict[str, List[float]] = Field(default_factory=dict)


# --------------------------------------------------------------------------- #
# long-running jobs (evolve / pareto / sensitivity / active-learning / benchmark)
# --------------------------------------------------------------------------- #
class EvolveRequest(BaseModel):
    model: ModelConfigBody = Field(default_factory=ModelConfigBody)
    evolution: OptimizerConfigBody = Field(default_factory=OptimizerConfigBody)
    notes: str = ""


class ParetoRequest(BaseModel):
    model: ModelConfigBody = Field(default_factory=ModelConfigBody)
    multiobjective: OptimizerConfigBody = Field(default_factory=OptimizerConfigBody)
    notes: str = ""


class SensitivityRequest(BaseModel):
    model: ModelConfigBody = Field(default_factory=ModelConfigBody)
    sensitivity: Dict[str, Any] = Field(default_factory=dict)
    notes: str = ""


class ActiveLearningRequest(BaseModel):
    model: ModelConfigBody = Field(default_factory=ModelConfigBody)
    active_learning: OptimizerConfigBody = Field(default_factory=OptimizerConfigBody)
    notes: str = ""


class BenchmarkRequest(BaseModel):
    model: ModelConfigBody = Field(default_factory=ModelConfigBody)
    evolution: OptimizerConfigBody = Field(default_factory=OptimizerConfigBody)
    multiobjective: OptimizerConfigBody = Field(default_factory=OptimizerConfigBody)
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
    # Stage 6b (schedules, docs/MODEL.md §2.1): the parameters a schedule may
    # vary, the phase cap, and named example protocols as full ModelConfig
    # dicts (configs/demo_fasting.yaml -> "demo_fasting"; absent file -> no key).
    schedulable: List[str] = Field(default_factory=list)   # SCHEDULABLE_PARAMETERS
    max_phases: int = MAX_PHASES
    presets: Dict[str, Dict[str, Any]] = Field(default_factory=dict)
    # Sub-clone competition (docs/MODEL.md §2.2, ROADMAP.md candidate feature
    # #4): the parameters a clone's `overrides` may set.
    subclone_overridable: List[str] = Field(default_factory=list)  # SUBCLONE_OVERRIDABLE_PARAMETERS


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


class ChipPresetInfo(BaseModel):
    """One entry of ``telomere_lab.adapters.chip.list_chip_presets()`` plus its
    derived model parameters (ROADMAP.md candidate feature #3), so the
    frontend can show stress/repair/cycles for every preset without a
    round trip per card."""

    conditions: ChipConditionsRequest
    label: str
    description: str
    derived: ChipParamsResponse


class ChipPresetsResponse(BaseModel):
    presets: Dict[str, ChipPresetInfo]


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
    """A scenario is specified either as an explicit ``config`` (a full
    ``ModelConfig`` body, the original shape) or as ``chip`` (organ-chip
    conditions, ROADMAP.md candidate feature #3: multi-chip comparison) --
    never both, never neither. The router maps ``chip`` through
    ``chip_to_model_params`` and merges the result onto the request's shared
    base config, the same override semantics ``ChipMapper``/Simulate already
    use client-side (``{...config, ...derived}``); see ``backend/routers/compare.py``.
    """

    name: str = Field(min_length=1, max_length=80)
    config: Optional[ModelConfigBody] = None
    chip: Optional[ChipConditionsRequest] = None
    # `config` XOR `chip` is enforced in the router (backend/routers/compare.py),
    # not here, so the 400 can be scenario-name-qualified like every other
    # config error in that endpoint.


class CompareRequest(BaseModel):
    scenarios: List[CompareScenario] = Field(min_length=1, max_length=6)
    #: Common random numbers: when set, every scenario is run with this seed
    #: (the Streamlit Compare page's "Force identical simulator seed").
    seed: Optional[int] = None
    #: Base ``ModelConfig`` a ``chip``-specified scenario's derived params are
    #: merged onto (ROADMAP.md candidate feature #3), the same
    #: ``{...config, ...derived}`` override semantics ``ChipMapper``/Simulate
    #: already use client-side. Defaults to ``ModelConfig()``'s own defaults
    #: (i.e. an all-default config) when omitted; a plain ``config`` scenario
    #: never reads this field.
    base_config: ModelConfigBody = Field(default_factory=ModelConfigBody)


class CompareScenarioResult(BaseModel):
    name: str
    result: SimulationRunResponse   # SimulationResult.to_json_dict() (incl. applied_schedule)
    fitness: Optional[float] = None # breakdown.total (None when the run is invalid)
    breakdown: Dict[str, Any]       # FitnessBreakdown.to_dict()
    deltas: Optional[Dict[str, Optional[float]]] = None  # runner.deltas vs. the first scenario; None for it


class CompareResponse(BaseModel):
    baseline: str                   # name of the first scenario, the reference for `deltas`
    scenarios: List[CompareScenarioResult]


# --------------------------------------------------------------------------- #
# LLM Layer 1 -- results interpreter (backend/llm.py, docs/ROADMAP.md)
# --------------------------------------------------------------------------- #
class LLMInterpretRequest(BaseModel):
    """Bring-your-own-key interpretation of one recorded run.

    ``api_key`` is a ``SecretStr`` (masked in reprs) and the model hides its
    input from validation errors, so the key is never echoed back or logged;
    the router hands ``get_secret_value()`` straight to a per-request client
    and nothing else keeps a reference. ``model`` / ``effort`` are checked
    against ``backend.llm.MODELS`` / ``EFFORTS`` (the single source, exposed on
    ``GET /api/meta/llm``) -> 422 on an unknown value.
    """

    model_config = ConfigDict(hide_input_in_errors=True)

    run_id: str = Field(min_length=1)
    api_key: SecretStr = Field(min_length=1)
    provider: Literal["anthropic"] = "anthropic"
    model: Optional[str] = None
    effort: Optional[str] = None

    @field_validator("model")
    @classmethod
    def _known_model(cls, value: Optional[str]) -> Optional[str]:
        from . import llm as _llm

        if value is not None and value not in _llm.MODELS:
            raise ValueError(f"unknown model {value!r}; one of {sorted(_llm.MODELS)}")
        return value

    @field_validator("effort")
    @classmethod
    def _known_effort(cls, value: Optional[str]) -> Optional[str]:
        from . import llm as _llm

        if value is not None and value not in _llm.EFFORTS:
            raise ValueError(f"unknown effort {value!r}; one of {list(_llm.EFFORTS)}")
        return value


class LLMUsage(BaseModel):
    input_tokens: int
    output_tokens: int
    cache_read_input_tokens: Optional[int] = None


class LLMInterpretResponse(BaseModel):
    run_id: str
    model: str
    narrative_markdown: str
    usage: LLMUsage
    #: List-price estimate from backend.llm.MODELS -- the user's invoice is the authority.
    estimated_cost_usd: Optional[float] = None
    warnings: List[str] = Field(default_factory=list)


class LLMValidateKeyRequest(BaseModel):
    model_config = ConfigDict(hide_input_in_errors=True)

    api_key: SecretStr = Field(min_length=1)
    provider: Literal["anthropic"] = "anthropic"


class LLMValidateKeyResponse(BaseModel):
    valid: bool
    detail: str


class LLMModelInfo(BaseModel):
    id: str
    label: str
    input_usd_per_mtok: float
    output_usd_per_mtok: float


class LLMMetaResponse(BaseModel):
    providers: List[str]
    models: List[LLMModelInfo]
    default_model: str
    efforts: List[str]
    default_effort: str
    rate_limit: Dict[str, int]   # {"calls": 10, "window_seconds": 600}
