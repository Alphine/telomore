// Exercises the *browser* code path of createPool() (real message passing, transfer lists, terminate-on-abort,
// timeouts, crash fallbacks) under Node by giving it a Worker built on node:worker_threads that runs the real
// foci/web/engine/worker.js with the few browser globals it needs (self, importScripts, postMessage).
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { Worker as NodeWorker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { Engine, manifest, loadCase, compareResult } from "./engine-util.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const engineDir = path.join(here, "..", "web", "engine");
const M = manifest();
const caseById = (id) => M.cases.find((c) => c.id === id);

const SHIM = `
const { parentPort, workerData } = require('worker_threads');
const fs = require('fs'), path = require('path');
globalThis.self = globalThis;
globalThis.module = undefined;   // a browser worker has no CommonJS module object
self.location = { search: workerData.search };
self.importScripts = function (u) {
  const file = path.join(workerData.dir, String(u).split('?')[0]);
  (0, eval)(fs.readFileSync(file, 'utf8'));
};
self.postMessage = (m, t) => parentPort.postMessage(m, t || []);
parentPort.on('message', (d) => { if (workerData.crashOnMessage) throw new Error('boom on message'); if (self.onmessage) self.onmessage({ data: d }); });
if (workerData.crashOnStart) throw new Error('boom on start');
(0, eval)(fs.readFileSync(path.join(workerData.dir, 'worker.js'), 'utf8'));
`;

let live = 0, created = 0;
function installWorker(mode = {}) {
  globalThis.Worker = class {
    constructor(url) {
      created++; live++;
      this._w = new NodeWorker(SHIM, { eval: true, workerData: { dir: engineDir, search: String(url).includes("?") ? "?" + String(url).split("?")[1] : "", ...mode } });
      this._w.on("message", (m) => this.onmessage && this.onmessage({ data: m }));
      this._w.on("error", (e) => this.onerror && this.onerror({ message: e.message, preventDefault() {} }));
      this._w.on("exit", () => { live--; });
    }
    postMessage(m, t) { this._w.postMessage(m, t); }
    terminate() { this._w.terminate(); }
  };
}
function uninstallWorker() { delete globalThis.Worker; }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function rejects(p, code) {
  let err = null;
  try { await p; } catch (e) { err = e; }
  assert.ok(err, "expected a rejection");
  assert.equal(err.code, code, `${err.code}: ${err.message}`);
}

test("worker pool: golden results through real workers, transfer detaches the caller's buffers, overlay comes back", async () => {
  installWorker();
  const pool = Engine.createPool(2, { inline: false });
  try {
    assert.equal(pool.inline, false);
    const ids = ["syn_seed1_8bit", "syn_16bit", "idr_3053300_crop", "syn_32x32", "syn_empty_zero"];
    const results = await Promise.all(ids.map(async (id) => {
      const c = caseById(id), inp = await loadCase(c);
      const res = await pool.analyze({ ...inp, params: c.params }, { mode: "reference", overlay: true });
      assert.equal(inp.dna.data.byteLength, 0, "buffer was transferred to the worker");
      assert.ok(res.overlay.data instanceof Uint8ClampedArray && res.overlay.data.length === c.width * c.height * 4);
      return compareResult(res, c.python);
    }));
    results.forEach((bad) => assert.deepEqual(bad, []));
    assert.ok(created <= 2, `at most pool-size workers were created (${created})`);
    // opts.transfer=false keeps the caller's data
    const c = caseById("syn_32x32"), inp = await loadCase(c);
    await pool.analyze(inp, { mode: "reference", transfer: false });
    assert.equal(inp.dna.data.byteLength, 32 * 32);
  } finally { pool.terminate(); uninstallWorker(); }
  await wait(200);
  assert.equal(live, 0, "no worker threads left after terminate()");
});

test("worker pool: aborting a running analysis kills that worker; the next task gets a fresh one", async () => {
  installWorker();
  created = 0;
  const pool = Engine.createPool(1, { inline: false });
  try {
    const big = caseById("idr_1922398");
    const ac = new AbortController();
    const running = pool.analyze(await loadCase(big), { mode: "reference", signal: ac.signal });
    setTimeout(() => ac.abort(), 30);
    await rejects(running, "aborted");
    const c = caseById("syn_seed2_8bit");
    const res = await pool.analyze(await loadCase(c), { mode: "reference" });
    assert.deepEqual(compareResult(res, c.python), []);
    assert.equal(created, 2, "the aborted worker was replaced");
  } finally { pool.terminate(); uninstallWorker(); }
  await wait(200);
  assert.equal(live, 0);
});

test("worker pool: timeout terminates a stuck worker and rejects", async () => {
  installWorker();
  const pool = Engine.createPool(1, { inline: false, timeoutMs: 20 });
  try {
    const big = caseById("idr_1922398");
    await rejects(pool.analyze(await loadCase(big), { mode: "reference" }), "aborted");
  } finally { pool.terminate(); uninstallWorker(); }
  await wait(200);
  assert.equal(live, 0);
});

test("worker pool: errors inside the worker arrive with the engine's codes", async () => {
  installWorker();
  const pool = Engine.createPool(1, { inline: false });
  try {
    const c = await loadCase(caseById("syn_32x32"));
    await rejects(pool.analyze(c, { mode: "gpu" }), "gpu_lost");                // worker has no WebGPU
    const d = await loadCase(caseById("syn_32x32"));
    await rejects(pool.analyze(d, { maxImagePixels: 10 }), "too_large");
    const e = await loadCase(caseById("syn_32x32"));
    const ok = await pool.analyze(e, { mode: "reference" });
    assert.equal(ok.backend, "cpu-f64");
  } finally { pool.terminate(); uninstallWorker(); }
});

test("worker pool: a worker that cannot start falls back to running on the calling thread", async () => {
  installWorker({ crashOnStart: true });
  const pool = Engine.createPool(1, { inline: false });
  try {
    const c = caseById("syn_seed3_8bit");
    const res = await pool.analyze({ ...(await loadCase(c)) }, { mode: "reference" });
    assert.deepEqual(compareResult(res, c.python), []);
    const res2 = await pool.analyze({ ...(await loadCase(c)) }, { mode: "reference" });
    assert.deepEqual(compareResult(res2, c.python), []);
  } finally { pool.terminate(); uninstallWorker(); }
});

test("worker pool: a worker that crashes mid-analysis rejects (never hangs) and the pool recovers", async () => {
  installWorker({ crashOnMessage: true });
  const pool = Engine.createPool(1, { inline: false });
  try {
    const big = caseById("idr_1922398");
    const p = pool.analyze(await loadCase(big), { mode: "reference" });
    p.catch(() => {});
    const settled = await Promise.race([p.then(() => "ok", (e) => e.code), wait(8000).then(() => "hung")]);
    assert.notEqual(settled, "hung");
    assert.equal(settled, "internal");
    uninstallWorker();
    installWorker();
    const c = caseById("syn_32x32");
    const ok = await pool.analyze(await loadCase(c), { mode: "reference" });
    assert.equal(ok.image.width, 32);
  } finally { pool.terminate(); uninstallWorker(); }
});

test("worker pool: queued tasks run in order with pool size 1; terminate() rejects the rest", async () => {
  installWorker();
  const pool = Engine.createPool(1, { inline: false });
  const order = [];
  try {
    const c = caseById("syn_seed1_8bit");
    const ps = [0, 1, 2].map(async (i) => { const r = await pool.analyze(await loadCase(c), { mode: "reference" }); order.push(i); return r; });
    await Promise.all(ps);
    assert.deepEqual(order, [0, 1, 2]);
    const a = pool.analyze(await loadCase(caseById("idr_1922398")), { mode: "reference" });
    const b = pool.analyze(await loadCase(caseById("idr_1922398")), { mode: "reference" });
    a.catch(() => {}); b.catch(() => {});
    pool.terminate();
    await rejects(a, "aborted");
    await rejects(b, "aborted");
    await rejects(pool.analyze(await loadCase(c)), "aborted");
  } finally { pool.terminate(); uninstallWorker(); }
  await wait(200);
  assert.equal(live, 0);
});

test("worker pool: the version token of the page's script tag is handed to the worker", async () => {
  // engine.js derives the worker URL from document.currentScript.src (with its ?v=HASH stamp); here only the default is visible
  installWorker();
  let seen = "";
  const Orig = globalThis.Worker;
  globalThis.Worker = class extends Orig { constructor(u) { seen = String(u); super(u); } };
  const pool = Engine.createPool(1, { inline: false });
  try {
    await pool.analyze(await loadCase(caseById("syn_32x32")), { mode: "reference" });
    assert.match(seen, new RegExp("worker\\.js\\?v=" + Engine.version.replace(/\./g, "\\.") + "$"));
  } finally { pool.terminate(); uninstallWorker(); }
});
