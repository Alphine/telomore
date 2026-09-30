"""Foci Lab: classical nucleus/focus counter (telomere_lab.foci) and /api/foci/overlay.

Offline: synthetic images with a known number of nuclei and foci; the IDR
fetch is stubbed for the API tests.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pytest
from fastapi.testclient import TestClient

SRC = Path(__file__).resolve().parents[1] / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from telomere_lab.foci import ATTRIBUTION, FociParams, count_foci, overlay_rgb  # noqa: E402
from telomere_lab.foci.segment import estimate_nuclei, otsu_threshold, segment_nuclei  # noqa: E402
from telomere_lab.foci.stats import auc, bh_qvalues, empirical_null, gene_stats, well_scores  # noqa: E402

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
    col = {c: i for i, c in enumerate(g["columns"])}
    # the three strongest supported decreases are the paper's recruitment pathway
    lowest3 = s["lowest"][:3]
    assert {r["gene"] for r in lowest3} == {"RNF168", "MDC1", "RNF8"}
    assert all(r["status"] == "hit_down" and r["sirnas"] >= 2 for r in lowest3)
    # every called hit has >= 2 distinct siRNAs and q < 0.05; single-well genes are never hits
    for r in g["rows"]:
        if r[col["status"]].startswith("hit"):
            assert r[col["sirnas"]] >= 2 and r[col["q"]] < 0.05
        if r[col["wells"]] < 2:
            assert r[col["status"]] == "single_well" and r[col["q"]] is None and r[col["rank"]] is None
    st = s["stats"]
    assert st["supported_hits_down"] + st["supported_hits_up"] == sum(r[col["status"]].startswith("hit") for r in g["rows"])
    assert st["genes_q05_empirical_null"] < st["genes_q05_theoretical_null"]
    assert abs(st["negative_controls"]["log2_median"]) < 0.05
    assert 0 < st["concordance"]["spearman"] < 0.3 and abs(st["concordance"]["spearman_shuffled"]) < 0.05
    assert st["truth_check"]["increased"]["gene_auc"] > 0.8
    wrn = {r["gene"]: r for r in s["telomere_panel"]}
    assert wrn["WRN"]["status"] == wrn["DKC1"]["status"] == "single_well"
    L = s["experiment_l"]
    assert L["n_wells"] >= 80 and L["nucleus_check"]["n_images"] >= 100


# ---- statistics on synthetic tables ------------------------------------------

def _wells(rows):
    return pd.DataFrame(rows, columns=["gene", "sirna", "z", "cells"])


def test_bh_and_auc_basics():
    q = bh_qvalues([0.01, 0.04, 0.03, 0.5])
    assert q.tolist() == pytest.approx([0.04, 0.0533333, 0.0533333, 0.5])
    assert auc([3, 4], [1, 2]) == 1.0 and auc([1, 2], [3, 4]) == 0.0 and auc([1], [1]) == 0.5


def test_empirical_null_recovers_shifted_bulk_despite_outliers():
    rng = np.random.default_rng(1)
    z = np.concatenate([rng.normal(0.5, 1.6, 5000), np.full(20, -15.0)])
    mu, sd = empirical_null(z)
    assert mu == pytest.approx(0.5, abs=0.1) and sd == pytest.approx(1.6, abs=0.1)


def test_hit_rule_needs_two_sirnas_and_empirical_q_and_skips_single_wells():
    rng = np.random.default_rng(2)
    rows = []
    for i in range(400):                                   # bulk with inflated spread (sd 1.5 per well)
        rows += [(f"G{i}", "a", rng.normal(0, 1.5), 100), (f"G{i}", "b", rng.normal(0, 1.5), 100)]
    rows += [("TWO", "a", -9.0, 100), ("TWO", "b", -8.0, 100)]            # two siRNAs, strong
    rows += [("ONE", "a", -9.0, 100), ("ONE", "a", -9.5, 100)]            # two wells, same siRNA
    rows += [("SOLO", "a", -30.0, 100)]                                    # single well, huge z
    rows += [("UP", "a", 8.0, 50), ("UP", "b", 9.0, 50)]
    t, info = gene_stats(_wells(rows))
    assert t.loc["TWO", "status"] == "hit_down" and t.loc["UP", "status"] == "hit_up"
    assert t.loc["ONE", "status"] == "q_only"                              # extreme but only one siRNA
    assert t.loc["SOLO", "status"] == "single_well" and np.isnan(t.loc["SOLO", "q"]) and np.isnan(t.loc["SOLO", "rank"])
    assert t.loc["TWO", "rank"] < t.loc["G0", "rank"] and t.loc["TWO", "rank"] <= 2
    assert "low_cells" in t.loc["UP", "flags"] and "one_sirna" in t.loc["ONE", "flags"]
    # the empirical null is wider than N(0,1), so it calls far fewer genes than the theoretical one
    assert info["n_q05_empirical"] < info["n_q05_theoretical"]
    assert info["sd"] > 1.2 and info["n_tested"] == 403


def test_disagreeing_sirnas_are_flagged():
    t, _ = gene_stats(_wells([("X", "a", -6.0, 100), ("X", "b", 2.0, 100), ("Y", "a", -6.0, 100), ("Y", "b", -5.0, 100)]))
    assert "disagree" in t.loc["X", "flags"] and "disagree" not in t.loc["Y", "flags"]


def test_well_scores_use_qc_passed_negative_controls():
    col = "Foci Per Cell (Normalized)"
    base = dict.fromkeys(["Gene Symbol", "siRNA Identifier", "Cell Count", "Plate_Well"])
    rows = [dict(base, **{"Control Type": "negative control", col: v}) for v in (0.8, 0.9, 1.0, 1.1, 1.25)]
    rows += [dict(base, **{"Control Type": None, col: 0.5, "Gene Symbol": "G", "siRNA Identifier": 7, "Cell Count": 90, "Plate_Well": "1_A1"})]
    s, ctl = well_scores(pd.DataFrame(rows))
    assert ctl["wells"] == 5 and ctl["log2_median"] == pytest.approx(0.0) and ctl["robust_sd"] > 0
    assert s["z"].iloc[0] == pytest.approx(-1 / ctl["robust_sd"]) and s["gene"].iloc[0] == "G"


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
