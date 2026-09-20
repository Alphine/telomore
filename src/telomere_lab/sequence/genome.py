"""A synthetic three-gene genome and point-mutation classification."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, Tuple

import numpy as np

from .genetic_code import CODON_TABLE, STOP, translate

GENE_ROLES = {
    "TOY-CHK": "checkpoint",   # loss -> damaged cells escape apoptosis
    "TOY-REP": "repair",       # loss -> elevated mutation rate
    "TOY-ESS": "essential",    # loss -> cell death
}
_GENE_CODONS = {"TOY-CHK": 60, "TOY-REP": 80, "TOY-ESS": 100}
_SENSE = [c for c, a in CODON_TABLE.items() if a != STOP and c != "ATG"]
BASES = "ACGT"


@dataclass(frozen=True)
class Gene:
    name: str
    role: str
    dna: str  # ATG ... stop, coding strand

    @property
    def protein(self) -> str:
        return translate(self.dna)


@dataclass(frozen=True)
class Genome:
    genes: Tuple[Gene, ...]

    def gene(self, name: str) -> Gene:
        return next(g for g in self.genes if g.name == name)


def build_genome(seed: int = 7) -> Genome:
    """Deterministic synthetic genome: ATG + random sense codons + TAA per gene."""
    rng = np.random.default_rng(seed)
    genes = []
    for name, n in _GENE_CODONS.items():
        body = "".join(_SENSE[i] for i in rng.integers(0, len(_SENSE), n))
        genes.append(Gene(name, GENE_ROLES[name], "ATG" + body + "TAA"))
    return Genome(tuple(genes))


@dataclass(frozen=True)
class MutationEffect:
    gene: str
    position: int          # 0-based nucleotide index in the gene
    ref: str
    alt: str
    codon_index: int
    ref_codon: str
    alt_codon: str
    ref_aa: str
    alt_aa: str
    effect: str            # synonymous | missense | nonsense | start_loss | stop_loss
    mutated_dna: str
    mutated_protein: str


def classify_mutation(gene: Gene, position: int, alt: str) -> MutationEffect:
    alt = alt.upper()
    if not 0 <= position < len(gene.dna):
        raise ValueError("position out of range")
    if alt not in BASES:
        raise ValueError("alt must be one of A, C, G, T")
    ref = gene.dna[position]
    if alt == ref:
        raise ValueError("alt equals the reference base")
    ci = position // 3
    ref_codon = gene.dna[3 * ci:3 * ci + 3]
    off = position - 3 * ci
    alt_codon = ref_codon[:off] + alt + ref_codon[off + 1:]
    ref_aa, alt_aa = CODON_TABLE[ref_codon], CODON_TABLE[alt_codon]
    if ci == 0 and alt_aa != "M":
        effect = "start_loss"
    elif ref_aa == STOP and alt_aa != STOP:
        effect = "stop_loss"
    elif ref_aa == alt_aa:
        effect = "synonymous"
    elif alt_aa == STOP:
        effect = "nonsense"
    else:
        effect = "missense"
    mutated = gene.dna[:position] + alt + gene.dna[position + 1:]
    return MutationEffect(gene.name, position, ref, alt, ci, ref_codon, alt_codon, ref_aa, alt_aa,
                          effect, mutated, translate(mutated))


def substitution_profile(gene: Gene) -> Dict[str, float]:
    """Fraction of all 3*L single-base substitutions in each effect class."""
    counts: Dict[str, int] = {}
    total = 0
    for pos in range(len(gene.dna)):
        for alt in BASES:
            if alt == gene.dna[pos]:
                continue
            e = classify_mutation(gene, pos, alt).effect
            counts[e] = counts.get(e, 0) + 1
            total += 1
    return {k: v / total for k, v in sorted(counts.items())}
