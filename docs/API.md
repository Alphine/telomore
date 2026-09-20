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

`POST /api/simulate` `{config: {...ModelConfig fields...}, provenance?: string}`
(protected) runs one simulation synchronously (sub-second per
`tests/test_simulator.py::test_runtime_target_default_config`) and returns
the full result as JSON (`SimulationResult.to_json_dict()` plus `run_id` and
`fitness`). Unknown/invalid fields → `400` (via `ModelConfig.validate()`
raising `ConfigError`). The run is recorded in the shared experiment ledger
and tagged as belonging to the calling user. `provenance` (optional, max
200 chars) becomes the ledger record's `notes` field instead of the default
`"via API"` — the LLM Layer 2 flow (see below) uses this to tag a run
loaded from an AI-proposed protocol.

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

### Sub-clone competition (candidate feature #4, 2026-09-11)

Every `ModelConfig` request body may also carry an optional **`subclones`**
block, a list shaped exactly like `ModelConfig.to_dict()` emits it
(`docs/MODEL.md` §2.2):

```json
{"config": {"population_size": 100, "carrying_capacity": 400,
            "subclones": [
              {"name": "resilient", "initial_fraction": 0.5,
               "overrides": {"maintenance_rate": 0.6, "repair_rate": 0.6}},
              {"name": "fragile", "initial_fraction": 0.5, "overrides": {}}
            ]}}
```

* `>= 2` clones with unique `name`s, `initial_fraction` in `(0, 1]` summing
  to `1.0` (small tolerance), and `overrides` keys restricted to
  `SUBCLONE_OVERRIDABLE_PARAMETERS` (`GET /api/meta/bounds` →
  `subclone_overridable`, currently `shortening_rate`, `maintenance_rate`,
  `repair_rate`, `stress_sensitivity`, and -- since 2026-09-14 -- the four
  genome-stability fields `replication_error_rate`,
  `oxidative_mutation_sensitivity`, `checkpoint_strength`,
  `mutation_threshold`), each bounds-checked like any other parameter. Omit
  the key, or send `"subclones": null`, for a single homogeneous population
  -- both are what an unset `to_dict()` round-trips to.
* Validation is the core gate: too few clones, a bad fraction sum, a
  duplicate name, a non-overridable key or an out-of-bounds override value
  all raise `ConfigError` -> **`400`** with the core message. Only a
  *malformed* block (e.g. a clone missing `initial_fraction`) is a pydantic
  `422` (`backend/schemas.py::ModelConfigBody` / `SubcloneSpec` type just the
  shape).
* The response's `run` carries **`clone_fraction`**: for every clone, its
  share of the *living* population at each cycle, an array of length
  `cycles + 1` on the same axis as `timeseries.cycle` (`0.0`, never `NaN`,
  once the population is extinct). `{}` when the config has no `subclones`.
  `config.subclones` echoes the block (`null` when none). `subclones` and
  `schedule` may be set together on the same config (the shared schedule
  applies uniformly to every clone unless a clone overrides that specific
  parameter, docs/MODEL.md §2.2); the outer GA/NSGA-II/active-learning gene
  encodings never touch `subclones` -- it is a Simulate-only exploratory
  lens, deliberately out of scope for the optimizers.
* `POST /api/simulate/ensemble` and `POST /api/compare` forward `subclones`
  transparently, like every other `ModelConfig` field.

Tests: `tests/test_api_subclones.py`.

### Genome stability: mutation burden and apoptosis checkpoint (docs/MODEL.md §2.3)

Four new plain scalar `ModelConfig` fields -- `replication_error_rate`,
`oxidative_mutation_sensitivity`, `checkpoint_strength`, `mutation_threshold`
-- need **zero schema changes** on this endpoint: `ModelConfigBody` already
accepts any recognised `ModelConfig` field, and all four default to values
(`0.0`, `0.0`, `0.0`, `1.0e9`) that make the feature bit-identical to a run
without it.

```json
{"config": {"replication_error_rate": 0.02, "oxidative_mutation_sensitivity": 0.02,
            "checkpoint_strength": 0.3, "mutation_threshold": 0.5}}
```

* The response's `run.timeseries` carries **`mean_mutation_burden`** and
  **`apoptotic_fraction`**, genome-wide per-cycle series of length
  `cycles + 1` on the same axis as `timeseries.cycle` -- all-zero, never
  absent, when the feature is unused (no new `SimulationRunResponse` field
  needed; `timeseries` is a generic passthrough dict).
* `run.terminal_metrics` carries **`final_mutation_burden`** and
  **`genomic_instability_index`** (the latter: fraction of *surviving* cells
  over `mutation_threshold` at the final cycle, `0.0` when unused).
* Out-of-bounds values raise `ConfigError` -> **`400`**, exactly like any
  other `PARAMETER_BOUNDS` field. `GET /api/meta/bounds` exposes all four in
  `bounds`/`evolvable`; none are schedulable. **Since 2026-09-14**, all four
  ARE sub-clone-overridable (see the sub-clone section above and
  `docs/MODEL.md` §2.2's "Composition with genome stability") -- a clone
  without the override still reads the shared config scalar, so this closes
  a gap this document previously called out rather than changing the
  feature's own default-off behavior.

Tests: `tests/test_genome_stability.py`, `tests/test_api_genome_stability.py`,
`tests/test_subclones.py` (composition cases).

### Per-cell heritable repair_rate (docs/MODEL.md §2.2.1)

One new plain scalar `ModelConfig` field -- `repair_rate_mutation_sigma`
(default `0.0`, its off switch) -- needs **zero schema changes** on this
endpoint, exactly like the genome-stability fields above.

```json
{"config": {"repair_rate": 0.4, "repair_rate_mutation_sigma": 0.03}}
```

* The response's `run.timeseries` carries **`mean_repair_rate`** (genome-wide
  per-cycle mean, `cycles + 1` entries, equal to the constant seed value
  when unused).
* `run.terminal_metrics` carries **`final_repair_rate_mean`** and
  **`final_repair_rate_std`** (the latter is `0.0` when unused, `> 0` once
  the population has diversified).
* Out-of-bounds values raise `ConfigError` -> **`400`**, exactly like any
  other `PARAMETER_BOUNDS` field (`GET /api/meta/bounds` exposes it in
  `bounds`; not evolvable, schedulable, or sub-clone-overridable). Setting
  it `> 0` together with a `repair_rate` schedule also raises `ConfigError`
  -> **`400`** (the two mechanisms have no combined semantics).

Tests: `tests/test_repair_rate_drift.py`.

### Genotype x Environment (G×E) study (docs/ROADMAP.md 2026-09-13 follow-up)

`POST /api/gxe` starts a background job (see "Long-running jobs" below) that
runs every `genotypes[i]` against every `environments[j]` as an **isolated**
simulation -- no sub-clone competition, no shared population -- averaged over
`eval_seeds`, and reports whether any genotype pair's fitness ordering flips
between environments (a re-ranking / reaction-norm crossing).

```json
{"model": {"cycles": 60}, "gxe": {
  "genotypes": [{"name": "A", "overrides": {}},
                {"name": "B", "overrides": {"maintenance_rate": 0.5}}],
  "environments": [{"name": "low_stress", "overrides": {"stress_level": 0.1}},
                    {"name": "high_stress", "overrides": {"stress_level": 0.9}}],
  "eval_seeds": [1, 2, 3]
}}
```

* `gxe` is a free-form dict, exactly like `SensitivityRequest.sensitivity` --
  all real validation happens core-side via `GxEConfig.from_dict().validate()`
  raising the core `ConfigError` -> **`400`**; a malformed JSON shape (e.g. a
  bad `model.schedule`) is still a pydantic **`422`**.
* A genotype's `overrides` keys must be one of `bounds.subclone_overridable`
  (`shortening_rate, maintenance_rate, repair_rate, stress_sensitivity`); an
  environment's must be one of the new `bounds.environment_overridable`
  (`stress_level` today). Using the wrong axis's key on a spec (e.g.
  `stress_level` on a genotype) raises `ConfigError`.
* `genotypes x environments` is capped at `GXE_MAX_CELLS = 60` cells
  (`eval_seeds` length is uncapped) -- enforced in `GxEConfig.validate()`
  since this is an async job, not `compare.py`'s synchronous 6-scenario cap,
  so an oversized grid fails fast instead of queuing and grinding.
* The completed job's `result` carries `items` (one `GxECell` per finished
  cell: `genotype`, `environment`, `fitness`, `survival`, `senescence`) and
  `reranking_pairs` (genotype-name pairs whose fitness ordering flips between
  at least two environments).
* Registered in the experiment ledger with `kind="gxe"`; artifacts are
  `gxe.json`, `gxe.csv`, `config.json` (mirroring `write_sensitivity_artifacts`).
* **Not built on sub-clone competition** -- see `docs/MODEL.md` §2.2's
  cross-reference for why genotypes are evaluated in isolation instead of as
  competing `ModelConfig.subclones`.

Tests: `tests/test_gxe_study.py`, `tests/test_api_gxe.py`.

### Synthetic "biological age" biomarker score (candidate feature #5, 2026-09-11)

Every `run` object returned by `POST /api/simulate` and `POST /api/compare`
carries **`biological_age`** (`backend/schemas.py::BiologicalAgeScoreBody`),
typed on `SimulationRunResponse` like `applied_schedule`/`clone_fraction`:

```json
{"biological_age": {
  "score_over_time": [12.4, 18.9, "... one value per cycle, same axis as timeseries.cycle ..."],
  "final_score": 41.2,
  "scale_label": "synthetic age index, 0 (youthful reference) - 100 (senescent reference)",
  "formula_note": "age_index = 100 * (1 - mean(normalized_survival, normalized_telomere_reserve, 1 - senescent_fraction)) ...",
  "valid": true
}}
```

* A **0-100 "synthetic age index"** computed purely from the model's own
  already-reported terminal metrics (`docs/MODEL.md` §4.1) — never a new
  measurement, never fed back into the simulator or any optimizer. `valid:
  false` (with `final_score: null` and an empty `score_over_time`) whenever
  the underlying run itself is invalid; never a crash, never `NaN`.
  `formula_note`/`scale_label` are short strings safe to render verbatim as
  a UI caption.
* `POST /api/simulate/ensemble` surfaces a lighter **`biological_age_final`**
  per seed on `EnsembleSeedResult` (the ensemble summary table's "spread of
  the age index across seeds") rather than a full per-seed
  `score_over_time` — a documented, deliberate scope reduction, since a full
  per-seed series would be `n_seeds`x the payload for a figure the fan chart
  doesn't otherwise need.
* `POST /api/compare` needed no schema change: each scenario's `result` is
  already a full `SimulationRunResponse`, so `result.biological_age` is
  present per scenario out of the box — a natural fit for "which chip
  profile/scenario ages the culture fastest" (the Compare page adds a
  "synthetic age index" column reading `result.biological_age.final_score`).

Tests: `tests/test_biological_age.py` (core), `tests/test_api_biological_age.py`
(simulate/ensemble/compare wiring).

## Ensemble / uncertainty visualization (candidate feature #2, 2026-09-11)

`POST /api/simulate/ensemble` `{config: {...ModelConfig fields...}, n_seeds: int, base_seed?: int}`
(protected) runs the existing, unmodified `simulate()` once per seed (a plain
Python loop -- each run is sub-second per
`test_runtime_target_default_config`, so multiprocessing was not added; revisit
only if a measured runtime at `n_seeds=50` becomes a real problem) and returns
the spread across seeds instead of one trajectory. It is a *separate* route
from `POST /api/simulate`, which is unchanged.

* **Seeds**: `base_seed, base_seed + 1, ..., base_seed + n_seeds - 1`
  (`base_seed` defaults to the config's own `seed` field when omitted). This
  is an explicit range convention specific to this endpoint -- distinct from
  the free-form `eval_seeds` tuples the GA/NSGA-II/active-learner take
  (`EvolutionConfig.eval_seeds` etc.), which are user-supplied lists rather
  than a range generated server-side.
* **`n_seeds`** must be in `[2, 50]` (`backend/schemas.py::MIN_ENSEMBLE_SEEDS`
  / `MAX_ENSEMBLE_SEEDS`) or the request is rejected with **`400`**
  (`n_seeds=1 outside [2, 50]`) -- deliberately a plain `400` like a
  `ConfigError`, not a pydantic `422`, since it is a request-shape rule
  specific to this route rather than a `ModelConfig` field. An invalid
  `config` still surfaces the core `ConfigError` as `400`, exactly like
  `/api/simulate`.
* **Response** (`EnsembleResponse`) is deliberately *not* `n_seeds` copies of
  `SimulationResult.to_json_dict()` -- that would be `n_seeds`x the
  single-run payload. Instead:
  * `bands` (`EnsembleBands`): **p10 / p50 (median) / p90 + mean of
    `mean_length`, taken independently at each cycle** across the valid
    seeds -- the percentile at cycle 5 and the percentile at cycle 50 may
    come from different seeds. This is the documented, honest choice: a
    distribution-free description of the spread across independent
    stochastic realizations of the same configuration, **not** a confidence
    band around any single seed's trajectory, and (per
    `docs/SCIENTIFIC_SCOPE.md`) not a claim about biological population
    variability beyond the model's own per-division noise term.
  * `series` (`EnsembleSeedResult[]`, one per seed): light-weight per-seed
    arrays only -- `mean_length`, `shortest_length`, `population_size`,
    `proliferative_count`, `senescent_fraction` (each `cycles + 1` long) plus
    `terminal_metrics`. No `final_lengths_bp`, no `distribution_snapshots`,
    no per-seed `config` (all seeds share `config`/`config_hash` at the top
    level) -- these are exactly what the fan chart, the terminal-metrics
    summary table and the particle visualization need, nothing more. A run
    that failed for a given seed carries `valid: false` /
    `failure_reason` and is excluded from `bands` and from summary
    statistics. `biological_age_final` (candidate feature #5) is that seed's
    final synthetic age index, `null` when invalid -- deliberately not a
    full per-seed `score_over_time` (see above).
  * `applied_schedule`: shared by every seed (only the RNG differs across
    seeds, not the schedule), same shape/convention as `/api/simulate`'s
    `applied_schedule`; `{}` when the config has no schedule.
* **Ledger**: exactly **one** entry per ensemble call (`kind: "ensemble"`,
  `configuration.seeds`/`n_seeds`, `fitness` = mean of the valid seeds'
  total fitness), not `n_seeds` entries -- tagged and owned by the calling
  user the same way as `/api/simulate`.
* `GET /api/meta/bounds` needed no changes: `n_seeds`'s `[2, 50]` range is a
  request-shape rule of this one route, not a `ModelConfig`/optimizer bound
  the forms need to mirror.

Tests: `tests/test_api_ensemble.py`.

## Long-running jobs (evolve / pareto / sensitivity / G×E / active-learning / benchmark)

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
* `GET /api/jobs` (auth required, no path param) → `List[JobStatusResponse]`
  of every **active** (`pending`/`running`, not yet terminal) job owned by
  the caller, newest first. Exists so the frontend can show a persistent
  "job in progress" indicator (a ⏳ badge next to the relevant nav item)
  and re-attach a page to its own in-flight job after navigating away and
  back — a page's local `jobId` state is lost on unmount even though the
  job itself keeps running server-side, since it lives on a detached
  daemon thread independent of any page being mounted.

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
| `POST /api/gxe` | `run_gxe_analysis` via `runner.run_gxe` | Yes — `GxECell.to_dict()` per finished (genotype, environment) cell | No — same rationale as sensitivity: no `should_stop` hook on the nested genotype x environment loop; `GxEConfig.validate()`'s `GXE_MAX_CELLS` cap bounds the worst case instead |
| `POST /api/active-learning` | `SurrogateActiveLearner.run` via `runner.run_active_learning` | Yes — `ActiveLearningRecord.to_dict()` per real evaluation | No — no `should_stop` hook on the GP-refit/acquire loop; adding one would touch `evolution/surrogate.py`'s core cycle |
| `POST /api/benchmark` | `evolution/benchmark.py`'s four `run_*_benchmark` functions | No — none of the four functions accept a callback, and the module isn't wired through `runner.py` (no ledger `run_id`) | No |

Request bodies: `{"model": {...}, "evolution"|"multiobjective"|"sensitivity"|"gxe"|"active_learning": {...}, "notes": "..."}`
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

### Multi-chip / multi-organ comparison (candidate feature #3, 2026-09-11)

A scenario may be specified as `{"name", "chip": {...ChipConditions...}}`
instead of `{"name", "config": {...ModelConfig...}}` — **exactly one** of the
two, never both, never neither (`400` on either violation, scenario-name
qualified like every other config error on this endpoint). `chip` fields are
the same optional `ChipConditions` fields as `/api/meta/chip-to-params`
(`flow_rate`, `oxygen_tension`, `nutrient_state`, `stress_exposure`,
`culture_days`, `doubling_time_days`); an unknown/malformed field is a `422` (pydantic wire-shape
validation), not a `400`. The request also accepts an optional
`base_config` (a `ModelConfig` body, defaults to `ModelConfig()`'s own
defaults): a `chip` scenario is mapped through the existing, unmodified
`telomere_lab.adapters.chip.chip_to_model_params` and the derived
`{stress_level, repair_rate, cycles}` are merged onto `base_config` —
`{...base_config, ...derived}`, the same override semantics `ChipMapper`
already applies client-side on the Simulate page — before validation. A
`config` scenario never reads `base_config`. Example mixing both scenario
kinds:

```json
{"scenarios": [{"name": "Baseline", "config": {...ModelConfig...}},
               {"name": "Liver-chip-like", "chip": {"flow_rate": 0.15, "oxygen_tension": 0.06,
                                                     "nutrient_state": 0.5, "stress_exposure": 0.5,
                                                     "culture_days": 90, "doubling_time_days": 4.5}}],
 "base_config": {...ModelConfig...},
 "seed": 42}
```

`GET /api/meta/chip-presets` (public) returns a small set of named,
illustrative chip condition profiles plus their derived parameters, so the
Compare page can render preset cards/pickers without a `/chip-to-params`
round trip per preset:

```json
{"presets": {"liver_chip_like": {"conditions": {...ChipConditions..., "doubling_time_days": 4.5},
                                  "label": "Liver-chip-like (low flow, physioxia)",
                                  "description": "...",
                                  "derived": {"stress_level": 0.55, "repair_rate": 0.28, "cycles": 20}},
             "...": {}}}
```

Presets are named, illustrative points in the chip-condition space loosely
evoking real organ-on-chip *concepts* (liver/lung/gut framings, plus a static
well control) — **not** a claim of calibration to any organ's physiology
(`docs/SCIENTIFIC_SCOPE.md` "organ-on-a-chip bridge", `docs/MODEL.md` §6).
`/api/compare` remains the single comparison engine: no new parallel
comparison endpoint was added, and `runner.compare_scenarios`/`deltas` are
unmodified. Tests: `tests/test_api_compare_chip.py`.

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
    "presets": {"demo_fasting": {...configs/demo_fasting.yaml model block, incl. "schedule"...}},
    "subclone_overridable": ["shortening_rate", "maintenance_rate", "repair_rate", "stress_sensitivity",
                              "replication_error_rate", "oxidative_mutation_sensitivity",
                              "checkpoint_strength", "mutation_threshold"]
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
  key). `subclone_overridable` (candidate feature #4) mirrors
  `SUBCLONE_OVERRIDABLE_PARAMETERS` — the sub-clone editor's per-clone
  override toggles come from here. `defaults` / `demo` now include
  `"schedule": null` and `"subclones": null`, and `evolution_default`
  includes `schedule_phases: 1`. No `multiobjective_default` / `sensitivity_default` /
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
  `stress_exposure`, `culture_days`, `doubling_time_days`, all optional with
  the dataclass defaults) → `{stress_level, repair_rate, cycles}` from
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

## LLM agentic layer (bring-your-own-key, docs/ROADMAP.md)

Every route below requires `api_key` (an Anthropic key) in the request body;
it is relayed to Anthropic for that one request only and is never persisted,
logged or echoed back (`backend/llm.py`). `GET /api/meta/llm` (**public**) →
`{providers, models: [{id, label, input_usd_per_mtok, output_usd_per_mtok}],
default_model, efforts, default_effort, rate_limit: {calls, window_seconds}}`
— the single source `model`/`effort` are validated against. Every LLM error
response (401/403/429/422/400/502) has a structured `detail`:
`{code, message, category?, retry_after?}` with `code` one of
`llm_auth_failed` / `llm_permission_denied` / `llm_rate_limited` /
`llm_refusal` / `llm_bad_request` / `llm_upstream_error` /
`llm_proposal_invalid` (Layer 2 only).

**Layer 1 — results interpreter** (`POST /api/llm/interpret`, **protected**):
body `{run_id, api_key, model?, effort?}` → a plain-language Markdown
narrative of one recorded run's own data (`{narrative_markdown, model, usage,
estimated_cost_usd, warnings}`). Read-only — cannot run or modify a
simulation. Rate limit: `llm.interpret_rate_limiter` (10 calls / 10 min per
user, in-memory, process-local).

**Layer 2 — protocol-designing agent** (`POST /api/llm/propose-protocol`,
**protected**): body `{goal, base_config, api_key, model?, effort?}` →
`{rationale, config, model, usage, estimated_cost_usd, warnings}`. The model
is given a forced tool call (`propose_protocol`: `rationale`, `phases`
(1-8), and one `stress_level`/`maintenance_rate`/`repair_rate` array per
phase, each in `[0, 1]`) and may only propose those four fields — every
other field of `base_config` passes through unchanged. **Hard safety
boundary**: the returned `config` has already passed the exact same
`ModelConfig.validate()` every other config (GA-mutated, NSGA-II-mutated,
human-typed) passes; a malformed or out-of-bounds tool call is rejected
server-side as `422 llm_proposal_invalid`, never returned as a "valid"
config. This route only proposes — it never calls `/api/simulate`; the
frontend loads `config` into the Simulate form exactly like a named YAML
preset, and the human must still press "Run simulation" themselves. A run
started from a loaded proposal can carry a ledger `notes` tag via
`POST /api/simulate`'s optional `provenance` field (defaults to `"via API"`
when omitted) so AI-proposed / human-typed / GA-evolved runs stay
distinguishable in the ledger. Separate rate limit from Layer 1:
`llm.propose_rate_limiter` (same 10/10 min default, independent budget).

## Testing note — ledger isolation

`ExperimentRegistry()` resolves its runs directory from
`telomere_lab.config.RUNS_DIR` **at call time**, so the API test fixtures
isolate the ledger with a single
`monkeypatch.setattr(config_module, "RUNS_DIR", tmp_path / "runs")` — the
routers' bare `ExperimentRegistry()` calls then write `record.json` files
and the `registry.jsonl` index under `tmp_path`, never into the real
`experiments/` tree. Running `python -m pytest` must leave
`git status --short` clean and `experiments/runs/` unchanged.


## Toy genome explorer (`/api/sequence/*`)

All require authentication and are synchronous. Synthetic genes only
(docs/MODEL.md §2.4); every response has `toy: true`.

* `GET /api/sequence/genome` — the three synthetic genes (`dna`, `mrna`, `protein`, substitution `profile`).
* `POST /api/sequence/mutate` — `{gene, position, alt}` -> effect class, codons, amino acids, mutated protein. 400 for unknown gene / bad position / `alt` equal to the reference base.
* `POST /api/sequence/lineage` — normal vs damaged lineage time series (`alive_fraction`, `mean_burden`, `<gene>_functional`) plus `model_bridge` sub-clone overrides. Extinct generations are `null`.
