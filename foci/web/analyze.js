// Foci Lab -- upload analyser client (analyze.html). Dependency-free.
// Nothing is sent until the user presses Analyse. The server processes the images
// in memory and stores nothing (docs/API.md, POST /api/foci/analyze).
(function (root) {
  "use strict";

  var RAILWAY = "https://telomore-production.up.railway.app/api/foci";
  var MAX_TOTAL_BYTES = 25 * 1024 * 1024;   // mirrors the server default; the server is the authority
  var EXT_OK = /\.(png|tif|tiff|jpg|jpeg)$/i;
  var TABLE_PREVIEW_ROWS = 200;

  // name, label, min, max, default, step, integer, odd, help
  var PARAMS = [
    { name: "min_nucleus_px", label: "Minimum nucleus size (px)", min: 20, max: 100000, def: 150, step: 10, int: true, odd: false,
      help: "Smaller objects are ignored. Roughly the area of your smallest nucleus in pixels." },
    { name: "background_size", label: "Background size (px, odd)", min: 11, max: 301, def: 41, step: 2, int: true, odd: true,
      help: "Must be larger than a nucleus' diameter; removes uneven illumination." },
    { name: "min_height", label: "Foci minimum height (grey levels 0-255)", min: 0.5, max: 255, def: 12, step: 0.5, int: false, odd: false,
      help: "How far a spot must rise above its local background. Raise it to count fewer, brighter foci." },
    { name: "tophat_size", label: "Top-hat size (px, odd)", min: 3, max: 51, def: 7, step: 2, int: true, odd: true,
      help: "Spots smaller than this are foci; larger structures are treated as background." },
    { name: "peak_window", label: "Peak window (px, odd)", min: 3, max: 31, def: 5, step: 2, int: true, odd: true,
      help: "One focus is counted per window of this size; lower it to split touching foci." }
  ];

  // ------------------------------------------------------------ pure helpers
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function fmtBytes(n) {
    if (!isFinite(n)) return "?";
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + " KB";
    return (n / 1024 / 1024).toFixed(1) + " MB";
  }

  // Mirror of the server's range checks so the user sees the problem before uploading.
  function validateParams(raw) {
    var errors = {}, clean = {};
    PARAMS.forEach(function (p) {
      var s = raw[p.name] == null ? "" : String(raw[p.name]).trim();
      if (s === "") { clean[p.name] = p.def; return; }
      var v = Number(s);
      if (!isFinite(v)) { errors[p.name] = p.label + " must be a number."; return; }
      if (p.int && Math.floor(v) !== v) { errors[p.name] = p.label + " must be a whole number."; return; }
      if (p.odd && v % 2 === 0) { errors[p.name] = p.label + " must be odd."; return; }
      if (v < p.min || v > p.max) { errors[p.name] = p.label + " must be between " + p.min + " and " + p.max + "."; return; }
      clean[p.name] = v;
    });
    return { ok: Object.keys(errors).length === 0, errors: errors, clean: clean };
  }

  // files: {name, size} objects (or null). Returns an error string or null.
  function checkFiles(dna, foci, maxBytes) {
    maxBytes = maxBytes || MAX_TOTAL_BYTES;
    if (!dna) return "Choose the DNA / nuclei image first.";
    var list = foci ? [dna, foci] : [dna];
    for (var i = 0; i < list.length; i++) {
      if (!EXT_OK.test(String(list[i].name || ""))) return "Only PNG, TIFF or JPEG files are accepted.";
      if (!(list[i].size > 0)) return "A chosen file is empty.";
    }
    var total = list.reduce(function (a, f) { return a + f.size; }, 0);
    if (total > maxBytes) return "The files total " + fmtBytes(total) + "; the limit is " + fmtBytes(maxBytes) + ".";
    if (!foci && !/\.tiff?$/i.test(dna.name)) {
      return "Choose the foci image too, or use one TIFF with two pages (page 1 = DNA, page 2 = foci).";
    }
    return null;
  }

  // Readable message for a failed request. detail is whatever the server said (untrusted text).
  function errorMessage(status, detail, retryAfter) {
    var d = detail ? String(detail).slice(0, 300) : "";
    var wait = retryAfter && isFinite(Number(retryAfter)) ? " Try again in about " + Math.ceil(Number(retryAfter)) + " s." : "";
    switch (status) {
      case 0: return "Could not reach the analysis server. Check your connection and try again.";
      case 400: return "The server could not read the upload" + (d ? ": " + d : ".");
      case 408: return "The upload took too long. Try a smaller file or a faster connection.";
      case 413: return "Too large: " + (d || "the upload exceeds the server limit.") + " Crop or downscale the image and try again.";
      case 415: return "Unsupported file type" + (d ? ": " + d : ". Use PNG, TIFF or JPEG.");
      case 422: return "The server rejected the input" + (d ? ": " + d : ".");
      case 429: return "Too many requests." + (wait || " Please wait a minute and try again.");
      case 503: return "The analyser is busy right now." + (wait || " Try again in a few seconds.");
      case 504: return "The analysis took too long. Use a smaller image.";
      default:
        return status >= 500 ? "The server had a problem (" + status + "). Try again later." : "Unexpected response (" + status + ")" + (d ? ": " + d : ".");
    }
  }

  function csvCell(v) {
    var s = v == null ? "" : String(v);
    if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s;   // spreadsheet formula guard
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  var CSV_COLS = ["id", "area_px", "centroid_x", "centroid_y", "nuclei_in_object", "foci"];
  function toCsv(rows) {
    var lines = [CSV_COLS.join(",")];
    (rows || []).forEach(function (r) {
      lines.push(CSV_COLS.map(function (c) { return csvCell(r[c]); }).join(","));
    });
    return lines.join("\r\n") + "\r\n";
  }

  // Counts of objects by foci number; the last bin collects everything >= maxBins-1.
  function histogramData(values, maxBins) {
    maxBins = maxBins || 20;
    var clean = (values || []).filter(function (v) { return isFinite(v) && v >= 0; }).map(function (v) { return Math.floor(v); });
    if (!clean.length) return { bins: [], total: 0, max: 0 };
    var top = Math.min(Math.max.apply(null, clean), maxBins - 1);
    var counts = [];
    for (var i = 0; i <= top; i++) counts.push(0);
    clean.forEach(function (v) { counts[Math.min(v, top)]++; });
    var bins = counts.map(function (c, i) {
      return { label: (i === top && Math.max.apply(null, clean) > top) ? i + "+" : String(i), count: c };
    });
    return { bins: bins, total: clean.length, max: Math.max.apply(null, counts) };
  }

  function histogramSvg(h) {
    if (!h.bins.length) return "<p class=\"note\">No nuclei detected.</p>";
    var W = 460, H = 220, L = 34, B = 30, T = 12, R = 8;
    var pw = W - L - R, ph = H - T - B, n = h.bins.length, bw = pw / n;
    var top = Math.max(h.max, 1);
    var parts = ["<svg viewBox=\"0 0 " + W + " " + H + "\" role=\"img\" aria-label=\"" +
      esc("Histogram: number of nuclear objects by foci count, " + h.total + " objects") + "\">"];
    parts.push("<line x1=\"" + L + "\" y1=\"" + (T + ph) + "\" x2=\"" + (W - R) + "\" y2=\"" + (T + ph) + "\"/>");
    parts.push("<text x=\"" + (L - 6) + "\" y=\"" + (T + 8) + "\" text-anchor=\"end\">" + esc(top) + "</text>");
    parts.push("<text x=\"" + (L - 6) + "\" y=\"" + (T + ph) + "\" text-anchor=\"end\">0</text>");
    h.bins.forEach(function (b, i) {
      var bh = b.count / top * ph, x = L + i * bw + bw * 0.12, w = bw * 0.76, y = T + ph - bh;
      parts.push("<rect class=\"bar\" x=\"" + x.toFixed(1) + "\" y=\"" + y.toFixed(1) + "\" width=\"" + w.toFixed(1) +
        "\" height=\"" + bh.toFixed(1) + "\"><title>" + esc(b.label + " foci: " + b.count + " objects") + "</title></rect>");
      if (n <= 12 || i % Math.ceil(n / 12) === 0) {
        parts.push("<text x=\"" + (x + w / 2).toFixed(1) + "\" y=\"" + (H - 14) + "\" text-anchor=\"middle\">" + esc(b.label) + "</text>");
      }
    });
    parts.push("<text x=\"" + (L + pw / 2) + "\" y=\"" + (H - 1) + "\" text-anchor=\"middle\">foci per object</text>");
    parts.push("</svg>");
    return parts.join("");
  }

  function safeBase64(s) {
    return typeof s === "string" && s.length > 100 && s.length < 40 * 1024 * 1024 && /^[A-Za-z0-9+\/]+={0,2}$/.test(s);
  }
  function num(v, d) {
    v = Number(v);
    return isFinite(v) ? (d == null ? String(v) : v.toFixed(d)) : "";
  }

  var api = {
    PARAMS: PARAMS, esc: esc, fmtBytes: fmtBytes, validateParams: validateParams, checkFiles: checkFiles,
    errorMessage: errorMessage, toCsv: toCsv, csvCell: csvCell, histogramData: histogramData,
    histogramSvg: histogramSvg, safeBase64: safeBase64, num: num, MAX_TOTAL_BYTES: MAX_TOTAL_BYTES
  };
  if (typeof module !== "undefined" && module.exports) { module.exports = api; }
  if (typeof document === "undefined") return;

  // ------------------------------------------------------------------- page
  var docEl = document.documentElement;
  try { var saved = localStorage.getItem("foci-theme"); if (saved) docEl.dataset.theme = saved; } catch (e) {}
  document.getElementById("themeBtn").addEventListener("click", function () {
    var dark = docEl.dataset.theme ? docEl.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
    docEl.dataset.theme = dark ? "light" : "dark";
    try { localStorage.setItem("foci-theme", docEl.dataset.theme); } catch (e) {}
  });

  // A local API override is honoured only when this page itself is served from localhost,
  // so a crafted link can never make the production page upload to another server.
  function apiBase() {
    var h = location.hostname;
    if (h === "localhost" || h === "127.0.0.1" || h === "[::1]") {
      var m = /[?&]api=(https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d{1,5})?\/api\/foci)(?:&|$)/.exec(location.search);
      if (m) return m[1];
    }
    return RAILWAY;
  }

  function $(id) { return document.getElementById(id); }
  var grid = $("paramGrid"), inputs = {};
  PARAMS.forEach(function (p) {
    var wrap = document.createElement("div");
    var lab = document.createElement("label");
    lab.setAttribute("for", "p_" + p.name);
    lab.textContent = p.label;
    var inp = document.createElement("input");
    inp.id = "p_" + p.name; inp.type = "number"; inp.inputMode = "decimal";
    inp.min = p.min; inp.max = p.max; inp.step = p.step; inp.value = p.def;
    var sm = document.createElement("small");
    sm.textContent = p.help + " Default " + p.def + ".";
    lab.appendChild(inp); wrap.appendChild(lab); wrap.appendChild(sm); grid.appendChild(wrap);
    inputs[p.name] = inp;
  });
  $("resetParams").addEventListener("click", function () {
    PARAMS.forEach(function (p) { inputs[p.name].value = p.def; inputs[p.name].classList.remove("bad"); });
  });

  function describe(input, out) {
    var f = input.files && input.files[0];
    out.textContent = f ? f.name + " (" + fmtBytes(f.size) + ")" : out.dataset.default;
  }
  ["dnaInfo", "fociInfo"].forEach(function (id) { $(id).dataset.default = $(id).textContent; });
  $("dnaFile").addEventListener("change", function () { describe(this, $("dnaInfo")); });
  $("fociFile").addEventListener("change", function () { describe(this, $("fociInfo")); });

  var status = $("status"), ctrl = null, timer = null;
  function setStatus(msg, cls) { status.textContent = msg || ""; status.className = "status" + (cls ? " " + cls : ""); }
  function busy(on) {
    $("goBtn").disabled = on; $("cancelBtn").hidden = !on; $("progress").hidden = !on;
    if (timer) { clearInterval(timer); timer = null; }
    if (on) {
      var t0 = Date.now();
      $("elapsed").textContent = "0 s";
      timer = setInterval(function () { $("elapsed").textContent = Math.round((Date.now() - t0) / 1000) + " s"; }, 500);
    }
  }

  $("cancelBtn").addEventListener("click", function () { if (ctrl) ctrl.abort(); });

  var lastRows = [];
  $("csvBtn").addEventListener("click", function () {
    var blob = new Blob([toCsv(lastRows)], { type: "text/csv;charset=utf-8" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url; a.download = "foci_per_nucleus.csv";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  });

  $("form").addEventListener("submit", function (ev) {
    ev.preventDefault();
    if (ctrl) return;
    var dna = $("dnaFile").files[0] || null, foci = $("fociFile").files[0] || null;
    var fe = checkFiles(dna, foci);
    if (fe) { setStatus(fe, "err"); return; }
    var raw = {};
    PARAMS.forEach(function (p) { raw[p.name] = inputs[p.name].value; });
    var v = validateParams(raw);
    PARAMS.forEach(function (p) { inputs[p.name].classList.toggle("bad", !!v.errors[p.name]); });
    if (!v.ok) {
      $("paramBox").open = true;
      setStatus(Object.keys(v.errors).map(function (k) { return v.errors[k]; })[0], "err");
      return;
    }
    var fd = new FormData();
    fd.append("dna", dna, "dna");            // the original file name is not sent
    if (foci) fd.append("foci", foci, "foci");
    PARAMS.forEach(function (p) { fd.append(p.name, String(v.clean[p.name])); });

    ctrl = new AbortController();
    $("results").hidden = true;
    busy(true);
    setStatus("Uploading and analysing... this can take up to a minute for large images.");
    var res;
    fetch(apiBase() + "/analyze", { method: "POST", body: fd, signal: ctrl.signal, credentials: "omit", cache: "no-store" })
      .then(function (r) {
        res = r;
        return r.text().then(function (t) { var j = null; try { j = JSON.parse(t); } catch (e) {} return j; });
      })
      .then(function (j) {
        if (!res.ok) {
          var d = j && typeof j.detail === "string" ? j.detail : "";
          setStatus(errorMessage(res.status, d, res.headers.get("Retry-After")), "err");
          return;
        }
        if (!j || j.validated !== false || !Array.isArray(j.table)) { setStatus("The server returned an unexpected answer.", "err"); return; }
        render(j);
        setStatus("Done.", "ok");
      })
      .catch(function (e) {
        if (e && e.name === "AbortError") setStatus("Cancelled. Nothing was kept on the server.");
        else setStatus(errorMessage(0), "err");
      })
      .then(function () { ctrl = null; busy(false); });
  });

  function tile(value, label) {
    var d = document.createElement("div"); d.className = "tile";
    var b = document.createElement("b"); b.textContent = value;
    var s = document.createElement("span"); s.textContent = label;
    d.appendChild(b); d.appendChild(s); return d;
  }

  function render(j) {
    lastRows = j.table.map(function (r) {
      var o = {}; ["id", "area_px", "centroid_x", "centroid_y", "nuclei_in_object", "foci"].forEach(function (k) { o[k] = num(r[k]); });
      return o;
    });
    $("resNote").textContent = "Exploratory count: not validated against manual counts. ";
    var tiles = $("tiles"); tiles.textContent = "";
    tiles.appendChild(tile(num(j.nuclei), "nuclei (estimated)"));
    tiles.appendChild(tile(num(j.objects), "nuclear objects"));
    tiles.appendChild(tile(num(j.foci), "foci"));
    tiles.appendChild(tile(j.foci_per_cell == null ? "n/a" : num(j.foci_per_cell, 2), "foci per nucleus"));

    var w = $("warnings"); w.textContent = "";
    (j.warnings || []).forEach(function (m) { var li = document.createElement("li"); li.textContent = String(m); w.appendChild(li); });

    var img = $("overlay");
    if (safeBase64(j.jpeg)) img.src = "data:image/jpeg;base64," + j.jpeg; else img.removeAttribute("src");
    var im = j.image || {};
    $("ovNote").textContent = "Image " + num(im.width) + " x " + num(im.height) + " px" +
      (Number(j.overlay_scale) < 1 ? "; overlay shown at " + Math.round(Number(j.overlay_scale) * 100) + "% size" : "") + ".";

    $("hist").innerHTML = histogramSvg(histogramData(lastRows.map(function (r) { return Number(r.foci); })));

    var t = $("tbl"); t.textContent = "";
    var head = t.createTHead().insertRow();
    ["#", "area (px)", "x", "y", "nuclei in object", "foci"].forEach(function (h) {
      var th = document.createElement("th"); th.scope = "col"; th.textContent = h; head.appendChild(th);
    });
    var body = t.createTBody();
    lastRows.slice(0, TABLE_PREVIEW_ROWS).forEach(function (r) {
      var tr = body.insertRow();
      ["id", "area_px", "centroid_x", "centroid_y", "nuclei_in_object", "foci"].forEach(function (k) {
        tr.insertCell().textContent = r[k];
      });
    });
    $("tblNote").textContent = lastRows.length > TABLE_PREVIEW_ROWS
      ? "Showing the first " + TABLE_PREVIEW_ROWS + " of " + lastRows.length + " rows; the CSV has all of them."
      : lastRows.length + " row(s)." + (j.table_truncated ? " The server truncated the table; counts above are complete." : "");
    $("csvBtn").disabled = lastRows.length === 0;

    var used = $("used"); used.textContent = "";
    PARAMS.forEach(function (p) {
      var dt = document.createElement("dt"), dd = document.createElement("dd");
      dt.textContent = p.label; dd.textContent = j.parameters ? num(j.parameters[p.name]) : "";
      used.appendChild(dt); used.appendChild(dd);
    });
    [["DNA image", im.dna], ["Foci image", im.foci]].forEach(function (pair) {
      var d = pair[1] || {};
      var dt = document.createElement("dt"), dd = document.createElement("dd");
      dt.textContent = pair[0];
      dd.textContent = (d.bit_depth ? d.bit_depth + "-bit" : "") + (d.normalisation ? "; " + d.normalisation : "") +
        (d.raw_lo != null ? "; raw range " + num(d.raw_lo, 0) + " to " + num(d.raw_hi, 0) : "");
      used.appendChild(dt); used.appendChild(dd);
    });
    var lim = $("limits"); lim.textContent = "";
    (j.limits || []).forEach(function (m) { var li = document.createElement("li"); li.textContent = String(m); lim.appendChild(li); });
    $("results").hidden = false;
    $("results").scrollIntoView({ behavior: "smooth", block: "start" });
  }
})(typeof window !== "undefined" ? window : globalThis);
