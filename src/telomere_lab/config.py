"""YAML configuration loading and project paths."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, Tuple

import yaml

from .schemas import EvolutionConfig, ModelConfig

PROJECT_ROOT = Path(__file__).resolve().parents[2]
CONFIG_DIR = PROJECT_ROOT / "configs"
RUNS_DIR = PROJECT_ROOT / "experiments" / "runs"
REPORTS_DIR = PROJECT_ROOT / "experiments" / "reports"


def load_yaml(path: str | Path) -> Dict[str, Any]:
    with open(path, "r", encoding="utf-8") as fh:
        data = yaml.safe_load(fh) or {}
    if not isinstance(data, dict):
        raise ValueError(f"{path}: top-level YAML must be a mapping")
    return data


def load_model_config(path: str | Path | None = None) -> ModelConfig:
    """Load a ``ModelConfig`` from YAML (``model:`` block or flat keys)."""
    if path is None:
        return ModelConfig()
    data = load_yaml(path)
    block = data.get("model", data)
    return ModelConfig.from_dict(block).validate()


def load_evolution_config(path: str | Path) -> Tuple[ModelConfig, EvolutionConfig]:
    """Load both the base model config and the optimizer config from one YAML.

    Expected layout::

        model:      {...ModelConfig fields...}
        evolution:  {...EvolutionConfig fields, weights: {...}}
    """
    data = load_yaml(path)
    model = ModelConfig.from_dict(data.get("model", {})).validate()
    evo = EvolutionConfig.from_dict(data.get("evolution", {})).validate()
    return model, evo


def load_multiobjective_config(path: str | Path) -> Tuple[ModelConfig, "MultiObjectiveConfig"]:
    """Load ``model:`` + ``multiobjective:`` blocks for the NSGA-II runner."""
    from .schemas import MultiObjectiveConfig

    data = load_yaml(path)
    model = ModelConfig.from_dict(data.get("model", {})).validate()
    mo = MultiObjectiveConfig.from_dict(data.get("multiobjective", {})).validate()
    return model, mo


def load_sensitivity_config(path: str | Path) -> Tuple[ModelConfig, "SensitivityConfig"]:
    """Load ``model:`` + ``sensitivity:`` blocks for the OAT sensitivity runner."""
    from .schemas import SensitivityConfig

    data = load_yaml(path)
    model = ModelConfig.from_dict(data.get("model", {})).validate()
    sens = SensitivityConfig.from_dict(data.get("sensitivity", {})).validate()
    return model, sens


def load_active_learning_config(path: str | Path) -> Tuple[ModelConfig, "ActiveLearningConfig"]:
    """Load ``model:`` + ``active_learning:`` blocks for the surrogate active-learning runner."""
    from .schemas import ActiveLearningConfig

    data = load_yaml(path)
    model = ModelConfig.from_dict(data.get("model", {})).validate()
    al = ActiveLearningConfig.from_dict(data.get("active_learning", {})).validate()
    return model, al


def dump_yaml(data: Dict[str, Any], path: str | Path) -> None:
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        yaml.safe_dump(data, fh, sort_keys=False)
