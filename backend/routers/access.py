"""PRO access requests (user side). Admin decisions live in routers/admin.py."""

from __future__ import annotations

import datetime as _dt
from typing import Any, Dict, List

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import func, select

from telomere_lab import db as _db

from ..auth import error_detail, get_current_user
from ..usage import iso

router = APIRouter(prefix="/access-requests", tags=["access"])

MAX_PER_DAY = 3


class AccessRequestBody(BaseModel):
    message: str = Field(default="", max_length=500)


def request_public(r: _db.AccessRequest) -> Dict[str, Any]:
    return {"id": r.id, "status": r.status, "message": r.message, "created_at": iso(r.created_at),
            "decided_at": iso(r.decided_at), "decision_note": r.decision_note}


@router.post("", status_code=status.HTTP_201_CREATED)
def create_request(body: AccessRequestBody, user: _db.User = Depends(get_current_user)) -> Dict[str, Any]:
    if _db.effective_plan(user) == _db.PLAN_PRO:
        raise HTTPException(409, detail=error_detail("already_pro", "Your account already has PRO access."))
    db = _db.get_session()
    try:
        pending = db.execute(select(_db.AccessRequest.id).where(
            _db.AccessRequest.user_id == user.id, _db.AccessRequest.status == "pending")).first()
        if pending is not None:
            raise HTTPException(409, detail=error_detail("request_pending", "You already have a pending request."))
        since = _db.utcnow() - _dt.timedelta(days=1)
        recent = db.execute(select(func.count()).select_from(_db.AccessRequest).where(
            _db.AccessRequest.user_id == user.id, _db.AccessRequest.created_at >= since)).scalar_one()
        if recent >= MAX_PER_DAY:
            raise HTTPException(429, detail=error_detail(
                "too_many_requests", f"At most {MAX_PER_DAY} requests per 24 hours."), headers={"Retry-After": "3600"})
        row = _db.AccessRequest(user_id=user.id, message=body.message.strip(), status="pending")
        db.add(row)
        db.commit()
        db.refresh(row)
        return request_public(row)
    finally:
        db.close()


@router.get("/mine")
def my_requests(user: _db.User = Depends(get_current_user)) -> List[Dict[str, Any]]:
    db = _db.get_session()
    try:
        rows = db.execute(select(_db.AccessRequest).where(_db.AccessRequest.user_id == user.id)
                          .order_by(_db.AccessRequest.created_at.desc(), _db.AccessRequest.id.desc())).scalars().all()
        return [request_public(r) for r in rows]
    finally:
        db.close()
