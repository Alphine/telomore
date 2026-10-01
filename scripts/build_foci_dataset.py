"""CLI: build the Foci Lab static dataset from IDR study idr0010 (Doil et al. 2009).

Outputs (all under ``foci/web/data`` unless --out is given):

* ``genes.json``      -- one row per gene: wells, median foci/cell (plate-normalised
                          and raw), median cell count, and its wells; from the authors' own
                          per-well table (idr0010-screenA-annotation.csv).
* ``summary.json``    -- screen totals, control distributions, histogram of
                          normalised foci/cell, top/bottom hits, telomere panel,
                          gallery index, Experiment L validation.
* ``sirna.json``      -- per-siRNA / per-well rows for every sample well with a gene symbol
                          (QC-removed wells kept and labelled; never ranked).
* ``symbols.json``    -- current HGNC symbols, names, previous symbols and aliases for the
                          Ensembl IDs in the screen (HGNC, CC0) + a token lookup.
* ``downloads/``      -- foci_genes.csv, foci_wells.csv, README_DATA.txt, manifest.json.
                          Formats: foci/DATA_FORMATS.md.
* ``well_index_byname.json`` -- IDR well address (Plate_Well) -> IDR image id for every imaged well, straight from
                          the IDR API: the image grid, and the "by IDR name" pairing as originally built.
* ``well_index.json`` -- annotation row (Plate_Well) -> IDR image id under the chosen pairing (default column-major,
                          empirically inferred, unconfirmed by IDR; scripts/build_foci_pairing.py). Used by the PHP
                          image proxy and the Railway overlay endpoint.
* ``img/*.jpg``       -- gallery for the default pairing: raw composite + our nucleus/foci overlay;
                          ``img/byname/*.jpg`` the same for the by-name pairing (summary.gallery_byname).

Experiment L re-runs our classical focus counter (telomere_lab.foci) on a fixed,
stratified sample of wells and compares with the authors' per-well counts.

    python scripts/build_foci_dataset.py                # full build (~5-10 min, network)
    python scripts/build_foci_dataset.py --no-images    # tables only
    python scripts/build_foci_dataset.py --only-gallery --gallery-keys RNF168,PSMA3 --max-requests 20
                                                        # (re)build some gallery tiles only, with an IDR request cap
    python scripts/build_foci_dataset.py --pairing name # annotation join and well_index.json as originally built
    python scripts/build_foci_dataset.py --refresh-hgnc # re-download the HGNC complete set (one request)
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import hashlib
import io
import json
import subprocess
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_foci_pairing import DEFAULT_PAIRING, PAIRING_STATUS, diff_stats, dumps, paired_index  # noqa: E402
from telomere_lab.foci import ATTRIBUTION, FociParams, IdrClient, count_foci, fetch_image_channels, overlay_rgb  # noqa: E402
from telomere_lab.foci.stats import (LOW_CELLS, NORM_COL as NORM, Q_HIT, Z_SIRNA, gene_stats, r3,  # noqa: E402
                                     sample_well_table, sirna_concordance, truth_check, well_scores)

META_URL = ("https://raw.githubusercontent.com/IDR/idr-metadata/master/"
            "idr0010-doil-dnadamage/screenA/idr0010-screenA-annotation.csv")
CACHE = ROOT / ".cache" / "idr0010"
HGNC_URL = "https://storage.googleapis.com/public-download-files/hgnc/tsv/tsv/hgnc_complete_set.txt"
HGNC_CACHE = ROOT / ".cache" / "hgnc" / "hgnc_complete_set.txt"
HGNC_LICENCE_URL = "https://www.genenames.org/about/license/"
DATA_FORMAT_VERSION = 1            # bump when the schema of any exported file changes (foci/DATA_FORMATS.md)
NUM_COLS = ["Cell Count", "53BP1 foci", "Foci Per Cell", "Foci Per Cell (Normalized)"]

GALLERY = [
    ("negative control", "Negative control (non-targeting siRNA)", "control"),
    ("RNF168", "Ubiquitin ligase that recruits 53BP1 to breaks", "down"),
    ("MDC1", "Mediator of DNA-damage checkpoint", "down"),
    ("RNF8", "Ubiquitin ligase upstream of RNF168", "down"),
    ("ATM", "Master kinase of the break response", "repair"),
    ("H2AFX", "Histone variant H2AX (gamma-H2AX)", "repair"),
    ("PSMA3", "Proteasome subunit", "up"),
    ("PSMB2", "Proteasome subunit", "up"),
    ("TERT", "Telomerase reverse transcriptase", "telomere"),
    ("TERF1", "Shelterin: TRF1", "telomere"),
    ("TERF2", "Shelterin: TRF2", "telomere"),
    ("POT1", "Shelterin: POT1", "telomere"),
    ("TINF2", "Shelterin: TIN2", "telomere"),
]
TELOMERE_GENES = ["TERT", "TERC", "TERF1", "TERF2", "TERF2IP", "POT1", "TINF2", "ACD", "DKC1", "WRN", "BLM", "RTEL1"]
REPAIR_GENES = ["RNF168", "RNF8", "MDC1", "ATM", "H2AFX", "UBE2N", "BRCA1", "ATR", "CHEK1", "CHEK2", "TP53", "NBN", "MRE11A", "RAD50"]


def load_table(path: Path | None = None) -> pd.DataFrame:
    f = Path(path) if path else CACHE / "annotation.csv"
    f.parent.mkdir(parents=True, exist_ok=True)
    if not f.exists():
        print("downloading", META_URL)
        urllib.request.urlretrieve(META_URL, f)
    a = pd.read_csv(f, low_memory=False, na_values=["-"])
    for c in NUM_COLS:
        a[c] = pd.to_numeric(a[c], errors="coerce")
    return a


class CountingClient(IdrClient):
    """IdrClient that counts every HTTP request and refuses to exceed ``limit``."""

    def __init__(self, limit: int | None = None, **kw):
        super().__init__(**kw)
        self.limit, self.requests = limit, 0

    def _get(self, path: str) -> bytes:
        if self.limit is not None and self.requests >= self.limit:
            raise RuntimeError(f"IDR request cap {self.limit} reached")
        self.requests += 1
        return super()._get(path)


CLIENT: CountingClient | None = None      # set by --max-requests; one session shared by every gallery fetch


def build_index(out: Path) -> dict:
    """IDR address -> image id (well_index_byname.json); fetched from IDR only when the file is absent."""
    f = out / "well_index_byname.json"
    if f.exists():
        return json.loads(f.read_text())
    client = IdrClient()

    def one(p):
        for _ in range(3):
            try:
                wells = IdrClient().plate_wells(p["@id"])
                break
            except Exception:
                time.sleep(2)
        else:
            return {}
        return {f"{p['Name']}_{chr(65 + w['Row'])}{w['Column'] + 1}": w["WellSamples"][0]["Image"]["@id"]
                for w in wells if w.get("WellSamples")}

    with ThreadPoolExecutor(6) as ex:
        parts = list(ex.map(one, client.plates()))
    idx = {k: v for m in parts for k, v in m.items()}
    f.write_text(json.dumps(idx, separators=(",", ":")))
    return idx


GENE_COLUMNS = ["gene", "wells", "sirnas", "med_norm", "fpc", "cells", "ensembl", "rank", "med_z", "stouffer",
                "emp_z", "p", "q", "status", "flags", "well_list"]
WELL_COLUMNS = ["plate_well", "norm_fpc", "imaged", "z", "cells", "sirna"]
LIST_KEYS = ["gene", "wells", "sirnas", "med_z", "stouffer", "emp_z", "q", "status", "med_norm", "cells", "flags"]


def g3(x):
    return None if x is None or not np.isfinite(x) else float(f"{x:.3g}")


def gene_table(t: pd.DataFrame, s: pd.DataFrame) -> list:
    """genes.json rows, ordered by rank (single-well genes, which are not ranked, last)."""
    agg = s.groupby("gene").agg(med_norm=(NORM, "median"), fpc=("Foci Per Cell", "median"),
                                ens=("Gene Identifier", "first"))
    wells = {g: [[w, r3(v), bool(i == i), r3(z), int(c), str(sr)] for w, v, i, z, c, sr in
                 zip(d["Plate_Well"], d[NORM], d["image_id"], d["z"], d["cells"], d["sirna"])]
             for g, d in s.groupby("gene")}
    rows = []
    for g, r in t.assign(_r=t["rank"].fillna(1e9)).sort_values("_r", kind="mergesort").iterrows():
        e = agg.loc[g]
        rows.append([g, int(r["wells"]), int(r["sirnas"]), r3(e["med_norm"]), r3(e["fpc"]), r3(r["cells"]),
                     e["ens"] if isinstance(e["ens"], str) else "", None if np.isnan(r["rank"]) else int(r["rank"]),
                     r3(r["med_z"]), r3(r["stouffer"]), r3(r["emp_z"]), g3(r["p"]), g3(r["q"]),
                     r["status"], r["flags"], wells[g]])
    return rows


def brief(by_gene: dict, names) -> list:
    """Compact per-gene dicts (no well list) for the summary lists and panels."""
    return [dict(zip(LIST_KEYS, [by_gene[n][GENE_COLUMNS.index(k)] for k in LIST_KEYS])) for n in names if n in by_gene]


def nucleus_check(a: pd.DataFrame) -> dict:
    """Our nucleus count vs the authors' Cell Count on every cached image (offline)."""
    rows = a[a["image_id"].notna() & a["Cell Count"].notna() & (a["Cell Count"] > 0)]
    by_img = {int(i): c for i, c in zip(rows["image_id"], rows["Cell Count"])}
    ours, theirs = [], []
    for f in sorted((CACHE / "img").glob("*.npz")):
        iid = int(f.stem)
        if iid not in by_img:
            continue
        d = np.load(f)
        ours.append(count_foci(d["dna"].astype(np.float32), d["foci"].astype(np.float32)).n_nuclei)
        theirs.append(by_img[iid])
    ours, theirs = np.array(ours, float), np.array(theirs, float)
    ratio = ours[ours > 0] / theirs[ours > 0]
    return {"n_images": int(len(ours)), "median_ours": r3(np.median(ours)), "median_authors": r3(np.median(theirs)),
            "median_ratio_of_medians": r3(np.median(ours) / np.median(theirs)),
            "ratio_p10": r3(np.quantile(ratio, .1)), "ratio_median": r3(np.median(ratio)),
            "ratio_p90": r3(np.quantile(ratio, .9))}


def nucleus_pairing_check(a: pd.DataFrame, byname: dict) -> dict:
    """Our nucleus count vs the authors' Cell Count on every cached image, under both pairings (offline).

    This is the headline number behind the pairing switch (docs/EXPERIMENT_PROTOCOL.md 15.4 (a)); the test fixture
    tests/fixtures/foci_pairing_nuclei.json holds the same quantities.
    """
    from scipy.stats import spearmanr
    out = {"status": PAIRING_STATUS}
    for name in ("name", "colmajor"):
        idx = paired_index(byname, name)
        cells = {int(idx[k]): c for k, c in zip(a["Plate_Well"], a["Cell Count"]) if k in idx and c > 0}
        ours, theirs = [], []
        for f in sorted((CACHE / "img").glob("*.npz")):
            if int(f.stem) in cells:
                d = np.load(f)
                ours.append(count_foci(d["dna"].astype(np.float32), d["foci"].astype(np.float32)).n_nuclei)
                theirs.append(cells[int(f.stem)])
        out[name] = {"n": len(ours), "nuclei_vs_cell_count_spearman": r3(spearmanr(ours, theirs)[0])}
    return out


def write_pairing_fixture(a: pd.DataFrame, byname: dict, summary: dict, dest: Path) -> int:
    """foci/tests/fixtures/foci_pairing_nuclei.json: per cached image, our nucleus count and the authors' Cell Count of the
    row paired by name and by column-major Well Number (regression test of the pairing; no images needed).
    Images fetched for the default-pairing gallery after Experiment L's sample (summary.gallery) are left out."""
    col = paired_index(byname, "colmajor")
    inv_name, inv_col = {v: k for k, v in byname.items()}, {v: k for k, v in col.items()}
    skip = {g["image_id"] for g in summary.get("gallery", [])}
    t = a.set_index("Plate_Well")

    def cells(k):
        v = t.loc[k, "Cell Count"]
        return None if pd.isna(v) else float(v)

    rows = []
    for f in sorted((CACHE / "img").glob("*.npz")):
        i = int(f.stem)
        if i in skip or i not in inv_name:
            continue
        d = np.load(f)
        n = count_foci(d["dna"].astype(np.float32), d["foci"].astype(np.float32)).n_nuclei
        nm, cm = inv_name[i], inv_col[i]
        rows.append([i, nm, int(t.loc[nm, "Well Number"]), cells(nm), cm, int(t.loc[cm, "Well Number"]), cells(cm), int(n)])
    dest.write_text(json.dumps({
        "about": "idr0010 images cached by the Foci Lab build (Experiment L sample): our nucleus count "
                 "(telomere_lab.foci.count_foci, default parameters) and the authors' Cell Count of the annotation row paired "
                 "with the image by IDR name vs by column-major Well Number. Annotation numbers: "
                 "idr0010-screenA-annotation.csv (Doil et al. 2009, IDR, CC BY 4.0). Written by "
                 "scripts/build_foci_dataset.py --pairing-fixture.",
        "columns": ["image_id", "idr_well", "name_row_well_number", "name_row_cells", "colmajor_row",
                    "colmajor_row_well_number", "colmajor_row_cells", "nuclei"],
        "rows": rows}, separators=(",", ":")), encoding="utf-8", newline="\n")
    return len(rows)


def fetch_cached(iid: int):
    f = CACHE / "img" / f"{iid}.npz"
    if f.exists():
        d = np.load(f)
        return d["dna"].astype(np.float32), d["foci"].astype(np.float32)
    f.parent.mkdir(parents=True, exist_ok=True)
    for _ in range(3):
        try:
            dna, foc, _ = fetch_image_channels(CLIENT or IdrClient(), iid)
            np.savez_compressed(f, dna=dna.astype(np.uint8), foci=foc.astype(np.uint8))
            return dna, foc
        except Exception as e:
            if CLIENT is not None and CLIENT.limit is not None and CLIENT.requests >= CLIENT.limit:
                raise
            time.sleep(3)
    raise RuntimeError(f"could not fetch image {iid}")


def composite(dna, foc):
    def n(a):
        lo, hi = np.percentile(a, [1, 99.8])
        return np.clip((a - lo) / max(hi - lo, 1e-6), 0, 1)
    rgb = np.stack([n(foc) * 0.25, n(foc), n(dna) * 0.85], -1)
    return (rgb * 255).astype(np.uint8)


def build_gallery(ok: pd.DataFrame, out: Path, subdir: str = "", keys=None) -> list:
    """Gallery tiles (one well per entry of GALLERY, or only ``keys``) written to out/img[/subdir]."""
    from PIL import Image
    rel = "img/" + (subdir + "/" if subdir else "")
    (out / rel).mkdir(parents=True, exist_ok=True)
    items = []
    for key, desc, group in GALLERY:
        if keys and key not in keys:
            continue
        if key == "negative control":
            rows = ok[ok["Control Type"] == "negative control"]
        else:
            rows = ok[(ok["Gene Symbol"] == key) & ok["Control Type"].isna()]
        rows = rows[rows["image_id"].notna()]
        if rows.empty:
            continue
        med = rows["Foci Per Cell (Normalized)"].median()
        r = rows.iloc[(rows["Foci Per Cell (Normalized)"] - med).abs().argsort().iloc[0]]
        iid = int(r["image_id"])
        dna, foc = fetch_cached(iid)
        res = count_foci(dna, foc)
        slug = key.replace(" ", "_")
        Image.fromarray(composite(dna, foc)).save(out / rel / f"{slug}_raw.jpg", quality=86)
        Image.fromarray(overlay_rgb(dna, foc, res)).save(out / rel / f"{slug}_overlay.jpg", quality=86)
        items.append({
            "key": key, "gene": None if key == "negative control" else key, "desc": desc, "group": group,
            "well": r["Plate_Well"], "image_id": iid,
            "authors": {"cells": r3(r["Cell Count"]), "foci": r3(r["53BP1 foci"]),
                        "fpc": r3(r["Foci Per Cell"]), "norm": r3(r["Foci Per Cell (Normalized)"])},
            "ours": {"nuclei": res.n_nuclei, "foci": res.n_foci, "fpc": r3(res.foci_per_cell)},
            "raw": f"{rel}{slug}_raw.jpg", "overlay": f"{rel}{slug}_overlay.jpg",
        })
        print(f"  gallery {key:<18} well {r['Plate_Well']:<12} ours {res.foci_per_cell:.2f}  authors {r['Foci Per Cell']:.2f}")
    return items


def experiment_l(ok: pd.DataFrame, n_per_bin: int = 9) -> dict:
    """Our classical counter vs the authors' per-well foci/cell on a stratified sample."""
    from scipy.stats import pearsonr, spearmanr
    s = ok[ok["Control Type"].isna() & ok["image_id"].notna() & ok["Foci Per Cell"].notna()].copy()
    s["q"] = pd.qcut(s["Foci Per Cell"], 9, labels=False)
    sample = pd.concat([g.sample(min(n_per_bin, len(g)), random_state=1) for _, g in s.groupby("q")])
    hits = s[s["Gene Symbol"].isin(["RNF168", "MDC1", "RNF8", "PSMA3", "PSMB2", "PSMB6"])]
    sample = pd.concat([sample, hits]).drop_duplicates("Plate_Well")
    with ThreadPoolExecutor(6) as ex:
        imgs = list(ex.map(lambda i: fetch_cached(int(i)), sample["image_id"]))
    ours, nuc = [], []
    for dna, foc in imgs:
        res = count_foci(dna, foc)
        ours.append(res.foci_per_cell)
        nuc.append(res.n_nuclei)
    sample["ours"], sample["our_nuclei"] = ours, nuc
    m = sample["ours"].notna() & np.isfinite(sample["ours"])
    x, y = sample.loc[m, "ours"], sample.loc[m, "Foci Per Cell"]
    low = sample["Gene Symbol"].isin(["RNF168", "MDC1", "RNF8"])
    high = sample["Gene Symbol"].isin(["PSMA3", "PSMB2", "PSMB6"])
    out = {
        "n_wells": int(m.sum()),
        "spearman": r3(spearmanr(x, y)[0]), "pearson": r3(pearsonr(x, y)[0]),
        "cells_pearson": r3(pearsonr(sample.loc[m, "our_nuclei"], sample.loc[m, "Cell Count"])[0]),
        "median_ours_repair_kd": r3(sample.loc[low & m, "ours"].median()),
        "median_ours_proteasome_kd": r3(sample.loc[high & m, "ours"].median()),
        "median_authors_repair_kd": r3(sample.loc[low & m, "Foci Per Cell"].median()),
        "median_authors_proteasome_kd": r3(sample.loc[high & m, "Foci Per Cell"].median()),
        "params": FociParams().__dict__,
        "points": [[r3(a), r3(b), g if isinstance(g, str) else ""] for a, b, g in
                   zip(sample.loc[m, "ours"], sample.loc[m, "Foci Per Cell"], sample.loc[m, "Gene Symbol"])],
    }
    print(f"  Experiment L: n={out['n_wells']} spearman={out['spearman']} pearson={out['pearson']} "
          f"(cells r={out['cells_pearson']})")
    return out


# --------------------------------------------------------------------------- exports (foci/DATA_FORMATS.md)

SIRNA_COLUMNS = ["sirna", "plate_well", "z", "norm_fpc", "fpc", "cells", "qc", "imaged", "sense", "antisense"]
GENES_CSV_COLUMNS = [c for c in GENE_COLUMNS if c != "well_list"] + ["hgnc_symbol"]
WELLS_CSV_COLUMNS = ["plate_well", "gene", "ensembl", "sirna", "sense", "antisense", "cells", "fpc", "norm_fpc", "z",
                     "qc", "imaged", "gene_status"]
DATA_ATTRIBUTION = (
    "Screen data: Doil C, et al. RNF168 binds and amplifies ubiquitin conjugates on damaged chromosomes to allow "
    "accumulation of repair proteins. Cell 2009;136:435-446 (doi:10.1016/j.cell.2008.12.041), via the Image Data "
    "Resource, study idr0010 (https://idr.openmicroscopy.org), CC BY 4.0. Derived tables: Foci Lab "
    "(https://studylab.id/foci/), which re-scored the authors' per-well numbers; changes were made. Current gene "
    "symbols: HGNC (https://www.genenames.org, CC0)."
)


def _num(x, ndigits=3):
    """float/int/NaN/None -> JSON-safe number or None."""
    if x is None or isinstance(x, (str, bool)):
        return x
    x = float(x)
    return None if not np.isfinite(x) else round(x, ndigits)


def sirna_payload(wt: pd.DataFrame) -> dict:
    """sirna.json: one row per sample well with a gene symbol, grouped by gene (keys sorted)."""
    rows = {}
    for r in wt.itertuples(index=False):
        cells = None if not np.isfinite(r.cells) else int(round(r.cells))
        rows.setdefault(r.gene, []).append([r.sirna, r.plate_well, _num(r.z), _num(r.norm_fpc), _num(r.fpc), cells,
                                            r.qc, bool(r.imaged), r.sense, r.antisense])
    return {"version": 1, "columns": SIRNA_COLUMNS, "by_gene": {g: rows[g] for g in sorted(rows)}}


def _split(x) -> list:
    return [p.strip() for p in str(x).split("|") if p.strip()] if isinstance(x, str) else []


def download_hgnc(dest: Path) -> None:
    """One polite GET of the HGNC complete set (no login); writes a small provenance sidecar."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    print("downloading", HGNC_URL)
    with urllib.request.urlopen(urllib.request.Request(HGNC_URL, headers={"User-Agent": "FociLab-build/1.0"}),
                                timeout=120) as r:
        dest.write_bytes(r.read())
        last_mod = r.headers.get("Last-Modified", "")
    meta = {"retrieved_utc": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "release": f"hgnc_complete_set.txt, Last-Modified {last_mod}" if last_mod else "hgnc_complete_set.txt"}
    dest.with_suffix(".meta.json").write_text(json.dumps(meta))


def build_symbols(ensembl_ids, hgnc_path: Path) -> dict:
    """symbols.json from the HGNC complete set, restricted to ``ensembl_ids``.

    An Ensembl ID that two HGNC entries claim is left out (recorded in ``shared_ensembl``). ``lookup`` maps an
    upper-cased current symbol / previous symbol / alias to one Ensembl ID; a token that reaches more than one
    screen gene appears ONLY in ``ambiguous``.
    """
    h = pd.read_csv(hgnc_path, sep="\t", dtype=str, low_memory=False, keep_default_na=False, na_values=[""])
    h = h[h["ensembl_gene_id"].isin(set(ensembl_ids))]
    dup = sorted(set(h.loc[h["ensembl_gene_id"].duplicated(keep=False), "ensembl_gene_id"]))
    h = h[~h["ensembl_gene_id"].isin(dup)].sort_values("ensembl_gene_id")
    by, tokens = {}, {}
    for r in h.itertuples(index=False):
        e = r.ensembl_gene_id
        prev, alias = _split(r.prev_symbol), _split(r.alias_symbol)
        by[e] = {"symbol": r.symbol, "name": r.name if isinstance(r.name, str) else "", "aliases": alias,
                 "previous": prev}
        for tok in [r.symbol] + prev + alias:
            tokens.setdefault(tok.upper(), set()).add(e)
    meta_f = hgnc_path.with_suffix(".meta.json")
    meta = json.loads(meta_f.read_text()) if meta_f.exists() else {
        "retrieved_utc": dt.datetime.fromtimestamp(hgnc_path.stat().st_mtime, dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "release": "hgnc_complete_set.txt (release not stated by the source)"}
    return {"version": 1,
            "source": {"name": "HGNC complete set (HUGO Gene Nomenclature Committee)", "url": HGNC_URL,
                       "licence": f"CC0 ({HGNC_LICENCE_URL})", "retrieved_utc": meta["retrieved_utc"],
                       "release": meta["release"]},
            "shared_ensembl": dup,
            "by_ensembl": by,
            "lookup": {k: next(iter(v)) for k, v in sorted(tokens.items()) if len(v) == 1},
            "ambiguous": {k: sorted(v) for k, v in sorted(tokens.items()) if len(v) > 1}}


def symbol_stats(genes: list, sym: dict) -> dict:
    """Measured agreement between the screen's 2005-era symbols and current HGNC symbols."""
    by = sym["by_ensembl"]
    ens_ids = sorted({g[6] for g in genes if g[6]})
    found = [g for g in genes if g[6] in by]
    changed = [g for g in found if g[0] != by[g[6]]["symbol"]]
    explained = [g for g in changed if g[0].upper() in {x.upper() for x in by[g[6]]["previous"] + by[g[6]]["aliases"]}]
    pref = set(TELOMERE_GENES) | set(REPAIR_GENES)
    ex = sorted(explained, key=lambda g: (g[0] not in pref, g[0]))[:5]
    n_found = len({g[6] for g in found})
    return {
        "source": sym["source"]["name"], "release": sym["source"]["release"], "licence": "CC0",
        "screen_genes": len(genes), "screen_genes_with_ensembl": sum(1 for g in genes if g[6]),
        "ensembl_ids_in_screen": len(ens_ids), "ensembl_ids_found_in_hgnc": n_found,
        "ensembl_ids_missing_from_hgnc": len(ens_ids) - n_found,
        "ensembl_ids_shared_by_two_hgnc_entries": len(sym["shared_ensembl"]),
        "genes_symbol_differs": len(changed), "genes_symbol_differs_explained_by_previous_or_alias": len(explained),
        "examples": [{"screen_symbol": g[0], "current_symbol": by[g[6]]["symbol"]} for g in ex],
        "lookup_tokens": len(sym["lookup"]), "ambiguous_tokens": len(sym["ambiguous"]),
        "note": "'missing' = the Ensembl ID is not attached to an approved gene in the HGNC complete set (retired, "
                "withdrawn or never assigned); the cases are not distinguishable here.",
    }


def _cell(v) -> str:
    if v is None or (isinstance(v, (float, np.floating)) and not np.isfinite(v)):
        return ""
    if isinstance(v, (bool, np.bool_)):
        return "true" if v else "false"
    if isinstance(v, (int, np.integer)):
        return str(int(v))
    if isinstance(v, (float, np.floating)):
        return repr(float(v))
    return str(v)


def csv_bytes(columns: list, rows) -> bytes:
    """Plain RFC-4180 CSV: UTF-8, LF line ends, minimal quoting, header row only, '.' decimals, '' for null."""
    buf = io.StringIO(newline="")
    w = csv.writer(buf, lineterminator="\n", quoting=csv.QUOTE_MINIMAL)
    w.writerow(columns)
    for r in rows:
        w.writerow([_cell(v) for v in r])
    return buf.getvalue().encode("utf-8")


def genes_csv(genes: list, sym: dict | None) -> bytes:
    by = sym["by_ensembl"] if sym else {}
    fi = GENE_COLUMNS.index("flags")
    rows = []
    for g in genes:
        r = list(g[:-1])
        r[fi] = ";".join(g[fi])
        rows.append(r + [by.get(g[6], {}).get("symbol", "")])
    return csv_bytes(GENES_CSV_COLUMNS, rows)


def wells_csv(wt: pd.DataFrame, t: pd.DataFrame) -> bytes:
    status = t["status"].to_dict()
    rows = [[r.plate_well, r.gene, r.ensembl, r.sirna, r.sense, r.antisense,
             None if not np.isfinite(r.cells) else int(round(r.cells)), _num(r.fpc), _num(r.norm_fpc), _num(r.z),
             r.qc, bool(r.imaged), status.get(r.gene, "")] for r in wt.itertuples(index=False)]
    return csv_bytes(WELLS_CSV_COLUMNS, rows)


def readme_text(n_genes: int, n_wells: int, n_removed: int, sym_note: str) -> str:
    return f"""Foci Lab - data download (foci_genes.csv, foci_wells.csv)
==========================================================

What this is
------------
Per-gene and per-well results of a genome-wide siRNA screen for 53BP1 foci in U2OS cells: IDR study idr0010
(Doil et al., Cell 2009). The per-well foci counts, cell counts and quality-control calls are the authors' own
(idr0010-screenA-annotation.csv). The scores below (z, emp_z, p, q, rank, status, flags) are computed by Foci Lab
from those numbers; they are not in the paper. The code is scripts/build_foci_dataset.py and
src/telomere_lab/foci/stats.py in the Telomere Lab repository; the exact formats are in foci/DATA_FORMATS.md.
Build time, code commit and SHA-256 of every file: manifest.json.

Licence and attribution
-----------------------
Licence: CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/). Please keep this attribution:

{DATA_ATTRIBUTION}

File format
-----------
UTF-8, comma separated, one header row, no comment lines, RFC-4180 quoting, records end with LF, "." as the
decimal point, an empty field means "no value", booleans are true/false.

foci_genes.csv  ({n_genes} rows, one per gene symbol that has at least one quality-controlled sample well)
-----------------------------------------------------------------------------------------------------------
gene       Gene symbol used by the screen (2005-2008 era annotation; may be outdated, see hgnc_symbol).
wells      Quality-controlled sample wells for the gene.
sirnas     Distinct siRNAs among those wells.
med_norm   Median plate-normalised foci per cell (1 = negative-control level; below 1 = fewer foci).
fpc        Median raw foci per cell.
cells      Median cell count per well.
ensembl    Ensembl gene ID from the screen table (the first one when a symbol maps to several IDs).
rank       1 = most foci lost. Empty for single-well genes, which are never ranked.
med_z      Median per-well z.
stouffer   Sum of the per-well z divided by sqrt(wells); empty for single-well genes.
emp_z      stouffer standardised by the median and robust SD (1.4826 x MAD) of all genes' stouffer values.
p          Two-sided normal p-value of emp_z.
q          Benjamini-Hochberg q-value of p across all tested genes.
status     hit_down / hit_up: q < 0.05 AND at least 2 distinct siRNAs each with |z| > 2 in that direction.
           q_only: q < 0.05 without two supporting siRNAs. single_well: only one well. none: everything else.
flags      Semicolon-separated: low_cells (median < 60 cells/well), one_sirna (several wells, one siRNA),
           disagree (strongest siRNA has |z| > 2 while another has the opposite sign with |z| > 1).
hgnc_symbol  Current HGNC symbol for the Ensembl ID, empty when the ID is not in HGNC. {sym_note}

foci_wells.csv  ({n_wells} rows, one per sample well with a gene symbol; {n_removed} are QC-removed)
---------------------------------------------------------------------------------------------------
plate_well   Plate_Well key of the screen (plate-well), unique.
gene, ensembl  As above, for this well.
sirna        siRNA identifier (well:<plate_well> when the screen table has none).
sense, antisense  siRNA sequences as given in the screen table (may be empty).
cells        Cell count.
fpc          Raw foci per cell.
norm_fpc     Plate-normalised foci per cell (the authors' numbers).
z            Robust per-well score: (log2(norm_fpc) - median over negative controls) /
             (1.4826 x MAD over negative controls), controls = quality-controlled negative-control wells.
             z < 0: fewer foci than controls. Empty for QC-removed wells and where norm_fpc is missing or <= 0.
qc           pass, or remove (the authors flagged the well; kept here for transparency, never scored or ranked).
imaged       true if an IDR image exists for the well (Plate_Well index of the IDR plates).
gene_status  status of the gene (as above); empty when the gene has no quality-controlled well.

Honest caveats
--------------
* Acute 72 h siRNA knock-down in one cell line (U2OS). Not chronic loss, not a primary cell, not telomerase-negative
  ageing biology.
* 53BP1 foci mark DNA double-strand breaks in general. They are not a telomere-specific readout.
* Concordance between independent siRNAs against the same gene is weak (summary.json > stats > concordance): a
  single well or a single siRNA is not evidence about a gene. Use status = hit_down/hit_up, which requires two
  supporting siRNAs, and confirm elsewhere.
* Counts and normalisation are the authors'; we did not re-image or re-count. Foci Lab's own counter is only used
  as a consistency check on a sample of wells (Experiment L).
* The empirical null assumes most genes do nothing; q is a ranking aid, not a calibrated error rate.
"""


def git_commit() -> str:
    try:
        r = subprocess.run(["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, text=True, timeout=10)
        return r.stdout.strip() if r.returncode == 0 and r.stdout.strip() else "unknown"
    except Exception:
        return "unknown"


def write_downloads(out: Path, genes: list, wt: pd.DataFrame, t: pd.DataFrame, sym: dict | None,
                    built_utc: str, commit: str) -> dict:
    d = out / "downloads"
    d.mkdir(parents=True, exist_ok=True)
    gcsv, wcsv = genes_csv(genes, sym), wells_csv(wt, t)
    note = ("Symbols come from the HGNC complete set (CC0), see symbols.json." if sym else
            "HGNC data were not available for this build; the column is empty.")
    readme = readme_text(len(genes), len(wt), int((wt["qc"] == "remove").sum()), note).encode("utf-8")
    files = [("foci_genes.csv", gcsv, len(genes), "One row per gene: the genes.json columns (no well list) plus hgnc_symbol."),
             ("foci_wells.csv", wcsv, len(wt), "One row per sample well with a gene symbol, QC-removed wells included."),
             ("README_DATA.txt", readme, None, "Column dictionary, definitions, attribution, licence and caveats.")]
    entries = []
    for name, data, rows, desc in files:
        (d / name).write_bytes(data)
        entries.append({"name": name, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest(),
                        "rows": rows, "description": desc})
    manifest = {"built_utc": built_utc, "git_commit": commit, "code_version": f"foci-data-{DATA_FORMAT_VERSION}",
                "licence": "CC BY 4.0", "attribution": DATA_ATTRIBUTION, "source_metadata_url": META_URL,
                "files": entries}
    (d / "manifest.json").write_bytes((json.dumps(manifest, indent=1, ensure_ascii=False) + "\n").encode("utf-8"))
    return manifest


def load_symbols(out: Path, hgnc: Path, ensembl_ids, refresh: bool) -> dict | None:
    """symbols.json: rebuilt from the HGNC file when there is one (downloaded on first use / --refresh-hgnc);
    otherwise the committed symbols.json is kept, or None when neither exists."""
    f = out / "symbols.json"
    if refresh or (not hgnc.exists() and not f.exists()):
        try:
            download_hgnc(hgnc)
        except Exception as e:
            print("HGNC download failed:", e)
    if hgnc.exists():
        sym = build_symbols(ensembl_ids, hgnc)
        f.write_text(json.dumps(sym, separators=(",", ":"), allow_nan=False, ensure_ascii=False), encoding="utf-8",
                     newline="\n")
        return sym
    return json.loads(f.read_text(encoding="utf-8")) if f.exists() else None


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default=str(ROOT / "foci" / "web" / "data"))
    ap.add_argument("--no-images", action="store_true")
    ap.add_argument("--annotation", default=None, help="annotation CSV (default .cache/idr0010/annotation.csv)")
    ap.add_argument("--hgnc", default=str(HGNC_CACHE), help="HGNC complete set TSV (downloaded once if absent)")
    ap.add_argument("--refresh-hgnc", action="store_true", help="download the HGNC complete set again")
    ap.add_argument("--pairing", choices=["colmajor", "name"], default=DEFAULT_PAIRING,
                    help="which image goes with which annotation row: column-major Well Number (default; empirically "
                         "inferred, unconfirmed by IDR) or the IDR well of the same name (as originally built)")
    ap.add_argument("--only-gallery", action="store_true",
                    help="rebuild just the gallery tiles of the default pairing and merge them into summary.json")
    ap.add_argument("--gallery-keys", default=None, help="comma-separated GALLERY keys for --only-gallery (default all)")
    ap.add_argument("--pairing-fixture", default=None, metavar="OUT.json",
                    help="write the pairing regression fixture from the cached images (offline) and exit")
    ap.add_argument("--max-requests", type=int, default=None, help="hard cap on IDR requests made by gallery fetches")
    args = ap.parse_args(argv)
    global CLIENT
    if args.max_requests is not None:
        CLIENT = CountingClient(limit=args.max_requests, timeout=60.0)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    a = load_table(args.annotation)
    byname = build_index(out)                       # IDR image grid: address -> image id
    idx = paired_index(byname, args.pairing)        # annotation row -> image id
    (out / "well_index.json").write_text(dumps(idx), encoding="utf-8", newline="\n")
    a["image_id"] = a["Plate_Well"].map(idx)
    ok = a[a["Quality Control"].isna()].copy()
    print(f"{len(a)} wells, {len(ok)} pass QC, {len(idx)} imaged, pairing {args.pairing}")

    if args.pairing_fixture:
        n = write_pairing_fixture(a, byname, json.loads((out / "summary.json").read_text()), Path(args.pairing_fixture))
        print(f"{n} cached images -> {args.pairing_fixture}")
        return 0
    if args.only_gallery:
        keys = set(args.gallery_keys.split(",")) if args.gallery_keys else None
        f = out / "summary.json"
        summary = json.loads(f.read_text())
        items = {g["key"]: g for g in summary.get("gallery", [])}
        try:
            for g in build_gallery(ok, out, keys=keys):
                items[g["key"]] = g
        finally:                                   # keep what was fetched even if the request cap was hit
            summary["gallery"] = [items[k] for k, _, _ in GALLERY if k in items]
            f.write_text(json.dumps(summary, indent=1, default=float, allow_nan=False))
            if CLIENT is not None:
                print(f"IDR requests made: {CLIENT.requests}")
        return 0

    s, ctl = well_scores(ok)
    t, null = gene_stats(s)
    genes = gene_table(t, s)
    by_gene = {g[0]: g for g in genes}
    (out / "genes.json").write_text(json.dumps({
        "columns": GENE_COLUMNS, "well_list_columns": WELL_COLUMNS, "rows": genes},
        separators=(",", ":"), allow_nan=False))

    # --- per-siRNA rows, current symbols, downloads
    wt = sample_well_table(a, s)
    (out / "sirna.json").write_text(json.dumps(sirna_payload(wt), separators=(",", ":"), allow_nan=False,
                                               ensure_ascii=False), encoding="utf-8", newline="\n")
    sym = load_symbols(out, Path(args.hgnc), {g[6] for g in genes if g[6]}, args.refresh_hgnc)
    built_utc = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    commit = git_commit()
    write_downloads(out, genes, wt, t, sym, built_utc, commit)
    print(f"sirna.json {len(wt)} wells; downloads written; symbols: {'yes' if sym else 'no'}")

    samples = ok[ok["Control Type"].isna()]
    norm = samples[NORM].dropna()
    edges = np.round(np.linspace(0, 4, 41), 2)
    hist, _ = np.histogram(norm.clip(upper=4), bins=edges)
    ctrl = {}
    for name, rows in ok[ok["Control Type"].notna()].groupby("Control Type"):
        v = rows[NORM].dropna()
        ctrl[name] = {"wells": int(len(v)), "median": r3(v.median()), "p10": r3(v.quantile(.1)), "p90": r3(v.quantile(.9))}
    rankable = [g for g in genes if g[7] is not None]        # already ordered: most foci lost first
    from scipy.stats import spearmanr
    cc = s[["z", "cells"]].dropna()
    conc = sirna_concordance(s)
    truth = truth_check(a, t, s)
    n_two = int((t["sirnas"] >= 2).sum())
    stats = {
        "z_definition": "log2(plate-normalised foci/cell) minus the negative-control median, divided by 1.4826 x MAD of the negative controls",
        "negative_controls": {"wells": ctl["wells"], "log2_median": r3(ctl["log2_median"]), "robust_sd": r3(ctl["robust_sd"])},
        "empirical_null": {"median": r3(null["mu"]), "robust_sd": r3(null["sd"]), "genes_tested": null["n_tested"]},
        "genes_q05_empirical_null": null["n_q05_empirical"], "genes_q05_theoretical_null": null["n_q05_theoretical"],
        "supported_hits_down": null["hits_down"], "supported_hits_up": null["hits_up"],
        "q_only_not_supported": null["q_only"], "single_well_genes": null["single_well"],
        "genes_with_two_sirnas": n_two, "genes_rankable": len(rankable),
        "rules": {"sirna_abs_z": Z_SIRNA, "q": Q_HIT, "min_sirnas": 2, "low_cells": LOW_CELLS},
        "low_cell_wells_pct": r3(100 * float((s["cells"] < LOW_CELLS).mean())),
        "cells_vs_z_spearman": r3(spearmanr(cc["z"], cc["cells"])[0]),
        "concordance": conc, "truth_check": truth,
    }
    print("stats:", json.dumps({k: v for k, v in stats.items() if k not in ("z_definition", "rules")}, default=float))

    def pick(names):
        return brief(by_gene, names)

    summary = {
        "attribution": ATTRIBUTION,
        "license": "CC BY 4.0",
        "source": {"study": "idr0010-doil-dnadamage", "screen_id": 1351,
                   "idr": "https://idr.openmicroscopy.org/webclient/?show=screen-1351",
                   "paper_doi": "10.1016/j.cell.2008.12.041", "metadata": META_URL},
        "totals": {"wells": int(len(a)), "wells_qc_pass": int(len(ok)), "genes": len(genes),
                   "plates": int(a["Plate"].nunique()), "imaged_wells": len(idx),
                   "sample_wells": int(len(samples))},
        "sample_median_norm": r3(norm.median()),
        "histogram": {"edges": edges.tolist(), "counts": hist.tolist(), "clipped_at": 4},
        "controls": ctrl,
        "stats": stats,
        "lowest": brief(by_gene, [g[0] for g in rankable[:15]]),
        "highest": brief(by_gene, [g[0] for g in rankable[::-1][:15]]),
        "telomere_panel": pick(TELOMERE_GENES),
        "telomere_absent": {g: ("no quality-controlled well" if (a["Gene Symbol"] == g).any() else "not in the screen table")
                            for g in TELOMERE_GENES if g not in by_gene},
        "repair_panel": pick(REPAIR_GENES),
    }
    old = out / "summary.json"
    prev = json.loads(old.read_text()) if old.exists() else {}
    byname_ok = ok.assign(image_id=ok["Plate_Well"].map(byname))   # Experiment L and the old gallery: by-name pairing
    if not args.no_images:
        print("gallery:")
        summary["gallery"] = build_gallery(ok, out)
        if args.pairing != "name":
            print("gallery (by name):")
            summary["gallery_byname"] = build_gallery(byname_ok, out, subdir="byname")
        print("experiment L (by-name pairing, as originally run):")
        summary["experiment_l"] = experiment_l(byname_ok)
        summary["experiment_l"]["pairing"] = "name"
        summary["experiment_l"]["nucleus_check"] = nucleus_check(a.assign(image_id=a["Plate_Well"].map(byname)))
        summary["experiment_l"]["pairing_check"] = nucleus_pairing_check(a, byname)
        print("  nucleus check:", summary["experiment_l"]["nucleus_check"])
        print("  pairing check:", summary["experiment_l"]["pairing_check"])
    else:                                    # keep the image-derived parts from the last full build
        for k in ("gallery", "gallery_byname", "experiment_l"):
            if k in prev:
                summary[k] = prev[k]
    summary["pairing"] = {"default": args.pairing, "options": ["colmajor", "name"], "status": PAIRING_STATUS,
                          "rule": "annotation Well Number N -> image at IDR row (N-1) % 12, column (N-1) // 12 (12 x 32 plates)",
                          "protocol": "docs/EXPERIMENT_PROTOCOL.md#154-experiment-l2",
                          "diff_vs_name": diff_stats(byname, paired_index(byname, "colmajor"))}
    summary["build"] = {"built_utc": built_utc, "git_commit": commit, "manifest": "downloads/manifest.json"}
    if sym:
        summary["symbols"] = symbol_stats(genes, sym)
    old.write_text(json.dumps(summary, indent=1, default=float, allow_nan=False))
    print("wrote", out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
