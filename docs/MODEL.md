# MODEL.md — Telomere dynamics model (v0.1.0)

This document specifies the exact equations, parameters, ranges and
assumptions of the MVP simulator (`src/telomere_lab/simulator/`). It is the
authoritative description referred to by SDD §9.

The model is a **lightweight, abstract population model**, not a
mechanistic reconstruction of human telomere biology. See
`SCIENTIFIC_SCOPE.md` for what it does and does not claim.

---

## 1. State

* A culture is a set of cells. Each cell carries `telomeres_per_cell`
  telomere lengths `L_ij` in base pairs (bp).
  * Human diploid cells have 92 telomere ends; the MVP default is 32 to
    keep evolution runs interactive. The Simulate page (`/simulate`)
    allows up to 92.
* Each cell has a boolean state: **proliferative** or **senescent**.
* Time advances in discrete **cell cycles** (one division of every
  proliferative cell per cycle). No wall-clock mapping is assumed except the
  optional organ-on-chip helper (§6).

Initial lengths: `L_ij(0) ~ Normal(initial_length, initial_length_sd)`,
clipped at 200 bp.

## 2. Per-cycle update

For each cycle `t → t+1`:

1. **Division.** Every proliferative cell produces one daughter with an
   identical copy of its telomere array. Senescent cells do not divide.
2. **Telomere change** on both copies of every dividing cell:

   ```
   L_ij ← max( 0,
              L_ij
              − shortening_rate                                        (end-replication loss)
              − stress_level · stress_sensitivity · (1 − repair_rate)  (stress-induced loss)
              − ε_ij,   ε_ij ~ Normal(0, noise_sd)                    (stochastic variation)
              + maintenance_rate · maintenance_max_gain · w_ij )       (telomerase-like gain)
   ```

   with the maintenance weight

   ```
   w_ij = exp( −(L_ij − min_j L_ij) / τ ) · clip( (L_sat − L_ij) / (L_sat − L₀), 0, 1 ),
   τ = 1000 bp,   L₀ = initial_length,   L_sat = 2 · L₀
   ```

   * The first factor gives the cell's **shortest telomere weight 1** and
     longer telomeres exponentially less. This encodes the observation that
     telomerase preferentially extends the shortest telomeres.
   * The second factor is 1 for any telomere at or below the initial
     length and ramps linearly to 0 at twice the initial length, so
     maintenance is fully effective in the physiological range but cannot
     drive unbounded growth. (An earlier form, `1 − L/L_sat`, already
     removed ~45 % of the gain at 7 kb and forced the optimiser into the
     `maintenance = 1` corner; see EXPERIMENT_PROTOCOL.md.)
3. **Senescence.** A cell becomes senescent (irreversibly) once
   `min_j L_ij < senescence_threshold`. The *shortest* telomere is the
   trigger, consistent with the literature that the shortest telomere, not
   the average, limits replicative capacity.
4. **Death.** Each senescent cell is removed with probability
   `senescent_death_rate` per cycle. Proliferative cells do not die in v0.1.
5. **Passaging.** If the number of living cells exceeds
   `carrying_capacity`, cells are randomly sub-sampled back to capacity,
   independent of state, mimicking in-vitro dilution.
6. **Recording.** Summary statistics (§4) are stored for the cycle.

All random draws come from one `numpy.random.Generator` seeded with
`seed`; the same `(config, seed)` gives bit-identical output.

### 2.1 Time-varying intervention protocols (schedules)

By default `stress_level`, `maintenance_rate` and `repair_rate` are constant
for the whole run. A `ModelConfig` may optionally carry a **schedule**
(`ModelConfig.schedule`, an `InterventionSchedule`) that makes any subset of
these three — and only these three (`SCHEDULABLE_PARAMETERS`) — **piecewise
constant** in time:

* The run's `cycles` division steps are split into `K` consecutive,
  as-equal-as-possible **phases**, `1 ≤ K ≤ MAX_PHASES = 8`.
* Each scheduled parameter has exactly `K` values, one per phase, each
  within the parameter's normal `PARAMETER_BOUNDS`; validation rejects a
  wrong length, an out-of-range value or a non-schedulable key
  (`ConfigError`), through the same `ModelConfig.validate()` gate every
  other config passes.
* The division step `t → t+1` (0-based `t = 0 … cycles−1`) uses phase

  ```
  phase(t) = min( K − 1, ⌊ t · K / cycles ⌋ )
  ```

  so for `cycles = 120, K = 6` the phases are cycles 0–19, 20–39, …,
  100–119. When `cycles` is not divisible by `K` the first phases are one
  step longer (10 cycles, K = 3 → blocks of 4, 3, 3). `t = cycles` (one past
  the last step) is clamped onto the final phase so a step line drawn
  against the `cycles + 1` time axis ends flat.
* The parameter update of §2 is unchanged; it simply reads the scheduled
  value for the current step. Parameters absent from the schedule keep
  their scalar value. When a parameter *is* scheduled, its scalar field
  (`config.stress_level` etc.) only documents the phase-0 / fallback value.
  Lookups: `ModelConfig.value_at(name, t)`, `per_cycle_values(name)`,
  `mean_value(name)`.
* `SimulationResult.applied_schedule[name]` records the per-step value
  actually applied for every scheduled parameter on the same `(T+1,)` axis
  as `time` (empty when unscheduled), and is exported in `to_json_dict()`.

**Backward compatibility.** `schedule=None` and a `K = 1` schedule run the
identical arithmetic and are bit-identical to the pre-schedule model
(`tests/test_schedule.py` checks this against golden output recorded from
the code before schedules existed); a config dict without a `schedule` key
loads with `schedule=None`; `config_hash` includes the schedule when one is
set and is unchanged for unscheduled configs.

**Cost of a protocol (see §5).** The intervention-cost term is charged on
the **time-averaged** maintenance and repair, `½(m̄² + r̄²)` with
`m̄ = mean_value("maintenance_rate")`, `r̄ = mean_value("repair_rate")`
(the mean over the `cycles` steps, so uneven phase lengths are weighted
correctly). For an unscheduled config `m̄, r̄` are the scalars and the cost
is exactly the original one. For a protocol this means intervening only
part of the time is cheaper than the same intensity held constant — and,
because the cost is convex, the cost *of the mean dose* is never more than
the mean of the per-phase costs (Jensen), so the objective deliberately
favours intermittent dosing at equal total dose. That is an experimenter
choice about what "intervention cost" means (total dose delivered), not a
biological statement; the alternative (mean of per-phase costs) would be
neutral to timing.

**Protocol search.** The optimizers (`EvolutionConfig`,
`MultiObjectiveConfig`, `ActiveLearningConfig`) take `schedule_phases`
(default 1). With `schedule_phases = K > 1` every *free* gene in
`SCHEDULABLE_PARAMETERS` is expanded into `K` genes named
`<parameter>@<phase>` with the parameter's bounds; other free genes stay
scalar; decoding builds the `InterventionSchedule` on the candidate config
(`evolution/genome.py`). `schedule_phases = 1` produces exactly the classic
genome and results. One-at-a-time sensitivity analysis stays a scalar
analysis: a scheduled baseline passes through unchanged, and perturbing a
parameter that happens to be scheduled shifts every phase by the same
amount. An optimised protocol is a model result under the stated objective,
not a dosing regimen (`SCIENTIFIC_SCOPE.md`).

## 3. Parameters

| Name | Default | Range | Unit | Kind |
|---|---|---|---|---|
| `initial_length` | 7500 | 3000–15000 | bp | initial condition |
| `initial_length_sd` | 800 | 0–3000 | bp | initial condition |
| `population_size` | 100 | ≥1 | cells | initial condition |
| `carrying_capacity` | 400 | ≥population | cells | structure |
| `telomeres_per_cell` | 32 | 1–92 | – | structure |
| `shortening_rate` | 55 | 10–200 | bp/cycle | model |
| `stress_level` | 0.40 | 0–1 | a.u. | model (evolvable, schedulable §2.1) |
| `stress_sensitivity` | 100 | 0–300 | bp/cycle | model |
| `maintenance_rate` | 0.20 | 0–1 | a.u. | model (evolvable, schedulable §2.1) |
| `maintenance_max_gain` | 120 | 0–300 | bp/cycle | model |
| `repair_rate` | 0.20 | 0–1 | a.u. | model (evolvable, schedulable §2.1) |
| `senescence_threshold` | 3000 | 500–6000 | bp | model (evolvable) |
| `noise_sd` | 30 | 0–200 | bp | randomness |
| `senescent_death_rate` | 0.03 | 0–0.5 | 1/cycle | model |
| `cycles` | 120 | ≥1 | cycles | run control |
| `seed` | 42 | – | – | randomness |
| `schedule` | none | 1–8 phases | – | optional protocol (§2.1) |

Evolvable genes (SDD §12): `initial_length`, `shortening_rate`,
`stress_level`, `maintenance_rate`, `repair_rate`, `senescence_threshold`.
The default experiment frees only the three "culture-condition" genes.

Each candidate's fitness is now averaged over multiple simulator seeds
(`eval_seeds`, default `(1, 2, 3)`) rather than a single draw, to reduce
stochastic noise in the search; Experiments A/B/C in
`docs/EXPERIMENT_PROTOCOL.md` were recorded with a single seed (42).

Order-of-magnitude anchors (used only to choose defaults, not fitted):
human somatic telomeres of roughly 5–15 kb; replication-associated loss on
the order of 50–100 bp per division; critically short telomeres in the
low-kb range; oxidative stress accelerating loss. The defaults give a
Hayflick-like limit of a few dozen to ~60 divisions in the unstressed
case, which is the intended qualitative behaviour.

## 4. Outputs

Per cycle: mean, median, 10th percentile and minimum telomere length; mean
of each cell's shortest telomere; senescent fraction; living cells;
proliferative cells; fraction of telomeres below threshold; coefficient
of variation of lengths.

Terminal metrics (`metrics.terminal_metrics`):

* `normalized_survival` — area under the proliferative-cell curve divided
  by `carrying_capacity × cycles` (∈ [0, 1]).
* `normalized_telomere_reserve` — `(mean shortest-per-cell − threshold) /
  (initial_length − threshold)` at the final cycle, clipped to [0, 1].
* `final_senescent_fraction`, `time_to_50pct_senescence` (`inf` if never
  reached), `final_length_cv`, population sizes, `extinct`.

## 5. Fitness (optimisation objective)

```
fitness = w_survival    · normalized_survival
        + w_reserve     · normalized_telomere_reserve
        − w_senescence  · final_senescent_fraction
        − w_instability · clip(final_length_cv / 0.5, 0, 1)
        − w_cost        · ½ (m̄² + r̄²)          m̄, r̄ = time-averaged maintenance_rate, repair_rate
```

For a constant (unscheduled) configuration `m̄ = maintenance_rate` and
`r̄ = repair_rate`, i.e. the cost is ½(maintenance² + repair²) exactly as
before; for a scheduled protocol see §2.1.

Default weights 0.40 / 0.30 / 0.20 / 0.10 / 0.30. Invalid simulations
(out-of-range parameter, non-finite state) receive fitness −1000 and are
flagged; they never compete with valid candidates.

**Fitness is an experimenter-chosen objective, not a biological truth.**
The cost term is *convex* (quadratic) so the marginal cost of an
"intervention" grows with its intensity and the optimiser has to find
"just enough" maintenance/repair instead of maxing every knob. With a
linear cost and the same weights the optimum sat in a corner
(maintenance = 1, repair = 0), which is a legitimate but uninformative
result; the convex form was chosen to make the trade-off visible.
Reducing `stress_level` is free under the default weights, which is
itself an assumption the user can change.

### 5.1 Multi-objective alternative (NSGA-II)

`evolution/multiobjective.py` optimises any two or more of the five
components above **without weights**. Objectives and their directions:

| Objective | Direction | Definition |
|---|---|---|
| `survival` | max | normalised proliferative-cell AUC |
| `reserve` | max | normalised shortest-telomere reserve |
| `senescence` | min | final senescent fraction |
| `instability` | min | clip(final CV / 0.5, 0, 1) |
| `cost` | min | ½(m̄² + r̄²), time-averaged maintenance / repair (§2.1) |

NSGA-II (Deb et al., 2002): fast non-dominated sort, crowding distance,
binary tournament on (rank, crowding), (μ+λ) survival with the last front
truncated by crowding. Operators, gene domains and bound repair are shared
with the GA. Because every objective is bounded in [0, 1], the 2-D
hypervolume is computed against the fixed nadir (worst corner) and is
comparable across runs. Invalid simulations are placed at a dominated
sentinel point and never enter the front. The scalar fitness is still
reported per front member for reference only.

### 5.2 Surrogate-model active learning

`evolution/surrogate.py` is a different kind of optimizer, not a rerun of
GA/NSGA-II/random search under another name: it answers "can we reach a
comparable fitness with *fewer* real simulator evaluations by being
selective about which genome to test next?" (the standard "why not just
random search" critique, made concrete and measured).

A small random initial design (uniform over the same normalised gene space
as the GA, `GenomeSpec`) is evaluated with the real simulator. A
`sklearn.gaussian_process.GaussianProcessRegressor` (Matern kernel) is then
fit to the (genome, fitness) pairs seen so far. A Gaussian Process is used
rather than a Random Forest because the free-gene space is low-dimensional
(3-6 genes) and the real-evaluation budget is small (tens of points) — a GP
is cheap to fit at this scale and, unlike a plain regressor, gives a
calibrated predictive mean *and* uncertainty, which the acquisition
function needs. Each iteration scores a random pool of candidate genomes
with the fitted surrogate, computes **Expected Improvement** (EI) against
the best real fitness seen so far, evaluates the EI-maximising candidate
with the real simulator, and refits. Every real evaluation, its surrogate
belief beforehand (mean/std/EI), and the running best-so-far are recorded
(`ActiveLearningResult`), so calibration and convergence are both visible.

`scripts/benchmark_optimizers.py` includes this method as a fourth,
budget-matched entry alongside GA/NSGA-II/random search on the same
convergence axis (real simulator evaluations vs. best fitness so far).

## 6. Organ-on-a-chip mapping (assumption)

`adapters/chip.py` converts chip conditions to model parameters:

```
o2_stress        = clip((O2 − 0.05)/(0.21 − 0.05), 0, 1) · 0.35
exogenous        = stress_exposure · 0.55
nutrient_stress  = (1 − nutrient_state) · 0.25
flow_relief      = flow_rate · 0.15
stress_level     = clip(o2_stress + exogenous + nutrient_stress − flow_relief, 0, 1)
repair_rate      = clip(0.10 + 0.30·nutrient_state + 0.20·flow_rate, 0, 1)
cycles           = culture_days / 1 day per doubling
```

Coefficients are round numbers chosen to keep outputs in bounds. They are
**not calibrated to any dataset** and the Simulate page's organ-on-chip
mapper labels them as derived
simulation parameters.

`adapters/chip.py::CHIP_PRESETS` (ROADMAP.md candidate feature #3, multi-chip
comparison, 2026-09-11) adds a small set of **named, illustrative** points in
this same input space (a static-well control plus profiles loosely evoking
liver-chip/lung-chip/gut-chip/injury-model *concepts*) so several conditions
can be compared side by side on the Compare page. The names are framing
devices only — they still go through the one, unmodified mapping above, and
are not a claim of calibration to any organ's real physiology.

## 7. Known simplifications

* No cell-cycle arrest heterogeneity, no DNA-damage checkpoints beyond
  the single length threshold, no apoptosis of proliferative cells, no
  crisis/ALT escape, no chromosome-specific telomere lengths, no
  asymmetric inheritance of sister-chromatid ends.
* Stress and repair are scalar abstractions (optionally piecewise constant
  in time, §2.1 — no continuous dose–response dynamics or lag).
* Maintenance is a phenomenological gain, not a telomerase kinetic model.
* Passaging is state-blind random sub-sampling.

## 8. Software validation

`tests/test_simulator.py` checks: bounds, deterministic seeding,
monotone shortening without maintenance, qualitative relationships
(faster shortening → earlier senescence; more maintenance → longer
telomeres and less senescence; repair mitigates stress), capacity cap,
maintenance-weight shape, and the <1 s runtime target.
`tests/test_schedule.py` checks schedules (§2.1): validation, the phase
mapping including non-divisible `cycles`, bit-identity of unscheduled and
`K = 1` runs against pre-schedule golden output, time-averaged cost, the
per-phase genome expansion/decoding round trip, and that
`schedule_phases = 1` reproduces the pre-schedule GA run exactly.
