// Foci Lab -- static client. Data: data/summary.json + data/genes.json (built by
// scripts/build_foci_dataset.py). Well images come through api/well.php (a
// caching proxy to IDR on this host); the live nucleus outline comes from the
// Telomere Lab backend on Railway.
(function () {
  "use strict";
  var RAILWAY = "https://telomore-production.up.railway.app/api/foci";
  var NS = "http://www.w3.org/2000/svg";
  var S = null, GENES = null, BYNAME = {};

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
  function klass(v) { var b = S.controls["negative control"]; return v < b.p10 ? "down" : v > b.p90 ? "up" : "mid"; }

  // ------------------------------------------- diverging log2 bar chart
  function barChart(host, rows, onPick) {
    host.innerHTML = "";
    var rowH = 26, top = 8, left = 110, right = 56, W = 560, H = top + rows.length * rowH + 22;
    var svg = el("svg", { viewBox: "0 0 " + W + " " + H, role: "img" }, host);
    var lo = -3.2, hi = 3.2, x = function (v) { return left + (Math.log2(Math.max(v, 0.05)) - lo) / (hi - lo) * (W - left - right); };
    var b = S.controls["negative control"];
    el("rect", { x: x(b.p10), y: top - 4, width: x(b.p90) - x(b.p10), height: rows.length * rowH + 4, fill: css("--band") }, svg);
    el("line", { x1: x(1), x2: x(1), y1: top - 4, y2: top + rows.length * rowH, stroke: css("--faint"), "stroke-width": 1 }, svg);
    [0.125, 0.25, 0.5, 1, 2, 4, 8].forEach(function (t) {
      txt("text", { x: x(t), y: H - 4, "text-anchor": "middle", "class": "val" }, t < 1 ? "1/" + (1 / t) : t + "x", svg);
    });
    rows.forEach(function (r, i) {
      var y = top + i * rowH, v = r[2];
      var g = el("g", { "class": "gene", tabindex: 0, role: "button", "aria-label": r[0] + " " + fmt(v) }, svg);
      txt("text", { x: left - 8, y: y + 16, "text-anchor": "end" }, r[0], g);
      var x0 = x(1), x1 = x(v), c = v < 1 ? css("--down") : css("--up");
      el("rect", { x: Math.min(x0, x1), y: y + 5, width: Math.max(2, Math.abs(x1 - x0)), height: rowH - 10, rx: 3, fill: c }, g);
      txt("text", { x: W - right + 8, y: y + 16, "class": "val" }, fmt(v), g);
      if (onPick) {
        g.addEventListener("click", function () { onPick(r[0]); });
        g.addEventListener("keydown", function (e) { if (e.key === "Enter") onPick(r[0]); });
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
    var v = g[2], k = klass(v), total = GENES.rows.length;
    var label = { down: "Fewer foci than controls", up: "More foci than controls", mid: "Within the control range" }[k];
    var wells = g[7].map(function (w) {
      return '<button type="button" data-w="' + esc(w[0]) + '" data-v="' + (w[1] == null ? "" : w[1]) + '"' + (w[2] ? "" : " disabled title=\"Plate not hosted in IDR\"") + ">" + esc(w[0]) + " · " + fmt(w[1]) + "</button>";
    }).join("");
    card.innerHTML =
      '<div class="gene-head"><h3>' + esc(g[0]) + '</h3><span class="pill ' + k + '">' + label + "</span>" +
      (g[5] ? '<a class="mono" href="https://www.ensembl.org/id/' + esc(g[5]) + '" rel="noopener">' + esc(g[5]) + "</a>" : "") + "</div>" +
      '<div class="stats"><div>foci / cell vs plate<b>' + fmt(v) + "×</b></div><div>raw foci / cell<b>" + fmt(g[3]) + "</b></div>" +
      "<div>rank (fewest first)<b>" + g[6].toLocaleString() + " / " + total.toLocaleString() + "</b></div><div>wells · median cells<b>" + g[1] + " · " + fmt(g[4], 0) + "</b></div></div>" +
      '<p class="note">Open a well to see its original image:</p><div class="wells">' + wells + "</div>" +
      (g[7].some(function (w) { return !w[2]; }) ? '<p class="note">Greyed wells sit on plate 153-29, which IDR does not host, so no image is available.</p>' : "");
    card.querySelectorAll(".wells button").forEach(function (b) {
      b.addEventListener("click", function () { openWell(b.dataset.w, g[0], b.dataset.v); });
    });
    histogram(document.getElementById("hist"), { name: g[0], v: v });
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

    barChart(document.getElementById("lowChart"), S.lowest.slice(0, 12), pickGene);
    barChart(document.getElementById("highChart"), S.highest.slice(0, 12), pickGene);
    barChart(document.getElementById("teloChart"), S.telomere_panel, pickGene);
    histogram(document.getElementById("hist"), null);

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
      scatter(document.getElementById("scatter"), L);
      document.getElementById("verdict").innerHTML =
        "<h3>Result: no agreement</h3><p>On " + L.n_wells + " wells spanning the full range, our per-well foci per cell does not track the published values.</p>" +
        "<dl><dt>Spearman ρ</dt><dd>" + fmt(L.spearman, 3) + "</dd><dt>Pearson r</dt><dd>" + fmt(L.pearson, 3) + "</dd>" +
        "<dt>nuclei count r</dt><dd>" + fmt(L.cells_pearson, 3) + "</dd>" +
        "<dt>RNF168/MDC1/RNF8 wells: ours vs authors</dt><dd>" + fmt(L.median_ours_repair_kd) + " vs " + fmt(L.median_authors_repair_kd) + "</dd>" +
        "<dt>proteasome wells: ours vs authors</dt><dd>" + fmt(L.median_ours_proteasome_kd) + " vs " + fmt(L.median_authors_proteasome_kd) + "</dd></dl>" +
        "<p><b>Why, as far as we can tell:</b> IDR keeps one 696×520 field per well (about 90 cells) as an 8-bit render, while the authors counted up to about 300 cells per well, likely over several fields at full bit depth. On one 8-bit field, normal nuclear texture passes as foci. Three detector designs and a parameter grid did not close the gap.</p>" +
        "<p><b>So:</b> every biological claim on this site uses the authors' own numbers. Our counter is shown only as an illustration.</p>";
    }
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
    barChart(document.getElementById("lowChart"), S.lowest.slice(0, 12), pickGene);
    barChart(document.getElementById("highChart"), S.highest.slice(0, 12), pickGene);
    barChart(document.getElementById("teloChart"), S.telomere_panel, pickGene);
    if (S.experiment_l) scatter(document.getElementById("scatter"), S.experiment_l);
    var hit = g && BYNAME[g.toUpperCase()];
    histogram(document.getElementById("hist"), hit ? { name: hit[0], v: hit[2] } : null);
  }
})();
