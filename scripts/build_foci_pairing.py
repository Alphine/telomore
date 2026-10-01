"""Image <-> annotation-row pairing for idr0010 (Foci Lab), and the two well-index files built from it.

Background (docs/EXPERIMENT_PROTOCOL.md section 15.4, "Independent checks" and "Consequence for Foci Lab"):
the plates are 12 rows (A-L) x 32 columns. The authors' table numbers its rows row-major (``Well Number`` =
r*32+c+1, true for all 57,216 rows). The image at IDR well (r, c) agrees with the annotation row whose
``Well Number`` N is **column-major**, N = c*12 + r + 1 -- not with the row of the same name. This is an
empirical inference (nucleus count vs the authors' Cell Count, lethal controls, plate 7-14); IDR and the authors
have not confirmed it.

Two files result, both ``Plate_Well -> IDR image id`` and both read by the same consumers:

* ``well_index_byname.json`` -- the IDR image grid as published: key = IDR well address (what the image really is),
  and, read as an annotation key, the original "same-named row" pairing. SCREEN plate mode uses it as the image
  grid. Built from the IDR API by ``build_foci_dataset.py`` (network); never rewritten here.
* ``well_index.json`` -- annotation row -> image under the column-major pairing (the default). Derived from the
  file above by a pure permutation inside each plate, no network, deterministic. Key = the annotation's
  ``Plate_Well`` (the key used in genes.json / sirna.json / foci_wells.csv and by the Railway overlay endpoint).

    python scripts/build_foci_pairing.py                      # write well_index.json, print the diff
    python scripts/build_foci_pairing.py --annotation .cache/idr0010/annotation.csv   # also verify Well Number
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "foci" / "web" / "data"

N_ROWS, N_COLS = 12, 32
PAIRINGS = ("colmajor", "name")
DEFAULT_PAIRING = "colmajor"
PAIRING_STATUS = ("empirically inferred, unconfirmed by IDR or the authors "
                  "(docs/EXPERIMENT_PROTOCOL.md section 15.4)")


def split_key(key: str):
    """'7-14_C12' -> ('7-14', 2, 11) with 0-based row and column."""
    plate, well = key.rsplit("_", 1)
    return plate, ord(well[0]) - 65, int(well[1:]) - 1


def make_key(plate: str, r: int, c: int) -> str:
    return f"{plate}_{chr(65 + r)}{c + 1}"


def well_number(r: int, c: int, n_cols: int = N_COLS) -> int:
    """The authors' row-major ``Well Number`` of the annotation row named (r, c)."""
    return r * n_cols + c + 1


def colmajor_address(n: int, n_rows: int = N_ROWS):
    """(row, column), 0-based, of the image paired with the annotation row of ``Well Number`` n."""
    return (n - 1) % n_rows, (n - 1) // n_rows


def annotation_for_image(r: int, c: int, n_rows: int = N_ROWS, n_cols: int = N_COLS):
    """Inverse of :func:`colmajor_address`: (row, col) of the annotation row paired with the image at (r, c)."""
    n = c * n_rows + r
    return n // n_cols, n % n_cols


def paired_index(byname: dict, pairing: str = DEFAULT_PAIRING) -> dict:
    """Annotation ``Plate_Well`` -> image id under ``pairing`` from the IDR-address index ``byname``.

    ``name``: the identity (as originally built). ``colmajor``: the annotation row with Well Number N gets the image
    at IDR well r = (N-1) % 12, c = (N-1) // 12 of the same plate. Key order follows ``byname``; an annotation row
    whose paired image is absent from IDR is left out.
    """
    if pairing == "name":
        return dict(byname)
    if pairing != "colmajor":
        raise ValueError(f"unknown pairing {pairing!r}")
    out = {}
    for key in byname:
        plate, r, c = split_key(key)
        r2, c2 = colmajor_address(well_number(r, c))
        img = byname.get(make_key(plate, r2, c2))
        if img is not None:
            out[key] = img
    return out


def diff_stats(byname: dict, paired: dict) -> dict:
    changed = sum(1 for k, v in paired.items() if byname.get(k) != v)
    plates = {split_key(k)[0] for k in byname}
    return {"annotation_keys": len(paired), "imaged_by_name": len(byname), "changed_image": changed,
            "same_image": len(paired) - changed, "plates": len(plates),
            "fixed_wells_per_full_plate": sum(
                1 for r in range(N_ROWS) for c in range(N_COLS) if colmajor_address(well_number(r, c)) == (r, c))}


def verify_annotation(csv_path: Path) -> dict:
    """Every annotation row must carry Well Number = r*32+c+1 for its own name (the premise of the permutation)."""
    n = bad = 0
    with Path(csv_path).open(newline="", encoding="utf-8-sig") as f:
        for row in csv.DictReader(f):
            n += 1
            _, r, c = split_key(row["Plate_Well"])
            if int(row["Well Number"]) != well_number(r, c):
                bad += 1
    return {"rows": n, "well_number_mismatch": bad}


def dumps(idx: dict) -> str:
    return json.dumps(idx, separators=(",", ":"))


def write_indexes(out: Path = DATA) -> dict:
    """Write well_index.json (column-major) from well_index_byname.json; return the diff stats."""
    byname = json.loads((out / "well_index_byname.json").read_text())
    paired = paired_index(byname, "colmajor")
    (out / "well_index.json").write_text(dumps(paired), encoding="utf-8", newline="\n")
    return diff_stats(byname, paired)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default=str(DATA))
    ap.add_argument("--annotation", default=None, help="annotation CSV: verify Well Number = r*32+c+1 for every row")
    args = ap.parse_args(argv)
    if args.annotation:
        v = verify_annotation(Path(args.annotation))
        print("annotation:", v)
        if v["well_number_mismatch"]:
            print("Well Number is not row-major for some rows: the permutation premise fails", file=sys.stderr)
            return 1
    print(json.dumps(write_indexes(Path(args.out))))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
