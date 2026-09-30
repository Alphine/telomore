# Foci Lab external gene annotations

`foci/web/data/annotations.json` attaches licensed, externally curated facts to genes of the
idr0010 53BP1 screen. It is produced by `scripts/build_foci_annotations.py` (standard library
only; downloads to a temp cache, `--offline` re-runs from the cache, output is byte-for-byte
deterministic for a given cache). Tests: `tests/test_foci_annotations.py` (no network).

53BP1 foci mark DNA double-strand breaks in general, not telomeres. These annotations are
context for interpreting screen hits (is this gene a known telomere-maintenance gene, does a
telomere-length GWAS locus map to it, is it essential for cell growth?). They are not results
of the screen.

## Format

```
{"version":1,"built_utc":"...","sources":[{id,name,url,licence,licence_url,retrieved_utc,
  version,attribution,caveat}],
 "by_ensembl":{"ENSG...":{"<source_id>":{"label":"<=24 chars","detail":"one line","url":"optional",
  "match":"symbol"  (only present when joined by gene symbol)}}},
 "match":{"<source_id>":{"screen_genes_matched":N,"of":M,"by_ensembl":N1,"by_symbol":N2}}}
```

`of` = distinct genes in the source (after de-duplication and filtering, see below).
`screen_genes_matched` = distinct screen Ensembl IDs that received an annotation.
Every entry whose `match` is `"symbol"` also says so in `detail`.

## Join method

The screen's Ensembl IDs come from an old Ensembl build and its symbols are partly outdated, and
none of the three sources ships Ensembl IDs. All sources are therefore bridged with the
**HGNC complete set** (licence CC0, https://www.genenames.org/about/license/ , opened
2026-09-30: "any form of reuse of the content is permitted", attribution recommended; file
`hgnc_complete_set.txt`, server Last-Modified 2026-09-29). HGNC is an identifier bridge only and
does not appear under `sources`.

1. Ensembl ID (`match` absent, counted in `by_ensembl`): Entrez ID (TelNet, DepMap) -> HGNC
   -> Ensembl gene ID -> present in `genes.json`. Version suffixes (`.12`) are stripped and cells
   with several IDs are split.
2. Symbol fallback (`"match":"symbol"`, counted in `by_symbol`): used when step 1 fails, and
   always for the GWAS Catalog (it returns symbols only). Source symbol (case, whitespace,
   unicode normalised) -> approved HGNC symbol, or a previous symbol that maps to exactly one
   gene and is not now an approved symbol of another gene -> HGNC Ensembl ID in the screen;
   otherwise the HGNC symbol / previous symbols / source symbol is looked up among the screen's
   own symbols and accepted only if that symbol maps to a single screen Ensembl ID that HGNC
   does not assign to a different gene.
3. Never joined: HGNC readthrough loci, withdrawn entries, ambiguous symbols, Excel
   date-mangled symbols (`1-Sep`).

A symbol match is a weaker claim than an ID match. Old-to-new renames (for example
CDK12 = CRKRS, STN1 = OBFC1, MTOR = FRAP1) are correct but were found by name.

## Sources included

### `telnet`: TelNet telomere-maintenance genes (pan-cancer supplement)
- Content: Additional file 1 of Braun et al., BMC Genetics 2018 (doi:10.1186/s12863-018-0617-8),
  Table S1, figshare 10.6084/m9.figshare.6289682 (v1, 2018-05-18, 152 KB xlsx). It lists 1022
  genes correlating with telomere length or deregulated in TCGA tumours; **132 are flagged "in
  TelNet"** and only those are used, with their TelNet score (1-10), evidence class
  (validated/screened/predicted), function terms and effect on ALT/telomerase.
- Licence evidence: figshare API record for the file states "CC BY + CC0" with licence URL
  https://creativecommons.org/licenses/by/4.0/ ; the PMC article page
  (https://pmc.ncbi.nlm.nih.gov/articles/PMC5960154/) states the article is under CC BY 4.0
  ("permits unrestricted use, distribution, and reproduction ... provided you give appropriate
  credit"). Opened 2026-09-30.
- Caveat: this is a small slice of TelNet (the database advertises 2000+ human genes). The
  TelNet website (`cancertelsys.org/telnet`) now serves a domain-parking page, so the full
  database could not be retrieved. Do not read absence of a badge as "not a telomere gene".

### `gwas`: NHGRI-EBI GWAS Catalog, human telomere length
- Content: associations for EFO/OBA trait `OBA_0003784` ("chromosome, telomeric region length";
  the catalogue's current term for telomere length, including leukocyte telomere length),
  1620 associations (1425 telomere-length ones at p <= 5e-8, from 28 studies), via the v2 REST API (the v1 API is deprecated and rate limited).
  Kept: p <= 5e-8 only, per (association, mapped gene). Detail shows number of associations and
  studies, best p, study accession, PMID and first author.
- Licence evidence: "Other GWAS Catalog data can be used under the EBI Services Terms of Use"
  (https://www.ebi.ac.uk/gwas/docs/faq , opened 2026-09-30); EMBL-EBI terms
  (https://www.ebi.ac.uk/about/terms-of-use/ , opened 2026-09-30): no restrictions beyond those of
  the original data owners, attribution expected. Original study rights may still apply.
- Caveats: **association, not a causal gene assignment**. Mapped genes are the gene overlapping
  the lead variant or the flanking genes for intergenic variants, so many listed genes are
  neighbours of the real effector. The list also contains lncRNAs, pseudogenes, antisense and
  readthrough loci that are not in the screen. Symbol match only.

### `depmap`: DepMap common-essential genes (CRISPR, 24Q4)
- Content: `CRISPRInferredCommonEssentials.csv` from DepMap 24Q4 Public (figshare+
  10.25452/figshare.plus.27993248.v1, 20 KB, 1523 genes as `SYMBOL (EntrezID)`).
- Licence evidence: figshare API record of the dataset: "CC BY 4.0"
  (https://creativecommons.org/licenses/by/4.0/). The dataset page on plus.figshare.com and
  depmap.org/portal returned HTTP 403 / a bot check to automated fetches, so the licence was
  read from the figshare API record; nothing was bypassed.
- Caveat: a newer DepMap release may exist (only 24Q4 was verified reachable). "Common
  essential" means growth dependency across cancer lines. siRNA knockdown of such genes may
  reduce cell numbers and confound per-cell foci readouts; it says nothing about telomeres.

## Match table (built 2026-09-30, screen = 17,536 genes)

| source | source genes | matched screen genes | by Ensembl ID | by symbol |
|---|---|---|---|---|
| telnet | 132 | 124 | 119 | 5 |
| gwas | 571 | 357 | 0 | 357 |
| depmap | 1523 | 1322 | 1284 | 38 |

All 201 unmatched DepMap and 8 unmatched TelNet genes are valid HGNC genes with a current Ensembl ID
that is not in `genes.json` and whose symbol is not found unambiguously there, i.e. most likely genes
that the screen library does not target (not verified gene by gene).
The low GWAS rate (63%) is expected: 571 mapped
symbols include many non-coding loci and pseudogenes that the siRNA library does not target.
File size 517 KB, 1721 annotated screen genes.

## Skipped, and why

- **TelNet full database** (cancertelsys.org/telnet): the domain currently serves a
  registrar parking page (HTTP 200, "Domain im Kundenauftrag registriert"); no export reachable.
  Only the CC BY supplement (above) is used.
- **DepMap portal downloads / API** (depmap.org): Cloudflare Turnstile bot check; not bypassed. The
  figshare+ copy was used instead. Large DepMap matrices (CRISPRGeneEffect, 0.4 GB) were not
  downloaded: too big, and not needed for a yes/no badge.
- **GWAS Catalog legacy v1 API**: deprecated, intentionally rate limited; v2 used.
- **Other telomere gene lists** (shelterin/ALT sets, full TelNet export):
  no small file with a verified open licence and stable machine-readable download was found
  within this task; nothing was included on trust.
- **Screen-level results from other papers** (e.g. telomere-length or ALT siRNA screens) were not
  attempted because no licensed per-gene table was located.
