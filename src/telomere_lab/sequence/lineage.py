"""Normal-vs-damaged cell lineages over the toy genome.

Each cell carries a functional flag per gene. Every generation each cell
receives point mutations at a per-base rate (x ``repair_penalty`` if TOY-REP is
lost). The chance a mutation in gene G knocks it out comes from the real
substitution table of that gene: nonsense / start-loss always, missense with
probability ``missense_lof`` (a toy assumption), synonymous never. Rules:

* TOY-ESS lost            -> the cell dies;
* TOY-CHK functional and passenger burden >= ``burden_threshold`` -> apoptosis;
* dead cells are replaced by copies of random survivors (constant population).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Optional

import numpy as np

from .genome import Genome, build_genome, substitution_profile


@dataclass
class LineageConfig:
    cells: int = 400
    generations: int = 60
    mutation_rate: float = 2e-4      # per base per division
    repair_penalty: float = 10.0     # rate multiplier once TOY-REP is lost
    missense_lof: float = 0.3        # P(missense knocks a gene out) -- toy assumption
    burden_threshold: int = 4        # passenger hits that trigger the checkpoint
    initial_lof: List[str] = field(default_factory=list)   # genes broken at generation 0
    seed: int = 1


def _lof_probability(genome: Genome, missense_lof: float) -> Dict[str, float]:
    out = {}
    for g in genome.genes:
        p = substitution_profile(g)
        out[g.name] = p.get("nonsense", 0.0) + p.get("start_loss", 0.0) + missense_lof * p.get("missense", 0.0)
    return out


def simulate_lineage(cfg: LineageConfig, genome: Optional[Genome] = None) -> Dict[str, list]:
    genome = genome or build_genome()
    rng = np.random.default_rng(cfg.seed)
    names = [g.name for g in genome.genes]
    length = {g.name: len(g.dna) for g in genome.genes}
    q = _lof_probability(genome, cfg.missense_lof)
    total_len = sum(length.values())
    n = cfg.cells

    ok = {name: np.ones(n, dtype=bool) for name in names}
    for name in cfg.initial_lof:
        ok[name][:] = False
    burden = np.zeros(n)
    series: Dict[str, list] = {"generation": [], "alive_fraction": [], "mean_burden": [],
                               **{f"{nm}_functional": [] for nm in names}}
    extinct = False

    def record(gen: int, alive_frac: float):
        series["generation"].append(gen)
        series["alive_fraction"].append(alive_frac)
        series["mean_burden"].append(float("nan") if extinct else float(burden.mean()))
        for nm in names:
            series[f"{nm}_functional"].append(float("nan") if extinct else float(ok[nm].mean()))

    record(0, 1.0)
    for gen in range(1, cfg.generations + 1):
        if extinct:
            record(gen, 0.0)
            continue
        rate = cfg.mutation_rate * np.where(ok["TOY-REP"], 1.0, cfg.repair_penalty)
        for nm in names:
            hits = rng.poisson(rate * length[nm] * q[nm])
            ok[nm] &= hits == 0
        burden += rng.poisson(rate * total_len)
        alive = ok["TOY-ESS"] & ~(ok["TOY-CHK"] & (burden >= cfg.burden_threshold))
        n_alive = int(alive.sum())
        if n_alive == 0:
            extinct = True
            record(gen, 0.0)
            continue
        survivors = np.flatnonzero(alive)
        idx = np.concatenate([survivors, rng.choice(survivors, size=n - n_alive)])
        for nm in names:
            ok[nm] = ok[nm][idx]
        burden = burden[idx]
        record(gen, n_alive / n)
    series["extinct"] = extinct
    return series


def subclone_overrides(checkpoint_ok: bool, repair_ok: bool) -> Dict[str, float]:
    """Bridge to the cell-population model (docs/MODEL.md §2.2/§2.3): translate
    the state of two toy genes into sub-clone genome-stability overrides. The
    numbers mirror configs/demo_healthy_vs_damaged.yaml."""
    return {
        "replication_error_rate": 0.001 if repair_ok else 0.003,
        "oxidative_mutation_sensitivity": 0.005 if repair_ok else 0.010,
        "checkpoint_strength": 0.5 if checkpoint_ok else 0.0,
        "mutation_threshold": 0.25,
    }
