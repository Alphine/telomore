# Reference-model comparison: `anais-rat/telomeres`

This directory documents (and lets you reproduce) the Level-3 comparison
against the open-source reference implementation named in the SDD:

- Repository: <https://github.com/anais-rat/telomeres> (commit
  `69191c55768477a8c9dc03e111e5e6b194545b69`, fetched 2026-09-08)
- License: **GPLv3**
- Requires: **Python 3.12** (pinned in its `pyproject.toml`), NumPy, SciPy,
  pandas, matplotlib, seaborn, cma, mpl-axes-aligner, psutil, openpyxl

## Why this code is never imported by `telomere_lab`

`telomere-evolution-lab` is MIT-licensed. GPLv3 is copyleft: importing a
GPLv3 package into an MIT process and distributing the result would make
the combination subject to GPLv3. To keep the two licenses cleanly
separated, `src/telomere_lab/` **never imports anything from `telomeres`**.
Instead:

1. You clone `anais-rat/telomeres` yourself, in its **own** virtual
   environment (Python 3.12, per its `pyproject.toml`).
2. You run `run_reference_hayflick.py` (below) *inside that environment* —
   a separate OS process, not a Python import into this package.
3. That script writes a small JSON file of results (plain numbers, no
   GPLv3 source code) which you copy into
   `experiments/reference_model/reference_hayflick.json` in *this* repo.
4. `scripts/compare_reference_model.py` (MIT, part of this package) reads
   that JSON and our own simulator's output side by side. It never touches
   the reference repository's code.

This is "mere aggregation" (two separately-run programs communicating
through a data file), not a derivative work.

## What the reference model actually is

`anais-rat/telomeres` is **not** a general-purpose telomere simulator with
tunable "stress/maintenance/repair" knobs like ours. It is the exact,
published, per-chromosome model of **replicative senescence in
telomerase-negative *Saccharomyces cerevisiae*** (budding yeast without
telomerase), fit to single-cell time-lapse data (Rat et al., *Nat Commun*
2025). Concretely (`telomeres/model/parameters.py`):

- 16 chromosomes × 2 ends = 32 telomeres per cell (same count as our
  default `telomeres_per_cell=32`, coincidentally).
- Constant shortening of `OVERHANG = 7` bp per division (no telomerase —
  there is no maintenance term at all; this model *is* the "maintenance
  = 0" case by construction).
- Senescence is **not** a fixed length threshold. It is a *stochastic*,
  per-cycle probability that depends on the cell's shortest telomere and
  its type (A/B, with non-terminal-arrest transitions between them):
  `p_sen(l) = 1` if `l ≤ l_min` (≈27 bp), else `b·exp(-a·l)`, with two
  different fitted `(a, b)` pairs for type A and type B cells. Type-B
  cells additionally carry a near-length-independent senescence
  probability once they've entered that state, and cells can undergo
  "non-terminal arrests" (temporary cycle arrest, `p_nta(l)`) before
  senescence proper.
- Population dynamics use real time (minutes/days), stochastic cycle
  durations per cell type, and periodic dilution to a saturation
  concentration — a chemostat-style culture model, not our discrete
  synchronous-cycle + carrying-capacity model.

**Practical consequence.** A literal side-by-side plot on the same axes
would compare a generic, abstract, human-inspired demo model against a
specific, richly-parameterised, experimentally calibrated yeast model —
different organism, different telomere-count-to-length scale (yeast
telomeres are ~300 bp; our defaults are human-scale kb), different
senescence mechanism (probabilistic multi-pathway vs. deterministic
threshold). The comparison in
`docs/EXPERIMENT_PROTOCOL.md` (Experiment D) is therefore **structural
and distributional** (shape of the generations-to-senescence
distribution), not a numeric overlay, and is labelled throughout as a
**model-to-model comparison**, not validation of either model.

## Reproducing the reference-model run

```bash
git clone https://github.com/anais-rat/telomeres.git
cd telomeres
git sparse-checkout set telomeres main makeFile data/processed   # skip data_finalCut/ (long paths, unrelated raw data)
python3.12 -m venv .venv312
.venv312/Scripts/activate  # or source .venv312/bin/activate on Linux/macOS
pip install numpy==2.3.3 scipy==1.16.2 pandas==2.3.2 matplotlib seaborn cma mpl-axes-aligner psutil openpyxl
cp <this-repo>/scripts/reference_model/run_reference_hayflick.py .
python run_reference_hayflick.py
cp reference_hayflick.json <this-repo>/experiments/reference_model/
```

> **Windows note.** If imports fail with
> `ModuleNotFoundError: No module named 'scipy.optimize._trustregion_constr...'`
> even though the file exists on disk, the checkout/venv path is too long
> for Windows' classic `MAX_PATH` (260 chars). Move the clone and venv to a
> short path (e.g. `C:\tmp\telomeres`) and retry — this is a Windows path
> limitation, not a package bug.

Then, back in *this* repo's own environment:

```bash
python scripts/compare_reference_model.py
```
