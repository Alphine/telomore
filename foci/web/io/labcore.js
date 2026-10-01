// FociLabCore -- pure (DOM-free, network-free) logic behind lab.html: file pairing, parameter validation,
// histograms and thumbnails, CSV and provenance builders, per-condition summaries.
(function (root) {
  "use strict";

  var LAB_VERSION = "1.0.0";

  // UI bounds. The five server parameters use the same bounds as analyze.js / backend/foci_upload.py;
  // the two sigmas are not exposed by the server so they get conservative bounds of their own.
  // The engine remains the authority and re-validates.
  var PARAM_SPECS = {
    nucleus_sigma:   { label: "Nucleus smoothing sigma (px)", min: 0.5, max: 10, step: 0.5, int: false, odd: false, help: "Gaussian blur of the nuclear channel before thresholding." },
    background_size: { label: "Background size (px, odd)", min: 11, max: 301, step: 2, int: true, odd: true, help: "Must be larger than a nucleus diameter; removes uneven illumination." },
    min_nucleus_px:  { label: "Minimum nucleus size (px)", min: 20, max: 100000, step: 10, int: true, odd: false, help: "Smaller objects are ignored." },
    foci_sigma:      { label: "Foci smoothing sigma (px)", min: 0.3, max: 5, step: 0.1, int: false, odd: false, help: "Gaussian blur of the foci channel before spot detection." },
    tophat_size:     { label: "Top-hat size (px, odd)", min: 3, max: 51, step: 2, int: true, odd: true, help: "Spots smaller than this are foci; larger structures count as background." },
    min_height:      { label: "Foci minimum height (grey levels 0-255)", min: 0.5, max: 255, step: 0.5, int: false, odd: false, help: "How far a spot must rise above local background after normalisation to 0-255." },
    peak_window:     { label: "Peak window (px, odd)", min: 3, max: 31, step: 2, int: true, odd: true, help: "One focus per window of this size; lower it to split touching foci." },
    // pipeline v2 (nucleus split) only
    sigma:            { label: "Nucleus smoothing sigma (px)", min: 0.1, max: 10, step: 0.1, int: false, odd: false, help: "Gaussian blur of the nuclear channel before thresholding (v2)." },
    thr_factor:       { label: "Threshold factor", min: 0.1, max: 3, step: 0.05, int: false, odd: false, help: "Multiplies the automatic (Otsu) nucleus threshold; lower makes nuclei larger (v2)." },
    split_sigma:      { label: "Split smoothing (px)", min: 0, max: 10, step: 0.25, int: false, odd: false, help: "Blur of the distance map used to find nucleus centres; 0 = none (v2)." },
    h:                { label: "Split depth h (px)", min: 0, max: 1000, step: 0.25, int: false, odd: false, help: "A dip in the distance map must be deeper than this to separate two nuclei; larger = fewer splits (v2)." },
    intensity_weight: { label: "Intensity weight in split", min: 0, max: 10, step: 0.1, int: false, odd: false, help: "Mixes smoothed DNA brightness into the split surface; 0 = shape only (v2)." },
    intensity_sigma:  { label: "Intensity smoothing (px)", min: 0.1, max: 10, step: 0.1, int: false, odd: false, help: "Blur of the DNA channel for that brightness term (v2)." }
  };
  var PARAM_ORDER = ["nucleus_sigma", "sigma", "background_size", "thr_factor", "min_nucleus_px", "split_sigma", "h", "intensity_weight", "intensity_sigma",
    "foci_sigma", "tophat_size", "min_height", "peak_window"];

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; });
  }
  function cleanLabel(s, n) { return String(s == null ? "" : s).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, n || 80); }

  // ------------------------------------------------------------ parameters
  function validateParams(raw, defaults) {
    var errors = {}, clean = {};
    Object.keys(defaults).forEach(function (k) {
      var sp = PARAM_SPECS[k] || { label: k, min: -Infinity, max: Infinity, int: false, odd: false };
      var s = raw[k] == null ? "" : String(raw[k]).trim();
      if (s === "") { clean[k] = defaults[k]; return; }
      var v = Number(s);
      if (!isFinite(v)) { errors[k] = sp.label + " must be a number."; return; }
      if (sp.int && Math.floor(v) !== v) { errors[k] = sp.label + " must be a whole number."; return; }
      if (sp.odd && Math.abs(v) % 2 !== 1) { errors[k] = sp.label + " must be odd."; return; }
      if (v < sp.min || v > sp.max) { errors[k] = sp.label + " must be between " + sp.min + " and " + sp.max + "."; return; }
      clean[k] = v;
    });
    return { ok: Object.keys(errors).length === 0, errors: errors, clean: clean };
  }

  // Accepts a flat {param: value} object or an exported {params: {...}} document.
  function parseParamsJSON(text, defaults) {
    var doc;
    if (String(text).length > 100000) return { ok: false, error: "That file is too large to be a parameter file." };
    try { doc = JSON.parse(text); } catch (e) { return { ok: false, error: "Not valid JSON." }; }
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) return { ok: false, error: "Expected a JSON object of parameters." };
    var src = doc.params && typeof doc.params === "object" ? doc.params : doc;
    var raw = {}, unknown = [];
    Object.keys(src).forEach(function (k) {
      if (Object.prototype.hasOwnProperty.call(defaults, k) && (typeof src[k] === "number" || typeof src[k] === "string")) raw[k] = src[k];
      else if (k !== "schema" && k !== "engine_version" && k !== "saved_at" && k !== "note" && k !== "pipeline") unknown.push(cleanLabel(k, 40));
    });
    if (!Object.keys(raw).length) return { ok: false, error: "No known parameters found in that file." };
    var v = validateParams(raw, defaults);
    return { ok: v.ok, errors: v.errors, clean: v.clean, provided: Object.keys(raw).length, unknown: unknown, error: v.ok ? null : Object.keys(v.errors).map(function (k) { return v.errors[k]; }).join(" ") };
  }

  function paramsToJSON(params, engineVersion, pipeline) {
    return JSON.stringify({ schema: "foci-lab-params/1", engine_version: engineVersion || null, pipeline: pipeline || "v1", saved_at: new Date().toISOString(), params: params }, null, 2);
  }

  // Presets are relative to whatever the engine currently reports as defaults (no invented numbers).
  function presetParams(id, defaults) {
    var p = Object.assign({}, defaults);
    function clampTo(k, v) { var sp = PARAM_SPECS[k]; if (!sp) return v; v = Math.min(sp.max, Math.max(sp.min, v)); return sp.odd ? (Math.round((v - 1) / 2) * 2 + 1) : v; }
    if (id === "strict" && "min_height" in p) p.min_height = clampTo("min_height", defaults.min_height * 2);
    else if (id === "loose" && "min_height" in p) p.min_height = clampTo("min_height", defaults.min_height * 0.5);
    return p;
  }

  // ------------------------------------------------------------ pairing
  var PAIR_PRESETS = [
    { id: "dapi_53bp1", label: "DAPI / 53BP1, gH2AX", nuclei: "DAPI, Hoechst", foci: "53BP1, gH2AX, H2AX, foci" },
    { id: "c1c2", label: "_c1 / _c2", nuclei: "_c1", foci: "_c2" },
    { id: "ch", label: "_ch00 / _ch01", nuclei: "_ch00", foci: "_ch01" },
    { id: "w", label: "_w1 / _w2", nuclei: "_w1", foci: "_w2" },
    { id: "c0c1", label: "C0 / C1 (ZEN-style)", nuclei: "C0-, _C0", foci: "C1-, _C1" }
  ];

  function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
  function splitTokens(s) { return String(s || "").split(/[,;\n]/).map(function (t) { return t.trim(); }).filter(function (t) { return t.length > 0 && t.length <= 40; }).slice(0, 12); }
  function tokenRe(tokens) {
    if (!tokens.length) return null;
    return new RegExp("(" + tokens.map(function (t) { return escRe(t) + (/\d$/.test(t) ? "(?!\\d)" : ""); }).join("|") + ")", "i");
  }
  function splitPath(name) {
    var n = String(name).replace(/\\/g, "/"), i = n.lastIndexOf("/");
    return { dir: i >= 0 ? n.slice(0, i) : "", base: i >= 0 ? n.slice(i + 1) : n };
  }
  function stripExt(b) { return b.replace(/\.(ome\.tiff?|tiff?|png|jpe?g)$/i, ""); }

  // rules: {nuclei: "DAPI, Hoechst", foci: "53BP1, gH2AX"}
  function classifyName(name, rules) {
    var base = stripExt(splitPath(name).base), ne = tokenRe(splitTokens(rules.nuclei)), fe = tokenRe(splitTokens(rules.foci));
    var isN = !!(ne && ne.test(base)), isF = !!(fe && fe.test(base));
    if (isN && isF) return "ambiguous";
    return isN ? "nuclei" : isF ? "foci" : null;
  }
  // Shared part of a name once the role word (and the separators around it) is removed; original case kept.
  function pairLabel(name, role, rules) {
    var sp = splitPath(name), base = stripExt(sp.base);
    var re = tokenRe(splitTokens(role === "nuclei" ? rules.nuclei : rules.foci));
    var k = re ? base.replace(re, "\u0001") : base;
    k = k.replace(/[\u0001]+([_\-. ]*)/, "").replace(/[_\-. ]{2,}/g, "_").replace(/^[_\-. ]+|[_\-. ]+$/g, "");
    return (sp.dir ? sp.dir + "/" : "") + (k || stripExt(sp.base));
  }

  // files: [{id, name}] (name may be a relative path). Returns {pairs:[{key,nucleiId,fociId}], nucleiOnly:[id], fociOnly:[id], other:[id], ambiguous:[id]}
  function pairFiles(files, rules) {
    var nuc = {}, foc = {}, res = { pairs: [], nucleiOnly: [], fociOnly: [], other: [], ambiguous: [] }, order = [];
    var labels = {};
    files.forEach(function (f) {
      var role = classifyName(f.name, rules);
      if (role === "ambiguous") { res.ambiguous.push(f.id); return; }
      if (!role) { res.other.push(f.id); return; }
      var label = pairLabel(f.name, role, rules), key = label.toLowerCase(), map = role === "nuclei" ? nuc : foc;
      if (!(key in nuc) && !(key in foc)) { order.push(key); labels[key] = label; }
      (map[key] = map[key] || []).push(f.id);
    });
    order.forEach(function (key) {
      var a = nuc[key] || [], b = foc[key] || [];
      var n = Math.max(a.length, b.length);
      for (var i = 0; i < n; i++) {
        if (a[i] != null && b[i] != null) res.pairs.push({ key: key + (n > 1 ? "#" + (i + 1) : ""), label: labels[key] + (n > 1 ? " #" + (i + 1) : ""), nucleiId: a[i], fociId: b[i] });
        else if (a[i] != null) res.nucleiOnly.push(a[i]); else res.fociOnly.push(b[i]);
      }
    });
    return res;
  }

  var NUC_RE = /dapi|hoechst|nucle|dna|\bblue\b/i, FOC_RE = /53bp1|h2ax|gh2ax|foci|fitc|green|alexa|488|cy3|red|568|594/i;
  function guessChannels(names) {
    var n = -1, f = -1, i;
    for (i = 0; i < names.length; i++) if (n < 0 && NUC_RE.test(names[i])) n = i;
    for (i = 0; i < names.length; i++) if (f < 0 && i !== n && FOC_RE.test(names[i])) f = i;
    if (n < 0) n = 0;
    if (f < 0) f = n === 0 ? 1 : 0;
    return { nuclei: n, foci: names.length > 1 ? f : -1 };
  }

  // ------------------------------------------------------------ pixel statistics
  // Single pass for the range, second pass for a 4096-bin histogram over [min, max].
  function channelStats(data) {
    var n = data.length, mn = Infinity, mx = -Infinity, i, v;
    for (i = 0; i < n; i++) { v = data[i]; if (v === v && v !== Infinity && v !== -Infinity) { if (v < mn) mn = v; if (v > mx) mx = v; } }
    if (mn === Infinity) return { min: 0, max: 0, p001: 0, p9999: 0, bins: new Uint32Array(256), n: n, flat: true };
    var B = 4096, hist = new Uint32Array(B), span = mx - mn;
    if (span > 0) { var sc = (B - 1) / span; for (i = 0; i < n; i++) { v = data[i]; if (v === v && v !== Infinity && v !== -Infinity) hist[((v - mn) * sc) | 0]++; } }
    else hist[0] = n;
    function pct(q) {
      var target = q * n, acc = 0;
      for (var b = 0; b < B; b++) { acc += hist[b]; if (acc >= target) return mn + (b / (B - 1)) * span; }
      return mx;
    }
    var coarse = new Uint32Array(256);
    for (var b = 0; b < B; b++) coarse[b >> 4] += hist[b];
    return { min: mn, max: mx, p001: pct(0.001), p9999: pct(0.9999), bins: coarse, n: n, flat: span === 0 };
  }

  // Display-only downsample (block mean) with a linear stretch lo..hi -> 0..255. Returns RGBA.
  function thumbnail(data, w, h, maxDim, lo, hi) {
    var f = Math.max(1, Math.ceil(Math.max(w, h) / maxDim)), tw = Math.ceil(w / f), th = Math.ceil(h / f);
    var out = new Uint8ClampedArray(tw * th * 4), span = hi > lo ? hi - lo : 1;
    for (var ty = 0; ty < th; ty++) {
      var y0 = ty * f, y1 = Math.min(h, y0 + f);
      for (var tx = 0; tx < tw; tx++) {
        var x0 = tx * f, x1 = Math.min(w, x0 + f), s = 0, c = 0;
        for (var y = y0; y < y1; y++) { var row = y * w; for (var x = x0; x < x1; x++) { var v = data[row + x]; if (v === v) { s += v; c++; } } }
        var g = c ? ((s / c - lo) / span) * 255 : 0, o = (ty * tw + tx) * 4;
        out[o] = out[o + 1] = out[o + 2] = g; out[o + 3] = 255;
      }
    }
    return { width: tw, height: th, rgba: out, factor: f };
  }

  // ------------------------------------------------------------ results -> numbers
  function nucleusCounts(result) {
    var objs = result && result.nuclei && result.nuclei.objects;
    if (Array.isArray(objs) && objs.length && typeof objs[0].foci === "number") return objs.map(function (o) { return o.foci; });
    var pc = result && result.foci && result.foci.per_cell;
    if (Array.isArray(pc) && pc.length && typeof pc[0] === "number") return pc.slice();
    return [];
  }
  function summarise(result) {
    var counts = nucleusCounts(result), nN = result.nuclei && result.nuclei.count != null ? result.nuclei.count : counts.length;
    var nF = result.foci && result.foci.count != null ? result.foci.count : counts.reduce(function (a, b) { return a + b; }, 0);
    var withF = counts.filter(function (c) { return c > 0; }).length;
    var sorted = counts.slice().sort(function (a, b) { return a - b; });
    var med = sorted.length ? (sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2) : null;
    return { nuclei: nN, foci: nF, fociPerNucleus: nN ? nF / nN : null, median: med, pctWithFoci: counts.length ? 100 * withF / counts.length : null };
  }

  // ------------------------------------------------------------ CSV
  function csvCell(v) {
    if (v == null) return "";
    if (typeof v === "number") return isFinite(v) ? String(Number.isInteger(v) ? v : Number(v.toPrecision(10))) : "";
    var s = String(v).replace(/\r?\n/g, " ");
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;                   // spreadsheet formula injection guard
    return /[",]/.test(s) || s !== s.trim() ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function toCsv(header, rows) {
    return header.join(",") + "\r\n" + rows.map(function (r) { return r.map(csvCell).join(","); }).join("\r\n") + (rows.length ? "\r\n" : "");
  }
  function pipelineOf(r) { return (r.result && r.result.pipeline_version) || null; }
  // records: done records only
  function perNucleusCsv(records) {
    var rows = [];
    records.forEach(function (r) {
      var objs = (r.result && r.result.nuclei && r.result.nuclei.objects) || [], px = r.pixelSizeUm;
      objs.forEach(function (o) {
        rows.push([r.name, r.condition, r.replicate, o.id, o.area_px, px ? o.area_px * px * px : null, o.cx, o.cy, o.foci, pipelineOf(r)]);
      });
    });
    return toCsv(["image", "condition", "replicate", "nucleus_id", "area_px", "area_um2", "centroid_x_px", "centroid_y_px", "foci", "pipeline_version"], rows);
  }
  function perImageCsv(records) {
    var rows = records.map(function (r) {
      var s = r.summary || {};
      return [r.name, r.condition, r.replicate, r.nuclei && r.nuclei.file.name, r.nuclei && r.nuclei.channel.name, r.foci && r.foci.file.name, r.foci && r.foci.channel.name,
        r.width, r.height, r.pixelSizeUm, r.status, s.nuclei, s.foci, s.fociPerNucleus, s.median, s.pctWithFoci, r.backend, r.engineVersion, r.timing_ms, (r.warnings || []).join(" | ") || (r.error || ""), pipelineOf(r)];
    });
    return toCsv(["image", "condition", "replicate", "nuclei_file", "nuclei_channel", "foci_file", "foci_channel", "width_px", "height_px", "pixel_size_um", "status",
      "nuclei", "foci_total", "foci_per_nucleus", "median_foci_per_nucleus", "pct_nuclei_with_foci", "backend", "engine_version", "time_ms", "warnings_or_error", "pipeline_version"], rows);
  }

  // ------------------------------------------------------------ conditions
  function mean(a) { return a.length ? a.reduce(function (x, y) { return x + y; }, 0) / a.length : null; }
  function sd(a) { if (a.length < 2) return null; var m = mean(a); return Math.sqrt(a.reduce(function (x, y) { return x + (y - m) * (y - m); }, 0) / (a.length - 1)); }

  function conditionSummary(records) {
    var groups = {}, order = [], warnings = [];
    records.forEach(function (r) {
      if (r.status !== "done" || !r.summary || r.summary.fociPerNucleus == null) return;
      var c = cleanLabel(r.condition, 60) || "(no condition)";
      if (!groups[c]) { groups[c] = []; order.push(c); }
      groups[c].push(r);
    });
    var out = order.map(function (c) {
      var rs = groups[c], imgMeans = rs.map(function (r) { return r.summary.fociPerNucleus; });
      var nN = rs.reduce(function (a, r) { return a + r.summary.nuclei; }, 0), nF = rs.reduce(function (a, r) { return a + r.summary.foci; }, 0);
      var reps = {}, repOrder = [];
      rs.forEach(function (r) { var k = cleanLabel(r.replicate, 60); if (!k) return; if (!reps[k]) { reps[k] = []; repOrder.push(k); } reps[k].push(r.summary.fociPerNucleus); });
      var repMeans = repOrder.map(function (k) { return mean(reps[k]); });
      return { condition: c, images: rs.length, nuclei: nN, foci: nF, pooled: nN ? nF / nN : null,
        imageMean: mean(imgMeans), imageSd: sd(imgMeans), replicates: repOrder.length, replicateMean: repMeans.length ? mean(repMeans) : null, replicateSd: sd(repMeans),
        unlabelled: rs.filter(function (r) { return !cleanLabel(r.replicate, 60); }).length };
    });
    if (out.length) {
      warnings.push("Fields of view from the same well, dish or slide are technical replicates, not independent replicates. Mean ± SD across images describes the images you chose, not biological variation; do not use it for a significance test.");
      out.forEach(function (g) {
        if (g.unlabelled) warnings.push("Condition '" + g.condition + "': " + g.unlabelled + " image(s) have no replicate label, so only image-level statistics are shown for them.");
        else if (g.replicates < 3) warnings.push("Condition '" + g.condition + "' has " + g.replicates + " labelled biological replicate(s); at least 3 are usually needed before comparing conditions.");
      });
      if (out.length === 1) warnings.push("Only one condition is labelled, so there is nothing to compare; label your controls and treated images to get a comparison.");
    }
    return { groups: out, warnings: warnings };
  }

  // ------------------------------------------------------------ backend badge text
  function describeBackend(caps, engineVersion) {
    if (!caps) return { kind: "none", text: "Analysis engine not loaded", selfTest: "unknown" };
    var st = caps.selfTest;
    var selfTest = st === true || st === "passed" || st === "pass" || (st && st.ok === true) || (st && st.passed === true) ? "passed"
      : st === false || st === "failed" || st === "fail" || (st && (st.ok === false || st.passed === false)) ? "failed" : "not run";
    var gpu = !!caps.webgpu && selfTest !== "failed";
    var adapter = caps.adapter && typeof caps.adapter === "object" ? (caps.adapter.description || caps.adapter.vendor || "") : (caps.adapter || "");
    return { kind: gpu ? "gpu" : "cpu", text: (gpu ? "GPU (WebGPU)" : "CPU (reference)") + " · engine " + cleanLabel(engineVersion || "?", 20) + " · self-test " + selfTest, adapter: cleanLabel(adapter, 80), selfTest: selfTest };
  }

  // ------------------------------------------------------------ provenance
  function fileEntry(f) {
    return { name: f.name, size_bytes: f.size, sha256: f.sha256, format: f.format, container: f.container ? { name: f.container.name, sha256: f.container.sha256 } : null };
  }
  function buildProvenance(ctx) {
    var recs = ctx.records.map(function (r) {
      return {
        image: r.name, condition: r.condition || null, replicate: r.replicate || null, status: r.status,
        nuclei: r.nuclei ? { file: fileEntry(r.nuclei.file), channel_index: r.nuclei.channel.index, channel_name: r.nuclei.channel.name, bit_depth: r.nuclei.channel.bitDepth } : null,
        foci: r.foci ? { file: fileEntry(r.foci.file), channel_index: r.foci.channel.index, channel_name: r.foci.channel.name, bit_depth: r.foci.channel.bitDepth } : null,
        width_px: r.width || null, height_px: r.height || null, pixel_size_um: r.pixelSizeUm || null,
        backend: r.backend || null, engine_version: r.engineVersion || null, pipeline_version: pipelineOf(r), time_ms: r.timing_ms == null ? null : r.timing_ms,
        normalisation: r.result ? r.result.normalisation || null : null,
        parameters_used: r.result && r.result.params ? r.result.params : null,
        counts: r.summary ? { nuclei: r.summary.nuclei, foci: r.summary.foci } : null,
        reader_warnings: r.readWarnings || [], engine_warnings: r.result && r.result.warnings ? r.result.warnings : [], error: r.error || null
      };
    });
    return {
      schema: "foci-lab-provenance/1",
      generated_at: (ctx.now || new Date()).toISOString(),
      page: { name: "Foci Lab browser lab", version: ctx.pageVersion, io_version: ctx.ioVersion, url: ctx.pageUrl || null },
      privacy: "Computed entirely in this browser tab. No image or result was uploaded. File identity is given by SHA-256 of the file bytes, computed in the browser.",
      engine: { version: ctx.engineVersion || null, pipeline_version: ctx.pipeline || null, mode_requested: ctx.mode, backends_used: Array.from(new Set(recs.map(function (r) { return r.backend; }).filter(Boolean))), capabilities: ctx.capabilities || null, worker_pool_size: ctx.poolSize || null },
      parameters: ctx.params, parameter_defaults: ctx.defaults,
      environment: { user_agent: ctx.userAgent || null, hardware_concurrency: ctx.hardwareConcurrency || null },
      images: recs,
      caveats: [
        "Classical, exploratory counter; NOT validated against manual counts (Experiments L and L2).",
        "Pipeline v2 only changes how touching nuclei are separated; the foci counting step is identical and still unvalidated. A better nucleus count is not evidence of a more accurate focus count.",
        "53BP1 and gamma-H2AX foci mark DNA double-strand breaks anywhere in the genome; they are not telomere-specific.",
        "Tune parameters on your own positive and negative controls before trusting a number.",
        "Images from one well or dish are technical, not independent, replicates."
      ]
    };
  }

  var api = { LAB_VERSION: LAB_VERSION, PARAM_SPECS: PARAM_SPECS, PARAM_ORDER: PARAM_ORDER, PAIR_PRESETS: PAIR_PRESETS, esc: esc, cleanLabel: cleanLabel,
    validateParams: validateParams, parseParamsJSON: parseParamsJSON, paramsToJSON: paramsToJSON, presetParams: presetParams,
    splitTokens: splitTokens, classifyName: classifyName, pairFiles: pairFiles, guessChannels: guessChannels,
    channelStats: channelStats, thumbnail: thumbnail, nucleusCounts: nucleusCounts, summarise: summarise,
    csvCell: csvCell, toCsv: toCsv, perNucleusCsv: perNucleusCsv, perImageCsv: perImageCsv, conditionSummary: conditionSummary,
    describeBackend: describeBackend, buildProvenance: buildProvenance };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.FociLabCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
