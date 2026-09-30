"""Tests for scripts/build_foci_annotations.py and the shipped annotations.json.

No network: parsers run on small inline fixtures; the real annotations.json is
validated against genes.json.
"""
from __future__ import annotations

import importlib.util
import io
import json
import re
import sys
import zipfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "build_foci_annotations.py"
ANNOT = ROOT / "foci" / "web" / "data" / "annotations.json"
GENES = ROOT / "foci" / "web" / "data" / "genes.json"

_spec = importlib.util.spec_from_file_location("build_foci_annotations", SCRIPT)
bfa = importlib.util.module_from_spec(_spec)
sys.modules["build_foci_annotations"] = bfa
_spec.loader.exec_module(bfa)


# ------------------------------------------------------------------ fixtures
def make_xlsx(rows: list[list[str]]) -> bytes:
    """Tiny inline-string .xlsx (one sheet) built from rows of strings ('' = empty)."""

    def colname(i):
        return chr(ord("A") + i)

    body = []
    for r, row in enumerate(rows, 1):
        cells = "".join(
            f'<c r="{colname(c)}{r}" t="inlineStr"><is><t>{v}</t></is></c>'
            for c, v in enumerate(row)
            if v != ""
        )
        body.append(f'<row r="{r}">{cells}</row>')
    ns = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
    rel = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("xl/workbook.xml",
                   f'<workbook xmlns="{ns}" xmlns:r="{rel}"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>')
        z.writestr("xl/_rels/workbook.xml.rels",
                   '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                   '<Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>')
        z.writestr("xl/worksheets/sheet1.xml",
                   f'<worksheet xmlns="{ns}"><sheetData>{"".join(body)}</sheetData></worksheet>')
    return buf.getvalue()


TELNET_HEADER = [
    ["Supplementary Table S1"],
    [""],
    ["Gene symbol", "Gene ID", "Correlation coefficient Rho", "p.value", "x", "y", "in TelNet",
     "Cellular function", "TM function", "TMM information", "", "", "TM significance", "TelNet score"],
    ["", "", "", "", "", "", "", "", "", "ALT", "Telomerase-mediated", "Predicted TMM"],
]


def telnet_fixture() -> bytes:
    rows = TELNET_HEADER + [
        ["TERT", "7015", "0.3", "0.01", "", "", "yes", "", "Telomerase activity; ", "enhancing", "enhancing", "Telomerase-mediated", "validated", "8"],
        ["ATRX", "546", "0.1", "0.02", "", "", "yes", "", "DNA repair; ", "ambiguous", "ambiguous", "ALT", "screened", "6"],
        ["NOTIN", "1", "0.1", "0.02", "", "", "no", "", "", "", "", "", "", ""],
        ["1-Sep", "9", "0.1", "0.02", "", "", "yes", "", "", "", "", "", "predicted", "2"],
        ["BADSCORE", "5", "0.1", "0.02", "", "", "yes", "", "", "", "", "", "predicted", "n/a"],
    ]
    return make_xlsx(rows)


def mini_hgnc() -> "bfa.Hgnc":
    text = "\t".join(["hgnc_id", "symbol", "status", "prev_symbol", "entrez_id", "ensembl_gene_id", "locus_type"]) + "\n"
    lines = [
        ("HGNC:1", "TERT", "Approved", "", "7015", "ENSG00000164362"),
        ("HGNC:2", "ATRX", "Approved", "XH2", "546", "ENSG00000085224"),
        ("HGNC:3", "NEWSYM", "Approved", '"OLDSYM|OLDER"', "777", "ENSG00000000777"),
        ("HGNC:4", "AAA1", "Approved", "SHARED", "41", "ENSG00000000041"),
        ("HGNC:5", "AAA2", "Approved", "SHARED", "42", "ENSG00000000042"),
        ("HGNC:6", "GONE", "Entry Withdrawn", "", "99", "ENSG00000000099"),
        ("HGNC:7", "NOENS", "Approved", "", "55", ""),
        # OLDNAME was once a symbol of REUSED but is now approved for another gene
        ("HGNC:8", "REUSED", "Approved", "OTHERGENE", "88", "ENSG00000000088"),
        ("HGNC:9", "OTHERGENE", "Approved", "", "89", "ENSG00000000089"),
        # screen id ENSG...500 is, in HGNC, gene STEAL
        ("HGNC:10", "STEAL", "Approved", "", "500", "ENSG00000000500"),
        ("HGNC:12", "TERT-ATRX", "Approved", "", "600", "ENSG00000164362", "readthrough"),
        ("HGNC:11", "WANTED", "Approved", "", "501", "ENSG00000000501x"),
    ]
    text += "\n".join("\t".join(l) for l in lines) + "\n"
    return bfa.parse_hgnc(text)


def mini_screen() -> "bfa.Screen":
    cols = ["gene", "ensembl"]
    rows = [
        ["TERT", "ENSG00000164362"],
        ["ATRX", "ENSG00000085224.5"],          # version suffix in the screen
        ["OLDSYM", "ENSG00000000888"],           # screen carries an outdated symbol and a different Ensembl build id
        ["MULTI", "ENSG00000000010; ENSG00000000011"],
        ["DUP", "ENSG00000000020"],
        ["dup ", "ENSG00000000021"],             # same symbol, different ids => ambiguous
        ["NOENS", "ENSG00000000055"],
        ["AAA1", "ENSG00000000041"],
        ["OTHERGENE", "ENSG00000000089"],
        ["WANTED", "ENSG00000000500"],           # screen pairs WANTED with STEAL's Ensembl id
    ]
    return bfa.Screen(cols, rows)


# ------------------------------------------------------------------- helpers
def test_norm_symbol_case_space_unicode():
    assert bfa.norm_symbol("  tert\u200b ") == "TERT"
    assert bfa.norm_symbol("\uff34\uff25\uff32\uff34") == "TERT"  # full-width letters
    assert bfa.norm_symbol(None) == ""


def test_split_ensembl_versions_and_multi():
    assert bfa.split_ensembl("ENSG00000085224.12") == ["ENSG00000085224"]
    assert bfa.split_ensembl("ensg00000000010; ENSG00000000011|ENSG00000000010") == [
        "ENSG00000000010", "ENSG00000000011"]
    assert bfa.split_ensembl("") == [] and bfa.split_ensembl(None) == []


def test_excel_date_symbols():
    for s in ("1-Sep", "Mar-01", "10-DEC"):
        assert bfa.is_excel_date_symbol(s)
    assert not bfa.is_excel_date_symbol("SEPTIN1")


# ------------------------------------------------------------------- parsers
def test_parse_telnet_fixture():
    recs = bfa.parse_telnet(telnet_fixture())
    assert [r["symbol"] for r in recs] == ["TERT", "ATRX"]  # 'no', date-mangled and bad score dropped
    tert = recs[0]
    assert tert["entrez"] == "7015" and tert["score"] == 8
    assert tert["functions"] == "Telomerase activity"
    assert (tert["alt"], tert["telomerase"], tert["predicted_tmm"]) == ("enhancing", "enhancing", "Telomerase-mediated")
    assert tert["rho"] == pytest.approx(0.3)


def test_parse_telnet_missing_header_raises():
    with pytest.raises(ValueError):
        bfa.parse_telnet(make_xlsx([["nothing", "here"]]))


def test_parse_depmap_fixture():
    text = 'Essentials\nAAMP (14)\n"AARS1 (16)"\nAAMP (14)\n\nbroken line\nATP5F1A (498)\n'
    recs = bfa.parse_depmap(text)
    assert recs == [
        {"symbol": "AAMP", "entrez": "14"},
        {"symbol": "AARS1", "entrez": "16"},
        {"symbol": "ATP5F1A", "entrez": "498"},
    ]


def _gwas(aid, genes, p, acc="GCST1", efo="OBA_0003784"):
    return {"association_id": aid, "accession_id": acc, "pubmed_id": "111", "first_author": "Doe J",
            "p_value": p, "mapped_genes": genes, "efo_traits": [{"efo_id": efo, "efo_trait": "t"}]}


def test_parse_gwas_filters_and_explodes():
    recs = bfa.parse_gwas([
        _gwas(1, ["TERT", "CLPTM1L"], 1e-30),
        _gwas(2, ["ATRX"], 1e-6),                       # not genome-wide significant
        _gwas(3, ["OTHER"], 1e-20, efo="MONDO_0100096"),  # other trait
        _gwas(4, [], 1e-20),                            # no mapped gene
        _gwas(5, ["  TERT "], None),                    # no p-value
        {**_gwas(6, ["NAF1"], None), "pvalue_mantissa": 2, "pvalue_exponent": -9},
        _gwas(1, ["TERT"], 1e-30),                      # duplicated row
    ])
    assert sorted(r["symbol"] for r in recs) == ["CLPTM1L", "NAF1", "TERT"]
    assert next(r for r in recs if r["symbol"] == "NAF1")["p"] == pytest.approx(2e-9)


def test_parse_hgnc_bridge():
    h = mini_hgnc()
    assert h.by_entrez["7015"]["ensembl"] == "ENSG00000164362"
    assert "GONE" not in h.by_symbol            # withdrawn entries ignored
    assert h.by_prev["OLDSYM"]["symbol"] == "NEWSYM"
    assert "SHARED" not in h.by_prev            # ambiguous previous symbol unusable
    assert h.by_symbol["NOENS"]["ensembl"] is None
    assert "TERT-ATRX" not in h.by_symbol and "600" not in h.by_entrez   # readthrough loci skipped


# ---------------------------------------------------------------------- join
def test_resolver_by_entrez_with_version_suffix():
    r = bfa.Resolver(mini_screen(), mini_hgnc())
    assert r.resolve("ATRX", "546") == ("ENSG00000085224", "ensembl")
    assert r.resolve("WRONGSYM", "7015") == ("ENSG00000164362", "ensembl")  # entrez beats symbol


def test_resolver_direct_ensembl_multi_id():
    r = bfa.Resolver(mini_screen(), mini_hgnc())
    assert r.resolve("x", "", "ENSG00000000099; ENSG00000000011.3") == ("ENSG00000000011", "ensembl")


def test_resolver_symbol_fallback_and_flag():
    r = bfa.Resolver(mini_screen(), mini_hgnc())
    # symbol only, HGNC ensembl id is in the screen
    assert r.resolve(" tert ") == ("ENSG00000164362", "symbol")
    # outdated symbol lives in the screen; HGNC resolves it through the previous-symbol list
    assert r.resolve("NEWSYM", "777") == ("ENSG00000000888", "symbol")
    assert r.resolve("OLDSYM") == ("ENSG00000000888", "symbol")


def test_resolver_rejects_reused_previous_symbol_and_id_conflicts():
    r = bfa.Resolver(mini_screen(), mini_hgnc())
    # REUSED's previous symbol OTHERGENE is an approved symbol elsewhere: must not match via it
    assert r.resolve("REUSED", "88") is None
    # screen row WANTED carries an id that HGNC assigns to a different gene (STEAL)
    assert r.resolve("WANTED", "501") is None
    assert r.resolve("WANTED") is None


def test_resolver_ambiguity_and_absence():
    r = bfa.Resolver(mini_screen(), mini_hgnc())
    assert r.resolve("DUP") is None            # two Ensembl ids share that symbol in the screen
    assert r.resolve("SHARED") is None         # previous symbol of two genes
    assert r.resolve("NOSUCHGENE", "123456") is None
    assert r.resolve("GONE", "99") is None     # withdrawn HGNC entry, not in screen


def test_join_records_merges_duplicates_and_counts():
    r = bfa.Resolver(mini_screen(), mini_hgnc())
    recs = [{"symbol": "TERT", "entrez": "7015"}, {"symbol": "tert", "entrez": ""},
            {"symbol": "ATRX", "entrez": "546"}, {"symbol": "NOPE", "entrez": ""}]
    by, n_src = bfa.join_records(recs, r)
    assert set(by) == {"ENSG00000164362", "ENSG00000085224"}
    assert by["ENSG00000164362"]["method"] == "ensembl" and len(by["ENSG00000164362"]["recs"]) == 2
    assert n_src == 4  # E:7015, S:TERT, E:546, S:NOPE


# --------------------------------------------------------------- annotations
def test_annotators_shape_and_symbol_flag():
    slot = {"method": "symbol", "recs": [{"symbol": "TERT", "entrez": "7015", "score": 8, "significance": "validated",
                                          "functions": "Telomerase activity", "alt": "enhancing",
                                          "telomerase": "enhancing", "predicted_tmm": "ALT"}]}
    a = bfa.annotate_telnet(slot)
    assert a["label"] == "TelNet score 8" and a["match"] == "symbol" and "symbol" in a["detail"]
    slot["method"] = "ensembl"
    assert "match" not in bfa.annotate_telnet(slot)

    g = bfa.annotate_gwas({"method": "ensembl", "recs": [
        {"symbol": "TERT", "p": 1e-30, "accession": "GCST1", "pmid": "1", "author": "A", "assoc_id": 1},
        {"symbol": "TERT", "p": 1e-9, "accession": "GCST2", "pmid": "2", "author": "B", "assoc_id": 2}]})
    assert g["label"] == "Telomere-length GWAS x2" and "GCST1" in g["detail"] and "2 studies" in g["detail"]
    assert "not a causal" in g["detail"] and g["url"].endswith("/genes/TERT")
    assert len(g["label"]) <= bfa.LABEL_MAX
    assert len(bfa.annotate_depmap({"method": "ensembl", "recs": [{}]})["label"]) <= bfa.LABEL_MAX


def test_fit_truncates_long_labels():
    assert len(bfa._fit("x" * 60)) == bfa.LABEL_MAX


def _mini_manifest():
    return {k: {"retrieved_utc": f"2026-01-0{i}T00:00:00Z"} for i, k in enumerate(["telnet", "gwas", "depmap", "hgnc"], 1)}


def test_assemble_contract_and_determinism():
    r = bfa.Resolver(mini_screen(), mini_hgnc())
    raw = {"telnet": bfa.parse_telnet(telnet_fixture()),
           "depmap": [{"symbol": "ATRX", "entrez": "546"}, {"symbol": "ZZZ", "entrez": "1"}],
           "gwas": [{"symbol": "TERT", "p": 1e-30, "accession": "G", "pmid": "1", "author": "A", "assoc_id": 1}]}
    d1 = bfa.assemble(raw, r, _mini_manifest())
    d2 = bfa.assemble(json.loads(json.dumps(raw)), bfa.Resolver(mini_screen(), mini_hgnc()), _mini_manifest())
    assert bfa.dumps(d1) == bfa.dumps(d2)
    assert d1["built_utc"] == "2026-01-04T00:00:00Z"   # newest cache timestamp, not wall clock
    assert d1["match"]["depmap"] == {"screen_genes_matched": 1, "of": 2, "by_ensembl": 1, "by_symbol": 0}
    assert d1["match"]["gwas"]["by_symbol"] == 1
    assert d1["by_ensembl"]["ENSG00000164362"].keys() == {"telnet", "gwas"}
    assert [s["id"] for s in d1["sources"]] == ["telnet", "gwas", "depmap"]


def test_build_offline_from_cache(tmp_path):
    """End to end from a hand-made cache: build(), then a second build gives identical bytes."""
    cache = tmp_path / "cache"
    cache.mkdir()
    (cache / bfa.CACHE_FILES["telnet"]).write_bytes(telnet_fixture())
    (cache / bfa.CACHE_FILES["depmap"]).write_text("Essentials\nATRX (546)\n", encoding="utf-8")
    hg = "hgnc_id\tsymbol\tstatus\tprev_symbol\tentrez_id\tensembl_gene_id\nH:1\tTERT\tApproved\t\t7015\tENSG00000164362\nH:2\tATRX\tApproved\t\t546\tENSG00000085224\n"
    (cache / bfa.CACHE_FILES["hgnc"]).write_text(hg, encoding="utf-8")
    (cache / bfa.CACHE_FILES["gwas"]).write_text(json.dumps({"records": [_gwas(1, ["TERT"], 1e-20)]}), encoding="utf-8")
    man = _mini_manifest()
    for key, fname in bfa.CACHE_FILES.items():
        man[key]["sha256"] = bfa.sha256_file(cache / fname)
    (cache / "manifest.json").write_text(json.dumps(man), encoding="utf-8")
    genes = tmp_path / "genes.json"
    genes.write_text(json.dumps({"columns": ["gene", "ensembl"], "rows": [
        ["TERT", "ENSG00000164362"], ["ATRX", "ENSG00000085224"]]}), encoding="utf-8")
    a = bfa.dumps(bfa.build(cache, genes))
    b = bfa.dumps(bfa.build(cache, genes))
    assert a == b
    assert bfa.ensure_cache(cache, offline=True, refresh=False)  # no network needed
    out = tmp_path / "out.json"
    assert bfa.main(["--cache", str(cache), "--genes", str(genes), "--out", str(out), "--offline"]) == 0
    assert out.read_text(encoding="utf-8") == a


def test_offline_detects_corrupted_cache_file(tmp_path):
    cache = tmp_path / "c"
    cache.mkdir()
    man = {}
    for key, fname in bfa.CACHE_FILES.items():
        (cache / fname).write_bytes(b"data-" + key.encode())
        man[key] = {"sha256": bfa.sha256_file(cache / fname), "retrieved_utc": "2026-01-01T00:00:00Z"}
    (cache / "manifest.json").write_text(json.dumps(man), encoding="utf-8")
    assert bfa.ensure_cache(cache, offline=True, refresh=False)
    (cache / bfa.CACHE_FILES["hgnc"]).write_bytes(b"truncated")
    with pytest.raises(bfa.FetchError):
        bfa.ensure_cache(cache, offline=True, refresh=False)


def test_offline_with_missing_cache_fails_cleanly(tmp_path):
    with pytest.raises(bfa.FetchError):
        bfa.ensure_cache(tmp_path / "empty", offline=True, refresh=False)
    assert bfa.main(["--cache", str(tmp_path / "empty2"), "--offline", "--out", str(tmp_path / "o.json")]) == 2


def test_http_get_rejects_partial_and_http_errors(monkeypatch, tmp_path):
    import urllib.error

    class Resp:
        status = 200
        def __init__(self, body, declared):
            self._b, self.headers = io.BytesIO(body), {"Content-Length": str(declared)}
        def read(self, n=-1): return self._b.read(n)
        def __enter__(self): return self
        def __exit__(self, *a): return False

    monkeypatch.setattr(bfa.time, "sleep", lambda s: None)
    monkeypatch.setattr(bfa.urllib.request, "urlopen", lambda req, timeout=0: Resp(b"abc", 10))
    with pytest.raises(bfa.FetchError, match="partial"):
        bfa.http_get("https://example.invalid/x", tmp_path / "x.bin", retries=2)
    assert not (tmp_path / "x.bin").exists() and not list(tmp_path.glob("*.part"))

    def boom(req, timeout=0):
        raise urllib.error.HTTPError("u", 503, "unavailable", {}, None)
    monkeypatch.setattr(bfa.urllib.request, "urlopen", boom)
    with pytest.raises(bfa.FetchError):
        bfa.http_get("https://example.invalid/x", tmp_path / "y.bin", retries=2)

    monkeypatch.setattr(bfa.urllib.request, "urlopen", lambda req, timeout=0: Resp(b"abcdef", 6))
    info = bfa.http_get("https://example.invalid/x", tmp_path / "z.bin")
    assert (tmp_path / "z.bin").read_bytes() == b"abcdef" and info["bytes"] == 6


# ----------------------------------------------------- shipped annotations.json
@pytest.fixture(scope="module")
def shipped():
    if not ANNOT.exists():
        pytest.skip("annotations.json not built")
    return json.loads(ANNOT.read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def screen_ids():
    g = json.loads(GENES.read_text(encoding="utf-8"))
    i = g["columns"].index("ensembl")
    ids = set()
    for r in g["rows"]:
        ids.update(bfa.split_ensembl(r[i]))
    return ids


def _no_nulls(o):
    if isinstance(o, dict):
        return all(v is not None and _no_nulls(v) for v in o.values())
    if isinstance(o, list):
        return all(v is not None and _no_nulls(v) for v in o)
    return True


def test_shipped_contract(shipped, screen_ids):
    assert shipped["version"] == 1
    assert re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ", shipped["built_utc"])
    src_ids = [s["id"] for s in shipped["sources"]]
    assert len(src_ids) == len(set(src_ids)) and src_ids
    for s in shipped["sources"]:
        for k in ("id", "name", "url", "licence", "licence_url", "retrieved_utc", "version", "attribution", "caveat"):
            assert isinstance(s.get(k), str) and s[k].strip(), (s["id"], k)
        assert s["url"].startswith("https://") and s["licence_url"].startswith("https://")
    used = set()
    for ensg, per in shipped["by_ensembl"].items():
        assert re.fullmatch(r"ENSG\d{11}", ensg) and ensg in screen_ids
        assert per
        for sid, a in per.items():
            used.add(sid)
            assert sid in src_ids
            assert 0 < len(a["label"]) <= 24
            assert a["detail"].strip() and "\n" not in a["detail"]
            assert set(a) <= {"label", "detail", "url", "match"}
            if "url" in a:
                assert a["url"].startswith("https://")
            if a.get("match") == "symbol":
                assert "symbol" in a["detail"].lower()
    assert used <= set(src_ids)
    assert set(shipped["match"]) == set(src_ids)
    for sid, m in shipped["match"].items():
        assert m["by_ensembl"] + m["by_symbol"] == m["screen_genes_matched"] <= m["of"]
        n = sum(1 for per in shipped["by_ensembl"].values() if sid in per)
        assert n == m["screen_genes_matched"]
        n_sym = sum(1 for per in shipped["by_ensembl"].values() if per.get(sid, {}).get("match") == "symbol")
        assert n_sym == m["by_symbol"]
    assert _no_nulls(shipped)


def test_shipped_sorted_compact_and_small(shipped):
    raw = ANNOT.read_bytes().replace(b"
", b"
")  # tolerate git autocrlf checkouts
")  # tolerate git autocrlf checkouts
    assert len(raw) < 1_500_000
    assert raw.endswith(b"\n") and b"\r" not in raw
    assert raw.decode("utf-8") == bfa.dumps(shipped)  # canonical: sorted keys, compact separators
