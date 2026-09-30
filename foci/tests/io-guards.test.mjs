import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import zlib from "node:zlib";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const IO = require("../web/io/io.js");
const PNG = require("../web/io/png.js");
const INF = require("../web/io/inflate.js");

const FX = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const fx = (n) => new Uint8Array(fs.readFileSync(path.join(FX, n)));

function pngChunk(type, data) {
  const b = Buffer.alloc(12 + data.length);
  b.writeUInt32BE(data.length, 0); b.write(type, 4, "latin1"); Buffer.from(data).copy(b, 8);
  b.writeUInt32BE(PNG.crc32(b, 4, 8 + data.length), 8 + data.length);
  return b;
}
function makePng(w, h, depth, ct, raw) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = depth; ihdr[9] = ct;
  return new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk("IHDR", ihdr), pngChunk("IDAT", zlib.deflateSync(raw)), pngChunk("IEND", [])]));
}

test("PNG: dimension cap fires before any allocation", async () => {
  const b = makePng(100000, 100000, 8, 0, Buffer.alloc(10));
  await assert.rejects(IO.readBytes(b, "x.png"), (e) => e.code === "too_large" && /megapixels/.test(e.message));
  const big = makePng(5000, 5000, 8, 0, Buffer.alloc(10));
  await assert.rejects(IO.readBytes(big, "x.png"), { code: "too_large" });
  // with the cap raised the dimensions pass, and the (too short) data is reported as corrupt instead
  await assert.rejects(IO.readBytes(big, "x.png", { maxPixels: 30e6 }), (e) => e.code !== "too_large");
});

test("PNG: decompression bomb (IDAT inflates past the declared size) is cut off", async () => {
  const b = makePng(4, 4, 8, 0, Buffer.alloc(50_000_000));
  await assert.rejects(IO.readBytes(b, "bomb.png"), { code: "bomb" });
});

test("PNG: too little data, bad CRC, missing IEND handling", async () => {
  await assert.rejects(IO.readBytes(makePng(8, 8, 8, 0, Buffer.alloc(10)), "s.png"), { code: "corrupt" });
  const good = fx("io_png_gray8.png"), bad = Uint8Array.from(good);
  bad[40] ^= 0xff;
  await assert.rejects(IO.readBytes(bad, "c.png"), /checksum|damaged/i);
  const noEnd = good.subarray(0, good.length - 12);
  const r = await IO.readBytes(noEnd, "n.png");
  assert.ok(r.warnings.some((w) => /IEND/.test(w)));
});

test("Fuzz: truncating or corrupting any fixture only ever throws FociIOError (no hang, no stray exceptions)", async () => {
  const names = fs.readdirSync(FX).filter((n) => /^io_(png|tiff|ome|zip)_.*\.(png|tif|zip)$/.test(n) && !/bomb/.test(n));
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  let runs = 0;
  async function one(bytes, label) {
    runs++;
    try { await IO.readBytes(bytes, "f", { maxPixels: 2e6 }); }
    catch (e) { assert.equal(e.name, "FociIOError", label + ": " + (e && e.stack)); assert.ok(e.message.length > 10); }
  }
  for (const n of names) {
    const good = fx(n);
    const cuts = new Set([0, 1, 7, 8, 9, 15, 16, 30, good.length - 1, good.length - 5]);
    for (let i = 0; i < 6; i++) cuts.add(Math.floor(rnd() * good.length));
    for (const c of cuts) {
      if (c < 0 || c >= good.length) continue;
      await one(good.subarray(0, c), n + " cut@" + c);
    }
    for (let k = 0; k < 10; k++) {
      const b = Uint8Array.from(good);
      const nflip = 1 + Math.floor(rnd() * 3);
      for (let f = 0; f < nflip; f++) b[Math.floor(rnd() * Math.min(b.length, k < 5 ? 400 : b.length))] ^= 1 << Math.floor(rnd() * 8);
      await one(b, n + " flip#" + k);
    }
  }
  assert.ok(runs > 1000);
});

test("Garbage and empty files", async () => {
  await assert.rejects(IO.readBytes(new Uint8Array(0), "e"), { code: "corrupt" });
  await assert.rejects(IO.readBytes(new Uint8Array(100).fill(7), "g.png"), { code: "bad_format" });
  await assert.rejects(IO.readBytes(new TextEncoder().encode("hello world, not an image at all"), "t.tif"), { code: "bad_format" });
  await assert.rejects(IO.readFile(null), { code: "bad_input" });
});

test("File size cap is enforced before reading", async () => {
  let read = false;
  const fake = { name: "big.tif", size: 500 * 1024 * 1024, arrayBuffer: async () => { read = true; return new ArrayBuffer(8); } };
  await assert.rejects(IO.readFile(fake), { code: "too_large" });
  assert.equal(read, false);
  await assert.rejects(IO.readBytes(fx("io_png_gray8.png"), "a.png", { maxFileBytes: 100 }), { code: "too_large" });
});

function tiffHeader() { return Buffer.from([0x49, 0x49, 42, 0, 8, 0, 0, 0]); }

test("TIFF: impossible IFD entry count, offsets past EOF, huge tag counts", async () => {
  const h = tiffHeader(), b = Buffer.alloc(8 + 2 + 4);
  h.copy(b); b.writeUInt16LE(65000, 8);
  await assert.rejects(IO.readBytes(new Uint8Array(b), "x.tif"), (e) => e.name === "FociIOError");
  const small = [[256, 3, 10], [257, 3, 10], [258, 3, 8], [259, 3, 1], [262, 3, 1], [277, 3, 1]];
  const e = Buffer.alloc(8 + 2 + 12 * (small.length + 1) + 4); h.copy(e); e.writeUInt16LE(small.length + 1, 8);
  small.forEach(([t, ty, v], i) => { const o = 10 + i * 12; e.writeUInt16LE(t, o); e.writeUInt16LE(ty, o + 2); e.writeUInt32LE(1, o + 4); e.writeUInt16LE(v, o + 8); });
  const o7 = 10 + small.length * 12;
  e.writeUInt16LE(273, o7); e.writeUInt16LE(4, o7 + 2); e.writeUInt32LE(0x7fffffff, o7 + 4); e.writeUInt32LE(100, o7 + 8);
  await assert.rejects(IO.readBytes(new Uint8Array(e), "x.tif"), (x) => x.name === "FociIOError" && /larger than the file|outside/.test(x.message));
  const n = Buffer.alloc(8 + 2 + 4); h.copy(n); n.writeUInt16LE(0, 8); n.writeUInt32LE(0xfffffff0, 10);
  await assert.rejects(IO.readBytes(new Uint8Array(n), "x.tif"), (x) => x.name === "FociIOError");
});

test("TIFF: oversized image is refused from the tags alone", async () => {
  const ents = [[256, 4, 100000], [257, 4, 100000], [258, 3, 8], [259, 3, 1], [262, 3, 1], [273, 4, 200], [277, 3, 1], [278, 4, 100000], [279, 4, 10]];
  const b = Buffer.alloc(8 + 2 + ents.length * 12 + 4 + 16);
  tiffHeader().copy(b); b.writeUInt16LE(ents.length, 8);
  ents.forEach(([t, ty, v], i) => { const o = 10 + i * 12; b.writeUInt16LE(t, o); b.writeUInt16LE(ty, o + 2); b.writeUInt32LE(1, o + 4); if (ty === 3) b.writeUInt16LE(v, o + 8); else b.writeUInt32LE(v, o + 8); });
  await assert.rejects(IO.readBytes(new Uint8Array(b), "x.tif"), { code: "too_large" });
});

test("TIFF: strip pointing outside the file is reported as truncation", async () => {
  const f = fx("io_tiff_u8.tif"), b = Uint8Array.from(f);
  const dv = new DataView(b.buffer);
  const ifd = dv.getUint32(4, true), n = dv.getUint16(ifd, true);
  for (let i = 0; i < n; i++) {
    const o = ifd + 2 + i * 12;
    if (dv.getUint16(o, true) === 273) { const cnt = dv.getUint32(o + 4, true), at = cnt > 1 ? dv.getUint32(o + 8, true) : o + 8; dv.setUint32(at, 0xfffffff0, true); }
  }
  await assert.rejects(IO.readBytes(b, "x.tif"), (e) => e.name === "FociIOError" && /outside|truncated/i.test(e.message));
});

test("LZW and PackBits: corrupt streams raise, never loop or overrun", () => {
  assert.throws(() => INF.lzw(new Uint8Array(0), 5), { code: "corrupt" });
  for (let i = 0; i < 300; i++) {
    const src = crypto.randomBytes(1 + (i * 7) % 300);
    try { INF.lzw(src, 64); } catch (e) { assert.equal(e.name, "FociIOError"); }
    try { INF.packBits(src, 64); } catch (e) { assert.equal(e.name, "FociIOError"); }
  }
  assert.deepEqual([...INF.packBits(Uint8Array.from([0x80, 0x01, 7, 8, 0xfe, 9]), 5)], [7, 8, 9, 9, 9]);
  assert.throws(() => INF.packBits(Uint8Array.from([0xf0, 1]), 5), { code: "bomb" });
});

test("SHA-256 (WebCrypto path and pure-JS fallback) match node:crypto", async () => {
  for (const n of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000, 100003]) {
    const buf = crypto.randomBytes(n), want = crypto.createHash("sha256").update(buf).digest("hex");
    assert.equal(await INF.sha256(new Uint8Array(buf)), want, "subtle n=" + n);
    assert.equal(INF.sha256js(new Uint8Array(buf)), want, "js n=" + n);
  }
});

test("TIFF: absurd tile size is refused before any allocation", async () => {
  const b = Uint8Array.from(fx("io_tiff_u16_tiled_lzw.tif")), dv = new DataView(b.buffer);
  const ifd = dv.getUint32(4, true), n = dv.getUint16(ifd, true);
  for (let i = 0; i < n; i++) { const o = ifd + 2 + i * 12, tag = dv.getUint16(o, true); if (tag === 322 || tag === 323) dv.setUint16(o + 8, 60000, true); }
  await assert.rejects(IO.readBytes(b, "x.tif"), (e) => e.name === "FociIOError" && e.code === "too_large");
});

test("TIFF: many pages sharing one huge strip table never get that table read", async () => {
  // the 70-page fixture is refused from the page count alone
  await assert.rejects(IO.readBytes(fx("io_bad_tiff_70pages.tif"), "x.tif"), { code: "unsupported" });
});
