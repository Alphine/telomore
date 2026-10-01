#!/usr/bin/env node
// Accuracy evaluation of a Foci Lab counting engine on ONE real plate (idr0010 plate 7-14), against the authors'
// per-well numbers, under BOTH candidate image<->annotation pairings (docs/EXPERIMENT_PROTOCOL.md 15.4 -- which pairing is
// right is UNRESOLVED; neither is asserted here).
//
//   node scripts/eval_foci_screen_engine.mjs --results <results.json> [--out experiments/reports/foci_screen_eval.json]
//   node scripts/eval_foci_screen_engine.mjs --engine foci/web/engine/engine.js --images <dir>/7-14 [--mode reference]
//
// A results file is {"engine","version","backend","params","wells":{"A1":{"nuclei":n,"foci":f}, ...}}. It is produced by
// scripts/eval_foci_screen_prepare.py (Python reference pipeline) or by this script's --engine branch (the ENGINE agent's
// browser engine run in Node, CPU "reference" mode, on the same 8-bit PNGs). The evaluation itself is shared, so the
// Python pipeline and the JS engine are scored by identical code.
//
// Definitions follow Experiment L2 (scripts/redo_experiment_l_raw16.py): eligible wells = authors' QC pass (Quality
// Control empty), not a control, Foci Per Cell present, Cell Count > 0; wells without a nucleus in OUR image are dropped
// (and listed); "increased DNA damage" = annotation Phenotype 1 == "increased DNA damage"; bootstrap = 2000 percentile
// resamples over wells, seed 0 (own PRNG, so the CI bounds differ slightly from numpy's).
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { inflateSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const S = require(path.join(root, "foci", "web", "screen-core.js"));
export const PLATE = "7-14";
export const ROWS = 12, COLS = 32;

// ------------------------------------------------------------------------------------------------ PNG decode
/** Minimal PNG reader: 8-bit, non-interlaced, grey / RGB / RGBA / grey+alpha. Returns {width, height, data: Uint8Array} = first channel. */
export function decodePng(buf) {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) if (buf[i] !== sig[i]) throw new Error("not a PNG");
  let p = 8, width = 0, height = 0, depth = 0, ctype = 0, interlace = 0; const idat = [];
  while (p + 8 <= buf.length) {
    const len = buf.readUInt32BE(p), type = buf.toString("latin1", p + 4, p + 8), body = buf.subarray(p + 8, p + 8 + len);
    if (type === "IHDR") { width = body.readUInt32BE(0); height = body.readUInt32BE(4); depth = body[8]; ctype = body[9]; interlace = body[12]; }
    else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") break;
    p += 12 + len;
  }
  if (depth !== 8 || interlace !== 0 || ![0, 2, 4, 6].includes(ctype)) throw new Error(`unsupported PNG (depth ${depth}, colour type ${ctype}, interlace ${interlace})`);
  const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[ctype], stride = width * bpp;
  const raw = inflateSync(Buffer.concat(idat));
  if (raw.length !== (stride + 1) * height) throw new Error("bad PNG size");
  const out = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[dst + x - bpp] : 0, b = y ? out[dst - stride + x] : 0, c = x >= bpp && y ? out[dst - stride + x - bpp] : 0;
      let v = raw[src + x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      else if (f !== 0) throw new Error("bad PNG filter");
      out[dst + x] = v & 255;
    }
  }
  const data = new Uint8Array(width * height);
  for (let i = 0; i < data.length; i++) data[i] = out[i * bpp];
  return { width, height, data };
}

// ------------------------------------------------------------------------------------------ statistics
function mulberry32(a) { return function () { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function quantile(sorted, q) { const p = (sorted.length - 1) * q, i = Math.floor(p), f = p - i; return i + 1 < sorted.length ? sorted[i] * (1 - f) + sorted[i + 1] * f : sorted[i]; }
export function pearson(x, y) {
  const n = x.length; if (n < 3) return NaN;
  let mx = 0, my = 0; for (let i = 0; i < n; i++) { mx += x[i]; my += y[i]; } mx /= n; my /= n;
  let sxx = 0, syy = 0, sxy = 0; for (let i = 0; i < n; i++) { const dx = x[i] - mx, dy = y[i] - my; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : NaN;
}
export function spearmanNaN(x, y) { const r = S.spearman(x, y); return r.rho == null ? NaN : r.rho; }
/** AUC = P(pos > neg) + 0.5 P(tie), via average ranks. */
export function auc(pos, neg) {
  const p = pos.filter(Number.isFinite), q = neg.filter(Number.isFinite);
  if (!p.length || !q.length) return NaN;
  const r = S.rankAverage(p.concat(q)); let sum = 0; for (let i = 0; i < p.length; i++) sum += r[i];
  return (sum - p.length * (p.length + 1) / 2) / (p.length * q.length);
}
/** Percentile CI of fn(indices) over resamples of 0..n-1 (stratified when strata given). */
export function bootstrapCi(fn, n, { boot = 2000, seed = 0, strata = null } = {}) {
  const rnd = mulberry32(seed + 1), groups = [];
  if (!strata) groups.push(Array.from({ length: n }, (_, i) => i));
  else for (const s of [...new Set(strata)].sort()) groups.push(strata.map((v, i) => (v === s ? i : -1)).filter((i) => i >= 0));
  const vals = [];
  for (let b = 0; b < boot; b++) {
    const idx = [];
    for (const g of groups) for (let k = 0; k < g.length; k++) idx.push(g[Math.floor(rnd() * g.length)]);
    const v = fn(idx); if (Number.isFinite(v)) vals.push(v);
  }
  if (vals.length < Math.max(10, boot / 10)) return [NaN, NaN];
  vals.sort((a, b) => a - b);
  return [quantile(vals, 0.025), quantile(vals, 0.975)];
}
const r4 = (x) => (Number.isFinite(x) ? Math.round(x * 1e4) / 1e4 : null);
function corrBlock(ours, theirs, opts) {
  const pick = (idx, v) => idx.map((i) => v[i]);
  const rho = spearmanNaN(ours, theirs), pr = pearson(ours, theirs);
  const ci = bootstrapCi((idx) => spearmanNaN(pick(idx, ours), pick(idx, theirs)), ours.length, opts);
  return { n: ours.length, spearman: r4(rho), spearman_ci95: ci.map(r4), pearson: r4(pr) };
}
function aucBlock(score, isPos, opts) {
  const pos = score.filter((_, i) => isPos[i]), neg = score.filter((_, i) => !isPos[i]);
  const a = auc(pos, neg);
  const ci = bootstrapCi((idx) => { const p = [], q = []; for (const i of idx) (isPos[i] ? p : q).push(score[i]); return auc(p, q); }, score.length, { ...opts, strata: isPos.map((v) => (v ? 1 : 0)) });
  return { n_pos: pos.length, n_neg: neg.length, auc: r4(a), auc_ci95: ci.map(r4) };
}

// ------------------------------------------------------------------------------------------ pairings
/** The image well (name) that annotation row {name, number} is paired with under each rule (inverse of the page's image -> annotation rule). */
export function imageWellFor(pairing, row) {
  if (pairing === "name") return row.name;
  if (pairing === "colmajor") { const n = row.number - 1; return S.rcToWell(n % ROWS, Math.floor(n / ROWS)); }
  throw new Error("unknown pairing " + pairing);
}

// ------------------------------------------------------------------------------------------ annotation
export function loadAnnotation(file, plate = PLATE) {
  const rows = S.parseCsv(readFileSync(file, "utf8")), h = rows[0], ci = Object.fromEntries(h.map((k, i) => [k, i]));
  for (const k of ["Plate", "Well Number", "Well", "Control Type", "Quality Control", "Cell Count", "Foci Per Cell", "Phenotype 1"]) if (!(k in ci)) throw new Error("annotation column missing: " + k);
  const num = (s) => (s === "" || s == null ? NaN : Number(s));
  return rows.slice(1).filter((r) => r[ci.Plate] === plate).map((r) => ({
    name: r[ci.Well], number: Number(r[ci["Well Number"]]), control: r[ci["Control Type"]], qcRemoved: r[ci["Quality Control"]] !== "",
    cells: num(r[ci["Cell Count"]]), fpc: num(r[ci["Foci Per Cell"]]), increased: r[ci["Phenotype 1"]] === "increased DNA damage",
  }));
}
/** Rows of foci_wells.csv for the plate in the same shape (what the plate page can see: sample wells with a gene symbol). */
export function loadWellsCsv(file, plate = PLATE) {
  const rows = S.parseCsv(readFileSync(file, "utf8")), h = rows[0], ci = Object.fromEntries(h.map((k, i) => [k, i]));
  const out = [], pre = plate + "_";
  for (const r of rows.slice(1)) {
    if (!r[ci.plate_well].startsWith(pre)) continue;
    const name = r[ci.plate_well].slice(pre.length), rc = S.wellToRC(name);
    if (!rc) continue;
    out.push({ name, number: rc.r * COLS + rc.c + 1, control: "", qcRemoved: r[ci.qc] !== "pass", cells: Number(r[ci.cells]), fpc: Number(r[ci.fpc]), increased: false });
  }
  return out;
}

// ------------------------------------------------------------------------------------------ evaluation
/** ours = {well: {nuclei, foci}}. Returns the per-pairing evaluation for the eligible authors' rows. */
export function evaluate(annotRows, ours, pairing, { boot = 2000, seed = 0, withAuc = true } = {}) {
  const elig = annotRows.filter((r) => !r.qcRemoved && !r.control && Number.isFinite(r.fpc) && r.cells > 0);
  const kept = [], dropped = [];
  for (const r of elig) {
    const w = imageWellFor(pairing, r), o = ours[w];
    if (o && o.nuclei > 0 && Number.isFinite(o.foci)) kept.push({ ...r, image: w, fpcOurs: o.foci / o.nuclei, nuclei: o.nuclei });
    else dropped.push(w);
  }
  const opts = { boot, seed };
  const y = kept.map((k) => k.fpc), x = kept.map((k) => k.fpcOurs);
  const out = {
    pairing, wells: { eligible: elig.length, analysed: kept.length, dropped_no_nuclei_or_missing_image: dropped.sort(), n_increased_damage: kept.filter((k) => k.increased).length },
    foci_per_cell_vs_authors: corrBlock(x, y, opts),
    nuclei_vs_authors_cell_count: corrBlock(kept.map((k) => k.nuclei), kept.map((k) => k.cells), opts),
    median_foci_per_cell: { ours: r4(median(x)), authors: r4(median(y)) },
  };
  if (withAuc) {
    const inc = kept.map((k) => k.increased);
    out.auc_increased_damage = { ours_foci_per_cell: aucBlock(x, inc, opts), authors_foci_per_cell_ceiling: aucBlock(y, inc, opts) };
  }
  return out;
}
function median(a) { const s = a.filter(Number.isFinite).sort((p, q) => p - q); return s.length ? quantile(s, 0.5) : NaN; }

// ------------------------------------------------------------------------------------------ running an engine
export async function runEngine(enginePath, imagesDir, mode) {
  globalThis.self = globalThis.self || globalThis;
  let E;
  try { const m = require(path.resolve(enginePath)); E = globalThis.FociEngine || (m && (m.FociEngine || m)); } catch (e) { throw new Error("cannot load engine " + enginePath + ": " + e.message); }
  if (!E || typeof E.analyze !== "function") throw new Error("engine has no analyze()");
  const names = [...new Set(readdirSync(imagesDir).filter((f) => f.endsWith(".dna.png")).map((f) => f.split(".")[0]))].sort();
  const wells = {}; let version = null, backend = null, params = null;
  try { params = typeof E.defaultParams === "function" ? await E.defaultParams() : null; } catch { /* optional */ }
  for (const w of names) {
    const d = decodePng(readFileSync(path.join(imagesDir, `${w}.dna.png`))), f = decodePng(readFileSync(path.join(imagesDir, `${w}.foci.png`)));
    const res = await E.analyze({ dna: { data: d.data, width: d.width, height: d.height, bitDepth: 8 }, foci: { data: f.data, width: f.width, height: f.height, bitDepth: 8 }, params }, { mode });
    version = version || res.version; backend = backend || res.backend;
    wells[w] = { nuclei: res.nuclei.count, foci: res.foci.count };
  }
  return { engine: "FociEngine (Node, " + mode + ")", version, backend, params, images: imagesDir, wells };
}

// ------------------------------------------------------------------------------------------ main
function arg(name, def) { const i = process.argv.indexOf("--" + name); return i >= 0 ? process.argv[i + 1] : def; }
async function main() {
  const annotFile = arg("annotation", path.join(root, ".cache", "idr0010", "annotation.csv"));
  const wellsCsv = arg("wells-csv", path.join(root, "foci", "web", "data", "downloads", "foci_wells.csv"));
  const l2File = arg("l2", path.join(root, "experiments", "reports", "foci_raw16.json"));
  const outFile = arg("out", path.join(root, "experiments", "reports", "foci_screen_eval.json"));
  const boot = Number(arg("boot", "2000"));
  let results;
  if (arg("results")) results = JSON.parse(readFileSync(arg("results"), "utf8"));
  else if (arg("engine")) {
    results = await runEngine(arg("engine"), arg("images"), arg("mode", "reference"));
    if (arg("save-results")) writeFileSync(arg("save-results"), JSON.stringify(results));
  } else { console.error("need --results <file> or --engine <engine.js> --images <dir>"); process.exit(2); }

  const A = loadAnnotation(annotFile), W = loadWellsCsv(wellsCsv);
  const ev = { full_annotation: {}, page_data_foci_wells_csv: {} };
  for (const p of S.PAIRINGS) {
    ev.full_annotation[p] = evaluate(A, results.wells, p, { boot });
    ev.page_data_foci_wells_csv[p] = evaluate(W, results.wells, p, { boot, withAuc: false });
  }
  let l2 = null;
  if (existsSync(l2File)) {
    const j = JSON.parse(readFileSync(l2File, "utf8")), pick = (k) => { const a = j.results[k].arms.legacy_8bit_default; return { foci_per_cell_spearman: a.foci_per_cell_vs_authors.spearman, foci_per_cell_spearman_ci95: a.foci_per_cell_vs_authors.spearman_ci95, nuclei_vs_cells_spearman: a.nuclei_vs_authors_cell_count.spearman, auc_increased_damage: a.phenotype_increased_damage.fpc.auc, auc_ci95: a.phenotype_increased_damage.fpc.auc_ci95, n: a.foci_per_cell_vs_authors.n }; };
    l2 = { source: "experiments/reports/foci_raw16.json, arm legacy_8bit_default (Python count_foci, default parameters, 8-bit render)", name_pairing: pick("annotation_well_name"), colmajor_pairing: pick("column_major_well_number") };
  }
  const out = {
    experiment: "Foci Lab plate mode: engine accuracy on plate " + PLATE,
    generated_utc: new Date().toISOString(),
    engine: { name: results.engine, version: results.version ?? null, backend: results.backend ?? null, params: results.params ?? null },
    images: results.images || "8-bit PNGs of plate 7-14 (see scripts/eval_foci_screen_prepare.py)",
    pairing_status: "UNRESOLVED (docs/EXPERIMENT_PROTOCOL.md 15.4): both pairings are reported; neither is asserted to be correct",
    pairings: { name: "image of well W with the annotation row named W", colmajor: "annotation Well Number n is the image at column (n-1) div 12, row (n-1) mod 12 (column-major grid, 12 rows)" },
    bootstrap: { resamples: boot, seed: 0, interval: "95% percentile, wells resampled (AUC: stratified)" },
    evaluation: ev,
    experiment_l2_reference: l2,
  };
  mkdirSync(path.dirname(outFile), { recursive: true });
  writeFileSync(outFile, JSON.stringify(out, null, 1) + "\n");
  for (const p of S.PAIRINGS) {
    const e = ev.full_annotation[p];
    console.log(`${p}: n=${e.wells.analysed}  foci/cell rho=${e.foci_per_cell_vs_authors.spearman} ${JSON.stringify(e.foci_per_cell_vs_authors.spearman_ci95)}  nuclei rho=${e.nuclei_vs_authors_cell_count.spearman}  AUC=${e.auc_increased_damage.ours_foci_per_cell.auc} ${JSON.stringify(e.auc_increased_damage.ours_foci_per_cell.auc_ci95)}`);
  }
  console.log("wrote " + outFile);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error(e.message); process.exit(1); });
