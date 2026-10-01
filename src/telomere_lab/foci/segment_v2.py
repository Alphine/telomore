"""Nucleus segmentation, pipeline "v2": a tighter foreground and a split of touching nuclei.

``segment.py`` (pipeline "v1") is frozen: it labels connected components of a loose mask (Gaussian sigma 2 ->
background opening subtracted -> Otsu on *log* intensity), so touching nuclei share one object and every
object is about 1.7x too big on BBBC039 (foreground Dice 0.75).  v2 changes two things and keeps the foci stage
of v1 untouched:

1. Foreground: Gaussian ``sigma`` (default 0.7) -> background opening subtracted -> *linear* Otsu on the positive
   values, scaled by ``thr_factor`` -> one binary opening -> fill holes.
2. Split: exact Euclidean distance transform of the (zero-padded) mask, Gaussian-smoothed (``split_sigma``),
   optionally plus a fraction (``intensity_weight``) of the smoothed DNA intensity, quantised to 1/32 px.
   The quantised surface is flooded from its maxima downwards in a single pass (decreasing level, raster order
   within a level, 4-connected).  A basin whose peak lies less than ``h`` above the level at which it meets a
   higher basin is merged into it (h-maxima markers / dynamics); otherwise the two basins stay separate objects.
   This is exactly "h-maxima markers + marker-controlled watershed", computed in one deterministic integer pass,
   so the JavaScript engine can reproduce it label for label (foci/web/engine/engine.js, ``segmentNucleiV2``).

All arithmetic that decides a label is either integer or IEEE-754 double on float32 inputs, evaluated in the same
order in both implementations.  Nothing here changes the behaviour of ``segment.py``.
"""

from __future__ import annotations

from dataclasses import dataclass, asdict
from typing import Dict, List

import numpy as np
from scipy import ndimage as ndi

from .segment import FociParams, SegmentationResult

PIPELINE_V2 = "v2"
Q_SCALE = 32.0  # surface quantisation: 1/32 px


@dataclass(frozen=True)
class NucleusV2Params:
    sigma: float = 0.7               # Gaussian sigma of the DNA channel before thresholding
    background_size: int = 41        # grey-opening window (odd), flattens uneven illumination
    thr_factor: float = 0.8          # multiplier on the linear Otsu threshold
    min_nucleus_px: int = 60         # objects smaller than this are dropped (after the split)
    split_sigma: float = 0.5         # Gaussian sigma of the distance map (0 = none)
    h: float = 1.0                   # minimum dynamics (px of smoothed distance) of a separate nucleus
    intensity_weight: float = 0.4    # weight of the smoothed DNA intensity in the split surface (0 = distance only)
    intensity_sigma: float = 1.0     # Gaussian sigma of that intensity term


def v2_params_dict(p: NucleusV2Params) -> Dict[str, float]:
    return asdict(p)


def _linear_otsu(flat: np.ndarray) -> float:
    from .segment import otsu_threshold

    v = flat[flat > 0]
    return float(otsu_threshold(v)) if v.size else 0.0


def _edt_padded(mask: np.ndarray) -> np.ndarray:
    """float32 distance to the nearest background pixel; the image is padded with one background pixel all round."""
    d = ndi.distance_transform_edt(np.pad(mask, 1))
    return d[1:-1, 1:-1].astype(np.float32)


def quantised_surface(dna: np.ndarray, mask: np.ndarray, p: NucleusV2Params) -> np.ndarray:
    """int64 split surface (higher = more nucleus-centre-like); values outside ``mask`` are meaningless."""
    ds = _edt_padded(mask)
    if p.split_sigma > 0:
        ds = ndi.gaussian_filter(ds, p.split_sigma)
    el = ds.astype(np.float64)
    if p.intensity_weight > 0:
        sm2 = ndi.gaussian_filter(dna.astype(np.float32), p.intensity_sigma)
        m2 = float(sm2[mask].max())
        if m2 > 0:
            dmax = float(ds.max())
            el = el + (p.intensity_weight * dmax) * (sm2.astype(np.float64) / m2)
    return np.floor(el * Q_SCALE).astype(np.int64)


def flood_with_dynamics(q: np.ndarray, mask: np.ndarray, hq: int) -> np.ndarray:
    """Label image (int32, raster order of first pixel, 0 = outside ``mask``) of the dynamics-merged basins of ``q``."""
    hgt, wid = mask.shape
    flat_idx = np.flatnonzero(mask.ravel())
    out = np.zeros(hgt * wid, np.int32)
    if flat_idx.size == 0:
        return out.reshape(hgt, wid)
    qf = q.ravel()
    order = flat_idx[np.lexsort((flat_idx, -qf[flat_idx]))].tolist()
    qs = qf.tolist()
    lab = [-1] * (hgt * wid)
    parent = []
    peak = []
    for i in order:
        x = i % wid
        qi = qs[i]
        roots = []
        for j, ok in ((i - wid, i >= wid), (i - 1, x > 0), (i + 1, x < wid - 1), (i + wid, i < (hgt - 1) * wid)):
            if ok and lab[j] >= 0:
                r = lab[j]
                while parent[r] != r:
                    parent[r] = parent[parent[r]]
                    r = parent[r]
                if r not in roots:
                    roots.append(r)
        if not roots:
            r = len(parent)
            parent.append(r)
            peak.append(qi)
        elif len(roots) == 1:
            r = roots[0]
        else:
            roots.sort(key=lambda t: (-peak[t], t))
            r = roots[0]
            for o in roots[1:]:
                if peak[o] - qi < hq:
                    parent[o] = r
        lab[i] = r
    final = np.zeros(hgt * wid, np.int64)
    for i in order:
        r = lab[i]
        while parent[r] != r:
            parent[r] = parent[parent[r]]
            r = parent[r]
        final[i] = r + 1
    # consecutive ids in raster order of the first pixel
    nz = np.flatnonzero(final)
    _, first = np.unique(final[nz], return_index=True)
    ranks = np.empty(first.size, np.int64)
    ranks[np.argsort(first, kind="stable")] = np.arange(1, first.size + 1)
    uniq = np.unique(final[nz])
    out[nz] = ranks[np.searchsorted(uniq, final[nz])]
    return out.reshape(hgt, wid)


def v2_foreground(dna: np.ndarray, p: NucleusV2Params) -> np.ndarray:
    smooth = ndi.gaussian_filter(dna.astype(np.float32), p.sigma)
    flat = smooth - ndi.grey_opening(smooth, size=p.background_size)
    thr = np.float32(_linear_otsu(flat) * p.thr_factor)
    mask = flat > thr
    mask = ndi.binary_opening(mask, iterations=1)
    return ndi.binary_fill_holes(mask)


def segment_nuclei_v2(dna: np.ndarray, p: NucleusV2Params = NucleusV2Params()) -> np.ndarray:
    """Label image (int32) of separate nuclei; ids 1..n in raster order of each nucleus's first pixel."""
    mask = v2_foreground(dna, p)
    if not mask.any():
        return np.zeros(mask.shape, np.int32)
    q = quantised_surface(dna, mask, p)
    hq = int(np.floor(p.h * Q_SCALE + 0.5))
    lab = flood_with_dynamics(q, mask, hq)
    n = int(lab.max())
    sizes = np.bincount(lab.ravel(), minlength=n + 1)
    sizes[0] = 0
    keep = sizes >= p.min_nucleus_px
    remap = np.zeros(sizes.size, np.int32)
    remap[keep] = np.arange(1, int(keep.sum()) + 1)
    return remap[lab]


def count_foci_v2(dna: np.ndarray, foci_ch: np.ndarray, p: FociParams = FociParams(),
                  p2: NucleusV2Params = NucleusV2Params()) -> SegmentationResult:
    """Pipeline v2: nuclei from ``segment_nuclei_v2`` (one object = one nucleus, so ``n_nuclei`` is the object
    count), foci exactly as ``segment.count_foci`` (same top-hat / peak rule, ``p`` supplies the foci parameters;
    ``p.nucleus_sigma``, ``p.background_size`` and ``p.min_nucleus_px`` are *not* used, ``p2`` replaces them)."""
    nuclei = segment_nuclei_v2(dna, p2)
    n_objects = int(nuclei.max())
    if n_objects == 0:
        return SegmentationResult(nuclei, np.zeros_like(nuclei), 0, 0, [], PIPELINE_V2)
    smooth = ndi.gaussian_filter(foci_ch.astype(np.float32), p.foci_sigma)
    th = ndi.white_tophat(smooth, size=p.tophat_size)
    peaks = (th == ndi.maximum_filter(th, size=p.peak_window)) & (th >= p.min_height) & (nuclei > 0)
    ys, xs = np.nonzero(peaks)
    per = np.bincount(nuclei[ys, xs], minlength=n_objects + 1)
    foci = np.zeros_like(nuclei)
    foci[ys, xs] = np.arange(1, ys.size + 1)
    return SegmentationResult(nuclei, foci, n_objects, int(per[1:].sum()), per[1:].tolist(), PIPELINE_V2)


def nucleus_table_v2(res: SegmentationResult) -> List[dict]:
    """Like ``segment.nucleus_table`` for a v2 result: every object is one nucleus (``nuclei_in_object`` = 1)."""
    from .segment import nucleus_table

    rows = nucleus_table(res)
    for r in rows:
        r["nuclei_in_object"] = 1
    return rows
