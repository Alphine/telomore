# EXPERIMENT_PROTOCOL.md — Baseline vs. evolved (reproducible)

All numbers below come from actual runs recorded in the experiment
registry on the developer laptop. They are **model outputs** under the
stated objective and assumptions (see `SCIENTIFIC_SCOPE.md`).

## 1. Question

Starting from a *stressed culture* baseline whose telomere reserve
collapses within the run window, can an evolutionary search over three
culture-condition parameters (`stress_level`, `maintenance_rate`,
`repair_rate`) find a configuration that optimises the stated objective —
and does it exploit an interpretable trade-off rather than maxing every
knob?

## 2. Setup

| Item | Value |
|---|---|
| Config file | `configs/evolution.yaml` |
| Command | `python scripts/run_evolution.py --config configs/evolution.yaml --seed 7` |
| Model version | 0.1.0 (`docs/MODEL.md`) |
| Optimizer version | 0.1.0 (GA: tournament-3, 10 % elites, uniform crossover 0.7, Gaussian mutation rate 0.3 / σ 0.15 normalised) |
| GA population × generations | 32 × 20 |
| Optimizer seed | 7 |
| Simulator seed per candidate | 42 (common random numbers across candidates) |
| Free genes | `stress_level` ∈ [0,1], `maintenance_rate` ∈ [0,1], `repair_rate` ∈ [0,1] |
| Fixed | initial length 7.5 kb (SD 0.8), shortening 55 bp/cycle, stress sensitivity 100 bp, max maintenance gain 120 bp, threshold 3.0 kb, noise 30 bp, 100 → cap 400 cells, 32 telomeres/cell, 120 cycles |
| Baseline genes | stress 0.60, maintenance 0.10, repair 0.15 |
| Objective weights | survival 0.40, reserve 0.30, senescence 0.20, instability 0.10, cost 0.30 (cost = ½(maint² + repair²)) |

Environment: Windows 11, AMD64 (AMD family 25), Python 3.13.15,
NumPy 2.3.4; no GPU. Git commit: none at time of run (repository
initialised, first commit pending — the ledger records `null`).

Multi-seed fitness averaging (`eval_seeds`) is now the schema default
(`docs/MODEL.md`) to reduce stochastic noise per candidate; Experiments
A, B and C below were all recorded with a single simulator seed (42) for
reproducibility transparency, so re-running the same config files today
searches with multi-seed fitness and will not reproduce these exact numbers.

## 3. Experiment A — Result of run `TEL-20260907-001`

Ledger: `experiments/runs/TEL-20260907-001/record.json`
(configuration hash `13acb39edebe0bbb`, 404 simulations, 70.7 s wall-clock).

### Fitness by generation (best candidate)

| Generation | 0 | 1 | 2 | 3 | 5 | 10 | 13 | 20 |
|---|---|---|---|---|---|---|---|---|
| Best fitness | 0.546 | 0.606 | 0.617 | 0.618 | 0.623 | 0.625 | 0.625 | 0.625 |

Baseline (the un-evolved configuration): **−0.134**. Generation 0 already
contains random candidates, hence its best is above baseline.

### Best candidate vs. baseline (simulator seed 42)

| Quantity | Baseline | Evolved | Δ |
|---|---|---|---|
| `stress_level` | 0.60 | **0.000** | −0.60 |
| `maintenance_rate` | 0.10 | **0.654** | +0.554 |
| `repair_rate` | 0.15 | **0.000** | −0.15 |
| Fitness | −0.134 | **+0.625** | +0.759 |
| Final senescent fraction | 100 % | 0 % | −100 pp |
| Cycles to 50 % senescent | 35 | not reached (>120) | — |
| Mean shortest telomere / cell (final) | 2.94 kb | 7.53 kb | +4.59 kb |
| Final mean length | 3.92 kb | 7.70 kb | +3.78 kb |
| Normalised survival (AUC) | 0.265 | 0.993 | +0.728 |
| Final living cells (cap 400) | 33 | 400 | +367 |
| Intervention cost term | 0.016 | 0.214 | +0.198 |

### Robustness across simulator seeds (seeds 1–5, not used in the search)

| Scenario | Mean fitness | SD |
|---|---|---|
| Baseline | −0.130 | 0.004 |
| Evolved | +0.626 | 0.001 |

The improvement is not an artefact of the single training seed.

## 4. Interpretation (within the model)

* The optimiser drove `stress_level` to its floor (reducing stress is
  free under the default weights) and `repair_rate` to zero (repair only
  acts on stress-induced loss, so once stress is 0 it is pure cost).
* `maintenance_rate` settled at **≈ 0.65, not 1.0**. With no stress the
  replication loss is 55 bp/cycle and the maximal gain is 120 bp/cycle on
  the shortest telomere, so ≈ 0.46 offsets loss and a little more rebuilds
  reserve; beyond that the reserve term is saturated and the convex cost
  dominates. The search found "just enough maintenance", which is the
  intended demonstration of an interpretable trade-off.
* Fitness plateaued after generation 13; diversity fell from 0.28 to
  ≈ 0.05 (normalised gene SD) — the population converged.

## 5. Negative result worth recording

Two earlier iterations of this exact protocol (same seeds) converged to a
corner solution (`maintenance_rate = 1.0`):

1. with a **linear** cost term ½(maint + repair) and weight 0.20, and
2. after making the cost convex, still with the original saturation factor
   `1 − L / (2 L₀)`, which removed ~45 % of the maintenance gain at 7 kb so
   only maximal maintenance could offset shortening.

Both runs were deleted from the ledger because the objective/model they
used is no longer the shipped one; the fix is documented in
`MODEL.md` §2 and §5. This is exactly the kind of assumption-sensitivity
the tool is meant to make visible.

## 6. Reproduce

```bash
pip install -e ".[dev]"
python -m pytest                                                    # 41+ tests
python scripts/run_evolution.py --config configs/evolution.yaml --seed 7
python scripts/run_pareto.py     --config configs/pareto.yaml --seed 7
python scripts/run_evolution.py --config configs/evolution_locked.yaml --seed 7
python scripts/run_pareto.py     --config configs/pareto_locked.yaml --seed 7
python scripts/run_protocol_experiment.py --seed 7                  # Experiment E (§10)
```

Expected: `best fitness +0.6254`, best genome
`{stress_level: 0.0, maintenance_rate: 0.654, repair_rate: 0.0}`,
registered as the next `TEL-<date>-NNN`. Bit-identical fitness history is
expected on the same NumPy major version; tiny last-digit differences may
appear across BLAS builds.

To view interactively: start the app (`uvicorn backend.main:app` with a
built frontend, see `README.md`) → `/evolve` (defaults match this protocol)
→ `/compare` → `/experiments`.

## 7. Experiment B — Pareto front with NSGA-II (run `TEL-20260907-005`)

### Question

The GA answer above depends on five weights. What does the model permit if
we drop the weights and ask directly for the **trade-off between survival
and intervention cost**?

### Setup

| Item | Value |
|---|---|
| Config / command | `configs/pareto.yaml` · `python scripts/run_pareto.py --config configs/pareto.yaml --seed 7` |
| Algorithm | NSGA-II (`docs/MODEL.md` §5.1), population 40, 25 generations, seed 7 |
| Objectives | maximise `survival`, minimise `cost` = ½(maint² + repair²) |
| Baseline, fixed genes, free genes, simulator seed | identical to Experiment A |
| Ledger | config hash `10bace2d929453db`, 632 simulations, 81.7 s |

### Result

| Generation | 0 | 1 | 3 | 5 | 10 | 15 | 20 | 25 |
|---|---|---|---|---|---|---|---|---|
| Front size | 5 | 5 | 10 | 12 | 26 | 35 | 40 | 40 |
| 2-D hypervolume | 0.940 | 0.952 | 0.971 | 0.978 | 0.983 | 0.984 | 0.984 | 0.984 |

Final front: **40 unique non-dominated candidates**, every one with
`stress_level = 0` and `repair_rate ≤ 0.044`, spanning
`maintenance_rate` 0.000 → 0.361:

| Point on the front | survival | cost | maintenance | scalar fitness (ref.) |
|---|---|---|---|---|
| cheapest | 0.468 | 0.000 | 0.000 | −0.049 |
| knee (max distance from the chord) | 0.961 | 0.033 | 0.258 | +0.253 |
| highest survival | 0.993 | 0.065 | 0.361 | +0.412 |
| baseline (not on front) | 0.265 | 0.016 | 0.10 (stress 0.6) | −0.134 |

### Interpretation (within the model)

* Survival **saturates at maintenance ≈ 0.35**: beyond that no extra
  proliferative-cell AUC is available in a 120-cycle window, only cost.
* The GA's single answer (maintenance 0.654, Experiment A) is therefore
  **not** on this front: it spends 3× the cost for the same survival. It is
  not wrong — the scalar objective also rewards *telomere reserve*, which
  keeps rising with maintenance — but the Pareto view makes explicit that the
  extra maintenance buys reserve, not survival. That is exactly the
  weight-dependence the multi-objective run is meant to expose.
* The knee at maintenance ≈ 0.26 (96 % of maximal survival for half the
  cost of the top point) is the natural "recommend for the next in-vitro
  test" candidate under a cost-conscious reading.

### Negative result worth recording

The first NSGA-II run collapsed to 2 unique points by generation 10 while
reporting 40 "non-dominated" members. Cause: the evaluation cache returned
the *same object* for identical genomes, so rank and crowding distance were
shared among clones; one boundary clone gave all clones infinite crowding
and intermediate points were truncated away. Fix: cached candidates are
copied, duplicate genomes are removed before survival selection, and empty
slots are filled with random immigrants (`multiobjective.py`). The flawed
run was deleted from the ledger; a regression test guards the fix.

## 8. Experiment C — Stress locked, only interventions free

### Question

Experiments A and B both let the optimizer set `stress_level`, and it always
drives it to 0 — a realistic answer only if stress is actually removable.
Many real culture/chip conditions are **not** removable (a fixed oxidative
environment, an unavoidable exposure). What can the model achieve if
`stress_level` is **locked at the stressed baseline (0.60)** and the
optimizer may only tune the two genuine interventions,
`maintenance_rate` and `repair_rate`? This is the more realistic and less
trivial scenario flagged when Experiments A/B were designed.

### Setup

Identical to Experiments A/B (same baseline, model, simulator seed) except:

| Item | A / B | C |
|---|---|---|
| Free genes | stress, maintenance, repair | **maintenance, repair only** |
| `stress_level` | evolvable | **fixed at 0.60** |
| Config / command | `evolution.yaml` / `pareto.yaml` | `configs/evolution_locked.yaml` · `python scripts/run_evolution.py --config configs/evolution_locked.yaml --seed 7` and `configs/pareto_locked.yaml` · `python scripts/run_pareto.py --config configs/pareto_locked.yaml --seed 7` |

### Result — GA, run `TEL-20260908-002`

| | Baseline | Evolved (locked) | Evolved (A, stress free) |
|---|---|---|---|
| `maintenance_rate` | 0.10 | **0.917** | 0.654 |
| `repair_rate` | 0.15 | **0.516** | 0.000 |
| `stress_level` | 0.60 | 0.60 (fixed) | 0.000 |
| Fitness | −0.134 | **+0.524** | +0.625 |

Locking stress still recovers 84 % of Experiment A's improvement
(+0.658 vs. +0.759 over baseline) using only interventions a real
experimenter could apply without changing the culture environment itself —
here, `repair_rate` becomes useful (0.516, vs. 0.000 when stress could be
zeroed, because repair only offsets *stress-induced* loss).

### Result — NSGA-II (survival vs. cost), run `TEL-20260908-003`

40 unique front points, hypervolume 0.852 → 0.871 over 25 generations
(697 simulations, 86.8 s). Unlike Experiment B's front (all `repair = 0`
because stress could be zeroed), **this front actively trades off
maintenance against repair**:

| Point | survival | cost | maintenance | repair |
|---|---|---|---|---|
| cheapest | 0.217 | 0.000 | 0.000 | 0.000 |
| knee (max curvature) | 0.970 | 0.258 | 0.621 | 0.361 |
| highest survival on front | 0.993 | 0.325 | 0.672 | 0.445 |

### Interpretation (within the model)

* With stress locked, the achievable survival ceiling (0.993) is the same
  as when stress was free, but it costs **5× more** (cost 0.325 vs. 0.065
  in Experiment B) — the model's way of saying "compensating for a stressor
  you can't remove is expensive."
* The GA's answer (maintenance 0.917, repair 0.516, survival 0.993, cost
  **0.553**) is *not on the 2-objective front* — verified directly: at
  those genes the model gives survival 0.993, cost 0.553, reserve 1.000.
  It is dominated on (survival, cost) by the front's own top point
  (cost 0.325 for the same survival), but the GA still preferred it because
  its scalar objective also rewards *telomere reserve*, which keeps rising
  with maintenance past the point where survival and cost plateau. This is
  the same pattern as Experiment B, now shown under a harder, more
  realistic constraint: **a 2-objective Pareto front is a lower bound on
  cost for a given survival, not the full picture whenever a third
  objective is in the scalar fitness.** A 3-objective front
  (survival, reserve, cost) would recover the GA point exactly; the
  Pareto page (`/pareto`) supports selecting a third objective for this check.
* Practically: if an experimenter can only intervene (cannot change the
  stressor), the model recommends **maintenance ≈ 0.6, repair ≈ 0.36** (the
  knee) as the cost-efficient choice, not the corner the unconstrained
  search finds.

## 9. Experiment D — Reference-model comparison (SDD §22 Level 3)

### Question

`anais-rat/telomeres` was named in the SDD as a potential validation
reference. Rather than assert that a comparison is "future work," this
experiment actually clones it, runs it, and compares it to our model.

### What the reference model actually is

Repository: <https://github.com/anais-rat/telomeres>
(commit `69191c55768477a8c9dc03e111e5e6b194545b69`, fetched 2026-09-08),
**GPLv3**, requires Python 3.12. It is the exact published model of
replicative senescence in **telomerase-negative *Saccharomyces
cerevisiae***, fit to single-cell time-lapse data (Rat et al., *Nature
Communications* 2025) — per-chromosome (16 × 2 = 32 telomere ends,
coincidentally matching our default `telomeres_per_cell`), constant 7 bp
shortening per division, **no telomerase/maintenance term at all**, and a
**stochastic, length-dependent senescence probability** (not a fixed
threshold) with separate laws for two cell sub-types plus non-terminal
arrests. Full details, and why it is *never imported* into this
MIT-licensed package (GPLv3 isolation via a separate process/environment):
`scripts/reference_model/README.md`.

Because the reference model has no maintenance term, the fair comparison
is against **our model with `maintenance_rate=0, stress_level=0`** — pure
replicative shortening with a deterministic threshold — the closest
structural analogue we have.

### What was measured

Not a raw trajectory overlay (different organism, different length scale:
yeast telomeres ≈ 300 bp vs. our human-scale kb defaults, different
senescence mechanism). Instead: the **distribution of the number of
generations before senescence onset**, a dimensionless quantity valid in
both models. For each model, 80 founding cells, seed 11:

- **Ours:** `founder_senescence_cycle` — a new per-founder first-passage
  tracker added to the simulator for this comparison (`simulator/model.py`,
  `simulator/population.py`), recording the cycle at which any descendant
  of a founding cell first became senescent. Exact and unbiased by
  construction.
- **Reference:** their own `population_init` / `population_evolution`
  (self-contained, no experimental-dataset dependency) with default
  best-fit parameters, run for 10 simulated days. Generation-of-onset per
  ancestor is reconstructed from `sen_counts`/`generations` (currently
  senescent cells) and `history_dead` (already-dead cells), taking the
  minimum — see `scripts/reference_model/run_reference_hayflick.py` for
  the exact method and its one caveat (a cell recorded only via
  `history_dead` was already senescent for some cycles before dying, so
  its generation is a slight overestimate of the true onset).

*A naive first pass compared `senescent_fraction(t)` directly against the
reference's population-level senescent count. That is **biased**: lineages
that have not yet senesced keep doubling every cycle while senescent ones
do not, so a population-level fraction over-represents long-lived lineages
and is not an unbiased estimate of the per-founder onset-generation
distribution. The founder-level first-passage tracker above was added
specifically to fix this.*

### Result

| | Ours (no maintenance, no stress) | Reference (`anais-rat/telomeres`, default params) |
|---|---|---|
| n founders | 80 | 80 |
| censored (never senesced) | 0 | 0 |
| mean generations | 41.99 | 6.16 |
| median | 43.0 | 6.0 |
| std | 6.53 | 1.74 |
| **CV (std/mean)** | **0.156** | **0.283** |
| min – max | 28 – 55 | 1 – 9 |
| skew | −0.30 | −0.63 |

Reproduce: `python scripts/compare_reference_model.py` (regenerates our
side; reads the reference side from
`experiments/reference_model/reference_hayflick.json`, itself produced by
the process in `scripts/reference_model/README.md`).

### Interpretation

* **Absolute generation counts are not comparable** and are not claimed to
  be — different organism, different length scale, different senescence
  mechanism. This was expected going in and is not a finding.
* **Both distributions are unimodal and mildly left-skewed** — qualitative
  agreement on shape at the coarsest level (a "spread cluster near an
  upper generation limit, with a tail of earlier senescence," the same
  qualitative picture as the classical Hayflick-limit literature).
* **The reference model has a substantially higher coefficient of
  variation** (0.283 vs. 0.156). This is an honest, informative
  difference, not a bug: our model's variability comes from one Gaussian
  noise term around a deterministic threshold, while the reference
  model's variability comes from a genuinely stochastic senescence
  *trigger* (a probability, not a threshold) layered with cell-type
  transitions (non-terminal arrests, type-B dynamics) that have their own,
  largely length-independent, senescence hazard. A single extra noise term
  cannot reproduce that — reproducing this CV gap would require modelling
  senescence as a hazard/probability rather than a threshold crossing, a
  concrete, scoped idea for a future model version (SDD §41 V0.2).
* **Conclusion for SDD §22 Level 3:** a real, executed, reproducible
  model-to-model comparison was performed. It does not "validate" either
  model — it clarifies exactly where and why the two model families
  diverge, which is the honest and useful outcome of this kind of
  comparison for a lightweight demo model.

## 10. Experiment E — Constant interventions vs. a 6-phase scheduled protocol

### Question

Experiments A–C optimise *constant* interventions. With schedules
(`docs/MODEL.md` §2.1) the optimizer can instead search over **protocols**:
one maintenance/repair level per phase of the run. Under the same locked
stressor as Experiment C (`stress_level = 0.60`, not evolvable), does
letting the GA *time* its interventions buy anything — at matched
time-averaged cost — over the best constant setting? A fasting-like,
hand-written alternating-stress protocol is simulated alongside as the
Simulate-page demo.

### Setup

| Item | Constant (control) | Protocol |
|---|---|---|
| Config / command | `configs/evolution_locked.yaml` · `python scripts/run_evolution.py --config configs/evolution_locked.yaml --seed 7` | `configs/evolution_protocol.yaml` · `python scripts/run_evolution.py --config configs/evolution_protocol.yaml --seed 7` |
| Free genes | `maintenance_rate`, `repair_rate` (2 genes) | the same two, each expanded to **6 phases** of 20 cycles → 12 genes (`maintenance_rate@0…5`, `repair_rate@0…5`) |
| `schedule_phases` | 1 | 6 |
| Everything else | identical: baseline stress 0.60 / maintenance 0.10 / repair 0.15, model fixed as in A–C, GA 32 × 20, optimizer seed 7, **`eval_seeds = (1, 2, 3)`** (multi-seed fitness, unlike A–C), weights 0.40/0.30/0.20/0.10/0.30 | |
| Cost term | ½(maint² + repair²) | ½(m̄² + r̄²) on the **time-averaged** doses (MODEL.md §2.1) — identical for constants |
| Ledger | `TEL-20260910-001` (config hash `97967f3041ce0fa1`, 1 119 simulations, 148 s) | `TEL-20260910-002` (config hash `344558bff0dfd173`, 1 830 simulations, 249 s) |

Both runs were produced by one driver, `python scripts/run_protocol_experiment.py --seed 7`,
which also simulates every scenario below on five held-out simulator seeds
(1–5) and writes `experiments/reports/experiment_e.json`. Environment:
Windows 11, AMD64, Python 3.13.15, NumPy 2.3.4, working tree at
`85f030f-dirty` (the schedule feature itself, committed immediately after).
Note the multi-seed fitness: the constant run here (**+0.5234**) is the
multi-seed re-run of Experiment C's single-seed **+0.524**, so the two agree
to three decimals.

### Fitness by generation (best candidate, training seeds 1–3)

| Generation | 0 | 1 | 2 | 3 | 5 | 10 | 15 | 20 |
|---|---|---|---|---|---|---|---|---|
| Constant (2 genes) | 0.498 | 0.520 | 0.520 | 0.520 | 0.523 | 0.5234 | 0.5234 | 0.5235 |
| Protocol (12 genes) | 0.381 | 0.485 | 0.510 | 0.518 | 0.519 | 0.5236 | 0.5238 | 0.5238 |

Baseline (un-evolved, stress 0.60 / maintenance 0.10 / repair 0.15): **−0.1318**
on the training seeds. The 12-gene search starts lower (random 6-phase
protocols are worse on average than random constants) and needs ~10
generations to catch up; final diversity 0.097 vs. 0.083 — the protocol
population had not fully converged at generation 20.

### Scenarios on held-out simulator seeds 1–5 (mean ± SD of fitness; other columns are 5-seed means)

| Scenario | m̄ (maintenance) | r̄ (repair) | Cost | Fitness | Survival (AUC) | Final senescent | Reserve | Instability | Cycles to 50 % senescent |
|---|---|---|---|---|---|---|---|---|---|
| Baseline (constant) | 0.100 | 0.150 | 0.016 | −0.1298 ± 0.0038 | 0.269 | 100 % | 0.000 | 0.327 | 33.8 |
| Fasting demo (`configs/demo_fasting.yaml`: stress 0.90/0.30 alternating, m̄ = 0.60) | 0.100 | 0.150 | 0.016 | −0.1386 ± 0.0051 | 0.248 | 100 % | 0.000 | 0.330 | 32.0 |
| **Evolved constant** (`TEL-20260910-001`) | 0.938 | 0.481 | 0.556 | **+0.5240 ± 0.0009** | 0.993 | 0 % | 0.999 | 0.059 | never |
| **Evolved protocol** (`TEL-20260910-002`) | 0.932 | 0.508 | 0.563 | **+0.5241 ± 0.0004** | 0.993 | 0 % | 1.000 | 0.040 | never |
| Constant at the protocol's mean doses (control) | 0.932 | 0.508 | 0.563 | +0.5226 ± 0.0005 | 0.993 | 0 % | 1.000 | 0.055 | never |

### The evolved protocol (phases of 20 cycles)

| Phase (cycles) | 0 (0–19) | 1 (20–39) | 2 (40–59) | 3 (60–79) | 4 (80–99) | 5 (100–119) | time average |
|---|---|---|---|---|---|---|---|
| `maintenance_rate` | 0.924 | 0.978 | 0.866 | 0.834 | 0.990 | 1.000 | 0.932 |
| `repair_rate` | 0.378 | **1.000** | 0.759 | 0.413 | 0.315 | 0.181 | 0.508 |

### Interpretation (within the model)

* **Scheduling buys essentially nothing here — a negative result.** The
  best protocol beats the best constant by **+0.0003** on the training
  seeds and by **+0.0001 ± 0.001** on five held-out seeds, i.e. within one
  standard deviation of seed-to-seed noise, while costing 64 % more
  simulator evaluations (1 830 vs. 1 119; fewer genome-cache hits in a
  12-dimensional space). Both solutions sit on the same plateau: survival
  0.993 (the ceiling seen in Experiments B/C), zero senescence, full
  reserve, and a cost term of ≈ 0.56 that the objective simply pays.
* **The timing itself is worth at most ~0.0015.** Holding the protocol's
  own time-averaged doses constant (control row) scores +0.5226, so the
  protocol's shape — repair front-loaded to 1.0 in cycles 20–39 while
  stress-driven loss is eroding the initial reserve, then tapering to 0.18
  as maintenance rises to 1.0 — is worth about +0.0015 (≈ 3 SD) over the
  equivalent constant. That is a real but tiny effect, and it is *not*
  enough to beat the separately-optimised constant. Mechanistically this is
  expected: in this model the stress-induced loss is linear in
  `(1 − repair)` and the maintenance gain is linear in `maintenance_rate`,
  so at equal mean dose the *timing* only matters through the nonlinearity
  of the senescence threshold and the reserve saturation — and the
  constant solution already keeps every cell far above threshold.
* **Intermittent stress at equal mean is slightly *worse* than constant
  stress.** The fasting demo (stress 0.90/0.30 alternating, mean 0.60,
  baseline interventions) scores −0.139 vs. the constant baseline's −0.130
  and reaches 50 % senescence ~2 cycles earlier: the high-stress opening
  phase pushes the shortest telomeres across the threshold sooner than the
  later low-stress phase can compensate, and senescence is irreversible.
  Within this model, then, the "fasting-like" motif carries no benefit on
  its own; it is a demo of the mechanism, not a result in its favour.
* **Where a protocol *could* matter.** The plateau is set by the objective:
  survival saturates and reserve is already 1.0, so there is nothing left
  for timing to buy. Schedules become informative when the constant
  optimum is *not* saturated — a lower cost weight, a harder or
  time-varying stressor, a stress schedule the optimizer cannot remove but
  can anticipate, or an objective that penalises dose *peaks*. Those are
  natural follow-ups (and the intended playground for the roadmap's LLM
  Layer 2, which proposes protocols into exactly this schema).
* **Method note.** Random 6-phase protocols are worse than random
  constants, and the 12-gene population had not converged at 20
  generations; a fairer search-budget comparison would give the protocol
  run more generations or a matched evaluation budget. The negative result
  above is therefore "no benefit found at Experiment C's budget," not
  "no benefit exists."

### Reproduce

```bash
python scripts/run_protocol_experiment.py --seed 7          # both GA runs (registered) + the table above -> experiments/reports/experiment_e.json
# or, piece by piece:
python scripts/run_evolution.py  --config configs/evolution_locked.yaml   --seed 7
python scripts/run_evolution.py  --config configs/evolution_protocol.yaml --seed 7
python scripts/run_simulation.py --config configs/demo_fasting.yaml --seed 1
```

Expected: constant `best fitness +0.5234`
(`{maintenance_rate: 0.938, repair_rate: 0.481}`), protocol
`best fitness +0.5238` with the phase table above. Bit-identical fitness
histories are expected on the same NumPy major version.

## 11. Experiment F — Sub-clone competition for carrying-capacity slots

### Question

`docs/MODEL.md` §2.2 adds sub-clone competition: a config may split its
founding population across named clones with their own per-cell-arithmetic
parameters, all competing for the same `carrying_capacity` slots. Does a
clone with better maintenance/repair genuinely outcompete a baseline clone
under shared stress, and how fast?

### Setup

`configs/demo_subclone_competition.yaml`: the same stressed culture as
`demo.yaml` (`stress_level = 0.60`, baseline `maintenance_rate = 0.10`,
`repair_rate = 0.15`), split 50/50 into **"resilient"** (overrides
`maintenance_rate = 0.6`, `repair_rate = 0.6`) and **"fragile"** (no
overrides — the baseline's own 0.10/0.15), run for 150 cycles (extended from
`demo.yaml`'s 120 to give the two clones' senescence trajectories room to
diverge and settle). These override values were chosen a priori as "a
clearly interpretable, strong intervention" — 3–4× the baseline's own
maintenance/repair — not tuned after seeing the result below.

```bash
python scripts/run_simulation.py --config configs/demo_subclone_competition.yaml --seed 42
```

Ledger: `TEL-20260911-001` (config hash `b14f38f95fd81ef1`, 193 ms).

### Result

| cycle | 0 | 37 | 75 | 113 | 150 |
|---|---|---|---|---|---|
| `resilient` fraction | 0.500 | 0.945 | 1.000 | 1.000 | 1.000 |
| `fragile` fraction | 0.500 | 0.055 | 0.000 | 0.000 | 0.000 |

Terminal metrics of the combined population: `final_senescent_fraction`
0.085, `normalized_survival` 0.983, `final_population_size` 400 (at
`carrying_capacity`), `time_to_50pct_senescence` = ∞ (never reached at the
population level — see the interpretation below for why that is not the
whole story).

### Interpretation

* **The resilient clone displaces the fragile one almost completely, and
  fast.** By cycle 37 (a quarter of the run) the fragile clone is already
  down to 5.5 % of the population; by cycle 75 (half the run) it is
  effectively zero. This is a clear, non-null result at the chosen
  parameters — not a marginal or ambiguous one.
* **Mechanism.** Every division step, proliferative cells produce a
  daughter and senescent cells do not (`simulator/model.py` §1); passaging
  then dilutes the *combined* population back to `carrying_capacity`
  irrespective of clone identity (`simulator/population.py::passage`). A
  clone whose telomeres shorten net-negative more slowly (higher
  `repair_rate` cuts the stress-loss term, higher `maintenance_rate` adds
  more gain) crosses `senescence_threshold` later, so a larger share of its
  cells are still dividing on any given cycle. Each cycle that share compounds:
  more proliferative cells this cycle means more daughters next cycle, so the
  clone's count grows relative to the other even while the *total* population
  is capped — an ordinary "more descendants per unit time" effect, not
  anything special to clones. This is the same mechanism the
  `founder_senescence_cycle` machinery already measures per-founder (§9,
  Experiment D): staying non-senescent longer accumulates more cell-cycles of
  descendants, and with two clones sharing one capacity, one clone's excess
  cell-cycles are the other clone's lost capacity slots.
* **Why `time_to_50pct_senescence` stays ∞ despite this.** That metric is
  computed on the *combined* population's senescent fraction (§4), which
  stays low here (8.5 % final) because the resilient clone, once dominant,
  keeps the combined pool mostly proliferative — a population-level average
  can look "healthy" while masking a complete compositional turnover
  underneath. `clone_fraction` is exactly the per-clone view that avoids this
  blind spot, the same bias `founder_senescence_cycle` was added to fix for
  senescence-onset timing in Experiment D.
* **Scope.** This is not a claim about real cellular sub-clones, mutation, or
  selection — clones are abstract parameter variants of the same model
  (`docs/SCIENTIFIC_SCOPE.md`). The result says: *given* this model's
  mechanics, a large enough maintenance/repair advantage translates into a
  fast, near-total takeover of shared capacity — a demonstration of the
  mechanism the feature is meant to expose, not a biological finding.

### Reproduce

```bash
python scripts/run_simulation.py --config configs/demo_subclone_competition.yaml --seed 42
```

## 12. Experiment G — Timed intervention beats a fixed one under intermittent (fasting-like) stress

### Question

Experiment E found that scheduling `maintenance_rate`/`repair_rate` buys
essentially nothing when `stress_level` is held **constant** — timing only
matters through threshold/reserve nonlinearities, and the constant optimum
already sits on that plateau. `demo_fasting.yaml`'s existing "fasting-like"
stress schedule (0.90/0.30 alternating, same mean as constant 0.60) was
similarly found to be slightly *worse* than constant stress — but only
under a **fixed, un-evolved** intervention (maintenance=0.10, repair=0.15).
Neither test answers the actual question an intermittent-fasting analogy
raises: if the *organism's own response* (maintenance/repair) is free to
adapt to a stress pattern that itself varies over time, does timing that
response help? This experiment evolves maintenance_rate/repair_rate — both
as a single constant and as a 6-phase schedule synced to the stress rhythm
— under five different mean-matched alternating stress patterns.

### Setup

`scripts/explore_fasting_variants.py`. Same GA settings as Experiment E
(population 32, generations 20, `eval_seeds=(1,2,3)`, default weights,
`n_workers=4`) applied to five stress schedules, each six 20-cycle phases
with **mean stress = 0.60** (matching the constant-stress control) but a
different amplitude/duty-cycle, evolving `maintenance_rate`/`repair_rate`
either as one constant value (`schedule_phases=1`) or as a 6-phase schedule
locked to the same phase boundaries as the stress rhythm
(`schedule_phases=6`):

| Pattern | Stress by phase (0–5) | Analogy |
|---|---|---|
| `demo_pattern` | 0.90, 0.30, 0.90, 0.30, 0.90, 0.30 | existing `demo_fasting.yaml` shape |
| `mild` | 0.75, 0.45, 0.75, 0.45, 0.75, 0.45 | smaller swing, same mean |
| `extreme` | 1.00, 0.20, 1.00, 0.20, 1.00, 0.20 | largest swing within `stress_level`'s [0, 1] bounds |
| `short_fast` | 0.80, 0.80, 0.80, 0.80, 0.20, 0.20 | mostly high, brief low block (16:8-like) |
| `long_fast` | 1.00, 0.40, 0.40, 1.00, 0.40, 0.40 | mostly low, brief high block (5:2-like) |

**A bug was found and fixed during this work**: a first version of
`long_fast` used `[0.80, 0.20, 0.20, 0.80, 0.20, 0.20]`, which averages to
0.40, not 0.60 — its early fitness advantage was confounded with simply
having a lower mean stress burden, not a timing effect. It was caught by
checking every pattern's mean before writing up results, corrected to the
table above, and rerun before any number below was recorded.

Not registered in the experiment ledger (exploratory sweep across many
scenarios); the one config promoted to a permanent, reproducible artifact
is `configs/demo_fasting_evolved.yaml` (the `demo_pattern` protocol
genome), covered below.

### Result (mean fitness, training seeds 1–3; reference: constant stress 0.60, evolved constant intervention = +0.5234, Experiment E)

| Pattern | Constant intervention | Scheduled intervention (synced to stress) | Gain from syncing |
|---|---|---|---|
| `demo_pattern` | +0.5234 | **+0.5508** | +0.0274 |
| `mild` | +0.5235 | +0.5394 | +0.0159 |
| `extreme` | +0.5233 | **+0.5688** | +0.0454 |
| `short_fast` | +0.5233 | +0.5487 | +0.0254 |
| `long_fast` | +0.5234 | +0.5504 | +0.0270 |

Every "constant intervention" column is within noise of the +0.5234
constant-stress reference regardless of the stress pattern's shape — a
constant response only sees the *mean* stress, exactly as Experiment E's
linear-dynamics argument predicts. Every "scheduled intervention" column
clearly beats it, and the gain grows with the stress swing's amplitude
(`extreme` > `demo_pattern`/`long_fast`/`short_fast` > `mild`). Held-out
check on `demo_pattern` at seed 42 (not one of the training `eval_seeds`):
constant intervention +0.5223, scheduled intervention +0.5501 — the same
gap, confirming this isn't a training-seed artifact.

### The evolved schedule (demo_pattern, phases of 20 cycles; stress 0.90/0.30/0.90/0.30/0.90/0.30)

| Phase | 0 (stress 0.90) | 1 (stress 0.30) | 2 (stress 0.90) | 3 (stress 0.30) | 4 (stress 0.90) | 5 (stress 0.30) |
|---|---|---|---|---|---|---|
| `maintenance_rate` | 1.00 | 0.78 | 0.32 | 1.00 | 1.00 | 0.79 |
| `repair_rate` | **1.00** | 0.42 | **0.98** | **0.00** | **0.74** | **0.00** |

### Interpretation (within the model)

* **Timing a response to a fixed environment (Experiment E) is not the
  same question as timing a response to a *varying* one (this
  experiment) — and they have different answers.** Both are honest,
  neither contradicts the other; they probe different parts of the
  model's behaviour.
* **The mechanism is visible in the evolved schedule, not just the
  fitness number.** `repair_rate` tracks the stress phase closely: high
  (0.74–1.00) during every high-stress phase, near zero during every
  low-stress phase, in 4 of 5 patterns. This falls directly out of the
  per-cycle update (`docs/MODEL.md` §2): stress-induced loss is
  `stress_level · stress_sensitivity · (1 − repair_rate)`, so repair's
  marginal benefit is proportional to the *current* `stress_level` — it is
  nearly free to skip during a low-stress phase and most valuable exactly
  when stress is high. Since the cost term is charged on the
  *time-averaged* dose (`docs/MODEL.md` §2.1), concentrating repair into
  the high-stress phases buys the same protection for less average cost.
  `maintenance_rate` does not show the same clean phase-lock, which also
  makes sense: its gain term has no `stress_level` factor, so its optimal
  timing depends on the telomere-length trajectory rather than the current
  stress phase.
* **This is a real result, not a re-run of the fasting demo's original
  finding.** `demo_fasting.yaml` (fixed maintenance=0.10/repair=0.15 under
  this exact stress rhythm) ends 100% senescent. The evolved schedule under
  the *identical* stress rhythm (`configs/demo_fasting_evolved.yaml`) ends
  0% senescent, every seed tested. The only difference is the timing of
  the response, not the environment.
* **Still not a dosing regimen.** This is a model result under an explicit
  computational objective, not evidence about real intermittent fasting,
  caloric restriction, or any clinical protocol (`docs/SCIENTIFIC_SCOPE.md`).
  The result says: *in this simplified model*, a repair response that
  concentrates into periods of higher modelled stress is more
  cost-efficient than a constant one, because of how the stress and repair
  terms multiply in the update equation — a mechanistic, interpretable
  finding about this specific set of equations, not a biological claim.

### Reproduce

```bash
python scripts/explore_fasting_variants.py                                 # the full sweep -> experiments/reports/fasting_sweep.json
python scripts/run_simulation.py --config configs/demo_fasting.yaml --no-register           # fixed response: 100% senescent
python scripts/run_simulation.py --config configs/demo_fasting_evolved.yaml --no-register    # evolved response: 0% senescent
```

## 13. Experiment H — A 3-objective Pareto front recovers the GA's "off-front" point

### Question

Experiment C's GA run (locked stress, `maintenance_rate`/`repair_rate` free)
found a point (maintenance=0.917, repair=0.516, survival=0.993) that was
*dominated* on the 2-objective (survival, cost) front — the front's own
top point reached the same survival for less cost. Experiment C's own
interpretation predicted why: the GA's scalar fitness also rewards
telomere *reserve*, which the 2-objective front never accounted for, and
predicted that adding `reserve` as a third NSGA-II objective would recover
the GA's point onto the front exactly. This experiment tests that
prediction directly instead of leaving it as a stated-but-unverified claim.

### Setup

`configs/pareto_locked_3obj.yaml` — identical to Experiment C's
`pareto_locked.yaml` (stress_level locked at 0.60, only
`maintenance_rate`/`repair_rate` free, same population/generations/seed)
except `objectives: [survival, reserve, cost]` instead of
`[survival, cost]`.

```bash
python scripts/run_pareto.py --config configs/pareto_locked_3obj.yaml --seed 7
```

Run `TEL-20260912-002`: 40-point front, 715 simulations, 118 s.

### Result

The Experiment C GA genome (`maintenance_rate=0.917`, `repair_rate=0.516`)
was re-evaluated against this run's model and checked for domination
against all 40 front points (does any front point have survival ≥, reserve
≥ *and* cost ≤, with at least one strictly better?):

| | survival | reserve | cost | Dominated by any of the 40 front points? |
|---|---|---|---|---|
| Experiment C's GA point (re-evaluated) | 0.9927 | 1.0000 | 0.5536 | **No — 0 of 40** |
| Closest front point found by NSGA-II | 0.9927 | 1.0000 | 0.5583 | — |

The closest front point's genome (`maintenance_rate=0.912`,
`repair_rate=0.533`) essentially reproduces the GA's own answer
(`0.917`/`0.516`) from an entirely different search (NSGA-II vs. a scalar
GA), independently.

**Hypervolume is reported as 0.0** for this run — `hypervolume_2d()` is
exact-2D-only by design (`docs/MODEL.md` §5.1) and returns 0 for any other
objective count rather than a wrong or misleading number. Front quality
here is checked directly (non-domination against a known point), not via
hypervolume — a real, documented limitation of the current hypervolume
tooling for 3+ objectives, not one this experiment works around.

### Interpretation (within the model)

* **Experiment C's own prediction holds, verified directly rather than
  asserted.** A 2-objective front is a lower bound on cost for a given
  survival *only among the objectives it tracks* — adding the objective
  the GA's scalar fitness actually also cared about (reserve) makes the
  "off-front" point a legitimate front point after all. Neither search
  was wrong; they were answering different questions.
* **Two independent search methods (a scalar GA and 3-objective NSGA-II)
  converge on the same trade-off point from opposite directions** — the
  GA by weighting all three quantities into one scalar, NSGA-II by
  searching the full trade-off surface and this point turning out to be
  non-dominated on it. That agreement is itself a mild robustness check on
  both.
* **Practical reading**: with stress locked at 0.60, `reserve` and
  `survival` saturate together (both peak at maintenance ≈ 0.91,
  repair ≈ 0.52-0.53) — there is no genuine 3-way trade-off *at* that
  corner of the space, only a 2-way one (cost vs. the joint
  survival+reserve ceiling), which is why a single point can be optimal
  for both a 2-D-blind scalar objective and a 3-D-aware Pareto search.
* Still a model result under the stated objective definitions
  (`docs/SCIENTIFIC_SCOPE.md`), not a claim about real intervention
  trade-offs.

## 14. Performance (scripts/benchmark.py, same machine)

| Measurement | Value |
|---|---|
| Single simulation, default config (100→400 cells × 32 telomeres × 120 cycles) | 141 ms median |
| Single simulation, large (200→1000 cells × 92 telomeres × 200 cycles) | 728 ms median |
| Evolution, 32 candidates | 7.2 s / generation (≈ 200 ms per evaluation) |

Report: `experiments/reports/benchmark.json`.
