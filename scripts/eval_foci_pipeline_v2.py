"""Foci Lab nucleus pipeline v2 vs v1 on BBBC039 (U2OS Hoechst, CC0): tune on TRAIN, evaluate once on TEST.

Data (not in the repo; fetch once, 78 MB + 2.8 MB + 18 KB, from https://data.broadinstitute.org/bbbc/BBBC039/):
    images.zip  masks.zip  metadata.zip     ->  DIR  (default: $BBBC039_DIR or .cache/bbbc039)

    python scripts/eval_foci_pipeline_v2.py --tune     # coordinate descent on the 100 TRAIN images only
    python scripts/eval_foci_pipeline_v2.py --final    # test split (50 images), v1 vs v2, bootstrap CIs, writes the report

``--tune`` writes experiments/reports/foci_pipeline_v2_tuning.json (trace + chosen parameters) and never opens
the test split.  The chosen parameters are then frozen as the defaults of ``NucleusV2Params``.  ``--final``
refuses to run unless those defaults equal the tuned parameters (so nothing can be adjusted after seeing test
numbers) and records in the report that the test split was evaluated once.  The validation split (50) is
evaluated in ``--final`` as a secondary check only; nothing is chosen on it.

Metric: per image, predicted objects matched to ground-truth instances with IoU strictly greater than t
(unique for t >= 0.5); F1 = 2TP/(2TP+FP+FN); reported as the mean over images and also pooled.  Count error is
reported for the nuclei count each pipeline reports (v1: area-based estimate; v2: number of objects) and for
the number of objects.  Bootstrap: 2000 resamples of images, seed 0, percentile 95% CI; the paired difference
v2 - v1 is resampled on the same images.
"""

from __future__ import annotations

import argparse
import dataclasses
import io
import json
import os
import sys
import time
import zipfile
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage as ndi

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))

from telomere_lab.foci import segment as S  # noqa: E402
from telomere_lab.foci import segment_v2 as V2  # noqa: E402

REPORTS = ROOT / "experiments" / "reports"
TUNING = REPORTS / "foci_pipeline_v2_tuning.json"
REPORT = REPORTS / "foci_pipeline_v2.json"
THS = (0.5, 0.6, 0.7, 0.8, 0.9)
GRID = {  # coordinate descent, train only
    "thr_factor": [0.6, 0.7, 0.8, 0.9, 1.0],
    "sigma": [0.7, 1.0, 1.5, 2.0],
    "split_sigma": [0.5, 1.0, 1.5, 2.0],
    "h": [0.25, 0.5, 1.0, 1.5, 2.0],
    "intensity_weight": [0.0, 0.2, 0.4, 0.7, 1.0],
    "intensity_sigma": [1.0, 2.0, 3.0],
    "min_nucleus_px": [30, 60, 100, 150],
    "background_size": [31, 41, 61],
}
BOOT = 2000


# ----------------------------------------------------------------------------------- data

def data_dir(arg):
    d = Path(arg or os.environ.get("BBBC039_DIR") or ROOT / ".cache" / "bbbc039")
    for f in ("images.zip", "masks.zip", "metadata.zip"):
        if not (d / f).is_file():
            raise SystemExit(f"{d / f} not found. Download images.zip, masks.zip, metadata.zip once from "
                             "https://data.broadinstitute.org/bbbc/BBBC039/ (CC0) into that folder, or pass --data.")
    return d


def split_names(d, split):
    with zipfile.ZipFile(d / "metadata.zip") as z:
        name = next(n for n in z.namelist() if n.endswith(f"{split}.txt") and "__MACOSX" not in n)
        return [l.strip().replace(".png", "") for l in z.read(name).decode().splitlines() if l.strip()]


def load_split(d, split):
    """-> list of (name, uint16 image, int32 instance labels); raw 12-bit values, as the pipeline gets them."""
    out = []
    with zipfile.ZipFile(d / "images.zip") as iz, zipfile.ZipFile(d / "masks.zip") as mz:
        for n in split_names(d, split):
            im = np.array(Image.open(io.BytesIO(iz.read(f"images/{n}.tif"))))
            a = np.array(Image.open(io.BytesIO(mz.read(f"masks/{n}.png"))))[..., 0]
            lab = np.zeros(a.shape, np.int32)
            c = 0
            for k in range(1, int(a.max()) + 1):  # touching nuclei carry different values; split each value into components
                l, m = ndi.label(a == k)
                lab[l > 0] = l[l > 0] + c
                c += m
            out.append((n, im, lab))
    return out


# --------------------------------------------------------------------------------- metrics

def match_counts(pred, gt, ths=THS):
    """-> list of (tp, fp, fn) per threshold (IoU strictly greater than t)."""
    npred, ng = int(pred.max()), int(gt.max())
    if npred == 0 or ng == 0:
        return [(0, npred, ng) for _ in ths]
    cnt = np.bincount((pred.astype(np.int64) * (ng + 1) + gt).ravel(), minlength=(npred + 1) * (ng + 1)).reshape(npred + 1, ng + 1)
    ap, ag = cnt.sum(1), cnt.sum(0)
    inter = cnt[1:, 1:]
    iou = inter / np.maximum(ap[1:, None] + ag[None, 1:] - inter, 1)
    out = []
    for t in ths:
        tp = int((iou > t).sum())
        out.append((tp, npred - tp, ng - tp))
    return out


def f1_of(tp, fp, fn):
    return 2 * tp / (2 * tp + fp + fn) if (2 * tp + fp + fn) else 1.0


def run_pipeline(version, img, p2):
    d = img.astype(np.float32)
    if version == "v1":
        lab = S.segment_nuclei(d, S.FociParams())
        n_est = int(S.estimate_nuclei(lab).sum()) if lab.max() else 0
    else:
        lab = V2.segment_nuclei_v2(d, p2)
        n_est = int(lab.max())
    return lab, n_est


def evaluate(images, version, p2=None):
    rows = []
    for name, im, gt in images:
        lab, n_est = run_pipeline(version, im, p2)
        mc = match_counts(lab, gt)
        a, b = lab > 0, gt > 0
        rows.append({
            "image": name, "gt_n": int(gt.max()), "objects": int(lab.max()), "nuclei_count": n_est,
            "tp": [m[0] for m in mc], "fp": [m[1] for m in mc], "fn": [m[2] for m in mc],
            "f1": [f1_of(*m) for m in mc], "dice_fg": float(2 * (a & b).sum() / max(a.sum() + b.sum(), 1)),
        })
    return rows


def objective(rows):
    return float(np.mean([r["f1"] for r in rows]))  # mean over images and over IoU 0.5..0.9


def _ci(samples):
    return [float(np.percentile(samples, 2.5)), float(np.percentile(samples, 97.5))]


def summarise(rows_by, ref="v1", seed=0):
    """Per-arm metrics with bootstrap CIs over images, and paired differences against ``ref``."""
    rng = np.random.default_rng(seed)
    n = len(rows_by[ref])
    boots = rng.integers(0, n, (BOOT, n))  # the same resamples for every arm -> paired differences
    out = {"n_images": n, "arms": {}, "paired_vs_" + ref: {}}

    def stats(rows):
        f1 = np.array([r["f1"] for r in rows])
        gt = np.array([r["gt_n"] for r in rows], float)
        o = np.array([r["objects"] for r in rows], float)
        c = np.array([r["nuclei_count"] for r in rows], float)
        tp, fp, fn = (np.array([r[k] for r in rows], float) for k in ("tp", "fp", "fn"))
        return f1, gt, o, c, tp, fp, fn

    for arm, rows in rows_by.items():
        f1, gt, o, c, tp, fp, fn = stats(rows)
        d = {"f1_mean": {}, "f1_pooled": {}, "f1_mean_ci95": {}}
        for k, t in enumerate(THS):
            d["f1_mean"][str(t)] = float(f1[:, k].mean())
            d["f1_mean_ci95"][str(t)] = _ci(f1[boots, k].mean(1))
            d["f1_pooled"][str(t)] = float(f1_of(tp[:, k].sum(), fp[:, k].sum(), fn[:, k].sum()))
        af = f1.mean(1)
        d["f1_avg_0.5_0.9"] = float(af.mean())
        d["f1_avg_0.5_0.9_ci95"] = _ci(af[boots].mean(1))
        for label, v in (("nuclei_count", c), ("objects", o)):
            err = v - gt
            d[label] = {
                "mean_per_image": float(v.mean()), "gt_mean_per_image": float(gt.mean()),
                "bias": float(err.mean()), "bias_ci95": _ci(err[boots].mean(1)),
                "mae": float(np.abs(err).mean()), "mae_ci95": _ci(np.abs(err)[boots].mean(1)),
                "relative_bias_pct": float(100 * err.sum() / gt.sum()),
                "relative_bias_pct_ci95": _ci(100 * err[boots].sum(1) / gt[boots].sum(1)),
                "total": int(v.sum()), "gt_total": int(gt.sum()),
            }
        d["foreground_dice_mean"] = float(np.mean([r["dice_fg"] for r in rows]))
        out["arms"][arm] = d
    f1r, gtr, orr, cr, *_ = stats(rows_by[ref])
    for arm, rows in rows_by.items():
        if arm == ref:
            continue
        f1, gt, o, c, *_ = stats(rows)
        dd = {"f1_diff": {}, "f1_diff_ci95": {}}
        for k, t in enumerate(THS):
            diff = f1[:, k] - f1r[:, k]
            dd["f1_diff"][str(t)] = float(diff.mean())
            dd["f1_diff_ci95"][str(t)] = _ci(diff[boots].mean(1))
        diff = f1.mean(1) - f1r.mean(1)
        dd["f1_avg_diff"] = float(diff.mean())
        dd["f1_avg_diff_ci95"] = _ci(diff[boots].mean(1))
        e = np.abs(c - gt) - np.abs(cr - gtr)
        dd["count_mae_diff"] = float(e.mean())
        dd["count_mae_diff_ci95"] = _ci(e[boots].mean(1))
        out["paired_vs_" + ref][arm] = dd
    return out


# ------------------------------------------------------------------------------------ tune

def _write_tuning(cur, best, trace, done):
    TUNING.parent.mkdir(parents=True, exist_ok=True)
    TUNING.write_text(json.dumps({
        "split": "training (100 images)", "objective": "mean F1 over images and IoU thresholds 0.5..0.9",
        "grid": GRID, "complete": done, "chosen": dataclasses.asdict(cur), "chosen_objective": best, "trace": trace,
    }, indent=1) + "\n", encoding="utf-8")


def tune(d, rounds=2, start=None):
    """Coordinate descent over GRID on the training split. ``start`` (dict) resumes from a known point; the run is
    checkpointed after every improvement, so an interrupted tuning can be continued with ``--start``."""
    train = load_split(d, "training")
    assert len(train) == 100
    cur = dataclasses.replace(V2.NucleusV2Params(), **(start or {}))
    trace = []

    def score(p):
        for attempt in range(40):  # the machine may be short of memory because of other jobs: wait and retry, never skip
            try:
                return objective(evaluate(train, "v2", p))
            except MemoryError:
                print("  (out of memory, retrying in 30 s)", flush=True)
                time.sleep(30)
        raise SystemExit("persistent out-of-memory")

    best = score(cur)
    trace.append({"params": dataclasses.asdict(cur), "objective": best, "note": "start (initial defaults)" if not start else "resumed from a checkpoint"})
    print("start", round(best, 4), flush=True)
    for r in range(rounds):
        changed = False
        for key, vals in GRID.items():
            for v in vals:
                if getattr(cur, key) == v:
                    continue
                cand = dataclasses.replace(cur, **{key: v})
                s = score(cand)
                trace.append({"params": dataclasses.asdict(cand), "objective": s, "note": f"round {r + 1}: {key}={v}"})
                print(f"round {r + 1} {key}={v}: {s:.4f}", flush=True)
                if s > best + 1e-9:
                    best, cur, changed = s, cand, True
                    print("  -> new best", round(best, 4), dataclasses.asdict(cur), flush=True)
                    _write_tuning(cur, best, trace, False)
        if not changed:
            break
    _write_tuning(cur, best, trace, True)
    print("chosen", dataclasses.asdict(cur), "objective", round(best, 4))


# ----------------------------------------------------------------------------------- final

def final(d):
    tuned = json.loads(TUNING.read_text(encoding="utf-8"))
    if tuned["chosen"] != dataclasses.asdict(V2.NucleusV2Params()):
        raise SystemExit("NucleusV2Params defaults differ from the parameters chosen on the training split "
                         f"({TUNING.name}); freeze them in segment_v2.py before the single test run.")
    p2 = V2.NucleusV2Params()
    import scipy
    out = {"pipeline_versions": ["v1", "v2"], "dataset": "BBBC039 (CC0)", "v2_params": dataclasses.asdict(p2),
           "tuned_on": "training split (100 images) only", "tuning_file": "experiments/reports/foci_pipeline_v2_tuning.json",
           "tuning_objective_train": tuned["chosen_objective"],
           "metric": "F1 at IoU strictly > t, mean over images; bootstrap 2000 resamples of images, seed 0",
           "v1_params": dataclasses.asdict(S.FociParams()),
           "env": {"python": sys.version.split()[0], "numpy": np.__version__, "scipy": scipy.__version__}}
    arms = {"v1": ("v1", None),
            "v2": ("v2", p2),
            "v2_foreground_only": ("v2", dataclasses.replace(p2, h=1e6)),                   # ablation: tight foreground, no split
            "v2_no_intensity": ("v2", dataclasses.replace(p2, intensity_weight=0.0))}        # ablation: distance-only split
    for split in ("test", "validation"):
        images = load_split(d, split)
        rows = {}
        for arm, (ver, pp) in arms.items():
            t = time.time()
            rows[arm] = evaluate(images, ver, pp)
            print(split, arm, round(objective(rows[arm]), 4), f"{time.time() - t:.0f}s", flush=True)
        out[split] = summarise(rows)
        out[split]["note"] = "evaluated once, after the parameters were frozen" if split == "test" else "secondary check; nothing was chosen on it"
        out[split]["per_image"] = {a: [{**{k: r[k] for k in ("image", "gt_n", "objects", "nuclei_count")}, "f1": [round(x, 4) for x in r["f1"]]} for r in rs]
                                   for a, rs in rows.items()}
    REPORT.write_text(json.dumps(out, indent=1) + "\n", encoding="utf-8")
    print("wrote", REPORT)
    for arm, a in out["test"]["arms"].items():
        print(arm, {k: round(v, 3) for k, v in a["f1_mean"].items()}, "avg", round(a["f1_avg_0.5_0.9"], 3),
              "count bias", round(a["nuclei_count"]["bias"], 2), "MAE", round(a["nuclei_count"]["mae"], 2))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", help="folder with images.zip, masks.zip, metadata.zip")
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--tune", action="store_true")
    g.add_argument("--final", action="store_true")
    ap.add_argument("--start", help="with --tune: resume from these parameters, e.g. sigma=0.7,h=1.0")
    ap.add_argument("--rounds", type=int, default=2)
    a = ap.parse_args()
    d = data_dir(a.data)
    if a.tune:
        proto = V2.NucleusV2Params()
        start = {k: type(getattr(proto, k))(v) for k, v in (kv.split("=") for kv in a.start.split(","))} if a.start else None
        tune(d, a.rounds, start)
    else:
        final(d)


if __name__ == "__main__":
    main()
