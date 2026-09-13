"""Serialisation of simulation / evolution results to JSON, CSV and bundles."""

from __future__ import annotations

import io
import json
import zipfile
from pathlib import Path
from typing import Dict

from ..evolution.engine import EvolutionResult
from ..schemas import SimulationResult
from .registry import _json_default


def simulation_json(result: SimulationResult, include_final_lengths: bool = True) -> str:
    return json.dumps(result.to_json_dict(include_final_lengths), indent=2, default=_json_default)


def simulation_csv(result: SimulationResult) -> str:
    return result.timeseries_frame().to_csv(index=False)


def evolution_json(result: EvolutionResult) -> str:
    return json.dumps(result.to_json_dict(), indent=2, default=_json_default)


def write_simulation_artifacts(result: SimulationResult, run_dir: str | Path) -> Dict[str, str]:
    run_dir = Path(run_dir)
    run_dir.mkdir(parents=True, exist_ok=True)
    paths = {
        "result_json": run_dir / "simulation.json",
        "timeseries_csv": run_dir / "timeseries.csv",
        "config_json": run_dir / "config.json",
    }
    paths["result_json"].write_text(simulation_json(result), encoding="utf-8")
    paths["timeseries_csv"].write_text(simulation_csv(result), encoding="utf-8")
    paths["config_json"].write_text(
        json.dumps(result.config.to_dict(), indent=2), encoding="utf-8"
    )
    return {k: str(v) for k, v in paths.items()}


def write_evolution_artifacts(result: EvolutionResult, run_dir: str | Path) -> Dict[str, str]:
    run_dir = Path(run_dir)
    run_dir.mkdir(parents=True, exist_ok=True)
    paths = {
        "evolution_json": run_dir / "evolution.json",
        "history_csv": run_dir / "summary.csv",
        "population_csv": run_dir / "final_population.csv",
        "best_json": run_dir / "best.json",
        "config_json": run_dir / "config.json",
    }
    paths["evolution_json"].write_text(evolution_json(result), encoding="utf-8")
    result.history_frame().to_csv(paths["history_csv"], index=False)
    result.population_frame().to_csv(paths["population_csv"], index=False)
    paths["best_json"].write_text(
        json.dumps(result.best.to_dict(), indent=2, default=_json_default), encoding="utf-8"
    )
    paths["config_json"].write_text(
        json.dumps({"model": result.base_config.to_dict(),
                    "evolution": result.evolution_config.to_dict()}, indent=2),
        encoding="utf-8",
    )
    return {k: str(v) for k, v in paths.items()}


def write_pareto_artifacts(result, run_dir: str | Path) -> Dict[str, str]:
    run_dir = Path(run_dir)
    run_dir.mkdir(parents=True, exist_ok=True)
    paths = {
        "pareto_json": run_dir / "pareto.json",
        "front_csv": run_dir / "pareto_front.csv",
        "history_csv": run_dir / "summary.csv",
        "population_csv": run_dir / "final_population.csv",
        "config_json": run_dir / "config.json",
    }
    paths["pareto_json"].write_text(json.dumps(result.to_json_dict(), indent=2, default=_json_default),
                                    encoding="utf-8")
    result.front_frame().to_csv(paths["front_csv"], index=False)
    result.history_frame().to_csv(paths["history_csv"], index=False)
    result.population_frame().to_csv(paths["population_csv"], index=False)
    paths["config_json"].write_text(
        json.dumps({"model": result.base_config.to_dict(), "multiobjective": result.mo_config.to_dict()},
                   indent=2), encoding="utf-8")
    return {k: str(v) for k, v in paths.items()}


def write_sensitivity_artifacts(result, run_dir: str | Path) -> Dict[str, str]:
    run_dir = Path(run_dir)
    run_dir.mkdir(parents=True, exist_ok=True)
    paths = {
        "sensitivity_json": run_dir / "sensitivity.json",
        "sensitivity_csv": run_dir / "sensitivity.csv",
        "config_json": run_dir / "config.json",
    }
    paths["sensitivity_json"].write_text(
        json.dumps(result.to_json_dict(), indent=2, default=_json_default), encoding="utf-8")
    result.to_frame().to_csv(paths["sensitivity_csv"], index=False)
    paths["config_json"].write_text(
        json.dumps({"model": result.base_config.to_dict(),
                    "sensitivity": result.sensitivity_config.to_dict()}, indent=2),
        encoding="utf-8",
    )
    return {k: str(v) for k, v in paths.items()}


def write_gxe_artifacts(result, run_dir: str | Path) -> Dict[str, str]:
    run_dir = Path(run_dir)
    run_dir.mkdir(parents=True, exist_ok=True)
    paths = {
        "gxe_json": run_dir / "gxe.json",
        "gxe_csv": run_dir / "gxe.csv",
        "config_json": run_dir / "config.json",
    }
    paths["gxe_json"].write_text(
        json.dumps(result.to_json_dict(), indent=2, default=_json_default), encoding="utf-8")
    result.to_frame().to_csv(paths["gxe_csv"], index=False)
    paths["config_json"].write_text(
        json.dumps({"model": result.base_config.to_dict(),
                    "gxe": result.gxe_config.to_dict()}, indent=2),
        encoding="utf-8",
    )
    return {k: str(v) for k, v in paths.items()}


def write_active_learning_artifacts(result, run_dir: str | Path) -> Dict[str, str]:
    run_dir = Path(run_dir)
    run_dir.mkdir(parents=True, exist_ok=True)
    paths = {
        "active_learning_json": run_dir / "active_learning.json",
        "active_learning_csv": run_dir / "active_learning.csv",
        "config_json": run_dir / "config.json",
    }
    paths["active_learning_json"].write_text(
        json.dumps(result.to_json_dict(), indent=2, default=_json_default), encoding="utf-8")
    result.to_frame().to_csv(paths["active_learning_csv"], index=False)
    paths["config_json"].write_text(
        json.dumps({"model": result.base_config.to_dict(),
                    "active_learning": result.al_config.to_dict()}, indent=2),
        encoding="utf-8",
    )
    return {k: str(v) for k, v in paths.items()}


def bundle_run_dir(run_dir: str | Path) -> bytes:
    """Zip an entire run directory into memory (for a download button)."""
    run_dir = Path(run_dir)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for p in sorted(run_dir.rglob("*")):
            if p.is_file():
                zf.write(p, arcname=str(p.relative_to(run_dir.parent)))
    return buf.getvalue()
