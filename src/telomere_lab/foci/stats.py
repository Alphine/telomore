"""Per-gene statistics for the idr0010 screen table (Foci Lab).

Everything here works on the authors' own per-well numbers (plate-normalised foci per
cell); nothing depends on our image counter. Pure functions on small tables so they can be
unit-tested on synthetic data.

Conventions: ``z < 0`` means fewer foci than the negative controls, ``z > 0`` more.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

LOW_CELLS = 60      # wells / genes with fewer cells are flagged (about the 5th percentile of wells)
Z_SIRNA = 2.0       # an siRNA "supports" a hit when its own |z| exceeds this
Q_HIT = 0.05
NORM_COL = "Foci Per Cell (Normalized)"


def r3(x):
    return None if x is None or not np.isfinite(x) else round(float(x), 3)


def well_scores(ok: pd.DataFrame):
    """Robust per-well score ``z`` for QC-passed sample wells.

    z = (log2(plate-normalised foci/cell) - median over negative controls) /
        (1.4826 * MAD over negative controls), controls = QC-passed negative-control wells.

    Returns (sample wells with columns gene, sirna, cells, z; control summary dict).
    """
    neg = ok[ok["Control Type"] == "negative control"][NORM_COL].dropna()
    neg = np.log2(neg[neg > 0])
    med = float(neg.median())
    sd = float(1.4826 * (neg - med).abs().median())
    s = ok[ok["Control Type"].isna() & ok["Gene Symbol"].notna()].copy()
    s = s[s[NORM_COL].notna() & (s[NORM_COL] > 0)]
    s["z"] = (np.log2(s[NORM_COL]) - med) / sd
    s["gene"] = s["Gene Symbol"]
    s["cells"] = s["Cell Count"]
    sir = s["siRNA Identifier"].astype("string")
    s["sirna"] = sir.where(sir.notna(), "well:" + s["Plate_Well"].astype(str))
    return s, {"wells": int(len(neg)), "log2_median": med, "robust_sd": sd}


def bh_qvalues(p) -> np.ndarray:
    """Benjamini-Hochberg adjusted p-values."""
    p = np.asarray(p, float)
    n = len(p)
    order = np.argsort(p, kind="mergesort")
    q = p[order] * n / np.arange(1, n + 1)
    q = np.minimum.accumulate(q[::-1])[::-1]
    out = np.empty(n)
    out[order] = np.minimum(q, 1.0)
    return out


def empirical_null(z):
    """Median and robust SD (1.4826 * MAD) of the bulk of combined z-scores."""
    z = np.asarray(z, float)
    mu = float(np.median(z))
    return mu, float(1.4826 * np.median(np.abs(z - mu)))


def gene_stats(s: pd.DataFrame, low_cells: float = LOW_CELLS, z_sirna: float = Z_SIRNA, q_hit: float = Q_HIT):
    """Per-gene statistics from a well table with columns gene, sirna, z, cells.

    * wells, distinct siRNAs, median z;
    * Stouffer combined z = sum(z)/sqrt(n) for genes with >= 2 wells (single-well genes get no
      combined z and are never hits);
    * emp_z, p, q: combined z standardised by the median/robust SD of all combined z, two-sided
      normal p, Benjamini-Hochberg q (the theoretical N(0,1) null is far too liberal because
      replicate wells share plate and siRNA effects);
    * status: ``hit_down`` / ``hit_up`` (>= 2 distinct siRNAs each with |z| > z_sirna in that
      direction AND q < q_hit), ``q_only`` (q < q_hit without two supporting siRNAs),
      ``single_well``, ``none``;
    * flags: low_cells, one_sirna, disagree (the strongest siRNA has |z| > z_sirna while another
      has the opposite sign with |z| > 1).

    Returns (DataFrame indexed by gene, dict with the null fit and hit counts).
    """
    from scipy.stats import norm

    rows = []
    for gene, d in s.groupby("gene", sort=True):
        per = d.groupby("sirna")["z"].median().sort_index()
        zs = d["z"].to_numpy(float)
        n = len(zs)
        rows.append({
            "gene": gene, "wells": n, "sirnas": len(per), "med_z": float(np.median(zs)),
            "stouffer": float(zs.sum() / np.sqrt(n)) if n >= 2 else np.nan,
            "sirna_z": per.to_numpy(float), "n_sirna_down": int((per < -z_sirna).sum()),
            "n_sirna_up": int((per > z_sirna).sum()), "cells": float(d["cells"].median()),
        })
    t = pd.DataFrame(rows).set_index("gene")
    for c in ("emp_z", "p", "q"):
        t[c] = np.nan
    test = t["stouffer"].notna()
    mu, sd = empirical_null(t.loc[test, "stouffer"].to_numpy())
    t.loc[test, "emp_z"] = (t.loc[test, "stouffer"] - mu) / sd
    t.loc[test, "p"] = 2 * norm.sf(np.abs(t.loc[test, "emp_z"].to_numpy()))
    t.loc[test, "q"] = bh_qvalues(t.loc[test, "p"].to_numpy())
    q_theory = bh_qvalues(2 * norm.sf(np.abs(t.loc[test, "stouffer"].to_numpy())))

    def status(r):
        if r["wells"] < 2:
            return "single_well"
        if r["q"] < q_hit and r["emp_z"] < 0 and r["n_sirna_down"] >= 2:
            return "hit_down"
        if r["q"] < q_hit and r["emp_z"] > 0 and r["n_sirna_up"] >= 2:
            return "hit_up"
        return "q_only" if r["q"] < q_hit else "none"

    def flags(r):
        f = []
        if r["cells"] < low_cells:
            f.append("low_cells")
        if r["wells"] >= 2 and r["sirnas"] < 2:
            f.append("one_sirna")
        sz = r["sirna_z"]
        if len(sz) >= 2:
            strongest = sz[np.argmax(np.abs(sz))]
            if abs(strongest) > z_sirna and ((sz * np.sign(strongest)) < -1.0).any():
                f.append("disagree")
        return f

    t["status"] = t.apply(status, axis=1)
    t["flags"] = t.apply(flags, axis=1)
    ranked = t[test].sort_values("emp_z", kind="mergesort")      # most foci lost first
    t["rank"] = np.nan
    t.loc[ranked.index, "rank"] = np.arange(1, len(ranked) + 1)
    info = {"mu": mu, "sd": sd, "n_tested": int(test.sum()),
            "n_q05_empirical": int((t["q"] < q_hit).sum()), "n_q05_theoretical": int((q_theory < q_hit).sum()),
            "hits_down": int((t["status"] == "hit_down").sum()), "hits_up": int((t["status"] == "hit_up").sum()),
            "q_only": int((t["status"] == "q_only").sum()), "single_well": int((t["status"] == "single_well").sum())}
    return t, info


def auc(pos, neg) -> float:
    """P(score_pos > score_neg) = Mann-Whitney U / (n1 n2); ties count one half."""
    from scipy.stats import rankdata
    pos, neg = np.asarray(pos, float), np.asarray(neg, float)
    r = rankdata(np.concatenate([pos, neg]))
    return float((r[:len(pos)].sum() - len(pos) * (len(pos) + 1) / 2) / (len(pos) * len(neg)))


def sirna_concordance(s: pd.DataFrame, seed: int = 0) -> dict:
    """Do two independent siRNAs against one gene give the same score?

    For genes with >= 2 distinct siRNAs: Spearman between the median z of the first two
    (ordered by siRNA id); the same after shuffling the second across genes; the same within the
    bulk (both |z| < 2); and, when the first has |z| >= 3, how often the second agrees in sign
    with |z| > 2 (against the shuffled control).
    """
    from scipy.stats import spearmanr

    a, b = [], []
    for _, d in s.groupby("gene", sort=True):
        per = d.groupby("sirna")["z"].median().sort_index()
        if len(per) >= 2:
            a.append(per.iloc[0])
            b.append(per.iloc[1])
    a, b = np.array(a), np.array(b)
    bs = np.random.default_rng(seed).permutation(b)

    def tail(x, y):
        m = np.abs(x) >= 3
        return float(np.mean((np.sign(x[m]) == np.sign(y[m])) & (np.abs(y[m]) > Z_SIRNA))) if m.any() else None

    bulk = (np.abs(a) < 2) & (np.abs(b) < 2)
    return {"n_pairs": int(len(a)), "spearman": r3(spearmanr(a, b)[0]),
            "spearman_shuffled": r3(spearmanr(a, bs)[0]), "spearman_bulk": r3(spearmanr(a[bulk], b[bulk])[0]),
            "tail_n": int((np.abs(a) >= 3).sum()), "tail_agree": r3(tail(a, b)),
            "tail_agree_shuffled": r3(tail(a, bs))}


def truth_check(a: pd.DataFrame, t: pd.DataFrame, s: pd.DataFrame) -> dict:
    """The authors' phenotype annotations against our ranking.

    ``a`` is the full annotation table, ``t`` the gene table from :func:`gene_stats`, ``s`` the
    scored sample wells. This is a consistency check, not independent validation: the annotations
    come from the same screen.
    """
    out = {}
    rankable = t[t["emp_z"].notna()]
    for key, col, sign, label in [("increased", "Phenotype 1", 1, "increased DNA damage"),
                                  ("defective", "Phenotype 2", -1, "defective DNA damage response")]:
        ann = a[a[col].notna()]
        genes = set(ann["Gene Symbol"].dropna())
        in_r = {g for g in genes if g in rankable.index}
        qc_wells = set(ann[ann["Quality Control"].isna()]["Plate_Well"])
        sc = sign * rankable["emp_z"]
        d = {"label": label, "wells": int(len(ann)), "wells_qc_pass": len(qc_wells), "genes": len(genes),
             "genes_rankable": len(in_r)}
        if in_r and len(in_r) < len(sc):
            d["gene_auc"] = r3(auc(sc[sc.index.isin(in_r)], sc[~sc.index.isin(in_r)]))
            order = list(sc.sort_values(ascending=False, kind="mergesort").index)
            d["top50"] = sum(g in in_r for g in order[:50])
            d["top100"] = sum(g in in_r for g in order[:100])
        m = s["Plate_Well"].isin(qc_wells)
        if m.any() and (~m).any():
            d["well_auc"] = r3(auc(sign * s.loc[m, "z"], sign * s.loc[~m, "z"]))
            d["well_n"] = int(m.sum())
        out[key] = d
    return out
