"""Foci Lab data exports: sirna.json, symbols.json, downloads/ (CSV + manifest).

Two layers: (1) the build script run offline on a small synthetic screen table + mini HGNC file (schema,
determinism, odd symbols, QC handling); (2) consistency checks on the committed files under foci/web/data.
"""

from __future__ import annotations

import csv
import hashlib
import importlib.util
import io
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "foci" / "web" / "data"
sys.path.insert(0, str(ROOT / "src"))

_spec = importlib.util.spec_from_file_location("build_foci_dataset", ROOT / "scripts" / "build_foci_dataset.py")
bfd = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(bfd)

REAL_COLS = ["Plate", "LabTek Plate", "Well Number", "Well", "Plate_Well", "Characteristics [Organism]",
             "Term Source 1 REF", "Term Source 1 Accession", "Characteristics [Cell Line]", "Term Source 2 REF",
             "Term Source 2 Accession", "siRNA Identifier", "Sense Sequence", "Antisense Sequence",
             "Original Gene Target", "Reagent Design Gene Annotation Build", "Gene Identifier", "Gene Symbol",
             "Gene Annotation Comments", "Analysis Gene Annotation Build", "Control Type", "Control Comments",
             "Quality Control", "Quality Control Comments", "Channels", "Comments", "Cell Count", "53BP1 foci",
             "Foci Per Cell", "Foci Per Cell (Normalized)", "Has Phenotype", "Phenotype Annotation Level",
             "Phenotype 1", "Phenotype 1 Term Name", "Phenotype 1 Term Accession", "Phenotype 2",
             "Phenotype 2 Term Name", "Phenotype 2 Term Accession"]
ODD = ["C9orf150", "AL390728.37", "Q9BSZ0_HUMAN", "NP_689812.2", "SETD8", "ALPPL2"]


def make_screen(seed=3):
    """~66 genes x 2-3 wells + controls; odd symbols, a single-well gene, a symbol with two Ensembl IDs, QC-removed
    wells that still carry a gene, a missing siRNA id, a zero and a missing normalised value."""
    rng = np.random.default_rng(seed)
    rows, k = [], 0

    def add(gene, ens, ctype, qc, norm, sirna, cells=None):
        nonlocal k
        k += 1
        cells = int(rng.integers(40, 300)) if cells is None else cells
        fpc = norm * 1.2
        rows.append({"Plate": 1, "Plate_Well": f"1-1_A{k}", "siRNA Identifier": sirna,
                     "Sense Sequence": None if sirna is None else "GGAUCUUCAAGUUUUCGGUtt",
                     "Antisense Sequence": None if sirna is None else "ACCGAAAACUUGAAGAUCCtg",
                     "Gene Identifier": ens, "Gene Symbol": gene, "Control Type": ctype, "Quality Control": qc,
                     "Cell Count": cells, "53BP1 foci": fpc * cells if np.isfinite(fpc) else None,
                     "Foci Per Cell": fpc, "Foci Per Cell (Normalized)": norm})

    for _ in range(40):
        add(None, None, "negative control", None, float(np.exp(rng.normal(0, .2))), None)
    for _ in range(4):
        add("ATM", "ENSG00000000001", "positive control", None, 1.5, None)
    for i, g in enumerate(ODD + [f"GENE{i}" for i in range(60)]):
        ens = f"ENSG{i + 10:011d}"
        for j in range(2 + i % 2):
            shift = -1.8 if g == "GENE3" else 0.0
            add(g, ens, None, None, float(np.exp(shift + rng.normal(0, .25))), str(1000 + 10 * i + j))
    add("SINGLE1", "ENSG00000099001", None, None, 0.9, "5001")
    add("SINGLE1", "ENSG00000099001", None, "remove", 0.5, "5002")                   # removed well of a 1-well gene
    add("ALPPL2", "ENSG00000099002", None, None, 1.1, "5003")                        # 2nd Ensembl ID for a symbol
    add("ONLYREMOVED", "ENSG00000099003", None, "remove", 0.4, "5004")               # gene with no passing well
    add("GENE5", "ENSG00000000015", None, None, 0.0, None)                           # zero norm, no siRNA id
    add("GENE6", "ENSG00000000016", None, None, float("nan"), "5005")                # missing norm
    add("GENE7", "ENSG00000000017", None, "remove", float("nan"), "5006", cells=np.nan)
    d = pd.DataFrame(rows)
    for c in REAL_COLS:
        if c not in d.columns:
            d[c] = None
    return d[REAL_COLS]


def make_hgnc(path: Path):
    """Mini HGNC file: renames, a shared alias (ambiguous), one Ensembl ID claimed twice, a symbol 'NA'."""
    cols = ["hgnc_id", "symbol", "name", "prev_symbol", "alias_symbol", "ensembl_gene_id", "status"]
    rows = [
        ["HGNC:1", "LURAP1L", "leucine rich adaptor protein 1 like", "C9orf150", "", "ENSG00000000010", "Approved"],
        ["HGNC:2", "KMT5A", "lysine methyltransferase 5A", "SETD8", "SET8|PR-Set7", "ENSG00000000014", "Approved"],
        ["HGNC:3", "ALPG", "alkaline phosphatase, germ cell", "ALPPL2", "", "ENSG00000000011", "Approved"],
        ["HGNC:4", "GENE0", "gene zero éü", "", "SET8", "ENSG00000000012", "Approved"],   # SET8 ambiguous
        ["HGNC:5", "NA", "symbol that looks like a null", "", "", "ENSG00000000013", "Approved"],
        ["HGNC:6", "SHARE1", "claimed twice", "", "", "ENSG00000000015", "Approved"],
        ["HGNC:7", "SHARE2", "claimed twice", "", "", "ENSG00000000015", "Approved"],
        ["HGNC:8", "OUTSIDE", "not in the screen", "", "OUT1", "ENSG99999999999", "Approved"],
        ["HGNC:9", "NOENS", "no ensembl", "", "", "", "Approved"],
    ]
    pd.DataFrame(rows, columns=cols).to_csv(path, sep="\t", index=False)


def run_build(tmp: Path, name="out"):
    src = tmp / "src"
    src.mkdir(exist_ok=True)
    make_screen().to_csv(src / "annotation.csv", index=False)
    make_hgnc(src / "hgnc.txt")
    (src / "hgnc.meta.json").write_text(json.dumps({"retrieved_utc": "2026-01-01T00:00:00Z", "release": "test"}))
    out = tmp / name
    out.mkdir()
    (out / "well_index.json").write_text(json.dumps({f"1-1_A{i}": 100 + i for i in range(1, 400, 2)}))
    rc = bfd.main(["--no-images", "--out", str(out), "--annotation", str(src / "annotation.csv"),
                   "--hgnc", str(src / "hgnc.txt")])
    assert rc == 0
    return out


@pytest.fixture(scope="module")
def built(tmp_path_factory):
    return run_build(tmp_path_factory.mktemp("foci_build"))


def load(out, name):
    return json.loads((out / name).read_text(encoding="utf-8"))


# ------------------------------------------------------------------ synthetic build

def test_sirna_schema_and_qc(built):
    s, g = load(built, "sirna.json"), load(built, "genes.json")
    assert s["version"] == 1
    assert s["columns"] == ["sirna", "plate_well", "z", "norm_fpc", "fpc", "cells", "qc", "imaged", "sense", "antisense"]
    assert list(s["by_gene"]) == sorted(s["by_gene"])
    ann = make_screen()
    n_samples = int((ann["Control Type"].isna() & ann["Gene Symbol"].notna()).sum())
    assert sum(len(v) for v in s["by_gene"].values()) == n_samples
    gz = {w[0]: w[3] for r in g["rows"] for w in r[-1]}
    seen = set()
    rows = {}
    for gene, rs in s["by_gene"].items():
        for r in rs:
            d = dict(zip(s["columns"], r))
            rows[d["plate_well"]] = d
            assert d["plate_well"] not in seen
            seen.add(d["plate_well"])
            assert d["qc"] in ("pass", "remove") and isinstance(d["imaged"], bool)
            assert all(isinstance(d[c], str) for c in ("sense", "antisense", "sirna"))
            if d["qc"] == "remove":
                assert d["z"] is None and d["plate_well"] not in gz
            elif d["z"] is not None:
                assert gz[d["plate_well"]] == d["z"]
    assert "ONLYREMOVED" in s["by_gene"] and "ONLYREMOVED" not in {r[0] for r in g["rows"]}
    zero = ann[(ann["Gene Symbol"] == "GENE5") & (ann["Foci Per Cell (Normalized)"] == 0)]["Plate_Well"].iloc[0]
    assert rows[zero]["qc"] == "pass" and rows[zero]["z"] is None and rows[zero]["sirna"] == f"well:{zero}"
    assert not any(isinstance(v, float) and not np.isfinite(v) for d in rows.values() for v in d.values())


def test_removed_wells_never_ranked_or_counted(built):
    g = load(built, "genes.json")
    by = {r[0]: r for r in g["rows"]}
    assert by["SINGLE1"][1] == 1 and by["SINGLE1"][7] is None and by["SINGLE1"][13] == "single_well"
    csvw = pd.read_csv(built / "downloads" / "foci_wells.csv", keep_default_na=False, na_values=[""],
                       dtype={"sirna": str})
    rem = csvw[csvw["qc"] == "remove"]
    assert len(rem) == 3 and rem["z"].isna().all()
    assert (csvw[csvw["gene"] == "ONLYREMOVED"]["gene_status"].isna()).all()


def test_symbols_schema(built):
    sym, g = load(built, "symbols.json"), load(built, "genes.json")
    assert sym["version"] == 1 and set(sym["source"]) == {"name", "url", "licence", "retrieved_utc", "release"}
    assert "CC0" in sym["source"]["licence"]
    assert set(sym["by_ensembl"]) <= {r[6] for r in g["rows"]}
    assert "ENSG99999999999" not in sym["by_ensembl"]                         # outside the screen
    assert "ENSG00000000015" not in sym["by_ensembl"] and sym["shared_ensembl"] == ["ENSG00000000015"]
    for v in sym["by_ensembl"].values():
        assert set(v) == {"symbol", "name", "aliases", "previous"} and isinstance(v["aliases"], list)
    assert sym["by_ensembl"]["ENSG00000000012"]["name"] == "gene zero éü"
    assert sym["by_ensembl"]["ENSG00000000013"]["symbol"] == "NA"             # not turned into NaN
    assert set(sym["lookup"]).isdisjoint(sym["ambiguous"])
    assert sym["ambiguous"]["SET8"] == ["ENSG00000000012", "ENSG00000000014"]
    assert sym["lookup"]["SETD8"] == "ENSG00000000014" and sym["lookup"]["C9ORF150"] == "ENSG00000000010"
    assert sym["lookup"]["PR-SET7"] == "ENSG00000000014"
    for tok, e in sym["lookup"].items():
        assert tok == tok.upper() and e in sym["by_ensembl"]
    for es in sym["ambiguous"].values():
        assert len(es) > 1 and es == sorted(es) and set(es) <= set(sym["by_ensembl"])


def test_summary_blocks(built):
    s = load(built, "summary.json")
    assert s["build"]["manifest"] == "downloads/manifest.json" and s["build"]["built_utc"].endswith("Z")
    b = s["symbols"]
    assert b["genes_symbol_differs"] == 5 and b["genes_symbol_differs_explained_by_previous_or_alias"] == 2
    assert b["ensembl_ids_missing_from_hgnc"] == b["ensembl_ids_in_screen"] - b["ensembl_ids_found_in_hgnc"]
    assert {e["screen_symbol"] for e in b["examples"]} == {"C9orf150", "SETD8"}


def test_csv_roundtrip_and_dtypes(built):
    d = built / "downloads"
    raw = (d / "foci_wells.csv").read_bytes()
    assert b"\r" not in raw and raw.endswith(b"\n") and not raw.startswith(b"\xef\xbb\xbf")
    w = pd.read_csv(d / "foci_wells.csv", keep_default_na=False, na_values=[""], dtype={"sirna": str})
    assert list(w.columns) == bfd.WELLS_CSV_COLUMNS
    assert w["imaged"].dtype == bool and w["z"].dtype == float and w["plate_well"].is_unique
    assert set(w["qc"]) == {"pass", "remove"}
    g = pd.read_csv(d / "foci_genes.csv", keep_default_na=False, na_values=[""])
    gj = load(built, "genes.json")
    assert list(g.columns) == bfd.GENES_CSV_COLUMNS
    assert len(g) == len(gj["rows"]) and g["gene"].is_unique and g["wells"].dtype == np.int64
    assert g["rank"].notna().sum() == sum(r[7] is not None for r in gj["rows"])
    assert g["rank"].dropna().is_monotonic_increasing
    by = g.set_index("gene")
    assert by.loc["C9orf150", "hgnc_symbol"] == "LURAP1L" and pd.isna(by.loc["SINGLE1", "hgnc_symbol"])
    gz = {x[0]: x[3] for r in gj["rows"] for x in r[-1]}
    for pw, z in zip(w["plate_well"], w["z"]):
        if pw in gz:
            assert gz[pw] == z
        else:
            assert pd.isna(z)


def test_quoting_of_awkward_fields():
    data = bfd.csv_bytes(["a", "b", "c"], [["x,y", 'say "hi"', "line\nbreak"], [None, float("nan"), True],
                                           [1.5, 3, "é"]])
    rows = list(csv.reader(io.StringIO(data.decode("utf-8"), newline="")))
    assert rows == [["a", "b", "c"], ["x,y", 'say "hi"', "line\nbreak"], ["", "", "true"], ["1.5", "3", "é"]]


def test_manifest_matches_files(built):
    d = built / "downloads"
    m = json.loads((d / "manifest.json").read_text(encoding="utf-8"))
    assert set(m) == {"built_utc", "git_commit", "code_version", "licence", "attribution", "source_metadata_url", "files"}
    assert m["licence"] == "CC BY 4.0" and "10.1016/j.cell.2008.12.041" in m["attribution"]
    assert {f["name"] for f in m["files"]} == {"foci_genes.csv", "foci_wells.csv", "README_DATA.txt"}
    for f in m["files"]:
        data = (d / f["name"]).read_bytes()
        assert f["bytes"] == len(data) and f["sha256"] == hashlib.sha256(data).hexdigest()
        if f["name"].endswith(".csv"):
            assert f["rows"] == len(pd.read_csv(d / f["name"], keep_default_na=False))
        else:
            assert f["rows"] is None


def test_build_is_deterministic(built, tmp_path):
    second = run_build(tmp_path, "again")
    for name in ["downloads/foci_genes.csv", "downloads/foci_wells.csv", "downloads/README_DATA.txt", "sirna.json",
                 "symbols.json", "genes.json"]:
        assert (built / name).read_bytes() == (second / name).read_bytes(), name
    a = json.loads((built / "downloads" / "manifest.json").read_text())["files"]
    b = json.loads((second / "downloads" / "manifest.json").read_text())["files"]
    assert a == b


def test_build_without_hgnc_still_writes_downloads(tmp_path, monkeypatch):
    src = tmp_path / "a.csv"
    make_screen().to_csv(src, index=False)
    out = tmp_path / "o"
    out.mkdir()
    (out / "well_index.json").write_text("{}")

    def offline(dest):
        raise OSError("offline")

    monkeypatch.setattr(bfd, "download_hgnc", offline)
    assert bfd.main(["--no-images", "--out", str(out), "--annotation", str(src),
                     "--hgnc", str(tmp_path / "none" / "hgnc.txt")]) == 0
    assert not (out / "symbols.json").exists() and "symbols" not in load(out, "summary.json")
    g = pd.read_csv(out / "downloads" / "foci_genes.csv", keep_default_na=False, na_values=[""])
    assert g["hgnc_symbol"].isna().all()


def test_no_images_keeps_gallery_and_experiment_l(tmp_path):
    src = tmp_path / "a.csv"
    make_screen().to_csv(src, index=False)
    make_hgnc(tmp_path / "h.txt")
    out = tmp_path / "o"
    out.mkdir()
    (out / "well_index.json").write_text("{}")
    (out / "summary.json").write_text(json.dumps({"gallery": [{"key": "x"}], "experiment_l": {"n_wells": 7}}))
    assert bfd.main(["--no-images", "--out", str(out), "--annotation", str(src), "--hgnc", str(tmp_path / "h.txt")]) == 0
    s = load(out, "summary.json")
    assert s["gallery"] == [{"key": "x"}] and s["experiment_l"] == {"n_wells": 7} and "build" in s


# ------------------------------------------------------------------ committed files

@pytest.mark.skipif(not (DATA / "sirna.json").exists(), reason="data not built")
def test_committed_files_consistent():
    g, s = load(DATA, "genes.json"), load(DATA, "sirna.json")
    sym = load(DATA, "symbols.json")
    m = json.loads((DATA / "downloads" / "manifest.json").read_text(encoding="utf-8"))
    assert set(sym["by_ensembl"]) <= {r[6] for r in g["rows"]}
    assert set(sym["lookup"]).isdisjoint(sym["ambiguous"])
    gz = {w[0]: w[3] for r in g["rows"] for w in r[-1]}
    for rows in s["by_gene"].values():
        for r in rows:
            d = dict(zip(s["columns"], r))
            if d["qc"] == "remove":
                assert d["z"] is None and d["plate_well"] not in gz
            elif d["z"] is not None:
                assert gz[d["plate_well"]] == d["z"]
    assert all(r[7] is None or r[1] >= 2 for r in g["rows"])                  # only 2+ well genes carry a rank
    for f in m["files"]:
        data = (DATA / "downloads" / f["name"]).read_bytes()
        assert hashlib.sha256(data).hexdigest() == f["sha256"] and len(data) == f["bytes"]
    assert len((DATA / "sirna.json").read_bytes()) < 9_000_000
    summ = load(DATA, "summary.json")
    assert summ["build"]["manifest"] == "downloads/manifest.json" and len(summ["gallery"]) > 0 and "experiment_l" in summ
