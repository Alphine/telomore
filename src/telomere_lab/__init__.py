"""Telomere Evolution Lab - evolutionary search over a telomere-dynamics model.

Scientific scope: a computational research prototype. It does not provide
medical advice, clinical predictions, or validated therapeutic recommendations.
"""

from .schemas import (
    MODEL_VERSION,
    OPTIMIZER_VERSION,
    EvolutionConfig,
    FitnessWeights,
    ModelConfig,
    SimulationResult,
)

__version__ = "0.1.0"

__all__ = [
    "MODEL_VERSION",
    "OPTIMIZER_VERSION",
    "EvolutionConfig",
    "FitnessWeights",
    "ModelConfig",
    "SimulationResult",
    "__version__",
]
