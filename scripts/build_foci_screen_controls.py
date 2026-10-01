"""Build foci/web/data/screen_controls.json: which wells of each idr0010 plate are controls (plate-mode page).

foci_wells.csv lists sample wells only, so the plate heatmap cannot tell a control from a missing well. This file carries
the authors' control wells, straight from idr0010-screenA-annotation.csv (.cache/idr0010/annotation.csv, see
scripts/build_foci_dataset.py). Per plate: {"<Well name>": [kind, cells, foci_per_cell, qc_removed]} with
kind "p" (positive control) or "n" (negative control). Numbers are the authors'; nothing is computed.

    python scripts/build_foci_screen_controls.py [annotation.csv] [out.json]
"""
from __future__ import annotations

import csv
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def build(src: Path) -> dict:
    plates: dict = {}
    with src.open(newline="", encoding="utf-8-sig") as f:
        for r in csv.DictReader(f):
            kind = {"positive control": "p", "negative control": "n"}.get((r.get("Control Type") or "").strip())
            if not kind:
                continue

            def num(x):
                try:
                    return round(float(x), 4)
                except (TypeError, ValueError):
                    return None

            cells = num(r.get("Cell Count"))
            plates.setdefault(str(r["Plate"]).strip(), {})[r["Well"].strip()] = [
                kind, int(cells) if cells is not None else None, num(r.get("Foci Per Cell")),
                1 if (r.get("Quality Control") or "").strip() == "remove" else 0,
            ]
    return {
        "version": 1,
        "source": "idr0010-screenA-annotation.csv (Doil et al., Cell 2009; Image Data Resource; CC BY 4.0)",
        "format": "plates[plate][well] = [kind p|n, cell_count, foci_per_cell, qc_removed 0|1]; numbers are the authors'",
        "plates": {p: dict(sorted(w.items())) for p, w in sorted(plates.items())},
    }


if __name__ == "__main__":
    src = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / ".cache" / "idr0010" / "annotation.csv"
    out = Path(sys.argv[2]) if len(sys.argv) > 2 else ROOT / "foci" / "web" / "data" / "screen_controls.json"
    d = build(src)
    out.write_text(json.dumps(d, separators=(",", ":"), sort_keys=False) + "\n", encoding="utf-8")
    print(f"{out}: {len(d['plates'])} plates, {sum(len(v) for v in d['plates'].values())} control wells")
