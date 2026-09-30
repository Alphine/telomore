// Foci Lab -- IDR plate mode (page controller). Logic lives in screen-core.js; this file wires it to the DOM,
// the cache proxy (api/plate.php, api/plates.php, api/well.php) and window.FociEngine.
// Safety: every string that comes from data goes through textContent / setAttribute, never innerHTML.
(function () {
  "use strict";
  var C = window.FociScreenCore;
  var NS = "http://www.w3.org/2000/svg";
  var SESSION_CAP = 1600;                     // image requests per browser tab (two plates' worth); hard stop
  var MAX_IMAGE_BYTES = 8 * 1024 * 1024, MAX_IMAGE_PIXELS = 4096 * 4096;
  var CELL = 30, MARGIN_L = 26, MARGIN_T = 18;

  function $(id) { return document.getElementById(id); }
  function el(tag, attrs, text) {
    var e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) { e.setAttribute(k, attrs[k]); });
    if (text != null) e.textContent = text;
    return e;
  }
  function sv(tag, attrs, text) {
    var e = document.createElementNS(NS, tag);
    if (attrs) Object.keys(attrs).forEach(function (k) { e.setAttribute(k, attrs[k]); });
    if (text != null) e.textContent = text;
    return e;
  }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); }
  function fmt(v, d) { return typeof v === "number" && isFinite(v) ? v.toFixed(d == null ? 2 : d) : "–"; }
  function setMsg(node, text, kind) { node.hidden = !text; node.textContent = text || ""; node.className = "sc-msg" + (kind ? " " + kind : ""); }

  // -------------------------------------------------------------------------------------------- state
  var S = {
    plates: [], info: null, plate: "", results: Object.create(null), table: [], authors: null, controls: null, csvText: null,
    engine: null, caps: null, pool: null, sched: null, running: false, params: null, mode: "auto",
    startedUtc: null, startedAt: 0, waitUntil: 0, stats: { hit: 0, miss: 0, fetched: 0, throttled: 0 }, engineVersion: null, backends: Object.create(null),
    pair: "name", metric: "fpc", scatter: "foci", sort: { key: "well", dir: 1 }, sel: null, heatBuilt: false, pickToken: 0, renderTimer: 0, gpuLost: false,
  };
  var budget = C.createBudget(SESSION_CAP, {
    get: function () { var v = parseInt(sessionStorage.getItem("foci-screen-requests"), 10); return isFinite(v) ? v : 0; },
    set: function (n) { sessionStorage.setItem("foci-screen-requests", String(n)); },
  });

  // ------------------------------------------------------------------------------------------------ theme
  (function theme() {
    var docEl = document.documentElement;
    try { var saved = localStorage.getItem("foci-theme"); if (saved) docEl.dataset.theme = saved; } catch (e) { /* blocked storage is fine */ }
    $("themeBtn").addEventListener("click", function () {
      var dark = docEl.dataset.theme ? docEl.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
      docEl.dataset.theme = dark ? "light" : "dark";
      try { localStorage.setItem("foci-theme", docEl.dataset.theme); } catch (e) { /* ignore */ }
    });
  })();

  // ---------------------------------------------------------------------------------------- network layer
  function httpError(res) {
    var e = new Error("HTTP " + res.status);
    e.status = res.status;
    e.retryAfter = C.parseRetryAfter(res.headers.get("Retry-After"));
    return e;
  }
  async function getJson(url, signal) {
    var res = await fetch(url, { credentials: "omit", signal: signal });
    if (!res.ok) throw httpError(res);
    return res.json();
  }
  var scratch = null;
  function scratchCtx(w, h) {
    if (!scratch) scratch = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(w, h) : document.createElement("canvas");
    scratch.width = w; scratch.height = h;
    return scratch.getContext("2d", { willReadFrequently: true });
  }
  /** One 8-bit channel of one well as an engine Channel. The proxy sends an RGB PNG with R = G = B: read R. */
  async function fetchChannel(plateWell, ch, signal) {
    if (!budget.spend(1)) { var cap = new Error("per-tab request cap reached (" + SESSION_CAP + ")"); cap.fatal = true; cap.capReached = true; throw cap; }
    var res = await fetch("api/well.php?w=" + encodeURIComponent(plateWell) + "&ch=" + ch, { credentials: "omit", signal: signal });
    if (!res.ok) throw httpError(res);
    var cache = res.headers.get("X-Foci-Cache");
    if (cache === "HIT") S.stats.hit++; else if (cache === "MISS") S.stats.miss++; else S.stats.fetched++;
    var ct = res.headers.get("Content-Type") || "";
    if (!/^image\/png/i.test(ct)) { var bad = new Error("unexpected content type"); bad.fatal = true; throw bad; }
    var blob = await res.blob();
    if (blob.size > MAX_IMAGE_BYTES || blob.size < 100) { var big = new Error("unexpected image size"); big.fatal = true; throw big; }
    var bmp;
    try { bmp = await createImageBitmap(blob, { colorSpaceConversion: "none", premultiplyAlpha: "none" }); }
    catch (e) {
      if (e && e.name === "AbortError") throw e;
      try { bmp = await createImageBitmap(blob); } catch (e2) { e2.fatal = true; throw e2; }
    }
    try {
      var w = bmp.width, h = bmp.height;
      if (!(w > 0 && h > 0) || w * h > MAX_IMAGE_PIXELS) { var sz = new Error("image too large"); sz.fatal = true; throw sz; }
      var ctx = scratchCtx(w, h);
      ctx.drawImage(bmp, 0, 0);
      var px = ctx.getImageData(0, 0, w, h).data, out = new Uint8Array(w * h);
      for (var i = 0, j = 0; i < out.length; i++, j += 4) out[i] = px[j];
      return { data: out, width: w, height: h, bitDepth: 8 };
    } finally { if (bmp.close) bmp.close(); }
  }

  // ----------------------------------------------------------------------------------------------- engine
  function engineAvailable() {
    var E = window.FociEngine;
    return !!(E && typeof E.analyze === "function" && typeof E.createPool === "function" && typeof E.defaultParams === "function");
  }
  async function initEngine() {
    var badge = $("engineBadge");
    if (!engineAvailable()) {
      badge.textContent = "not available";
      setMsg($("engineMsg"), "The analysis engine (engine/engine.js) is not part of this build of the site, so a plate cannot be analysed here yet. You can still browse the plate list and see what a run would cost.", "err");
      return;
    }
    S.engine = window.FociEngine;
    try { S.caps = await Promise.resolve(S.engine.capabilities && S.engine.capabilities()); } catch (e) { S.caps = null; }
    var gpu = S.caps && (S.caps.webgpu === true || S.caps.gpu === true || (S.caps.webgpu && S.caps.webgpu.available === true));
    badge.textContent = S.caps ? (gpu ? "GPU available" : "CPU only") : "ready";
    try {
      var d = await Promise.resolve(S.engine.defaultParams());
      $("paramDefaults").textContent = JSON.stringify(d, null, 1).slice(0, 4000);
      S.defaults = d;
    } catch (e) { S.defaults = {}; }
    refreshGo();
  }
  function parseOverrides() {
    var txt = $("paramJson").value.trim(), msg = $("paramMsg");
    msg.textContent = "";
    if (!txt) return Object.assign({}, S.defaults || {});
    var o;
    try { o = JSON.parse(txt); } catch (e) { msg.textContent = "Not valid JSON: " + e.message; return null; }
    if (!o || typeof o !== "object" || Array.isArray(o)) { msg.textContent = "Overrides must be a JSON object."; return null; }
    var clean = {};
    for (var k of Object.keys(o)) {
      var v = o[k];
      if (!/^[A-Za-z0-9_]{1,40}$/.test(k) || k === "__proto__" || k === "constructor" || k === "prototype") { msg.textContent = "Bad parameter name: " + k.slice(0, 40); return null; }
      if (!(typeof v === "number" && isFinite(v)) && typeof v !== "boolean" && typeof v !== "string" && v !== null) { msg.textContent = "Parameter " + k + " must be a number, boolean, string or null."; return null; }
      clean[k] = v;
    }
    return Object.assign({}, S.defaults || {}, clean);
  }

  // ---------------------------------------------------------------------------------------------- plates
  async function loadPlates() {
    var sel = $("plateSel");
    try {
      var j = await getJson("api/plates.php");
      if (!j || !Array.isArray(j.plates)) throw new Error("shape");
      S.plates = j.plates.filter(function (p) { return p && C.validPlateName(p.plate) && Number.isInteger(p.wells) && p.wells > 0; });
      clear(sel);
      sel.appendChild(el("option", { value: "" }, "Choose a plate (" + S.plates.length + " available)"));
      S.plates.forEach(function (p) { sel.appendChild(el("option", { value: p.plate }, p.plate + "  (" + p.wells + " wells)")); });
      sel.disabled = false;
      $("plateCount").textContent = "";
    } catch (e) {
      clear(sel); sel.appendChild(el("option", { value: "" }, "Plate list unavailable"));
      $("plateCount").textContent = "Could not load the plate list (" + (e.status || e.message) + "). Reload the page to try again.";
    }
  }
  async function pickPlate(name) {
    var token = ++S.pickToken;
    if (S.running) return;
    if (S.plate && name !== S.plate && Object.keys(S.results).length) {
      if (!confirm("Discard the results for plate " + S.plate + "? Export them first if you want to keep them.")) { $("plateSel").value = S.plate; return; }
    }
    resetResults();
    S.plate = ""; S.info = null;
    $("plateInfo").hidden = true; $("consent").checked = false;
    if (!name) { refreshGo(); return; }
    if (!C.validPlateName(name)) return;
    try {
      var info = C.checkPlateInfo(await getJson("api/plate.php?plate=" + encodeURIComponent(name)), name);
      if (token !== S.pickToken) return;
      S.info = info; S.plate = name;
      var e = C.estimate(info);
      $("costImages").textContent = String(e.images);
      $("costWells").textContent = String(info.wells.length);
      $("costTime").textContent = "Time: about " + e.firstTimeMinutes + " min the first time a plate is requested (the server releases about " + info.quota.missPerMin + " new images a minute to one visitor), or roughly " + e.cachedMinutes + " min when the images are already cached. Analysis runs alongside the downloads.";
      $("costLimits").textContent = info.quota.missPerMin + " new images a minute and " + info.quota.missPerDay + " a day, and " + info.quota.hitPerMin + " cached images a minute";
      $("costCap").textContent = String(SESSION_CAP);
      $("plateInfo").hidden = false;
      updateBudgetText();
      buildTableSkeleton();
      S.table = C.buildTable(info, S.results, {}, {});
      $("results").hidden = false;
      renderAll(true);
    } catch (err) {
      setMsg($("progressText"), "Could not load plate " + name + ": " + (err.status === 404 ? "no images for this plate in IDR" : err.message), "err");
      $("progressBox").hidden = false;
    }
    refreshGo();
  }
  function updateBudgetText() { $("costUsed").textContent = budget.used() + " of " + SESSION_CAP; }

  function resetResults() {
    S.results = Object.create(null); S.table = []; S.sel = null; S.heatBuilt = false; S.stats = { hit: 0, miss: 0, fetched: 0, throttled: 0 };
    S.engineVersion = null; S.backends = Object.create(null); S.startedUtc = null; S.gpuLost = false; S.authors = null; S.controls = null;
    clear($("heat")); clear($("legend")); clear($("compare")); clear($("tbl"));
    $("results").hidden = true; $("progressBox").hidden = true;
    ["pauseBtn", "resumeBtn", "cancelBtn", "retryBtn"].forEach(function (id) { $(id).hidden = true; });
    $("detail").textContent = "Hover or focus a well to see its numbers.";
    $("csvBtn").disabled = true; $("provBtn").disabled = true;
    if (S.pool) { try { S.pool.terminate(); } catch (e) { /* ignore */ } S.pool = null; }
    S.sched = null;
  }

  function refreshGo() {
    var ok = !!(S.engine && S.info && !S.running && $("consent").checked);
    $("goBtn").disabled = !ok;
    $("plateSel").disabled = S.running || !S.plates.length;
    $("modeSel").disabled = S.running;
  }

  // ------------------------------------------------------------------------------------------ authors' data
  async function ensureAuthors() {
    if (S.authors) return;
    var note = $("progressText");
    if (!S.csvText) {
      setMsg(note, "Loading the authors' per-well table (about 5.7 MB, compressed in transit)…");
      var res = await fetch("data/downloads/foci_wells.csv", { credentials: "omit" });
      if (!res.ok) throw httpError(res);
      S.csvText = await res.text();
    }
    S.authors = C.indexAuthors(C.parseCsv(S.csvText), S.plate);
    try {
      var cj = await getJson("data/screen_controls.json");
      S.controls = cj && cj.plates && Object.prototype.hasOwnProperty.call(cj.plates, S.plate) ? cj.plates[S.plate] : {};
    } catch (e) { S.controls = {}; setMsg(note, "Control-well list unavailable; controls will not be marked.", "err"); }
  }

  // ------------------------------------------------------------------------------------------------- run
  function makeTasks() {
    return S.info.wells.filter(function (w) { var r = S.results[w.well]; return !(r && !r.error); }).map(function (w) {
      return { id: w.well, run: function (ctx) { return runWell(w, ctx); } };
    });
  }
  function abortErr() { var a = new Error("aborted"); a.name = "AbortError"; return a; }
  async function runWell(w, ctx) {
    var dna = await fetchChannel(w.plate_well, "dna", ctx.signal);
    var foci = await fetchChannel(w.plate_well, "foci", ctx.signal);
    if (ctx.signal.aborted) throw abortErr();
    if (dna.width !== foci.width || dna.height !== foci.height) { var m = new Error("channel sizes differ"); m.fatal = true; throw m; }
    var res;
    try {
      res = await S.pool.analyze({ dna: dna, foci: foci, params: S.params }, { mode: S.mode, overlay: false, signal: ctx.signal });
    } catch (e) {
      if (e && (e.name === "AbortError" || e.code === "aborted")) throw abortErr();
      if (e && e.code === "gpu_lost") { S.gpuLost = true; S.sched.pause(); throw abortErr(); }
      if (e && typeof e === "object") e.fatal = true;   // a deterministic engine failure on this well: do not retry
      throw e;
    }
    if (res && res.version && !S.engineVersion) S.engineVersion = String(res.version).slice(0, 60);
    if (res && typeof res.backend === "string") S.backends[res.backend.slice(0, 20)] = true;
    S.results[w.well] = C.summariseResult(res);
    scheduleRender();
  }

  async function startRun() {
    if (!S.engine || !S.info || S.running) return;
    var remaining = makeTasks().length;
    if (!remaining) { setMsg($("progressText"), "Every well of this plate is already analysed."); return; }
    if (!budget.canStart(remaining * 2)) {
      setMsg($("progressText"), "This tab has used " + budget.used() + " of its " + SESSION_CAP + " image requests; " + remaining * 2 + " more are needed. Reload the page to start a new session.", "err");
      $("progressBox").hidden = false; return;
    }
    var params = parseOverrides();
    if (!params) { $("progressBox").hidden = false; setMsg($("progressText"), "Fix the engine parameters first.", "err"); return; }
    S.params = params; S.mode = $("modeSel").value;
    $("progressBox").hidden = false;
    try { await ensureAuthors(); } catch (e) { setMsg($("progressText"), "Could not load the authors' table: " + (e.message || e), "err"); return; }
    try {
      S.pool = S.engine.createPool(Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 2) - 1)));
    } catch (e) { setMsg($("progressText"), "Could not start the engine: " + (e.message || e), "err"); return; }
    S.gpuLost = false; S.capHit = false; S.startedUtc = S.startedUtc || new Date().toISOString(); S.startedAt = Date.now();
    var c0 = counts(); S.resumedFrom = c0.ok + c0.failed;
    S.sched = C.createScheduler({ concurrency: 3, tasks: makeTasks(), minGapMs: 60, onEvent: onSchedEvent });
    S.running = true; setRunButtons("running"); refreshGo(); renderAll(true);
    var r = await S.sched.start();
    S.running = false;
    S.waitUntil = 0;
    S.lastStatus = r.status;
    if (S.pool && r.status !== "paused") { try { S.pool.terminate(); } catch (e) { /* ignore */ } S.pool = null; }
    setRunButtons(r.status, r);
    refreshGo(); renderAll(true); updateBudgetText();
    progressText(r.status, r);
  }
  function onSchedEvent(ev) {
    if (ev.type === "failed" && ev.error && ev.error.capReached && S.sched) { S.capHit = true; S.sched.pause(); }
    if (ev.type === "failed") { S.results[ev.id] = { error: (ev.error && (ev.error.code || ev.error.message) || "error").toString().slice(0, 120) }; scheduleRender(); }
    else if (ev.type === "throttled") { S.stats.throttled++; S.waitUntil = Date.now() + ev.waitMs; }
    else if (ev.type === "done") scheduleRender();
  }
  function setRunButtons(state, r) {
    var failed = r ? r.failed : 0, running = state === "running", resumable = state === "paused" || state === "busy" || state === "stopped" || state === "cancelled";
    $("pauseBtn").hidden = !running;
    $("cancelBtn").hidden = !running;
    $("resumeBtn").hidden = !resumable;
    $("retryBtn").hidden = !(failed > 0 && !running && !resumable);
    $("goBtn").hidden = running || resumable;
  }
  function counts() {
    var ok = 0, failed = 0;
    Object.keys(S.results).forEach(function (k) { if (S.results[k].error) failed++; else ok++; });
    return { ok: ok, failed: failed, total: S.info ? S.info.wells.length : 0 };
  }
  function progressText(status, r) {
    var c = counts(), bar = $("bar"), t = $("progressText");
    bar.max = Math.max(1, c.total); bar.value = c.ok + c.failed;
    var parts = ["Analysed " + c.ok + " of " + c.total + " wells"];
    if (c.failed) parts.push(c.failed + " failed");
    parts.push("images: " + S.stats.hit + " from cache, " + S.stats.miss + " newly fetched from IDR");
    var bk = Object.keys(S.backends);
    if (bk.length) parts.push("backend: " + bk.join(" + "));
    var line = parts.join(" · ");
    var kind = "";
    if (S.running) {
      var wait = S.waitUntil - Date.now();
      if (wait > 500) line += " — the server asked us to slow down; waiting " + Math.ceil(wait / 1000) + " s";
      else if (c.ok > 3) { var per = (Date.now() - S.startedAt) / Math.max(1, c.ok + c.failed - (S.resumedFrom || 0)); line += " — about " + Math.max(1, Math.round(per * (c.total - c.ok - c.failed) / 60000)) + " min left"; }
    } else if (status === "done") { line += c.failed ? " — finished with failures; you can retry them." : " — finished."; kind = c.failed ? "err" : "ok"; }
    else if (status === "paused" && S.capHit) { line += " — paused: this tab's cap of " + SESSION_CAP + " image requests is used up. Reload the page to start a new session."; kind = "err"; }
    else if (status === "paused") line += S.gpuLost ? " — paused: the GPU was lost. Choose 'CPU reference' and press Resume." : " — paused.";
    else if (status === "cancelled") line += " — cancelled; results so far are kept and you can resume.";
    else if (status === "busy") { line += " — stopped: the server kept asking us to slow down. Try again later; nothing is lost."; kind = "err"; }
    setMsg(t, line, kind);
  }
  setInterval(function () { if (S.running) progressText("running"); }, 1000);

  // ---------------------------------------------------------------------------------------------- rendering
  function scheduleRender() {
    if (S.renderTimer) return;
    S.renderTimer = setTimeout(function () { S.renderTimer = 0; renderAll(false); }, 300);
  }
  function refreshTable() { S.table = C.buildTable(S.info, S.results, S.authors || {}, S.controls || {}); }
  function renderAll(full) {
    if (!S.info) return;
    refreshTable();
    progressText(S.running ? "running" : S.lastStatus || "idle");
    renderHeat();
    renderCompare();
    renderTable(full);
    var c = counts();
    $("csvBtn").disabled = !c.ok; $("provBtn").disabled = !c.ok;
    $("tblNote").textContent = c.ok + " of " + c.total + " wells analysed. Click a column heading to sort.";
  }

  // ---- heatmap
  function ensureHeat() {
    if (S.heatBuilt) return;
    var host = $("heat"), info = S.info, W = MARGIN_L + info.cols * CELL, H = MARGIN_T + info.rows * CELL;
    clear(host);
    var svg = sv("svg", { viewBox: "0 0 " + W + " " + H, role: "group", "aria-label": "Plate heatmap, " + info.rows + " rows by " + info.cols + " columns" });
    for (var c = 0; c < info.cols; c++) svg.appendChild(sv("text", { x: MARGIN_L + c * CELL + CELL / 2, y: 12, "text-anchor": "middle" }, String(c + 1)));
    for (var r = 0; r < info.rows; r++) svg.appendChild(sv("text", { x: 10, y: MARGIN_T + r * CELL + CELL / 2 + 3, "text-anchor": "middle" }, String.fromCharCode(65 + r)));
    S.cellEls = Object.create(null);
    for (var rr = 0; rr < info.rows; rr++) for (var cc = 0; cc < info.cols; cc++) {
      var well = C.rcToWell(rr, cc), x = MARGIN_L + cc * CELL, y = MARGIN_T + rr * CELL;
      var g = sv("g"), rect = sv("rect", { x: x + 1, y: y + 1, width: CELL - 2, height: CELL - 2, rx: 3, "class": "cell none", tabindex: rr === 0 && cc === 0 ? "0" : "-1", role: "button", "data-well": well, "data-r": rr, "data-c": cc });
      var hatch = sv("g", { "class": "hatch-g", display: "none" });
      [8, 16, 24].forEach(function (o) { hatch.appendChild(sv("line", { "class": "hatch", x1: x + 2, y1: y + 2 + o, x2: x + 2 + o, y2: y + 2 })); });
      var ring = sv("g", { display: "none" });
      ring.appendChild(sv("circle", { "class": "ringdark", cx: x + CELL / 2, cy: y + CELL / 2, r: 9 }));
      ring.appendChild(sv("circle", { "class": "ring", cx: x + CELL / 2, cy: y + CELL / 2, r: 9 }));
      var mark = sv("text", { "class": "mark", x: x + CELL / 2, y: y + CELL / 2 + 3 }, "");
      ring.appendChild(mark);
      var xf = sv("g", { display: "none" });
      xf.appendChild(sv("line", { "class": "xfail", x1: x + 6, y1: y + 6, x2: x + CELL - 6, y2: y + CELL - 6 }));
      xf.appendChild(sv("line", { "class": "xfail", x1: x + CELL - 6, y1: y + 6, x2: x + 6, y2: y + CELL - 6 }));
      g.appendChild(rect); g.appendChild(hatch); g.appendChild(ring); g.appendChild(xf);
      svg.appendChild(g);
      S.cellEls[well] = { rect: rect, hatch: hatch, ring: ring, mark: mark, xf: xf };
    }
    host.appendChild(svg);
    svg.addEventListener("mouseover", function (e) { var w = e.target && e.target.getAttribute && e.target.getAttribute("data-well"); if (w) showDetail(w, false); });
    svg.addEventListener("focusin", function (e) { var w = e.target && e.target.getAttribute && e.target.getAttribute("data-well"); if (w) showDetail(w, false); });
    svg.addEventListener("click", function (e) { var w = e.target && e.target.getAttribute && e.target.getAttribute("data-well"); if (w) showDetail(w, true); });
    svg.addEventListener("keydown", function (e) {
      var t = e.target, r0 = +t.getAttribute("data-r"), c0 = +t.getAttribute("data-c");
      var d = { ArrowRight: [0, 1], ArrowLeft: [0, -1], ArrowDown: [1, 0], ArrowUp: [-1, 0], Home: [0, -c0], End: [0, S.info.cols - 1 - c0] }[e.key];
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); showDetail(t.getAttribute("data-well"), true); return; }
      if (!d) return;
      e.preventDefault();
      var nr = Math.max(0, Math.min(S.info.rows - 1, r0 + d[0])), nc = Math.max(0, Math.min(S.info.cols - 1, c0 + d[1])), n = S.cellEls[C.rcToWell(nr, nc)];
      if (n) { t.setAttribute("tabindex", "-1"); n.rect.setAttribute("tabindex", "0"); n.rect.focus(); }
    });
    S.heatBuilt = true;
  }
  function renderHeat() {
    ensureHeat();
    var m = C.heatmapModel(S.table, S.info, S.metric, S.pair), mlabel = m.label;
    m.cells.forEach(function (c) {
      var e = S.cellEls[c.well]; if (!e) return;
      var cls = "cell";
      if (!c.exists) cls += " absent"; else if (c.status === "failed") cls += " failed"; else if (c.color) cls += ""; else cls += " none";
      if (S.sel === c.well) cls += " sel";
      e.rect.setAttribute("class", cls);
      if (c.color) e.rect.setAttribute("fill", c.color); else e.rect.removeAttribute("fill");
      e.hatch.setAttribute("display", c.qcRemoved && c.exists ? "" : "none");
      e.ring.setAttribute("display", c.control ? "" : "none");
      e.mark.textContent = c.control === "p" ? "P" : c.control === "n" ? "N" : "";
      e.xf.setAttribute("display", c.status === "failed" ? "" : "none");
      var desc = "Well " + c.well + ": " + (c.exists ? (isFinite(c.value) ? mlabel + " " + fmt(c.value, 2) : c.status === "failed" ? "analysis failed" : "no value yet") : "no image") +
        (c.qcRemoved ? ", authors removed it (pairing " + (S.pair === "name" ? "A" : "B") + ")" : "") + (c.control ? (c.control === "p" ? ", positive control" : ", negative control") : "");
      e.rect.setAttribute("aria-label", desc);
    });
    renderLegend(m);
  }
  function renderLegend(m) {
    var host = $("legend"); clear(host);
    var svg = sv("svg", { viewBox: "0 0 560 46", role: "img", "aria-label": "Colour scale for " + m.label + " from " + fmt(m.lo) + " to " + fmt(m.hi) });
    var defs = sv("defs"), grad = sv("linearGradient", { id: "scGrad", x1: "0", x2: "1", y1: "0", y2: "0" });
    C.VIRIDIS.forEach(function (c, i) { grad.appendChild(sv("stop", { offset: (i / (C.VIRIDIS.length - 1)).toString(), "stop-color": c })); });
    defs.appendChild(grad); svg.appendChild(defs);
    svg.appendChild(sv("rect", { x: 6, y: 4, width: 300, height: 12, fill: "url(#scGrad)", rx: 2 }));
    svg.appendChild(sv("text", { x: 6, y: 32 }, m.n ? fmt(m.lo) : "–"));
    svg.appendChild(sv("text", { x: 306, y: 32, "text-anchor": "end" }, m.n ? fmt(m.hi) : "–"));
    svg.appendChild(sv("text", { x: 316, y: 14 }, m.label));
    svg.appendChild(sv("text", { x: 316, y: 32 }, "2nd–98th percentile, n = " + m.n));
    host.appendChild(svg);
  }
  function showDetail(well, pin) {
    var box = $("detail");
    if (pin) { S.sel = S.sel === well ? null : well; renderHeat(); fillDetail(box, well, !!S.sel); return; }
    if (S.sel) return;                     // a selected (clicked) well stays until it is clicked again or another is chosen
    fillDetail(box, well, false);
  }
  function fillDetail(box, well, pinned) {
    var t = S.table.filter(function (x) { return x.well === well; })[0];
    if (!t) return;
    clear(box);
    box.appendChild(el("b", null, "Well " + well + " · image " + t.image_id + (pinned ? " (selected)" : "")));
    var dl = el("dl");
    function row(k, v) { dl.appendChild(el("dt", null, k)); dl.appendChild(el("dd", null, v)); }
    row("Status", t.status === "ok" ? "analysed (" + (t.backend || "backend unknown") + ")" : t.status === "failed" ? "failed: " + t.error : "not analysed yet");
    if (t.status === "ok") { row("Nuclei", fmt(t.nuclei, 0)); row("Foci", fmt(t.foci, 0)); row("Foci per cell", fmt(t.fpc, 3)); }
    C.PAIRINGS.forEach(function (p) {
      var a = t.pair[p];
      row("Pairing " + (p === "name" ? "A (by name)" : "B (column-major)"), "annotation " + a.well + " · " + a.kind + (a.qc ? " · QC " + a.qc : "") + " · cells " + (a.cells == null ? "–" : a.cells) + " · foci/cell " + (a.fpc == null ? "–" : fmt(a.fpc, 3)));
    });
    box.appendChild(dl);
    if (t.status === "ok" && S.engine && !S.running) {
      var b = el("button", { type: "button", "class": "btn ghost" }, "Show overlay (re-analyses this well)");
      b.addEventListener("click", function () { showOverlay(t, box, b); });
      box.appendChild(b);
    }
  }
  async function showOverlay(t, box, btn) {
    btn.disabled = true; btn.textContent = "Working…";
    try {
      var w = S.info.wells.filter(function (x) { return x.well === t.well; })[0], ctl = new AbortController();
      var dna = await fetchChannel(w.plate_well, "dna", ctl.signal), foci = await fetchChannel(w.plate_well, "foci", ctl.signal);
      var res = await S.engine.analyze({ dna: dna, foci: foci, params: S.params || S.defaults || {} }, { mode: S.mode, overlay: true });
      var ov = res && res.overlay, cv = el("canvas");
      if (ov && ov.data && ov.width && ov.height) { cv.width = ov.width; cv.height = ov.height; cv.getContext("2d").putImageData(ov.data instanceof Uint8ClampedArray ? new ImageData(ov.data, ov.width, ov.height) : new ImageData(new Uint8ClampedArray(ov.data), ov.width, ov.height), 0, 0); }
      else if (ov && (ov instanceof ImageData)) { cv.width = ov.width; cv.height = ov.height; cv.getContext("2d").putImageData(ov, 0, 0); }
      else if (ov && typeof ov.width === "number") { cv.width = ov.width; cv.height = ov.height; cv.getContext("2d").drawImage(ov, 0, 0); }
      else throw new Error("the engine returned no overlay");
      cv.setAttribute("role", "img"); cv.setAttribute("aria-label", "Overlay for well " + t.well);
      box.appendChild(cv); btn.remove();
    } catch (e) { btn.disabled = false; btn.textContent = "Show overlay (re-analyses this well) — failed: " + String(e.message || e).slice(0, 80); }
  }

  // ---- comparison cards
  function scatterSvg(points, xlab, ylab) {
    var W = 360, H = 250, L = 44, B = 34, T = 8, R = 10, svg = sv("svg", { viewBox: "0 0 " + W + " " + H, role: "img", "aria-label": "Scatter plot of " + ylab + " against " + xlab + ", " + points.x.length + " wells" });
    if (!points.x.length) { svg.appendChild(sv("text", { x: W / 2, y: H / 2, "text-anchor": "middle" }, "no wells to compare yet")); return svg; }
    var xs = points.x, ys = points.y, x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs), y0 = Math.min.apply(null, ys), y1 = Math.max.apply(null, ys);
    if (x1 === x0) { x0 -= 1; x1 += 1; } if (y1 === y0) { y0 -= 1; y1 += 1; }
    var px = function (v) { return L + (v - x0) / (x1 - x0) * (W - L - R); }, py = function (v) { return H - B - (v - y0) / (y1 - y0) * (H - B - T); };
    svg.appendChild(sv("line", { "class": "axis", x1: L, y1: H - B, x2: W - R, y2: H - B }));
    svg.appendChild(sv("line", { "class": "axis", x1: L, y1: T, x2: L, y2: H - B }));
    svg.appendChild(sv("text", { x: L, y: H - B + 14, "text-anchor": "start" }, fmt(x0, 1)));
    svg.appendChild(sv("text", { x: W - R, y: H - B + 14, "text-anchor": "end" }, fmt(x1, 1)));
    svg.appendChild(sv("text", { x: (L + W - R) / 2, y: H - 4, "text-anchor": "middle" }, xlab));
    svg.appendChild(sv("text", { x: L - 4, y: H - B, "text-anchor": "end" }, fmt(y0, 1)));
    svg.appendChild(sv("text", { x: L - 4, y: T + 8, "text-anchor": "end" }, fmt(y1, 1)));
    svg.appendChild(sv("text", { x: 12, y: (T + H - B) / 2, "text-anchor": "middle", transform: "rotate(-90 12 " + (T + H - B) / 2 + ")" }, ylab));
    for (var i = 0; i < xs.length; i++) svg.appendChild(sv("circle", { "class": "dot", cx: px(xs[i]).toFixed(1), cy: py(ys[i]).toFixed(1), r: 2.6 }));
    return svg;
  }
  function rhoLine(label, r) {
    var p = el("p");
    p.appendChild(document.createTextNode(label + ": "));
    p.appendChild(el("span", { "class": "mono" }, r.rho == null ? "ρ not defined" : "ρ = " + r.rho.toFixed(3)));
    p.appendChild(document.createTextNode("  (n = " + r.n + (r.rho == null && r.reason ? "; " + r.reason : "") + ")"));
    return p;
  }
  function renderCompare() {
    var host = $("compare"); clear(host);
    C.PAIRINGS.forEach(function (p) {
      var cmp = C.comparePairing(S.table, p), card = el("div", { "class": "card sc-cmp" });
      card.appendChild(el("h3", null, p === "name" ? "Pairing A: image of well W with annotation row W" : "Pairing B: image at (row r, column c) with Well Number c × " + S.info.rows + " + r + 1"));
      card.appendChild(rhoLine("Our foci per cell vs authors' foci per cell", cmp.foci));
      card.appendChild(rhoLine("Our nucleus count vs authors' cell count", cmp.nuclei));
      var sc = S.scatter === "foci" ? cmp.foci.points : cmp.nuclei.points;
      card.appendChild(scatterSvg(sc, S.scatter === "foci" ? "authors' foci per cell" : "authors' cell count", S.scatter === "foci" ? "our foci per cell" : "our nucleus count"));
      var k = cmp.skipped;
      card.appendChild(el("p", { "class": "note" }, "Not compared: " + k.notAnalysed + " not analysed or failed, " + k.control + " controls, " + k.qcRemoved + " removed by the authors' QC, " + k.noAuthorValue + " with no authors' row."));
      host.appendChild(card);
    });
    host.appendChild(el("p", { "class": "note sc-span" }, "Neither pairing is asserted to be correct (see the notice at the top). Agreement is a rank correlation only; it does not calibrate our counts to the authors' definition of a focus."));
  }

  // ---- table
  var COLS = [
    ["well", "Well", function (t) { return t.c * 100 + t.r; }, function (t) { return t.well; }],
    ["nuclei", "Nuclei", function (t) { return t.nuclei; }, function (t) { return fmt(t.nuclei, 0); }],
    ["foci", "Foci", function (t) { return t.foci; }, function (t) { return fmt(t.foci, 0); }],
    ["fpc", "Foci/cell", function (t) { return t.fpc; }, function (t) { return fmt(t.fpc, 3); }],
  ];
  function pairCols(p, tag) {
    return [
      [tag + "w", "Annot. well", function (t) { return t.pair[p].well.charCodeAt(0) * 100 + (+t.pair[p].well.slice(1)); }, function (t) { return t.pair[p].well; }],
      [tag + "c", "Cells", function (t) { return t.pair[p].cells == null ? NaN : t.pair[p].cells; }, function (t) { return t.pair[p].cells == null ? "–" : String(t.pair[p].cells); }],
      [tag + "f", "Foci/cell", function (t) { return t.pair[p].fpc == null ? NaN : t.pair[p].fpc; }, function (t) { return t.pair[p].fpc == null ? "–" : fmt(t.pair[p].fpc, 3); }],
      [tag + "k", "Flag", null, function (t) { var a = t.pair[p]; return a.kind === "sample" ? (a.qc === "remove" ? "QC removed" : "") : a.kind === "none" ? "no row" : a.kind; }],
    ];
  }
  var ALLCOLS = COLS.concat(pairCols("name", "a"), pairCols("colmajor", "b"));
  function buildTableSkeleton() {
    var tbl = $("tbl"); clear(tbl);
    var thead = el("thead"), g = el("tr", { "class": "grp" });
    g.appendChild(el("th", { colspan: "4" }, "Our result (in your browser)"));
    g.appendChild(el("th", { colspan: "4" }, "Pairing A: by well name"));
    g.appendChild(el("th", { colspan: "4" }, "Pairing B: by Well Number, column-major"));
    thead.appendChild(g);
    var h = el("tr");
    ALLCOLS.forEach(function (c) {
      var th = el("th", { scope: "col", "aria-sort": "none", "data-key": c[0] });
      if (c[2]) { var b = el("button", { type: "button", "class": "sortbtn" }, c[1]); b.addEventListener("click", function () { S.sort = { key: c[0], dir: S.sort.key === c[0] ? -S.sort.dir : 1 }; renderTable(true); }); th.appendChild(b); }
      else th.textContent = c[1];
      h.appendChild(th);
    });
    thead.appendChild(h); tbl.appendChild(thead); tbl.appendChild(el("tbody"));
  }
  function renderTable() {
    var tbl = $("tbl"); if (!tbl.firstChild) buildTableSkeleton();
    var col = ALLCOLS.filter(function (c) { return c[0] === S.sort.key; })[0] || ALLCOLS[0];
    tbl.querySelectorAll("th[data-key]").forEach(function (th) { th.setAttribute("aria-sort", th.getAttribute("data-key") === col[0] ? (S.sort.dir > 0 ? "ascending" : "descending") : "none"); });
    var rows = S.table.slice().sort(function (x, y) {
      var a = col[2] ? col[2](x) : 0, b = col[2] ? col[2](y) : 0, an = !(typeof a === "number" && isFinite(a)), bn = !(typeof b === "number" && isFinite(b));
      if (an || bn) return an === bn ? 0 : an ? 1 : -1;
      return (a - b) * S.sort.dir || (x.c * 100 + x.r) - (y.c * 100 + y.r);
    });
    var body = tbl.tBodies[0], frag = document.createDocumentFragment();
    rows.forEach(function (t) {
      var tr = el("tr", { "class": t.status === "failed" ? "failed" : t.status === "pending" ? "pending" : "" });
      ALLCOLS.forEach(function (c, i) {
        var txt = c[3](t);
        if (i === 0) { tr.appendChild(el("th", { scope: "row" }, txt)); return; }
        tr.appendChild(el("td", { "class": c[2] ? "num" : "txt" }, c[0] === "nuclei" && t.status === "failed" ? "failed" : txt));
      });
      frag.appendChild(tr);
    });
    clear(body); body.appendChild(frag);
  }

  // ------------------------------------------------------------------------------------------------ export
  function download(name, mime, text) {
    var url = URL.createObjectURL(new Blob([text], { type: mime }));
    var a = el("a", { href: url, download: name });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }
  function currentProvenance() {
    var c = counts();
    return C.buildProvenance({
      generatedUtc: new Date().toISOString(), startedUtc: S.startedUtc, plate: S.plate, rows: S.info.rows, cols: S.info.cols, nWells: c.total,
      analysed: c.ok, failed: c.failed, pending: c.total - c.ok - c.failed, engineVersion: S.engineVersion, backends: Object.keys(S.backends), mode: S.mode,
      capabilities: S.caps && JSON.stringify(S.caps).length < 4000 ? S.caps : null, params: S.params || S.defaults || null,
      comparisons: C.PAIRINGS.map(function (p) { return C.comparePairing(S.table, p); }),
    });
  }

  // ------------------------------------------------------------------------------------------------ wiring
  $("plateSel").addEventListener("change", function () { pickPlate($("plateSel").value); });
  $("consent").addEventListener("change", refreshGo);
  $("goBtn").addEventListener("click", startRun);
  $("resumeBtn").addEventListener("click", startRun);
  $("pauseBtn").addEventListener("click", function () { if (S.sched) S.sched.pause(); $("pauseBtn").disabled = true; setTimeout(function () { $("pauseBtn").disabled = false; }, 600); });
  $("cancelBtn").addEventListener("click", function () { if (S.sched) S.sched.cancel(); });
  $("retryBtn").addEventListener("click", function () {
    Object.keys(S.results).forEach(function (k) { if (S.results[k].error) delete S.results[k]; });
    startRun();
  });
  $("metricSel").addEventListener("change", function () { S.metric = $("metricSel").value; if (S.info) renderHeat(); });
  document.querySelectorAll('input[name="pairSel"]').forEach(function (r) { r.addEventListener("change", function () { if (r.checked) { S.pair = r.value; if (S.info) { renderHeat(); if (S.sel) fillDetail($("detail"), S.sel, true); } } }); });
  document.querySelectorAll('input[name="scSel"]').forEach(function (r) { r.addEventListener("change", function () { if (r.checked) { S.scatter = r.value; if (S.info) renderCompare(); } }); });
  $("csvBtn").addEventListener("click", function () { if (S.info) download("foci_plate_" + S.plate + "_wells.csv", "text/csv;charset=utf-8", "﻿" + C.exportCsv(S.plate, S.table)); });
  $("provBtn").addEventListener("click", function () { if (S.info) download("foci_plate_" + S.plate + "_provenance.json", "application/json", JSON.stringify(currentProvenance(), null, 2) + "\n"); });
  $("paramJson").addEventListener("input", function () { parseOverrides(); });
  window.addEventListener("beforeunload", function (e) { if (S.running) { e.preventDefault(); e.returnValue = ""; } });
  window.addEventListener("pagehide", function () {
    if (S.sched) S.sched.cancel();
    if (S.pool) { try { S.pool.terminate(); } catch (e) { /* ignore */ } S.pool = null; }
  });

  // Debug/test hook: read-only view of the state (no setters).
  window.FociScreen = { state: function () { return { plate: S.plate, running: S.running, results: Object.keys(S.results).length, requests: budget.used() }; } };

  updateBudgetText();
  initEngine();
  loadPlates();
})();
