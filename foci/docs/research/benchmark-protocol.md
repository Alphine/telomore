# Benchmark protocol (draft for owner sign-off)

Context and evidence: `docs/FOCI_BROWSER_COMPUTE.md`. Freeze this file (commit) before running anything in the "held-out" rows.

## Frozen items
* Engine version/commit, parameters (repo defaults: nucleus_sigma 2, background_size 41, min_nucleus_px 150, foci_sigma 1, tophat_size 7, min_height 12, peak_window 5), scale rule (`as-is` on raw 12-bit values).
* Tunable on train only: `min_height`, `peak_window`, `min_nucleus_px`. Validation chooses among at most 10 pre-listed candidates. Test runs once.

## Splits
* BBBC039: official split files.
* idr0010: by plate. `h = int(sha256(plate_name).hexdigest(), 16) % 10`; h 0-6 train, 7 validation, 8-9 test. Plate 7-14 was used in Experiment L2: mark "seen", exclude from held-out.

## Metrics
* Nuclei: object F1 at IoU 0.5..0.9 (strictly greater than threshold; per-image mean and pooled), count bias and MAE, Bland-Altman limits, Dice.
* Foci: match radius 3 px (fixed in advance), precision/recall/F1, per-nucleus count MAE and Bland-Altman.
* GPU vs CPU: max abs/relative error per stage, mask mismatch fraction, object-count equality rate, foci-count equality rate, run-to-run bit identity, per adapter.
* Per-well vs authors: Spearman, Pearson, AUC('increased DNA damage'), bootstrap 95% CI (2000 resamples over wells, seed 0), both pairings (by name, column-major) in one table plus paired difference; authors' own values as ceiling row; absolute level reported, not scored.

## Proposed pass thresholds (owner to confirm)
* Nuclear branch "validated for widefield U2OS Hoechst": F1@0.5 >= 0.85 and count bias within +-5% on BBBC039 test.
* GPU "agrees with CPU": mask mismatch <= 0.01% of pixels, object counts equal in >= 99% of fields, foci count |d| <= 1 in >= 99% of fields, on >= 3 adapters from >= 2 vendors.
* Per-well: Spearman >= 0.6 under the pairing that agrees with cell counts, and pairing confirmed with the curators, before any biological statement.

## Baseline already measured (2026-10-01, default parameters, BBBC039 test split, once)
F1@0.5/0.6/0.7/0.8/0.9 = 0.501/0.212/0.015/0/0; nuclei per field 94.9 (area estimate) vs 114.4 GT, bias -19.5; float32-emulated GPU arithmetic changed the object count in 0 of 50 images. Reproduce with `foci/docs/research/probes/bbbc039_baseline.py` (needs `b39/*.tif` = test-split images and `masks039.zip`).

## Commands
```
# golden parity (ENGINE to provide the fixture script)
python scripts/make_engine_fixtures.py && node --test foci/web/engine/test/
# nuclei benchmark on all splits (ENGINE/LAB harness, Node)
node foci/web/engine/bench/bbbc039.mjs --data <dir> --split test --out results/bbbc039_test.json
# GPU parity (Playwright + Chromium with WebGPU)
npx playwright test foci/web/engine/test/gpu-parity.spec.js
# probes
python foci/docs/research/probes/gaussian_parity_probe.py
node foci/docs/research/probes/cpu_filters_timing.mjs
# open foci/docs/research/probes/webgpu-probe.html via any local static server (needs a secure context, localhost is fine)
```
The scripts named under `foci/web/engine/` are the requested deliverables of ENGINE, not files that exist yet.
