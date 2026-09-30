// Shared helpers for the engine tests (not itself a test file).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
export const Engine = require("../web/engine/engine.js");
export const { decodePng } = require("../web/engine/dev/pngdecode.js");
export const GOLD = path.join(here, "fixtures", "engine_golden");

export function manifest() {
  return JSON.parse(fs.readFileSync(path.join(GOLD, "manifest.json"), "utf8"));
}

const cache = new Map();
/** Decode a case's two PNGs into engine channels (fresh copies every call: the engine may not mutate them). */
export async function loadCase(entry) {
  let pair = cache.get(entry.id);
  if (!pair) {
    const dna = await decodePng(fs.readFileSync(path.join(GOLD, entry.files.dna)));
    const foci = await decodePng(fs.readFileSync(path.join(GOLD, entry.files.foci)));
    pair = { dna, foci };
    cache.set(entry.id, pair);
  }
  const ch = (c) => ({ data: c.data.slice(), width: c.width, height: c.height, bitDepth: entry.bit_depth });
  return { dna: ch(pair.dna), foci: ch(pair.foci) };
}

export function sha(typed) {
  return crypto.createHash("sha256").update(new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength)).digest("hex");
}

/** max |a-b| and number of differing elements */
export function diff(a, b) {
  let m = 0, n = 0;
  for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - b[i]); if (d > m) m = d; if (a[i] !== b[i]) n++; }
  return { max: m, count: n };
}

/** Compare an engine result with the Python record: returns a list of human-readable mismatches. */
export function compareResult(res, py) {
  const bad = [];
  if (res.nuclei.object_count !== py.n_objects) bad.push(`objects ${res.nuclei.object_count} != ${py.n_objects}`);
  if (res.nuclei.count !== py.n_nuclei) bad.push(`nuclei ${res.nuclei.count} != ${py.n_nuclei}`);
  if (res.foci.count !== py.n_foci) bad.push(`foci ${res.foci.count} != ${py.n_foci}`);
  const per = res.nuclei.objects.map((o) => o.foci);
  if (JSON.stringify(per) !== JSON.stringify(py.foci_per_object)) bad.push("foci per object differ");
  const area = res.nuclei.objects.map((o) => o.area_px);
  if (JSON.stringify(area) !== JSON.stringify(py.object_area)) bad.push("object areas differ");
  const est = res.nuclei.objects.map((o) => o.nuclei_in_object);
  if (JSON.stringify(est) !== JSON.stringify(py.nuclei_in_object)) bad.push("nuclei_in_object differ");
  if (res.foci.points.length !== py.peaks.length) bad.push(`peak list length ${res.foci.points.length} != ${py.peaks.length}`);
  else {
    for (let i = 0; i < py.peaks.length; i++) {
      const [x, y, h, o] = py.peaks[i], p = res.foci.points[i];
      if (p.x !== x || p.y !== y || p.object !== o || Math.fround(h) !== p.height) { bad.push(`peak ${i}: (${p.x},${p.y},${p.height},${p.object}) != (${x},${y},${h},${o})`); break; }
    }
  }
  return bad;
}
