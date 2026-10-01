import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const S = require("../web/screen-core.js");
const H = await import("../../scripts/eval_foci_screen_engine.mjs");
const fx = (n) => path.join(here, "fixtures", n);
const expect = JSON.parse(readFileSync(fx("screen_png_expect.json"), "utf8"));

test("PNG decoder reads PIL-written RGB and grey files (Sub, Up, Paeth filters)", () => {
  const a = H.decodePng(readFileSync(fx("screen_png_rgb.png")));
  assert.deepEqual([a.width, a.height], [37, 23]);
  assert.deepEqual(Array.from(a.data), expect.rgb_first_channel);
  const g = H.decodePng(readFileSync(fx("screen_png_grey.png")));
  assert.deepEqual(Array.from(g.data), expect.grey);
});

// test-only encoder that uses all five PNG filter types, one per row
function encodePng(w, h, rgb) {
  const bpp = 3, stride = w * bpp, rows = [];
  const crcTable = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  for (let y = 0; y < h; y++) {
    const f = y % 5, line = Buffer.alloc(stride + 1); line[0] = f;
    for (let x = 0; x < stride; x++) {
      const v = rgb[y * stride + x], a = x >= bpp ? rgb[y * stride + x - bpp] : 0, b = y ? rgb[(y - 1) * stride + x] : 0, c = x >= bpp && y ? rgb[(y - 1) * stride + x - bpp] : 0;
      let pred = 0;
      if (f === 1) pred = a; else if (f === 2) pred = b; else if (f === 3) pred = (a + b) >> 1;
      else if (f === 4) { const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c); pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      line[x + 1] = (v - pred) & 255;
    }
    rows.push(line);
  }
  const chunk = (type, body) => { const len = Buffer.alloc(4); len.writeUInt32BE(body.length); const td = Buffer.concat([Buffer.from(type), body]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0))]);
}

test("PNG decoder handles all five filter types (incl. Average) and rejects what it cannot read", () => {
  const w = 19, h = 11, px = new Uint8Array(w * h * 3);
  for (let i = 0; i < px.length; i++) px[i] = (i * 37 + (i >> 3) * 11) & 255;
  const d = H.decodePng(encodePng(w, h, px));
  for (let i = 0; i < w * h; i++) assert.equal(d.data[i], px[i * 3]);
  assert.throws(() => H.decodePng(Buffer.from("not a png at all")), /not a PNG/);
  const bad = encodePng(w, h, px); bad[24] = 16;
  assert.throws(() => H.decodePng(bad), /unsupported/);
});

test("AUC matches scipy mannwhitneyu; bootstrap is reproducible and brackets the estimate", () => {
  const { pos, neg, auc } = expect.auc;
  assert.ok(Math.abs(H.auc(pos, neg) - auc) < 1e-12);
  assert.ok(Number.isNaN(H.auc([], neg)));
  const x = Array.from({ length: 80 }, (_, i) => ((i * 37) % 23) + (i % 7) / 10), y = x.map((v, i) => v * 0.5 + ((i * 11) % 9));
  const f = (idx) => H.spearmanNaN(idx.map((i) => x[i]), idx.map((i) => y[i]));
  const ci1 = H.bootstrapCi(f, 80, { boot: 300, seed: 3 }), ci2 = H.bootstrapCi(f, 80, { boot: 300, seed: 3 }), ci3 = H.bootstrapCi(f, 80, { boot: 300, seed: 4 });
  assert.deepEqual(ci1, ci2);
  assert.notDeepEqual(ci1, ci3);
  const est = H.spearmanNaN(x, y);
  assert.ok(ci1[0] < est && est < ci1[1]);
  assert.ok(Number.isNaN(H.bootstrapCi(() => NaN, 10, { boot: 50 })[0]));
});

test("the harness's annotation-to-image rule is the exact inverse of the page's image-to-annotation rule", () => {
  for (const pairing of S.PAIRINGS) for (let r = 0; r < 12; r++) for (let c = 0; c < 32; c++) {
    const name = S.annotationWellName(pairing, r, c, 12, 32), rc = S.wellToRC(name);
    const row = { name, number: rc.r * 32 + rc.c + 1 };
    assert.equal(H.imageWellFor(pairing, row), S.rcToWell(r, c), `${pairing} ${r},${c}`);
  }
  assert.equal(H.imageWellFor("colmajor", { name: "A2", number: 2 }), "B1");
  assert.equal(H.imageWellFor("colmajor", { name: "B1", number: 33 }), "I3");
  assert.throws(() => H.imageWellFor("x", { name: "A1", number: 1 }));
});

function synthetic() {
  // Authors' rows for a 12 x 32 plate; "ours" is built so that the COLUMN-MAJOR pairing is perfect (a property of this test data only).
  const annot = [], ours = {};
  for (let n = 1; n <= 384; n++) {
    const name = S.rcToWell(Math.floor((n - 1) / 32), (n - 1) % 32), cells = 50 + ((n * 13) % 97), fpc = 0.5 + ((n * 29) % 61) / 10;
    annot.push({ name, number: n, control: n % 40 === 0 ? "positive control" : "", qcRemoved: n % 9 === 0, cells, fpc, increased: fpc > 6 });
    ours[H.imageWellFor("colmajor", { name, number: n })] = { nuclei: cells, foci: Math.round(fpc * cells * 1000) / 1000 };
  }
  ours.A1.nuclei = 0;   // a well with no nucleus is dropped, never turned into 0 or Infinity
  return { annot, ours };
}

test("evaluate(): perfect under the pairing the data were built for, near zero under the other; drops and filters reported", () => {
  const { annot, ours } = synthetic();
  const cm = H.evaluate(annot, ours, "colmajor", { boot: 100 }), nm = H.evaluate(annot, ours, "name", { boot: 100 });
  assert.ok(cm.foci_per_cell_vs_authors.spearman > 0.999);   // float division can break exact ties
  assert.ok(cm.nuclei_vs_authors_cell_count.spearman > 0.999);
  assert.ok(Math.abs(nm.foci_per_cell_vs_authors.spearman) < 0.3);
  const eligible = annot.filter((r) => !r.qcRemoved && !r.control).length;
  assert.equal(cm.wells.eligible, eligible);
  assert.equal(cm.wells.analysed + cm.wells.dropped_no_nuclei_or_missing_image.length, eligible);
  assert.ok(cm.wells.dropped_no_nuclei_or_missing_image.length >= 1);
  assert.ok(cm.auc_increased_damage.ours_foci_per_cell.auc > 0.99);
  assert.ok(cm.auc_increased_damage.ours_foci_per_cell.n_pos > 5);
  assert.ok(Math.abs(nm.auc_increased_damage.ours_foci_per_cell.auc - 0.5) < 0.2);
  const flat = Object.fromEntries(Object.entries(ours).map(([k]) => [k, { nuclei: 10, foci: 10 }]));
  assert.equal(H.evaluate(annot, flat, "colmajor", { boot: 50 }).foci_per_cell_vs_authors.spearman, null, "constant predictions give no coefficient, not 0 or NaN");
});

test("runEngine drives an engine module over a directory of PNGs (mock engine, plumbing only)", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "foci-eval-"));
  const mk = (n255) => { const w = 16, h = 8, px = new Uint8Array(w * h * 3).fill(20); for (let i = 0; i < n255; i++) px[i * 9] = px[i * 9 + 1] = px[i * 9 + 2] = 255; return encodePng(w, h, px); };
  writeFileSync(path.join(dir, "A1.dna.png"), mk(5)); writeFileSync(path.join(dir, "A1.foci.png"), mk(7));
  writeFileSync(path.join(dir, "B1.dna.png"), mk(2)); writeFileSync(path.join(dir, "B1.foci.png"), mk(0));
  const r = await H.runEngine(path.join(here, "fixtures", "screen_mock_engine.js"), dir, "reference");
  assert.deepEqual(r.wells, { A1: { nuclei: 5, foci: 7 }, B1: { nuclei: 2, foci: 0 } });
  assert.equal(r.version, "mock-0.1");
});
