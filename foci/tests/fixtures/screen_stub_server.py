"""Local stub of the Foci Lab proxy plus a static copy of the site, for the plate-mode walkthrough (no IDR, no PHP).

    python screen_stub_server.py --web <scratch copy of foci/web> --port 8765

Serves the files of --web and emulates api/plates.php, api/plate.php and api/well.php with a tiny synthetic two-channel
image per well (R = G = B PNG, 64 x 48): nucleus count N and foci count F are encoded as the number of 255-valued
pixels (see screen_mock_engine.js). Plates 9-1 and 9-2 are 12 x 32. The authors' table (data/downloads/foci_wells.csv and
data/screen_controls.json, written into --web at start-up) is built so that the COLUMN-MAJOR pairing agrees with the
images; that is a property of this synthetic data only. Control endpoints:
    /__stub/throttle?n=3&retry=1   the next n well requests answer 429 with that Retry-After
    /__stub/fail?w=9-1_C5          that well answers 404 from now on
    /__stub/stats                  JSON counters
"""
from __future__ import annotations

import argparse
import io
import json
import re
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from PIL import Image

ROWS, COLS = 12, 32
PLATES = ("9-1", "9-2")
W, H = 64, 48
STATE = {"throttle": 0, "retry": 1, "served": 0, "hit": 0, "miss": 0, "t429": 0, "fail": set(), "seen": set(), "max_live": 0, "live": 0}
LOCK = threading.Lock()


def wnum(r, c):  # column-major image number, 0-based
    return c * ROWS + r


def nf(plate, r, c):
    n = wnum(r, c) + (0 if plate == "9-1" else 97)
    N = 4 + (n * 7) % 13  # 4..16 nuclei
    F = (N * (1 + (n * 5) % 4)) // 2  # foci, correlated with N but not equal to it
    return N, F


def well_name(r, c):
    return f"{chr(65 + r)}{c + 1}"


def png(plate, r, c, ch):
    N, F = nf(plate, r, c)
    k = N if ch == "dna" else F
    img = Image.new("L", (W, H), 20)
    px = img.load()
    for i in range(min(k, 48)):
        x, y = 4 + (i % 8) * 8, 4 + (i // 8) * 8
        for dx in range(-2, 3):
            for dy in range(-2, 3):
                px[x + dx, y + dy] = 150
        px[x, y] = 255
    b = io.BytesIO()
    img.convert("RGB").save(b, "PNG")
    return b.getvalue()


def write_data(web: Path):
    d = web / "data" / "downloads"
    d.mkdir(parents=True, exist_ok=True)
    lines = ["plate_well,gene,ensembl,sirna,sense,antisense,cells,fpc,norm_fpc,z,qc,imaged,gene_status"]
    controls = {}
    for plate in PLATES:
        ctl = {}
        for r in range(ROWS):
            for c in range(COLS):
                # annotation Well Number = c*12 + r + 1 (row-major naming): the row the COLUMN-MAJOR pairing assigns to image (r, c)
                n = wnum(r, c)
                ar, ac = divmod(n, COLS)
                name = well_name(ar, ac)
                N, F = nf(plate, r, c)
                if name in ("A4", "B7"):
                    ctl[name] = ["p" if name == "A4" else "n", 100, 1.5, 1 if name == "A4" else 0]
                    continue
                qc = "remove" if (n % 11 == 0) else "pass"
                gene = 'G"%d,x' % n if n % 50 == 0 else "GENE%d" % n
                cells = N * 10 + (n % 3)
                fpc = round(F / N, 3)
                lines.append(f'{plate}_{name},"{gene.replace(chr(34), chr(34) * 2)}",ENSG{n},{n},s,a,{cells},{fpc},{fpc},0,{qc},true,none')
        controls[plate] = ctl
    (d / "foci_wells.csv").write_text("\n".join(lines) + "\n", encoding="utf-8")
    (web / "data" / "screen_controls.json").write_text(json.dumps({"version": 1, "plates": controls}), encoding="utf-8")


def make_handler(web: Path):
    class Handler(SimpleHTTPRequestHandler):
        def __init__(self, *a, **k):
            super().__init__(*a, directory=str(web), **k)

        def log_message(self, *a):
            pass

        def _json(self, obj, code=200):
            b = json.dumps(obj).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(b)))
            self.end_headers()
            self.wfile.write(b)

        def _text(self, code, msg, extra=()):
            b = msg.encode()
            self.send_response(code)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", str(len(b)))
            for k, v in extra:
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(b)

        def do_GET(self):
            u = urlparse(self.path)
            q = parse_qs(u.query)
            if u.path == "/api/plates.php":
                return self._json({"plates": [{"plate": p, "wells": ROWS * COLS} for p in PLATES], "n": len(PLATES)})
            if u.path == "/api/plate.php":
                p = (q.get("plate") or [""])[0]
                if p not in PLATES:
                    return self._text(404, "plate not imaged in IDR")
                wells = [{"well": well_name(r, c), "plate_well": f"{p}_{well_name(r, c)}", "image_id": 5000 + wnum(r, c)} for c in range(COLS) for r in range(ROWS)]
                return self._json({"plate": p, "wells": wells, "n": len(wells), "rows": ROWS, "cols": COLS,
                                   "quota": {"requests_per_plate": 768, "cached_responses_per_min": 1200, "uncached_responses_per_min": 60, "uncached_responses_per_day": 2000}})
            if u.path == "/api/well.php":
                return self._well(q)
            if u.path == "/__stub/throttle":
                STATE["throttle"] = int((q.get("n") or ["1"])[0])
                STATE["retry"] = int((q.get("retry") or ["1"])[0])
                return self._json({"ok": True})
            if u.path == "/__stub/fail":
                STATE["fail"].add((q.get("w") or [""])[0])
                return self._json({"ok": True})
            if u.path == "/__stub/stats":
                return self._json({k: (sorted(v) if isinstance(v, set) else v) for k, v in STATE.items() if k != "seen"})
            return super().do_GET()

        def _well(self, q):
            w = (q.get("w") or [""])[0]
            ch = (q.get("ch") or [""])[0]
            plate, _, well = w.rpartition("_")
            with LOCK:
                STATE["served"] += 1
                STATE["live"] += 1
                STATE["max_live"] = max(STATE["max_live"], STATE["live"])
            try:
                if STATE["throttle"] > 0:
                    with LOCK:
                        STATE["throttle"] -= 1
                        STATE["t429"] += 1
                    return self._text(429, "too many uncached images requested; slow down", [("Retry-After", str(STATE["retry"]))])
                m = re.fullmatch(r"([A-L])([1-9][0-9]?)", well)
                if plate not in PLATES or ch not in ("dna", "foci") or w in STATE["fail"] or not m or int(m.group(2)) > COLS:
                    return self._text(404, "well not imaged in IDR")
                r, c = ord(m.group(1)) - 65, int(m.group(2)) - 1
                with LOCK:
                    hit = (w, ch) in STATE["seen"]
                    STATE["seen"].add((w, ch))
                    STATE["hit" if hit else "miss"] += 1
                time.sleep(0.004)
                b = png(plate, r, c, ch)
                self.send_response(200)
                self.send_header("Content-Type", "image/png")
                self.send_header("Content-Length", str(len(b)))
                self.send_header("X-Foci-Cache", "HIT" if hit else "MISS")
                self.end_headers()
                self.wfile.write(b)
            finally:
                with LOCK:
                    STATE["live"] -= 1

        def end_headers(self):
            self.send_header("Cache-Control", "no-store")
            super().end_headers()

    return Handler


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--web", required=True)
    ap.add_argument("--port", type=int, default=8765)
    a = ap.parse_args()
    web = Path(a.web)
    write_data(web)
    srv = ThreadingHTTPServer(("127.0.0.1", a.port), make_handler(web))
    print(f"stub on http://127.0.0.1:{a.port}/screen.html", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
