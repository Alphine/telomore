// Mock of window.FociEngine for the plate-mode walkthrough and tests (NOT the real engine).
// Counts exactly: nuclei = number of 255-valued pixels in the DNA channel, foci = number of 255-valued pixels in the
// 53BP1 channel (the synthetic stub images are drawn that way). Mirrors the contract in the task description:
// capabilities(), defaultParams(), analyze({dna, foci, params}, {mode, overlay, signal}), createPool(n).
(function (root) {
  "use strict";
  function abortError() { var e = new Error("aborted"); e.code = "aborted"; e.name = "AbortError"; return e; }
  var config = { delayMs: 15, gpuLostAfter: 0, calls: 0 };
  function count255(ch) { var n = 0, d = ch.data; for (var i = 0; i < d.length; i++) if (d[i] === 255) n++; return n; }
  function analyze(input, opts) {
    opts = opts || {};
    return new Promise(function (resolve, reject) {
      if (opts.signal && opts.signal.aborted) return reject(abortError());
      var ch = input && input.dna, fc = input && input.foci;
      if (!ch || !fc || ch.width !== fc.width || ch.height !== fc.height || !(ch.data instanceof Uint8Array)) { var b = new Error("bad input"); b.code = "bad_input"; return reject(b); }
      config.calls++;
      var t = setTimeout(function () {
        if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
        if (config.gpuLostAfter && config.calls === config.gpuLostAfter && opts.mode === "gpu") { var g = new Error("gpu lost"); g.code = "gpu_lost"; return reject(g); }
        var nuc = count255(ch), foc = count255(fc), backend = opts.mode === "gpu" ? "gpu" : "cpu";
        var res = { version: "mock-0.1", backend: backend, timing_ms: { total: config.delayMs }, nuclei: { count: nuc, objects: [] }, foci: { count: foc, per_cell: nuc ? foc / nuc : 0, points: [] }, warnings: [] };
        if (opts.overlay) {
          var px = new Uint8ClampedArray(ch.width * ch.height * 4);
          for (var i = 0; i < ch.data.length; i++) { px[4 * i] = fc.data[i]; px[4 * i + 1] = ch.data[i]; px[4 * i + 2] = 40; px[4 * i + 3] = 255; }
          res.overlay = { width: ch.width, height: ch.height, data: px };
        }
        resolve(res);
      }, config.delayMs);
      function onAbort() { clearTimeout(t); reject(abortError()); }
      if (opts.signal) opts.signal.addEventListener("abort", onAbort, { once: true });
    });
  }
  root.FociEngine = {
    capabilities: function () { return { webgpu: true, cpu: true, mock: true }; },
    defaultParams: function () { return { min_height: 12, sigma: 1 }; },
    analyze: analyze,
    createPool: function (n) {
      var alive = true;
      return { size: n || 2, analyze: function (i, o) { return alive ? analyze(i, o) : Promise.reject(abortError()); }, terminate: function () { alive = false; } };
    },
    __mock: config,
  };
})(typeof self !== "undefined" ? self : this);
