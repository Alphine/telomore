# FastAPI backend (Phase 1 of the Streamlit → React migration)

This is **Phase 1** of a deliberate, multi-session migration off the
Streamlit GUI (`app/`) to a React frontend backed by this REST API. It
exists because Streamlit's UX and simulation-interactivity (live-updating
charts during a long-running optimization) feel limited for this project.

**The Streamlit app in `app/` remains the live production UI** throughout
this migration and is untouched by this phase — it keeps running exactly as
it does today, deployed via the existing `Procfile`/`railway.json`. This API
is not wired into that start command yet; it only needs to run locally for
React frontend development in a later phase. Later phases will build the
React app against the contract documented here while Streamlit stays live.

The API is a thin wrapper around `telomere_lab.experiments.runner` (the
existing service layer already shared by the CLI scripts and the Streamlit
pages) — no simulation/optimization logic was reimplemented or restructured.

## Running it locally

```bash
pip install -r requirements.txt          # now includes fastapi, uvicorn, pyjwt
uvicorn backend.main:app --reload --port 8000
curl http://127.0.0.1:8000/api/health    # {"status": "ok"}
```

Environment variables (all optional for local dev, with the same
env-var-with-dev-fallback pattern already used by `DATABASE_URL` in
`telomere_lab/db.py` and `RESEND_API_KEY` in `telomere_lab/email.py`):

| Variable | Purpose | Dev fallback |
|---|---|---|
| `SECRET_KEY` | Signs JWTs | random per-process secret (logged as a loud warning); **must** be set as a real Railway env var before this API is ever deployed, otherwise every issued token is invalidated on each restart/redeploy |
| `DATABASE_URL` | Postgres connection (Railway) | SQLite file at `data/local.db` |
| `RESEND_API_KEY` | Transactional email | emails are not sent; `dev_verification_link` / `dev_reset_link` are returned in the JSON response instead |
| `FRONTEND_ORIGIN` | Extra allowed CORS origin for the deployed React app | not set — only `http://localhost:5173` (Vite default) is allowed besides it |
| `FRONTEND_BASE_URL` | Base URL used to build verification/reset links | empty → relative link (`/?token=...`) |

## Auth flow

1. `POST /api/auth/register` `{username, email, password}` → `201`, `{message, dev_verification_link?}`.
   `dev_verification_link` is present only when Resend is not configured
   (dev mode); in production it is emailed instead. Duplicate username/email
   → `409`.
2. `GET /api/auth/verify?token=...` → `{message, verified}`. **Note the
   query param is `token`**, not `verify_token` like the Streamlit app's
   query-param routing — a deliberate, documented difference since the
   Streamlit app derives its param names from its own page-routing needs,
   while this is a clean REST contract the React app is written against.
3. `POST /api/auth/login` `{username, password}` →
   * `401` if credentials are wrong,
   * `403` if the account exists but is not yet verified (no token issued),
   * `200` `{access_token, token_type: "bearer"}` otherwise. Token is a
     7-day JWT (`HS256`) carrying `sub` (user id) and `username`.
4. Send `Authorization: Bearer <token>` on every protected route.
   `GET /api/auth/me` returns `{id, username, email, is_verified}`.
5. `POST /api/auth/forgot-password` `{email}` → always the same generic
   `200` message regardless of whether the account exists (security
   requirement carried over from the Streamlit version). In dev mode (no
   `RESEND_API_KEY`) *and* the account exists, the response additionally
   carries `dev_reset_link` for local testing — production never does this.
6. `POST /api/auth/reset-password` `{token, new_password}` → `200` on
   success, `400` if the token is invalid/expired/unknown.

Every protected route depends on `backend.auth.get_current_user`, which
extracts + verifies the JWT, loads the user, and gates on **both** a valid
token **and** `is_verified` (401 vs. 403 respectively) — the single auth gate
every route below uses, mirroring `require_login()` in the Streamlit app.

## Simulate (synchronous)

`POST /api/simulate` `{config: {...ModelConfig fields...}}` (protected) runs
one simulation synchronously (sub-second per
`tests/test_simulator.py::test_runtime_target_default_config`) and returns
the full result as JSON (`SimulationResult.to_json_dict()` plus `run_id` and
`fitness`). Unknown/invalid fields → `400` (via `ModelConfig.validate()`
raising `ConfigError`). The run is recorded in the shared experiment ledger
and tagged as belonging to the calling user.

## Long-running jobs (evolve / pareto / sensitivity / active-learning / benchmark)

These `POST` a config body and return `{"job_id": "..."}` immediately,
instead of blocking on the whole run. Poll:

* `GET /api/jobs/{job_id}` (owner only, 403 for anyone else) →
  `{job_id, kind, status, progress, result, error, created_at, updated_at}`.
  `status` is one of `pending` / `running` / `completed` / `failed` /
  `stopped`. `progress` is whatever shape the underlying engine's own
  `progress_callback` already produces (see below) — reused verbatim, no new
  progress format was invented.
* `POST /api/jobs/{job_id}/stop` (owner only) — sets a stop flag. Only
  effective on engines that support cooperative cancellation (see table).

**Job-abstraction design** (`backend/jobs.py`): a module-level dict keyed by
a UUID4 job id holds each job's status, progress payload, final result, and
a `threading.Event` stop flag. Starting a job spawns a daemon
`threading.Thread` (not FastAPI's `BackgroundTasks`, since the client needs
the job id back *before* the run finishes, to start polling immediately).
This is a single-process, in-memory store — no Redis/Celery — which is a
known, documented scaling limit fine for this project's current scale (one
Railway service, no horizontal scaling): jobs do not survive a process
restart and are invisible across worker processes if the service is ever
scaled out.

| Endpoint | Wraps | Live progress? | Stop supported? |
|---|---|---|---|
| `POST /api/evolve` | `EvolutionEngine.run` via `runner.run_evolution` | Yes — `GenerationRecord.to_dict()` per generation | Yes — `should_stop` already exists on the engine |
| `POST /api/pareto` | `NSGA2Engine.run` via `runner.run_pareto` | Yes — `MOGenerationRecord.to_dict()` per generation | Yes — `should_stop` already exists on the engine |
| `POST /api/sensitivity` | `run_sensitivity_analysis` via `runner.run_sensitivity` | Yes — `ParameterSensitivity.to_dict()` per parameter | No — the function has no `should_stop` hook; adding one would touch its per-parameter loop, judged out of scope for a short OAT sweep |
| `POST /api/active-learning` | `SurrogateActiveLearner.run` via `runner.run_active_learning` | Yes — `ActiveLearningRecord.to_dict()` per real evaluation | No — no `should_stop` hook on the GP-refit/acquire loop; adding one would touch `evolution/surrogate.py`'s core cycle |
| `POST /api/benchmark` | `evolution/benchmark.py`'s four `run_*_benchmark` functions | No — none of the four functions accept a callback, and the module isn't wired through `runner.py` (no ledger `run_id`) | No |

Request bodies: `{"model": {...}, "evolution"|"multiobjective"|"sensitivity"|"active_learning": {...}, "notes": "..."}`
(`/api/benchmark` takes `model`, `evolution`, `multiobjective`). Each config
block is validated with the matching `telomere_lab.schemas` dataclass's own
`.from_dict().validate()` — `400` with the `ConfigError` message on failure.

On success, evolve/pareto/sensitivity/active-learning register the run in
the shared JSONL ledger and tag it to the calling user
(`db.record_user_run`), same as the Streamlit pages do. Benchmark does not
(there is no ledger `run_id` for it, matching the CLI/Streamlit behavior
today — benchmarking has never been ledger-backed in this codebase).

## Experiments

* `GET /api/experiments?mine=true|false` (protected) — the ledger, filtered
  to the calling user's own runs by default (mirrors the Streamlit
  Experiments page's "My experiments" / "All experiments" tabs), via
  `db.list_user_runs`.
* `GET /api/experiments/{run_id}` (protected) — the full ledger record plus
  its artifact filenames. **Scoped down:** this returns artifact *paths*
  from the record only — there is no `GET .../artifacts/{name}` download
  route in this phase; adding streaming file downloads (with correct
  content-types, path traversal guards, etc.) was judged a large-enough
  scope addition to defer to when the React app actually needs it.

## What's deliberately out of scope for Phase 1

* No streaming (SSE/WebSocket) progress push — the React app is expected to
  poll `GET /api/jobs/{id}`. Could be added later without changing the job
  store's shape.
* No Redis/Celery job queue — see the job-abstraction design note above.
* No artifact download endpoint (see Experiments section above).
* CORS allows `http://localhost:5173` unconditionally; the production React
  origin is only added via `FRONTEND_ORIGIN` if that env var is set. No
  wildcard production origin was added — tighten this once the React app has
  a real deployed URL.
* The live Railway deploy is **not** changed — `Procfile`/`railway.json`
  still start Streamlit. Wiring `uvicorn backend.main:app` into a real
  deployment is a later-phase decision.

## Meta (Phase 3) — read-only metadata the React forms are driven by

`backend/routers/meta.py`. `telomere_lab.schemas` stays the single source of
truth for bounds and defaults; these routes only mirror it so the frontend
never hardcodes a bound in TypeScript.

* `GET /api/meta/bounds` (**public** — static, non-sensitive, and a form
  needs it before the user has done anything) →
  ```json
  {
    "bounds": {"<name>": {"min", "max", "unit", "label", "description"}, ...},
    "evolvable": ["initial_length", "shortening_rate", ...],
    "defaults": {...ModelConfig().to_dict()...},
    "demo": {...configs/demo.yaml model block (falls back to defaults if missing)...},
    "fitness_weights_default": {...FitnessWeights().to_dict()...},
    "evolution_default": {...EvolutionConfig().to_dict(), incl. nested "weights"...}
  }
  ```
  `bounds` has one entry per `PARAMETER_BOUNDS` key, i.e. the five-tuple
  `(min, max, unit, label, description)` as an object.
* `GET /api/meta/version` (**public**) →
  `{package, model, optimizer, python, numpy, git_commit}` — taken from
  `telomere_lab.experiments.registry.environment_metadata()` (same values the
  ledger records; `git_commit` is `null` outside a git checkout and carries a
  `-dirty` suffix for an unclean tree).
* `POST /api/meta/chip-to-params` (**protected**) — body is the
  `ChipConditions` fields (`flow_rate`, `oxygen_tension`, `nutrient_state`,
  `stress_exposure`, `culture_days`, all optional with the dataclass
  defaults) → `{stress_level, repair_rate, cycles}` from
  `telomere_lab.adapters.chip.chip_to_model_params`. The mapping is a
  documented modelling assumption, not a calibrated relationship
  (`docs/MODEL.md` §6); the response values are valid `ModelConfig`
  overrides as-is.

Serialisation note (affects consumers of every result route): FastAPI's
pydantic-v2 JSON mode turns non-finite floats into `null`, so e.g.
`terminal_metrics.time_to_50pct_senescence` is `null` (not `Infinity`) when
the target is never reached, and length statistics are `null` once a
population is extinct. Tests: `tests/test_api_meta.py`.

## Phase 2 — frontend serving

`backend/main.py` now optionally serves the built React app
(`frontend/`, see `frontend/README.md`). After all `/api` routers are
included, `create_app()` checks for `frontend/dist/index.html`; if present it
mounts `frontend/dist/assets` at `/assets` (`StaticFiles`) and registers a
catch-all `GET /{path}` that returns `index.html` for any path not starting
with `/api` (SPA fallback so client-side routes like `/login` or `/simulate`
work on reload), plus top-level static files in `dist/` (e.g. `favicon.svg`).
Unknown `/api/...` paths still return FastAPI's own JSON `404`. If there is no
build, nothing is mounted and the app behaves exactly as in Phase 1 — tests
and API-only dev runs are unaffected (`tests/test_api_static.py`).

`FRONTEND_ORIGIN` is unchanged for now: when FastAPI serves the build the
frontend is same-origin, so no extra CORS origin is needed in production; the
env var stays available for a separately hosted frontend, and the Vite dev
server (`http://localhost:5173`) proxies `/api` to uvicorn rather than
relying on CORS. The Railway start command still launches Streamlit — running
`uvicorn backend.main:app` in production is a Phase 5 decision.
