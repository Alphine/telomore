"""Toy DNA -> RNA -> protein layer (docs/MODEL.md §2.4).

A *toy*: the standard genetic code is real, the genes are synthetic (not any
real human gene) and their "roles" (checkpoint / repair / essential) are
labels chosen to illustrate the model's mechanisms. Nothing here is a
calibrated or clinical claim (docs/SCIENTIFIC_SCOPE.md).
"""

from .genetic_code import CODON_TABLE, STOP, reverse_complement, transcribe, translate
from .genome import (
    GENE_ROLES,
    Gene,
    Genome,
    MutationEffect,
    build_genome,
    classify_mutation,
    substitution_profile,
)
from .lineage import LineageConfig, simulate_lineage, subclone_overrides

__all__ = [
    "CODON_TABLE", "STOP", "reverse_complement", "transcribe", "translate",
    "GENE_ROLES", "Gene", "Genome", "MutationEffect", "build_genome",
    "classify_mutation", "substitution_profile",
    "LineageConfig", "simulate_lineage", "subclone_overrides",
]
