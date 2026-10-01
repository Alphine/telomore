"""Classical (non-learned) nucleus segmentation and 53BP1 focus counting.

Deliberately simple and deterministic, scipy only:

1. Nuclei: Gaussian-smoothed DNA channel -> background opening subtracted ->
   Otsu on log intensity -> fill holes -> drop specks; touching nuclei are
   counted by area (``estimate_nuclei``) rather than split.
2. Foci: white top-hat of the 53BP1 channel (removes the diffuse nuclear
   background, keeps spots smaller than ``tophat_size``) -> local maxima at
   least ``min_height`` grey levels high, one per ``peak_window`` -> counted
   per nucleus. (A median+MAD threshold was tried first and failed: on 8-bit
   data most top-hat values are 0-1, the MAD collapses and touching foci merge.)

``min_height`` is the only tuned parameter; it is fitted on a training split of wells
against the authors' published per-well counts and checked on held-out wells
(scripts/build_foci_dataset.py).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import List

import numpy as np
from scipy import ndimage as ndi


@dataclass(frozen=True)
class FociParams:
    nucleus_sigma: float = 2.0
    background_size: int = 41  # > nucleus diameter; removes uneven illumination
    min_nucleus_px: int = 150
    foci_sigma: float = 1.0
    tophat_size: int = 7
    min_height: float = 12.0  # grey levels (8-bit) above local background
    peak_window: int = 5


@dataclass
class SegmentationResult:
    nuclei: np.ndarray            # int label image, 0 = background
    foci: np.ndarray              # int label image of accepted foci
    n_nuclei: int
    n_foci: int
    foci_per_nucleus: List[int] = field(default_factory=list)  # per nuclear object
    pipeline_version: str = "v1"  # which nucleus pipeline produced this ("v1" here; "v2" in segment_v2.py)

    @property
    def foci_per_cell(self) -> float:
        return self.n_foci / self.n_nuclei if self.n_nuclei else float("nan")


def otsu_threshold(values: np.ndarray, bins: int = 256) -> float:
    hist, edges = np.histogram(values, bins=bins)
    hist = hist.astype(np.float64)
    centers = (edges[:-1] + edges[1:]) / 2
    w0 = np.cumsum(hist)
    w1 = w0[-1] - w0
    m0 = np.cumsum(hist * centers)
    mu0 = np.divide(m0, w0, out=np.zeros_like(m0), where=w0 > 0)
    mu1 = np.divide(m0[-1] - m0, w1, out=np.zeros_like(m0), where=w1 > 0)
    between = w0 * w1 * (mu0 - mu1) ** 2
    return float(centers[int(np.argmax(between))])


def _log_otsu(flat: np.ndarray) -> float:
    """Otsu on log intensity: dim and bright nuclei both clear it."""
    v = np.log1p(np.clip(flat, 0, None))
    return float(np.expm1(otsu_threshold(v[v > 0]))) if (v > 0).any() else 0.0


def segment_nuclei(dna: np.ndarray, p: FociParams) -> np.ndarray:
    """Label image of nuclear objects (touching nuclei may share one object)."""
    smooth = ndi.gaussian_filter(dna.astype(np.float32), p.nucleus_sigma)
    # flatten uneven illumination: subtract a grey opening larger than a nucleus
    flat = smooth - ndi.grey_opening(smooth, size=p.background_size)
    mask = flat > _log_otsu(flat)
    mask = ndi.binary_fill_holes(ndi.binary_opening(mask, iterations=2))
    lab, n = ndi.label(mask)
    if n == 0:
        return lab
    sizes = np.bincount(lab.ravel())
    sizes[0] = 0
    keep = sizes >= p.min_nucleus_px
    remap = np.zeros(sizes.size, np.int32)
    remap[keep] = np.arange(1, int(keep.sum()) + 1)
    return remap[lab]


def estimate_nuclei(objects: np.ndarray) -> np.ndarray:
    """Nuclei per object: touching nuclei are not split (a watershed split was
    tried and left blocky artefacts); instead each object counts as
    round(area / median object area), at least 1."""
    sizes = np.bincount(objects.ravel())[1:]
    if sizes.size == 0:
        return sizes
    med = float(np.median(sizes))
    return np.maximum(1, np.rint(sizes / med)).astype(int)


def count_foci(dna: np.ndarray, foci_ch: np.ndarray, p: FociParams = FociParams()) -> SegmentationResult:
    nuclei = segment_nuclei(dna, p)
    n_objects = int(nuclei.max())
    if n_objects == 0:
        return SegmentationResult(nuclei, np.zeros_like(nuclei), 0, 0, [])
    n_nuclei = int(estimate_nuclei(nuclei).sum())
    smooth = ndi.gaussian_filter(foci_ch.astype(np.float32), p.foci_sigma)
    th = ndi.white_tophat(smooth, size=p.tophat_size)
    # a focus = a local maximum of the top-hat, at least `min_height` grey levels
    # above its surroundings, inside a nucleus; `peak_window` keeps one maximum
    # per spot so touching foci are still counted separately
    peaks = (th == ndi.maximum_filter(th, size=p.peak_window)) & (th >= p.min_height) & (nuclei > 0)
    ys, xs = np.nonzero(peaks)
    owners = nuclei[ys, xs]
    per = np.bincount(owners, minlength=n_objects + 1)
    foci = np.zeros_like(nuclei)
    foci[ys, xs] = np.arange(1, ys.size + 1)
    return SegmentationResult(nuclei, foci, n_nuclei, int(per[1:].sum()), per[1:].tolist())


def overlay_rgb(dna: np.ndarray, foci_ch: np.ndarray, res: SegmentationResult) -> np.ndarray:
    """uint8 RGB: DNA blue, 53BP1 green, nucleus outlines white, counted foci ringed in amber."""
    def norm(a):
        lo, hi = np.percentile(a, [1, 99.7])
        return np.clip((a - lo) / max(hi - lo, 1e-6), 0, 1)
    rgb = np.zeros(dna.shape + (3,), np.float32)
    rgb[..., 2] = norm(dna) * 0.85
    rgb[..., 1] = norm(foci_ch)
    rgb[..., 0] = norm(foci_ch) * 0.25
    inside = res.nuclei > 0
    edge = inside & ~ndi.binary_erosion(inside, iterations=1)
    rgb[edge] = (0.85, 0.9, 0.95)
    ring = ndi.binary_dilation(res.foci > 0, iterations=3) & ~ndi.binary_dilation(res.foci > 0, iterations=1)
    rgb[ring] = (1.0, 0.72, 0.15)
    return (rgb * 255).astype(np.uint8)


def nucleus_table(res: SegmentationResult) -> List[dict]:
    """One row per nuclear object: id (1-based label), area in px, centroid
    (x, y) in px, nuclei-in-object (area-based estimate, >=1) and foci count.

    Additive helper for the upload analyser; count_foci itself is unchanged.
    Memory: only foreground pixel coordinates are materialised.
    """
    lab = res.nuclei
    n = int(lab.max()) if lab.size else 0
    if n == 0:
        return []
    ys, xs = np.nonzero(lab)
    owners = lab[ys, xs]
    area = np.bincount(owners, minlength=n + 1)[1:]
    cx = np.bincount(owners, weights=xs, minlength=n + 1)[1:] / np.maximum(area, 1)
    cy = np.bincount(owners, weights=ys, minlength=n + 1)[1:] / np.maximum(area, 1)
    est = estimate_nuclei(lab)
    per = res.foci_per_nucleus
    return [
        {
            "id": i + 1,
            "area_px": int(area[i]),
            "centroid_x": round(float(cx[i]), 1),
            "centroid_y": round(float(cy[i]), 1),
            "nuclei_in_object": int(est[i]),
            "foci": int(per[i]),
        }
        for i in range(n)
    ]
