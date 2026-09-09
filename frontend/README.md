# React frontend (Phases 2–3 of the Streamlit → React migration)

Vite + React 18 + TypeScript + Tailwind CSS v4 + React Router v6, built
against the FastAPI backend in `../backend/` (contract: `../docs/API.md`).

Phase 2 delivered the scaffold: routing, auth pages (login / register /
verify / forgot- and reset-password), the public landing page ported from
`app/streamlit_app.py`, and a protected shell. Phase 3 replaced the
**Simulate** and **Evolve** placeholders with full ports of
`app/pages/01_Simulate.py` / `02_Evolve.py`, added the job-polling hook and
the WebGL particle visualization. Pareto / Sensitivity / Active Learning /
Compare / Experiments are still placeholders (Phase 4). **The Streamlit app
in `../app/` is still the live production UI** — Railway keeps starting it.

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

`frontend/dist/` is git-ignored. When it exists, `backend/main.py` serves it
(static `/assets` + SPA fallback to `index.html` for every non-`/api` GET),
so a single `uvicorn backend.main:app` process hosts API + frontend on one
origin — the production shape planned in `docs/ROADMAP.md`. Without a build
the backend behaves exactly as before (API only).

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
              download.ts (Blob exports, CSV builders)
              charts/  Plot.tsx (lazy wrapper), PlotlyPlot.tsx (the plotly import),
                       theme.ts (PALETTE/_LAYOUT port + dark mode),
                       simulationCharts.ts, evolutionCharts.ts
  pages/      Landing, Login, Register, ForgotPassword, ResetPassword, Verify,
              Simulate/ (index.tsx, metrics.ts), Evolve/ (index.tsx, form.ts),
              Placeholder (remaining protected stubs), NotFound
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
`backend/routers/evolve.py`). **"Send best to Compare"** is a TODO for Phase
4 — the only cross-page state is the baseline hand-off below.

### Baseline hand-off

`components/baseline.ts` keeps the shared baseline `ModelConfig` in
`sessionStorage` (`tel_baseline_config`), mirroring
`st.session_state["baseline_config"]`: Simulate's *Set as baseline* writes
it, Evolve reads it (falling back to `bounds.demo`), Evolve's *Set best as
baseline* writes the base config with the best genome merged in, and
Simulate's *Reset to demo baseline* clears it.

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
