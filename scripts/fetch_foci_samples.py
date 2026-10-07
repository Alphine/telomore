"""Fetch a small set of sample wells from the public IDR (idr0010, CC BY 4.0) into foci/web/samples/.

One DNA PNG and one 53BP1 PNG (8-bit greyscale, as rendered by the IDR) per Foci Lab gallery entry, plus
``manifest.json`` with the attribution and the IDR link of every image. The wells are the ones in
``summary.gallery`` (default column-major pairing), so no new choice is made here. The total is a few MB.

    python scripts/fetch_foci_samples.py [--out foci/web/samples] [--max-mb 200]
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))

from PIL import Image  # noqa: E402

from telomere_lab.foci.idr import BASE, IdrClient, fetch_image_channels  # noqa: E402

ATTRIBUTION = ("Image Data Resource, study idr0010 (https://idr.openmicroscopy.org/webclient/?show=screen-1351). "
               "Doil et al., Cell 2009, doi:10.1016/j.cell.2008.12.041. Licence CC BY 4.0 "
               "(https://creativecommons.org/licenses/by/4.0/). Images re-rendered by the IDR as 8-bit greyscale "
               "PNGs (linear window from the channel minimum to the curators' display maximum); no other change.")


def slug(s: str) -> str:
    return "".join(c if c.isalnum() else "_" for c in s.lower()).strip("_")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default=str(ROOT / "foci" / "web" / "samples"))
    ap.add_argument("--max-mb", type=float, default=200.0, help="stop before the folder would exceed this size")
    a = ap.parse_args()
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)

    summary = json.loads((ROOT / "foci" / "web" / "data" / "summary.json").read_text(encoding="utf-8"))
    client = IdrClient()
    items, total = [], 0
    for g in summary["gallery"]:
        key = slug(g["key"])
        iid = int(g["image_id"])
        dna, foci, meta = fetch_image_channels(client, iid)
        files = {}
        for name, arr in (("dna", dna), ("foci", foci)):
            f = out / f"{key}_{name}.png"
            Image.fromarray(arr.clip(0, 255).astype("uint8"), "L").save(f, optimize=True)
            files[name] = f.name
            total += f.stat().st_size
        if total > a.max_mb * 1024 * 1024:
            print("size limit reached, stopping", file=sys.stderr)
            return 1
        items.append({"key": key, "label": g["key"], "description": g["desc"], "group": g["group"],
                      "well": g["well"], "image_id": iid, "size_x": meta["size"]["width"],
                      "size_y": meta["size"]["height"], "files": files,
                      "idr_url": f"{BASE}/webclient/?show=image-{iid}"})
        print(f"{g['key']:<18} well {g['well']:<10} image {iid}  ok ({total/1e6:.1f} MB so far)")
        time.sleep(0.5)  # be gentle with the public server

    (out / "manifest.json").write_text(json.dumps({
        "version": 1, "built_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "licence": "CC BY 4.0", "attribution": ATTRIBUTION, "pairing": "column-major (inferred, unconfirmed)",
        "items": items}, indent=1), encoding="utf-8")
    (out / "README.md").write_text(
        "# Foci Lab sample images\n\n"
        f"{ATTRIBUTION}\n\n"
        "Rebuild: `python scripts/fetch_foci_samples.py` (or the GitHub Action `Refresh Foci Lab samples`).\n"
        "Use: download a DNA + 53BP1 pair and drop both into Browser lab (`lab.html`).\n", encoding="utf-8")
    print(f"done: {len(items)} wells, {total/1e6:.1f} MB -> {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
