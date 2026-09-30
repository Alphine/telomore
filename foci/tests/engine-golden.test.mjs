import test from "node:test";
import assert from "node:assert/strict";
import { Engine, manifest, loadCase, compareResult, sha } from "./engine-util.mjs";

const M = manifest();

for (const c of M.cases) {
  test(`golden parity (exact): ${c.id}`, async () => {
    const py = c.python;
    if (py.error) return; // Python itself raised: nothing to match (recorded in the manifest)
    const { dna, foci } = await loadCase(c);
    const res = await Engine.analyze({ dna, foci, params: c.params }, { mode: "reference", debug: true });
    assert.deepEqual(compareResult(res, py), []);
    // intermediates: bit-exact against the Python arrays (sha256 of the raw float32 / int32 bytes)
    const d = res._debug, h = py.hashes;
    assert.equal(sha(d.smooth_dna), h.smooth_dna, "smoothed DNA");
    assert.equal(sha(d.flat), h.flat, "flat (background-subtracted) DNA");
    assert.equal(sha(d.labels), h.labels, "nucleus label image");
    if (h.th) {
      assert.equal(sha(d.smooth_foci), h.smooth_foci, "smoothed foci");
      assert.equal(sha(d.th), h.th, "white top-hat");
    }
    // The threshold is only ever used as a float32 (flat > threshold compares in float32); the double itself
    // comes from expm1, which differs between libm implementations by at most 1 ulp.
    assert.equal(res.thresholds.nucleus_float32, Math.fround(py.threshold), "nucleus threshold as float32");
    assert.ok(Math.abs(res.thresholds.nucleus - py.threshold) <= 4 * Number.EPSILON * Math.abs(py.threshold), "nucleus threshold within 4 ulp");
    assert.equal(res.backend, "cpu-f64");
    assert.equal(res.image.width, c.width);
  });
}

test("golden manifest sanity", () => {
  assert.ok(M.cases.length >= 30);
  assert.ok(M.cases.filter((c) => c.kind === "idr0010").length >= 12);
  assert.ok(M.cases.every((c) => !c.python.error), "no fixture where Python itself raised");
});
