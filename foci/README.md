# Foci Lab

Companion site to Telomere Evolution Lab, served at **https://studylab.id/foci/**. Telomere Lab itself is at
https://studylab.id/telomore/ (a static build whose API is the Railway backend); https://studylab.id/ is a landing
page for both.
It explores a real, published genome-wide siRNA screen of 53BP1 DNA-damage foci:
IDR study [idr0010](https://idr.openmicroscopy.org/webclient/?show=screen-1351),
Doil et al., *Cell* 2009 (doi:10.1016/j.cell.2008.12.041), licensed **CC BY 4.0**.

| Part | Where | Runs on |
|---|---|---|
| Static site (gene explorer, findings, gallery, Experiment L) | `foci/web/` | Hostinger (studylab.id/foci/) |
| Image proxy + disk cache for any of 56,832 wells | `foci/web/api/well.php` | Hostinger PHP 8.2 |
| Live nucleus outline | `backend/routers/foci.py` → `/api/foci/overlay` | Railway (existing backend) |
| Dataset build (authors' table, per-gene statistics, gallery, Experiment L) | `scripts/build_foci_dataset.py` | laptop / any Python |
| Segmentation + IDR client + per-gene statistics (`stats.py`) | `src/telomere_lab/foci/` | shared |

Rebuild and deploy:

```bash
python scripts/build_foci_dataset.py
deploy_studylab.bat          # builds Telomere Lab + packs Foci Lab, uploads both
```

How the per-gene results are made (all from the authors' table, deterministic):
per-well robust score z (log2 of plate-normalised foci/cell, minus the negative-control median, over their
robust SD); per gene the number of wells, distinct siRNAs, median z and a Stouffer combined z; p and
Benjamini-Hochberg q from an *empirical* null (the N(0,1) null calls ~1,400 genes, the empirical one 39).
A **supported hit** needs >= 2 distinct siRNAs each with |z| > 2 in the same direction and q < 0.05
(currently 4 decreases, 25 increases); single-well genes (4,206) are never called. Two siRNAs against one gene
correlate only weakly (Spearman ~0.11), so only the extreme tail is reproducible. Numbers are in
`data/summary.json` under `stats` and shown on the site.

Honesty notes: 53BP1 foci are general DNA-break markers, not telomere-specific; biological claims
use the authors' numbers; our automatic counter does not reproduce them (Experiment L,
`docs/EXPERIMENT_PROTOCOL.md` §15.2) and is labelled as an unvalidated illustration. The likely cause is
the windowed 8-bit render of 16-bit source data plus unpublished focus thresholds; a re-test on the raw data
(BioImage Archive S-BIAD885) has not been done.
