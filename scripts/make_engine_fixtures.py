"""Golden fixtures for the browser analysis engine (foci/web/engine/engine.js).

Runs the Python reference (src/telomere_lab/foci/segment.py + the input normalisation of
backend/foci_upload.py) on

  (a) synthetic image pairs with known nuclei / foci (several seeds, uneven illumination, saturation,
      8/12/16-bit, empty, constant, tiny, 1xN, non-square), and
  (b) real IDR idr0010 pairs from .cache/idr0010/img/*.npz (full fields and crops),

writes the inputs as PNGs and the Python results as foci/tests/fixtures/engine_golden/manifest.json:
object count, estimated nuclei, per-object foci, total foci, every peak (x, y, height, object),
thresholds, normalisation, and sha256 + summary statistics of intermediate arrays (so a mismatch can be
localised to a stage).  The Node tests (foci/tests/engine-*.test.mjs) assert exact equality against it;
tests/test_foci_engine_fixtures.py re-runs the Python reference on the stored PNGs and checks the manifest
is still what segment.py produces.

    python scripts/make_engine_fixtures.py                  # regenerate everything
    python scripts/make_engine_fixtures.py --check          # verify the committed manifest (no writes)
    python scripts/make_engine_fixtures.py --dump DIR ID    # raw float32/int32 intermediates of one case (debugging)

Synthetic images come from numpy.random.default_rng(seed); the PNGs on disk, not the generator, are the
authoritative inputs (a future numpy may draw a different stream, which only matters when regenerating).
The IDR images are from idr0010 (Doil et al., Cell 2009), CC BY 4.0, the same data the site shows.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
from PIL import Image
from scipy import ndimage as ndi

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT))

from telomere_lab.foci import segment as S  # noqa: E402
from telomere_lab.foci.segment import FociParams, count_foci  # noqa: E402

OUT = ROOT / "foci" / "tests" / "fixtures" / "engine_golden"
CACHE = ROOT / ".cache" / "idr0010" / "img"
FORMAT = 1


# ------------------------------------------------------------------ synthetic images

def _synth(seed: int, h: int = 240, w: int = 320, n: int = 10, illum: float = 0.3, noise: float = 3.0,
           foci_mean: float = 3.0, rmin: float = 9.0, rmax: float = 15.0, spacing: float = 1.6) -> Tuple[np.ndarray, np.ndarray]:
    """Float images (0..~255) with n nuclei and Poisson(foci_mean) foci each; returns (dna, foci)."""
    rng = np.random.default_rng(seed)
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    bg = 12 + illum * 60 * (xx / w) + illum * 40 * (yy / h)
    dna, foc = bg.copy(), 0.4 * bg
    placed: List[Tuple[float, float, float]] = []
    tries = 0
    while len(placed) < n and tries < 2000:
        tries += 1
        r = rng.uniform(rmin, rmax)
        if w <= 2 * r + 4 or h <= 2 * r + 4:
            r = max(3.0, min(w, h) / 2 - 3)
        cx, cy = rng.uniform(r + 2, w - r - 2), rng.uniform(r + 2, h - r - 2)
        if all(np.hypot(cx - a, cy - b) >= spacing * max(r, c) for a, b, c in placed):
            placed.append((cx, cy, r))
    for cx, cy, r in placed:
        d = np.hypot(xx - cx, (yy - cy) * 1.15)
        disk = 1.0 / (1.0 + np.exp(np.clip((d - r) / 1.5, -40, 40)))
        dna += rng.uniform(70, 170) * disk * (1 + 0.15 * np.sin(xx / 3.0 + cy))
        foc += rng.uniform(18, 35) * disk
        for _ in range(int(rng.poisson(foci_mean))):
            ang, rad = rng.uniform(0, 2 * np.pi), r * 0.7 * np.sqrt(rng.uniform())
            sx, sy = cx + rad * np.cos(ang), cy + rad * np.sin(ang)
            sg = rng.uniform(1.0, 1.6)
            foc += rng.uniform(50, 160) * np.exp(-((xx - sx) ** 2 + (yy - sy) ** 2) / (2 * sg * sg))
    dna += rng.normal(0, noise, dna.shape)
    foc += rng.normal(0, noise * 0.8, foc.shape)
    return dna, foc


def _u8(a: np.ndarray) -> np.ndarray:
    return np.clip(np.rint(a), 0, 255).astype(np.uint8)


def _u16(a: np.ndarray, scale: float, offset: float, seed: int, noise: float = 30.0) -> np.ndarray:
    rng = np.random.default_rng(seed + 991)
    return np.clip(np.rint(a * scale + offset + rng.normal(0, noise, a.shape)), 0, 65535).astype(np.uint16)


def synthetic_cases() -> List[Dict[str, Any]]:
    cs: List[Dict[str, Any]] = []

    def add(cid: str, dna: np.ndarray, foc: np.ndarray, depth: int, note: str, params: Optional[Dict[str, Any]] = None) -> None:
        cs.append({"id": cid, "kind": "synthetic", "note": note, "dna": dna, "foci": foc, "bit_depth": depth, "params": params or {}})

    for seed in (1, 2, 3):
        d, f = _synth(seed, n=8 + seed * 2)
        add(f"syn_seed{seed}_8bit", _u8(d), _u8(f), 8, f"seed {seed}, mild uneven illumination")
    d, f = _synth(4, illum=1.6, n=12)
    add("syn_uneven_illumination", _u8(d), _u8(f), 8, "strong illumination gradient")
    d, f = _synth(5, n=9)
    add("syn_saturated", _u8(d * 3.2), _u8(f * 2.5), 8, "DNA and foci channels heavily saturated")
    d, f = _synth(6, h=120, w=160, n=5, rmin=9, rmax=13)
    add("syn_16bit", _u16(d, 220, 1200, 6), _u16(f, 180, 900, 7), 16, "16-bit, percentile stretch")
    d16 = _u16(d, 220, 1200, 6)
    d16.flat[5] = 65535
    add("syn_16bit_hot_pixel", d16, _u16(f, 180, 900, 7), 16, "16-bit with a hot pixel (stretch must ignore it)")
    d, f = _synth(7, h=120, w=160, n=5, rmin=9, rmax=13)
    add("syn_12bit", np.clip(np.rint(d * 14), 0, 4095).astype(np.uint16), np.clip(np.rint(f * 14), 0, 4095).astype(np.uint16),
        12, "12-bit data in a 16-bit container")
    d, f = _synth(8, h=100, w=331, n=5)
    add("syn_nonsquare_100x331", _u8(d), _u8(f), 8, "non-square")
    d, f = _synth(9, h=331, w=100, n=5)
    add("syn_nonsquare_331x100", _u8(d), _u8(f), 8, "non-square, portrait")
    d, f = _synth(10, n=40, spacing=0.95, rmin=10, rmax=14)
    add("syn_dense_touching", _u8(d), _u8(f), 8, "many touching nuclei (objects != nuclei)")
    d, f = _synth(11, h=32, w=32, n=1, rmin=6, rmax=8)
    add("syn_32x32", _u8(d), _u8(f), 8, "minimum accepted size on the server")
    d, f = _synth(12, h=60, w=60, n=1, rmin=11, rmax=12)
    add("syn_60x60_one_nucleus", _u8(d), _u8(f), 8, "one nucleus", {"min_nucleus_px": 20})
    d, f = _synth(13, n=8)
    add("syn_custom_sigmas", _u8(d), _u8(f), 8, "non-default sigmas and min_nucleus_px", {"nucleus_sigma": 3.0, "foci_sigma": 1.5, "min_nucleus_px": 300})
    rng = np.random.default_rng(14)
    add("syn_empty_noise", rng.integers(0, 12, (120, 160), dtype=np.uint8), rng.integers(0, 12, (120, 160), dtype=np.uint8), 8, "noise only, no nuclei")
    add("syn_empty_zero", np.zeros((80, 90), np.uint8), np.zeros((80, 90), np.uint8), 8, "all zero")
    add("syn_constant_200", np.full((80, 90), 200, np.uint8), np.full((80, 90), 200, np.uint8), 8, "constant, saturated-ish")
    add("syn_constant_255", np.full((50, 50), 255, np.uint8), np.full((50, 50), 255, np.uint8), 8, "constant at the 8-bit maximum")
    add("syn_16bit_constant", np.full((64, 64), 4000, np.uint16), np.full((64, 64), 4000, np.uint16), 16, "flat 16-bit image (no signal range)")
    rng = np.random.default_rng(15)
    add("syn_tiny_5x7", rng.integers(0, 256, (5, 7), dtype=np.uint8), rng.integers(0, 256, (5, 7), dtype=np.uint8), 8, "5x7 random, smaller than every footprint")
    add("syn_tiny_1x40", rng.integers(0, 256, (1, 40), dtype=np.uint8), rng.integers(0, 256, (1, 40), dtype=np.uint8), 8, "1xN", {"min_nucleus_px": 20})
    add("syn_tiny_40x1", rng.integers(0, 256, (40, 1), dtype=np.uint8), rng.integers(0, 256, (40, 1), dtype=np.uint8), 8, "Nx1", {"min_nucleus_px": 20})
    add("syn_tiny_1x1", np.array([[77]], np.uint8), np.array([[200]], np.uint8), 8, "single pixel")
    blocks = np.zeros((60, 70), np.uint8)
    blocks[10:30, 10:30] = 180
    blocks[35:55, 40:60] = 120
    blocks[15:25, 15:25] = 0  # a hole that must be filled
    f2 = np.zeros((60, 70), np.uint8) + 5
    f2[20, 40] = 0
    f2[20, 22], f2[45, 50], f2[12, 12] = 90, 120, 100
    add("syn_blocks_with_hole", blocks, f2, 8, "hard-edged blocks, a hole, foci on/off the nuclei", {"min_nucleus_px": 50, "background_size": 11})
    return cs


# ------------------------------------------------------------------------ IDR images

def idr_cases() -> List[Dict[str, Any]]:
    if not CACHE.is_dir():
        raise SystemExit(f"{CACHE} not found: copy .cache/idr0010 (annotation + img/*.npz) into the worktree first")
    files = sorted(CACHE.glob("*.npz"))
    if len(files) < 12:
        raise SystemExit("need at least 12 cached IDR images")
    picks = [files[i * len(files) // 12] for i in range(12)]
    cs = []
    windows = [(0, 260, 0, 348), (0, 260, 348, 696), (260, 520, 0, 348), (260, 520, 348, 696)]
    for k, f in enumerate(picks):
        z = np.load(f)
        dna, foc = z["dna"], z["foci"]
        assert dna.dtype == np.uint8 and dna.shape == foc.shape
        full = k % 4 == 0          # 3 full fields, 9 crops
        if not full:
            y0, y1, x0, x1 = windows[k % 4]
            dna, foc = dna[y0:y1, x0:x1], foc[y0:y1, x0:x1]
        cs.append({"id": f"idr_{f.stem}" + ("" if full else "_crop"), "kind": "idr0010", "note": ("full field" if full else f"crop y{y0}:{y1} x{x0}:{x1}") + f", image {f.stem}",
                   "dna": np.ascontiguousarray(dna), "foci": np.ascontiguousarray(foc), "bit_depth": 8, "params": {}})
    return cs


# --------------------------------------------------------------- python reference run

def _sha(a: np.ndarray) -> str:
    return hashlib.sha256(np.ascontiguousarray(a).tobytes()).hexdigest()


def _stats(a: np.ndarray) -> Dict[str, float]:
    a64 = a.astype(np.float64)
    return {"sum": float(a64.sum()), "min": float(a64.min()), "max": float(a64.max())}


def _f32_repr(x: np.float32) -> float:
    """Shortest decimal that round-trips as float32 (JS compares with Math.fround)."""
    return float(np.format_float_positional(np.float32(x), unique=True, trim="-"))


def _image_from_array(a: np.ndarray) -> Image.Image:
    return Image.fromarray(a)  # uint8 -> 'L', uint16 -> 'I;16' (exactly what a decoded PNG/TIFF gives the server)


def load_signal(a: np.ndarray, label: str) -> Tuple[np.ndarray, Dict[str, Any]]:
    from backend import foci_upload as up
    return up.to_signal(_image_from_array(a), label)


def _norm_info(info: Dict[str, Any]) -> Dict[str, Any]:
    keep = {"bit_depth", "saturated_fraction", "normalisation", "raw_lo", "raw_hi", "clipped_high_fraction"}
    return {k: v for k, v in info.items() if k in keep}


def reference(dna_raw: np.ndarray, foc_raw: np.ndarray, overrides: Dict[str, Any], with_intermediates: bool = True) -> Dict[str, Any]:
    dna, dinfo = load_signal(dna_raw, "DNA")
    foc, finfo = load_signal(foc_raw, "Foci")
    p = FociParams(**overrides)
    out: Dict[str, Any] = {}
    try:
        res = count_foci(dna, foc, p)
    except Exception as e:  # recorded, never hidden
        return {"error": f"{type(e).__name__}: {e}"}
    nuclei = res.nuclei
    n_obj = int(nuclei.max())
    ys, xs = np.nonzero(res.foci)
    th = None
    if n_obj:
        sm = ndi.gaussian_filter(foc.astype(np.float32), p.foci_sigma)
        th = ndi.white_tophat(sm, size=p.tophat_size)
    order = res.foci[ys, xs]
    assert (np.diff(order) == 1).all() if order.size > 1 else True
    sizes = np.bincount(nuclei.ravel(), minlength=n_obj + 1)[1:]
    est = S.estimate_nuclei(nuclei).tolist() if n_obj else []
    out.update({
        "normalisation": {"dna": _norm_info(dinfo), "foci": _norm_info(finfo)},
        "n_objects": n_obj,
        "n_nuclei": int(res.n_nuclei),
        "n_foci": int(res.n_foci),
        "foci_per_object": [int(v) for v in res.foci_per_nucleus],
        "object_area": [int(v) for v in sizes],
        "nuclei_in_object": est,
        "peaks": [[int(x), int(y), _f32_repr(th[y, x]), int(nuclei[y, x])] for y, x in zip(ys, xs)],
    })
    if with_intermediates:
        smooth = ndi.gaussian_filter(dna.astype(np.float32), p.nucleus_sigma)
        flat = smooth - ndi.grey_opening(smooth, size=p.background_size)
        thr = S._log_otsu(flat)
        out["threshold"] = float(thr)
        out["hashes"] = {"norm_dna": _sha(dna), "norm_foci": _sha(foc), "smooth_dna": _sha(smooth), "flat": _sha(flat), "labels": _sha(nuclei.astype(np.int32))}
        out["stats"] = {"smooth_dna": _stats(smooth), "flat": _stats(flat)}
        if th is not None:
            out["hashes"]["smooth_foci"] = _sha(sm)
            out["hashes"]["th"] = _sha(th)
            out["stats"]["th"] = _stats(th)
    return out


# ------------------------------------------------------------------ files + manifest

def sweep_spec() -> List[Tuple[str, List[Dict[str, Any]]]]:
    variants = (
        [{"min_height": v} for v in (0.5, 6.0, 20.0, 40.0)]
        + [{"tophat_size": v} for v in (3, 5, 9, 15)]
        + [{"peak_window": v} for v in (3, 7, 11)]
        + [{"background_size": v} for v in (11, 75)]
        + [{"min_nucleus_px": v} for v in (20, 400)]
        + [{"min_height": 8.0, "tophat_size": 9, "peak_window": 7}]
    )
    return [("idr_full_0", variants), ("idr_crop_1", variants), ("syn_seed2_8bit", variants)]


def env_info() -> Dict[str, str]:
    import scipy
    return {"python": platform.python_version(), "numpy": np.__version__, "scipy": scipy.__version__, "pillow": Image.__version__,
            "platform": f"{platform.system()}-{platform.machine()}"}


def png_name(cid: str, which: str) -> str:
    return f"{cid}_{which}.png"


def read_case_images(entry: Dict[str, Any], base: Path = OUT) -> Tuple[np.ndarray, np.ndarray]:
    return tuple(np.array(Image.open(base / entry["files"][k])) for k in ("dna", "foci"))  # type: ignore[return-value]


def build(write: bool = True) -> Dict[str, Any]:
    cases = synthetic_cases() + idr_cases()
    # the sweeps reference cases by role; resolve the two IDR role names
    idr_ids = [c["id"] for c in cases if c["kind"] == "idr0010"]
    roles = {"idr_full_0": next(i for i in idr_ids if not i.endswith("_crop")), "idr_crop_1": next(i for i in idr_ids if i.endswith("_crop"))}
    if write:
        OUT.mkdir(parents=True, exist_ok=True)
        for old in OUT.glob("*.png"):
            old.unlink()
    entries = []
    for c in cases:
        h, w = c["dna"].shape
        entry = {
            "id": c["id"], "kind": c["kind"], "note": c["note"], "width": w, "height": h, "bit_depth": c["bit_depth"],
            "files": {"dna": png_name(c["id"], "dna"), "foci": png_name(c["id"], "foci")}, "params": c["params"],
        }
        if write:
            for k in ("dna", "foci"):
                Image.fromarray(c[k]).save(OUT / entry["files"][k], format="PNG", optimize=True)
                back = np.array(Image.open(OUT / entry["files"][k]))
                assert back.dtype == c[k].dtype and (back == c[k]).all(), "PNG round trip changed pixels"
        entry["python"] = reference(c["dna"], c["foci"], c["params"])
        entries.append(entry)
    by_id = {c["id"]: c for c in cases}
    sweeps = []
    for role, variants in sweep_spec():
        cid = roles.get(role, role)
        c = by_id[cid]
        for v in variants:
            merged = dict(c["params"]); merged.update(v)
            sweeps.append({"case": cid, "params": merged, "python": reference(c["dna"], c["foci"], merged, with_intermediates=False)})
    manifest = {"format": FORMAT, "generator": "scripts/make_engine_fixtures.py", "env": env_info(), "cases": entries, "sweeps": sweeps}
    if write:
        with open(OUT / "manifest.json", "w", encoding="utf-8", newline="\n") as fh:
            json.dump(manifest, fh, separators=(",", ":"))
            fh.write("\n")
    return manifest


def recompute_from_disk(manifest: Dict[str, Any], base: Path = OUT) -> Dict[str, Any]:
    """Re-run the Python reference on the stored PNGs; returns a manifest-shaped dict (for drift detection)."""
    entries = []
    byid = {}
    for e in manifest["cases"]:
        dna, foc = read_case_images(e, base)
        byid[e["id"]] = (dna, foc)
        entries.append({"id": e["id"], "python": reference(dna, foc, e["params"])})
    sweeps = []
    for s in manifest["sweeps"]:
        dna, foc = byid[s["case"]]
        sweeps.append({"case": s["case"], "params": s["params"], "python": reference(dna, foc, s["params"], with_intermediates=False)})
    return {"cases": entries, "sweeps": sweeps}


def dump(case_id: str, outdir: str) -> None:
    m = json.loads((OUT / "manifest.json").read_text(encoding="utf-8"))
    e = next(x for x in m["cases"] if x["id"] == case_id)
    dna_raw, foc_raw = read_case_images(e)
    dna, _ = load_signal(dna_raw, "DNA")
    foc, _ = load_signal(foc_raw, "Foci")
    p = FociParams(**e["params"])
    os.makedirs(outdir, exist_ok=True)
    smooth = ndi.gaussian_filter(dna.astype(np.float32), p.nucleus_sigma)
    flat = smooth - ndi.grey_opening(smooth, size=p.background_size)
    sm = ndi.gaussian_filter(foc.astype(np.float32), p.foci_sigma)
    arrays = {"norm_dna": dna, "norm_foci": foc, "smooth_dna": smooth, "flat": flat, "smooth_foci": sm,
              "th": ndi.white_tophat(sm, size=p.tophat_size), "labels": S.segment_nuclei(dna, p).astype(np.int32)}
    for k, a in arrays.items():
        np.ascontiguousarray(a).tofile(os.path.join(outdir, f"{case_id}.{k}.bin"))
    print("wrote", sorted(arrays), "to", outdir, "shape", dna.shape)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--check", action="store_true", help="verify the committed manifest against the current reference (no writes)")
    ap.add_argument("--dump", nargs=2, metavar=("DIR", "CASE_ID"), help="write raw intermediates of one case")
    a = ap.parse_args()
    if a.dump:
        dump(a.dump[1], a.dump[0])
        return
    if a.check:
        m = json.loads((OUT / "manifest.json").read_text(encoding="utf-8"))
        again = recompute_from_disk(m)
        bad = [e["id"] for e, r in zip(m["cases"], again["cases"]) if e["python"] != r["python"]]
        bad += [f"sweep:{s['case']}:{s['params']}" for s, r in zip(m["sweeps"], again["sweeps"]) if s["python"] != r["python"]]
        print("DRIFT in:" if bad else "manifest matches the current reference", *bad, sep="\n  " if bad else " ")
        sys.exit(1 if bad else 0)
    m = build(True)
    size = sum(f.stat().st_size for f in OUT.iterdir())
    print(f"wrote {len(m['cases'])} cases + {len(m['sweeps'])} sweeps to {OUT} ({size / 1e6:.2f} MB)")
    errs = [e["id"] for e in m["cases"] if "error" in e["python"]]
    if errs:
        print("python raised for:", errs)


if __name__ == "__main__":
    main()
