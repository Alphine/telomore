import test from "node:test";
import assert from "node:assert/strict";
import { Engine, manifest, loadCase, compareResult } from "./engine-util.mjs";

const M = manifest();
const caseById = (id) => M.cases.find((c) => c.id === id);

async function rejects(p, code) {
  let err = null;
  try { await p; } catch (e) { err = e; }
  assert.ok(err, "expected a rejection");
  assert.equal(err.code, code, `${err && err.code}: ${err && err.message}`);
}

test("pool: size defaults to min(hardwareConcurrency - 1, 4), at least 1; explicit sizes honoured", () => {
  const hc = (typeof navigator !== "undefined" && navigator.hardwareConcurrency) || 1;
  const p = Engine.createPool();
  assert.equal(p.size, Math.max(1, Math.min(hc - 1, 4)));
  p.terminate();
  const q = Engine.createPool(3);
  assert.equal(q.size, 3);
  q.terminate();
  assert.equal(typeof q.analyze, "function");
});

test("pool (inline under Node): results equal direct analyze and the golden fixtures, many tasks in flight", async () => {
  const pool = Engine.createPool(2);
  try {
    const ids = ["syn_seed1_8bit", "syn_16bit", "syn_32x32", "syn_dense_touching", "idr_3053300_crop"];
    const out = await Promise.all(ids.map(async (id) => {
      const c = caseById(id);
      const res = await pool.analyze({ ...(await loadCase(c)), params: c.params }, { mode: "reference" });
      return compareResult(res, c.python);
    }));
    out.forEach((bad) => assert.deepEqual(bad, []));
  } finally { pool.terminate(); }
});

test("pool: bad input and too_large reject with the engine's codes", async () => {
  const pool = Engine.createPool(1);
  try {
    const c = await loadCase(caseById("syn_32x32"));
    await rejects(pool.analyze({ dna: c.dna }), "bad_input");
    await rejects(pool.analyze({ ...c, params: { min_height: NaN } }), "bad_input");
    await rejects(pool.analyze(c, { maxImagePixels: 10 }), "too_large");
    await rejects(pool.analyze(c, { mode: "gpu" }), "gpu_lost");
  } finally { pool.terminate(); }
});

test("pool: abort a queued task and a running task; the pool keeps working", async () => {
  const pool = Engine.createPool(1);
  try {
    const big = caseById("idr_1922398");
    const ac1 = new AbortController(), ac2 = new AbortController();
    const running = pool.analyze(await loadCase(big), { mode: "reference", signal: ac1.signal });
    const queued = pool.analyze(await loadCase(big), { mode: "reference", signal: ac2.signal });
    setTimeout(() => ac1.abort(), 20);
    ac2.abort();
    await rejects(queued, "aborted");
    await rejects(running, "aborted");
    const c = caseById("syn_seed3_8bit");
    const res = await pool.analyze({ ...(await loadCase(c)) }, { mode: "reference" });
    assert.deepEqual(compareResult(res, c.python), []);
    const pre = new AbortController();
    pre.abort();
    await rejects(pool.analyze(await loadCase(c), { signal: pre.signal }), "aborted");
  } finally { pool.terminate(); }
});

test("pool: terminate() rejects everything outstanding and later calls; nothing is left hanging", async () => {
  const pool = Engine.createPool(1);
  const big = caseById("idr_1922398");
  const a = pool.analyze(await loadCase(big), { mode: "reference" });
  const b = pool.analyze(await loadCase(big), { mode: "reference" });
  a.catch(() => {}); b.catch(() => {});
  pool.terminate();
  // the first may already be executing inline; it is cancelled at its next stage boundary or finishes: never hangs
  const settled = await Promise.race([
    Promise.allSettled([a, b]),
    new Promise((r) => setTimeout(() => r("hung"), 10000)),
  ]);
  assert.notEqual(settled, "hung");
  assert.equal(settled[1].status, "rejected");
  assert.equal(settled[1].reason.code, "aborted");
  await rejects(pool.analyze(await loadCase(caseById("syn_32x32"))), "aborted");
});

test("pool: the caller's buffers are not detached under Node (inline) and inputs are untouched", async () => {
  const pool = Engine.createPool(1);
  try {
    const c = await loadCase(caseById("syn_seed1_8bit"));
    await pool.analyze(c, { mode: "reference" });
    assert.equal(c.dna.data.byteLength, 320 * 240);
  } finally { pool.terminate(); }
});

test("worker script is well-formed: only same-directory importScripts, posts ready and typed results", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const f = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "web", "engine", "worker.js");
  const src = fs.readFileSync(f, "utf8");
  assert.match(src, /importScripts\('engine\.js' \+ /);
  assert.match(src, /type: 'ready'/);
  assert.match(src, /postMessage\(\{ id: m\.id, ok: true/);
  assert.match(src, /postMessage\(\{ id: m\.id, ok: false/);
});
