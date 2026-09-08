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
