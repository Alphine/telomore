# Foci Lab - data formats

Public contract of the files under `foci/web/data/` (served at `https://studylab.id/foci/data/`). They are produced by
`scripts/build_foci_dataset.py` from the authors' per-well table of IDR study idr0010 (Doil et al., Cell 2009,
doi:10.1016/j.cell.2008.12.041, CC BY 4.0) and, for current gene symbols, the HGNC complete set (CC0).
Columns are only ever appended; readers should look columns up by name.

Conventions: JSON is UTF-8, compact, `null` for "no value", no `NaN`/`Infinity`; floats are rounded to 3 decimals
(`p` and `q` to 3 significant digits). "Sample well" = a non-control well that has a gene symbol.
`z < 0` = fewer 53BP1 foci per cell than the negative controls.

## genes.json (unchanged)

`{"columns":[...],"well_list_columns":[...],"rows":[[...]]}`. Columns: `gene, wells, sirnas, med_norm, fpc, cells,
ensembl, rank, med_z, stouffer, emp_z, p, q, status, flags, well_list`. Only QC-passed wells count. `rank` is `null`
for single-well genes (never ranked). `ensembl` is the first Ensembl ID seen for the symbol (a few dozen symbols map to two
IDs in the screen table). `well_list` rows: `plate_well, norm_fpc, imaged, z, cells, sirna`.

## sirna.json

```
{"version":1,
 "columns":["sirna","plate_well","z","norm_fpc","fpc","cells","qc","imaged","sense","antisense"],
 "by_gene":{"RNF168":[["126170","90-27_D6",-10.204,0.206,0.331,236,"pass",true,"GGA...","..."], ...], ...}}
```

One row per sample well, grouped by the gene symbol used in genes.json (keys sorted; rows in screen-table order).

| column | type | meaning |
|---|---|---|
| sirna | string | siRNA identifier; `well:<plate_well>` if the table has none |
| plate_well | string | unique well key |
| z | number or null | the same per-well z as in genes.json `well_list`. `null` for `qc = "remove"` wells (never scored) and for `pass` wells whose normalised foci/cell is missing or <= 0 (log undefined) |
| norm_fpc | number or null | plate-normalised foci per cell (authors) |
| fpc | number or null | raw foci per cell (authors) |
| cells | integer or null | cell count |
| qc | `"pass"` or `"remove"` | authors' quality-control call. `remove` wells are shown for transparency; they never enter a gene's counts, statistics or rank, and a gene with only removed wells has no genes.json row |
| imaged | boolean | an IDR image exists (`well_index.json`) |
| sense, antisense | string | siRNA sequences from the table (may be empty) |

## symbols.json (HGNC)

```
{"version":1,
 "source":{"name","url","licence","retrieved_utc","release"},
 "shared_ensembl":["ENSG..."],
 "by_ensembl":{"ENSG...":{"symbol","name","aliases":[...],"previous":[...]}},
 "lookup":{"UPPERCASE_TOKEN":"ENSG..."},
 "ambiguous":{"TOKEN":["ENSG...","ENSG..."]}}
```

* Source: `hgnc_complete_set.txt` from `https://storage.googleapis.com/public-download-files/hgnc/tsv/tsv/`, no login;
  licence CC0 (https://www.genenames.org/about/license/). HGNC states no release number; `release` records the file's
  `Last-Modified` header.
* `by_ensembl` covers only the Ensembl IDs in genes.json (the `ensembl` column). An ID absent from HGNC (retired,
  withdrawn or never assigned; not distinguishable) is absent here. An ID claimed by two HGNC entries is left out and
  listed in `shared_ensembl`.
* `lookup` maps the upper-cased current symbol, previous symbols and aliases of those genes to one Ensembl ID. A
  token reaching more than one gene appears only in `ambiguous` (sorted IDs), never in `lookup`.
* Screen symbols with no HGNC match (e.g. `NP_689812.2`, `Q9BSZ0_HUMAN`, `AL390728.37`) are not in `lookup`; match
  them against genes.json directly.

## summary.json (appended keys)

* `build`: `{"built_utc","git_commit","manifest":"downloads/manifest.json"}` (commit the build was run from).
* `symbols` (only when HGNC data were available): `source, release, licence, screen_genes,
  screen_genes_with_ensembl, ensembl_ids_in_screen, ensembl_ids_found_in_hgnc, ensembl_ids_missing_from_hgnc,
  ensembl_ids_shared_by_two_hgnc_entries, genes_symbol_differs,
  genes_symbol_differs_explained_by_previous_or_alias, examples:[{screen_symbol,current_symbol}], lookup_tokens,
  ambiguous_tokens, note`.

All other keys are unchanged.

## downloads/

Plain CSV: UTF-8 without BOM, header row only, no comment lines, RFC-4180 quoting (only where needed), records end
with LF, `.` decimals, empty field = no value, booleans `true`/`false`. Read `sirna` as text (it can be
`well:...`) and disable pandas' default NA strings (`keep_default_na=False, na_values=[""]`) so gene symbols such as
`NA` survive. Files are byte-stable: rebuilding from the same inputs gives identical bytes and hashes.

### foci_genes.csv

One row per gene, ordered by rank (single-well genes last). Columns: `gene, wells, sirnas, med_norm, fpc, cells,
ensembl, rank, med_z, stouffer, emp_z, p, q, status, flags, hgnc_symbol`. As genes.json, except `flags` is
semicolon-separated (`low_cells;disagree`, empty if none) and `hgnc_symbol` is the current HGNC symbol for `ensembl`
(empty when unknown). Types: integer `wells, sirnas, rank`; number `med_norm, fpc, cells, med_z, stouffer, emp_z, p,
q`; text otherwise.

### foci_wells.csv

One row per sample well (QC-removed included), screen-table order. Columns: `plate_well, gene, ensembl, sirna,
sense, antisense, cells, fpc, norm_fpc, z, qc, imaged, gene_status`. Same definitions as sirna.json; `ensembl` is the
ID of this well (can differ between wells of one symbol); `gene_status` is the genes.json `status` of the gene, empty
when the gene has no QC-passed well.

### README_DATA.txt

Column dictionary, definitions of z / q / status / flags, attribution, licence and caveats (acute 72 h siRNA screen,
U2OS only, 53BP1 marks DNA breaks in general, weak siRNA concordance).

### manifest.json

```
{"built_utc","git_commit","code_version":"foci-data-1","licence":"CC BY 4.0","attribution","source_metadata_url",
 "files":[{"name","bytes","sha256","rows","description"}]}
```

`files` lists the three files above (`rows` = data rows, `null` for the text file). `built_utc` is the only
non-deterministic value (with `git_commit`, which names the commit the build ran from).
