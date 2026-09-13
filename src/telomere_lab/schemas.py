"""Typed configuration and result containers.

Everything the simulator, optimizer, CLI and GUI exchange goes through the
dataclasses defined here. They are plain dataclasses (no third-party
validation library) so the core engine stays dependency-light.

Units
-----
* Telomere lengths are stored in **base pairs (bp)**. The GUI converts to kb
  for display only.
* Time is measured in **cell cycles** (population doublings of the
  proliferative compartment), not wall-clock hours.
"""

from __future__ import annotations

import hashlib
import json
import math
from dataclasses import asdict, dataclass, field, fields
from typing import Any, Dict, Optional, Tuple

import numpy as np

MODEL_VERSION = "0.1.0"
OPTIMIZER_VERSION = "0.1.0"


class ConfigError(ValueError):
    """Raised when a configuration violates its declared bounds."""


# --------------------------------------------------------------------------- #
# Parameter bounds (single source of truth for GUI sliders + genome domains)
# --------------------------------------------------------------------------- #

#: name -> (minimum, maximum, unit, human label, short description)
PARAMETER_BOUNDS: Dict[str, tuple] = {
    "initial_length": (3000.0, 15000.0, "bp", "Initial telomere length",
                       "Mean telomere length of the founding cells."),
    "initial_length_sd": (0.0, 3000.0, "bp", "Initial length spread (SD)",
                          "Standard deviation of telomere lengths at t=0."),
    "shortening_rate": (10.0, 200.0, "bp/cycle", "Replication shortening",
                        "End-replication loss per telomere per division."),
    "stress_level": (0.0, 1.0, "a.u.", "Stress level",
                     "Abstract culture/oxidative stress (0 = none, 1 = maximal)."),
    "stress_sensitivity": (0.0, 300.0, "bp/cycle", "Stress sensitivity",
                           "Extra loss per division at stress_level = 1."),
    "maintenance_rate": (0.0, 1.0, "a.u.", "Maintenance (telomerase-like)",
                         "Fraction of the maximal length-restoring activity."),
    "maintenance_max_gain": (0.0, 300.0, "bp/cycle", "Max maintenance gain",
                             "Gain per division on the shortest telomere at maintenance_rate = 1."),
    "repair_rate": (0.0, 1.0, "a.u.", "Repair rate",
                    "Fraction of stress-induced damage that is repaired."),
    "senescence_threshold": (500.0, 6000.0, "bp", "Senescence threshold",
                             "A cell stops dividing once its *shortest* telomere drops below this."),
    "noise_sd": (0.0, 200.0, "bp", "Per-division noise SD",
                 "Gaussian variability in loss per telomere per division."),
    "senescent_death_rate": (0.0, 0.5, "1/cycle", "Senescent death rate",
                             "Probability that a senescent cell is lost per cycle."),
    "replication_error_rate": (0.0, 0.05, "1/cycle", "Replication error rate",
                               "Baseline mutation burden added per division, genome-wide."),
    "oxidative_mutation_sensitivity": (0.0, 0.05, "1/cycle", "Oxidative mutation sensitivity",
                                       "Extra mutation burden per division at stress_level = 1, offset by repair_rate."),
    "checkpoint_strength": (0.0, 1.0, "a.u.", "Apoptosis checkpoint strength",
                            "Probability per cycle that a cell over the mutation threshold is removed; 0 disables the checkpoint."),
    "mutation_threshold": (0.0, 1.0e9, "a.u.", "Mutation burden threshold",
                           "Burden level above which the apoptosis checkpoint can trigger (only relevant when checkpoint_strength > 0)."),
}

#: The genes the evolutionary optimizer is allowed to touch (SDD §12).
EVOLVABLE_PARAMETERS = (
    "initial_length",
    "shortening_rate",
    "stress_level",
    "maintenance_rate",
    "repair_rate",
    "senescence_threshold",
    "replication_error_rate",
    "oxidative_mutation_sensitivity",
    "checkpoint_strength",
    "mutation_threshold",
)

#: Parameters that may vary over the run as a piecewise-constant schedule
#: (docs/MODEL.md §2.1). All three are "culture-condition / intervention"
#: knobs; structural and initial-condition parameters cannot be scheduled.
SCHEDULABLE_PARAMETERS = ("stress_level", "maintenance_rate", "repair_rate")

#: Upper bound on the number of equal-length phases in a schedule.
MAX_PHASES = 8

#: Parameters a sub-clone's ``overrides`` may set (docs/MODEL.md §2.2). All
#: four are per-cell-arithmetic "biology knobs"; structural, initial-condition
#: and stress-input parameters cannot be overridden per clone (a clone is a
#: genetic variant, not a different culture).
SUBCLONE_OVERRIDABLE_PARAMETERS = ("shortening_rate", "maintenance_rate", "repair_rate", "stress_sensitivity")

#: Fractions across all clones must sum to 1.0 within this tolerance.
SUBCLONE_FRACTION_TOLERANCE = 1e-6


def phase_index(cycle: int, cycles: int, phases: int) -> int:
    """Phase in force during the division step ``cycle -> cycle + 1``.

    ``cycle`` is the 0-based step index (0 .. cycles - 1); the run is split
    into ``phases`` consecutive, as-equal-as-possible blocks. ``cycle ==
    cycles`` (one past the last step) is clamped onto the final phase so
    that a step line drawn against the ``cycles + 1``-long time axis ends
    flat.
    """
    if cycles < 1 or phases < 1:
        raise ValueError("cycles and phases must be >= 1")
    return min(phases - 1, (max(int(cycle), 0) * phases) // cycles)


@dataclass(frozen=True)
class InterventionSchedule:
    """Piecewise-constant values for one or more ``SCHEDULABLE_PARAMETERS``.

    ``values[name]`` holds exactly ``phases`` entries; phase ``k`` applies to
    the steps whose :func:`phase_index` is ``k``. Parameters absent from
    ``values`` keep their scalar ``ModelConfig`` value for the whole run.
    """

    phases: int
    values: Dict[str, Tuple[float, ...]] = field(default_factory=dict)

    def validate(self) -> "InterventionSchedule":
        if not isinstance(self.phases, int) or isinstance(self.phases, bool):
            raise ConfigError(f"schedule.phases must be an integer, got {self.phases!r}")
        if not (1 <= self.phases <= MAX_PHASES):
            raise ConfigError(f"schedule.phases={self.phases} outside [1, {MAX_PHASES}]")
        for name, vals in self.values.items():
            if name not in SCHEDULABLE_PARAMETERS:
                raise ConfigError(f"{name} cannot be scheduled; choose from {list(SCHEDULABLE_PARAMETERS)}")
            if len(vals) != self.phases:
                raise ConfigError(f"schedule.values[{name}] has {len(vals)} entries, expected {self.phases}")
            lo, hi = PARAMETER_BOUNDS[name][0], PARAMETER_BOUNDS[name][1]
            for k, v in enumerate(vals):
                if not np.isfinite(v):
                    raise ConfigError(f"schedule.values[{name}][{k}] must be finite, got {v!r}")
                if not (lo <= v <= hi):
                    raise ConfigError(f"schedule.values[{name}][{k}]={v} outside [{lo}, {hi}]")
        return self

    def to_dict(self) -> Dict[str, Any]:
        return {"phases": int(self.phases),
                "values": {k: [float(x) for x in v] for k, v in self.values.items()}}

    @classmethod
    def from_dict(cls, data: Any) -> "InterventionSchedule":
        if isinstance(data, InterventionSchedule):
            return data
        if not isinstance(data, dict):
            raise ConfigError(f"schedule must be a mapping, got {type(data).__name__}")
        try:
            phases = int(data.get("phases", 1))
        except (TypeError, ValueError):
            raise ConfigError(f"schedule.phases must be an integer, got {data.get('phases')!r}") from None
        raw = data.get("values") or {}
        if not isinstance(raw, dict):
            raise ConfigError("schedule.values must be a mapping of parameter -> list of values")
        values: Dict[str, Tuple[float, ...]] = {}
        for name, vals in raw.items():
            if isinstance(vals, (int, float)) or not hasattr(vals, "__iter__"):
                raise ConfigError(f"schedule.values[{name}] must be a list of {phases} values")
            values[str(name)] = tuple(float(x) for x in vals)
        return cls(phases=phases, values=values)

    def per_cycle(self, name: str, cycles: int) -> np.ndarray:
        """Value of ``name`` at every step 0 .. cycles (length ``cycles + 1``)."""
        vals = np.asarray(self.values[name], dtype=float)
        idx = [phase_index(t, cycles, self.phases) for t in range(cycles + 1)]
        return vals[idx]


@dataclass(frozen=True)
class SubcloneSpec:
    """One named, genetically distinct sub-clone in a competing sub-population
    (docs/MODEL.md §2.2, ROADMAP.md candidate feature #4).

    ``overrides`` may set any subset of ``SUBCLONE_OVERRIDABLE_PARAMETERS``;
    a parameter absent from ``overrides`` falls back to the shared
    ``ModelConfig``'s own scalar/schedule value for that clone (this is what
    makes an all-empty-overrides clone table behave identically to today's
    single-population model).
    """

    name: str
    initial_fraction: float
    overrides: Dict[str, float] = field(default_factory=dict)

    def validate(self) -> "SubcloneSpec":
        if not self.name or not isinstance(self.name, str):
            raise ConfigError(f"subclone name must be a non-empty string, got {self.name!r}")
        if not np.isfinite(self.initial_fraction) or not (0.0 < self.initial_fraction <= 1.0):
            raise ConfigError(f"subclone {self.name!r} initial_fraction={self.initial_fraction} must be in (0, 1]")
        for key, value in self.overrides.items():
            if key not in SUBCLONE_OVERRIDABLE_PARAMETERS:
                raise ConfigError(
                    f"subclone {self.name!r} cannot override {key!r}; choose from "
                    f"{list(SUBCLONE_OVERRIDABLE_PARAMETERS)}"
                )
            lo, hi = PARAMETER_BOUNDS[key][0], PARAMETER_BOUNDS[key][1]
            if not np.isfinite(value):
                raise ConfigError(f"subclone {self.name!r} overrides[{key}] must be finite, got {value!r}")
            if not (lo <= value <= hi):
                raise ConfigError(f"subclone {self.name!r} overrides[{key}]={value} outside [{lo}, {hi}]")
        return self

    def to_dict(self) -> Dict[str, Any]:
        return {"name": self.name, "initial_fraction": float(self.initial_fraction),
                "overrides": {k: float(v) for k, v in self.overrides.items()}}

    @classmethod
    def from_dict(cls, data: Any) -> "SubcloneSpec":
        if isinstance(data, SubcloneSpec):
            return data
        if not isinstance(data, dict):
            raise ConfigError(f"each subclone must be a mapping, got {type(data).__name__}")
        overrides = data.get("overrides") or {}
        if not isinstance(overrides, dict):
            raise ConfigError("subclone overrides must be a mapping of parameter -> value")
        return cls(
            name=str(data.get("name", "")),
            initial_fraction=float(data.get("initial_fraction", 0.0)),
            overrides={str(k): float(v) for k, v in overrides.items()},
        )


def _validate_subclones(subclones: Tuple[SubcloneSpec, ...]) -> None:
    if len(subclones) < 2:
        raise ConfigError("subclones needs >= 2 clones (a single clone is meaningless; just omit the field)")
    names = [c.name for c in subclones]
    if len(set(names)) != len(names):
        raise ConfigError(f"subclone names must be unique, got {names}")
    for clone in subclones:
        clone.validate()
    total = math.fsum(c.initial_fraction for c in subclones)
    if abs(total - 1.0) > SUBCLONE_FRACTION_TOLERANCE:
        raise ConfigError(f"subclone initial_fractions must sum to 1.0, got {total}")


@dataclass
class ModelConfig:
    """Parameters governing one virtual experiment.

    Split (SDD §9): *model parameters* (biology), *initial conditions*,
    *randomness*, and structural sizes.
    """

    # --- initial conditions ---------------------------------------------
    initial_length: float = 7500.0
    initial_length_sd: float = 800.0
    population_size: int = 100
    carrying_capacity: int = 400
    telomeres_per_cell: int = 32

    # --- model parameters --------------------------------------------------
    shortening_rate: float = 55.0
    stress_level: float = 0.40
    stress_sensitivity: float = 100.0
    maintenance_rate: float = 0.20
    maintenance_max_gain: float = 120.0
    repair_rate: float = 0.20
    senescence_threshold: float = 3000.0
    noise_sd: float = 30.0
    senescent_death_rate: float = 0.03

    # --- optional genome stability / apoptosis checkpoint (docs/MODEL.md §2.3) --
    #: Baseline + oxidative contributions to a per-cell mutation-burden
    #: accumulator; both default to 0.0 so the accumulator never grows and the
    #: checkpoint below has nothing to act on -- bit-identical to today's model.
    replication_error_rate: float = 0.0
    oxidative_mutation_sensitivity: float = 0.0
    #: Probability per cycle a cell over ``mutation_threshold`` is removed.
    #: 0.0 (default) is the feature's actual off switch.
    checkpoint_strength: float = 0.0
    #: Sentinel default far above any reachable mutation_burden -- belt-and-
    #: suspenders alongside checkpoint_strength=0.0.
    mutation_threshold: float = 1.0e9

    # --- run control -------------------------------------------------------
    cycles: int = 120
    seed: int = 42
    record_distribution_every: int = 0  # 0 = only final distribution

    # --- optional time-varying protocol (docs/MODEL.md §2.1) ------------------
    #: When set, the scheduled parameters override their scalar field cycle by
    #: cycle; the scalar then only documents the phase-0 / fallback value.
    schedule: Optional[InterventionSchedule] = None

    # --- optional sub-clone competition (docs/MODEL.md §2.2) ------------------
    #: When set, the founding population is split across these named clones
    #: (largest-remainder allocation of ``population_size`` by
    #: ``initial_fraction``) and each clone's per-cell arithmetic uses its own
    #: ``overrides`` where set, falling back to this config's own scalar/
    #: schedule values otherwise. ``None`` is the single implicit "default"
    #: clone -- bit-identical to today's model.
    subclones: Optional[Tuple[SubcloneSpec, ...]] = None

    def validate(self) -> "ModelConfig":
        for name, (lo, hi, *_rest) in PARAMETER_BOUNDS.items():
            value = getattr(self, name)
            if not np.isfinite(value):
                raise ConfigError(f"{name} must be finite, got {value!r}")
            if not (lo <= value <= hi):
                raise ConfigError(f"{name}={value} outside [{lo}, {hi}]")
        if self.schedule is not None:
            self.schedule.validate()
        if self.subclones is not None:
            _validate_subclones(self.subclones)
        if self.population_size < 1:
            raise ConfigError("population_size must be >= 1")
        if self.carrying_capacity < self.population_size:
            raise ConfigError("carrying_capacity must be >= population_size")
        if self.telomeres_per_cell < 1:
            raise ConfigError("telomeres_per_cell must be >= 1")
        if self.cycles < 1:
            raise ConfigError("cycles must be >= 1")
        if self.senescence_threshold >= self.initial_length:
            raise ConfigError("senescence_threshold must be below initial_length")
        return self

    # --- schedule lookups ----------------------------------------------------
    def is_scheduled(self, name: str) -> bool:
        return self.schedule is not None and name in self.schedule.values

    def value_at(self, name: str, cycle: int) -> float:
        """Value of ``name`` in force during step ``cycle -> cycle + 1``.

        The scalar field when ``name`` is not scheduled; otherwise the phase
        value selected by :func:`phase_index`.
        """
        if not self.is_scheduled(name):
            return float(getattr(self, name))
        return float(self.schedule.values[name][phase_index(cycle, self.cycles, self.schedule.phases)])

    def per_cycle_values(self, name: str) -> np.ndarray:
        """``value_at(name, t)`` for t = 0 .. cycles (length ``cycles + 1``)."""
        if not self.is_scheduled(name):
            return np.full(int(self.cycles) + 1, float(getattr(self, name)))
        return self.schedule.per_cycle(name, int(self.cycles))

    def mean_value(self, name: str) -> float:
        """Time average of ``name`` over the ``cycles`` division steps.

        Equals the scalar field exactly when ``name`` is not scheduled; used by
        the intervention-cost term (docs/MODEL.md §5).
        """
        if not self.is_scheduled(name):
            return float(getattr(self, name))
        vals = self.schedule.values[name]
        if all(v == vals[0] for v in vals):
            return float(vals[0])  # a constant schedule averages to exactly its value
        per_step = self.per_cycle_values(name)[: int(self.cycles)]
        return float(math.fsum(per_step.tolist()) / int(self.cycles))

    # --- helpers -------------------------------------------------------------
    def to_dict(self) -> Dict[str, Any]:
        data = asdict(self)
        data["schedule"] = self.schedule.to_dict() if self.schedule is not None else None
        data["subclones"] = [c.to_dict() for c in self.subclones] if self.subclones is not None else None
        return data

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "ModelConfig":
        allowed = {f.name for f in fields(cls)}
        clean = {k: v for k, v in data.items() if k in allowed}
        schedule = clean.pop("schedule", None)
        subclones = clean.pop("subclones", None)
        cfg = cls(**clean)
        # coerce ints that may arrive as floats from YAML / genomes
        cfg.population_size = int(cfg.population_size)
        cfg.carrying_capacity = int(cfg.carrying_capacity)
        cfg.telomeres_per_cell = int(cfg.telomeres_per_cell)
        cfg.cycles = int(cfg.cycles)
        cfg.seed = int(cfg.seed)
        cfg.record_distribution_every = int(cfg.record_distribution_every)
        if schedule is not None:
            cfg.schedule = InterventionSchedule.from_dict(schedule)
        if subclones is not None:
            if not isinstance(subclones, (list, tuple)):
                raise ConfigError(f"subclones must be a list, got {type(subclones).__name__}")
            cfg.subclones = tuple(SubcloneSpec.from_dict(c) for c in subclones)
        return cfg

    def replace(self, **changes: Any) -> "ModelConfig":
        data = self.to_dict()
        data.update(changes)
        return ModelConfig.from_dict(data)

    def config_hash(self) -> str:
        """Stable hash of every field *except* the seed (SDD §19 cache key).

        The schedule is part of the hash whenever one is set; an unscheduled
        config hashes exactly as it did before schedules existed.
        """
        data = self.to_dict()
        data.pop("seed", None)
        if data.get("schedule") is None:
            data.pop("schedule", None)
        if data.get("subclones") is None:
            data.pop("subclones", None)
        blob = json.dumps(data, sort_keys=True, default=float).encode()
        return hashlib.sha256(blob).hexdigest()[:16]


@dataclass
class SimulationResult:
    """Structured output of one simulation (SDD §10)."""

    seed: int
    config: ModelConfig
    model_version: str
    time: np.ndarray                       # (T+1,)
    mean_length: np.ndarray                # (T+1,) bp, over all telomeres in living cells
    median_length: np.ndarray
    shortest_length: np.ndarray            # global minimum
    p10_length: np.ndarray                 # 10th percentile
    mean_shortest_per_cell: np.ndarray     # mean over cells of each cell's shortest telomere
    senescent_fraction: np.ndarray
    population_size: np.ndarray            # living cells (proliferative + senescent)
    proliferative_count: np.ndarray
    fraction_below_threshold: np.ndarray   # telomeres below the senescence threshold
    length_cv: np.ndarray                  # coefficient of variation of lengths
    final_lengths: np.ndarray              # flattened telomere lengths at the end
    distribution_snapshots: Dict[int, np.ndarray] = field(default_factory=dict)
    #: Per founding cell (population_size,): cycle at which the FIRST of its
    #: descendants became senescent, or -1 if none had by the end of the run
    #: (right-censored). Comparable to a reference model's per-ancestor
    #: senescence-onset tracking (docs/EXPERIMENT_PROTOCOL.md Experiment D).
    founder_senescence_cycle: np.ndarray = field(default_factory=lambda: np.array([], dtype=int))
    #: Per-cycle value actually applied for each *scheduled* parameter, on the
    #: same ``(T+1,)`` axis as ``time`` (entry t = value in force during the
    #: step t -> t+1; the last entry repeats the final phase so a step line
    #: ends flat). Empty when the config has no schedule.
    applied_schedule: Dict[str, np.ndarray] = field(default_factory=dict)
    #: Per-clone population-fraction-of-total-living array, on the same
    #: ``(T+1,)`` axis as ``time`` (docs/MODEL.md §2.2, sub-clone competition).
    #: Empty dict when ``config.subclones`` is unset.
    clone_fraction: Dict[str, np.ndarray] = field(default_factory=dict)
    #: Genome-wide mean mutation burden / apoptotic fraction per cycle, on the
    #: same ``(T+1,)`` axis as ``time`` (docs/MODEL.md §2.3). All-zero arrays
    #: (not ``None``) when genome stability is unused, matching every other
    #: always-present timeseries field.
    mean_mutation_burden: np.ndarray = field(default_factory=lambda: np.array([]))
    apoptotic_fraction: np.ndarray = field(default_factory=lambda: np.array([]))
    terminal_metrics: Dict[str, float] = field(default_factory=dict)
    #: Synthetic "biological age" biomarker score (ROADMAP.md candidate
    #: feature #5, docs/MODEL.md §4.1) -- a derived, documented composite of
    #: this result's own terminal metrics, computed post-hoc from an already
    #: -completed simulation. ``None`` until attached by the simulator
    #: (`simulator/model.py`) or an explicit call to
    #: ``simulator.biomarker.biological_age_score``; never NaN or a crash --
    #: see `simulator/biomarker.py` for the full formula and its rationale.
    biological_age: Optional[Any] = None
    valid: bool = True
    failure_reason: Optional[str] = None
    runtime_seconds: float = 0.0

    # --- export ---------------------------------------------------------------
    def timeseries_frame(self):
        import pandas as pd

        return pd.DataFrame(
            {
                "cycle": self.time,
                "mean_length_bp": self.mean_length,
                "median_length_bp": self.median_length,
                "shortest_length_bp": self.shortest_length,
                "p10_length_bp": self.p10_length,
                "mean_shortest_per_cell_bp": self.mean_shortest_per_cell,
                "senescent_fraction": self.senescent_fraction,
                "population_size": self.population_size,
                "proliferative_count": self.proliferative_count,
                "fraction_below_threshold": self.fraction_below_threshold,
                "length_cv": self.length_cv,
                "mean_mutation_burden": self.mean_mutation_burden,
                "apoptotic_fraction": self.apoptotic_fraction,
            }
        )

    def to_json_dict(self, include_final_lengths: bool = True) -> Dict[str, Any]:
        out: Dict[str, Any] = {
            "seed": self.seed,
            "model_version": self.model_version,
            "config": self.config.to_dict(),
            "config_hash": self.config.config_hash(),
            "valid": self.valid,
            "failure_reason": self.failure_reason,
            "runtime_seconds": self.runtime_seconds,
            "terminal_metrics": self.terminal_metrics,
            "timeseries": {
                k: v.tolist() for k, v in self.timeseries_frame().items()
            },
            "applied_schedule": {k: np.asarray(v).tolist() for k, v in self.applied_schedule.items()},
            "clone_fraction": {k: np.asarray(v).tolist() for k, v in self.clone_fraction.items()},
            "biological_age": self.biological_age.to_json_dict() if self.biological_age is not None else None,
        }
        if include_final_lengths:
            out["final_lengths_bp"] = self.final_lengths.tolist()
        return out


@dataclass
class FitnessWeights:
    """Weights of the explicit, user-configurable objective (SDD §13).

    fitness = w_survival * survival
            + w_reserve  * reserve
            - w_senescence * senescence
            - w_instability * instability
            - w_cost * intervention_cost
    """

    w_survival: float = 0.40
    w_reserve: float = 0.30
    w_senescence: float = 0.20
    w_instability: float = 0.10
    w_cost: float = 0.30
    #: Weight of the genome-instability term (docs/MODEL.md §2.3). Defaults to
    #: 0.0 so existing fitness scores are unaffected until a user opts in.
    w_genome_instability: float = 0.0

    def to_dict(self) -> Dict[str, float]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "FitnessWeights":
        allowed = {f.name for f in fields(cls)}
        return cls(**{k: float(v) for k, v in data.items() if k in allowed})


def _validate_schedule_phases(phases: Any) -> None:
    if isinstance(phases, bool) or int(phases) != phases or not (1 <= int(phases) <= MAX_PHASES):
        raise ConfigError(f"schedule_phases must be an integer in [1, {MAX_PHASES}], got {phases!r}")


#: Objectives available to the multi-objective optimizer: name -> (direction, description)
OBJECTIVES: Dict[str, tuple] = {
    "survival": ("max", "normalised proliferative-cell AUC"),
    "reserve": ("max", "normalised shortest-telomere reserve at the end"),
    "senescence": ("min", "final senescent fraction"),
    "instability": ("min", "final length CV, scaled"),
    "cost": ("min", "intervention cost ½(maintenance² + repair²)"),
    "genome_instability": ("min", "genomic instability index (fraction of cells over the mutation threshold)"),
}


@dataclass
class MultiObjectiveConfig:
    """NSGA-II settings. Shares operators and gene domains with the GA."""

    population_size: int = 40
    generations: int = 25
    mutation_rate: float = 0.30
    mutation_sigma: float = 0.15
    crossover_rate: float = 0.80
    crossover_kind: str = "uniform"
    seed: int = 7
    eval_seeds: tuple = (42,)
    free_genes: tuple = ("stress_level", "maintenance_rate", "repair_rate")
    objectives: tuple = ("survival", "cost")
    checkpoint_every: int = 5
    #: >1 expands every free gene in SCHEDULABLE_PARAMETERS into one gene per
    #: phase (a protocol search, docs/MODEL.md §2.1); 1 = constant genes.
    schedule_phases: int = 1
    weights: FitnessWeights = field(default_factory=FitnessWeights)  # scalar fitness for reference only

    def validate(self) -> "MultiObjectiveConfig":
        if self.population_size < 4 or self.population_size % 2:
            raise ConfigError("multi-objective population_size must be even and >= 4")
        _validate_schedule_phases(self.schedule_phases)
        if self.generations < 1:
            raise ConfigError("generations must be >= 1")
        if not (0.0 <= self.mutation_rate <= 1.0):
            raise ConfigError("mutation_rate must be in [0, 1]")
        if self.mutation_sigma <= 0:
            raise ConfigError("mutation_sigma must be > 0")
        if self.crossover_kind not in ("uniform", "arithmetic"):
            raise ConfigError("crossover_kind must be 'uniform' or 'arithmetic'")
        for g in self.free_genes:
            if g not in EVOLVABLE_PARAMETERS:
                raise ConfigError(f"{g} is not an evolvable parameter")
        if not self.free_genes:
            raise ConfigError("at least one free gene is required")
        if len(self.objectives) < 2:
            raise ConfigError("at least two objectives are required")
        for o in self.objectives:
            if o not in OBJECTIVES:
                raise ConfigError(f"unknown objective {o}; choose from {sorted(OBJECTIVES)}")
        if not self.eval_seeds:
            raise ConfigError("eval_seeds must not be empty")
        return self

    def to_dict(self) -> Dict[str, Any]:
        d = asdict(self)
        d["eval_seeds"] = list(self.eval_seeds)
        d["free_genes"] = list(self.free_genes)
        d["objectives"] = list(self.objectives)
        return d

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "MultiObjectiveConfig":
        data = dict(data)
        weights = data.pop("weights", None)
        allowed = {f.name for f in fields(cls)}
        clean = {k: v for k, v in data.items() if k in allowed}
        for key in ("eval_seeds", "free_genes", "objectives"):
            if key in clean:
                clean[key] = tuple(int(s) if key == "eval_seeds" else s for s in clean[key])
        cfg = cls(**clean)
        if weights is not None:
            cfg.weights = FitnessWeights.from_dict(weights)
        return cfg


@dataclass
class EvolutionConfig:
    """Genetic-algorithm settings (SDD §14)."""

    population_size: int = 32
    generations: int = 20
    elite_fraction: float = 0.10
    mutation_rate: float = 0.30          # probability each gene mutates
    mutation_sigma: float = 0.15         # in normalised [0,1] gene space
    crossover_rate: float = 0.70
    crossover_kind: str = "uniform"      # "uniform" | "arithmetic"
    tournament_size: int = 3
    seed: int = 7
    #: Simulator seeds averaged per candidate (SDD §14). Multiple seeds are the
    #: default so a candidate's fitness is not a single stochastic draw; earlier
    #: recorded experiments (docs/EXPERIMENT_PROTOCOL.md A/B/C) used a single
    #: seed (42) for reproducibility and are not directly comparable in noise.
    eval_seeds: tuple = (1, 2, 3)
    free_genes: tuple = ("stress_level", "maintenance_rate", "repair_rate")
    early_stopping_patience: int = 0     # 0 = disabled
    early_stopping_tol: float = 1e-4
    checkpoint_every: int = 5
    #: >1 expands every free gene in SCHEDULABLE_PARAMETERS into one gene per
    #: phase (a protocol search, docs/MODEL.md §2.1); 1 = constant genes.
    schedule_phases: int = 1
    weights: FitnessWeights = field(default_factory=FitnessWeights)

    def validate(self) -> "EvolutionConfig":
        if self.population_size < 4:
            raise ConfigError("evolution population_size must be >= 4")
        _validate_schedule_phases(self.schedule_phases)
        if self.generations < 1:
            raise ConfigError("generations must be >= 1")
        if not (0.0 <= self.elite_fraction <= 0.5):
            raise ConfigError("elite_fraction must be in [0, 0.5]")
        if not (0.0 <= self.mutation_rate <= 1.0):
            raise ConfigError("mutation_rate must be in [0, 1]")
        if self.mutation_sigma <= 0:
            raise ConfigError("mutation_sigma must be > 0")
        if self.crossover_kind not in ("uniform", "arithmetic"):
            raise ConfigError("crossover_kind must be 'uniform' or 'arithmetic'")
        for g in self.free_genes:
            if g not in EVOLVABLE_PARAMETERS:
                raise ConfigError(f"{g} is not an evolvable parameter")
        if not self.free_genes:
            raise ConfigError("at least one free gene is required")
        if not self.eval_seeds:
            raise ConfigError("eval_seeds must not be empty")
        return self

    def to_dict(self) -> Dict[str, Any]:
        d = asdict(self)
        d["eval_seeds"] = list(self.eval_seeds)
        d["free_genes"] = list(self.free_genes)
        return d

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "EvolutionConfig":
        data = dict(data)
        weights = data.pop("weights", None)
        allowed = {f.name for f in fields(cls)}
        clean = {k: v for k, v in data.items() if k in allowed}
        if "eval_seeds" in clean:
            clean["eval_seeds"] = tuple(int(s) for s in clean["eval_seeds"])
        if "free_genes" in clean:
            clean["free_genes"] = tuple(clean["free_genes"])
        cfg = cls(**clean)
        if weights is not None:
            cfg.weights = FitnessWeights.from_dict(weights)
        return cfg


@dataclass
class ActiveLearningConfig:
    """Surrogate-model active-learning settings (GP + Expected Improvement).

    Real simulator budget = ``(n_initial + n_iterations) * len(eval_seeds)``,
    matching how the GA/NSGA-II/random-search benchmarks count evaluations
    (SDD-adjacent choice, see ``evolution/benchmark.py``).
    """

    n_initial: int = 8            # size of the random initial design
    n_iterations: int = 16        # real-simulator evaluations chosen by the acquisition function
    eval_seeds: tuple = (1, 2, 3)
    free_genes: tuple = ("stress_level", "maintenance_rate", "repair_rate")
    seed: int = 11
    xi: float = 0.01              # Expected Improvement exploration margin
    candidate_pool_size: int = 500  # random candidates the acquisition function is scored over
    #: >1 expands every free gene in SCHEDULABLE_PARAMETERS into one gene per
    #: phase (a protocol search, docs/MODEL.md §2.1); 1 = constant genes.
    schedule_phases: int = 1
    weights: FitnessWeights = field(default_factory=FitnessWeights)

    def validate(self) -> "ActiveLearningConfig":
        if self.n_initial < 2:
            raise ConfigError("n_initial must be >= 2")
        _validate_schedule_phases(self.schedule_phases)
        if self.n_iterations < 0:
            raise ConfigError("n_iterations must be >= 0")
        if self.candidate_pool_size < 10:
            raise ConfigError("candidate_pool_size must be >= 10")
        if self.xi < 0:
            raise ConfigError("xi must be >= 0")
        for g in self.free_genes:
            if g not in EVOLVABLE_PARAMETERS:
                raise ConfigError(f"{g} is not an evolvable parameter")
        if not self.free_genes:
            raise ConfigError("at least one free gene is required")
        if not self.eval_seeds:
            raise ConfigError("eval_seeds must not be empty")
        return self

    def to_dict(self) -> Dict[str, Any]:
        d = asdict(self)
        d["eval_seeds"] = list(self.eval_seeds)
        d["free_genes"] = list(self.free_genes)
        return d

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "ActiveLearningConfig":
        data = dict(data)
        weights = data.pop("weights", None)
        allowed = {f.name for f in fields(cls)}
        clean = {k: v for k, v in data.items() if k in allowed}
        if "eval_seeds" in clean:
            clean["eval_seeds"] = tuple(int(s) for s in clean["eval_seeds"])
        if "free_genes" in clean:
            clean["free_genes"] = tuple(clean["free_genes"])
        cfg = cls(**clean)
        if weights is not None:
            cfg.weights = FitnessWeights.from_dict(weights)
        return cfg


@dataclass
class SensitivityConfig:
    """One-at-a-time (OAT) sensitivity analysis settings (tornado chart)."""

    parameters: tuple = EVOLVABLE_PARAMETERS
    perturbation_fraction: float = 0.10  # +/- fraction of the PARAMETER_BOUNDS range
    eval_seeds: tuple = (1, 2, 3)
    weights: FitnessWeights = field(default_factory=FitnessWeights)

    def validate(self) -> "SensitivityConfig":
        if not (0.0 < self.perturbation_fraction <= 0.5):
            raise ConfigError("perturbation_fraction must be in (0, 0.5]")
        if not self.parameters:
            raise ConfigError("at least one parameter is required")
        for p in self.parameters:
            if p not in EVOLVABLE_PARAMETERS:
                raise ConfigError(f"{p} is not an evolvable parameter")
        if not self.eval_seeds:
            raise ConfigError("eval_seeds must not be empty")
        return self

    def to_dict(self) -> Dict[str, Any]:
        d = asdict(self)
        d["parameters"] = list(self.parameters)
        d["eval_seeds"] = list(self.eval_seeds)
        return d

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "SensitivityConfig":
        data = dict(data)
        weights = data.pop("weights", None)
        allowed = {f.name for f in fields(cls)}
        clean = {k: v for k, v in data.items() if k in allowed}
        if "parameters" in clean:
            clean["parameters"] = tuple(clean["parameters"])
        if "eval_seeds" in clean:
            clean["eval_seeds"] = tuple(int(s) for s in clean["eval_seeds"])
        cfg = cls(**clean)
        if weights is not None:
            cfg.weights = FitnessWeights.from_dict(weights)
        return cfg
