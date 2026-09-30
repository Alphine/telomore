import test from "node:test";
import assert from "node:assert/strict";
import { Engine, manifest, loadCase, sha } from "./engine-util.mjs";

const M = manifest();

function rgbOf(overlay) {
  const n = overlay.width * overlay.height, out = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) { out[3 * i] = overlay.data[4 * i]; out[3 * i + 1] = overlay.data[4 * i + 1]; out[3 * i + 2] = overlay.data[4 * i + 2]; }
  return out;
}

test("overlay RGB is byte-identical to overlay_rgb() for every fixture", async () => {
  for (const c of M.cases) {
    const { dna, foci } = await loadCase(c);
    const res = await Engine.analyze({ dna, foci, params: c.params }, { mode: "reference", overlay: true });
    assert.ok(res.overlay, c.id);
    assert.equal(res.overlay.width, c.width);
    assert.equal(res.overlay.height, c.height);
    assert.ok(res.overlay.data instanceof Uint8ClampedArray);
    assert.equal(res.overlay.data.length, c.width * c.height * 4);
    assert.equal(sha(rgbOf(res.overlay)), c.python.hashes.overlay_rgb, `${c.id}: overlay differs from Python`);
    for (let i = 3; i < res.overlay.data.length; i += 4) assert.equal(res.overlay.data[i], 255);
  }
});

test("overlay colours: outlines white-ish, rings amber, background blue/green", async () => {
  const c = M.cases.find((x) => x.id === "syn_blocks_with_hole");
  const { dna, foci } = await loadCase(c);
  const res = await Engine.analyze({ dna, foci, params: c.params }, { mode: "reference", overlay: true });
  const o = res.overlay, w = o.width;
  const px = (x, y) => Array.from(o.data.slice((y * w + x) * 4, (y * w + x) * 4 + 3));
  // a nucleus boundary pixel that no focus ring covers: (0.85, 0.9, 0.95) * 255, truncated
  const lab = (await Engine.analyze({ dna: (await loadCase(c)).dna, foci: (await loadCase(c)).foci, params: c.params }, { mode: "reference", debug: true }))._debug.labels;
  const ringed = new Set();
  for (const pt of res.foci.points) for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) ringed.add((pt.y + dy) * w + pt.x + dx);
  let edge = -1;
  for (let i = w + 1; i < lab.length - w - 1 && edge < 0; i++) if (lab[i] > 0 && lab[i - 1] === 0 && !ringed.has(i)) edge = i;
  assert.ok(edge > 0, "found an outline pixel");
  assert.deepEqual(px(edge % w, Math.floor(edge / w)), [216, 229, 242]);
  // a counted focus is ringed in amber at Manhattan distance 2..3
  const f = res.foci.points[0];
  assert.deepEqual(px(f.x + 3, f.y), [255, 183, 38]);
  assert.deepEqual(px(f.x + 1, f.y).length, 3);
  assert.notDeepEqual(px(f.x + 1, f.y), [255, 183, 38]);
});

test("no overlay unless asked", async () => {
  const c = M.cases.find((x) => x.id === "syn_32x32");
  const { dna, foci } = await loadCase(c);
  const res = await Engine.analyze({ dna, foci }, { mode: "reference" });
  assert.equal(res.overlay, undefined);
});
