import test from "node:test";
import assert from "node:assert/strict";
import { Engine } from "./engine-util.mjs";

const I = Engine._internals;

// scipy.ndimage._filters._gaussian_kernel1d(sigma, 0, int(4*sigma+0.5)), first half + centre, as printed by Python repr()
const SCIPY_KERNELS = {
  1: [0.00013383062461474175, 0.0044318616200312655, 0.05399112742070441, 0.24197144565660073, 0.39894346935609776],
  2: [6.691628957263553e-05, 0.0004363490205067883, 0.002215963172596555, 0.00876430436278587, 0.026995957967298846, 0.06475993660472744, 0.12098748976534904, 0.17603575888479037, 0.199474647864745],
  3: [4.46113427726488e-05, 0.00016009476589197758, 0.0005141076058219727, 0.001477324778400407, 0.0037987699403054824, 0.008740878047691292, 0.017997500190860556, 0.03315998842086742, 0.054671578245654065, 0.08065919989878699, 0.1064856940272447, 0.12579798346031065, 0.1329845385507837],
};

test("Gaussian kernel weights equal scipy's bit for bit (sigma 1, 2, 3)", () => {
  for (const [s, half] of Object.entries(SCIPY_KERNELS)) {
    const k = I.gaussKernel(Number(s));
    assert.equal(k.radius, half.length - 1);
    assert.equal(k.weights.length, 2 * half.length - 1);
    for (let i = 0; i < half.length; i++) {
      assert.equal(k.weights[i], half[i], `sigma ${s} weight ${i}`);
      assert.equal(k.weights[k.weights.length - 1 - i], half[i], "symmetric");
    }
  }
});

test("Gaussian radius = int(4*sigma + 0.5), tiny sigma gives the identity kernel", () => {
  assert.equal(I.gaussKernel(0.1).radius, 0);
  assert.deepEqual(Array.from(I.gaussKernel(0.1).weights), [1]);
  assert.equal(I.gaussKernel(10).radius, 40);
});

test("pairwise summation matches a simple sum on short inputs and splits above 128", () => {
  const a = Float64Array.from({ length: 300 }, (_, i) => 1 / (i + 1));
  let s = 0;
  for (const v of a) s += v;
  assert.ok(Math.abs(I.pairwiseSum(a, 0, 300) - s) < 1e-13);
  assert.equal(I.pairwiseSum(Float64Array.from([1, 2, 3]), 0, 3), 6);
});

test("reflect index equals numpy's 'symmetric' padding at any distance", () => {
  // n = 4: ... d c b a | a b c d | d c b a | a b c d ...
  const seq = [];
  for (let i = -9; i < 13; i++) seq.push(I.reflectIndex(i, 4));
  assert.deepEqual(seq, [0, 0, 1, 2, 3, 3, 2, 1, 0, 0, 1, 2, 3, 3, 2, 1, 0, 0, 1, 2, 3, 3]);
  assert.equal(I.reflectIndex(-1, 4), 0);
  assert.equal(I.reflectIndex(4, 4), 3);
  assert.equal(I.reflectIndex(5, 1), 0);
});

function lcg(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }

test("van Herk min/max filters equal a brute-force window scan (incl. windows larger than the image, 1xN, Nx1)", () => {
  const rnd = lcg(7);
  const shapes = [[1, 1], [1, 9], [9, 1], [2, 3], [7, 5], [13, 17], [30, 22]];
  for (const [h, w] of shapes) {
    for (const size of [3, 5, 11, 41, 75]) {
      for (const isMax of [false, true]) {
        const src = Float32Array.from({ length: w * h }, () => Math.fround(rnd() * 100));
        const got = src.slice();
        I.minmax2d(got, w, h, size, isMax);
        const r = (size - 1) >> 1;
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
          let best = isMax ? -Infinity : Infinity;
          for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
            const v = src[I.reflectIndex(y + dy, h) * w + I.reflectIndex(x + dx, w)];
            best = isMax ? Math.max(best, v) : Math.min(best, v);
          }
          assert.equal(got[y * w + x], best, `${w}x${h} size ${size} ${isMax ? "max" : "min"} at ${x},${y}`);
        }
      }
    }
  }
});

test("Gaussian filter of a constant image is (almost exactly) constant; impulse response is the outer product of the kernel", () => {
  const w = 21, h = 19, buf = new Float32Array(w * h).fill(100);
  I.gaussian2d(buf, w, h, 2);
  for (const v of buf) assert.ok(Math.abs(v - 100) < 1e-4);
  const imp = new Float32Array(w * h);
  imp[9 * w + 10] = 1;
  I.gaussian2d(imp, w, h, 1);
  const k = I.gaussKernel(1).weights;
  for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
    assert.ok(Math.abs(imp[(9 + dy) * w + 10 + dx] - k[dy + 4] * k[dx + 4]) < 1e-7);
  }
});

test("binary opening / hole filling / labelling on hand-made masks", () => {
  const w = 12, h = 9;
  const m = new Uint8Array(w * h);
  const set = (x, y) => { m[y * w + x] = 1; };
  for (let y = 1; y <= 6; y++) for (let x = 1; x <= 6; x++) set(x, y);      // 6x6 block
  m[3 * w + 3] = 0; m[3 * w + 4] = 0;                                        // interior hole
  set(10, 4); set(11, 4);                                                    // speck touching the border
  const t = new Uint8Array(w * h);
  I.fillHoles(m, w, h);
  assert.equal(m[3 * w + 3], 1, "hole filled");
  I.binaryOpening2(m, t, w, h);
  assert.equal(m[4 * w + 10], 0, "speck removed by opening");
  const lab = I.labelAndFilter(m, w, h, 5);
  assert.equal(lab.count, 1);
  assert.equal(lab.labels[3 * w + 3], 1);
  // diagonal neighbours are NOT connected (4-connectivity)
  const d = new Uint8Array(9); d[0] = 1; d[4] = 1; d[8] = 1;
  assert.equal(I.labelAndFilter(d, 3, 3, 1).count, 3);
  // ids follow raster order of the first pixel; small objects dropped then relabelled consecutively
  const r = new Uint8Array(7 * 3);
  r[0] = 1; r[1] = 1; r[2] = 1;         // 3 px (kept)
  r[2 * 7 + 0] = 1;                      // 1 px (dropped)
  r[2 * 7 + 3] = 1; r[2 * 7 + 4] = 1; r[2 * 7 + 5] = 1; r[2 * 7 + 6] = 1;   // 4 px (kept)
  const l2 = I.labelAndFilter(r, 7, 3, 3);
  assert.equal(l2.count, 2);
  assert.equal(l2.labels[14], 0);
  assert.equal(l2.labels[17], 2);
});

test("estimateNuclei: round(area / median), at least 1, half-to-even", () => {
  assert.deepEqual(I.estimateNuclei([100, 100, 100]), [1, 1, 1]);
  assert.deepEqual(I.estimateNuclei([100, 200, 300]), [1, 1, 2]);      // 0.5 -> 0 -> at least 1; 1.5 -> 2
  assert.deepEqual(I.estimateNuclei([100, 100, 250]), [1, 1, 2]);   // 2.5 -> 2 (half to even)
  assert.deepEqual(I.estimateNuclei([]), []);
  assert.deepEqual(I.estimateNuclei([10, 30]), [1, 2]);            // median 20 -> 0.5 -> 0 -> max(1, .) ; 1.5 -> 2
});

test("logOtsu: no positive pixels -> threshold 0; constant positive image handled (first == last)", () => {
  const z = new Float32Array(100), s = new Float32Array(100);
  assert.equal(I.logOtsu(z, s).threshold, 0);
  const c = new Float32Array(100).fill(5);
  const r = I.logOtsu(c, new Float32Array(100));
  assert.ok(Number.isFinite(r.threshold) && r.threshold >= 0);
});
