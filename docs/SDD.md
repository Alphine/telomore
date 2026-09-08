# Telomere Evolution Lab — Software Design Document (SDD)

**Project:** Telomere Evolution Lab  
**Working name:** `telomere-evolution-lab`  
**Document type:** Software Design Document  
**Status:** MVP blueprint  
**Target event:** Kaggle — AI4S Open Innovation: AI for Life Science  
**Theme:** AI + Organ-on-a-Chip / in-vitro life systems  
**Primary language:** Python  
**UI:** Streamlit + Plotly  
**Execution target:** CPU-first, laptop-friendly  
**Scientific scope:** Computational research prototype; not a clinical or therapeutic decision system.

---

## 1. Executive Summary

Telomere Evolution Lab is an interactive computational laboratory for exploring telomere dynamics and demonstrating how an evolutionary AI system can search a biological parameter space.

The system combines:

1. A lightweight telomere population/lineage simulation engine.
2. An interactive browser GUI.
3. Parameter sweeps and scenario comparison.
4. Evolutionary optimization.
5. Experiment logging and reproducibility.
6. Optional integration of published/open-source telomere models.
7. A scientific visualization layer that makes the search process observable.

The core idea is not to build another generic biology chatbot.

The project demonstrates an **AI-driven virtual experimentation loop**:

```text
Biological hypothesis / target
            ↓
      parameter genome
            ↓
    telomere simulation
            ↓
    biological outcomes
            ↓
       fitness score
            ↓
 mutation / selection
            ↓
      next generation
            ↺
```

The interface exposes the simulation and evolutionary search so a researcher/judge can interactively inspect the relationship between assumptions, parameters, simulated outcomes, and optimization.

The MVP is deliberately lightweight. It avoids molecular-dynamics workloads such as atomistic or coarse-grained simulations and instead uses mathematical/stochastic models that can run repeatedly on CPU.

---

## 2. Motivation

Telomere dynamics are useful as a compact demonstration problem because the system has:

- measurable state variables,
- time-dependent dynamics,
- multiple interacting parameters,
- stochastic behavior,
- trade-offs,
- and a natural optimization/search problem.

A computational model associated with published telomere work is already available as open-source code on GitHub, providing a potential scientific reference/validation model rather than requiring us to invent every biological assumption from scratch.

Reference repository:

- `anais-rat/telomeres` — simulation of cell populations and lineages during replicative senescence, including code for simulation and parameter estimation.

The project's design therefore follows a **reuse + orchestration + optimization** philosophy:

> Build the AI experimentation layer around established scientific modeling rather than pretending to replace the underlying biology.

---

## 3. Goals

### 3.1 Primary goals

- Create an interactive telomere simulation application in Python.
- Run the application locally through a browser.
- Allow users to manipulate model parameters interactively.
- Visualize telomere trajectories, distributions, senescence, and population outcomes.
- Implement an evolutionary optimizer that searches simulation parameters.
- Make every optimization run reproducible.
- Compare baseline versus evolved scenarios.
- Produce artifacts suitable for a Kaggle hackathon writeup/demo.
- Keep the core loop fast enough for laptop CPU execution.

### 3.2 Scientific goals

The system should demonstrate:

- how model assumptions influence simulated telomere dynamics;
- how parameter combinations produce different outcomes;
- how an AI search strategy can discover parameter configurations that optimize a defined objective;
- how virtual experiments can reduce the number of candidate conditions requiring downstream investigation.

### 3.3 Product goals

The demo should feel like a **virtual scientific cockpit**, not a static notebook:

```text
┌────────────────────────────────────────────┐
│            TELOMERE EVOLUTION LAB          │
├────────────────────────────────────────────┤
│ Model parameters       │ Live results       │
│ Initial length   7.5kb │ Telomere plot      │
│ Shortening rate  55bp  │ Population plot    │
│ Stress level     0.40  │ Distribution       │
│ Repair rate      0.20  │ Senescence rate    │
│                         │ Fitness             │
├────────────────────────────────────────────┤
│ [Run] [Compare] [Evolve] [Export]          │
└────────────────────────────────────────────┘
```

---

## 4. Non-Goals

The MVP will **not**:

- claim to predict human lifespan;
- claim to prescribe medical treatment;
- model individual patient biology;
- perform clinical risk assessment;
- simulate atoms/molecular dynamics;
- require CUDA/NVIDIA;
- require an AMD GPU;
- require paid proprietary scientific software;
- depend on NUPACK;
- depend on oxDNA;
- build physical organ-on-a-chip hardware;
- attempt to reproduce all mechanisms of human telomere biology.

Any biological intervention terminology in the UI must be clearly labeled as a **simulation parameter/scenario**, not a recommendation.

---

## 5. Design Principles

### 5.1 CPU-first

The simulator must run on an ordinary laptop.

Target:

```text
one simulation:
< 1 second for default MVP configuration

small evolutionary search:
seconds to a few minutes

large experiment:
optional Kaggle/cloud execution
```

Actual performance must be measured rather than assumed.

### 5.2 Scientific transparency

Every result must be traceable to:

```text
model version
+ parameter configuration
+ random seed
+ optimizer configuration
+ code commit
```

### 5.3 Reproducibility

The same seed and configuration should produce the same deterministic result, or an explicitly controlled stochastic result.

### 5.4 Modular simulation

The simulator must not be tightly coupled to Streamlit.

```text
UI
 ↓
service layer
 ↓
simulation API
 ↓
model implementation
```

This allows the evolutionary optimizer and CLI to use exactly the same simulation engine.

### 5.5 Existing science first

Where possible, reuse/openly reference published models and validated assumptions instead of inventing unsupported biological equations.

### 5.6 Separate model from optimization

The simulator answers:

> What happens under this configuration?

The optimizer answers:

> Which configurations should we test next?

This separation is critical.

---

## 6. High-Level Architecture

```text
                 ┌──────────────────────┐
                 │   Streamlit GUI      │
                 │ sliders / charts     │
                 │ experiment controls  │
                 └──────────┬───────────┘
                            │
                            ▼
                 ┌──────────────────────┐
                 │ Application Services │
                 │ run / compare /      │
                 │ evolve / export      │
                 └──────────┬───────────┘
                            │
             ┌──────────────┼──────────────┐
             ▼              ▼              ▼
       ┌──────────┐   ┌────────────┐  ┌───────────┐
       │ Simulator│   │ Evolution  │  │ Experiment│
       │ Engine   │   │ Engine     │  │ Registry  │
       └────┬─────┘   └─────┬──────┘  └─────┬─────┘
            │               │               │
            └───────────────┼───────────────┘
                            ▼
                    ┌──────────────┐
                    │ Result Store │
                    │ JSON / CSV   │
                    │ figures      │
                    └──────────────┘
```

---

## 7. Technology Stack

### Runtime

- Python 3.11+ target
- NumPy
- SciPy
- Pandas

### Visualization / GUI

- Streamlit
- Plotly

Streamlit is appropriate because it provides interactive widgets such as sliders, buttons, selectors, and state handling directly from Python, and applications are launched with `streamlit run`. Plotly can provide zoomable and hoverable scientific charts.

### Testing

- pytest
- Streamlit AppTest where useful

### Packaging

Preferred:

```text
pyproject.toml
```

Optional environment management:

```text
uv
```

or a standard Python virtual environment.

### Version control

GitHub is the authoritative project backup and version-control system.

Do not place large datasets, generated caches, or large model artifacts in Git.

---

## 8. Repository Structure

```text
telomere-evolution-lab/
│
├── README.md
├── LICENSE
├── pyproject.toml
├── .gitignore
│
├── app/
│   ├── streamlit_app.py
│   ├── pages/
│   │   ├── 01_Simulate.py
│   │   ├── 02_Evolve.py
│   │   ├── 03_Compare.py
│   │   └── 04_Experiments.py
│   └── ui/
│       ├── controls.py
│       ├── charts.py
│       └── components.py
│
├── src/
│   └── telomere_lab/
│       ├── __init__.py
│       ├── config.py
│       ├── schemas.py
│       ├── simulator/
│       │   ├── __init__.py
│       │   ├── model.py
│       │   ├── population.py
│       │   ├── stochastic.py
│       │   └── metrics.py
│       │
│       ├── evolution/
│       │   ├── __init__.py
│       │   ├── genome.py
│       │   ├── population.py
│       │   ├── selection.py
│       │   ├── mutation.py
│       │   ├── crossover.py
│       │   └── engine.py
│       │
│       ├── experiments/
│       │   ├── registry.py
│       │   ├── runner.py
│       │   └── artifacts.py
│       │
│       └── adapters/
│           └── published_model.py
│
├── configs/
│   ├── default.yaml
│   ├── demo.yaml
│   └── evolution.yaml
│
├── experiments/
│   ├── runs/
│   └── reports/
│
├── tests/
│   ├── test_simulator.py
│   ├── test_metrics.py
│   ├── test_evolution.py
│   └── test_app.py
│
├── scripts/
│   ├── run_simulation.py
│   ├── run_evolution.py
│   └── benchmark.py
│
└── docs/
    ├── SDD.md
    ├── MODEL.md
    ├── SCIENTIFIC_SCOPE.md
    └── EXPERIMENT_PROTOCOL.md
```

---

## 9. Core Simulation Model

The MVP uses an abstract telomere dynamics model.

A cell contains a population of telomere lengths:

```text
L = [L1, L2, ..., Ln]
```

At each simulated cell cycle, telomeres can change through simplified processes such as:

- replication-associated shortening;
- stress-dependent shortening;
- repair/maintenance;
- optional telomerase-like maintenance parameter;
- stochastic variation;
- senescence trigger.

A simplified conceptual equation:

```text
L_next =
L_current
- replication_loss
- stress_loss
+ maintenance_gain
+ stochastic_term
```

The exact equations and parameter ranges must be documented in `MODEL.md`.

The MVP should distinguish between:

1. **Model parameters** — assumptions governing biological dynamics.
2. **Initial conditions** — starting state.
3. **Randomness** — stochastic variation.
4. **Optimization variables** — parameters the evolutionary algorithm is allowed to modify.
5. **Evaluation metrics** — outputs used to calculate fitness.

---

## 10. Simulation State

A simulation run should produce a structured result such as:

```python
SimulationResult(
    seed=42,
    time=np.ndarray,
    population_telomere_lengths=np.ndarray,
    mean_length=np.ndarray,
    median_length=np.ndarray,
    shortest_length=np.ndarray,
    senescent_fraction=np.ndarray,
    population_size=np.ndarray,
    terminal_metrics={...},
)
```

Optional additional metrics:

- minimum telomere length;
- percentile distribution;
- fraction below threshold;
- number of senescent cells;
- lineage depth;
- population growth/decline;
- variability across cells.

---

## 11. Initial Parameter Set

The MVP should expose a small, interpretable number of parameters.

Example:

```text
initial_telomere_length
replication_shortening_rate
stress_level
stress_sensitivity
maintenance_rate
repair_rate
senescence_threshold
population_size
simulation_cycles
random_seed
```

Do not expose dozens of parameters initially.

The goal is to make the causal relationship understandable.

---

## 12. Parameter Genome

The evolutionary system represents a candidate experiment/model configuration as a genome:

```text
Genome
├── initial_length
├── shortening_rate
├── stress_level
├── maintenance_rate
├── repair_rate
└── threshold
```

Each gene has:

- valid domain;
- type;
- step size or mutation scale;
- optional scientific constraint.

Example:

```python
Gene(
    name="stress_level",
    minimum=0.0,
    maximum=1.0,
    mutation_sigma=0.10,
)
```

The optimizer must never produce values outside permitted bounds.

---

## 13. Fitness Function

The fitness function must be explicit and configurable.

Example conceptual objective:

```text
maximize healthy simulated population persistence
while minimizing excessive parameter cost / instability
```

Possible normalized objective:

```text
fitness =
    w1 * normalized_survival
  + w2 * normalized_telomere_reserve
  - w3 * senescence_fraction
  - w4 * instability_penalty
```

The weights should be user-configurable for research demonstrations.

The demo must clearly show:

```text
Fitness ≠ biological truth
```

Fitness is an optimization objective defined by the experimenter.

### Important constraint

The project should avoid presenting the optimizer as discovering a medically optimal intervention. It is optimizing the **chosen computational objective under the chosen model assumptions**.

---

## 14. Evolutionary Algorithm

Initial implementation:

```text
1. initialize population
2. evaluate all genomes
3. rank by fitness
4. retain elites
5. select parents
6. crossover
7. mutate
8. repair invalid genomes
9. evaluate next generation
10. repeat
11. return best candidates
```

Recommended MVP algorithm:

- population: 32–128 candidates;
- elite fraction: 5–15%;
- mutation: Gaussian for continuous variables;
- crossover: uniform or arithmetic;
- early stopping: configurable;
- random seed: required.

Future options:

- differential evolution;
- CMA-ES;
- Bayesian optimization;
- multi-objective optimization;
- reinforcement learning.

Do not implement all algorithms in MVP.

---

## 15. Why Evolutionary Search

Evolutionary search is a good fit because the virtual experiment has:

```text
candidate parameters
       ↓
expensive black-box simulation
       ↓
scalar fitness
```

The simulator does not need to be differentiable.

The optimizer can therefore treat the scientific model as a black box.

---

## 16. Interactive GUI

### Page 1 — Simulate

Purpose: inspect a single virtual experiment.

Controls:

```text
Initial telomere length
Shortening rate
Stress
Maintenance
Repair
Senescence threshold
Population size
Cycles
Random seed
```

Actions:

```text
[Run Simulation]
[Reset]
[Export JSON]
[Export CSV]
```

Charts:

1. mean / median / minimum telomere length over time;
2. telomere-length distribution;
3. senescent fraction over time;
4. population size over time.

---

### Page 2 — Evolve

Purpose: run the evolutionary optimizer.

Controls:

```text
Population size
Generations
Mutation rate
Mutation sigma
Elite fraction
Fitness weights
Random seed
```

Actions:

```text
[Evolve]
[Stop]
[Export Results]
```

Charts:

```text
Best fitness by generation
Mean fitness by generation
Diversity by generation
Best parameter trajectory
```

Table:

```text
Rank | Fitness | Stress | Maintenance | Repair | ...
```

---

### Page 3 — Compare

Compare:

```text
Baseline
vs
Best evolved candidate
vs
User-selected candidate
```

Overlay:

```text
telomere trajectories
senescence trajectories
population trajectories
```

Show deltas:

```text
Fitness: +18.2%
Senescence: -11.4 pp
Minimum telomere reserve: +0.43 kb
```

The UI must clearly label these as **model outputs**.

---

### Page 4 — Experiments

Show a reproducibility ledger:

```text
Run ID
timestamp
git commit
model version
optimizer version
seed
configuration hash
fitness
artifact paths
```

Allow export of a complete experiment bundle.

---

## 17. Interactive UX

The GUI should support:

- sliders;
- numeric inputs;
- dropdowns;
- checkboxes/toggles;
- run buttons;
- interactive Plotly charts;
- data tables;
- download/export controls.

A slider change should not automatically trigger a heavy evolutionary search.

Use forms or explicit run buttons for expensive operations.

For expensive evolution:

```text
user changes parameters
        ↓
[Run Evolution]
        ↓
job executes
        ↓
results appear
```

Streamlit reruns the app when widgets change, so state handling and caching must be designed deliberately.

---

## 18. Performance Architecture

### Fast path

```text
single simulation
↓
NumPy vectorized operations
↓
interactive visualization
```

### Evolution path

```text
generation
↓
N independent simulations
↓
parallel evaluation if needed
↓
fitness aggregation
```

Start with serial execution.

Only add multiprocessing after profiling proves it necessary.

Potential future architecture:

```text
candidate genomes
      ↓
worker pool
 ┌────┼─────┐
 ↓    ↓     ↓
sim  sim   sim
 └────┼─────┘
      ↓
 fitness
```

Do not introduce distributed infrastructure into MVP.

---

## 19. Caching

Two cache categories:

### Safe cache

Cache deterministic simulation results based on:

```text
model_version
parameter_hash
random_seed
simulator_version
```

### UI cache

Cache static reference data and expensive read-only artifacts.

Never cache a stochastic simulation without including the random seed in the cache key.

---

## 20. Experiment Registry

Every experiment receives a unique ID:

```text
TEL-20260907-001
```

Example record:

```json
{
  "run_id": "TEL-20260907-001",
  "model_version": "0.1.0",
  "optimizer_version": "0.1.0",
  "seed": 42,
  "configuration": {},
  "fitness": 0.8234,
  "git_commit": "abc123",
  "created_at": "..."
}
```

---

## 21. Reproducibility

Required metadata for every reported result:

```text
Git commit
Model version
Simulator configuration
Optimizer configuration
Random seed
Python version
Dependency lock/version
Dataset/reference model identifier
Runtime
Hardware description
```

A result in the final writeup must be reproducible from the repository.

---

## 22. Scientific Validation Strategy

The project should not claim that a simplified simulator is biologically validated.

Validation is divided into levels.

### Level 1 — Software correctness

Test:

- parameter bounds;
- deterministic seed behavior;
- state transition logic;
- metric calculations.

### Level 2 — Internal consistency

Test known qualitative relationships:

```text
higher shortening rate
→ generally faster shortening

higher maintenance
→ generally preserves length
```

These are sanity checks, not proof of biological truth.

### Level 3 — Reference-model comparison

Where appropriate, compare selected outputs with an available published/open-source telomere simulation model.

Reference:

`anais-rat/telomeres`

The comparison should be clearly labeled as a model-to-model comparison.

### Level 4 — Literature alignment

Document the biological assumptions and limitations against peer-reviewed literature.

No claim should be stronger than the supporting evidence.

---

## 23. Optional Published Model Adapter

To avoid coupling the application directly to one scientific implementation, create:

```python
class TelomereModelAdapter(Protocol):
    def simulate(self, config: ModelConfig) -> SimulationResult:
        ...
```

Implement:

```text
SimpleTelomereModel
PublishedTelomereModelAdapter
```

The first demo can use the lightweight model.

The adapter can later wrap a published research implementation.

This creates a clean path from:

```text
toy / MVP model
        ↓
reference model
```

without rewriting the GUI or optimizer.

---

## 24. Organ-on-a-Chip Relevance

The event theme is AI + Organ-on-a-Chip.

The project therefore needs an explicit bridge rather than merely presenting a standalone ageing simulator.

Recommended framing:

```text
Organ-on-chip / in-vitro experiment
             ↓
observed stress / culture parameters
             ↓
telomere-related response model
             ↓
virtual experiment
             ↓
AI search
             ↓
candidate next conditions
```

For the MVP, this can remain a **computational abstraction**.

Potential future input layer:

```text
chip condition
├── flow
├── oxygen
├── nutrient state
├── stress exposure
└── culture duration
```

These can be mapped to abstract cellular stress parameters.

This mapping must be explicitly documented as a modeling assumption.

The project must not claim that the virtual model exactly reproduces a physical organ-on-a-chip.

---

## 25. AI Strategy

"AI" should refer to a real computational search component.

Minimum acceptable AI component:

**Evolutionary optimization.**

Optional enhanced components:

- surrogate model to predict fitness;
- active learning;
- Bayesian optimization;
- LLM-generated experiment hypotheses;
- natural-language experiment interface.

However:

> LLM is optional. Evolutionary optimization is the core AI capability.

This prevents the project from becoming dependent on an external API or an expensive model.

---

## 26. Optional LLM Layer

Future phase:

```text
User:
"Find a scenario that preserves telomere reserve
while limiting stress."

          ↓

LLM parses objective

          ↓

Structured optimization target

          ↓

Evolutionary engine

          ↓

Simulation

          ↓

Results

          ↓

LLM explains trade-offs
```

The LLM must not directly invent numeric outputs.

All quantitative claims shown to the user must come from the simulator/experiment registry.

---

## 27. CLI

The core engine must work without the GUI.

### Single simulation

```bash
python scripts/run_simulation.py \
  --config configs/demo.yaml \
  --seed 42
```

### Evolution

```bash
python scripts/run_evolution.py \
  --config configs/evolution.yaml \
  --seed 42
```

### Benchmark

```bash
python scripts/benchmark.py
```

### GUI

```bash
streamlit run app/streamlit_app.py
```

This preserves headless execution for Kaggle and cloud environments.

---

## 28. Data and Artifact Strategy

Do not require a large dataset for the MVP.

Store:

```text
configs/
experiment metadata
reference citations
small example outputs
figures
```

Do not commit:

```text
large generated caches
huge model files
temporary simulation outputs
private credentials
```

For Kaggle:

```text
GitHub
  ↓
code/config
  ↓
Kaggle notebook
  ↓
CPU execution
  ↓
experiment artifacts
  ↓
submission/writeup
```

---

## 29. Testing

### Unit tests

Simulation:

```text
test_initial_conditions
test_bounds
test_deterministic_seed
test_shortening_direction
test_metric_calculation
```

Evolution:

```text
test_genome_bounds
test_mutation_bounds
test_crossover
test_selection
test_convergence_smoke_test
```

### Integration tests

```text
config
 ↓
simulation
 ↓
metrics
 ↓
fitness
 ↓
evolution
```

### GUI tests

Use Streamlit AppTest where practical for:

- page loading;
- required controls;
- simulation button;
- result display;
- export behavior.

---

## 30. Failure Handling

Simulation failures must never silently become high fitness.

Rules:

```text
invalid simulation
      ↓
mark candidate invalid
      ↓
fitness = large negative / explicit failure
      ↓
log reason
```

Examples:

- parameter outside range;
- numerical overflow;
- NaN;
- empty population;
- impossible state.

Optimizer failures must preserve the last valid checkpoint.

---

## 31. Checkpointing

Evolution runs should periodically save:

```text
generation
best genome
best fitness
population
random state
configuration
```

Example:

```text
experiments/runs/TEL-.../
├── config.json
├── generation_010.json
├── generation_020.json
├── best.json
└── summary.csv
```

This allows interrupted runs to resume.

---

## 32. Performance Targets

MVP targets should be measured on the developer laptop.

Suggested acceptance criteria:

```text
GUI starts successfully
single simulation < 1 sec target
32-candidate evolution usable interactively
100+ candidate batch completes without failure
memory remains bounded
no GPU required
```

These are engineering targets, not guarantees.

Actual benchmark numbers must be recorded in the experiment report.

---

## 33. MVP Scope

### M0 — Foundation

Deliver:

- repository;
- environment;
- package structure;
- CLI;
- minimal model;
- tests.

### M1 — Interactive Simulator

Deliver:

- Streamlit GUI;
- sliders;
- Plotly charts;
- scenario export.

### M2 — Evolution Engine

Deliver:

- genome;
- mutation;
- selection;
- crossover;
- fitness;
- generation chart.

### M3 — Scientific Experiment Layer

Deliver:

- baseline vs evolved;
- experiment registry;
- reproducibility metadata;
- reference-model discussion.

### M4 — AI4S Demo

Deliver:

- polished UI;
- 1 compelling scientific narrative;
- one reproducible optimization experiment;
- clear limitations;
- Kaggle writeup;
- demo screenshots/video.

---

## 34. Demo Story

The final demo should not be:

> "Here is my telomere simulator."

It should be:

> "Here is a virtual laboratory where an evolutionary AI searches a telomere-dynamics model for experiment conditions that optimize a defined biological objective."

Recommended flow:

```text
1. Start with baseline
2. Show declining telomere reserve
3. Define an optimization objective
4. Click EVOLVE
5. Show candidate population
6. Show fitness improving
7. Show best candidate
8. Compare baseline vs evolved
9. Inspect parameter trade-offs
10. Export reproducible experiment
```

This tells a complete AI-for-science story.

---

## 35. Example Visual Narrative

Baseline:

```text
Generation 0
Fitness = 0.52
```

Evolution:

```text
Generation 1   0.57
Generation 5   0.66
Generation 10  0.74
Generation 20  0.81
Generation 30  0.84
```

Best candidate:

```text
maintenance_rate     +XX%
stress_level         -XX%
repair_rate          +XX%
fitness              +XX%
```

All numbers shown in the final submission must come from actual runs.

---

## 36. Scientific Safety / Interpretation

This project is a computational demonstration.

All public-facing documentation must include a limitation such as:

> The system explores behavior within a computational model and does not provide medical advice, clinical predictions, or validated therapeutic recommendations.

Do not use language such as:

```text
"AI discovered how to extend human lifespan."
```

Prefer:

```text
"AI identified parameter configurations that optimize the chosen objective within the simulation."
```

---

## 37. Competition Strategy

Because the event is a Community Hackathon focused on AI for life science and Organ-on-a-Chip, the submission should emphasize:

```text
AI
+
scientific modeling
+
virtual experimentation
+
interactive demonstration
+
reproducibility
```

The project should not spend most of its effort on UI polish while neglecting the scientific/optimization loop.

The judging narrative should answer four questions:

### Problem

What experimental/scientific workflow is expensive or difficult?

### Method

How does the computational model represent it?

### AI contribution

What does evolutionary search do that a static simulator does not?

### Evidence

What reproducible experiment demonstrates improvement?

---

## 38. Competitive Differentiation

Weak:

```text
Telomere dashboard
```

Better:

```text
Telomere simulator
```

Strong:

```text
Telomere simulator
+
interactive scientific cockpit
+
evolutionary AI
+
reproducible virtual experiments
```

Best future version:

```text
Organ-on-chip condition model
        +
telomere dynamics
        +
AI experiment planner
        +
evolutionary search
        +
active learning
        +
human-readable explanation
```

---

## 39. Open-Source / Licensing Policy

The implementation must prioritize components with licenses compatible with the project and competition rules.

Before incorporating external code:

1. record repository and version;
2. inspect LICENSE;
3. retain required attribution;
4. document modifications;
5. verify that commercial/use/distribution restrictions are compatible.

Do not make NUPACK or oxDNA a core dependency of the MVP.

The current design is intentionally centered on Python, NumPy/SciPy, Streamlit, Plotly, and an openly accessible telomere-model reference repository.

---

## 40. Risks

### Risk: Model is scientifically too simple

Mitigation:

- document assumptions;
- compare with published model where possible;
- add stochastic population dynamics;
- avoid exaggerated claims.

### Risk: Evolution optimizes the wrong thing

Mitigation:

- make fitness transparent;
- show objective weights;
- show Pareto/trade-off views later;
- include baseline comparison.

### Risk: UI looks impressive but has little scientific substance

Mitigation:

- prioritize reproducible experiment evidence;
- expose equations/assumptions;
- export configs and seeds.

### Risk: Evolution becomes too slow

Mitigation:

- vectorize;
- benchmark;
- reduce population/generations;
- add parallel evaluation only if necessary.

### Risk: Competition theme alignment is weak

Mitigation:

- explicitly connect virtual parameters to in-vitro / organ-on-chip experimental conditions;
- frame as computational support for experiment design;
- avoid claiming direct physical-chip validation unless actually performed.

---

## 41. Future Roadmap

### V0.1

```text
simple simulator
+
GUI
+
evolution
```

### V0.2

```text
published-model adapter
+
parameter sweeps
+
multi-objective optimization
```

### V0.3

```text
organ-on-chip parameter abstraction
+
active learning
```

### V0.4

```text
surrogate model
+
experiment prioritization
```

### V1.0

```text
AI scientific experimentation platform
```

---

## 42. Final Product Positioning

**Telomere Evolution Lab** is:

> **A lightweight, interactive AI-for-Science laboratory where evolutionary algorithms explore telomere-dynamics models and propose candidate virtual experiments under explicit scientific objectives.**

Product metaphor:

```text
Jupyter
   +
scientific dashboard
   +
evolutionary optimizer
   +
virtual laboratory
```

One-liner:

> **Simulate. Evolve. Compare. Learn.**

---

## 43. Acceptance Criteria

The MVP is considered complete when:

- [ ] `streamlit run app/streamlit_app.py` launches locally.
- [ ] A user can run a telomere simulation from the browser.
- [ ] At least four interactive charts are available.
- [ ] A user can export simulation results.
- [ ] Evolutionary search can optimize a defined objective.
- [ ] Best fitness improves in a smoke-test benchmark.
- [ ] All candidate parameters remain in valid ranges.
- [ ] Every run records a seed and configuration.
- [ ] CLI can reproduce the same simulation.
- [ ] Unit tests pass.
- [ ] No GPU is required.
- [ ] README explains scientific limitations.
- [ ] A baseline-vs-evolved experiment is reproducible.
- [ ] The event submission can point to the repository and demo artifacts.

---

## 44. Immediate Build Order

Build in this exact order:

```text
1. simulator/model.py
2. simulator/metrics.py
3. schemas.py
4. CLI simulation
5. Streamlit Simulate page
6. evolution/genome.py
7. evolution/engine.py
8. CLI evolution
9. Streamlit Evolve page
10. experiment registry
11. Compare page
12. published-model adapter
13. organ-on-chip mapping
14. final demo + writeup
```

Do not start with LLM integration.

Do not start with React.

Do not start with molecular dynamics.

Do not start with a complex database.

The first milestone is:

```text
CPU laptop
   ↓
simulate
   ↓
visualize
   ↓
evolve
   ↓
compare
```

That is the core product.

---

## 45. References

- Kaggle — **AI4S Open Innovation: AI for Life Science**, themed around AI + Organ-on-a-Chip and currently listed as a Community Hackathon with a $22,200 prize pool. citeturn359694search0
- Streamlit documentation — interactive Python applications, widgets, forms, and browser-based app execution. citeturn359694search1turn359694search2turn359694search3
- `anais-rat/telomeres` — open-source code associated with simulation of cell populations and lineages during replicative senescence, including simulation/parameter-estimation workflows. citeturn359694search9

---

## 46. Status

**Architecture:** Approved for MVP planning  
**Compute strategy:** CPU-first  
**GPU dependency:** None  
**Primary UI:** Streamlit  
**Primary visualization:** Plotly  
**Primary AI:** Evolutionary optimization  
**Scientific engine:** Lightweight mathematical/stochastic model with optional published-model adapter  
**Target:** AI4S Open Innovation hackathon prototype  
