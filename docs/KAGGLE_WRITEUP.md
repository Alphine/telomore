# Kaggle Writeup: AI4S Open Innovation: AI for Life Science

Structure follows the competition's recommended layout (category first, demo video, code repository, 200-300 word summary,
technical report, optional demo link, team). Every number comes from `README.md`, `foci/README.md` or
`docs/EXPERIMENT_PROTOCOL.md`.

## Title

Telomere Evolution Lab and Foci Lab: a transparent AI-for-science lab that reports what did not work

## Submission category

**End-to-End System**

## Demo video

https://youtu.be/YDKOISImczQ

## Public code repository

https://github.com/Alphine/telomore (MIT licence)

## Optional demo links (no login needed)

- Landing page for both labs: https://studylab.id/
- Telomere Evolution Lab (anonymous visitors see precomputed example runs, clearly labelled): https://studylab.id/telomore/
- Foci Lab (real IDR microscopy, in-browser analysis, sample images built in): https://studylab.id/foci/ and https://studylab.id/foci/lab.html

## Project summary

Telomeres shorten each time a cell divides, and a cell whose shortest telomere falls below a threshold stops dividing.
Long-term cultures, such as the in vitro systems used in organ-on-a-chip work, are shaped by this process, but choosing
which culture conditions to test is a costly search. We built an end-to-end system with two parts.

**Telomere Evolution Lab** is a telomere-dynamics simulator with an AI search layer: a genetic algorithm, an NSGA-II
multi-objective search and a Gaussian-process active learner propose maintenance, repair and stress settings that optimise an
explicit, user-weighted objective. An optional organ-on-chip condition mapper turns chip culture conditions into model
parameters. Every run is written to a reproducibility ledger (seed, configuration hash, code version).

**Foci Lab** connects the model to real data: the published idr0010 genome-wide siRNA screen of 53BP1 DNA-damage foci
(17,536 genes, 56,832 imaged wells), plus a browser-only image analyser. Your microscopy images never leave your machine; a
Content-Security-Policy and a test enforce it.

The distinctive part is honesty: fourteen documented experiments, including negative results, an unvalidated foci counter
labelled as such, and a data-pairing finding stated as "strongly supported, not confirmed". It runs on a laptop CPU.
No clinical claim is made.

## Technical report

### 1. Problem and application scenario

Cell cultures with limited replicative lifespan are central to in vitro life systems. Their behaviour depends on telomere
shortening, maintenance, repair and stress. Experimenters need a way to rank virtual conditions worth testing at the bench
first, and a way to look at DNA-damage readouts in real images without sending the images away. This is a computational
research prototype, not a diagnostic or predictive clinical tool.

### 2. Data, licences and compliance

- Telomere Lab: no external data; defaults are within literature ranges and are **not fitted** to data.
- Foci Lab: IDR idr0010, Doil et al., *Cell* 2009 (doi:10.1016/j.cell.2008.12.041), licence **CC BY 4.0**, attributed on
  the site and in `foci/web/samples/manifest.json`. Gene symbols: HGNC (CC0).
- No personal, clinical or restricted data. Usage logs of the hosted site keep no request bodies and no raw IP addresses.

### 3. Methods and system architecture

Per cell cycle every proliferative cell divides; each replicated telomere loses a base amount plus stress-dependent loss
scaled by (1 - repair) plus noise, and gains a telomerase-like amount directed to the shortest telomere. A cell becomes
senescent when its shortest telomere falls below a threshold.

```
objective -> parameter genome -> telomere simulation -> outcomes -> fitness -> mutation/selection -> next generation
fitness = 0.40 survival + 0.30 reserve - 0.20 senescence - 0.10 instability - 0.30 intervention cost
```

- Optimisers: genetic algorithm; NSGA-II (Pareto fronts); one-at-a-time sensitivity; Gaussian-process surrogate with
  Expected Improvement. Each candidate is averaged over several simulator seeds.
- Stack: Python (NumPy, SciPy, pandas, scikit-learn), FastAPI backend, React + Vite + TypeScript frontend with WebGL and
  Plotly. Foci Lab is plain JavaScript with a CPU reference path (bit-exact with the Python counter) and optional WebGPU.
- Deployment: anonymous visitors see precomputed JSON scenarios from static hosting (no server compute); live compute is
  limited to approved accounts.

### 4. Experiments and results

All fourteen experiments (A to N, plus a re-test L2) are in `docs/EXPERIMENT_PROTOCOL.md` with the commands to rerun them.

- **A**: with stress free to evolve, fitness moves from -0.13 to +0.63.
- **B**: the NSGA-II front shows that A's answer overspends on intervention cost to gain reserve, not survival.
- **C**: with stress locked (a stressor that cannot be removed), a genuine maintenance/repair trade-off appears and locking
  recovers 84 % of A's improvement using only real interventions.
- **D**: a structural model-to-model comparison with the published yeast model `anais-rat/telomeres`; explicitly not a
  validation against data.
- **E (negative)**: a 6-phase scheduled protocol buys essentially nothing over a constant intervention at locked stress:
  +0.0001 +/- 0.001 on five held-out seeds, within seed noise, at 64 % more simulator evaluations. This is "no benefit found
  at this budget", not "no benefit exists".
- **J (negative)**: we expected the Gaussian-process learner to degrade faster than the genetic algorithm as the search
  space grows. It did not. From 3 to 31 genes at a fixed budget of 144 simulator calls its variance was lowest at every level,
  and the genetic algorithm was the less robust method once per-phase genes were added (3 optimiser seeds per cell).
- **L (negative)**: our automatic foci counter does not reproduce the authors' published counts. It is labelled an
  unvalidated illustration on the site.

**Screen statistics (Foci Lab).** Per-gene results use the authors' table, deterministically: robust per-well scores,
Stouffer combined z per gene and q-values from an empirical null (the N(0,1) null would call about 1,400 genes, the empirical
one 39). A supported hit needs at least two distinct siRNAs with |z| > 2 in the same direction and q < 0.05: 4 decreases
and 25 increases. Single-well genes (4,206) are never called. Two siRNAs against one gene correlate only weakly (Spearman
about 0.11).

**Pairing observation (strongly supported, not confirmed).** In idr0010 the image of a well agrees with the authors' cell
counts only when the image grid is numbered column-major and joined by `Well Number`, not by well name. On 106 wells the
Spearman correlation between our nucleus counts and the authors' cell counts is 0.71 under column-major pairing against 0.16
under pairing by IDR well name. IDR has not confirmed this and it may be a convention we missed, so the site defaults to the
inferred pairing, says so, and keeps both selectable (`docs/IDR_PAIRING_REPORT.md`).

### 5. Reliability analysis and limitations

- Abstract population model; "stress", "repair" and "maintenance" are scalar abstractions, not assayed quantities.
- The organ-on-chip mapping is a documented assumption with uncalibrated coefficients.
- No bring-your-own-data import and no parameter fitting yet (`docs/ROADMAP.md`).
- 53BP1 foci mark DNA breaks in general, not telomeres specifically.
- The foci counter is unvalidated; the optimiser optimises the chosen objective and nothing else.
- Reproducibility: seeds, configuration hashes and golden outputs; about 1,149 automated tests (639 pytest, 251 Vitest,
  259 Node tests for Foci Lab, counted 2026-10-01 per the README). The backend pytest suite passed on a clean install.

### 6. Potential scientific or practical impact

A transparent way to rank candidate culture conditions before bench work, a teaching tool, and a template for AI-for-science
projects that publish negative results next to positive ones.

### 7. Reproduction instructions

Python 3.11+ and Node 22, no GPU, no paid service.

```bash
pip install -e ".[dev]"
python scripts/run_simulation.py --config configs/demo.yaml --seed 42
python scripts/run_evolution.py  --config configs/evolution.yaml --seed 7
python scripts/run_pareto.py     --config configs/pareto.yaml --seed 7
python scripts/run_protocol_experiment.py --seed 7        # Experiment E
python -m pytest
node --test "foci/tests/*.test.mjs"                       # Foci Lab
```

Web app: `uvicorn backend.main:app --port 8000` and `cd frontend && npm install && npm run dev`. Foci Lab is static: serve
`foci/web/` with any static server (no PHP needed for the explorer and the Browser lab; the sample images are in
`foci/web/samples/`).

### 8. Sources and licences of external components

- Code: MIT. Data: IDR idr0010 (CC BY 4.0), HGNC (CC0).
- Libraries: NumPy, SciPy, pandas, scikit-learn, FastAPI, React, Vite, Plotly (their own open-source licences).
- Reference model for Experiment D: `anais-rat/telomeres` (GPLv3), run in an isolated environment so licences never mix.
- AI tools: the code was developed with assistance from Claude Code (Anthropic).

## Team

[TO CONFIRM BY THE TEAM LEADER: names, roles, and whether the team covers both AI/CS and biology expertise (declare it in the
report to be eligible for the +0.5 interpretability bonus). Do not claim expertise that is not there.]
