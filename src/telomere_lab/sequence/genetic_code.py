"""The standard genetic code (NCBI translation table 1)."""

from __future__ import annotations

from typing import Dict

STOP = "*"
_BASES = "TCAG"
_AMINO = "FFLLSSSSYY**CC*WLLLLPPPPHHQQRRRRIIIMTTTTNNKKSSRRVVVVAAAADDEEGGGG"

CODON_TABLE: Dict[str, str] = {
    a + b + c: _AMINO[16 * i + 4 * j + k]
    for i, a in enumerate(_BASES)
    for j, b in enumerate(_BASES)
    for k, c in enumerate(_BASES)
}

_COMP = {"A": "T", "T": "A", "C": "G", "G": "C"}


def reverse_complement(dna: str) -> str:
    return "".join(_COMP[b] for b in reversed(dna.upper()))


def transcribe(dna: str) -> str:
    """Coding-strand DNA -> mRNA (T -> U)."""
    return dna.upper().replace("T", "U")


def translate(dna: str, to_stop: bool = True) -> str:
    """Coding-strand DNA -> protein; the stop codon is not included, and with
    ``to_stop=False`` translation continues past it (stops shown as ``*``)."""
    dna = dna.upper()
    protein = []
    for i in range(0, len(dna) - len(dna) % 3, 3):
        aa = CODON_TABLE[dna[i:i + 3]]
        if aa == STOP and to_stop:
            break
        protein.append(aa)
    return "".join(protein)
