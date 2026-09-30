import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const A = createRequire(import.meta.url)("../web/analyze.js");

test("esc escapes markup and quotes", () => {
  assert.equal(A.esc(`<img src=x onerror="a('b')">&`), "&lt;img src=x onerror=&quot;a(&#39;b&#39;)&quot;&gt;&amp;");
  assert.equal(A.esc(5), "5");
});

test("validateParams: defaults, ranges, odd, integer, NaN", () => {
  const ok = A.validateParams({});
  assert.ok(ok.ok);
  assert.deepEqual(ok.clean, { min_nucleus_px: 150, background_size: 41, min_height: 12, tophat_size: 7, peak_window: 5 });
  assert.equal(A.validateParams({ min_height: "" }).clean.min_height, 12);
  assert.equal(A.validateParams({ min_height: "20.5" }).clean.min_height, 20.5);
  for (const bad of [{ min_height: "nan" }, { min_height: "Infinity" }, { min_height: "0" }, { min_height: "256" },
    { tophat_size: "8" }, { tophat_size: "2" }, { peak_window: "4" }, { background_size: "9" },
    { min_nucleus_px: "1.5" }, { min_nucleus_px: "19" }, { min_nucleus_px: "abc" }]) {
    const r = A.validateParams(bad);
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.equal(Object.keys(r.errors).length, 1);
  }
});

test("checkFiles", () => {
  const png = (n, size = 1000) => ({ name: n, size });
  assert.match(A.checkFiles(null, null), /DNA/);
  assert.equal(A.checkFiles(png("a.png"), png("b.PNG")), null);
  assert.equal(A.checkFiles(png("stack.tif"), null), null);
  assert.match(A.checkFiles(png("a.png"), null), /foci image too/);
  assert.match(A.checkFiles(png("a.gif"), png("b.png")), /PNG, TIFF or JPEG/);
  assert.match(A.checkFiles(png("a.png", 0), png("b.png")), /empty/);
  assert.match(A.checkFiles(png("a.png", 20e6), png("b.png", 20e6)), /limit/);
});

test("errorMessage covers each status and never trusts markup", () => {
  assert.match(A.errorMessage(0), /Could not reach/);
  assert.match(A.errorMessage(413, "Upload larger"), /Too large/);
  assert.match(A.errorMessage(415, ""), /PNG, TIFF or JPEG/);
  assert.match(A.errorMessage(422, "images differ"), /images differ/);
  assert.match(A.errorMessage(429, "", "12"), /12 s/);
  assert.match(A.errorMessage(429, "", "junk"), /wait a minute/);
  assert.match(A.errorMessage(503, "", "10"), /busy.*10 s/);
  assert.match(A.errorMessage(504), /too long/);
  assert.match(A.errorMessage(500), /server had a problem/);
  assert.ok(A.errorMessage(422, "x".repeat(5000)).length < 400);
});

test("toCsv: header, rows, quoting and formula guard", () => {
  const csv = A.toCsv([{ id: 1, area_px: 400, centroid_x: 10.5, centroid_y: 3, nuclei_in_object: 1, foci: 2 }]);
  assert.equal(csv, "id,area_px,centroid_x,centroid_y,nuclei_in_object,foci\r\n1,400,10.5,3,1,2\r\n");
  assert.equal(A.csvCell('a,"b"'), '"a,""b"""');
  assert.equal(A.csvCell("=HYPERLINK(1)"), "'=HYPERLINK(1)");
  assert.equal(A.csvCell("-3.5"), "-3.5");
  assert.equal(A.toCsv([]), "id,area_px,centroid_x,centroid_y,nuclei_in_object,foci\r\n");
});

test("histogramData bins and overflow bin", () => {
  assert.deepEqual(A.histogramData([]), { bins: [], total: 0, max: 0 });
  const h = A.histogramData([0, 2, 2, 4, 4, 4]);
  assert.deepEqual(h.bins.map((b) => b.count), [1, 0, 2, 0, 3]);
  assert.equal(h.total, 6); assert.equal(h.max, 3);
  const o = A.histogramData([1, 50, 99, NaN, -1], 5);
  assert.deepEqual(o.bins.map((b) => [b.label, b.count]), [["0", 0], ["1", 1], ["2", 0], ["3", 0], ["4+", 2]]);
  assert.equal(o.total, 3);
});

test("histogramSvg is well formed and escapes labels", () => {
  const svg = A.histogramSvg(A.histogramData([0, 1, 1, 2]));
  assert.match(svg, /^<svg[\s\S]*<\/svg>$/);
  assert.equal((svg.match(/<rect/g) || []).length, 3);
  assert.doesNotMatch(svg, /NaN|undefined/);
  const evil = A.histogramSvg({ bins: [{ label: "<script>", count: 1 }], total: 1, max: 1 });
  assert.doesNotMatch(evil, /<script>/);
  assert.match(A.histogramSvg({ bins: [], total: 0, max: 0 }), /No nuclei/);
});

test("safeBase64 and num", () => {
  assert.equal(A.safeBase64("A".repeat(200)), true);
  assert.equal(A.safeBase64("A".repeat(200) + '"onerror=1'), false);
  assert.equal(A.safeBase64(null), false);
  assert.equal(A.safeBase64("abc"), false);
  assert.equal(A.num("3.14159", 2), "3.14");
  assert.equal(A.num(NaN), "");
  assert.equal(A.num(undefined), "");
});
