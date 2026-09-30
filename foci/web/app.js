// Foci Lab -- static client. Data: data/summary.json + data/genes.json (built by
// scripts/build_foci_dataset.py). Optional, degrade gracefully when missing: data/sirna.json,
// data/symbols.json, data/annotations.json, data/downloads/manifest.json.
// Well images come through api/well.php (a caching proxy to IDR on this host); the live nucleus
// outline comes from the Telomere Lab backend on Railway. Pure logic lives in lib.js (unit-tested).
(function () {
  "use strict";
  var L = window.FociLib;
  var RAILWAY = "https://telomore-production.up.railway.app/api/foci";
  var NS = "http://www.w3.org/2000/svg";
  var S = null, GENES = null, BYNAME = Object.create(null), C = {};
  var resolver = null, symbols = null, annotations = undefined, manifest = null, sirnaData = undefined, sirnaPromise = null;
  var esc = L.escHtml, fmt = L.fmt, fz = L.fz, fq = L.fq;
  var readyState = false, readyQ = [];

  // ---------------------------------------------------------------- theme
  var root = document.documentElement;
  try { var saved = localStorage.getItem("foci-theme"); if (saved) root.dataset.theme = saved; } catch (e) { /* storage blocked */ }
  document.getElementById("themeBtn").addEventListener("click", function () {
    var dark = root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
    root.dataset.theme = dark ? "light" : "dark";
    try { localStorage.setItem("foci-theme", root.dataset.theme); } catch (e) { /* storage blocked */ }
  });

  // -------------------------------------------------------------- helpers
  function el(tag, attrs, parent) {
    var e = document.createElementNS(NS, tag);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }
  function txt(tag, attrs, s, parent) { var e = el(tag, attrs, parent); e.textContent = s; return e; }
  function h(tag, cls, html) { var e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
  function t(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function css(name) { return getComputedStyle(root).getPropertyValue(name).trim(); }
  function $(id) { return document.getElementById(id); }
  function reduced() { return matchMedia("(prefers-reduced-motion: reduce)").matches; }
  function scrollTo(node, block) { node.scrollIntoView({ behavior: reduced() ? "auto" : "smooth", block: block || "nearest" }); }
  function optional(url) { // parsed JSON or null; never throws (404, HTML fallback pages, bad JSON, offline)
    return fetch(url).then(function (r) { return r.ok ? r.text() : null; })
      .then(function (body) { if (body == null) return null; try { return JSON.parse(body); } catch (e) { return null; } })
      .catch(function () { return null; });
  }

  // ---------------------------------------------- support labels and formats
  var STATUS = {
    hit_down: ["down", "Supported hit: fewer foci"], hit_up: ["up", "Supported hit: more foci"],
    q_only: ["mid", "Extreme score, but not supported by two siRNAs"], none: ["mid", "Not a hit"],
    single_well: ["mid", "One well only: not rankable, never a hit"]
  };
  function statusOf(s) { return STATUS[s] || ["mid", String(s)]; }
  var FLAGS = {
    low_cells: "low cell count (under 60 cells per well)", one_sirna: "all wells come from one siRNA",
    disagree: "siRNAs disagree (one strong, another opposite)"
  };
  function supported(r) { return r.status === "hit_down" || r.status === "hit_up"; }

  // ------------------------------------------------ annotations (contract 5)
  function annotSources(ens) {
    if (!annotations || !ens || !annotations.by_ensembl || !Object.prototype.hasOwnProperty.call(annotations.by_ensembl, ens)) return [];
    var by = annotations.by_ensembl[ens];
    return (annotations.sources || []).filter(function (s) { return s && Object.prototype.hasOwnProperty.call(by, s.id) && by[s.id]; })
      .map(function (s) { return { source: s, entry: by[s.id] }; });
  }
  function badges(ens) {
    var wrap = t("span", "badges"), list = annotSources(ens);
    list.forEach(function (x) {
      var url = L.safeUrl(x.entry.url), b = url ? t("a", "badge", String(x.entry.label)) : t("span", "badge", String(x.entry.label));
      if (url) { b.href = url; b.rel = "noopener"; b.target = "_blank"; }
      var tip = x.source.name + ": " + (x.entry.detail || x.entry.label);
      b.title = tip; b.setAttribute("aria-label", tip);
      wrap.appendChild(b); wrap.appendChild(document.createTextNode(" "));
    });
    return list.length ? wrap : null;
  }
  function annotDetails(ens) {
    var list = annotSources(ens);
    if (!list.length) return null;
    var d = t("details", "annot-src"), sm = t("summary", null, "Annotation sources and caveats"), ul = t("ul");
    d.appendChild(sm);
    list.forEach(function (x) {
      var s = x.source, li = t("li"), m = annotations.match && annotations.match[s.id];
      var nm = L.safeUrl(s.url) ? t("a", null, s.name) : t("b", null, s.name);
      if (nm.tagName === "A") { nm.href = s.url; nm.rel = "noopener"; nm.target = "_blank"; }
      li.appendChild(nm);
      li.appendChild(document.createTextNode(": " + x.entry.label + (x.entry.detail ? " (" + x.entry.detail + ")" : "") + ". "));
      var meta = [s.version ? "version " + s.version : "", s.retrieved_utc ? "retrieved " + String(s.retrieved_utc).slice(0, 10) : "", s.licence ? "licence " + s.licence : ""].filter(Boolean).join(", ");
      if (meta) li.appendChild(t("span", "note", meta + ". "));
      if (s.attribution) li.appendChild(t("span", "note", s.attribution + " "));
      if (m && m.screen_genes_matched != null) li.appendChild(t("span", "note", "Screen genes matched: " + Number(m.screen_genes_matched).toLocaleString() + (m.of != null ? " of " + Number(m.of).toLocaleString() : "") + ". "));
      if (s.caveat) li.appendChild(t("span", "caveat-inline", "Caveat: " + s.caveat));
      ul.appendChild(li);
    });
    d.appendChild(ul);
    return d;
  }

  // ------------------------------------ diverging bar chart on the z scale
  function barChart(host, rows, onPick) {
    host.innerHTML = "";
    var rowH = 26, top = 8, left = 104, right = 118, W = 600, H = top + rows.length * rowH + 22;
    var svg = el("svg", { viewBox: "0 0 " + W + " " + H, role: "img", "aria-label": "Median score of each gene in robust standard deviations of the negative controls" }, host);
    var lim = 14, x = function (v) { return left + (Math.max(-lim, Math.min(lim, v)) + lim) / (2 * lim) * (W - left - right); };
    el("rect", { x: x(-2), y: top - 4, width: x(2) - x(-2), height: rows.length * rowH + 4, fill: css("--band") }, svg);
    el("line", { x1: x(0), x2: x(0), y1: top - 4, y2: top + rows.length * rowH, stroke: css("--faint"), "stroke-width": 1 }, svg);
    [-12, -8, -4, 0, 4, 8, 12].forEach(function (tk) { txt("text", { x: x(tk), y: H - 4, "text-anchor": "middle", "class": "val" }, fz(tk, 0), svg); });
    rows.forEach(function (r, i) {
      var y = top + i * rowH, v = r.med_z;
      var desc = r.gene + ", median z " + fz(v) + ", " + r.wells + " wells, " + r.sirnas + " siRNAs, " + statusOf(r.status)[1];
      var g = el("g", { "class": "gene", tabindex: 0, role: "button", "aria-label": desc }, svg);
      txt("text", { x: left - 8, y: y + 16, "text-anchor": "end" }, r.gene, g);
      if (v == null || r.wells < 2 && r.status === "single_well") {
        txt("text", { x: x(0) + 8, y: y + 16, "class": "val" }, "one well: not rankable (z " + fz(v) + ")", g);
      } else {
        var x0 = x(0), x1 = x(v), c = v < 0 ? css("--down") : css("--up"), sup = supported(r);
        el("rect", { x: Math.min(x0, x1), y: y + 5, width: Math.max(2, Math.abs(x1 - x0)), height: rowH - 10, rx: 3,
                     fill: sup ? c : "none", stroke: c, "stroke-width": 1.6, "stroke-dasharray": sup ? "0" : "4 3" }, g);
        txt("text", { x: W - right + 8, y: y + 16, "class": "val" }, fz(v) + " · " + r.wells + "w " + r.sirnas + "s" + (sup ? " ✔" : ""), g);
      }
      if (onPick) {
        g.addEventListener("click", function () { onPick(r.gene); });
        g.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPick(r.gene); } });
      }
    });
  }

  // ------------------------------------------------------------ histogram
  function histogram(host, mark) {
    host.innerHTML = "";
    var hs = S.histogram, W = 720, H = 220, Lm = 44, R = 12, T = 12, B = 30;
    var max = Math.max.apply(null, hs.counts), n = hs.counts.length;
    var svg = el("svg", { viewBox: "0 0 " + W + " " + H, role: "img", "aria-label": "Histogram of foci per cell relative to plate" }, host);
    var x = function (v) { return Lm + v / hs.edges[n] * (W - Lm - R); };
    var y = function (c) { return T + (1 - c / max) * (H - T - B); };
    var b = S.controls["negative control"];
    el("rect", { x: x(b.p10), y: T, width: x(b.p90) - x(b.p10), height: H - T - B, fill: css("--band") }, svg);
    hs.counts.forEach(function (c, i) {
      el("rect", { x: x(hs.edges[i]) + 1, y: y(c), width: x(hs.edges[i + 1]) - x(hs.edges[i]) - 2, height: H - B - y(c), fill: css("--neutral"), rx: 1.5 }, svg);
    });
    [0, 1, 2, 3, 4].forEach(function (tk) { txt("text", { x: x(tk), y: H - 10, "text-anchor": "middle", "class": "val" }, tk === 4 ? "≥4" : String(tk), svg); });
    txt("text", { x: Lm, y: T + 12, "class": "val" }, max.toLocaleString() + " wells", svg);
    if (mark != null && mark.v != null) {
      var mx = x(Math.min(mark.v, hs.edges[n]));
      el("line", { x1: mx, x2: mx, y1: T, y2: H - B, stroke: css("--accent"), "stroke-width": 2.5 }, svg);
      txt("text", { x: Math.min(mx + 6, W - 90), y: T + 30, fill: css("--accent") }, mark.name + " " + fmt(mark.v), svg);
    }
  }

  // --------------------------------------------------------------- scatter
  function scatter(host, Lx) {
    host.innerHTML = "";
    var W = 520, H = 360, P = { l: 48, r: 14, t: 12, b: 42 };
    var pts = Lx.points.filter(function (p) { return p[0] != null && p[1] != null; });
    var xmax = Math.max.apply(null, pts.map(function (p) { return p[1]; })) * 1.05;
    var ymax = Math.max.apply(null, pts.map(function (p) { return p[0]; })) * 1.05;
    var svg = el("svg", { viewBox: "0 0 " + W + " " + H, role: "img", "aria-label": "Our foci per cell against the authors' foci per cell" }, host);
    var x = function (v) { return P.l + v / xmax * (W - P.l - P.r); }, y = function (v) { return P.t + (1 - v / ymax) * (H - P.t - P.b); };
    el("line", { x1: P.l, x2: W - P.r, y1: H - P.b, y2: H - P.b, stroke: css("--line") }, svg);
    el("line", { x1: P.l, x2: P.l, y1: P.t, y2: H - P.b, stroke: css("--line") }, svg);
    [0, 5, 10, 15].forEach(function (tk) { if (tk <= xmax) txt("text", { x: x(tk), y: H - P.b + 16, "text-anchor": "middle", "class": "val" }, String(tk), svg); });
    [0, 5, 10, 15].forEach(function (tk) { if (tk <= ymax) txt("text", { x: P.l - 8, y: y(tk) + 4, "text-anchor": "end", "class": "val" }, String(tk), svg); });
    txt("text", { x: (W + P.l) / 2, y: H - 6, "text-anchor": "middle" }, "authors' foci per cell (published)", svg);
    txt("text", { x: 14, y: (H - P.b) / 2, "text-anchor": "middle", transform: "rotate(-90 14 " + (H - P.b) / 2 + ")" }, "our foci per cell", svg);
    var REP = { RNF168: 1, MDC1: 1, RNF8: 1 }, PRO = { PSMA3: 1, PSMB2: 1, PSMB6: 1 };
    pts.forEach(function (p) {
      var c = REP[p[2]] ? css("--down") : PRO[p[2]] ? css("--up") : css("--neutral");
      var dot = el("circle", { cx: x(p[1]), cy: y(p[0]), r: REP[p[2]] || PRO[p[2]] ? 5 : 3.6, fill: c, "fill-opacity": 0.85 }, svg);
      txt("title", {}, (p[2] || "sample") + ": authors " + fmt(p[1]) + ", ours " + fmt(p[0]), dot);
    });
  }

  // ------------------------------------------------------------ view / cite
  var view = { kind: "page" };
  function baseUrl() { return /^https?:$/.test(location.protocol) ? location.origin + location.pathname : location.href.split(/[?#]/)[0]; }
  function setView(v) { view = v || { kind: "page" }; updateCite(); }
  function viewUrlLabel() {
    if (view.kind === "gene") return { url: baseUrl() + "?gene=" + encodeURIComponent(view.gene), label: "gene " + view.gene };
    if (view.kind === "list") {
      var hash = L.buildListHash(view.tokens);
      return hash ? { url: baseUrl() + hash, label: "gene list of " + view.tokens.length + " gene" + (view.tokens.length === 1 ? "" : "s") }
                  : { url: baseUrl(), label: "custom gene list of " + view.tokens.length + " genes (no permalink above " + L.LIST_CAP + " genes)" };
    }
    return { url: baseUrl(), label: "" };
  }
  function updateCite() {
    if (!S) return;
    var v = viewUrlLabel(), acc = new Date().toISOString().slice(0, 10);
    $("citeView").textContent = v.label ? "This citation refers to: " + v.label + "." : "This citation refers to the whole site. Open a gene or analyse a list first to cite that view.";
    $("citeText").value = L.citationText({ url: v.url, accessed: acc, viewLabel: v.label, manifest: manifest, attribution: S.attribution, licence: S.license });
    var p = L.parseAttribution(S.attribution), b = p && L.bibtex(p, "Data via the Image Data Resource, study idr0010; " + S.license);
    $("bibText").textContent = b || "";
    $("bibCopy").hidden = !b; document.querySelector("#citeCard .bib").hidden = !b;
  }
  function copyText(text, msgEl) {
    function done(ok) { msgEl.textContent = ok ? "Copied." : "Copy failed: select the text and press Ctrl+C."; setTimeout(function () { msgEl.textContent = ""; }, 3000); }
    function fallback() {
      var ta = document.createElement("textarea"); ta.value = text; ta.setAttribute("readonly", ""); ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      var ok = false; try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
      document.body.removeChild(ta); done(ok);
    }
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(function () { done(true); }, fallback); else fallback();
  }
  $("citeCopy").addEventListener("click", function () { copyText($("citeText").value, $("citeMsg")); });
  $("bibCopy").addEventListener("click", function () { copyText($("bibText").textContent, $("citeMsg")); });

  function saveBlob(name, text, type) {
    var blob = new Blob([text], { type: type || "text/csv;charset=utf-8" }), a = document.createElement("a"), u = URL.createObjectURL(blob);
    a.href = u; a.download = name; document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(u); }, 2000);
  }

  // ------------------------------------------------------------ downloads
  function renderDownloads() {
    var box = $("dlBody"); box.innerHTML = "";
    if (!manifest || !Array.isArray(manifest.files) || !manifest.files.length) {
      box.appendChild(t("p", "note", "The processed data files are not published on this build yet. Per-gene CSV export (gene card) and the gene-list CSV work without them."));
      return;
    }
    var meta = [];
    if (manifest.built_utc) meta.push("built " + String(manifest.built_utc).replace("T", " ").replace(/:\d\d(\.\d+)?Z?$/, " UTC"));
    if (manifest.git_commit) meta.push("commit " + String(manifest.git_commit).slice(0, 12));
    if (manifest.code_version) meta.push("code version " + manifest.code_version);
    if (meta.length) box.appendChild(t("p", "note", "Data " + meta.join(", ") + "."));
    var wrap = t("div", "tbl"), tb = t("table"), cap = t("caption", "sr", "Downloadable data files"); tb.appendChild(cap);
    var head = t("tr");
    ["file", "size", "rows", "SHA-256", "what it is"].forEach(function (c) { head.appendChild(t("th", null, c)).setAttribute("scope", "col"); });
    var th = t("thead"); th.appendChild(head); tb.appendChild(th);
    var body = t("tbody");
    manifest.files.forEach(function (f) {
      if (!f || !/^[A-Za-z0-9._-]{1,80}$/.test(String(f.name))) return;
      var tr = t("tr"), td = t("th"); td.setAttribute("scope", "row");
      var a = t("a", null, f.name); a.href = "data/downloads/" + f.name; a.setAttribute("download", f.name); td.appendChild(a); tr.appendChild(td);
      tr.appendChild(t("td", "num", L.fBytes(f.bytes)));
      tr.appendChild(t("td", "num", f.rows == null ? "–" : Number(f.rows).toLocaleString()));
      var sh = t("td", "sha"); sh.appendChild(t("code", null, f.sha256 ? String(f.sha256) : "–")); tr.appendChild(sh);
      tr.appendChild(t("td", "wrap", f.description || ""));
      body.appendChild(tr);
    });
    tb.appendChild(body); wrap.appendChild(tb); box.appendChild(wrap);
    var lic = manifest.licence || S.license;
    box.appendChild(t("p", "note", "Licence: " + lic + ". " + (manifest.attribution || S.attribution)));
    if (L.safeUrl(manifest.source_metadata_url)) {
      var p = t("p", "note", "Source metadata: "), a2 = t("a", null, "IDR idr0010 annotation table"); a2.href = manifest.source_metadata_url; a2.rel = "noopener"; p.appendChild(a2); box.appendChild(p);
    }
  }

  // ------------------------------------------------------- gene resolution
  var GENE_RE = /^[A-Za-z][A-Za-z0-9-]{0,24}$/;
  function currentSymbol(row) {
    var ens = row[C.ensembl];
    return symbols && symbols.by_ensembl && ens && Object.prototype.hasOwnProperty.call(symbols.by_ensembl, ens) && symbols.by_ensembl[ens].symbol || row[C.gene];
  }
  function linkouts(row) {
    var sym = currentSymbol(row), ens = row[C.ensembl], out = [];
    if (ens) out.push(["Ensembl", "https://www.ensembl.org/id/" + encodeURIComponent(ens)]);
    if (GENE_RE.test(sym)) {
      out.push(["HGNC", "https://www.genenames.org/tools/search/#!/?query=" + encodeURIComponent(sym)]);
      out.push(["UniProt", "https://www.uniprot.org/uniprotkb?query=" + encodeURIComponent("gene_exact:" + sym + " AND organism_id:9606").replace(/%20/g, "+")]);
      out.push(["STRING", "https://string-db.org/cgi/network?identifiers=" + encodeURIComponent(sym) + "&species=9606"]);
    }
    return out;
  }

  // ------------------------------------------------------------ siRNA data
  function getSirna() {
    if (sirnaData !== undefined) return Promise.resolve(sirnaData);
    if (!sirnaPromise) sirnaPromise = optional("data/sirna.json").then(function (d) {
      sirnaData = d && d.by_gene && d.columns ? d : null; return sirnaData;
    });
    return sirnaPromise;
  }
  function wellItems(row) { // fallback from genes.json: its well_list holds the quality-controlled wells only
    return row[C.well_list].map(function (w) { return { sirna: w[5], plate_well: w[0], z: w[3], norm_fpc: w[1], fpc: null, cells: w[4], qc: "pass", imaged: w[2], sense: null, antisense: null }; });
  }
  function sirnaItems(row, sd) {
    var g = row[C.gene];
    if (sd && Object.prototype.hasOwnProperty.call(sd.by_gene, g)) return { items: L.objectify(sd.columns, sd.by_gene[g]), full: true };
    return { items: wellItems(row), full: false };
  }
  function geneCsv(row, sirna) {
    var head = ["gene", "ensembl", "gene_status", "gene_median_z", "gene_combined_z", "gene_q", "sirna", "plate_well", "z", "foci_per_cell_vs_plate", "foci_per_cell_raw", "cells", "qc", "imaged", "sense", "antisense", "source"];
    var g = [row[C.gene], row[C.ensembl], row[C.status], row[C.med_z], row[C.emp_z], row[C.q]];
    var rows = sirna.items.map(function (w) {
      return g.concat([w.sirna, w.plate_well, w.z, w.norm_fpc, w.fpc, w.cells, w.qc, w.imaged, w.sense, w.antisense, "IDR idr0010, Doil et al. 2009, " + S.license]);
    });
    return L.buildCsv(head, rows);
  }
  function renderSirna(box, row, sd) {
    box.innerHTML = "";
    var sirna = sirnaItems(row, sd), items = sirna.items, sum = L.sirnaSummary(items);
    var msg = t("p", "note sirna-msg" + (sum.conflict || !sum.agree ? " warn" : ""), sum.message + (sum.nRemoved ? " " + sum.nRemoved + " well" + (sum.nRemoved > 1 ? "s" : "") + " removed by quality control " + (sum.nRemoved > 1 ? "are" : "is") + " greyed out and not counted." : ""));
    msg.setAttribute("role", "status"); box.appendChild(msg);
    if (!sirna.full) box.appendChild(t("p", "note", sd ? "siRNA table for this gene is not in sirna.json; showing the quality-controlled wells from the gene table (no sequences)." : "Per-siRNA detail (QC-removed wells, sequences) is not published on this build; showing the quality-controlled wells from the gene table."));
    var lab = t("label", "chk"), cb = t("input"); cb.type = "checkbox";
    lab.appendChild(cb); lab.appendChild(document.createTextNode(" Only siRNAs with the same direction (|z| > 2)"));
    box.appendChild(lab);
    var out = t("p", "note"); out.setAttribute("role", "status"); box.appendChild(out);
    var wrap = t("div", "tbl"), tb = t("table"); tb.appendChild(t("caption", "sr", "Individual siRNAs for " + row[C.gene]));
    var th = t("thead"), hr = t("tr");
    ["siRNA", "well", "z", "foci/cell vs plate", "raw foci/cell", "cells", "QC"].forEach(function (c) { var x = t("th", null, c); x.setAttribute("scope", "col"); hr.appendChild(x); });
    th.appendChild(hr); tb.appendChild(th);
    var body = t("tbody"); tb.appendChild(body); wrap.appendChild(tb); box.appendChild(wrap);
    function rows() {
      body.innerHTML = "";
      var show = cb.checked ? L.sameDirection(items, sum.direction) : items;
      out.textContent = cb.checked ? (sum.direction === 0 ? "No consistent direction to filter on: " + (sum.conflict ? "the siRNAs disagree." : "no siRNA has |z| > 2.") : show.length + " of " + items.length + " wells shown.") : "";
      show.forEach(function (w) {
        var tr = t("tr", w.qc === "remove" ? "qc-removed" : ""), th1 = t("th", null, w.sirna == null ? "–" : String(w.sirna)); th1.setAttribute("scope", "row"); tr.appendChild(th1);
        var tdw = t("td");
        if (w.imaged) {
          var b = t("button", "lnk", w.plate_well); b.type = "button";
          b.addEventListener("click", function () { openWell(w.plate_well, row[C.gene], w.norm_fpc); });
          tdw.appendChild(b);
        } else { tdw.textContent = w.plate_well; tdw.title = "Plate not hosted in IDR"; }
        tr.appendChild(tdw);
        tr.appendChild(t("td", "num", fz(w.z))); tr.appendChild(t("td", "num", w.norm_fpc == null ? "–" : fmt(w.norm_fpc) + "×"));
        tr.appendChild(t("td", "num", fmt(w.fpc))); tr.appendChild(t("td", "num", w.cells == null ? "–" : String(w.cells)));
        tr.appendChild(t("td", null, w.qc === "remove" ? "removed (not counted)" : "pass"));
        body.appendChild(tr);
      });
    }
    cb.addEventListener("change", rows); rows();
    var withSeq = items.filter(function (w) { return w.sense || w.antisense; });
    if (withSeq.length) {
      var d = t("details", "seqs"), sm = t("summary", null, "siRNA sequences (" + withSeq.length + ")"); d.appendChild(sm);
      var ul = t("ul");
      withSeq.forEach(function (w) {
        var li = t("li"); li.appendChild(t("b", null, String(w.sirna) + " "));
        li.appendChild(t("code", null, "sense " + (w.sense || "–") + " · antisense " + (w.antisense || "–")));
        if (w.qc === "remove") li.appendChild(t("span", "note", " (removed by QC)"));
        ul.appendChild(li);
      });
      d.appendChild(ul); box.appendChild(d);
    }
    var csvBtn = t("button", "btn ghost", "Download this gene's wells (CSV)"); csvBtn.type = "button";
    csvBtn.addEventListener("click", function () { saveBlob("foci_" + String(row[C.gene]).replace(/[^A-Za-z0-9._-]/g, "_") + "_wells.csv", geneCsv(row, sirna)); });
    var r = t("div", "row"); r.appendChild(csvBtn); box.appendChild(r);
  }

  // ------------------------------------------------------------ gene card
  var shownRow = null;
  function fillAnnot(box, row) {
    box.innerHTML = "";
    var b = badges(row[C.ensembl]);
    if (b) { box.appendChild(t("span", "annot-lbl", "Annotations: ")); box.appendChild(b); var d = annotDetails(row[C.ensembl]); if (d) box.appendChild(d); box.hidden = false; }
    else box.hidden = annotations !== undefined;
  }
  function refreshAnnotations() {
    if (!S) return;
    var box = document.querySelector("#geneCard [data-annot]");
    if (box && shownRow) fillAnnot(box, shownRow);
    telomereTable();
    window.dispatchEvent(new Event("foci:annotations"));
  }
  function showGeneRow(g, note) {
    shownRow = g;
    var card = $("geneCard");
    card.hidden = false;
    var st = statusOf(g[C.status]), k = st[0], ranked = g[C.rank] != null, st_ = S.stats;
    var wells = g[C.well_list].map(function (w) {
      var txtw = esc(w[0]) + " · " + fmt(w[1]) + "× · z " + fz(w[3]) + " · " + w[4] + " cells" + (w[4] < st_.rules.low_cells ? " ⚠" : "");
      return '<button type="button" data-w="' + esc(w[0]) + '" data-v="' + (w[1] == null ? "" : esc(w[1])) + '"' +
        (w[2] ? "" : " disabled title=\"Plate not hosted in IDR\"") + ">" + txtw + "</button>";
    }).join("");
    var flags = g[C.flags].map(function (f) { return "<li>" + esc(FLAGS[f] || f) + "</li>"; }).join("");
    var nRank = st_.genes_rankable;
    var links = linkouts(g).map(function (x) { return '<a href="' + esc(x[1]) + '" target="_blank" rel="noopener">' + esc(x[0]) + "</a>"; }).join(" · ");
    card.innerHTML =
      '<div class="gene-head"><h3>' + esc(g[C.gene]) + '</h3><span class="pill ' + k + '">' + esc(st[1]) + "</span>" +
      (g[C.ensembl] ? '<span class="mono">' + esc(g[C.ensembl]) + "</span>" : "") + "</div>" +
      '<div class="annot-box" data-annot' + (annotations === undefined ? "" : " hidden") + "></div>" +
      (links ? '<p class="links">Look up: ' + links + "</p>" : "") +
      '<div class="stats"><div>median z (per well)<b>' + fz(g[C.med_z]) + "</b></div>" +
      "<div>combined z · q (empirical null)<b>" + (ranked ? fz(g[C.emp_z]) + " · " + fq(g[C.q]) : "–") + "</b></div>" +
      "<div>wells · distinct siRNAs<b>" + esc(g[C.wells]) + " · " + esc(g[C.sirnas]) + "</b></div>" +
      "<div>median cells per well<b>" + fmt(g[C.cells], 0) + "</b></div>" +
      "<div>foci / cell vs plate (median)<b>" + fmt(g[C.med_norm]) + "×</b></div><div>raw foci / cell<b>" + fmt(g[C.fpc]) + "</b></div>" +
      "<div>rank (fewest foci first)<b>" + (ranked ? g[C.rank].toLocaleString() + " / " + nRank.toLocaleString() : "not ranked") + "</b></div></div>" +
      (flags ? '<ul class="flags" aria-label="Flags">' + flags + "</ul>" : "") +
      '<p class="note">z counts robust standard deviations of the negative controls (' + fmt(st_.negative_controls.robust_sd, 2) +
      " log2 units); negative = fewer foci. Cell count sits next to every value because foci per cell falls as cell count rises (Spearman " + fmt(st_.cells_vs_z_spearman) + ").</p>" +
      '<p class="note caveat">Caution: two independent siRNAs against the same gene agree only weakly across the screen (Spearman ' + fmt(st_.concordance.spearman) +
      "; " + Math.round(100 * st_.concordance.tail_agree) + "% agreement in the tail against " + Math.round(100 * st_.concordance.tail_agree_shuffled) +
      "% by chance). Only genes supported by two siRNAs and a small q deserve trust.</p>" +
      '<h4>Individual siRNAs</h4><div class="sirna-box" data-sirna><p class="note">Loading siRNA table…</p></div>' +
      '<h4>Wells</h4><p class="note">Open a well to see its original image:</p><div class="wells">' + wells + "</div>" +
      (g[C.well_list].some(function (w) { return !w[2]; }) ? '<p class="note">Greyed wells sit on plate 153-29, which IDR does not host, so no image is available.</p>' : "");
    card.querySelectorAll(".wells button").forEach(function (b) {
      b.addEventListener("click", function () { openWell(b.dataset.w, g[C.gene], b.dataset.v); });
    });
    fillAnnot(card.querySelector("[data-annot]"), g);
    var sbox = card.querySelector("[data-sirna]");
    getSirna().then(function (sd) { if (shownRow === g) renderSirna(sbox, g, sd); });
    histogram($("hist"), { name: g[C.gene], v: g[C.med_norm] });
    setView({ kind: "gene", gene: g[C.gene] });
  }
  function noteText(msg) { $("resolveNote").textContent = msg || ""; }
  // Resolve whatever the user typed and show the gene (or explain why not).
  function doSearch(text, opts) {
    opts = opts || {};
    var q = String(text || "").trim(), card = $("geneCard");
    if (!q) { noteText("Type a gene symbol, Ensembl ID or alias."); return; }
    var r = resolver.resolveOne(q);
    if (r.status === "ok") {
      var g = r.row, sym = g[C.gene];
      var how = r.via === "symbol" ? "" : r.via === "ensembl" ? "“" + q + "” is Ensembl ID of " + sym + "." :
        r.via === "previous" ? "“" + q + "” is a previous symbol; resolved as " + sym + "." : r.via === "current" ? "“" + q + "” resolved as " + sym + " in this screen." :
        "“" + q + "” is an alias; resolved as " + sym + ".";
      noteText(how);
      showGeneRow(g);
      if (opts.push) pushGene(sym);
      if (!opts.noscroll) scrollTo(card);
    } else if (r.status === "ambiguous") {
      shownRow = null; card.hidden = false; card.innerHTML = "";
      card.appendChild(t("p", null, "“" + q + "” is ambiguous: it names more than one gene. Pick one:"));
      var ul = t("div", "wells");
      r.candidates.forEach(function (c) {
        if (c.inScreen) {
          var b = t("button", null, (c.symbol || c.gene) + " (" + c.ensembl + ")"); b.type = "button";
          b.addEventListener("click", function () { $("geneInput").value = c.gene; doSearch(c.gene, { push: true }); });
          ul.appendChild(b);
        } else ul.appendChild(t("span", "note", (c.symbol || c.ensembl) + " (" + c.ensembl + "): not in this screen "));
      });
      card.appendChild(ul); noteText("Ambiguous name; nothing was guessed."); setView({ kind: "page" });
      histogram($("hist"), null);
    } else {
      shownRow = null; card.hidden = false;
      card.innerHTML = "<p>No gene matching <b>" + esc(q) + "</b> in this screen (" + esc(r.reason || "not found") + ").</p>";
      var sug = resolver.suggest(q.replace(/[^A-Za-z0-9-]/g, ""), 8);
      if (sug.length) {
        card.appendChild(t("p", "note", "Did you mean:"));
        var w2 = t("div", "wells");
        sug.forEach(function (s) { var b = t("button", null, s.value + (s.gene ? " → " + s.gene : "")); b.type = "button"; b.addEventListener("click", function () { $("geneInput").value = s.gene || s.value; doSearch(s.gene || s.value, { push: true }); }); w2.appendChild(b); });
        card.appendChild(w2);
      }
      noteText(""); setView({ kind: "page" });
      histogram($("hist"), null);
    }
  }
  function pushGene(sym) {
    var u = new URL(location.href); u.searchParams.set("gene", sym);
    if (u.search === location.search) return;
    try { history.pushState({ gene: sym }, "", u.pathname + u.search + u.hash); } catch (e) { /* file:// */ }
  }
  function pickGene(name) {
    $("geneInput").value = name;
    doSearch(name, { push: true, noscroll: true });
    scrollTo($("explorer"), "start");
  }

  // ----------------------------------------------------------- well dialog
  var dlg = $("wellDlg"), cur = null, curGene = null, viewer = null;
  function initViewer() {
    if (viewer) return;
    viewer = window.FociViewer.create({
      panesEl: $("vwPanes"), channelsEl: $("vwChannels"), zoomInEl: $("vwIn"), zoomOutEl: $("vwOut"), resetEl: $("vwReset"),
      attribution: function () { return S.attribution; },
      onInfo: function (i, info) {
        if (i !== 0) return;
        var a = $("wellIdr"), url = info && L.safeUrl(info.idr_url);
        if (url && /^https:\/\/idr\.openmicroscopy\.org\//.test(url)) { a.href = url; a.hidden = false; } else a.hidden = true;
        $("wellMeta").querySelectorAll("[data-px]").forEach(function (n) { n.remove(); });
        if (info && info.pixel_size_um > 0) {
          $("wellMeta").insertAdjacentHTML("beforeend", '<dt data-px>pixel size</dt><dd data-px>' + esc(fmt(info.pixel_size_um, 3)) + " µm</dd>");
        }
      },
      onTools: function (s) {
        $("dlgBody").classList.toggle("cmp-on", s.panes > 1);
        $("cmpOff").hidden = s.panes < 2;
      }
    });
  }
  function openWell(well, gene, v) {
    if (!window.FociViewer) return;
    initViewer();
    cur = well; curGene = gene;
    $("wellTitle").textContent = well + (gene ? " · " + gene : "");
    viewer.clear();
    $("wellIdr").hidden = true;
    viewer.load(0, well, gene || "");
    $("wellMeta").innerHTML =
      "<dt>gene</dt><dd>" + esc(gene || "control") + "</dd><dt>foci / cell vs plate</dt><dd>" + (v ? esc(fmt(v)) + "×" : "–") + "</dd>";
    var btn = $("wellOutline");
    btn.disabled = false; btn.textContent = "Outline nuclei (live, Railway)";
    $("cmpGene").value = ""; fillCmpWells(null);
    if (typeof dlg.showModal === "function") { if (!dlg.open) dlg.showModal(); } else dlg.setAttribute("open", "");
  }
  $("wellClose").addEventListener("click", function () { dlg.close(); });
  dlg.addEventListener("click", function (e) { if (e.target === dlg) dlg.close(); });
  dlg.addEventListener("close", function () { if (viewer) viewer.clear(); cur = null; });
  $("wellOutline").addEventListener("click", function () {
    var btn = this, well = cur;
    if (!well || !viewer) return;
    btn.disabled = true; btn.textContent = "Analysing…";
    viewer.status(0, "Running the classical counter on the server (a few seconds)…");
    fetch(RAILWAY + "/overlay?well=" + encodeURIComponent(well)).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    }).then(function (d) {
      if (well !== cur) return;
      return viewer.setOverlay(0, "data:image/jpeg;base64," + d.jpeg, "Our outline").then(function () {
        $("wellMeta").insertAdjacentHTML("beforeend",
          "<dt>nuclei (ours)</dt><dd>" + esc(d.nuclei) + "</dd><dt>foci / cell (ours)</dt><dd>" + esc(fmt(d.foci_per_cell)) + "</dd>");
        viewer.status(0, "White: nucleus outlines. Amber: spots our counter accepted. Choose a channel to go back.");
        btn.textContent = "Outlined";
      });
    }).catch(function (e) {
      viewer.status(0, "Live analysis is unavailable right now (" + e.message + ").");
      btn.disabled = false; btn.textContent = "Try again";
    });
  });
  // compare
  function fillCmpWells(row) {
    var sel = $("cmpWell"); sel.innerHTML = "";
    var wl = row ? row[C.well_list].filter(function (w) { return w[2]; }) : [];
    if (!wl.length) { var o = t("option", null, row ? "no imaged wells for this gene" : "choose a gene first"); o.value = ""; sel.appendChild(o); $("cmpGo").disabled = true; return; }
    wl.forEach(function (w) { var o = t("option", null, w[0] + " · z " + fz(w[3])); o.value = w[0]; sel.appendChild(o); });
    $("cmpGo").disabled = false;
  }
  $("cmpGene").addEventListener("input", function () {
    var v = this.value.trim(), list = $("cmpList"); list.innerHTML = "";
    resolver.suggest(v, 20).forEach(function (s) { var o = document.createElement("option"); o.value = s.gene || s.value; if (s.gene) o.label = s.value + " → " + s.gene; list.appendChild(o); });
    var r = v.length >= 2 ? resolver.resolveOne(v) : null;
    fillCmpWells(r && r.status === "ok" ? r.row : null);
    $("cmpGene").dataset.gene = r && r.status === "ok" ? r.row[C.gene] : "";
  });
  $("cmpGo").addEventListener("click", function () {
    var w = $("cmpWell").value, g = $("cmpGene").dataset.gene;
    if (w && viewer) viewer.load(1, w, g || "");
  });
  $("cmpCtl").addEventListener("click", function () {
    var ctl = (S.gallery || []).filter(function (x) { return !x.gene; })[0];
    if (ctl && viewer) viewer.load(1, ctl.well, "negative control");
  });
  $("cmpOff").addEventListener("click", function () { if (viewer) viewer.remove(1); });

  // --------------------------------------------------------------- render
  function telomereTable() {
    var rows = S.telomere_panel.map(function (x) {
      var sup = x.status === "single_well" ? "not rankable" : statusOf(x.status)[1];
      return '<tr><th scope="row">' + esc(x.gene) + "</th><td>" + esc(x.wells) + "</td><td>" + esc(x.sirnas) + "</td><td>" + fz(x.med_z) + "</td><td>" + fmt(x.cells, 0) +
        "</td><td>" + esc(sup) + "</td><td>" + (x.flags.length ? esc(x.flags.map(function (f) { return f.replace(/_/g, " "); }).join(", ")) : "–") + '</td><td data-ann="' + esc(x.gene) + '"></td></tr>';
    }).join("");
    var tb = $("teloTable");
    tb.innerHTML = '<caption class="sr">Telomere and shelterin genes in the screen</caption><thead><tr><th scope="col">gene</th><th scope="col">wells</th><th scope="col">siRNAs</th><th scope="col">median z</th><th scope="col">median cells</th><th scope="col">status</th><th scope="col">flags</th><th scope="col">annotations</th></tr></thead><tbody>' + rows + "</tbody>";
    tb.querySelectorAll("td[data-ann]").forEach(function (td) {
      var g = BYNAME[td.dataset.ann.toUpperCase()], b = g && badges(g[C.ensembl]);
      if (b) td.appendChild(b); else td.textContent = annotations === undefined ? "" : "–";
    });
  }
  function render() {
    var tt = S.totals;
    $("t-genes").textContent = tt.genes.toLocaleString();
    $("tiles").innerHTML = [
      [tt.wells.toLocaleString(), "wells in the screen"], [tt.genes.toLocaleString(), "genes silenced"],
      [tt.imaged_wells.toLocaleString(), "wells with images in IDR"], [S.license, "open licence"],
    ].map(function (x) { return '<div class="tile"><b>' + esc(x[0]) + "</b><span>" + esc(x[1]) + "</span></div>"; }).join("");
    $("attrib").textContent = S.attribution;

    charts();
    histogram($("hist"), null);
    texts();

    var gal = $("gal");
    (S.gallery || []).forEach(function (g) {
      var card = h("article", "shot");
      var title = g.gene || "Negative control";
      card.innerHTML =
        '<div class="pic"><img loading="lazy" src="data/' + esc(g.raw) + '" alt="' + esc(title) + ' knockdown: DNA blue, 53BP1 green">' +
        '<button type="button" class="toggle" aria-pressed="false">Our outline</button></div>' +
        '<div class="meta"><h3><span>' + esc(title) + '</span><span class="mono">' + esc(g.well) + "</span></h3><p>" + esc(g.desc) + "</p>" +
        "<table><tr><td>authors: foci / cell</td><td>" + fmt(g.authors.fpc) + "</td></tr><tr><td>authors: vs plate</td><td>" + fmt(g.authors.norm) + "×</td></tr>" +
        "<tr><td>ours (not validated)</td><td>" + fmt(g.ours.fpc) + "</td></tr></table></div>";
      var img = card.querySelector("img"), tg = card.querySelector(".toggle");
      tg.addEventListener("click", function () {
        var on = tg.getAttribute("aria-pressed") !== "true";
        tg.setAttribute("aria-pressed", String(on));
        img.src = "data/" + (on ? g.overlay : g.raw);
      });
      gal.appendChild(card);
    });

    var Lx = S.experiment_l;
    if (Lx) {
      var N = Lx.nucleus_check;
      scatter($("scatter"), Lx);
      $("verdict").innerHTML =
        "<h3>Result: no agreement</h3><p>On " + Lx.n_wells + " wells spanning the full range, our per-well foci per cell does not track the published values.</p>" +
        "<dl><dt>Spearman ρ</dt><dd>" + fmt(Lx.spearman, 3) + "</dd><dt>Pearson r</dt><dd>" + fmt(Lx.pearson, 3) + "</dd>" +
        "<dt>nuclei count r</dt><dd>" + fmt(Lx.cells_pearson, 3) + "</dd>" +
        "<dt>RNF168/MDC1/RNF8 wells: ours vs authors</dt><dd>" + fmt(Lx.median_ours_repair_kd) + " vs " + fmt(Lx.median_authors_repair_kd) + "</dd>" +
        "<dt>proteasome wells: ours vs authors</dt><dd>" + fmt(Lx.median_ours_proteasome_kd) + " vs " + fmt(Lx.median_authors_proteasome_kd) + "</dd></dl>" +
        "<p><b>Why, as far as we can tell (not tested):</b> IDR holds exactly one image per well, so the number of fields is not the explanation: on the " + N.n_images + " images we cached, our nucleus count has median " + fmt(N.median_ours, 0) +
        " against the authors' cell count of " + fmt(N.median_authors, 0) + " (ratio " + fmt(N.median_ratio_of_medians) + "; per-well ratio 10th to 90th percentile " + fmt(N.ratio_p10) + " to " + fmt(N.ratio_p90) +
        "), so the two count roughly the same nuclei. The likelier causes are (1) the source images are 16-bit while the render we can fetch is a windowed 8-bit PNG, which clips bright foci and compresses dim ones, and (2) the authors' focus definition and thresholds are not published in the table. " +
        "Three detector designs and a parameter grid did not close the gap.</p>" +
        "<p><b>What a better test needs:</b> the raw 16-bit data (BioImage Archive S-BIAD885 holds OME-Zarr archives of about 450 MB per plate) and a comparison of per-nucleus intensity distributions against the authors' 63 phenotype-annotated wells, instead of comparing counts. <b>That re-test has not been done.</b></p>" +
        "<p><b>So:</b> every biological claim on this site uses the authors' own numbers. Our counter is an unvalidated illustration.</p>";
    }
  }

  function charts() {
    barChart($("lowChart"), S.lowest.slice(0, 12), pickGene);
    barChart($("highChart"), S.highest.slice(0, 12), pickGene);
    barChart($("teloChart"), S.telomere_panel, pickGene);
  }

  function texts() {
    var st = S.stats, n = st.empirical_null, cn = st.concordance, tc = st.truth_check, r = st.rules;
    var low3 = S.lowest.slice(0, 3).map(function (x) { return x.gene; }).join(", ");
    $("findNote").innerHTML =
      "Bars show each gene's median z; solid bars are <b>supported hits</b> (at least " + r.min_sirnas + " distinct siRNAs each with |z| &gt; " + r.sirna_abs_z +
      " in the same direction, and empirical-null q &lt; " + r.q + "), dashed bars are not. Labels give wells (w) and distinct siRNAs (s). The grey band is |z| &lt; 2. " +
      "Genes are ordered by combined z over the " + st.genes_rankable.toLocaleString() + " genes with at least two wells.";
    $("callout").innerHTML =
      "<b>" + st.supported_hits_down + " supported hits with fewer foci and " + st.supported_hits_up + " with more foci</b>, among " + st.genes_rankable.toLocaleString() +
      " genes with two or more wells. The strongest three decreases are <b>" + esc(low3) + "</b>, the recruitment pathway the paper reported; the increases are dominated by <b>proteasome</b> subunits (PSMA/PSMB). " +
      st.q_only_not_supported + " more genes reach q &lt; " + r.q + " without two supporting siRNAs and are not called hits. " + st.single_well_genes.toLocaleString() +
      " genes have a single quality-controlled well and are never called.";
    $("teloNote").innerHTML =
      "Wells, distinct siRNAs, median z and flags come from the same table as the hits above. " +
      "<b>WRN and DKC1 have only one quality-controlled well</b>, so they cannot be ranked. Absent: " +
      Object.keys(S.telomere_absent).map(function (g) { return esc(g) + " (" + esc(S.telomere_absent[g]) + ")"; }).join("; ") + ".";
    telomereTable();
    $("howBody").innerHTML =
      "<p><b>What z means.</b> Each well's foci per cell (already divided by its plate's typical value) is put on a log2 scale, the median of the " + st.negative_controls.wells +
      " quality-controlled negative-control wells is subtracted, and the result is divided by their robust spread (" + fmt(st.negative_controls.robust_sd, 2) +
      " log2 units). z = −3 means three control-spreads fewer foci; z = +3 means more.</p>" +
      "<p><b>Why an empirical null.</b> Wells of a gene share plates and siRNAs, so combined scores are wider than a textbook N(0,1): under N(0,1), " + st.genes_q05_theoretical_null.toLocaleString() +
      " genes would pass q &lt; 0.05. We instead centre and scale by the bulk of the combined scores (median " + fmt(n.median, 2) + ", robust SD " + fmt(n.robust_sd, 2) + "), which leaves " + st.genes_q05_empirical_null + " genes.</p>" +
      "<p><b>Why only the tail is trustworthy.</b> Across " + cn.n_pairs.toLocaleString() + " genes with two or more siRNAs, the first two siRNAs correlate only weakly (Spearman " + fmt(cn.spearman, 2) +
      "; " + fmt(cn.spearman_shuffled, 2) + " when shuffled across genes; " + fmt(cn.spearman_bulk, 2) + " inside the bulk). When one siRNA scores |z| ≥ 3, the other confirms it (same sign, |z| &gt; 2) for " +
      Math.round(100 * cn.tail_agree) + "% of genes, against " + Math.round(100 * cn.tail_agree_shuffled) + "% by chance. Mid-range scores of single genes are mostly noise, which is why hits need two siRNAs.</p>" +
      "<p><b>Check against the authors' own annotations.</b> The paper labelled " + tc.increased.genes + " genes (" + tc.increased.wells + " wells) &quot;increased DNA damage&quot; and " + tc.defective.genes +
      " genes (" + tc.defective.wells + " wells) &quot;defective DNA damage response&quot;. In our ranking, " + tc.increased.top50 + " of the " + tc.increased.genes + " increased-damage genes fall in the top 50 of " + st.genes_rankable.toLocaleString() +
      " (" + tc.increased.top100 + " in the top 100; gene-level AUC " + fmt(tc.increased.gene_auc, 3) + ", well-level AUC " + fmt(tc.increased.well_auc, 3) + "), and " + tc.defective.top50 + " of " + tc.defective.genes + " defective-response genes fall in the bottom 50 (well-level AUC " + fmt(tc.defective.well_auc, 3) +
      "). This is a consistency check, not independent proof: the annotations come from the same screen.</p>" +
      "<p><b>Flags.</b> Wells under " + r.low_cells + " cells (about " + fmt(st.low_cell_wells_pct, 0) + "% of wells) make foci per cell unstable, and foci per cell tends to fall as cell count rises (Spearman " + fmt(st.cells_vs_z_spearman) + "), a possible toxicity confound.</p>";
  }

  function setupSearch() {
    var list = $("geneList"), input = $("geneInput");
    // a datalist of ~17.5k options is heavy: fill it lazily with prefix matches only
    input.addEventListener("input", function () {
      list.innerHTML = "";
      resolver.suggest(input.value, 30).forEach(function (s) {
        var o = document.createElement("option"); o.value = s.gene || s.value;
        if (s.gene) o.label = s.value + " → " + s.gene;
        list.appendChild(o);
      });
    });
    $("geneForm").addEventListener("submit", function (e) { e.preventDefault(); doSearch(input.value, { push: true }); });
  }
  function routeGene(initial) {
    var q = new URLSearchParams(location.search).get("gene");
    if (q) { $("geneInput").value = q; doSearch(q, { noscroll: initial }); }
  }
  window.addEventListener("popstate", function () {
    if (!S || !resolver) return;
    var q = new URLSearchParams(location.search).get("gene");
    if (!q) return;
    var r = resolver.resolveOne(q);
    if (r.status === "ok" && r.row === shownRow) return; // plain #anchor navigation: leave the card alone
    $("geneInput").value = q; doSearch(q, { noscroll: true });
  });

  // ----------------------------------------------------------------- boot
  window.FociApp = {
    ready: function (cb) { if (readyState) cb(api()); else readyQ.push(cb); },
    get: api, badges: badges, css: css, el: el, txt: txt, t: t, h: h, saveBlob: saveBlob, setView: setView, pickGene: pickGene, scrollTo: scrollTo,
    statusOf: statusOf, FLAGS: FLAGS, copyText: copyText, optional: optional
  };
  function api() { return { S: S, GENES: GENES, C: C, BYNAME: BYNAME, resolver: resolver, symbols: symbols, annotations: annotations, manifest: manifest }; }

  var optionals = Promise.all([
    optional("data/symbols.json").then(function (d) { symbols = d && d.lookup && d.by_ensembl ? d : null; }),
    optional("data/annotations.json").then(function (d) { annotations = d && d.by_ensembl && Array.isArray(d.sources) ? d : null; }),
    optional("data/downloads/manifest.json").then(function (d) { manifest = d && Array.isArray(d.files) ? d : null; })
  ]);

  function fetchJson(u) { return fetch(u).then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status + " for " + u); return r.json(); }); }
  Promise.all([fetchJson("data/summary.json"), fetchJson("data/genes.json")])
    .then(function (res) {
      S = res[0]; GENES = res[1];
      GENES.columns.forEach(function (c, i) { C[c] = i; });
      GENES.rows.forEach(function (r) { BYNAME[String(r[0]).toUpperCase()] = r; });
      resolver = L.makeResolver(GENES, null);
      render();
      setupSearch();
      updateCite();
      // optional files load in parallel with the main data; wait for them (bounded) before routing
      return Promise.race([optionals, new Promise(function (r) { setTimeout(r, 4000); })]);
    })
    .then(function () {
      resolver = L.makeResolver(GENES, symbols);
      renderDownloads(); refreshAnnotations(); updateCite();
      routeGene(true);
      readyState = true;
      readyQ.splice(0).forEach(function (cb) { cb(api()); });
    })
    .catch(function (e) {
      $("tiles").innerHTML = '<p class="note">Could not load the dataset (' + esc(e.message) + ").</p>";
      $("dlBody").textContent = "";
    });

  // redraw charts with the right colours when the theme changes
  new MutationObserver(function () { if (S) { var g = shownRow; charts(); if (S.experiment_l) scatter($("scatter"), S.experiment_l); histogram($("hist"), g ? { name: g[C.gene], v: g[C.med_norm] } : null); window.dispatchEvent(new Event("foci:theme")); } })
    .observe(root, { attributes: true, attributeFilter: ["data-theme"] });
})();
