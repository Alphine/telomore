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
    keep evolution runs interactive. The GUI allows up to 92.
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

## 3. Parameters

| Name | Default | Range | Unit | Kind |
|---|---|---|---|---|
| `initial_length` | 7500 | 3000–15000 | bp | initial condition |
| `initial_length_sd` | 800 | 0–3000 | bp | initial condition |
| `population_size` | 100 | ≥1 | cells | initial condition |
| `carrying_capacity` | 400 | ≥population | cells | structure |
| `telomeres_per_cell` | 32 | 1–92 | – | structure |
| `shortening_rate` | 55 | 10–200 | bp/cycle | model |
| `stress_level` | 0.40 | 0–1 | a.u. | model (evolvable) |
| `stress_sensitivity` | 100 | 0–300 | bp/cycle | model |
| `maintenance_rate` | 0.20 | 0–1 | a.u. | model (evolvable) |
| `maintenance_max_gain` | 120 | 0–300 | bp/cycle | model |
| `repair_rate` | 0.20 | 0–1 | a.u. | model (evolvable) |
| `senescence_threshold` | 3000 | 500–6000 | bp | model (evolvable) |
| `noise_sd` | 30 | 0–200 | bp | randomness |
| `senescent_death_rate` | 0.03 | 0–0.5 | 1/cycle | model |
| `cycles` | 120 | ≥1 | cycles | run control |
| `seed` | 42 | – | – | randomness |

Evolvable genes (SDD §12): `initial_length`, `shortening_rate`,
`stress_level`, `maintenance_rate`, `repair_rate`, `senescence_threshold`.
The default experiment frees only the three "culture-condition" genes.

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
        − w_cost        · ½ (maintenance_rate² + repair_rate²)
```

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
| `cost` | min | ½(maintenance² + repair²) |

NSGA-II (Deb et al., 2002): fast non-dominated sort, crowding distance,
binary tournament on (rank, crowding), (μ+λ) survival with the last front
truncated by crowding. Operators, gene domains and bound repair are shared
with the GA. Because every objective is bounded in [0, 1], the 2-D
hypervolume is computed against the fixed nadir (worst corner) and is
comparable across runs. Invalid simulations are placed at a dominated
sentinel point and never enter the front. The scalar fitness is still
reported per front member for reference only.

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
**not calibrated to any dataset** and the GUI labels them as derived
simulation parameters.

## 7. Known simplifications

* No cell-cycle arrest heterogeneity, no DNA-damage checkpoints beyond
  the single length threshold, no apoptosis of proliferative cells, no
  crisis/ALT escape, no chromosome-specific telomere lengths, no
  asymmetric inheritance of sister-chromatid ends.
* Stress and repair are scalar abstractions.
* Maintenance is a phenomenological gain, not a telomerase kinetic model.
* Passaging is state-blind random sub-sampling.

## 8. Software validation

`tests/test_simulator.py` checks: bounds, deterministic seeding,
monotone shortening without maintenance, qualitative relationships
(faster shortening → earlier senescence; more maintenance → longer
telomeres and less senescence; repair mitigates stress), capacity cap,
maintenance-weight shape, and the <1 s runtime target.
