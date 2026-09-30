"""Experiment L2 (telomere_lab.foci.raw16): raw-intensity foci detection on OME-Zarr plates.

The numpy/scipy logic tests always run; the OME-Zarr reader test is skipped when the optional
``zarr`` package is not installed. No real data is used (a tiny synthetic plate is built in the test).
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pytest

SRC = Path(__file__).resolve().parents[1] / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from telomere_lab.foci import FociParams, count_foci  # noqa: E402
from telomere_lab.foci import raw16 as R  # noqa: E402


def synthetic_raw(foci_per_nucleus=(0, 2, 4), seed=0, scale=1.0):
    """3x3 grid of round nuclei on a 12-bit-like background; known number of 53BP1 spots per nucleus."""
    rng = np.random.default_rng(seed)
    H = W = 300
    yy, xx = np.mgrid[:H, :W]
    dna = 200.0 + rng.normal(0, 8.0, (H, W))
    foc = 150.0 + rng.normal(0, 6.0, (H, W))
    expected, k = [], 0
    for i in range(3):
        for j in range(3):
            cy, cx = 50 + i * 100, 50 + j * 100
            inside = (yy - cy) ** 2 + (xx - cx) ** 2 <= 22 ** 2
            dna[inside] += 1200.0
            foc[inside] += 60.0
            n = foci_per_nucleus[k % len(foci_per_nucleus)]
            k += 1
            expected.append(n)
            for m in range(n):
                ang = 2 * np.pi * m / max(n, 1)
                fy, fx = cy + 11 * np.sin(ang), cx + 11 * np.cos(ang)
                foc += 900.0 * np.exp(-((yy - fy) ** 2 + (xx - fx) ** 2) / (2 * 1.3 ** 2))
    return np.clip(dna * scale, 0, 65535).astype(np.uint16), np.clip(foc * scale, 0, 65535).astype(np.uint16), expected


# ------------------------------------------------------------------ plain-numpy logic (always runs)
def test_well_name_no_zero_padding():
    assert R.well_name("A", "1") == "A1"
    assert R.well_name("l", 32) == "L32"
    assert R.well_name(" B ", "07") == "B7"


def test_well_number_conventions_are_bijections():
    n_rows, n_cols = 12, 32
    cm = {R.colmajor_well_number(r, c, n_rows) for r in range(n_rows) for c in range(n_cols)}
    rm = {R.rowmajor_well_number(r, c, n_cols) for r in range(n_rows) for c in range(n_cols)}
    assert cm == rm == set(range(1, n_rows * n_cols + 1))
    assert R.colmajor_well_number(0, 0, n_rows) == 1
    assert R.colmajor_well_number(1, 0, n_rows) == 2      # B1 follows A1 (column-major)
    assert R.rowmajor_well_number(0, 1, n_cols) == 2      # A2 follows A1 (row-major, the annotation's Well name)
    assert R.colmajor_well_number(0, 1, n_rows) == 13
    assert R.colmajor_well_number(11, 31, n_rows) == 384


def test_render_8bit_no_uint16_wrap_and_roundtrip():
    a = np.array([0, 10, 60, 61, 2000, 4095, 65535], dtype=np.uint16)
    q = R.render_8bit(a, 61, 4095)
    assert q.dtype == np.float32
    assert q[0] == 0 and q[1] == 0 and q[2] == 0        # below the window start: clipped, NOT wrapped to ~65000
    assert q[3] == 0 and q[5] == 255 and q[6] == 255
    back = R.unrender_8bit(q, 61, 4095)
    inside = (a >= 61) & (a <= 4095)
    assert np.all(np.abs(back[inside] - a[inside]) <= (4095 - 61) / 255 / 2 + 1e-3)


def test_robust_sigma_floor_and_nan_free():
    assert R.robust_sigma(np.zeros(100), floor=1.0) == 1.0
    assert R.robust_sigma(np.array([]), floor=2.0) == 2.0
    x = np.random.default_rng(0).normal(0, 5.0, 100000)
    assert abs(R.robust_sigma(x) - 5.0) < 0.2


def test_local_maxima_plateau_counted_once():
    img = np.zeros((20, 20), np.float32)
    img[5:8, 5:8] = 10.0          # flat top: 9 equal maxima
    img[15, 15] = 12.0
    allowed = np.ones_like(img, bool)
    ys, xs = R.local_maxima(img, allowed, 5.0, 5, dedupe=True)
    assert len(ys) == 2
    ys2, _ = R.local_maxima(img, allowed, 5.0, 5, dedupe=False)
    assert len(ys2) > 2


def test_auc_mw_ties_and_empty():
    assert R.auc_mw([1, 2, 3], [0, 0.5]) == 1.0
    assert R.auc_mw([1, 1], [1, 1]) == 0.5
    assert np.isnan(R.auc_mw([], [1.0]))
    assert R.auc_mw([0.0], [1.0, 2.0]) == 0.0


def test_make_folds_deterministic_and_balanced():
    a, b = R.make_folds(101, seed=3), R.make_folds(101, seed=3)
    assert np.array_equal(a, b)
    assert abs(int((a == 0).sum()) - int((a == 1).sum())) <= 1
    assert not np.array_equal(a, R.make_folds(101, seed=4))


def test_crossfit_uses_training_fold_only():
    rng = np.random.default_rng(1)
    n = 200
    y = rng.normal(size=n)
    folds = R.make_folds(n, 0)
    good = y + rng.normal(0, 0.2, n)
    noise = rng.normal(size=n)
    mat = np.stack([noise, good, noise[::-1]], axis=1)
    chosen, oof, train_rho = R.crossfit_calibrate(mat, y, folds)
    assert chosen == [1, 1]
    assert np.allclose(oof, good)
    assert all(r > 0.9 for r in train_rho)
    # scrambling the HELD-OUT fold's targets must not change the threshold chosen for that fold
    y2 = y.copy()
    y2[folds == 0] = rng.normal(size=int((folds == 0).sum()))
    chosen2, _, _ = R.crossfit_calibrate(mat, y2, folds)
    assert chosen2[0] == chosen[0]


def test_bootstrap_ci_deterministic_and_brackets_estimate():
    rng = np.random.default_rng(0)
    x = rng.normal(size=120)
    y = x + rng.normal(0, 0.5, 120)
    a = R.summarise_corr(x, y, boot=300, seed=5)
    b = R.summarise_corr(x, y, boot=300, seed=5)
    assert a == b
    lo, hi = a["spearman_ci95"]
    assert lo < a["spearman"] < hi
    assert a["n"] == 120


def test_nan_handling():
    x = np.array([1.0, 2.0, np.nan, 4.0, 5.0])
    y = np.array([1.0, 2.0, 3.0, np.nan, 5.0])
    assert R.safe_spearman(x, y) == pytest.approx(1.0)
    assert np.isnan(R.safe_spearman([1, 1, 1], [1, 2, 3]))


def test_detectors_count_known_foci_on_12bit_range():
    dna, foc, expected = synthetic_raw()
    wd = R.well_candidates(dna, foc, FociParams(), legacy_floor=None)
    assert wd.n_objects == 9 and wd.n_nuclei == 9
    for det, thr in (("tophat_mad", 15.0), ("dog_mad", 15.0), ("nuc_ratio", 1.0)):
        got = R.per_object_counts(wd, det, thr)
        assert sorted(got.tolist()) == sorted(expected), det
    assert R.foci_per_cell(wd, "tophat_mad", 15.0) == pytest.approx(sum(expected) / 9)
    # thresholds far too high: nothing counted, no NaN
    assert R.foci_per_cell(wd, "tophat_mad", 1e6) == 0.0


def test_scale_invariance_of_mad_scores_and_no_wrap_on_uint16():
    dna, foc, expected = synthetic_raw()
    dna2, foc2, _ = synthetic_raw(scale=3.0)
    a = R.well_candidates(dna, foc)
    b = R.well_candidates(dna2, foc2)
    ca = sorted(R.per_object_counts(a, "tophat_mad", 15.0).tolist())
    cb = sorted(R.per_object_counts(b, "tophat_mad", 15.0).tolist())
    assert ca == cb == sorted(expected)
    # background below the foci baseline must not wrap (uint16 arithmetic would make ~65000-sized top-hat values)
    assert float(a.cands["tophat_mad"].height.max()) < 5000


def test_legacy_candidates_reproduce_count_foci():
    dna, foc, _ = synthetic_raw()
    d8 = R.render_8bit(dna, float(dna.min()), float(dna.max()))
    f8 = R.render_8bit(foc, float(foc.min()), float(foc.max()))
    p = FociParams()
    ref = count_foci(d8, f8, p)
    wd = R.well_candidates(d8, f8, p, detectors=(), legacy_floor=1.0)
    assert wd.n_nuclei == ref.n_nuclei
    assert int((wd.cands["legacy"].score >= p.min_height).sum()) == ref.n_foci
    assert R.per_object_counts(wd, "legacy", p.min_height).tolist() == ref.foci_per_nucleus


def test_empty_image_gives_no_objects():
    flat = np.full((120, 120), 300, np.uint16)
    wd = R.well_candidates(flat, flat)
    assert wd.n_objects == 0 and wd.n_nuclei == 0
    assert wd.cands == {}


def test_pooled_distribution_auc_separates_shifted_groups():
    rng = np.random.default_rng(2)
    pos = [rng.poisson(4, 60).astype(float) for _ in range(8)]
    neg = [rng.poisson(2, 60).astype(float) for _ in range(30)]
    out = R.pooled_distribution_auc(pos, neg, boot=100, seed=0)
    assert out["auc"] > 0.7 and out["auc_ci95"][0] > 0.6


# ------------------------------------------------------------------ OME-Zarr reader (needs zarr)
def _write_plate(path, root="9-99.ome.zarr", rows=("A", "B"), cols=("1", "2", "3"), h=40, w=50):
    zarr = pytest.importorskip("zarr")
    store = zarr.storage.ZipStore(str(path), mode="w")
    try:
        g = zarr.open_group(store, mode="w", zarr_format=2, path=root)
    except TypeError:
        pytest.skip("this zarr version cannot write v2 groups with zarr_format")
    wells = []
    for ri, r in enumerate(rows):
        for ci, c in enumerate(cols):
            wells.append({"path": f"{r}/{c}", "rowIndex": ri, "columnIndex": ci})
    g.attrs["plate"] = {"rows": [{"name": r} for r in rows], "columns": [{"name": c} for c in cols], "wells": wells}
    truth = {}
    for wi, wl in enumerate(wells):
        wg = g.require_group(wl["path"])
        wg.attrs["well"] = {"images": [{"path": "0"}]}
        ig = wg.require_group("0")
        swap = wi == 1                      # in one well the 53BP1 channel comes first
        dapi = np.full((h, w), 100 + wi, np.uint16)
        bp1 = np.full((h, w), 2000 + wi, np.uint16)
        bp1[3, 4] = 4095
        chans = [bp1, dapi] if swap else [dapi, bp1]
        labels = ["Channel 1", "Dapi"] if swap else ["Dapi", "Channel 1"]
        data = np.stack(chans)[None, :, None]           # t, c, z, y, x
        ig.attrs["multiscales"] = [{"axes": [{"name": a, "type": "x"} for a in "tczyx"],
                                    "datasets": [{"path": "0"}], "version": "0.4"}]
        ig.attrs["omero"] = {"channels": [{"label": labels[i], "window": {"start": float(a.min()), "end": float(a.max())}}
                                          for i, a in enumerate(chans)]}
        arr = ig.create_array("0", shape=data.shape, chunks=data.shape, dtype=">u2", compressors=None)
        arr[...] = data.astype(">u2")
        truth[f"{wl['path'].replace('/', '')}"] = (dapi, bp1)
    store.close()
    return truth


def test_ome_zarr_plate_reader_roundtrip(tmp_path):
    pytest.importorskip("zarr")
    zp = tmp_path / "9-99.ome.zarr.zip"
    truth = _write_plate(zp)
    with R.OmeZarrPlate(str(zp)) as P:
        assert (P.n_rows, P.n_cols) == (2, 3)
        assert sorted(P.wells) == ["A1", "A2", "A3", "B1", "B2", "B3"]
        assert P.grid["B3"] == (1, 2)
        for name, (dapi, bp1) in truth.items():
            d, f, win = P.read_well(name)
            assert d.dtype == np.uint16 and f.dtype == np.uint16 and d.shape == (40, 50)
            assert d.dtype.byteorder in ("=", "|", "<")          # native, not the stored big-endian
            assert np.array_equal(d, dapi) and np.array_equal(f, bp1), name   # channel identity via labels
            assert win["foci"][1] == 4095.0 and win["dna"][1] == float(dapi.max())
