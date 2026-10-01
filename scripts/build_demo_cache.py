"""Build the static demo cache served to anonymous / free users.

Every scenario below is executed against the REAL backend (FastAPI app via
``TestClient``) and the response body the live API returns is stored as JSON
under ``frontend/public/demo-cache/<feature>/<id>.json`` plus an ``index.json``.
The React result views can therefore render a cached scenario unchanged.

Usage::

    python scripts/build_demo_cache.py            # (re)build in place
    python scripts/build_demo_cache.py --out DIR  # build somewhere else
    python scripts/build_demo_cache.py --only simulate,compare

Determinism: all seeds are fixed in the requests; the only non-reproducible
values the live API emits (wall-clock ``runtime_seconds``, ledger ``run_id`` /
``created_at``, absolute artifact paths, host/environment strings) are
normalised, floats are rounded to 5 significant digits and the files are
written with sorted keys, so running the script twice yields identical bytes.
``index.json`` keeps its previous ``generated_at`` when no file content changed.

See docs/DEMO_CACHE.md.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
import shutil
import sys
import tempfile
import time
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUT = ROOT / "frontend" / "public" / "demo-cache"

INDEX_VERSION = 1
SIG_DIGITS = 5
FIXED_LEDGER_EPOCH = "2026-01-01T00:00:00"

DISCLAIMER = (
    "Precomputed example run of the Telomere Lab model with fixed seeds -- not patient data and not a "
    "prediction. Illustrative model behaviour only; see the Scientific scope page."
)

# --------------------------------------------------------------------------- #
# shared model bases
# --------------------------------------------------------------------------- #
FAST = dict(population_size=60, carrying_capacity=240, telomeres_per_cell=16)

STRESSED = dict(  # the "stressed culture" used by configs/evolution.yaml, sized down for the demo
    initial_length=7500.0, initial_length_sd=800.0, shortening_rate=55.0, stress_level=0.60,
    stress_sensitivity=100.0, maintenance_rate=0.10, maintenance_max_gain=120.0, repair_rate=0.15,
    senescence_threshold=3000.0, noise_sd=30.0, senescent_death_rate=0.03, cycles=100, seed=42,
    **FAST,
)

WEIGHTS_DEFAULT = dict(w_survival=0.40, w_reserve=0.30, w_senescence=0.20, w_instability=0.10, w_cost=0.30)


def _model(**over: Any) -> Dict[str, Any]:
    return {**STRESSED, **over}


def _sim_cfg(**over: Any) -> Dict[str, Any]:
    """Full-size (default 100/400/32) single-run config for the Simulate page."""
    base = dict(population_size=100, carrying_capacity=400, telomeres_per_cell=32, cycles=150, seed=42)
    base.update(over)
    return base


# --------------------------------------------------------------------------- #
# scenario table
# --------------------------------------------------------------------------- #
# kind: "sync" -> one POST returning the response; "job" -> POST then poll /api/jobs/{id}, store `.result`.
# endpoint is informational for the frontend (which result view / request builder applies).
SCENARIOS: List[Dict[str, Any]] = []


def add(feature: str, id: str, title: str, description: str, endpoint: str, kind: str, request: Any,
        model: Optional[Dict[str, Any]] = None, special: Optional[str] = None) -> None:
    SCENARIOS.append(dict(feature=feature, id=id, title=title, description=description, endpoint=endpoint,
                          kind=kind, request=request, model=model, special=special))


# ---- simulate -------------------------------------------------------------- #
_c = _sim_cfg(initial_length=7500.0, stress_level=0.20, maintenance_rate=0.0, repair_rate=0.4,
              hours_per_cycle=24.0, record_distribution_every=25)
add("simulate", "fibroblast-aging", "Normal fibroblast aging (no telomerase)",
    "A culture of telomerase-negative cells with mild stress and no maintenance: telomeres shorten with every "
    "division until the shortest one crosses the senescence threshold and the culture stops growing "
    "(a replicative-senescence curve). " + DISCLAIMER,
    "/simulate", "sync", {"config": _c, "provenance": "demo-cache: fibroblast-aging"}, _c)

_c = _sim_cfg(stress_level=0.90, repair_rate=0.10, maintenance_rate=0.10, replication_error_rate=0.002,
              oxidative_mutation_sensitivity=0.01, checkpoint_strength=0.30, mutation_threshold=0.25,
              repair_rate_mutation_sigma=0.02, record_distribution_every=25)
add("simulate", "high-oxidative-stress", "High oxidative stress, weak repair",
    "High abstract stress with low repair accelerates telomere loss and mutation-burden accumulation; an "
    "apoptosis checkpoint culls high-burden cells and each cell's repair rate drifts heritably. Shows how "
    "the optional genome-stability mechanisms (docs/MODEL.md 2.3, 2.2.1) shape the trajectory. " + DISCLAIMER,
    "/simulate", "sync", {"config": _c, "provenance": "demo-cache: high-oxidative-stress"}, _c)

_c = _sim_cfg(stress_level=0.20, maintenance_rate=0.90, repair_rate=0.5, cycles=200, record_distribution_every=50)
add("simulate", "telomerase-positive", "Telomerase-positive / immortalised-like culture",
    "A high maintenance (telomerase-like) rate offsets end-replication loss, so telomeres are held above the "
    "senescence threshold and the culture keeps proliferating to the carrying capacity. The maintenance term "
    "is a phenomenological gain, not a kinetic model of telomerase. " + DISCLAIMER,
    "/simulate", "sync", {"config": _c, "provenance": "demo-cache: telomerase-positive"}, _c)

_c = _sim_cfg(stress_level=0.60, maintenance_rate=0.10, repair_rate=0.15, record_distribution_every=25,
              subclones=[{"name": "resilient", "initial_fraction": 0.5,
                          "overrides": {"maintenance_rate": 0.6, "repair_rate": 0.6}},
                         {"name": "fragile", "initial_fraction": 0.5, "overrides": {}}])
add("simulate", "subclone-competition", "Sub-clone competition (resilient vs fragile)",
    "Two genetically distinct sub-clones share one culture and one carrying capacity. The clone with higher "
    "maintenance and repair keeps dividing after the other senesces and takes over the culture "
    "(docs/MODEL.md 2.2). A mechanism illustration, not a calibrated claim. " + DISCLAIMER,
    "/simulate", "sync", {"config": _c, "provenance": "demo-cache: subclone-competition"}, _c)

_c = _sim_cfg(stress_level=0.30, maintenance_rate=0.0, repair_rate=0.4, hours_per_cycle=24.0,
              initial_within_cell_sd=300.0, shortening_rate_cv=0.30, senescence_softness_bp=400.0,
              random_arrest_rate=0.005, record_distribution_every=25)
add("simulate", "stochastic-senescence", "Stochastic senescence and heterogeneous shortening",
    "The newer stochastic mechanisms switched on together: a logistic (soft) senescence hazard, a small "
    "length-independent arrest rate, a heritable per-cell shortening-rate CV and a within-cell length spread "
    "(docs/MODEL.md 2.5-2.8). Cells enter senescence at different times, unlike the hard-threshold default. "
    + DISCLAIMER,
    "/simulate", "sync", {"config": _c, "provenance": "demo-cache: stochastic-senescence"}, _c)

_c = _sim_cfg(stress_level=0.90, maintenance_rate=0.10, repair_rate=0.15, cycles=120,
              record_distribution_every=20,
              schedule={"phases": 6, "values": {"stress_level": [0.90, 0.30, 0.90, 0.30, 0.90, 0.30]}})
add("simulate", "alternating-stress-protocol", "Time-varying stress protocol",
    "Stress alternates between a high and a low phase over six equal blocks (time-averaged stress 0.6), "
    "showing the scheduled-intervention feature of the model (docs/MODEL.md 2.1). A model scenario, not a "
    "clinical regimen. " + DISCLAIMER,
    "/simulate", "sync", {"config": _c, "provenance": "demo-cache: alternating-stress-protocol"}, _c)

# ---- ensemble (lives under the simulate feature) --------------------------- #
for _id, _title, _desc, _over in [
    ("ensemble-fibroblast-aging", "Ensemble: fibroblast aging across 8 seeds",
     "The same no-telomerase culture re-run with eight different random seeds, showing the run-to-run spread "
     "(median and bands) in length, population size and senescent fraction.",
     dict(stress_level=0.20, maintenance_rate=0.0, repair_rate=0.4)),
    ("ensemble-telomerase-positive", "Ensemble: telomerase-positive culture across 8 seeds",
     "Eight seeds of a high-maintenance culture: the bands stay tight because maintenance keeps telomeres "
     "above the threshold in every replicate.",
     dict(stress_level=0.20, maintenance_rate=0.90, repair_rate=0.5)),
    ("ensemble-stochastic-senescence", "Ensemble: stochastic senescence across 8 seeds",
     "Soft senescence hazard plus heterogeneous shortening rates widen the across-seed spread compared with "
     "the hard-threshold default.",
     dict(stress_level=0.30, maintenance_rate=0.0, repair_rate=0.4, initial_within_cell_sd=300.0,
          shortening_rate_cv=0.30, senescence_softness_bp=400.0, random_arrest_rate=0.005)),
]:
    _c = _sim_cfg(cycles=120, population_size=80, carrying_capacity=300, telomeres_per_cell=16, **_over)
    add("simulate", _id, _title, _desc + " " + DISCLAIMER, "/simulate/ensemble", "sync",
        {"config": _c, "n_seeds": 8, "base_seed": 100}, _c)

# ---- evolve ---------------------------------------------------------------- #
_ga = dict(population_size=16, generations=10, elite_fraction=0.10, mutation_rate=0.30, mutation_sigma=0.15,
           crossover_rate=0.70, crossover_kind="uniform", tournament_size=3, seed=7, eval_seeds=[1, 2],
           free_genes=["stress_level", "maintenance_rate", "repair_rate"], schedule_phases=1,
           early_stopping_patience=0, checkpoint_every=5, weights=WEIGHTS_DEFAULT)
_c = _model()
add("evolve", "stressed-culture-balanced", "Genetic algorithm on a stressed culture (balanced objective)",
    "A small genetic algorithm searches stress, maintenance and repair settings for a stressed baseline "
    "culture under the default weighted objective, and reports how the best candidate compares with the "
    "baseline. It is a search over a simulator, not a recommendation. " + DISCLAIMER,
    "/evolve", "job", {"model": _c, "evolution": _ga, "notes": "demo-cache"}, _c)
_c = _model()
add("evolve", "survival-heavy-low-cost", "Genetic algorithm weighted toward survival, cheap interventions",
    "Same search, but the objective rewards proliferative survival and penalises intervention cost more "
    "strongly, so the optimiser trades off how much maintenance and repair it is willing to apply. " + DISCLAIMER,
    "/evolve", "job", {"model": _c, "evolution": {**_ga, "seed": 11, "weights": dict(
        w_survival=0.60, w_reserve=0.20, w_senescence=0.10, w_instability=0.05, w_cost=0.60)},
                       "notes": "demo-cache"}, _c)
_c = _model(stress_level=0.5, cycles=90)
add("evolve", "three-phase-protocol", "Protocol search with three phases",
    "Each free gene is split into three consecutive phases (schedule_phases = 3), so the genetic algorithm "
    "searches a time-varying protocol rather than a constant setting (docs/MODEL.md 2.1). " + DISCLAIMER,
    "/evolve", "job", {"model": _c, "evolution": {**_ga, "schedule_phases": 3, "generations": 8, "seed": 5},
                       "notes": "demo-cache"}, _c)

# ---- pareto ---------------------------------------------------------------- #
_mo = dict(population_size=16, generations=10, mutation_rate=0.30, mutation_sigma=0.15, crossover_rate=0.80,
           crossover_kind="uniform", seed=7, eval_seeds=[42],
           free_genes=["stress_level", "maintenance_rate", "repair_rate"], objectives=["survival", "cost"],
           checkpoint_every=5, schedule_phases=1, weights=WEIGHTS_DEFAULT)
_c = _model()
add("pareto", "survival-vs-cost", "Pareto front: survival vs intervention cost",
    "NSGA-II returns the whole trade-off curve between proliferative survival (maximise) and intervention "
    "cost (minimise) instead of a single weighted winner. " + DISCLAIMER,
    "/pareto", "job", {"model": _c, "multiobjective": _mo, "notes": "demo-cache"}, _c)
_c = _model()
add("pareto", "survival-reserve-senescence", "Three objectives: survival, reserve, senescence",
    "A three-objective front over survival, telomere reserve and final senescent fraction, showing which "
    "objectives conflict in this model. " + DISCLAIMER,
    "/pareto", "job", {"model": _c, "multiobjective": {**_mo, "objectives": ["survival", "reserve", "senescence"],
                                                       "seed": 3}, "notes": "demo-cache"}, _c)
_c = _model(replication_error_rate=0.002, oxidative_mutation_sensitivity=0.01, checkpoint_strength=0.3,
            mutation_threshold=0.25)
add("pareto", "survival-vs-genome-instability", "Survival vs genome instability",
    "With the genome-stability mechanism enabled, the front trades proliferative survival against the "
    "fraction of cells over the mutation threshold. " + DISCLAIMER,
    "/pareto", "job", {"model": _c, "multiobjective": {**_mo, "objectives": ["survival", "genome_instability"],
                                                       "seed": 9}, "notes": "demo-cache"}, _c)

# ---- sensitivity ----------------------------------------------------------- #
_sens = dict(parameters=["initial_length", "shortening_rate", "stress_level", "maintenance_rate", "repair_rate",
                         "senescence_threshold"], perturbation_fraction=0.10, eval_seeds=[1, 2, 3],
             weights=WEIGHTS_DEFAULT)
_c = _model()
add("sensitivity", "stressed-baseline", "One-at-a-time sensitivity around a stressed baseline",
    "Each parameter is nudged by 10% of its allowed range, one at a time, and the change in fitness is "
    "ranked (a tornado chart). It shows which model inputs matter most near this baseline, not which "
    "biological factors matter in vivo. " + DISCLAIMER,
    "/sensitivity", "job", {"model": _c, "sensitivity": _sens, "notes": "demo-cache"}, _c)
_c = _model(stress_level=0.2, maintenance_rate=0.3, repair_rate=0.5)
add("sensitivity", "mild-baseline", "Sensitivity around a mild, well-maintained baseline",
    "The same analysis around a low-stress, moderately maintained culture, where the ranking of "
    "influential parameters differs from the stressed case. " + DISCLAIMER,
    "/sensitivity", "job", {"model": _c, "sensitivity": _sens, "notes": "demo-cache"}, _c)
_c = _model(replication_error_rate=0.002, oxidative_mutation_sensitivity=0.01, checkpoint_strength=0.3,
            mutation_threshold=0.25)
add("sensitivity", "genome-stability-weighted", "Sensitivity with genome stability in the objective",
    "Genome stability is added to the objective, so parameters that change mutation burden show up in the "
    "ranking alongside telomere parameters. " + DISCLAIMER,
    "/sensitivity", "job", {"model": _c, "sensitivity": {**_sens, "parameters": _sens["parameters"] + [
        "replication_error_rate", "oxidative_mutation_sensitivity", "checkpoint_strength"], "weights": {**WEIGHTS_DEFAULT, "w_genome_instability": 0.3}},
                            "notes": "demo-cache"}, _c)

# ---- gxe ------------------------------------------------------------------- #
_c = _model(cycles=90)
add("gxe", "maintenance-by-stress", "Genotype x environment: maintenance vs stress",
    "Three maintenance 'genotypes' are each run at three stress 'environments' as isolated simulations; "
    "crossing lines in the reaction norm mean the best genotype depends on the environment (re-ranking). "
    "'Genotype' and 'environment' are model parameter bundles. " + DISCLAIMER,
    "/gxe", "job", {"model": _c, "gxe": {
        "genotypes": [{"name": "low-maintenance", "overrides": {"maintenance_rate": 0.05, "repair_rate": 0.1}},
                      {"name": "mid-maintenance", "overrides": {"maintenance_rate": 0.4, "repair_rate": 0.3}},
                      {"name": "high-maintenance", "overrides": {"maintenance_rate": 0.9, "repair_rate": 0.6}}],
        "environments": [{"name": "low-stress", "overrides": {"stress_level": 0.1}},
                         {"name": "medium-stress", "overrides": {"stress_level": 0.5}},
                         {"name": "high-stress", "overrides": {"stress_level": 0.9}}],
        "eval_seeds": [1, 2], "weights": WEIGHTS_DEFAULT}, "notes": "demo-cache"}, _c)
_c = _model(cycles=90, replication_error_rate=0.002, oxidative_mutation_sensitivity=0.01,
            mutation_threshold=0.25, checkpoint_strength=0.3)
add("gxe", "checkpoint-by-stress", "Genotype x environment: apoptosis checkpoint vs stress",
    "Checkpoint-competent and checkpoint-deficient genotypes across stress levels, scored with genome "
    "stability in the objective. " + DISCLAIMER,
    "/gxe", "job", {"model": _c, "gxe": {
        "genotypes": [{"name": "checkpoint-intact", "overrides": {"checkpoint_strength": 0.5}},
                      {"name": "checkpoint-deficient", "overrides": {"checkpoint_strength": 0.0}}],
        "environments": [{"name": "low-stress", "overrides": {"stress_level": 0.2}},
                         {"name": "high-stress", "overrides": {"stress_level": 0.8}}],
        "eval_seeds": [1, 2], "weights": {**WEIGHTS_DEFAULT, "w_genome_instability": 0.4}}, "notes": "demo-cache"}, _c)
_c = _model(cycles=90)
add("gxe", "repair-by-stress", "Genotype x environment: repair vs stress",
    "Low, medium and high repair genotypes across two stress levels; a small grid that is quick to read. "
    + DISCLAIMER,
    "/gxe", "job", {"model": _c, "gxe": {
        "genotypes": [{"name": "low-repair", "overrides": {"repair_rate": 0.05}},
                      {"name": "mid-repair", "overrides": {"repair_rate": 0.4}},
                      {"name": "high-repair", "overrides": {"repair_rate": 0.9}}],
        "environments": [{"name": "mild", "overrides": {"stress_level": 0.3}},
                         {"name": "harsh", "overrides": {"stress_level": 0.85}}],
        "eval_seeds": [1, 2, 3], "weights": WEIGHTS_DEFAULT}, "notes": "demo-cache"}, _c)

# ---- active learning ------------------------------------------------------- #
_al = dict(n_initial=6, n_iterations=8, eval_seeds=[1, 2], free_genes=["stress_level", "maintenance_rate",
           "repair_rate"], schedule_phases=1, seed=11, xi=0.01, candidate_pool_size=200, weights=WEIGHTS_DEFAULT)
_c = _model()
add("active-learning", "stressed-culture", "Active learning on a stressed culture",
    "A Gaussian-process surrogate and Expected Improvement pick which configuration to simulate next, "
    "reaching good fitness with few real simulator runs. A small budget is used here for a quick demo. "
    + DISCLAIMER,
    "/active-learning", "job", {"model": _c, "active_learning": _al, "notes": "demo-cache"}, _c)
_c = _model(stress_level=0.8, repair_rate=0.1)
add("active-learning", "harsh-environment", "Active learning in a harsh environment",
    "Same method on a high-stress, low-repair baseline, where there is more room for the interventions to "
    "matter. " + DISCLAIMER,
    "/active-learning", "job", {"model": _c, "active_learning": {**_al, "seed": 21}, "notes": "demo-cache"}, _c)
_c = _model(cycles=90)
add("active-learning", "three-phase-protocol", "Active learning of a two-phase protocol",
    "The surrogate searches a two-phase time-varying protocol (schedule_phases = 2) rather than constant "
    "settings. " + DISCLAIMER,
    "/active-learning", "job", {"model": _c, "active_learning": {**_al, "schedule_phases": 2, "seed": 5,
                                                                 "n_iterations": 6}, "notes": "demo-cache"}, _c)

# ---- compare --------------------------------------------------------------- #
_base = dict(**FAST, cycles=120, seed=42)
add("compare", "stress-levels", "Compare: low, medium and high stress",
    "Three cultures that differ only in stress level, run with a common seed so differences are "
    "attributable to the parameter. Deltas are relative to the first scenario. " + DISCLAIMER,
    "/compare", "sync", {"scenarios": [
        {"name": "low stress", "config": {**_base, "stress_level": 0.1, "maintenance_rate": 0.1, "repair_rate": 0.3}},
        {"name": "medium stress", "config": {**_base, "stress_level": 0.5, "maintenance_rate": 0.1, "repair_rate": 0.3}},
        {"name": "high stress", "config": {**_base, "stress_level": 0.9, "maintenance_rate": 0.1, "repair_rate": 0.3}},
    ], "seed": 42}, _base)
add("compare", "baseline-vs-interventions", "Compare: baseline vs maintenance vs repair",
    "A stressed baseline against a maintenance-only, a repair-only and a combined intervention, "
    "all with the same seed. " + DISCLAIMER,
    "/compare", "sync", {"scenarios": [
        {"name": "baseline", "config": {**_base, "stress_level": 0.6, "maintenance_rate": 0.05, "repair_rate": 0.1}},
        {"name": "maintenance only", "config": {**_base, "stress_level": 0.6, "maintenance_rate": 0.7, "repair_rate": 0.1}},
        {"name": "repair only", "config": {**_base, "stress_level": 0.6, "maintenance_rate": 0.05, "repair_rate": 0.8}},
        {"name": "combined", "config": {**_base, "stress_level": 0.6, "maintenance_rate": 0.7, "repair_rate": 0.8}},
    ], "seed": 42}, _base)
add("compare", "organ-chip-presets", "Compare: illustrative organ-on-chip presets",
    "Four illustrative organ-chip culture-condition presets mapped to model parameters through the "
    "documented (assumption-based) chip adapter. The presets are not measurements of any real chip. "
    + DISCLAIMER,
    "/compare", "sync", {"scenarios": [
        {"name": "static well (control)", "chip": {"flow_rate": 0.0, "oxygen_tension": 0.21, "nutrient_state": 0.6,
                                                    "stress_exposure": 0.3, "culture_days": 60.0, "doubling_time_days": 1.0}},
        {"name": "liver-chip-like", "chip": {"flow_rate": 0.3, "oxygen_tension": 0.05, "nutrient_state": 0.9,
                                              "stress_exposure": 0.1, "culture_days": 60.0, "doubling_time_days": 1.0}},
        {"name": "injury-stress-like", "chip": {"flow_rate": 0.5, "oxygen_tension": 0.21, "nutrient_state": 0.7,
                                                 "stress_exposure": 0.8, "culture_days": 60.0, "doubling_time_days": 1.0}},
    ], "seed": 42, "base_config": _base}, _base)
add("compare", "mechanisms", "Compare: model mechanisms on the same culture",
    "The same culture with the hard senescence threshold, the soft (logistic) hazard and heterogeneous "
    "shortening rates, to see what each optional mechanism changes. " + DISCLAIMER,
    "/compare", "sync", {"scenarios": [
        {"name": "hard threshold", "config": {**_base, "stress_level": 0.3, "maintenance_rate": 0.0, "repair_rate": 0.4}},
        {"name": "soft hazard", "config": {**_base, "stress_level": 0.3, "maintenance_rate": 0.0, "repair_rate": 0.4,
                                           "senescence_softness_bp": 400.0}},
        {"name": "heterogeneous shortening", "config": {**_base, "stress_level": 0.3, "maintenance_rate": 0.0,
                                                         "repair_rate": 0.4, "shortening_rate_cv": 0.3}},
    ], "seed": 42}, _base)

# ---- genome ---------------------------------------------------------------- #
add("genome", "toy-genome", "Toy genome: genes and example mutations",
    "The synthetic DNA -> RNA -> protein layer: the toy genes with their transcripts, proteins and "
    "substitution profiles, plus example point mutations classified as silent, missense or nonsense. "
    "Synthetic sequences only. " + DISCLAIMER,
    "/sequence/genome + /sequence/mutate", "special", {"mutations": []}, None, special="genome")
for _id, _title, _desc, _over in [
    ("lineage-default", "Normal vs damaged lineage (checkpoint + repair genes lost)",
     "A normal lineage and one that starts with loss-of-function in the toy checkpoint and repair genes: "
     "the damaged lineage accumulates mutation burden faster.", {}),
    ("lineage-checkpoint-only", "Lineage with only the checkpoint gene damaged",
     "Only TOY-CHK is lost, isolating the contribution of the checkpoint to burden and survival.",
     dict(damaged_genes=["TOY-CHK"], seed=2)),
    ("lineage-high-mutation", "Lineage under a high mutation rate",
     "A five-fold higher base mutation rate, comparing how quickly a normal and a damaged lineage cross the "
     "burden threshold.", dict(mutation_rate=1e-3, seed=3)),
]:
    add("genome", _id, _title, _desc + " Toy model; " + DISCLAIMER, "/sequence/lineage", "sync",
        {"cells": 300, "generations": 50, "mutation_rate": 2e-4, "repair_penalty": 10.0, "missense_lof": 0.3,
         "burden_threshold": 4, "damaged_genes": ["TOY-CHK", "TOY-REP"], "seed": 1, **_over}, None)

# ---- experiments (snapshot of the ledger written by the runs above) -------- #
add("experiments", "demo-ledger", "Example experiment ledger",
    "A read-only snapshot of the reproducibility ledger produced by building this demo cache: one entry per "
    "recorded precomputed run, with the full record (configuration, hash, versions, terminal metrics). "
    "Run ids, timestamps and file paths are normalised. Artifact downloads are not available in the demo. "
    + DISCLAIMER,
    "/experiments", "special", {"mine": False}, None, special="ledger")


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #
def _round_sig(obj: Any) -> Any:
    if isinstance(obj, bool) or obj is None or isinstance(obj, (int, str)):
        return obj
    if isinstance(obj, float):
        if obj != obj or obj in (float("inf"), float("-inf")):
            return None
        if obj == 0.0:
            return 0.0
        r = float(f"{obj:.{SIG_DIGITS}g}")
        return r
    if isinstance(obj, list):
        return [_round_sig(x) for x in obj]
    if isinstance(obj, dict):
        return {k: _round_sig(v) for k, v in obj.items()}
    return obj


_WALL_CLOCK_KEYS = ("runtime_seconds", "elapsed_seconds")


def _scrub_volatile(obj: Any) -> Any:
    """Zero wall-clock durations (runtime_seconds, per-generation elapsed_seconds): they differ run to run."""
    if isinstance(obj, dict):
        return {k: (0.0 if k in _WALL_CLOCK_KEYS and isinstance(v, (int, float)) else _scrub_volatile(v))
                for k, v in obj.items()}
    if isinstance(obj, list):
        return [_scrub_volatile(x) for x in obj]
    return obj


def _dump(obj: Any) -> bytes:
    text = json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
    return (text + "\n").encode("utf-8")


def engine_version() -> str:
    from telomere_lab import __version__
    from telomere_lab.schemas import MODEL_VERSION, OPTIMIZER_VERSION
    return f"telomere_lab {__version__} (model {MODEL_VERSION}, optimizer {OPTIMIZER_VERSION})"


def _config_hash(model: Optional[Dict[str, Any]]) -> str:
    if model is None:
        return "n/a"
    from telomere_lab.schemas import ModelConfig
    return ModelConfig.from_dict(copy.deepcopy(model)).validate().config_hash()


def _seed_of(sc: Dict[str, Any]) -> int:
    req = sc["request"]
    for path in (("config", "seed"), ("model", "seed"), ("seed",), ("base_seed",)):
        cur: Any = req
        ok = True
        for p in path:
            if isinstance(cur, dict) and p in cur and cur[p] is not None:
                cur = cur[p]
            else:
                ok = False
                break
        if ok and isinstance(cur, int):
            return int(cur)
    return 0


# --------------------------------------------------------------------------- #
# live engine access (FastAPI TestClient against backend.main:app)
# --------------------------------------------------------------------------- #
class Engine:
    """A throwaway backend: temp SQLite DB, temp experiment ledger, a verified throwaway user."""

    PASSWORD = "Demo-Cache-Build-1x!"

    def __init__(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="telomere-demo-cache-"))
        self._env_backup = {k: os.environ.get(k) for k in (
            "DATABASE_URL", "TELOMERE_DISABLE_LIMITS", "TELOMERE_REQUIRE_PRO", "TELOMERE_RATE_LIMIT",
            "RESEND_API_KEY", "SECRET_KEY")}
        os.environ["DATABASE_URL"] = "sqlite:///" + (self.tmp / "demo.db").as_posix()
        os.environ["TELOMERE_DISABLE_LIMITS"] = "1"
        os.environ["TELOMERE_REQUIRE_PRO"] = "0"
        os.environ["TELOMERE_RATE_LIMIT"] = "off"
        os.environ.pop("RESEND_API_KEY", None)
        os.environ.setdefault("SECRET_KEY", "demo-cache-build-secret-not-used-in-production")
        for p in (ROOT, ROOT / "src"):
            if str(p) not in sys.path:
                sys.path.insert(0, str(p))

        import telomere_lab.config as cfg
        from telomere_lab import db as _db
        cfg.RUNS_DIR = self.tmp / "experiments" / "runs"
        cfg.RUNS_DIR.mkdir(parents=True, exist_ok=True)
        _db.reset_engine()
        self._db = _db

        from fastapi.testclient import TestClient
        from backend.main import app
        self.client = TestClient(app)
        self.headers = self._login()

    def _login(self) -> Dict[str, str]:
        c = self.client
        r = c.post("/api/auth/register", json={"username": "demo_cache_builder", "email": "builder@example.invalid",
                                               "password": self.PASSWORD})
        r.raise_for_status()
        link = r.json().get("dev_verification_link")
        if not link:
            raise RuntimeError("email is configured; refusing to send mail from the cache builder")
        token = link.split("token=", 1)[1]
        c.get("/api/auth/verify", params={"token": token}).raise_for_status()
        r = c.post("/api/auth/login", json={"username": "demo_cache_builder", "password": self.PASSWORD})
        r.raise_for_status()
        return {"Authorization": "Bearer " + r.json()["access_token"]}

    def close(self) -> None:
        try:
            self._db.reset_engine()
        except Exception:
            pass
        for k, v in self._env_backup.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        shutil.rmtree(self.tmp, ignore_errors=True)

    # ------------------------------------------------------------------ calls
    def post(self, path: str, body: Any) -> Any:
        r = self.client.post("/api" + path, json=body, headers=self.headers)
        if r.status_code >= 400:
            raise RuntimeError(f"POST {path} -> {r.status_code}: {r.text[:500]}")
        return r.json()

    def get(self, path: str, **params: Any) -> Any:
        r = self.client.get("/api" + path, params=params or None, headers=self.headers)
        if r.status_code >= 400:
            raise RuntimeError(f"GET {path} -> {r.status_code}: {r.text[:500]}")
        return r.json()

    def run_job(self, path: str, body: Any, timeout: float = 900.0) -> Any:
        job_id = self.post(path, body)["job_id"]
        t0 = time.time()
        while True:
            st = self.get(f"/jobs/{job_id}")
            if st["status"] == "completed":
                return st["result"]
            if st["status"] in ("failed", "stopped"):
                raise RuntimeError(f"job {path} {st['status']}: {st.get('error')}")
            if time.time() - t0 > timeout:
                raise TimeoutError(f"job {path} did not finish in {timeout}s")
            time.sleep(0.05)

    def run(self, sc: Dict[str, Any]) -> Any:
        """Execute one non-special scenario; returns the live response body."""
        if sc["kind"] == "job":
            return self.run_job(sc["endpoint"], sc["request"])
        return self.post(sc["endpoint"], sc["request"])

    def genome_scenario(self) -> Any:
        from telomere_lab.sequence import build_genome, classify_mutation
        genome = self.get("/sequence/genome")
        lib = build_genome()
        # first example of each effect class (deterministic scan order), chosen with the library,
        # then executed through the API so the stored body is the live one.
        wanted = ["synonymous", "missense", "nonsense", "start_loss", "stop_loss"]
        picks: Dict[str, Dict[str, Any]] = {}
        for g in lib.genes:
            for pos in range(len(g.dna)):
                for alt in "ACGT":
                    if alt == g.dna[pos]:
                        continue
                    eff = classify_mutation(g, pos, alt).effect
                    if eff in wanted and eff not in picks:
                        picks[eff] = {"gene": g.name, "position": pos, "alt": alt}
            if len(picks) == len(wanted):
                break
        reqs = [picks[e] for e in wanted if e in picks]
        outs = [self.post("/sequence/mutate", r) for r in reqs]
        return {"mutations": reqs}, {"genome": genome, "mutations": outs}


# --------------------------------------------------------------------------- #
# ledger normalisation
# --------------------------------------------------------------------------- #
def _normalise_record(rec: Dict[str, Any], demo_id: str, rank: int) -> Dict[str, Any]:
    rec = _scrub_volatile(rec)
    stamp = f"{FIXED_LEDGER_EPOCH[:11]}{rank // 60:02d}:{rank % 60:02d}:00"
    if "created_at" in rec:
        rec["created_at"] = stamp
    if "git_commit" in rec:
        rec["git_commit"] = None
    env = rec.get("environment")
    if isinstance(env, dict):
        rec["environment"] = {k: (v if k in ("package_version", "model_version", "optimizer_version") else None)
                              for k, v in env.items()}
    arts = rec.get("artifacts")
    if isinstance(arts, dict):
        rec["artifacts"] = {k: f"experiments/runs/{demo_id}/{Path(str(v)).name}" for k, v in arts.items()}
    return rec


def _find_run_ids(obj: Any, out: List[str]) -> None:
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k == "run_id" and isinstance(v, str) and v.startswith("TEL-"):
                out.append(v)
            else:
                _find_run_ids(v, out)
    elif isinstance(obj, list):
        for x in obj:
            _find_run_ids(x, out)


def _replace_run_ids(obj: Any, mapping: Dict[str, str]) -> Any:
    if isinstance(obj, dict):
        return {k: _replace_run_ids(v, mapping) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_replace_run_ids(x, mapping) for x in obj]
    if isinstance(obj, str) and obj in mapping:
        return mapping[obj]
    return obj


def demo_run_id(feature: str, sid: str) -> str:
    return f"DEMO-{feature}-{sid}"


# --------------------------------------------------------------------------- #
# main build
# --------------------------------------------------------------------------- #
def normalise_live(feature: str, sid: str, body: Any) -> Any:
    """What a live response becomes in the cache (shared with the tests for the determinism check)."""
    ids: List[str] = []
    _find_run_ids(body, ids)
    mapping = {rid: demo_run_id(feature, sid) for rid in dict.fromkeys(ids)}
    return _round_sig(_scrub_volatile(_replace_run_ids(body, mapping)))


def build(out: Path, only: Optional[List[str]] = None, verbose: bool = True) -> Dict[str, Any]:
    out = Path(out)
    selected = [s for s in SCENARIOS if not only or s["feature"] in only]
    old_index = None
    if (out / "index.json").is_file():
        try:
            old_index = json.loads((out / "index.json").read_text(encoding="utf-8"))
        except Exception:
            old_index = None

    eng = Engine()
    eng_version = engine_version()
    files: Dict[str, bytes] = {}
    entries: Dict[str, List[Dict[str, Any]]] = {}
    run_ids_by_scenario: Dict[str, str] = {}
    try:
        for sc in selected:
            if sc["special"] == "ledger":
                continue
            t0 = time.time()
            if sc["special"] == "genome":
                request, response = eng.genome_scenario()
            else:
                request = sc["request"]
                response = eng.run(sc)
                ids: List[str] = []
                _find_run_ids(response, ids)
                for rid in ids:
                    run_ids_by_scenario[rid] = demo_run_id(sc["feature"], sc["id"])
            response = normalise_live(sc["feature"], sc["id"], response)
            doc = {
                "id": sc["id"], "title": sc["title"], "description": sc["description"], "feature": sc["feature"],
                "endpoint": sc["endpoint"], "request": request, "response": response,
                "meta": {"seed": _seed_of(sc), "engine_version": eng_version,
                         "config_hash": _config_hash(sc["model"])},
            }
            if sc["special"] == "genome":
                doc["meta"]["seed"] = 0
            files[f"{sc['feature']}/{sc['id']}.json"] = _dump(doc)
            if verbose:
                rel_ = f"{sc['feature']}/{sc['id']}.json"
                print(f"  {rel_}: {len(files[rel_]) / 1024:.0f} KB ({time.time() - t0:.1f}s)", flush=True)

        # ledger snapshot -- from the temp ledger, in the order the runs were recorded
        for sc in selected:
            if sc["special"] != "ledger":
                continue
            rows = eng.get("/experiments", mine="false")
            rows = sorted(rows, key=lambda r: r["run_id"])
            details, summaries = {}, []
            for rank, row in enumerate(rows):
                rid = row["run_id"]
                demo = run_ids_by_scenario.get(rid, f"DEMO-extra-{rank}")
                detail = eng.get(f"/experiments/{rid}")
                rec = _normalise_record(detail["record"], demo, rank)
                rec["run_id"] = demo
                detail = {"record": rec, "artifacts": rec.get("artifacts", {})}
                summ = _normalise_record(row, demo, rank)
                summ["run_id"] = demo
                summ["mine"] = False
                summaries.append(summ)
                details[demo] = detail
            order = sorted(range(len(summaries)), key=lambda i: (summaries[i]["created_at"], summaries[i]["run_id"]))
            summaries = [summaries[i] for i in reversed(order)]  # newest first, like the live listing
            response = _round_sig(summaries)
            doc = {
                "id": sc["id"], "title": sc["title"], "description": sc["description"], "feature": sc["feature"],
                "endpoint": sc["endpoint"], "request": sc["request"], "response": response,
                "extra": {"details": _round_sig(details)},
                "meta": {"seed": 0, "engine_version": eng_version, "config_hash": "n/a"},
            }
            files[f"{sc['feature']}/{sc['id']}.json"] = _dump(doc)
            if verbose:
                print(f"  {sc['feature']}/{sc['id']}: {len(summaries)} runs", flush=True)
    finally:
        eng.close()

    # ---- index
    by_feature: Dict[str, List[Dict[str, Any]]] = {}
    for sc in selected:
        rel = f"{sc['feature']}/{sc['id']}.json"
        data = files[rel]
        sha = hashlib.sha256(data).hexdigest()
        by_feature.setdefault(sc["feature"], []).append({
            "id": sc["id"], "title": sc["title"], "description": sc["description"], "file": rel,
            "endpoint": sc["endpoint"], "bytes": len(data), "sha": sha, "version": sha[:10],
        })
    if only and old_index:  # partial rebuild: keep other features as they were
        merged = dict(old_index.get("features", {}))
        merged.update(by_feature)
        by_feature = merged
    index = {"version": INDEX_VERSION, "generated_at": None, "engine_version": eng_version,
             "features": by_feature}
    # keep the old timestamp when nothing changed (idempotent bytes)
    if old_index and {**old_index, "generated_at": None} == index:
        index["generated_at"] = old_index.get("generated_at")
    else:
        index["generated_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

    # ---- write
    out.mkdir(parents=True, exist_ok=True)
    for rel, data in files.items():
        p = out / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        if not p.is_file() or p.read_bytes() != data:
            p.write_bytes(data)
    if not only:  # drop stale scenario files from earlier builds
        keep = set(files) | {"index.json"}
        for p in list(out.rglob("*.json")):
            if p.relative_to(out).as_posix() not in keep:
                p.unlink()
        for d in sorted((x for x in out.iterdir() if x.is_dir()), reverse=True):
            if not any(d.iterdir()):
                d.rmdir()
    idx_bytes = json.dumps(index, indent=1, sort_keys=True, ensure_ascii=False).encode("utf-8") + b"\n"
    ip = out / "index.json"
    if not ip.is_file() or ip.read_bytes() != idx_bytes:
        ip.write_bytes(idx_bytes)
    if verbose:
        total = sum(len(b) for b in files.values())
        print(f"wrote {len(files)} scenario files, {total / 1e6:.2f} MB total -> {out}")
    return index


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--out", default=str(DEFAULT_OUT), help="output directory")
    ap.add_argument("--only", default="", help="comma-separated feature keys to rebuild")
    args = ap.parse_args(argv)
    only = [x.strip() for x in args.only.split(",") if x.strip()] or None
    build(Path(args.out), only)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
