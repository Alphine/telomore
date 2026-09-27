"""CLI: build the Foci Lab static dataset from IDR study idr0010 (Doil et al. 2009).

Outputs (all under ``foci/web/data`` unless --out is given):

* ``genes.json``      -- one row per gene: wells, median foci/cell (plate-normalised
                          and raw), median cell count, and its wells; from the authors' own
                          per-well table (idr0010-screenA-annotation.csv).
* ``summary.json``    -- screen totals, control distributions, histogram of
                          normalised foci/cell, top/bottom hits, telomere panel,
                          gallery index, Experiment L validation.
* ``well_index.json`` -- Plate_Well -> IDR image id for every imaged well (used
                          by the PHP image proxy and the Railway overlay endpoint).
* ``img/*.jpg``       -- gallery: raw composite + our nucleus/foci overlay.

Experiment L re-runs our classical focus counter (telomere_lab.foci) on a fixed,
stratified sample of wells and compares with the authors' per-well counts.

    python scripts/build_foci_dataset.py                # full build (~5-10 min, network)
    python scripts/build_foci_dataset.py --no-images    # tables only
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from telomere_lab.foci import ATTRIBUTION, FociParams, IdrClient, count_foci, fetch_image_channels, overlay_rgb  # noqa: E402

META_URL = ("https://raw.githubusercontent.com/IDR/idr-metadata/master/"
            "idr0010-doil-dnadamage/screenA/idr0010-screenA-annotation.csv")
CACHE = ROOT / ".cache" / "idr0010"
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


def load_table() -> pd.DataFrame:
    CACHE.mkdir(parents=True, exist_ok=True)
    f = CACHE / "annotation.csv"
    if not f.exists():
        print("downloading", META_URL)
        urllib.request.urlretrieve(META_URL, f)
    a = pd.read_csv(f, low_memory=False, na_values=["-"])
    for c in NUM_COLS:
        a[c] = pd.to_numeric(a[c], errors="coerce")
    return a


def build_index(out: Path) -> dict:
    f = out / "well_index.json"
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


def r3(x):
    return None if x is None or not np.isfinite(x) else round(float(x), 3)


def gene_table(ok: pd.DataFrame) -> list:
    g = ok[ok["Control Type"].isna() & ok["Gene Symbol"].notna()].groupby("Gene Symbol")
    t = g.agg(n=("Foci Per Cell (Normalized)", "size"), norm=("Foci Per Cell (Normalized)", "median"),
              fpc=("Foci Per Cell", "median"), cells=("Cell Count", "median"),
              ens=("Gene Identifier", "first")).reset_index()
    wells = g.apply(lambda d: [[w, r3(v), bool(i == i)] for w, v, i in
                               zip(d["Plate_Well"], d["Foci Per Cell (Normalized)"], d["image_id"])],
                    include_groups=False)
    t["wells"] = t["Gene Symbol"].map(wells)
    t = t.sort_values("norm")
    t["rank"] = np.arange(1, len(t) + 1)
    return [[r["Gene Symbol"], int(r["n"]), r3(r["norm"]), r3(r["fpc"]), r3(r["cells"]),
             r["ens"] if isinstance(r["ens"], str) else "", int(r["rank"]), r["wells"]] for _, r in t.iterrows()]


def fetch_cached(iid: int):
    f = CACHE / "img" / f"{iid}.npz"
    if f.exists():
        d = np.load(f)
        return d["dna"].astype(np.float32), d["foci"].astype(np.float32)
    f.parent.mkdir(parents=True, exist_ok=True)
    for _ in range(3):
        try:
            dna, foc, _ = fetch_image_channels(IdrClient(), iid)
            np.savez_compressed(f, dna=dna.astype(np.uint8), foci=foc.astype(np.uint8))
            return dna, foc
        except Exception:
            time.sleep(3)
    raise RuntimeError(f"could not fetch image {iid}")


def composite(dna, foc):
    def n(a):
        lo, hi = np.percentile(a, [1, 99.8])
        return np.clip((a - lo) / max(hi - lo, 1e-6), 0, 1)
    rgb = np.stack([n(foc) * 0.25, n(foc), n(dna) * 0.85], -1)
    return (rgb * 255).astype(np.uint8)


def build_gallery(ok: pd.DataFrame, out: Path) -> list:
    from PIL import Image
    (out / "img").mkdir(parents=True, exist_ok=True)
    items = []
    for key, desc, group in GALLERY:
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
        Image.fromarray(composite(dna, foc)).save(out / "img" / f"{slug}_raw.jpg", quality=86)
        Image.fromarray(overlay_rgb(dna, foc, res)).save(out / "img" / f"{slug}_overlay.jpg", quality=86)
        items.append({
            "key": key, "gene": None if key == "negative control" else key, "desc": desc, "group": group,
            "well": r["Plate_Well"], "image_id": iid,
            "authors": {"cells": r3(r["Cell Count"]), "foci": r3(r["53BP1 foci"]),
                        "fpc": r3(r["Foci Per Cell"]), "norm": r3(r["Foci Per Cell (Normalized)"])},
            "ours": {"nuclei": res.n_nuclei, "foci": res.n_foci, "fpc": r3(res.foci_per_cell)},
            "raw": f"img/{slug}_raw.jpg", "overlay": f"img/{slug}_overlay.jpg",
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


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default=str(ROOT / "foci" / "web" / "data"))
    ap.add_argument("--no-images", action="store_true")
    args = ap.parse_args(argv)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    a = load_table()
    idx = build_index(out)
    a["image_id"] = a["Plate_Well"].map(idx)
    ok = a[a["Quality Control"].isna()].copy()
    print(f"{len(a)} wells, {len(ok)} pass QC, {len(idx)} imaged")

    genes = gene_table(ok)
    (out / "genes.json").write_text(json.dumps({
        "columns": ["gene", "wells", "norm_fpc", "fpc", "cells", "ensembl", "rank", "well_list"],
        "well_list_columns": ["plate_well", "norm_fpc", "imaged"], "rows": genes},
        separators=(",", ":")))

    samples = ok[ok["Control Type"].isna()]
    norm = samples["Foci Per Cell (Normalized)"].dropna()
    edges = np.round(np.linspace(0, 4, 41), 2)
    hist, _ = np.histogram(norm.clip(upper=4), bins=edges)
    ctrl = {}
    for name, rows in ok[ok["Control Type"].notna()].groupby("Control Type"):
        v = rows["Foci Per Cell (Normalized)"].dropna()
        ctrl[name] = {"wells": int(len(v)), "median": r3(v.median()), "p10": r3(v.quantile(.1)), "p90": r3(v.quantile(.9))}
    gmap = {g[0]: g[:7] for g in genes}
    well_n = [g[:7] for g in genes if g[1] >= 2]

    def pick(names):
        return [gmap[n] for n in names if n in gmap]

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
        "lowest": well_n[:15],
        "highest": well_n[::-1][:15],
        "telomere_panel": pick(TELOMERE_GENES),
        "repair_panel": pick(REPAIR_GENES),
        "columns": ["gene", "wells", "norm_fpc", "fpc", "cells", "ensembl", "rank"],
    }
    if not args.no_images:
        print("gallery:")
        summary["gallery"] = build_gallery(ok, out)
        print("experiment L:")
        summary["experiment_l"] = experiment_l(ok)
    (out / "summary.json").write_text(json.dumps(summary, indent=1, default=float))
    print("wrote", out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
