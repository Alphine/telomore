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
optimiser answers *"which configurations should we test next?"*. The GUI
makes both observable.

## Quick start

```bash
pip install -e ".[dev]"          # or: uv pip install -e ".[dev]"
streamlit run app/streamlit_app.py
```

Headless (same engine, no GUI):

```bash
python scripts/run_simulation.py --config configs/demo.yaml --seed 42
python scripts/run_evolution.py  --config configs/evolution.yaml --seed 7
python scripts/run_pareto.py     --config configs/pareto.yaml --seed 7      # NSGA-II
python scripts/run_evolution.py  --config configs/evolution_locked.yaml --seed 7  # stress locked
python scripts/run_sensitivity.py --config configs/sensitivity.yaml                 # OAT tornado
python scripts/benchmark.py
python scripts/benchmark_optimizers.py                                              # GA vs NSGA-II vs random search
python -m pytest
```

## GUI pages

| Page | Purpose |
|---|---|
| **Simulate** | Sliders for every model parameter (plus an optional organ-on-chip condition mapper). Four interactive Plotly charts: length trajectories, length distribution, senescence, population. JSON/CSV export and reproduction command. |
| **Evolve** | Configure the objective weights and the genetic algorithm, press *Evolve*, watch best/mean fitness, diversity and the best candidate's parameter trajectory generation by generation. Every run is registered. |
| **Pareto** | NSGA-II multi-objective search. Choose two or more objectives (e.g. survival vs. intervention cost) and get the **Pareto front** instead of one weighted winner; hypervolume by generation; send any front point to Compare. |
| **Sensitivity** | One-at-a-time (OAT) sensitivity analysis: perturb each evolvable parameter +/- a fraction of its range around the baseline, one at a time, and read off the fitness swing as a tornado chart — which single knob matters most, holding everything else fixed. |
| **Compare** | Overlay baseline vs. best evolved vs. a user-selected scenario (from the GA population, the Pareto front, or manual sliders) with common random numbers; read the deltas and each scenario's fitness composition. |
| **Experiments** | Reproducibility ledger (run ID, timestamp, git commit, versions, seed, config hash, fitness, artifacts) with one-click bundle download. |

## Model in one paragraph

Each cell carries a set of telomere lengths (bp). Per cell cycle every
proliferative cell divides; each replicated telomere loses
`shortening_rate` + stress-dependent loss × (1 − `repair_rate`) + noise,
and gains a telomerase-like amount directed preferentially to the cell's
shortest telomere. A cell becomes irreversibly senescent when its shortest
telomere falls below `senescence_threshold`; senescent cells stop dividing
and are slowly lost; the culture is passaged back to carrying capacity.
Exact equations, ranges and simplifications: [`docs/MODEL.md`](docs/MODEL.md).

## Fitness (the AI's objective)

```
fitness = 0.40·survival + 0.30·telomere_reserve − 0.20·senescence − 0.10·instability − 0.30·intervention_cost
intervention_cost = ½ (maintenance² + repair²)      # convex: "just enough", not "max everything"
```

Weights are user-configurable in the GUI. **Fitness ≠ biological truth**:
it is the experimenter's objective under the model's assumptions.

Because any weighting is a choice, the **Pareto** page runs NSGA-II on the
raw objectives and returns the whole trade-off front (`docs/MODEL.md` §5.1).

Every candidate's fitness is averaged over multiple simulator seeds
(`eval_seeds`, default `(1, 2, 3)`) rather than a single stochastic draw, so
the GA/NSGA-II/sensitivity analysis are all comparing candidates on a less
noisy estimate of fitness. `scripts/benchmark_optimizers.py` compares GA,
NSGA-II and a budget-matched random search on this same scalar fitness to
sanity-check that evolution is actually beating undirected search.

## Reproducible experiment

See [`docs/EXPERIMENT_PROTOCOL.md`](docs/EXPERIMENT_PROTOCOL.md) for three
reproducible experiments — every number in it comes from an actual run
recorded in `experiments/`:

- **A.** GA, baseline vs. evolved, stress free to evolve — fitness −0.13 → +0.63.
- **B.** NSGA-II Pareto front (survival vs. cost), stress free — reveals that
  A's answer overspends on cost for reserve, not survival.
- **C.** Both optimizers with `stress_level` **locked** (a stressor the
  experimenter cannot remove) — the more realistic case, where the front
  shows a genuine maintenance/repair trade-off and locking recovers 84 % of
  A's improvement using only real interventions.
- **D.** Reference-model comparison against the published, GPLv3
  `anais-rat/telomeres` (telomerase-negative yeast senescence model): our
  model's generations-to-senescence distribution vs. theirs, run in an
  isolated environment so the two licenses never mix
  (`scripts/reference_model/`).

## Repository layout

```
app/            Streamlit GUI (streamlit_app.py + pages/ + ui/)
src/telomere_lab/
  schemas.py    typed configs, bounds, result containers
  simulator/    model.py, population.py, metrics.py, stochastic.py
  evolution/    genome, mutation, crossover, selection, fitness, engine, benchmark
  analysis/     sensitivity (OAT tornado analysis)
  experiments/  registry (ledger), runner (service layer), artifacts
  adapters/     model protocol, published-model stub, organ-on-chip mapping
configs/        default.yaml, demo.yaml, evolution.yaml, sensitivity.yaml
scripts/        run_simulation.py, run_evolution.py, run_sensitivity.py, benchmark.py, benchmark_optimizers.py
tests/          simulator, metrics, evolution, sensitivity, benchmark, Streamlit AppTest
docs/           SDD, MODEL, SCIENTIFIC_SCOPE, EXPERIMENT_PROTOCOL
experiments/    runs/ (ledger + artifacts, git-ignored), reports/
```

## Scientific limitations

* Abstract population model; no telomerase kinetics, checkpoints, ALT,
  apoptosis of cycling cells, chromosome identity or molecular detail.
* "Stress", "repair" and "maintenance" are scalar abstractions.
* The organ-on-chip mapping is a documented assumption with uncalibrated
  coefficients.
* No comparison against the open-source reference model
  (`anais-rat/telomeres`) has been performed yet; the adapter is an
  explicit extension point.
* The optimiser optimises the chosen objective, nothing else.

Full statement: [`docs/SCIENTIFIC_SCOPE.md`](docs/SCIENTIFIC_SCOPE.md).

## Design document

[`docs/SDD.md`](docs/SDD.md) is the software design document this
implementation follows (build order SDD §44).

## License

MIT.
