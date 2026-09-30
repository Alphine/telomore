"""foci/web/api/plate.php, plates.php and the bulk-use guards of well.php, against a local stub of IDR.

Uses ``php -S`` (several processes sharing one document root and cache, so locking is really exercised across
processes) with FOCI_ALLOW_TEST_BASE=1 / FOCI_IDR_BASE pointing at a threaded loopback stub. No network.
Skipped when PHP with the curl extension is not available.
"""

from __future__ import annotations

import io
import json
import os
import shutil
import socket
import subprocess
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import pytest
from PIL import Image

from tests.test_foci_well_php import IMGDATA, PHP, WEB  # noqa: F401  (shared PHP detection + IDR metadata fixture)

pytestmark = pytest.mark.skipif(PHP is None, reason="php with curl not available")

INDEX = json.loads((WEB / "data" / "well_index.json").read_text())
NOISE = Image.frombytes("RGB", (64, 64), os.urandom(64 * 64 * 3))


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


class Stub(BaseHTTPRequestHandler):
    lock = threading.Lock()
    log: list = []
    delay = 0.0
    live = 0
    peak = 0
    mode = "ok"  # ok | 429

    def log_message(self, *a):
        pass

    def _send(self, code, body, ctype, extra=()):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        for k, v in extra:
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urlparse(self.path)
        with Stub.lock:
            Stub.log.append(self.path)
            Stub.live += 1
            Stub.peak = max(Stub.peak, Stub.live)
        try:
            if Stub.delay:
                time.sleep(Stub.delay)
            if Stub.mode == "429":
                return self._send(429, b"slow down", "text/plain", [("Retry-After", "7")])
            if u.path == "/webclient/":
                self._send(200, b"<html></html>", "text/html", [("Set-Cookie", "sessionid=abc123; Path=/")])
            elif u.path.startswith("/webgateway/imgData/"):
                self._send(200, IMGDATA.encode(), "application/json")
            elif u.path.startswith("/webgateway/render_image/"):
                if "sessionid=abc123" not in (self.headers.get("Cookie") or ""):
                    return self._send(403, b"no session", "text/plain")
                q = parse_qs(u.query)
                b = io.BytesIO()
                if q.get("m") == ["g"]:
                    NOISE.save(b, "PNG")
                    self._send(200, b.getvalue(), "image/png")
                else:
                    NOISE.save(b, "JPEG")
                    self._send(200, b.getvalue(), "image/jpeg")
            else:
                self._send(404, b"nope", "text/plain")
        finally:
            with Stub.lock:
                Stub.live -= 1

    @classmethod
    def reset(cls):
        with cls.lock:
            cls.log.clear()
            cls.delay = 0.0
            cls.live = 0
            cls.peak = 0
            cls.mode = "ok"

    @classmethod
    def idr_count(cls, kind=""):
        with cls.lock:
            return len([p for p in cls.log if kind in p])


@pytest.fixture(scope="module")
def stub():
    sp = free_port()
    srv = ThreadingHTTPServer(("127.0.0.1", sp), Stub)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield sp
    srv.shutdown()


@pytest.fixture
def make_site(tmp_path, stub):
    procs = []

    def _make(env=None, servers=1):
        Stub.reset()
        root = tmp_path / f"host{len(procs)}_{time.time_ns()}"
        pub = root / "public_html"
        (pub / "api").mkdir(parents=True)
        (pub / "data").mkdir()
        for f in (WEB / "api").glob("*.php"):
            shutil.copy(f, pub / "api" / f.name)
        shutil.copy(WEB / "data" / "well_index.json", pub / "data" / "well_index.json")
        e = dict(os.environ, FOCI_ALLOW_TEST_BASE="1", FOCI_IDR_BASE=f"http://127.0.0.1:{stub}")
        e.update({k: str(v) for k, v in (env or {}).items()})
        bases = []
        for _ in range(servers):
            pp = free_port()
            procs.append(subprocess.Popen([*PHP, "-S", f"127.0.0.1:{pp}", "-t", str(pub)], env=e, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
            for _ in range(60):
                try:
                    socket.create_connection(("127.0.0.1", pp), 0.2).close()
                    break
                except OSError:
                    time.sleep(0.1)
            bases.append(f"http://127.0.0.1:{pp}/api/")
        return {"bases": bases, "base": bases[0], "cache": root / "focilab_cache", "pub": pub, "env": e, "root": root}

    yield _make
    for p in procs:
        p.terminate()
    for p in procs:
        p.wait(timeout=10)


def get(url, method="GET", headers=None):
    req = urllib.request.Request(url, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=40) as r:
            return r.status, dict(r.headers), r.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()


def wells_of(plate):
    return sorted(k for k in INDEX if k.rsplit("_", 1)[0] == plate)


# ---------------------------------------------------------------------------------------------- plates / plate


def test_plates_list(make_site):
    s = make_site()
    st, h, body = get(s["base"] + "plates.php")
    j = json.loads(body)
    assert st == 200 and h["Content-Type"].startswith("application/json") and "max-age" in h["Cache-Control"]
    assert j["n"] == len(j["plates"]) == 148
    assert all(set(p) == {"plate", "wells"} for p in j["plates"])
    by = {p["plate"]: p["wells"] for p in j["plates"]}
    assert by["7-14"] == 384 and by["102"] == 384 and by["5-12"] == 384 and by["100-27"] == 384
    assert "153-29" not in by                      # in the annotation, no images in IDR
    names = [p["plate"] for p in j["plates"]]
    assert names.index("5-12") < names.index("100-27")           # natural order
    assert sum(by.values()) == len(INDEX)
    # 304 + HEAD + method
    st2, _, b2 = get(s["base"] + "plates.php", headers={"If-None-Match": h["ETag"]})
    assert st2 == 304 and b2 == b""
    assert get(s["base"] + "plates.php", "HEAD")[0] == 200
    assert get(s["base"] + "plates.php", "POST", {"Content-Length": "0"})[0] == 405
    assert Stub.idr_count() == 0


@pytest.mark.parametrize("plate", ["7-14", "100-27", "102", "5-12", "10-34"])
def test_plate_contract(make_site, plate):
    s = make_site()
    st, h, body = get(s["base"] + f"plate.php?plate={plate}")
    j = json.loads(body)
    assert st == 200 and j["plate"] == plate and j["n"] == len(j["wells"]) == 384
    assert j["rows"] == 12 and j["cols"] == 32
    assert set(j["wells"][0]) == {"well", "plate_well", "image_id"}
    assert j["wells"][0] == {"well": "A1", "plate_well": f"{plate}_A1", "image_id": INDEX[f"{plate}_A1"]}
    assert [w["well"] for w in j["wells"][:3]] == ["A1", "B1", "C1"]                       # column-major order
    assert j["wells"][12]["well"] == "A2" and j["wells"][-1]["well"] == "L32"
    assert all(INDEX[w["plate_well"]] == w["image_id"] for w in j["wells"])
    assert len({w["well"] for w in j["wells"]}) == 384
    assert j["quota"]["requests_per_plate"] == 768 and j["quota"]["uncached_responses_per_min"] >= 1
    assert "max-age" in h["Cache-Control"] and h["X-Content-Type-Options"] == "nosniff"
    assert get(s["base"] + f"plate.php?plate={plate}", headers={"If-None-Match": h["ETag"]})[0] == 304
    assert Stub.idr_count() == 0


@pytest.mark.parametrize(
    "qs,code",
    [
        ("", 400), ("?plate=", 400), ("?plate[]=7-14", 400), ("?plate=../7-14", 400), ("?plate=7-14%00", 400), ("?plate=7-14%0A", 400),
        ("?plate=7_14", 400), ("?plate=7-14/", 400), ("?plate=7-14-1", 400), ("?plate=" + "9" * 40, 400), ("?plate=%E2%82%AC", 400),
        ("?plate=A", 400), ("?plate=7-14%20", 400),
        ("?plate=999", 404), ("?plate=153-29", 404), ("?plate=7-99", 404), ("?plate=0", 404),
    ],
)
def test_plate_validation(make_site, qs, code):
    s = make_site()
    st, h, _ = get(s["base"] + "plate.php" + qs)
    assert st == code
    if code == 400:
        assert h["Cache-Control"] == "no-store"


def test_plate_method_and_head(make_site):
    s = make_site()
    assert get(s["base"] + "plate.php?plate=7-14", "HEAD")[0] == 200
    st, h, _ = get(s["base"] + "plate.php?plate=7-14", "POST", {"Content-Length": "0"})
    assert st == 405 and h["Allow"] == "GET, HEAD"


def test_internal_files_are_not_endpoints(make_site):
    s = make_site()
    assert get(s["base"] + "_lib.php")[0] in (404, 200)
    st, _, body = get(s["base"] + "_lib.php")
    assert body in (b"",) or st == 404          # the lib emits nothing when requested directly
    st, _, body = get(s["base"] + "cache_gc.php")
    assert st == 404


# ---------------------------------------------------------------------------------------------- well.php guards


def test_hit_and_miss_headers_etag_304(make_site):
    s = make_site()
    w = "7-14_A1"
    st, h, b1 = get(s["base"] + f"well.php?w={w}&ch=dna")
    assert st == 200 and h["X-Foci-Cache"] == "MISS" and h["ETag"].startswith('"') and "misses-minute=" in h["X-Foci-Quota"]
    st, h2, b2 = get(s["base"] + f"well.php?w={w}&ch=dna")
    assert st == 200 and h2["X-Foci-Cache"] == "HIT" and b1 == b2 and h2["ETag"] == h["ETag"]
    n = Stub.idr_count()
    st, h3, b3 = get(s["base"] + f"well.php?w={w}&ch=dna", headers={"If-None-Match": h["ETag"]})
    assert st == 304 and b3 == b"" and "immutable" in h3["Cache-Control"]
    assert get(s["base"] + f"well.php?w={w}&ch=dna", headers={"If-None-Match": 'W/"nope", ' + h["ETag"]})[0] == 304
    assert get(s["base"] + f"well.php?w={w}&ch=dna", headers={"If-None-Match": '"other"'})[0] == 200
    assert get(s["base"] + f"well.php?w={w}&ch=dna", headers={"If-None-Match": "*"})[0] == 304
    assert Stub.idr_count() == n
    st, hi, bi = get(s["base"] + f"well.php?w={w}&info=1")
    assert st == 200 and get(s["base"] + f"well.php?w={w}&info=1", headers={"If-None-Match": hi["ETag"]})[0] == 304


def test_miss_rate_limit_429_and_hits_unaffected(make_site):
    s = make_site({"FOCI_MISS_PER_MIN": 4, "FOCI_MISS_PER_DAY": 1000, "FOCI_IDR_RATE": 1000, "FOCI_IDR_BURST": 1000})
    ws = wells_of("7-14")[:8]
    codes = [get(s["base"] + f"well.php?w={w}&ch=dna")[0] for w in ws]
    assert codes[:4] == [200] * 4 and set(codes[4:]) == {429}
    st, h, body = get(s["base"] + f"well.php?w={ws[4]}&ch=dna")
    assert st == 429 and h["Cache-Control"] == "no-store" and int(h["Retry-After"]) >= 1 and int(h["Retry-After"]) <= 60
    # cached answers are still served, with no IDR traffic
    n = Stub.idr_count()
    for w in ws[:4]:
        assert get(s["base"] + f"well.php?w={w}&ch=dna")[0] == 200
    assert Stub.idr_count() == n
    # a refused miss did not reach IDR and left nothing behind
    assert not list(s["cache"].glob("*.tmp*"))


def test_daily_miss_limit(make_site):
    s = make_site({"FOCI_MISS_PER_MIN": 1000, "FOCI_MISS_PER_DAY": 3, "FOCI_IDR_RATE": 1000, "FOCI_IDR_BURST": 1000})
    codes = [get(s["base"] + f"well.php?w={w}&ch=foci")[0] for w in wells_of("7-14")[:5]]
    assert codes == [200, 200, 200, 429, 429]
    st, h, _ = get(s["base"] + f"well.php?w={wells_of('7-14')[5]}&ch=foci")
    assert int(h["Retry-After"]) > 1000            # one day-token back takes 86400/3 s


def test_hit_rate_limit(make_site):
    s = make_site({"FOCI_HIT_PER_MIN": 6, "FOCI_MISS_PER_MIN": 100})
    w = "7-14_A1"
    get(s["base"] + f"well.php?w={w}&ch=dna")        # miss: costs one response token as well
    codes = [get(s["base"] + f"well.php?w={w}&ch=dna")[0] for _ in range(8)]
    assert codes.count(200) == 5 and codes.count(429) == 3
    st, h, _ = get(s["base"] + f"well.php?w={w}&ch=dna")
    assert st == 429 and "Retry-After" in h


def test_forwarded_for_is_ignored_unless_proxy_trusted(make_site):
    s = make_site({"FOCI_MISS_PER_MIN": 2, "FOCI_IDR_RATE": 1000, "FOCI_IDR_BURST": 1000})
    ws = wells_of("7-14")[:4]
    codes = [get(s["base"] + f"well.php?w={w}&ch=dna", headers={"X-Forwarded-For": f"10.0.0.{i}"})[0] for i, w in enumerate(ws)]
    assert codes == [200, 200, 429, 429]           # spoofed header did not create fresh quotas
    t = make_site({"FOCI_MISS_PER_MIN": 2, "FOCI_IDR_RATE": 1000, "FOCI_IDR_BURST": 1000, "FOCI_TRUSTED_PROXIES": "127.0.0.1"})
    codes = [get(t["base"] + f"well.php?w={w}&ch=dna", headers={"X-Forwarded-For": f"10.0.0.{i // 2}"})[0] for i, w in enumerate(ws)]
    assert codes == [200, 200, 200, 200]           # behind a trusted proxy the client address is used
    codes = [get(t["base"] + f"well.php?w={w}&ch=foci", headers={"X-Forwarded-For": "garbage, 10.9.9.9"})[0] for w in ws[:3]]
    assert codes == [200, 200, 429]


def test_idr_concurrency_cap_503(make_site, stub):
    s = make_site({"FOCI_IDR_CONCURRENCY": 1, "FOCI_MISS_PER_MIN": 1000, "FOCI_IDR_RATE": 1000, "FOCI_IDR_BURST": 1000}, servers=3)
    Stub.delay = 0.6
    ws = wells_of("7-14")[:3]

    def one(i):
        return get(s["bases"][i] + f"well.php?w={ws[i]}&ch=dna")

    with ThreadPoolExecutor(3) as ex:
        res = list(ex.map(one, range(3)))
    codes = sorted(r[0] for r in res)
    assert codes.count(200) >= 1 and 503 in codes
    for st, h, _ in res:
        if st == 503:
            assert int(h["Retry-After"]) >= 1 and h["Cache-Control"] == "no-store"
    assert Stub.peak <= 1                                        # never two simultaneous IDR fetches
    Stub.delay = 0.0
    # the refused ones succeed on retry
    assert all(get(s["base"] + f"well.php?w={w}&ch=dna")[0] == 200 for w in ws)


def test_idr_request_rate_cap_503(make_site):
    s = make_site({"FOCI_IDR_RATE": 0.2, "FOCI_IDR_BURST": 3, "FOCI_IDR_WAIT_MS": 0, "FOCI_MISS_PER_MIN": 1000})
    # first miss needs 3 IDR calls (session cookie, imgData, render) = the whole burst
    assert get(s["base"] + "well.php?w=7-14_A1&ch=dna")[0] == 200
    n = Stub.idr_count()
    st, h, _ = get(s["base"] + "well.php?w=7-14_B1&ch=dna")
    assert st == 503 and int(h["Retry-After"]) >= 1
    assert Stub.idr_count() == n                                  # nothing was sent to IDR
    assert not list(s["cache"].glob("7*.tmp*")) and not list(s["cache"].glob("*.tmp*"))


def test_idr_upstream_429_becomes_503(make_site):
    s = make_site({"FOCI_IDR_RATE": 1000, "FOCI_IDR_BURST": 1000})
    Stub.mode = "429"
    st, h, _ = get(s["base"] + "well.php?w=7-14_A1&ch=dna")
    assert st == 503 and int(h["Retry-After"]) >= 1
    Stub.mode = "ok"


def test_burst_same_files_no_corruption_and_single_fetch(make_site):
    s = make_site({"FOCI_MISS_PER_MIN": 10000, "FOCI_MISS_PER_DAY": 100000, "FOCI_HIT_PER_MIN": 100000, "FOCI_IDR_RATE": 1000, "FOCI_IDR_BURST": 1000, "FOCI_IDR_CONCURRENCY": 8}, servers=3)
    Stub.delay = 0.05
    ws = wells_of("7-14")[:4]
    jobs = [(ws[i % 4], ch) for i in range(32) for ch in ("dna", "foci")]

    def one(j):
        k, (w, ch) = j
        return get(s["bases"][k % 3] + f"well.php?w={w}&ch={ch}")

    with ThreadPoolExecutor(12) as ex:
        res = list(ex.map(one, enumerate(jobs)))
    assert [r[0] for r in res].count(200) == len(jobs), sorted({r[0] for r in res})
    for st, h, body in res:
        Image.open(io.BytesIO(body)).verify()                       # every response is a whole PNG
    names = [p.name for p in s["cache"].iterdir()]
    assert not [n for n in names if ".tmp" in n]
    for p in s["cache"].glob("*.png"):
        Image.open(p).verify()
    # each of the 4 images: metadata and each channel fetched from IDR exactly once
    assert Stub.idr_count("imgData") == 4 and Stub.idr_count("render_image") == 8


def test_cache_cleanup_lru_order_and_protected_files(make_site):
    s = make_site({"FOCI_CACHE_MAX_BYTES": 10000, "FOCI_EVICT_GRACE_S": 120})
    cache = s["cache"]
    cache.mkdir(parents=True)
    now = time.time()
    (cache / "idr_cookies.txt").write_bytes(b"x" * 50000)
    os.utime(cache / "idr_cookies.txt", (now - 99999, now - 99999))
    spec = [  # name, size, age in seconds
        ("1.dna.png", 3000, 5000), ("2.dna.png", 3000, 4000), ("3.dna.png", 3000, 3000), ("4.jpg", 3000, 2000),
        ("5.info.json", 3000, 1000), ("6.foci.png", 3000, 10),                     # 6: inside the grace period
        ("7.foci.png", 3000, -99999999),                                           # stamped in the far future (clock jump)
    ]
    for n, size, age in spec:
        (cache / n).write_bytes(b"\x00" * size)
        os.utime(cache / n, (now - age, now - age))
    (cache / "8.dna.png.tmp0123456789ab").write_bytes(b"t")
    os.utime(cache / "8.dna.png.tmp0123456789ab", (now - 5000, now - 5000))
    (cache / "9.dna.png.tmp0123456789ab").write_bytes(b"t")          # fresh temp file: an upload in flight
    (cache / "unrelated.txt").write_bytes(b"u" * 100)
    (cache / "_rl").mkdir()
    (cache / "_rl" / "c_old").write_text("0 1 1 1")
    os.utime(cache / "_rl" / "c_old", (now - 3 * 86400, now - 3 * 86400))
    env = dict(s["env"], FOCI_CACHE_DIR=str(cache))
    out = subprocess.run([*PHP, str(s["pub"] / "api" / "cache_gc.php")], env=env, capture_output=True, text=True)
    st = json.loads(out.stdout)
    assert st["ran"] and st["scanned"] == 7 and st["deleted"] >= 1
    left = {p.name for p in cache.iterdir()}
    # 21000 bytes managed, cap 10000, target 9000: least recently used go first, protected files stay
    assert "1.dna.png" not in left and "2.dna.png" not in left and "3.dna.png" not in left and "4.jpg" not in left
    assert "6.foci.png" in left                                        # within the grace period
    assert "idr_cookies.txt" in left and "unrelated.txt" in left       # never touched
    assert "8.dna.png.tmp0123456789ab" not in left and "9.dna.png.tmp0123456789ab" in left
    assert not (cache / "_rl" / "c_old").exists()
    managed = sum((cache / n).stat().st_size for n in left if n[0].isdigit() and ".tmp" not in n)
    assert managed <= 10000
    # nothing over the cap: nothing deleted
    env = dict(s["env"], FOCI_CACHE_DIR=str(cache))
    out = subprocess.run([*PHP, str(s["pub"] / "api" / "cache_gc.php")], env=env, capture_output=True, text=True)
    assert json.loads(out.stdout)["deleted"] == 0


def test_cleanup_triggered_by_misses_and_hit_refreshes_recency(make_site):
    s = make_site({"FOCI_CACHE_MAX_BYTES": 1, "FOCI_CLEANUP_PROB": 0, "FOCI_EVICT_GRACE_S": 0, "FOCI_MISS_PER_MIN": 1000, "FOCI_IDR_RATE": 1000, "FOCI_IDR_BURST": 1000})
    ws = wells_of("7-14")[:3]
    for w in ws:
        assert get(s["base"] + f"well.php?w={w}&ch=dna")[0] == 200
    iid = [INDEX[w] for w in ws]
    now = time.time()
    for i, n in enumerate(iid):                      # ages: first oldest
        f = s["cache"] / f"{n}.dna.png"
        os.utime(f, (now - 1000 + i * 10, now - 1000 + i * 10))
    old = (s["cache"] / f"{iid[0]}.dna.png").stat().st_mtime
    assert get(s["base"] + f"well.php?w={ws[0]}&ch=dna")[0] == 200     # a hit on the oldest file refreshes it
    assert (s["cache"] / f"{iid[0]}.dna.png").stat().st_mtime > old + 500
    # with cap = 1 byte and prob = 1, the next miss sweeps: everything except the newest goes, cookie jar stays
    s2 = make_site({"FOCI_CACHE_MAX_BYTES": 70000, "FOCI_CLEANUP_PROB": 1, "FOCI_EVICT_GRACE_S": 0, "FOCI_MISS_PER_MIN": 1000, "FOCI_IDR_RATE": 1000, "FOCI_IDR_BURST": 1000})
    for w in wells_of("7-14")[:12]:
        assert get(s2["base"] + f"well.php?w={w}&ch=dna")[0] == 200
    time.sleep(0.5)
    size = sum(p.stat().st_size for p in s2["cache"].iterdir() if p.name[0].isdigit())
    assert size <= 70000 + 20000                                    # soft cap: within one response of the limit
    assert (s2["cache"] / "idr_cookies.txt").exists()


def test_config_file_outside_web_root_and_env_precedence(make_site):
    s = make_site({"FOCI_MISS_PER_MIN": 3, "FOCI_IDR_RATE": 1000, "FOCI_IDR_BURST": 1000})
    (s["root"] / "focilab_config.php").write_text("<?php return ['miss_per_min' => 1, 'miss_per_day' => 7];")
    codes = [get(s["base"] + f"well.php?w={w}&ch=dna")[0] for w in wells_of("7-14")[:5]]
    assert codes == [200, 200, 200, 429, 429]       # env (3) beats the file (1)
    bad = make_site({"FOCI_MISS_PER_MIN": "abc", "FOCI_MISS_PER_DAY": "-5", "FOCI_IDR_RATE": "1e999", "FOCI_CACHE_MAX_BYTES": "99999999999999999999"})
    assert get(bad["base"] + "well.php?w=7-14_A1&ch=dna")[0] == 200   # garbage values fall back to defaults/clamps


def test_clock_skew_and_corrupt_limiter_state(make_site):
    s = make_site({"FOCI_MISS_PER_MIN": 2, "FOCI_IDR_RATE": 1000, "FOCI_IDR_BURST": 1000})
    get(s["base"] + "well.php?w=7-14_A1&ch=dna")
    rl = s["cache"] / "_rl"
    [f] = list(rl.iterdir())
    f.write_text(f"{time.time() + 10**9:.4f} 0 0 0")          # timestamp a billion seconds ahead, empty buckets
    st, h, _ = get(s["base"] + "well.php?w=7-14_B1&ch=dna")
    assert st == 429 and 1 <= int(h["Retry-After"]) <= 100000   # no negative elapsed time, no overflow
    f.write_text("garbage \x00 nan inf")                         # corrupt state must not crash or bypass
    assert get(s["base"] + "well.php?w=7-14_B1&ch=dna")[0] in (200, 429)
    f.write_text("")
    assert get(s["base"] + "well.php?w=7-14_C1&ch=dna")[0] == 200


@pytest.mark.parametrize("qs", ["?w=7-14_A1&ch=dna%00", "?w=7-14_A01", "?w=7-14_a1", "?w=7-14_Q1", "?w=7-14_A1%0d%0aSet-Cookie:x=1", "?w=7_14_A1", "?w=%2e%2e%2f7-14_A1"])
def test_malformed_well_ids_never_reach_idr(make_site, qs):
    s = make_site()
    st, h, _ = get(s["base"] + "well.php" + qs)
    assert st in (400, 404) and "Set-Cookie" not in h
    assert Stub.idr_count() == 0
