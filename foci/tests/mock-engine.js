// Tiny stand-in for window.FociEngine (the real one is written by the ENGINE agent and lives in foci/web/engine/).
// It follows the agreed contract closely enough to drive lab.js and the labcore tests, but its "analysis" is a toy:
// nuclei = 4-connected components above mean + 0.5 sd of the DNA channel, foci = local maxima of the foci channel
// above mean + 2 sd inside a nucleus. NEVER ship this file in foci/web.
(function (root) {
  "use strict";
  var DEFAULTS = { nucleus_sigma: 2, background_size: 41, min_nucleus_px: 150, foci_sigma: 1, tophat_size: 7, min_height: 12, peak_window: 5 };
  var opts = { delay: 250, webgpu: true, selfTest: true };

  function err(code, msg) { var e = new Error(msg); e.code = code; return e; }
  function stats(d) { var n = d.length, s = 0, q = 0, i; for (i = 0; i < n; i++) s += d[i]; var m = s / n; for (i = 0; i < n; i++) q += (d[i] - m) * (d[i] - m); return { mean: m, sd: Math.sqrt(q / n) }; }

  function analyzeSync(input) {
    var dna = input.dna, foci = input.foci, w = dna.width, h = dna.height;
    if (!foci || foci.width !== w || foci.height !== h) throw err("bad_input", "Channels differ in size.");
    if (w * h > 16e6) throw err("too_large", "Image too large.");
    var sd = stats(dna.data), thr = sd.mean + 0.5 * sd.sd, lab = new Int32Array(w * h), objs = [], n = 0, stack = [];
    var minPx = input.params.min_nucleus_px || 10;
    for (var s = 0; s < w * h; s++) {
      if (lab[s] || dna.data[s] <= thr) continue;
      var id = ++n, area = 0, sx = 0, sy = 0; stack.length = 0; stack.push(s); lab[s] = id;
      while (stack.length) {
        var p = stack.pop(), x = p % w, y = (p / w) | 0; area++; sx += x; sy += y;
        if (x > 0 && !lab[p - 1] && dna.data[p - 1] > thr) { lab[p - 1] = id; stack.push(p - 1); }
        if (x < w - 1 && !lab[p + 1] && dna.data[p + 1] > thr) { lab[p + 1] = id; stack.push(p + 1); }
        if (y > 0 && !lab[p - w] && dna.data[p - w] > thr) { lab[p - w] = id; stack.push(p - w); }
        if (y < h - 1 && !lab[p + w] && dna.data[p + w] > thr) { lab[p + w] = id; stack.push(p + w); }
      }
      if (area >= Math.min(minPx, 4)) objs.push({ id: id, area_px: area, cx: sx / area, cy: sy / area, foci: 0 }); else { n--; }
    }
    var fs = stats(foci.data), ft = fs.mean + 2 * fs.sd, pts = [], byId = {};
    objs.forEach(function (o) { byId[o.id] = o; });
    for (var y = 1; y < h - 1; y++) for (var x = 1; x < w - 1; x++) {
      var i = y * w + x, v = foci.data[i];
      if (v < ft || !lab[i] || !byId[lab[i]]) continue;
      if (v >= foci.data[i - 1] && v >= foci.data[i + 1] && v >= foci.data[i - w] && v >= foci.data[i + w] && v > foci.data[i - w - 1]) { pts.push({ x: x, y: y, height: v - fs.mean, object: lab[i] }); byId[lab[i]].foci++; }
    }
    var ov = new Uint8ClampedArray(w * h * 4), mx = 0, i2;
    for (i2 = 0; i2 < dna.data.length; i2++) if (dna.data[i2] > mx) mx = dna.data[i2];
    for (i2 = 0; i2 < w * h; i2++) { var g = mx ? (dna.data[i2] / mx) * 255 : 0; ov[4 * i2] = g * 0.3; ov[4 * i2 + 1] = g * 0.5; ov[4 * i2 + 2] = g; ov[4 * i2 + 3] = 255; }
    pts.forEach(function (p) { var k = (p.y * w + p.x) * 4; ov[k] = 255; ov[k + 1] = 176; ov[k + 2] = 32; });
    return {
      version: "mock-0.1", pipeline_version: "v1", backend: opts.webgpu ? "gpu" : "reference", timing_ms: { total: 5 }, image: { width: w, height: h },
      normalisation: { dna: "mock", foci: "mock", bit_depth: [dna.bitDepth, foci.bitDepth] },
      nuclei: { count: objs.length, objects: objs }, foci: { count: pts.length, per_cell: objs.map(function (o) { return o.foci; }), points: pts },
      params: input.params, warnings: pts.length > 50 ? ["mock: many foci"] : [], overlay: { width: w, height: h, data: ov }
    };
  }

  function analyze(input, o) {
    o = o || {};
    return new Promise(function (resolve, reject) {
      if (o.signal && o.signal.aborted) return reject(err("aborted", "aborted"));
      var t = setTimeout(function () {
        try { var r = analyzeSync(input); if (!o.overlay) delete r.overlay; resolve(r); } catch (e) { reject(e); }
      }, opts.delay);
      if (o.signal) o.signal.addEventListener("abort", function () { clearTimeout(t); reject(err("aborted", "aborted")); }, { once: true });
    });
  }

  var api = {
    version: "mock-0.1", _opts: opts,
    capabilities: function () { return Promise.resolve({ webgpu: opts.webgpu, adapter: opts.webgpu ? "Mock GPU" : null, selfTest: opts.selfTest, maxImagePixels: 16e6, hardwareConcurrency: 8 }); },
    defaultParams: function () { return Object.assign({}, DEFAULTS); },
    analyze: analyze,
    createPool: function (n) { return { size: n || 2, analyze: analyze, terminate: function () { api._terminated = (api._terminated || 0) + 1; } }; }
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.FociEngine = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
