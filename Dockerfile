# Telomere Evolution Lab -- one image, one Railway service: FastAPI (backend/)
# serving the built React frontend (frontend/dist) on a single origin.
#
# Stage 1 builds the frontend; stage 2 is the Python runtime. Paths inside
# /app mirror the repo layout exactly, because telomere_lab.config derives
# PROJECT_ROOT from src/telomere_lab/config.py (-> /app) and backend/main.py
# serves <repo>/frontend/dist.

# ---------------------------------------------------------------- frontend
FROM node:22-alpine AS frontend
WORKDIR /build
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# ---------------------------------------------------------------- runtime
FROM python:3.13-slim AS runtime
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /app

COPY requirements.txt ./
RUN pip install -r requirements.txt

# Package metadata + source; installed editable so `import telomere_lab`
# resolves to /app/src (PROJECT_ROOT stays /app, like a local checkout).
COPY pyproject.toml README.md ./
COPY src/ ./src/
RUN pip install --no-deps -e .

COPY backend/ ./backend/
COPY configs/ ./configs/
# docs/ is excluded from the build context except this one file: backend/llm.py
# quotes its "Language policy" section verbatim in the interpreter's system prompt.
COPY docs/SCIENTIFIC_SCOPE.md ./docs/SCIENTIFIC_SCOPE.md
# The experiment ledger (experiments/runs/<id>/ + experiments/registry.jsonl)
# is created at runtime by ExperimentRegistry; the reference runs are
# git-ignored and the reports/ + reference_model/ data is only used by the
# CLI scripts, so nothing under experiments/ is baked in. `data/` holds the
# SQLite fallback DB when DATABASE_URL is unset.
RUN mkdir -p experiments/runs data

COPY --from=frontend /build/dist ./frontend/dist

EXPOSE 8000
# Railway injects PORT (currently set to 8080 on the service); fall back to
# 8000 for `docker run -p 8000:8000` without env.
CMD ["sh", "-c", "uvicorn backend.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
