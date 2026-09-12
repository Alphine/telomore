# ROADMAP.md

Running log of the long-term product direction for Telomere Evolution Lab,
now that it has graduated from a hackathon submission to an ongoing
personal project ("private lab"). This file is a decision log, not a
committed spec — entries are dated and should be revisited as the project
evolves. Build sessions going forward may use Claude Fable 5.1.

## Status as of 2026-09-10

Live at `telomore-production.up.railway.app` (Railway project
`earnest-vibrancy`, services `telomore` + `Postgres`). React frontend
(`frontend/`) + FastAPI backend (`backend/`) + Python science package
(`src/telomere_lab/`), deployed as one Docker image (`Dockerfile`,
`railway.json`); 158 pytest + 76 Vitest tests passing. Features shipped:
core simulator (with optional piecewise-constant intervention schedules —
core, API and React UI, 2026-09-10), GA, NSGA-II Pareto, sensitivity analysis (OAT + tornado),
multi-seed fitness, optimizer benchmark (GA/NSGA-II/random search),
surrogate-model active learning (GP + Expected Improvement), reference-model
comparison (`anais-rat/telomeres`), user accounts (Postgres + bcrypt, JWT),
email verification + forgot-password (Resend, dev-mode fallback), landing
page, WebGL particle visualization of the culture on Simulate.

## Completed: Streamlit → React migration (2026-09-09 → 2026-09-10)

Decision (2026-09-09): fully replace the Streamlit GUI with a React
frontend, because Streamlit's UX and simulation-interactivity (no smooth
live-updating charts during a long optimization run) feel limiting.
Completed 2026-09-10 with Phase 5 below; the Streamlit app is gone.

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
     Experiments. **Done 2026-09-10** (`frontend/src/pages/{Pareto,
     Sensitivity,ActiveLearning,Compare,Experiments}`, `POST /api/compare`,
     `GET /api/experiments/{run_id}/artifacts[/{name}]`, `objectives` on
     `GET /api/meta/bounds` — see `frontend/README.md`, `docs/API.md`).
  5. Remove `app/` (Streamlit) entirely, update Railway start command +
     docs. **Done 2026-09-10**: `app/`, `tests/test_app.py`, `Procfile`
     and the `streamlit`/`plotly` Python dependencies removed; new
     multi-stage `Dockerfile` (node build of `frontend/` → `python:3.13-slim`
     running `uvicorn backend.main:app`) with `railway.json` on the
     `DOCKERFILE` builder + `/api/health` healthcheck (see `docs/API.md`
     "Deployment" for the required env vars — `SECRET_KEY` must be set
     before the first deploy); `ExperimentRegistry` now resolves
     `config.RUNS_DIR` at call time so the API tests write their ledger into
     `tmp_path` instead of the real `experiments/` tree.

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

## Candidate next-simulation features (brainstormed 2026-09-09)

Ranked by the account owner's stated priority:

1. **Time-varying / scheduled intervention protocols** (highest priority).
   **DONE 2026-09-10** — Python core (stage 6a) and API + React (stage 6b,
   same day, see below). `stress_level`/`repair_rate`/`maintenance_rate`
   may now be piecewise constant over `K ≤ 8` equal phases
   (`ModelConfig.schedule`, `InterventionSchedule`, `SCHEDULABLE_PARAMETERS`,
   `MAX_PHASES`; phase of step `t` = `min(K−1, ⌊tK/cycles⌋)`); the
   simulator reads the scheduled value per step and records
   `SimulationResult.applied_schedule`; the intervention cost is charged on
   the time-averaged dose; the GA / NSGA-II / active learner take
   `schedule_phases` and expand each schedulable free gene into one gene
   per phase (`<gene>@<phase>`), so the search space is "find a good
   *protocol*", not just good constants — the materially stronger
   AI-contribution story argued for below. Unscheduled configs are
   bit-identical to before (golden-fixture tests). Full spec:
   `docs/MODEL.md` §2.1; first real run: `docs/EXPERIMENT_PROTOCOL.md`
   Experiment E (constant vs. 6-phase protocol, stress locked); configs
   `configs/evolution_protocol.yaml`, `configs/demo_fasting.yaml`.
   **Stage 6b DONE 2026-09-10:** the API types the `schedule` block
   (`backend/schemas.py::ModelConfigBody` / `InterventionSchedule`, free-form
   otherwise) and `schedule_phases` (`OptimizerConfigBody`, range-checked
   against `MAX_PHASES`) on every config body, types `applied_schedule` on the
   simulate/compare results, and `GET /api/meta/bounds` exposes
   `schedulable` / `max_phases` / `presets.demo_fasting`; invalid schedules
   still surface the core `ConfigError` as 400 (`tests/test_api_schedule.py`).
   React: a `ScheduleEditor` on Simulate (per-parameter "vary over time"
   toggles, shared phase count, per-phase bounded inputs, "Load fasting demo",
   "Reset to constant"; `schedule` is omitted from the request when constant)
   with an "Applied protocol" step chart + phase table (time averages computed
   from `applied_schedule`); a "Protocol phases" control on
   Evolve/Pareto/Active Learning (factual helper text citing Experiment E's
   negative result) with `gene@phase` tables and a best-candidate phase table
   + step plot; Compare passes scheduled scenarios through and adds a dashed
   step-line protocol panel plus s̄/m̄/r̄ columns. `genomeToConfig` (client
   port of `GenomeSpec.to_config`) assembles `@` genes into a `schedule` for
   every hand-off. Docs: `docs/API.md`, `frontend/README.md` "Scheduled
   protocols". LLM Layer 2 (below) is now unblocked.
2. **Ensemble / uncertainty visualization** (pairs directly with the
   WebGPU particle-viz plan above). Run many seeds, show the full spread
   (fan chart / particle cloud) instead of a single mean trajectory —
   scientifically more honest about the model's stochasticity, and a
   natural fit for a particle-based renderer (many trajectories = many
   particle streams). **DONE 2026-09-11** — `POST /api/simulate/ensemble`
   (`backend/routers/simulate.py`, a new route alongside the unchanged
   `POST /api/simulate`) runs the existing, unmodified `simulate()` once per
   seed (`telomere_lab.experiments.runner.run_ensemble`, a plain Python
   loop — each run is sub-second, so multiprocessing was not added; noted
   as a future optimization if `n_seeds=50` runtime ever becomes a measured
   problem) for seeds `base_seed .. base_seed + n_seeds - 1` (`n_seeds` in
   `[2, 50]`), and returns p10/p50(median)/p90 + mean bands of `mean_length`
   computed independently at each cycle across seeds
   (`runner.summarize_ensemble` — an honest, distribution-free description
   of the spread, not a per-trajectory confidence band), light-weight
   per-seed series (not a full `to_json_dict()` each — that would be
   `n_seeds`x the single-run payload) and per-seed terminal metrics, with
   exactly one ledger entry per ensemble call (`kind: "ensemble"`). React:
   an "Ensemble (uncertainty)" section on Simulate, additive and never
   affecting the existing single-run flow — a fan chart (p10-p90 shaded
   band + median/mean lines, `components/charts/ensembleCharts.ts`), a
   min/mean/max/std terminal-metrics summary table across seeds
   (`components/EnsembleSummaryTable.tsx`), and `EnsemblePopulationCanvas.tsx`,
   a multi-stream sibling of `PopulationCanvas` rendering up to 5 overlaid
   seed streams with reduced per-stream opacity — Canvas 2D only
   (documented scope reduction vs. the single-run canvas's WebGL2 renderer,
   to keep a second, independently-timed multi-stream program from
   multiplying that renderer's complexity for a feature the build brief
   explicitly allows a lighter-touch treatment). Docs:
   `docs/API.md` "Ensemble / uncertainty visualization",
   `frontend/README.md` "Ensemble (uncertainty) mode". Tests:
   `tests/test_api_ensemble.py`, `charts/ensembleCharts.test.ts`,
   `EnsembleSummaryTable.test.ts`, ensemble cases in `Simulate.test.tsx`.
3. **Multi-chip / multi-organ parallel comparison.** Run several organ-chip
   condition profiles (e.g. liver-chip vs lung-chip stress signatures)
   side by side. Strengthens the "AI + Organ-on-a-Chip" theme, which is
   currently thin (only one chip→parameter mapping, uncalibrated).
   **DONE 2026-09-11** — `adapters/chip.py::CHIP_PRESETS` (five named,
   illustrative profiles: `static_well`, `liver_chip_like`, `lung_chip_like`,
   `gut_chip_like`, `injury_stress_chip_like` — each a hand-picked point in
   the existing (flow, oxygen, nutrients, stress, duration) space, framed
   loosely around real organ-on-chip *concepts* without claiming calibration,
   per `docs/SCIENTIFIC_SCOPE.md`) + `list_chip_presets()`; the chip→param
   mapping formula itself (`chip_to_model_params`) is untouched.
   `GET /api/meta/chip-presets` (public) exposes every preset plus its
   derived `{stress_level, repair_rate, cycles}`. `POST /api/compare`'s
   scenario shape now accepts `{name, chip: {...ChipConditions...}}` as an
   alternative to `{name, config: {...ModelConfig...}}` — exactly one of the
   two (400 on both-or-neither); a `chip` scenario is mapped through the
   unchanged `chip_to_model_params` and merged onto the request's new
   `base_config` (`{...base_config, ...derived}`, the same override
   semantics `ChipMapper` already used client-side) before validation, so
   `/api/compare` stays the single comparison engine — `runner.compare_scenarios`/
   `deltas` were not touched. React: a new "Organ-chip presets" scenario
   source on the Compare page (`api/useChipPresets.ts`) — a preset
   picker + "+ Add scenario" that can add any number of presets (including
   the same one twice) as separate rows alongside the existing
   baseline/evolved/pareto/manual scenarios, each showing its derived
   stress/repair/cycles read-only and removable; submitted using the new
   `{name, chip}` shape (mapping stays server-side, one source of truth).
   Scope reduction: presets are added as-is, no per-scenario editing of their
   chip conditions before adding (`ChipMapper`'s sliders per row would add
   real complexity for a "compare N profiles" feature whose core ask is the
   side-by-side view, not per-scenario tuning). Docs: `docs/API.md` "Compare"
   (chip-scenario shape + `/chip-presets`), `docs/MODEL.md` §6,
   `frontend/README.md` "Compare". Tests: `tests/test_chip_presets.py`,
   `tests/test_api_compare_chip.py`, chip-preset cases in `Compare.test.tsx`.
4. **Sub-population / sub-clone competition.** Multiple genetically
   distinct sub-populations competing for carrying-capacity slots within
   one simulation — an inner evolutionary layer distinct from the outer
   parameter-search loop. **DONE 2026-09-11** — `ModelConfig.subclones`
   (`SubcloneSpec`, `SUBCLONE_OVERRIDABLE_PARAMETERS = (shortening_rate,
   maintenance_rate, repair_rate, stress_sensitivity)`; `>= 2` uniquely-named
   clones, `initial_fraction`s summing to 1.0, bounds-checked overrides via
   the same `PARAMETER_BOUNDS`) splits the founding population by
   largest-remainder allocation and threads a `clone_id` array through
   `population.divide`/`remove_dead`/`passage` exactly like `founder_id`;
   `simulator/model.py` builds a small per-clone lookup for each overridable
   parameter once per `simulate()` call and indexes it by `clone_id` to get
   **per-cell** `deterministic_loss`/`max_gain` arrays instead of scalars —
   a small vectorised generalisation of the existing arithmetic, not a
   rewrite. Composition rule: `shortening_rate`/`stress_sensitivity`
   overrides simply replace the scalar (never schedulable); a
   `maintenance_rate`/`repair_rate` override means "this clone's own
   constant value, ignoring the shared schedule for that parameter" — a
   clone without that override still reads the shared scheduled/scalar
   value, so `subclones=None` (the single implicit default clone, no
   overrides) is **bit-identical** to the pre-subclone model
   (`tests/test_subclones.py`, golden-fixture regression shared with
   `tests/test_schedule.py`). `SimulationResult.clone_fraction[name]` records
   each clone's share of the living population per cycle. Deliberately
   **not** wired into the GA/NSGA-II/active-learner gene encodings — a
   Simulate-page exploratory lens, not a new optimizer gene space. Full
   spec: `docs/MODEL.md` §2.2; first real run:
   `docs/EXPERIMENT_PROTOCOL.md` Experiment F (a "resilient"
   higher-maintenance/repair clone displaces a "fragile" baseline clone
   almost completely within half the run at `configs/demo_subclone_competition.yaml`'s
   parameters — a clear, non-null result, not tuned to force that outcome).
   API: `backend/schemas.py::SubcloneSpec` types the `subclones` block's
   shape on every `ModelConfigBody` (semantics still validated by the core
   → `400`); `GET /api/meta/bounds` exposes `subclone_overridable`; the
   simulate/compare responses carry `clone_fraction`; ensemble and compare
   forward `subclones` transparently, verified rather than assumed
   (`tests/test_api_subclones.py`). React: a "Sub-clone competition" section
   on Simulate (`SubcloneEditor.tsx` + `subclonesUtils.ts`, mirroring
   `ScheduleEditor`'s toggle/add-row/bounded-input pattern) with a
   fraction-sum warning, and a stacked-area composition chart
   (`charts/subcloneCharts.ts`) plus a final-composition table on the
   results side — not added to Evolve/Pareto/Active Learning/Compare's
   scenario builders, matching the "distinct from the outer loop" scope.
   Docs: `docs/MODEL.md` §2.2, `docs/API.md`, `docs/SCIENTIFIC_SCOPE.md`,
   `frontend/README.md` "Sub-clone competition". Tests:
   `tests/test_subclones.py`, `tests/test_api_subclones.py`,
   `subclonesUtils.test.ts`, `SubcloneEditor.test.tsx`,
   `charts/subcloneCharts.test.ts`.
5. **Synthetic "biological age" biomarker score.** A single relatable
   demo-friendly number derived from the trajectory, with the same strict
   scope-language discipline as the rest of the project
   (`docs/SCIENTIFIC_SCOPE.md`). **DONE 2026-09-11** —
   `simulator/biomarker.py::biological_age_score` is a pure, deterministic,
   post-hoc function of an already-completed `SimulationResult` (no change
   to `simulator/model.py`'s per-cycle arithmetic, `population.py`,
   `evolution/`, or `analysis/`): a **0-100 "synthetic age index"** (0 =
   youthful reference, 100 = senescent/collapsed reference), computed at
   every recorded cycle (`BiologicalAgeScore.score_over_time`, same
   `(T+1,)` axis as `time`) as well as at the end (`final_score`), as the
   equal-weighted mean of three quantities the model already reports
   (`docs/MODEL.md` §4.1): a progressive proliferative-cell AUC (the same
   integrand `normalized_survival` integrates, reduces to that exact value
   at the last cycle), the shortest-telomere reserve (identical formula to
   `normalized_telomere_reserve`, every cycle instead of only the last),
   and the complement of `senescent_fraction`. An extinct culture saturates
   at 100 at every post-extinction cycle; an invalid result returns an
   explicitly-flagged empty/`valid=False` score, never a crash or `NaN`.
   Attached to `SimulationResult.biological_age` by `simulator/model.py`'s
   `_assemble`/`_failed_result` (a one-line post-hoc attachment, not new
   simulation mechanism) and exported by `to_json_dict()`. Deliberately
   **not** wired into the GA/NSGA-II/active-learner objective functions — a
   display/narrative number, not a new optimization target.
   API: `backend/schemas.py::BiologicalAgeScoreBody` types the field on
   `SimulationRunResponse` (so it flows through `/api/simulate` and
   `/api/compare` automatically); `POST /api/simulate/ensemble` adds a
   lighter per-seed `biological_age_final` (not a full per-seed series — a
   documented scope reduction, since that would be `n_seeds`x the payload
   for a figure the fan chart doesn't otherwise need); `/api/compare`
   needed no schema change since each scenario's `result` is already a full
   run. React: `components/BiologicalAgeGauge.tsx` (a big number + a plain
   CSS gauge, no new chart dependency) mounted prominently on Simulate
   right after the terminal-metrics row, plus an optional
   `score_over_time` line trace (`charts/biologicalAgeCharts.ts`); the
   ensemble summary table gained a "Synthetic age index" min/mean/max/std
   row; Compare gained a per-scenario "synthetic age index" column. Not
   added to Evolve/Pareto/Active Learning/Sensitivity (no optimizer-facing
   surface for a display number). **Mandatory, verified UI copy
   discipline**: every place the score renders also renders the exact same
   disclaimer string
   (`components/biologicalAgeUtils.ts::BIOLOGICAL_AGE_DISCLAIMER`, in the
   `docs/SCIENTIFIC_SCOPE.md` register) in the same viewport — asserted by
   Vitest, not just eyeballed. Docs: `docs/MODEL.md` §4.1,
   `docs/SCIENTIFIC_SCOPE.md` ("Synthetic 'biological age' biomarker
   score" + a language-policy example pair), `docs/API.md`,
   `frontend/README.md`. Tests: `tests/test_biological_age.py` (12),
   `tests/test_api_biological_age.py` (4) — pytest 251 total; `Vitest`
   125 total (`BiologicalAgeGauge.test.tsx` + assertions added to
   `Simulate.test.tsx`, `Compare.test.tsx`, `EnsembleSummaryTable.test.ts`).

   **This completes all five originally-ranked candidate simulation
   features from the 2026-09-09 brainstorm above** (scheduled protocols,
   ensemble/uncertainty, multi-chip comparison, sub-clone competition,
   synthetic biological-age score) — a genuine milestone; a future session
   should not re-propose any of items 1-5 as new work. Possible future
   ideas (not yet prioritized, not part of the ranked list above): a
   literature-calibrated variant of the age-index weights; surfacing
   `score_over_time` on the particle canvas itself (colour-coded by age
   band) instead of only as a separate line chart.

## LLM agentic layer (decided 2026-09-09, two layers, both approved)

The SDD originally scoped an LLM layer as out-of-scope for the hackathon
MVP. Now that this is an ongoing project, it's back in scope, deliberately
split into two layers of increasing ambition/risk. **Bring-your-own-key**:
the user supplies their own LLM API key (Anthropic first, others later);
the app never bears LLM cost and the key is **session-only, never
persisted to the database** — same non-persistent-credential posture as
the existing login system.

### Layer 1 — Results interpreter — **DONE 2026-09-11**

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

Shipped as: `backend/llm.py` + `backend/routers/llm.py`
(`POST /api/llm/interpret`, `POST /api/llm/validate-key`,
`GET /api/meta/llm`), BYOK via the official `anthropic` Python SDK
(`anthropic.Anthropic(api_key=...)` per request, `claude-opus-5` default,
`claude-sonnet-5`/`claude-haiku-4-5` selectable, adaptive thinking,
`output_config.effort`). The key lives in the browser's `sessionStorage`
only and is never logged/persisted/ledgered; a small in-memory per-user
rate limit (10 calls / 10 min) caps exposure. `frontend/src/components/
InterpretPanel.tsx` is mounted on the Experiments detail view and the
completed-result section of Evolve/Pareto/Sensitivity/Active Learning.

### Layer 2 — Protocol-designing agent (build after roadmap item #1 above)

Depends on the time-varying/scheduled-protocol simulation feature
(candidate feature #1 above) existing first — Layer 2 needs a "schedule"
concept to propose into. That concept now exists end to end
(`InterventionSchedule` in the core, `schedule` on every API config body,
the Simulate `ScheduleEditor` — all 2026-09-10), so a proposed protocol can
be shown and edited in the UI. The LLM is given a constrained tool: it may
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
- `--resume` CLI flag for checkpointed evolution runs. **DONE 2026-09-12** —
  `EvolutionEngine.from_checkpoint()` + `scripts/run_evolution.py --resume`.
- Multiprocessing for parallel fitness evaluation.
- Combining with the unrelated `Baby_Monster` project (evolutionary-RL
  cognitive-architecture research, PyTorch/notebook-driven, entirely
  different compute profile and maturity stage) into one app — decided
  2026-09-09 to keep fully separate. A lightweight shared "portal" linking
  out to both independent apps was floated as a much later, optional idea
  if the "private lab" framing is wanted — not planned yet.
