"""FastAPI app factory/entrypoint -- Phase 1 of the Streamlit -> React migration.

Run locally with::

    uvicorn backend.main:app --reload

See docs/API.md for the full endpoint list and the job-polling contract.

IMPORTANT: this app is NOT wired into the Railway start command yet. The
live Railway deploy keeps running Streamlit (``app/streamlit_app.py`` via
the existing Procfile) throughout this migration; this module only needs to
run locally for React frontend development in a later phase.
"""

from __future__ import annotations

import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .routers import (
    active_learning,
    auth,
    benchmark,
    evolve,
    experiments,
    jobs,
    pareto,
    sensitivity,
    simulate,
)


def create_app() -> FastAPI:
    app = FastAPI(
        title="Telomere Evolution Lab API",
        description="REST API wrapping telomere_lab's simulation/optimization service layer. "
                     "Phase 1 of a migration off the Streamlit GUI in app/ (still the live production UI).",
        version="0.1.0",
    )

    # Vite's default dev-server origin, plus an env-configurable production
    # origin placeholder. TODO(Phase 2+): once the React app has a real
    # deployed URL, set FRONTEND_ORIGIN in Railway and tighten this list --
    # do not ship a wildcard production origin.
    allowed_origins = ["http://localhost:5173", "http://127.0.0.1:5173"]
    extra_origin = os.environ.get("FRONTEND_ORIGIN")
    if extra_origin:
        allowed_origins.append(extra_origin)

    app.add_middleware(
        CORSMiddleware,
        allow_origins=allowed_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.get("/api/health", tags=["health"])
    def health() -> dict:
        return {"status": "ok"}

    app.include_router(auth.router, prefix="/api")
    app.include_router(simulate.router, prefix="/api")
    app.include_router(evolve.router, prefix="/api")
    app.include_router(pareto.router, prefix="/api")
    app.include_router(sensitivity.router, prefix="/api")
    app.include_router(active_learning.router, prefix="/api")
    app.include_router(benchmark.router, prefix="/api")
    app.include_router(experiments.router, prefix="/api")
    app.include_router(jobs.router, prefix="/api")

    return app


app = create_app()
