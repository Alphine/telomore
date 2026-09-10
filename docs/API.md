# FastAPI backend

The REST API behind the React frontend (`frontend/`), and the production
server: one `uvicorn backend.main:app` process serves the `/api` routes and
the built frontend (`frontend/dist`) on a single origin. It was built in
Phase 1 of the Streamlit → React migration (`docs/ROADMAP.md`, completed
2026-09-10; the Streamlit app in `app/` no longer exists) and this document
keeps the per-phase notes since they explain several contract decisions.

The API is a thin wrapper around `telomere_lab.experiments.runner` (the
service layer shared with the CLI scripts) — no simulation/optimization
logic was reimplemented or restructured.

## Deployment (Railway, Docker)

The repo-root `Dockerfile` is a two-stage build — `node:22-alpine` runs
`npm ci && npm run build` in `frontend/`, then `python:3.13-slim` installs
`requirements.txt`, `pip install -e .` for `src/telomere_lab`, copies
`backend/` + `configs/`, copies the built frontend to `frontend/dist` (the
path `backend/main.py` serves) and starts
`uvicorn backend.main:app --host 0.0.0.0 --port ${PORT:-8000}`.
`railway.json` selects `"builder": "DOCKERFILE"` with
`healthcheckPath: /api/health`; there is no `Procfile` — the Dockerfile
`CMD` is the single start command. `.dockerignore` keeps `node_modules`,
`frontend/dist`, `data/`, `experiments/runs/`, tests and docs out of the
build context.

Environment variables the Railway service needs:

| Variable | Required | Notes |
|---|---|---|
| `SECRET_KEY` | **yes — set before the first deploy** | Signs JWTs. Without it the app generates a random per-process secret, so every login is invalidated on each restart/redeploy. Any long random string. |
| `DATABASE_URL` | yes (already set) | Injected by the Railway Postgres plugin. On engine init the app runs `create_all()` for missing tables **and** an additive column sync (`db._add_missing_columns`): any model column absent from an existing table is added via `ALTER TABLE … ADD COLUMN` (nullable, with the model's scalar default, unique index where declared). Existing rows are kept. Column removals/renames/type changes are still manual — there is no full migration framework. |
| `RESEND_API_KEY` | yes for real emails (already set) | Without it registration/forgot-password return `dev_*_link` fields instead of sending mail. |
| `PORT` | set by Railway | The `CMD` reads it (`${PORT:-8000}`); the service currently has `PORT=8080`. |
| `FRONTEND_BASE_URL` | optional | Absolute base for verification/reset links in emails (e.g. `https://telomore-production.up.railway.app`); empty → relative `/?token=...` links, which only work when the email is opened on the same origin. Recommended in production. |
| `FRONTEND_ORIGIN` | optional | Extra CORS origin; not needed when this process serves the frontend (same origin). |

Notes: the experiment ledger (`experiments/runs/` + `experiments/registry.jsonl`)
lives on the container filesystem and is **ephemeral** — it is empty after
every deploy (same as under Streamlit). Jobs are in-memory and single-process
(see below), so run one replica.

Local equivalent without Docker: `cd frontend && npm ci && npm run build`,
then `uvicorn backend.main:app --port 8000` from the repo root serves API +
frontend at <http://127.0.0.1:8000>.

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
| `SECRET_KEY` | Signs JWTs | random per-process secret (logged as a loud warning); **must** be set as a real Railway env var in production (see Deployment above), otherwise every issued token is invalidated on each restart/redeploy |
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

### Scheduled intervention protocols (stage 6b, 2026-09-10)

Every `ModelConfig` request body (`config` here, `model` on the job routes,
`scenarios[].config` on Compare) may carry an optional **`schedule`** block,
shaped exactly like `ModelConfig.to_dict()` emits it (`docs/MODEL.md` §2.1):

```json
{"config": {"cycles": 120, "stress_level": 0.9,
            "schedule": {"phases": 6,
                         "values": {"stress_level": [0.9, 0.3, 0.9, 0.3, 0.9, 0.3]}}}}
```

* `schedule.phases` (int, `1..max_phases`) splits the run's `cycles` into
  as-equal-as-possible phases; `schedule.values[<name>]` gives one value per
  phase for a name in `SCHEDULABLE_PARAMETERS` (`GET /api/meta/bounds` →
  `schedulable`, currently `stress_level`, `maintenance_rate`, `repair_rate`).
  Omit the key, or send `"schedule": null`, for constant parameters — both
  are what an unscheduled `to_dict()` round-trips to. A scheduled parameter's
  scalar field only documents its phase-0 / fallback value.
* Validation is the core gate: wrong length, an out-of-bounds value, a
  non-schedulable name or too many phases raise `ConfigError` → **`400`**
  with the core message (e.g. `schedule.values[stress_level] has 2 entries,
  expected 3`). Only a *malformed* block (e.g. `"phases": "many"`) is a
  pydantic `422`, like any other malformed body
  (`backend/schemas.py::ModelConfigBody` / `InterventionSchedule` type just
  the shape; everything else stays a free-form dict).
* The response's `run` carries **`applied_schedule`**: for every *scheduled*
  parameter the value actually in force at each cycle, an array of length
  `cycles + 1` on the same axis as `timeseries.cycle` (entry `t` = value
  during step `t → t+1`; the last entry repeats the final phase so a step
  line ends flat). `{}` when the config has no schedule. `config.schedule`
  echoes the schedule (`null` when none). The intervention-cost term in
  `fitness` is charged on the time-averaged doses (mean of the first `cycles`
  entries of `applied_schedule`).

Tests: `tests/test_api_schedule.py`.

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

**Protocol search (`schedule_phases`, stage 6b).** The `evolution`,
`multiobjective` and `active_learning` blocks accept `schedule_phases` (int,
default `1`, `1..max_phases` — range-checked by
`backend/schemas.py::OptimizerConfigBody` against the core `MAX_PHASES`, so an
out-of-range value is a `422` naming `schedule_phases`). With `K > 1` every
*free* gene in `SCHEDULABLE_PARAMETERS` is expanded into `K` genes named
`<gene>@<phase>` (`maintenance_rate@0` … `maintenance_rate@5`) with the
parameter's bounds; other free genes stay scalar. The `@` names appear
verbatim wherever a genome is reported — `best.genome` / `baseline.genome` /
`history[].best_genome` on evolve, `front[].genome` on pareto,
`best_genome` / `records[].genome` on active-learning — and the frontend
reassembles them into a `ModelConfig.schedule` for hand-offs
(`frontend/src/components/scheduleUtils.ts::genomeToConfig`, mirroring
`GenomeSpec.to_config`). `schedule_phases = 1` is the classic constant-gene
search and bit-identical to before. The `model` block may itself carry a
`schedule` (see Simulate above); a scheduled parameter that is *not* a free
gene passes through unchanged. Sensitivity takes no `schedule_phases` (OAT
stays a scalar analysis, MODEL.md §2.1).

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
  its artifact filenames (the record's `artifacts` dict, i.e. key →
  absolute path). Phase 1 deliberately shipped no download route; Phase 4
  added the two below when the React Experiments page needed them.
* `GET /api/experiments/{run_id}/artifacts` (protected, Phase 4) — the
  files in `experiments/runs/<run_id>/` as
  `[{name, key, size_bytes, media_type}]`, where `key` is the
  `record["artifacts"]` key pointing at that file (`null` for files the
  record does not list, e.g. `record.json`).
* `GET /api/experiments/{run_id}/artifacts/{name}` (protected, Phase 4) —
  the file itself as an attachment (`FileResponse`; `.json` →
  `application/json`, `.csv` → `text/csv`, otherwise `mimetypes` /
  `application/octet-stream`). Security: `run_id` and `name` must each be a
  single plain path segment (`^[A-Za-z0-9][A-Za-z0-9._-]*$`, no `..`) →
  otherwise `400`; the resolved path must be a file directly inside the run
  directory, which itself must be directly inside the runs root → otherwise
  `404`. Ownership follows the record route: any authenticated, verified
  user can read any run (the ledger is shared; only the listing is filtered
  by `mine`). Note the download needs the bearer token, so the React page
  fetches it and saves the Blob client-side instead of using a bare link.
* `GET /api/experiments` summaries additionally carry `seed`,
  `configuration_hash`, `git_commit` and `model_version` (the remaining
  `registry._index_row` columns) since Phase 4, so the ledger table needs no
  per-row detail request.

## Compare (synchronous, Phase 4)

`POST /api/compare` (protected) runs up to **six** named scenarios side by
side — the API behind the React port of `app/pages/03_Compare.py`:

```json
{"scenarios": [{"name": "Baseline", "config": {...ModelConfig...}},
               {"name": "Manual",   "config": {...}}],
 "seed": 42}
```

Every `config` goes through `ModelConfig.from_dict().validate()` (`400`
with `"<name>: <ConfigError>"` on failure; duplicate names and more than six
scenarios are also `400`, an empty list is a `422`). A `config` may carry a
`schedule` (Simulate section above); it passes through untouched and the
scenario's `result.applied_schedule` is filled like on `/api/simulate`
(empty for constant scenarios). The optional `seed`
re-seeds every scenario before running (common random numbers — the
Streamlit page's "Force identical simulator seed" checkbox). The scenarios
are run with `runner.compare_scenarios` (default `FitnessWeights`) and the
response is

```json
{"baseline": "Baseline",
 "scenarios": [{"name", "result": {...SimulationResult.to_json_dict()...},
                "fitness": 0.41, "breakdown": {...FitnessBreakdown...},
                "deltas": null | {"fitness_abs", "fitness_pct", "senescence_pp",
                                  "reserve_kb", "mean_length_kb", "survival_abs"}}]}
```

`deltas` is `runner.deltas(first, this)` — always relative to the **first**
scenario (which therefore has `deltas: null`); `fitness_pct` is `null` where
`deltas` yields NaN (zero/invalid baseline fitness). `fitness` is `null` for
an invalid run. Nothing is written to the ledger (the Streamlit Compare page
never recorded either). Tests: `tests/test_api_compare.py`,
`tests/test_api_artifacts.py`.

## What's deliberately out of scope for Phase 1

* No streaming (SSE/WebSocket) progress push — the React app is expected to
  poll `GET /api/jobs/{id}`. Could be added later without changing the job
  store's shape.
* No Redis/Celery job queue — see the job-abstraction design note above.
* No artifact download endpoint in Phase 1 (added in Phase 4, see the
  Experiments section above).
* CORS allows `http://localhost:5173` unconditionally; the production React
  origin is only added via `FRONTEND_ORIGIN` if that env var is set. No
  wildcard production origin was added — tighten this once the React app has
  a real deployed URL.
* (Resolved in Phase 5.) The live Railway deploy was left on Streamlit
  during Phases 1–4; it now runs this API via the `Dockerfile` (see
  Deployment above).

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
    "evolution_default": {...EvolutionConfig().to_dict(), incl. nested "weights"...},
    "objectives": {"survival": {"direction": "max", "description": "..."}, ...},
    "schedulable": ["stress_level", "maintenance_rate", "repair_rate"],
    "max_phases": 8,
    "presets": {"demo_fasting": {...configs/demo_fasting.yaml model block, incl. "schedule"...}}
  }
  ```
  `bounds` has one entry per `PARAMETER_BOUNDS` key, i.e. the five-tuple
  `(min, max, unit, label, description)` as an object. `objectives` (Phase
  4) mirrors `telomere_lab.schemas.OBJECTIVES` — the `(direction,
  description)` tuples the Pareto page's objective multiselect is built
  from. `schedulable` / `max_phases` (stage 6b) mirror
  `SCHEDULABLE_PARAMETERS` / `MAX_PHASES` — the schedule editor's toggles and
  phase-count range come from here; `presets` are named example protocols as
  full `ModelConfig` dicts (currently only `demo_fasting`, loaded from
  `configs/demo_fasting.yaml` like `demo`; a missing file simply omits the
  key). `defaults` / `demo` now include `"schedule": null`, and
  `evolution_default` includes `schedule_phases: 1`. No `multiobjective_default` / `sensitivity_default` /
  `active_learning_default` blocks are exposed: the API fills omitted config
  fields with the dataclass defaults, and the React forms start from the
  same values (noted in each page's source).
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
relying on CORS. Since Phase 5 this is exactly how production runs (see
Deployment at the top).

## Testing note — ledger isolation

`ExperimentRegistry()` resolves its runs directory from
`telomere_lab.config.RUNS_DIR` **at call time**, so the API test fixtures
isolate the ledger with a single
`monkeypatch.setattr(config_module, "RUNS_DIR", tmp_path / "runs")` — the
routers' bare `ExperimentRegistry()` calls then write `record.json` files
and the `registry.jsonl` index under `tmp_path`, never into the real
`experiments/` tree. Running `python -m pytest` must leave
`git status --short` clean and `experiments/runs/` unchanged.
