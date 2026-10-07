# Kaggle Writeup (DRAFT): AI4S Open Innovation: AI for Life Science

> Draft for pasting into the Kaggle form. Every number below is taken from `README.md`, `foci/README.md` or
> `docs/EXPERIMENT_PROTOCOL.md`. Items in [BRACKETS] must be filled in or checked before submitting.

## Title

Telomere Evolution Lab and Foci Lab: an AI-for-science lab that reports what did not work

## Subtitle (one line)

An evolutionary search over a telomere-dynamics model, plus a browser-only tool for real DNA-damage microscopy, built to be checked rather than believed.

## Links

- Live: https://studylab.id/ (landing), https://studylab.id/telomore/ (Telomere Evolution Lab), https://studylab.id/foci/ (Foci Lab)
- Code (MIT): https://github.com/Alphine/telomore
- Demo video: (link to be added once the video is uploaded)

## Summary

Telomeres shorten each time a cell divides, and a cell whose shortest telomere falls below a threshold stops dividing.
We built two connected tools around that idea.

**Telomere Evolution Lab** is a simulator of telomere dynamics (cells x telomeres, per cell cycle) with an AI layer on top.
A genetic algorithm, an NSGA-II multi-objective search and a surrogate-model active learner look for virtual intervention
settings (maintenance, repair, stress) that maximise an explicit, user-weighted objective. It runs on a laptop CPU, with no GPU.

**Foci Lab** is a companion site built on real data: a published genome-wide siRNA screen of 53BP1 DNA-damage foci
(IDR idr0010, Doil et al., *Cell* 2009, CC BY 4.0), with 17,536 genes and 56,832 wells with images. Users can explore the
authors' results, and analyse their own microscopy images **inside the browser**, without uploading them.

This is a computational research prototype. It makes no clinical, diagnostic or anti-ageing claim.

## What we built

### 1. Simulate, evolve, compare

- **Simulate**: every model parameter is editable; interactive charts of length trajectories, senescence and population;
  a 3D telomere view (an illustration rebuilt from summary statistics, not a measured cell).
- **Evolve**: a genetic algorithm with a visible fitness curve. Fitness is
  `0.40 survival + 0.30 telomere reserve - 0.20 senescence - 0.10 instability - 0.30 intervention cost`,
  with the weights configurable. Every candidate is averaged over several simulator seeds.
- **Pareto**: because any weighting is a choice, NSGA-II returns the whole trade-off front, for example survival versus
  intervention cost.
- **Sensitivity and Active Learning**: a one-at-a-time tornado analysis, and a Gaussian-process surrogate with Expected
  Improvement that picks which configuration to test next.
- **Experiments ledger**: every run records its seed, configuration hash, model version and git commit, so it can be repeated.

### 2. Foci Lab: real microscopy, private by design

- Gene explorer, a gene-list test (hypergeometric over-representation and a rank-sum test), a well viewer, and plate mode.
- **Browser compute**: the analysis engine is plain JavaScript (a CPU reference path that is bit-exact with our Python
  counter, plus optional WebGPU with automatic CPU fallback). Images are never uploaded and the server never runs the
  analysis. A Content-Security-Policy with `connect-src 'none'` and a test enforce that no file leaves the machine.
- Results export as CSV together with a provenance JSON (engine version, parameters, SHA-256 of every file).

### 3. Access model

Anonymous visitors see precomputed example runs, clearly labelled "Precomputed example - not live compute". Live compute is
for Pro accounts approved by an admin, so a public site cannot be used as free compute. Usage logs keep no request bodies and
no raw IP addresses.

## Results, including the negative ones

We treat negative results as results. Fourteen experiments (A to N, plus a re-test L2) are documented in
`docs/EXPERIMENT_PROTOCOL.md`, with the commands to rerun them.

- **Experiment A**: with stress free to evolve, the genetic algorithm moves fitness from -0.13 to +0.63.
- **Experiment B**: the NSGA-II front shows that A's answer overspends on intervention cost to gain reserve, not survival.
- **Experiment C**: with stress **locked** (a stressor the experimenter cannot remove, the more realistic case), the front
  shows a genuine maintenance/repair trade-off, and locking recovers 84 % of A's improvement using only real interventions.
- **Experiment D**: a structural, model-to-model comparison with the published yeast model `anais-rat/telomeres`. It is
  explicitly **not** a validation against data.
- **Experiment E (negative)**: letting the optimiser time its interventions as a 6-phase protocol, with stress locked, buys
  essentially nothing. The best protocol beats the best constant by +0.0001 +/- 0.001 on five held-out seeds (within seed
  noise) at 64 % more simulator evaluations. This is "no benefit found at this budget", not "no benefit exists".
- **Experiment J (negative)**: we expected the Gaussian-process active learner to degrade faster than the genetic algorithm
  as the search space grows. It did not. Across 3 to 31 genes at a fixed budget of 144 simulator calls, the learner's
  variance was the lowest at every level, and the genetic algorithm was the less robust method once per-phase schedule genes
  were added. Only 3 optimizer seeds per cell, so this shows a pattern, not precise curves.
- **Experiment L (negative)**: our automatic foci counter does **not** reproduce the authors' published counts. We label it
  an unvalidated illustration and say so on the site.

### A data-pairing observation (strongly supported, not confirmed)

In idr0010 the image of a well agrees with the authors' cell counts only when the image grid is numbered column-major and
joined by `Well Number`, not by well name. On 106 wells the Spearman correlation between our nucleus counts and the authors'
cell counts is 0.71 under column-major pairing, against 0.16 under pairing by IDR well name. Three independent checks
support this. **IDR has not confirmed it**, and it may be a convention we missed. The site therefore defaults to the
column-major pairing, says it is inferred, and keeps the by-name pairing selectable everywhere. Report:
`docs/IDR_PAIRING_REPORT.md`.

### Screen statistics

Per-gene results come from the authors' table, deterministically: a robust per-well score, a Stouffer combined z per gene,
and q-values from an empirical null (the N(0,1) null would call about 1,400 genes, the empirical one 39). A **supported hit**
needs at least two distinct siRNAs, each with |z| > 2 in the same direction, and q < 0.05. That gives 4 decreases and 25
increases. Genes with a single well (4,206) are never called. Two siRNAs against one gene correlate only weakly (Spearman
about 0.11), and the site says so.

## Why this fits "AI for Life Science"

- The AI is used to propose experiments worth testing at the bench first, under an explicit and inspectable objective, not to
  claim biological truth. "Fitness is not biological truth" is stated in the app.
- Reproducibility is built in: a ledger, golden outputs and seeds. About 1,149 automated tests (639 pytest, 251 Vitest,
  259 Node tests for Foci Lab, counted 2026-10-01 per the README) [RE-COUNT before submitting].
- Honesty about limits: no medical advice, no fitting to patient data, an unvalidated counter, and an unconfirmed pairing
  finding, each stated where the result is shown.

## Limitations

- Abstract population model. "Stress", "repair" and "maintenance" are scalar abstractions, not assayed quantities.
- The organ-on-chip mapping is a documented assumption with uncalibrated coefficients.
- No bring-your-own-data import and no parameter fitting yet (see `docs/ROADMAP.md`).
- 53BP1 foci mark DNA breaks in general, not telomeres specifically.
- The foci counter is unvalidated. The optimiser optimises the chosen objective and nothing else.

## Tech stack

Python (NumPy, SciPy, pandas, scikit-learn), FastAPI, React + Vite + TypeScript with Plotly and WebGL, a plain-JavaScript
analysis engine with WebGPU, Railway (backend) and Hostinger (static sites). CPU-only, laptop-friendly.

## Data and licences

Code: MIT. Foci Lab data: IDR idr0010, Doil et al., *Cell* 2009 (doi:10.1016/j.cell.2008.12.041), CC BY 4.0, with
attribution on the site. Gene symbols: HGNC (CC0).

## Checklist before submitting

- [ ] Fill in the video link and check the Kaggle form's required fields, track and deadline.
- [ ] Re-count the tests (`python -m pytest`, `cd frontend && npx vitest run`, `node --test "foci/tests/*.test.mjs"`).
- [ ] Open the live site logged out and confirm the demo banner reads "Precomputed example - not live compute".
- [ ] Make sure no real emails, tokens or `.env` values appear in the video or screenshots.
