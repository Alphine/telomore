Foci Lab - data download (foci_genes.csv, foci_wells.csv)
==========================================================

What this is
------------
Per-gene and per-well results of a genome-wide siRNA screen for 53BP1 foci in U2OS cells: IDR study idr0010
(Doil et al., Cell 2009). The per-well foci counts, cell counts and quality-control calls are the authors' own
(idr0010-screenA-annotation.csv). The scores below (z, emp_z, p, q, rank, status, flags) are computed by Foci Lab
from those numbers; they are not in the paper. The code is scripts/build_foci_dataset.py and
src/telomere_lab/foci/stats.py in the Telomere Lab repository; the exact formats are in foci/DATA_FORMATS.md.
Build time, code commit and SHA-256 of every file: manifest.json.

Licence and attribution
-----------------------
Licence: CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/). Please keep this attribution:

Screen data: Doil C, et al. RNF168 binds and amplifies ubiquitin conjugates on damaged chromosomes to allow accumulation of repair proteins. Cell 2009;136:435-446 (doi:10.1016/j.cell.2008.12.041), via the Image Data Resource, study idr0010 (https://idr.openmicroscopy.org), CC BY 4.0. Derived tables: Foci Lab (https://studylab.id/foci/), which re-scored the authors' per-well numbers; changes were made. Current gene symbols: HGNC (https://www.genenames.org, CC0).

File format
-----------
UTF-8, comma separated, one header row, no comment lines, RFC-4180 quoting, records end with LF, "." as the
decimal point, an empty field means "no value", booleans are true/false.

foci_genes.csv  (17536 rows, one per gene symbol that has at least one quality-controlled sample well)
-----------------------------------------------------------------------------------------------------------
gene       Gene symbol used by the screen (2005-2008 era annotation; may be outdated, see hgnc_symbol).
wells      Quality-controlled sample wells for the gene.
sirnas     Distinct siRNAs among those wells.
med_norm   Median plate-normalised foci per cell (1 = negative-control level; below 1 = fewer foci).
fpc        Median raw foci per cell.
cells      Median cell count per well.
ensembl    Ensembl gene ID from the screen table (the first one when a symbol maps to several IDs).
rank       1 = most foci lost. Empty for single-well genes, which are never ranked.
med_z      Median per-well z.
stouffer   Sum of the per-well z divided by sqrt(wells); empty for single-well genes.
emp_z      stouffer standardised by the median and robust SD (1.4826 x MAD) of all genes' stouffer values.
p          Two-sided normal p-value of emp_z.
q          Benjamini-Hochberg q-value of p across all tested genes.
status     hit_down / hit_up: q < 0.05 AND at least 2 distinct siRNAs each with |z| > 2 in that direction.
           q_only: q < 0.05 without two supporting siRNAs. single_well: only one well. none: everything else.
flags      Semicolon-separated: low_cells (median < 60 cells/well), one_sirna (several wells, one siRNA),
           disagree (strongest siRNA has |z| > 2 while another has the opposite sign with |z| > 1).
hgnc_symbol  Current HGNC symbol for the Ensembl ID, empty when the ID is not in HGNC. Symbols come from the HGNC complete set (CC0), see symbols.json.

foci_wells.csv  (46972 rows, one per sample well with a gene symbol; 9622 are QC-removed)
---------------------------------------------------------------------------------------------------
plate_well   Plate_Well key of the screen (plate-well), unique.
gene, ensembl  As above, for this well.
sirna        siRNA identifier (well:<plate_well> when the screen table has none).
sense, antisense  siRNA sequences as given in the screen table (may be empty).
cells        Cell count.
fpc          Raw foci per cell.
norm_fpc     Plate-normalised foci per cell (the authors' numbers).
z            Robust per-well score: (log2(norm_fpc) - median over negative controls) /
             (1.4826 x MAD over negative controls), controls = quality-controlled negative-control wells.
             z < 0: fewer foci than controls. Empty for QC-removed wells and where norm_fpc is missing or <= 0.
qc           pass, or remove (the authors flagged the well; kept here for transparency, never scored or ranked).
imaged       true if an IDR image exists for the well (Plate_Well index of the IDR plates).
gene_status  status of the gene (as above); empty when the gene has no quality-controlled well.

Honest caveats
--------------
* Acute 72 h siRNA knock-down in one cell line (U2OS). Not chronic loss, not a primary cell, not telomerase-negative
  ageing biology.
* 53BP1 foci mark DNA double-strand breaks in general. They are not a telomere-specific readout.
* Concordance between independent siRNAs against the same gene is weak (summary.json > stats > concordance): a
  single well or a single siRNA is not evidence about a gene. Use status = hit_down/hit_up, which requires two
  supporting siRNAs, and confirm elsewhere.
* Counts and normalisation are the authors'; we did not re-image or re-count. Foci Lab's own counter is only used
  as a consistency check on a sample of wells (Experiment L).
* The empirical null assumes most genes do nothing; q is a ranking aid, not a calibrated error rate.
