"""Image <-> annotation pairing of Foci Lab (docs/EXPERIMENT_PROTOCOL.md 15.4): the column-major rule, the committed
index files, and the headline agreement of our nucleus count with the authors' Cell Count under each pairing.

The pairing is empirically inferred and unconfirmed by IDR; these tests pin the derivation and the evidence that
motivates the default, they do not prove the pairing is right.
"""
import importlib.util
import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "foci" / "web" / "data"
sys.path.insert(0, str(ROOT / "scripts"))
import build_foci_pairing as P  # noqa: E402

FIXTURE = ROOT / "foci" / "tests" / "fixtures" / "foci_pairing_nuclei.json"
ANNOTATION = ROOT / ".cache" / "idr0010" / "annotation.csv"


@pytest.fixture(scope="module")
def byname():
    return json.loads((DATA / "well_index_byname.json").read_text())


@pytest.fixture(scope="module")
def colmajor():
    return json.loads((DATA / "well_index.json").read_text())


def test_rule_examples():
    assert P.colmajor_address(1) == (0, 0)              # Well Number 1 -> A1
    assert P.colmajor_address(2) == (1, 0)              # A2 (Well Number 2) -> B1
    assert P.colmajor_address(33) == (8, 2)             # B1 (Well Number 33) -> I3
    assert P.colmajor_address(384) == (11, 31)
    assert P.well_number(0, 1) == 2 and P.well_number(1, 0) == 33


def test_rule_is_a_bijection_and_inverse_works():
    seen = set()
    for r in range(P.N_ROWS):
        for c in range(P.N_COLS):
            a = P.colmajor_address(P.well_number(r, c))
            assert 0 <= a[0] < P.N_ROWS and 0 <= a[1] < P.N_COLS
            seen.add(a)
            assert P.annotation_for_image(*a) == (r, c)
    assert len(seen) == P.N_ROWS * P.N_COLS
    assert sum(1 for r in range(12) for c in range(32) if P.colmajor_address(P.well_number(r, c)) == (r, c)) == 2


def test_committed_index_is_the_deterministic_permutation(byname, colmajor):
    assert P.paired_index(byname, "colmajor") == colmajor
    assert list(P.paired_index(byname, "colmajor")) == list(colmajor)          # same key order: byte-stable rebuilds
    assert P.paired_index(byname, "name") == byname
    st = P.diff_stats(byname, colmajor)
    assert st == {"annotation_keys": 56832, "imaged_by_name": 56832, "changed_image": 56536, "same_image": 296,
                  "plates": 148, "fixed_wells_per_full_plate": 2}
    # a permutation inside each plate: same images, same keys
    assert sorted(colmajor.values()) == sorted(byname.values()) and set(colmajor) == set(byname)
    with pytest.raises(ValueError):
        P.paired_index(byname, "other")


def test_dumps_is_compact_and_roundtrips(colmajor):
    raw = (DATA / "well_index.json").read_text()
    assert raw == P.dumps(colmajor) and ": " not in raw[:200]


@pytest.mark.skipif(not ANNOTATION.exists(), reason="annotation CSV not cached (.cache/idr0010)")
def test_annotation_well_number_is_row_major():
    assert P.verify_annotation(ANNOTATION) == {"rows": 57216, "well_number_mismatch": 0}


def _fixture():
    d = json.loads(FIXTURE.read_text())
    return [dict(zip(d["columns"], r)) for r in d["rows"]]


def test_fixture_rows_follow_the_rule(byname, colmajor):
    rows = _fixture()
    assert len(rows) == 106
    for r in rows:
        plate, rr, cc = P.split_key(r["idr_well"])
        assert byname[r["idr_well"]] == r["image_id"]
        assert r["name_row_well_number"] == P.well_number(rr, cc)                       # authors' row-major number
        assert r["colmajor_row_well_number"] == cc * P.N_ROWS + rr + 1                  # column-major number of the image
        assert r["colmajor_row"] == P.make_key(plate, *P.annotation_for_image(rr, cc))
        assert colmajor[r["colmajor_row"]] == r["image_id"]                              # the shipped default index


def test_headline_nuclei_vs_cell_count():
    """Our nucleus count vs the authors' Cell Count on the 106 cached images (protocol 15.4 (a)): 0.16 by name, 0.71 column-major."""
    from scipy.stats import pearsonr, spearmanr
    rows = _fixture()
    nuc = [r["nuclei"] for r in rows]
    name = spearmanr(nuc, [r["name_row_cells"] for r in rows])[0]
    col = spearmanr(nuc, [r["colmajor_row_cells"] for r in rows])[0]
    assert name == pytest.approx(0.158, abs=0.005)
    assert col == pytest.approx(0.712, abs=0.005)
    assert pearsonr(nuc, [r["colmajor_row_cells"] for r in rows])[0] > 0.65
    assert col - name > 0.5


def test_summary_records_the_pairing_and_matches_the_fixture(byname, colmajor):
    s = json.loads((DATA / "summary.json").read_text())
    p = s["pairing"]
    assert p["default"] == "colmajor" and "unconfirmed" in p["status"] and p["options"] == ["colmajor", "name"]
    assert p["diff_vs_name"]["changed_image"] == 56536
    chk = s["experiment_l"]["pairing_check"]
    assert chk["name"]["n"] == chk["colmajor"]["n"] == 106
    assert chk["name"]["nuclei_vs_cell_count_spearman"] == 0.158 and chk["colmajor"]["nuclei_vs_cell_count_spearman"] == 0.712
    assert s["experiment_l"]["pairing"] == "name"                                         # Exp. L ran under the by-name pairing
    # every gallery tile belongs to its pairing's index, and its files exist
    for key, idx in (("gallery", colmajor), ("gallery_byname", byname)):
        assert s[key], key
        for g in s[key]:
            assert idx[g["well"]] == g["image_id"], (key, g["key"])
            assert (DATA / g["raw"]).is_file() and (DATA / g["overlay"]).is_file()
    assert 0 < len(s["gallery"]) <= len(s["gallery_byname"])


def test_screen_eval_report_agrees_with_protocol_numbers():
    """experiments/reports/foci_screen_eval.json (browser SCREEN engine, plate 7-14) quotes the 15.4 (c) numbers."""
    f = ROOT / "experiments" / "reports" / "foci_screen_eval.json"
    if not f.exists():
        pytest.skip("report not present")
    fa = json.loads(f.read_text())["evaluation"]["full_annotation"]
    assert fa["name"]["foci_per_cell_vs_authors"]["spearman"] == pytest.approx(-0.005, abs=0.001)
    assert fa["colmajor"]["foci_per_cell_vs_authors"]["spearman"] == pytest.approx(0.303, abs=0.001)
    assert fa["name"]["nuclei_vs_authors_cell_count"]["spearman"] == pytest.approx(0.07, abs=0.005)
    assert fa["colmajor"]["nuclei_vs_authors_cell_count"]["spearman"] == pytest.approx(0.56, abs=0.01)
    assert fa["colmajor"]["auc_increased_damage"]["ours_foci_per_cell"]["auc"] == pytest.approx(0.68, abs=0.005)
