// Foci Lab -- pure logic (no DOM). UMD: window.FociLib in the browser, module.exports in Node
// (tests: node --test foci/tests). Everything shown as a statistic on the site that is not read
// straight from the data files is computed here and unit-tested against scipy.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.FociLib = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  var hasOwn = Object.prototype.hasOwnProperty;
  function own(o, k) { return o != null && hasOwn.call(o, k); }

  // ------------------------------------------------------------ formatting
  function fmt(v, d) { return v == null || !isFinite(v) ? "–" : Number(v).toFixed(d == null ? 2 : d); }
  function fz(v, d) { return v == null || !isFinite(v) ? "–" : (v < 0 ? "−" : v > 0 ? "+" : "") + Math.abs(v).toFixed(d == null ? 1 : d); }
  function fq(q) { return q == null || !isFinite(q) ? "–" : q < 0.001 ? q.toExponential(1).replace("e-", "e−") : q.toFixed(3); }
  function fp(p) {
    if (p == null || !isFinite(p)) return "–";
    if (p === 0) return "< 1e−300";
    if (p >= 0.001) return p.toFixed(p >= 0.1 ? 2 : 3);
    return p.toExponential(1).replace("e-", "e−");
  }
  function fBytes(n) {
    if (n == null || !isFinite(n)) return "–";
    if (n < 1024) return n + " B";
    if (n < 1048576) return (n / 1024).toFixed(1) + " kB";
    return (n / 1048576).toFixed(1) + " MB";
  }
  function escHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; });
  }
  // Only http(s) URLs are ever put into href attributes.
  function safeUrl(u) { return typeof u === "string" && /^https?:\/\/[^\s"'<>]+$/i.test(u) ? u : null; }

  // ------------------------------------------------------------------- CSV
  // RFC 4180 quoting. String cells that a spreadsheet could read as a formula are prefixed with
  // a single quote (CSV injection); numbers are written as-is.
  function csvCell(v, opts) {
    if (v == null) return "";
    if (typeof v === "boolean") return v ? "true" : "false";
    if (typeof v === "number") return isFinite(v) ? String(v) : "";
    var s = String(v);
    if (!(opts && opts.raw) && /^[=+\-@\t\r]/.test(s) && !/^[+-]?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(s)) s = "'" + s;
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function buildCsv(header, rows, opts) {
    var out = [header.map(function (c) { return csvCell(c, { raw: true }); }).join(",")];
    rows.forEach(function (r) { out.push(r.map(function (c) { return csvCell(c, opts); }).join(",")); });
    return out.join("\r\n") + "\r\n";
  }

  // ------------------------------------------------------------ tokenising
  var ZW = /[​-‍⁠﻿]/g;
  // Split pasted text on whitespace, commas and semicolons; dedupe case-insensitively; cap the count.
  function splitTokens(text, cap) {
    cap = cap || 2000;
    var parts = String(text == null ? "" : text).replace(ZW, "").split(/[\s,;]+/), seen = Object.create(null), out = [], dup = 0, total = 0;
    for (var i = 0; i < parts.length; i++) {
      var t = parts[i].replace(/^["'`]+|["'`]+$/g, "");
      if (!t) continue;
      var u = t.toUpperCase();
      if (seen[u]) { dup++; continue; }
      seen[u] = 1; total++;
      if (out.length < cap) out.push(t);
    }
    return { tokens: out, unique: total, duplicates: dup, truncated: total > cap, cap: cap };
  }

  // -------------------------------------------------------------- resolver
  var ENS_RE = /^ENSG\d{6,}(\.\d+)?$/i;
  // genes: {columns, rows} from genes.json; symbols: parsed symbols.json or null.
  function makeResolver(genes, symbols) {
    var ci = {};
    genes.columns.forEach(function (c, i) { ci[c] = i; });
    var bySym = new Map(), byEns = new Map();
    genes.rows.forEach(function (r) {
      bySym.set(String(r[ci.gene]).toUpperCase(), r);
      if (ci.ensembl != null && r[ci.ensembl]) byEns.set(String(r[ci.ensembl]).toUpperCase(), r);
    });
    var lookup = symbols && symbols.lookup || null, amb = symbols && symbols.ambiguous || null, byE = symbols && symbols.by_ensembl || null;
    function currentSymbol(ens) { return own(byE, ens) && byE[ens].symbol ? byE[ens].symbol : null; }
    function cand(ens) { var r = byEns.get(ens); return { ensembl: ens, symbol: currentSymbol(ens) || (r ? r[ci.gene] : null), inScreen: !!r, gene: r ? r[ci.gene] : null }; }

    function resolveOne(token) {
      var t = String(token).trim(), u = t.toUpperCase();
      if (!t) return { status: "unresolved", token: token, reason: "empty" };
      if (t.length > 100) return { status: "unresolved", token: t.slice(0, 40) + "…", reason: "too long to be a gene name" };
      if (bySym.has(u)) return { status: "ok", token: t, via: "symbol", row: bySym.get(u) };
      if (ENS_RE.test(t)) {
        var e = u.replace(/\.\d+$/, "");
        if (byEns.has(e)) return { status: "ok", token: t, via: "ensembl", row: byEns.get(e) };
        return { status: "unresolved", token: t, reason: "Ensembl ID not in this screen" };
      }
      if (amb && own(amb, u)) {
        return { status: "ambiguous", token: t, candidates: amb[u].map(cand) };
      }
      if (lookup && own(lookup, u)) {
        var ens = lookup[u], row = byEns.get(ens), cur = currentSymbol(ens);
        if (!row) return { status: "unresolved", token: t, reason: "known gene " + (cur || ens) + " (" + ens + ") is not in this screen" };
        var kind = "alias";
        if (own(byE, ens)) {
          var m = byE[ens];
          if (cur && cur.toUpperCase() === u) kind = "current";
          else if ((m.previous || []).some(function (p) { return String(p).toUpperCase() === u; })) kind = "previous";
        }
        return { status: "ok", token: t, via: kind, row: row, currentSymbol: cur };
      }
      return { status: "unresolved", token: t, reason: symbols ? "not a symbol, Ensembl ID, alias or previous name in this screen" : "not a screen symbol or Ensembl ID" };
    }

    // Resolve many tokens. Two tokens naming the same gene are collapsed (first wins).
    function resolveList(tokens) {
      var res = { resolved: [], unresolved: [], ambiguous: [], collapsed: [] }, seen = new Map();
      tokens.forEach(function (tok) {
        var r = resolveOne(tok);
        if (r.status === "ok") {
          var name = String(r.row[ci.gene]);
          if (seen.has(name)) { res.collapsed.push({ token: tok, gene: name, first: seen.get(name) }); return; }
          seen.set(name, tok);
          res.resolved.push(r);
        } else if (r.status === "ambiguous") res.ambiguous.push(r);
        else res.unresolved.push(r);
      });
      return res;
    }

    // Prefix suggestions: screen symbols, Ensembl IDs, and (if loaded) aliases/previous names of screen genes.
    var sug = null;
    function buildSuggest() {
      var items = [];
      genes.rows.forEach(function (r) {
        items.push([String(r[ci.gene]).toUpperCase(), r[ci.gene], null]);
        if (ci.ensembl != null && r[ci.ensembl]) items.push([String(r[ci.ensembl]).toUpperCase(), r[ci.ensembl], r[ci.gene]]);
      });
      if (lookup) {
        Object.keys(lookup).forEach(function (k) {
          var r = byEns.get(lookup[k]);
          if (r && !bySym.has(k)) items.push([k, k, r[ci.gene]]);
        });
      }
      items.sort(function (a, b) { return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0; });
      sug = items;
    }
    function suggest(prefix, n) {
      var q = String(prefix).trim().toUpperCase(), out = [];
      if (q.length < 2) return out;
      if (!sug) buildSuggest();
      var lo = 0, hi = sug.length;
      while (lo < hi) { var mid = (lo + hi) >> 1; if (sug[mid][0] < q) lo = mid + 1; else hi = mid; }
      for (var i = lo; i < sug.length && out.length < (n || 30) && sug[i][0].indexOf(q) === 0; i++) out.push({ value: sug[i][1], gene: sug[i][2] });
      return out;
    }
    function invalidateSuggest() { sug = null; }
    return { resolveOne: resolveOne, resolveList: resolveList, suggest: suggest, invalidateSuggest: invalidateSuggest, col: ci, size: bySym.size };
  }

  // ------------------------------------------------------------ statistics
  var LG = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
            12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  function lgamma(x) { // Lanczos (g = 7); x > 0
    if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
    x -= 1;
    var a = LG[0], t = x + 7.5;
    for (var i = 1; i < 9; i++) a += LG[i] / (x + i);
    return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
  }
  var LF = [0];
  function logFact(n) { // exact by summation, cached
    while (LF.length <= n) LF.push(LF[LF.length - 1] + Math.log(LF.length));
    return LF[n];
  }
  function logChoose(n, k) { return logFact(n) - logFact(k) - logFact(n - k); }
  // P(X >= k) for X ~ Hypergeometric(N population, K successes, n draws): one-sided upper tail, exact.
  function hypergeomSf(k, N, K, n) {
    if (![k, N, K, n].every(function (v) { return Number.isInteger(v) && v >= 0; }) || K > N || n > N) return NaN;
    var lo = Math.max(0, n + K - N), hi = Math.min(n, K);
    if (k <= lo) return 1;
    if (k > hi) return 0;
    var lc = logChoose(N, n), s = 0;
    // sum the (smaller) tail terms from the far end for accuracy
    for (var i = hi; i >= k; i--) s += Math.exp(logChoose(K, i) + logChoose(N - K, n - i) - lc);
    return Math.min(1, s);
  }
  // Regularised upper incomplete gamma Q(a, x) (series / continued fraction), a > 0
  function gammaQ(a, x) {
    if (x <= 0) return 1;
    var lg = a === 0.5 ? 0.5 * Math.log(Math.PI) : lgamma(a);
    if (x < a + 1) {
      var ap = a, sum = 1 / a, del = sum;
      for (var n = 0; n < 500; n++) { ap += 1; del *= x / ap; sum += del; if (Math.abs(del) < Math.abs(sum) * 1e-16) break; }
      return Math.max(0, 1 - sum * Math.exp(-x + a * Math.log(x) - lg));
    }
    var tiny = 1e-300, b = x + 1 - a, c = 1 / tiny, d = 1 / b, hh = d;
    for (var i = 1; i < 500; i++) {
      var an = -i * (i - a); b += 2;
      d = an * d + b; if (Math.abs(d) < tiny) d = tiny;
      c = b + an / c; if (Math.abs(c) < tiny) c = tiny;
      d = 1 / d; var del2 = d * c; hh *= del2;
      if (Math.abs(del2 - 1) < 1e-16) break;
    }
    return Math.exp(-x + a * Math.log(x) - lg) * hh;
  }
  function erfc(x) { return x >= 0 ? gammaQ(0.5, x * x) : 2 - gammaQ(0.5, x * x); }
  function normSfTwoSided(z) { return Math.min(1, erfc(Math.abs(z) / Math.SQRT2)); }

  function median(a) {
    if (!a.length) return null;
    var s = a.slice().sort(function (x, y) { return x - y; }), m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  // Mann-Whitney U (x vs y), normal approximation with tie correction, no continuity correction
  // (equals scipy.stats.mannwhitneyu(x, y, use_continuity=False, method="asymptotic")).
  function mannWhitney(x, y) {
    x = x.filter(isFinite); y = y.filter(isFinite);
    var n1 = x.length, n2 = y.length, N = n1 + n2;
    if (!n1 || !n2) return { n1: n1, n2: n2, U: null, z: null, p: null, auc: null };
    var all = new Array(N);
    for (var i = 0; i < N; i++) all[i] = [i < n1 ? x[i] : y[i - n1], i < n1 ? 1 : 0];
    all.sort(function (a, b) { return a[0] - b[0]; });
    var r1 = 0, tie = 0, i2 = 0;
    while (i2 < N) {
      var j = i2;
      while (j + 1 < N && all[j + 1][0] === all[i2][0]) j++;
      var t = j - i2 + 1, avg = (i2 + j) / 2 + 1;
      for (var k = i2; k <= j; k++) if (all[k][1]) r1 += avg;
      tie += t * t * t - t;
      i2 = j + 1;
    }
    var U = r1 - n1 * (n1 + 1) / 2, mu = n1 * n2 / 2;
    var sigma2 = n1 * n2 / 12 * ((N + 1) - (N > 1 ? tie / (N * (N - 1)) : 0));
    var z = sigma2 > 0 ? (U - mu) / Math.sqrt(sigma2) : 0;
    return { n1: n1, n2: n2, U: U, mu: mu, sigma: Math.sqrt(Math.max(sigma2, 0)), z: z, p: sigma2 > 0 ? normSfTwoSided(z) : 1, auc: U / (n1 * n2),
             median1: median(x), median2: median(y) };
  }

  // ---------------------------------------------------- gene-list analysis
  // resolvedRows: screen rows for the list; universe rows: every gene row. cols: name -> index.
  function analyseList(resolvedRows, allRows, cols) {
    var uni = allRows.filter(function (r) { return r[cols.rank] != null; });
    var inList = new Set(resolvedRows.map(function (r) { return r[cols.gene]; }));
    var listRank = resolvedRows.filter(function (r) { return r[cols.rank] != null; });
    var cats = [["hit_down", "supported hits, fewer foci"], ["hit_up", "supported hits, more foci"], ["any", "supported hits, either direction"]];
    var N = uni.length, n = listRank.length, out = { universe: N, listRankable: n, listTotal: resolvedRows.length, listUnrankable: resolvedRows.length - n, hyper: [] };
    cats.forEach(function (c) {
      var hit = function (r) { return c[0] === "any" ? (r[cols.status] === "hit_down" || r[cols.status] === "hit_up") : r[cols.status] === c[0]; };
      var K = uni.filter(hit).length, k = listRank.filter(hit).length;
      out.hyper.push({ key: c[0], label: c[1], N: N, K: K, n: n, k: k, expected: N ? n * K / N : null, fold: K && n ? k / (n * K / N) : null, p: n ? hypergeomSf(k, N, K, n) : null });
    });
    var x = listRank.map(function (r) { return r[cols.med_z]; }), y = uni.filter(function (r) { return !inList.has(r[cols.gene]); }).map(function (r) { return r[cols.med_z]; });
    out.mw = mannWhitney(x, y);
    return out;
  }
  var PHRASE = { hit_down: "supported hits with fewer foci", hit_up: "supported hits with more foci", any: "supported hits (either direction)" };
  function interpretHyper(h) {
    if (!h.n) return "No rankable genes in the list, so nothing to test.";
    var what = PHRASE[h.key] || h.label;
    var s = h.k + " of the " + h.n + " rankable genes in your list " + (h.k === 1 ? "is" : "are") + " " + what + "; about " +
      (h.expected < 0.1 ? h.expected.toFixed(3) : h.expected.toFixed(1)) + " would be expected if the list were a random draw from the " + h.N.toLocaleString("en-US") + " rankable genes. ";
    if (h.k === 0) return s + "None found, so there is nothing to test for over-representation.";
    if (h.p < 0.05) return s + "That is more than chance alone usually gives (one-sided p = " + fp(h.p) + ").";
    return s + "That is compatible with chance (one-sided p = " + fp(h.p) + ").";
  }
  function interpretMw(m) {
    if (!m || m.p == null) return "Not enough genes for a rank-sum test.";
    var dir = m.z < 0 ? "lower (fewer foci)" : "higher (more foci)";
    var s = "Median z of the list is " + fz(m.median1) + " against " + fz(m.median2) + " for all other rankable genes. ";
    if (m.n1 < 5) return s + "With only " + m.n1 + " rankable genes the normal approximation is unreliable; treat p = " + fp(m.p) + " as a rough guide.";
    if (m.p < 0.05) return s + "The list's genes tend to have " + dir + " scores than the rest (two-sided p = " + fp(m.p) + "; probability a random list gene outranks a random other gene = " + fmt(m.auc, 2) + ").";
    return s + "No clear shift in either direction (two-sided p = " + fp(m.p) + ").";
  }

  // ------------------------------------------------------------ siRNA logic
  function objectify(columns, rows) {
    return rows.map(function (r) { var o = {}; columns.forEach(function (c, i) { o[c] = r[i]; }); return o; });
  }
  // items: objects with sirna, z, qc. QC-removed wells never count.
  function sirnaSummary(items, absZ) {
    absZ = absZ == null ? 2 : absZ;
    var pass = items.filter(function (w) { return w.qc !== "remove"; });
    var by = new Map();
    pass.forEach(function (w) { if (w.z != null && isFinite(w.z)) { var k = w.sirna == null ? w.plate_well : w.sirna; if (!by.has(k)) by.set(k, []); by.get(k).push(w.z); } });
    var per = [];
    by.forEach(function (zs, k) { per.push({ sirna: k, z: median(zs) }); });
    var down = per.filter(function (s) { return s.z < -absZ; }), up = per.filter(function (s) { return s.z > absZ; });
    var opp = 0;
    if (down.length && !up.length) opp = per.filter(function (s) { return s.z > 0 && s.z <= absZ; }).length;
    if (up.length && !down.length) opp = per.filter(function (s) { return s.z < 0 && s.z >= -absZ; }).length;
    var direction = down.length && !up.length ? -1 : up.length && !down.length ? 1 : 0;
    var conflict = down.length > 0 && up.length > 0;
    var msg = "";
    if (per.length < 2) msg = "Only " + per.length + " quality-controlled siRNA" + (per.length === 1 ? "" : "s") + " with a score: agreement cannot be checked.";
    else if (conflict) msg = "The siRNAs disagree: " + down.length + " strongly lower and " + up.length + " strongly higher foci. This gene is not a supported hit.";
    else if (direction !== 0 && (direction < 0 ? down : up).length >= 2) msg = (direction < 0 ? down : up).length + " of " + per.length + " siRNAs have |z| > " + absZ + " in the same direction (" + (direction < 0 ? "fewer" : "more") + " foci)." + (opp ? " " + opp + " other siRNA" + (opp > 1 ? "s" : "") + " point the opposite way, weakly." : "");
    else if (direction !== 0) msg = "Only one siRNA of " + per.length + " has |z| > " + absZ + " (" + (direction < 0 ? "fewer" : "more") + " foci)" + (opp ? "; " + opp + " other" + (opp > 1 ? "s" : "") + " point the opposite way, weakly" : "") + ". One strong siRNA can be an off-target effect, so this gene is not a supported hit.";
    else msg = "No siRNA has |z| > " + absZ + ".";
    return { nWells: items.length, nPass: pass.length, nRemoved: items.length - pass.length, nSirna: per.length, strongDown: down.length, strongUp: up.length,
             direction: direction, conflict: conflict, agree: direction !== 0 && (direction < 0 ? down : up).length >= 2, message: msg };
  }
  function sameDirection(items, direction, absZ) {
    absZ = absZ == null ? 2 : absZ;
    return items.filter(function (w) { return w.qc !== "remove" && w.z != null && direction !== 0 && Math.abs(w.z) > absZ && (w.z < 0) === (direction < 0); });
  }

  // ----------------------------------------------------- citation / BibTeX
  // Parses only what the attribution string states, e.g.
  // "Images: Doil C, et al. <title>. Cell 2009;136:435-446 (doi:10.1016/j.cell.2008.12.041). Via ..."
  function parseAttribution(a) {
    var m = /(?:Images:\s*)?([A-Z][\w'’\-]+) ([A-Z]{1,4}),? et al\.? (.+?)\. ([A-Z][A-Za-z ]*?) (\d{4});(\d+):(\d+)[-–](\d+)\s*\(doi:\s*([^)\s]+)\)/.exec(String(a || ""));
    if (!m) return null;
    return { family: m[1], initials: m[2], title: m[3], journal: m[4], year: m[5], volume: m[6], pageStart: m[7], pageEnd: m[8], doi: m[9] };
  }
  function bibtex(p, extra) {
    if (!p) return null;
    var key = (p.family + p.year).toLowerCase().replace(/[^a-z0-9]/g, "") + "rnf168";
    var ini = p.initials.split("").join(". ") + ".";
    var lines = ["@article{" + key + ",", "  author  = {" + p.family + ", " + ini + " and others},", "  title   = {" + p.title + "},", "  journal = {" + p.journal + "},",
      "  year    = {" + p.year + "},", "  volume  = {" + p.volume + "},", "  pages   = {" + p.pageStart + "--" + p.pageEnd + "},", "  doi     = {" + p.doi + "}" + (extra ? "," : "")];
    if (extra) lines.push("  note    = {" + extra + "}");
    lines.push("}");
    return lines.join("\n");
  }
  // v: {url, accessed, viewLabel, manifest, attribution, licence}
  function citationText(v) {
    var m = v.manifest, lines = [];
    lines.push("Foci Lab: explorer for the idr0010 53BP1 foci siRNA screen (companion to Telomere Evolution Lab)." + (v.viewLabel ? " View: " + v.viewLabel + "." : ""));
    lines.push(v.url + " (accessed " + v.accessed + ").");
    if (m && (m.built_utc || m.git_commit)) {
      lines.push("Data build: " + (m.built_utc ? String(m.built_utc).slice(0, 10) : "date not stated") + (m.git_commit ? ", commit " + String(m.git_commit).slice(0, 12) : "") + (m.code_version ? ", code version " + m.code_version : "") + ".");
    }
    lines.push("Underlying data and images: " + String(v.attribution || "").replace(/^Images:\s*/, "") + (v.licence && String(v.attribution || "").indexOf(v.licence) < 0 ? " Licence: " + v.licence + "." : ""));
    lines.push("Interpretation: exploratory; acute 72 h siRNA screen in U2OS cells; 53BP1 foci mark DNA breaks in general, not telomeres specifically.");
    return lines.join("\n");
  }

  // ---------------------------------------------------------------- hashes
  var LIST_CAP = 200;
  function parseListHash(hash) {
    var m = /^#list=(.*)$/.exec(String(hash || ""));
    if (!m) return null;
    var toks = m[1].split(",").map(function (t) { try { return decodeURIComponent(t); } catch (e) { return ""; } }).filter(Boolean);
    return toks.slice(0, 2000);
  }
  function buildListHash(tokens, cap) {
    cap = cap || LIST_CAP;
    if (!tokens.length || tokens.length > cap) return null;
    return "#list=" + tokens.map(encodeURIComponent).join(",");
  }

  // ------------------------------------------------------------- scale bar
  // Largest 1-2-5 length (µm) that fits within targetPx screen pixels.
  function niceScaleBar(umPerPx, targetPx) {
    if (!(umPerPx > 0) || !(targetPx > 0)) return null;
    var maxUm = umPerPx * targetPx, e = Math.floor(Math.log10(maxUm)), best = null;
    [5, 2, 1].forEach(function (m) { var v = m * Math.pow(10, e); if (best == null && v <= maxUm) best = v; });
    if (best == null) best = Math.pow(10, e - 1) * 5;
    return { um: best, px: best / umPerPx, label: (best >= 1 ? String(Math.round(best * 1000) / 1000) : String(best)) + " µm" };
  }

  return {
    fmt: fmt, fz: fz, fq: fq, fp: fp, fBytes: fBytes, escHtml: escHtml, safeUrl: safeUrl,
    csvCell: csvCell, buildCsv: buildCsv, splitTokens: splitTokens, makeResolver: makeResolver,
    lgamma: lgamma, logChoose: logChoose, hypergeomSf: hypergeomSf, erfc: erfc, normSfTwoSided: normSfTwoSided, median: median,
    mannWhitney: mannWhitney, analyseList: analyseList, interpretHyper: interpretHyper, interpretMw: interpretMw,
    objectify: objectify, sirnaSummary: sirnaSummary, sameDirection: sameDirection,
    parseAttribution: parseAttribution, bibtex: bibtex, citationText: citationText,
    parseListHash: parseListHash, buildListHash: buildListHash, LIST_CAP: LIST_CAP, niceScaleBar: niceScaleBar
  };
});
