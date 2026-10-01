import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const IO = require("../web/io/io.js");

const FX = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const EXP = JSON.parse(fs.readFileSync(path.join(FX, "io_expected.json"), "utf8"));
const load = (n) => new File([fs.readFileSync(path.join(FX, n))], n);

function sameValues(actual, expected, label) {
  assert.equal(actual.length, expected.length, label + ": length");
  for (let i = 0; i < expected.length; i++) {
    if (actual[i] !== expected[i]) assert.fail(`${label}: first mismatch at ${i}: got ${actual[i]} expected ${expected[i]}`);
  }
}

for (const [name, spec] of Object.entries(EXP.files)) {
  if (spec.error || spec.zip || spec.lossy) continue;
  test("decode " + name, async () => {
    const r = await IO.readFile(load(name));
    assert.equal(r.format, spec.format);
    assert.equal(r.channels.length, spec.channels.length, "channel count");
    spec.channels.forEach((c, i) => {
      const ds = EXP.datasets[c.ds], ch = r.channels[i];
      assert.equal(ch.name, c.name, "name " + i);
      assert.equal(ch.bitDepth, c.bitDepth, "bitDepth " + i);
      assert.equal(ch.width, ds.w); assert.equal(ch.height, ds.h);
      const Ctor = c.bitDepth === 8 ? Uint8Array : c.bitDepth === 32 ? Float32Array : Uint16Array;
      assert.ok(ch.data instanceof Ctor, "typed array " + ch.data.constructor.name);
      sameValues(ch.data, ds.v, name + " ch" + i);
    });
    assert.equal(r.width, r.channels[0].width);
    if (spec.pixelSizeUm == null) assert.equal(r.pixelSizeUm, null);
    else assert.ok(Math.abs(r.pixelSizeUm - spec.pixelSizeUm) < 1e-6 * Math.max(1, spec.pixelSizeUm), "pixel size " + r.pixelSizeUm);
    for (const w of spec.warn) assert.ok(r.warnings.some((x) => x.toLowerCase().includes(w.toLowerCase())), `warning '${w}' in ${JSON.stringify(r.warnings)}`);
    if (!spec.warn.length) assert.deepEqual(r.warnings.filter((x) => !/reduced|loops/.test(x)), [], "no unexpected warnings");
  });
}

test("select decodes only requested channels", async () => {
  const r = await IO.readFile(load("io_tiff_multipage3_u16.tif"), { select: [1] });
  assert.equal(r.channels.length, 3);
  assert.equal(r.channels[0].data, null); assert.equal(r.channels[2].data, null);
  sameValues(r.channels[1].data, EXP.datasets.u16_1.v, "selected");
  const rp = await IO.readFile(load("io_tiff_rgb16_planar.tif"), { select: [2] });
  assert.equal(rp.channels[0].data, null);
  sameValues(rp.channels[2].data, EXP.datasets.u16_2.v, "planar selected");
});

test("OME name with markup is neutralised", async () => {
  const r = await IO.readFile(load("io_ome_2c_be.ome.tif"));
  assert.equal(r.channels[0].name, "Hoechst & b");
});

test("JPEG is flagged lossy and pixel cap is checked before decode", async () => {
  const bytes = fs.readFileSync(path.join(FX, "io_jpeg_gray.jpg"));
  let got = null;
  const dec = async (u8, size) => { got = size; const n = size.width * size.height, d = new Uint8ClampedArray(n * 4); for (let i = 0; i < n; i++) { d[4 * i] = d[4 * i + 1] = d[4 * i + 2] = i & 255; d[4 * i + 3] = 255; } return { width: size.width, height: size.height, rgba: d }; };
  const r = await IO.readBytes(bytes, "a.jpg", { jpegDecoder: dec });
  assert.equal(r.format, "jpeg"); assert.equal(r.channels.length, 1); assert.equal(r.channels[0].name, "Gray");
  assert.equal(got.width, 37); assert.equal(got.height, 29);
  assert.ok(r.warnings.some((w) => /lossy/i.test(w)));
  await assert.rejects(IO.readBytes(bytes, "a.jpg", { maxPixels: 100, jpegDecoder: dec }), { code: "too_large" });
  await assert.rejects(IO.readBytes(bytes.subarray(0, 12), "a.jpg", { jpegDecoder: dec }), /damaged|corrupt/i);
});

test("unsupported TIFF features fail clearly and say what to do", async () => {
  for (const [name, spec] of Object.entries(EXP.files)) {
    if (!spec.error || !name.startsWith("io_bad_tiff")) continue;
    await assert.rejects(IO.readFile(load(name)), (e) => {
      assert.match(e.code, new RegExp("^(" + spec.error + ")$"), name + " code " + e.code);
      if (spec.match) assert.match(e.message, new RegExp(spec.match, "i"));
      if (e.code === "unsupported") assert.match(e.message, /uncompressed|LZW|Deflate/);
      return true;
    }, name);
  }
});

test("ZIP: lists image entries, ignores junk, extracts and decodes", async () => {
  const buf = fs.readFileSync(path.join(FX, "io_zip_ok.zip"));
  const z = await IO.readBytes(buf, "io_zip_ok.zip");
  assert.equal(z.format, "zip");
  assert.deepEqual(z.entries.map((e) => e.name), EXP.files["io_zip_ok.zip"].zip);
  assert.ok(z.warnings.length);
  const a = await IO.readZipEntry(buf, z.entries[0]);
  sameValues(a.channels[0].data, EXP.datasets.u16_0.v, "zip png");
  const b = await IO.readZipEntry(buf, z.entries[1]);
  sameValues(b.channels[0].data, EXP.datasets.u16_0.v, "zip tif");
});

test("ZIP: bombs, empty, truncated, tampered entries are refused", async () => {
  await assert.rejects(IO.readFile(load("io_zip_bomb.zip")), { code: "bomb" });
  await assert.rejects(IO.readFile(load("io_zip_empty_of_images.zip")), { code: "unsupported" });
  const ok = fs.readFileSync(path.join(FX, "io_zip_ok.zip"));
  await assert.rejects(IO.readBytes(ok.subarray(0, ok.length - 40), "t.zip"), /ZIP|truncated/i);
  // understate the declared size in the central directory: extraction must not exceed it
  const t = Uint8Array.from(ok), dv = new DataView(t.buffer);
  for (let i = 0; i + 46 < t.length; i++) {
    if (dv.getUint32(i, true) === 0x02014b50) { dv.setUint32(i + 24, 10, true); break; }
  }
  const z = await IO.readBytes(t, "t.zip");
  await assert.rejects(IO.readZipEntry(t, z.entries[0]), (e) => ["bomb", "corrupt"].includes(e.code));
  // encrypted flag
  const enc = Uint8Array.from(ok), dv2 = new DataView(enc.buffer);
  for (let i = 0; i + 46 < enc.length; i++) { if (dv2.getUint32(i, true) === 0x02014b50) { dv2.setUint16(i + 8, 1, true); break; } }
  await assert.rejects(IO.readBytes(enc, "e.zip"), /password|encrypt/i);
  // entry-count guard
  await assert.rejects(IO.readBytes(ok, "m.zip", { zipLimits: { maxImageEntries: 1 } }), { code: "too_large" });
});
