"""Generate the small image fixtures used by foci/tests/io-*.test.mjs.

Run:  python foci/tests/fixtures/io_gen.py

Writes io_*.png / io_*.tif / io_*.zip next to this script plus io_expected.json (the pixel values each
file must decode to). The TIFF and PNG writers below are independent of the JavaScript decoders; a few
files are additionally written with PIL/libtiff as a cross-check (LZW, Deflate, PackBits, 16-bit).
Output is deterministic (fixed seeds), so regenerating produces identical bytes.
"""
import io
import json
import os
import struct
import sys
import zipfile
import zlib

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
W, H = 37, 29           # odd sizes exercise strip and tile edges
DATASETS = {}
FILES = {}


# ----------------------------------------------------------------------------- datasets
def dataset(name, kind, seed, w=W, h=H):
    rng = np.random.default_rng(seed)
    yy, xx = np.mgrid[0:h, 0:w]
    base = (xx * 5 + yy * 3 + (xx * yy) % 11) % 97
    noise = rng.integers(0, 29, size=(h, w))
    a = base + noise
    if kind == "u8":
        arr = (a * 2).astype(np.uint8)
    elif kind == "u16":
        arr = (a * 600 + rng.integers(0, 500, size=(h, w))).astype(np.uint16)
        arr[0, 0], arr[0, 1] = 0, 65535
    elif kind == "u12":
        arr = (a * 30 + rng.integers(0, 20, size=(h, w))).astype(np.uint16)
        arr[0, 0], arr[0, 1] = 0, 4095
    elif kind == "i16":
        arr = (a * 300 - 9000 + rng.integers(0, 50, size=(h, w))).astype(np.int16)
    elif kind == "i8":
        arr = (a - 60).astype(np.int8)
    elif kind == "u32":
        arr = (a.astype(np.uint64) * 70000 + 5).astype(np.uint32)
    elif kind == "f32":
        arr = (a * 0.37 - 4.25 + rng.random((h, w))).astype(np.float32)
    elif kind == "f64":
        arr = (a * 0.37 - 4.25 + rng.random((h, w))).astype(np.float64)
    else:
        raise ValueError(kind)
    DATASETS[name] = arr
    return arr


for i in range(3):
    dataset("u8_%d" % i, "u8", 10 + i)
    dataset("u16_%d" % i, "u16", 20 + i)
dataset("u12_0", "u12", 31)
dataset("u12_1", "u12", 32)
dataset("i16_0", "i16", 41)
dataset("i8_0", "i8", 42)
dataset("u32_0", "u32", 43)
dataset("f32_0", "f32", 44)
dataset("f64_0", "f64", 45)
dataset("noise8", "u8", 99, 128, 96)
DATASETS["noise8"] = np.random.default_rng(7).integers(0, 256, size=(96, 128)).astype(np.uint8)


def exp_value(a):
    """Expected decoded values as a JSON-able list (what the JS decoder must return)."""
    if a.dtype == np.float64:
        a = a.astype(np.float32)
    if a.dtype in (np.int16, np.int8, np.uint32):
        a = a.astype(np.float32)
    return a.reshape(-1).tolist()


def bit_depth_of(a, declared=None):
    if declared:
        return declared
    if a.dtype == np.uint8:
        return 8
    if a.dtype == np.uint16:
        return 16
    return 32


def add_expected(fname, fmt, channels, pixel_size=None, warn=None, **extra):
    """channels: list of (name, dataset_id, bitDepth)."""
    e = {"format": fmt, "channels": [{"name": n, "ds": d, "bitDepth": b} for n, d, b in channels],
         "pixelSizeUm": pixel_size, "warn": warn or []}
    e.update(extra)
    FILES[fname] = e


# ----------------------------------------------------------------------------- PNG writer
def png_chunk(t, d):
    c = struct.pack(">I", len(d)) + t + d
    return c + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)


def filt_row(ft, row, prev, bpp):
    row = row.astype(np.int32)
    prev = prev.astype(np.int32)
    out = np.zeros_like(row)
    n = len(row)
    for i in range(n):
        a = row[i - bpp] if i >= bpp else 0
        b = prev[i]
        c = prev[i - bpp] if i >= bpp else 0
        if ft == 0:
            p = 0
        elif ft == 1:
            p = a
        elif ft == 2:
            p = b
        elif ft == 3:
            p = (a + b) // 2
        else:
            pp = a + b - c
            pa, pb, pc = abs(pp - a), abs(pp - b), abs(pp - c)
            p = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
        out[i] = (row[i] - p) & 255
    return out.astype(np.uint8)


def png_scanlines(rows_bytes, bpp):
    """rows_bytes: list of uint8 arrays. Cycles through all five filter types."""
    out = bytearray()
    prev = np.zeros_like(rows_bytes[0])
    for i, r in enumerate(rows_bytes):
        ft = i % 5
        out.append(ft)
        out += filt_row(ft, r, prev, bpp).tobytes()
        prev = r
    return bytes(out)


def pack_rows(arr2d, depth, ct_spp):
    """arr2d: (h, w*spp) integer samples -> list of packed rows of bytes."""
    rows = []
    for r in arr2d:
        if depth == 8:
            rows.append(r.astype(np.uint8))
        elif depth == 16:
            rows.append(r.astype(">u2").view(np.uint8))
        else:
            bits = np.unpackbits(r.astype(np.uint8)[:, None], axis=1)[:, 8 - depth:].reshape(-1)
            pad = (-len(bits)) % 8
            bits = np.concatenate([bits, np.zeros(pad, np.uint8)])
            rows.append(np.packbits(bits))
    return rows


PASSES = [(0, 0, 8, 8), (4, 0, 8, 8), (0, 4, 4, 8), (2, 0, 4, 4), (0, 2, 2, 4), (1, 0, 2, 2), (0, 1, 1, 2)]


def write_png(path, arr, ct, depth, interlace=False, phys=None, plte=None):
    """arr: (h, w) or (h, w, spp) integer array already in PNG sample layout."""
    h, w = arr.shape[:2]
    spp = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[ct]
    a = arr.reshape(h, w, spp)
    bpp = max(1, spp * depth // 8)
    if interlace:
        raw = b""
        for x0, y0, dx, dy in PASSES:
            sub = a[y0::dy, x0::dx, :]
            if sub.shape[0] == 0 or sub.shape[1] == 0:
                continue
            raw += png_scanlines(pack_rows(sub.reshape(sub.shape[0], -1), depth, spp), bpp)
    else:
        raw = png_scanlines(pack_rows(a.reshape(h, -1), depth, spp), bpp)
    # split IDAT in two to exercise chunk concatenation
    z = zlib.compress(raw, 6)
    half = max(1, len(z) // 2)
    data = b"\x89PNG\r\n\x1a\n" + png_chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, depth, ct, 0, 0, 1 if interlace else 0))
    if plte is not None:
        data += png_chunk(b"PLTE", bytes(plte))
    if phys:
        data += png_chunk(b"pHYs", struct.pack(">IIB", phys, phys, 1))
    data += png_chunk(b"IDAT", z[:half]) + png_chunk(b"IDAT", z[half:]) + png_chunk(b"IEND", b"")
    with open(os.path.join(HERE, path), "wb") as f:
        f.write(data)


# ----------------------------------------------------------------------------- TIFF writer
def lzw_encode(data):
    out, acc, nacc = bytearray(), 0, 0

    def emit(code, bits):
        nonlocal acc, nacc
        acc = (acc << bits) | code
        nacc += bits
        while nacc >= 8:
            out.append((acc >> (nacc - 8)) & 255)
            nacc -= 8
        acc &= (1 << nacc) - 1

    table, nxt, bits = {}, 258, 9
    emit(256, bits)
    w = None
    for b in data:
        if w is None:
            w = b
            continue
        key = (w, b)
        if key in table:
            w = table[key]
            continue
        emit(w, bits)
        table[key] = nxt
        nxt += 1
        if nxt == 4094:
            emit(256, bits)
            table, nxt, bits = {}, 258, 9
        elif nxt > (1 << bits) - 1:
            bits += 1
        w = b
    if w is not None:
        emit(w, bits)
        nxt += 1
        if nxt == 4094:
            emit(256, bits)
            bits = 9
        elif nxt > (1 << bits) - 1:
            bits += 1
    emit(257, bits)
    if nacc:
        out.append((acc << (8 - nacc)) & 255)
    return bytes(out)


def packbits_encode(data):
    out, i, n = bytearray(), 0, len(data)
    while i < n:
        j = i
        while j + 1 < n and data[j + 1] == data[i] and j - i < 127:
            j += 1
        run = j - i + 1
        if run >= 3:
            out += bytes([(257 - run) & 255, data[i]])
            i = j + 1
        else:
            k = i
            while k < n and k - i < 128 and not (k + 2 < n and data[k] == data[k + 1] == data[k + 2]):
                k += 1
            if k == i:
                k = i + 1
            out += bytes([k - i - 1]) + bytes(data[i:k])
            i = k
    return bytes(out)


def pack_bits_msb(vals, depth):
    bits = ((vals[:, None].astype(np.uint32) >> np.arange(depth - 1, -1, -1)) & 1).astype(np.uint8).reshape(-1)
    pad = (-len(bits)) % 8
    return np.packbits(np.concatenate([bits, np.zeros(pad, np.uint8)])).tobytes()


class Tiff:
    def __init__(self, le=True, big=False):
        self.le, self.big = le, big
        self.e = "<" if le else ">"
        self.buf = bytearray(b"II" if le else b"MM")
        if big:
            self.buf += struct.pack(self.e + "HHHH", 43, 8, 0, 0) + b"\0" * 8
            self.first_ptr, self.osz = 8, 8
        else:
            self.buf += struct.pack(self.e + "HI", 42, 0)
            self.first_ptr, self.osz = 4, 4
        self.prev_next = None

    def align(self):
        if len(self.buf) % 2:
            self.buf += b"\0"

    def off(self, v):
        return struct.pack(self.e + ("Q" if self.big else "I"), v)

    def add_page(self, tags, chunk_bytes, offsets_tag, counts_tag, cycle_to=None):
        """tags: list of (tag, type, [values]); chunk_bytes: list of bytes (written in order)."""
        offs, cnts = [], []
        for c in chunk_bytes:
            self.align()
            offs.append(len(self.buf))
            cnts.append(len(c))
            self.buf += c
        tags = list(tags) + [(offsets_tag, 16 if self.big else 4, offs), (counts_tag, 16 if self.big else 4, cnts)]
        tags.sort(key=lambda t: t[0])
        fmts = {1: "B", 2: "c", 3: "H", 4: "I", 5: "II", 7: "B", 11: "f", 12: "d", 16: "Q"}
        sizes = {1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 11: 4, 12: 8, 16: 8}
        entries = []
        inline = 8 if self.big else 4
        for tag, typ, vals in tags:
            if typ == 2:
                raw = vals.encode("utf-8") + b"\0"
                count = len(raw)
            elif typ == 5:
                raw = b"".join(struct.pack(self.e + "II", a, b) for a, b in vals)
                count = len(vals)
            else:
                raw = b"".join(struct.pack(self.e + fmts[typ], v) for v in vals)
                count = len(vals)
            if len(raw) <= inline:
                val = raw + b"\0" * (inline - len(raw))
            else:
                self.align()
                val = self.off(len(self.buf))
                self.buf += raw
            cnt = struct.pack(self.e + ("Q" if self.big else "I"), count)
            entries.append(struct.pack(self.e + "HH", tag, typ) + cnt + val)
        self.align()
        ifd_pos = len(self.buf)
        head = struct.pack(self.e + ("Q" if self.big else "H"), len(entries))
        self.buf += head + b"".join(entries)
        nxt_pos = len(self.buf)
        self.buf += self.off(0)
        ptr = self.first_ptr if self.prev_next is None else self.prev_next
        self.buf[ptr:ptr + self.osz] = self.off(ifd_pos)
        self.prev_next = nxt_pos
        if cycle_to is not None:
            self.buf[nxt_pos:nxt_pos + self.osz] = self.off(cycle_to)
        return ifd_pos

    def save(self, name):
        with open(os.path.join(HERE, name), "wb") as f:
            f.write(bytes(self.buf))


def compress(kind, data):
    if kind == "none":
        return data
    if kind == "lzw":
        return lzw_encode(data)
    if kind == "deflate":
        return zlib.compress(data, 6)
    if kind == "packbits":
        return packbits_encode(data)
    raise ValueError(kind)


COMP_CODE = {"none": 1, "lzw": 5, "deflate": 8, "packbits": 32773}


def region_bytes(reg, depth, sfmt, le, predictor):
    """reg: (rows, cols, spp) or planar (rows, cols) array -> encoded bytes (before compression)."""
    a = reg.copy()
    if predictor == 2:
        d = a.copy()
        d[:, 1:] = (a[:, 1:].astype(np.int64) - a[:, :-1].astype(np.int64)).astype(a.dtype)
        a = d
    if 8 < depth < 16:
        return b"".join(pack_bits_msb(row.reshape(-1), depth) for row in a)
    dt = a.dtype.newbyteorder("<" if le else ">")
    return a.astype(dt).tobytes()


def write_tiff(name, pages, le=True, big=False, compression="none", predictor=1, tile=None, rps=None,
               planar=1, depth=None, photo=1, desc=None, xres=None, resunit=None, cycle=False, subfile=None,
               extra=None, raw_override=None):
    """pages: list of arrays, (h, w) or (h, w, spp). depth overrides BitsPerSample (for 12-bit)."""
    t = Tiff(le, big)
    first_ifd = None
    for pi, arr in enumerate(pages):
        h, w = arr.shape[:2]
        a = arr.reshape(h, w, -1)
        spp = a.shape[2]
        dt = a.dtype
        d = depth or dt.itemsize * 8
        sfmt = 3 if dt.kind == "f" else (2 if dt.kind == "i" else 1)
        chunks = []
        if tile:
            tw, tl = tile
            planes = [a] if planar == 1 else [a[:, :, s:s + 1] for s in range(spp)]
            for pl in planes:
                for ty in range(0, h, tl):
                    for tx in range(0, w, tw):
                        reg = np.zeros((tl, tw, pl.shape[2]), dt)
                        sub = pl[ty:ty + tl, tx:tx + tw]
                        reg[:sub.shape[0], :sub.shape[1]] = sub
                        chunks.append(compress(compression, region_bytes(reg, d, sfmt, le, predictor)))
            layout_tags = [(322, 3, [tw]), (323, 3, [tl])]
            ot, ct = 324, 325
        else:
            r = rps or h
            planes = [a] if planar == 1 else [a[:, :, s:s + 1] for s in range(spp)]
            for pl in planes:
                for y in range(0, h, r):
                    chunks.append(compress(compression, region_bytes(pl[y:y + r], d, sfmt, le, predictor)))
            layout_tags = [(278, 4, [r])]
            ot, ct = 273, 279
        if raw_override is not None:
            chunks = raw_override
        tags = [(256, 4, [w]), (257, 4, [h]), (258, 3, [d] * spp), (259, 3, [COMP_CODE[compression]]),
                (262, 3, [photo if spp != 3 or photo != 1 else 2]), (277, 3, [spp]), (284, 3, [planar]),
                (339, 3, [sfmt] * spp)] + layout_tags
        if predictor != 1:
            tags.append((317, 3, [predictor]))
        if spp > 3:
            tags.append((338, 3, [2] * (spp - 3)))
        if pi == 0 and desc:
            tags.append((270, 2, desc))
        if xres:
            tags += [(282, 5, [xres]), (283, 5, [xres]), (296, 3, [resunit])]
        if subfile is not None and pi in subfile:
            tags.append((254, 4, [subfile[pi]]))
        if extra:
            tags += extra
        pos = t.add_page(tags, chunks, ot, ct, cycle_to=first_ifd if (cycle and pi == len(pages) - 1) else None)
        if first_ifd is None:
            first_ifd = pos
    t.save(name)
    return t


def ome_xml(names, size_c, size_z=1, size_t=1, order="XYCZT", psx=None, unit=None, le=True, w=W, h=H, extra_image=False):
    chans = "".join('<Channel ID="Channel:0:%d" Name="%s" SamplesPerPixel="1"/>' % (i, n) for i, n in enumerate(names))
    ps = ""
    if psx is not None:
        ps = ' PhysicalSizeX="%s" PhysicalSizeY="%s"' % (psx, psx)
        if unit:
            ps += ' PhysicalSizeXUnit="%s" PhysicalSizeYUnit="%s"' % (unit, unit)
    tiffdata = "".join('<TiffData IFD="%d" PlaneCount="1"/>' % i for i in range(size_c * size_z * size_t))
    more = ('<Image ID="Image:1"><Pixels ID="Pixels:1" DimensionOrder="XYZCT" Type="uint16" SizeX="%d" SizeY="%d" SizeZ="1" SizeC="1" SizeT="1"><Channel ID="Channel:1:0" Name="other"/></Pixels></Image>' % (w, h)) if extra_image else ""
    return ('<?xml version="1.0" encoding="UTF-8"?><OME xmlns="http://www.openmicroscopy.org/Schemas/OME/2016-06">'
            '<Image ID="Image:0" Name="x"><Pixels ID="Pixels:0" DimensionOrder="%s" Type="uint16" SizeX="%d" SizeY="%d" SizeZ="%d" SizeC="%d" SizeT="%d" BigEndian="%s"%s>%s%s</Pixels></Image>%s</OME>'
            % (order, w, h, size_z, size_c, size_t, "false" if le else "true", ps, chans, tiffdata, more))


# ----------------------------------------------------------------------------- build fixtures
def main():
    D = DATASETS
    # ---- PNG (own writer; every filter type; split IDAT)
    write_png("io_png_gray8.png", D["u8_0"], 0, 8)
    add_expected("io_png_gray8.png", "png", [("Gray", "u8_0", 8)])
    write_png("io_png_gray16.png", D["u16_0"], 0, 16, phys=2000)   # 2000 px per metre -> 500 um
    add_expected("io_png_gray16.png", "png", [("Gray", "u16_0", 16)], pixel_size=500.0)
    write_png("io_png_gray16_adam7.png", D["u16_1"], 0, 16, interlace=True)
    add_expected("io_png_gray16_adam7.png", "png", [("Gray", "u16_1", 16)])
    rgb8 = np.stack([D["u8_0"], D["u8_1"], D["u8_2"]], axis=2)
    write_png("io_png_rgb8.png", rgb8, 2, 8)
    add_expected("io_png_rgb8.png", "png", [("Red", "u8_0", 8), ("Green", "u8_1", 8), ("Blue", "u8_2", 8)])
    write_png("io_png_rgb8_adam7.png", rgb8, 2, 8, interlace=True)
    add_expected("io_png_rgb8_adam7.png", "png", [("Red", "u8_0", 8), ("Green", "u8_1", 8), ("Blue", "u8_2", 8)])
    rgb16 = np.stack([D["u16_0"], D["u16_1"], D["u16_2"]], axis=2)
    write_png("io_png_rgb16.png", rgb16, 2, 16)
    add_expected("io_png_rgb16.png", "png", [("Red", "u16_0", 16), ("Green", "u16_1", 16), ("Blue", "u16_2", 16)])
    rgba = np.stack([D["u8_0"], D["u8_1"], D["u8_2"], np.full((H, W), 200, np.uint8)], axis=2)
    write_png("io_png_rgba8.png", rgba, 6, 8)
    add_expected("io_png_rgba8.png", "png", [("Red", "u8_0", 8), ("Green", "u8_1", 8), ("Blue", "u8_2", 8)], warn=["transparency"])
    ga = np.stack([D["u8_1"], np.full((H, W), 255, np.uint8)], axis=2)
    write_png("io_png_graya8.png", ga, 4, 8)
    add_expected("io_png_graya8.png", "png", [("Gray", "u8_1", 8)])
    # palette: grey palette and colour palette (8-bit indices)
    idx = (D["u8_0"] % 16).astype(np.uint8)
    DATASETS["pal_idx"] = idx
    grey_pal = [v for i in range(16) for v in (i * 17, i * 17, i * 17)]
    write_png("io_png_palette_grey.png", idx, 3, 8, plte=grey_pal)
    DATASETS["pal_grey"] = (idx.astype(np.uint16) * 17).astype(np.uint8)
    add_expected("io_png_palette_grey.png", "png", [("Gray", "pal_grey", 8)], warn=["palette"])
    col_pal = [v for i in range(16) for v in (i * 16, 255 - i * 16, (i * 7) % 256)]
    write_png("io_png_palette_colour.png", idx, 3, 8, plte=col_pal)
    cp = np.array(col_pal, np.uint8).reshape(16, 3)
    for c in range(3):
        DATASETS["pal_c%d" % c] = cp[idx, c]
    add_expected("io_png_palette_colour.png", "png", [("Red", "pal_c0", 8), ("Green", "pal_c1", 8), ("Blue", "pal_c2", 8)], warn=["palette"])
    # 4-bit grey -> scaled to 0..255
    g4 = (D["u8_2"] % 16).astype(np.uint8)
    write_png("io_png_gray4.png", g4, 0, 4)
    DATASETS["g4_scaled"] = (g4.astype(np.uint16) * 17).astype(np.uint8)
    add_expected("io_png_gray4.png", "png", [("Gray", "g4_scaled", 8)], warn=["scaled"])
    # PIL cross-checks (libtiff / libpng made)
    Image.fromarray(D["u16_2"]).save(os.path.join(HERE, "io_png_gray16_pil.png"))
    add_expected("io_png_gray16_pil.png", "png", [("Gray", "u16_2", 16)])
    Image.fromarray(D["u8_2"], "L").save(os.path.join(HERE, "io_png_gray8_pil.png"), optimize=True)
    add_expected("io_png_gray8_pil.png", "png", [("Gray", "u8_2", 8)])
    Image.fromarray(D["noise8"], "L").save(os.path.join(HERE, "io_tiff_lzw_pil_noise.tif"), compression="tiff_lzw")
    add_expected("io_tiff_lzw_pil_noise.tif", "tiff", [("Channel 1", "noise8", 8)])
    Image.fromarray(D["noise8"], "L").save(os.path.join(HERE, "io_tiff_deflate_pil_noise.tif"), compression="tiff_adobe_deflate")
    add_expected("io_tiff_deflate_pil_noise.tif", "tiff", [("Channel 1", "noise8", 8)])
    Image.fromarray(D["noise8"], "L").save(os.path.join(HERE, "io_tiff_packbits_pil_noise.tif"), compression="packbits")
    add_expected("io_tiff_packbits_pil_noise.tif", "tiff", [("Channel 1", "noise8", 8)])
    Image.fromarray(D["u16_0"]).save(os.path.join(HERE, "io_tiff_u16_pil.tif"))
    add_expected("io_tiff_u16_pil.tif", "tiff", [("Channel 1", "u16_0", 16)])
    Image.fromarray(D["u16_1"]).save(os.path.join(HERE, "io_tiff_u16_lzw_pil.tif"), compression="tiff_lzw")
    add_expected("io_tiff_u16_lzw_pil.tif", "tiff", [("Channel 1", "u16_1", 16)])
    Image.fromarray(D["u8_1"], "L").save(os.path.join(HERE, "io_jpeg_gray.jpg"), quality=95)
    add_expected("io_jpeg_gray.jpg", "jpeg", [], lossy=True)

    # ---- TIFF matrix: compression x endianness, strips
    for comp in ("none", "lzw", "deflate", "packbits"):
        for le in (True, False):
            n = "io_tiff_u16_%s_%s.tif" % (comp, "le" if le else "be")
            write_tiff(n, [D["u16_0"]], le=le, compression=comp, rps=7)
            add_expected(n, "tiff", [("Channel 1", "u16_0", 16)])
    for comp in ("lzw", "deflate"):
        for le in (True, False):
            n = "io_tiff_u16_%s_pred2_%s.tif" % (comp, "le" if le else "be")
            write_tiff(n, [D["u16_1"]], le=le, compression=comp, predictor=2, rps=8)
            add_expected(n, "tiff", [("Channel 1", "u16_1", 16)])
    write_tiff("io_tiff_u8_pred2_lzw.tif", [D["u8_1"]], compression="lzw", predictor=2)
    add_expected("io_tiff_u8_pred2_lzw.tif", "tiff", [("Channel 1", "u8_1", 8)])
    # tiles (edge tiles are partial: 37x29 with 16x16 tiles)
    for comp in ("none", "lzw", "deflate", "packbits"):
        n = "io_tiff_u16_tiled_%s.tif" % comp
        write_tiff(n, [D["u16_2"]], compression=comp, tile=(16, 16))
        add_expected(n, "tiff", [("Channel 1", "u16_2", 16)])
    write_tiff("io_tiff_u16_tiled_pred2_be.tif", [D["u16_2"]], le=False, compression="deflate", predictor=2, tile=(32, 16))
    add_expected("io_tiff_u16_tiled_pred2_be.tif", "tiff", [("Channel 1", "u16_2", 16)])
    # BigTIFF
    write_tiff("io_tiff_big_u16_lzw.tif", [D["u16_0"]], big=True, compression="lzw", rps=10)
    add_expected("io_tiff_big_u16_lzw.tif", "bigtiff", [("Channel 1", "u16_0", 16)])
    write_tiff("io_tiff_big_u16_be.tif", [D["u16_0"]], big=True, le=False, compression="deflate", tile=(16, 16))
    add_expected("io_tiff_big_u16_be.tif", "bigtiff", [("Channel 1", "u16_0", 16)])
    # sample types
    write_tiff("io_tiff_u8.tif", [D["u8_0"]], rps=5)
    add_expected("io_tiff_u8.tif", "tiff", [("Channel 1", "u8_0", 8)])
    write_tiff("io_tiff_u12_packed.tif", [D["u12_0"]], depth=12, rps=6)
    add_expected("io_tiff_u12_packed.tif", "tiff", [("Channel 1", "u12_0", 12)], warn=["Packed 12-bit"])
    write_tiff("io_tiff_u12_packed_lzw_be.tif", [D["u12_1"]], depth=12, le=False, compression="lzw", tile=(16, 16))
    add_expected("io_tiff_u12_packed_lzw_be.tif", "tiff", [("Channel 1", "u12_1", 12)], warn=["Packed 12-bit"])
    for nm, dsn in (("i16", "i16_0"), ("i8", "i8_0"), ("u32", "u32_0"), ("f32", "f32_0"), ("f64", "f64_0")):
        for le in (True, False):
            n = "io_tiff_%s_%s.tif" % (nm, "le" if le else "be")
            write_tiff(n, [D[dsn]], le=le, compression="deflate" if nm != "f64" else "none", rps=9)
            add_expected(n, "tiff", [("Channel 1", dsn, 32)], warn=["converted"] if nm != "f32" else [])
    write_tiff("io_tiff_u32_pred2.tif", [D["u32_0"]], compression="lzw", predictor=2)
    add_expected("io_tiff_u32_pred2.tif", "tiff", [("Channel 1", "u32_0", 32)], warn=["converted"])
    # multi-sample: RGB chunky, planar, RGB planar + predictor
    write_tiff("io_tiff_rgb16_chunky.tif", [rgb16], compression="lzw", rps=11)
    add_expected("io_tiff_rgb16_chunky.tif", "tiff", [("Red", "u16_0", 16), ("Green", "u16_1", 16), ("Blue", "u16_2", 16)])
    write_tiff("io_tiff_rgb16_chunky_pred2.tif", [rgb16], compression="deflate", predictor=2, tile=(16, 16), le=False)
    add_expected("io_tiff_rgb16_chunky_pred2.tif", "tiff", [("Red", "u16_0", 16), ("Green", "u16_1", 16), ("Blue", "u16_2", 16)])
    write_tiff("io_tiff_rgb16_planar.tif", [rgb16], planar=2, compression="deflate", rps=10)
    add_expected("io_tiff_rgb16_planar.tif", "tiff", [("Red", "u16_0", 16), ("Green", "u16_1", 16), ("Blue", "u16_2", 16)])
    write_tiff("io_tiff_rgb8_planar_pred2_tiled.tif", [rgb8], planar=2, compression="lzw", predictor=2, tile=(16, 16))
    add_expected("io_tiff_rgb8_planar_pred2_tiled.tif", "tiff", [("Red", "u8_0", 8), ("Green", "u8_1", 8), ("Blue", "u8_2", 8)])
    # multi-page (2 and 3 pages, mixed compression per file)
    write_tiff("io_tiff_multipage3_u16.tif", [D["u16_0"], D["u16_1"], D["u16_2"]], compression="lzw", rps=13)
    add_expected("io_tiff_multipage3_u16.tif", "tiff", [("Channel 1", "u16_0", 16), ("Channel 2", "u16_1", 16), ("Channel 3", "u16_2", 16)])
    write_tiff("io_tiff_multipage2_be.tif", [D["u8_0"], D["u8_1"]], le=False, compression="packbits")
    add_expected("io_tiff_multipage2_be.tif", "tiff", [("Channel 1", "u8_0", 8), ("Channel 2", "u8_1", 8)])
    # resolution tags: 20000 px/cm -> 0.5 um ; inch 50800 -> 0.5 um ; 72 dpi ignored
    write_tiff("io_tiff_res_cm.tif", [D["u16_0"]], xres=(20000, 1), resunit=3)
    add_expected("io_tiff_res_cm.tif", "tiff", [("Channel 1", "u16_0", 16)], pixel_size=0.5)
    write_tiff("io_tiff_res_inch.tif", [D["u16_0"]], xres=(50800, 1), resunit=2)
    add_expected("io_tiff_res_inch.tif", "tiff", [("Channel 1", "u16_0", 16)], pixel_size=0.5)
    write_tiff("io_tiff_res_72dpi.tif", [D["u16_0"]], xres=(72, 1), resunit=2)
    add_expected("io_tiff_res_72dpi.tif", "tiff", [("Channel 1", "u16_0", 16)], pixel_size=None, warn=["dpi"])
    # WhiteIsZero
    write_tiff("io_tiff_whiteiszero.tif", [D["u8_0"]], photo=0)
    DATASETS["u8_0_inv"] = (255 - D["u8_0"].astype(np.int32)).astype(np.uint8)
    add_expected("io_tiff_whiteiszero.tif", "tiff", [("Channel 1", "u8_0_inv", 8)], warn=["WhiteIsZero"])
    # ImageJ description with unit (resolution 2 px/um -> 0.5 um)
    ij = "ImageJ=1.53t\nimages=2\nchannels=2\nunit=\\u00B5m\n"
    write_tiff("io_tiff_imagej.tif", [D["u16_0"], D["u16_1"]], desc=ij, xres=(2, 1), resunit=1)
    add_expected("io_tiff_imagej.tif", "tiff", [("Channel 1", "u16_0", 16), ("Channel 2", "u16_1", 16)], pixel_size=0.5)
    # reduced-resolution pages are skipped
    write_tiff("io_tiff_reduced_page.tif", [D["u16_0"], D["u16_1"][:14, :18]], subfile={1: 1}, compression="deflate")
    add_expected("io_tiff_reduced_page.tif", "tiff", [("Channel 1", "u16_0", 16)], warn=["reduced-resolution"])
    # cyclic IFD chain
    write_tiff("io_tiff_cycle.tif", [D["u16_0"], D["u16_1"]], cycle=True)
    add_expected("io_tiff_cycle.tif", "tiff", [("Channel 1", "u16_0", 16), ("Channel 2", "u16_1", 16)], warn=["loops back"])

    # ---- OME-TIFF
    names = ["DAPI", "53BP1"]
    x = ome_xml(names, 2, psx="0.325", unit="\u00b5m")
    write_tiff("io_ome_2c_le.ome.tif", [D["u16_0"], D["u16_1"]], desc=x, compression="deflate", rps=9)
    add_expected("io_ome_2c_le.ome.tif", "ome-tiff", [("DAPI", "u16_0", 16), ("53BP1", "u16_1", 16)], pixel_size=0.325)
    x = ome_xml(["Hoechst &amp; &lt;b&gt;", "gH2AX"], 2, psx="325", unit="nm", le=False)
    write_tiff("io_ome_2c_be.ome.tif", [D["u16_0"], D["u16_1"]], le=False, desc=x, compression="lzw", tile=(16, 16))
    add_expected("io_ome_2c_be.ome.tif", "ome-tiff", [("Hoechst & b", "u16_0", 16), ("gH2AX", "u16_1", 16)], pixel_size=0.325)
    x = ome_xml(["A", "B"], 2, size_z=2, order="XYZCT", psx="1", unit="mm")
    write_tiff("io_ome_zstack.ome.tif", [D["u16_0"], D["u16_1"], D["u16_2"], D["u16_0"]], desc=x)
    add_expected("io_ome_zstack.ome.tif", "ome-tiff", [("A z1", "u16_0", 16), ("A z2", "u16_1", 16), ("B z1", "u16_2", 16), ("B z2", "u16_0", 16)], pixel_size=1000.0, warn=["z/time stack"])
    x = ome_xml(["A", "B"], 2, extra_image=True)
    write_tiff("io_ome_two_series.ome.tif", [D["u16_0"], D["u16_1"], D["u16_2"]], desc=x)
    add_expected("io_ome_two_series.ome.tif", "ome-tiff", [("A", "u16_0", 16), ("B", "u16_1", 16)], warn=["image series"])
    x = ome_xml(["A", "B", "C"], 3)
    write_tiff("io_ome_mismatch.ome.tif", [D["u16_0"], D["u16_1"]], desc=x)
    add_expected("io_ome_mismatch.ome.tif", "ome-tiff", [("Channel 1", "u16_0", 16), ("Channel 2", "u16_1", 16)], warn=["does not match"])

    # ---- unsupported TIFFs (expect an error that names the problem)
    write_tiff("io_bad_tiff_jpeg.tif", [D["u8_0"]], extra=[], compression="none")
    # patch compression tag value to 7 (JPEG)
    _patch_tag("io_bad_tiff_jpeg.tif", 259, 7)
    write_tiff("io_bad_tiff_floatpred.tif", [D["f32_0"]], compression="deflate")
    _patch_tag("io_bad_tiff_floatpred.tif", 317, 3, add=True)
    FILES["io_bad_tiff_jpeg.tif"] = {"error": "unsupported", "match": "JPEG"}
    FILES["io_bad_tiff_floatpred.tif"] = {"error": "unsupported", "match": "predictor"}
    # palette-colour tiff
    write_tiff("io_bad_tiff_palette.tif", [D["u8_0"]], photo=3)
    FILES["io_bad_tiff_palette.tif"] = {"error": "unsupported", "match": "palette"}
    # decompression bomb: tiny declared image, strip inflates to 2 MB
    write_tiff("io_bad_tiff_bomb.tif", [D["u8_0"][:8, :8]], compression="deflate", raw_override=[zlib.compress(b"\0" * 2_000_000)])
    FILES["io_bad_tiff_bomb.tif"] = {"error": "bomb|corrupt"}

    # ---- ZIPs
    def put(z, n, data):
        z.writestr(n, data)

    with zipfile.ZipFile(os.path.join(HERE, "io_zip_ok.zip"), "w", zipfile.ZIP_DEFLATED) as z:
        put(z, "set/a_DAPI.png", open(os.path.join(HERE, "io_png_gray16.png"), "rb").read())
        put(z, "set/a_53BP1.tif", open(os.path.join(HERE, "io_tiff_u16_lzw_le.tif"), "rb").read())
        put(z, "__MACOSX/set/._a_DAPI.png", b"junk")
        put(z, "set/readme.txt", b"hello")
        put(z, "set/", b"")
    FILES["io_zip_ok.zip"] = {"zip": ["set/a_DAPI.png", "set/a_53BP1.tif"]}
    with zipfile.ZipFile(os.path.join(HERE, "io_zip_bomb.zip"), "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        put(z, "x.tif", b"\0" * 12_000_000)
    FILES["io_zip_bomb.zip"] = {"error": "bomb"}
    with zipfile.ZipFile(os.path.join(HERE, "io_zip_empty_of_images.zip"), "w") as z:
        put(z, "notes.txt", b"nothing here")
    FILES["io_zip_empty_of_images.zip"] = {"error": "unsupported"}

    # expected datasets (only those referenced)
    used = {c["ds"] for f in FILES.values() for c in f.get("channels", [])}
    out = {"width": W, "height": H, "datasets": {}, "files": FILES}
    for k in sorted(used):
        out["datasets"][k] = {"w": int(DATASETS[k].shape[1]), "h": int(DATASETS[k].shape[0]), "v": exp_value(DATASETS[k])}
    with open(os.path.join(HERE, "io_expected.json"), "w") as f:
        json.dump(out, f, separators=(",", ":"))
    print("wrote", len(FILES), "fixtures,", sum(os.path.getsize(os.path.join(HERE, n)) for n in FILES) // 1024, "KB")


def _patch_tag(name, tag, value, add=False):
    """Overwrite (or, with add=True, rewrite an unused slot of) a SHORT tag value in the first IFD of a classic LE TIFF."""
    p = os.path.join(HERE, name)
    b = bytearray(open(p, "rb").read())
    ifd = struct.unpack("<I", b[4:8])[0]
    n = struct.unpack("<H", b[ifd:ifd + 2])[0]
    for i in range(n):
        o = ifd + 2 + i * 12
        if struct.unpack("<H", b[o:o + 2])[0] == tag:
            b[o + 8:o + 10] = struct.pack("<H", value)
            open(p, "wb").write(b)
            return
    if add:
        # no predictor tag present: append a new IFD entry by rewriting the directory at the end of the file
        entries = [bytes(b[ifd + 2 + i * 12: ifd + 14 + i * 12]) for i in range(n)]
        nxt = bytes(b[ifd + 2 + n * 12: ifd + 6 + n * 12])
        entries.append(struct.pack("<HHIHH", tag, 3, 1, value, 0))
        entries.sort(key=lambda e: struct.unpack("<H", e[:2])[0])
        if len(b) % 2:
            b.append(0)
        new = len(b)
        b += struct.pack("<H", len(entries)) + b"".join(entries) + nxt
        b[4:8] = struct.pack("<I", new)
        open(p, "wb").write(b)
        return
    raise SystemExit("tag %d not found in %s" % (tag, name))


if __name__ == "__main__":
    main()
