// Foci Lab -- static client. Data: data/summary.json + data/genes.json (built by
// scripts/build_foci_dataset.py). Well images come through api/well.php (a
// caching proxy to IDR on this host); the live nucleus outline comes from the
// Telomere Lab backend on Railway.
(function () {
  "use strict";
  var RAILWAY = "https://telomore-production.up.railway.app/api/foci";
  var NS = "http://www.w3.org/2000/svg";
  var S = null, GENES = null, BYNAME = {}, C = {};

  // ---------------------------------------------------------------- theme
  var root = document.documentElement;
  try { var saved = localStorage.getItem("foci-theme"); if (saved) root.dataset.theme = saved; } catch (e) {}
  document.getElementById("themeBtn").addEventListener("click", function () {
    var dark = root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
    root.dataset.theme = dark ? "light" : "dark";
    try { localStorage.setItem("foci-theme", root.dataset.theme); } catch (e) {}
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
  function fmt(v, d) { return v == null ? "–" : Number(v).toFixed(d == null ? 2 : d); }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function css(name) { return getComputedStyle(root).getPropertyValue(name).trim(); }

  // ---------------------------------------------- support labels and formats
  var STATUS = {
    hit_down: ["down", "Supported hit: fewer foci"], hit_up: ["up", "Supported hit: more foci"],
    q_only: ["mid", "Extreme score, but not supported by two siRNAs"], none: ["mid", "Not a hit"],
    single_well: ["mid", "One well only: not rankable, never a hit"]
  };
  var FLAGS = {
    low_cells: "low cell count (under 60 cells per well)", one_sirna: "all wells come from one siRNA",
    disagree: "siRNAs disagree (one strong, another opposite)"
  };
  function fz(v, d) { return v == null ? "–" : (v < 0 ? "−" : v > 0 ? "+" : "") + Math.abs(v).toFixed(d == null ? 1 : d); }
  function fq(q) { return q == null ? "–" : q < 0.001 ? q.toExponential(1).replace("e-", "e−") : q.toFixed(3); }
  function supported(r) { return r.status === "hit_down" || r.status === "hit_up"; }

  // ------------------------------------ diverging bar chart on the z scale
  // rows: objects from summary.json lists (gene, wells, sirnas, med_z, status, ...)
  function barChart(host, rows, onPick) {
    host.innerHTML = "";
    var rowH = 26, top = 8, left = 104, right = 118, W = 600, H = top + rows.length * rowH + 22;
    var svg = el("svg", { viewBox: "0 0 " + W + " " + H, role: "img", "aria-label": "Median score of each gene in robust standard deviations of the negative controls" }, host);
    var lim = 14, x = function (v) { return left + (Math.max(-lim, Math.min(lim, v)) + lim) / (2 * lim) * (W - left - right); };
    el("rect", { x: x(-2), y: top - 4, width: x(2) - x(-2), height: rows.length * rowH + 4, fill: css("--band") }, svg);
    el("line", { x1: x(0), x2: x(0), y1: top - 4, y2: top + rows.length * rowH, stroke: css("--faint"), "stroke-width": 1 }, svg);
    [-12, -8, -4, 0, 4, 8, 12].forEach(function (t) { txt("text", { x: x(t), y: H - 4, "text-anchor": "middle", "class": "val" }, fz(t, 0), svg); });
    rows.forEach(function (r, i) {
      var y = top + i * rowH, v = r.med_z;
      var desc = r.gene + ", median z " + fz(v) + ", " + r.wells + " wells, " + r.sirnas + " siRNAs, " + STATUS[r.status][1];
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
        g.addEventListener("keydown", function (e) { if (e.key === "Enter") onPick(r.gene); });
      }
    });
  }

  // ------------------------------------------------------------ histogram
  function histogram(host, mark) {
    host.innerHTML = "";
    var hs = S.histogram, W = 720, H = 220, L = 44, R = 12, T = 12, B = 30;
    var max = Math.max.apply(null, hs.counts), n = hs.counts.length;
    var svg = el("svg", { viewBox: "0 0 " + W + " " + H, role: "img", "aria-label": "Histogram of foci per cell relative to plate" }, host);
    var x = function (v) { return L + v / hs.edges[n] * (W - L - R); };
    var y = function (c) { return T + (1 - c / max) * (H - T - B); };
    var b = S.controls["negative control"];
    el("rect", { x: x(b.p10), y: T, width: x(b.p90) - x(b.p10), height: H - T - B, fill: css("--band") }, svg);
    hs.counts.forEach(function (c, i) {
      el("rect", { x: x(hs.edges[i]) + 1, y: y(c), width: x(hs.edges[i + 1]) - x(hs.edges[i]) - 2, height: H - B - y(c), fill: css("--neutral"), rx: 1.5 }, svg);
    });
    [0, 1, 2, 3, 4].forEach(function (t) { txt("text", { x: x(t), y: H - 10, "text-anchor": "middle", "class": "val" }, t === 4 ? "≥4" : String(t), svg); });
    txt("text", { x: L, y: T + 12, "class": "val" }, max.toLocaleString() + " wells", svg);
    if (mark != null) {
      var mx = x(Math.min(mark.v, hs.edges[n]));
      el("line", { x1: mx, x2: mx, y1: T, y2: H - B, stroke: css("--accent"), "stroke-width": 2.5 }, svg);
      txt("text", { x: Math.min(mx + 6, W - 90), y: T + 30, fill: css("--accent") }, mark.name + " " + fmt(mark.v), svg);
    }
  }

  // --------------------------------------------------------------- scatter
  function scatter(host, L) {
    host.innerHTML = "";
    var W = 520, H = 360, P = { l: 48, r: 14, t: 12, b: 42 };
    var pts = L.points.filter(function (p) { return p[0] != null && p[1] != null; });
    var xmax = Math.max.apply(null, pts.map(function (p) { return p[1]; })) * 1.05;
    var ymax = Math.max.apply(null, pts.map(function (p) { return p[0]; })) * 1.05;
    var svg = el("svg", { viewBox: "0 0 " + W + " " + H, role: "img", "aria-label": "Our foci per cell against the authors' foci per cell" }, host);
    var x = function (v) { return P.l + v / xmax * (W - P.l - P.r); }, y = function (v) { return P.t + (1 - v / ymax) * (H - P.t - P.b); };
    el("line", { x1: P.l, x2: W - P.r, y1: H - P.b, y2: H - P.b, stroke: css("--line") }, svg);
    el("line", { x1: P.l, x2: P.l, y1: P.t, y2: H - P.b, stroke: css("--line") }, svg);
    [0, 5, 10, 15].forEach(function (t) { if (t <= xmax) txt("text", { x: x(t), y: H - P.b + 16, "text-anchor": "middle", "class": "val" }, String(t), svg); });
    [0, 5, 10, 15].forEach(function (t) { if (t <= ymax) txt("text", { x: P.l - 8, y: y(t) + 4, "text-anchor": "end", "class": "val" }, String(t), svg); });
    txt("text", { x: (W + P.l) / 2, y: H - 6, "text-anchor": "middle" }, "authors' foci per cell (published)", svg);
    txt("text", { x: 14, y: (H - P.b) / 2, "text-anchor": "middle", transform: "rotate(-90 14 " + (H - P.b) / 2 + ")" }, "our foci per cell", svg);
    var REP = { RNF168: 1, MDC1: 1, RNF8: 1 }, PRO = { PSMA3: 1, PSMB2: 1, PSMB6: 1 };
    pts.forEach(function (p) {
      var c = REP[p[2]] ? css("--down") : PRO[p[2]] ? css("--up") : css("--neutral");
      var dot = el("circle", { cx: x(p[1]), cy: y(p[0]), r: REP[p[2]] || PRO[p[2]] ? 5 : 3.6, fill: c, "fill-opacity": 0.85 }, svg);
      txt("title", {}, (p[2] || "sample") + ": authors " + fmt(p[1]) + ", ours " + fmt(p[0]), dot);
    });
  }

  // ------------------------------------------------------------ gene card
  function showGene(name) {
    var g = BYNAME[String(name).toUpperCase()];
    var card = document.getElementById("geneCard");
    card.hidden = false;
    if (!g) {
      card.innerHTML = "<p>No gene called <b>" + esc(name) + "</b> in this screen (or it has no quality-controlled wells).</p>";
      histogram(document.getElementById("hist"), null);
      return;
    }
    var st = STATUS[g[C.status]], k = st[0], ranked = g[C.rank] != null, st_ = S.stats;
    var wells = g[C.well_list].map(function (w) {
      var txtw = esc(w[0]) + " · " + fmt(w[1]) + "× · z " + fz(w[3]) + " · " + w[4] + " cells" + (w[4] < st_.rules.low_cells ? " ⚠" : "");
      return '<button type="button" data-w="' + esc(w[0]) + '" data-v="' + (w[1] == null ? "" : w[1]) + '"' +
        (w[2] ? "" : " disabled title=\"Plate not hosted in IDR\"") + ">" + txtw + "</button>";
    }).join("");
    var flags = g[C.flags].map(function (f) { return "<li>" + esc(FLAGS[f] || f) + "</li>"; }).join("");
    var nRank = st_.genes_rankable;
    card.innerHTML =
      '<div class="gene-head"><h3>' + esc(g[C.gene]) + '</h3><span class="pill ' + k + '">' + esc(st[1]) + "</span>" +
      (g[C.ensembl] ? '<a class="mono" href="https://www.ensembl.org/id/' + esc(g[C.ensembl]) + '" rel="noopener">' + esc(g[C.ensembl]) + "</a>" : "") + "</div>" +
      '<div class="stats"><div>median z (per well)<b>' + fz(g[C.med_z]) + "</b></div>" +
      "<div>combined z · q (empirical null)<b>" + (ranked ? fz(g[C.emp_z]) + " · " + fq(g[C.q]) : "–") + "</b></div>" +
      "<div>wells · distinct siRNAs<b>" + g[C.wells] + " · " + g[C.sirnas] + "</b></div>" +
      "<div>median cells per well<b>" + fmt(g[C.cells], 0) + "</b></div>" +
      "<div>foci / cell vs plate (median)<b>" + fmt(g[C.med_norm]) + "×</b></div><div>raw foci / cell<b>" + fmt(g[C.fpc]) + "</b></div>" +
      "<div>rank (fewest foci first)<b>" + (ranked ? g[C.rank].toLocaleString() + " / " + nRank.toLocaleString() : "not ranked") + "</b></div></div>" +
      (flags ? '<ul class="flags" aria-label="Flags">' + flags + "</ul>" : "") +
      '<p class="note">z counts robust standard deviations of the negative controls (' + fmt(st_.negative_controls.robust_sd, 2) +
      " log2 units); negative = fewer foci. Cell count sits next to every value because foci per cell falls as cell count rises (Spearman " + fmt(st_.cells_vs_z_spearman) + ").</p>" +
      '<p class="note caveat">Caution: two independent siRNAs against the same gene agree only weakly across the screen (Spearman ' + fmt(st_.concordance.spearman) +
      "; " + Math.round(100 * st_.concordance.tail_agree) + "% agreement in the tail against " + Math.round(100 * st_.concordance.tail_agree_shuffled) +
      "% by chance). Only genes supported by two siRNAs and a small q deserve trust.</p>" +
      '<p class="note">Open a well to see its original image:</p><div class="wells">' + wells + "</div>" +
      (g[C.well_list].some(function (w) { return !w[2]; }) ? '<p class="note">Greyed wells sit on plate 153-29, which IDR does not host, so no image is available.</p>' : "");
    card.querySelectorAll(".wells button").forEach(function (b) {
      b.addEventListener("click", function () { openWell(b.dataset.w, g[C.gene], b.dataset.v); });
    });
    histogram(document.getElementById("hist"), { name: g[C.gene], v: g[C.med_norm] });
    card.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
  function pickGene(name) {
    document.getElementById("geneInput").value = name;
    showGene(name);
    document.getElementById("explorer").scrollIntoView({ behavior: "smooth" });
  }

  // ----------------------------------------------------------- well dialog
  var dlg = document.getElementById("wellDlg"), cur = null;
  function openWell(well, gene, v) {
    cur = well;
    document.getElementById("wellTitle").textContent = well + (gene ? " · " + gene : "");
    var img = document.getElementById("wellImg"), st = document.getElementById("wellStatus");
    img.alt = "Microscopy of well " + well + ": DNA in blue, 53BP1 in green";
    img.removeAttribute("src");
    st.textContent = "Loading image from IDR…";
    img.onload = function () { st.textContent = ""; };
    img.onerror = function () { st.textContent = "Image could not be loaded right now."; };
    img.src = "api/well.php?w=" + encodeURIComponent(well);
    document.getElementById("wellMeta").innerHTML =
      "<dt>gene</dt><dd>" + esc(gene || "control") + "</dd><dt>foci / cell vs plate</dt><dd>" + (v ? fmt(v) + "×" : "–") + "</dd>";
    var btn = document.getElementById("wellOutline");
    btn.disabled = false; btn.textContent = "Outline nuclei (live, Railway)";
    if (typeof dlg.showModal === "function") dlg.showModal(); else dlg.setAttribute("open", "");
  }
  document.getElementById("wellClose").addEventListener("click", function () { dlg.close(); });
  dlg.addEventListener("click", function (e) { if (e.target === dlg) dlg.close(); });
  document.getElementById("wellOutline").addEventListener("click", function () {
    var btn = this, well = cur, st = document.getElementById("wellStatus");
    btn.disabled = true; btn.textContent = "Analysing…";
    st.textContent = "Running the classical counter on the server (a few seconds)…";
    fetch(RAILWAY + "/overlay?well=" + encodeURIComponent(well)).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    }).then(function (d) {
      if (well !== cur) return;
      document.getElementById("wellImg").src = "data:image/jpeg;base64," + d.jpeg;
      document.getElementById("wellMeta").insertAdjacentHTML("beforeend",
        "<dt>nuclei (ours)</dt><dd>" + d.nuclei + "</dd><dt>foci / cell (ours)</dt><dd>" + fmt(d.foci_per_cell) + "</dd>");
      st.textContent = "White: nucleus outlines. Amber: spots our counter accepted.";
      btn.textContent = "Outlined";
    }).catch(function (e) {
      st.textContent = "Live analysis is unavailable right now (" + e.message + ").";
      btn.disabled = false; btn.textContent = "Try again";
    });
  });

  // --------------------------------------------------------------- render
  function render() {
    var t = S.totals;
    document.getElementById("t-genes").textContent = t.genes.toLocaleString();
    document.getElementById("tiles").innerHTML = [
      [t.wells.toLocaleString(), "wells in the screen"], [t.genes.toLocaleString(), "genes silenced"],
      [t.imaged_wells.toLocaleString(), "wells with images in IDR"], [S.license, "open licence"],
    ].map(function (x) { return '<div class="tile"><b>' + x[0] + "</b><span>" + x[1] + "</span></div>"; }).join("");
    document.getElementById("attrib").textContent = S.attribution;

    charts();
    histogram(document.getElementById("hist"), null);
    texts();

    var gal = document.getElementById("gal");
    (S.gallery || []).forEach(function (g) {
      var card = h("article", "shot");
      var title = g.gene || "Negative control";
      card.innerHTML =
        '<div class="pic"><img loading="lazy" src="data/' + g.raw + '" alt="' + esc(title) + ' knockdown: DNA blue, 53BP1 green">' +
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

    var L = S.experiment_l;
    if (L) {
      var N = L.nucleus_check;
      scatter(document.getElementById("scatter"), L);
      document.getElementById("verdict").innerHTML =
        "<h3>Result: no agreement</h3><p>On " + L.n_wells + " wells spanning the full range, our per-well foci per cell does not track the published values.</p>" +
        "<dl><dt>Spearman ρ</dt><dd>" + fmt(L.spearman, 3) + "</dd><dt>Pearson r</dt><dd>" + fmt(L.pearson, 3) + "</dd>" +
        "<dt>nuclei count r</dt><dd>" + fmt(L.cells_pearson, 3) + "</dd>" +
        "<dt>RNF168/MDC1/RNF8 wells: ours vs authors</dt><dd>" + fmt(L.median_ours_repair_kd) + " vs " + fmt(L.median_authors_repair_kd) + "</dd>" +
        "<dt>proteasome wells: ours vs authors</dt><dd>" + fmt(L.median_ours_proteasome_kd) + " vs " + fmt(L.median_authors_proteasome_kd) + "</dd></dl>" +
        "<p><b>Why, as far as we can tell (not tested):</b> IDR holds exactly one image per well, so the number of fields is not the explanation: on the " + N.n_images + " images we cached, our nucleus count has median " + fmt(N.median_ours, 0) +
        " against the authors' cell count of " + fmt(N.median_authors, 0) + " (ratio " + fmt(N.median_ratio_of_medians) + "; per-well ratio 10th to 90th percentile " + fmt(N.ratio_p10) + " to " + fmt(N.ratio_p90) +
        "), so the two count roughly the same nuclei. The likelier causes are (1) the source images are 16-bit while the render we can fetch is a windowed 8-bit PNG, which clips bright foci and compresses dim ones, and (2) the authors' focus definition and thresholds are not published in the table. " +
        "Three detector designs and a parameter grid did not close the gap.</p>" +
        "<p><b>What a better test needs:</b> the raw 16-bit data (BioImage Archive S-BIAD885 holds OME-Zarr archives of about 450 MB per plate) and a comparison of per-nucleus intensity distributions against the authors' 63 phenotype-annotated wells, instead of comparing counts. <b>That re-test has not been done.</b></p>" +
        "<p><b>So:</b> every biological claim on this site uses the authors' own numbers. Our counter is an unvalidated illustration.</p>";
    }
  }

  function charts() {
    barChart(document.getElementById("lowChart"), S.lowest.slice(0, 12), pickGene);
    barChart(document.getElementById("highChart"), S.highest.slice(0, 12), pickGene);
    barChart(document.getElementById("teloChart"), S.telomere_panel, pickGene);
  }

  function texts() {
    var st = S.stats, n = st.empirical_null, cn = st.concordance, tc = st.truth_check, r = st.rules;
    var low3 = S.lowest.slice(0, 3).map(function (x) { return x.gene; }).join(", ");
    document.getElementById("findNote").innerHTML =
      "Bars show each gene's median z; solid bars are <b>supported hits</b> (at least " + r.min_sirnas + " distinct siRNAs each with |z| &gt; " + r.sirna_abs_z +
      " in the same direction, and empirical-null q &lt; " + r.q + "), dashed bars are not. Labels give wells (w) and distinct siRNAs (s). The grey band is |z| &lt; 2. " +
      "Genes are ordered by combined z over the " + st.genes_rankable.toLocaleString() + " genes with at least two wells.";
    document.getElementById("callout").innerHTML =
      "<b>" + st.supported_hits_down + " supported hits with fewer foci and " + st.supported_hits_up + " with more foci</b>, among " + st.genes_rankable.toLocaleString() +
      " genes with two or more wells. The strongest three decreases are <b>" + esc(low3) + "</b>, the recruitment pathway the paper reported; the increases are dominated by <b>proteasome</b> subunits (PSMA/PSMB). " +
      st.q_only_not_supported + " more genes reach q &lt; " + r.q + " without two supporting siRNAs and are not called hits. " + st.single_well_genes.toLocaleString() +
      " genes have a single quality-controlled well and are never called.";
    document.getElementById("teloNote").innerHTML =
      "Wells, distinct siRNAs, median z and flags come from the same table as the hits above. " +
      "<b>WRN and DKC1 have only one quality-controlled well</b>, so they cannot be ranked. Absent: " +
      Object.keys(S.telomere_absent).map(function (g) { return esc(g) + " (" + esc(S.telomere_absent[g]) + ")"; }).join("; ") + ".";
    var rows = S.telomere_panel.map(function (x) {
      var sup = x.status === "single_well" ? "not rankable" : STATUS[x.status][1];
      return '<tr><th scope="row">' + esc(x.gene) + "</th><td>" + x.wells + "</td><td>" + x.sirnas + "</td><td>" + fz(x.med_z) + "</td><td>" + fmt(x.cells, 0) +
        "</td><td>" + esc(sup) + "</td><td>" + (x.flags.length ? esc(x.flags.map(function (f) { return f.replace(/_/g, " "); }).join(", ")) : "–") + "</td></tr>";
    }).join("");
    document.getElementById("teloTable").innerHTML = '<thead><tr><th scope="col">gene</th><th scope="col">wells</th><th scope="col">siRNAs</th><th scope="col">median z</th><th scope="col">median cells</th><th scope="col">status</th><th scope="col">flags</th></tr></thead><tbody>' + rows + "</tbody>";
    document.getElementById("howBody").innerHTML =
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
    var list = document.getElementById("geneList");
    // datalist of ~17.5k options is heavy; fill it lazily with prefix matches
    var input = document.getElementById("geneInput");
    input.addEventListener("input", function () {
      var q = input.value.trim().toUpperCase();
      list.innerHTML = "";
      if (q.length < 2) return;
      var n = 0;
      for (var i = 0; i < GENES.rows.length && n < 30; i++) {
        if (GENES.rows[i][0].toUpperCase().indexOf(q) === 0) { var o = document.createElement("option"); o.value = GENES.rows[i][0]; list.appendChild(o); n++; }
      }
    });
    input.addEventListener("keydown", function (e) { if (e.key === "Enter") showGene(input.value.trim()); });
    document.getElementById("geneGo").addEventListener("click", function () { showGene(input.value.trim()); });
    var q = new URLSearchParams(location.search).get("gene");
    if (q) { input.value = q; showGene(q); }
  }

  Promise.all([fetch("data/summary.json").then(function (r) { return r.json(); }),
               fetch("data/genes.json").then(function (r) { return r.json(); })])
    .then(function (res) {
      S = res[0]; GENES = res[1];
      GENES.columns.forEach(function (c, i) { C[c] = i; });
      GENES.rows.forEach(function (r) { BYNAME[r[0].toUpperCase()] = r; });
      render();
      setupSearch();
    })
    .catch(function (e) {
      document.getElementById("tiles").innerHTML = '<p class="note">Could not load the dataset (' + esc(e.message) + ").</p>";
    });

  // redraw charts with the right colours when the theme changes
  new MutationObserver(function () { if (S) { var g = document.getElementById("geneInput").value.trim(); render2(g); } })
    .observe(root, { attributes: true, attributeFilter: ["data-theme"] });
  function render2(g) {
    charts();
    if (S.experiment_l) scatter(document.getElementById("scatter"), S.experiment_l);
    var hit = g && BYNAME[g.toUpperCase()];
    histogram(document.getElementById("hist"), hit ? { name: hit[C.gene], v: hit[C.med_norm] } : null);
  }
})();
