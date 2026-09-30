"""GET /api/foci/overlay -- live nucleus outline for one IDR idr0010 well (Foci Lab).

Public (the Foci Lab site on studylab.id is public and has no accounts), but
bounded: only wells listed in foci/web/data/well_index.json are accepted, so it
cannot be pointed at arbitrary IDR images, and results are memoised per well.
The foci count it returns is NOT validated against the authors' numbers
(docs/EXPERIMENT_PROTOCOL.md, Experiment L); the response says so.
"""

from __future__ import annotations

import base64
import io
import json
import re
import threading
from functools import lru_cache
from pathlib import Path
from typing import Dict

from fastapi import APIRouter, Depends, HTTPException, Query
from PIL import Image

from ..ratelimit import rate_limit

from telomere_lab.foci import ATTRIBUTION, IdrClient, count_foci, fetch_image_channels, overlay_rgb

router = APIRouter(prefix="/foci", tags=["foci"])

INDEX_PATH = Path(__file__).resolve().parents[2] / "foci" / "web" / "data" / "well_index.json"
WELL_RE = re.compile(r"^[0-9A-Za-z-]{1,12}_[A-P][0-9]{1,2}$")
_lock = threading.Semaphore(2)  # at most two IDR fetches at once


@lru_cache(maxsize=1)
def well_index() -> Dict[str, int]:
    try:
        return json.loads(INDEX_PATH.read_text())
    except FileNotFoundError:
        return {}


@lru_cache(maxsize=256)
def _analyse(image_id: int) -> Dict:
    with _lock:
        dna, foc, _ = fetch_image_channels(IdrClient(timeout=30), image_id)
    res = count_foci(dna, foc)
    buf = io.BytesIO()
    Image.fromarray(overlay_rgb(dna, foc, res)).save(buf, format="JPEG", quality=85)
    return {
        "image_id": image_id,
        "nuclei": res.n_nuclei,
        "foci": res.n_foci,
        "foci_per_cell": None if res.n_nuclei == 0 else round(res.foci_per_cell, 3),
        "jpeg": base64.b64encode(buf.getvalue()).decode("ascii"),
        "validated": False,
        "note": "Classical counter; its foci count does not reproduce the authors' per-well values (Experiment L).",
        "attribution": ATTRIBUTION,
    }


@router.get("/overlay", dependencies=[Depends(rate_limit("foci_overlay", 60))])
def overlay(well: str = Query(..., max_length=16)) -> Dict:
    if not WELL_RE.match(well):
        raise HTTPException(status_code=400, detail="bad well id")
    iid = well_index().get(well)
    if iid is None:
        raise HTTPException(status_code=404, detail="well not imaged in IDR")
    try:
        return {"well": well, **_analyse(int(iid))}
    except HTTPException:
        raise
    except Exception as exc:  # network / IDR hiccup: do not cache, report cleanly
        raise HTTPException(status_code=502, detail=f"IDR unavailable: {exc.__class__.__name__}") from exc
