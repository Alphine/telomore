"""Crossover operators (uniform and arithmetic) in normalised gene space."""

from __future__ import annotations

from typing import Dict, Tuple

import numpy as np

from .genome import GenomeSpec


def uniform_crossover(
    a: Dict[str, float], b: Dict[str, float], spec: GenomeSpec, rng: np.random.Generator
) -> Tuple[Dict[str, float], Dict[str, float]]:
    xa, xb = spec.to_array(a), spec.to_array(b)
    mask = rng.random(xa.shape[0]) < 0.5
    ca = np.where(mask, xa, xb)
    cb = np.where(mask, xb, xa)
    return spec.from_array(ca), spec.from_array(cb)


def arithmetic_crossover(
    a: Dict[str, float], b: Dict[str, float], spec: GenomeSpec, rng: np.random.Generator
) -> Tuple[Dict[str, float], Dict[str, float]]:
    xa, xb = spec.to_array(a), spec.to_array(b)
    alpha = rng.random(xa.shape[0])
    ca = alpha * xa + (1.0 - alpha) * xb
    cb = alpha * xb + (1.0 - alpha) * xa
    return spec.from_array(ca), spec.from_array(cb)


def crossover(kind: str, a, b, spec, rng):
    if kind == "uniform":
        return uniform_crossover(a, b, spec, rng)
    if kind == "arithmetic":
        return arithmetic_crossover(a, b, spec, rng)
    raise ValueError(f"unknown crossover kind: {kind}")
