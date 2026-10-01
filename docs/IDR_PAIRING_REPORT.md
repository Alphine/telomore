# idr0010: a possible mismatch between image well address and annotation row

Prepared 2026-10-01 for the Image Data Resource team (idr-help) and the authors of idr0010 (Doil et al., *Cell* 2009).
**Nothing has been sent.** The owner decides whether, to whom and when. This text is written so it can be pasted into an
email or a forum post as it stands.

Contact: Alphine (TODO(owner): name, email, affiliation).

## Summary

While building an open-source tool that reads idr0010 images next to the authors' per-well annotation, we noticed that the
image at a given well address agrees with the authors' per-well cell count only if the image grid is numbered
**column by column** and joined to the annotation through `Well Number`. Joining by the **well name** (image `A2` with the
annotation row whose `Well` is `A2`) shows no agreement. We have not been able to confirm this with any documentation, and
we may simply have missed a convention. We would be grateful if you could tell us whether the two numberings are meant to
be related as described below.

We are **not** claiming that the deposited data are wrong, that any published result is affected, or that the authors'
table is incorrect. The authors' numbers are used exactly as published.

## What we observed

* Every annotation row in the study table (57,216 rows) satisfies `Well Number` = `r*32 + c + 1`, where `r` is the row
  letter index (A = 0) and `c` the zero-based column, for a plate of 12 rows (A-L) x 32 columns. That is a row-major
  numbering with 32 columns per row.
* The images on the plates we looked at are addressed by well name (`A1` ... `L32`) in IDR and in the BioImage Archive
  OME-Zarr conversion (S-BIAD885); the two agree on addresses (8 of 8 images we compared sit in the same-named zarr well).
* If the image at `(row r, column c)` is joined to the annotation row with `Well Number = c*12 + r + 1`, which is the
  **column-major** numbering of the same grid (A1, B1, ..., L1, A2, ...), the image agrees with the authors' cell counts.
  If it is joined to the annotation row with the same well name, it does not.

## The checks and the numbers

All three checks use our own nucleus detector, which is a simple classical one and is **not** validated. Only the
direction and size of the difference between the two joins matters here, not the absolute values. Spearman rank
correlation throughout.

1. **106 cached wells over many plates.** Our nucleus count per image vs the authors' `Cell Count`:
   0.16 when joined by name, **0.71** (Pearson 0.69) when joined column-major. Our foci per cell vs the authors' foci per
   cell: -0.07 by name, 0.34 column-major.
2. **Lethal-knockdown controls (a biological readout).** For 20 KIF11 positive-control rows (the CSV reports a median of
   79 cells per spot) the image at the same-named well has a median of 144.5 detected nuclei, about a typical field (about
   135), i.e. no loss of cells. The image at the column-major well has a median of 93.5 nuclei. Across these rows our
   nucleus counts vs the CSV cell counts give Spearman -0.19 (by name) and **0.83** (column-major).
3. **A full plate, 7-14, analysed in the browser.** 304 QC-passed non-control wells. Nuclei vs cells: 0.07 by name,
   0.56 column-major (Experiment L2 on the raw data of the same plate: 0.07 and 0.48). Foci per cell vs the authors':
   -0.005 by name, 0.303 column-major. Detecting the 19 "increased DNA damage" wells: AUC 0.50 by name, 0.68
   column-major; the authors' own foci per cell reaches 0.93 on the same wells.

Also tested and **rejected** as pairings on plate 7-14: row-major numbering shifted by up to 40 wells, horizontal and
vertical flips, 180-degree rotation, reversal; shifting the column-major order by one to three wells reduces the agreement
from 0.48 to 0.14-0.37. Bit depth is unrelated: the pixel data are 12-bit values in 16-bit containers (values 38-4095) and
the same detector gives the same agreement on the raw values and on the 8-bit render.

One earlier attempt at check 2/3 assumed a 16 x 24 plate geometry. That was wrong (the plates are 12 x 32) and was
withdrawn; the numbers above use 12 x 32.

## What we are NOT claiming

* **Not confirmed.** This is empirical agreement between our own counts and the authors' counts. We have not seen a
  document stating the intended relation between image address and annotation row.
* It may be a **metadata convention** we missed (for example an acquisition or array-position numbering that is
  documented elsewhere), not an error.
* We cannot tell **which side** would carry any inconsistency (the image address, the annotation row, or neither), and
  image data alone cannot decide it.
* Only one plate was analysed in full (7-14); the cached-image check covers 106 wells over many plates; the lethal-control
  check covers 20 rows. We did not examine all 147 plates, nor the two plates without a zip in S-BIAD885 (`5-12`,
  `153-29`).
* Nothing here says that the published findings of Doil et al. are affected. Our foci counter is unvalidated and does not
  reproduce the authors' foci counts well even with the best pairing.

## How to reproduce

Everything is open source (MIT; the idr0010 data are CC BY 4.0). Repository: https://github.com/Alphine/telomore
(TODO(owner): confirm the public URL before sending).

* Protocol and all numbers: `docs/EXPERIMENT_PROTOCOL.md`, section 15.4 ("Experiment L2"), including the independent checks.
* Raw-data run on plate 7-14: download
  `https://ftp.ebi.ac.uk/biostudies/fire/S-BIAD/885/S-BIAD885/Files/idr0010/7-14.ome.zarr.zip` (475,572,589 bytes), then
  `pip install zarr` and
  `PYTHONPATH=src python scripts/redo_experiment_l_raw16.py PATH/7-14.ome.zarr.zip` (about 5 minutes; writes
  `experiments/reports/foci_raw16.json`).
* Browser version with both pairings side by side: https://studylab.id/foci/screen.html (pick plate 7-14; every comparison
  is shown as pairing A "by name" and pairing B "column-major `Well Number`"). The harness for the numbers is
  `scripts/eval_foci_screen_engine.mjs`; see `foci/docs/SCREEN_MODE.md`.

## Questions

1. Is the annotation's `Well Number` meant to follow the same ordering as the image well address, or is it an acquisition
   (array) order that differs from the plate layout? If the latter, where is the mapping documented?
2. For plates of 12 rows x 32 columns, is column-major numbering (A1, B1, ..., L1, A2, ...) of the images the intended
   reading of `Well Number`?
3. Is there a recommended way to join an image (IDR well, or S-BIAD885 zarr well) to its row in the study annotation, and
   is it the same for all plates?
4. If the two are not meant to match, would you want us to document the mapping on our side, or is a correction in the
   metadata a matter for the study authors?
5. We cache and display IDR images through a small caching proxy at 3 requests per second site-wide. Please tell us if you
   would prefer different limits.

Thank you for IDR and for the open data; this tool would not exist without it.

## Citations

Doil C, et al. RNF168 binds and amplifies ubiquitin conjugates on damaged chromosomes to allow accumulation of repair
proteins. *Cell* 2009 (doi:10.1016/j.cell.2008.12.041). Data: Image Data Resource idr0010 (screen 1351), CC BY 4.0;
BioImage Archive S-BIAD885.
