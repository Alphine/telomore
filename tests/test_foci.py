"""Foci Lab: classical nucleus/focus counter (telomere_lab.foci) and /api/foci/overlay.

Offline: synthetic images with a known number of nuclei and foci; the IDR
fetch is stubbed for the API tests.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient

SRC = Path(__file__).resolve().parents[1] / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from telomere_lab.foci import ATTRIBUTION, FociParams, count_foci, overlay_rgb  # noqa: E402
from telomere_lab.foci.segment import estimate_nuclei, otsu_threshold, segment_nuclei  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]


def synthetic(n_side=3, foci_per_nucleus=(0, 2, 4), seed=0, gradient=True):
    """n_side x n_side grid of round nuclei on a dim, unevenly lit background,
    each with a known number of bright 53BP1 spots."""
    rng = np.random.default_rng(seed)
    H, W = 300, 300
    yy, xx = np.mgrid[:H, :W]
    dna = 3.0 + (xx / W * 25.0 if gradient else 0.0) + rng.normal(0, 1.0, (H, W))
    foc = 4.0 + rng.normal(0, 1.0, (H, W))
    expected = []
    k = 0
    for i in range(n_side):
        for j in range(n_side):
            cy, cx = 50 + i * 100, 50 + j * 100
            inside = (yy - cy) ** 2 + (xx - cx) ** 2 <= 22 ** 2
            dna[inside] += 70 + 10 * k
            foc[inside] += 10
            nf = foci_per_nucleus[k % len(foci_per_nucleus)]
            for f in range(nf):
                a = 2 * np.pi * f / max(nf, 1)
                fy, fx = cy + int(10 * np.sin(a)), cx + int(10 * np.cos(a))
                foc += 90 * np.exp(-((yy - fy) ** 2 + (xx - fx) ** 2) / (2 * 1.3 ** 2))
            expected.append(nf)
            k += 1
    return np.clip(dna, 0, 255).astype(np.float32), np.clip(foc, 0, 255).astype(np.float32), expected


def test_otsu_splits_two_populations():
    v = np.concatenate([np.full(500, 10.0), np.full(500, 200.0)])
    assert 10 < otsu_threshold(v) < 200


def test_counts_known_nuclei_and_foci_despite_uneven_illumination():
    dna, foc, expected = synthetic()
    res = count_foci(dna, foc)
    assert res.n_nuclei == 9
    assert res.n_foci == sum(expected)
    assert sorted(res.foci_per_nucleus) == sorted(expected)
    assert res.foci_per_cell == pytest.approx(sum(expected) / 9)


def test_touching_nuclei_are_counted_by_area():
    lab = np.zeros((50, 200), int)
    lab[10:30, 10:30] = 1          # single nucleus, area 400
    lab[10:30, 50:70] = 2          # single nucleus, area 400
    lab[10:30, 100:140] = 3        # two fused nuclei, area 800
    assert estimate_nuclei(lab).tolist() == [1, 1, 2]


def test_empty_image_has_no_nuclei_and_no_nan_crash():
    z = np.zeros((120, 120), np.float32)
    res = count_foci(z, z)
    assert res.n_nuclei == 0 and res.n_foci == 0
    assert np.isnan(res.foci_per_cell)


def test_min_height_controls_sensitivity():
    dna, foc, expected = synthetic()
    strict = count_foci(dna, foc, FociParams(min_height=250))
    assert strict.n_foci == 0
    assert segment_nuclei(dna, FociParams()).max() == 9


def test_overlay_is_rgb_uint8_same_size():
    dna, foc, _ = synthetic()
    img = overlay_rgb(dna, foc, count_foci(dna, foc))
    assert img.shape == dna.shape + (3,) and img.dtype == np.uint8


def test_attribution_names_source_and_licence():
    assert "idr0010" in ATTRIBUTION and "CC BY 4.0" in ATTRIBUTION and "Doil" in ATTRIBUTION


def test_published_dataset_is_consistent():
    data = ROOT / "foci" / "web" / "data"
    s = json.loads((data / "summary.json").read_text())
    g = json.loads((data / "genes.json").read_text())
    assert s["license"] == "CC BY 4.0"
    assert len(g["rows"]) == s["totals"]["genes"]
    lowest3 = [r[0] for r in s["lowest"][:3]]
    assert set(lowest3) == {"RNF168", "MDC1", "RNF8"}  # the paper's pathway, from the authors' own table
    assert s["experiment_l"]["n_wells"] >= 80


# ---- API -------------------------------------------------------------------

@pytest.fixture()
def client(monkeypatch):
    from backend.main import create_app
    from backend.routers import foci as foci_router

    monkeypatch.setattr(foci_router, "well_index", lambda: {"85_A2": 123})
    monkeypatch.setattr(foci_router, "_analyse", lambda iid: {
        "image_id": iid, "nuclei": 9, "foci": 18, "foci_per_cell": 2.0, "jpeg": "", "validated": False,
        "note": "", "attribution": ATTRIBUTION})
    return TestClient(create_app())


def test_overlay_rejects_bad_and_unknown_wells(client):
    assert client.get("/api/foci/overlay", params={"well": "../etc"}).status_code == 400
    assert client.get("/api/foci/overlay", params={"well": "85_Z9"}).status_code == 400
    assert client.get("/api/foci/overlay", params={"well": "85_A3"}).status_code == 404


def test_overlay_is_public_marked_unvalidated_and_allows_studylab(client):
    r = client.get("/api/foci/overlay", params={"well": "85_A2"}, headers={"Origin": "https://studylab.id"})
    assert r.status_code == 200
    body = r.json()
    assert body["well"] == "85_A2" and body["image_id"] == 123 and body["validated"] is False
    assert r.headers.get("access-control-allow-origin") == "https://studylab.id"
