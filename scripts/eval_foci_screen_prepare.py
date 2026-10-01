"""Prepare the plate-mode engine evaluation on plate 7-14 WITHOUT touching IDR.

The plate's raw data is the BioImage Archive copy of idr0010 (S-BIAD885, OME-Zarr, CC BY 4.0) that Experiment L2 already
downloaded. `render` writes, for every well, the two 8-bit greyscale renderings that Foci Lab's proxy (api/well.php)
would serve from IDR -- a linear window `start:end` (integers, the per-image display window stored in the zarr metadata,
= IDR's) mapped to 0..255 -- as RGB PNGs with R = G = B, exactly like the proxy's PNGs. Experiment L2 verified this
emulation against real IDR PNGs on 8 images of this plate (mean absolute difference < 0.002 grey levels).
`count` runs the Python reference pipeline (telomere_lab.foci.count_foci, default parameters) on those PNGs and writes a
results file that scripts/eval_foci_screen_engine.mjs can evaluate (the same file format the Node engine run produces).

    python scripts/eval_foci_screen_prepare.py render --zarr 7-14.ome.zarr.zip --out <dir>          (dir OUTSIDE the repo)
    python scripts/eval_foci_screen_prepare.py count  --images <dir>/7-14 --out <dir>/results_python.json
"""
from __future__ import annotations

import argparse
import dataclasses
import json
import sys
import time
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from telomere_lab.foci import raw16 as R  # noqa: E402
from telomere_lab.foci.segment import FociParams, count_foci  # noqa: E402


def _git_rev() -> str:
    import subprocess
    try:
        return "telomere_lab.foci @ git " + subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=ROOT, capture_output=True, text=True).stdout.strip()
    except OSError:
        return "telomere_lab.foci (git revision unknown)"


def render(zarr_path: str, out: Path) -> None:
    """Resumable: wells whose two PNGs exist are skipped, and the zip is reopened every 40 wells (zarr's zip store
    holds on to memory on a small laptop)."""
    out.mkdir(parents=True, exist_ok=True)
    meta = {"source": "BioImage Archive S-BIAD885 (idr0010 as OME-Zarr), CC BY 4.0", "zarr": Path(zarr_path).name, "wells": {}}
    t0 = time.time()
    with R.OmeZarrPlate(zarr_path) as plate:
        names = sorted(plate.wells)
        meta["grid"] = {"rows": plate.n_rows, "cols": plate.n_cols}
        for w in names:
            meta["wells"][w] = {"row": plate.grid[w][0], "col": plate.grid[w][1]}
    todo = [w for w in names if not ((out / f"{w}.dna.png").exists() and (out / f"{w}.foci.png").exists())]
    for k in range(0, len(todo), 40):
        with R.OmeZarrPlate(zarr_path) as plate:
            for name in todo[k:k + 40]:
                dna, foci, win = plate.read_well(name)
                for ch, arr in (("dna", dna), ("foci", foci)):
                    lo, hi = int(win[ch][0]), int(win[ch][1])
                    q = R.render_8bit(arr, lo, hi).astype(np.uint8)
                    Image.fromarray(q, "L").convert("RGB").save(out / f"{name}.{ch}.png", optimize=False)
                meta["wells"][name].update({"window_dna": [int(win["dna"][0]), int(win["dna"][1])], "window_foci": [int(win["foci"][0]), int(win["foci"][1])]})
        print(f"{min(k + 40, len(todo))}/{len(todo)} wells, {time.time() - t0:.0f}s", flush=True)
    (out / "_render_meta.json").write_text(json.dumps(meta, indent=1))
    print(f"{len(names)} wells, {2 * len(names)} PNGs in {out}")


def count(images: Path, out: Path) -> None:
    """Resumable: results are checkpointed next to the output every 25 wells; a transient MemoryError (small, busy
    laptop) is retried after a pause."""
    names = sorted({p.name.split(".")[0] for p in images.glob("*.dna.png")})
    p = FociParams()
    ck = out.with_suffix(".partial.json")
    res = json.loads(ck.read_text()) if ck.exists() else {}
    t0 = time.time()
    for i, w in enumerate(names):
        if w in res:
            continue
        for attempt in range(8):
            try:
                dna = np.asarray(Image.open(images / f"{w}.dna.png").convert("L"), dtype=np.float32)
                foci = np.asarray(Image.open(images / f"{w}.foci.png").convert("L"), dtype=np.float32)
                r = count_foci(dna, foci, p)
                break
            except MemoryError:
                time.sleep(3)
        else:
            raise SystemExit("out of memory, rerun to resume")
        res[w] = {"nuclei": int(r.n_nuclei), "foci": int(r.n_foci), "objects": int(r.nuclei.max())}
        if len(res) % 25 == 0:
            ck.write_text(json.dumps(res))
            print(f"{len(res)}/{len(names)} {time.time() - t0:.0f}s", flush=True)
    out.write_text(json.dumps({
        "engine": "python telomere_lab.foci.count_foci", "version": _git_rev(), "backend": "python-cpu",
        "params": dataclasses.asdict(p), "images": "8-bit renders of 7-14 emulated from the S-BIAD885 zarr window (see eval_foci_screen_prepare.py)",
        "wells": res}, indent=1))
    if ck.exists():
        ck.unlink()
    print(f"wrote {out} ({len(res)} wells, {time.time() - t0:.0f}s)")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("render")
    a.add_argument("--zarr", required=True)
    a.add_argument("--out", required=True)
    b = sub.add_parser("count")
    b.add_argument("--images", required=True)
    b.add_argument("--out", required=True)
    args = ap.parse_args()
    if args.cmd == "render":
        render(args.zarr, Path(args.out) / "7-14")
    else:
        count(Path(args.images), Path(args.out))
