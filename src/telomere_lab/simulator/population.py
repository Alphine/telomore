"""Population-level bookkeeping: division, senescence, death, passaging.

These are pure functions on NumPy arrays so they are easy to test in
isolation and to reuse from :mod:`telomere_lab.simulator.model`.
"""

from __future__ import annotations

from typing import Tuple

import numpy as np

from .stochastic import subsample_indices


def update_senescence(lengths: np.ndarray, senescent: np.ndarray, threshold: float) -> np.ndarray:
    """A cell is senescent once its shortest telomere is below ``threshold``.

    Senescence is treated as irreversible in this model.
    """
    return senescent | (lengths.min(axis=1) < threshold)


def divide(
    lengths: np.ndarray, senescent: np.ndarray, founder_id: np.ndarray
) -> Tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Every proliferative cell produces one daughter.

    ``founder_id`` identifies which cell of the *founding* population (at
    cycle 0) each row descends from; a daughter inherits its parent's id.
    Tracking it lets us record, per founder, the first cycle at which *any*
    descendant became senescent (SDD comparison to reference-model lineages).

    Returns the expanded ``lengths`` / ``senescent`` / ``founder_id`` arrays
    and a boolean ``divided`` mask marking rows that went through
    replication this cycle (both the parent copy and the daughter copy).
    """
    prolif = ~senescent
    daughters = lengths[prolif]
    new_lengths = np.concatenate([lengths, daughters], axis=0)
    new_senescent = np.concatenate([senescent, np.zeros(daughters.shape[0], dtype=bool)])
    new_founder_id = np.concatenate([founder_id, founder_id[prolif]])
    divided = np.concatenate([prolif, np.ones(daughters.shape[0], dtype=bool)])
    return new_lengths, new_senescent, new_founder_id, divided


def remove_dead(
    rng: np.random.Generator, lengths: np.ndarray, senescent: np.ndarray,
    founder_id: np.ndarray, death_rate: float,
) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Senescent cells are lost with probability ``death_rate`` per cycle."""
    if death_rate <= 0 or not senescent.any():
        return lengths, senescent, founder_id
    dies = senescent & (rng.random(senescent.shape[0]) < death_rate)
    keep = ~dies
    return lengths[keep], senescent[keep], founder_id[keep]


def passage(
    rng: np.random.Generator, lengths: np.ndarray, senescent: np.ndarray,
    founder_id: np.ndarray, capacity: int,
) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Randomly dilute the culture back to ``capacity`` cells.

    Mirrors in-vitro passaging: cells are sampled without regard to state,
    so senescent and proliferative cells are lost proportionally.
    """
    n = lengths.shape[0]
    if n <= capacity:
        return lengths, senescent, founder_id
    idx = subsample_indices(rng, n, capacity)
    return lengths[idx], senescent[idx], founder_id[idx]
