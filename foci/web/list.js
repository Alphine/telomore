// Foci Lab -- "Test your gene list": resolve pasted genes against the screen, show a table,
// volcano and rank plot, and two simple enrichment tests (computed and unit-tested in lib.js).
(function () {
  "use strict";
  var A = window.FociApp, L = window.FociLib;
  if (!A || !L) return;
  var D = null, last = null, sort = { key: "q", dir: 1 }, showAll = false, lastKey = null;
  var fmt = L.fmt, fz = L.fz, fq = L.fq;
  var CAP = 2000, ROWS = 200;
  var EXAMPLE = "ATM ATR CHEK1 CHEK2 BRCA1 BRCA2 RAD51 MDC1 H2AFX RNF8 RNF168 PARP1 XRCC4 LIG4 TP53 MRE11 RAD50 NBN";
  function $(id) { return document.getElementById(id); }
  var t = A.t;

  // ------------------------------------------------------------- running
  function run(text, opts) {
    opts = opts || {};
    var sp = L.splitTokens(text, CAP), out = $("listOut");
    if (!sp.tokens.length) {
      out.textContent = ""; $("listLink").textContent = "Paste at least one gene first.";
      last = null; A.setView({ kind: "page" }); return;
    }
    var res = D.resolver.resolveList(sp.tokens), C = D.C;
    var entries = res.resolved.map(function (r) { return { token: r.token, via: r.via, row: r.row, currentSymbol: r.currentSymbol }; });
    var an = L.analyseList(entries.map(function (e) { return e.row; }), D.GENES.rows, C);
    last = { split: sp, res: res, entries: entries, an: an };
    lastKey = sp.tokens.join(",");
    var hash = L.buildListHash(sp.tokens);
    if (opts.push && location.hash !== hash) {
      try { history.pushState({ list: 1 }, "", location.pathname + location.search + (hash || "")); } catch (e) { /* file:// */ }
    }
    var lk = $("listLink"); lk.textContent = "";
    if (hash) {
      lk.appendChild(document.createTextNode("Permalink to this list: "));
      var a = t("a", null, location.href.split("#")[0] + hash); a.href = hash; lk.appendChild(a);
    } else lk.textContent = "No permalink: lists over " + L.LIST_CAP + " genes are too long for a URL. Use the CSV export to keep your results.";
    A.setView({ kind: "list", tokens: sp.tokens });
    render();
    lk.appendChild(document.createTextNode(" · " + entries.length + " of " + sp.tokens.length + " entries matched a screen gene."));
    if (!opts.noscroll) A.scrollTo($("genelist"), "start");
  }

  // ------------------------------------------------------------ rendering
  function render() {
    var out = $("listOut"), C = D.C, an = last.an, res = last.res, sp = last.split;
    out.innerHTML = "";
    var byStatus = { hit_down: 0, hit_up: 0 };
    last.entries.forEach(function (e) { var s = e.row[C.status]; if (s in byStatus) byStatus[s]++; });
    var nVia = { symbol: 0, ensembl: 0, other: 0 };
    last.entries.forEach(function (e) { nVia[e.via === "symbol" ? "symbol" : e.via === "ensembl" ? "ensembl" : "other"]++; });

    var sum = t("div", "list-sum");
    var p1 = t("p", null, "");
    p1.innerHTML = "<b>" + sp.tokens.length + "</b> unique entries read; <b>" + last.entries.length + "</b> matched a gene in the screen" +
      " (" + nVia.symbol + " by symbol, " + nVia.ensembl + " by Ensembl ID, " + nVia.other + " by alias or previous name). " +
      "<b>" + an.listRankable + "</b> of them can be ranked (two or more wells)" + (an.listUnrankable ? "; " + an.listUnrankable + (an.listUnrankable === 1 ? " has a single well and is" : " have a single well and are") + " never called." : ".");
    sum.appendChild(p1);
    var p2 = t("p", "hitline", "");
    p2.innerHTML = "Supported hits in your list: <b class=\"dn\">" + byStatus.hit_down + " with fewer foci</b> and <b class=\"upc\">" + byStatus.hit_up + " with more foci</b>.";
    sum.appendChild(p2);
    if (sp.truncated) sum.appendChild(t("p", "note warn", "Only the first " + CAP.toLocaleString() + " of " + sp.unique.toLocaleString() + " unique entries were used."));
    if (sp.duplicates) sum.appendChild(t("p", "note", sp.duplicates + " repeated entr" + (sp.duplicates === 1 ? "y was" : "ies were") + " counted once."));
    out.appendChild(sum);

    problems(out, res);
    if (last.entries.length) {
      enrichment(out);
      var two = t("div", "two");
      var f1 = t("figure", "card"), f2 = t("figure", "card");
      f1.appendChild(t("figcaption", null, "Volcano: median z against significance (q)"));
      f1.appendChild(t("div", null)).id = "volcano";
      f1.appendChild(t("p", "note", "Each dot is a gene. Grey: all rankable genes. Rings: your genes; filled: supported hits. The table below has the same values."));
      f2.appendChild(t("figcaption", null, "Rank plot: where your genes sit in the ranking"));
      f2.appendChild(t("div", null)).id = "rankplot";
      f2.appendChild(t("p", "note", "Genes ordered from fewest to most foci (by combined z). Marks: your genes."));
      two.appendChild(f1); two.appendChild(f2); out.appendChild(two);
      plots();
      tableSection(out);
    } else out.appendChild(t("p", "note warn", "None of the entries matched a gene in this screen, so there is nothing to plot."));
  }

  function problems(out, res) {
    var n = res.unresolved.length + res.ambiguous.length + res.collapsed.length;
    if (!n) return;
    var d = t("details", "card problems"); if (n <= 12) d.open = true;
    d.appendChild(t("summary", null, "Entries that were not used (" + res.unresolved.length + " not found, " + res.ambiguous.length + " ambiguous, " + res.collapsed.length + " duplicate genes)"));
    var ul = t("ul");
    res.unresolved.forEach(function (u) { ul.appendChild(t("li", null, u.token + ": " + u.reason)); });
    res.ambiguous.forEach(function (a) {
      ul.appendChild(t("li", null, a.token + ": ambiguous, could be " + a.candidates.map(function (c) { return (c.symbol || c.ensembl) + " (" + c.ensembl + (c.inScreen ? "" : ", not in screen") + ")"; }).join(" or ") + ". Nothing was guessed; use a specific symbol or Ensembl ID."));
    });
    res.collapsed.forEach(function (c) { ul.appendChild(t("li", null, c.token + " is the same gene as " + c.first + " (" + c.gene + "); counted once.")); });
    d.appendChild(ul); out.appendChild(d);
  }

  function enrichment(out) {
    var an = last.an, card = t("div", "card enrich");
    card.appendChild(t("h3", null, "Enrichment (exploratory)"));
    var head = t("p", "note", "Universe: the " + an.universe.toLocaleString() + " genes with at least two wells (the only genes that can be ranked or called). Your list contributes " + an.listRankable + " of them.");
    card.appendChild(head);
    // over-representation
    card.appendChild(t("h4", null, "1. Are supported hits over-represented in your list?"));
    var wrap = t("div", "tbl"), tb = t("table");
    tb.appendChild(t("caption", "sr", "Over-representation of supported hits in the gene list"));
    var hr = t("tr");
    ["category", "in your list", "in the universe", "expected in list", "fold", "one-sided p"].forEach(function (c) { var th = t("th", null, c); th.setAttribute("scope", "col"); hr.appendChild(th); });
    var th = t("thead"); th.appendChild(hr); tb.appendChild(th);
    var body = t("tbody");
    an.hyper.forEach(function (x) {
      var tr = t("tr"), h1 = t("th", null, x.label); h1.setAttribute("scope", "row"); tr.appendChild(h1);
      tr.appendChild(t("td", "num", x.k + " of " + x.n)); tr.appendChild(t("td", "num", x.K + " of " + x.N.toLocaleString()));
      tr.appendChild(t("td", "num", x.expected == null ? "–" : x.expected < 0.1 ? x.expected.toFixed(3) : x.expected.toFixed(1)));
      tr.appendChild(t("td", "num", x.fold == null ? "–" : x.fold.toFixed(1) + "×")); tr.appendChild(t("td", "num", L.fp(x.p)));
      body.appendChild(tr);
    });
    tb.appendChild(body); wrap.appendChild(tb); card.appendChild(wrap);
    var ul = t("ul", "interp");
    an.hyper.forEach(function (x) { ul.appendChild(t("li", null, L.interpretHyper(x))); });
    card.appendChild(ul);
    card.appendChild(t("p", "note", "Method: exact hypergeometric upper tail, P(at least k hits), by summation in log space; it matches scipy.stats.hypergeom to 8 digits in the unit tests."));
    // rank-sum
    card.appendChild(t("h4", null, "2. Do your genes have shifted scores overall?"));
    var m = an.mw;
    if (m && m.p != null) {
      var dl = t("dl", "kv");
      [["genes in list / others", m.n1 + " / " + m.n2.toLocaleString()], ["median z, list", fz(m.median1)], ["median z, others", fz(m.median2)],
       ["Mann-Whitney U", String(m.U)], ["P(list gene > other gene)", fmt(m.auc, 3)], ["z (normal approx.)", fz(m.z, 2)], ["two-sided p", L.fp(m.p)]].forEach(function (kv) {
        dl.appendChild(t("dt", null, kv[0])); dl.appendChild(t("dd", null, kv[1]));
      });
      card.appendChild(dl);
    }
    card.appendChild(t("p", "interp", L.interpretMw(m)));
    card.appendChild(t("p", "note", "Method: Mann-Whitney rank-sum on each gene's median z, list genes against all other rankable genes; normal approximation with tie correction and no continuity correction (matches scipy.stats.mannwhitneyu, method asymptotic, in the unit tests). Below about 5 list genes the approximation is rough."));
    // caveats
    var cv = t("div", "caveat"), cs = D.S.stats.concordance.spearman;
    cv.appendChild(t("b", null, "Read this before you trust a p-value."));
    var cul = t("ul");
    ["These tests are exploratory. Four tests are shown and p-values are not corrected for that; treat p between 0.01 and 0.05 as a hint at best.",
     "Two siRNAs against one gene agree only weakly across the screen (Spearman " + fmt(cs, 2) + "), so single-gene scores are noisy and lists of a few genes have little power. A non-significant result is not evidence of no effect.",
     "Gene lists chosen after looking at these data (for example the top hits of this screen) will look enriched by construction. The tests assume the list was fixed beforehand.",
     "Genes in one pathway or complex are not independent, which makes the p-values optimistic. The universe excludes genes with a single well.",
     "This is a short-term (about 72 h) siRNA screen in one cell line (U2OS). 53BP1 foci mark DNA breaks in general, not telomeres specifically."]
      .forEach(function (s) { cul.appendChild(t("li", null, s)); });
    cv.appendChild(cul); card.appendChild(cv);
    out.appendChild(card);
  }

  // ---------------------------------------------------------------- plots
  function plots() {
    if (!last || !$("volcano")) return;
    var C = D.C, uni = D.GENES.rows.filter(function (r) { return r[C.rank] != null; });
    var mine = last.entries.map(function (e) { return e.row; }).filter(function (r) { return r[C.rank] != null; });
    volcano($("volcano"), uni, mine); rankPlot($("rankplot"), uni, mine);
  }
  function ticks(lo, hi, n) {
    var span = hi - lo, step = Math.pow(10, Math.floor(Math.log10(span / n))), m = span / n / step;
    step *= m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10;
    var out = []; for (var v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(Math.round(v / step) * step);
    return out;
  }
  function nlq(q) { return q == null ? null : q <= 0 ? 300 : -Math.log10(q); }
  function dotColor(r, C) { return r[C.status] === "hit_down" ? A.css("--down") : r[C.status] === "hit_up" ? A.css("--up") : A.css("--ink"); }
  function volcano(host, uni, mine) {
    host.innerHTML = "";
    var C = D.C, el = A.el, tx = A.txt, W = 640, H = 400, P = { l: 52, r: 14, t: 14, b: 46 };
    var zmax = 2, ymax = 2;
    uni.forEach(function (r) { zmax = Math.max(zmax, Math.abs(r[C.med_z])); ymax = Math.max(ymax, nlq(r[C.q]) || 0); });
    zmax = Math.min(60, Math.ceil(zmax / 2) * 2); ymax = Math.ceil(ymax / 5) * 5;
    var x = function (v) { return P.l + (Math.max(-zmax, Math.min(zmax, v)) + zmax) / (2 * zmax) * (W - P.l - P.r); };
    var y = function (v) { return P.t + (1 - Math.min(v, ymax) / ymax) * (H - P.t - P.b); };
    var svg = el("svg", { viewBox: "0 0 " + W + " " + H, role: "img", "aria-label": "Volcano plot of " + mine.length + " genes from your list among " + uni.length + " rankable genes. The table below lists the same values.", "class": "plot" }, host);
    ticks(-zmax, zmax, 6).forEach(function (v) { el("line", { x1: x(v), x2: x(v), y1: P.t, y2: H - P.b, stroke: A.css("--line"), "stroke-width": 1 }, svg); tx("text", { x: x(v), y: H - P.b + 16, "text-anchor": "middle", "class": "val" }, fz(v, 0), svg); });
    ticks(0, ymax, 5).forEach(function (v) { el("line", { x1: P.l, x2: W - P.r, y1: y(v), y2: y(v), stroke: A.css("--line"), "stroke-width": 1 }, svg); tx("text", { x: P.l - 6, y: y(v) + 4, "text-anchor": "end", "class": "val" }, String(v), svg); });
    el("line", { x1: P.l, x2: W - P.r, y1: y(-Math.log10(0.05)), y2: y(-Math.log10(0.05)), stroke: A.css("--faint"), "stroke-dasharray": "5 4", "stroke-width": 1 }, svg);
    tx("text", { x: W - P.r - 2, y: y(-Math.log10(0.05)) - 4, "text-anchor": "end", "class": "val" }, "q = 0.05", svg);
    var d = [];
    uni.forEach(function (r) { var v = nlq(r[C.q]); if (v != null) d.push("M" + x(r[C.med_z]).toFixed(1) + " " + y(v).toFixed(1) + "h0"); });
    el("path", { d: d.join(""), stroke: A.css("--neutral"), "stroke-opacity": 0.45, "stroke-width": 3, "stroke-linecap": "round", fill: "none" }, svg);
    var pts = mine.filter(function (r) { return r[C.q] != null; }).map(function (r) { return { r: r, x: x(r[C.med_z]), y: y(nlq(r[C.q])) }; });
    pts.forEach(function (p) {
      var sup = p.r[C.status] === "hit_down" || p.r[C.status] === "hit_up", col = dotColor(p.r, C);
      var c = el("circle", { cx: p.x, cy: p.y, r: sup ? 5 : 4, fill: sup ? col : "none", stroke: col, "stroke-width": 1.8 }, svg);
      tx("title", {}, p.r[C.gene] + ": z " + fz(p.r[C.med_z]) + ", q " + fq(p.r[C.q]), c);
    });
    labels(svg, pts.slice().sort(function (a, b) { return a.y - b.y; }).slice(0, 8), W, P);
    tx("text", { x: (W + P.l) / 2, y: H - 6, "text-anchor": "middle" }, "median z (negative = fewer foci)", svg);
    tx("text", { x: 13, y: (H - P.b) / 2, "text-anchor": "middle", transform: "rotate(-90 13 " + (H - P.b) / 2 + ")" }, "−log10 q", svg);
    var skipped = mine.length - pts.length;
    if (skipped > 0) host.appendChild(t("p", "note", skipped + " of your genes have no q (single well) and are not drawn."));
  }
  function labels(svg, pts, W, P) {
    var C = D.C, placed = [];
    pts.forEach(function (p) {
      var name = p.r[C.gene], w = name.length * 6.6 + 4, left = p.x + 8 + w > W - P.r, x0 = left ? p.x - 8 - w : p.x + 8, y0 = p.y - 6;
      var hit = placed.some(function (b) { return x0 < b.x1 && x0 + w > b.x0 && y0 - 12 < b.y1 && y0 + 3 > b.y0; });
      if (hit) return;
      placed.push({ x0: x0, x1: x0 + w, y0: y0 - 12, y1: y0 + 3 });
      var g = A.el("g", { "class": "gene", tabindex: 0, role: "button", "aria-label": name + ", open in gene explorer" }, svg);
      A.txt("text", { x: x0, y: y0, "class": "lbl" }, name, g);
      g.addEventListener("click", function () { A.pickGene(name); });
      g.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); A.pickGene(name); } });
    });
  }
  function rankPlot(host, uni, mine) {
    host.innerHTML = "";
    var C = D.C, el = A.el, tx = A.txt, W = 640, H = 400, P = { l: 52, r: 14, t: 14, b: 46 };
    var sorted = uni.slice().sort(function (a, b) { return a[C.rank] - b[C.rank]; }), N = sorted.length;
    var zmin = Infinity, zmax = -Infinity;
    sorted.forEach(function (r) { zmin = Math.min(zmin, r[C.emp_z]); zmax = Math.max(zmax, r[C.emp_z]); });
    var lo = Math.floor(zmin / 5) * 5, hi = Math.ceil(zmax / 5) * 5;
    var x = function (rank) { return P.l + (rank - 1) / Math.max(1, N - 1) * (W - P.l - P.r); };
    var y = function (v) { return P.t + (1 - (v - lo) / (hi - lo)) * (H - P.t - P.b); };
    var svg = el("svg", { viewBox: "0 0 " + W + " " + H, role: "img", "aria-label": "Rank plot: combined z against rank for " + N + " rankable genes, with " + mine.length + " genes from your list marked. The table below lists the same values.", "class": "plot" }, host);
    ticks(lo, hi, 6).forEach(function (v) { el("line", { x1: P.l, x2: W - P.r, y1: y(v), y2: y(v), stroke: A.css("--line"), "stroke-width": 1 }, svg); tx("text", { x: P.l - 6, y: y(v) + 4, "text-anchor": "end", "class": "val" }, fz(v, 0), svg); });
    [1, Math.round(N / 4), Math.round(N / 2), Math.round(3 * N / 4), N].forEach(function (rk) { tx("text", { x: x(rk), y: H - P.b + 16, "text-anchor": "middle", "class": "val" }, rk.toLocaleString(), svg); });
    var d = sorted.map(function (r, i) { return (i ? "L" : "M") + x(r[C.rank]).toFixed(1) + " " + y(r[C.emp_z]).toFixed(1); }).join("");
    el("path", { d: d, fill: "none", stroke: A.css("--neutral"), "stroke-width": 2 }, svg);
    mine.forEach(function (r) {
      var col = dotColor(r, C), sup = r[C.status] === "hit_down" || r[C.status] === "hit_up";
      el("line", { x1: x(r[C.rank]), x2: x(r[C.rank]), y1: H - P.b, y2: y(r[C.emp_z]), stroke: col, "stroke-opacity": 0.35, "stroke-width": 1 }, svg);
      var c = el("circle", { cx: x(r[C.rank]), cy: y(r[C.emp_z]), r: sup ? 5 : 3.6, fill: sup ? col : "none", stroke: col, "stroke-width": 1.8 }, svg);
      tx("title", {}, r[C.gene] + ": rank " + r[C.rank].toLocaleString() + " of " + N.toLocaleString() + ", combined z " + fz(r[C.emp_z]), c);
    });
    tx("text", { x: (W + P.l) / 2, y: H - 6, "text-anchor": "middle" }, "rank (1 = fewest foci)", svg);
    tx("text", { x: 13, y: (H - P.b) / 2, "text-anchor": "middle", transform: "rotate(-90 13 " + (H - P.b) / 2 + ")" }, "combined z (empirical null)", svg);
  }

  // ---------------------------------------------------------------- table
  var COLS = [
    { k: "gene", label: "gene", get: function (e, C) { return e.row[C.gene]; } },
    { k: "med_z", label: "median z", num: true, get: function (e, C) { return e.row[C.med_z]; } },
    { k: "q", label: "q", num: true, get: function (e, C) { return e.row[C.q]; } },
    { k: "status", label: "status", get: function (e, C) { return e.row[C.status]; } },
    { k: "sirnas", label: "siRNAs", num: true, get: function (e, C) { return e.row[C.sirnas]; } },
    { k: "cells", label: "median cells", num: true, get: function (e, C) { return e.row[C.cells]; } },
    { k: "flags", label: "flags", get: function (e, C) { return e.row[C.flags].length; } },
    { k: "ann", label: "annotations", noSort: true }
  ];
  function sortedEntries() {
    var C = D.C, col = COLS.filter(function (c) { return c.k === sort.key; })[0] || COLS[2];
    return last.entries.slice().sort(function (a, b) {
      var x = col.get(a, C), y = col.get(b, C);
      if (x == null && y == null) return String(a.row[C.gene]).localeCompare(b.row[C.gene]);
      if (x == null) return 1; if (y == null) return -1;
      var c = typeof x === "number" ? x - y : String(x).localeCompare(String(y));
      return c ? c * sort.dir : String(a.row[C.gene]).localeCompare(String(b.row[C.gene]));
    });
  }
  function tableSection(out) {
    var card = t("div", "card"); card.id = "listTableCard";
    var top = t("div", "row spread");
    top.appendChild(t("h3", null, "Your genes"));
    var csv = t("button", "btn ghost", "Download results (CSV)"); csv.type = "button"; csv.addEventListener("click", exportCsv);
    top.appendChild(csv); card.appendChild(top);
    var wrap = t("div", "tbl"), tb = t("table"); tb.id = "listTable";
    tb.appendChild(t("caption", "sr", "Genes from your list with their scores in the screen. Column headers are buttons that sort the table."));
    wrap.appendChild(tb); card.appendChild(wrap);
    var more = t("div", "row"); more.id = "listMore"; card.appendChild(more);
    out.appendChild(card);
    tableRows();
  }
  function tableRows() {
    var C = D.C, tb = $("listTable"); if (!tb) return;
    tb.innerHTML = "";
    var thead = t("thead"), hr = t("tr");
    COLS.forEach(function (c) {
      var th = t("th"); th.setAttribute("scope", "col");
      if (c.noSort) th.textContent = c.label;
      else {
        var b = t("button", "sortbtn", c.label); b.type = "button";
        var on = sort.key === c.k;
        th.setAttribute("aria-sort", on ? (sort.dir > 0 ? "ascending" : "descending") : "none");
        if (on) b.textContent = c.label + (sort.dir > 0 ? " ▲" : " ▼");
        b.addEventListener("click", function () { sort = { key: c.k, dir: on ? -sort.dir : 1 }; tableRows(); var nb = $("listTable").querySelector('th:nth-child(' + (COLS.indexOf(c) + 1) + ') button'); if (nb) nb.focus(); });
        th.appendChild(b);
      }
      hr.appendChild(th);
    });
    thead.appendChild(hr); tb.appendChild(thead);
    var body = t("tbody"), rows = sortedEntries(), shown = showAll ? rows : rows.slice(0, ROWS);
    shown.forEach(function (e) {
      var tr = t("tr"), r = e.row, st = A.statusOf(r[C.status]);
      var th = t("th"); th.setAttribute("scope", "row");
      var gb = t("button", "lnk mono", r[C.gene]); gb.type = "button"; gb.addEventListener("click", function () { A.pickGene(r[C.gene]); });
      th.appendChild(gb);
      if (e.via !== "symbol") th.appendChild(t("span", "note from", " (from " + e.token + ")"));
      tr.appendChild(th);
      tr.appendChild(t("td", "num", fz(r[C.med_z]))); tr.appendChild(t("td", "num", fq(r[C.q])));
      var ts = t("td"); ts.appendChild(t("span", "pill " + st[0], st[1])); tr.appendChild(ts);
      tr.appendChild(t("td", "num", String(r[C.sirnas]))); tr.appendChild(t("td", "num", fmt(r[C.cells], 0)));
      tr.appendChild(t("td", "wrap", r[C.flags].length ? r[C.flags].map(function (f) { return f.replace(/_/g, " "); }).join(", ") : "–"));
      var ta = t("td"), b = A.badges(r[C.ensembl]); if (b) ta.appendChild(b); else ta.textContent = "–"; tr.appendChild(ta);
      body.appendChild(tr);
    });
    tb.appendChild(body);
    var more = $("listMore"); more.innerHTML = "";
    if (rows.length > ROWS) {
      var btn = t("button", "btn ghost", showAll ? "Show first " + ROWS : "Show all " + rows.length.toLocaleString() + " genes"); btn.type = "button";
      btn.addEventListener("click", function () { showAll = !showAll; tableRows(); });
      more.appendChild(btn);
    }
  }
  function exportCsv() {
    var C = D.C, head = ["input", "resolved_as", "gene", "ensembl", "status", "rank", "median_z", "combined_z", "q", "wells", "sirnas", "median_cells", "flags"], rows = [];
    last.entries.forEach(function (e) {
      var r = e.row;
      rows.push([e.token, e.via, r[C.gene], r[C.ensembl], r[C.status], r[C.rank], r[C.med_z], r[C.emp_z], r[C.q], r[C.wells], r[C.sirnas], r[C.cells], r[C.flags].join(";")]);
    });
    last.res.unresolved.forEach(function (u) { rows.push([u.token, "not found", "", "", "", "", "", "", "", "", "", "", u.reason]); });
    last.res.ambiguous.forEach(function (a) { rows.push([a.token, "ambiguous", "", "", "", "", "", "", "", "", "", "", a.candidates.map(function (c) { return c.symbol || c.ensembl; }).join(";")]); });
    last.res.collapsed.forEach(function (c) { rows.push([c.token, "duplicate of " + c.first, c.gene, "", "", "", "", "", "", "", "", "", ""]); });
    A.saveBlob("foci_gene_list_results.csv", L.buildCsv(head, rows));
  }

  // ------------------------------------------------------------- wiring
  function fromHash(initial) {
    var toks = L.parseListHash(location.hash);
    if (!toks) return;
    if (toks.join(",") === lastKey) return;
    if (!toks.length) return;
    $("listInput").value = toks.join("\n");
    run(toks.join("\n"), { noscroll: !initial ? true : false, push: false });
  }
  A.ready(function (d) {
    D = d;
    $("listGo").addEventListener("click", function () { showAll = false; run($("listInput").value, { push: true }); });
    $("listExample").addEventListener("click", function () { $("listInput").value = EXAMPLE.split(" ").join("\n"); $("listLink").textContent = "Example list of well-known DNA-damage-response genes, chosen by us in advance, not from this screen's results. Press Analyse list."; });
    $("listClear").addEventListener("click", function () {
      $("listInput").value = ""; $("listOut").textContent = ""; $("listLink").textContent = ""; last = null; lastKey = null;
      try { history.replaceState(null, "", location.pathname + location.search); } catch (e) { /* file:// */ }
      A.setView({ kind: "page" }); $("listInput").focus();
    });
    window.addEventListener("popstate", function () { fromHash(false); });
    window.addEventListener("hashchange", function () { fromHash(false); });
    window.addEventListener("foci:theme", plots);
    window.addEventListener("foci:annotations", function () { if (last) tableRows(); });
    fromHash(true);
  });
})();
