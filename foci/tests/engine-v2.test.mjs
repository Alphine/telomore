// Pipeline v2 (nucleus split) in reference mode: exact label/count parity with the Python reference
// (src/telomere_lab/foci/segment_v2.py) on foci/tests/fixtures/engine_golden_v2, plus API behaviour.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Engine, decodePng, GOLD, compareResult, sha } from "./engine-util.mjs";

const G2 = path.join(GOLD, "..", "engine_golden_v2");
const M = JSON.parse(fs.readFileSync(path.join(G2, "manifest.json"), "utf8"));
const cache = new Map();

async function load(entry) {
  let pair = cache.get(entry.id);
  if (!pair) {
    const rd = async (k) => decodePng(fs.readFileSync(path.join(G2, entry.files[k])));
    pair = { dna: await rd("dna"), foci: await rd("foci") };
    cache.set(entry.id, pair);
  }
  const ch = (c) => ({ data: c.data.slice(), width: c.width, height: c.height, bitDepth: entry.bit_depth });
  return { dna: ch(pair.dna), foci: ch(pair.foci) };
}

for (const c of M.cases) {
  test(`v2 golden parity (exact): ${c.id}`, async () => {
    const py = c.python;
    const { dna, foci } = await load(c);
    const res = await Engine.analyze({ dna, foci, params: c.params }, { mode: "reference", pipeline: "v2", debug: true });
    assert.equal(res.pipeline_version, "v2");
    assert.equal(py.pipeline_version, "v2");
    assert.deepEqual(compareResult(res, py), []);
    const d = res._debug, h = py.hashes;
    assert.equal(sha(d.flat), h.flat, "flat DNA");
    if (h.surface) assert.equal(sha(d.surface), h.surface, "quantised split surface");
    assert.equal(sha(d.labels), h.labels, "nucleus label image");
    if (h.th) {
      assert.equal(sha(d.smooth_foci), h.smooth_foci, "smoothed foci");
      assert.equal(sha(d.th), h.th, "top-hat");
    }
    assert.equal(res.thresholds.nucleus, py.threshold, "linear Otsu threshold (no libm involved)");
    assert.equal(res.thresholds.nucleus_float32, Math.fround(py.threshold32), "scaled float32 threshold");
    assert.equal(res.nuclei.count, res.nuclei.object_count, "v2: one object = one nucleus");
    assert.equal(res.backend, "cpu-f64");
  });
}

M.sweeps.forEach((s, i) => {
  test(`v2 parameter sweep #${i}: ${s.case} ${JSON.stringify(s.params)}`, async () => {
    const entry = M.cases.find((c) => c.id === s.case);
    const { dna, foci } = await load(entry);
    const res = await Engine.analyze({ dna, foci, params: s.params }, { mode: "reference", pipeline: "v2" });
    assert.deepEqual(compareResult(res, s.python), []);
  });
});

test("v2: splitting really happens on touching nuclei (fixture sanity)", () => {
  const dense = M.cases.find((c) => c.id === "bbbc_crop0").python;
  assert.ok(dense.n_objects >= 8);
  assert.ok(M.cases.filter((c) => c.kind === "bbbc039").length >= 6);
});

test("pipeline option: default is v1, results carry pipeline_version, v1 output unchanged", async () => {
  const e = M.cases.find((c) => c.id === "bbbc_crop1");
  const a = await Engine.analyze(await load(e), { mode: "reference" });
  const b = await Engine.analyze(await load(e), { mode: "reference", pipeline: "v1" });
  assert.equal(a.pipeline_version, "v1");
  assert.equal(b.pipeline_version, "v1");
  assert.deepEqual(a.nuclei, b.nuclei);
  const v2 = await Engine.analyze(await load(e), { mode: "reference", pipeline: "v2" });
  assert.equal(v2.pipeline_version, "v2");
  assert.ok(v2.nuclei.count > a.nuclei.count, "v2 separates touching nuclei into more objects than v1 counts as such here or equal");
});

test("pipeline option: validation and parameter sets", async () => {
  const e = M.cases.find((c) => c.id === "syn_blocks_with_hole");
  await assert.rejects(Engine.analyze(await load(e), { pipeline: "v3" }), (x) => x.code === "bad_input");
  await assert.rejects(Engine.analyze({ ...(await load(e)), params: { nucleus_sigma: 2 } }, { pipeline: "v2" }), (x) => x.code === "bad_input");
  await assert.rejects(Engine.analyze({ ...(await load(e)), params: { h: 1 } }, { pipeline: "v1" }), (x) => x.code === "bad_input");
  const d = Engine.defaultParams("v2");
  for (const k of ["sigma", "thr_factor", "split_sigma", "h", "intensity_weight", "intensity_sigma", "min_nucleus_px", "background_size", "min_height"]) assert.ok(k in d, k);
  assert.deepEqual(Object.keys(Engine.defaultParams()), Object.keys(Engine.defaultParams("v1")));
  assert.equal(Engine.defaultParams().min_nucleus_px, 150);
  const r = await Engine.analyze(await load(e), { pipeline: "v2", mode: "gpu" });
  assert.equal(r.backend, "cpu-f64");
  assert.ok(r.warnings.some((w) => /CPU/.test(w)));
});

test("v2 is deterministic, does not mutate its input and works through the pool", async () => {
  const e = M.cases.find((c) => c.id === "bbbc_crop3");
  const inp = await load(e);
  const before = sha(inp.dna.data);
  const a = await Engine.analyze(inp, { pipeline: "v2", overlay: true });
  const b = await Engine.analyze(inp, { pipeline: "v2", overlay: true });
  assert.equal(sha(inp.dna.data), before);
  assert.deepEqual(a.nuclei, b.nuclei);
  assert.equal(sha(a.overlay.data), sha(b.overlay.data));
  const pool = Engine.createPool(1);
  const c = await pool.analyze(await load(e), { pipeline: "v2" });
  pool.terminate();
  assert.equal(c.pipeline_version, "v2");
  assert.deepEqual(c.nuclei, a.nuclei);
});
