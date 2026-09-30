// Foci Lab -- Browser lab page logic (lab.html).
// Everything happens in this tab: files are read with FociIO, analysed by window.FociEngine, exported as local downloads.
// This file (and io/*.js) makes no network calls; tests/io-nonetwork.test.mjs enforces that, and lab.html's
// Content-Security-Policy (connect-src 'none') enforces it in the browser.
(function () {
  "use strict";

  var Core = window.FociLabCore, IO = window.FociIO;
  var Eng = window.FociEngine || null;
  var MAX_FILES = 500, MAX_FILE_BYTES = 200 * 1024 * 1024, DEFAULT_PX = 16e6, NUC_ROWS = 200, MAX_POINTS = 5000, MAX_IDS = 1500;
  var EXT_RE = /\.(png|tif|tiff|jpg|jpeg|zip)$/i;

  var S = {
    files: [], sets: [], nextFile: 1, nextSet: 1, defaults: null, caps: null, engineVersion: null,
    pool: null, poolSize: 0, running: false, ac: null, selected: null, overlayUrl: null, zoom: "fit", lastRun: null, maxPx: DEFAULT_PX, scanning: false, zipCache: null
  };

  // ------------------------------------------------------------------ tiny helpers
  function $(id) { return document.getElementById(id); }
  function h(tag, a, kids) {
    var e = document.createElement(tag);
    if (a) Object.keys(a).forEach(function (k) {
      var v = a[k];
      if (v == null || v === false || k === "style") return;
      if (k === "class") e.className = v;
      else if (k === "text") e.textContent = v;
      else if (k.slice(0, 2) === "on") e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? "" : v);
    });
    (kids || []).forEach(function (c) { if (c != null) e.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    return e;
  }
  var SVGNS = "http://www.w3.org/2000/svg";   // a namespace identifier, never fetched
  function sv(tag, a) {
    var e = document.createElementNS(SVGNS, tag);
    if (a) Object.keys(a).forEach(function (k) { e.setAttribute(k, a[k]); });
    return e;
  }
  function clear(e) { while (e.firstChild) e.removeChild(e.firstChild); }
  function fmtBytes(n) { return !isFinite(n) ? "?" : n < 1024 ? n + " B" : n < 1048576 ? (n / 1024).toFixed(0) + " KB" : (n / 1048576).toFixed(1) + " MB"; }
  function fmtNum(n, d) { return n == null || !isFinite(n) ? "–" : Number(n).toFixed(d == null ? 2 : d); }
  function short(s, n) { s = String(s); return s.length > n ? s.slice(0, Math.floor(n / 2) - 1) + "…" + s.slice(-Math.floor(n / 2)) : s; }
  function errMsg(e) { return String((e && e.message) || e || "Unknown error").slice(0, 400); }
  function say(msg, cls) { var s = $("status"); s.textContent = msg || ""; s.className = "status" + (cls ? " " + cls : ""); }
  function stamp() { var d = new Date(), p = function (n) { return (n < 10 ? "0" : "") + n; }; return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "-" + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()); }
  function totalMs(t) { if (t == null) return null; if (typeof t === "number") return t; if (typeof t === "object") { if (typeof t.total === "number") return t.total; var s = 0; Object.keys(t).forEach(function (k) { if (typeof t[k] === "number") s += t[k]; }); return s; } return null; }
  function fileById(id) { for (var i = 0; i < S.files.length; i++) if (S.files[i].id === id) return S.files[i]; return null; }
  function setById(id) { for (var i = 0; i < S.sets.length; i++) if (S.sets[i].id === id) return S.sets[i]; return null; }
  function download(name, data, mime) {
    var blob = data instanceof Blob ? data : new Blob([data], { type: mime });
    var url = URL.createObjectURL(blob), a = h("a", { href: url, download: name });
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  // ------------------------------------------------------------------ theme (same pattern as the other pages)
  var docEl = document.documentElement;
  try { var saved = localStorage.getItem("foci-theme"); if (saved) docEl.dataset.theme = saved; } catch (e) { /* storage blocked */ }
  $("themeBtn").addEventListener("click", function () {
    var dark = docEl.dataset.theme ? docEl.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
    docEl.dataset.theme = dark ? "light" : "dark";
    try { localStorage.setItem("foci-theme", docEl.dataset.theme); } catch (e) { /* storage blocked */ }
  });

  // ------------------------------------------------------------------ engine, badge, parameters
  function showBadge(text, kind, title) { var b = $("badge"); b.textContent = text; b.className = "backend " + kind; if (title) b.setAttribute("title", title); else b.removeAttribute("title"); }

  async function initEngine() {
    if (!Eng || typeof Eng.analyze !== "function") {
      $("engineMissing").hidden = false;
      showBadge("Analysis engine not loaded", "none");
      $("paramGrid").textContent = "";
      $("paramMsg").textContent = "Parameters appear once the engine has loaded.";
      return;
    }
    try { S.defaults = Eng.defaultParams(); } catch (e) { S.defaults = null; }
    if (!S.defaults) { $("engineMissing").hidden = false; showBadge("Analysis engine failed to start", "none"); return; }
    S.engineVersion = Eng.version || null;
    try { S.caps = await Eng.capabilities(); } catch (e) { S.caps = null; }
    if (S.caps && S.caps.maxImagePixels > 0 && isFinite(S.caps.maxImagePixels)) S.maxPx = S.caps.maxImagePixels;
    $("maxPxText").textContent = String(+(S.maxPx / 1e6).toFixed(1));
    var d = Core.describeBackend(S.caps, S.engineVersion);
    showBadge(d.text, d.kind, d.adapter ? "Adapter: " + d.adapter : "");
    if (d.kind !== "gpu") $("mode").querySelector('option[value="gpu"]').disabled = true;
    buildParamGrid();
    var n = Math.max(1, Math.min(8, (S.caps && S.caps.hardwareConcurrency) || navigator.hardwareConcurrency || 2)), sel = $("pool");
    for (var i = 1; i <= n; i++) sel.appendChild(h("option", { value: String(i), text: String(i) }));
    sel.value = String(Math.min(2, n));
    updateButtons();
  }

  function buildParamGrid() {
    var grid = $("paramGrid"), keys = Core.PARAM_ORDER.filter(function (k) { return k in S.defaults; });
    Object.keys(S.defaults).forEach(function (k) { if (keys.indexOf(k) < 0) keys.push(k); });
    clear(grid);
    keys.forEach(function (k) {
      var sp = Core.PARAM_SPECS[k] || { label: k, help: "", step: "any" };
      var id = "p_" + k;
      grid.appendChild(h("div", { class: "field" }, [
        h("label", { for: id, text: sp.label }),
        h("input", { type: "text", inputmode: "decimal", id: id, "data-key": k, autocomplete: "off", value: String(S.defaults[k]), oninput: onParamInput }),
        sp.help ? h("small", { id: id + "_h", text: sp.help + (sp.min != null ? " (" + sp.min + " to " + sp.max + ")" : "") }) : null
      ]));
      if (sp.help) $(id).setAttribute("aria-describedby", id + "_h");
    });
  }
  function rawParams() { var o = {}; $("paramGrid").querySelectorAll("input[data-key]").forEach(function (i) { o[i.getAttribute("data-key")] = i.value; }); return o; }
  function readParams(report) {
    if (!S.defaults) return null;
    var v = Core.validateParams(rawParams(), S.defaults);
    $("paramGrid").querySelectorAll("input[data-key]").forEach(function (i) { var bad = !!v.errors[i.getAttribute("data-key")]; if (bad) i.setAttribute("aria-invalid", "true"); else i.removeAttribute("aria-invalid"); });
    if (report !== false) { var m = $("paramMsg"); m.textContent = v.ok ? "" : Object.keys(v.errors).map(function (k) { return v.errors[k]; }).join(" "); m.className = "note" + (v.ok ? "" : " st-err"); }
    return v.ok ? v.clean : null;
  }
  function onParamInput() { $("paramPreset").value = "custom"; readParams(); updateButtons(); }
  function setParamInputs(p) { Object.keys(p).forEach(function (k) { var i = $("p_" + k); if (i) i.value = String(p[k]); }); readParams(); updateButtons(); }

  $("paramPreset").appendChild(h("option", { value: "custom", text: "Custom (edited)", hidden: true }));
  $("paramPreset").addEventListener("change", function () { if (this.value !== "custom" && S.defaults) setParamInputs(Core.presetParams(this.value, S.defaults)); });
  $("resetParams").addEventListener("click", function () { if (!S.defaults) return; $("paramPreset").value = "defaults"; setParamInputs(S.defaults); });
  $("exportParams").addEventListener("click", function () {
    var p = readParams(); if (!p) return;
    download("foci-lab-parameters-" + stamp() + ".json", Core.paramsToJSON(p, S.engineVersion), "application/json");
  });
  $("importParamsBtn").addEventListener("click", function () { $("importParams").click(); });
  $("importParams").addEventListener("change", async function () {
    var f = this.files && this.files[0]; this.value = ""; if (!f || !S.defaults) return;
    var m = $("paramMsg");
    if (f.size > 100000) { m.textContent = "That file is too large to be a parameter file."; m.className = "note st-err"; return; }
    var r = Core.parseParamsJSON(await f.text(), S.defaults);
    if (!r.ok) { m.textContent = "Could not import: " + r.error; m.className = "note st-err"; return; }
    $("paramPreset").value = "custom"; setParamInputs(r.clean);
    m.textContent = "Imported " + r.provided + " parameter" + (r.provided === 1 ? "" : "s") + " (others keep their current engine defaults)" + (r.unknown && r.unknown.length ? " (ignored unknown keys: " + r.unknown.join(", ") + ")" : "") + ".";
    m.className = "note st-ok";
  });

  // ------------------------------------------------------------------ adding files
  var fileInput = $("fileInput"), folderInput = $("folderInput"), drop = $("drop");
  $("pickFiles").addEventListener("click", function () { fileInput.click(); });
  $("pickFolder").addEventListener("click", function () { folderInput.click(); });
  fileInput.addEventListener("change", function () { addEntries(Array.prototype.map.call(fileInput.files, function (f) { return { file: f, path: f.name }; })); fileInput.value = ""; });
  folderInput.addEventListener("change", function () { addEntries(Array.prototype.map.call(folderInput.files, function (f) { return { file: f, path: f.webkitRelativePath || f.name }; })); folderInput.value = ""; });
  $("clearFiles").addEventListener("click", function () {
    if (S.running) return;
    S.files = []; S.sets = []; S.zipCache = null; S.selected = null; hideResults(); renderFiles(); renderSets(); updateButtons();
  });
  window.addEventListener("dragover", function (e) { e.preventDefault(); });          // a stray drop must not navigate away from the page
  window.addEventListener("drop", function (e) { e.preventDefault(); });
  ["dragenter", "dragover"].forEach(function (t) { drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.add("over"); }); });
  drop.addEventListener("dragleave", function (e) { if (!drop.contains(e.relatedTarget)) drop.classList.remove("over"); });
  drop.addEventListener("drop", async function (e) {
    e.preventDefault(); e.stopPropagation(); drop.classList.remove("over");
    var dt = e.dataTransfer; if (!dt) return;
    var entries = [], plain = [];
    if (dt.items && dt.items.length) {                                      // entries must be taken synchronously
      for (var i = 0; i < dt.items.length; i++) {
        var it = dt.items[i]; if (it.kind !== "file") continue;
        var ent = it.webkitGetAsEntry ? it.webkitGetAsEntry() : null;
        if (ent) entries.push(ent); else { var f = it.getAsFile(); if (f) plain.push({ file: f, path: f.name }); }
      }
    } else for (var j = 0; j < dt.files.length; j++) plain.push({ file: dt.files[j], path: dt.files[j].name });
    say("Reading dropped items…");
    var budget = { left: MAX_FILES * 4, truncated: false };
    var found = plain.slice();
    for (var k = 0; k < entries.length; k++) await walkEntry(entries[k], "", 0, found, budget);
    say(budget.truncated ? "That folder holds a very large number of entries; only the first ones were read." : "");
    addEntries(found);
  });
  function readEntries(reader) { return new Promise(function (res) { reader.readEntries(res, function () { res([]); }); }); }
  async function walkEntry(ent, prefix, depth, out, budget) {
    if (budget.left-- <= 0) { budget.truncated = true; return; }
    if (ent.isFile) {
      var f = await new Promise(function (res) { ent.file(res, function () { res(null); }); });
      if (f) out.push({ file: f, path: (prefix + ent.name) });
    } else if (ent.isDirectory && depth < 8) {
      var reader = ent.createReader(), batch;
      do { batch = await readEntries(reader); for (var i = 0; i < batch.length; i++) await walkEntry(batch[i], prefix + ent.name + "/", depth + 1, out, budget); } while (batch.length && budget.left > 0);
    }
  }

  function addEntries(list) {
    if (S.running) { say("Wait for the current run to finish (or cancel it) before adding files.", "err"); return; }
    var added = 0, skipped = [];
    list.forEach(function (it) {
      var f = it.file, path = String(it.path || f.name).replace(/\\/g, "/").replace(/^\/+/, "");
      if (!EXT_RE.test(path)) { skipped.push(path); return; }
      if (S.files.length >= MAX_FILES) { skipped.push(path + " (limit of " + MAX_FILES + " files)"); return; }
      for (var i = 0; i < S.files.length; i++) { var o = S.files[i]; if (o.name === path && o.size === f.size && o.file.lastModified === f.lastModified && !o.zipEntry) return; }   // same file added twice
      S.files.push({ id: S.nextFile++, name: path, size: f.size, file: f, status: "queued", format: null, channels: [], warnings: [], error: null });
      added++;
    });
    if (skipped.length) say(skipped.length + " item(s) skipped (not PNG, TIFF, JPEG or ZIP): " + short(skipped.slice(0, 3).join(", "), 120) + (skipped.length > 3 ? ", …" : ""), "err");
    else if (!added) say("Nothing new to add.");
    else say("");
    renderFiles(); updateButtons();
    if (added) scanQueue();
  }

  async function scanQueue() {
    if (S.scanning) return;
    S.scanning = true;
    try {
      var vf;
      while ((vf = S.files.filter(function (f) { return f.status === "queued"; })[0])) {
        vf.status = "scanning"; renderFiles();
        try { await scanOne(vf); } catch (e) { vf.status = "error"; vf.error = errMsg(e); }
        renderFiles();
      }
    } finally { S.scanning = false; }
    buildSets();
  }

  async function zipBytes(file) {
    if (S.zipCache && S.zipCache.file === file) return S.zipCache;
    S.zipCache = null;
    var buf = new Uint8Array(await file.arrayBuffer());
    var listing = await IO.readBytes(buf, file.name, { maxPixels: S.maxPx });
    S.zipCache = { file: file, buf: buf, entries: listing.entries };
    return S.zipCache;
  }

  // Read raw bytes of a file entry (plain file or ZIP member).
  async function rawBytes(vf) {
    if (vf.zipEntry) {
      var z = await zipBytes(vf.file), e = z.entries.filter(function (x) { return x.name === vf.zipEntry; })[0];
      if (!e) throw new Error("The ZIP no longer lists '" + vf.zipEntry + "'.");
      return IO.extractZipEntry(z.buf, e);
    }
    if (vf.file.size > MAX_FILE_BYTES) throw new Error("File is " + fmtBytes(vf.file.size) + "; the limit is " + fmtBytes(MAX_FILE_BYTES) + ".");
    return new Uint8Array(await vf.file.arrayBuffer());
  }

  async function scanOne(vf) {
    var bytes = await rawBytes(vf);
    vf.size = bytes.length;
    vf.sha256 = await IO.sha256(bytes);
    var r = await IO.readBytes(bytes, vf.name, { maxPixels: S.maxPx, maxFileBytes: MAX_FILE_BYTES });
    if (r.format === "zip") {
      if (vf.zipEntry) throw new Error("Nested ZIP archives are not opened.");
      vf.format = "zip"; vf.status = "container"; vf.warnings = r.warnings; vf.count = r.entries.length;
      var at = S.files.indexOf(vf), kids = r.entries.map(function (e) {
        return { id: S.nextFile++, name: vf.name + "/" + e.name, size: e.size, file: vf.file, zipEntry: e.name, container: { name: vf.name, sha256: vf.sha256 }, status: "queued", format: null, channels: [], warnings: [], error: null };
      });
      S.files.splice.apply(S.files, [at + 1, 0].concat(kids));
      S.zipCache = { file: vf.file, buf: bytes, entries: r.entries };
      return;
    }
    vf.format = r.format; vf.width = r.width; vf.height = r.height; vf.pixelSizeUm = r.pixelSizeUm; vf.warnings = r.warnings;
    vf.channels = r.channels.map(function (c, i) {
      var st = c.data ? Core.channelStats(c.data) : null;
      return { index: i, name: c.name, bitDepth: c.bitDepth, width: c.width, height: c.height, stats: st, thumb: c.data ? Core.thumbnail(c.data, c.width, c.height, 280, st.p001, st.p9999 > st.p001 ? st.p9999 : st.max) : null };
    });
    vf.status = "ok";
  }

  function removeFile(id) {
    if (S.running) return;
    var vf = fileById(id); if (!vf) return;
    S.files = S.files.filter(function (f) { return f.id !== id && !(vf.format === "zip" && f.container && f.file === vf.file); });
    S.sets = S.sets.filter(function (s) { return S.files.some(function (f) { return f.id === s.nuc.fileId; }) && S.files.some(function (f) { return f.id === s.foc.fileId; }); });
    renderFiles(); renderSets(); updateButtons();
  }

  function renderFiles() {
    var tb = $("fileTbl").querySelector("tbody"); clear(tb);
    $("fileTblWrap").hidden = !S.files.length;
    var total = 0, big = 0, bad = 0, okN = 0;
    S.files.forEach(function (f) {
      total += f.format === "zip" || f.zipEntry ? 0 : f.size;
      if (f.status === "error") bad++;
      if (f.status === "ok") okN++;
      if (f.width && f.width * f.height > 8e6) big++;
      var st = f.status === "ok" ? h("span", { class: "st-ok", text: f.warnings.length ? "Ready (" + f.warnings.length + " note" + (f.warnings.length > 1 ? "s" : "") + ")" : "Ready", title: f.warnings.join(" • ") })
        : f.status === "error" ? h("span", { class: "st-err", text: f.error })
        : f.status === "container" ? h("span", { class: "st-ok", text: "ZIP: " + f.count + " image" + (f.count === 1 ? "" : "s") })
        : h("span", { class: "st-run", text: f.status === "scanning" ? "Reading…" : "Waiting…" });
      tb.appendChild(h("tr", null, [
        h("td", { class: "fname", text: f.name }),
        h("td", { text: f.format ? f.format.toUpperCase() : "–" }),
        h("td", { class: "num", text: fmtBytes(f.size) }),
        h("td", { class: "num", text: f.width ? f.width + " × " + f.height : "–" }),
        h("td", { class: "num", text: f.channels.length ? String(f.channels.length) : "–" }),
        h("td", null, [st]),
        h("td", null, [h("button", { type: "button", class: "lnk", "aria-label": "Remove " + f.name, text: "Remove", onclick: function () { removeFile(f.id); } })])
      ]));
    });
    var nm = navigator.deviceMemory ? " This device reports about " + navigator.deviceMemory + " GB of memory." : "";
    $("fileSummary").textContent = S.files.length
      ? S.files.length + " file" + (S.files.length === 1 ? "" : "s") + ", " + fmtBytes(total) + " in total; " + okN + " readable" + (bad ? ", " + bad + " with problems (see the table)" : "") + "."
        + (big ? " " + big + " image" + (big === 1 ? " is" : "s are") + " above 8 megapixels: each needs a few hundred MB while it runs, so use a pool size of 1 if the tab runs out of memory." + nm : "")
      : "No files yet.";
    $("clearFiles").disabled = !S.files.length || S.running;
  }

  // ------------------------------------------------------------------ pairing and sets
  var presetSel = $("rulePreset");
  Core.PAIR_PRESETS.forEach(function (p) { presetSel.appendChild(h("option", { value: p.id, text: p.label })); });
  presetSel.appendChild(h("option", { value: "custom", text: "Custom (edited)" }));
  function applyPreset(id) { var p = Core.PAIR_PRESETS.filter(function (x) { return x.id === id; })[0]; if (p) { $("ruleNuc").value = p.nuclei; $("ruleFoc").value = p.foci; } }
  presetSel.addEventListener("change", function () { applyPreset(this.value); });
  applyPreset("dapi_53bp1");
  ["ruleNuc", "ruleFoc"].forEach(function (id) { $(id).addEventListener("input", function () { presetSel.value = "custom"; }); });
  $("repair").addEventListener("click", function () { buildSets(true); });
  function currentRules() { return { nuclei: $("ruleNuc").value, foci: $("ruleFoc").value }; }

  function guessFor(vf, role) {
    if (vf.channels.length < 2) return 0;
    var g = Core.guessChannels(vf.channels.map(function (c) { return c.name; }));
    return Math.max(0, role === "nuclei" ? g.nuclei : g.foci);
  }
  function baseName(n) { var b = String(n).replace(/\\/g, "/").split("/").pop(); return b.replace(/\.(ome\.tiff?|tiff?|png|jpe?g)$/i, ""); }

  function buildSets(force) {
    if (S.running) return;
    var prev = {}; S.sets.forEach(function (s) { prev[s.key] = s; });
    var manual = S.sets.filter(function (s) { return s.manual && fileById(s.nuc.fileId) && fileById(s.foc.fileId); });
    var oks = S.files.filter(function (f) { return f.status === "ok" && f.channels.length; });
    var res = Core.pairFiles(oks.map(function (f) { return { id: f.id, name: f.name }; }), currentRules());
    var sets = [], used = {};
    function mk(key, name, nuc, foc) {
      var o = prev[key];
      return { id: S.nextSet++, key: key, name: name, manual: false, nuc: nuc, foc: foc, condition: o ? o.condition : "", replicate: o ? o.replicate : "", include: o ? o.include : true, status: "idle", msg: "", result: null, summary: null };
    }
    res.pairs.forEach(function (p) {
      var nf = fileById(p.nucleiId), ff = fileById(p.fociId); used[p.nucleiId] = used[p.fociId] = true;
      sets.push(mk("pair:" + p.key, p.label, { fileId: nf.id, ch: guessFor(nf, "nuclei") }, { fileId: ff.id, ch: guessFor(ff, "foci") }));
    });
    oks.forEach(function (f) {
      if (used[f.id] || f.channels.length < 2) return;
      used[f.id] = true;
      var g = Core.guessChannels(f.channels.map(function (c) { return c.name; }));
      sets.push(mk("file:" + f.id + ":" + f.name, f.name.replace(/\.(ome\.tiff?|tiff?|png|jpe?g)$/i, ""), { fileId: f.id, ch: g.nuclei }, { fileId: f.id, ch: g.foci }));
    });
    var left = oks.filter(function (f) { return !used[f.id]; }).map(function (f) { return f.name; });
    sets = sets.concat(manual);
    // unique names
    var seen = {};
    sets.forEach(function (s) { var n = s.name; if (seen[n]) { seen[n]++; s.name = n + " (" + seen[n] + ")"; } else seen[n] = 1; });
    S.sets = sets;
    var msg = sets.length ? sets.length + " set" + (sets.length === 1 ? "" : "s") + " ready." : (oks.length ? "No sets yet." : "");
    if (res.ambiguous.length) msg += " " + res.ambiguous.length + " file(s) match both the nuclei and the foci words and were not paired.";
    if (left.length) msg += " " + left.length + " single-channel file(s) are not in any set (" + short(left.slice(0, 3).join(", "), 90) + (left.length > 3 ? ", …" : "") + "): edit the words above or add a set manually.";
    $("pairNote").textContent = msg;
    $("addSet").disabled = !oks.length;
    renderSets(); updateButtons();
    if (force) say("");
  }

  function setProblem(s) {
    var nf = fileById(s.nuc.fileId), ff = fileById(s.foc.fileId);
    if (!nf || !ff) return "Choose a nuclei channel and a foci channel.";
    var nc = nf.channels[s.nuc.ch], fc = ff.channels[s.foc.ch];
    if (!nc || !fc) return "Choose a nuclei channel and a foci channel.";
    if (nf === ff && s.nuc.ch === s.foc.ch) return "Nuclei and foci must be different channels.";
    if (nc.width !== fc.width || nc.height !== fc.height) return "Image sizes differ (" + nc.width + "×" + nc.height + " vs " + fc.width + "×" + fc.height + "); the two channels must match.";
    return null;
  }

  function optionLabel(f, c) { return short(f.name, 46) + " — " + c.name + " (" + c.bitDepth + "-bit)"; }
  function populate(sel, cur) {
    if (sel.getAttribute("data-full")) return;
    sel.setAttribute("data-full", "1"); clear(sel);
    S.files.forEach(function (f) { if (f.status !== "ok") return; f.channels.forEach(function (c) { sel.appendChild(h("option", { value: f.id + ":" + c.index, text: optionLabel(f, c) })); }); });
    sel.value = cur;
  }
  function chanBox(s, role) {
    var src = role === "nuclei" ? s.nuc : s.foc, uid = "s" + s.id + role, f = fileById(src.fileId), c = f && f.channels[src.ch];
    var sel = h("select", { id: uid }), cur = src.fileId + ":" + src.ch;
    if (c) sel.appendChild(h("option", { value: cur, text: optionLabel(f, c) }));
    var total = 0; S.files.forEach(function (x) { total += x.channels.length; });
    var box = h("div", { class: "chan" }, [h("label", { for: uid, text: role === "nuclei" ? "Nuclei channel (DAPI, Hoechst)" : "Foci channel (53BP1, gamma-H2AX)" }), sel]);
    var eager = total * S.sets.length <= 3000;
    if (eager) populate(sel, cur); else ["focus", "mousedown", "keydown"].forEach(function (t) { sel.addEventListener(t, function () { populate(sel, sel.value); }, { once: false }); });
    sel.addEventListener("change", function () {
      var p = sel.value.split(":"); src.fileId = +p[0]; src.ch = +p[1];
      drawPreview(box, src, role); refreshSet(s);
    });
    drawPreview(box, src, role);
    return box;
  }
  function drawPreview(box, src, role) {
    Array.prototype.slice.call(box.querySelectorAll("canvas, svg, .stat")).forEach(function (n) { box.removeChild(n); });
    var f = fileById(src.fileId), c = f && f.channels[src.ch];
    if (!c || !c.thumb) return;
    var cv = h("canvas", { width: c.thumb.width, height: c.thumb.height, role: "img", "aria-label": "Preview of the " + role + " channel (display-stretched, downsampled)" });
    cv.getContext("2d").putImageData(new ImageData(c.thumb.rgba, c.thumb.width, c.thumb.height), 0, 0);
    box.appendChild(cv);
    var bins = c.stats.bins, mx = 1, i; for (i = 0; i < 256; i++) if (bins[i] > mx) mx = bins[i];
    var d = "M0 50"; for (i = 0; i < 256; i++) d += " L" + i + " " + (50 - 48 * Math.sqrt(bins[i] / mx)).toFixed(1); d += " L255 50 Z";
    var g = sv("svg", { class: "hist", viewBox: "0 0 256 52", preserveAspectRatio: "none", role: "img", "aria-label": "Intensity histogram (square-root scale) from " + c.stats.min + " to " + c.stats.max });
    g.appendChild(sv("line", { x1: 0, x2: 256, y1: 50.5, y2: 50.5 })); g.appendChild(sv("path", { d: d }));
    box.appendChild(g);
    box.appendChild(h("p", { class: "stat", text: "range " + fmtNum(c.stats.min, 0) + "–" + fmtNum(c.stats.max, 0) + " · p0.1–p99.99 " + fmtNum(c.stats.p001, 0) + "–" + fmtNum(c.stats.p9999, 0) + (c.stats.flat ? " · flat image" : "") }));
  }

  function renderSets() {
    var host = $("sets"); clear(host);
    $("bulkBox").hidden = !S.sets.length;
    S.sets.forEach(function (s) {
      var title = h("h3", { text: s.name });
      var inc = h("input", { type: "checkbox", id: "inc" + s.id }); inc.checked = s.include;
      inc.addEventListener("change", function () { s.include = inc.checked; card.classList.toggle("off", !s.include); updateButtons(); });
      var card = h("div", { class: "card set" + (s.include ? "" : " off"), id: "set" + s.id, role: "group", "aria-label": "Image set " + s.name }, [
        h("div", { class: "set-head" }, [title, h("div", { class: "actions" }, [
          h("label", { class: "chk", for: "inc" + s.id }, [inc, "Include in run"]),
          h("button", { type: "button", class: "lnk", "aria-label": "Remove set " + s.name, text: "Remove set", onclick: function () { if (S.running) return; S.sets = S.sets.filter(function (x) { return x !== s; }); renderSets(); updateButtons(); } })
        ])]),
        h("div", { class: "set-body" }, [chanBox(s, "nuclei"), chanBox(s, "foci")]),
        h("div", { class: "set-meta" }, [
          h("div", { class: "field" }, [h("label", { for: "cond" + s.id, text: "Condition (control, treated, …)" }), h("input", { type: "text", id: "cond" + s.id, list: "condList", maxlength: "60", autocomplete: "off", value: s.condition, oninput: function () { s.condition = this.value; } })]),
          h("div", { class: "field" }, [h("label", { for: "rep" + s.id, text: "Replicate (experiment / dish; optional)" }), h("input", { type: "text", id: "rep" + s.id, maxlength: "60", autocomplete: "off", value: s.replicate, oninput: function () { s.replicate = this.value; } })])
        ]),
        h("p", { class: "set-msg", id: "msg" + s.id, role: "status" })
      ]);
      host.appendChild(card);
      refreshSet(s);
    });
  }

  function refreshSet(s) {
    var m = $("msg" + s.id); if (!m) return;
    var p = setProblem(s), txt = "", cls = "set-msg";
    if (s.status === "idle") { if (p) { txt = p; cls += " err"; } }
    else { txt = s.msg || ""; cls += s.status === "error" ? " err" : s.status === "done" ? " ok" : s.status === "cancelled" ? " warn" : ""; }
    m.textContent = txt; m.className = cls;
    updateButtons();
  }

  $("addSet").addEventListener("click", function () {
    var f = S.files.filter(function (x) { return x.status === "ok"; })[0]; if (!f) return;
    var g = f.channels.length > 1 ? Core.guessChannels(f.channels.map(function (c) { return c.name; })) : { nuclei: 0, foci: -1 };
    S.sets.push({ id: S.nextSet++, key: "manual:" + S.nextSet, name: "Manual set " + (S.sets.length + 1), manual: true, nuc: { fileId: f.id, ch: g.nuclei }, foc: { fileId: f.id, ch: g.foci }, condition: "", replicate: "", include: true, status: "idle", msg: "", result: null, summary: null });
    renderSets(); $("bulkBox").hidden = false;
    var last = S.sets[S.sets.length - 1]; var n = $("s" + last.id + "nuclei"); if (n) n.focus();
  });
  $("bulkApply").addEventListener("click", function () {
    var t = $("bulkMatch").value.trim().toLowerCase(), c = Core.cleanLabel($("bulkCond").value, 60), r = Core.cleanLabel($("bulkRep").value, 60), n = 0;
    if (!t) { $("pairNote").textContent = "Type the text that the set names should contain."; return; }
    S.sets.forEach(function (s) { if (s.name.toLowerCase().indexOf(t) >= 0) { if (c) s.condition = c; if (r) s.replicate = r; n++; } });
    $("pairNote").textContent = n + " set(s) updated.";
    renderSets();
  });

  // ------------------------------------------------------------------ running
  function updateButtons() {
    var ready = !!Eng && !!S.defaults && !S.running && S.sets.some(function (s) { return s.include && !setProblem(s); }) && !!readParams(false);
    $("runBtn").disabled = !ready;
    $("cancelBtn").hidden = !S.running;
    ["pickFiles", "pickFolder", "repair", "addSet", "bulkApply"].forEach(function (id) { $(id).disabled = S.running || (id === "addSet" && !S.files.some(function (f) { return f.status === "ok"; })); });
    $("clearFiles").disabled = S.running || !S.files.length;
    $("mode").disabled = $("pool").disabled = S.running;
  }

  function raceAbort(p, signal) {
    return new Promise(function (resolve, reject) {
      function onAbort() { var e = new Error("Cancelled."); e.code = "aborted"; reject(e); }
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
      p.then(function (v) { signal.removeEventListener("abort", onAbort); resolve(v); }, function (e) { signal.removeEventListener("abort", onAbort); reject(e); });
    });
  }

  // Decode one file's channels for analysis, verifying it is byte-identical to what was scanned.
  async function loadChannels(vf, select) {
    var bytes = await rawBytes(vf);
    if ((await IO.sha256(bytes)) !== vf.sha256) throw new Error("'" + short(vf.name, 60) + "' changed on disk after it was added. Remove it and add it again.");
    return IO.readBytes(bytes, vf.name, { maxPixels: S.maxPx, maxFileBytes: MAX_FILE_BYTES, select: select });
  }
  function chanInput(c) { return { data: c.data, width: c.width, height: c.height, bitDepth: c.bitDepth }; }

  function getPool(n) {
    if (S.pool && S.poolSize === n) return S.pool;
    killPool();
    if (typeof Eng.createPool === "function") { S.pool = Eng.createPool(n); S.poolSize = n; return S.pool; }
    S.pool = { analyze: function (i, o) { return Eng.analyze(i, o); }, terminate: function () {}, size: 1 }; S.poolSize = n;
    return S.pool;
  }
  function killPool() { if (S.pool) { try { S.pool.terminate(); } catch (e) { /* ignore */ } } S.pool = null; S.poolSize = 0; }
  window.addEventListener("pagehide", killPool);

  async function makeOverlayBlob(ov) {
    try {
      var cv = document.createElement("canvas"); cv.width = ov.width; cv.height = ov.height;
      cv.getContext("2d").putImageData(new ImageData(ov.data instanceof Uint8ClampedArray ? ov.data : new Uint8ClampedArray(ov.data.buffer || ov.data), ov.width, ov.height), 0, 0);
      return await new Promise(function (res) { cv.toBlob(res, "image/png"); });
    } catch (e) { return null; }
  }

  function resetResult(s) { s.result = null; s.summary = null; s.overlayBlob = null; s.backend = null; s.engineVersion = null; s.timing_ms = null; s.error = null; s.readWarnings = []; s.msg = ""; s.status = "idle"; }

  async function runSet(s, params, pool, signal) {
    try {
      s.status = "reading"; s.msg = "Reading files…"; refreshSet(s);
      var nf = fileById(s.nuc.fileId), ff = fileById(s.foc.fileId), dna, foci, nres, fres;
      if (nf === ff) { nres = fres = await loadChannels(nf, [s.nuc.ch, s.foc.ch]); }
      else { nres = await loadChannels(nf, [s.nuc.ch]); if (signal.aborted) throw abortErr(); fres = await loadChannels(ff, [s.foc.ch]); }
      if (signal.aborted) throw abortErr();
      dna = nres.channels[s.nuc.ch]; foci = fres.channels[s.foc.ch];
      if (!dna || !foci || !dna.data || !foci.data) throw new Error("The selected channel could not be decoded.");
      if (dna.width !== foci.width || dna.height !== foci.height) throw new Error("Image sizes differ: " + dna.width + "×" + dna.height + " vs " + foci.width + "×" + foci.height + ".");
      s.width = dna.width; s.height = dna.height; s.pixelSizeUm = nres.pixelSizeUm || fres.pixelSizeUm || null;
      s.readWarnings = (nres.warnings || []).concat(nf === ff ? [] : (fres.warnings || [])).filter(function (w, i, a) { return a.indexOf(w) === i; });
      s.status = "running"; s.msg = "Analysing…"; refreshSet(s);
      var t0 = performance.now();
      var res = await raceAbort(pool.analyze({ dna: chanInput(dna), foci: chanInput(foci), params: params }, { mode: $("mode").value, overlay: true, signal: signal }), signal);
      dna = foci = nres = fres = null;
      if (res.overlay && res.overlay.data) { s.overlayBlob = await makeOverlayBlob(res.overlay); }
      delete res.overlay;
      s.result = res; s.summary = Core.summarise(res); s.backend = res.backend || null; s.engineVersion = res.version || S.engineVersion;
      s.timing_ms = totalMs(res.timing_ms); if (s.timing_ms == null) s.timing_ms = performance.now() - t0;
      s.status = "done";
      s.msg = s.summary.nuclei + " nuclei, " + s.summary.foci + " foci (" + (s.backend || "?") + ", " + Math.round(s.timing_ms) + " ms)" + ((res.warnings || []).length ? " – " + res.warnings.length + " warning(s)" : "");
    } catch (e) {
      if ((e && e.code === "aborted") || signal.aborted) { s.status = "cancelled"; s.msg = "Cancelled."; }
      else { s.status = "error"; s.error = errMsg(e); s.msg = (e && e.code === "too_large" ? "Too large: " : e && e.code === "gpu_lost" ? "GPU lost (try the CPU backend): " : "") + s.error; }
    }
    refreshSet(s); renderResults();
  }
  function abortErr() { var e = new Error("Cancelled."); e.code = "aborted"; return e; }

  $("runBtn").addEventListener("click", runAll);
  $("cancelBtn").addEventListener("click", function () {
    if (!S.running || !S.ac) return;
    S.ac.abort(); killPool(); say("Cancelling…");
  });

  async function runAll() {
    if (S.running || !Eng) return;
    var params = readParams(); if (!params) { say("Fix the highlighted parameters first.", "err"); return; }
    var todo = S.sets.filter(function (s) { return s.include && !setProblem(s); });
    if (!todo.length) { say("No runnable image set. Check the messages under each set.", "err"); return; }
    S.running = true; S.ac = new AbortController(); var signal = S.ac.signal;
    todo.forEach(function (s) { resetResult(s); s.status = "queued"; s.msg = "Waiting…"; refreshSet(s); });
    hideResults(); updateButtons(); renderFiles();
    var size = Math.max(1, Math.min(+$("pool").value || 1, todo.length)), t0 = performance.now(), startedAt = new Date();
    $("progWrap").hidden = false; $("prog").max = todo.length; $("prog").value = 0; $("progText").textContent = "0 / " + todo.length;
    say("Analysing " + todo.length + " image set" + (todo.length === 1 ? "" : "s") + " in this tab…");
    var done = 0, idx = 0;
    try {
      var pool = getPool(+$("pool").value || 1);
      var workers = [];
      for (var w = 0; w < Math.min(size, todo.length); w++) workers.push((async function () {
        while (idx < todo.length && !signal.aborted) {
          var s = todo[idx++];
          await runSet(s, params, pool, signal);
          done++; $("prog").value = done; $("progText").textContent = done + " / " + todo.length;
        }
      })());
      await Promise.all(workers);
    } catch (e) { say("The run stopped unexpectedly: " + errMsg(e), "err"); }
    todo.forEach(function (s) { if (s.status === "queued" || s.status === "reading" || s.status === "running") { s.status = "cancelled"; s.msg = "Cancelled."; refreshSet(s); } });
    var ok = todo.filter(function (s) { return s.status === "done"; }).length, bad = todo.filter(function (s) { return s.status === "error"; }).length, can = todo.filter(function (s) { return s.status === "cancelled"; }).length;
    S.lastRun = { startedAt: startedAt, finishedAt: new Date(), mode: $("mode").value, poolSize: size, params: params, ids: todo.map(function (s) { return s.id; }) };
    S.running = false; S.ac = null;
    $("progWrap").hidden = true;
    say((signal.aborted ? "Cancelled. " : "") + ok + " analysed" + (bad ? ", " + bad + " failed" : "") + (can ? ", " + can + " cancelled" : "") + " in " + ((performance.now() - t0) / 1000).toFixed(1) + " s.", bad || signal.aborted ? "err" : "ok");
    updateButtons(); renderFiles(); renderResults();
    if (ok && S.selected == null) showDetail(todo.filter(function (s) { return s.status === "done"; })[0].id);
    try { var d = Core.describeBackend(S.caps, S.engineVersion); var used = Array.from(new Set(todo.map(function (s) { return s.backend; }).filter(Boolean))); if (used.length) showBadge(d.text + " · last run: " + used.join(", "), d.kind, d.adapter ? "Adapter: " + d.adapter : ""); } catch (e) { /* cosmetic */ }
  }

  // ------------------------------------------------------------------ results
  function fileInfo(vf) { return { id: vf.id, name: vf.name, size: vf.size, sha256: vf.sha256, format: vf.format, container: vf.container || null }; }
  function recordOf(s) {
    var nf = fileById(s.nuc.fileId), ff = fileById(s.foc.fileId), nc = nf && nf.channels[s.nuc.ch], fc = ff && ff.channels[s.foc.ch];
    return { id: s.id, name: s.name, condition: Core.cleanLabel(s.condition, 60), replicate: Core.cleanLabel(s.replicate, 60), status: s.status,
      nuclei: nf && nc ? { file: fileInfo(nf), channel: { index: s.nuc.ch, name: nc.name, bitDepth: nc.bitDepth } } : null,
      foci: ff && fc ? { file: fileInfo(ff), channel: { index: s.foc.ch, name: fc.name, bitDepth: fc.bitDepth } } : null,
      width: s.width, height: s.height, pixelSizeUm: s.pixelSizeUm, result: s.result, summary: s.summary, backend: s.backend, engineVersion: s.engineVersion, timing_ms: s.timing_ms,
      warnings: (s.readWarnings || []).concat(s.result && s.result.warnings ? s.result.warnings : []), readWarnings: s.readWarnings || [], error: s.error };
  }
  function attempted() { return S.sets.filter(function (s) { return s.status === "done" || s.status === "error" || s.status === "cancelled"; }); }

  function hideResults() { $("results").hidden = true; $("detail").hidden = true; S.selected = null; }

  function renderResults() {
    var rows = attempted();
    if (!rows.length) { $("results").hidden = true; return; }
    $("results").hidden = false;
    var tb = $("batchTbl").querySelector("tbody"); clear(tb);
    rows.forEach(function (s) {
      var sm = s.summary, stCls = s.status === "done" ? "st-ok" : s.status === "error" ? "st-err" : "st-run";
      tb.appendChild(h("tr", null, [
        h("th", { scope: "row", class: "fname", text: s.name }),
        h("td", { text: s.condition || "–" }), h("td", { text: s.replicate || "–" }),
        h("td", null, [h("span", { class: stCls, text: s.status === "error" ? "Failed: " + short(s.error || "", 70) : s.status })]),
        h("td", { class: "num", text: sm ? String(sm.nuclei) : "–" }), h("td", { class: "num", text: sm ? String(sm.foci) : "–" }),
        h("td", { class: "num", text: sm ? fmtNum(sm.fociPerNucleus) : "–" }), h("td", { class: "num", text: sm && sm.pctWithFoci != null ? fmtNum(sm.pctWithFoci, 0) : "–" }),
        h("td", { text: s.backend || "–" }),
        h("td", null, [s.status === "done" ? h("button", { type: "button", class: "lnk", "aria-label": "Open details for " + s.name, text: "Open", onclick: function () { showDetail(s.id, true); } }) : null])
      ]));
    });
    var cs = Core.conditionSummary(rows.map(recordOf));
    $("condCard").hidden = !cs.groups.length;
    var ct = $("condTbl").querySelector("tbody"); clear(ct);
    cs.groups.forEach(function (g) {
      ct.appendChild(h("tr", null, [h("th", { scope: "row", text: g.condition }), h("td", { class: "num", text: String(g.images) }), h("td", { class: "num", text: String(g.nuclei) }), h("td", { class: "num", text: fmtNum(g.pooled) }),
        h("td", { class: "num", text: fmtNum(g.imageMean) + (g.imageSd != null ? " ± " + fmtNum(g.imageSd) : "") }),
        h("td", { class: "num", text: String(g.replicates) }), h("td", { class: "num", text: g.replicateMean == null ? "–" : fmtNum(g.replicateMean) + (g.replicateSd != null ? " ± " + fmtNum(g.replicateSd) : "") })]));
    });
    var wl = $("condWarn"); clear(wl); cs.warnings.forEach(function (w) { wl.appendChild(h("li", { text: w })); });
  }

  function tile(label, value) { return h("div", { class: "tile" }, [h("b", { text: value }), h("span", { text: label })]); }

  function showDetail(id, focus) {
    var s = setById(id); if (!s || s.status !== "done") return;
    S.selected = id;
    var r = s.result, sm = s.summary;
    $("detail").hidden = false;
    $("detailTitle").textContent = s.name + (s.condition ? " · " + s.condition : "");
    var t = $("tiles"); clear(t);
    [["Nuclei", String(sm.nuclei)], ["Foci", String(sm.foci)], ["Foci per nucleus", fmtNum(sm.fociPerNucleus)], ["Median per nucleus", sm.median == null ? "–" : fmtNum(sm.median, 1)], ["Nuclei with ≥1 focus (%)", sm.pctWithFoci == null ? "–" : fmtNum(sm.pctWithFoci, 0)]]
      .forEach(function (x) { t.appendChild(tile(x[0], x[1])); });
    var wl = $("detailWarn"); clear(wl);
    (s.readWarnings || []).forEach(function (w) { wl.appendChild(h("li", { text: "Reader: " + w })); });
    (r.warnings || []).forEach(function (w) { wl.appendChild(h("li", { text: "Engine: " + (typeof w === "string" ? w : JSON.stringify(w)) })); });
    // parameters / normalisation
    var dl = $("used"); clear(dl);
    function kv(k, v) { dl.appendChild(h("dt", { text: k })); dl.appendChild(h("dd", { text: v })); }
    kv("Backend", (s.backend || "?") + " · engine " + (s.engineVersion || "?"));
    kv("Image", s.width + " × " + s.height + " px" + (s.pixelSizeUm ? " · " + fmtNum(s.pixelSizeUm, 4) + " µm/px" : ""));
    Object.keys(r.params || {}).forEach(function (k) { kv(k, String(r.params[k])); });
    if (r.normalisation != null) kv("Normalisation", typeof r.normalisation === "string" ? r.normalisation : JSON.stringify(r.normalisation));
    // nuclei table
    var objs = (r.nuclei && r.nuclei.objects) || [], nb = $("nucTbl").querySelector("tbody"); clear(nb);
    objs.slice(0, NUC_ROWS).forEach(function (o) { nb.appendChild(h("tr", null, [h("td", { text: String(o.id) }), h("td", { text: String(o.area_px) }), h("td", { text: fmtNum(o.cx, 1) }), h("td", { text: fmtNum(o.cy, 1) }), h("td", { text: String(o.foci) })])); });
    $("nucNote").textContent = objs.length > NUC_ROWS ? "Showing the first " + NUC_ROWS + " of " + objs.length + " objects; the CSV export has all of them." : objs.length + " objects.";
    drawHist(Core.nucleusCounts(r));
    loadOverlay(s);
    if (focus) $("detailTitle").focus();
  }

  function drawHist(counts) {
    var host = $("hist"); clear(host);
    if (!counts.length) { host.appendChild(h("p", { class: "note", text: "No per-object counts were reported." })); return; }
    var mx = 0; counts.forEach(function (c) { if (c > mx) mx = c; });
    var cap = Math.min(mx, 30), bins = new Array(cap + 1).fill(0); counts.forEach(function (c) { bins[Math.min(c, cap)]++; });
    var top = Math.max.apply(null, bins), W = 420, Hh = 160, pad = 26, bw = (W - pad - 6) / bins.length;
    var g = sv("svg", { viewBox: "0 0 " + W + " " + (Hh + 20), role: "img", "aria-label": "Histogram of foci per nuclear object" });
    g.appendChild(sv("line", { x1: pad, x2: W - 6, y1: Hh, y2: Hh }));
    bins.forEach(function (n, i) {
      var bh = top ? (n / top) * (Hh - 14) : 0;
      g.appendChild(sv("rect", { class: "bar", x: pad + i * bw + 1, y: Hh - bh, width: Math.max(1, bw - 2), height: bh }));
      if (i % Math.ceil(bins.length / 12) === 0) { var tx = sv("text", { x: pad + i * bw + bw / 2, y: Hh + 13, "text-anchor": "middle" }); tx.textContent = (i === cap && mx > cap ? cap + "+" : String(i)); g.appendChild(tx); }
    });
    var ty = sv("text", { x: 2, y: 10 }); ty.textContent = String(top); g.appendChild(ty);
    host.appendChild(g);
  }

  // ---- overlay viewer
  var ovImg = $("ovImg"), ovSvg = $("ovSvg"), stage = $("stage"), viewer = $("viewer");
  var cur = { w: 1, h: 1 };
  function loadOverlay(s) {
    if (S.overlayUrl) { URL.revokeObjectURL(S.overlayUrl); S.overlayUrl = null; }
    var dims = s.result.image || { width: s.width, height: s.height };
    cur.w = dims.width || s.width || 1; cur.h = dims.height || s.height || 1;
    ovSvg.setAttribute("viewBox", "0 0 " + cur.w + " " + cur.h);
    if (s.overlayBlob) { S.overlayUrl = URL.createObjectURL(s.overlayBlob); ovImg.src = S.overlayUrl; ovImg.style.display = ""; $("ovNote").textContent = ""; }
    else { ovImg.removeAttribute("src"); ovImg.style.display = "none"; $("ovNote").textContent = "The engine returned no overlay image for this set; the point and ID layers below are still drawn from its results."; }
    $("tgImg").disabled = !s.overlayBlob;
    drawLayers(s); S.zoom = "fit"; applyZoom(); toggles();
    if (!s.overlayBlob) { stage.style.aspectRatio = cur.w + " / " + cur.h; stage.style.background = "#05080f"; } else { stage.style.aspectRatio = ""; stage.style.background = ""; }
  }
  function drawLayers(s) {
    clear(ovSvg);
    var pts = (s.result.foci && s.result.foci.points) || [], objs = (s.result.nuclei && s.result.nuclei.objects) || [];
    var gp = sv("g", { id: "gPts" }), gi = sv("g", { id: "gIds" }), i;
    for (i = 0; i < Math.min(pts.length, MAX_POINTS); i++) gp.appendChild(sv("circle", { class: "pt", cx: pts[i].x + 0.5, cy: pts[i].y + 0.5, r: 5 }));
    var fs = Math.max(8, Math.round(cur.w / 70));
    for (i = 0; i < Math.min(objs.length, MAX_IDS); i++) { var t = sv("text", { class: "id", x: objs[i].cx, y: objs[i].cy, "text-anchor": "middle", "font-size": fs }); t.textContent = String(objs[i].id); gi.appendChild(t); }
    ovSvg.appendChild(gp); ovSvg.appendChild(gi);
    $("ovNote").textContent = ($("ovNote").textContent ? $("ovNote").textContent + " " : "") + (pts.length > MAX_POINTS ? "Only the first " + MAX_POINTS + " of " + pts.length + " foci are drawn. " : "") + (objs.length > MAX_IDS ? "Only the first " + MAX_IDS + " nucleus IDs are drawn." : "");
  }
  function toggles() {
    ovImg.classList.toggle("off", !$("tgImg").checked);
    var gp = $("gPts"), gi = $("gIds");
    if (gp) gp.style.display = $("tgPts").checked ? "" : "none";
    if (gi) gi.style.display = $("tgIds").checked ? "" : "none";
  }
  ["tgImg", "tgPts", "tgIds"].forEach(function (id) { $(id).addEventListener("change", toggles); });
  function applyZoom() {
    if (S.zoom === "fit") stage.style.width = "100%"; else stage.style.width = Math.round(cur.w * S.zoom) + "px";
    var px = stage.getBoundingClientRect().width; $("zLabel").textContent = S.zoom === "fit" ? "fit (" + Math.round(100 * px / cur.w) + "%)" : Math.round(S.zoom * 100) + "%";
  }
  function zoomBy(f) {
    var z = S.zoom === "fit" ? stage.getBoundingClientRect().width / cur.w : S.zoom;
    S.zoom = Math.min(16, Math.max(0.05, z * f)); applyZoom();
  }
  $("zIn").addEventListener("click", function () { zoomBy(1.5); });
  $("zOut").addEventListener("click", function () { zoomBy(1 / 1.5); });
  $("zFit").addEventListener("click", function () { S.zoom = "fit"; applyZoom(); });
  $("z100").addEventListener("click", function () { S.zoom = 1; applyZoom(); });
  viewer.addEventListener("keydown", function (e) {
    if (e.key === "+" || e.key === "=") { e.preventDefault(); zoomBy(1.5); } else if (e.key === "-" || e.key === "_") { e.preventDefault(); zoomBy(1 / 1.5); } else if (e.key === "0") { e.preventDefault(); S.zoom = "fit"; applyZoom(); }
  });
  viewer.addEventListener("wheel", function (e) { if (e.ctrlKey) { e.preventDefault(); zoomBy(e.deltaY < 0 ? 1.2 : 1 / 1.2); } }, { passive: false });
  window.addEventListener("resize", function () { if (S.zoom === "fit" && S.selected != null) applyZoom(); });

  // ---- exports
  function doneRecords() { return S.sets.filter(function (s) { return s.status === "done"; }).map(recordOf); }
  var BOM = "﻿";
  $("expNuc").addEventListener("click", function () { download("foci-lab-per-nucleus-" + stamp() + ".csv", BOM + Core.perNucleusCsv(doneRecords()), "text/csv;charset=utf-8"); });
  $("expImg").addEventListener("click", function () { download("foci-lab-per-image-" + stamp() + ".csv", BOM + Core.perImageCsv(attempted().map(recordOf)), "text/csv;charset=utf-8"); });
  $("expProv").addEventListener("click", function () {
    var lr = S.lastRun || {}, recs = attempted().map(recordOf);
    var prov = Core.buildProvenance({ pageVersion: Core.LAB_VERSION, ioVersion: IO.version, pageUrl: location.origin + location.pathname, engineVersion: S.engineVersion, mode: lr.mode, poolSize: lr.poolSize,
      capabilities: S.caps, params: lr.params || null, defaults: S.defaults, userAgent: navigator.userAgent, hardwareConcurrency: navigator.hardwareConcurrency, records: recs });
    prov.run = { started_at: lr.startedAt ? lr.startedAt.toISOString() : null, finished_at: lr.finishedAt ? lr.finishedAt.toISOString() : null };
    download("foci-lab-provenance-" + stamp() + ".json", JSON.stringify(prov, null, 2), "application/json");
  });

  // ------------------------------------------------------------------ last-resort handlers
  window.addEventListener("error", function (e) { say("Unexpected error: " + errMsg(e.error || e.message), "err"); });
  window.addEventListener("unhandledrejection", function (e) { say("Unexpected error: " + errMsg(e.reason), "err"); });

  $("maxFileText").textContent = fmtBytes(MAX_FILE_BYTES).replace(".0", "");
  initEngine().then(function () { updateButtons(); renderFiles(); });
})();
