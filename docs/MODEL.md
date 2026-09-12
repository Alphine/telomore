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

### 2.2 Sub-clone competition

By default a simulation is one homogeneous population. A `ModelConfig` may
optionally carry **sub-clones** (`ModelConfig.subclones`, a tuple of
`SubcloneSpec`) that split the founding population into named, genetically
distinct groups competing for the same `carrying_capacity` slots — an inner
evolutionary layer distinct from the outer GA/NSGA-II/active-learning
parameter search, which never touches this field (ROADMAP.md candidate
feature #4).

* Each `SubcloneSpec` has a `name`, an `initial_fraction` and an `overrides`
  mapping. There must be `>= 2` clones (a single clone is meaningless — omit
  the field instead), names must be unique, and every clone's
  `initial_fraction` must be finite and in `(0, 1]`; the fractions across all
  clones must sum to `1.0` within `SUBCLONE_FRACTION_TOLERANCE = 1e-6`.
* `overrides` may set any subset of `SUBCLONE_OVERRIDABLE_PARAMETERS =
  (shortening_rate, maintenance_rate, repair_rate, stress_sensitivity)` — the
  four per-cell-arithmetic "biology knobs" of §2. Each override is
  bounds-checked against the same `PARAMETER_BOUNDS` every other value in
  this model uses. A clone may **not** override `senescence_threshold`,
  `carrying_capacity`, `stress_level`, or any structural/initial-condition
  field: a clone is a genetic variant of the *same* culture, not a different
  experiment.
* **Founding allocation.** The `population_size` founding cells are split
  across clones by the **largest-remainder method** on `initial_fraction`
  (not per-cell coin flips), so the cell count per clone is a deterministic
  function of `(population_size, fractions)` and spends no RNG draw — the
  rest of the RNG stream (initial lengths, division noise, death, passaging)
  is completely unaffected by whether `subclones` is set. A daughter cell
  inherits its parent's clone exactly like it inherits `founder_id` (§2,
  `simulator/population.py::divide`) — a clone is a heritable identity, not
  a per-division draw.
* **Composition rule with the per-cell arithmetic of §2.** `shortening_rate`
  and `stress_sensitivity` are never schedulable (§2.1), so a clone's
  override on either simply *replaces* the config's scalar for that clone's
  cells in the `deterministic_loss` term — no ambiguity with time-varying
  behaviour. `maintenance_rate` and `repair_rate` *can* be scheduled; the
  chosen rule is: **the shared schedule (or scalar) is the culture
  environment's dosing level and applies uniformly to every clone**; a
  clone's override on `maintenance_rate`/`repair_rate`, when present, means
  "this clone's own constant value, ignoring the shared schedule for that
  parameter" — a clone without that specific override still reads the
  shared per-step scheduled/scalar value, exactly as every cell did before
  sub-clones existed. Concretely, per cycle the simulator builds a small
  `(n_clones,)` lookup for each of the four overridable parameters (clone's
  override, or the shared value) and indexes it by each dividing cell's
  `clone_id` to get **per-cell** `deterministic_loss` / `max_gain` arrays,
  the natural vectorised generalisation of §2's scalar arithmetic.
  **Backward compatibility**: `subclones=None` (or an unset field) uses a
  single implicit "default" clone with no overrides, whose lookup values are
  therefore identical to the plain scalar/schedule arithmetic — bit-identical
  to the pre-sub-clone model (`tests/test_subclones.py` checks this against
  the same golden fixture `tests/test_schedule.py` uses); a config dict
  without a `subclones` key loads with `subclones=None`; `config_hash`
  includes `subclones` when set and is unchanged when unset.
* **Composition with schedules (§2.1).** Both mechanisms may be set on the
  same config: the schedule drives the shared per-step values every clone
  reads by default, while distinct clones may each pin their own constant
  `maintenance_rate`/`repair_rate` regardless of the schedule's swings on
  that parameter (`tests/test_subclones.py::test_schedule_and_subclones_compose`).
* **Output.** `SimulationResult.clone_fraction[name]` records, on the same
  `(T+1,)` axis as `time`, the fraction of the *living* population in each
  named clone at every cycle (`0.0`, never `NaN`, when the population is
  extinct) — empty when `subclones` is unset. Exported in `to_json_dict()`.
* **Not in scope for the outer search.** The GA/NSGA-II/active-learner
  genome encodings (`evolution/genome.py`) do not expand or evolve
  `subclones` — this is a Simulate-page exploratory lens on the *inner*
  competition dynamics, not a new gene space for the *outer* optimizers.

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
| `subclones` | none | ≥2 clones | – | optional sub-clone competition (§2.2) |

Evolvable genes (SDD §12): `initial_length`, `shortening_rate`,
`stress_level`, `maintenance_rate`, `repair_rate`, `senescence_threshold`.
The default experiment frees only the three "culture-condition" genes.

Each candidate's fitness is now averaged over multiple simulator seeds
(`eval_seeds`, default `(1, 2, 3)`) rather than a single draw, to reduce
stochastic noise in the search; Experiments A/B/C in
`docs/EXPERIMENT_PROTOCOL.md` were recorded with a single seed (42).

### 3.1 Literature calibration (2026-09-12)

The defaults above were originally chosen as order-of-magnitude anchors, not
fitted to data. This section replaces that with an actual literature check
(via Consensus.app, human-reviewed) — same "used to choose defaults, not
fitted" status, but now with real citations behind each number instead of a
one-line hand-wave. Nothing in `schemas.py` was changed as a result: every
current default already falls inside, or close to, the ranges below.

| Parameter | Default | Literature anchor | Verdict |
|---|---|---|---|
| `initial_length` | 7500 bp | Adult blood ~6900 bp (Zheng et al., 2024, single-telomere array-FISH); fibroblast TRF (old donors) ~7000 bp (Allsopp et al., 1992) | Consistent |
| `initial_length_sd` | 800 bp | Inter-individual leukocyte TL SD ~0.8 kb (Sabharwal et al., 2018) | Consistent |
| `shortening_rate` | 55 bp/cycle | Fibroblasts in vitro: ~48±21 bp/division (Allsopp et al., 1992), ~50 bp (Levy et al., 1992); commonly cited range 50–100 bp, up to ~200 bp depending on cell type/method; newer in vivo estimate ~28 bp (Harris et al., 2025) | Consistent (mid-range of the in vitro fibroblast literature, the most relevant comparator for this model) |
| `stress_sensitivity` | 100 bp/cycle (0–300) | Saretzki et al. (1995): telomere loss rate rises from 90 bp/PD (normoxia) to >500 bp/PD under 40% O₂ hyperoxia — a ~410 bp/PD *excess* under an extreme stress condition; Tchirkov & Lansdorp (2003): 1.5–3.2× increase in oxidatively-stressed (ataxia-telangiectasia) fibroblasts | Directionally consistent; the single most extreme literature datapoint (severe hyperoxia) exceeds this parameter's 300 bp/cycle upper bound — noted as a scope limit, not corrected, since 40% O₂ is a specific extreme experimental condition rather than the chronic/moderate stress this abstract knob is meant to represent |
| `maintenance_max_gain` | 120 bp/cycle (0–300) | Cristofari & Lingner (2006): telomeres elongate up to 0.8 kb (800 bp) per population doubling under hTERT/hTR **overexpression** — an experimental extreme, not physiological telomerase activity (which the retrieved literature does not quantify as a clean bp/division rate) | Default and range are well below the overexpression extreme, consistent with representing moderate/physiological maintenance rather than engineered telomerase overexpression |
| `senescence_threshold` | 3000 bp | Not a fixed universal value in the literature: the *shortest* telomere in a cell, not the mean, triggers senescence (Allsopp et al., 1995; Xu et al., 2013); short telomeres accumulate at ~1–2 kb before senescence, individual telomeres as low as 0.5–1 kb (Martens et al., 2000); TRF2 overexpression can shift the senescence setpoint from ~7 kb down to ~4 kb without accelerating senescence (Karlseder et al., 2002), showing telomere *protection state*, not length alone, governs the trigger | Plausible single-threshold approximation of a "shortest-telomere-driven, protection-state-dependent" mechanism the model deliberately simplifies — documented here as a known simplification, not silently assumed |
| `repair_rate` | 0.20 (0–1, a.u.) | No direct bp/cycle repair-rate analog found; conceptually maps to shelterin-mediated protection and DNA-damage-response suppression at telomeres (de Lange, 2018; Denchi & de Lange, 2007) rather than a literature-quantified "repair rate" | Qualitative abstraction only — flagged as not literature-calibrated in the same numeric sense as the others |

**References** (author/year as cited above; DOIs given where captured from the
search):
- Allsopp et al., 1992, *PNAS*, "Telomere length predicts replicative
  capacity of human fibroblasts"
- Allsopp et al., 1995, *Exp. Cell Res.*
- Levy et al., 1992, *J. Mol. Biol.*, "Telomere end-replication problem and
  cell aging"
- Harris et al., 2025 (in vivo telomere-shortening-per-division estimate via
  sex/DKC1 dosage differences)
- Zheng et al., 2024 (single-telomere array-FISH telomere length survey)
- Sabharwal et al., 2018 (pediatric multi-tissue telomere length)
- Karlseder et al., 2002, *Science* (TRF2 overexpression and the senescence
  setpoint)
- Martens et al., 2000 (short-telomere accumulation before senescence)
- Xu et al., 2013 (shortest telomere as the senescence determinant)
- Saretzki, Docke & Lotze, 1995, *Exp. Cell Res.*,
  doi:10.1006/excr.1995.1305, "Mild hyperoxia shortens telomeres and
  inhibits proliferation of fibroblasts: a model for senescence?"
- Tchirkov & Lansdorp, 2003, *Hum. Mol. Genet.*, doi:10.1093/hmg/ddg023,
  "Role of oxidative stress in telomere shortening in cultured fibroblasts
  from normal individuals and patients with ataxia-telangiectasia"
- Cristofari & Lingner, 2006, *EMBO J.*, doi:10.1038/sj.emboj.7600952,
  "Telomere length homeostasis requires that telomerase levels are
  limiting"
- de Lange, 2018, "Shelterin-Mediated Telomere Protection"
- Denchi & de Lange, 2007, "Protection of telomeres through independent
  control of ATM and ATR by TRF2 and POT1"

This is a calibration *check* against literature-reported ranges, not a
parameter re-fit — the model remains a deliberately abstract, coarse-grained
simulation (§1), and none of these anchors change what the model does or
does not claim (`docs/SCIENTIFIC_SCOPE.md`). The qualitative behaviour this
was originally chosen for still holds: a Hayflick-like limit of a few dozen
to ~60 divisions in the unstressed case.

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

### 4.1 Synthetic "biological age" biomarker score

ROADMAP.md candidate feature #5 (the last of the five originally-ranked
candidate simulation features). `simulator/biomarker.py::biological_age_score`
turns a completed `SimulationResult` into ONE relatable, demo-friendly number
on a **0-100 "synthetic age index"** (0 = fully youthful reference state, 100
= fully senescent/collapsed reference state) — computed at every recorded
cycle (`BiologicalAgeScore.score_over_time`, same `(T+1,)` axis as `time`) as
well as at the end (`final_score`), so a running simulation can be watched as
an age number ticking up, not just read off a static terminal value.

**This is a pure, deterministic, post-hoc re-expression of three quantities
already named in §4 above — not a new measurement, not a new simulation
mechanism, and not anything validated against real biology.** It is computed
*after* `simulate()` finishes (`simulator/model.py::_assemble` /
`_failed_result`, a one-line attachment, not part of the per-cycle
arithmetic of §2) and never feeds back into the model, the fitness function,
or any optimizer gene space.

Formula, for every recorded cycle `t`:

```
survival_t   = cumulative AUC of proliferative_count[0..t] / (carrying_capacity · t)
               (clipped to [0, 1]; the same integrand normalized_survival
               integrates over the whole run, evaluated progressively so it
               reduces to that exact terminal value at the last cycle)
reserve_t    = clip((mean_shortest_per_cell[t] − senescence_threshold)
                     / (initial_length − senescence_threshold), 0, 1)
               (identical formula to normalized_telomere_reserve, evaluated
               at every cycle instead of only the last one)
non_senesc_t = 1 − senescent_fraction[t]           (complement of final_senescent_fraction)

vitality_t   = mean(survival_t, reserve_t, non_senesc_t)     -- equal weights
age_index_t  = 100 · (1 − vitality_t)                        -- clipped [0, 100]
```

An extinct culture at cycle `t` (`population_size[t] == 0`) is forced to
`age_index_t = 100` regardless of the formula above — a culture that has
ended is, by construction, at the fully senescent/collapsed end of the
scale, even though the *cumulative* survival term can still be positive from
cycles when the culture was alive. `final_score` equals `score_over_time` at
the last recorded cycle, which by construction equals the same weighted
combination of the three *terminal* metrics named in §4
(`normalized_survival`, `normalized_telomere_reserve`,
`final_senescent_fraction`) — this function invents no new underlying
measurement.

Each of the three terms is chosen because it is already a first-class,
documented output of this model (§4): survival is the strongest "still
young and dividing" signal the model has; telomere reserve is the buffer
remaining before the model's own senescence trigger; senescent fraction is
the direct population-level readout of the terminal state. Deterministic
and pure (no RNG): the same `SimulationResult` in always gives the same
score out.

**Explicitly not modelled.** This is **not** a validated biological-age
clock (e.g. an epigenetic/methylation clock), not a claim about lifespan or
disease risk, and not fit to any real dataset — a documented, transparent
arithmetic function of numbers this simulation already produced (see
`docs/SCIENTIFIC_SCOPE.md`). An invalid `SimulationResult` (`valid=False`)
never crashes or produces NaN: `biological_age_score` returns an explicitly
flagged empty score (`valid=False`, `final_score=None`,
`score_over_time=[]`) instead.

**Output.** `SimulationResult.biological_age` carries a `BiologicalAgeScore`
(`score_over_time`, `final_score`, `scale_label`, `formula_note`, `valid`);
exported in `to_json_dict()`. `formula_note`/`scale_label` are short,
machine-readable strings safe to surface verbatim as a UI caption/tooltip.

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
cycles           = culture_days / doubling_time_days   (Sec 6.1: per-condition, not a global 1 day)
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

### 6.1 Literature check against physical chip data (2026-09-12)

Two of the mapping's numbers describe a real, measurable physical quantity
and were checked against the literature (web search, human-reviewed); the
rest (the `0.35`/`0.55`/`0.25`/`0.15`/`0.10`/`0.30`/`0.20` weights) are
**not** checkable the same way — `stress_level` and `repair_rate` are this
model's own unitless `[0, 1]` abstractions, not quantities any chip paper
reports a number for, so those remain a documented modelling choice, same as
before this check.

**Oxygen tension anchors** — the `0.05` "physioxia" reference and the chip
presets' `oxygen_tension` values hold up well:
- General physioxia (most tissues) is commonly reported as ~3–10% O₂
  (pO₂ ≈ 23–70 mmHg) — the model's `0.05` (5%) sits inside this band.
- Liver tissue pO₂ ≈ 46 mmHg ≈ 6% O₂ — matches `liver_chip_like`'s
  `oxygen_tension=0.06` closely.
- Intestinal wall pO₂ spans a steep gradient: ~6% in the vascularized
  submucosa down to <2% at the crypt–lumen interface and ~3% at the villus
  tip — `gut_chip_like`'s `oxygen_tension=0.08` is the right order of
  magnitude but on the high side of most of this range; the preset doesn't
  attempt to model the gradient itself.
- Lung alveolar pO₂ ≈ 100–110 mmHg ≈ 13–14% O₂ on the tissue/blood side —
  `lung_chip_like`'s `oxygen_tension=0.21` (atmospheric) doesn't match that
  number directly, but is defensible for a different reason: an
  air-liquid-interface lung-chip's apical epithelial surface is exposed to
  inhaled air (~21% O₂) directly, not the blood-side tissue value. Framed as
  "the air-facing side," not "lung tissue," 0.21 is reasonable; framed as
  "lung tissue pO₂," it is not — worth keeping this distinction in mind
  when reading the preset's label.

**Doubling time** — originally a single global `ASSUMED_DOUBLING_TIME_DAYS =
1.0` applied to every chip preset; the literature said this should not be
one number, so `ChipConditions` gained a per-condition `doubling_time_days`
field (2026-09-12, still defaulting to 1.0 for custom/unset conditions) and
each named preset now sets its own:
- `static_well` / `injury_stress_chip_like` → **1.0 day**. Human dermal
  fibroblasts in standard culture double in ~18–24 h — matches closely, and
  both presets are fibroblast-like in framing (no organ-specific slow
  tissue implied).
- `liver_chip_like` → **4.5 days**. Primary hepatocyte/liver-organoid
  cultures report doubling times of ~3.5–5.8 days depending on
  passage/duration; 4.5 is the midpoint of that range, not a single
  literature value.
- `gut_chip_like` → **8.0 days**. Intestinal organoids typically take
  ~7–10+ days to the next split/maturity; 8 is the middle of that range.
- `lung_chip_like` → **2.0 days**. Airway epithelial cells in their
  expansion phase report ~1–2 days per population doubling; note the
  literature also says *mature, differentiated* air-liquid-interface
  epithelium becomes far less proliferative than this once established —
  this constant represents the expansion-phase rate, not the fully
  differentiated state, which is a narrower but still real gap (unlike the
  liver/gut numbers, which have a single well-supported range).

**What changed**: `cycles = culture_days / doubling_time_days` is now
per-condition instead of a hardcoded `/ 1`. Before this fix,
`liver_chip_like`/`gut_chip_like` ran 4–8× too many simulated cell
divisions for a given `culture_days` relative to the tissue they're framed
around; the same nominal `culture_days` now produces a `cycles` count
appropriate to each preset's assumed cell type. This changes the recorded
`cycles` (and therefore population dynamics) for these two presets relative
to any run made before 2026-09-12 — a deliberate, documented behavior
change, not a silent one. `stress_level`/`repair_rate` formulas and every
other coefficient are unaffected.

## 7. Known simplifications

* No cell-cycle arrest heterogeneity, no DNA-damage checkpoints beyond
  the single length threshold, no apoptosis of proliferative cells, no
  crisis/ALT escape, no chromosome-specific telomere lengths, no
  asymmetric inheritance of sister-chromatid ends. The literature (§3.1)
  says the *shortest* telomere's protection state, not a fixed length
  alone, actually governs the trigger — the single scalar threshold here
  is a deliberate simplification of that.
* Stress and repair are scalar abstractions (optionally piecewise constant
  in time, §2.1 — no continuous dose–response dynamics or lag).
* Maintenance is a phenomenological gain, not a telomerase kinetic model
  (§3.1: the literature reports telomerase elongation under experimental
  overexpression, not a physiological per-division rate this could be
  fitted to).
* Passaging is state-blind random sub-sampling.
* Sub-clones (§2.2) are abstract parameter variants sharing one culture's
  environment/schedule, not a model of mutation, drift, or real genetic
  heterogeneity — see `docs/SCIENTIFIC_SCOPE.md`.

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
`tests/test_subclones.py` checks sub-clone competition (§2.2): schema
validation (fraction sum, clone count, override keys/bounds), bit-identity of
an unset `subclones` config against the same golden fixture, `clone_fraction`
summing to ~1.0 of the living population at every non-extinct cycle, a
resilient-vs-fragile competition scenario where the higher-maintenance/
repair clone's share measurably increases, the extinction edge case, and
composition with an active schedule.
`tests/test_biological_age.py` checks the synthetic "biological age"
biomarker score (§4.1): a youthful configuration scores near the youthful
end and a heavily-stressed/senescent-by-end one scores near the senescent
end, the score's front-half/back-half trend over a declining-health
trajectory, `score_over_time` length matches `time`, an invalid result
returns an explicit empty/`valid=False` score rather than crashing or NaN,
an extinct culture saturates every post-extinction cycle at exactly 100,
determinism (same input twice → identical output), and the [0, 100] bound.
