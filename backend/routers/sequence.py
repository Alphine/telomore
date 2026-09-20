"""/api/sequence/* -- the toy DNA -> RNA -> protein genome explorer (docs/MODEL.md §2.4).

Synthetic genes only; every response carries ``toy: true`` so the UI can label it.
Cheap and synchronous (no job queue): a lineage run is ~60 generations of
vectorised numpy over a few hundred cells.
"""

from __future__ import annotations

from typing import Dict, List

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from telomere_lab import db as _db
from telomere_lab.sequence import (
    LineageConfig,
    build_genome,
    classify_mutation,
    simulate_lineage,
    subclone_overrides,
    substitution_profile,
    transcribe,
)

from ..auth import get_current_user

router = APIRouter(prefix="/sequence", tags=["sequence"])
_GENOME = build_genome()
_GENE_NAMES = [g.name for g in _GENOME.genes]


def _json_safe(series: Dict) -> Dict:
    """Extinct cultures record NaN; JSON has none, so send null."""
    return {k: [None if isinstance(x, float) and x != x else x for x in v] if isinstance(v, list) else v
            for k, v in series.items()}


class MutateRequest(BaseModel):
    gene: str
    position: int = Field(ge=0)
    alt: str = Field(min_length=1, max_length=1)


class LineageRequest(BaseModel):
    cells: int = Field(400, ge=50, le=2000)
    generations: int = Field(60, ge=1, le=200)
    mutation_rate: float = Field(2e-4, ge=0.0, le=1e-2)
    repair_penalty: float = Field(10.0, ge=1.0, le=100.0)
    missense_lof: float = Field(0.3, ge=0.0, le=1.0)
    burden_threshold: int = Field(4, ge=1, le=50)
    damaged_genes: List[str] = Field(default_factory=lambda: ["TOY-CHK", "TOY-REP"])
    seed: int = Field(1, ge=0, le=2**31 - 1)


@router.get("/genome")
def genome(user: _db.User = Depends(get_current_user)) -> Dict:
    del user
    return {
        "toy": True,
        "genes": [
            {"name": g.name, "role": g.role, "dna": g.dna, "mrna": transcribe(g.dna), "protein": g.protein,
             "profile": substitution_profile(g)}
            for g in _GENOME.genes
        ],
    }


@router.post("/mutate")
def mutate(body: MutateRequest, user: _db.User = Depends(get_current_user)) -> Dict:
    del user
    if body.gene not in _GENE_NAMES:
        raise HTTPException(status_code=400, detail=f"unknown gene {body.gene!r}")
    try:
        e = classify_mutation(_GENOME.gene(body.gene), body.position, body.alt)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"toy": True, **e.__dict__, "mutated_mrna": transcribe(e.mutated_dna)}


@router.post("/lineage")
def lineage(body: LineageRequest, user: _db.User = Depends(get_current_user)) -> Dict:
    del user
    bad = [g for g in body.damaged_genes if g not in _GENE_NAMES]
    if bad:
        raise HTTPException(status_code=400, detail=f"unknown gene(s) {bad}")
    common = dict(cells=body.cells, generations=body.generations, mutation_rate=body.mutation_rate,
                  repair_penalty=body.repair_penalty, missense_lof=body.missense_lof,
                  burden_threshold=body.burden_threshold, seed=body.seed)
    normal = simulate_lineage(LineageConfig(**common), _GENOME)
    damaged = simulate_lineage(LineageConfig(initial_lof=body.damaged_genes, **common), _GENOME)
    return {
        "toy": True,
        "normal": _json_safe(normal),
        "damaged": _json_safe(damaged),
        "model_bridge": {
            "normal": subclone_overrides(True, True),
            "damaged": subclone_overrides("TOY-CHK" not in body.damaged_genes,
                                          "TOY-REP" not in body.damaged_genes),
        },
    }
