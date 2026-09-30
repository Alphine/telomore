import test from "node:test";
import assert from "node:assert/strict";
import { Engine, manifest, loadCase } from "./engine-util.mjs";

const M = manifest();
const caseById = (id) => M.cases.find((c) => c.id === id);
const small = async () => loadCase(caseById("syn_32x32"));
const ch = (data, w, h, bitDepth = 8) => ({ data, width: w, height: h, bitDepth });

// 600x500 = 0.3 Mpx: large enough for the 'auto' batch rule to consider the GPU
const blank = () => ({ dna: ch(new Uint8Array(300000), 600, 500), foci: ch(new Uint8Array(300000), 600, 500) });

async function rejects(p, code, re) {
  let err = null;
  try { await p; } catch (e) { err = e; }
  assert.ok(err, "expected a rejection");
  assert.ok(err instanceof Error);
  assert.equal(err.code, code, `code ${err.code} (${err.message})`);
  if (re) assert.match(err.message, re);
}

test("too_large: per-channel pixel limit, before any heavy allocation", async () => {
  const big = ch(new Uint8Array(5000 * 5000), 5000, 5000);      // 25 Mpx > the 16 Mpx default
  const t0 = performance.now();
  await rejects(Engine.analyze({ dna: big, foci: big }), "too_large", /Mpx/);
  assert.ok(performance.now() - t0 < 200, "rejected without doing any work");
  const { dna, foci } = await small();
  await rejects(Engine.analyze({ dna, foci }, { maxImagePixels: 500 }), "too_large");
  // the limit is configurable upwards and inclusive
  const r = await Engine.analyze({ dna, foci }, { maxImagePixels: 1024, mode: "reference" });
  assert.equal(r.image.width, 32);
  await rejects(Engine.analyze({ dna: ch(new Uint8Array(1), 70000, 1), foci: ch(new Uint8Array(1), 70000, 1) }, { maxImagePixels: 1e9 }), "too_large", /edge/);
});

test("too_large: estimated memory limit", async () => {
  const { dna, foci } = await small();
  await rejects(Engine.analyze({ dna, foci }, { maxMemoryBytes: 1000 }), "too_large", /memory/);
  assert.ok(Engine._internals.memoryEstimate(4000, 4000, false) < 1.6e9);
  assert.ok(Engine._internals.memoryEstimate(4000, 4000, true) > Engine._internals.memoryEstimate(4000, 4000, false));
});

test("bad_input: shapes, types, non-finite numbers", async () => {
  const d = new Uint8Array(32 * 32);
  await rejects(Engine.analyze(null), "bad_input");
  await rejects(Engine.analyze({}), "bad_input", /dna/);
  await rejects(Engine.analyze({ dna: ch(d, 32, 32) }), "bad_input", /foci/);
  await rejects(Engine.analyze({ dna: ch(d, 32, 32), foci: ch(new Uint8Array(33 * 32), 33, 32) }), "bad_input", /differ in size/);
  await rejects(Engine.analyze({ dna: ch(d, 32, 32), foci: ch(new Uint8Array(10), 32, 32) }), "bad_input", /length/);
  await rejects(Engine.analyze({ dna: ch(d, 32.5, 32), foci: ch(d, 32, 32) }), "bad_input");
  await rejects(Engine.analyze({ dna: ch(d, 0, 0), foci: ch(d, 0, 0) }), "bad_input");
  await rejects(Engine.analyze({ dna: ch(d, 32, 32, 10), foci: ch(d, 32, 32) }), "bad_input", /bitDepth/);
  await rejects(Engine.analyze({ dna: ch(new Uint16Array(1024), 32, 32, 8), foci: ch(d, 32, 32) }), "bad_input", /Uint8Array/);
  await rejects(Engine.analyze({ dna: ch([1, 2, 3], 3, 1), foci: ch(d, 32, 32) }), "bad_input");
  const f = new Float32Array(1024).fill(5);
  f[17] = NaN;
  await rejects(Engine.analyze({ dna: ch(f, 32, 32, 32), foci: ch(d, 32, 32) }), "bad_input", /non-finite/);
  f[17] = Infinity;
  await rejects(Engine.analyze({ dna: ch(f, 32, 32, 32), foci: ch(d, 32, 32) }), "bad_input", /non-finite/);
  const t = new Uint16Array(1024);
  t[3] = 4096;
  await rejects(Engine.analyze({ dna: ch(t, 32, 32, 12), foci: ch(d, 32, 32) }), "bad_input", /12 bits/);
  await rejects(Engine.analyze({ dna: ch(d, 32, 32), foci: ch(d, 32, 32) }, { mode: "turbo" }), "bad_input", /mode/);
  await rejects(Engine.analyze({ dna: ch(d, 32, 32), foci: ch(d, 32, 32) }, { maxImagePixels: NaN }), "bad_input");
});

test("bad_input: parameter validation mirrors the server's ranges", async () => {
  const { dna, foci } = await small();
  const bad = [{ min_height: NaN }, { min_height: Infinity }, { min_height: 0 }, { min_height: 256 }, { min_height: "12" },
    { tophat_size: 8 }, { tophat_size: 2 }, { tophat_size: 53 }, { peak_window: 4 }, { peak_window: 33 }, { background_size: 9 }, { background_size: 42 },
    { background_size: 303 }, { min_nucleus_px: 19 }, { min_nucleus_px: 1.5 }, { min_nucleus_px: 100001 }, { nucleus_sigma: 0 }, { nucleus_sigma: -1 },
    { foci_sigma: 11 }, { nope: 1 }, { __proto__: { x: 1 }, toString: 1 }];
  for (const params of bad) {
    await rejects(Engine.analyze({ dna, foci, params }, { mode: "reference" }), "bad_input");
  }
  await rejects(Engine.analyze({ dna, foci, params: [1] }), "bad_input");
  // boundaries are accepted
  for (const params of [{ min_height: 0.5 }, { min_height: 255 }, { tophat_size: 3 }, { tophat_size: 51 }, { peak_window: 31 }, { background_size: 301 }, { min_nucleus_px: 100000 }]) {
    const r = await Engine.analyze({ dna, foci, params }, { mode: "reference" });
    for (const k of Object.keys(params)) assert.equal(r.params[k], params[k]);
  }
  // defaults fill in
  const r = await Engine.analyze({ dna, foci, params: { min_height: 20 } }, { mode: "reference" });
  assert.deepEqual(r.params, { ...Engine.defaultParams(), min_height: 20 });
});

test("aborted: before start, and in the middle of a real analysis", async () => {
  const { dna, foci } = await loadCase(caseById("idr_1922398"));
  const ac0 = new AbortController();
  ac0.abort();
  await rejects(Engine.analyze({ dna, foci }, { signal: ac0.signal }), "aborted");
  const ac = new AbortController();
  const t0 = performance.now();
  const p = Engine.analyze({ dna, foci }, { mode: "reference", signal: ac.signal });
  setTimeout(() => ac.abort(), 25);
  await rejects(p, "aborted");
  assert.ok(performance.now() - t0 < 3000);
  // and the engine is still healthy afterwards
  const ok = await Engine.analyze({ dna: (await loadCase(caseById("idr_1922398"))).dna, foci: (await loadCase(caseById("idr_1922398"))).foci }, { mode: "reference" });
  assert.equal(ok.foci.count, caseById("idr_1922398").python.n_foci);
});

test("gpu mode without WebGPU rejects with gpu_lost; auto falls back to the CPU", async () => {
  const { dna, foci } = await small();
  await rejects(Engine.analyze({ dna, foci }, { mode: "gpu" }), "gpu_lost");
  const r = await Engine.analyze({ dna, foci }, { mode: "auto" });
  assert.equal(r.backend, "cpu-f64");
  const caps = await Engine.capabilities();
  assert.equal(caps.webgpu, false);
  assert.equal(caps.adapter, null);
  assert.equal(caps.selfTest, "skipped");
  assert.equal(caps.maxImagePixels, 16e6);
  assert.ok(caps.hardwareConcurrency >= 1);
});

test("device loss: the lost device is reported, explicit gpu mode fails, auto continues on the CPU", async () => {
  const { dna, foci } = await small();
  const G = Engine._internals.gpuState;
  const saved = { ...G };
  const hadNav = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { value: { gpu: {}, hardwareConcurrency: 4 }, configurable: true });
  try {
    G.lost = { reason: "destroyed", message: "test" };
    G.initPromise = Promise.resolve(null);
    await rejects(Engine.analyze({ dna, foci }, { mode: "gpu" }), "gpu_lost", /lost/);
    const r = await Engine.analyze(blank(), { mode: "auto", batchSize: 100 });
    assert.equal(r.backend, "cpu-f64");
    assert.ok(r.warnings.some((w) => /lost earlier/.test(w)), JSON.stringify(r.warnings));
  } finally {
    Object.assign(G, saved);
    if (hadNav) Object.defineProperty(globalThis, "navigator", hadNav); else delete globalThis.navigator;
  }
});

test("failed GPU self-test: explicit gpu mode rejects, auto reports it in warnings and uses the CPU", async () => {
  const { dna, foci } = await small();
  const G = Engine._internals.gpuState;
  const saved = { ...G };
  const hadNav = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { value: { gpu: {}, hardwareConcurrency: 4 }, configurable: true });
  try {
    G.lost = null; G.device = null; G.selfTest = "failed"; G.initPromise = Promise.resolve(null);
    await rejects(Engine.analyze({ dna, foci }, { mode: "gpu" }), "gpu_lost", /self-test/);
    const r = await Engine.analyze(blank(), { mode: "auto", batchSize: 100 });
    assert.equal(r.backend, "cpu-f64");
    assert.ok(r.warnings.some((w) => /self-test failed/.test(w)), JSON.stringify(r.warnings));
  } finally {
    Object.assign(G, saved);
    if (hadNav) Object.defineProperty(globalThis, "navigator", hadNav); else delete globalThis.navigator;
  }
});

test("the engine never mutates its inputs and is deterministic", async () => {
  const c = caseById("syn_seed2_8bit");
  const a = await loadCase(c), b = await loadCase(c);
  const before = { d: a.dna.data.slice(), f: a.foci.data.slice() };
  const r1 = await Engine.analyze({ dna: a.dna, foci: a.foci }, { mode: "reference", overlay: true });
  const r2 = await Engine.analyze({ dna: b.dna, foci: b.foci }, { mode: "reference", overlay: true });
  assert.deepEqual(a.dna.data, before.d);
  assert.deepEqual(a.foci.data, before.f);
  const strip = (r) => { const { timing_ms, overlay, ...rest } = r; return { rest, ov: Buffer.from(overlay.data.buffer).toString("base64") }; };
  assert.deepEqual(strip(r1), strip(r2));
  // same for 16-bit
  const c16 = caseById("syn_16bit");
  const s = await loadCase(c16);
  const t = await loadCase(c16);
  assert.deepEqual(strip(await Engine.analyze(s, { mode: "reference", overlay: true })), strip(await Engine.analyze(t, { mode: "reference", overlay: true })));
});

test("result shape follows the contract", async () => {
  const c = caseById("idr_1922398");
  const r = await Engine.analyze(await loadCase(c), { mode: "reference" });
  assert.equal(r.version, Engine.version);
  assert.match(Engine.version, /^\d+\.\d+\.\d+$/);
  assert.equal(r.backend, "cpu-f64");
  assert.equal(typeof r.timing_ms.total, "number");
  assert.deepEqual(r.image, { width: 696, height: 520 });
  for (const k of ["dna", "foci"]) {
    assert.equal(r.normalisation[k].method, "none");
    for (const f of ["lo", "hi", "clipped_fraction"]) assert.ok(f in r.normalisation[k]);
  }
  assert.equal(r.nuclei.count, c.python.n_nuclei);
  assert.equal(r.nuclei.object_count, r.nuclei.objects.length);
  assert.deepEqual(Object.keys(r.nuclei.objects[0]).sort(), ["area_px", "cx", "cy", "foci", "id", "nuclei_in_object"]);
  assert.equal(r.foci.per_cell, c.python.n_foci / c.python.n_nuclei);
  assert.deepEqual(Object.keys(r.foci.points[0]).sort(), ["height", "object", "x", "y"]);
  assert.deepEqual(r.params, Engine.defaultParams());
  assert.ok(Array.isArray(r.warnings));
  // centroid = mean pixel coordinate of the object (checked on object 1 via the label image)
  const dbg = await Engine.analyze(await loadCase(c), { mode: "reference", debug: true });
  const lab = dbg._debug.labels;
  let n = 0, sx = 0, sy = 0;
  for (let i = 0; i < lab.length; i++) if (lab[i] === 1) { n++; sx += i % 696; sy += Math.floor(i / 696); }
  assert.equal(r.nuclei.objects[0].area_px, n);
  assert.equal(r.nuclei.objects[0].cx, sx / n);
  assert.equal(r.nuclei.objects[0].cy, sy / n);
});

test("no nuclei: per_cell is null, a warning is given, the foci channel is not needed", async () => {
  const c = caseById("syn_empty_zero");
  const r = await Engine.analyze(await loadCase(c), { mode: "reference" });
  assert.equal(r.nuclei.count, 0);
  assert.equal(r.nuclei.object_count, 0);
  assert.equal(r.foci.count, 0);
  assert.equal(r.foci.per_cell, null);
  assert.ok(r.warnings.some((w) => /No nuclei/.test(w)));
});

test("warnings: saturation and flat images are reported", async () => {
  const r = await Engine.analyze(await loadCase(caseById("syn_saturated")), { mode: "reference" });
  assert.ok(r.warnings.some((w) => /saturated/.test(w)), JSON.stringify(r.warnings));
  const f = await Engine.analyze(await loadCase(caseById("syn_16bit_constant")), { mode: "reference" });
  assert.ok(f.warnings.some((w) => /no intensity range/.test(w)));
});

test("the engine source contains no network access and no dynamic code", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const dir = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "web", "engine");
  for (const f of ["engine.js", "worker.js"]) {
    const src = fs.readFileSync(path.join(dir, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const re of [/\bfetch\s*\(/, /XMLHttpRequest/, /WebSocket/, /EventSource/, /sendBeacon/, /\beval\s*\(/, /new\s+Function\b/, /\bimport\s*\(/, /https?:\/\//, /importScripts\s*\(\s*['"]https?/, /\.src\s*=/]) {
      assert.ok(!re.test(src), `${f} matches ${re}`);
    }
    // importScripts is allowed only for the engine itself, same directory
    for (const m of src.matchAll(/importScripts\(([^)]*)\)/g)) assert.match(m[1].trim(), /^'engine\.js' \+ \(/);
  }
});
