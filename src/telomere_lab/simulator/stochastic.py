"""Random-number helpers.

All stochasticity in the simulator flows through a single
``numpy.random.Generator`` created from the run seed, so identical
``(config, seed)`` pairs give bit-identical trajectories (SDD §5.3).
"""

from __future__ import annotations

import numpy as np


def make_rng(seed: int) -> np.random.Generator:
    return np.random.default_rng(int(seed))


def initial_lengths(
    rng: np.random.Generator, n_cells: int, n_telomeres: int, mean: float, sd: float,
    floor: float = 200.0,
) -> np.ndarray:
    """Gaussian initial telomere lengths, clipped to a small positive floor."""
    lengths = rng.normal(mean, sd, size=(n_cells, n_telomeres))
    return np.maximum(lengths, floor)


def initial_lengths_hierarchical(
    rng: np.random.Generator, n_cells: int, n_telomeres: int, mean: float, between_sd: float,
    within_sd: float, floor: float = 200.0,
) -> np.ndarray:
    """Two-level initial lengths (docs/MODEL.md section 2.6).

    One offset per cell ~ N(0, between_sd) plus an independent per-telomere
    N(0, within_sd); total per-telomere variance is between_sd**2 + within_sd**2.
    """
    offsets = rng.normal(0.0, between_sd, size=(n_cells, 1))
    lengths = mean + offsets + rng.normal(0.0, within_sd, size=(n_cells, n_telomeres))
    return np.maximum(lengths, floor)


def shortening_multipliers(rng: np.random.Generator, n_cells: int, cv: float) -> np.ndarray:
    """Lognormal multipliers with mean exactly 1 and coefficient of variation ``cv``."""
    sigma2 = np.log1p(cv * cv)
    return rng.lognormal(-0.5 * sigma2, np.sqrt(sigma2), size=n_cells)


def division_noise(
    rng: np.random.Generator, shape: tuple, sd: float
) -> np.ndarray:
    if sd <= 0:
        return np.zeros(shape)
    return rng.normal(0.0, sd, size=shape)


def subsample_indices(
    rng: np.random.Generator, n_available: int, n_keep: int
) -> np.ndarray:
    """Randomly keep ``n_keep`` of ``n_available`` cells (culture passaging)."""
    if n_keep >= n_available:
        return np.arange(n_available)
    return rng.choice(n_available, size=n_keep, replace=False)
