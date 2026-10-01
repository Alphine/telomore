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
  ``pytest`` and ``uvicorn backend.main:app`` work with zero setup on a
  machine that has no Postgres server at all.

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
import secrets
from pathlib import Path
from typing import List, Optional, Tuple

import bcrypt
from sqlalchemy import (
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
    create_engine,
    func,
    inspect as sa_inspect,
    select,
    text,
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
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True, nullable=False)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    created_at: Mapped[_dt.datetime] = mapped_column(
        DateTime, default=lambda: _dt.datetime.now(_dt.timezone.utc)
    )

    # ------------------------------------------------------- email verification
    is_verified: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    verification_token: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    verification_token_created_at: Mapped[Optional[_dt.datetime]] = mapped_column(DateTime, nullable=True)

    # ----------------------------------------------------------- password reset
    reset_token: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    reset_token_expires_at: Mapped[Optional[_dt.datetime]] = mapped_column(DateTime, nullable=True)

    # ------------------------------------------------------- plan / admin
    is_admin: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    plan: Mapped[str] = mapped_column(String(16), default="free", nullable=False)
    is_disabled: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    plan_expires_at: Mapped[Optional[_dt.datetime]] = mapped_column(DateTime, nullable=True)
    last_login_at: Mapped[Optional[_dt.datetime]] = mapped_column(DateTime, nullable=True)
    last_seen_at: Mapped[Optional[_dt.datetime]] = mapped_column(DateTime, nullable=True)
    admin_note: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)

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


def utcnow() -> _dt.datetime:
    """Naive UTC "now" (all new datetime columns store naive UTC)."""
    return _dt.datetime.now(_dt.timezone.utc).replace(tzinfo=None)


class AccessRequest(Base):
    """A user asking an admin for PRO access."""

    __tablename__ = "access_requests"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False, index=True)
    message: Mapped[str] = mapped_column(String(500), default="", nullable=False)
    status: Mapped[str] = mapped_column(String(16), default="pending", nullable=False, index=True)
    created_at: Mapped[_dt.datetime] = mapped_column(DateTime, default=utcnow, nullable=False)
    decided_by: Mapped[Optional[int]] = mapped_column(ForeignKey("users.id"), nullable=True)
    decided_at: Mapped[Optional[_dt.datetime]] = mapped_column(DateTime, nullable=True)
    decision_note: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)


class UsageEvent(Base):
    """One API request. Route template only; no bodies, tokens or raw IPs."""

    __tablename__ = "usage_events"

    id: Mapped[int] = mapped_column(primary_key=True)
    ts: Mapped[_dt.datetime] = mapped_column(DateTime, default=utcnow, nullable=False, index=True)
    user_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True, index=True)
    endpoint: Mapped[str] = mapped_column(String(200), nullable=False)
    method: Mapped[str] = mapped_column(String(10), nullable=False)
    status_code: Mapped[int] = mapped_column(Integer, nullable=False)
    duration_ms: Mapped[float] = mapped_column(Float, nullable=False)
    ip_hash: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)
    req_bytes: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    kind: Mapped[Optional[str]] = mapped_column(String(16), nullable=True)


class AdminAuditLog(Base):
    __tablename__ = "admin_audit_log"

    id: Mapped[int] = mapped_column(primary_key=True)
    ts: Mapped[_dt.datetime] = mapped_column(DateTime, default=utcnow, nullable=False, index=True)
    admin_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    action: Mapped[str] = mapped_column(String(40), nullable=False)
    target_user_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True, index=True)
    detail: Mapped[Optional[str]] = mapped_column(Text, nullable=True)  # JSON string


class DuplicateUsernameError(Exception):
    """Raised by :func:`create_user` when the username is already taken."""


class DuplicateEmailError(Exception):
    """Raised by :func:`create_user` when the email is already registered."""


# Reset tokens are valid for this long after being issued.
RESET_TOKEN_LIFETIME = _dt.timedelta(hours=1)


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


def column_ddl(table, col, dialect) -> List[str]:
    """DDL statements that add ``col`` to an existing ``table`` for ``dialect``.

    Pure (no connection) so it can be rendered and checked against the
    PostgreSQL dialect in tests. Identifiers are quoted through the dialect's
    preparer (so reserved words are safe), boolean/string defaults are emitted
    as valid literals, and on PostgreSQL ``ADD COLUMN IF NOT EXISTS`` makes the
    sync idempotent when two replicas boot at once.
    """
    quote = dialect.identifier_preparer.quote
    tbl, name = quote(table.name), quote(col.name)
    if_not_exists = "IF NOT EXISTS " if dialect.name == "postgresql" else ""
    ddl = f"ALTER TABLE {tbl} ADD COLUMN {if_not_exists}{name} {col.type.compile(dialect=dialect)}"
    default = col.default.arg if col.default is not None else None
    if default is not None and not callable(default):
        if isinstance(default, bool):
            literal = "TRUE" if default else "FALSE"
        elif isinstance(default, (int, float)):
            literal = repr(default)
        else:
            literal = "'" + str(default).replace("'", "''") + "'"
        ddl += " DEFAULT " + literal
    out = [ddl]
    if col.unique or col.index:
        kind = "UNIQUE INDEX" if col.unique else "INDEX"
        idx = quote(f"ix_{table.name}_{col.name}")
        out.append(f"CREATE {kind} IF NOT EXISTS {idx} ON {tbl} ({name})")
    return out


def _add_missing_columns(engine) -> List[str]:
    """Additive schema sync: add model columns missing from existing tables.

    ``create_all`` only creates tables that do not exist yet, so a database
    created by an older release keeps its old column set (this bit the
    production Postgres when email verification was added). New columns are
    added nullable (existing rows cannot satisfy NOT NULL), with the model's
    scalar default when it has one, plus a unique index where the model asks
    for one. Returns the ``table.column`` names that were added.
    """
    inspector = sa_inspect(engine)
    added: List[str] = []
    with engine.begin() as conn:
        for table in Base.metadata.sorted_tables:
            if not inspector.has_table(table.name):
                continue
            existing = {c["name"] for c in inspector.get_columns(table.name)}
            for col in table.columns:
                if col.name in existing:
                    continue
                for stmt in column_ddl(table, col, engine.dialect):
                    conn.execute(text(stmt))
                added.append(f"{table.name}.{col.name}")
    return added


def _init_schema(engine) -> None:
    Base.metadata.create_all(engine)
    _add_missing_columns(engine)


_engine = None
_SessionLocal: Optional[sessionmaker] = None


def get_engine(database_url: Optional[str] = None):
    """Return the process-wide SQLAlchemy engine, creating it (and the
    tables, if missing) on first use. Pass ``database_url`` explicitly for
    tests that want an isolated database."""
    global _engine, _SessionLocal
    if database_url is not None:
        engine = create_engine(database_url, future=True)
        _init_schema(engine)
        return engine
    if _engine is None:
        url = _normalized_database_url()
        connect_args = {"check_same_thread": False} if url.startswith("sqlite") else {}
        _engine = create_engine(url, future=True, connect_args=connect_args)
        _init_schema(_engine)
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
    raw = password.encode("utf-8")
    if len(raw) > 72:  # bcrypt >= 5 raises on longer input; fail with a clear, catchable message
        raise ValueError("password must be at most 72 bytes in UTF-8")
    return bcrypt.hashpw(raw, bcrypt.gensalt()).decode("utf-8")


def _verify_password(password: str, password_hash: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode("utf-8"), password_hash.encode("utf-8"))
    except ValueError:
        return False


# ------------------------------------------------------------------- API
def create_user(username: str, email: str, password: str, session: Optional[Session] = None) -> User:
    """Create a new user. Raises :class:`DuplicateUsernameError` /
    :class:`DuplicateEmailError` if the username / email is already taken.

    The new user starts with ``is_verified=False``; the caller is expected
    to immediately call :func:`generate_verification_token` and send (or,
    in dev mode, display) the verification link."""
    username = username.strip()
    email = email.strip().lower()
    if not username:
        raise ValueError("username must not be empty")
    if not email:
        raise ValueError("email must not be empty")
    if not password:
        raise ValueError("password must not be empty")

    own_session = session is None
    db = session or get_session()
    try:
        existing_username = db.execute(
            select(User).where(User.username == username)
        ).scalar_one_or_none()
        if existing_username is not None:
            raise DuplicateUsernameError(f"username {username!r} is already taken")
        existing_email = db.execute(select(User).where(User.email == email)).scalar_one_or_none()
        if existing_email is not None:
            raise DuplicateEmailError(f"email {email!r} is already registered")
        user = User(username=username, email=email, password_hash=_hash_password(password))
        db.add(user)
        db.commit()
        db.refresh(user)
        return user
    finally:
        if own_session:
            db.close()


def _find_login_user(db: Session, login: str) -> Optional[User]:
    """Resolve what a person typed in the login box to one account.

    Exact username first; otherwise the email address (case-insensitive,
    emails are unique); otherwise a case-insensitive username, but only when
    exactly one account matches -- never guess between ``Alice`` and ``alice``.
    """
    login = login.strip()
    if not login:
        return None
    user = db.execute(select(User).where(User.username == login)).scalar_one_or_none()
    if user is not None:
        return user
    if "@" in login:
        user = db.execute(select(User).where(func.lower(User.email) == login.lower())).scalar_one_or_none()
        if user is not None:
            return user
    matches = db.execute(select(User).where(func.lower(User.username) == login.lower()).limit(2)).scalars().all()
    return matches[0] if len(matches) == 1 else None


def authenticate(username: str, password: str, session: Optional[Session] = None) -> Optional[User]:
    """Return the :class:`User` if credentials are valid, else ``None``.

    ``username`` may be the username or the account's email address
    (see :func:`_find_login_user`)."""
    own_session = session is None
    db = session or get_session()
    try:
        user = _find_login_user(db, username)
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


# ------------------------------------------------------- email verification
def generate_verification_token(user_id: int, session: Optional[Session] = None) -> str:
    """Create (or replace) a verification token for ``user_id`` and return
    the raw token. Verification tokens do not expire (a deliberate scope
    limitation - see README)."""
    own_session = session is None
    db = session or get_session()
    try:
        user = db.get(User, user_id)
        if user is None:
            raise ValueError(f"no user with id {user_id!r}")
        token = secrets.token_urlsafe(32)
        user.verification_token = token
        user.verification_token_created_at = _dt.datetime.now(_dt.timezone.utc)
        db.add(user)
        db.commit()
        return token
    finally:
        if own_session:
            db.close()


def verify_email(token: str, session: Optional[Session] = None) -> Optional[User]:
    """Mark the user owning ``token`` as verified and clear the token.

    Returns the :class:`User` on success, ``None`` if the token is invalid
    (unknown or already used)."""
    if not token:
        return None
    own_session = session is None
    db = session or get_session()
    try:
        user = db.execute(
            select(User).where(User.verification_token == token)
        ).scalar_one_or_none()
        if user is None:
            return None
        user.is_verified = True
        user.verification_token = None
        user.verification_token_created_at = None
        db.add(user)
        db.commit()
        db.refresh(user)
        return user
    finally:
        if own_session:
            db.close()


# ----------------------------------------------------------------- password reset
def request_password_reset(email: str, session: Optional[Session] = None) -> Optional[Tuple[User, str]]:
    """Issue a password-reset token (valid for :data:`RESET_TOKEN_LIFETIME`)
    for the user with ``email``.

    Returns ``(user, raw_token)`` on success, ``None`` if no user with that
    email exists. NOTE on the dev/prod asymmetry: the *production* UI must
    show a generic "if an account exists..." message regardless of this
    function's return value, so as not to leak which emails are registered.
    In dev mode (no RESEND_API_KEY), the caller is allowed to be more
    revealing - showing the raw link on screen when a user *was* found - for
    local testing convenience; that is a deliberate, documented trade-off,
    not an oversight."""
    own_session = session is None
    db = session or get_session()
    try:
        user = db.execute(
            select(User).where(User.email == email.strip().lower())
        ).scalar_one_or_none()
        if user is None:
            return None
        token = secrets.token_urlsafe(32)
        user.reset_token = token
        user.reset_token_expires_at = _dt.datetime.now(_dt.timezone.utc) + RESET_TOKEN_LIFETIME
        db.add(user)
        db.commit()
        db.refresh(user)
        return user, token
    finally:
        if own_session:
            db.close()


def reset_password(token: str, new_password: str, session: Optional[Session] = None) -> bool:
    """Validate ``token`` (must exist and not be expired) and set
    ``new_password`` for its owner, clearing the reset token.

    Returns ``True`` on success, ``False`` if the token is invalid, unknown,
    or expired."""
    if not token or not new_password:
        return False
    own_session = session is None
    db = session or get_session()
    try:
        user = db.execute(select(User).where(User.reset_token == token)).scalar_one_or_none()
        if user is None:
            return False
        expires_at = user.reset_token_expires_at
        if expires_at is not None and expires_at.tzinfo is None:
            expires_at = expires_at.replace(tzinfo=_dt.timezone.utc)
        if expires_at is None or expires_at < _dt.datetime.now(_dt.timezone.utc):
            return False
        user.password_hash = _hash_password(new_password)
        user.reset_token = None
        user.reset_token_expires_at = None
        db.add(user)
        db.commit()
        return True
    finally:
        if own_session:
            db.close()


# ------------------------------------------------------------ plans / admins
PLAN_FREE = "free"
PLAN_PRO = "pro"


def admin_identifiers() -> set:
    """Lower-cased usernames/emails listed in ``TELOMERE_ADMIN_USERS``."""
    raw = os.environ.get("TELOMERE_ADMIN_USERS", "")
    return {p.strip().lower() for p in raw.split(",") if p.strip()}


def is_env_admin(user: User) -> bool:
    """Listed in ``TELOMERE_ADMIN_USERS`` *and* email-verified. Requiring a
    verified address stops someone from squatting a listed username (or an
    email they do not control) to become an admin."""
    ids = admin_identifiers()
    return bool(ids) and user.is_verified and (user.username.lower() in ids or user.email.lower() in ids)


def effective_plan(user: User, now: Optional[_dt.datetime] = None) -> str:
    """``pro`` only while the plan has not expired (admins always count as pro)."""
    if user.is_admin:
        return PLAN_PRO
    if user.plan != PLAN_PRO:
        return PLAN_FREE
    exp = user.plan_expires_at
    if exp is not None:
        if exp.tzinfo is not None:
            exp = exp.astimezone(_dt.timezone.utc).replace(tzinfo=None)
        if exp <= (now or utcnow()):
            return PLAN_FREE
    return PLAN_PRO


def apply_admin_bootstrap(session: Optional[Session] = None) -> int:
    """Promote every user matching ``TELOMERE_ADMIN_USERS`` (username or
    email, case-insensitive) to admin + pro. The only path that creates an
    admin. Returns how many rows changed."""
    ids = admin_identifiers()
    if not ids:
        return 0
    own = session is None
    db = session or get_session()
    try:
        users = db.execute(
            select(User).where(
                User.is_verified.is_(True),
                (func.lower(User.username).in_(ids)) | (func.lower(User.email).in_(ids)),
            )
        ).scalars().all()
        changed = 0
        for u in users:
            if not u.is_admin or u.plan != PLAN_PRO or u.is_disabled or u.plan_expires_at is not None:
                u.is_admin = True
                u.plan = PLAN_PRO
                u.plan_expires_at = None
                u.is_disabled = False
                changed += 1
        if changed:
            db.commit()
        return changed
    finally:
        if own:
            db.close()


def record_login(user_id: int) -> Optional[User]:
    """Stamp ``last_login_at``, re-apply the admin bootstrap for this user
    and return the fresh row."""
    db = get_session()
    try:
        user = db.get(User, user_id)
        if user is None:
            return None
        user.last_login_at = utcnow()
        user.last_seen_at = user.last_login_at
        if is_env_admin(user):
            user.is_admin = True
            user.plan = PLAN_PRO
            user.plan_expires_at = None
            user.is_disabled = False
        db.commit()
        db.refresh(user)
        return user
    finally:
        db.close()


def touch_last_seen(user_id: int, min_interval: _dt.timedelta = _dt.timedelta(minutes=5)) -> None:
    """Best-effort ``last_seen_at`` update, at most once per ``min_interval``."""
    try:
        now = utcnow()
        db = get_session()
        try:
            user = db.get(User, user_id)
            if user is not None and (user.last_seen_at is None or now - user.last_seen_at > min_interval):
                user.last_seen_at = now
                db.commit()
        finally:
            db.close()
    except Exception:  # noqa: BLE001 - never break a request over a timestamp
        pass
