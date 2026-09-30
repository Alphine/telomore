import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const L = require("../web/lib.js");
const fx = (n) => JSON.parse(readFileSync(path.join(here, "fixtures", n), "utf8"));
const close = (a, b, rel = 1e-9) => assert.ok(Math.abs(a - b) <= rel * Math.max(Math.abs(b), 1e-300), `${a} vs ${b}`);

// ---- expected values: scipy 1.18 (foci/tests/fixtures/gen_expected.py) ----
test("hypergeometric upper tail matches scipy.stats.hypergeom.sf(k-1, N, K, n)", () => {
  const cases = [
    [5, 13330, 29, 50, 6.709978537776261e-08],
    [1, 13330, 4, 100, 0.029674820498066867],
    [3, 13330, 25, 200, 0.006000048744718963],
    [3, 20, 7, 5, 0.20678534571723425],
    [20, 13330, 29, 2000, 7.81851817526104e-11],
    [0, 13330, 25, 10, 1.0],
    [10, 50, 10, 50, 1.0],
    [1, 13330, 4, 3, 0.0009000224499109263],
    [29, 13330, 29, 29, 2.186258435411029e-89],
    [20, 100, 30, 40, 0.00043106255242406365],
  ];
  for (const [k, N, K, n, p] of cases) close(L.hypergeomSf(k, N, K, n), p, 1e-8);
  assert.ok(Number.isNaN(L.hypergeomSf(1, 10, 11, 3)));
  assert.equal(L.hypergeomSf(4, 10, 3, 5), 0); // k above the support
});

const gen = (n, a, m, off) => Array.from({ length: n }, (_, i) => ((i * a) % m) / 10 + off);
test("Mann-Whitney U (asymptotic, tie-corrected, no continuity) matches scipy", () => {
  const cases = [
    [[-3.2, -2.5, -4.1], [0.1, -0.3, 0.5, 0.2, -0.1, 0.9, -0.6, 0.3, 1.1, 0.0, 0.4, -0.2], 0.0, 0.009374768459434876],
    [[1, 1, 2, 2, 2, 3, 3], [1, 1, 1, 2, 2, 3, 3, 3, 3, 4, 4, 0, 0, 0, 1, 2], 59.5, 0.8099584410985219],
    [[0, 0, 0, 0, 1], [0, 0, 0, 0, 0, 0, 0, 1, 1], 22.0, 0.9254555645977179],
    [gen(60, 37, 101, -2), gen(400, 53, 97, 0), 7987.0, 2.9216746387626763e-05],
    [[5.5, 6.1, 7.3, 8.0], [1, 2, 3, 4, 5, 5.5, 5.5], 27.0, 0.013159898257727896],
  ];
  for (const [x, y, U, p] of cases) {
    const r = L.mannWhitney(x, y);
    assert.equal(r.U, U);
    close(r.p, p, 1e-8);
  }
  assert.equal(L.mannWhitney([], [1, 2]).p, null);
  assert.equal(L.mannWhitney([1, 1], [1, 1]).p, 1); // all tied: no information
});

test("erfc / lgamma sanity", () => {
  close(L.erfc(0), 1); close(L.erfc(1), 0.15729920705028513, 1e-12); close(L.erfc(-1), 1.8427007929497148, 1e-12);
  close(L.erfc(6), 2.151973671249892e-17, 1e-9);
  close(L.lgamma(0.5), 0.5723649429247001, 1e-12); close(L.lgamma(10), Math.log(362880), 1e-12);
});

test("analyseList uses rankable genes as universe and counts supported hits", () => {
  const g = fx("genes_mini.json"), cols = {}; g.columns.forEach((c, i) => (cols[c] = i));
  const list = g.rows.filter((r) => ["RNF168", "AL390728.37", "PSMA3"].includes(r[0]));
  const a = L.analyseList(list, g.rows, cols);
  assert.equal(a.universe, 5); assert.equal(a.listTotal, 3); assert.equal(a.listRankable, 2); assert.equal(a.listUnrankable, 1);
  const any = a.hyper.find((h) => h.key === "any");
  assert.equal(any.K, 2); assert.equal(any.k, 2); assert.equal(any.n, 2);
  close(any.p, L.hypergeomSf(2, 5, 2, 2)); close(any.p, 0.1, 1e-12);
  assert.equal(a.hyper.find((h) => h.key === "hit_down").k, 1);
  assert.equal(a.mw.n2, 3); // the other rankable genes
  assert.ok(/random draw/.test(L.interpretHyper(any)));
  assert.ok(/only 2 rankable/.test(L.interpretMw(a.mw)));
});

test("CSV quoting per RFC 4180 and formula neutralising", () => {
  assert.equal(L.csvCell("a,b"), '"a,b"');
  assert.equal(L.csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(L.csvCell("l1\nl2"), '"l1\nl2"');
  assert.equal(L.csvCell(null), ""); assert.equal(L.csvCell(-3.5), "-3.5"); assert.equal(L.csvCell(NaN), ""); assert.equal(L.csvCell(true), "true");
  assert.equal(L.csvCell("=1+1"), "'=1+1"); assert.equal(L.csvCell("@SUM(A1)"), "'@SUM(A1)"); assert.equal(L.csvCell("-5"), "-5");
  assert.equal(L.buildCsv(["g", "note"], [["A,B", 'q"']]), 'g,note\r\n"A,B","q"""\r\n');
  // round-trip through a tiny RFC 4180 parser
  const csv = L.buildCsv(["a", "b"], [["x,y", 'he said "no"\nline2'], ["plain", ""]]);
  const rows = []; let row = [], cur = "", q = false;
  for (let i = 0; i < csv.length; i++) {
    const c = csv[i];
    if (q) { if (c === '"') { if (csv[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(cur); cur = ""; }
    else if (c === "\r") { /* skip */ }
    else if (c === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; }
    else cur += c;
  }
  assert.deepEqual(rows, [["a", "b"], ["x,y", 'he said "no"\nline2'], ["plain", ""]]);
});

test("splitTokens: separators, CRLF, dedupe, cap, emoji, RTL, quotes", () => {
  const r = L.splitTokens("rnf168, TP53BP1;atm\r\nRNF168\tbrca1 ​'PSMA3'\n\n");
  assert.deepEqual(r.tokens, ["rnf168", "TP53BP1", "atm", "brca1", "PSMA3"]); assert.equal(r.duplicates, 1);
  assert.deepEqual(L.splitTokens("").tokens, []); assert.deepEqual(L.splitTokens(null).tokens, []); assert.deepEqual(L.splitTokens(" ,;\n ").tokens, []);
  const big = Array.from({ length: 2500 }, (_, i) => "G" + i).join(" ");
  const c = L.splitTokens(big); assert.equal(c.tokens.length, 2000); assert.ok(c.truncated); assert.equal(c.unique, 2500);
  assert.deepEqual(L.splitTokens("😀 שלום AL390728.37 A_B").tokens, ["😀", "שלום", "AL390728.37", "A_B"]);
});

test("resolver: symbols, Ensembl, aliases, previous, ambiguous, unknown, prototype names", () => {
  const R = L.makeResolver(fx("genes_mini.json"), fx("symbols_mini.json"));
  let r = R.resolveOne("rnf168"); assert.equal(r.via, "symbol"); assert.equal(r.row[0], "RNF168");
  r = R.resolveOne("ensg00000067369.5"); assert.equal(r.via, "ensembl"); assert.equal(r.row[0], "TP53BP1");
  r = R.resolveOne("53BP1"); assert.equal(r.status, "ok"); assert.equal(r.via, "alias"); assert.equal(r.row[0], "TP53BP1"); assert.equal(r.currentSymbol, "TP53BP1");
  r = R.resolveOne("trp53bp1"); assert.equal(r.via, "previous");
  r = R.resolveOne("shared"); assert.equal(r.status, "ambiguous"); assert.equal(r.candidates.length, 2);
  assert.deepEqual(r.candidates.map((c) => c.inScreen), [true, true]);
  r = R.resolveOne("NS1"); assert.equal(r.status, "unresolved"); assert.ok(/not in this screen/.test(r.reason));
  r = R.resolveOne("ENSG00000555555"); assert.equal(r.status, "unresolved");
  for (const t of ["constructor", "__proto__", "hasOwnProperty", "toString"]) assert.notEqual(R.resolveOne(t).status === "ok" && R.resolveOne(t).via !== "alias", true, t);
  assert.equal(R.resolveOne("__proto__").status, "unresolved");
  assert.equal(R.resolveOne("toString").status, "unresolved");
  assert.equal(R.resolveOne("__proto__x").status, "ok");
  assert.equal(R.resolveOne("AL390728.37").row[0], "AL390728.37");
  assert.equal(R.resolveOne('a,b"c').row[0], 'A,B"C');
  assert.equal(R.resolveOne("x".repeat(200)).status, "unresolved");
  const rl = R.resolveList(["RNF168", "rnf168a", "53BP1", "TP53BP1", "zzz", "shared"]);
  assert.equal(rl.resolved.length, 2); assert.equal(rl.collapsed.length, 2); assert.equal(rl.unresolved.length, 1); assert.equal(rl.ambiguous.length, 1);
  // without symbols.json: aliases are simply unresolved
  const R2 = L.makeResolver(fx("genes_mini.json"), null);
  assert.equal(R2.resolveOne("53BP1").status, "unresolved"); assert.equal(R2.resolveOne("tp53bp1").status, "ok");
});

test("suggest: prefix search over symbols, Ensembl IDs and aliases", () => {
  const R = L.makeResolver(fx("genes_mini.json"), fx("symbols_mini.json"));
  assert.deepEqual(R.suggest("rn").map((s) => s.value), ["RNF168", "RNF168A"]);
  assert.deepEqual(R.suggest("r"), []);
  assert.equal(R.suggest("53b")[0].gene, "TP53BP1");
  assert.equal(R.suggest("ENSG00000163")[0].gene, "RNF168");
  assert.equal(R.suggest("psm", 1).length, 1);
});

test("siRNA summary: QC-removed never counted, disagreement and direction", () => {
  const s = fx("sirna_mini.json"), items = L.objectify(s.columns, s.by_gene.RNF168);
  const sum = L.sirnaSummary(items);
  assert.equal(sum.nRemoved, 1); assert.equal(sum.nPass, 2); assert.equal(sum.strongUp, 0); assert.equal(sum.strongDown, 2);
  assert.equal(sum.direction, -1); assert.ok(sum.agree); assert.ok(!sum.conflict);
  assert.equal(L.sameDirection(items, -1).length, 2);
  const conflict = L.sirnaSummary([{ sirna: "a", z: -3, qc: "pass" }, { sirna: "b", z: 4, qc: "pass" }]);
  assert.ok(conflict.conflict); assert.equal(conflict.direction, 0); assert.ok(/disagree/.test(conflict.message));
  assert.equal(L.sameDirection([{ z: -3, qc: "pass" }], 0).length, 0);
  const one = L.sirnaSummary([{ sirna: "a", z: -3, qc: "pass" }, { sirna: "b", z: 0.5, qc: "pass" }, { sirna: "c", z: -0.4, qc: "pass" }]);
  assert.ok(!one.agree); assert.ok(/not a supported hit/.test(one.message));
  const nul = L.sirnaSummary([{ sirna: "a", z: null, qc: "pass" }]);
  assert.equal(nul.nSirna, 0);
});

test("citation: attribution parsing, BibTeX only from stated fields, text block", () => {
  const S = fx("summary_attr.json");
  const p = L.parseAttribution(S.attribution);
  assert.deepEqual([p.family, p.initials, p.journal, p.year, p.volume, p.pageStart, p.pageEnd, p.doi], ["Doil", "C", "Cell", "2009", "136", "435", "446", "10.1016/j.cell.2008.12.041"]);
  assert.ok(p.title.startsWith("RNF168 binds")); assert.ok(p.title.endsWith("repair proteins"));
  const b = L.bibtex(p, "IDR idr0010");
  assert.ok(b.includes("pages   = {435--446}") && b.includes("author  = {Doil, C. and others}") && b.includes("note    = {IDR idr0010}"));
  assert.equal(L.parseAttribution("something else"), null); assert.equal(L.bibtex(null), null);
  const t = L.citationText({ url: "https://studylab.id/foci/?gene=RNF168", accessed: "2026-09-30", viewLabel: "gene RNF168", manifest: { built_utc: "2026-09-29T10:00:00Z", git_commit: "84a125f0123456789", code_version: "1.2" }, attribution: S.attribution, licence: "CC BY 4.0" });
  assert.ok(t.includes("accessed 2026-09-30") && t.includes("commit 84a125f01234") && t.includes("Doil C, et al.") && t.includes("CC BY 4.0") && !t.includes("Images:"));
  assert.ok(!/commit/.test(L.citationText({ url: "u", accessed: "d", attribution: "x" })));
  assert.equal((t.match(/CC BY 4\.0/g) || []).length, 1); // licence not repeated when the attribution already states it
  assert.ok(/Licence: MIT/.test(L.citationText({ url: "u", accessed: "d", attribution: "x", licence: "MIT" })));
});

test("permalink hash for gene lists", () => {
  assert.deepEqual(L.parseListHash("#list=RNF168,AL390728.37,A%2CB"), ["RNF168", "AL390728.37", "A,B"]);
  assert.equal(L.parseListHash("#explorer"), null); assert.equal(L.parseListHash(""), null);
  assert.deepEqual(L.parseListHash("#list=%E0%A4%A"), []); // bad escape is dropped, not thrown
  assert.equal(L.buildListHash(["A", "B C"]), "#list=A,B%20C");
  assert.equal(L.buildListHash(Array.from({ length: 201 }, (_, i) => "G" + i)), null);
  assert.equal(L.buildListHash([]), null);
  assert.deepEqual(L.parseListHash(L.buildListHash(["x;y", "😀"])), ["x;y", "😀"]);
});

test("scale bar picks a 1-2-5 length that fits", () => {
  const s = L.niceScaleBar(0.32, 100); assert.equal(s.um, 20); assert.ok(s.px <= 100 && s.px > 40); assert.equal(s.label, "20 µm");
  assert.equal(L.niceScaleBar(0.5, 100).um, 50); assert.equal(L.niceScaleBar(0.1, 30).um, 2); assert.equal(L.niceScaleBar(null, 50), null);
});

test("formatting and escaping helpers", () => {
  assert.equal(L.fz(-2.34), "−2.3"); assert.equal(L.fz(0), "0.0"); assert.equal(L.fz(null), "–");
  assert.equal(L.fq(7.12e-30), "7.1e−30"); assert.equal(L.fp(0.0312), "0.031"); assert.equal(L.fp(3e-11), "3.0e−11");
  assert.equal(L.fBytes(1536), "1.5 kB"); assert.equal(L.escHtml(`<a href="x">'&`), "&lt;a href=&quot;x&quot;&gt;&#39;&amp;");
  assert.equal(L.safeUrl("javascript:alert(1)"), null); assert.equal(L.safeUrl("https://x.org/a?b=1"), "https://x.org/a?b=1");
});

test("real data: every screen symbol resolves to itself; RNF168 is a supported hit", { skip: !existsSync(path.join(here, "../web/data/genes.json")) }, () => {
  const g = JSON.parse(readFileSync(path.join(here, "../web/data/genes.json"), "utf8"));
  const R = L.makeResolver(g, null);
  for (const row of g.rows) assert.equal(R.resolveOne(row[0]).row, row, row[0]);
  assert.equal(R.resolveOne("ENSG00000163961").row[0], "RNF168");
  const a = L.analyseList(["RNF168", "RNF8", "MDC1"].map((s) => R.resolveOne(s).row), g.rows, R.col);
  assert.equal(a.universe, 13330);
  assert.equal(a.hyper.find((h) => h.key === "any").K, 29);
});
