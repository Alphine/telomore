# 🧬 Telomere Evolution Lab

**Simulate. Evolve. Compare. Learn.**

A lightweight, interactive AI-for-Science laboratory where an evolutionary
algorithm searches a telomere-dynamics model for virtual experiment
conditions that optimise an explicit scientific objective.

> **Scope.** This is a computational research prototype. It explores
> behaviour within a simplified model and does **not** provide medical
> advice, clinical predictions, or validated therapeutic recommendations.
> Parameters named after biological processes are simulation parameters.

Built for **Kaggle — AI4S Open Innovation: AI for Life Science**
(theme: AI + Organ-on-a-Chip). CPU-only, laptop-friendly, no GPU.

The app is a React frontend (`frontend/`) served by a FastAPI backend
(`backend/`) that wraps the Python science package (`src/telomere_lab/`) —
see [`docs/API.md`](docs/API.md) for the REST contract and
[`frontend/README.md`](frontend/README.md) for the frontend.

---

## The idea

```
biological hypothesis / objective
          ↓
   parameter genome  (stress, maintenance, repair, …)
          ↓
   telomere simulation  (cells × telomeres, per cell cycle)
          ↓
   biological outcomes  (length, senescence, survival)
          ↓
   fitness score  (explicit weighted objective)
          ↓
   mutation / selection → next generation  ↺
```

The simulator answers *"what happens under this configuration?"*; the
optimiser answers *"which configurations should we test next?"*. The web app
makes both observable.

## Quick start

Development — two terminals from the repo root (Python ≥ 3.11, Node 22):

```bash
# 1. API on :8000 (SQLite fallback, dev-mode email links -- see docs/API.md)
pip install -e ".[dev]"          # or: uv pip install -e ".[dev]"
uvicorn backend.main:app --reload --port 8000

# 2. React dev server on :5173, proxying /api -> :8000
cd frontend && npm install && npm run dev
```

Open <http://localhost:5173>. No extra setup needed for accounts/login: with
no `DATABASE_URL` set, user accounts are stored in a local SQLite file created
automatically on first use (see [Accounts / login](#accounts--login)); with
no `RESEND_API_KEY` set, verification/reset links are shown on screen.

Production shape — one process, one origin (this is what the `Dockerfile`
builds and Railway runs):

```bash
cd frontend && npm ci && npm run build && cd ..   # -> frontend/dist/
uvicorn backend.main:app --host 0.0.0.0 --port 8000
# or: docker build -t telomere-lab . && docker run -p 8000:8000 -e SECRET_KEY=... telomere-lab
```

FastAPI serves the `/api` routes and, when `frontend/dist/` exists, the built
React app with an SPA fallback. Required environment variables for a real
deployment (`SECRET_KEY`, `DATABASE_URL`, `RESEND_API_KEY`, …) are listed in
[`docs/API.md`](docs/API.md#deployment).

Headless (same engine, no GUI):

```bash
python scripts/run_simulation.py --config configs/demo.yaml --seed 42
python scripts/run_evolution.py  --config configs/evolution.yaml --seed 7
python scripts/run_pareto.py     --config configs/pareto.yaml --seed 7      # NSGA-II
python scripts/run_evolution.py  --config configs/evolution_locked.yaml --seed 7  # stress locked
python scripts/run_evolution.py  --config configs/evolution_protocol.yaml --seed 7 # stress locked, 6-phase protocol search
python scripts/run_simulation.py --config configs/demo_fasting.yaml --seed 42      # hand-written alternating-stress schedule
python scripts/run_protocol_experiment.py --seed 7                                  # Experiment E: constant vs protocol
python scripts/run_simulation.py --config configs/demo_subclone_competition.yaml --seed 42  # resilient vs fragile clone, shared stress
python scripts/run_sensitivity.py --config configs/sensitivity.yaml                 # OAT tornado
python scripts/run_active_learning.py --config configs/active_learning.yaml --seed 1 # surrogate + Expected Improvement
python scripts/benchmark.py
python scripts/benchmark_optimizers.py                                              # GA vs NSGA-II vs random search vs active learning
python -m pytest
```

## Accounts / login

Every functional page — **Simulate, Evolve, Pareto, Sensitivity, Active
Learning, Compare, Experiments** — requires a logged-in account; the
**Home** page stays public (it's the marketing/overview page, feature cards
and page links included — only clicking through to a feature page hits the
login gate). Auth is self-serve username + password (no OAuth) on the
`/register` and `/login` pages; the API issues a 7-day JWT
(`docs/API.md`).

Storage: **PostgreSQL** in production, via Railway's Postgres plugin, which
injects a `DATABASE_URL` env var into the app service automatically.
Locally, with no `DATABASE_URL` set, the app **transparently falls back to
a SQLite file** under `data/local.db` (created on first use, git-ignored) —
same schema, same code path, zero setup. This is why `pip install -e
".[dev]"` + `uvicorn backend.main:app` (and `pytest`) keep working out of
the box with no local database server.

Login state is the JWT, kept in the browser's `localStorage` so it survives
page reloads (see `frontend/README.md` "Auth state" for the trade-off); it
expires after 7 days or when `SECRET_KEY` changes. There is no server-side
session store.

Registration now also collects an **email address**, and a fresh account
starts unverified. A logged-in-but-unverified user sees a "verify your
email" screen instead of the real page content on every gated feature (with
a "resend verification email" button) until they click the link from their
verification email. **Forgot password** (`/forgot-password`) emails (or, in
dev mode, displays) a reset link valid for one hour.

Transactional email (verification + password reset) is sent via
[Resend](https://resend.com) from `src/telomere_lab/email.py`, gated on the
`RESEND_API_KEY` environment variable — the same present-vs-absent pattern
as `DATABASE_URL` above:

* **`RESEND_API_KEY` set** (production, injected as a Railway env var) —
  `send_email()` POSTs to Resend's API and the link is actually emailed to
  the user. The sender is Resend's shared sandbox address
  (`onboarding@resend.dev`), since this project has not verified a custom
  sending domain.
* **`RESEND_API_KEY` not set** (local dev, CI, `pytest`) — `send_email()` is
  a no-op (no network call at all); the API returns the verification/reset
  link in its JSON response (`dev_verification_link` / `dev_reset_link`) and
  the UI shows it on screen, captioned "Email not configured (dev mode) — use
  this link directly". This is what
  lets the whole flow — register, verify, log in, forgot password, reset —
  be tested end-to-end locally and in CI with zero real credentials.

Deliberately out of scope for this pass (reasonable to add later, not
required now): rate-limiting on reset-link requests, a CAPTCHA on
registration, and verification-token expiry (unlike reset tokens, which
expire after 1 hour, a verification token stays valid until used).

On the **Experiments** page, the reproducibility ledger is split into an
"All experiments" tab (the full shared ledger, exactly as before) and a
"My experiments" tab (only the run IDs recorded under your account). The
underlying JSONL ledger itself is unchanged — the accounts database only
tracks which run IDs belong to which user.

## App pages (React routes)

The landing page (`/`) and the auth pages are public; every route below is
behind the login gate.

| Route | Page | Purpose |
|---|---|---|
| `/simulate` | **Simulate** | Inputs for every model parameter (plus an optional organ-on-chip condition mapper). A WebGL particle view of the culture, a synthetic 0-100 "biological age index" gauge (a documented composite of the model's own metrics, not a real biomarker), and interactive Plotly charts: length trajectories, final length distribution, senescence, population, and the age index over time. A lazy-loaded **3D telomere view** (chromosomes with telomere caps that shorten from teal to red until the cell is depleted; an illustration reconstructed from summary statistics) and a one-click *healthy-vs-damaged clones* preset. JSON/CSV export and reproduction command. |
| `/evolve` | **Evolve** | Configure the objective weights and the genetic algorithm, press *Evolve*, watch best/mean fitness live generation by generation (with a Stop button), then diversity and the best candidate's parameter trajectory. Every run is registered. |
| `/pareto` | **Pareto** | NSGA-II multi-objective search. Choose two or more objectives (e.g. survival vs. intervention cost) and get the **Pareto front** instead of one weighted winner; hypervolume by generation; send any front point to Compare. |
| `/sensitivity` | **Sensitivity** | One-at-a-time (OAT) sensitivity analysis: perturb each evolvable parameter +/- a fraction of its range around the baseline, one at a time, and read off the fitness swing as a tornado chart — which single knob matters most, holding everything else fixed. |
| `/active-learning` | **Active Learning** | Surrogate-model active learning: a Gaussian-process surrogate + Expected Improvement chooses which untested configuration to evaluate next with the real simulator, reaching good fitness with fewer real evaluations than random search. |
| `/compare` | **Compare** | Overlay baseline vs. best evolved vs. a Pareto point vs. a manual scenario with common random numbers; read the deltas and each scenario's fitness composition. |
| `/genome` | **Genome Explorer** | A *toy* DNA → RNA → protein layer: the real standard genetic code applied to three synthetic genes. Click a base to mutate it and see the effect (synonymous / missense / nonsense / start-loss), then compare a normal and a damaged (checkpoint- and repair-deficient) lineage. Synthetic genes, uncalibrated — a teaching aid (`docs/MODEL.md` §2.4). |
| `/experiments` | **Experiments** | Reproducibility ledger (run ID, timestamp, git commit, versions, seed, config hash, fitness, artifacts) with per-file artifact download and a reproduction command. |

## Where it runs

* **https://studylab.id/** — landing page (`deploy/landing/`) for both labs.
* **https://studylab.id/telomore/** — the React app as a static build on Hostinger (`VITE_BASE=/telomore/`);
  every API call goes to the Railway backend (`VITE_API_BASE`, CORS-allowed). Old root links such as
  `/simulate` redirect here. Deploy everything with `deploy_studylab.bat`.
* **https://telomore-production.up.railway.app/** — the same app served by FastAPI itself (the
  backend's own origin; Python compute always runs here).

## Foci Lab (companion site with real microscopy)

**https://studylab.id/foci/** explores a published genome-wide siRNA screen of 53BP1 DNA-damage foci
(IDR idr0010, Doil et al. 2009, CC BY 4.0): 17,536 genes, the original images, and Experiment L, an
honest negative result on automated foci counting. See `foci/README.md`.

## Model in one paragraph

Each cell carries a set of telomere lengths (bp). Per cell cycle every
proliferative cell divides; each replicated telomere loses
`shortening_rate` + stress-dependent loss × (1 − `repair_rate`) + noise,
and gains a telomerase-like amount directed preferentially to the cell's
shortest telomere. A cell becomes irreversibly senescent when its shortest
telomere falls below `senescence_threshold`; senescent cells stop dividing
and are slowly lost; the culture is passaged back to carrying capacity.
Exact equations, ranges and simplifications: [`docs/MODEL.md`](docs/MODEL.md).

**Protocols (time-varying interventions).** `stress_level`,
`maintenance_rate` and `repair_rate` can optionally follow a
piecewise-constant **schedule**: the run is split into up to 8 equal phases
and each scheduled parameter gets one value per phase
(`configs/demo_fasting.yaml` alternates high/low stress over six phases).
Every optimizer accepts `schedule_phases`, which turns each schedulable free
gene into one gene per phase, so the GA / NSGA-II / active learner search
over *protocols* rather than constants; the intervention cost is charged on
the time-averaged dose. Unscheduled configs behave exactly as before.
Semantics: [`docs/MODEL.md` §2.1](docs/MODEL.md); first real run:
Experiment E in [`docs/EXPERIMENT_PROTOCOL.md`](docs/EXPERIMENT_PROTOCOL.md).
(Python core + CLI only so far; the React forms do not expose schedules yet —
`docs/ROADMAP.md`.)

## Fitness (the AI's objective)

```
fitness = 0.40·survival + 0.30·telomere_reserve − 0.20·senescence − 0.10·instability − 0.30·intervention_cost
intervention_cost = ½ (maintenance² + repair²)      # convex: "just enough", not "max everything"
```

Weights are user-configurable on the Evolve page. **Fitness ≠ biological truth**:
it is the experimenter's objective under the model's assumptions.

Because any weighting is a choice, the **Pareto** page runs NSGA-II on the
raw objectives and returns the whole trade-off front (`docs/MODEL.md` §5.1).

Every candidate's fitness is averaged over multiple simulator seeds
(`eval_seeds`, default `(1, 2, 3)`) rather than a single stochastic draw, so
the GA/NSGA-II/sensitivity analysis are all comparing candidates on a less
noisy estimate of fitness. `scripts/benchmark_optimizers.py` compares GA,
NSGA-II, a budget-matched random search, and a surrogate-model active
learner (`docs/MODEL.md` §5.2) on this same scalar fitness to sanity-check
that evolution — and being selective about which configuration to test
next — actually beats undirected search.

## Reproducible experiment

See [`docs/EXPERIMENT_PROTOCOL.md`](docs/EXPERIMENT_PROTOCOL.md) for five
reproducible experiments — every number in it comes from an actual run
recorded in `experiments/`:

- **A.** GA, baseline vs. evolved, stress free to evolve — fitness −0.13 → +0.63.
- **B.** NSGA-II Pareto front (survival vs. cost), stress free — reveals that
  A's answer overspends on cost for reserve, not survival.
- **C.** Both optimizers with `stress_level` **locked** (a stressor the
  experimenter cannot remove) — the more realistic case, where the front
  shows a genuine maintenance/repair trade-off and locking recovers 84 % of
  A's improvement using only real interventions.
- **D.** Structural, model-to-model comparison (not a validation against
  data) with the published, GPLv3 `anais-rat/telomeres` (telomerase-negative
  *yeast* senescence model): the shape of our generations-to-senescence
  distribution vs. theirs. Absolute generation counts differ and are not
  comparable; run in an isolated environment so the two licenses never mix
  (`scripts/reference_model/`).
- **E.** Constant interventions vs. a 6-phase scheduled **protocol** with
  stress locked (same GA, same seed): does letting the optimizer time its
  interventions buy anything at matched time-averaged cost?

## Repository layout

```
backend/        FastAPI app (main.py, auth.py JWT, jobs.py in-memory job store, routers/ one per page)
frontend/       React + Vite + TypeScript app (src/pages/ one per route, src/api/ client; builds to dist/)
src/telomere_lab/
  db.py         user accounts + "which run belongs to which user" (Postgres/SQLite)
  email.py      transactional email via Resend, dev-mode no-op fallback (RESEND_API_KEY)
  schemas.py    typed configs, bounds, result containers
  simulator/    model.py, population.py, metrics.py, stochastic.py
  evolution/    genome, mutation, crossover, selection, fitness, engine, benchmark, surrogate (active learning)
  analysis/     sensitivity (OAT tornado analysis)
  experiments/  registry (ledger), runner (service layer), artifacts
  adapters/     model protocol, published-model stub, organ-on-chip mapping
configs/        default.yaml, demo.yaml, demo_fasting.yaml, demo_subclone_competition.yaml, evolution*.yaml (incl. evolution_protocol.yaml), pareto*.yaml, sensitivity.yaml, active_learning.yaml
scripts/        run_simulation.py, run_evolution.py, run_pareto.py, run_sensitivity.py, run_active_learning.py, run_protocol_experiment.py, benchmark.py, benchmark_optimizers.py
tests/          simulator, metrics, evolution, schedule (+ fixtures/ golden output), sensitivity, surrogate, benchmark, db, email, API (test_api_*.py)
docs/           SDD, MODEL, SCIENTIFIC_SCOPE, EXPERIMENT_PROTOCOL, API, ROADMAP
experiments/    runs/ (ledger + artifacts, git-ignored), reports/
data/           local SQLite fallback DB for accounts (git-ignored; unused when DATABASE_URL is set)
Dockerfile      multi-stage image (node build of frontend/ -> python:3.13-slim running uvicorn); railway.json points at it
```

## Scientific limitations

* Abstract population model; no telomerase kinetics, ALT, chromosome
  identity or molecular detail. The only checkpoint is an optional,
  scalar apoptosis checkpoint on a mutation-burden abstraction
  (`docs/MODEL.md` §2.3); it is off by default.
* "Stress", "repair" and "maintenance" are scalar abstractions.
* The organ-on-chip mapping is a documented assumption with uncalibrated
  coefficients.
* The only reference-model comparison is Experiment D: a structural
  model-to-model comparison with the yeast model `anais-rat/telomeres`
  (SDD §22 Level 3). It is not a validation against data, and the
  in-process adapter remains a stub by design.
* The companion Foci Lab's automated foci counter is unvalidated: it does
  not reproduce the published counts (Experiment L).
* No bring-your-own-data import or parameter fitting yet (planned,
  `docs/ROADMAP.md`).
* The optimiser optimises the chosen objective, nothing else.

Full statement: [`docs/SCIENTIFIC_SCOPE.md`](docs/SCIENTIFIC_SCOPE.md).

## Design document

[`docs/SDD.md`](docs/SDD.md) is the software design document this
implementation follows (build order SDD §44).

## License

MIT.
