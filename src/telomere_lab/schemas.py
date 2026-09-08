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
from dataclasses import asdict, dataclass, field, fields
from typing import Any, Dict, Optional

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
}

#: The genes the evolutionary optimizer is allowed to touch (SDD §12).
EVOLVABLE_PARAMETERS = (
    "initial_length",
    "shortening_rate",
    "stress_level",
    "maintenance_rate",
    "repair_rate",
    "senescence_threshold",
)


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

    # --- run control -------------------------------------------------------
    cycles: int = 120
    seed: int = 42
    record_distribution_every: int = 0  # 0 = only final distribution

    def validate(self) -> "ModelConfig":
        for name, (lo, hi, *_rest) in PARAMETER_BOUNDS.items():
            value = getattr(self, name)
            if not np.isfinite(value):
                raise ConfigError(f"{name} must be finite, got {value!r}")
            if not (lo <= value <= hi):
                raise ConfigError(f"{name}={value} outside [{lo}, {hi}]")
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

    # --- helpers -------------------------------------------------------------
    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "ModelConfig":
        allowed = {f.name for f in fields(cls)}
        clean = {k: v for k, v in data.items() if k in allowed}
        cfg = cls(**clean)
        # coerce ints that may arrive as floats from YAML / genomes
        cfg.population_size = int(cfg.population_size)
        cfg.carrying_capacity = int(cfg.carrying_capacity)
        cfg.telomeres_per_cell = int(cfg.telomeres_per_cell)
        cfg.cycles = int(cfg.cycles)
        cfg.seed = int(cfg.seed)
        cfg.record_distribution_every = int(cfg.record_distribution_every)
        return cfg

    def replace(self, **changes: Any) -> "ModelConfig":
        data = self.to_dict()
        data.update(changes)
        return ModelConfig.from_dict(data)

    def config_hash(self) -> str:
        """Stable hash of every field *except* the seed (SDD §19 cache key)."""
        data = self.to_dict()
        data.pop("seed", None)
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
    terminal_metrics: Dict[str, float] = field(default_factory=dict)
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

    def to_dict(self) -> Dict[str, float]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "FitnessWeights":
        allowed = {f.name for f in fields(cls)}
        return cls(**{k: float(v) for k, v in data.items() if k in allowed})


#: Objectives available to the multi-objective optimizer: name -> (direction, description)
OBJECTIVES: Dict[str, tuple] = {
    "survival": ("max", "normalised proliferative-cell AUC"),
    "reserve": ("max", "normalised shortest-telomere reserve at the end"),
    "senescence": ("min", "final senescent fraction"),
    "instability": ("min", "final length CV, scaled"),
    "cost": ("min", "intervention cost ½(maintenance² + repair²)"),
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
    weights: FitnessWeights = field(default_factory=FitnessWeights)  # scalar fitness for reference only

    def validate(self) -> "MultiObjectiveConfig":
        if self.population_size < 4 or self.population_size % 2:
            raise ConfigError("multi-objective population_size must be even and >= 4")
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
    eval_seeds: tuple = (42,)            # simulator seeds averaged per candidate
    free_genes: tuple = ("stress_level", "maintenance_rate", "repair_rate")
    early_stopping_patience: int = 0     # 0 = disabled
    early_stopping_tol: float = 1e-4
    checkpoint_every: int = 5
    weights: FitnessWeights = field(default_factory=FitnessWeights)

    def validate(self) -> "EvolutionConfig":
        if self.population_size < 4:
            raise ConfigError("evolution population_size must be >= 4")
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
