"""GET /api/foci/overlay -- live nucleus outline for one IDR idr0010 well (Foci Lab).

Public (the Foci Lab site on studylab.id is public and has no accounts), but
bounded: only wells listed in foci/web/data/well_index.json are accepted, so it
cannot be pointed at arbitrary IDR images, and results are memoised per well.
The foci count it returns is NOT validated against the authors' numbers
(docs/EXPERIMENT_PROTOCOL.md, Experiment L); the response says so.
"""

from __future__ import annotations

import asyncio
import base64
import io
import json
import logging
import re
import threading
from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache
from pathlib import Path
from typing import Dict

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import JSONResponse
import numpy as np
from PIL import Image

from .. import foci_upload as up
from ..ratelimit import rate_limit

from telomere_lab.foci import (
    ATTRIBUTION,
    FociParams,
    IdrClient,
    SegmentationResult,
    count_foci,
    fetch_image_channels,
    nucleus_table,
    overlay_rgb,
)

log = logging.getLogger(__name__)

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
        "pipeline_version": res.pipeline_version,
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


# --------------------------------------------------------------------------
# POST /api/foci/analyze -- a scientist's own two-channel image (in memory only)

LIMIT_NOTES = [
    "Exploratory: the counts are NOT validated against manual counts. Tune the parameters on your own positive and negative controls.",
    "53BP1 / gamma-H2AX foci mark DNA double-strand breaks in general; they are not telomere-specific.",
    "Touching nuclei are not split: each object counts as round(area / median object area) nuclei, so per-object foci counts can span several nuclei.",
    "Foci are local maxima of a white top-hat filtered marker channel inside the nucleus mask; overlapping foci, foci outside nuclei and out-of-focus signal are not handled specially.",
    "Thresholds are in 8-bit grey levels (0-255). 16-bit images are percentile-stretched to that scale first (0.1-99.99%).",
    "Your images are processed in memory and are not stored or logged.",
]

_executor = ThreadPoolExecutor(max_workers=4, thread_name_prefix="foci-analyze")


def _block(a: np.ndarray, k: int, how: str) -> np.ndarray:
    h, w = (a.shape[0] // k) * k, (a.shape[1] // k) * k
    v = a[:h, :w].reshape(h // k, k, w // k, k)
    return v.mean(axis=(1, 3)) if how == "mean" else v.max(axis=(1, 3))


def _overlay_image(dna: np.ndarray, foc: np.ndarray, res) -> tuple:
    """Overlay JPEG image, at most OVERLAY_MAX_SIDE px on the long side.

    Large images are block-reduced BEFORE drawing (mean for the intensity
    channels, max for the nucleus / focus masks so no focus disappears), which keeps
    the float RGB canvas small; images within the limit are drawn at full size.
    """
    k = -(-max(dna.shape) // up.OVERLAY_MAX_SIDE)  # ceil
    if k <= 1:
        return Image.fromarray(overlay_rgb(dna, foc, res)), 1.0
    small = SegmentationResult(
        (_block(res.nuclei > 0, k, "max")).astype(np.int32),
        (_block(res.foci > 0, k, "max")).astype(np.int32),
        res.n_nuclei, res.n_foci, res.foci_per_nucleus,
    )
    rgb = overlay_rgb(_block(dna, k, "mean"), _block(foc, k, "mean"), small)
    return Image.fromarray(rgb), 1.0 / k


def _run_analysis(files, params: Dict[str, float], c) -> Dict:
    """CPU-bound part; runs in a worker thread while holding the compute slot."""
    dna, foc, info, warnings = up.load_pair(files, c)
    p = FociParams(
        min_nucleus_px=int(params["min_nucleus_px"]),
        background_size=int(params["background_size"]),
        min_height=float(params["min_height"]),
        tophat_size=int(params["tophat_size"]),
        peak_window=int(params["peak_window"]),
    )
    res = count_foci(dna, foc, p)
    table = nucleus_table(res)
    im, scale = _overlay_image(dna, foc, res)
    buf = io.BytesIO()
    im.save(buf, format="JPEG", quality=85)  # fresh encode: no input metadata can survive
    if res.n_nuclei == 0:
        warnings.append("No nuclei were detected. Check that 'dna' is the nuclear stain and try a smaller minimum nucleus size.")
    truncated = len(table) > up.MAX_TABLE_ROWS
    return {
        "validated": False,
        "pipeline_version": res.pipeline_version,
        "nuclei": res.n_nuclei,
        "objects": len(table),
        "foci": res.n_foci,
        "foci_per_cell": None if res.n_nuclei == 0 else round(res.foci_per_cell, 3),
        "table": table[: up.MAX_TABLE_ROWS],
        "table_truncated": truncated,
        "image": {"width": info["width"], "height": info["height"], "dna": info["dna"], "foci": info["foci"]},
        "parameters": params,
        "jpeg": base64.b64encode(buf.getvalue()).decode("ascii"),
        "overlay_scale": round(scale, 4),
        "warnings": warnings,
        "limits": LIMIT_NOTES,
        "note": "Exploratory classical counter; not validated against manual counts.",
    }


@router.post("/analyze", dependencies=[Depends(rate_limit("foci_analyze", 20))])
async def analyze(request: Request) -> JSONResponse:
    c = up.cfg()
    headers = {"Cache-Control": "no-store"}

    # 1. bounded number of request bodies buffered at once (memory guard)
    ups = up.upload_semaphore()
    handed_off = False  # once a worker owns the buffers it releases this slot when it finishes
    if not ups.acquire(blocking=False):
        raise HTTPException(503, "Server is busy receiving other uploads. Try again shortly.", headers={"Retry-After": "10"})
    try:
        try:
            texts, files = await asyncio.wait_for(up.read_multipart(request, c["max_bytes"]), c["upload_timeout"])
        except asyncio.TimeoutError:
            raise HTTPException(408, "Upload timed out.") from None
        params = up.parse_params(texts)

        # 2. bounded wait for a compute slot, then 503 (no thread is parked while waiting)
        sem = up.compute_semaphore()
        loop = asyncio.get_running_loop()
        deadline = loop.time() + c["queue_wait"]
        while not sem.acquire(blocking=False):
            if loop.time() >= deadline:
                raise HTTPException(503, "The analyser is busy. Try again in a few seconds.", headers={"Retry-After": "10"})
            await asyncio.sleep(0.05)
        try:
            fut = _executor.submit(_run_analysis, files, params, c)
        except BaseException:
            sem.release()
            raise
        # the slot is released when the worker actually finishes (even after a timeout)
        handed_off = True
        fut.add_done_callback(lambda _f: (sem.release(), ups.release()))
        try:
            out = await asyncio.wait_for(asyncio.wrap_future(fut), c["timeout"])
        except asyncio.TimeoutError:
            raise HTTPException(504, "Analysis exceeded the time budget. Use a smaller image.") from None
        except up.AnalysisError as exc:
            raise HTTPException(exc.status, exc.message) from None
        except MemoryError:
            raise HTTPException(503, "The server ran out of memory. Use a smaller image.") from None
        except HTTPException:
            raise
        except Exception as exc:
            log.error("foci analyze failed: %s", exc.__class__.__name__)  # class only, never content
            raise HTTPException(500, "Analysis failed.") from None
        return JSONResponse(out, headers=headers)
    finally:
        files = None  # drop the buffers promptly
        if not handed_off:
            ups.release()
