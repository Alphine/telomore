"""Admin API (``/api/admin/*``). Every route needs ``require_admin``; every
mutating action writes an ``AdminAuditLog`` row. Exact JSON shapes: docs/ADMIN.md.

Deliberately absent: deleting users (disable instead), creating/removing
admins (only ``TELOMERE_ADMIN_USERS`` does that), anything that returns
password hashes or tokens.
"""

from __future__ import annotations

import csv
import datetime as _dt
import io
import json
import math
import secrets
from collections import defaultdict
from typing import Any, Dict, List, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import and_, case, func, or_, select

from telomere_lab import db as _db

from .. import jobs as job_store
from .. import schemas as api_schemas
from ..auth import error_detail, require_admin
from ..usage import COMPUTE_KINDS, iso

router = APIRouter(prefix="/admin", tags=["admin"], dependencies=[Depends(require_admin)])

U = _db.User
MAX_EXPORT_ROWS = 100000


# ------------------------------------------------------------------ helpers
def _err(status_code: int, code: str, message: str) -> HTTPException:
    return HTTPException(status_code, detail=error_detail(code, message))


def _pro_expr(now: _dt.datetime):
    return or_(U.is_admin.is_(True),
               and_(U.plan == _db.PLAN_PRO, or_(U.plan_expires_at.is_(None), U.plan_expires_at > now)))


def _parse_dt(value: Optional[str], name: str, end_of_day: bool = False) -> Optional[_dt.datetime]:
    if not value:
        return None
    try:
        text = value.strip().replace("Z", "+00:00")
        if len(text) == 10:
            d = _dt.datetime.fromisoformat(text)
            return d + _dt.timedelta(days=1) if end_of_day else d
        d = _dt.datetime.fromisoformat(text)
    except ValueError:
        raise HTTPException(422, f"invalid {name}: expected ISO date or datetime")
    if d.tzinfo is not None:
        d = d.astimezone(_dt.timezone.utc).replace(tzinfo=None)
    return d


def _paginate(page: int, page_size: int, total: int) -> Dict[str, Any]:
    return {"total": total, "page": page, "page_size": page_size, "pages": max(1, math.ceil(total / page_size))}


def _percentile(values: List[float], q: float) -> float:
    if not values:
        return 0.0
    s = sorted(values)
    k = (len(s) - 1) * q
    lo, hi = math.floor(k), math.ceil(k)
    return round(s[lo] + (s[hi] - s[lo]) * (k - lo), 2)


def _audit(db, admin: U, action: str, target_user_id: Optional[int], detail: Dict[str, Any]) -> None:
    db.add(_db.AdminAuditLog(admin_id=admin.id, action=action, target_user_id=target_user_id,
                             detail=json.dumps(detail, default=str, sort_keys=True)))


def _user_item(u: U, pending: bool = False) -> Dict[str, Any]:
    return {
        "id": u.id, "username": u.username, "email": u.email, "is_verified": u.is_verified,
        "is_admin": u.is_admin, "plan": u.plan, "plan_effective": _db.effective_plan(u),
        "plan_expires_at": iso(u.plan_expires_at), "is_disabled": u.is_disabled, "note": u.admin_note,
        "created_at": iso(u.created_at), "last_login_at": iso(u.last_login_at),
        "last_seen_at": iso(u.last_seen_at), "pending_request": pending,
    }


def _pending_ids(db, ids: List[int]) -> set:
    if not ids:
        return set()
    rows = db.execute(select(_db.AccessRequest.user_id).where(
        _db.AccessRequest.user_id.in_(ids), _db.AccessRequest.status == "pending")).all()
    return {r[0] for r in rows}


def _request_item(r: _db.AccessRequest, names: Dict[int, tuple]) -> Dict[str, Any]:
    uname, email = names.get(r.user_id, (None, None))
    return {
        "id": r.id, "user_id": r.user_id, "username": uname, "email": email, "message": r.message,
        "status": r.status, "created_at": iso(r.created_at), "decided_by": r.decided_by,
        "decided_by_username": names.get(r.decided_by, (None,))[0] if r.decided_by else None,
        "decided_at": iso(r.decided_at), "decision_note": r.decision_note,
    }


def _names(db, ids) -> Dict[int, tuple]:
    ids = {i for i in ids if i is not None}
    if not ids:
        return {}
    return {r[0]: (r[1], r[2]) for r in db.execute(select(U.id, U.username, U.email).where(U.id.in_(ids))).all()}


def _usage_item(e: _db.UsageEvent, names: Dict[int, tuple]) -> Dict[str, Any]:
    return {
        "id": e.id, "ts": iso(e.ts), "user_id": e.user_id,
        "username": names.get(e.user_id, (None,))[0] if e.user_id else None,
        "endpoint": e.endpoint, "method": e.method, "status_code": e.status_code,
        "duration_ms": e.duration_ms, "ip_hash": e.ip_hash, "req_bytes": e.req_bytes, "kind": e.kind,
    }


def _day_series(counts: Dict[str, int], days: int, today: _dt.date) -> List[Dict[str, Any]]:
    out = []
    for i in range(days - 1, -1, -1):
        d = (today - _dt.timedelta(days=i)).isoformat()
        out.append({"date": d, "count": counts.get(d, 0)})
    return out


# -------------------------------------------------------------------- stats
@router.get("/stats")
def stats() -> Dict[str, Any]:
    db = _db.get_session()
    try:
        now = _db.utcnow()
        today = now.date()

        def count(*where) -> int:
            return db.execute(select(func.count()).select_from(U).where(*where)).scalar_one()

        pro = _pro_expr(now)
        total = count()
        users = {"total": total, "verified": count(U.is_verified.is_(True)), "pro": count(pro),
                 "free": count(~pro), "disabled": count(U.is_disabled.is_(True))}

        since30 = datetime_midnight(today - _dt.timedelta(days=29))
        signups: Dict[str, int] = defaultdict(int)
        for (ts,) in db.execute(select(U.created_at).where(U.created_at >= since30)).all():
            if ts is not None:
                signups[ts.date().isoformat()] += 1

        AR = _db.AccessRequest
        reqs = {
            "pending": db.execute(select(func.count()).select_from(AR).where(AR.status == "pending")).scalar_one(),
            "last_24h": db.execute(select(func.count()).select_from(AR).where(
                AR.created_at >= now - _dt.timedelta(hours=24))).scalar_one(),
            "last_7d": db.execute(select(func.count()).select_from(AR).where(
                AR.created_at >= now - _dt.timedelta(days=7))).scalar_one(),
        }

        E = _db.UsageEvent
        compute_days: Dict[str, int] = defaultdict(int)
        for (ts,) in db.execute(select(E.ts).where(E.ts >= since30, E.kind.in_(COMPUTE_KINDS))).all():
            compute_days[ts.date().isoformat()] += 1

        since7 = now - _dt.timedelta(days=7)
        lat: Dict[str, List[float]] = defaultdict(list)
        total7 = errors7 = 0
        for endpoint, status_code, dur, kind in db.execute(
                select(E.endpoint, E.status_code, E.duration_ms, E.kind).where(E.ts >= since7).limit(200000)).all():
            total7 += 1
            errors7 += 1 if status_code >= 500 else 0
            if kind in COMPUTE_KINDS:
                lat[endpoint].append(dur)
        latency = [{"endpoint": ep, "count": len(v), "p50_ms": _percentile(v, 0.5), "p95_ms": _percentile(v, 0.95)}
                   for ep, v in sorted(lat.items())]

        top_rows = db.execute(
            select(E.user_id, func.count().label("n")).where(
                E.ts >= since30, E.kind.in_(COMPUTE_KINDS), E.user_id.is_not(None))
            .group_by(E.user_id).order_by(func.count().desc()).limit(10)).all()
        names = _names(db, [r[0] for r in top_rows])
        top = [{"user_id": r[0], "username": names.get(r[0], ("(deleted)",))[0], "count": r[1]} for r in top_rows]

        return {
            "generated_at": iso(now), "users": users,
            "signups_per_day": _day_series(signups, 30, today), "requests": reqs,
            "compute_events_per_day": _day_series(compute_days, 30, today),
            "latency_by_endpoint": latency,
            "error_rate": {"window_days": 7, "total": total7, "errors": errors7,
                           "rate": round(errors7 / total7, 4) if total7 else 0.0},
            "top_users": top, "jobs": job_store.counts(),
        }
    finally:
        db.close()


def datetime_midnight(d: _dt.date) -> _dt.datetime:
    return _dt.datetime(d.year, d.month, d.day)


# -------------------------------------------------------------------- users
_SORTS = {"created_at": U.created_at, "last_seen_at": U.last_seen_at, "last_login_at": U.last_login_at,
          "username": U.username, "email": U.email}


@router.get("/users")
def list_users(
    query: Optional[str] = Query(None, max_length=200),
    plan: Literal["all", "free", "pro"] = "all",
    status: Literal["all", "active", "disabled", "verified", "unverified", "admin"] = "all",
    sort: str = "-created_at",
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=100),
) -> Dict[str, Any]:
    desc = sort.startswith("-")
    col = _SORTS.get(sort.lstrip("-"))
    if col is None:
        raise HTTPException(422, f"sort must be one of {sorted(_SORTS)} (optionally prefixed with '-')")
    now = _db.utcnow()
    where = []
    if query:
        like = f"%{query.strip().lower()}%"
        where.append(or_(func.lower(U.username).like(like), func.lower(U.email).like(like)))
    if plan == "pro":
        where.append(_pro_expr(now))
    elif plan == "free":
        where.append(~_pro_expr(now))
    if status == "active":
        where.append(U.is_disabled.is_(False))
    elif status == "disabled":
        where.append(U.is_disabled.is_(True))
    elif status == "verified":
        where.append(U.is_verified.is_(True))
    elif status == "unverified":
        where.append(U.is_verified.is_(False))
    elif status == "admin":
        where.append(U.is_admin.is_(True))
    db = _db.get_session()
    try:
        total = db.execute(select(func.count()).select_from(U).where(*where)).scalar_one()
        # NULLs last, deterministic tie-break on id.
        nulls = case((col.is_(None), 1), else_=0)
        order = [nulls, col.desc() if desc else col.asc(), U.id.desc() if desc else U.id.asc()]
        rows = db.execute(select(U).where(*where).order_by(*order)
                          .limit(page_size).offset((page - 1) * page_size)).scalars().all()
        pend = _pending_ids(db, [u.id for u in rows])
        return {"items": [_user_item(u, u.id in pend) for u in rows], **_paginate(page, page_size, total)}
    finally:
        db.close()


@router.get("/users/{user_id}")
def get_user(user_id: int) -> Dict[str, Any]:
    db = _db.get_session()
    try:
        u = db.get(U, user_id)
        if u is None:
            raise _err(404, "not_found", "No such user.")
        E, AR = _db.UsageEvent, _db.AccessRequest
        events = db.execute(select(E).where(E.user_id == user_id).order_by(E.ts.desc(), E.id.desc()).limit(50)).scalars().all()
        reqs = db.execute(select(AR).where(AR.user_id == user_id).order_by(AR.created_at.desc(), AR.id.desc())).scalars().all()
        runs = db.execute(select(func.count()).select_from(_db.UserRun).where(_db.UserRun.user_id == user_id)).scalar_one()
        names = _names(db, [user_id] + [r.decided_by for r in reqs])
        item = _user_item(u, any(r.status == "pending" for r in reqs))
        item.update({"runs_count": runs, "recent_usage": [_usage_item(e, names) for e in events],
                     "requests": [_request_item(r, names) for r in reqs]})
        return item
    finally:
        db.close()


class UserPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    plan: Optional[Literal["free", "pro"]] = None
    plan_expires_at: Optional[str] = None
    is_disabled: Optional[bool] = None
    note: Optional[str] = Field(default=None, max_length=500)


@router.patch("/users/{user_id}")
def patch_user(user_id: int, body: UserPatch, admin: U = Depends(require_admin)) -> Dict[str, Any]:
    sent = body.model_fields_set
    db = _db.get_session()
    try:
        u = db.get(U, user_id)
        if u is None:
            raise _err(404, "not_found", "No such user.")
        if u.is_admin and (body.is_disabled is True or body.plan == "free"):
            raise _err(409, "admin_protected", "Admin accounts cannot be disabled or downgraded.")
        changes: Dict[str, Any] = {}
        if "plan" in sent and body.plan is not None:
            u.plan = body.plan
            changes["plan"] = body.plan
            if body.plan == "free":
                u.plan_expires_at = None
        if "plan_expires_at" in sent and not (body.plan == "free"):
            exp = _parse_dt(body.plan_expires_at, "plan_expires_at")
            u.plan_expires_at = exp
            changes["plan_expires_at"] = iso(exp)
        if "is_disabled" in sent and body.is_disabled is not None:
            u.is_disabled = body.is_disabled
            changes["is_disabled"] = body.is_disabled
        if "note" in sent:
            u.admin_note = (body.note or "").strip() or None
            changes["note"] = u.admin_note
        _audit(db, admin, "user_update", u.id, changes)
        db.commit()
        db.refresh(u)
        return _user_item(u, bool(_pending_ids(db, [u.id])))
    finally:
        db.close()


class UserCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    username: str = Field(min_length=api_schemas.MIN_USERNAME_LENGTH, max_length=api_schemas.MAX_USERNAME_LENGTH)
    email: str = Field(min_length=3, max_length=254)
    password: Optional[str] = None
    plan: Literal["free", "pro"] = "free"
    plan_days: Optional[int] = Field(default=None, ge=1, le=3650)

    @field_validator("password")
    @classmethod
    def _pw(cls, v: Optional[str]) -> Optional[str]:
        return None if v is None else api_schemas._check_new_password(v)


@router.post("/users", status_code=201)
def create_user(body: UserCreate, admin: U = Depends(require_admin)) -> Dict[str, Any]:
    password = body.password or secrets.token_urlsafe(12)
    db = _db.get_session()
    try:
        try:
            u = _db.create_user(body.username, body.email, password, session=db)
        except (_db.DuplicateUsernameError, _db.DuplicateEmailError) as exc:
            raise _err(409, "duplicate", str(exc))
        except ValueError as exc:
            raise HTTPException(422, str(exc))
        u.is_verified = True
        u.plan = body.plan
        if body.plan == "pro" and body.plan_days:
            u.plan_expires_at = _db.utcnow() + _dt.timedelta(days=body.plan_days)
        _audit(db, admin, "user_create", u.id, {"username": u.username, "plan": body.plan, "plan_days": body.plan_days})
        db.commit()
        db.refresh(u)
        return {"user": _user_item(u), "temporary_password": password}
    finally:
        db.close()


# ----------------------------------------------------------------- requests
@router.get("/requests")
def list_requests(
    status: Literal["pending", "approved", "rejected", "all"] = "pending",
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=100),
) -> Dict[str, Any]:
    AR = _db.AccessRequest
    where = [] if status == "all" else [AR.status == status]
    db = _db.get_session()
    try:
        total = db.execute(select(func.count()).select_from(AR).where(*where)).scalar_one()
        order = [AR.created_at.asc(), AR.id.asc()] if status == "pending" else [AR.created_at.desc(), AR.id.desc()]
        rows = db.execute(select(AR).where(*where).order_by(*order)
                          .limit(page_size).offset((page - 1) * page_size)).scalars().all()
        names = _names(db, [r.user_id for r in rows] + [r.decided_by for r in rows])
        return {"items": [_request_item(r, names) for r in rows], **_paginate(page, page_size, total)}
    finally:
        db.close()


class ApproveBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    plan_days: Optional[int] = Field(default=None, ge=1, le=3650)
    note: Optional[str] = Field(default=None, max_length=500)


class RejectBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    note: Optional[str] = Field(default=None, max_length=500)


def _decide(request_id: int, admin: U, approve: bool, note: Optional[str], plan_days: Optional[int]) -> Dict[str, Any]:
    AR = _db.AccessRequest
    db = _db.get_session()
    try:
        r = db.get(AR, request_id)
        if r is None:
            raise _err(404, "not_found", "No such request.")
        if r.status != "pending":
            raise _err(409, "request_not_pending", f"This request was already {r.status}.")
        r.status = "approved" if approve else "rejected"
        r.decided_by = admin.id
        r.decided_at = _db.utcnow()
        r.decision_note = (note or "").strip() or None
        if approve:
            target = db.get(U, r.user_id)
            if target is not None:
                target.plan = _db.PLAN_PRO
                target.plan_expires_at = _db.utcnow() + _dt.timedelta(days=plan_days) if plan_days else None
        _audit(db, admin, "request_approve" if approve else "request_reject", r.user_id,
               {"request_id": r.id, "plan_days": plan_days, "note": r.decision_note})
        db.commit()
        db.refresh(r)
        return _request_item(r, _names(db, [r.user_id, r.decided_by]))
    finally:
        db.close()


@router.post("/requests/{request_id}/approve")
def approve_request(request_id: int, body: Optional[ApproveBody] = None, admin: U = Depends(require_admin)):
    body = body or ApproveBody()
    return _decide(request_id, admin, True, body.note, body.plan_days)


@router.post("/requests/{request_id}/reject")
def reject_request(request_id: int, body: Optional[RejectBody] = None, admin: U = Depends(require_admin)):
    body = body or RejectBody()
    return _decide(request_id, admin, False, body.note, None)


# -------------------------------------------------------------------- usage
def _usage_filters(from_, to, user_id, endpoint, status):
    E = _db.UsageEvent
    where = []
    start, end = _parse_dt(from_, "from"), _parse_dt(to, "to", end_of_day=True)
    if start:
        where.append(E.ts >= start)
    if end:
        where.append(E.ts < end)
    if user_id is not None:
        where.append(E.user_id == user_id)
    if endpoint:
        where.append(E.endpoint == endpoint)
    if status:
        s = status.strip().lower()
        if len(s) == 3 and s.endswith("xx") and s[0].isdigit():
            where.append(and_(E.status_code >= int(s[0]) * 100, E.status_code < int(s[0]) * 100 + 100))
        elif s.isdigit():
            where.append(E.status_code == int(s))
        else:
            raise HTTPException(422, "status must be a code like 200 or a class like 5xx")
    return where


@router.get("/usage")
def list_usage(
    from_: Optional[str] = Query(None, alias="from"),
    to: Optional[str] = None,
    user_id: Optional[int] = None,
    endpoint: Optional[str] = Query(None, max_length=200),
    status: Optional[str] = Query(None, max_length=8),
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=100),
) -> Dict[str, Any]:
    E = _db.UsageEvent
    where = _usage_filters(from_, to, user_id, endpoint, status)
    db = _db.get_session()
    try:
        total = db.execute(select(func.count()).select_from(E).where(*where)).scalar_one()
        rows = db.execute(select(E).where(*where).order_by(E.ts.desc(), E.id.desc())
                          .limit(page_size).offset((page - 1) * page_size)).scalars().all()
        names = _names(db, [e.user_id for e in rows])
        return {"items": [_usage_item(e, names) for e in rows], **_paginate(page, page_size, total)}
    finally:
        db.close()


@router.get("/usage/summary")
def usage_summary(days: int = Query(7, ge=1, le=90)) -> Dict[str, Any]:
    E = _db.UsageEvent
    now = _db.utcnow()
    since = now - _dt.timedelta(days=days)
    db = _db.get_session()
    try:
        rows = db.execute(select(E.ts, E.endpoint, E.status_code, E.duration_ms, E.kind, E.user_id, E.ip_hash)
                          .where(E.ts >= since).limit(500000)).all()
    finally:
        db.close()
    by_day: Dict[str, List[int]] = defaultdict(lambda: [0, 0])
    by_ep: Dict[str, Dict[str, Any]] = {}
    by_kind: Dict[str, int] = defaultdict(int)
    users, ips, errors = set(), set(), 0
    for ts, ep, code, dur, kind, uid, iph in rows:
        err = code >= 500
        errors += err
        d = by_day[ts.date().isoformat()]
        d[0] += 1
        d[1] += err
        e = by_ep.setdefault(ep, {"count": 0, "errors": 0, "durs": []})
        e["count"] += 1
        e["errors"] += err
        e["durs"].append(dur)
        by_kind[kind or "other"] += 1
        if uid is not None:
            users.add(uid)
        if iph:
            ips.add(iph)
    total = len(rows)
    return {
        "from": iso(since), "to": iso(now), "total": total, "errors": errors,
        "error_rate": round(errors / total, 4) if total else 0.0,
        "unique_users": len(users), "unique_ips": len(ips),
        "by_day": [{"date": k, "count": v[0], "errors": v[1]} for k, v in sorted(by_day.items())],
        "by_endpoint": [{"endpoint": k, "count": v["count"], "errors": v["errors"],
                         "p50_ms": _percentile(v["durs"], 0.5), "p95_ms": _percentile(v["durs"], 0.95)}
                        for k, v in sorted(by_ep.items())],
        "by_kind": [{"kind": k, "count": v} for k, v in sorted(by_kind.items())],
    }


@router.get("/usage/export.csv")
def export_usage(
    from_: Optional[str] = Query(None, alias="from"),
    to: Optional[str] = None,
    user_id: Optional[int] = None,
    endpoint: Optional[str] = Query(None, max_length=200),
    status: Optional[str] = Query(None, max_length=8),
    admin: U = Depends(require_admin),
) -> Response:
    E = _db.UsageEvent
    where = _usage_filters(from_, to, user_id, endpoint, status)
    db = _db.get_session()
    try:
        rows = db.execute(select(E).where(*where).order_by(E.ts.desc(), E.id.desc()).limit(MAX_EXPORT_ROWS)).scalars().all()
        _audit(db, admin, "usage_export", None, {"rows": len(rows), "from": from_, "to": to, "user_id": user_id,
                                                  "endpoint": endpoint, "status": status})
        db.commit()
    finally:
        db.close()
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["id", "ts", "user_id", "endpoint", "method", "status_code", "duration_ms", "ip_hash", "req_bytes", "kind"])
    for e in rows:
        w.writerow([e.id, iso(e.ts), e.user_id, e.endpoint, e.method, e.status_code, e.duration_ms,
                    e.ip_hash, e.req_bytes, e.kind])
    return Response(buf.getvalue(), media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": 'attachment; filename="usage.csv"', "Cache-Control": "no-store"})


# -------------------------------------------------------------------- audit
@router.get("/audit")
def audit_log(
    action: Optional[str] = Query(None, max_length=40),
    admin_id: Optional[int] = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=100),
) -> Dict[str, Any]:
    A = _db.AdminAuditLog
    where = []
    if action:
        where.append(A.action == action)
    if admin_id is not None:
        where.append(A.admin_id == admin_id)
    db = _db.get_session()
    try:
        total = db.execute(select(func.count()).select_from(A).where(*where)).scalar_one()
        rows = db.execute(select(A).where(*where).order_by(A.ts.desc(), A.id.desc())
                          .limit(page_size).offset((page - 1) * page_size)).scalars().all()
        names = _names(db, [r.admin_id for r in rows] + [r.target_user_id for r in rows])
        items = []
        for r in rows:
            try:
                detail = json.loads(r.detail) if r.detail else {}
            except ValueError:
                detail = {}
            items.append({"id": r.id, "ts": iso(r.ts), "admin_id": r.admin_id,
                          "admin_username": names.get(r.admin_id, (None,))[0], "action": r.action,
                          "target_user_id": r.target_user_id,
                          "target_username": names.get(r.target_user_id, (None,))[0] if r.target_user_id else None,
                          "detail": detail})
        return {"items": items, **_paginate(page, page_size, total)}
    finally:
        db.close()
