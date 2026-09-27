"""Minimal read-only client for the public IDR web API.

Rendered images need a public session cookie (obtained by one GET of the
webclient) and an explicit channel list; each channel is fetched separately as a lossless 8-bit greyscale PNG,
linearly windowed from the channel minimum to the curators' display maximum
(the brightest pixels saturate; the dim majority of nuclei keep their range).
"""

from __future__ import annotations

import io
import json
import urllib.request
from http.cookiejar import CookieJar
from typing import Dict, List

import numpy as np
from PIL import Image

BASE = "https://idr.openmicroscopy.org"
SCREEN_ID = 1351  # idr0010-doil-dnadamage/screenA
UA = "TelomereLab-FociLab/1.0 (+https://github.com/Alphine/telomore)"


class IdrClient:
    def __init__(self, base: str = BASE, timeout: float = 60.0):
        self.base = base
        self.timeout = timeout
        self._opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(CookieJar()))
        self._opener.addheaders = [("User-Agent", UA)]
        self._session = False

    def _get(self, path: str) -> bytes:
        with self._opener.open(self.base + path, timeout=self.timeout) as r:
            return r.read()

    def json(self, path: str):
        return json.loads(self._get(path))

    def ensure_session(self) -> None:
        if not self._session:
            self._get("/webclient/?experimenter=-1")
            self._session = True

    def image_meta(self, image_id: int) -> Dict:
        return self.json(f"/webgateway/imgData/{int(image_id)}/")

    def image_annotations(self, image_id: int) -> Dict[str, str]:
        out: Dict[str, str] = {}
        for ann in self.json(f"/webclient/api/annotations/?type=map&image={int(image_id)}")["annotations"]:
            for k, v in ann["values"]:
                out.setdefault(k, v)
        return out

    def channel_png(self, image_id: int, channel: int, lo: float, hi: float) -> np.ndarray:
        self.ensure_session()
        q = f"c={channel}|{lo:.0f}:{hi:.0f}$FFFFFF&m=g&format=png"
        raw = self._get(f"/webgateway/render_image/{int(image_id)}/0/0/?{q}")
        return np.asarray(Image.open(io.BytesIO(raw)).convert("L"), dtype=np.float32)

    def plates(self, screen_id: int = SCREEN_ID) -> List[Dict]:
        out, off = [], 0
        while True:
            d = self.json(f"/api/v0/m/screens/{screen_id}/plates/?limit=200&offset={off}")
            out += d["data"]
            off += 200
            if off >= d["meta"]["totalCount"]:
                return out

    def plate_wells(self, plate_id: int) -> List[Dict]:
        out, off = [], 0
        while True:
            d = self.json(f"/api/v0/m/plates/{int(plate_id)}/wells/?limit=500&offset={off}")
            out += d["data"]
            off += 500
            if off >= d["meta"]["totalCount"]:
                return out


def fetch_image_channels(client: IdrClient, image_id: int):
    """(dna, foci) float arrays in 0..255 plus the image's channel metadata."""
    meta = client.image_meta(image_id)
    chans = meta["channels"]
    if len(chans) < 2:
        raise ValueError("expected a DNA channel and a 53BP1 channel")
    arrs = []
    for i, c in enumerate(chans[:2], start=1):
        w = c["window"]
        arrs.append(client.channel_png(image_id, i, w["min"], w["end"]))
    return arrs[0], arrs[1], meta
