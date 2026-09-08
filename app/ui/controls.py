"""Widget groups shared by the pages. Every control reads its range from
``PARAMETER_BOUNDS`` so the GUI and the optimizer can never disagree."""

from __future__ import annotations

from typing import Dict, Optional

import streamlit as st

from telomere_lab.adapters.chip import ChipConditions, chip_to_model_params
from telomere_lab.schemas import (
    EVOLVABLE_PARAMETERS,
    PARAMETER_BOUNDS,
    EvolutionConfig,
    FitnessWeights,
    ModelConfig,
)


def _slider(name: str, value: float, key_prefix: str, step: Optional[float] = None,
            kb: bool = False) -> float:
    lo, hi, unit, label, help_text = PARAMETER_BOUNDS[name]
    if kb:  # show bp parameters in kb for readability
        v = st.slider(f"{label} (kb)", lo / 1000, hi / 1000, float(value) / 1000,
                      step=step or 0.1, help=help_text, key=f"{key_prefix}_{name}")
        return float(v) * 1000
    if step is None:
        step = 0.01 if hi - lo <= 2 else 1.0
    return float(st.slider(f"{label} ({unit})", float(lo), float(hi), float(value),
                           step=step, help=help_text, key=f"{key_prefix}_{name}"))


def model_controls(defaults: ModelConfig, key_prefix: str = "sim",
                   advanced: bool = True) -> ModelConfig:
    """Render the parameter sliders and return a validated ``ModelConfig``."""
    st.markdown("**Initial conditions**")
    initial_length = _slider("initial_length", defaults.initial_length, key_prefix, kb=True)
    threshold = _slider("senescence_threshold", defaults.senescence_threshold, key_prefix, kb=True)
    if threshold >= initial_length:
        st.warning("Senescence threshold must be below the initial length; clamping.")
        threshold = initial_length * 0.8

    st.markdown("**Dynamics**")
    shortening = _slider("shortening_rate", defaults.shortening_rate, key_prefix)
    stress = _slider("stress_level", defaults.stress_level, key_prefix)
    maintenance = _slider("maintenance_rate", defaults.maintenance_rate, key_prefix)
    repair = _slider("repair_rate", defaults.repair_rate, key_prefix)

    st.markdown("**Population & run**")
    c1, c2 = st.columns(2)
    population = c1.number_input("Founding cells", 10, 2000, int(defaults.population_size),
                                 step=10, key=f"{key_prefix}_population_size")
    capacity = c2.number_input("Carrying capacity", int(population), 5000,
                               max(int(defaults.carrying_capacity), int(population)),
                               step=50, key=f"{key_prefix}_capacity")
    c3, c4 = st.columns(2)
    cycles = c3.number_input("Cycles", 5, 600, int(defaults.cycles), step=5,
                             key=f"{key_prefix}_cycles")
    seed = c4.number_input("Random seed", 0, 2**31 - 1, int(defaults.seed), step=1,
                           key=f"{key_prefix}_seed")

    extra: Dict[str, float] = {}
    if advanced:
        with st.expander("Advanced model parameters"):
            extra["initial_length_sd"] = _slider("initial_length_sd", defaults.initial_length_sd, key_prefix)
            extra["stress_sensitivity"] = _slider("stress_sensitivity", defaults.stress_sensitivity, key_prefix)
            extra["maintenance_max_gain"] = _slider("maintenance_max_gain", defaults.maintenance_max_gain, key_prefix)
            extra["noise_sd"] = _slider("noise_sd", defaults.noise_sd, key_prefix)
            extra["senescent_death_rate"] = _slider("senescent_death_rate", defaults.senescent_death_rate, key_prefix)
            extra["telomeres_per_cell"] = int(st.number_input(
                "Telomeres per cell", 2, 92, int(defaults.telomeres_per_cell), step=2,
                help="Human cells have 92 telomere ends; the MVP default (32) trades realism for speed.",
                key=f"{key_prefix}_telomeres_per_cell"))
            extra["record_distribution_every"] = int(st.number_input(
                "Snapshot distribution every N cycles (0 = final only)", 0, 200,
                int(defaults.record_distribution_every), step=5, key=f"{key_prefix}_snap"))

    return defaults.replace(
        initial_length=initial_length, senescence_threshold=threshold,
        shortening_rate=shortening, stress_level=stress, maintenance_rate=maintenance,
        repair_rate=repair, population_size=int(population), carrying_capacity=int(capacity),
        cycles=int(cycles), seed=int(seed), **extra,
    ).validate()


def fitness_weight_controls(defaults: FitnessWeights, key_prefix: str = "w") -> FitnessWeights:
    st.caption("fitness = w₁·survival + w₂·reserve − w₃·senescence − w₄·instability − w₅·cost")
    c1, c2 = st.columns(2)
    w1 = c1.slider("w₁ survival", 0.0, 1.0, defaults.w_survival, 0.05, key=f"{key_prefix}_survival")
    w2 = c2.slider("w₂ telomere reserve", 0.0, 1.0, defaults.w_reserve, 0.05, key=f"{key_prefix}_reserve")
    w3 = c1.slider("w₃ senescence", 0.0, 1.0, defaults.w_senescence, 0.05, key=f"{key_prefix}_senescence")
    w4 = c2.slider("w₄ instability", 0.0, 1.0, defaults.w_instability, 0.05, key=f"{key_prefix}_instability")
    w5 = c1.slider("w₅ intervention cost", 0.0, 1.0, defaults.w_cost, 0.05, key=f"{key_prefix}_cost")
    return FitnessWeights(w1, w2, w3, w4, w5)


def evolution_controls(defaults: EvolutionConfig, key_prefix: str = "evo") -> EvolutionConfig:
    c1, c2, c3 = st.columns(3)
    pop = c1.number_input("Candidates per generation", 8, 256, int(defaults.population_size), step=8,
                          key=f"{key_prefix}_pop")
    gens = c2.number_input("Generations", 1, 200, int(defaults.generations), step=1, key=f"{key_prefix}_gens")
    seed = c3.number_input("Optimizer seed", 0, 2**31 - 1, int(defaults.seed), step=1, key=f"{key_prefix}_seed")
    c4, c5, c6 = st.columns(3)
    mrate = c4.slider("Mutation rate", 0.0, 1.0, float(defaults.mutation_rate), 0.05, key=f"{key_prefix}_mrate")
    msigma = c5.slider("Mutation sigma (normalised)", 0.01, 0.5, float(defaults.mutation_sigma), 0.01,
                       key=f"{key_prefix}_msigma")
    elite = c6.slider("Elite fraction", 0.0, 0.5, float(defaults.elite_fraction), 0.05, key=f"{key_prefix}_elite")
    c7, c8, c9 = st.columns(3)
    xrate = c7.slider("Crossover rate", 0.0, 1.0, float(defaults.crossover_rate), 0.05, key=f"{key_prefix}_xrate")
    xkind = c8.selectbox("Crossover", ["uniform", "arithmetic"],
                         index=0 if defaults.crossover_kind == "uniform" else 1, key=f"{key_prefix}_xkind")
    patience = c9.number_input("Early-stop patience (0 = off)", 0, 100, int(defaults.early_stopping_patience),
                               key=f"{key_prefix}_patience")
    free = st.multiselect(
        "Genes the optimizer may change", list(EVOLVABLE_PARAMETERS), list(defaults.free_genes),
        help="Everything not selected stays fixed at the baseline value.", key=f"{key_prefix}_free")
    seeds_text = st.text_input("Simulator seeds per candidate (comma-separated; more = less noise, slower)",
                               ",".join(str(s) for s in defaults.eval_seeds), key=f"{key_prefix}_seeds")
    try:
        eval_seeds = tuple(int(s.strip()) for s in seeds_text.split(",") if s.strip())
    except ValueError:
        st.error("Seeds must be integers.")
        eval_seeds = defaults.eval_seeds
    return EvolutionConfig(
        population_size=int(pop), generations=int(gens), elite_fraction=float(elite),
        mutation_rate=float(mrate), mutation_sigma=float(msigma), crossover_rate=float(xrate),
        crossover_kind=xkind, seed=int(seed), eval_seeds=eval_seeds or defaults.eval_seeds,
        free_genes=tuple(free) or defaults.free_genes, early_stopping_patience=int(patience),
        checkpoint_every=defaults.checkpoint_every, weights=defaults.weights,
    )


def chip_controls(key_prefix: str = "chip") -> Dict[str, float]:
    """Organ-on-chip condition inputs -> derived simulation parameters."""
    st.caption("Derived simulation parameters. The mapping is a documented modelling assumption, "
               "not a calibrated relationship (docs/MODEL.md §6).")
    c1, c2 = st.columns(2)
    flow = c1.slider("Perfusion / flow (0 static → 1 high)", 0.0, 1.0, 0.5, 0.05, key=f"{key_prefix}_flow")
    o2 = c2.slider("Oxygen tension (fraction O₂)", 0.02, 0.21, 0.21, 0.01, key=f"{key_prefix}_o2")
    nutrient = c1.slider("Nutrient state (0 depleted → 1 replete)", 0.0, 1.0, 0.8, 0.05, key=f"{key_prefix}_nut")
    exposure = c2.slider("Exogenous stress exposure", 0.0, 1.0, 0.2, 0.05, key=f"{key_prefix}_exp")
    days = st.slider("Culture duration (days, 1 doubling/day assumed)", 5, 300, 60, 5, key=f"{key_prefix}_days")
    chip = ChipConditions(flow_rate=flow, oxygen_tension=o2, nutrient_state=nutrient,
                          stress_exposure=exposure, culture_days=float(days))
    derived = chip_to_model_params(chip)
    st.write({k: (round(v, 3) if isinstance(v, float) else v) for k, v in derived.items()})
    return derived
