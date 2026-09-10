# React frontend

Vite + React 18 + TypeScript + Tailwind CSS v4 + React Router v6, built
against the FastAPI backend in `../backend/` (contract: `../docs/API.md`).
This is the production UI; it replaced the Streamlit app (`app/`, removed
2026-09-10) over Phases 2–5 of the migration in `../docs/ROADMAP.md`.

Phase 2 delivered the scaffold: routing, auth pages (login / register /
verify / forgot- and reset-password), the public landing page ported from
the Streamlit `app/streamlit_app.py`, and a protected shell. Phase 3
replaced the **Simulate** and **Evolve** placeholders with full ports of
the Streamlit `01_Simulate.py` / `02_Evolve.py` pages, added the
job-polling hook and the WebGL particle visualization. Phase 4 ported the
remaining five pages — **Pareto**, **Sensitivity**, **Active Learning**,
**Compare**, **Experiments** — so all seven `FEATURES` pages are real; the
`Placeholder` component only renders if a feature path is ever added without
a page. The `app/...` file references throughout this document name the
Streamlit pages each React page was ported from; those files are gone (see
git history before Phase 5 if you need them).

## Run locally

Two terminals, from the repo root:

```bash
# 1. API (SQLite fallback, dev-mode email links -- see docs/API.md)
uvicorn backend.main:app --reload --port 8000

# 2. Frontend dev server (proxies /api -> http://127.0.0.1:8000, see vite.config.ts)
cd frontend
npm install
npm run dev            # http://localhost:5173
```

## Build / test / lint

```bash
cd frontend
npm run build          # tsc -b && vite build  -> frontend/dist/
npm run test           # vitest (jsdom + @testing-library/react)
npm run lint           # oxlint
npm run typecheck      # tsc -b
```

## Production

`frontend/dist/` is git-ignored. When it exists, `backend/main.py` serves it
(static `/assets` + SPA fallback to `index.html` for every non-`/api` GET),
so a single `uvicorn backend.main:app` process hosts API + frontend on one
origin. Without a build the backend behaves exactly as before (API only).

That is how production runs: the repo-root `Dockerfile` builds this app in a
`node:22-alpine` stage (`npm ci && npm run build`) and copies `dist/` into
the `python:3.13-slim` runtime image at `frontend/dist`, next to `backend/`
— the same relative path as in a checkout. Railway builds that image
(`railway.json`, `DOCKERFILE` builder) and starts uvicorn on `$PORT`; there
is no separate static host, no CORS configuration and no base-path setting
(the app is served from `/`). Required env vars are in `../docs/API.md`
"Deployment". To reproduce locally without Docker:

```bash
cd frontend && npm ci && npm run build && cd ..
uvicorn backend.main:app --port 8000     # http://127.0.0.1:8000 serves API + UI
```

**Bundle shape.** `plotly.js-dist-min` (pinned `4.1.0`, with
`react-plotly.js` `4.1.0`) is ~4 MB minified / ~1.25 MB gzipped. It lives in
its own lazy chunk (`components/charts/PlotlyPlot.tsx` is the only module
that imports it, loaded through `React.lazy` in `Plot.tsx`), so the landing
and auth pages never download it; Vite's ">500 kB chunk" warning at build
time refers to that chunk and is expected. Both packages ship their own
TypeScript types, so no `@types/*` packages are needed for them.

## Layout

```
src/
  api/        client.ts (fetch wrapper, ApiError), endpoints.ts (one fn per
              endpoint), types.ts (mirrors backend/schemas.py + the
              telomere_lab.schemas dicts it passes through), devLinks.ts,
              useJob.ts (job polling hook), useBounds.ts (cached /api/meta/bounds)
  auth/       context.ts (AuthContext + useAuth), AuthContext.tsx (provider),
              RequireAuth.tsx (route guard), safeNext.ts
  components/ Layout (sidebar/top bar), Callout + Disclaimer, DevLink, AuthCard,
              ModelConfigForm (+ NumberInput), ChipMapper (+ chipFields.ts),
              MetricRow, PopulationCanvas (+ populationFrames.ts), baseline.ts,
              handoff.ts (Evolve/Pareto -> Compare scenarios, see below),
              download.ts (Blob exports, CSV builders), PageHeader, ProgressBar,
              Provenance (run id + config hash line), BaselineSummary,
              CheckboxGroup (st.multiselect as checkboxes),
              scheduleUtils.ts (phase arithmetic, schedule payloads, genomeToConfig),
              ScheduleEditor (Simulate's "Protocol (schedule)" section),
              ProtocolTable (phase table + time averages), PhasesControl
              (optimizers' schedule_phases), GeneName (`gene@phase` rendering)
              charts/  Plot.tsx (lazy wrapper), PlotlyPlot.tsx (the plotly import),
                       theme.ts (PALETTE/_LAYOUT port + dark mode),
                       simulationCharts.ts, evolutionCharts.ts, paretoCharts.ts,
                       sensitivityCharts.ts, activeLearningCharts.ts, compareCharts.ts,
                       scheduleCharts.ts (step-line protocol figures)
  pages/      Landing, Login, Register, ForgotPassword, ResetPassword, Verify,
              Simulate/ (index.tsx, metrics.ts), Evolve/ (index.tsx, form.ts),
              Pareto/ (index.tsx, form.ts), Sensitivity/, ActiveLearning/,
              Compare/, Experiments/ (index.tsx, ledger.ts),
              Placeholder (unused fallback), NotFound
  features.ts FEATURES / NAV order / DISCLAIMER text, copied from the Streamlit app
  test/       vitest setup + helpers (MemoryRouter + AuthProvider, fetch mock),
              fixtures.ts (a /api/meta/bounds response + a SimulationRun)
```

## Pages done in Phase 3

### Simulate (`pages/Simulate/`)

Port of `app/pages/01_Simulate.py`. The parameter form
(`components/ModelConfigForm.tsx`) is driven entirely by
`GET /api/meta/bounds`: every bounded parameter's min / max / unit / label /
description comes from `PARAMETER_BOUNDS` via the API, the kb display and
the step rule mirror `app/ui/controls.py::_slider`, and the demo baseline
(`configs/demo.yaml`) arrives as `bounds.demo`. Only the widget ranges of the
structural fields that are *not* in `PARAMETER_BOUNDS` (founding cells,
capacity, cycles, seed, telomeres per cell, snapshot interval) are copied
from the Streamlit `st.number_input` calls — the server-side
`ModelConfig.validate()` remains the authority, and a `400` is shown as-is.

The **organ-on-chip mapper** toggle renders `components/ChipMapper.tsx`
(same five inputs as `chip_controls`), which calls
`POST /api/meta/chip-to-params` (debounced) and shows the derived
`stress_level` / `repair_rate` / `cycles`; those three fields become
read-only in the form and are what gets submitted.

Results: the six-metric row from `terminal_metric_row`, the particle canvas
(below), the four Plotly charts (`length_trajectory`, `length_distribution`,
`senescence_curve`, `population_curve` ported 1:1 in
`charts/simulationCharts.ts`), the fitness-breakdown bar under a
collapsible, JSON + CSV export (client-side Blob; the CSV has the
`timeseries_frame()` columns) and the provenance block. Charts follow the
OS dark mode (`usePrefersDark` swaps the `plotly_white`-equivalent colours).

Deliberate differences from the Streamlit page, all forced by the API shape:

* **No "Record run in experiment registry" checkbox.** `POST /api/simulate`
  always records the run and returns `run_id`, so the page just shows it.
* **Length distribution shows the final distribution only.**
  `SimulationResult.to_json_dict()` ships `final_lengths_bp` but not the
  intermediate `distribution_snapshots`, which the Streamlit page overlaid.
* **Fitness breakdown uses the default weights** — the API scores with
  `FitnessWeights()`; the Streamlit page used the session's weights.

### Evolve (`pages/Evolve/`)

Port of `app/pages/02_Evolve.py`: fitness weights (formula text copied
verbatim), `EvolutionConfig` controls (`eval_seeds` as comma-separated
ints, `free_genes` as checkboxes over `bounds.evolvable`), the baseline
`ModelConfig` in a collapsible (reusing `ModelConfigForm`), notes.
`POST /api/evolve` returns a `job_id`, which `useJob` polls; while
`pending/running` the page shows a progress bar with the Streamlit progress
text, a live "Fitness by generation" chart built from the accumulated
`GenerationRecord` progress payloads, the best genome so far, and a **Stop**
button (`POST /api/jobs/{id}/stop`). On `completed` / `stopped` it renders
the five result metrics, the ledger `run_id`, the three charts
(`evolution_fitness_chart`, `diversity_chart`, `parameter_trajectory_chart`
in `charts/evolutionCharts.ts`), the best-vs-baseline gene table, JSON /
CSV exports and **Set best as baseline**. `failed` shows the job error.

Scoped down: the **final population table** is not shown because the
evolve job result contains only `best` / `baseline` / `history` (see
`backend/routers/evolve.py`). Every finished job also writes the best
candidate to the Compare hand-off (below); **Send best to Compare →** just
navigates there.

### sessionStorage hand-offs (cross-page state)

The Streamlit app shared state between pages through `st.session_state`;
the React app uses `sessionStorage` (survives navigation and a reload of
the tab, not a new tab/session — the same per-session semantics):

| Key | Written by | Read by | Shape |
|---|---|---|---|
| `tel_baseline_config` (`components/baseline.ts`) | Simulate *Set as baseline*, Evolve *Set best as baseline*; cleared by Simulate *Reset to demo baseline* | Evolve, Pareto, Sensitivity, Active Learning, Compare (fallback: `bounds.demo`) | `ModelConfig` |
| `tel_evolve_best` (`components/handoff.ts`) | Evolve, automatically when a job completes/stops (baseline with the best genome merged in, as `GenomeSpec.to_config`) | Compare → "Best evolved" scenario | `{config: ModelConfig, label, run_id}` |
| `tel_compare_user_config` (`components/handoff.ts`) | Pareto *Send this point to the Compare page* | Compare → "From Pareto page" scenario | `{config: ModelConfig, label, run_id}` |

The Streamlit Compare page could also load "Best evolved" from the ledger
when the session had no Evolve result; the React page only offers what is in
`sessionStorage` and links to the Evolve page otherwise (the ledger record
has the best genome but the API returns no `final_population.csv` parsing).

## Pages done in Phase 4

All three optimizer pages share the Evolve pattern: `useJob` polls
`GET /api/jobs/{id}` (unchanged, only the generics differ), the per-step
`progress` payloads are accumulated into a live list during the run (polling
may skip steps; the completed `result` replaces the list), the form is
disabled while the job is active, `failed` shows the job error, and on
completion a `Provenance` line shows the ledger run id + configuration hash
(+ git commit), fetched from `GET /api/experiments/{run_id}` since job
results only carry the run id. Optimizer defaults (`MultiObjectiveConfig`,
`SensitivityConfig`, `ActiveLearningConfig`) are copied from the dataclass
defaults — `GET /api/meta/bounds` has no blocks for them — and the scalar
weights sent are `bounds.fitness_weights_default` (the Streamlit pages used
the session's Evolve weights; the React Evolve page keeps them local).

### Pareto (`pages/Pareto/`)

Port of `app/pages/05_Pareto.py`: objective multiselect from
`bounds.objectives` (`OBJECTIVES`), the `MultiObjectiveConfig` controls,
`free_genes`, the shared baseline (collapsible `ModelConfigForm`), notes.
While running: progress bar (`Generation g/N · front k · HV x · n
simulations`), best-per-objective line, a live **hypervolume / front-size
by generation** chart (`paretoCharts.ts::hypervolumeChart`, secondary y
axis) and a **Stop** button whose copy says stopping happens after the
current generation finishes. On `completed`/`stopped`: metrics, provenance,
the Pareto scatter over the first two objectives (`paretoScatter`; colour
by a free gene or a third objective, defaulting to the gene that varies most
along the front), the front table, "pick a point → Send to Compare", JSON /
CSV exports. Scoped down: the **dominated-candidate cloud** is not drawn —
the API result has no `final_population`.

### Sensitivity (`pages/Sensitivity/`)

Port of `app/pages/06_Sensitivity.py`: parameter checkboxes over
`bounds.evolvable`, perturbation fraction, seeds, notes. Progress is one
`ParameterSensitivity` per finished parameter → progress bar + a live
table; on completion the **tornado chart** (`sensitivityCharts.ts`,
horizontal diverging bars from the baseline fitness, sorted by |swing|),
the sorted table, exports. **No Stop button** — the API has no cooperative
cancellation for sensitivity (docs/API.md); the page says so while running.

### Active Learning (`pages/ActiveLearning/`)

Port of `app/pages/07_ActiveLearning.py`: `ActiveLearningConfig` controls.
Progress is one `ActiveLearningRecord` per real evaluation → progress bar,
live **best-so-far vs. real evaluations** line with per-evaluation markers
(`activeLearningCharts.ts`) and the iteration table (predicted mean/std and
acquisition value vs. actual fitness). **No Stop button** (no hook on the
GP-refit loop). Scoped down: the Streamlit page also ran a **random-search
baseline** of the same budget client-side; the API result does not include
one, so no baseline line is drawn (adding it would be a backend change
outside this phase's scope).

### Compare (`pages/Compare/`)

Port of `app/pages/03_Compare.py` on `POST /api/compare` (synchronous).
Scenarios: **Baseline** (always), **Best evolved** (`tel_evolve_best`, else a
prompt to run Evolve), **From Pareto page** (`tel_compare_user_config`),
**Manual** (a `ModelConfigForm` seeded from the baseline). "Force identical
simulator seed" sends the common `seed`. Results: five overlays
(`compareCharts.ts::overlayChart` — mean shortest telomere / senescent
fraction / proliferative cells, mean length with the threshold line, living
cells), the deltas table vs. the baseline (`runner.deltas` keys), the
scenario-parameter table and one fitness-composition bar per scenario
(`fitnessBreakdownBar` with a title prefix). Invalid scenarios are listed
and excluded from the charts, as in Streamlit.

### Experiments (`pages/Experiments/`)

Port of `app/pages/04_Experiments.py`. Tabs **My experiments** / **All
experiments** are the `?mine=true|false` query parameter (so a tab is
linkable), the table shows run id, timestamp, kind, seed, config hash,
fitness, git commit and notes (the summary route carries these columns since
Phase 4), newest first. Clicking a row sets `?run=<id>` (Provenance links
land here) and loads `GET /api/experiments/{id}` + `.../artifacts`: metric
cards, a **reproduction command** derived per kind the way the Streamlit
page did (`ledger.ts::reproductionCommand`, with copy-to-clipboard), the
artifact list with per-file download links (`href` is the API route; the
click fetches with the bearer token via `api/client.ts::requestBlob` and
saves the Blob, because a bare link cannot send the token) and the full
record JSON. Scoped down: no **zip bundle** download (the API serves single
files; `bundle_run_dir` is not exposed) and no "current environment" JSON
(`GET /api/meta/version` covers the versions).

## Scheduled protocols (stage 6b, 2026-09-10)

`docs/MODEL.md` §2.1 lets `stress_level` / `maintenance_rate` /
`repair_rate` vary as `K ≤ 8` piecewise-constant phases
(`ModelConfig.schedule`), and the optimizers search one value per phase
(`schedule_phases`). The API contract is in `../docs/API.md` (Simulate →
"Scheduled intervention protocols", the `schedule_phases` note under
long-running jobs, and the new `schedulable` / `max_phases` / `presets`
keys of `GET /api/meta/bounds`). Nothing about schedules is hardcoded in
TypeScript: the parameter list, the phase cap, the bounds of each per-phase
input and the fasting preset all come from that endpoint.

* **`components/scheduleUtils.ts`** (pure, unit-tested against MODEL.md's
  examples incl. cycles not divisible by K): `phaseIndex(t, cycles, K) =
  min(K−1, ⌊tK/cycles⌋)`, `phaseBounds`, `perCycleValues`, `meanApplied`
  (time average over the `cycles` steps of an `applied_schedule` array — the
  trailing clamped entry is dropped; this, not a formula, is what the UI
  reports as m̄ / r̄), `buildSchedule` / `withSchedule` / `configPayload`
  (emit exactly the `ModelConfig.to_dict()` shape, keep a scheduled
  parameter's scalar equal to its phase-0 value, and **omit** the `schedule`
  key from requests when nothing is scheduled), `splitGeneName` /
  `groupGenes` (`maintenance_rate@3` → parameter + phase) and
  `genomeToConfig` (the client port of `GenomeSpec.to_config`: `@` genes are
  assembled into a schedule whose phase count is the number of phases present
  for that parameter; `handoff.ts` re-exports it, so Evolve *Set best as
  baseline*, the Compare hand-offs and Pareto *Send this point* all carry a
  proper `schedule` instead of raw `@` keys).
* **Simulate** — `components/ScheduleEditor.tsx` renders as a "Protocol
  (schedule)" fieldset right after Dynamics (via `ModelConfigForm`'s
  `afterDynamics` slot): one "vary over time" toggle per `bounds.schedulable`
  parameter, a shared phase count (1..`bounds.max_phases`, showing the cycle
  ranges of each phase), one bounded number input per phase for every
  scheduled parameter, **Load fasting demo** (`bounds.presets.demo_fasting`,
  replaces the whole config) and **Reset to constant**. A scheduled
  parameter's scalar slider becomes read-only with a "scheduled" badge
  (`ModelConfigForm`'s `lockedLabels`); with the organ-on-chip mapper on, its
  two derived parameters cannot be scheduled (and are dropped from an existing
  schedule). Results: when `run.applied_schedule` is non-empty an **Applied
  protocol** step chart (`scheduleCharts.ts::appliedScheduleChart`, Plotly
  `line.shape: 'hv'`, follows the particle-canvas cursor) and a
  `ProtocolTable` (phase → cycle range → values, plus the time average
  computed from `applied_schedule`) appear above the four trajectory charts.
  The particle canvas is unchanged. The provenance "reproduce" line points a
  scheduled run at a YAML `--config` (the CLI's `--set` takes scalars only).
* **Evolve / Pareto / Active Learning** — a shared `PhasesControl`
  ("Protocol phases", 1..`max_phases`) sends `schedule_phases`. Its helper
  text is deliberately factual: a protocol search is a larger search space,
  and Experiment E (`docs/EXPERIMENT_PROTOCOL.md` §10) found no benefit over
  a constant dose. With `K > 1` the gene tables show `<gene>@<phase>` rows
  grouped by parameter in phase order (`GeneName` renders the phase tag), the
  parameter-trajectory chart maps each `@` gene onto its parameter's bounds,
  the Pareto colour-by options / hover use the actual genome keys, and the
  best candidate (Evolve), the picked front point (Pareto) and the best genome
  (Active Learning) get a phase table + step plot of the schedule
  `genomeToConfig` assembled (expanded with the same phase arithmetic — the
  job results carry no per-cycle payload).
* **Compare** — scenarios pass through untouched (the hand-offs and the
  session baseline may carry a `schedule`). When any scenario is scheduled, a
  compact **Applied protocols** panel draws each scheduled scenario's
  `applied_schedule` as dashed `hv` step lines (`protocolOverlayChart`), and
  the scenario-parameter table gains s̄ / m̄ / r̄ columns (`meanApplied` of the
  applied values; a constant scenario shows its scalar) with a † on the scalar
  cells of scheduled parameters (phase-0 values).
* Tests: `scheduleUtils.test.ts`, `ScheduleEditor.test.tsx`,
  `charts/scheduleCharts.test.ts`, plus new cases in the Simulate (payload
  omitted when constant; fasting preset posted verbatim + applied protocol
  rendered), Evolve (`schedule_phases` sent, `@` rows, best-protocol table,
  hand-off shape) and Compare (pass-through, protocol panel, mean columns)
  suites — Vitest 76.

## `useJob` (`api/useJob.ts`)

```ts
const { job, error, isActive, stop } = useJob<Progress, Result>(jobId, { intervalMs: 1000 })
```

Polls `GET /api/jobs/{id}` on a `setTimeout` chain (never overlapping
requests), stops on `completed` / `failed` / `stopped` and on a `401/403/404`
(job gone or not ours), and clears its timer on unmount or when `jobId`
changes. State is keyed by job id so switching jobs needs no reset effect.
`stop()` POSTs `/stop` and adopts the returned snapshot. Phase 4's Pareto /
Sensitivity / Active Learning pages should reuse it unchanged — only the
`Progress` / `Result` generics differ.

## Particle canvas (`components/PopulationCanvas.tsx`)

Rendering only, per the GPU strategy in `docs/ROADMAP.md`: nothing is
simulated in the browser. `populationFrames.ts` (pure, unit-tested) maps the
series that `SimulationResult.to_json_dict()` actually returns
(`population_size`, `senescent_fraction`, `proliferative_count`,
`mean_length_bp`, `shortest_length_bp`, plus `config.initial_length`) into
a per-cycle frame: particle count = living cells (capped at 1500),
coloured share = senescent fraction, size/brightness = mean length relative
to the initial length. Particles drift in a dish from a seed-deterministic
layout (`mulberry32`), so they are illustrative, not tracked cells — the
UI says so. Renderer: raw WebGL2 point sprites (no three.js), falling back
to Canvas 2D when WebGL2 is unavailable, and to a text notice when neither
context exists (jsdom). Play/pause, speed and a timeline scrubber; the
current cycle is pushed to the Simulate charts as a vertical cursor
(throttled to ~7 updates/s because it re-renders every Plotly figure).

It is **not** shown on Evolve: the evolve job result has no per-cycle
simulation payload for the best candidate. *Set best as baseline* → Simulate
is the way to see it.

## Auth state

`AuthProvider` (`src/auth/AuthContext.tsx`) holds
`{ token, user, status: 'loading' | 'anonymous' | 'authenticated' }`. On
start, a stored token is only trusted once `GET /api/auth/me` accepts it; a
401/403 clears it. `login()` distinguishes the API's three outcomes: 401 →
wrong credentials, 403 → email not verified (with a verify hint), 200 →
store token, fetch `/me`. `RequireAuth` redirects anonymous users to
`/login?next=<path>` and returns them after login.

**localStorage trade-off.** The JWT is persisted in `localStorage`
(`tel_token`) so a login survives page reloads — a deliberate UX improvement
over the Streamlit app's session-only login. The cost is that any script
running on this origin can read it (XSS), unlike an HttpOnly cookie. This is
acceptable for a research prototype with no third-party scripts; revisit if
the threat model changes.

## Dev-mode email links

Without `RESEND_API_KEY`, the backend returns `dev_verification_link` /
`dev_reset_link` in the register / forgot-password responses, shaped as
`/?token=…` and `/?reset_token=…` (root path + query param, see
`backend/routers/auth.py::_frontend_link`). The frontend maps these onto
`/verify?token=…` and `/reset-password?token=…` — both when rendering them
as clickable dev-mode links (`src/api/devLinks.ts`) and when such a link is
opened directly (the landing route redirects on those query params).
