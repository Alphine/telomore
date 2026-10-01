# Foci Lab IDR plate mode

`foci/web/screen.html` (+ `screen.js`, `screen-core.js`, `screen.css`) lets a visitor pick one of the 148 imaged plates of
IDR study idr0010 (screen 1351, Doil et al., Cell 2009, CC BY 4.0). **The visitor's browser** fetches the plate's wells
through our cache proxy, analyses them with the Foci Lab engine (`window.FociEngine`, WebGPU or CPU workers) and shows a
plate heatmap, a per-well table and the agreement with the authors' own numbers. Our server never runs an analysis; it
only hands out cached images and a few small JSON files.

## Pieces

| File | Role |
|---|---|
| `web/api/plates.php`, `web/api/plate.php` | list of plates / wells of one plate, built from `data/well_index.json` only (no IDR access) |
| `web/api/well.php` | cached PNG per well and channel (unchanged contract), now guarded for bulk use |
| `web/api/_lib.php`, `web/api/cache_gc.php` | shared helpers (limits, throttle, LRU) / optional cron entry point (CLI only) |
| `web/screen-core.js` | pure logic, unit-tested: CSV, Spearman, both pairings, table, heatmap model, fetch scheduler, exports |
| `web/screen.js`, `web/screen.html`, `web/screen.css` | the page |
| `web/data/screen_controls.json` | authors' control wells per plate (`scripts/build_foci_screen_controls.py`), because `foci_wells.csv` lists sample wells only |
| `scripts/eval_foci_screen_prepare.py`, `scripts/eval_foci_screen_engine.mjs` | accuracy evaluation on plate 7-14 (below) |

## What the plate has: 12 x 32, not 16 x 24

Every imaged idr0010 plate has **384 wells arranged A-L x 1-32** (12 rows, 32 columns), not the 16 x 24 grid of a standard
384-well plate. `plate.php` therefore returns `rows: 12, cols: 32`, and the page draws what the server says. The image grid
is numbered column by column (A1, B1, ..., L1, A2, ...) in the pairing B rule below, with **12** wells per column.

## The pairing question (unresolved, shown both ways)

The annotation table (`Well`, `Well Number`) and the IDR image grid do not number the wells the same way. Two rules for
"which annotation row belongs to the image at row r, column c (zero-based)":

* **A, by name:** annotation row whose `Well` is the image's well name (image A2 with row A2).
* **B, column-major `Well Number`:** annotation row whose `Well Number` is `c * 12 + r + 1`; the annotation's own
  numbering is row-major over 32 columns (A1 = 1, A2 = 2, ..., A32 = 32, B1 = 33), so that row is named
  `letter(floor((n-1)/32)) + ((n-1) mod 32 + 1)`.

Experiment L2 (`docs/EXPERIMENT_PROTOCOL.md` 15.4) found rule B agrees with the authors' cell counts on plate 7-14 (and
on cached images of other plates), rule A does not. That is indirect evidence; nothing in the data or the curators' files
shows which side carries the mislabel. **The page does not decide:** every comparison, heatmap mark and table column
exists twice, labelled A and B, with a notice at the top of the page.

## Politeness and limits

Per visitor (client address, `REMOTE_ADDR`; `X-Forwarded-For` is ignored unless the peer is in `FOCI_TRUSTED_PROXIES`):

| Limit | Default | Env var | Why |
|---|---|---|---|
| Cached responses | 1200 / min (burst 1200) | `FOCI_HIT_PER_MIN` | a hit costs one local file read; a fully cached plate is 768 images and loads in about a minute |
| Responses that need IDR | 60 / min | `FOCI_MISS_PER_MIN` | one uncached plate takes about 13 minutes, so one visitor cannot burst IDR |
| Same, per day | 2000 (token bucket) | `FOCI_MISS_PER_DAY` | about 2.6 plates per day per visitor; walking the whole screen from one address would take weeks |

**Check on the real host that `REMOTE_ADDR` is the visitor.** If the site sits behind a CDN or reverse proxy, every visitor looks like
the proxy and all of them share ONE allowance (the plate page would then hit 429 almost at once): list the proxy's addresses in
`FOCI_TRUSTED_PROXIES` so that `X-Forwarded-For` is used. This could not be verified here (no access to the host).

Whole site, towards IDR: **3 requests per second** (burst 6, `FOCI_IDR_RATE`, `FOCI_IDR_BURST`) and **3 simultaneous
fetches** (`FOCI_IDR_CONCURRENCY`). A first-time well costs up to three IDR requests (session cookie once an hour, image
metadata once per image, the render), a second channel one more. When saturated the proxy answers `503` with `Retry-After`;
a refused miss is refunded to the visitor. Cache hits are never throttled by the IDR limits.

Disk: `FOCI_CACHE_MAX_BYTES` (default 1,500,000,000; `0` = unlimited). When a miss happens, with probability
`FOCI_CLEANUP_PROB` (0.02) the oldest files by mtime (hits touch it, at most once a minute) are deleted until 90 % of the
cap remains. Files touched within `FOCI_EVICT_GRACE_S` (120 s) are never deleted, the cookie jar and anything not named
`<imageid>.<variant>` are never touched, and a served file is opened before its headers are sent (an eviction cannot cut a
response). **Size reality check:** the 8-bit RGB PNGs of plate 7-14 measured about 158 MB for the 768 images (about 200 KB
each), so 1.5 GB holds roughly nine plates; the whole screen would be about 23 GB. The cap is soft by up to a few
responses. `php api/cache_gc.php` (set `FOCI_CACHE_DIR`) runs the same cleanup from cron.

The page adds its own rules: at most 3 requests in flight (never more, whatever the code is asked for), a 60 ms minimum
gap, `Retry-After` honoured for **all** workers, exponential back-off for network/5xx errors (4 attempts per well), a stop
with "busy" after 8 refusals in a row, a hard cap of 1600 image requests per browser tab (`sessionStorage`), one plate at a
time, everything cancelled on navigation.

Configuration without environment variables: `focilab_config.php` next to the cache directory (outside the web root),
`<?php return ['miss_per_min' => 30, 'cache_max_bytes' => 800000000];` with the same keys as the table (lower-case, without
`FOCI_`). Environment variables win over the file; values are clamped to sane ranges.

## What the page shows

Plate picker with cost notice and consent, engine badge, parameter overrides (JSON, merged over `defaultParams()`),
progress with pause / resume / cancel / retry-failed, a 12 x 32 SVG heatmap (viridis, colour-blind-safe; hatched = authors'
QC removal, ring P / N = control under the chosen pairing, red cross = failed), a sortable table with both pairings'
annotation values, per-pairing Spearman (average ranks) with n and a scatter plot, CSV export of the per-well results
and a provenance JSON (engine version, backend, parameters, timestamps, both pairings' statistics).

Comparison rule: analysed wells with at least one nucleus, sample wells (not controls), authors' QC pass. The page reads
`data/downloads/foci_wells.csv`, which has sample wells with a gene symbol only: on plate 7-14 that is **296** QC-passed
wells against **304** in Experiment L2 (whose table is the full annotation); the 8 missing ones have no gene symbol.

## Contract with the engine (what `screen.js` assumes)

`window.FociEngine` from `engine/engine.js`: `capabilities()`, `defaultParams()`, `createPool(n)` returning
`{analyze, terminate, size}`, `analyze({dna, foci, params}, {mode: 'reference'|'gpu'|'auto', overlay, signal})`. Channels are
`{data: Uint8Array, width, height, bitDepth: 8}` (the page decodes the proxy's PNG; R = G = B, R is read). The result needs
`nuclei.count`, `foci.count`, optionally `version`, `backend`, `timing_ms`, `warnings`, and, when asked, `overlay` as
`{width, height, data: RGBA}` or an `ImageData`/canvas-like object. **Foci per cell is computed as `foci.count / nuclei.count`**
(not read from `foci.per_cell`). Errors may carry `.code`: `aborted` (treated as a cancellation), `gpu_lost` (the run
pauses and asks for CPU mode), `too_large` / `bad_input` (that well fails, no retry). Without the engine file the page
loads, shows what a run would cost, and disables the Analyse button with an explanation.

## Accuracy of the Python reference pipeline on plate 7-14 (what exists today)

The browser engine was not available in this branch; the harness `scripts/eval_foci_screen_engine.mjs` scores any engine,
and the numbers below are for the **Python reference pipeline** (`telomere_lab.foci.count_foci`, default parameters) that
the engine is meant to reproduce. They will have to be re-run with `--engine foci/web/engine/engine.js` once it is merged.

**Images.** No images were fetched from IDR for this evaluation (a first attempt with a wrong URL form wasted ~770
requests, all answered `HTTP 400`, nothing stored). The 8-bit renders are emulated from the raw plate that Experiment L2
already downloaded (BioImage Archive S-BIAD885, `7-14.ome.zarr.zip`): the per-image display window `start:end` is mapped
linearly to 0-255 and written as RGB PNGs, which is what `well.php` serves. L2 checked this emulation against real IDR PNGs
of 8 wells of this plate (mean absolute difference < 0.002 grey levels). Reproducing L2's published point estimates exactly
(below) supports, but does not prove, that the harness is correct.

**Result** (304 QC-passed non-control wells, 19 with the "increased DNA damage" phenotype, 2000-resample percentile
bootstrap over wells, seed 0, own PRNG):

| | by name (A) | column-major (B) | Experiment L2, same pipeline (A / B) |
|---|---|---|---|
| Spearman, foci per cell vs authors' | -0.005 (-0.125 to 0.111) | **0.303 (0.190 to 0.406)** | -0.005 / 0.303 |
| Spearman, nuclei vs authors' cell count | 0.067 (-0.046 to 0.169) | **0.558 (0.451 to 0.651)** | 0.067 / 0.558 |
| AUC, our foci per cell for the 19 phenotype wells | 0.500 (0.371 to 0.633) | 0.679 (0.526 to 0.838) | 0.500 / 0.679 |
| AUC, authors' own foci per cell (ceiling) | 0.928 (0.828 to 0.998) | same wells | 0.93 |
| Median foci per cell, ours / authors' | 4.32 / 2.01 | 4.45 / 2.01 | 4.45 (B) |

Point estimates equal L2's (same code, same wells); the CI bounds differ in the third decimal because the bootstrap
uses a different random number generator. Restricted to what the page can see (`foci_wells.csv`, n = 296) the Spearman
of foci per cell is 0.015 (A) and 0.328 (B), of nuclei 0.066 and 0.557. Full machine-readable output:
`experiments/reports/foci_screen_eval.json`.

**What this shows and does not show.** One plate, one pipeline, 19 phenotype wells (wide intervals). Under rule B the
pipeline ranks wells weakly-to-moderately like the authors' foci per cell (0.30) and fairly well for nucleus counts
(0.56); under rule A it does not at all. The absolute level differs by a factor of two (4.4 vs 2.0 foci per cell), so
only rank agreement is meaningful. This says nothing about which pairing is right, nothing about other plates, and it is
not an accuracy claim against manual counts. The positive/negative control wells were not scored (L2: uninformative).
