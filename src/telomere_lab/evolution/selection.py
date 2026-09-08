"""Selection operators: elitism and tournament selection."""

from __future__ import annotations

from typing import List, Sequence

import numpy as np


def rank_indices(fitness: Sequence[float]) -> np.ndarray:
    """Indices sorted from best (highest fitness) to worst."""
    return np.argsort(-np.asarray(fitness, dtype=float), kind="stable")


def select_elites(fitness: Sequence[float], n_elites: int) -> List[int]:
    return rank_indices(fitness)[:n_elites].tolist()


def tournament_select(
    fitness: Sequence[float], rng: np.random.Generator, tournament_size: int
) -> int:
    """Pick ``tournament_size`` random candidates, return the fittest index."""
    n = len(fitness)
    k = max(1, min(tournament_size, n))
    contenders = rng.choice(n, size=k, replace=False)
    best = max(contenders, key=lambda i: fitness[i])
    return int(best)
