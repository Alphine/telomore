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
from telomere_lab.foci.stats import (LOW_CELLS, NORM_COL as NORM, Q_HIT, Z_SIRNA, gene_stats, r3,  # noqa: E402
                                     sirna_concordance, truth_check, well_scores)

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

    s, ctl = well_scores(ok)
    t, null = gene_stats(s)
    genes = gene_table(t, s)
    by_gene = {g[0]: g for g in genes}
    (out / "genes.json").write_text(json.dumps({
        "columns": GENE_COLUMNS, "well_list_columns": WELL_COLUMNS, "rows": genes},
        separators=(",", ":"), allow_nan=False))

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
    if not args.no_images:
        print("gallery:")
        summary["gallery"] = build_gallery(ok, out)
        print("experiment L:")
        summary["experiment_l"] = experiment_l(ok)
        summary["experiment_l"]["nucleus_check"] = nucleus_check(a)
        print("  nucleus check:", summary["experiment_l"]["nucleus_check"])
    else:                                    # keep the image-derived parts from the last full build
        for k in ("gallery", "experiment_l"):
            if k in prev:
                summary[k] = prev[k]
    old.write_text(json.dumps(summary, indent=1, default=float, allow_nan=False))
    print("wrote", out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
