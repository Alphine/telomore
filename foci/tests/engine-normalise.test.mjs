import test from "node:test";
import assert from "node:assert/strict";
import { Engine, manifest, loadCase, sha } from "./engine-util.mjs";

const { normalise } = Engine._internals;
const M = manifest();
const ch = (data, w, h, bitDepth) => ({ data, width: w, height: h, bitDepth });

test("normalised arrays are bit-identical to backend.foci_upload.to_signal for every fixture", async () => {
  for (const c of M.cases) {
    const { dna, foci } = await loadCase(c);
    const nd = normalise(dna), nf = normalise(foci);
    assert.equal(sha(nd.data), c.python.hashes.norm_dna, `${c.id} dna`);
    assert.equal(sha(nf.data), c.python.hashes.norm_foci, `${c.id} foci`);
    const pn = c.python.normalisation.dna;
    if (c.bit_depth !== 8 && pn.raw_lo !== undefined) {
      assert.ok(Math.abs(nd.info.lo - pn.raw_lo) <= 1e-9 * Math.max(1, Math.abs(pn.raw_lo)), `${c.id}: lo ${nd.info.lo} vs ${pn.raw_lo}`);
      assert.ok(Math.abs(nd.info.hi - pn.raw_hi) <= 1e-9 * Math.max(1, Math.abs(pn.raw_hi)), `${c.id}: hi`);
      assert.equal(nd.info.clipped_high_fraction, pn.clipped_high_fraction);
    }
    assert.equal(nd.info.saturated_fraction, pn.saturated_fraction, `${c.id} saturated fraction`);
  }
});

test("8-bit data is used as is and reported as such", () => {
  const d = Uint8Array.from([0, 1, 100, 254, 255, 255]);
  const n = normalise(ch(d, 3, 2, 8));
  assert.deepEqual(Array.from(n.data), [0, 1, 100, 254, 255, 255]);
  assert.equal(n.info.method, "none");
  assert.equal(n.info.saturated_fraction, 2 / 6);
  assert.equal(n.info.clipped_fraction, 0);
});

test("12- and 16-bit: percentile stretch onto 0..255, never wraps around below the low percentile", () => {
  // 10,000 pixels: 0.1% (10) are far below the bulk, 0.1% far above -> clipped to 0 / 255, never wrapped
  const n = 10000, d = new Uint16Array(n);
  for (let i = 0; i < n; i++) d[i] = 1000 + (i % 1000);
  for (let i = 0; i < 10; i++) d[i] = 0;          // below lo: a Uint16 subtraction would wrap to ~64000
  for (let i = 10; i < 20; i++) d[i] = 65535;
  const r = normalise(ch(d, 100, 100, 16));
  assert.equal(r.info.method, "percentile-0.1-99.99");
  assert.ok(r.info.lo >= 0 && r.info.lo < 1100, `lo ${r.info.lo}`);
  assert.ok(r.info.clipped_low_fraction >= 0.001 - 1e-12);
  for (let i = 0; i < 10; i++) assert.equal(r.data[i], 0, "low outlier clipped to 0");
  for (let i = 10; i < 20; i++) assert.equal(r.data[i], 255, "hot pixel clipped to 255");
  let min = 255, max = 0;
  for (const v of r.data) { if (v < min) min = v; if (v > max) max = v; }
  assert.ok(min >= 0 && max <= 255);
  // 12-bit goes the same way
  const d12 = Uint16Array.from(d, (v) => Math.min(4095, v >> 4));
  assert.equal(normalise(ch(d12, 100, 100, 12)).info.method, "percentile-0.1-99.99");
});

test("constant and saturated images", () => {
  const flat16 = normalise(ch(new Uint16Array(64).fill(4000), 8, 8, 16));
  assert.equal(flat16.info.method, "flat");
  assert.ok(flat16.data.every((v) => v === 0));
  const flat8 = normalise(ch(new Uint8Array(64).fill(255), 8, 8, 8));
  assert.equal(flat8.info.saturated_fraction, 1);
  assert.ok(flat8.data.every((v) => v === 255));
  const sat16 = new Uint16Array(1000).fill(65535);
  for (let i = 0; i < 500; i++) sat16[i] = 100 + i;
  const r = normalise(ch(sat16, 50, 20, 16));
  assert.equal(r.info.saturated_fraction, 0.5);
});

test("float32 (32-bit) input is percentile-stretched too", () => {
  const f = new Float32Array(5000);
  for (let i = 0; i < f.length; i++) f[i] = -3.5 + i * 0.01;
  const r = normalise(ch(f, 100, 50, 32));
  assert.equal(r.info.method, "percentile-0.1-99.99");
  assert.ok(Math.abs(r.info.lo - (-3.5 + 0.01 * 4.999)) < 1e-4);
  assert.ok(r.data[0] === 0 && r.data[4999] === 255);
});

test("float32 data whose range overflows float32 is rejected instead of producing NaN images", () => {
  const f = new Float32Array(10000).fill(3e38);
  for (let i = 0; i < 10; i++) f[i] = -3e38;   // the 0.1 percentile interpolates across a 6e38 gap (> float32 max)
  assert.throws(() => normalise(ch(f, 100, 100, 32)), (e) => e.code === "bad_input");
});

test("quantile arithmetic matches numpy's linear interpolation on known cases", () => {
  const { percentilesF32, percentilesInt } = Engine._internals;
  // np.percentile([1,2,3,4,5], [0.1, 99.99]) -> [1.004, 4.9996] (float64)
  const a = percentilesF32(Float32Array.from([5, 1, 4, 2, 3]), [0.1, 99.99]);
  assert.ok(Math.abs(a[0] - 1.004) < 1e-12 && Math.abs(a[1] - 4.9996) < 1e-12, JSON.stringify(a));
  const b = percentilesInt(Uint16Array.from([5, 1, 4, 2, 3]), 65535, [0.1, 99.99]);
  assert.deepEqual(b, a);
  assert.equal(percentilesF32(Float32Array.from([7]), [1, 99.7]).join(), "7,7");
});

test("rint is round-half-to-even like np.rint", () => {
  const { rint } = Engine._internals;
  assert.deepEqual([0.5, 1.5, 2.5, 3.5, -0.5, 2.4, 2.6].map(rint), [0, 2, 2, 4, 0, 2, 3]);
});
