"""FastAPI app factory/entrypoint -- the production server.

Run locally with::

    uvicorn backend.main:app --reload

See docs/API.md for the full endpoint list, the job-polling contract and the
deployment notes. In production (Railway, see the root ``Dockerfile``) this
single process serves both the ``/api`` routes and the built React frontend
in ``frontend/dist``.
"""

from __future__ import annotations

import os
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .routers import (
    active_learning,
    auth,
    benchmark,
    compare,
    evolve,
    experiments,
    gxe,
    jobs,
    llm,
    meta,
    pareto,
    sensitivity,
    sequence,
    simulate,
)

# Built React frontend: ``cd frontend && npm run build`` writes here (the
# Dockerfile copies the build to the same relative path). Served by this app
# when present so ONE Railway service hosts API + frontend (docs/ROADMAP.md).
# Absent in tests / API-only dev runs -> no-op.
FRONTEND_DIST = Path(__file__).resolve().parents[1] / "frontend" / "dist"


def _mount_frontend(app: FastAPI, dist: Path) -> None:
    dist = dist.resolve()
    index_html = dist / "index.html"
    if not index_html.is_file():
        return

    assets = dist / "assets"
    if assets.is_dir():
        app.mount("/assets", StaticFiles(directory=str(assets)), name="frontend-assets")

    # SPA fallback: any non-/api GET falls through to index.html so the React
    # router handles client-side routes (/login, /simulate, ...). Registered
    # AFTER the API routers, so real endpoints win; unknown /api/... paths
    # still get FastAPI's own JSON 404 rather than the HTML shell.
    @app.get("/{full_path:path}", include_in_schema=False)
    def spa_fallback(full_path: str) -> FileResponse:
        if full_path == "api" or full_path.startswith("api/"):
            raise HTTPException(404, "Not Found")
        candidate = dist / full_path
        # Top-level static files in dist/ (favicon.svg etc.), no traversal.
        if full_path and candidate.is_file() and dist in candidate.resolve().parents:
            return FileResponse(candidate)
        return FileResponse(index_html)


def create_app() -> FastAPI:
    app = FastAPI(
        title="Telomere Evolution Lab API",
        description="REST API wrapping telomere_lab's simulation/optimization service layer; "
                     "also serves the built React frontend (frontend/dist) when present.",
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
    app.include_router(gxe.router, prefix="/api")
    app.include_router(active_learning.router, prefix="/api")
    app.include_router(benchmark.router, prefix="/api")
    app.include_router(compare.router, prefix="/api")
    app.include_router(experiments.router, prefix="/api")
    app.include_router(jobs.router, prefix="/api")
    app.include_router(llm.router, prefix="/api")
    app.include_router(meta.router, prefix="/api")
    app.include_router(sequence.router, prefix="/api")

    _mount_frontend(app, FRONTEND_DIST)

    return app


app = create_app()
