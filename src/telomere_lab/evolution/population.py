"""Evaluated-candidate container used by the evolution engine."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from .fitness import FitnessBreakdown


@dataclass
class Candidate:
    genome: Dict[str, float]
    fitness: float
    breakdown: Optional[FitnessBreakdown] = None
    terminal_metrics: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "genome": self.genome,
            "fitness": self.fitness,
            "breakdown": self.breakdown.to_dict() if self.breakdown else None,
            "terminal_metrics": self.terminal_metrics,
        }

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "Candidate":
        bd = d.get("breakdown")
        return cls(
            genome=dict(d["genome"]),
            fitness=float(d["fitness"]),
            breakdown=FitnessBreakdown(**bd) if bd else None,
            terminal_metrics=dict(d.get("terminal_metrics", {})),
        )


def ranked(population: List[Candidate]) -> List[Candidate]:
    return sorted(population, key=lambda c: c.fitness, reverse=True)
