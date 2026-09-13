"""Metric calculations on simulator state and finished trajectories.

Per-step summaries are computed inside the simulation loop by
:func:`summarise_state`; whole-run terminal metrics by
:func:`terminal_metrics`.
"""

from __future__ import annotations

from typing import Dict

import numpy as np


def summarise_state(
    lengths: np.ndarray, senescent: np.ndarray, threshold: float,
    mutation_burden: np.ndarray | None = None, apoptotic: np.ndarray | None = None,
) -> Dict[str, float]:
    """Summary statistics for one time-step.

    Parameters
    ----------
    lengths : (n_cells, n_telomeres) telomere lengths of *living* cells
    senescent : (n_cells,) boolean mask
    threshold : senescence threshold in bp
    mutation_burden : (n_cells,) genomic-instability accumulator (docs/MODEL.md
        §2.3), optional -- ``None`` when the caller doesn't track it.
    apoptotic : (n_cells,) boolean mask of cells over the mutation threshold,
        optional.
    """
    n_cells = lengths.shape[0]
    if n_cells == 0:
        return {
            "mean_length": np.nan,
            "median_length": np.nan,
            "shortest_length": np.nan,
            "p10_length": np.nan,
            "mean_shortest_per_cell": np.nan,
            "senescent_fraction": np.nan,
            "population_size": 0,
            "proliferative_count": 0,
            "fraction_below_threshold": np.nan,
            "length_cv": np.nan,
            "mean_mutation_burden": np.nan,
            "apoptotic_fraction": np.nan,
        }
    flat = lengths.ravel()
    per_cell_min = lengths.min(axis=1)
    mean = float(flat.mean())
    std = float(flat.std())
    return {
        "mean_length": mean,
        "median_length": float(np.median(flat)),
        "shortest_length": float(flat.min()),
        "p10_length": float(np.percentile(flat, 10)),
        "mean_shortest_per_cell": float(per_cell_min.mean()),
        "senescent_fraction": float(senescent.mean()),
        "population_size": int(n_cells),
        "proliferative_count": int((~senescent).sum()),
        "fraction_below_threshold": float((flat < threshold).mean()),
        "length_cv": (std / mean) if mean > 0 else np.nan,
        "mean_mutation_burden": float(mutation_burden.mean()) if mutation_burden is not None else 0.0,
        "apoptotic_fraction": float(apoptotic.mean()) if apoptotic is not None else 0.0,
    }


def time_to_fraction(senescent_fraction: np.ndarray, target: float) -> float:
    """First cycle at which the senescent fraction reaches ``target``.

    Returns ``inf`` if the target is never reached (a censored observation).
    """
    idx = np.flatnonzero(np.nan_to_num(senescent_fraction, nan=0.0) >= target)
    return float(idx[0]) if idx.size else float("inf")


def hayflick_distribution(founder_senescence_cycle: np.ndarray) -> Dict[str, float]:
    """Summary of the per-founder generation-at-senescence-onset distribution.

    Unbiased first-passage quantity, unlike ``senescent_fraction(t)`` which
    is skewed toward long-lived lineages because they keep doubling while
    senescent ones do not (see docs/EXPERIMENT_PROTOCOL.md Experiment D).
    """
    observed = founder_senescence_cycle[founder_senescence_cycle >= 0]
    n = founder_senescence_cycle.size
    if observed.size == 0:
        return {"n_founders": int(n), "n_observed": 0, "censored_fraction": 1.0 if n else float("nan"),
                "mean_generations": float("nan"), "median_generations": float("nan"),
                "std_generations": float("nan")}
    return {
        "n_founders": int(n),
        "n_observed": int(observed.size),
        "censored_fraction": float(1.0 - observed.size / n),
        "mean_generations": float(observed.mean()),
        "median_generations": float(np.median(observed)),
        "std_generations": float(observed.std()),
    }


def terminal_metrics(
    time: np.ndarray,
    mean_length: np.ndarray,
    mean_shortest_per_cell: np.ndarray,
    senescent_fraction: np.ndarray,
    population_size: np.ndarray,
    proliferative_count: np.ndarray,
    length_cv: np.ndarray,
    carrying_capacity: int,
    initial_length: float,
    threshold: float,
) -> Dict[str, float]:
    """Scalar outcomes used for reporting and fitness (SDD §10, §13).

    All *normalised* quantities are clipped to [0, 1] so the fitness
    function is bounded regardless of parameter extremes.
    """
    cycles = max(int(time[-1]), 1)
    prolif = np.nan_to_num(proliferative_count.astype(float), nan=0.0)

    # Area under the proliferative-cell curve, normalised to the maximum
    # attainable value (capacity for every cycle).
    survival_auc = float(np.trapezoid(prolif, time)) / (carrying_capacity * cycles)
    survival_auc = float(np.clip(survival_auc, 0.0, 1.0))

    final_mean = float(np.nan_to_num(mean_length[-1], nan=0.0))
    final_shortest = float(np.nan_to_num(mean_shortest_per_cell[-1], nan=0.0))
    final_sen = senescent_fraction[-1]
    final_sen = 1.0 if np.isnan(final_sen) else float(final_sen)  # extinct == fully lost
    final_pop = int(population_size[-1])
    final_cv = float(np.nan_to_num(length_cv[-1], nan=0.0))

    # Reserve: how much of the initial length remains above the threshold in
    # the shortest telomere per cell, on average.
    reserve_bp = final_shortest - threshold
    reserve_norm = float(np.clip(reserve_bp / max(initial_length - threshold, 1.0), 0.0, 1.0))

    return {
        "final_mean_length_bp": final_mean,
        "final_mean_shortest_bp": final_shortest,
        "telomere_reserve_bp": reserve_bp,
        "normalized_telomere_reserve": reserve_norm,
        "normalized_survival": survival_auc,
        "final_senescent_fraction": final_sen,
        "final_population_size": final_pop,
        "peak_population_size": int(np.nanmax(population_size)),
        "time_to_50pct_senescence": time_to_fraction(senescent_fraction, 0.5),
        "time_to_90pct_senescence": time_to_fraction(senescent_fraction, 0.9),
        "final_length_cv": final_cv,
        "extinct": bool(final_pop == 0),
    }
