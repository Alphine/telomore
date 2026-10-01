#!/usr/bin/env python
"""Experiment L2 -- re-test 53BP1 foci counting on RAW idr0010 intensities (one plate).

Usage (needs the OPTIONAL package zarr:  pip install zarr):

    python scripts/redo_experiment_l_raw16.py PATH/TO/7-14.ome.zarr.zip [--out experiments/reports/foci_raw16.json]

The plate zip is BioImage Archive S-BIAD885 (idr0010 as OME-Zarr, CC BY 4.0), e.g.
https://ftp.ebi.ac.uk/biostudies/fire/S-BIAD/885/S-BIAD885/Files/idr0010/7-14.ome.zarr.zip (475,572,589 bytes).
Keep it OUTSIDE the repository (raw data is never committed). The annotation table is
.cache/idr0010/annotation.csv (see scripts/build_foci_dataset.py); the plate id is taken from the zip name.

Design (see docs/EXPERIMENT_PROTOCOL.md 15.4): every eligible well is scored by 2-fold cross-fitting -- each
detector's single threshold is chosen ONLY on the other half of the wells (max Spearman with the authors'
foci/cell), so every reported prediction is out-of-sample. The paired 8-bit baseline runs on the same wells,
rendered to 8 bit with the IDR window stored in the zarr metadata.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from telomere_lab.foci import raw16 as R  # noqa: E402
from telomere_lab.foci.segment import FociParams, count_foci  # noqa: E402

DEFAULT_ANNOTATION = ROOT / ".cache" / "idr0010" / "annotation.csv"
DEFAULT_OUT = ROOT / "experiments" / "reports" / "foci_raw16.json"
SEED = 0
BOOT = 2000


def r4(x):
    x = float(x)
    return round(x, 4) if np.isfinite(x) else None


def clean(o):
    """JSON-safe copy (numpy scalars/arrays -> python, NaN -> None)."""
    if isinstance(o, dict):
        return {str(k): clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [clean(v) for v in o]
    if isinstance(o, np.ndarray):
        return clean(o.tolist())
    if isinstance(o, (np.floating, float)):
        return r4(o)
    if isinstance(o, np.integer):
        return int(o)
    return o


def load_table(annotation: Path, plate: str) -> pd.DataFrame:
    a = pd.read_csv(annotation, low_memory=False)
    a = a[a["Plate"].astype(str) == plate].copy()
    if a.empty:
        raise SystemExit(f"plate {plate!r} not in {annotation}")
    for c in ("Cell Count", "53BP1 foci", "Foci Per Cell"):
        a[c] = pd.to_numeric(a[c], errors="coerce")
    a["qc_pass"] = a["Quality Control"].isna()  # the column holds 'remove' or is empty
    a["ph_increased"] = a["Phenotype 1"].astype(str).eq("increased DNA damage")
    a["ph_defective"] = a["Phenotype 2"].astype(str).eq("defective DNA damage response")
    return a.set_index("Well", drop=False)


def sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(1 << 22), b""):
            h.update(b)
    return h.hexdigest()


def per_nucleus_values(wd: R.WellData, detector: str, thr: float):
    """Per single-nucleus objects only: foci count and integrated focus height."""
    if wd.n_objects == 0:
        return np.zeros(0), np.zeros(0)
    single = wd.obj_nuclei == 1
    return (R.per_object_counts(wd, detector, thr)[single].astype(float),
            R.per_object_intensity(wd, detector, thr)[single])


def per_well_scores(wd: R.WellData, detector: str, thr: float) -> dict:
    cnt, inten = per_nucleus_values(wd, detector, thr)
    if cnt.size == 0:
        return {"fpc": np.nan, "mean_integrated": np.nan, "p90_count": np.nan}
    return {"fpc": R.foci_per_cell(wd, detector, thr), "mean_integrated": float(inten.mean()),
            "p90_count": float(np.quantile(cnt, 0.9))}


def evaluate_arm(name, detector, wds, grid, y, cells, folds, is_inc, is_def, ctrl, fixed_thr=None, boot=BOOT):
    """Cross-fitted (or fixed-threshold) evaluation of one detector arm on the eligible wells."""
    mat = R.fpc_matrix(wds, detector, grid)
    if fixed_thr is None:
        chosen, oof, train_rho = R.crossfit_calibrate(mat, y, folds)
        thr_w = np.array([grid[chosen[f]] for f in folds])
        info = {"threshold_per_fold": [float(grid[j]) for j in chosen], "train_spearman_per_fold": train_rho,
                "heldout_spearman_per_fold": [R.safe_spearman(oof[folds == f], y[folds == f]) for f in range(len(chosen))]}
        # threshold for wells outside the calibration table (controls): fitted on ALL eligible wells
        rhos_all = [R.safe_spearman(mat[:, j], y) for j in range(mat.shape[1])]
        j_all = int(np.nanargmax(rhos_all))
        ctrl_thr = float(grid[j_all])
        info["threshold_all_wells_for_controls"] = ctrl_thr
    else:
        thr_w = np.full(len(wds), float(fixed_thr))
        oof = np.array([R.foci_per_cell(w, detector, fixed_thr) for w in wds])
        info = {"threshold": float(fixed_thr), "note": "fixed (the 8-bit pipeline default), nothing calibrated"}
        ctrl_thr = float(fixed_thr)
    nuc = np.array([w.n_nuclei for w in wds], float)
    out = {"detector": detector, **info}
    out["foci_per_cell_vs_authors"] = R.summarise_corr(oof, y, boot, SEED)
    out["nuclei_vs_authors_cell_count"] = {
        "pearson": R.safe_pearson(nuc, cells), "spearman": R.safe_spearman(nuc, cells),
        "median_ours": float(np.median(nuc)), "median_authors": float(np.median(cells)),
        "median_per_well_ratio": float(np.median(nuc / cells))}
    out["median_foci_per_cell_ours"] = float(np.nanmedian(oof))
    out["median_foci_per_cell_authors"] = float(np.median(y))
    # per-well scores at the fold thresholds
    sc = [per_well_scores(w, detector, t) for w, t in zip(wds, thr_w)]
    feats = {k: np.array([s[k] for s in sc]) for k in ("fpc", "mean_integrated", "p90_count")}
    out["phenotype_increased_damage"] = {k: R.auc_with_ci(v, is_inc, boot, SEED) for k, v in feats.items()}
    if is_def.any():
        # authors' 'defective response' wells should have LOW foci/cell
        out["phenotype_defective_response"] = R.auc_with_ci(-feats["fpc"], is_def, boot, SEED)
    else:
        out["phenotype_defective_response"] = {"n_pos": 0, "note": "no such well on this plate"}
    # distribution metric: per-nucleus values pooled over annotated wells vs the rest (well-level bootstrap)
    cnt_inc, cnt_rest, int_inc, int_rest = [], [], [], []
    for w, t, inc in zip(wds, thr_w, is_inc):
        c, i = per_nucleus_values(w, detector, t)
        (cnt_inc if inc else cnt_rest).append(c)
        (int_inc if inc else int_rest).append(i)
    out["distribution_increased_damage"] = {
        "per_nucleus_foci_count": R.pooled_distribution_auc(cnt_inc, cnt_rest, 1000, SEED),
        "per_nucleus_integrated_height": R.pooled_distribution_auc(int_inc, int_rest, 1000, SEED)}
    out["_oof"] = oof
    out["_thr_w"] = thr_w
    out["_ctrl_thr"] = ctrl_thr
    return out


def control_separation(arm, detector, ctrl_wds, ctrl_lab, ctrl_y):
    thr = arm["_ctrl_thr"]
    ours = np.array([R.foci_per_cell(w, detector, thr) for w in ctrl_wds])
    pos, neg = ctrl_lab == "positive control", ctrl_lab == "negative control"
    return {"n_positive": int(pos.sum()), "n_negative": int(neg.sum()),
            "auc_ours_positive_gt_negative": R.auc_mw(ours[pos], ours[neg]),
            "auc_authors_positive_gt_negative": R.auc_mw(ctrl_y[pos], ctrl_y[neg]),
            "median_ours_positive": float(np.nanmedian(ours[pos])), "median_ours_negative": float(np.nanmedian(ours[neg])),
            "median_authors_positive": float(np.median(ctrl_y[pos])), "median_authors_negative": float(np.median(ctrl_y[neg]))}


def analyse(mapping, A, ws, q_ws, l_ws, args, p):
    """Full evaluation for one image<->annotation assignment. ``A`` is indexed by zarr well name."""
    elig_mask = (A["qc_pass"] & A["Control Type"].isna() & A["Foci Per Cell"].notna() & (A["Cell Count"] > 0))
    ctrl_mask = A["Control Type"].isin(["positive control", "negative control"]) & A["Foci Per Cell"].notna()
    elig, ctrl = A[elig_mask], A[ctrl_mask]
    keep = [w for w in elig.index if ws[w].n_objects > 0 and q_ws[w].n_objects > 0 and l_ws[w].n_objects > 0]
    dropped = [w for w in elig.index if w not in keep]
    E = elig.loc[keep]
    y = E["Foci Per Cell"].to_numpy(float)
    cells = E["Cell Count"].to_numpy(float)
    is_inc = E["ph_increased"].to_numpy(bool)
    is_def = E["ph_defective"].to_numpy(bool)
    folds = R.make_folds(len(E), SEED)
    L = lambda d: [d[w] for w in E.index]  # noqa: E731

    arms = {}
    arms["legacy_8bit_default"] = evaluate_arm("legacy_8bit_default", "legacy", L(l_ws), R.LEGACY_GRID, y, cells, folds,
                                               is_inc, is_def, None, fixed_thr=p.min_height, boot=args.boot)
    arms["legacy_8bit_calibrated"] = evaluate_arm("legacy_8bit_calibrated", "legacy", L(l_ws), R.LEGACY_GRID, y, cells,
                                                  folds, is_inc, is_def, None, boot=args.boot)
    for det in R.DETECTORS:
        arms[f"raw_{det}"] = evaluate_arm(f"raw_{det}", det, L(ws), R.SCORE_GRID[det], y, cells, folds, is_inc, is_def,
                                          None, boot=args.boot)
        arms[f"quant8_{det}"] = evaluate_arm(f"quant8_{det}", det, L(q_ws), R.SCORE_GRID[det], y, cells, folds, is_inc,
                                             is_def, None, boot=args.boot)

    # headline raw detector: chosen by mean TRAINING-fold Spearman (never by held-out performance)
    headline = max((f"raw_{d}" for d in R.DETECTORS), key=lambda n: np.mean(arms[n]["train_spearman_per_fold"]))

    paired = {}
    for det in R.DETECTORS:
        paired[f"raw_vs_quant8_{det}"] = R.paired_spearman_diff(
            arms[f"raw_{det}"]["_oof"], arms[f"quant8_{det}"]["_oof"], y, args.boot, SEED)
    paired["headline_raw_vs_legacy_8bit_default"] = R.paired_spearman_diff(
        arms[headline]["_oof"], arms["legacy_8bit_default"]["_oof"], y, args.boot, SEED)
    paired["headline_raw_vs_legacy_8bit_calibrated"] = R.paired_spearman_diff(
        arms[headline]["_oof"], arms["legacy_8bit_calibrated"]["_oof"], y, args.boot, SEED)

    # controls (not part of calibration, so held out by construction)
    c_lab = ctrl["Control Type"].to_numpy()
    c_y = ctrl["Foci Per Cell"].to_numpy(float)
    controls = {"genes_positive": sorted(map(str, ctrl.loc[ctrl["Control Type"] == "positive control", "Gene Symbol"].unique())),
                "qc_status_note": "positive controls carry QC 'remove: control' in the annotation; used only here"}
    for n, a in arms.items():
        det = a["detector"]
        wsrc = l_ws if det == "legacy" else (q_ws if n.startswith("quant8") else ws)
        controls[n] = control_separation(a, det, [wsrc[w] for w in ctrl.index], c_lab, c_y)

    ceiling = {"authors_fpc_auc_increased": R.auc_with_ci(y, is_inc, args.boot, SEED),
               "authors_fpc_auc_defective_low": (R.auc_with_ci(-y, is_def, args.boot, SEED) if is_def.any()
                                                  else {"n_pos": 0, "note": "no such well on this plate"})}
    table = [{"image_well": w, "annotation_well": str(E.loc[w, "Well"]), "authors_fpc": y[i], "authors_cells": cells[i],
              "fold": int(folds[i]), "increased_damage": bool(is_inc[i]), "ours_nuclei_raw": ws[w].n_nuclei,
              f"ours_fpc_{headline}": arms[headline]["_oof"][i],
              "ours_fpc_legacy_8bit_default": arms["legacy_8bit_default"]["_oof"][i]} for i, w in enumerate(E.index)]
    for a in arms.values():  # drop private arrays
        for k in [k for k in a if k.startswith("_")]:
            del a[k]
    return {"mapping": mapping,
            "wells": {"eligible_qc_pass_noncontrol": int(elig_mask.sum()), "analysed": len(E), "dropped_no_nuclei": dropped,
                      "n_increased_damage_analysed": int(is_inc.sum()),
                      "n_increased_damage_on_plate": int(A["ph_increased"].sum()),
                      "n_defective_response_on_plate": int(A["ph_defective"].sum()), "n_controls_scored": int(len(ctrl))},
            "headline_raw_detector": headline, "arms": arms, "paired_spearman_differences": paired,
            "controls": controls, "authors_reference": ceiling, "per_well": table}


def idr_png_mapping_check():
    """Optional, offline: the ~100 cached IDR PNGs of Experiment L (all plates). Our nucleus count vs the authors'
    Cell Count under the two assignments. Skipped (None) when the cache / well index is absent."""
    idx_f, cache, ann_f = ROOT / "foci" / "web" / "data" / "well_index_byname.json", ROOT / ".cache" / "idr0010" / "img", DEFAULT_ANNOTATION
    if not (idx_f.exists() and cache.exists() and ann_f.exists()):
        return None
    inv = {v: k for k, v in json.loads(idx_f.read_text()).items()}
    a = pd.read_csv(ann_f, low_memory=False)
    a["cc"] = pd.to_numeric(a["Cell Count"], errors="coerce")
    by_name, by_num = a.set_index("Plate_Well")["cc"], a.set_index(["Plate", "Well Number"])["cc"]
    p = FociParams()
    rows = []
    for f in sorted(cache.glob("*.npz")):
        name = inv.get(int(f.stem))
        if name is None:
            continue
        plate, w = name.rsplit("_", 1)
        r, c = ord(w[0]) - 65, int(w[1:]) - 1
        z = np.load(f)
        n = count_foci(z["dna"].astype(np.float32), z["foci"].astype(np.float32), p).n_nuclei
        try:
            rows.append((n, float(by_name[name]), float(by_num[(plate, R.colmajor_well_number(r, c, 12))])))
        except KeyError:
            continue
    d = np.array(rows, float).reshape(-1, 3)
    d = d[np.isfinite(d).all(axis=1) & (d[:, 1] > 0) & (d[:, 2] > 0)]
    if len(d) < 10:
        return None
    return {"n_images": int(len(d)), "note": "8-bit PNGs from many plates, no QC filter",
            "by_annotation_well_name": {"spearman": R.safe_spearman(d[:, 0], d[:, 1]), "pearson": R.safe_pearson(d[:, 0], d[:, 1])},
            "by_column_major_well_number": {"spearman": R.safe_spearman(d[:, 0], d[:, 2]), "pearson": R.safe_pearson(d[:, 0], d[:, 2])}}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("zip", help="path to a plate zip, e.g. 7-14.ome.zarr.zip")
    ap.add_argument("--out", default=str(DEFAULT_OUT))
    ap.add_argument("--annotation", default=str(DEFAULT_ANNOTATION))
    ap.add_argument("--boot", type=int, default=BOOT)
    args = ap.parse_args(argv)
    t0 = time.time()

    plate = Path(args.zip).name.split(".ome.zarr")[0]
    ann = load_table(Path(args.annotation), plate)
    by_number = ann.set_index("Well Number", drop=False)
    p = FociParams()

    ws, q_ws, l_ws, mismatch = {}, {}, {}, []
    raw_min, raw_max, sat = 65535, 0, []
    with R.OmeZarrPlate(args.zip) as P:
        if set(ann["Well"]) != set(P.wells):
            raise SystemExit("annotation wells and zarr wells differ")
        n_rows, n_cols = P.n_rows, P.n_cols
        if len(ann) != n_rows * n_cols:
            raise SystemExit("annotation size differs from the plate grid")
        grid = dict(P.grid)
        for name in P.wells:
            dna, foc, win = P.read_well(name)
            raw_min, raw_max = min(raw_min, int(dna.min()), int(foc.min())), max(raw_max, int(dna.max()), int(foc.max()))
            sat.append(int((foc >= 4095).sum()))
            ws[name] = R.well_candidates(dna, foc, p)                                   # raw integers
            d8, f8 = R.render_8bit(dna, *win["dna"]), R.render_8bit(foc, *win["foci"])   # what the IDR web API serves
            q_ws[name] = R.well_candidates(R.unrender_8bit(d8, *win["dna"]), R.unrender_8bit(f8, *win["foci"]), p)
            l_ws[name] = R.well_candidates(d8, f8, p, detectors=(), legacy_floor=1.0)    # the Experiment L pipeline
            ref = count_foci(d8, f8, p)  # the legacy candidates must reproduce count_foci at its default threshold
            mine = int((l_ws[name].cands["legacy"].score >= p.min_height).sum()) if l_ws[name].n_objects else 0
            if (ref.n_nuclei, ref.n_foci) != (l_ws[name].n_nuclei, mine):
                mismatch.append(name)
    if mismatch:
        raise SystemExit(f"legacy candidates disagree with count_foci on {len(mismatch)} wells, e.g. {mismatch[:3]}")

    # two image <-> annotation assignments (see raw16.colmajor_well_number)
    A_name = ann.loc[list(ws)].copy()                      # by the annotation's Well name (as Experiment L did)
    A_cm = by_number.loc[[R.colmajor_well_number(*grid[w], n_rows) for w in ws]].copy()  # by column-major well number
    A_cm.index = list(ws)
    evidence = {}
    for label, A in (("annotation_well_name", A_name), ("column_major_well_number", A_cm)):
        ok = A["qc_pass"] & A["Control Type"].isna() & (A["Cell Count"] > 0)
        nuc = np.array([ws[w].n_nuclei for w in A.index[ok.to_numpy()]], float)
        cc = A.loc[ok, "Cell Count"].to_numpy(float)
        evidence[label] = {"n_wells": int(ok.sum()), "nuclei_vs_authors_cell_count": {
            "spearman": R.safe_spearman(nuc, cc), "pearson": R.safe_pearson(nuc, cc)}}
    evidence["cached_idr_png_check"] = idr_png_mapping_check()

    results = {"column_major_well_number": analyse("column_major_well_number", A_cm, ws, q_ws, l_ws, args, p),
               "annotation_well_name": analyse("annotation_well_name", A_name, ws, q_ws, l_ws, args, p)}
    report = {
        "experiment": "L2 - Experiment L repeated on raw idr0010 intensities (one plate)",
        "provenance": {
            "archive": "BioImage Archive S-BIAD885 (idr0010, Doil et al. Cell 2009, OME-NGFF conversion)",
            "licence": "CC BY 4.0",
            "file": Path(args.zip).name, "size_bytes": os.path.getsize(args.zip), "sha256_computed_locally": sha256(args.zip),
            "note": "the archive publishes no checksum; sha256 was computed after download; size matches the published file list",
            "plate": plate, "annotation": Path(args.annotation).name, "plate_grid_rows_cols": [n_rows, n_cols],
            "raw_intensity_range_seen": {"min": raw_min, "max": raw_max},
            "median_pixels_at_4095_in_53bp1_per_well": float(np.median(sat)),
            "channels": "labels from OME metadata: 'Dapi' = DNA, other = 53BP1",
        },
        "design": {"seed": SEED, "cv": "2-fold cross-fit; threshold chosen on the other fold by max Spearman with authors foci/cell",
                   "bootstrap": args.boot, "params_default_pipeline": p.__dict__,
                   "grids": {k: [float(x) for x in v] for k, v in R.SCORE_GRID.items()}
                   | {"legacy": [float(R.LEGACY_GRID[0]), float(R.LEGACY_GRID[-1])]},
                   "headline_rule": "raw detector with the highest mean training-fold Spearman",
                   "primary_mapping": "column_major_well_number"},
        "mapping_evidence": evidence,
        "results": results,
        "elapsed_s": round(time.time() - t0, 1),
    }
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(clean(report), indent=1) + "\n", encoding="utf-8")
    prim = results["column_major_well_number"]
    print(f"wrote {args.out}  (n={prim['wells']['analysed']}, headline {prim['headline_raw_detector']}, {report['elapsed_s']}s)")
    return report


if __name__ == "__main__":
    main()
