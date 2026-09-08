"""User accounts + "which run belongs to which user" store.

Storage backend selection (dev vs. production):

* If the ``DATABASE_URL`` environment variable is set (Railway injects this
  automatically once a Postgres plugin is attached to the service, in the
  ``postgresql://...`` form), that database is used. SQLAlchemy's
  ``psycopg2`` driver expects the ``postgresql+psycopg2://`` scheme, so the
  raw Railway URL is rewritten defensively (``postgresql://`` ->
  ``postgresql+psycopg2://``; ``postgres://`` -> ``postgresql+psycopg2://``
  for older-style URLs some providers still hand out).
* If ``DATABASE_URL`` is not set (local dev machine, CI, ``pytest``), a
  SQLite file under ``<repo>/data/local.db`` is created and used instead,
  with exactly the same schema/interface. This fallback is what lets
  ``pytest`` and ``streamlit run app/streamlit_app.py`` work with zero setup
  on a machine that has no Postgres server at all.

This module intentionally does **not** touch the existing JSONL experiment
ledger (``telomere_lab.experiments.registry``) — that stays file-based
exactly as it is. The only thing persisted here is: (a) user accounts and
their password hashes, and (b) a join table recording which ledger
``run_id`` was produced during which user's session, so the GUI can filter
"my experiments" out of the shared ledger.
"""

from __future__ import annotations

import datetime as _dt
import os
from pathlib import Path
from typing import List, Optional

import bcrypt
from sqlalchemy import (
    DateTime,
    ForeignKey,
    String,
    UniqueConstraint,
    create_engine,
    select,
)
from sqlalchemy.orm import (
    DeclarativeBase,
    Mapped,
    Session,
    mapped_column,
    relationship,
    sessionmaker,
)

from .config import PROJECT_ROOT

DATA_DIR = PROJECT_ROOT / "data"


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    username: Mapped[str] = mapped_column(String(150), unique=True, index=True, nullable=False)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    created_at: Mapped[_dt.datetime] = mapped_column(
        DateTime, default=lambda: _dt.datetime.now(_dt.timezone.utc)
    )

    runs: Mapped[List["UserRun"]] = relationship(back_populates="user", cascade="all, delete-orphan")


class UserRun(Base):
    """Links an experiment-ledger run_id (e.g. ``TEL-20260909-001``) to the
    user whose session produced it. No experiment data is duplicated here."""

    __tablename__ = "user_runs"
    __table_args__ = (UniqueConstraint("user_id", "run_id", name="uq_user_run"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False, index=True)
    run_id: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    created_at: Mapped[_dt.datetime] = mapped_column(
        DateTime, default=lambda: _dt.datetime.now(_dt.timezone.utc)
    )

    user: Mapped["User"] = relationship(back_populates="runs")


class DuplicateUsernameError(Exception):
    """Raised by :func:`create_user` when the username is already taken."""


def _normalized_database_url() -> str:
    """Return a SQLAlchemy-ready database URL.

    ``DATABASE_URL`` (set) -> Postgres, with the driver scheme fixed up.
    Not set -> a SQLite file under ``data/local.db`` (dir created if needed).
    """
    raw = os.environ.get("DATABASE_URL")
    if raw:
        if raw.startswith("postgres://"):
            return "postgresql+psycopg2://" + raw[len("postgres://"):]
        if raw.startswith("postgresql://"):
            return "postgresql+psycopg2://" + raw[len("postgresql://"):]
        return raw  # already a fully-qualified SQLAlchemy URL (e.g. in tests)

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    db_path = DATA_DIR / "local.db"
    return f"sqlite:///{db_path.as_posix()}"


_engine = None
_SessionLocal: Optional[sessionmaker] = None


def get_engine(database_url: Optional[str] = None):
    """Return the process-wide SQLAlchemy engine, creating it (and the
    tables, if missing) on first use. Pass ``database_url`` explicitly for
    tests that want an isolated database."""
    global _engine, _SessionLocal
    if database_url is not None:
        engine = create_engine(database_url, future=True)
        Base.metadata.create_all(engine)
        return engine
    if _engine is None:
        url = _normalized_database_url()
        connect_args = {"check_same_thread": False} if url.startswith("sqlite") else {}
        _engine = create_engine(url, future=True, connect_args=connect_args)
        Base.metadata.create_all(_engine)
        _SessionLocal = sessionmaker(bind=_engine, expire_on_commit=False, future=True)
    return _engine


def get_session(database_url: Optional[str] = None) -> Session:
    """Return a new SQLAlchemy session bound to the configured engine."""
    if database_url is not None:
        engine = get_engine(database_url)
        return sessionmaker(bind=engine, expire_on_commit=False, future=True)()
    get_engine()  # ensure _SessionLocal is initialised
    assert _SessionLocal is not None
    return _SessionLocal()


def reset_engine() -> None:
    """Drop the cached engine/session factory (used by tests between runs)."""
    global _engine, _SessionLocal
    _engine = None
    _SessionLocal = None


# --------------------------------------------------------------- passwords
def _hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def _verify_password(password: str, password_hash: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode("utf-8"), password_hash.encode("utf-8"))
    except ValueError:
        return False


# ------------------------------------------------------------------- API
def create_user(username: str, password: str, session: Optional[Session] = None) -> User:
    """Create a new user. Raises :class:`DuplicateUsernameError` if the
    username is already taken."""
    username = username.strip()
    if not username:
        raise ValueError("username must not be empty")
    if not password:
        raise ValueError("password must not be empty")

    own_session = session is None
    db = session or get_session()
    try:
        existing = db.execute(select(User).where(User.username == username)).scalar_one_or_none()
        if existing is not None:
            raise DuplicateUsernameError(f"username {username!r} is already taken")
        user = User(username=username, password_hash=_hash_password(password))
        db.add(user)
        db.commit()
        db.refresh(user)
        return user
    finally:
        if own_session:
            db.close()


def authenticate(username: str, password: str, session: Optional[Session] = None) -> Optional[User]:
    """Return the :class:`User` if credentials are valid, else ``None``."""
    own_session = session is None
    db = session or get_session()
    try:
        user = db.execute(select(User).where(User.username == username.strip())).scalar_one_or_none()
        if user is None:
            return None
        if not _verify_password(password, user.password_hash):
            return None
        return user
    finally:
        if own_session:
            db.close()


def record_user_run(user_id: int, run_id: str, session: Optional[Session] = None) -> None:
    """Record that ``run_id`` (from the JSONL experiment ledger) belongs to
    ``user_id``. Idempotent: recording the same pair twice is a no-op."""
    own_session = session is None
    db = session or get_session()
    try:
        exists = db.execute(
            select(UserRun).where(UserRun.user_id == user_id, UserRun.run_id == run_id)
        ).scalar_one_or_none()
        if exists is not None:
            return
        db.add(UserRun(user_id=user_id, run_id=run_id))
        db.commit()
    finally:
        if own_session:
            db.close()


def list_user_runs(user_id: int, session: Optional[Session] = None) -> List[str]:
    """Return the list of ledger run_ids recorded for ``user_id``, most
    recent first."""
    own_session = session is None
    db = session or get_session()
    try:
        rows = db.execute(
            select(UserRun.run_id)
            .where(UserRun.user_id == user_id)
            .order_by(UserRun.created_at.desc())
        ).scalars().all()
        return list(rows)
    finally:
        if own_session:
            db.close()
