import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const S = require("../web/screen-core.js");
const close = (a, b, eps = 1e-12) => assert.ok(Math.abs(a - b) <= eps, `${a} vs ${b}`);

// ---------------------------------------------------------------- Spearman (scipy 1.18 values in the fixture)
test("Spearman matches scipy.stats.spearmanr, including ties and a constant input", () => {
  const cases = JSON.parse(readFileSync(path.join(here, "fixtures", "screen_spearman_scipy.json"), "utf8"));
  assert.equal(cases.length, 7);
  for (const c of cases) {
    const r = S.spearman(c.x, c.y);
    if (c.rho === null) { assert.equal(r.rho, null); assert.match(r.reason, /constant/); }
    else close(r.rho, c.rho, 1e-12);
    assert.equal(r.n, c.x.length);
  }
});
test("Spearman edge cases: non-finite pairs dropped, too few pairs, both constant, symmetric", () => {
  const r = S.spearman([1, 2, NaN, 4, 5, Infinity], [2, 4, 9, 8, 10, 1]);
  assert.equal(r.n, 4); close(r.rho, 1);
  assert.equal(S.spearman([1, 2], [1, 2]).rho, null);
  assert.equal(S.spearman([], []).n, 0);
  assert.equal(S.spearman([3, 3, 3], [3, 3, 3]).rho, null);
  assert.equal(S.spearman([1, 2, 3, 4], [null, undefined, "a", 4]).n, 1);
  const x = [5, 1, 4, 4, 2], y = [1, 3, 2, 2, 9];
  close(S.spearman(x, y).rho, S.spearman(y, x).rho);
  assert.deepEqual(S.rankAverage([10, 20, 20, 30]), [1, 2.5, 2.5, 4]);
  assert.deepEqual(S.rankAverage([]), []);
});

// ------------------------------------------------------------------------------------------------- CSV
test("CSV parser: BOM, CRLF, quotes, embedded comma/newline/quote, empty fields, no trailing newline", () => {
  const t = '﻿a,b,c\r\n1,"x, y",\r\n"he said ""hi""","line1\nline2",3\r\n,,\r\nlast,1,2';
  assert.deepEqual(S.parseCsv(t), [["a", "b", "c"], ["1", "x, y", ""], ['he said "hi"', "line1\nline2", "3"], ["", "", ""], ["last", "1", "2"]]);
  assert.deepEqual(S.parseCsv(""), []);
  assert.deepEqual(S.parseCsv("a\n\nb\n"), [["a"], ["b"]]);
  assert.deepEqual(S.parseCsv('a,"b'), [["a", "b"]]);            // unterminated quote: no crash
  assert.deepEqual(S.parseCsv("x,y\r1,2\r"), [["x", "y"], ["1", "2"]]);
});
test("CSV writer quotes and guards formulas; numbers stay numbers", () => {
  assert.equal(S.csvCell('a"b'), '"a""b"');
  assert.equal(S.csvCell("=1+1"), "'=1+1");
  assert.equal(S.csvCell("-12.5"), "-12.5");
  assert.equal(S.csvCell(NaN), "");
  assert.equal(S.csvCell(null), "");
  assert.equal(S.csvCell("x,y"), '"x,y"');
  assert.equal(S.toCsvText(["a", "b"], [[1, "q"], [2, null]]), "a,b\r\n1,q\r\n2,\r\n");
});

// ---------------------------------------------------------------------- authors' table / plate validation
const CSV = 'plate_well,gene,ensembl,sirna,sense,antisense,cells,fpc,norm_fpc,z,qc,imaged,gene_status\n' +
  '7-14_A2,PHYHD1,E1,1,s,a,212,1.283,0.725,,remove,true,none\n7-14_A3,"X, Y",E2,2,s,a,177,0.605,0.342,-0.3,pass,true,none\n' +
  '7-14_A13,G3,E3,3,s,a,100,2.5,1.1,0.2,pass,true,none\n85_A1,OTHER,E4,4,s,a,50,1,1,0,pass,true,none\n7-14_ZZ9,BAD,E5,5,s,a,1,1,1,0,pass,true,none\n';
test("indexAuthors keeps only this plate's well names (A1, not A01) and parses numbers", () => {
  const a = S.indexAuthors(S.parseCsv(CSV), "7-14");
  assert.deepEqual(Object.keys(a).sort(), ["A13", "A2", "A3"]);
  assert.deepEqual(a.A3, { cells: 177, fpc: 0.605, normFpc: 0.342, qc: "pass", gene: "X, Y" });
  assert.equal(a.A2.qc, "remove");
  assert.equal(Object.keys(S.indexAuthors(S.parseCsv(CSV), "7-1")).length, 0);        // prefix must match the whole plate name
  assert.throws(() => S.indexAuthors([["plate_well", "cells"]], "7-14"), /missing column/);
  assert.equal(Object.keys(S.indexAuthors([], "7-14")).length, 0);
});
test("plate and well name validation", () => {
  for (const p of ["7-14", "102", "100-27", "5-12", "153-29"]) assert.ok(S.validPlateName(p), p);
  for (const p of ["", "7_14", "../7", "7-14\n", "a", "1-2-3", "12345", "7-14 ", null, 7]) assert.ok(!S.validPlateName(p), String(p));
  assert.deepEqual(S.wellToRC("A1"), { r: 0, c: 0 });
  assert.deepEqual(S.wellToRC("L32"), { r: 11, c: 31 });
  for (const w of ["A01", "a1", "Q1", "A", "", "A100", null]) assert.equal(S.wellToRC(w), null, String(w));
  assert.equal(S.rcToWell(0, 0), "A1");
});
function plateJson(plate, rows, cols, over) {
  const wells = [];
  for (let c = 0; c < cols; c++) for (let r = 0; r < rows; r++) { const w = S.rcToWell(r, c); wells.push({ well: w, plate_well: plate + "_" + w, image_id: 1000 + c * rows + r }); }
  return Object.assign({ plate, wells, n: wells.length, rows, cols, quota: { requests_per_plate: 2 * wells.length, cached_responses_per_min: 1200, uncached_responses_per_min: 60, uncached_responses_per_day: 2000 } }, over || {});
}
test("checkPlateInfo accepts the server contract and rejects anything else", () => {
  const ok = S.checkPlateInfo(plateJson("7-14", 12, 32), "7-14");
  assert.equal(ok.wells.length, 384); assert.deepEqual([ok.rows, ok.cols], [12, 32]); assert.equal(ok.quota.perPlate, 768);
  assert.deepEqual([ok.wells[1].r, ok.wells[1].c], [1, 0]);
  const bads = [
    (j) => { j.plate = "8-1"; }, (j) => { j.wells[3].plate_well = "7-14_A1"; }, (j) => { j.wells[0].image_id = "5"; }, (j) => { j.wells[0].image_id = 0; },
    (j) => { j.wells[1].well = "A01"; }, (j) => { j.wells[2] = j.wells[1]; }, (j) => { j.rows = 99; }, (j) => { j.wells = []; }, (j) => { j.wells[0].well = "Z1"; j.wells[0].plate_well = "7-14_Z1"; },
    (j) => { j.cols = 10; },
  ];
  for (const f of bads) { const j = plateJson("7-14", 12, 32); f(j); assert.throws(() => S.checkPlateInfo(j, "7-14"), /unexpected plate data/); }
  assert.throws(() => S.checkPlateInfo(null, "7-14"));
  // a hostile quota cannot produce NaN/negative numbers
  const h = S.checkPlateInfo(plateJson("7-14", 12, 32, { quota: { requests_per_plate: -5, uncached_responses_per_min: "x" } }), "7-14");
  assert.equal(h.quota.perPlate, 768); assert.equal(h.quota.missPerMin, 60);
});

// ------------------------------------------------------------------------------ the two pairings (12 x 32)
test("pairing arithmetic on the 12 x 32 idr0010 plate: by name vs column-major Well Number", () => {
  const nm = (r, c) => S.annotationWellName("name", r, c, 12, 32);
  const cm = (r, c) => S.annotationWellName("colmajor", r, c, 12, 32);
  assert.equal(nm(0, 0), "A1"); assert.equal(nm(11, 31), "L32"); assert.equal(nm(1, 2), "B3");
  assert.equal(S.annotationWellNumber("colmajor", 0, 0, 12, 32), 1);
  assert.equal(S.annotationWellNumber("colmajor", 1, 0, 12, 32), 2);       // B1 -> Well Number 2 -> annotation A2
  assert.equal(cm(0, 0), "A1"); assert.equal(cm(1, 0), "A2"); assert.equal(cm(11, 0), "A12");
  assert.equal(cm(0, 1), "A13"); assert.equal(cm(0, 2), "A25");
  assert.equal(cm(0, 3), "B5");                                            // 37th position -> second annotation row
  assert.equal(cm(11, 31), "L32");
  assert.equal(S.annotationWellNumber("name", 1, 0, 12, 32), 33);          // annotation B1 = Well Number 33
  // both rules are bijections on the plate, and differ on most wells
  for (const p of ["name", "colmajor"]) {
    const seen = new Set();
    for (let r = 0; r < 12; r++) for (let c = 0; c < 32; c++) seen.add(S.annotationWellName(p, r, c, 12, 32));
    assert.equal(seen.size, 384);
  }
  let same = 0; for (let r = 0; r < 12; r++) for (let c = 0; c < 32; c++) if (nm(r, c) === cm(r, c)) same++;
  assert.ok(same >= 1 && same < 384 / 4, String(same));                   // A1 and L32 coincide; the rules disagree on most wells
  // zero-based vs one-based: column-major on a 16 x 24 grid differs from the 12-row rule
  assert.equal(S.annotationWellName("colmajor", 0, 1, 16, 24), "A17");
  assert.throws(() => S.annotationWellName("diagonal", 0, 0, 12, 32), /unknown pairing/);
});

// ---------------------------------------------------------------------------------------- table / compare
function tinyPlate() {
  const info = S.checkPlateInfo(plateJson("9-9", 12, 32), "9-9");
  return info;
}
test("table carries both pairings, controls and the authors' QC; comparison uses only analysed QC-pass sample wells", () => {
  const info = tinyPlate();
  // authors (by annotation well name): A1 sample pass (cells 100, fpc 2), A2 sample pass (cells 200, fpc 1), A3 removed, A13 sample pass
  const authors = { A1: { cells: 100, fpc: 2, qc: "pass", gene: "g1" }, A2: { cells: 200, fpc: 1, qc: "pass", gene: "g2" }, A3: { cells: 50, fpc: 9, qc: "remove", gene: "" }, A13: { cells: 10, fpc: 5, qc: "pass", gene: "" } };
  const controls = { A4: ["p", 60, 3.1, 1], A5: ["n", 70, 1.2, 0] };
  const res = {
    A1: S.summariseResult({ nuclei: { count: 10 }, foci: { count: 20 }, backend: "cpu" }),
    B1: S.summariseResult({ nuclei: { count: 40 }, foci: { count: 40 }, backend: "gpu", warnings: ["w"] }),   // colmajor -> annotation A2
    C1: { error: "boom" },
    A2: S.summariseResult({ nuclei: { count: 0 }, foci: { count: 0 } }),
  };
  const table = S.buildTable(info, res, authors, controls);
  assert.equal(table.length, 384);
  const byW = Object.fromEntries(table.map((t) => [t.well, t]));
  assert.equal(byW.A1.status, "ok"); assert.equal(byW.A1.fpc, 2); assert.equal(byW.B1.fpc, 1); assert.equal(byW.C1.status, "failed"); assert.equal(byW.D1.status, "pending");
  assert.ok(Number.isNaN(byW.A2.fpc));                                        // no nucleus: no foci per cell, never Infinity or 0
  assert.equal(byW.B1.pair.name.well, "B1"); assert.equal(byW.B1.pair.colmajor.well, "A2"); assert.equal(byW.B1.pair.colmajor.cells, 200);
  assert.equal(byW.D1.pair.colmajor.well, "A4"); assert.equal(byW.D1.pair.colmajor.kind, "positive control"); assert.equal(byW.D1.pair.colmajor.qc, "remove");
  assert.equal(byW.E1.pair.colmajor.kind, "negative control");
  assert.equal(byW.A2.pair.name.kind, "sample"); assert.equal(byW.L32.pair.name.kind, "none");
  const name = S.comparePairing(table, "name"), cm = S.comparePairing(table, "colmajor");
  assert.equal(name.foci.n, 1);                                               // A1 only (A2 has no nucleus -> no foci/cell; B1 has no annotation "B1"; C1 failed)
  assert.equal(name.nuclei.n, 2);                                             // A1 + A2
  assert.equal(cm.foci.n, 2); assert.equal(cm.nuclei.n, 3);                   // A1->A1, B1->A2, A2->A13 (no nucleus, but a cell count)
  assert.equal(cm.foci.rho, null);                                            // n < 3: no coefficient rather than a fake one
  assert.equal(cm.skipped.notAnalysed, 384 - 3);                              // 3 analysed wells (A1, B1, A2); the failed and pending ones are not compared
  // the same image evidence, different pairing, different numbers
  assert.notDeepEqual(name.foci.points, cm.foci.points);
});
test("summariseResult tolerates odd engine output", () => {
  const s = S.summariseResult({ nuclei: { count: "x" }, foci: { count: 5 }, timing_ms: { total: 12 } });
  assert.ok(Number.isNaN(s.nuclei) && Number.isNaN(s.fpc)); assert.equal(s.ms, 12);
  const t = S.summariseResult(null); assert.ok(Number.isNaN(t.foci)); assert.equal(t.warnings, 0);
  assert.equal(S.summariseResult({ backend: "x".repeat(99), nuclei: { count: 2 }, foci: { count: 3 } }).backend.length, 20);
});

// ------------------------------------------------------------------------------------------------ heatmap
test("heatmap model: colours on a robust range, absent wells, marks under the chosen pairing", () => {
  const info = S.checkPlateInfo(plateJson("9-9", 4, 6), "9-9");
  const res = {}; info.wells.forEach((w, i) => { res[w.well] = S.summariseResult({ nuclei: { count: 10 }, foci: { count: i } }); });
  const authors = {}; for (let r = 0; r < 4; r++) for (let c = 0; c < 6; c++) authors[S.rcToWell(r, c)] = { cells: 100 + c, fpc: r, qc: c === 0 ? "remove" : "pass", gene: "" };
  const table = S.buildTable(info, res, authors, { D6: ["n", 1, 1, 0] });
  const hm = S.heatmapModel(table, info, "fpc", "name");
  assert.equal(hm.cells.length, 24); assert.equal(hm.n, 24);
  assert.ok(hm.hi > hm.lo);
  const a1 = hm.cells.find((c) => c.well === "A1"), last = hm.cells.find((c) => c.well === "D6");
  assert.match(a1.color, /^#[0-9a-f]{6}$/); assert.equal(a1.qcRemoved, true); assert.equal(last.control, "", "D6 is a sample in this authors table, sample rows win over the control list");
  // values outside the 2nd..98th percentile clip to the end colours; a constant metric maps to the middle
  assert.equal(S.colorFor(-5, 0, 10), S.colorFor(0, 0, 10)); assert.equal(S.colorFor(99, 0, 10), S.colorFor(10, 0, 10));
  assert.equal(S.colorFor(NaN, 0, 1), null); assert.match(S.colorFor(3, 3, 3), /^#/);
  const pending = S.buildTable(info, {}, authors, {});
  const h2 = S.heatmapModel(pending, info, "fpc", "name");
  assert.ok(h2.cells.every((c) => c.color === null && c.status === "pending"));
  const hc = S.heatmapModel(table, info, "author_cells", "colmajor");
  assert.equal(hc.label, "Authors' cell count"); assert.ok(hc.cells.some((c) => c.color));
  // gaps in the plate show as absent cells
  const sparse = S.buildTable({ ...info, wells: info.wells.slice(1) }, {}, {}, {});
  assert.equal(S.heatmapModel(sparse, info, "fpc", "name").cells.filter((c) => !c.exists).length, 1);
});

// --------------------------------------------------------------------------------------------- exports
test("CSV export has both pairings and round-trips through the parser; provenance is complete and honest", () => {
  const info = S.checkPlateInfo(plateJson("9-9", 12, 32), "9-9");
  const table = S.buildTable(info, { A1: S.summariseResult({ nuclei: { count: 4 }, foci: { count: 6 }, backend: "cpu" }) }, { A1: { cells: 9, fpc: 1.5, qc: "pass", gene: "=cmd|x" } }, {});
  const csv = S.exportCsv("9-9", table);
  const rows = S.parseCsv(csv);
  assert.equal(rows.length, 385); assert.deepEqual(rows[0], S.CSV_HEADER);
  assert.equal(rows[1].length, S.CSV_HEADER.length);
  assert.deepEqual(rows[1].slice(0, 10), ["9-9", "A1", "1", "1", "1000", "ok", "4", "6", "1.5", "cpu"]);
  assert.equal(rows[2][5], "pending"); assert.equal(rows[2][6], "");
  const prov = S.buildProvenance({ generatedUtc: "2026-10-01T00:00:00Z", plate: "9-9", rows: 12, cols: 32, nWells: 384, analysed: 1, failed: 0, pending: 383, engineVersion: "e-1", backends: ["cpu"], mode: "auto",
    params: { k: 1 }, comparisons: [S.comparePairing(table, "name"), S.comparePairing(table, "colmajor")] });
  assert.equal(prov.engine.version, "e-1"); assert.deepEqual(prov.params, { k: 1 }); assert.equal(prov.plate, "9-9");
  assert.match(prov.pairing_status, /unconfirmed/); assert.equal(prov.default_pairing, "colmajor"); assert.deepEqual(Object.keys(prov.pairings), ["name", "colmajor"]);
  assert.equal(prov.pairings.name.foci_per_cell_vs_authors_fpc.spearman, null);
  assert.match(prov.attribution, /CC BY 4.0/);
  JSON.parse(JSON.stringify(prov));
});

// --------------------------------------------------------------------------------- budget / Retry-After
test("session budget is a hard cap and survives a broken store", () => {
  let v = 0; const b = S.createBudget(10, { get: () => v, set: (n) => { v = n; } });
  assert.ok(b.canStart(10)); assert.ok(b.spend(6)); assert.ok(!b.canStart(5)); assert.ok(!b.spend(5)); assert.equal(b.remaining(), 4);
  const broken = S.createBudget(3, { get() { throw new Error("blocked"); }, set() { throw new Error("blocked"); } });
  assert.ok(broken.spend(3)); assert.ok(!broken.spend(1)); assert.equal(broken.used(), 3);
  const weird = S.createBudget(3, { get: () => -5, set() {} }); assert.equal(weird.used(), 0);
});
test("Retry-After parsing: seconds, HTTP date, garbage", () => {
  assert.equal(S.parseRetryAfter("7"), 7); assert.equal(S.parseRetryAfter(" 120 "), 120);
  assert.equal(S.parseRetryAfter("Thu, 01 Oct 2026 00:00:30 GMT", Date.parse("2026-10-01T00:00:00Z")), 30);
  assert.equal(S.parseRetryAfter("Thu, 01 Oct 2026 00:00:30 GMT", Date.parse("2026-10-01T01:00:00Z")), 0);
  for (const g of ["soon", "-5", "1e9", "", null, undefined]) assert.equal(S.parseRetryAfter(g), null, String(g));
});
test("cost estimate uses the server's published limits", () => {
  const info = S.checkPlateInfo(plateJson("7-14", 12, 32), "7-14");
  const e = S.estimate(info, null);
  assert.equal(e.images, 768); assert.equal(e.firstTimeMinutes, 13); assert.ok(e.dayShare > 0.3 && e.dayShare < 0.4);
  assert.equal(S.estimate(info, 0).firstTimeMinutes, 0);
});
