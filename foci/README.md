# Foci Lab

Companion site to Telomere Evolution Lab, served at **https://studylab.id/foci/**. Telomere Lab itself is at
https://studylab.id/telomore/ (a static build whose API is the Railway backend); https://studylab.id/ is a landing
page for both.
It explores a real, published genome-wide siRNA screen of 53BP1 DNA-damage foci:
IDR study [idr0010](https://idr.openmicroscopy.org/webclient/?show=screen-1351),
Doil et al., *Cell* 2009 (doi:10.1016/j.cell.2008.12.041), licensed **CC BY 4.0**.

| Part | Where | Runs on |
|---|---|---|
| Static site (gene explorer, gene-list query, well viewer, findings, gallery, Experiment L) | `foci/web/` | Hostinger (studylab.id/foci/) |
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
`docs/EXPERIMENT_PROTOCOL.md` §15.2) and is labelled as an unvalidated illustration. A re-test on the raw data
of one plate (§15.4, BioImage Archive S-BIAD885) found that bit depth is not the cause, and that the image-to-annotation
pairing by IDR well name is uncertain, so the image shown next to a well's numbers may belong to another well.

## Site features (`foci/web/`)

Plain HTML/CSS/JS, no framework, no build step. Files: `index.html`, `style.css`, `app.js` (page, gene explorer,
citation, downloads), `list.js` (gene-list query), `viewer.js` (well image viewer), `lib.js` (all pure logic: parsing,
resolving, statistics, CSV, citation; UMD, so the same file runs in the page and in Node tests).

- **Gene explorer**: search by symbol, Ensembl ID or, when `symbols.json` exists, alias / previous symbol
  ("resolved as ..." note; ambiguous names list their candidates and are never guessed). Per-siRNA table (z, foci per cell
  against plate, cells, QC; QC-removed wells greyed and never counted; filter "same direction, |z| > 2"; a visible note
  when siRNAs disagree; sequences collapsible), per-gene wells CSV, link-outs (Ensembl, HGNC, UniProt, STRING), annotation badges.
- **Test your gene list**: paste up to 2,000 symbols / Ensembl IDs / aliases. Sortable table, CSV export, volcano and rank
  plots, and two exploratory tests computed in `lib.js`: exact hypergeometric over-representation of supported hits
  (universe = the 13,330 genes with at least two wells) and a Mann-Whitney rank-sum on median z (normal approximation,
  tie-corrected, no continuity correction). Lists of up to 200 genes get a permalink (`#list=SYM1,SYM2,...`).
- **Well viewer**: Merged / DNA / 53BP1 channel toggles (client-side compositing of two 8-bit PNGs, DNA blue, 53BP1 green),
  zoom and pan (wheel, pinch, buttons, keyboard), scale bar when the pixel size is known, side-by-side compare with
  synchronised zoom (gene vs negative control, or gene vs gene), PNG download with the attribution rendered into the image,
  link to the image in IDR.
- **Data and citation**: download section from `data/downloads/manifest.json` (size, rows, SHA-256, licence), and a
  "Cite this view" block (title, URL with gene or list permalink, access date, data build and commit, paper citation,
  licence) plus BibTeX. The BibTeX is parsed only from the attribution sentence in `summary.json` (authors, title, journal,
  year, volume, pages, DOI); nothing else is added.
- Navigation has one link to `analyze.html` (a separate page, not part of this folder's files above).

Statistics are exploratory. The site states that siRNA concordance is weak (Spearman ~0.11), that lists chosen after
looking at the data are biased, that the tests are not corrected for multiplicity, and that 53BP1 foci mark DNA breaks in
general, not telomeres.

### Optional data files and their contracts

Every file below is optional; when it is missing (404, HTML fallback, bad JSON) the feature is hidden or replaced by a
clear message, never a broken page.

| File | Contract (abridged) | Without it |
|---|---|---|
| `data/genes.json`, `data/summary.json` | required; columns are looked up by name | site does not load |
| `data/sirna.json` | `{"version":1,"columns":["sirna","plate_well","z","norm_fpc","fpc","cells","qc","imaged","sense","antisense"],"by_gene":{SYMBOL:[[...]]}}`, `qc` is `pass` or `remove`; loaded lazily when a gene card opens | table falls back to the quality-controlled wells in `genes.json` (no QC-removed wells, no sequences) |
| `data/symbols.json` | `{"version":1,"source":{...},"by_ensembl":{ENSG:{symbol,name,aliases,previous}},"lookup":{UPPER_TOKEN:ENSG},"ambiguous":{TOKEN:[ENSG,...]}}` | aliases are not recognised; symbols and Ensembl IDs still are |
| `data/annotations.json` | `{"version":1,"sources":[{id,name,url,licence,retrieved_utc,version,attribution,caveat}],"by_ensembl":{ENSG:{source_id:{label,detail,url}}},"match":{source_id:{screen_genes_matched,of}}}`; rendered generically | no badges |
| `data/downloads/manifest.json` | `{built_utc,git_commit,code_version,licence,attribution,source_metadata_url,files:[{name,bytes,sha256,rows,description}]}` plus the files themselves in the same folder | download section says files are not published; the citation omits build date and commit |
| `api/well.php?w=<well>&ch=dna\|foci` | 8-bit greyscale PNG with the composite's windowing | plain composite JPEG; channel toggles hidden |
| `api/well.php?w=<well>&info=1` | `{well,image_id,size_x,size_y,pixel_size_um,channels,idr_url}` | no scale bar, no IDR link |

### Tests

Node 22's built-in runner, no packages:

```bash
node --test foci/tests/site-*.test.mjs
```

`foci/tests/site-lib.test.mjs` covers the resolver (symbols, Ensembl IDs, aliases, ambiguous names, prototype-like names),
tokenising (CRLF, mixed separators, emoji / right-to-left text, caps), CSV quoting (RFC 4180, formula neutralising), the
siRNA summary, citation and BibTeX, permalink hashes, the scale bar and the statistics. The expected values for the
hypergeometric tail and the Mann-Whitney test (tie-heavy, small-list and large cases) were produced with scipy 1.18 by
`foci/tests/fixtures/gen_expected.py` and are hard-coded in the test file. The fixtures in `foci/tests/fixtures/` are
hand-made miniatures of the contracts above; they are never served by the site.

To develop the UI without the optional files, copy `foci/web/` to a scratch folder, add fixture versions of the files
above, and serve it with `python -m http.server` (or `php -S`). The browser will log a 404 for each optional file that
is absent; that is the browser reporting the request, not an error in the page.
