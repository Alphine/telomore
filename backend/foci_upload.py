"""Upload analyser for Foci Lab: safe parsing + decoding of a scientist's own images.

Everything happens in memory. Nothing is written to disk, logged or cached:
the multipart body is parsed with a streaming parser into bytearrays (never
Starlette's spooled temp files, which spill to disk above 1 MB), decoded with
Pillow restricted to PNG/JPEG/TIFF, analysed, and dropped.

All limits are environment variables read at request time (docs/API.md,
"Foci Lab upload analyser"). ``TELOMERE_DISABLE_LIMITS=1`` lifts them for a
local single-user install, like every other limit in ``backend/limits.py``.
"""

from __future__ import annotations

import io
import math
import re
import threading
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
from fastapi import HTTPException, Request
from PIL import Image

from . import limits

try:  # python-multipart >= 0.0.13 renamed its import package
    from python_multipart.multipart import MultipartParser
except ImportError:  # pragma: no cover - older releases
    from multipart.multipart import MultipartParser  # type: ignore

# ------------------------------------------------------------------ limits

MB = 1024 * 1024
ENV_MAX_BYTES = ("TELOMERE_FOCI_MAX_UPLOAD_BYTES", 25 * MB)   # whole request body
ENV_MAX_PIXELS = ("TELOMERE_FOCI_MAX_PIXELS", 12_000_000)      # per image
ENV_MAX_SIDE = ("TELOMERE_FOCI_MAX_SIDE", 8192)                # per image edge
ENV_CONCURRENCY = ("TELOMERE_FOCI_CONCURRENCY", 1)             # analyses at once
ENV_QUEUE_WAIT = ("TELOMERE_FOCI_QUEUE_WAIT_SECONDS", 10)      # wait for a slot, then 503
ENV_TIMEOUT = ("TELOMERE_FOCI_TIMEOUT_SECONDS", 120)           # analysis budget, then 504
ENV_UPLOAD_TIMEOUT = ("TELOMERE_FOCI_UPLOAD_TIMEOUT_SECONDS", 60)
ENV_MAX_UPLOADS = ("TELOMERE_FOCI_MAX_UPLOADS", 4)             # request bodies buffered at once
MIN_SIDE = 32
MAX_TABLE_ROWS = 20000
OVERLAY_MAX_SIDE = 2048

ALLOWED_FILES = ("dna", "foci")


def _num(spec: Tuple[str, float]) -> Optional[float]:
    return limits.get_limit(spec[0], spec[1])


def cfg() -> Dict[str, Any]:
    conc = _num(ENV_CONCURRENCY)
    return {
        "max_bytes": _num(ENV_MAX_BYTES),
        "max_pixels": _num(ENV_MAX_PIXELS),
        "max_side": _num(ENV_MAX_SIDE),
        "concurrency": max(1, int(conc)) if conc else 1,
        "queue_wait": _num(ENV_QUEUE_WAIT) or 0.0,
        "timeout": _num(ENV_TIMEOUT),
        "upload_timeout": _num(ENV_UPLOAD_TIMEOUT),
        "max_uploads": max(1, int(_num(ENV_MAX_UPLOADS) or 4)),
    }


# --------------------------------------------------- concurrency primitives

_sem_lock = threading.Lock()
_compute: Dict[str, Any] = {"n": None, "sem": None}
_upload: Dict[str, Any] = {"n": None, "sem": None}


def _sem(store: Dict[str, Any], n: int) -> threading.BoundedSemaphore:
    with _sem_lock:
        if store["n"] != n:
            store["n"], store["sem"] = n, threading.BoundedSemaphore(n)
        return store["sem"]


def compute_semaphore() -> threading.BoundedSemaphore:
    return _sem(_compute, cfg()["concurrency"])


def upload_semaphore() -> threading.BoundedSemaphore:
    return _sem(_upload, cfg()["max_uploads"])


# --------------------------------------------------------------- parameters

# name -> (kind, low, high, default, must_be_odd)
PARAM_SPECS: Dict[str, Tuple[str, float, float, float, bool]] = {
    "min_nucleus_px": ("int", 20, 100000, 150, False),
    "background_size": ("int", 11, 301, 41, True),
    "min_height": ("float", 0.5, 255, 12.0, False),
    "tophat_size": ("int", 3, 51, 7, True),
    "peak_window": ("int", 3, 31, 5, True),
}


def parse_params(fields: Dict[str, str]) -> Dict[str, float]:
    """Validate the five tunable parameters; blank/missing -> default; out of range -> 422."""
    out: Dict[str, float] = {}
    for name, (kind, lo, hi, default, odd) in PARAM_SPECS.items():
        raw = (fields.get(name) or "").strip()
        if raw == "":
            out[name] = default
            continue
        try:
            v = float(raw)
        except ValueError:
            raise HTTPException(422, f"{name} must be a number") from None
        if not math.isfinite(v):
            raise HTTPException(422, f"{name} must be a finite number")
        if kind == "int":
            if v != int(v):
                raise HTTPException(422, f"{name} must be a whole number")
            v = int(v)
            if odd and v % 2 == 0:
                raise HTTPException(422, f"{name} must be an odd number")
        if not (lo <= v <= hi):
            raise HTTPException(422, f"{name} must be between {lo:g} and {hi:g}")
        out[name] = v
    return out


# ---------------------------------------------------------------- multipart

_BOUNDARY_RE = re.compile(r'boundary=(?:"([^"]{1,70})"|([^\s;",]{1,70}))', re.I)
_NAME_RE = re.compile(r'(?:^|;)\s*name=(?:"([^"]*)"|([^\s;]*))', re.I)
MAX_TEXT_FIELD = 256
MAX_PARTS = 12


async def read_multipart(request: Request, max_bytes: Optional[float]) -> Tuple[Dict[str, str], Dict[str, bytearray]]:
    """Stream the request body into (text fields, file fields), enforcing the size cap."""
    ctype = request.headers.get("content-type", "")
    if not ctype.lower().startswith("multipart/form-data"):
        raise HTTPException(415, "Send multipart/form-data with fields 'dna' and 'foci'.")
    m = _BOUNDARY_RE.search(ctype)
    if not m:
        raise HTTPException(400, "multipart boundary missing")
    boundary = (m.group(1) or m.group(2)).encode("latin-1", "ignore")

    cl = request.headers.get("content-length")
    if cl is not None and max_bytes:
        try:
            if int(cl) > max_bytes + 4096:
                raise HTTPException(413, f"Upload larger than the server limit of {int(max_bytes)} bytes.")
        except ValueError:
            raise HTTPException(400, "bad Content-Length") from None

    texts: Dict[str, str] = {}
    files: Dict[str, bytearray] = {}
    st: Dict[str, Any] = {"hdr": b"", "val": b"", "headers": {}, "name": None, "buf": None, "n": 0, "parts": 0}

    def on_part_begin():
        st["parts"] += 1
        if st["parts"] > MAX_PARTS:
            raise HTTPException(422, "too many form fields")
        st.update(headers={}, name=None, buf=None, hdr=b"", val=b"")

    def on_hf(data, s, e):
        st["hdr"] += data[s:e]

    def on_hv(data, s, e):
        st["val"] += data[s:e]

    def on_he():
        st["headers"][st["hdr"].decode("latin-1").lower()] = st["val"].decode("latin-1")
        st["hdr"], st["val"] = b"", b""

    def on_headers_finished():
        disp = st["headers"].get("content-disposition", "")
        nm = _NAME_RE.search(disp)
        name = (nm.group(1) if nm and nm.group(1) is not None else (nm.group(2) if nm else None))
        if not name:
            raise HTTPException(422, "form field without a name")
        if name in texts or name in files:
            raise HTTPException(422, f"duplicate field '{name[:32]}'")
        if name in ALLOWED_FILES:
            st["buf"] = bytearray()
            files[name] = st["buf"]
        elif name in PARAM_SPECS:
            st["buf"] = bytearray()
        else:
            raise HTTPException(422, "unknown form field")
        st["name"] = name

    def on_part_data(data, s, e):
        buf = st["buf"]
        if buf is None:
            return
        buf += data[s:e]
        if st["name"] not in ALLOWED_FILES and len(buf) > MAX_TEXT_FIELD:
            raise HTTPException(422, f"{st['name']} value too long")

    def on_part_end():
        if st["name"] in PARAM_SPECS:
            texts[st["name"]] = bytes(st["buf"]).decode("utf-8", "replace")
        st["buf"] = None

    parser = MultipartParser(
        boundary,
        {
            "on_part_begin": on_part_begin,
            "on_header_field": on_hf,
            "on_header_value": on_hv,
            "on_header_end": on_he,
            "on_headers_finished": on_headers_finished,
            "on_part_data": on_part_data,
            "on_part_end": on_part_end,
        },
    )
    total = 0
    try:
        async for chunk in request.stream():
            total += len(chunk)
            if max_bytes and total > max_bytes + 4096:
                raise HTTPException(413, f"Upload larger than the server limit of {int(max_bytes)} bytes.")
            parser.write(chunk)
            # file parts count against the cap individually too (headers/boundaries excluded)
            if max_bytes and sum(len(b) for b in files.values()) > max_bytes:
                raise HTTPException(413, f"Upload larger than the server limit of {int(max_bytes)} bytes.")
        parser.finalize()
    except HTTPException:
        raise
    except Exception:  # malformed multipart
        raise HTTPException(400, "malformed multipart body") from None
    return texts, files


# ------------------------------------------------------------------ decoding

_FORMATS = {"png": "PNG", "jpeg": "JPEG", "tiff": "TIFF"}


def sniff(data: bytes) -> Optional[str]:
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "png"
    if data[:3] == b"\xff\xd8\xff":
        return "jpeg"
    if data[:4] in (b"II*\x00", b"MM\x00*", b"II+\x00", b"MM\x00+"):
        return "tiff"
    return None


class AnalysisError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status, self.message = status, message


def _open(data: bytes, label: str, c: Dict[str, Any]) -> Tuple[Image.Image, str]:
    kind = sniff(bytes(data[:16]))
    if kind is None:
        raise AnalysisError(415, f"{label}: not a PNG, TIFF or JPEG file (checked the file signature).")
    if c["max_pixels"]:
        Image.MAX_IMAGE_PIXELS = int(c["max_pixels"])  # Pillow's own bomb guard as a second line
    try:
        im = Image.open(io.BytesIO(data), formats=[_FORMATS[kind]])
        w, h = im.size
    except Image.DecompressionBombError:
        raise AnalysisError(413, f"{label}: image has too many pixels.") from None
    except MemoryError:
        raise
    except Exception:
        raise AnalysisError(422, f"{label}: could not read the image (corrupt or unsupported).") from None
    if w < MIN_SIDE or h < MIN_SIDE:
        raise AnalysisError(422, f"{label}: image is {w}x{h}; at least {MIN_SIDE}x{MIN_SIDE} pixels are needed.")
    if c["max_pixels"] and w * h > c["max_pixels"]:
        raise AnalysisError(
            413, f"{label}: {w}x{h} = {w * h / 1e6:.1f} Mpx exceeds the server limit of {c['max_pixels'] / 1e6:g} Mpx."
        )
    if c["max_side"] and max(w, h) > c["max_side"]:
        raise AnalysisError(413, f"{label}: {w}x{h} exceeds the maximum edge length of {int(c['max_side'])} px.")
    return im, kind


def _frames(im: Image.Image) -> int:
    """1, 2 or 3 (=3 or more), without walking a possibly huge IFD chain."""
    n = 1
    try:
        for i in (1, 2):
            im.seek(i)
            n = i + 1
    except EOFError:
        pass
    except Exception:
        raise AnalysisError(422, "could not read the image frames (corrupt file).") from None
    finally:
        try:
            im.seek(0)
        except Exception:
            pass
    return n


def to_signal(im: Image.Image, label: str) -> Tuple[np.ndarray, Dict[str, Any]]:
    """Current frame -> float32 array on the 0..255 scale the tuned defaults assume.

    8-bit input is used as is. 16-bit / 32-bit / float input is stretched
    linearly from its 0.1th to its 99.99th percentile onto 0..255 (a robust
    stretch: single hot pixels cannot compress the range). What was done, and
    how many pixels ended up clipped, is reported back and never silent.
    """
    info: Dict[str, Any] = {}
    try:
        mode = im.mode
        if mode in ("I;16", "I;16L", "I;16B", "I;16N", "I"):
            a = np.asarray(im.convert("I"), dtype=np.float32)
            info["bit_depth"] = 16 if mode.startswith("I;16") else 32
        elif mode == "F":
            a = np.array(im, dtype=np.float32)
            info["bit_depth"] = 32
        elif mode in ("RGB", "RGBA", "CMYK", "YCbCr", "LAB", "HSV", "RGBX", "RGBa"):
            rgb = np.asarray(im.convert("RGB"))
            a = rgb.max(axis=2).astype(np.float32)
            info["bit_depth"] = 8
            info["colour_reduced"] = True
        else:  # L, P, 1, LA, La ...
            a = np.asarray(im.convert("L"), dtype=np.float32)
            info["bit_depth"] = 8
    except MemoryError:
        raise
    except Exception:
        raise AnalysisError(422, f"{label}: could not decode the pixel data (corrupt file).") from None

    if not np.isfinite(a).all():
        info["non_finite_pixels"] = int((~np.isfinite(a)).sum())
        a = np.nan_to_num(a, nan=0.0, posinf=0.0, neginf=0.0)

    if info["bit_depth"] == 8:
        info["saturated_fraction"] = float((a >= 255).mean())
        info["normalisation"] = "none (8-bit values used as is)"
        return a, info

    lo, hi = np.percentile(a, [0.1, 99.99])
    info["raw_lo"], info["raw_hi"] = float(lo), float(hi)
    info["saturated_fraction"] = float((a >= a.max()).mean()) if a.max() > 0 else 0.0
    if hi <= lo:
        info["normalisation"] = "flat image: no signal range"
        info["clipped_high_fraction"] = 0.0
        return np.zeros_like(a), info
    a -= lo
    a *= 255.0 / float(hi - lo)
    info["clipped_high_fraction"] = float((a > 255).mean())
    np.clip(a, 0, 255, out=a)
    info["normalisation"] = "percentile stretch 0.1-99.99% -> 0-255"
    return a, info


def load_pair(
    files: Dict[str, bytearray], c: Dict[str, Any]
) -> Tuple[np.ndarray, np.ndarray, Dict[str, Any], List[str]]:
    """(dna, foci, info, warnings) from the uploaded files; raises AnalysisError."""
    if "dna" not in files or not len(files["dna"]):
        raise AnalysisError(422, "The DNA / nuclei image ('dna') is required.")
    warnings: List[str] = []
    dna_im, dkind = _open(files["dna"], "DNA image", c)
    channels: List[Tuple[np.ndarray, Dict[str, Any]]] = []
    if "foci" in files and len(files["foci"]):
        foc_im, fkind = _open(files["foci"], "Foci image", c)
        if _frames(dna_im) != 1 or _frames(foc_im) != 1:
            raise AnalysisError(
                422, "Multi-frame files are not accepted except one 2-page TIFF (page 1 = DNA, page 2 = foci) sent as 'dna' alone."
            )
        if dna_im.size != foc_im.size:
            raise AnalysisError(
                422, f"The two images differ in size: DNA {dna_im.size[0]}x{dna_im.size[1]}, foci {foc_im.size[0]}x{foc_im.size[1]}."
            )
        channels = [to_signal(dna_im, "DNA image"), to_signal(foc_im, "Foci image")]
        kinds = (dkind, fkind)
    else:
        n = _frames(dna_im)
        if dkind != "tiff" or n != 2:
            raise AnalysisError(
                422, "Send both a 'dna' and a 'foci' image, or one TIFF with exactly two pages (page 1 = DNA, page 2 = foci)."
            )
        for k, lab in ((0, "DNA page"), (1, "Foci page")):
            dna_im.seek(k)
            channels.append(to_signal(dna_im, lab))
        kinds = (dkind, dkind)
    (dna, dinfo), (foc, finfo) = channels
    w, h = dna_im.size
    for lab, inf, kd in (("DNA", dinfo, kinds[0]), ("Foci", finfo, kinds[1])):
        if kd == "jpeg":
            warnings.append(f"{lab} image is a JPEG: lossy compression blurs small foci; PNG or TIFF is preferred.")
        if inf.get("saturated_fraction", 0) > 0.01:
            warnings.append(f"{lab} image: {inf['saturated_fraction'] * 100:.1f}% of pixels are at the maximum value (saturated).")
        if inf.get("colour_reduced"):
            warnings.append(f"{lab} image is a colour file: the brightest channel per pixel was used. Save greyscale channels for best results.")
        if inf.get("non_finite_pixels"):
            warnings.append(f"{lab} image: {inf['non_finite_pixels']} non-finite pixels were set to 0.")
        if inf.get("normalisation", "").startswith("flat"):
            warnings.append(f"{lab} image has no intensity range (all pixels equal).")
    info = {"width": w, "height": h, "dna": dinfo, "foci": finfo}
    return dna, foc, info, warnings
