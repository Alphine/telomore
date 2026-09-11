# SCIENTIFIC_SCOPE.md

> The system explores behaviour within a computational model and does not
> provide medical advice, clinical predictions, or validated therapeutic
> recommendations.

## What this project is

An **AI-for-Science demonstration**: an evolutionary optimiser searches the
parameter space of a lightweight, stochastic telomere-population model for
virtual experiment conditions that maximise an explicit, user-defined
objective. The contribution is the *observable virtual-experimentation
loop* (hypothesis → parameter genome → simulation → outcome → fitness →
selection), with every result reproducible from seed + configuration.

## What this project is not

* Not a predictor of human lifespan, disease risk or treatment response.
* Not a model of any individual patient.
* Not a validated model of organ-on-a-chip physiology.
* Not a molecular-dynamics or telomerase-kinetics model.
* Not evidence that any real intervention extends telomeres or lifespan.

Parameters called "maintenance", "repair" or "stress" are abstract model
knobs. The optimiser identifies *parameter configurations that optimise the
chosen objective within the simulation* — nothing more. The same holds for
time-varying **protocols** (`MODEL.md` §2.1): an "optimised protocol" or a
"fasting-like schedule" is a piecewise-constant sequence of model
parameters that scored well under the stated objective in the simulation —
not a dosing regimen, a fasting recommendation, or evidence about any real
intermittent intervention.

## Validation levels (SDD §22)

| Level | Status | Where |
|---|---|---|
| 1 Software correctness | done | `tests/` (bounds, seeds, transitions, metrics) |
| 2 Internal consistency | done | `tests/test_simulator.py` qualitative relationships |
| 3 Reference-model comparison | **done (illustrative, not validation)** | `docs/EXPERIMENT_PROTOCOL.md` Experiment D |
| 4 Literature alignment | partial | `MODEL.md` §3, §7 (assumptions and simplifications listed) |

### Reference model

`anais-rat/telomeres` (https://github.com/anais-rat/telomeres, commit
`69191c55768477a8c9dc03e111e5e6b194545b69`, GPLv3) is the published model
of replicative senescence in telomerase-negative yeast, with
parameter-estimation workflows fit to single-cell data. It has been:

1. cloned and inspected (repository commit and GPLv3 license recorded);
2. run in its own isolated Python 3.12 environment (never imported into
   this MIT-licensed package — see `scripts/reference_model/README.md`);
3. compared against our model on matched initial conditions (80 founders,
   same seed), on the one dimensionless quantity valid in both models: the
   distribution of generations-to-senescence-onset per founding cell;
4. labelled throughout as a **model-to-model comparison**, not validation
   of either model — see `docs/EXPERIMENT_PROTOCOL.md` Experiment D for
   the numbers and their interpretation, including where the two models'
   variability genuinely differs and why.

The in-process `PublishedTelomereModelAdapter` remains a documented stub
by design (`adapters/published_model.py`): the reference model is
structurally different enough (different organism, per-chromosome state,
stochastic senescence trigger vs. our deterministic threshold) that
wrapping it behind `ModelConfig` would misrepresent it as
parameter-compatible with `SimpleTelomereModel`, which it is not.

## Fitness ≠ biological truth

The fitness function is printed on the Evolve page (`/evolve`) with its
weights. It is a design choice. Changing weights changes which
configurations "win". The Compare page (`/compare`) shows the composition of
every scenario's fitness so that the trade-off the optimiser exploited is
visible.

The multi-objective (NSGA-II) Pareto page (`/pareto`) removes the weights
altogether and reports the Pareto front. That answers "which trade-offs does the model
permit?" — it still does not say which trade-off is biologically right.

## Language policy

Avoid: "AI discovered how to extend lifespan", "optimal therapy",
"prevents ageing", "optimal dosing regimen", "fasting protocol that works".
Prefer: "AI identified parameter configurations that optimise the chosen
objective within the simulation", "model output", "simulation parameter",
"scheduled parameter protocol (model result)".

## Organ-on-a-chip bridge

The mapping from chip conditions (flow, oxygen, nutrients, exogenous
stress, duration) to model parameters is a **stated modelling
assumption** with round-number coefficients (MODEL.md §6). It frames the
tool as computational support for *experiment design*, i.e. prioritising
which conditions to test next in vitro. It has not been validated against
any physical chip.

## Sub-clone competition

Sub-clones (`ModelConfig.subclones`, MODEL.md §2.2) are abstract per-cell
parameter variants of the same model competing for shared carrying-capacity
slots, not a model of real genetic heterogeneity, mutation, or clonal
selection.
