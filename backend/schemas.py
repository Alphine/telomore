"""Pydantic request/response models -- the API's own contract layer.

Deliberately separate from ``telomere_lab.schemas`` (the dataclasses used by
the simulation/optimization engines): those stay engine-internal and
dependency-light, these are the wire format. Routers convert between the two
at the boundary (``telomere_lab.schemas.ModelConfig.from_dict(...)`` etc.).

Config blocks (``model``, ``evolution``, ``multiobjective``, ``sensitivity``,
``active_learning``) are accepted as free-form dicts rather than being
re-typed field-by-field here: ``telomere_lab.schemas`` is the single source
of truth for field names/bounds (``PARAMETER_BOUNDS``, ``EVOLVABLE_PARAMETERS``),
and each dataclass's own ``.from_dict().validate()` already does full
validation, raising ``ConfigError`` (mapped to HTTP 400 by the routers).
Re-declaring every field here would just be a second copy of that contract
to keep in sync.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


# --------------------------------------------------------------------------- #
# auth
# --------------------------------------------------------------------------- #
class RegisterRequest(BaseModel):
    username: str = Field(min_length=1)
    email: str = Field(min_length=3)
    password: str = Field(min_length=1)


class RegisterResponse(BaseModel):
    message: str
    dev_verification_link: Optional[str] = None


class VerifyResponse(BaseModel):
    message: str
    verified: bool


class LoginRequest(BaseModel):
    username: str
    password: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"


class ForgotPasswordRequest(BaseModel):
    email: str = Field(min_length=3)


class ForgotPasswordResponse(BaseModel):
    message: str
    dev_reset_link: Optional[str] = None


class ResetPasswordRequest(BaseModel):
    token: str
    new_password: str = Field(min_length=1)


class MessageResponse(BaseModel):
    message: str


class UserResponse(BaseModel):
    id: int
    username: str
    email: str
    is_verified: bool


# --------------------------------------------------------------------------- #
# simulate
# --------------------------------------------------------------------------- #
class SimulateRequest(BaseModel):
    config: Dict[str, Any] = Field(default_factory=dict)


class SimulateResponse(BaseModel):
    run: Dict[str, Any]


# --------------------------------------------------------------------------- #
# long-running jobs (evolve / pareto / sensitivity / active-learning / benchmark)
# --------------------------------------------------------------------------- #
class EvolveRequest(BaseModel):
    model: Dict[str, Any] = Field(default_factory=dict)
    evolution: Dict[str, Any] = Field(default_factory=dict)
    notes: str = ""


class ParetoRequest(BaseModel):
    model: Dict[str, Any] = Field(default_factory=dict)
    multiobjective: Dict[str, Any] = Field(default_factory=dict)
    notes: str = ""


class SensitivityRequest(BaseModel):
    model: Dict[str, Any] = Field(default_factory=dict)
    sensitivity: Dict[str, Any] = Field(default_factory=dict)
    notes: str = ""


class ActiveLearningRequest(BaseModel):
    model: Dict[str, Any] = Field(default_factory=dict)
    active_learning: Dict[str, Any] = Field(default_factory=dict)
    notes: str = ""


class BenchmarkRequest(BaseModel):
    model: Dict[str, Any] = Field(default_factory=dict)
    evolution: Dict[str, Any] = Field(default_factory=dict)
    multiobjective: Dict[str, Any] = Field(default_factory=dict)
    notes: str = ""


class JobStartResponse(BaseModel):
    job_id: str


class JobStatusResponse(BaseModel):
    job_id: str
    kind: str
    status: str  # pending | running | completed | failed | stopped
    progress: Optional[Dict[str, Any]] = None
    result: Optional[Dict[str, Any]] = None
    error: Optional[str] = None
    created_at: str
    updated_at: str


# --------------------------------------------------------------------------- #
# experiments
# --------------------------------------------------------------------------- #
class ExperimentSummary(BaseModel):
    run_id: str
    kind: Optional[str] = None
    created_at: Optional[str] = None
    fitness: Optional[float] = None
    runtime_seconds: Optional[float] = None
    notes: Optional[str] = None
    mine: bool = False


class ExperimentDetail(BaseModel):
    record: Dict[str, Any]
    artifacts: Dict[str, str] = Field(default_factory=dict)
