"""Gaussian mutation in normalised gene space with hard bound repair."""

from __future__ import annotations

from typing import Dict

import numpy as np

from .genome import GenomeSpec


def gaussian_mutation(
    genome: Dict[str, float],
    spec: GenomeSpec,
    rng: np.random.Generator,
    mutation_rate: float,
    sigma: float,
) -> Dict[str, float]:
    """Mutate each gene with probability ``mutation_rate``.

    The perturbation is N(0, sigma) in [0, 1] space, then clipped, so the
    result is always inside the gene's domain (SDD §12: never out of bounds).
    """
    arr = spec.to_array(genome)
    mask = rng.random(arr.shape[0]) < mutation_rate
    if mask.any():
        arr[mask] = arr[mask] + rng.normal(0.0, sigma, size=int(mask.sum()))
    arr = np.clip(arr, 0.0, 1.0)
    return spec.from_array(arr)
