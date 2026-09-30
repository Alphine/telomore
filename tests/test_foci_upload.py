"""POST /api/foci/analyze -- the Foci Lab upload analyser.

Synthetic images with a known number of nuclei/foci go through the real
endpoint (in-process TestClient). Covers: 8/16-bit PNG/TIFF, 2-page TIFF,
big-endian 16-bit, every safeguard (size, pixels, type, shape, corrupt,
tiny, concurrency 503, rate limit 429, CORS preflight) and "nothing is
persisted".
"""

from __future__ import annotations

import io
import os
import struct
import sys
import tempfile
import threading
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
for p in (ROOT / "src", Path(__file__).resolve().parent):
    if str(p) not in sys.path:
        sys.path.insert(0, str(p))

from test_foci import synthetic  # noqa: E402

from backend import foci_upload as up  # noqa: E402
from backend.main import create_app  # noqa: E402

URL = "/api/foci/analyze"


@pytest.fixture()
def client():
    return TestClient(create_app())


def png(a, mode=None) -> bytes:
    b = io.BytesIO()
    Image.fromarray(a).save(b, format="PNG")
    return b.getvalue()


def tif(a) -> bytes:
    b = io.BytesIO()
    Image.fromarray(a).save(b, format="TIFF")
    return b.getvalue()


def post(client, dna=None, foci=None, data=None, dna_name="dna.png", foci_name="foci.png", **kw):
    files = {}
    if dna is not None:
        files["dna"] = (dna_name, dna, "application/octet-stream")
    if foci is not None:
        files["foci"] = (foci_name, foci, "application/octet-stream")
    return client.post(URL, files=files or None, data=data or {}, **kw)


@pytest.fixture(scope="module")
def img():
    return synthetic()  # 9 nuclei, 2*(0+2+4)... known foci


def test_8bit_png_exact_counts_and_contract(client, img):
    dna, foc, expected = img
    r = post(client, png(dna.astype(np.uint8)), png(foc.astype(np.uint8)))
    assert r.status_code == 200, r.text
    j = r.json()
    assert j["validated"] is False
    assert j["nuclei"] == 9 and j["foci"] == sum(expected)
    assert j["foci_per_cell"] == pytest.approx(sum(expected) / 9, abs=1e-3)
    assert sorted(t["foci"] for t in j["table"]) == sorted(expected)
    assert sum(t["foci"] for t in j["table"]) == j["foci"]
    assert all(0 <= t["centroid_x"] < 300 and 0 <= t["centroid_y"] < 300 for t in j["table"])
    assert {"id", "area_px", "centroid_x", "centroid_y", "nuclei_in_object", "foci"} <= set(j["table"][0])
    assert j["parameters"]["min_height"] == 12.0 and j["parameters"]["peak_window"] == 5
    assert j["limits"] and j["image"]["dna"]["bit_depth"] == 8
    assert Image.open(io.BytesIO(__import__("base64").b64decode(j["jpeg"]))).size == (300, 300)
    assert r.headers["cache-control"] == "no-store"


def test_matches_library_result_bit_for_bit(client, img):
    from telomere_lab.foci import count_foci

    dna, foc, _ = img
    d8, f8 = dna.astype(np.uint8), foc.astype(np.uint8)
    ref = count_foci(d8.astype(np.float32), f8.astype(np.float32))
    j = post(client, png(d8), png(f8)).json()
    assert (j["nuclei"], j["foci"]) == (ref.n_nuclei, ref.n_foci)
    assert [t["foci"] for t in j["table"]] == ref.foci_per_nucleus


@pytest.mark.parametrize("fmt", ["png", "tif"])
def test_16bit_counts_match(client, img, fmt):
    dna, foc, expected = img
    enc = png if fmt == "png" else tif
    d16 = (dna * 200).astype(np.uint16)
    f16 = (foc * 200).astype(np.uint16)
    r = post(client, enc(d16), enc(f16))
    assert r.status_code == 200, r.text
    j = r.json()
    assert j["nuclei"] == 9 and j["foci"] == sum(expected)
    assert j["image"]["dna"]["bit_depth"] == 16
    assert "percentile" in j["image"]["foci"]["normalisation"]
    assert 0 <= j["image"]["foci"]["clipped_high_fraction"] < 0.01


def test_16bit_low_bit_depth_camera_range(client, img):
    dna, foc, expected = img  # 12-bit-style data: values up to ~4000
    r = post(client, tif((dna * 15).astype(np.uint16)), tif((foc * 15).astype(np.uint16)))
    assert r.status_code == 200 and r.json()["foci"] == sum(expected)


def test_big_endian_16bit_tiff(client, img):
    tifffile = pytest.importorskip("tifffile")
    dna, foc, expected = img
    outs = []
    for a in (dna, foc):
        b = io.BytesIO()
        tifffile.imwrite(b, (a * 200).astype(">u2"), byteorder=">")
        outs.append(b.getvalue())
    assert outs[0][:2] == b"MM"
    r = post(client, outs[0], outs[1])
    assert r.status_code == 200, r.text
    assert r.json()["nuclei"] == 9 and r.json()["foci"] == sum(expected)


def test_two_page_tiff(client, img):
    dna, foc, expected = img
    b = io.BytesIO()
    Image.fromarray(dna.astype(np.uint8)).save(
        b, format="TIFF", save_all=True, append_images=[Image.fromarray(foc.astype(np.uint8))]
    )
    r = post(client, b.getvalue(), None, dna_name="stack.tif")
    assert r.status_code == 200, r.text
    assert r.json()["foci"] == sum(expected)


def test_three_page_tiff_and_multiframe_with_two_files_rejected(client, img):
    dna, foc, _ = img
    a = Image.fromarray(dna.astype(np.uint8))
    b3 = io.BytesIO()
    a.save(b3, format="TIFF", save_all=True, append_images=[a, a])
    assert post(client, b3.getvalue(), None).status_code == 422
    b2 = io.BytesIO()
    a.save(b2, format="TIFF", save_all=True, append_images=[a])
    assert post(client, b2.getvalue(), png(foc.astype(np.uint8))).status_code == 422


def test_single_channel_only_is_rejected(client, img):
    dna, _, _ = img
    r = post(client, png(dna.astype(np.uint8)), None)
    assert r.status_code == 422 and "both" in r.json()["detail"]
    assert post(client, None, png(dna.astype(np.uint8))).status_code == 422


def test_animated_gif_and_wrong_types_rejected(client, img):
    dna, foc, _ = img
    g = io.BytesIO()
    a = Image.fromarray(dna.astype(np.uint8))
    a.save(g, format="GIF", save_all=True, append_images=[a])
    assert post(client, g.getvalue(), png(foc.astype(np.uint8))).status_code == 415
    assert post(client, b"%PDF-1.4 hello", b"MZ\x90\x00").status_code == 415
    assert post(client, b"", b"").status_code == 422
    r = client.post(URL, json={"a": 1})
    assert r.status_code == 415


def test_jpeg_accepted_with_warning(client, img):
    dna, foc, _ = img
    out = []
    for a in (dna, foc):
        b = io.BytesIO()
        Image.fromarray(a.astype(np.uint8)).save(b, format="JPEG", quality=95)
        out.append(b.getvalue())
    r = post(client, out[0], out[1])
    assert r.status_code == 200
    assert any("JPEG" in w for w in r.json()["warnings"])


def test_rgb_composite_is_reduced_with_warning(client, img):
    dna, foc, _ = img
    rgb = np.stack([np.zeros_like(dna), np.zeros_like(dna), dna], axis=-1).astype(np.uint8)
    r = post(client, png(rgb), png(foc.astype(np.uint8)))
    assert r.status_code == 200 and r.json()["nuclei"] == 9
    assert any("brightest channel" in w for w in r.json()["warnings"])


def test_float_tiff_with_nan_is_safe(client, img):
    dna, foc, expected = img
    d = dna.astype(np.float32).copy()
    d[0, 0] = np.nan
    d[1, 1] = np.inf
    r = post(client, tif(d), tif(foc.astype(np.float32)))
    assert r.status_code == 200, r.text
    j = r.json()
    assert j["nuclei"] == 9 and any("non-finite" in w for w in j["warnings"])
    assert json_is_finite(j)


def json_is_finite(o):
    if isinstance(o, float):
        return np.isfinite(o)
    if isinstance(o, dict):
        return all(json_is_finite(v) for v in o.values())
    if isinstance(o, list):
        return all(json_is_finite(v) for v in o)
    return True


def test_parameters_change_results_and_are_echoed(client, img):
    dna, foc, expected = img
    d, f = png(dna.astype(np.uint8)), png(foc.astype(np.uint8))
    j = post(client, d, f, data={"min_height": "200"}).json()
    assert j["foci"] == 0 and j["parameters"]["min_height"] == 200
    j = post(client, d, f, data={"min_nucleus_px": "100000"}).json()
    assert j["nuclei"] == 0 and j["foci_per_cell"] is None and j["table"] == []
    assert any("No nuclei" in w for w in j["warnings"])
    # blank -> default
    assert post(client, d, f, data={"min_height": ""}).json()["parameters"]["min_height"] == 12.0


@pytest.mark.parametrize(
    "data",
    [
        {"min_height": "nan"}, {"min_height": "inf"}, {"min_height": "-1"}, {"min_height": "abc"},
        {"min_height": "1e999"}, {"tophat_size": "8"}, {"tophat_size": "2"}, {"peak_window": "4"},
        {"background_size": "9"}, {"background_size": "100001"}, {"min_nucleus_px": "1.5"},
        {"min_nucleus_px": "0"}, {"bogus": "1"},
    ],
)
def test_bad_parameters_are_422(client, img, data):
    dna, foc, _ = img
    r = post(client, png(dna.astype(np.uint8)), png(foc.astype(np.uint8)), data=data)
    assert r.status_code == 422, (data, r.text)


def test_mismatched_shapes(client, img):
    dna, foc, _ = img
    r = post(client, png(dna.astype(np.uint8)), png(foc[:280].astype(np.uint8)))
    assert r.status_code == 422 and "differ in size" in r.json()["detail"]


def test_corrupt_and_truncated_files(client, img):
    dna, foc, _ = img
    good = png(dna.astype(np.uint8))
    assert post(client, good[:200] + b"\x00" * 50, good).status_code == 422
    assert post(client, good[: len(good) // 2], good).status_code == 422
    assert post(client, b"\x89PNG\r\n\x1a\n" + os.urandom(500), good).status_code == 422
    assert post(client, b"II*\x00" + os.urandom(500), good).status_code == 422


def test_tiny_image(client):
    a = np.zeros((10, 10), np.uint8)
    r = post(client, png(a), png(a))
    assert r.status_code == 422 and "at least" in r.json()["detail"]


def test_saturated_and_blank_images_do_not_crash(client):
    full = np.full((120, 120), 255, np.uint8)
    r = post(client, png(full), png(full))
    assert r.status_code == 200 and r.json()["nuclei"] == 0 and r.json()["foci"] == 0
    assert any("maximum value" in w for w in r.json()["warnings"])
    z16 = np.full((120, 120), 40000, np.uint16)
    r = post(client, png(z16), png(z16))
    assert r.status_code == 200 and r.json()["nuclei"] == 0
    zero = np.zeros((120, 120), np.uint16)
    assert post(client, png(zero), png(zero)).status_code == 200


def test_oversize_upload_413(client, img, monkeypatch):
    dna, foc, _ = img
    monkeypatch.setenv("TELOMERE_FOCI_MAX_UPLOAD_BYTES", "20000")
    r = post(client, png((np.random.default_rng(1).random((300, 300)) * 255).astype(np.uint8)), png(foc.astype(np.uint8)))
    assert r.status_code == 413


def test_oversize_without_content_length_is_caught_while_streaming(monkeypatch, img):
    dna, foc, _ = img
    monkeypatch.setenv("TELOMERE_FOCI_MAX_UPLOAD_BYTES", "20000")
    body = b"--B\r\nContent-Disposition: form-data; name=\"dna\"; filename=\"a\"\r\n\r\n" + os.urandom(60000) + b"\r\n--B--\r\n"

    def gen():
        for i in range(0, len(body), 4096):
            yield body[i : i + 4096]

    r = TestClient(create_app()).post(URL, content=gen(), headers={"content-type": "multipart/form-data; boundary=B"})
    assert r.status_code == 413


def test_over_pixel_cap_413(client, monkeypatch):
    monkeypatch.setenv("TELOMERE_FOCI_MAX_PIXELS", "10000")
    a = np.zeros((120, 120), np.uint8)
    r = post(client, png(a), png(a))
    assert r.status_code == 413 and "Mpx" in r.json()["detail"]


def test_declared_huge_dimensions_rejected_before_decode(client):
    """A PNG header claiming 60000x60000 (3.6 Gpx) with almost no data: refused from the header alone."""
    def chunk(t, d):
        import zlib
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)

    import zlib
    ihdr = struct.pack(">IIBBBBB", 60000, 60000, 8, 0, 0, 0, 0)
    bomb = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(b"\x00" * 100)) + chunk(b"IEND", b"")
    r = post(client, bomb, bomb)
    assert r.status_code == 413


def test_malformed_multipart_400(client):
    r = client.post(URL, content=b"garbage", headers={"content-type": "multipart/form-data; boundary=zzz"})
    assert r.status_code == 400
    r = client.post(URL, content=b"x", headers={"content-type": "multipart/form-data"})
    assert r.status_code == 400


def test_duplicate_and_unknown_fields(client, img):
    dna, foc, _ = img
    b = png(dna.astype(np.uint8))
    body = (
        b"--B\r\nContent-Disposition: form-data; name=\"dna\"\r\n\r\n" + b + b"\r\n"
        b"--B\r\nContent-Disposition: form-data; name=\"dna\"\r\n\r\n" + b + b"\r\n--B--\r\n"
    )
    r = client.post(URL, content=body, headers={"content-type": "multipart/form-data; boundary=B"})
    assert r.status_code == 422
    body = b"--B\r\nContent-Disposition: form-data; name=\"../../etc/passwd\"; filename=\"x\"\r\n\r\nabc\r\n--B--\r\n"
    r = client.post(URL, content=body, headers={"content-type": "multipart/form-data; boundary=B"})
    assert r.status_code == 422 and "passwd" not in r.text


def test_rate_limit_429(client, monkeypatch):
    from backend import ratelimit

    monkeypatch.setenv("TELOMERE_RATE_LIMIT", "on")
    monkeypatch.setenv("TELOMERE_RATE_LIMIT_FOCI_ANALYZE", "2")
    ratelimit.reset()
    codes = [client.post(URL, json={}).status_code for _ in range(3)]
    assert codes == [415, 415, 429]
    r = client.post(URL, json={})
    assert r.status_code == 429 and "retry-after" in r.headers
    ratelimit.reset()


def test_busy_compute_slot_returns_503_and_does_not_leak(client, img, monkeypatch):
    dna, foc, expected = img
    monkeypatch.setenv("TELOMERE_FOCI_QUEUE_WAIT_SECONDS", "0.2")
    sem = up.compute_semaphore()
    assert sem.acquire(blocking=False)
    try:
        r = post(client, png(dna.astype(np.uint8)), png(foc.astype(np.uint8)))
        assert r.status_code == 503 and r.headers["retry-after"]
    finally:
        sem.release()
    # the failed request must not have leaked either semaphore: a normal call succeeds
    r = post(client, png(dna.astype(np.uint8)), png(foc.astype(np.uint8)))
    assert r.status_code == 200 and r.json()["foci"] == sum(expected)


def test_upload_buffer_slots_503(client, img, monkeypatch):
    monkeypatch.setenv("TELOMERE_FOCI_MAX_UPLOADS", "1")
    sem = up.upload_semaphore()
    assert sem.acquire(blocking=False)
    try:
        assert post(client, b"x", b"y").status_code == 503
    finally:
        sem.release()


def test_slot_released_after_error_paths(client, img):
    dna, foc, expected = img
    for _ in range(3):  # each error path must give the slots back
        assert post(client, b"junk", b"junk").status_code == 415
        assert post(client, png(dna.astype(np.uint8)), png(foc[:100].astype(np.uint8))).status_code == 422
    assert post(client, png(dna.astype(np.uint8)), png(foc.astype(np.uint8))).status_code == 200


def test_timeout_504_then_slot_freed_when_worker_finishes(client, img, monkeypatch):
    import backend.routers.foci as router

    gate = threading.Event()
    real = router._run_analysis

    def slow(*a, **k):
        gate.wait(5)
        return real(*a, **k)

    monkeypatch.setattr(router, "_run_analysis", slow)
    monkeypatch.setenv("TELOMERE_FOCI_TIMEOUT_SECONDS", "0.3")
    dna, foc, _ = img
    r = post(client, png(dna.astype(np.uint8)), png(foc.astype(np.uint8)))
    assert r.status_code == 504
    gate.set()
    import time

    for _ in range(100):
        s = up.compute_semaphore()
        if s.acquire(blocking=False):
            s.release()
            break
        time.sleep(0.05)
    else:
        pytest.fail("compute slot was never released")


def test_cors_preflight_and_actual_request(client, img):
    r = client.options(
        URL,
        headers={
            "Origin": "https://studylab.id",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type",
        },
    )
    assert r.status_code == 200
    assert r.headers["access-control-allow-origin"] == "https://studylab.id"
    assert "POST" in r.headers["access-control-allow-methods"]
    dna, foc, _ = img
    r = post(client, png(dna.astype(np.uint8)), png(foc.astype(np.uint8)), headers={"Origin": "https://studylab.id"})
    assert r.headers["access-control-allow-origin"] == "https://studylab.id"
    bad = client.options(URL, headers={"Origin": "https://evil.example", "Access-control-request-method": "POST"})
    assert "access-control-allow-origin" not in bad.headers


def test_nothing_is_persisted(client, img, tmp_path, monkeypatch):
    monkeypatch.setattr(tempfile, "tempdir", str(tmp_path))
    monkeypatch.setenv("TMPDIR", str(tmp_path))
    dna, foc, _ = img
    before = sorted(os.listdir(tmp_path))
    cwd_before = sorted(os.listdir("."))
    big = (np.random.default_rng(0).random((1200, 1200)) * 255).astype(np.uint8)  # > Starlette's 1 MB spool size
    assert len(png(big)) > 1_000_000
    post(client, png(big), png(big))
    post(client, png(dna.astype(np.uint8)), png(foc.astype(np.uint8)))
    post(client, b"junk", b"junk")
    assert sorted(os.listdir(tmp_path)) == before
    assert sorted(os.listdir(".")) == cwd_before


def test_filenames_and_content_never_reflected(client, img):
    dna, foc, _ = img
    r = post(client, png(dna.astype(np.uint8)), png(foc.astype(np.uint8)), dna_name="<script>alert(1)</script>.png")
    assert "<script>" not in r.text
    r = post(client, b"not an image <script>", b"x", dna_name="<img src=x onerror=1>.png")
    assert "<script>" not in r.text and "onerror" not in r.text


def test_existing_overlay_route_untouched():
    paths = set(create_app().openapi()["paths"])
    assert "/api/foci/overlay" in paths and URL in paths


def test_wide_image_overlay_is_block_reduced_but_counts_are_full_resolution(client, img):
    dna, foc, expected = img
    wide_d, wide_f = np.tile(dna, (1, 7)), np.tile(foc, (1, 7))   # 300 x 2100 px: long side over the 2048 overlay cap
    r = post(client, png(wide_d.astype(np.uint8)), png(wide_f.astype(np.uint8)))
    assert r.status_code == 200, r.text
    j = r.json()
    assert j["nuclei"] == 63 and j["foci"] == 7 * sum(expected)
    assert j["overlay_scale"] == 0.5
    assert Image.open(io.BytesIO(__import__("base64").b64decode(j["jpeg"]))).size == (1050, 150)
    assert max(t["centroid_x"] for t in j["table"]) > 2000     # centroids stay in original pixels
