"""GET /api/experiments (+ /{run_id}) -- the JSONL experiment ledger, filterable
to the current user's own runs (mirrors the Streamlit Experiments page's two
tabs: "My experiments" / "All experiments"), via ``db.list_user_runs``.
"""

from __future__ import annotations

from typing import List

from fastapi import APIRouter, Depends, HTTPException, Query, status

from telomere_lab import db as _db
from telomere_lab.experiments.registry import ExperimentRegistry

from .. import schemas as api_schemas
from ..auth import get_current_user

router = APIRouter(prefix="/experiments", tags=["experiments"])


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
        ))
    return out


@router.get("/{run_id}", response_model=api_schemas.ExperimentDetail)
def get_experiment(run_id: str, user: _db.User = Depends(get_current_user)) -> api_schemas.ExperimentDetail:
    registry = ExperimentRegistry()
    try:
        record = registry.load(run_id)
    except (OSError, FileNotFoundError):
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"No such run: {run_id!r}")
    return api_schemas.ExperimentDetail(record=record, artifacts=record.get("artifacts", {}))
