"""Experiment registry and reproducibility ledger (SDD §20, §21).

Every run gets an ID ``TEL-YYYYMMDD-NNN`` and a directory under
``experiments/runs/<run_id>/`` holding ``record.json`` plus artifacts. A
flat ``experiments/registry.jsonl`` index is appended for fast listing.
"""

from __future__ import annotations

import datetime as _dt
import hashlib
import json
import platform
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

import numpy as np

from .. import __version__, config as _config
from ..config import PROJECT_ROOT
from ..schemas import MODEL_VERSION, OPTIMIZER_VERSION


def git_commit(root: Path = PROJECT_ROOT) -> Optional[str]:
    try:
        out = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"], cwd=root,
            capture_output=True, text=True, timeout=5,
        )
        if out.returncode == 0:
            sha = out.stdout.strip()
            dirty = subprocess.run(["git", "status", "--porcelain"], cwd=root,
                                   capture_output=True, text=True, timeout=5).stdout.strip()
            return sha + ("-dirty" if dirty else "")
    except Exception:  # git missing or not a repository
        pass
    return None


def environment_metadata() -> Dict[str, Any]:
    import pandas, scipy  # noqa: E401 - versions for the ledger

    return {
        "python_version": sys.version.split()[0],
        "platform": platform.platform(),
        "machine": platform.machine(),
        "processor": platform.processor(),
        "numpy_version": np.__version__,
        "scipy_version": scipy.__version__,
        "pandas_version": pandas.__version__,
        "package_version": __version__,
        "model_version": MODEL_VERSION,
        "optimizer_version": OPTIMIZER_VERSION,
        "git_commit": git_commit(),
    }


def configuration_hash(configuration: Dict[str, Any]) -> str:
    blob = json.dumps(configuration, sort_keys=True, default=_json_default).encode()
    return hashlib.sha256(blob).hexdigest()[:16]


class ExperimentRegistry:
    def __init__(self, runs_dir: str | Path | None = None):
        # Resolved at call time (not bound as a default at import) so that
        # ``telomere_lab.config.RUNS_DIR`` can be redirected, e.g. by test
        # fixtures pointing the ledger at a temporary directory.
        self.runs_dir = Path(runs_dir if runs_dir is not None else _config.RUNS_DIR)
        self.runs_dir.mkdir(parents=True, exist_ok=True)
        self.index_path = self.runs_dir.parent / "registry.jsonl"

    # ---------------------------------------------------------------- ids
    def new_run_id(self, when: Optional[_dt.datetime] = None) -> str:
        when = when or _dt.datetime.now()
        stamp = when.strftime("%Y%m%d")
        existing = sorted(p.name for p in self.runs_dir.glob(f"TEL-{stamp}-*"))
        seq = 1
        if existing:
            try:
                seq = int(existing[-1].split("-")[-1]) + 1
            except ValueError:
                seq = len(existing) + 1
        return f"TEL-{stamp}-{seq:03d}"

    # ------------------------------------------------------------- records
    def register(
        self,
        kind: str,
        seed: int,
        configuration: Dict[str, Any],
        fitness: Optional[float] = None,
        artifacts: Optional[Dict[str, str]] = None,
        runtime_seconds: Optional[float] = None,
        notes: str = "",
        extra: Optional[Dict[str, Any]] = None,
        run_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        run_id = run_id or self.new_run_id()
        run_dir = self.runs_dir / run_id
        run_dir.mkdir(parents=True, exist_ok=True)
        record: Dict[str, Any] = {
            "run_id": run_id,
            "kind": kind,  # "simulation" | "evolution" | "comparison"
            "created_at": _dt.datetime.now().isoformat(timespec="seconds"),
            "seed": int(seed),
            "configuration": configuration,
            "configuration_hash": configuration_hash(configuration),
            "fitness": fitness,
            "runtime_seconds": runtime_seconds,
            "artifacts": artifacts or {},
            "notes": notes,
            "environment": environment_metadata(),
        }
        record["model_version"] = record["environment"]["model_version"]
        record["optimizer_version"] = record["environment"]["optimizer_version"]
        record["git_commit"] = record["environment"]["git_commit"]
        if extra:
            record.update(extra)
        with open(run_dir / "record.json", "w", encoding="utf-8") as fh:
            json.dump(record, fh, indent=2, default=_json_default)
        with open(self.index_path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(_index_row(record), default=_json_default) + "\n")
        return record

    def run_dir(self, run_id: str) -> Path:
        return self.runs_dir / run_id

    def load(self, run_id: str) -> Dict[str, Any]:
        with open(self.runs_dir / run_id / "record.json", "r", encoding="utf-8") as fh:
            return json.load(fh)

    def list_runs(self) -> List[Dict[str, Any]]:
        rows = []
        for rec_path in sorted(self.runs_dir.glob("TEL-*/record.json")):
            try:
                with open(rec_path, "r", encoding="utf-8") as fh:
                    rows.append(_index_row(json.load(fh)))
            except (OSError, json.JSONDecodeError):
                continue
        return rows

    def ledger_frame(self):
        import pandas as pd

        rows = self.list_runs()
        if not rows:
            return pd.DataFrame(columns=list(_index_row({}).keys()))
        return pd.DataFrame(rows).sort_values("created_at", ascending=False).reset_index(drop=True)


def _index_row(record: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "run_id": record.get("run_id"),
        "kind": record.get("kind"),
        "created_at": record.get("created_at"),
        "git_commit": record.get("git_commit"),
        "model_version": record.get("model_version"),
        "optimizer_version": record.get("optimizer_version"),
        "seed": record.get("seed"),
        "configuration_hash": record.get("configuration_hash"),
        "fitness": record.get("fitness"),
        "runtime_seconds": record.get("runtime_seconds"),
        "artifacts": ", ".join(sorted((record.get("artifacts") or {}).keys())),
        "notes": record.get("notes", ""),
    }


def _json_default(o):
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, (np.floating,)):
        return None if np.isnan(o) else float(o)
    if isinstance(o, np.ndarray):
        return o.tolist()
    if isinstance(o, (np.bool_,)):
        return bool(o)
    if isinstance(o, float) and o != o:
        return None
    if o == float("inf"):
        return "inf"
    if isinstance(o, Path):
        return str(o)
    raise TypeError(f"not JSON serialisable: {type(o)}")
