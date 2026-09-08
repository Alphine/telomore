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
```

Expected: `best fitness +0.6254`, best genome
`{stress_level: 0.0, maintenance_rate: 0.654, repair_rate: 0.0}`,
registered as the next `TEL-<date>-NNN`. Bit-identical fitness history is
expected on the same NumPy major version; tiny last-digit differences may
appear across BLAS builds.

To view interactively: `streamlit run app/streamlit_app.py` → Evolve
(defaults match this protocol) → Compare → Experiments.

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
  (survival, reserve, cost) would recover the GA point exactly; the GUI
  Pareto page supports selecting a third objective for this check.
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

## 10. Performance (scripts/benchmark.py, same machine)

| Measurement | Value |
|---|---|
| Single simulation, default config (100→400 cells × 32 telomeres × 120 cycles) | 141 ms median |
| Single simulation, large (200→1000 cells × 92 telomeres × 200 cycles) | 728 ms median |
| Evolution, 32 candidates | 7.2 s / generation (≈ 200 ms per evaluation) |

Report: `experiments/reports/benchmark.json`.
