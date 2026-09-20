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
   ideas (not yet prioritized, not part of the ranked list above), both
   resolved 2026-09-12:
   - A literature-calibrated variant of the age-index weights —
     **checked, not changed**: the classic Frailty Index (the most
     widely used real biological-age composite) is itself unweighted by
     definition, so equal weighting mirrors that convention; literature
     weighting schemes that outperform it are regression-fit against a
     real outcome (mortality/decline) this simulator's internal
     quantities have no counterpart of, so a "calibrated" reweighting
     isn't buildable without a fabricated target
     (`simulator/biomarker.py`, `docs/MODEL.md` §4.1).
   - Surfacing `score_over_time` on the particle canvas itself (colour-
     coded by age band) instead of only as a separate line chart —
     **DONE**: the dish now has an emerald→amber→rose ring driven by the
     current frame's synthetic age index (`ageBandColor` in
     `populationFrames.ts`), alongside the existing per-particle
     proliferative/senescent colouring, plus a numeric readout; null
     (no ring colour claim) for ensemble seed views and any run recorded
     before this field existed.

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

### Layer 2 — Protocol-designing agent — **DONE 2026-09-12**

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
**2026-09-12 update**: this motif is no longer purely hypothetical —
Experiment G (`docs/EXPERIMENT_PROTOCOL.md` §12) found a real, mechanistic
case where a repair schedule synced to an intermittent stress rhythm beats
a constant response to the same rhythm, shipped as the
`demo_fasting_evolved` preset. A Layer-2 agent proposing "repair boost
during a fasting-like phase" would now be proposing something this
codebase has independently verified can help, not just a plausible-sounding
guess — still gated on the same safety boundary below (every proposal goes
through the same `validate()` every other config does).

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

Additional guardrails designed in: rate-limit/cap how many proposals an
agentic session can queue per run (cost control on the user's own key), log
every LLM-proposed config in the experiment ledger tagged with its
provenance (so "AI-proposed" vs "human-typed" vs "GA-evolved" configs stay
distinguishable in `docs/EXPERIMENT_PROTOCOL.md` write-ups), and give the
user a review/approve step before an LLM-proposed protocol actually runs (no
fully autonomous unattended agent loop for v1).

**Shipped as**: `backend/llm.py::propose_protocol()` +
`POST /api/llm/propose-protocol` (`backend/routers/llm.py`, docs/API.md),
same BYOK/session-only-key posture as Layer 1. The model gets a *forced*
Anthropic tool call (`propose_protocol`: `rationale`, `phases` (1-8), one
`stress_level`/`maintenance_rate`/`repair_rate` array per phase) rather than
free-text parsing, so there is no ambiguity about what it can and cannot
change — every other field of the caller's current config is fixed and
never touched. The system prompt quotes the model's own core equation and
cites Experiments E and G by name so proposals are literature-of-this-
codebase-informed, not blind guesses. Every returned config has already
been run through `ModelConfig.from_dict(...).validate()` server-side; a
malformed or out-of-range tool call comes back as `422 llm_proposal_invalid`
and is never handed to the frontend as runnable. The frontend
(`frontend/src/components/ProtocolProposer.tsx`, mounted on Simulate next to
`ScheduleEditor`) treats a proposal exactly like a named YAML preset — it
loads the config into the form for review/editing, and the human still has
to press "Run simulation" themselves; the component never calls
`/api/simulate`. A run started from a loaded proposal can be tagged via
`SimulateRequest.provenance` (new field, defaults to the old hardcoded
`"via API"` when omitted) so the ledger keeps AI-proposed runs
distinguishable, per the guardrail above. Separate rate-limit budget from
Layer 1 (`propose_rate_limiter`, same 10/10 min default).

Verified: 275 backend tests (14 new: happy path incl. constant/phases=1
proposals, malformed tool-call shapes rejected as 422 rather than crashing,
every Layer-1-style error mapping, its own rate-limit budget, and the
provenance tag round-tripping through the real ledger), 159 frontend tests
(6 new), and a live check against the real (network-restricted in this
environment) Anthropic API confirming the full request pipeline end to end
— the "Validate key" button reaches our backend, which genuinely attempts
the Anthropic call and maps the resulting connection error to a friendly
502 message, exactly as the unit tests predict for that failure mode.

## Genome stability: mutation burden and apoptosis checkpoint (brainstormed 2026-09-13, DONE 2026-09-13)

Following the decision to drop Baby_Monster (a fully separate PyTorch/RL
cognitive-architecture project) from this roadmap entirely, and to keep
expanding the genome-focused research direction *inside* Telomere Lab rather
than spinning up a second app, this is the first of several
brainstormed "genome-basis" ideas — chosen because it plugs directly into
the existing evolutionary-computation paradigm (new evolvable parameters, a
6th fitness objective) with no new infrastructure, and follows the exact
architectural precedent already proven twice (schedules §2.1, sub-clone
competition §2.2): additive, off-by-default, zero new API/router plumbing,
proven by a golden-fixture bit-identity test.

**DONE 2026-09-13** — a per-cell **mutation burden** accumulator
(`ModelConfig.replication_error_rate` / `oxidative_mutation_sensitivity`,
both default `0.0`) grows on every division, offset by the existing
`repair_rate`; an optional **apoptosis checkpoint**
(`ModelConfig.checkpoint_strength`, default `0.0` — the feature's actual off
switch; `mutation_threshold`, a `1.0e9` sentinel default) removes flagged
cells with a per-cycle probability, mirroring `remove_dead`'s exact shape
(`simulator/population.py::remove_apoptotic`). All four fields are
evolvable; none are schedulable or sub-clone-overridable in this version
(explicitly deferred below). New outputs `mean_mutation_burden` /
`apoptotic_fraction` (per-cycle timeseries) and `final_mutation_burden` /
`genomic_instability_index` (terminal metrics); a 6th, inert-by-default
fitness term (`w_genome_instability = 0.0`) and multi-objective
`genome_instability` objective. **Zero backend/router schema changes** were
needed — confirmed by writing `tests/test_api_genome_stability.py` against
the real API before touching `backend/` at all, exactly as the "additive,
generic-passthrough" architecture predicts. React: a "Genome stability
(optional)" `<details>` block of plain `bounded()` sliders in
`ModelConfigForm.tsx` (no dedicated editor component — these are scalar
fields, not array-of-struct data like sub-clones/schedules), a new
mutation-burden line chart (`charts/genomeStabilityCharts.ts`), and a
results section on Simulate gated on the feature actually being in use.
Full spec: `docs/MODEL.md` §2.3. Tests: `tests/test_genome_stability.py`,
`tests/test_api_genome_stability.py` (pytest all green, including the
golden-fixture bit-identity proof), Vitest all green (159, incl. a
Sensitivity-page fixture update for the 4 newly-evolvable parameters).

Other genome-basis ideas from the same brainstorm (Genome Stability Lab
picked first as the cheapest/lowest-risk/most-scientifically-grounded step):
a genotype × environment (G×E) study reusing sub-clones as genotypes
(**DONE 2026-09-13**, see below), a canalization/robustness fitness
objective (**DONE 2026-09-13**, see below), upgrading sub-clones toward a
population-genetics-style model (**DONE 2026-09-13**, see below), grounding
parameter choices in real GWAS-variant effect sizes (**DONE 2026-09-13**,
see below), and a genome-dimensionality scaling study (**DONE 2026-09-14**,
see below). A "Genome Function Explorer" concept (predicted functional
impact of a config) was flagged as carrying more scientific-honesty/
overclaim risk and is not prioritized. **This completes every genome-basis
idea from the 2026-09-13 brainstorm except the deliberately-not-prioritized
one.**

### Per-cell heritable repair_rate (population-genetics-style) (DONE 2026-09-13)

`repair_rate` can now be a genuinely per-CELL continuous trait instead of a
clone-shared scalar: a new `repair_rate_mutation_sigma` field (0.0 default,
the feature's off switch) makes each cell track its own `repair_rate`,
seeded from its sub-clone's starting value at cycle 0, mutating by a small
Gaussian step (clipped to `PARAMETER_BOUNDS["repair_rate"]`) at every
division and inherited by daughters — mutation-selection balance on a
heritable trait, the population-genetics-style model this roadmap item
asked for. Mirrors exactly how `mutation_burden` was added as a new
per-cell array in the Genome Stability feature above, including its
discipline (default-inert, golden-fixture bit-identity proof unaffected).

The one real design decision: `repair_rate` already had three overlapping
identities (scalar field, `SCHEDULABLE_PARAMETERS` time schedule,
`SUBCLONE_OVERRIDABLE_PARAMETERS` per-clone override). Rather than trying to
reconcile per-cell drift with a population-wide time schedule, the two are
made mutually exclusive (`ModelConfig.validate()` raises `ConfigError` if
both are set); a sub-clone override still applies, now as the per-cell
trait's *initial condition* per clone rather than a value re-applied every
cycle. GA evolution, sensitivity sweeps, G×E, the chip adapter and the LLM
protocol proposer are all unaffected — they keep treating `repair_rate` as
the scalar "seed"/nominal value, since none of them opt into
`repair_rate_mutation_sigma > 0` by default.

Full spec: `docs/MODEL.md` §2.2. Tests: `tests/test_repair_rate_drift.py`
(pytest all green, including its own golden-fixture bit-identity proof),
Vitest all green (176), `npx tsc -b --force` and lint clean.

### GWAS-variant effect-size calibration check (DONE 2026-09-13)

Same discipline as the existing literature calibration (§3.1, ROADMAP
"Explicitly deferred" section, resolved 2026-09-12): a calibration *check*
against real human telomere-length GWAS studies, not a parameter re-fit.
Retrieved via general web search (Consensus.app not used this round).

Checked `initial_length_sd` (founder-population spread) against twin-based
broad-sense heritability of leukocyte telomere length (Broer et al. 2013,
h² ≈ 0.70) and against the largest GWAS to date (Codd et al. 2021, UK
Biobank n=472,174, 138 loci / 197 variants, only 8.1% common-SNP
heritability and ~5.6% polygenic-score variance explained — a large gap vs.
the twin estimate, the classic telomere-length "missing heritability").
Decomposing the existing 800 bp phenotypic-variance anchor (Sabharwal et
al. 2018, already used in §3.1) by the 0.70 heritability figure gives an
implied genetic-component SD of ≈669 bp and environmental ≈438 bp — the
current default sits at a consistent order of magnitude between the two.
Checked `repair_rate`/`repair_rate_mutation_sigma` against DNA-repair-locus
GWAS hits (`RTEL1`, `PARP1`, `TERT`), which report effect sizes as
disease-risk odds ratios or T/S-ratio shifts, never a repair-*rate*
quantity comparable to this model's unitless 0–1 knob, and against the fact
that GWAS/heritability measure germline inter-individual variation while
`repair_rate_mutation_sigma` is a somatic per-division drift step within
one lineage — not the same biological quantity even in principle.

**Outcome, same as §3.1: no defaults changed.** The one actionable finding
is a documented simplification, not a numeric correction — `initial_length_sd`
conflates genetic and environmental variance sources into a single
founder-spread number, which this single-generation, non-pedigreed model
has no mechanism to decompose (new `docs/MODEL.md` §7 bullet). Full spec:
`docs/MODEL.md` §3.2 (new subsection, mirrors §3.1's table format) and §9
References ("GWAS telomere-length calibration"). No code changes — this
was a documentation-only exercise, consistent with §3.1's own outcome.

### Genome-dimensionality scaling study (DONE 2026-09-14)

Disambiguated with the account owner first: this is about the **optimizer's
search-space dimensionality** (`evolution/genome.py`'s chromosome encoding —
GA/NSGA-II/active-learner "genome"), not a new biological genome-complexity
mechanism. Reused the existing budget-matched benchmark machinery
(`evolution/benchmark.py`, already built for `scripts/benchmark_optimizers.py`)
unmodified, at a sweep of 7 genome sizes (3 → 31 genes, via
`EVOLVABLE_PARAMETERS` prefix subsets and `schedule_phases` expansion) instead
of one fixed size — **zero new optimizer/simulator code**, only a new sweep
script, `scripts/benchmark_dimensionality.py`.

Genuinely surprising result, reported as found rather than as originally
hypothesized (a priori expectation was that GP-based active learning would
degrade faster in high dimensions — the general ML-literature expectation):
GA turned out to be the **less** robust method under a fixed small budget
(144 simulator calls/cell) — its variance more than doubled once
`schedule_phases` expansion pushed the gene count past 10, while active
learning (GP-EI) stayed the lowest-variance method at every dimensionality
level tested and random search stayed a flat, dimension-agnostic floor.
Equally important: plain gene-count growth (3→10 independent scalar genes)
and schedule-phase-driven growth (10→31 correlated per-phase genes) behave
completely differently — only the latter showed any degradation at all,
for any method.

Full spec: `docs/EXPERIMENT_PROTOCOL.md` §15, Experiment J. Report:
`experiments/reports/benchmark_dimensionality.{json,csv}` (63 cells, 3
seeds each, 9,072 total simulator calls). No production code changes —
`scripts/benchmark_dimensionality.py` is a new analysis script built
entirely on existing, untouched `evolution/benchmark.py` functions.

### Healthy-vs-damaged clones + toy Genome Explorer (DONE 2026-09-20)

Tier 1: `configs/demo_healthy_vs_damaged.yaml` (also a one-click preset on
Simulate) and Experiment K (`docs/EXPERIMENT_PROTOCOL.md` §15.1): a
checkpoint-deficient clone displaces a healthy one, with symmetric neutral
controls. Tier 2: `telomere_lab.sequence` + `/api/sequence/*` + the Genome
Explorer page (`/genome`): real genetic code, *synthetic* genes, mutation
classification and normal-vs-damaged lineages (`docs/MODEL.md` §2.4). Both are
labelled toy / model mechanisms in `docs/SCIENTIFIC_SCOPE.md`.

### 3D telomere cell view (DONE 2026-09-20)

Simulate has a lazy-loaded "Show 3D telomere view" (three.js, ~145 kB gzip, only
fetched on click): chromosomes with telomere caps whose length and colour follow
the run's per-cycle statistics (teal -> amber -> red as the shortest end nears
the senescence limit; grey body and fusion bridges once senescent). The
"representative cell" is reconstructed from summary statistics (lengths spread
evenly around the mean, shortest end = mean shortest-per-cell), so it is an
illustration, not a measured single cell; chromosome shapes are stylised.
Code: `frontend/src/components/{telomereCell.ts,TelomereCell3D.tsx}`.

### Canalization / robustness fitness objective (DONE 2026-09-13)

A new `canalization` fitness term measuring consistency of a genotype's
`survival` outcome across its `eval_seeds` replicate simulations —
deliberately narrow: stochastic robustness only, not environmental
robustness (the G×E study above already covers that) or structural
parameter robustness (Sensitivity already covers that). Formula: the
coefficient of variation of `survival` across replicates, scaled the same
way `instability` already is (`CANALIZATION_CV_SCALE = 0.5`, chosen after
running real simulations across safe/small-population/near-extinction
configs to confirm the scale actually discriminates rather than
degenerating to always-1.0). Direction is "max" — unlike every other
optional term shipped so far, it is *added* to `total`, not subtracted.

Architecturally the one subtlety: canalization is a property of a
*replicate set*, not a single simulation, so it's computed in
`evolution/fitness.py::average_breakdowns` (which gained a required
`weights` parameter) rather than `compute_fitness` — threaded through all
7 call sites that average replicate fitness (GA engine ×2, NSGA-II,
benchmark, surrogate active-learner, Sensitivity, G×E). `w_canalization`
defaults to `0.0` (inert). Also fixed two pre-existing staleness bugs found
while touching this code: `FitnessWeights`'s own docstring was never
updated when `w_genome_instability` shipped, and neither the Evolve page's
weight-slider list nor the Simulate page's fitness-breakdown bar chart ever
got a `genome_instability` entry — both fixed in the same pass as adding
`canalization`.

Full spec: `docs/MODEL.md` §5 / §5.1, `docs/SCIENTIFIC_SCOPE.md`. Tests:
new `tests/test_fitness.py` (no direct unit tests of `average_breakdowns`
existed before this), plus the full regression suite for every optimizer/
analysis path that shares `average_breakdowns` (`test_evolution.py`,
`test_engine_best/parallel/resume.py`, `test_multiobjective.py`,
`test_sensitivity.py`, `test_gxe_study.py`, `test_benchmark_optimizers.py`,
`test_surrogate.py`, `test_genome_stability.py`) confirmed still green.

### Genotype × Environment (G×E) study (DONE 2026-09-13)

Shipped as a new page (`/gxe`) + async job (`POST /api/gxe`), not as an
additive field on an existing page — unlike Genome Stability, this needed
new infrastructure (a new job kind, a new core analysis module, a new
router), the same shape as Sensitivity rather than the "off-by-default
`ModelConfig` field" pattern. Each genotype (`GenotypeSpec` — a named
`SUBCLONE_OVERRIDABLE_PARAMETERS` override bundle) is run against every
environment (`EnvironmentSpec` — a named `stress_level` override) as an
**isolated** simulation, averaged over `eval_seeds`, and the result flags
any genotype pair whose fitness ordering flips between environments
(`reranking_pairs`) — a reaction-norm chart (`gxeCharts.ts`) plots one line
per genotype across environments so a crossing is visible directly.

**Decided against**: running genotypes as competing `ModelConfig.subclones`
in one shared population per environment (reusing the sub-clone competition
engine as-is). That measures frequency-dependent competitive dynamics
(who out-competes whom when both are present at once), not classical G×E
interaction (how does each genotype's own fitness change across
environments) — the two are genuinely different questions, and the roadmap
brainstorm's own framing ("genotype re-ranking... between environments") is
squarely the reaction-norm one. `docs/MODEL.md` §2.2 carries the
cross-reference explaining this explicitly so it isn't re-proposed later.

Full spec: `docs/API.md`'s G×E section, `docs/MODEL.md` §2.2's
cross-reference. Tests: `tests/test_gxe_study.py` (core, including a
monkeypatched deterministic-crossover fixture — real simulator dynamics
don't reliably produce a large, seed-robust crossover between two hand-
picked genotypes, so the reranking-*logic* is tested directly rather than
hoping a tuned example happens to cross), `tests/test_api_gxe.py` (job
lifecycle, 400/422 split, ledger registration). Frontend:
`gxeCharts.test.ts`, `overrideListUtils.test.ts`, `GxE.test.tsx`. Verified
live end-to-end against the real API (job runs, live progress, chart,
ledger entry with `kind="gxe"`).

While building this, also fixed a verification gap left over from Genome
Stability: this repo's `tsconfig.json` is a solution-style file (`files: []`,
project references only), so `tsc --noEmit -p .` silently does nothing
without `--build` — the real check is `tsc -b` (what `npm run build` and CI
actually run). Two stale test fixtures from Genome Stability (missing the
new `mean_mutation_burden`/`apoptotic_fraction`/`genome_instability` fields)
had slipped past the earlier "typecheck clean" claim as a result; fixed
alongside this feature.

## Explicitly deferred / out of scope for now

- Literature calibration of default parameters (needs real citation work,
  not just coding). **DONE 2026-09-12** — `docs/MODEL.md` §3.1, checked via
  Consensus.app against real papers (Allsopp 1992, Levy 1992, Saretzki 1995,
  Karlseder 2002, Cristofari & Lingner 2006, and others); no defaults
  changed, all were already inside or close to the literature ranges found.
- Organ-on-chip coefficient calibration against physical chip data.
  **DONE 2026-09-12** — `docs/MODEL.md` §6.1, checked via web search
  (Consensus.app quota exhausted mid-session, so this one used general web
  search instead). The weighting coefficients themselves aren't checkable
  (they map to this model's own unitless `stress_level`/`repair_rate`
  abstractions, not a measured physical quantity), but the two anchors that
  are — oxygen tension and doubling time — were checked: oxygen tensions
  hold up well (liver ~6% O2 matches `liver_chip_like` almost exactly); the
  single global `ASSUMED_DOUBLING_TIME_DAYS=1.0` did not — it fit
  fibroblast-like presets but was 4-6x too fast for `liver_chip_like` and
  similarly off for `gut_chip_like`. **Follow-up fix, same day** —
  `ChipConditions.doubling_time_days` (default 1.0) lets each preset set its
  own literature-checked value instead of sharing one constant:
  `liver_chip_like` 4.5 days, `gut_chip_like` 8.0 days, `lung_chip_like`
  2.0 days, `static_well`/`injury_stress_chip_like` stay at 1.0
  (fibroblast-like). Changes the derived `cycles` for the three organ-like
  presets relative to any run made before 2026-09-12 — a deliberate,
  documented behavior change (`docs/MODEL.md` §6.1).
- GitHub Actions CI. **DONE 2026-09-12** — `.github/workflows/ci.yml` runs
  backend pytest + frontend typecheck/lint/vitest/build on every push/PR to
  master.
- Kaggle notebook submission packaging. **Decided against, 2026-09-12** —
  this item dates back to the project's hackathon-submission origins, but
  the app has since grown into a full-stack FastAPI + React + Postgres
  service deployed on Railway (see "Status" at the top of this file); a
  Jupyter-notebook repackaging doesn't fit that architecture and would mean
  maintaining a second, degraded copy of the science (no web UI, no DB, no
  live deployment) purely for a submission format this project no longer
  targets. Not revisited unless a future Kaggle-specific submission is
  explicitly requested.
- An in-GUI "Assumptions" page rendering `docs/MODEL.md` equations.
  **DONE 2026-09-12, via an existing feature** — the Docs page
  (`frontend/src/pages/Docs`, `/guide?doc=model`, built 2026-09-11 for a
  different request) already renders the complete `docs/MODEL.md` in-app,
  equations included, with a working table of contents. Building a separate
  "Assumptions" page would duplicate this content, so this item is
  satisfied by cross-reference rather than new code.
- 3-objective Pareto front for the locked-stress scenario (NSGA-II engine
  already supports 3 objectives, just never run for this scenario).
  **DONE 2026-09-12** — `configs/pareto_locked_3obj.yaml`
  (`objectives: [survival, reserve, cost]`), run `TEL-20260912-002`
  (`docs/EXPERIMENT_PROTOCOL.md` Experiment H). Confirmed Experiment C's own
  prediction directly: the GA's point that was dominated on the 2-objective
  (survival, cost) front is **not dominated by any of the 40 points** on
  the 3-objective front — verified by re-evaluating the exact GA genome and
  checking it against every front point, not just visually. No code
  changes needed (frontend already supports N-objective fronts by using
  objective 3+ as a colour dimension; `hypervolume_2d()` correctly reports
  0.0 for 3 objectives rather than a wrong number, a known, documented
  limitation of that specific metric, not of the search itself).
- `--resume` CLI flag for checkpointed evolution runs. **DONE 2026-09-12** —
  `EvolutionEngine.from_checkpoint()` + `scripts/run_evolution.py --resume`.
- Multiprocessing for parallel fitness evaluation. **DONE 2026-09-12** —
  `EvolutionEngine(..., n_workers=N)` evaluates a generation's genomes across
  a reused `ProcessPoolExecutor`; opt-in only (default `n_workers=1` is the
  unchanged serial path), bit-for-bit identical trajectory to serial since
  the RNG only ever runs in the main process. `scripts/run_evolution.py
  --workers N`.
- Sub-clone × genome-stability composition (docs/MODEL.md §2.3): a clone
  overriding its own `replication_error_rate` / `oxidative_mutation_sensitivity`
  / `checkpoint_strength` / `mutation_threshold`. **DONE 2026-09-14** — all
  four added to `SUBCLONE_OVERRIDABLE_PARAMETERS`. The two that only apply
  at division (`replication_error_rate`, `oxidative_mutation_sensitivity`)
  are looked up exactly like `shortening_rate`/`stress_sensitivity` already
  were (a per-clone constant array indexed by the dividing cells' clones);
  the two that gate the apoptosis checkpoint against *every living cell*
  each cycle (`checkpoint_strength`, `mutation_threshold`) needed a new
  full-population lookup shape (`checkpoint_strength_c[clone_id]` /
  `mutation_threshold_c[clone_id]`), which required
  `simulator/population.py::remove_apoptotic` to accept a per-cell array in
  addition to its original scalar — the trickiest part of this change, since
  it also had to preserve the exact "no RNG draw when the feature is off"
  discipline the golden-fixture bit-identity test depends on
  (`not np.any(checkpoint_strength > 0)` replaces the old `checkpoint_strength
  <= 0` scalar guard). `SimulationResult.terminal_metrics
  ["genomic_instability_index"]` was also updated to compare each surviving
  cell against its *own* clone's threshold rather than the shared scalar.
  Zero backend router or frontend changes needed — `bounds.subclone_overridable`
  (`GET /api/meta/bounds`) and `SubcloneEditor.tsx` are both already fully
  dynamic off `SUBCLONE_OVERRIDABLE_PARAMETERS`, the same "additive,
  generic-passthrough" pattern every sub-clone/schedule/genome-stability
  feature before it has followed; only `frontend/src/test/fixtures.ts`'s
  hardcoded mirror of the bounds response needed updating. Full spec:
  `docs/MODEL.md` §2.2 "Composition with genome stability". Tests: 4 new
  cases in `tests/test_subclones.py` (differential mutation-burden growth,
  differential apoptotic removal, per-clone `genomic_instability_index`, and
  bit-identity when unused) — 313 pytest total, 176 Vitest total, `npx tsc -b
  --force` and lint clean.
