# ROADMAP.md

Running log of the long-term product direction for Telomere Evolution Lab,
now that it has graduated from a hackathon submission to an ongoing
personal project ("private lab"). This file is a decision log, not a
committed spec — entries are dated and should be revisited as the project
evolves. Build sessions going forward may use Claude Fable 5.1.

## Status as of 2026-09-09

Live at `telomore-production.up.railway.app` (Railway project
`earnest-vibrancy`, services `telomore` + `Postgres`). Streamlit GUI +
Python backend (`src/telomere_lab/`), 82 tests passing. Features shipped:
core simulator, GA, NSGA-II Pareto, sensitivity analysis (OAT + tornado),
multi-seed fitness, optimizer benchmark (GA/NSGA-II/random search),
surrogate-model active learning (GP + Expected Improvement), reference-model
comparison (`anais-rat/telomeres`), user accounts (Postgres + bcrypt),
email verification + forgot-password (Resend, dev-mode fallback), landing
page + CSS polish.

## In progress: Streamlit → React migration

Decision (2026-09-09): fully replace the Streamlit GUI with a React
frontend, because Streamlit's UX and simulation-interactivity (no smooth
live-updating charts during a long optimization run) feel limiting.

- **Stack**: FastAPI backend (thin wrapper reusing `src/telomere_lab/` as a
  dependency, not a rewrite of the science) + React (Vite + TypeScript)
  frontend. Single Railway service — FastAPI serves both the API and the
  built static frontend, no separate service/CORS complexity in production.
- **Phasing** (deliberately staged, not a big-bang rewrite, to avoid the
  concurrent-agent file-clobbering problems seen earlier in this project):
  1. FastAPI backend — auth (JWT) + all simulate/evolve/pareto/sensitivity/
     active-learning/benchmark/experiments endpoints, async job-polling
     pattern for long-running operations. **Done 2026-09-09** (`backend/`,
     `docs/API.md`).
  2. React scaffold — routing, auth pages, landing page, API client.
     **Done 2026-09-09** (`frontend/`, Vite + React 18 + TS + Tailwind v4;
     FastAPI serves the build when present — see `frontend/README.md`).
  3. Migrate the highest-interactivity pages first: Simulate, Evolve.
     **Done 2026-09-09** (`frontend/src/pages/Simulate`, `pages/Evolve`,
     `api/useJob.ts` polling hook, `components/PopulationCanvas.tsx`
     WebGL2/Canvas2D particle visualization, `GET/POST /api/meta/*`
     metadata endpoints — see `frontend/README.md`, `docs/API.md`).
  4. Migrate the rest: Pareto, Sensitivity, Active Learning, Compare,
     Experiments.
  5. Remove `app/` (Streamlit) entirely, update Railway start command +
     docs. Streamlit stays the live production UI until this step.

## GPU strategy (decided 2026-09-09)

- **Compute stays CPU-only, server-side, Python.** Rejected: reimplementing
  the simulation core in WebGPU compute shaders (WGSL) for client-side
  execution. Reason: it would fork the scientific model into a second,
  independent implementation that has to stay numerically consistent with
  the Python version already validated by 82 tests and compared against
  the published reference model (`anais-rat/telomeres`) — a correctness
  and maintenance risk not justified by the actual compute cost (single
  simulations already run sub-second on CPU; not a bottleneck at current
  scale). WebGPU browser support is also not universal yet (Safari lags),
  so a CPU/JS fallback would be needed regardless, doubling the surface
  area for no clear win today.
- **A pluggable server-side array backend (numpy default, optional
  CuPy/PyTorch if a local GPU is present) is a reasonable future addition
  for self-hosted/local power users running very large populations or
  generation counts** — NOT for the Railway-hosted deployment, which has
  no GPU tier. Not started; revisit only if a concrete large-scale use
  case appears (e.g. population sizes in the tens of thousands, or a
  higher-fidelity per-chromosome model).
- **Cloud GPU burst-compute** (dispatching heavy jobs to a paid external
  GPU provider like Modal/RunPod on demand) was considered and shelved —
  real infra/billing complexity for a need that doesn't exist yet at this
  project's current scale.
- **WebGPU/WebGL IS in scope for client-side VISUALIZATION** (not compute):
  real-time particle rendering of the cell/telomere population — e.g.
  hundreds of animated points shrinking/going senescent as a simulation or
  optimizer run streams progress from the backend. This is purely a
  rendering layer on top of data computed server-side in Python, so it
  carries none of the dual-implementation risk above. Planned as part of
  the React migration's Simulate/Evolve pages (Phase 3).

## Candidate next-simulation features (brainstormed 2026-09-09, not yet built)

Ranked by the account owner's stated priority:

1. **Time-varying / scheduled intervention protocols** (highest priority).
   Currently `stress_level`/`repair_rate`/`maintenance_rate` are constant
   for the whole run. Allowing them to be scheduled per cycle-range (e.g.
   "boost repair only during cycles 10-20") turns the optimizer's search
   space from "find good constant parameters" into "find a good
   *protocol*" — a materially stronger AI-contribution story for judging
   (per `docs/SDD.md` §37's emphasis on AI + scientific modeling, not just
   UI). Needs: `ModelConfig` schema extension for scheduled parameters,
   simulator loop changes to read schedule at each cycle, gene encoding
   changes for the optimizers to search over schedules.
2. **Ensemble / uncertainty visualization** (pairs directly with the
   WebGPU particle-viz plan above). Run many seeds, show the full spread
   (fan chart / particle cloud) instead of a single mean trajectory —
   scientifically more honest about the model's stochasticity, and a
   natural fit for a particle-based renderer (many trajectories = many
   particle streams).
3. **Multi-chip / multi-organ parallel comparison.** Run several organ-chip
   condition profiles (e.g. liver-chip vs lung-chip stress signatures)
   side by side. Strengthens the "AI + Organ-on-a-Chip" theme, which is
   currently thin (only one chip→parameter mapping, uncalibrated).
4. **Sub-population / sub-clone competition.** Multiple genetically
   distinct sub-populations competing for carrying-capacity slots within
   one simulation — an inner evolutionary layer distinct from the outer
   parameter-search loop.
5. **Synthetic "biological age" biomarker score.** A single relatable
   demo-friendly number derived from the trajectory, with the same strict
   scope-language discipline as the rest of the project
   (`docs/SCIENTIFIC_SCOPE.md`).

## LLM agentic layer (decided 2026-09-09, two layers, both approved)

The SDD originally scoped an LLM layer as out-of-scope for the hackathon
MVP. Now that this is an ongoing project, it's back in scope, deliberately
split into two layers of increasing ambition/risk. **Bring-your-own-key**:
the user supplies their own LLM API key (Anthropic first, others later);
the app never bears LLM cost and the key is **session-only, never
persisted to the database** — same non-persistent-credential posture as
the existing login system.

### Layer 1 — Results interpreter (build first, low risk)

Read-only. The LLM reads an experiment's results (ledger entry, sensitivity
tornado data, Pareto front, active-learning convergence) and writes a
plain-language scientific narrative — why the optimizer picked a given
trade-off, which parameter dominates, what a front shape implies. Never
touches the simulator or proposes configs. Must follow the same language
discipline already codified in `docs/SCIENTIFIC_SCOPE.md` ("AI identified
parameter configurations that optimize...", never "AI discovered a cure"
or similar overclaiming) — the interpreter's system prompt should quote
that policy directly, not re-derive it. Directly strengthens the judging
narrative (`docs/SDD.md` §37's four questions) since it can generate that
narrative dynamically from real run data.

### Layer 2 — Protocol-designing agent (build after roadmap item #1 above)

Depends on the time-varying/scheduled-protocol simulation feature
(candidate feature #1 above) existing first — Layer 2 needs a "schedule"
concept to propose into. The LLM is given a constrained tool: it may
propose a candidate `ModelConfig` / intervention schedule (e.g. a
fasting-like cyclic pattern — high stress N cycles, repair boost M cycles,
repeat), inspired by real biological analogies the user cares about
(caloric restriction / intermittent fasting as an intervention motif).

**Hard safety boundary (this is the direct answer to "tanpa merusak dan
mengubah DNA"):** the LLM never executes biology and never bypasses
validation. Every proposal is just numbers/schedule within the existing
`PARAMETER_BOUNDS`, and every proposal MUST pass the exact same
`ModelConfig.validate()` (or its scheduled-protocol equivalent) that every
other config already passes — GA-mutated, NSGA-II-mutated, or
human-typed-in-the-GUI configs all go through the identical gate. The LLM
only ever gets to *suggest a hypothesis*; the deterministic Python
simulator is the only thing that ever "runs the biology," exactly as
today. This means Layer 2 cannot introduce a new class of bug or safety
issue beyond "a proposed config that's valid but scientifically
uninteresting" — worst case is a wasted simulation, not a corrupted one.

Additional guardrails to design in when this is built: rate-limit/cap how
many proposals an agentic session can queue per run (cost control on the
user's own key), log every LLM-proposed config in the experiment ledger
tagged with its provenance (so "AI-proposed" vs "human-typed" vs
"GA-evolved" configs stay distinguishable in `docs/EXPERIMENT_PROTOCOL.md`
write-ups), and give the user a review/approve step before an LLM-proposed
protocol actually runs (no fully autonomous unattended agent loop for v1).

## Explicitly deferred / out of scope for now

- Literature calibration of default parameters (needs real citation work,
  not just coding).
- Organ-on-chip coefficient calibration against physical chip data.
- GitHub Actions CI.
- Kaggle notebook submission packaging.
- An in-GUI "Assumptions" page rendering `docs/MODEL.md` equations.
- 3-objective Pareto front for the locked-stress scenario (NSGA-II engine
  already supports 3 objectives, just never run for this scenario).
- `--resume` CLI flag / multiprocessing for parallel fitness evaluation.
- Combining with the unrelated `Baby_Monster` project (evolutionary-RL
  cognitive-architecture research, PyTorch/notebook-driven, entirely
  different compute profile and maturity stage) into one app — decided
  2026-09-09 to keep fully separate. A lightweight shared "portal" linking
  out to both independent apps was floated as a much later, optional idea
  if the "private lab" framing is wanted — not planned yet.
