"""GET /api/experiments (+ /{run_id}) -- the JSONL experiment ledger, filterable
to the current user's own runs (mirrors the Streamlit Experiments page's two
tabs: "My experiments" / "All experiments"), via ``db.list_user_runs``.

Phase 4 adds ``GET /{run_id}/artifacts`` (list) and
``GET /{run_id}/artifacts/{name}`` (download) for the React Experiments page.
Files are resolved strictly under ``experiments/runs/<run_id>/``; a
``run_id`` or ``name`` containing a path separator or ``..`` is rejected
before touching the filesystem, and the resolved path must still be inside
the run directory. Ownership follows the existing record routes: any
authenticated, verified user may read any run (the ledger is shared; only
the *listing* is filtered by ``mine``).
"""

from __future__ import annotations

import mimetypes
import re
from pathlib import Path
from typing import List

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import FileResponse

from telomere_lab import db as _db
from telomere_lab.experiments.registry import ExperimentRegistry

from .. import schemas as api_schemas
from ..auth import get_current_user

router = APIRouter(prefix="/experiments", tags=["experiments"])

# A single path segment: no separators, no `..`, nothing hidden.
_SAFE_SEGMENT = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")

_MEDIA_TYPES = {".json": "application/json", ".csv": "text/csv", ".yaml": "application/yaml",
                ".yml": "application/yaml", ".txt": "text/plain", ".md": "text/markdown"}


def _safe_segment(value: str, what: str) -> str:
    if not _SAFE_SEGMENT.match(value) or ".." in value:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Invalid {what}: {value!r}")
    return value


def _run_dir_or_404(registry: ExperimentRegistry, run_id: str) -> Path:
    run_dir = registry.run_dir(run_id).resolve()
    runs_root = registry.runs_dir.resolve()
    if run_dir.parent != runs_root or not run_dir.is_dir():
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"No such run: {run_id!r}")
    return run_dir


def _media_type(path: Path) -> str:
    return _MEDIA_TYPES.get(path.suffix.lower()) or mimetypes.guess_type(path.name)[0] or "application/octet-stream"


@router.get("", response_model=List[api_schemas.ExperimentSummary])
def list_experiments(
    mine: bool = Query(True, description="If true (default), only the current user's own runs."),
    user: _db.User = Depends(get_current_user),
) -> List[api_schemas.ExperimentSummary]:
    registry = ExperimentRegistry()
    rows = registry.list_runs()
    my_run_ids = set(_db.list_user_runs(user.id))

    out = []
    for row in rows:
        is_mine = row.get("run_id") in my_run_ids
        if mine and not is_mine:
            continue
        out.append(api_schemas.ExperimentSummary(
            run_id=row.get("run_id"), kind=row.get("kind"), created_at=row.get("created_at"),
            fitness=row.get("fitness"), runtime_seconds=row.get("runtime_seconds"),
            notes=row.get("notes"), mine=is_mine,
            seed=row.get("seed"), configuration_hash=row.get("configuration_hash"),
            git_commit=row.get("git_commit"), model_version=row.get("model_version"),
        ))
    return out


@router.get("/{run_id}", response_model=api_schemas.ExperimentDetail)
def get_experiment(run_id: str, user: _db.User = Depends(get_current_user)) -> api_schemas.ExperimentDetail:
    _safe_segment(run_id, "run id")
    registry = ExperimentRegistry()
    try:
        record = registry.load(run_id)
    except (OSError, FileNotFoundError):
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"No such run: {run_id!r}")
    return api_schemas.ExperimentDetail(record=record, artifacts=record.get("artifacts", {}))


@router.get("/{run_id}/artifacts", response_model=List[api_schemas.ArtifactInfo])
def list_artifacts(run_id: str, user: _db.User = Depends(get_current_user)) -> List[api_schemas.ArtifactInfo]:
    del user  # auth gate only (same as get_experiment)
    _safe_segment(run_id, "run id")
    registry = ExperimentRegistry()
    run_dir = _run_dir_or_404(registry, run_id)
    try:
        record = registry.load(run_id)
    except (OSError, ValueError):
        record = {}
    # record["artifacts"] is {key: absolute path}; map file name -> key so the
    # UI can label e.g. summary.csv as "history_csv".
    key_by_name = {Path(p).name: k for k, p in (record.get("artifacts") or {}).items()}
    out = []
    for p in sorted(run_dir.iterdir()):
        if not p.is_file():
            continue
        out.append(api_schemas.ArtifactInfo(
            name=p.name, key=key_by_name.get(p.name), size_bytes=p.stat().st_size, media_type=_media_type(p),
        ))
    return out


@router.get("/{run_id}/artifacts/{name}")
def download_artifact(run_id: str, name: str, user: _db.User = Depends(get_current_user)) -> FileResponse:
    del user  # auth gate only (same as get_experiment)
    _safe_segment(run_id, "run id")
    _safe_segment(name, "artifact name")
    run_dir = _run_dir_or_404(ExperimentRegistry(), run_id)
    path = (run_dir / name).resolve()
    if path.parent != run_dir or not path.is_file():
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"No artifact {name!r} in run {run_id!r}")
    return FileResponse(path, media_type=_media_type(path), filename=path.name)
