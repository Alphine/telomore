import test from "node:test";
import assert from "node:assert/strict";
import { Engine, manifest, loadCase, compareResult } from "./engine-util.mjs";

const M = manifest();
const byId = new Map(M.cases.map((c) => [c.id, c]));

test("parameter sweep: engine == Python for every variation (3 fixtures)", async () => {
  assert.ok(M.sweeps.length >= 40);
  assert.equal(new Set(M.sweeps.map((s) => s.case)).size, 3);
  const failures = [];
  for (const s of M.sweeps) {
    const c = byId.get(s.case);
    const { dna, foci } = await loadCase(c);
    const res = await Engine.analyze({ dna, foci, params: s.params }, { mode: "reference" });
    const bad = compareResult(res, s.python);
    if (bad.length) failures.push(`${s.case} ${JSON.stringify(s.params)}: ${bad.join("; ")}`);
  }
  assert.deepEqual(failures, []);
});

test("parameter sweep actually moves the result (the sweep is not vacuous)", () => {
  for (const id of new Set(M.sweeps.map((s) => s.case))) {
    const counts = new Set(M.sweeps.filter((s) => s.case === id).map((s) => s.python.n_foci));
    assert.ok(counts.size >= 4, `${id}: only ${counts.size} distinct foci totals across the sweep`);
  }
});

test("defaultParams equals FociParams() in segment.py", () => {
  assert.deepEqual(Engine.defaultParams(), M.default_params);
  const a = Engine.defaultParams();
  a.min_height = 99;
  assert.equal(Engine.defaultParams().min_height, 12, "defaultParams returns a fresh object");
});
