"""foci/web/api/well.php against a local stub of IDR (no network, no production).

Runs ``php -S`` with FOCI_ALLOW_TEST_BASE=1 / FOCI_IDR_BASE pointing at a
loopback stub that mimics the three IDR endpoints the script uses. Skipped when
PHP with the curl extension is not available.
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
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import pytest
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / "foci" / "web"
IMGDATA = (ROOT / "tests" / "fixtures" / "idr_imgdata_1922019.json").read_text()
NOISE = Image.frombytes("RGB", (64, 64), os.urandom(64 * 64 * 3))
WELL = "100-27_A1"  # -> image 1922019 under both pairings (A1: Well Number 1 is a fixed point of the permutation)


def _php_cmd():
    php = shutil.which("php")
    if not php:
        return None
    ext = []
    ok = subprocess.run([php, "-r", "echo function_exists('curl_init')?'1':'0';"], capture_output=True, text=True).stdout
    if ok != "1":
        extdir = Path(php).parent / "ext"
        if not (extdir / "php_curl.dll").exists():
            return None
        ext = ["-d", f"extension_dir={extdir}", "-d", "extension=curl"]
        ok = subprocess.run([php, *ext, "-r", "echo function_exists('curl_init')?'1':'0';"], capture_output=True, text=True).stdout
        if ok != "1":
            return None
    return [php, *ext]


PHP = _php_cmd()
pytestmark = pytest.mark.skipif(PHP is None, reason="php with curl not available")


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


class Stub(BaseHTTPRequestHandler):
    log: list = []
    fail_render = False

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
        Stub.log.append(self.path)
        if u.path == "/webclient/":
            self._send(200, b"<html></html>", "text/html", [("Set-Cookie", "sessionid=abc123; Path=/")])
        elif u.path.startswith("/webgateway/imgData/"):
            self._send(200, IMGDATA.encode(), "application/json")
        elif u.path.startswith("/webgateway/render_image/"):
            if "sessionid=abc123" not in (self.headers.get("Cookie") or ""):
                return self._send(403, b"no session", "text/plain")
            if Stub.fail_render:
                return self._send(200, b"tiny", "image/png")
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


@pytest.fixture(scope="module")
def site(tmp_path_factory):
    root = tmp_path_factory.mktemp("host")
    pub = root / "public_html"
    (pub / "api").mkdir(parents=True)
    (pub / "data").mkdir()
    for f in (WEB / "api").glob("*.php"):   # well.php now requires _lib.php
        shutil.copy(f, pub / "api" / f.name)
    for n in ("well_index.json", "well_index_byname.json"):
        shutil.copy(WEB / "data" / n, pub / "data" / n)
    sp, pp = free_port(), free_port()
    srv = HTTPServer(("127.0.0.1", sp), Stub)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    env = dict(os.environ, FOCI_ALLOW_TEST_BASE="1", FOCI_IDR_BASE=f"http://127.0.0.1:{sp}")
    proc = subprocess.Popen(
        [*PHP, "-S", f"127.0.0.1:{pp}", "-t", str(pub)], env=env, stdout=subprocess.DEVNULL, stderr=open(os.environ.get("PHP_LOG", os.devnull), "w")
    )
    for _ in range(50):
        try:
            socket.create_connection(("127.0.0.1", pp), 0.2).close()
            break
        except OSError:
            time.sleep(0.1)
    yield {"base": f"http://127.0.0.1:{pp}/api/well.php", "cache": root / "focilab_cache", "pub": pub, "env": env}
    proc.terminate()
    srv.shutdown()


def get(site, qs, method="GET"):
    req = urllib.request.Request(site["base"] + qs, method=method)
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, dict(r.headers), r.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()


def test_composite_channels_and_info(site):
    Stub.log.clear()
    st, h, body = get(site, f"?w={WELL}")
    assert st == 200 and h["Content-Type"] == "image/jpeg" and body[:3] == b"\xff\xd8\xff"
    assert "immutable" in h["Cache-Control"]
    # the exact IDR request the previous version made: both channels, curators' window, m=c, q=0.9
    render = [p for p in Stub.log if "render_image" in p][0]
    assert "c=1%7C52%3A778%240000FF%2C2%7C40%3A1410%2400FF00&m=c&q=0.9" in render
    for ch, win in (("dna", "1%7C52%3A778"), ("foci", "2%7C40%3A1410")):
        st, h, body = get(site, f"?w={WELL}&ch={ch}")
        assert st == 200 and h["Content-Type"] == "image/png" and body[:4] == b"\x89PNG"
        assert "immutable" in h["Cache-Control"] and h["X-Content-Type-Options"] == "nosniff"
        assert any(f"c={win}%24FFFFFF&m=g&format=png" in p for p in Stub.log), Stub.log
    st, h, body = get(site, f"?w={WELL}&info=1")
    j = json.loads(body)
    assert st == 200 and h["Content-Type"].startswith("application/json")
    assert j == {
        "well": WELL, "pairing": "colmajor", "image_id": 1922019, "size_x": 696, "size_y": 520, "pixel_size_um": 0.465,
        "pixel_size_source": "idr0010 study protocol (IDR reports the nominal default 1.0)",
        "channels": ["Hoechst 33258", "Alexa488/53BP1"],
        "idr_url": "https://idr.openmicroscopy.org/webclient/?show=image-1922019",
    }
    assert "max-age" in h["Cache-Control"] and "immutable" not in h["Cache-Control"]


def test_pairing_param_selects_the_image(site):
    """Default = column-major (annotation row -> image of the column-major address); pair=name = IDR address as is."""
    byname = json.loads((WEB / "data" / "well_index_byname.json").read_text())
    colmaj = json.loads((WEB / "data" / "well_index.json").read_text())
    key = "100-27_B1"                      # row 2, column 1: Well Number 33 -> image at IDR I3
    assert byname[key] != colmaj[key] and colmaj[key] == byname["100-27_I3"]
    for pair, want in (("name", byname[key]), ("colmajor", colmaj[key]), (None, colmaj[key])):
        st, h, body = get(site, f"?w={key}&info=1" + (f"&pair={pair}" if pair else ""))
        j = json.loads(body)
        assert st == 200 and j["image_id"] == want and j["pairing"] == (pair or "colmajor"), (pair, j)
    for bad in ("pair=", "pair=other", "pair[]=name", "pair=NAME"):
        assert get(site, f"?w={key}&info=1&{bad}")[0] == 400, bad


def test_second_request_is_served_from_cache(site):
    get(site, f"?w={WELL}&ch=foci")
    Stub.log.clear()
    for q in ("", "&ch=dna", "&ch=foci", "&info=1"):
        assert get(site, f"?w={WELL}{q}")[0] == 200
    assert Stub.log == []          # no IDR traffic at all
    assert get(site, f"?w={WELL}", "HEAD")[0] == 200


@pytest.mark.parametrize(
    "qs,code",
    [
        ("", 400), ("?w=", 400), ("?w[]=x", 400), ("?w=../../etc/passwd", 400), ("?w=100-27_A1%00", 400),
        ("?w=100-27_A1%0A", 400), (f"?w={WELL}&ch=rgb", 400), (f"?w={WELL}&ch[]=dna", 400),
        (f"?w={WELL}&info=0", 400), (f"?w={WELL}&info=1&ch=dna", 400), ("?w=999-99_A1", 404),
    ],
)
def test_validation(site, qs, code):
    st, h, body = get(site, qs)
    assert st == code
    assert h["Content-Type"].startswith("text/plain") and h["Cache-Control"] == "no-store"


def test_method_not_allowed(site):
    req = urllib.request.Request(site["base"] + f"?w={WELL}", data=b"x", method="POST")
    with pytest.raises(urllib.error.HTTPError) as e:
        urllib.request.urlopen(req, timeout=10)
    assert e.value.code == 405 and e.value.headers["Allow"] == "GET, HEAD"


def test_cache_outside_web_root_and_no_temp_leftovers(site):
    cache = site["cache"]
    assert cache.is_dir() and site["pub"] not in cache.parents
    names = sorted(p.name for p in cache.iterdir())
    assert "1922019.jpg" in names and "1922019.dna.png" in names and "1922019.info.json" in names
    assert not [n for n in names if ".tmp" in n]
    assert not any(p.name.startswith("focilab") for p in site["pub"].rglob("*"))


def test_upstream_garbage_is_502_and_not_cached(site):
    other = next(k for k, v in json.loads((WEB / "data" / "well_index.json").read_text()).items() if v != 1922019)
    Stub.fail_render = True
    try:
        st, h, body = get(site, f"?w={other}&ch=dna")
        assert st == 502 and h["Cache-Control"] == "no-store"
    finally:
        Stub.fail_render = False
    assert not list(site["cache"].glob("*.dna.png.tmp*"))


def test_test_base_ignored_without_switch(site, tmp_path):
    """Without FOCI_ALLOW_TEST_BASE=1 the override variable must be ignored (real host is used)."""
    src = (WEB / "api" / "well.php").read_text()
    out = subprocess.run(
        [*PHP, "-r", "putenv('FOCI_IDR_BASE=http://127.0.0.1:1'); " + src[src.index("function idr_base"): src.index("$IDR = idr_base();")].replace("\r", "") + " echo idr_base();"],
        capture_output=True, text=True,
    ).stdout
    assert out == "https://idr.openmicroscopy.org"
    out = subprocess.run(
        [*PHP, "-r", "putenv('FOCI_ALLOW_TEST_BASE=1'); putenv('FOCI_IDR_BASE=https://evil.example'); " + src[src.index("function idr_base"): src.index("$IDR = idr_base();")].replace("\r", "") + " echo idr_base();"],
        capture_output=True, text=True,
    ).stdout
    assert out == "https://idr.openmicroscopy.org"  # even with the switch, only loopback is accepted
