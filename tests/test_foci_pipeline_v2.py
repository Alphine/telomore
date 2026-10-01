"""Foci Lab nucleus pipeline v2 (segment_v2.py): behaviour, determinism, v1 untouched, fixtures, evaluation maths."""

import importlib.util
import json
import sys
from pathlib import Path

import numpy as np
import pytest

pytest.importorskip("scipy")
from scipy import ndimage as ndi  # noqa: E402

from telomere_lab.foci import segment as S  # noqa: E402
from telomere_lab.foci import segment_v2 as V2  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent


def _two_touching(r=14, gap=-6, noise=0.0, seed=0):
    """Two overlapping discs of radius r (centres 2r+gap apart), bright on dark, as float32 0..255."""
    h, w = 80, 120
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    cx1, cx2 = 60 - (r + gap / 2), 60 + (r + gap / 2)
    img = np.full((h, w), 10.0, np.float32)
    for cx in (cx1, cx2):
        img += 150.0 / (1.0 + np.exp(np.clip((np.hypot(xx - cx, yy - 40) - r) / 1.0, -40, 40)))
    if noise:
        img += np.random.default_rng(seed).normal(0, noise, img.shape).astype(np.float32)
    return np.clip(img, 0, 255).astype(np.float32)


def test_v1_default_and_version_fields():
    img = _two_touching()
    res = S.count_foci(img, img)
    assert res.pipeline_version == "v1"
    assert S.SegmentationResult(np.zeros((2, 2), np.int32), np.zeros((2, 2), np.int32), 0, 0).pipeline_version == "v1"
    r2 = V2.count_foci_v2(img, img)
    assert r2.pipeline_version == "v2" == V2.PIPELINE_V2
    empty = V2.count_foci_v2(np.zeros((30, 30), np.float32), np.zeros((30, 30), np.float32))
    assert empty.pipeline_version == "v2" and empty.n_nuclei == 0 and empty.n_foci == 0


def test_v2_splits_touching_nuclei_that_v1_keeps_as_one_object():
    img = _two_touching()
    assert int(S.segment_nuclei(img, S.FociParams()).max()) == 1
    lab = V2.segment_nuclei_v2(img)
    assert int(lab.max()) == 2
    # both halves are of similar size and the two objects cover the foreground
    a = np.bincount(lab.ravel())[1:]
    assert 0.7 < a[0] / a[1] < 1.4
    assert (lab > 0).sum() == a.sum()


def test_v2_does_not_split_a_single_round_nucleus():
    h, w = 80, 80
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    img = 10 + 150 / (1 + np.exp(np.clip((np.hypot(xx - 40, yy - 40) - 15) / 1.0, -40, 40)))
    assert int(V2.segment_nuclei_v2(img.astype(np.float32)).max()) == 1


def test_huge_h_never_splits_and_h_zero_splits_at_least_as_much():
    img = _two_touching()
    p = V2.NucleusV2Params
    n_big = int(V2.segment_nuclei_v2(img, p(h=1000.0)).max())
    n_zero = int(V2.segment_nuclei_v2(img, p(h=0.0)).max())
    assert n_big == 1
    assert n_zero >= int(V2.segment_nuclei_v2(img, p(h=0.5)).max()) >= n_big


def test_labels_are_consecutive_in_raster_order_and_deterministic():
    img = _two_touching(noise=2.0, seed=3)
    a = V2.segment_nuclei_v2(img)
    b = V2.segment_nuclei_v2(img.copy())
    assert a.dtype == np.int32 and np.array_equal(a, b)
    ids = a[a > 0]
    assert set(np.unique(ids)) == set(range(1, int(a.max()) + 1))
    first = [int(np.flatnonzero(a.ravel() == k)[0]) for k in range(1, int(a.max()) + 1)]
    assert first == sorted(first)


def test_min_nucleus_px_drops_small_pieces_and_relabels():
    img = _two_touching()
    n = int(V2.segment_nuclei_v2(img).max())
    assert n == 2
    gone = V2.segment_nuclei_v2(img, V2.NucleusV2Params(min_nucleus_px=10 ** 6))
    assert gone.max() == 0


def test_empty_and_constant_images():
    assert V2.segment_nuclei_v2(np.zeros((20, 20), np.float32)).max() == 0
    assert V2.segment_nuclei_v2(np.full((20, 20), 100, np.float32)).max() == 0


def test_edt_padded_equals_brute_force():
    rng = np.random.default_rng(1)
    for _ in range(4):
        m = ndi.binary_dilation(rng.random((23, 31)) > 0.93, iterations=3) | (rng.random((23, 31)) > 0.97)
        got = V2._edt_padded(m)
        pad = np.pad(m, 1)
        ys, xs = np.nonzero(~pad)
        fy, fx = np.nonzero(m)
        want = np.zeros(m.shape, np.float64)
        for y, x in zip(fy, fx):
            want[y, x] = np.sqrt(((ys - (y + 1)) ** 2 + (xs - (x + 1)) ** 2).min())
        assert np.array_equal(got, want.astype(np.float32))


def test_flood_with_dynamics_merges_shallow_basins_only():
    # two peaks of height 100 and 90 joined by a pass at 60: dynamics of the lower one is 30
    q = np.array([[0, 100, 80, 60, 70, 90, 0]], np.int64)
    mask = np.ones_like(q, bool)
    mask[0, [0, -1]] = False
    assert int(V2.flood_with_dynamics(q, mask, 31).max()) == 1     # 30 < 31: merged
    lab = V2.flood_with_dynamics(q, mask, 30)                       # 30 >= 30: separate
    assert int(lab.max()) == 2 and lab[0, 1] == 1 and lab[0, 5] == 2
    assert lab[0, 0] == 0 and lab[0, 6] == 0


def test_foci_stage_is_shared_with_v1():
    """Same nuclei -> same foci: on a single round nucleus v1 and v2 report the same foci."""
    h, w = 90, 90
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    dna = (10 + 150 / (1 + np.exp(np.clip((np.hypot(xx - 45, yy - 45) - 25) / 1.0, -40, 40)))).astype(np.float32)
    foc = np.full((h, w), 5, np.float32)
    for (y, x) in ((40, 40), (50, 55)):
        foc += 120 * np.exp(-((xx - x) ** 2 + (yy - y) ** 2) / 2.0)
    r1, r2 = S.count_foci(dna, foc), V2.count_foci_v2(dna, foc)
    assert r1.n_foci == r2.n_foci == 2 and r1.n_nuclei == r2.n_nuclei == 1
    rows = V2.nucleus_table_v2(r2)
    assert len(rows) == 1 and rows[0]["nuclei_in_object"] == 1 and rows[0]["foci"] == 2


def test_segment_py_is_untouched_in_behaviour():
    """A canary on v1 itself: its public defaults and output on a fixed synthetic image."""
    assert S.FociParams() == S.FociParams(2.0, 41, 150, 1.0, 7, 12.0, 5)
    img = _two_touching()
    lab = S.segment_nuclei(img, S.FociParams())
    assert int(lab.max()) == 1 and int((lab > 0).sum()) > 1000


# ---------------------------------------------------------------- golden fixtures

@pytest.fixture(scope="module")
def gen():
    pytest.importorskip("PIL")
    pytest.importorskip("fastapi")  # backend.foci_upload imports it
    spec = importlib.util.spec_from_file_location("make_engine_fixtures_v2", ROOT / "scripts" / "make_engine_fixtures.py")
    mod = importlib.util.module_from_spec(spec)
    sys.modules["make_engine_fixtures_v2"] = mod
    spec.loader.exec_module(mod)
    return mod


def test_v2_golden_manifest_matches_current_reference(gen):
    man = gen.OUT2 / "manifest.json"
    m = json.loads(man.read_text(encoding="utf-8"))
    assert m["pipeline"] == "v2"
    assert m["default_params"] == V2.v2_params_dict(V2.NucleusV2Params())
    assert len(m["cases"]) >= 20 and len(m["sweeps"]) >= 30
    assert all(c["python"]["pipeline_version"] == "v2" for c in m["cases"])
    bad = gen.check_v2()
    assert not bad, f"v2 fixtures drifted from segment_v2.py: {bad}; run `python scripts/make_engine_fixtures.py --v2`"
    size = sum(f.stat().st_size for f in gen.OUT2.iterdir())
    assert size < 3_000_000, "added fixtures must stay under 3 MB"


# ------------------------------------------------------------ evaluation script maths

@pytest.fixture(scope="module")
def ev():
    pytest.importorskip("PIL")
    spec = importlib.util.spec_from_file_location("eval_foci_pipeline_v2", ROOT / "scripts" / "eval_foci_pipeline_v2.py")
    mod = importlib.util.module_from_spec(spec)
    sys.modules["eval_foci_pipeline_v2"] = mod
    spec.loader.exec_module(mod)
    return mod


def test_match_counts_and_f1(ev):
    gt = np.zeros((20, 20), np.int32)
    gt[2:10, 2:10] = 1          # 64 px
    gt[12:18, 12:18] = 2        # 36 px
    pred = np.zeros_like(gt)
    pred[2:10, 2:10] = 1        # perfect
    pred[12:18, 12:15] = 2      # half of gt 2 -> IoU 0.5 (not > 0.5)
    pred[0:2, 15:20] = 3        # false positive
    mc = dict(zip(ev.THS, ev.match_counts(pred, gt)))
    assert mc[0.5] == (1, 2, 1)         # IoU of object 2 is exactly 0.5: not a match (strictly greater)
    assert mc[0.9] == (1, 2, 1)
    assert ev.f1_of(1, 2, 1) == pytest.approx(0.4)
    assert ev.f1_of(0, 0, 0) == 1.0
    assert ev.match_counts(np.zeros_like(gt), gt)[0] == (0, 0, 2)


def test_summarise_pairs_arms_on_the_same_images(ev):
    def row(gt_n, objects, tp):
        return {"gt_n": gt_n, "objects": objects, "nuclei_count": objects, "tp": [tp] * 5, "fp": [objects - tp] * 5, "fn": [gt_n - tp] * 5,
                "f1": [ev.f1_of(tp, objects - tp, gt_n - tp)] * 5, "dice_fg": 0.9}
    a = [row(10, 8, 4), row(12, 9, 5), row(8, 7, 3)]
    b = [row(10, 10, 9), row(12, 12, 11), row(8, 8, 8)]
    out = ev.summarise({"v1": a, "v2": b})
    d = out["paired_vs_v1"]["v2"]
    assert d["f1_avg_diff"] > 0.3 and d["f1_avg_diff_ci95"][0] > 0
    assert out["arms"]["v2"]["nuclei_count"]["bias"] == pytest.approx(0.0)
    assert out["arms"]["v1"]["nuclei_count"]["bias"] < 0
