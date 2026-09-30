"""Experiment L2: the 53BP1 foci re-test on raw (un-rendered) idr0010 data.

Reads the OME-Zarr plate zips of BioImage Archive S-BIAD885 (idr0010 converted to
OME-NGFF) and runs foci detectors on the un-rendered integer intensities instead of
the 8-bit windowed PNG that the IDR web API serves. Nothing here changes the default
8-bit pipeline (``segment.py``); it only composes scipy operations and reuses
``FociParams`` / ``segment_nuclei`` / ``estimate_nuclei`` read-only.

* ``zarr`` is an OPTIONAL dependency, imported lazily inside ``OmeZarrPlate`` only
  (``pip install zarr``). Everything else in this module is plain numpy/scipy.
* All arithmetic is done in float32 (never on uint16, which would wrap on subtraction).
* Detectors expose *candidates* (one per local maximum, with a score) so a threshold can
  be re-applied cheaply and calibrated on a training split only (``crossfit_calibrate``).

The authors' focus definition (ImageJ routine, thresholds) is NOT published; none of the
detectors here claims to be it.
"""

from __future__ import annotations

import json
import re
import zipfile
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Sequence, Tuple

import numpy as np
from scipy import ndimage as ndi
from scipy.stats import rankdata, spearmanr

from .segment import FociParams, estimate_nuclei, segment_nuclei

DETECTORS = ("tophat_mad", "dog_mad", "nuc_ratio")
# candidate floors (scores below are never stored); grids for calibration stay above them
SCORE_FLOOR = {"tophat_mad": 1.0, "dog_mad": 1.0, "nuc_ratio": 0.02}
SCORE_GRID = {
    "tophat_mad": np.round(np.geomspace(1.5, 150.0, 28), 3),
    "dog_mad": np.round(np.geomspace(1.5, 150.0, 28), 3),
    "nuc_ratio": np.round(np.geomspace(0.03, 3.0, 28), 4),
}
LEGACY_GRID = np.arange(1.0, 61.0, 1.0)  # min_height grey levels of the 8-bit pipeline


# --------------------------------------------------------------------------- OME-Zarr I/O
def well_name(row_label: str, col_label) -> str:
    """Annotation-style well name: row letter + 1-based column WITHOUT zero padding ('A1', not 'A01')."""
    return f"{str(row_label).strip().upper()}{int(str(col_label).strip())}"


def colmajor_well_number(row_index: int, col_index: int, n_rows: int) -> int:
    """1-based annotation 'Well Number' of the image at zero-based (row_index, col_index) of the IDR/zarr grid.

    Empirical finding of Experiment L2 (docs 15.4): the images' grid is numbered COLUMN-major (A1, B1, ... L1, A2, ...)
    when matched to the authors' records, whereas the annotation's ``Well`` letter+column name is ROW-major
    (A1, A2, ... A32, B1, ...). Matching by name pairs an image with another well's numbers."""
    return int(col_index) * int(n_rows) + int(row_index) + 1


def rowmajor_well_number(row_index: int, col_index: int, n_cols: int) -> int:
    """1-based row-major number of grid position (row_index, col_index): what the annotation's ``Well`` name encodes."""
    return int(row_index) * int(n_cols) + int(col_index) + 1


def render_8bit(a: np.ndarray, lo: float, hi: float) -> np.ndarray:
    """Linear window lo..hi -> 0..255, rounded, clipped (the IDR web render of one greyscale channel)."""
    a = np.asarray(a, dtype=np.float32)
    span = max(float(hi) - float(lo), 1e-6)
    return np.clip(np.rint((a - float(lo)) / span * 255.0), 0, 255).astype(np.float32)


def unrender_8bit(q: np.ndarray, lo: float, hi: float) -> np.ndarray:
    """Map 8-bit grey levels back to raw intensity units (quantised: 255 levels over lo..hi)."""
    return float(lo) + np.asarray(q, dtype=np.float32) * (max(float(hi) - float(lo), 1e-6) / 255.0)


class OmeZarrPlate:
    """Read-only view of one idr0010 plate zip (OME-Zarr v0.4, bioformats2raw layout)."""

    def __init__(self, path: str):
        try:
            import zarr  # optional dependency, imported lazily on purpose
        except ImportError as e:  # pragma: no cover - exercised only without zarr
            raise ImportError("reading OME-Zarr needs the optional 'zarr' package (pip install zarr)") from e
        self.path = str(path)
        with zipfile.ZipFile(self.path) as zf:
            roots = {n.split("/", 1)[0] for n in zf.namelist() if "/" in n}
        roots = sorted(r for r in roots if r.endswith(".zarr"))
        if len(roots) != 1:
            raise ValueError(f"expected exactly one *.zarr root in {self.path}, found {roots}")
        self.root = roots[0]
        self._store = zarr.storage.ZipStore(self.path, mode="r")
        try:
            self._g = zarr.open_group(self._store, mode="r", path=self.root, zarr_format=2)
        except TypeError:  # zarr 2.x has no zarr_format kwarg
            self._g = zarr.open_group(self._store, mode="r", path=self.root)
        plate = json.loads(self._read_json(".zattrs"))["plate"]
        rows = [r["name"] for r in plate["rows"]]
        cols = [c["name"] for c in plate["columns"]]
        self.n_rows, self.n_cols = len(rows), len(cols)
        self.wells: Dict[str, str] = {}
        self.grid: Dict[str, Tuple[int, int]] = {}  # name -> zero-based (row_index, column_index)
        for w in plate["wells"]:
            # rowIndex / columnIndex are zero-based; the path ("A/1") carries the 1-based labels
            name = well_name(rows[w["rowIndex"]], cols[w["columnIndex"]])
            if w["path"].replace("/", "") != name:
                raise ValueError(f"well path {w['path']} disagrees with row/column indices ({name})")
            self.wells[name] = w["path"]
            self.grid[name] = (int(w["rowIndex"]), int(w["columnIndex"]))

    def _read_json(self, rel: str) -> str:
        with zipfile.ZipFile(self.path) as zf:
            return zf.read(f"{self.root}/{rel}").decode()

    def close(self) -> None:
        self._store.close()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()

    def read_well(self, name: str) -> Tuple[np.ndarray, np.ndarray, Dict[str, Tuple[float, float]]]:
        """(dna, foci53bp1, windows) at full resolution; arrays are uint16 in native byte order (y, x).

        The axes come from the well's multiscales metadata (idr0010: t, c, z, y, x), and the two
        channels are identified from the omero channel labels ("Dapi" = DNA; the other = 53BP1).
        windows = {"dna": (start, end), "foci": (start, end)} as stored (the IDR render window).
        """
        wpath = self.wells[name]
        img = self._g[f"{wpath}/0"]
        attrs = dict(img.attrs)
        ms = attrs["multiscales"][0]
        axes = [a["name"] for a in ms["axes"]]
        arr = img[ms["datasets"][0]["path"]]
        if arr.dtype.kind != "u" or arr.dtype.itemsize != 2:
            raise ValueError(f"expected uint16 data, got {arr.dtype}")
        full = np.asarray(arr[...])
        idx = []
        for ax in axes:
            if ax in ("t", "z"):
                idx.append(0)
            else:
                idx.append(slice(None))
        sub = full[tuple(idx)]
        keep = [a for a in axes if a not in ("t", "z")]
        if sorted(keep) != ["c", "x", "y"]:
            raise ValueError(f"unexpected axes {axes}")
        sub = np.transpose(sub, [keep.index(a) for a in ("c", "y", "x")]).astype(np.uint16)
        chans = attrs["omero"]["channels"]
        labels = [str(c.get("label", "")).lower() for c in chans]
        dna_i = [i for i, l in enumerate(labels) if "dapi" in l or "hoechst" in l]
        if len(chans) != 2 or len(dna_i) != 1:
            raise ValueError(f"cannot identify channels from labels {labels}")
        dna_i = dna_i[0]
        foc_i = 1 - dna_i
        w = lambda i: (float(chans[i]["window"]["start"]), float(chans[i]["window"]["end"]))  # noqa: E731
        return sub[dna_i], sub[foc_i], {"dna": w(dna_i), "foci": w(foc_i)}


# --------------------------------------------------------------------------- detectors
@dataclass
class Cands:
    """Foci candidates of one detector: one entry per local maximum above the floor."""
    obj: np.ndarray      # int32 nuclear-object label (1-based) the maximum lies in
    score: np.ndarray    # float32 detector score (unit depends on the detector)
    height: np.ndarray   # float32 top-hat / DoG height in raw intensity units


@dataclass
class WellData:
    n_objects: int
    obj_nuclei: np.ndarray               # int, nuclei estimate per object (estimate_nuclei)
    obj_area: np.ndarray                 # int pixels per object
    sigma: Dict[str, float] = field(default_factory=dict)  # noise scale per MAD detector (raw units)
    cands: Dict[str, Cands] = field(default_factory=dict)

    @property
    def n_nuclei(self) -> int:
        return int(self.obj_nuclei.sum())


def robust_sigma(x: np.ndarray, floor: float = 1.0) -> float:
    """1.4826 x MAD of x (raw intensity units), never below ``floor`` (guards the MAD collapse on coarse data)."""
    x = np.asarray(x, dtype=np.float64).ravel()
    if x.size == 0:
        return float(floor)
    return float(max(1.4826 * np.median(np.abs(x - np.median(x))), floor))


def local_maxima(img: np.ndarray, allowed: np.ndarray, floor: float, window: int, dedupe: bool = True):
    """Coordinates of local maxima of ``img`` >= floor inside ``allowed``.

    ``dedupe`` keeps a single pixel per connected plateau (flat tops appear on coarse/saturated data
    and would otherwise count one spot several times)."""
    peaks = (img == ndi.maximum_filter(img, size=window)) & (img >= floor) & allowed
    if dedupe and peaks.any():
        lab, n = ndi.label(peaks, structure=np.ones((3, 3), bool))
        ys, xs = np.nonzero(peaks)
        first = np.unique(lab[ys, xs], return_index=True)[1]
        return ys[first], xs[first]
    return np.nonzero(peaks)


def well_candidates(dna: np.ndarray, foci: np.ndarray, p: FociParams = FociParams(),
                    detectors: Sequence[str] = DETECTORS, wide_sigma: float = 3.0,
                    legacy_floor: Optional[float] = None) -> WellData:
    """Segment nuclei on ``dna`` and collect foci candidates on ``foci`` (both raw intensities).

    Nuclei: ``segment_nuclei`` (unchanged). Detectors (all on the Gaussian-smoothed 53BP1 channel):

    * ``tophat_mad``: white top-hat maxima; score = height / (1.4826 MAD of the top-hat inside nuclei).
    * ``dog_mad``: difference of Gaussians (sigma vs ``wide_sigma``) maxima; score = height / (1.4826 MAD of the DoG in nuclei).
    * ``nuc_ratio``: top-hat height relative to the object's own diffuse level
      (median smoothed 53BP1 in the nucleus minus the median outside nuclei) -- dimensionless.
    * ``legacy``: exactly the 8-bit pipeline's candidates (no plateau de-duplication), score = top-hat height in
      the input's own units; only produced when ``legacy_floor`` is given (used to verify against ``count_foci``).
    """
    dna_f = np.asarray(dna, dtype=np.float32)
    foc_f = np.asarray(foci, dtype=np.float32)
    nuclei = segment_nuclei(dna_f, p)
    n_obj = int(nuclei.max())
    wd = WellData(n_obj, np.zeros(0, int), np.zeros(0, int))
    if n_obj == 0:
        return wd
    wd.obj_nuclei = estimate_nuclei(nuclei)
    wd.obj_area = np.bincount(nuclei.ravel())[1:]
    inside = nuclei > 0
    smooth = ndi.gaussian_filter(foc_f, p.foci_sigma)
    top = ndi.white_tophat(smooth, size=p.tophat_size)

    def pack(ys, xs, score, height) -> Cands:
        return Cands(nuclei[ys, xs].astype(np.int32), score.astype(np.float32), height.astype(np.float32))

    if "tophat_mad" in detectors:
        s = robust_sigma(top[inside])
        ys, xs = local_maxima(top, inside, SCORE_FLOOR["tophat_mad"] * s, p.peak_window)
        wd.sigma["tophat_mad"] = s
        wd.cands["tophat_mad"] = pack(ys, xs, top[ys, xs] / s, top[ys, xs])
    if "dog_mad" in detectors:
        dog = smooth - ndi.gaussian_filter(foc_f, wide_sigma)
        s = robust_sigma(dog[inside])
        ys, xs = local_maxima(dog, inside, SCORE_FLOOR["dog_mad"] * s, p.peak_window)
        wd.sigma["dog_mad"] = s
        wd.cands["dog_mad"] = pack(ys, xs, dog[ys, xs] / s, dog[ys, xs])
    if "nuc_ratio" in detectors:
        outside = ~ndi.binary_dilation(inside, iterations=5)
        bg = float(np.median(smooth[outside])) if outside.sum() > 100 else float(np.median(smooth))
        med = np.asarray(ndi.median(smooth, labels=nuclei, index=np.arange(1, n_obj + 1)), dtype=np.float32)
        diffuse = np.maximum(med - bg, 1.0)  # >= 1 raw unit: no division by ~0 for empty/dark objects
        ys, xs = local_maxima(top, inside, 1e-6, p.peak_window)
        score = top[ys, xs] / diffuse[nuclei[ys, xs] - 1]
        keep = score >= SCORE_FLOOR["nuc_ratio"]
        wd.cands["nuc_ratio"] = pack(ys[keep], xs[keep], score[keep], top[ys, xs][keep])
    if legacy_floor is not None:
        ys, xs = local_maxima(top, inside, legacy_floor, p.peak_window, dedupe=False)
        wd.cands["legacy"] = pack(ys, xs, top[ys, xs], top[ys, xs])
    return wd


# --------------------------------------------------------------------------- per-well measures
def per_object_counts(wd: WellData, detector: str, thr: float) -> np.ndarray:
    """Foci per nuclear object at score >= thr (length n_objects)."""
    c = wd.cands[detector]
    return np.bincount(c.obj[c.score >= thr], minlength=wd.n_objects + 1)[1:]


def per_object_intensity(wd: WellData, detector: str, thr: float) -> np.ndarray:
    """Integrated focus height (raw units) per nuclear object at score >= thr."""
    c = wd.cands[detector]
    m = c.score >= thr
    return np.bincount(c.obj[m], weights=c.height[m], minlength=wd.n_objects + 1)[1:]


def foci_per_cell(wd: WellData, detector: str, thr: float) -> float:
    if wd.n_objects == 0 or wd.n_nuclei == 0:
        return float("nan")
    return float(per_object_counts(wd, detector, thr).sum() / wd.n_nuclei)


def fpc_matrix(wds: Sequence[WellData], detector: str, grid: Sequence[float]) -> np.ndarray:
    """(n_wells, len(grid)) foci/cell at every grid threshold; NaN where a well has no nuclei."""
    out = np.full((len(wds), len(grid)), np.nan)
    for i, wd in enumerate(wds):
        if wd.n_objects == 0:
            continue
        c = wd.cands[detector]
        for j, t in enumerate(grid):
            out[i, j] = np.count_nonzero(c.score >= t) / wd.n_nuclei
    return out


# --------------------------------------------------------------------------- calibration / statistics
def safe_spearman(x, y) -> float:
    x, y = np.asarray(x, float), np.asarray(y, float)
    m = np.isfinite(x) & np.isfinite(y)
    if m.sum() < 3 or np.ptp(x[m]) == 0 or np.ptp(y[m]) == 0:
        return float("nan")
    return float(spearmanr(x[m], y[m])[0])


def safe_pearson(x, y) -> float:
    x, y = np.asarray(x, float), np.asarray(y, float)
    m = np.isfinite(x) & np.isfinite(y)
    if m.sum() < 3 or np.ptp(x[m]) == 0 or np.ptp(y[m]) == 0:
        return float("nan")
    return float(np.corrcoef(x[m], y[m])[0, 1])


def make_folds(n: int, seed: int = 0, k: int = 2) -> np.ndarray:
    """Deterministic fold id per well (random permutation, balanced)."""
    perm = np.random.default_rng(seed).permutation(n)
    fold = np.empty(n, int)
    fold[perm] = np.arange(n) % k
    return fold


def crossfit_calibrate(mat: np.ndarray, y: np.ndarray, folds: np.ndarray):
    """Choose the grid column maximising Spearman(mat[:, j], y) on each fold's TRAINING wells only.

    Returns (chosen_index_per_fold, oof_prediction, train_spearman_per_fold) where the prediction for a well
    uses the column chosen without that well's fold. Ties -> the lowest threshold (first column)."""
    k = int(folds.max()) + 1
    chosen, train_rho = [], []
    oof = np.full(mat.shape[0], np.nan)
    for f in range(k):
        tr, te = folds != f, folds == f
        rhos = np.array([safe_spearman(mat[tr, j], y[tr]) for j in range(mat.shape[1])])
        j = int(np.nanargmax(rhos)) if np.isfinite(rhos).any() else 0
        chosen.append(j)
        train_rho.append(float(rhos[j]))
        oof[te] = mat[te, j]
    return chosen, oof, train_rho


def auc_mw(pos: Sequence[float], neg: Sequence[float]) -> float:
    """P(pos > neg) + 0.5 P(tie), via ranks; NaN if either side is empty."""
    pos, neg = np.asarray(pos, float), np.asarray(neg, float)
    pos, neg = pos[np.isfinite(pos)], neg[np.isfinite(neg)]
    if pos.size == 0 or neg.size == 0:
        return float("nan")
    r = rankdata(np.concatenate([pos, neg]))
    return float((r[: pos.size].sum() - pos.size * (pos.size + 1) / 2) / (pos.size * neg.size))


def bootstrap_ci(fn, n: int, boot: int = 2000, seed: int = 0, strata: Optional[np.ndarray] = None,
                 alpha: float = 0.05) -> Tuple[float, float]:
    """Percentile CI of ``fn(idx)`` over resamples of range(n) (stratified when ``strata`` is given)."""
    rng = np.random.default_rng(seed)
    groups = [np.arange(n)] if strata is None else [np.nonzero(strata == s)[0] for s in np.unique(strata)]
    vals = []
    for _ in range(boot):
        idx = np.concatenate([g[rng.integers(0, g.size, g.size)] for g in groups if g.size])
        v = fn(idx)
        if np.isfinite(v):
            vals.append(v)
    if len(vals) < max(10, boot // 10):
        return float("nan"), float("nan")
    lo, hi = np.quantile(vals, [alpha / 2, 1 - alpha / 2])
    return float(lo), float(hi)


def summarise_corr(pred: np.ndarray, y: np.ndarray, boot: int = 2000, seed: int = 0) -> dict:
    """Spearman and Pearson of pred vs y with percentile bootstrap CIs (wells resampled)."""
    m = np.isfinite(pred) & np.isfinite(y)
    p, t = pred[m], y[m]
    out = {"n": int(m.sum()), "spearman": safe_spearman(p, t), "pearson": safe_pearson(p, t)}
    out["spearman_ci95"] = list(bootstrap_ci(lambda i: safe_spearman(p[i], t[i]), p.size, boot, seed))
    out["pearson_ci95"] = list(bootstrap_ci(lambda i: safe_pearson(p[i], t[i]), p.size, boot, seed))
    return out


def paired_spearman_diff(a: np.ndarray, b: np.ndarray, y: np.ndarray, boot: int = 2000, seed: int = 0) -> dict:
    """Spearman(a, y) - Spearman(b, y) on the same wells, bootstrap CI from the same resamples."""
    m = np.isfinite(a) & np.isfinite(b) & np.isfinite(y)
    a, b, t = a[m], b[m], y[m]
    d = safe_spearman(a, t) - safe_spearman(b, t)
    lo, hi = bootstrap_ci(lambda i: safe_spearman(a[i], t[i]) - safe_spearman(b[i], t[i]), a.size, boot, seed)
    return {"n": int(m.sum()), "diff": float(d), "ci95": [lo, hi]}


def auc_with_ci(score: np.ndarray, is_pos: np.ndarray, boot: int = 2000, seed: int = 0) -> dict:
    """AUC of ``score`` for positives vs the rest (stratified bootstrap over wells)."""
    m = np.isfinite(score)
    s, pos = score[m], is_pos[m].astype(bool)
    out = {"n_pos": int(pos.sum()), "n_neg": int((~pos).sum())}
    out["auc"] = auc_mw(s[pos], s[~pos])
    out["auc_ci95"] = list(bootstrap_ci(lambda i: auc_mw(s[i][pos[i]], s[i][~pos[i]]), s.size, boot, seed, strata=pos.astype(int)))
    return out


def pooled_distribution_auc(groups_pos: List[np.ndarray], groups_neg: List[np.ndarray],
                            boot: int = 1000, seed: int = 0) -> dict:
    """AUC between per-nucleus values pooled over the positive wells and over the other wells.

    The CI resamples WELLS (not nuclei) within each group, so nuclei of one well are not treated as independent."""
    def pooled(gs, idx):
        parts = [gs[i] for i in idx if gs[i].size]
        return np.concatenate(parts) if parts else np.zeros(0)

    a_all = pooled(groups_pos, range(len(groups_pos)))
    b_all = pooled(groups_neg, range(len(groups_neg)))
    est = auc_mw(a_all, b_all)
    rng = np.random.default_rng(seed)
    vals = []
    for _ in range(boot):
        ia = rng.integers(0, len(groups_pos), len(groups_pos)) if groups_pos else []
        ib = rng.integers(0, len(groups_neg), len(groups_neg)) if groups_neg else []
        v = auc_mw(pooled(groups_pos, ia), pooled(groups_neg, ib))
        if np.isfinite(v):
            vals.append(v)
    ci = [float(x) for x in np.quantile(vals, [0.025, 0.975])] if len(vals) > 10 else [float("nan")] * 2
    return {"auc": est, "auc_ci95": ci, "n_nuclei_pos": int(a_all.size), "n_nuclei_other": int(b_all.size),
            "median_pos": float(np.median(a_all)) if a_all.size else float("nan"),
            "median_other": float(np.median(b_all)) if b_all.size else float("nan"),
            "mean_pos": float(a_all.mean()) if a_all.size else float("nan"),
            "mean_other": float(b_all.mean()) if b_all.size else float("nan")}
