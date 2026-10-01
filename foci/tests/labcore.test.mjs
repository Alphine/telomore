import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Core = require("../web/io/labcore.js");
const Mock = require("./mock-engine.js");

const DEF = Mock.defaultParams();

test("pairFiles: DAPI/53BP1 words, directories, duplicates, leftovers", () => {
  const rules = { nuclei: "DAPI, Hoechst", foci: "53BP1, gH2AX" };
  const names = ["Exp1_DAPI_001.tif", "Exp1_53BP1_001.tif", "Exp1_DAPI_002.tif", "Exp1_53BP1_002.tif", "lone.tif", "ctrl/A_DAPI.png", "ctrl/A_53BP1.png", "other/A_DAPI.png", "both_DAPI_53BP1.tif"];
  const r = Core.pairFiles(names.map((n, i) => ({ id: i, name: n })), rules);
  assert.deepEqual(r.pairs.map((p) => [p.nucleiId, p.fociId]), [[0, 1], [2, 3], [5, 6]]);
  assert.deepEqual(r.pairs.map((p) => p.label), ["Exp1_001", "Exp1_002", "ctrl/A"]);
  assert.deepEqual(r.nucleiOnly, [7]); assert.deepEqual(r.other, [4]); assert.deepEqual(r.ambiguous, [8]);
});

test("pairFiles: _c1/_c2 does not confuse _c1 with _c10; case-insensitive", () => {
  const r = Core.pairFiles(["s1_c1.tif", "s1_C2.tif", "s1_c10.tif", "s2_c1.tif", "s2_c2.tif"].map((n, i) => ({ id: i, name: n })), { nuclei: "_c1", foci: "_c2" });
  assert.deepEqual(r.pairs.map((p) => p.label), ["s1", "s2"]);
  assert.deepEqual(r.other, [2]);
});

test("pairFiles: same name in two folders never cross-pairs; true duplicates pair in order", () => {
  const rules = { nuclei: "DAPI", foci: "FOCI" };
  const r = Core.pairFiles([["d1/x_DAPI.png", 0], ["d2/x_FOCI.png", 1], ["d1/x_FOCI.png", 2], ["d2/x_DAPI.png", 3]].map(([n, i]) => ({ id: i, name: n })), rules);
  assert.deepEqual(r.pairs.map((p) => [p.nucleiId, p.fociId]).sort(), [[0, 2], [3, 1]].sort());
  const d = Core.pairFiles([{ id: 0, name: "a_DAPI.png" }, { id: 1, name: "a_DAPI.png" }, { id: 2, name: "a_FOCI.png" }, { id: 3, name: "a_FOCI.png" }], rules);
  assert.equal(d.pairs.length, 2); assert.notEqual(d.pairs[0].key, d.pairs[1].key);
});

test("pairFiles: empty or hostile rules do not throw or hang", () => {
  assert.doesNotThrow(() => Core.pairFiles([{ id: 0, name: "a.png" }], { nuclei: "", foci: "" }));
  assert.doesNotThrow(() => Core.pairFiles([{ id: 0, name: "a(b.png" }], { nuclei: "(", foci: "[*+?.^$|\\" }));
  assert.equal(Core.classifyName("a.png", { nuclei: "(", foci: "" }), null);
  assert.equal(Core.splitTokens("a, b;c\n" + "x".repeat(100)).length, 3);
});

test("guessChannels uses names, falls back to order", () => {
  assert.deepEqual(Core.guessChannels(["53BP1", "DAPI"]), { nuclei: 1, foci: 0 });
  assert.deepEqual(Core.guessChannels(["Channel 1", "Channel 2", "Channel 3"]), { nuclei: 0, foci: 1 });
  assert.deepEqual(Core.guessChannels(["Gray"]), { nuclei: 0, foci: -1 });
});

test("validateParams / parseParamsJSON / presets", () => {
  assert.ok(Core.validateParams({}, DEF).ok);
  assert.deepEqual(Core.validateParams({}, DEF).clean, DEF);
  for (const bad of [{ min_height: "abc" }, { min_height: "0" }, { min_height: "256" }, { tophat_size: "8" }, { peak_window: "2" }, { background_size: "10" }, { min_nucleus_px: "1.5" }, { nucleus_sigma: "99" }, { foci_sigma: "-1" }, { min_height: "Infinity" }, { tophat_size: "-3" }]) {
    assert.equal(Core.validateParams(bad, DEF).ok, false, JSON.stringify(bad));
  }
  const good = Core.parseParamsJSON(JSON.stringify({ params: { min_height: 20, junk: 1 } }), DEF);
  assert.ok(good.ok); assert.equal(good.clean.min_height, 20); assert.deepEqual(good.unknown, ["junk"]); assert.equal(good.provided, 1);
  assert.equal(Core.parseParamsJSON("not json", DEF).ok, false);
  assert.equal(Core.parseParamsJSON("[1]", DEF).ok, false);
  assert.equal(Core.parseParamsJSON("{}", DEF).ok, false);
  assert.equal(Core.parseParamsJSON(JSON.stringify({ min_height: 999 }), DEF).ok, false);
  assert.equal(Core.parseParamsJSON("x".repeat(200000), DEF).ok, false);
  const round = Core.parseParamsJSON(Core.paramsToJSON(DEF, "v1"), DEF);
  assert.ok(round.ok); assert.deepEqual(round.clean, DEF);
  assert.equal(Core.presetParams("strict", DEF).min_height, DEF.min_height * 2);
  assert.equal(Core.presetParams("loose", DEF).min_height, DEF.min_height / 2);
  assert.deepEqual(Core.presetParams("defaults", DEF), DEF);
});

test("channelStats and thumbnail", () => {
  const d = new Uint16Array(10000); for (let i = 0; i < d.length; i++) d[i] = 100 + (i % 100);
  d[5] = 60000;
  const s = Core.channelStats(d);
  assert.equal(s.min, 100); assert.equal(s.max, 60000);
  assert.ok(s.p9999 >= 100 && s.p9999 <= 60000 && s.p001 >= 100);
  assert.equal(s.bins.reduce((a, b) => a + b, 0), 10000);
  assert.ok(Core.channelStats(new Uint8Array(50)).flat);
  assert.equal(Core.channelStats(Float32Array.from([NaN, 1, 2, Infinity])).max, 2);
  const t = Core.thumbnail(new Uint8Array(1000 * 500).fill(128), 1000, 500, 100, 0, 255);
  assert.equal(t.width, 100); assert.equal(t.height, 50); assert.equal(t.rgba.length, 100 * 50 * 4);
  assert.equal(t.rgba[0], 128); assert.equal(t.rgba[3], 255);
  const odd = Core.thumbnail(new Uint8Array(7 * 5).fill(255), 7, 5, 3, 0, 255);
  assert.equal(odd.width * odd.height * 4, odd.rgba.length);
});

// ---- a realistic record set via the mock engine ---------------------------------------------------
async function makeRecord(name, cond, rep, seed) {
  const w = 64, h = 64, dna = new Uint16Array(w * h).fill(200), foc = new Uint16Array(w * h).fill(100);
  for (let k = 0; k < 3; k++) {
    const cx = 12 + 20 * k + (seed % 3), cy = 20 + 8 * k;
    for (let y = -6; y <= 6; y++) for (let x = -6; x <= 6; x++) if (x * x + y * y <= 36) dna[(cy + y) * w + cx + x] = 9000;
    for (let f = 0; f < (seed + k) % 4; f++) foc[(cy + f - 1) * w + cx + f] = 8000 + 50 * f;
  }
  const res = await Mock.analyze({ dna: { data: dna, width: w, height: h, bitDepth: 16 }, foci: { data: foc, width: w, height: h, bitDepth: 16 }, params: { ...DEF, min_nucleus_px: 4 } }, { overlay: false });
  const file = (n) => ({ name: n, size: 123, sha256: "ab".repeat(32), format: "png", container: null });
  return { name, condition: cond, replicate: rep, status: "done", nuclei: { file: file(name + "_DAPI.png"), channel: { index: 0, name: "Gray", bitDepth: 16 } }, foci: { file: file(name + "_53BP1.png"), channel: { index: 0, name: "Gray", bitDepth: 16 } },
    width: w, height: h, pixelSizeUm: 0.5, result: res, summary: Core.summarise(res), backend: res.backend, engineVersion: res.version, timing_ms: 5, warnings: [], readWarnings: [], error: null };
}

test("summarise handles per-object counts and missing fields", async () => {
  const r = await makeRecord("a", "", "", 1);
  assert.equal(r.summary.nuclei, r.result.nuclei.count);
  assert.equal(r.summary.foci, r.result.foci.count);
  assert.ok(r.summary.nuclei >= 3);
  assert.ok(Math.abs(r.summary.fociPerNucleus - r.summary.foci / r.summary.nuclei) < 1e-12);
  const s = Core.summarise({ nuclei: { count: 0, objects: [] }, foci: { count: 0, per_cell: [] } });
  assert.equal(s.fociPerNucleus, null); assert.equal(s.median, null);
  assert.deepEqual(Core.nucleusCounts({ foci: { per_cell: [1, 2, 3] } }), [1, 2, 3]);
  assert.deepEqual(Core.nucleusCounts({}), []);
});

test("CSV builders: header, row counts, injection guard, quoting, numbers", async () => {
  const recs = [await makeRecord("=cmd|'/c calc'!A0", "ctrl, \"x\"", "+1", 1), await makeRecord("b\nc", "treated", "", 2)];
  const csv = Core.perNucleusCsv(recs), nuc = csv.split("\r\n");
  assert.equal(nuc[0], "image,condition,replicate,nucleus_id,area_px,area_um2,centroid_x_px,centroid_y_px,foci,pipeline_version");
  const total = recs.reduce((a, r) => a + r.result.nuclei.objects.length, 0);
  assert.equal(nuc.length - 2, total);                          // header + rows + trailing empty after the last CRLF
  assert.ok(nuc[1].startsWith("'=cmd|'/c calc'!A0,\"ctrl, \"\"x\"\"\",'+1,"), nuc[1]);
  assert.ok(!csv.includes("b\nc"));
  const img = Core.perImageCsv(recs).split("\r\n");
  assert.equal(img.length, 4);
  assert.equal(img[0].split(",").length, 21);
  assert.ok(/,pipeline_version$/.test(img[0]));
  assert.equal(Core.csvCell(1 / 3), "0.3333333333"); assert.equal(Core.csvCell(NaN), ""); assert.equal(Core.csvCell(null), ""); assert.equal(Core.csvCell(-5), "-5");
  assert.equal(Core.csvCell("-x"), "'-x"); assert.equal(Core.csvCell("\tx"), "'\tx");
  const first = recs[0].result.nuclei.objects[0];
  assert.ok(nuc[1].includes("," + Number((first.area_px * 0.25).toPrecision(10)) + ","));   // area in um2 = px^2 * (um/px)^2
});

test("conditionSummary: pooled vs image vs replicate means, warnings", async () => {
  const recs = [await makeRecord("c1", "control", "A", 1), await makeRecord("c2", "control", "A", 2), await makeRecord("c3", "control", "B", 3), await makeRecord("t1", "treated", "", 4)];
  const cs = Core.conditionSummary(recs);
  const c = cs.groups.find((g) => g.condition === "control"), t = cs.groups.find((g) => g.condition === "treated");
  assert.equal(c.images, 3); assert.equal(c.replicates, 2); assert.equal(c.unlabelled, 0);
  const means = recs.slice(0, 3).map((r) => r.summary.fociPerNucleus);
  assert.ok(Math.abs(c.imageMean - (means[0] + means[1] + means[2]) / 3) < 1e-12);
  assert.ok(Math.abs(c.replicateMean - ((means[0] + means[1]) / 2 + means[2]) / 2) < 1e-12);
  assert.equal(t.replicateMean, null); assert.equal(t.unlabelled, 1);
  assert.ok(cs.warnings.some((w) => /technical replicates/.test(w)));
  assert.ok(cs.warnings.some((w) => /control.*2 labelled biological replicate/.test(w)));
  assert.ok(cs.warnings.some((w) => /treated.*no replicate label/.test(w)));
  assert.deepEqual(Core.conditionSummary([{ status: "error" }]).groups, []);
  assert.equal(Core.conditionSummary([]).warnings.length, 0);
});

test("buildProvenance records everything needed to reproduce a run", async () => {
  const recs = [await makeRecord("s1", "control", "A", 1)];
  const when = new Date("2026-01-02T03:04:05Z");
  const p = Core.buildProvenance({ pageVersion: Core.LAB_VERSION, ioVersion: "1.0.0", engineVersion: "mock-0.1", mode: "auto", poolSize: 2, capabilities: await Mock.capabilities(), params: DEF, defaults: DEF,
    userAgent: "UA", hardwareConcurrency: 8, records: recs, now: when, pageUrl: "https://example.org/foci/lab.html" });
  assert.equal(p.schema, "foci-lab-provenance/1");
  assert.equal(p.generated_at, "2026-01-02T03:04:05.000Z");
  assert.equal(p.page.version, Core.LAB_VERSION);
  assert.equal(p.engine.version, "mock-0.1"); assert.deepEqual(p.engine.backends_used, ["gpu"]); assert.equal(p.engine.worker_pool_size, 2);
  assert.deepEqual(p.parameters, DEF);
  const im = p.images[0];
  assert.equal(im.nuclei.file.name, "s1_DAPI.png"); assert.equal(im.nuclei.file.sha256.length, 64); assert.equal(im.nuclei.bit_depth, 16);
  assert.ok(im.normalisation); assert.deepEqual(im.counts, { nuclei: recs[0].summary.nuclei, foci: recs[0].summary.foci });
  assert.ok(p.caveats.length >= 4 && /NOT validated/.test(p.caveats[0]));
  assert.ok(/No image or result was uploaded/.test(p.privacy));
  assert.doesNotThrow(() => JSON.stringify(p));
  assert.ok(!JSON.stringify(p).includes("overlay"));
});

test("describeBackend: GPU, CPU, failed self-test, no engine", () => {
  assert.equal(Core.describeBackend({ webgpu: true, selfTest: true, adapter: "X" }, "1.2").kind, "gpu");
  assert.match(Core.describeBackend({ webgpu: true, selfTest: true }, "1.2").text, /GPU.*engine 1\.2.*self-test passed/);
  const cpu = Core.describeBackend({ webgpu: false, selfTest: null }, "1.2");
  assert.equal(cpu.kind, "cpu"); assert.match(cpu.text, /CPU.*not run/);
  const failed = Core.describeBackend({ webgpu: true, selfTest: { ok: false } }, "1");
  assert.equal(failed.kind, "cpu"); assert.equal(failed.selfTest, "failed");
  assert.equal(Core.describeBackend(null).kind, "none");
});

test("mock engine honours the contract shape and abort", async () => {
  const caps = await Mock.capabilities();
  for (const k of ["webgpu", "adapter", "selfTest", "maxImagePixels", "hardwareConcurrency"]) assert.ok(k in caps);
  assert.deepEqual(Object.keys(Mock.defaultParams()).sort(), ["background_size", "foci_sigma", "min_height", "min_nucleus_px", "nucleus_sigma", "peak_window", "tophat_size"]);
  const ac = new AbortController(); ac.abort();
  await assert.rejects(Mock.analyze({}, { signal: ac.signal }), { code: "aborted" });
});
