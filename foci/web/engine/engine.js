/*
 * Foci Lab analysis engine -- runs entirely in the user's browser (or Node, for tests).
 *
 *   Classic script: defines window.FociEngine (and module.exports under Node).
 *   No network access of any kind, no eval / Function, no dependencies, no build step.
 *
 * It reproduces src/telomere_lab/foci/segment.py (count_foci, estimate_nuclei,
 * overlay_rgb) and the input normalisation of backend/foci_upload.py (to_signal).
 *
 *   'reference' mode  plain JS on Float64 arithmetic with float32 *storage* at exactly the
 *                     places numpy/scipy store float32 -> results equal the Python ones
 *                     (see foci/docs/ENGINE.md for the evidence and the one residual risk).
 *   'gpu' mode        WebGPU (f32) for the per-pixel filters; thresholds, morphology,
 *                     labelling and all counting stay on the CPU with the same code.
 *
 * Read foci/docs/ENGINE.md before changing anything here.
 */
(function (root) {
  'use strict';

  var VERSION = '1.1.0';
  var IS_NODE = typeof process !== 'undefined' && !!(process.versions && process.versions.node);
  var SCRIPT_URL = (function () {
    try {
      if (typeof document !== 'undefined' && document.currentScript && document.currentScript.src) return document.currentScript.src;
    } catch (e) { /* ignore */ }
    return null;
  })();

  var DEFAULT_MAX_PIXELS = 16e6;           // per channel
  var DEFAULT_MAX_MEMORY = 1.6e9;          // bytes of engine working memory (estimated before allocating)
  var MAX_SIDE = 65535;
  var AUTO_GPU_MIN_PIXELS = 2e6;           // 'auto' uses the GPU at or above this many pixels per channel ...
  var AUTO_GPU_MIN_BATCH_PIXELS = 0.25e6;  // ... or, with opts.batchSize >= AUTO_GPU_BATCH, at or above this
  var AUTO_GPU_BATCH = 8;

  // ------------------------------------------------------------------------ errors

  function fail(code, message) {
    var e = new Error(message);
    e.code = code;
    return e;
  }

  // ----------------------------------------------------------------------- params

  // Mirrors FociParams in segment.py (names + defaults) ...
  var DEFAULTS = Object.freeze({
    nucleus_sigma: 2.0,
    background_size: 41,
    min_nucleus_px: 150,
    foci_sigma: 1.0,
    tophat_size: 7,
    min_height: 12.0,
    peak_window: 5,
  });
  // ... and the accepted ranges: the five tunable ones equal PARAM_SPECS in backend/foci_upload.py;
  // the two sigmas are not tunable on the server, so the range here is our own safety bound.
  var SPECS = {
    nucleus_sigma: { int: false, odd: false, lo: 0.1, hi: 10 },
    background_size: { int: true, odd: true, lo: 11, hi: 301 },
    min_nucleus_px: { int: true, odd: false, lo: 20, hi: 100000 },
    foci_sigma: { int: false, odd: false, lo: 0.1, hi: 10 },
    tophat_size: { int: true, odd: true, lo: 3, hi: 51 },
    min_height: { int: false, odd: false, lo: 0.5, hi: 255 },
    peak_window: { int: true, odd: true, lo: 3, hi: 31 },
  };

  // Pipeline "v2" (segment_v2.py, NucleusV2Params): the nucleus parameters differ, the four foci parameters are shared.
  var DEFAULTS_V2 = Object.freeze(Object.assign({
    sigma: 1.0,
    background_size: 41,
    thr_factor: 0.8,
    min_nucleus_px: 60,
    split_sigma: 1.0,
    h: 0.5,
    intensity_weight: 0.0,
    intensity_sigma: 2.0,
  }, { foci_sigma: 1.0, tophat_size: 7, min_height: 12.0, peak_window: 5 }));
  var SPECS_V2 = {
    sigma: { int: false, odd: false, lo: 0.1, hi: 10 },
    background_size: SPECS.background_size,
    thr_factor: { int: false, odd: false, lo: 0.1, hi: 3 },
    min_nucleus_px: { int: true, odd: false, lo: 1, hi: 100000 },
    split_sigma: { int: false, odd: false, lo: 0, hi: 10 },
    h: { int: false, odd: false, lo: 0, hi: 1000 },
    intensity_weight: { int: false, odd: false, lo: 0, hi: 10 },
    intensity_sigma: { int: false, odd: false, lo: 0.1, hi: 10 },
    foci_sigma: SPECS.foci_sigma,
    tophat_size: SPECS.tophat_size,
    min_height: SPECS.min_height,
    peak_window: SPECS.peak_window,
  };

  function defaultParams(pipeline) {
    var o = {}, src = pipeline === 'v2' ? DEFAULTS_V2 : DEFAULTS;
    for (var k in src) o[k] = src[k];
    return o;
  }

  function resolveParams(partial, pipeline) {
    var p = defaultParams(pipeline), specs = pipeline === 'v2' ? SPECS_V2 : SPECS;
    if (partial === undefined || partial === null) return p;
    if (typeof partial !== 'object' || Array.isArray(partial)) throw fail('bad_input', 'params must be an object');
    Object.keys(partial).forEach(function (k) {
      if (!Object.prototype.hasOwnProperty.call(specs, k)) throw fail('bad_input', 'unknown parameter' + (pipeline === 'v2' ? ' for pipeline v2' : '') + ': ' + k);
      var v = partial[k];
      var s = specs[k];
      if (typeof v !== 'number' || !isFinite(v)) throw fail('bad_input', k + ' must be a finite number');
      if (s.int && Math.floor(v) !== v) throw fail('bad_input', k + ' must be a whole number');
      if (s.odd && v % 2 === 0) throw fail('bad_input', k + ' must be an odd number');
      if (v < s.lo || v > s.hi) throw fail('bad_input', k + ' must be between ' + s.lo + ' and ' + s.hi);
      p[k] = v;
    });
    return p;
  }

  // ------------------------------------------------------------------ input checks

  var TYPE_FOR_DEPTH = { 8: '[object Uint8Array]', 12: '[object Uint16Array]', 16: '[object Uint16Array]', 32: '[object Float32Array]' };

  function checkChannel(ch, name, maxPixels) {
    if (!ch || typeof ch !== 'object') throw fail('bad_input', name + ' channel is missing');
    var w = ch.width, h = ch.height, d = ch.bitDepth;
    if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1) throw fail('bad_input', name + ': width and height must be positive integers');
    if (w > MAX_SIDE || h > MAX_SIDE) throw fail('too_large', name + ': ' + w + 'x' + h + ' exceeds the maximum edge length of ' + MAX_SIDE + ' px');
    if (w * h > maxPixels) {
      throw fail('too_large', name + ': ' + w + 'x' + h + ' = ' + (w * h / 1e6).toFixed(1) + ' Mpx exceeds the limit of ' + (maxPixels / 1e6) + ' Mpx');
    }
    if (!Object.prototype.hasOwnProperty.call(TYPE_FOR_DEPTH, d)) throw fail('bad_input', name + ': bitDepth must be 8, 12, 16 or 32');
    var tag = Object.prototype.toString.call(ch.data);
    var okTag = tag === TYPE_FOR_DEPTH[d] || (d === 8 && tag === '[object Uint8ClampedArray]');
    if (!okTag) throw fail('bad_input', name + ': data must be a ' + TYPE_FOR_DEPTH[d].slice(8, -1) + ' for bitDepth ' + d + ' (got ' + tag.slice(8, -1) + ')');
    if (ch.data.length !== w * h) throw fail('bad_input', name + ': data length ' + ch.data.length + ' does not match ' + w + 'x' + h);
    return { width: w, height: h, bitDepth: d };
  }

  // one scan: integer range check (12-bit) / finiteness (32-bit)
  function scanValues(ch, name) {
    var data = ch.data, n = data.length, i;
    if (ch.bitDepth === 32) {
      for (i = 0; i < n; i++) if (!(data[i] - data[i] === 0)) throw fail('bad_input', name + ': non-finite pixel value at index ' + i);
    } else if (ch.bitDepth === 12) {
      for (i = 0; i < n; i++) if (data[i] > 4095) throw fail('bad_input', name + ': value ' + data[i] + ' exceeds 12 bits');
    }
  }

  function memoryEstimate(w, h, overlay, pipeline) {
    // Float32 A + B (8), normalisation sort copy transient (4), masks/scratch (3), labels (4), stack worst case (4),
    // peak mask (1), + overlay RGBA (4) and a re-normalised channel (4).
    var perPx = 8 + 4 + 3 + 4 + 4 + 1 + (overlay ? 8 : 0);
    if (pipeline === 'v2') perPx += 8 + 8 + 4 + 8 + 4 + 4;     // + v2: distance planes (Float64), surface, copy of the DNA, order, parents
    return w * h * perPx;
  }

  // ------------------------------------------------------------ numpy-compatible bits

  // numpy's pairwise summation (npy DOUBLE_pairwise_sum) -- the order matters for bit-exact kernels
  function pairwiseSum(a, off, n) {
    var i, res;
    if (n < 8) {
      res = 0;
      for (i = 0; i < n; i++) res += a[off + i];
      return res;
    }
    if (n <= 128) {
      var r0 = a[off], r1 = a[off + 1], r2 = a[off + 2], r3 = a[off + 3];
      var r4 = a[off + 4], r5 = a[off + 5], r6 = a[off + 6], r7 = a[off + 7];
      for (i = 8; i < n - (n % 8); i += 8) {
        r0 += a[off + i]; r1 += a[off + i + 1]; r2 += a[off + i + 2]; r3 += a[off + i + 3];
        r4 += a[off + i + 4]; r5 += a[off + i + 5]; r6 += a[off + i + 6]; r7 += a[off + i + 7];
      }
      res = ((r0 + r1) + (r2 + r3)) + ((r4 + r5) + (r6 + r7));
      for (; i < n; i++) res += a[off + i];
      return res;
    }
    var n2 = Math.floor(n / 2);
    n2 -= n2 % 8;
    return pairwiseSum(a, off, n2) + pairwiseSum(a, off + n2, n - n2);
  }

  // scipy.ndimage._filters._gaussian_kernel1d(sigma, 0, radius) with truncate=4.0
  function gaussKernel(sigma) {
    var sd = +sigma;
    var r = Math.trunc(4.0 * sd + 0.5);
    var n = 2 * r + 1;
    var phi = new Float64Array(n);
    var c = -0.5 / (sd * sd);
    for (var i = 0; i < n; i++) {
      var x = i - r;
      phi[i] = Math.exp(c * (x * x));
    }
    var s = pairwiseSum(phi, 0, n);
    for (var j = 0; j < n; j++) phi[j] = phi[j] / s;
    return { radius: r, weights: phi };
  }

  // numpy round-half-to-even (np.rint)
  function rint(x) {
    var f = Math.floor(x), d = x - f;
    if (d < 0.5) return f;
    if (d > 0.5) return f + 1;
    return f % 2 === 0 ? f : f + 1;
  }

  // np.percentile(a, q*100, method='linear') given an order-statistic accessor over float32 values.
  // q is the already-divided fraction (np.true_divide(q, 100)). Returns float64.
  function quantileLinear(n, kth, q) {
    var vi = (n - 1) * q;
    var prev = Math.floor(vi), next = prev + 1, a, b, t;
    if (vi >= n - 1) { prev = n - 1; next = n - 1; t = vi - (-1); } else { t = vi - prev; }
    a = kth(prev); b = kth(next);
    var diff = Math.fround(b - a);            // float32 - float32 stays float32 in numpy
    var r = a + diff * t;                      // float64 from here on (t is float64)
    if (t >= 0.5) r = b - diff * (1 - t);
    return r;
  }

  // float32 order statistics via a sorted copy
  function sortedCopy(f32) {
    var c = new Float32Array(f32);
    c.sort();
    return c;
  }

  function percentilesF32(f32, qsPercent) {
    var s = sortedCopy(f32), n = s.length;
    return qsPercent.map(function (qp) {
      return quantileLinear(n, function (k) { return s[k]; }, qp / 100);
    });
  }

  // integer data (Uint8/Uint16 -> exactly representable in float32) via counting, no sort
  function percentilesInt(data, maxValue, qsPercent) {
    var counts = new Uint32Array(maxValue + 1), n = data.length, i;
    for (i = 0; i < n; i++) counts[data[i]]++;
    var cum = new Float64Array(maxValue + 1), run = 0;
    for (i = 0; i <= maxValue; i++) { run += counts[i]; cum[i] = run; }
    function kth(k) {           // value v such that cum[v] > k  (0-based order statistic)
      var lo = 0, hi = maxValue;
      while (lo < hi) {
        var mid = (lo + hi) >> 1;
        if (cum[mid] > k) hi = mid; else lo = mid + 1;
      }
      return lo;
    }
    return qsPercent.map(function (qp) { return quantileLinear(n, kth, qp / 100); });
  }

  // -------------------------------------------------------------- normalisation

  /*
   * backend/foci_upload.py to_signal(): 8-bit as is; 12/16/32-bit -> 0.1..99.99 percentile stretch to 0..255,
   * float32 storage after each in-place numpy operation.
   * Returns { data: Float32Array, info }.
   */
  function normalise(ch) {
    var src = ch.data, n = src.length, i, out = new Float32Array(n);
    var info = { bit_depth: ch.bitDepth };
    if (ch.bitDepth === 8) {
      var sat = 0;
      for (i = 0; i < n; i++) { var v = src[i]; out[i] = v; if (v >= 255) sat++; }
      info.method = 'none';
      info.lo = 0; info.hi = 255;
      info.clipped_fraction = 0; info.clipped_high_fraction = 0; info.clipped_low_fraction = 0;
      info.saturated_fraction = sat / n;
      return { data: out, info: info };
    }
    var q, max = -Infinity;
    for (i = 0; i < n; i++) { if (src[i] > max) max = src[i]; }
    var satn = 0;
    if (max > 0) { for (i = 0; i < n; i++) if (src[i] >= max) satn++; }
    info.saturated_fraction = max > 0 ? satn / n : 0;
    if (ch.bitDepth === 32) q = percentilesF32(src, [0.1, 99.99]);
    else q = percentilesInt(src, 65535, [0.1, 99.99]);
    var lo = q[0], hi = q[1];
    if (!isFinite(lo) || !isFinite(hi)) throw fail('bad_input', 'the intensity range of the image is too large to stretch (float32 overflow)');
    info.lo = lo; info.hi = hi;
    if (!(hi > lo)) {
      info.method = 'flat';
      info.clipped_fraction = 0; info.clipped_high_fraction = 0; info.clipped_low_fraction = 0;
      return { data: out, info: info };   // zeros, like np.zeros_like
    }
    var scale = Math.fround(255.0 / (hi - lo));   // `a *= python_float` -> the float is cast to float32
    var high = 0, low = 0;
    for (i = 0; i < n; i++) {
      var a = Math.fround(Math.fround(src[i]) - lo);  // `a -= lo` (np.float64 scalar): float64 math, stored float32
      a = Math.fround(a * scale);
      if (a > 255) { high++; a = 255; } else if (a < 0) { low++; a = 0; }
      out[i] = a;
    }
    info.method = 'percentile-0.1-99.99';
    info.clipped_high_fraction = high / n;
    info.clipped_low_fraction = low / n;
    info.clipped_fraction = (high + low) / n;
    return { data: out, info: info };
  }

  // -------------------------------------------------------------- line filters (CPU)

  function reflectIndex(i, n) {      // scipy mode='reflect' (d c b a | a b c d | d c b a), any distance
    if (n === 1) return 0;
    var m = 2 * n;
    i = ((i % m) + m) % m;
    return i < n ? i : m - 1 - i;
  }

  /*
   * Apply a 1-D kernel along `axis` (0 = down columns, 1 = along rows) to a Float32Array, in place.
   * Every line is gathered into a Float64 buffer with `r` reflected samples on each side, so the
   * result of a line never depends on the order lines are processed in. makeKernel(n) returns
   * fn(ext, n, out) computing out[0..n) from ext (length n + 2r, ext[r + i] == line[i]).
   * The output is stored into the Float32Array (round-to-nearest-even, like numpy's float32 output).
   */
  function filterAxis(buf, w, h, axis, r, makeKernel) {
    var n = axis === 0 ? h : w;
    var lines = axis === 0 ? w : h;
    var ext = new Float64Array(n + 2 * r);
    var out = new Float64Array(n);
    var map = new Int32Array(2 * r);   // source index for the r left then r right pad samples
    var p;
    for (p = 0; p < r; p++) {
      map[p] = reflectIndex(p - r, n);
      map[r + p] = reflectIndex(n + p, n);
    }
    var kernel = makeKernel(n);
    var i, l;
    for (l = 0; l < lines; l++) {
      if (axis === 1) {
        var base = l * w;
        for (i = 0; i < n; i++) ext[r + i] = buf[base + i];
        for (p = 0; p < r; p++) { ext[p] = buf[base + map[p]]; ext[r + n + p] = buf[base + map[r + p]]; }
        kernel(ext, n, out);
        for (i = 0; i < n; i++) buf[base + i] = out[i];
      } else {
        for (i = 0; i < n; i++) ext[r + i] = buf[l + i * w];
        for (p = 0; p < r; p++) { ext[p] = buf[l + map[p] * w]; ext[r + n + p] = buf[l + map[r + p] * w]; }
        kernel(ext, n, out);
        for (i = 0; i < n; i++) buf[l + i * w] = out[i];
      }
    }
  }

  // scipy NI_Correlate1D, symmetric-kernel branch: centre first, then pairs from the outermost inwards
  function gaussMaker(weights, r) {
    return function () {
      return function (ext, n, out) {
        var wc = weights[r];
        for (var i = 0; i < n; i++) {
          var acc = ext[r + i] * wc;
          for (var k = 0; k < r; k++) acc += (ext[i + k] + ext[i + 2 * r - k]) * weights[k];
          out[i] = acc;
        }
      };
    };
  }

  // running min / max over windows [i - r, i + r]: van Herk / Gil-Werman, exact, O(1) per sample
  function vanHerkMaker(r, isMax) {
    var wl = 2 * r + 1;
    return function (n) {
      var m = n + 2 * r;
      var g = new Float64Array(m), hh = new Float64Array(m);
      return function (ext, nn, out) {
        var i, c = 0, a, b;
        if (isMax) {
          for (i = 0; i < m; i++) {
            if (c === 0) g[i] = ext[i]; else { a = g[i - 1]; b = ext[i]; g[i] = a > b ? a : b; }
            if (++c === wl) c = 0;
          }
          c = (m - 1) % wl;
          for (i = m - 1; i >= 0; i--) {
            if (i === m - 1 || c === wl - 1) hh[i] = ext[i]; else { a = hh[i + 1]; b = ext[i]; hh[i] = a > b ? a : b; }
            if (--c < 0) c = wl - 1;
          }
          for (i = 0; i < n; i++) { a = hh[i]; b = g[i + wl - 1]; out[i] = a > b ? a : b; }
        } else {
          for (i = 0; i < m; i++) {
            if (c === 0) g[i] = ext[i]; else { a = g[i - 1]; b = ext[i]; g[i] = a < b ? a : b; }
            if (++c === wl) c = 0;
          }
          c = (m - 1) % wl;
          for (i = m - 1; i >= 0; i--) {
            if (i === m - 1 || c === wl - 1) hh[i] = ext[i]; else { a = hh[i + 1]; b = ext[i]; hh[i] = a < b ? a : b; }
            if (--c < 0) c = wl - 1;
          }
          for (i = 0; i < n; i++) { a = hh[i]; b = g[i + wl - 1]; out[i] = a < b ? a : b; }
        }
      };
    };
  }

  // ndi.gaussian_filter(float32, sigma): axis 0 then axis 1, float32 storage after each pass
  function gaussian2d(buf, w, h, sigma) {
    var k = gaussKernel(sigma);
    var mk = gaussMaker(k.weights, k.radius);
    filterAxis(buf, w, h, 0, k.radius, mk);
    filterAxis(buf, w, h, 1, k.radius, mk);
  }

  // ndi.minimum_filter / maximum_filter(size=odd) with mode='reflect' (separable, exact)
  function minmax2d(buf, w, h, size, isMax) {
    var r = (size - 1) >> 1;
    if (r < 1) return;
    var mk = vanHerkMaker(r, isMax);
    filterAxis(buf, w, h, 0, r, mk);
    filterAxis(buf, w, h, 1, r, mk);
  }

  // ---------------------------------------------------------------- Otsu (numpy-exact)

  var F = Math.fround;

  /*
   * _log_otsu(flat) from segment.py, float32-exact where numpy is float32:
   * v = float32 log1p(clip(flat, 0)); np.histogram(v[v > 0], 256) with float32 edges;
   * float64 Otsu; expm1 -> Python float -> compared against float32 data as a float32.
   * `scratch` (Float32Array, same length) is overwritten. Returns diagnostics incl. the float32 threshold.
   */
  function logOtsu(flat, scratch, linear) {
    var n = flat.length, i, cnt = 0, vmin = Infinity, vmax = -Infinity;
    for (i = 0; i < n; i++) {
      var x = flat[i];
      var v = x > 0 ? (linear ? x : F(Math.log1p(x))) : 0;     // np.clip(flat, 0, None) then float32 log1p (linear: flat[flat > 0] as is)
      scratch[i] = v;
      if (v > 0) { cnt++; if (v < vmin) vmin = v; if (v > vmax) vmax = v; }
    }
    if (cnt === 0) return { threshold: 0, threshold32: 0, log_threshold: null, positive_pixels: 0, degenerate: false };
    var first = vmin, last = vmax;
    if (first === last) { first = F(first - 0.5); last = F(last + 0.5); }
    var NB = 256;
    // np.linspace(first, last, NB + 1, dtype=float32) evaluated in float32
    var delta = F(last - first), step = F(delta / NB);
    var edges = new Float32Array(NB + 1), k;
    if (step === 0) return { threshold: 0, threshold32: 0, log_threshold: null, positive_pixels: cnt, degenerate: true };
    for (k = 0; k <= NB; k++) edges[k] = F(F(k * step) + first);
    edges[NB] = last;
    for (k = 0; k < NB; k++) {
      if (edges[k] >= edges[k + 1]) return { threshold: 0, threshold32: 0, log_threshold: null, positive_pixels: cnt, degenerate: true };
    }
    var hist = new Float64Array(NB);
    var denom = F(last - first);
    for (i = 0; i < n; i++) {
      var val = scratch[i];
      if (!(val > 0)) continue;
      var idx = Math.trunc(F(F(F(val - first) / denom) * NB));
      if (idx === NB) idx--;
      if (val < edges[idx]) idx--;
      if (val >= edges[idx + 1] && idx !== NB - 1) idx++;
      hist[idx]++;
    }
    // otsu_threshold()
    var centers = new Float64Array(NB);
    for (k = 0; k < NB; k++) centers[k] = F(F(edges[k] + edges[k + 1]) / 2);
    var w0 = new Float64Array(NB), m0 = new Float64Array(NB), run = 0, runm = 0;
    for (k = 0; k < NB; k++) { run += hist[k]; w0[k] = run; runm += hist[k] * centers[k]; m0[k] = runm; }
    var w0last = w0[NB - 1], m0last = m0[NB - 1];
    var best = -Infinity, bi = 0;
    for (k = 0; k < NB; k++) {
      var W0 = w0[k], W1 = w0last - W0;
      var mu0 = W0 > 0 ? m0[k] / W0 : 0;
      var mu1 = W1 > 0 ? (m0last - m0[k]) / W1 : 0;
      var dd = mu0 - mu1;
      var between = (W0 * W1) * (dd * dd);
      if (between > best) { best = between; bi = k; }
    }
    var logThr = centers[bi];
    if (linear) return { threshold: logThr, threshold32: F(logThr), log_threshold: null, positive_pixels: cnt, degenerate: false };
    var thr = Math.expm1(logThr);
    return { threshold: thr, threshold32: F(thr), log_threshold: logThr, positive_pixels: cnt, degenerate: false };
  }

  // ------------------------------------------------------------ binary morphology (CPU)

  // 4-connected (cross) erosion / dilation of a 0/1 Uint8Array, outside the image = 0 (scipy border_value=0)
  function erode4(src, dst, w, h) {
    for (var y = 0; y < h; y++) {
      var row = y * w;
      for (var x = 0; x < w; x++) {
        var i = row + x;
        dst[i] = (src[i] && x > 0 && src[i - 1] && x < w - 1 && src[i + 1] && y > 0 && src[i - w] && y < h - 1 && src[i + w]) ? 1 : 0;
      }
    }
  }

  function dilate4(src, dst, w, h) {
    for (var y = 0; y < h; y++) {
      var row = y * w;
      for (var x = 0; x < w; x++) {
        var i = row + x;
        dst[i] = (src[i] || (x > 0 && src[i - 1]) || (x < w - 1 && src[i + 1]) || (y > 0 && src[i - w]) || (y < h - 1 && src[i + w])) ? 1 : 0;
      }
    }
  }

  // ndi.binary_opening(mask, iterations=2): two erosions then two dilations. Result ends in `mask`.
  function binaryOpening2(mask, tmp, w, h) {
    erode4(mask, tmp, w, h); erode4(tmp, mask, w, h);
    dilate4(mask, tmp, w, h); dilate4(tmp, mask, w, h);
  }

  function growStack(s) {
    var t = new Int32Array(s.length * 2);
    t.set(s);
    return t;
  }

  // ndi.binary_fill_holes: background not 4-connected to the image border becomes foreground
  function fillHoles(mask, w, h) {
    var N = w * h, outside = new Uint8Array(N), stack = new Int32Array(1024), sp = 0, i, x, y;
    function seed(j) {
      if (!mask[j] && !outside[j]) {
        outside[j] = 1;
        if (sp === stack.length) stack = growStack(stack);
        stack[sp++] = j;
      }
    }
    for (x = 0; x < w; x++) { seed(x); seed((h - 1) * w + x); }
    for (y = 0; y < h; y++) { seed(y * w); seed(y * w + w - 1); }
    while (sp > 0) {
      i = stack[--sp];
      x = i % w; y = (i - x) / w;
      if (x > 0) seed(i - 1);
      if (x < w - 1) seed(i + 1);
      if (y > 0) seed(i - w);
      if (y < h - 1) seed(i + w);
    }
    for (i = 0; i < N; i++) if (!outside[i]) mask[i] = 1;
  }

  // ndi.label (4-connected, ids in raster order of each object's first pixel) + size filter + consecutive relabel
  function labelAndFilter(mask, w, h, minPx) {
    var N = w * h, labels = new Int32Array(N), stack = new Int32Array(1024), sp = 0, sizes = [0], n = 0, i, x, y;
    for (var s = 0; s < N; s++) {
      if (!mask[s] || labels[s]) continue;
      n++;
      var cnt = 1;
      labels[s] = n; stack[0] = s; sp = 1;
      while (sp > 0) {
        i = stack[--sp];
        x = i % w; y = (i - x) / w;
        var j;
        if (x > 0) { j = i - 1; if (mask[j] && !labels[j]) { labels[j] = n; cnt++; if (sp === stack.length) stack = growStack(stack); stack[sp++] = j; } }
        if (x < w - 1) { j = i + 1; if (mask[j] && !labels[j]) { labels[j] = n; cnt++; if (sp === stack.length) stack = growStack(stack); stack[sp++] = j; } }
        if (y > 0) { j = i - w; if (mask[j] && !labels[j]) { labels[j] = n; cnt++; if (sp === stack.length) stack = growStack(stack); stack[sp++] = j; } }
        if (y < h - 1) { j = i + w; if (mask[j] && !labels[j]) { labels[j] = n; cnt++; if (sp === stack.length) stack = growStack(stack); stack[sp++] = j; } }
      }
      sizes.push(cnt);
    }
    var remap = new Int32Array(n + 1), kept = 0;
    for (var l = 1; l <= n; l++) if (sizes[l] >= minPx) remap[l] = ++kept;
    for (i = 0; i < N; i++) labels[i] = remap[labels[i]];
    return { labels: labels, count: kept };
  }

  // per-object area and centroid (double sums of integers: exact)
  function objectStats(labels, w, h, n) {
    var area = new Float64Array(n + 1), sx = new Float64Array(n + 1), sy = new Float64Array(n + 1);
    var i = 0;
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++, i++) {
        var l = labels[i];
        if (l) { area[l]++; sx[l] += x; sy[l] += y; }
      }
    }
    return { area: area, sx: sx, sy: sy };
  }

  // estimate_nuclei(): max(1, rint(area / median(area)))
  function estimateNuclei(areas) {          // areas: array of object areas (ids 1..n)
    var n = areas.length;
    if (n === 0) return [];
    var sorted = Array.prototype.slice.call(areas).sort(function (a, b) { return a - b; });
    var med = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
    var out = new Array(n);
    for (var i = 0; i < n; i++) out[i] = Math.max(1, rint(areas[i] / med));
    return out;
  }

  // ----------------------------------------------------------------- pipeline v2 (nucleus split)
  // Mirrors src/telomere_lab/foci/segment_v2.py step by step (read its docstring first). Everything that decides a
  // label is integer arithmetic or IEEE double on float32 inputs, in the same order as Python, so labels match exactly.

  var Q_SCALE = 32;

  // ndi.distance_transform_edt(np.pad(mask, 1)) as float32: exact Euclidean distance to the nearest background pixel
  function edtPadded(mask, w, h) {
    var W = w + 2, H = h + 2, f = new Float64Array(W * H), x, y, d;
    var BIG = 1e9;
    // row pass: squared horizontal distance to the nearest background pixel of the row (the pad guarantees one)
    for (y = 1; y <= h; y++) {
      var row = y * W, mrow = (y - 1) * w - 1;
      d = BIG;
      for (x = 0; x < W; x++) {
        d = (x === 0 || x === W - 1 || !mask[mrow + x]) ? 0 : d + 1;
        f[row + x] = d;
      }
      d = BIG;
      for (x = W - 1; x >= 0; x--) {
        d = (x === 0 || x === W - 1 || !mask[mrow + x]) ? 0 : d + 1;
        if (d < f[row + x]) f[row + x] = d;
      }
      for (x = 0; x < W; x++) f[row + x] *= f[row + x];
    }
    // column pass: exact lower envelope of parabolas (Felzenszwalb & Huttenlocher); intersections are compared as fractions
    var v = new Int32Array(H), zn = new Float64Array(H), zd = new Float64Array(H), g = new Float64Array(H), out = new Float32Array(w * h);
    for (x = 1; x <= w; x++) {
      for (y = 0; y < H; y++) g[y] = (y === 0 || y === H - 1) ? 0 : f[y * W + x];
      var k = 0, q;
      v[0] = 0;
      for (q = 1; q < H; q++) {
        for (;;) {
          var pp = v[k], num = (g[q] + q * q) - (g[pp] + pp * pp), den = 2 * (q - pp);
          if (k > 0 && num * zd[k] <= zn[k] * den) { k--; continue; }
          k++; v[k] = q; zn[k] = num; zd[k] = den;
          break;
        }
      }
      var top = k, j = 0;
      for (y = 1; y <= h; y++) {
        while (j < top && zn[j + 1] < y * zd[j + 1]) j++;
        d = (y - v[j]) * (y - v[j]) + g[v[j]];
        out[(y - 1) * w + x - 1] = F(Math.sqrt(d));
      }
    }
    return out;
  }

  // flood_with_dynamics(): single decreasing-level pass, 4-connected, raster order within a level; a basin whose peak is
  // less than hq above the level where it meets a higher basin is merged into it. Returns int32 labels 1..n in raster
  // order of each region's first pixel (0 outside the mask).
  function floodWithDynamics(q, mask, w, h, hq) {
    var N = w * h, i, cnt = 0;
    var qmin = Infinity, qmax = -Infinity;
    for (i = 0; i < N; i++) if (mask[i]) { cnt++; if (q[i] < qmin) qmin = q[i]; if (q[i] > qmax) qmax = q[i]; }
    var out = new Int32Array(N);
    if (cnt === 0) return out;
    // order = mask pixels by decreasing q, ties in raster order (counting sort)
    var nb = qmax - qmin + 1, start = new Int32Array(nb + 1), order = new Int32Array(cnt);
    for (i = 0; i < N; i++) if (mask[i]) start[qmax - q[i] + 1]++;
    for (i = 0; i < nb; i++) start[i + 1] += start[i];
    for (i = 0; i < N; i++) if (mask[i]) order[start[qmax - q[i]]++] = i;
    var lab = new Int32Array(N).fill(-1), parent = [], peak = [];
    function find(r) {
      while (parent[r] !== r) { parent[r] = parent[parent[r]]; r = parent[r]; }
      return r;
    }
    var roots = [];
    for (var oi = 0; oi < cnt; oi++) {
      i = order[oi];
      var x = i % w, qi = q[i], nbr, r, t;
      roots.length = 0;
      for (t = 0; t < 4; t++) {
        if (t === 0) { if (i < w) continue; nbr = i - w; }
        else if (t === 1) { if (x === 0) continue; nbr = i - 1; }
        else if (t === 2) { if (x === w - 1) continue; nbr = i + 1; }
        else { if (i >= (h - 1) * w) continue; nbr = i + w; }
        if (lab[nbr] >= 0) {
          r = find(lab[nbr]);
          if (roots.indexOf(r) < 0) roots.push(r);
        }
      }
      if (roots.length === 0) { r = parent.length; parent.push(r); peak.push(qi); }
      else if (roots.length === 1) r = roots[0];
      else {
        roots.sort(function (a, b) { return (peak[b] - peak[a]) || (a - b); });
        r = roots[0];
        for (t = 1; t < roots.length; t++) if (peak[roots[t]] - qi < hq) parent[roots[t]] = r;
      }
      lab[i] = r;
    }
    var ids = new Int32Array(parent.length), n = 0;
    for (i = 0; i < N; i++) {
      if (!mask[i]) continue;
      var rr = find(lab[i]);
      if (!ids[rr]) ids[rr] = ++n;
      out[i] = ids[rr];
    }
    return out;
  }

  // segment_nuclei_v2(): returns {labels, count, threshold, threshold32, degenerate, dmax}; `dnaNorm` (Float32Array) is not modified
  async function segmentNucleiV2(dnaNorm, w, h, p, ctx) {
    var N = w * h, i;
    var keep = p.intensity_weight > 0 ? dnaNorm.slice() : null;
    var flat = await cpuBackend.nucleiFlat(dnaNorm.slice(), w, h, { nucleus_sigma: p.sigma, background_size: p.background_size }, ctx);
    if (ctx.dbg) ctx.dbg.flat = flat.slice();
    var scratch = new Float32Array(N);
    var ot = logOtsu(flat, scratch, true);
    scratch = null;
    await ctx.step('otsu');
    var thr32 = F(ot.threshold * p.thr_factor);
    var mask = new Uint8Array(N), any = false;
    for (i = 0; i < N; i++) { mask[i] = flat[i] > thr32 ? 1 : 0; }
    flat = null;
    var tmp = new Uint8Array(N);
    erode4(mask, tmp, w, h); dilate4(tmp, mask, w, h);                  // binary_opening(iterations=1)
    tmp = null;
    fillHoles(mask, w, h);
    for (i = 0; i < N; i++) if (mask[i]) { any = true; break; }
    await ctx.step('v2 mask');
    var res = { labels: new Int32Array(N), count: 0, threshold: ot.threshold, threshold32: thr32, degenerate: ot.degenerate };
    if (!any) return res;
    var ds = edtPadded(mask, w, h);
    await ctx.step('v2 distance');
    if (p.split_sigma > 0) gaussian2d(ds, w, h, p.split_sigma);
    var el = new Float64Array(N);
    for (i = 0; i < N; i++) el[i] = ds[i];
    if (p.intensity_weight > 0) {
      gaussian2d(keep, w, h, p.intensity_sigma);
      var m2 = -Infinity;
      for (i = 0; i < N; i++) if (mask[i] && keep[i] > m2) m2 = keep[i];
      if (m2 > 0) {
        var dmax = -Infinity;
        for (i = 0; i < N; i++) if (ds[i] > dmax) dmax = ds[i];
        var wd = p.intensity_weight * dmax;
        for (i = 0; i < N; i++) el[i] = el[i] + wd * (keep[i] / m2);
      }
    }
    var q = new Int32Array(N);
    for (i = 0; i < N; i++) q[i] = Math.floor(el[i] * Q_SCALE);
    el = null; ds = null; keep = null;
    if (ctx.dbg) ctx.dbg.surface = q.slice();
    var hq = Math.floor(p.h * Q_SCALE + 0.5);
    var lab = floodWithDynamics(q, mask, w, h, hq);
    await ctx.step('v2 watershed');
    var n = 0;
    for (i = 0; i < N; i++) if (lab[i] > n) n = lab[i];
    var sizes = new Int32Array(n + 1);
    for (i = 0; i < N; i++) sizes[lab[i]]++;
    var remap = new Int32Array(n + 1), kept = 0;
    for (var l = 1; l <= n; l++) if (sizes[l] >= p.min_nucleus_px) remap[l] = ++kept;
    for (i = 0; i < N; i++) lab[i] = remap[lab[i]];
    res.labels = lab; res.count = kept;
    return res;
  }

  // ------------------------------------------------------------------ CPU backend

  var cpuBackend = {
    name: 'cpu-f64',
    // flat = gaussian(dna) - grey_opening(gaussian(dna), background_size); `dna` (Float32Array) is consumed
    nucleiFlat: async function (dna, w, h, p, ctx) {
      gaussian2d(dna, w, h, p.nucleus_sigma);
      await ctx.step('dna smoothed');
      if (ctx.dbg) ctx.dbg.smooth_dna = dna.slice();
      var open = dna.slice();
      minmax2d(open, w, h, p.background_size, false);
      await ctx.step('dna eroded');
      minmax2d(open, w, h, p.background_size, true);
      await ctx.step('dna opened');
      for (var i = 0, n = dna.length; i < n; i++) dna[i] = dna[i] - open[i];
      return dna;
    },
    // th = white_tophat(gaussian(foci)); peak = th == maximum_filter(th) & th >= min_height
    fociPeaks: async function (foci, w, h, p, ctx) {
      gaussian2d(foci, w, h, p.foci_sigma);
      await ctx.step('foci smoothed');
      if (ctx.dbg) ctx.dbg.smooth_foci = foci.slice();
      var open = foci.slice();
      minmax2d(open, w, h, p.tophat_size, false);
      minmax2d(open, w, h, p.tophat_size, true);
      await ctx.step('foci top-hat');
      var n = foci.length, i;
      for (i = 0; i < n; i++) foci[i] = foci[i] - open[i];           // th (float32 store == float32 subtract here)
      if (ctx.dbg) ctx.dbg.th = foci.slice();
      open.set(foci);
      minmax2d(open, w, h, p.peak_window, true);
      await ctx.step('foci maxima');
      var minh = F(p.min_height), peak = new Uint8Array(n);
      for (i = 0; i < n; i++) peak[i] = (foci[i] === open[i] && foci[i] >= minh) ? 1 : 0;
      return { th: foci, peak: peak };
    },
  };

  // ------------------------------------------------------------------ pipeline

  // Yield to the event loop between stages so an AbortSignal can be delivered. In a browser use a MessageChannel: unlike
  // setTimeout(0) it is not throttled to one tick per second in background tabs. (Node: a port with a handler would keep
  // the process alive, so it uses setTimeout.)
  var tick = (function () {
    if (!IS_NODE && typeof MessageChannel !== 'undefined') {
      var chan = new MessageChannel(), waiting = [];
      chan.port1.onmessage = function () { var r = waiting.shift(); if (r) r(); };
      return function () { return new Promise(function (r) { waiting.push(r); chan.port2.postMessage(0); }); };
    }
    return function () { return new Promise(function (r) { setTimeout(r, 0); }); };
  })();

  function makeCtx(signal, debug) {
    var t0 = now(), last = t0, timing = {};
    var ctx = {
      signal: signal || null,
      dbg: debug ? {} : null,
      timing: timing,
      t0: t0,
      step: async function (label) {
        var t = now();
        timing[label] = (timing[label] || 0) + (t - last);
        if (ctx.signal) {
          if (ctx.signal.aborted) throw fail('aborted', 'analysis aborted');
          await tick();
          if (ctx.signal.aborted) throw fail('aborted', 'analysis aborted');
        }
        last = now();
      },
      mark: function () { last = now(); },
    };
    return ctx;
  }

  function now() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  }

  function saturationWarning(label, info) {
    var out = [];
    if (info.saturated_fraction > 0.01) out.push(label + ' image: ' + (info.saturated_fraction * 100).toFixed(1) + '% of pixels are at the maximum value (saturated).');
    if (info.method === 'flat') out.push(label + ' image has no intensity range (all pixels equal).');
    return out;
  }

  async function runPipeline(dnaCh, fociCh, p, backend, ctx, opts, warnings) {
    var w = dnaCh.width, h = dnaCh.height, N = w * h, i;
    ctx.mark();
    var nd = normalise(dnaCh);
    await ctx.step('normalise dna');
    var normInfo = { dna: nd.info, foci: null };

    // ---- nuclei
    var v2 = opts.pipeline === 'v2', ot, labels, nObj;
    if (v2) {
      var sv = await segmentNucleiV2(nd.data, w, h, p, ctx);
      nd = { info: nd.info };
      ot = { threshold: sv.threshold, threshold32: sv.threshold32, log_threshold: null };
      if (sv.degenerate) warnings.push('DNA image: the intensity histogram is degenerate; the nucleus threshold fell back to 0.');
      labels = sv.labels; nObj = sv.count;
    } else {
      var flat = await backend.nucleiFlat(nd.data, w, h, p, ctx);
      nd = { info: nd.info };                      // nd.data was consumed (it is `flat` on the CPU path): let it be collected
      if (ctx.dbg) ctx.dbg.flat = flat.slice();
      var scratch = new Float32Array(N);
      ot = logOtsu(flat, scratch);
      scratch = null;
      if (ot.degenerate) warnings.push('DNA image: the intensity histogram is degenerate; the nucleus threshold fell back to 0.');
      await ctx.step('otsu');
      var mask = new Uint8Array(N), t32 = ot.threshold32;
      for (i = 0; i < N; i++) mask[i] = flat[i] > t32 ? 1 : 0;
      flat = null;
      var tmpMask = new Uint8Array(N);
      binaryOpening2(mask, tmpMask, w, h);
      tmpMask = null;
      await ctx.step('opening');
      fillHoles(mask, w, h);
      await ctx.step('fill holes');
      var lab = labelAndFilter(mask, w, h, p.min_nucleus_px);
      mask = null;
      labels = lab.labels; nObj = lab.count;
      await ctx.step('label');
    }
    if (ctx.dbg) { ctx.dbg.mask_labels = labels; }

    var st = objectStats(labels, w, h, nObj);
    var areas = new Array(nObj);
    for (i = 0; i < nObj; i++) areas[i] = st.area[i + 1];
    var est;
    if (v2) { est = new Array(nObj); for (i = 0; i < nObj; i++) est[i] = 1; }     // v2: one object = one nucleus
    else est = estimateNuclei(areas);
    var nNuclei = 0;
    for (i = 0; i < est.length; i++) nNuclei += est[i];

    // ---- foci (Python returns before touching the foci channel when there are no nuclei)
    var points = [], perObj = new Int32Array(nObj + 1), fd = null, peaksRes = null;
    var nf = normalise(fociCh);
    normInfo.foci = nf.info;
    await ctx.step('normalise foci');
    if (nObj > 0) {
      peaksRes = await backend.fociPeaks(nf.data, w, h, p, ctx);
      var th = peaksRes.th, pk = peaksRes.peak;
      for (i = 0; i < N; i++) {
        if (pk[i] && labels[i] > 0) {
          var x = i % w, y = (i - x) / w;
          points.push({ x: x, y: y, height: th[i], object: labels[i] });
          perObj[labels[i]]++;
        }
      }
      fd = th;
      await ctx.step('collect peaks');
    }
    var objects = new Array(nObj);
    for (i = 0; i < nObj; i++) {
      var a = st.area[i + 1];
      objects[i] = { id: i + 1, area_px: a, cx: st.sx[i + 1] / a, cy: st.sy[i + 1] / a, nuclei_in_object: est[i], foci: perObj[i + 1] };
    }
    warnings.push.apply(warnings, saturationWarning('DNA', nd.info));
    warnings.push.apply(warnings, saturationWarning('Foci', nf.info));
    if (nNuclei === 0) warnings.push("No nuclei were detected. Check that 'dna' is the nuclear stain and try a smaller minimum nucleus size.");

    var res = {
      version: VERSION,
      pipeline_version: v2 ? 'v2' : 'v1',
      backend: backend.name,
      image: { width: w, height: h },
      normalisation: normInfo,
      nuclei: { count: nNuclei, object_count: nObj, objects: objects },
      foci: { count: points.length, per_cell: nNuclei ? points.length / nNuclei : null, points: points },
      thresholds: { nucleus: ot.threshold, nucleus_float32: ot.threshold32, nucleus_log: v2 ? null : ot.log_threshold, min_height_float32: F(p.min_height) },
      params: p,
      warnings: warnings,
    };
    if (opts.overlay) {
      ctx.mark();
      res.overlay = makeOverlay(dnaCh, fociCh, labels, points, w, h);
      await ctx.step('overlay');
    }
    if (ctx.dbg) { ctx.dbg.labels = labels; res._debug = ctx.dbg; }
    return res;
  }

  // overlay_rgb(): DNA blue, 53BP1 green, white outlines, amber rings; RGBA output, alpha 255
  function makeOverlay(dnaCh, fociCh, labels, points, w, h) {
    var N = w * h, i, x, y;
    var dn = normalise(dnaCh).data, fn = normalise(fociCh).data;
    function norm(a) {
      var q = percentilesF32(a, [1, 99.7]);
      var lo = q[0], den = Math.max(q[1] - q[0], 1e-6);
      return { lo: lo, den: den };
    }
    var nd = norm(dn), nf = norm(fn);
    var out = new Uint8ClampedArray(N * 4);
    // masks
    var edge = new Uint8Array(N);
    for (y = 0; y < h; y++) {
      for (x = 0; x < w; x++) {
        i = y * w + x;
        if (labels[i] > 0) {
          var interior = x > 0 && x < w - 1 && y > 0 && y < h - 1 && labels[i - 1] > 0 && labels[i + 1] > 0 && labels[i - w] > 0 && labels[i + w] > 0;
          if (!interior) edge[i] = 1;
        }
      }
    }
    var d1 = new Uint8Array(N), d3 = new Uint8Array(N);
    points.forEach(function (pt) {
      for (var dy = -3; dy <= 3; dy++) {
        var yy = pt.y + dy;
        if (yy < 0 || yy >= h) continue;
        var rem = 3 - Math.abs(dy);
        for (var dx = -rem; dx <= rem; dx++) {
          var xx = pt.x + dx;
          if (xx < 0 || xx >= w) continue;
          var j = yy * w + xx;
          d3[j] = 1;
          if (Math.abs(dx) + Math.abs(dy) <= 1) d1[j] = 1;
        }
      }
    });
    var E = [F(0.85), F(0.9), F(0.95)], A = [F(1.0), F(0.72), F(0.15)];
    function clip01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }
    for (i = 0; i < N; i++) {
      var o = i * 4, r, g, b;
      if (d3[i] && !d1[i]) { r = A[0]; g = A[1]; b = A[2]; }
      else if (edge[i]) { r = E[0]; g = E[1]; b = E[2]; }
      else {
        var nD = clip01((dn[i] - nd.lo) / nd.den), nF = clip01((fn[i] - nf.lo) / nf.den);
        b = F(nD * 0.85); g = F(nF); r = F(nF * 0.25);
      }
      out[o] = Math.trunc(F(r * 255)); out[o + 1] = Math.trunc(F(g * 255)); out[o + 2] = Math.trunc(F(b * 255)); out[o + 3] = 255;
    }
    return { width: w, height: h, data: out };
  }

  // ------------------------------------------------------------------ WebGPU backend

  var WGSL = [
    'struct P { w: u32, h: u32, r: u32, axis: u32, op: u32, minh: f32, pad0: u32, pad1: u32 };',
    '@group(0) @binding(0) var<uniform> p : P;',
    '@group(0) @binding(1) var<storage, read> src : array<f32>;',
    '@group(0) @binding(2) var<storage, read_write> dst : array<f32>;',
    '@group(0) @binding(3) var<storage, read> wts : array<f32>;',
    '@group(0) @binding(4) var<storage, read> src2 : array<f32>;',
    '@group(0) @binding(5) var<storage, read_write> flags : array<u32>;',
    '',
    'fn reflect_idx(i : i32, n : i32) -> i32 {',
    '  if (n == 1) { return 0; }',
    '  let m = 2 * n;',
    '  var j = i % m;',
    '  if (j < 0) { j = j + m; }',
    '  if (j >= n) { j = m - 1 - j; }',
    '  return j;',
    '}',
    '',
    'fn at(pos : i32, x : i32, y : i32) -> f32 {',
    '  if (p.axis == 0u) { return src[u32(reflect_idx(pos, i32(p.h))) * p.w + u32(x)]; }',
    '  return src[u32(y) * p.w + u32(reflect_idx(pos, i32(p.w)))];',
    '}',
    '',
    '@compute @workgroup_size(16, 16)',
    'fn gauss(@builtin(global_invocation_id) id : vec3<u32>) {',
    '  if (id.x >= p.w || id.y >= p.h) { return; }',
    '  let x = i32(id.x); let y = i32(id.y); let r = i32(p.r);',
    '  var pos = x; if (p.axis == 0u) { pos = y; }',
    '  var acc = at(pos, x, y) * wts[r];',
    '  for (var jj = -r; jj < 0; jj = jj + 1) {',
    '    acc = acc + (at(pos + jj, x, y) + at(pos - jj, x, y)) * wts[r + jj];',
    '  }',
    '  dst[id.y * p.w + id.x] = acc;',
    '}',
    '',
    '@compute @workgroup_size(16, 16)',
    'fn minmax(@builtin(global_invocation_id) id : vec3<u32>) {',
    '  if (id.x >= p.w || id.y >= p.h) { return; }',
    '  let x = i32(id.x); let y = i32(id.y); let r = i32(p.r);',
    '  var pos = x; if (p.axis == 0u) { pos = y; }',
    '  var acc = at(pos, x, y);',
    '  for (var jj = 1; jj <= r; jj = jj + 1) {',
    '    let a = at(pos - jj, x, y); let b = at(pos + jj, x, y);',
    '    if (p.op == 0u) { acc = min(acc, min(a, b)); } else { acc = max(acc, max(a, b)); }',
    '  }',
    '  dst[id.y * p.w + id.x] = acc;',
    '}',
    '',
    '@compute @workgroup_size(16, 16)',
    'fn sub(@builtin(global_invocation_id) id : vec3<u32>) {',
    '  if (id.x >= p.w || id.y >= p.h) { return; }',
    '  let i = id.y * p.w + id.x;',
    '  dst[i] = src[i] - src2[i];',
    '}',
    '',
    '@compute @workgroup_size(16, 16)',
    'fn peaks(@builtin(global_invocation_id) id : vec3<u32>) {',
    '  if (id.x >= p.w || id.y >= p.h) { return; }',
    '  let i = id.y * p.w + id.x;',
    '  var f = 0u;',
    '  if (src[i] == src2[i] && src[i] >= p.minh) { f = 1u; }',
    '  flags[i] = f;',
    '}',
  ].join('\n');

  var gpuState = { device: null, adapter: null, info: null, pipelines: null, layout: null, lost: null, selfTest: 'skipped', initPromise: null };

  function hasWebGPU() {
    return typeof navigator !== 'undefined' && !!navigator.gpu;
  }

  function gpuLimitsSubset(limits) {
    var names = ['maxTextureDimension2D', 'maxBufferSize', 'maxStorageBufferBindingSize', 'maxComputeWorkgroupSizeX', 'maxComputeWorkgroupSizeY',
      'maxComputeInvocationsPerWorkgroup', 'maxComputeWorkgroupsPerDimension', 'maxStorageBuffersPerShaderStage', 'maxBindGroups', 'maxUniformBufferBindingSize'];
    var o = {};
    names.forEach(function (k) { try { if (limits && typeof limits[k] === 'number') o[k] = limits[k]; } catch (e) { /* ignore */ } });
    return o;
  }

  async function initGpu() {
    if (gpuState.initPromise) return gpuState.initPromise;
    gpuState.initPromise = (async function () {
      if (!hasWebGPU()) { gpuState.selfTest = 'skipped'; return null; }
      try {
        var adapter = await navigator.gpu.requestAdapter();
        if (!adapter) { gpuState.selfTest = 'skipped'; return null; }
        var info = null;
        try { info = adapter.info || (adapter.requestAdapterInfo ? await adapter.requestAdapterInfo() : null); } catch (e) { info = null; }
        gpuState.adapter = adapter;
        gpuState.info = {
          vendor: info && info.vendor || '', architecture: info && info.architecture || '', description: info && (info.description || info.device) || '',
          limits: gpuLimitsSubset(adapter.limits),
        };
        var device = await adapter.requestDevice();
        gpuState.device = device;
        device.lost.then(function (l) { gpuState.lost = { reason: l && l.reason || 'unknown', message: l && l.message || '' }; gpuState.device = null; });
        device.pushErrorScope('validation');
        buildPipelines(device);
        var buildErr = await device.popErrorScope();
        if (buildErr) throw new Error('shader/pipeline: ' + buildErr.message);
        var ok = await gpuSelfTest();
        gpuState.selfTest = ok ? 'passed' : 'failed';
        return ok ? device : null;
      } catch (e) {
        gpuState.selfTest = 'failed';
        gpuState.selfTestError = String(e && e.message || e);
        return null;
      }
    })();
    return gpuState.initPromise;
  }

  function buildPipelines(device) {
    var U = 0x0004 /* COMPUTE */;
    var layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: U, buffer: { type: 'uniform' } },
        { binding: 1, visibility: U, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: U, buffer: { type: 'storage' } },
        { binding: 3, visibility: U, buffer: { type: 'read-only-storage' } },
        { binding: 4, visibility: U, buffer: { type: 'read-only-storage' } },
        { binding: 5, visibility: U, buffer: { type: 'storage' } },
      ],
    });
    var pl = device.createPipelineLayout({ bindGroupLayouts: [layout] });
    var module = device.createShaderModule({ code: WGSL });
    var pipes = {};
    ['gauss', 'minmax', 'sub', 'peaks'].forEach(function (name) {
      pipes[name] = device.createComputePipeline({ layout: pl, compute: { module: module, entryPoint: name } });
    });
    gpuState.layout = layout;
    gpuState.pipelines = pipes;
  }

  // GPUBufferUsage flags (spec constants; the global may be absent in worker-less contexts, so spelled out)
  var BU = { MAP_READ: 0x1, COPY_SRC: 0x4, COPY_DST: 0x8, UNIFORM: 0x40, STORAGE: 0x80 };

  /*
   * A GPU work session for one image size. All passes use distinct src/dst buffers within a dispatch.
   * The session owns its buffers; destroy() must always be called.
   */
  function GpuSession(device, w, h) {
    this.d = device; this.w = w; this.h = h; this.N = w * h;
    this.bufs = [];
    this.uniforms = [];
    // A buffer may not be bound both read-only and read-write in one dispatch, so each role has its own placeholder.
    this.dummyR = this.make(16, BU.STORAGE | BU.COPY_DST);
    this.dummyW = this.make(16, BU.STORAGE | BU.COPY_DST);
    this.dummyF = this.make(16, BU.STORAGE | BU.COPY_DST);
    this.A = this.make(this.N * 4, BU.STORAGE | BU.COPY_DST | BU.COPY_SRC);
    this.B = this.make(this.N * 4, BU.STORAGE | BU.COPY_DST | BU.COPY_SRC);
    this.C = this.make(this.N * 4, BU.STORAGE | BU.COPY_DST | BU.COPY_SRC);
    this.flags = null;
    this.enc = device.createCommandEncoder();
    this.wbuf = {};
  }
  GpuSession.prototype.make = function (size, usage) {
    var b = this.d.createBuffer({ size: Math.max(16, Math.ceil(size / 4) * 4), usage: usage });
    this.bufs.push(b);
    return b;
  };
  GpuSession.prototype.weights = function (arr) {
    var f = new Float32Array(arr.length);
    for (var i = 0; i < arr.length; i++) f[i] = arr[i];
    var b = this.make(f.byteLength, BU.STORAGE | BU.COPY_DST);
    this.d.queue.writeBuffer(b, 0, f);
    return b;
  };
  GpuSession.prototype.pass = function (entry, o) {
    var u = new ArrayBuffer(32), dv = new DataView(u);
    dv.setUint32(0, this.w, true); dv.setUint32(4, this.h, true); dv.setUint32(8, o.r || 0, true); dv.setUint32(12, o.axis || 0, true);
    dv.setUint32(16, o.op || 0, true); dv.setFloat32(20, o.minh || 0, true);
    var ub = this.make(32, BU.UNIFORM | BU.COPY_DST);
    this.d.queue.writeBuffer(ub, 0, u);
    var bg = this.d.createBindGroup({
      layout: gpuState.layout,
      entries: [
        { binding: 0, resource: { buffer: ub } },
        { binding: 1, resource: { buffer: o.src || this.dummyR } },
        { binding: 2, resource: { buffer: o.dst || this.dummyW } },
        { binding: 3, resource: { buffer: o.wts || this.dummyR } },
        { binding: 4, resource: { buffer: o.src2 || this.dummyR } },
        { binding: 5, resource: { buffer: o.flags || this.dummyF } },
      ],
    });
    var pass = this.enc.beginComputePass();
    pass.setPipeline(gpuState.pipelines[entry]);
    pass.setBindGroup(0, bg);
    pass.dispatchWorkgroups(Math.ceil(this.w / 16), Math.ceil(this.h / 16));
    pass.end();
  };
  GpuSession.prototype.flush = function () {
    this.d.queue.submit([this.enc.finish()]);
    this.enc = this.d.createCommandEncoder();
  };
  GpuSession.prototype.read = async function (buf, Ctor, count) {
    var bytes = count * Ctor.BYTES_PER_ELEMENT;
    var stg = this.make(bytes, BU.MAP_READ | BU.COPY_DST);
    this.enc.copyBufferToBuffer(buf, 0, stg, 0, Math.ceil(bytes / 4) * 4);
    this.flush();
    await stg.mapAsync(1 /* READ */);
    var out = new Ctor(stg.getMappedRange().slice(0, bytes));
    stg.unmap();
    return out;
  };
  GpuSession.prototype.destroy = function () {
    this.bufs.forEach(function (b) { try { b.destroy(); } catch (e) { /* ignore */ } });
    this.bufs = [];
  };
  GpuSession.prototype.gauss = function (from, to, sigma) {
    var k = gaussKernel(sigma), wb = this.weights(k.weights);
    this.pass('gauss', { src: from, dst: to, wts: wb, r: k.radius, axis: 0 });
    this.pass('gauss', { src: to, dst: from, wts: wb, r: k.radius, axis: 1 });      // result back in `from`
  };
  // min/max filter of `from` into `to`, using `tmp` as the intermediate; result in `to`
  GpuSession.prototype.minmax = function (from, tmp, to, size, op) {
    var r = (size - 1) >> 1;
    this.pass('minmax', { src: from, dst: tmp, r: r, axis: 0, op: op });
    this.pass('minmax', { src: tmp, dst: to, r: r, axis: 1, op: op });
  };

  async function withGpuErrors(device, fn) {
    device.pushErrorScope('validation');
    device.pushErrorScope('out-of-memory');
    var result, thrown = null;
    try { result = await fn(); } catch (e) { thrown = e; }
    var oom = await device.popErrorScope();
    var val = await device.popErrorScope();
    if (oom || val) throw fail('gpu_lost', 'GPU error: ' + ((oom || val).message || 'validation/out-of-memory'));
    if (thrown) throw thrown;
    return result;
  }

  function gpuWrap(e) {
    if (e && e.code) return e;
    return fail('gpu_lost', 'GPU error: ' + (e && e.message || e));
  }


  var gpuBackend = {
    name: 'webgpu-f32',

    // flat = gauss(dna) - opening(gauss(dna)); returns a Float32Array read back from the GPU.
    // Buffer flow (every dispatch has distinct src and dst):
    //   A <- dna; gauss A->B->A (smooth in A); erode A->B->C; dilate C->B->C (opened in C); sub A-C -> B; read B
    nucleiFlat: async function (dna, w, h, p, ctx) {
      var device = gpuDevice();
      var s = new GpuSession(device, w, h);
      try {
        return await withGpuErrors(device, async function () {
          device.queue.writeBuffer(s.A, 0, dna.buffer, dna.byteOffset, dna.byteLength);
          s.gauss(s.A, s.B, p.nucleus_sigma);
          if (ctx.dbg) ctx.dbg.smooth_dna = await s.read(s.A, Float32Array, s.N);
          s.minmax(s.A, s.B, s.C, p.background_size, 0);
          s.minmax(s.C, s.B, s.C, p.background_size, 1);
          s.pass('sub', { src: s.A, src2: s.C, dst: s.B });
          return await s.read(s.B, Float32Array, s.N);
        }).then(async function (flat) { await ctx.step('gpu dna filters'); return flat; });
      } catch (e) { throw gpuWrap(e); } finally { s.destroy(); }
    },

    // th = A - opening(A) with A = gauss(foci); M = maximum_filter(th); flag = th == M && th >= min_height
    // Buffer flow: A <- foci; gauss; erode A->B->C; dilate C->B->C; sub A-C -> B (= th); max B->A->C (M in C);
    //              peaks(B, C) -> flags; read B and flags.
    fociPeaks: async function (foci, w, h, p, ctx) {
      var device = gpuDevice();
      var s = new GpuSession(device, w, h);
      try {
        return await withGpuErrors(device, async function () {
          device.queue.writeBuffer(s.A, 0, foci.buffer, foci.byteOffset, foci.byteLength);
          s.gauss(s.A, s.B, p.foci_sigma);
          if (ctx.dbg) ctx.dbg.smooth_foci = await s.read(s.A, Float32Array, s.N);
          s.minmax(s.A, s.B, s.C, p.tophat_size, 0);
          s.minmax(s.C, s.B, s.C, p.tophat_size, 1);
          s.pass('sub', { src: s.A, src2: s.C, dst: s.B });
          s.minmax(s.B, s.A, s.C, p.peak_window, 1);
          s.flags = s.make(s.N * 4, BU.STORAGE | BU.COPY_SRC);
          s.pass('peaks', { src: s.B, src2: s.C, flags: s.flags, minh: F(p.min_height) });
          var th = await s.read(s.B, Float32Array, s.N);
          var fl = await s.read(s.flags, Uint32Array, s.N);
          var peak = new Uint8Array(s.N);
          for (var i = 0; i < s.N; i++) peak[i] = fl[i] ? 1 : 0;
          if (ctx.dbg) ctx.dbg.th = th.slice();
          return { th: th, peak: peak };
        }).then(async function (r) { await ctx.step('gpu foci filters'); return r; });
      } catch (e) { throw gpuWrap(e); } finally { s.destroy(); }
    },
  };

  function gpuDevice() {
    if (gpuState.lost) throw fail('gpu_lost', 'GPU device lost: ' + gpuState.lost.reason);
    if (!gpuState.device) throw fail('gpu_lost', 'GPU device is not available');
    return gpuState.device;
  }

  // Boot self-test: a small known image through both backends; the GPU must agree with the CPU reference
  // to within float32 accumulation noise, and pick exactly the same peaks.
  function selfTestImages() {
    var w = 64, h = 48, dna = new Float32Array(w * h), foci = new Float32Array(w * h), x, y, s = 12345;
    function rnd() { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return (s >>> 8) / 16777216; }
    for (y = 0; y < h; y++) {
      for (x = 0; x < w; x++) {
        var d1 = Math.hypot(x - 20, y - 24), d2 = Math.hypot(x - 46, y - 22);
        var nuc = d1 < 11 ? 140 : (d2 < 9 ? 100 : 0);
        dna[y * w + x] = Math.min(255, Math.round(nuc + 8 + rnd() * 6 + x * 0.2));
        var f = nuc ? 30 : 4;
        f += 120 * Math.exp(-((x - 18) * (x - 18) + (y - 22) * (y - 22)) / 2.5);
        f += 90 * Math.exp(-((x - 47) * (x - 47) + (y - 25) * (y - 25)) / 2.5);
        foci[y * w + x] = Math.min(255, Math.round(f + rnd() * 3));
      }
    }
    return { w: w, h: h, dna: dna, foci: foci };
  }

  async function gpuSelfTest() {
    var t = selfTestImages(), p = resolveParams({ background_size: 11, tophat_size: 7, peak_window: 5, min_height: 12 });
    var ctxA = { dbg: null, step: async function () {} };
    var cf = await cpuBackend.nucleiFlat(t.dna.slice(), t.w, t.h, p, ctxA);
    var gf = await gpuBackend.nucleiFlat(t.dna.slice(), t.w, t.h, p, ctxA);
    var i, d = 0;
    if (gf.length !== cf.length) return false;
    for (i = 0; i < cf.length; i++) { var e = Math.abs(cf[i] - gf[i]); if (!(e <= 0.05)) return false; if (e > d) d = e; }
    var cp = await cpuBackend.fociPeaks(t.foci.slice(), t.w, t.h, p, ctxA);
    var gp = await gpuBackend.fociPeaks(t.foci.slice(), t.w, t.h, p, ctxA);
    var n = 0;
    for (i = 0; i < cp.th.length; i++) {
      if (!(Math.abs(cp.th[i] - gp.th[i]) <= 0.05)) return false;
      if (cp.peak[i] !== gp.peak[i]) return false;
      n += cp.peak[i];
    }
    return n >= 2;                          // the image has two planted foci; a dead shader finds none
  }

  // ------------------------------------------------------------------ public API

  function hardwareConcurrency() {
    if (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) return navigator.hardwareConcurrency;
    if (IS_NODE) { try { return require('os').cpus().length || 1; } catch (e) { /* ignore */ } }
    return 1;
  }

  async function capabilities() {
    await initGpu();
    return {
      webgpu: hasWebGPU() && !!gpuState.adapter,
      adapter: gpuState.info || null,
      selfTest: gpuState.selfTest,
      maxImagePixels: DEFAULT_MAX_PIXELS,
      hardwareConcurrency: hardwareConcurrency(),
    };
  }

  function validateOpts(opts) {
    opts = opts || {};
    if (typeof opts !== 'object') throw fail('bad_input', 'opts must be an object');
    var mode = opts.mode === undefined ? 'auto' : opts.mode;
    if (mode !== 'reference' && mode !== 'gpu' && mode !== 'auto') throw fail('bad_input', "mode must be 'reference', 'gpu' or 'auto'");
    var maxPx = opts.maxImagePixels === undefined ? DEFAULT_MAX_PIXELS : opts.maxImagePixels;
    if (typeof maxPx !== 'number' || !(maxPx >= 1) || !isFinite(maxPx)) throw fail('bad_input', 'maxImagePixels must be a positive number');
    var maxMem = opts.maxMemoryBytes === undefined ? DEFAULT_MAX_MEMORY : opts.maxMemoryBytes;
    if (typeof maxMem !== 'number' || !(maxMem > 0)) throw fail('bad_input', 'maxMemoryBytes must be a positive number');
    var pipeline = opts.pipeline === undefined ? 'v1' : opts.pipeline;
    if (pipeline !== 'v1' && pipeline !== 'v2') throw fail('bad_input', "pipeline must be 'v1' or 'v2'");
    return { pipeline: pipeline, mode: mode, overlay: !!opts.overlay, signal: opts.signal || null, maxPx: maxPx, maxMem: maxMem, debug: !!opts.debug, batchSize: opts.batchSize > 0 ? opts.batchSize : 1 };
  }

  async function analyze(input, opts) {
    var o = validateOpts(opts);
    if (o.signal && o.signal.aborted) throw fail('aborted', 'analysis aborted');
    if (!input || typeof input !== 'object') throw fail('bad_input', 'input must be an object {dna, foci, params?}');
    var p = resolveParams(input.params, o.pipeline);
    var dc = checkChannel(input.dna, 'dna', o.maxPx);
    var fc = checkChannel(input.foci, 'foci', o.maxPx);
    if (dc.width !== fc.width || dc.height !== fc.height) {
      throw fail('bad_input', 'the two images differ in size: DNA ' + dc.width + 'x' + dc.height + ', foci ' + fc.width + 'x' + fc.height);
    }
    var est = memoryEstimate(dc.width, dc.height, o.overlay, o.pipeline);
    if (est > o.maxMem) throw fail('too_large', 'estimated working memory ' + Math.round(est / 1e6) + ' MB exceeds the limit of ' + Math.round(o.maxMem / 1e6) + ' MB');
    scanValues(input.dna, 'dna');
    scanValues(input.foci, 'foci');

    var warnings = [];
    var px = dc.width * dc.height;
    var useGpu = false;
    if (o.pipeline === 'v2') {
      // v2's nucleus stage (distance transform + flood) is CPU-only and its filters would have to match it exactly: run it all on the reference path
      if (o.mode === 'gpu') warnings.push("Pipeline v2 runs on the CPU reference path only; mode 'gpu' was ignored.");
    } else if (o.mode === 'gpu' || (o.mode === 'auto' && hasWebGPU() && (px >= AUTO_GPU_MIN_PIXELS || (o.batchSize >= AUTO_GPU_BATCH && px >= AUTO_GPU_MIN_BATCH_PIXELS)))) {
      if (gpuState.lost) {
        if (o.mode === 'gpu') throw fail('gpu_lost', 'GPU device was lost (' + gpuState.lost.reason + ')');
        warnings.push('GPU device was lost earlier in this session; used the CPU reference path.');
      } else {
        await initGpu();
        if (gpuState.device && gpuState.selfTest === 'passed') {
          var lim = gpuState.device.limits, bufMax = Math.min(lim.maxStorageBufferBindingSize || Infinity, lim.maxBufferSize || Infinity);
          if (px * 4 > bufMax) {      // one float32 plane must fit a single storage buffer
            if (o.mode === 'gpu') throw fail('too_large', 'the image needs ' + px * 4 + ' bytes per plane; this GPU allows ' + bufMax);
            warnings.push('The image is larger than the buffer limit of this GPU; used the CPU reference path.');
          } else useGpu = true;
        }
        else if (o.mode === 'gpu') throw fail('gpu_lost', gpuState.selfTest === 'failed' ? 'the GPU self-test failed' : 'WebGPU is not available');
        else if (gpuState.selfTest === 'failed') warnings.push('The GPU self-test failed; used the CPU reference path.');
      }
    }
    var t0 = now(), res;
    if (useGpu) {
      var ctx = makeCtx(o.signal, o.debug), w1 = warnings.slice();
      try {
        res = await runPipeline(input.dna, input.foci, p, gpuBackend, ctx, o, w1);
        res.timing_ms = ctx.timing;
      } catch (e) {
        if (!(e && e.code === 'gpu_lost') || o.mode === 'gpu') throw e;
        warnings.push('GPU failed (' + e.message + '); recomputed on the CPU reference path.');
        if (!gpuState.lost) gpuState.lost = { reason: 'error', message: e.message };   // no more GPU attempts this session
        res = null;
      }
    }
    if (!res) {
      var ctx2 = makeCtx(o.signal, o.debug);
      res = await runPipeline(input.dna, input.foci, p, cpuBackend, ctx2, o, warnings);
      res.timing_ms = ctx2.timing;
    }
    res.timing_ms.total = now() - t0;
    return res;
  }

  // ---------------------------------------------------------------- GPU vs reference report

  /*
   * cases: [{ name, input: {dna, foci, params?} }]. Runs each in 'reference' and 'gpu' mode (debug on) and reports
   * count mismatches, exact-peak agreement, max |difference| of the smoothed / flat / top-hat arrays, and timings.
   */
  async function parity(cases, opts) {
    var caps = await capabilities();
    if (!caps.webgpu || caps.selfTest !== 'passed') return { available: false, capabilities: caps, cases: [] };
    var out = [], worst = { flat: 0, th: 0, smooth_dna: 0, smooth_foci: 0 }, mism = 0;
    for (var c = 0; c < cases.length; c++) {
      var k = cases[c];
      var ref = await analyze(k.input, { mode: 'reference', debug: true, maxImagePixels: opts && opts.maxImagePixels });
      var gpu = await analyze(k.input, { mode: 'gpu', debug: true, maxImagePixels: opts && opts.maxImagePixels });
      var diffs = {};
      ['smooth_dna', 'flat', 'smooth_foci', 'th'].forEach(function (key) {
        var a = ref._debug[key], b = gpu._debug[key];
        if (!a || !b) return;
        var m = 0;
        for (var i = 0; i < a.length; i++) { var d = Math.abs(a[i] - b[i]); if (d > m) m = d; }
        diffs[key] = m;
        if (m > worst[key]) worst[key] = m;
      });
      var samePoints = ref.foci.points.length === gpu.foci.points.length && ref.foci.points.every(function (pt, i) {
        var q = gpu.foci.points[i]; return pt.x === q.x && pt.y === q.y && pt.object === q.object;
      });
      var same = ref.nuclei.count === gpu.nuclei.count && ref.nuclei.object_count === gpu.nuclei.object_count && ref.foci.count === gpu.foci.count && samePoints;
      if (!same) mism++;
      out.push({
        name: k.name, same: same, samePoints: samePoints,
        reference: { nuclei: ref.nuclei.count, objects: ref.nuclei.object_count, foci: ref.foci.count, ms: ref.timing_ms.total },
        gpu: { nuclei: gpu.nuclei.count, objects: gpu.nuclei.object_count, foci: gpu.foci.count, ms: gpu.timing_ms.total, warnings: gpu.warnings },
        max_abs_diff: diffs,
      });
    }
    return { available: true, capabilities: caps, cases: out, summary: { cases: out.length, mismatching_cases: mism, worst_max_abs_diff: worst } };
  }

  // -------------------------------------------------------------------- worker pool

  function scriptBase() {
    return SCRIPT_URL ? SCRIPT_URL.replace(/[?#].*$/, '').replace(/[^/]*$/, '') : '';
  }

  // The deploy step stamps <script src="engine.js?v=HASH">; the worker (and the engine it imports) must use the same
  // cache-busting token, otherwise a cached worker.js / engine.js could outlive a release.
  function versionToken() {
    var m = SCRIPT_URL ? /[?&]v=([\w.\-]{1,64})/.exec(SCRIPT_URL) : null;
    return m ? m[1] : VERSION;
  }

  function publicError(e) {
    var code = e && e.code;
    if (code !== 'too_large' && code !== 'bad_input' && code !== 'aborted' && code !== 'gpu_lost') code = 'internal';
    var err = new Error(e && e.message || String(e));
    err.code = code;
    return err;
  }

  function createPool(n, popts) {
    popts = popts || {};
    var size = (typeof n === 'number' && n >= 1) ? Math.floor(n) : Math.max(1, Math.min(hardwareConcurrency() - 1, 4));
    var inline = popts.inline === true || (popts.inline !== false && (IS_NODE || typeof Worker === 'undefined'));
    var workerUrl = popts.workerUrl || (scriptBase() + 'worker.js?v=' + versionToken());
    var timeoutMs = popts.timeoutMs === undefined ? 300000 : popts.timeoutMs;
    var dead = false, nextId = 1, queue = [], slots = [], chain = Promise.resolve();
    var i;
    for (i = 0; i < size; i++) slots.push({ worker: null, task: null, ready: false, failedBeforeReady: false });

    function abortedErr(msg) { return fail('aborted', msg || 'analysis aborted'); }

    function finish(task, err, value) {
      if (task.done) return;
      task.done = true;
      if (task.timer) clearTimeout(task.timer);
      if (task.signal && task.onAbort) task.signal.removeEventListener('abort', task.onAbort);
      if (task.slot) { task.slot.task = null; task.slot = null; }
      if (err) task.reject(err); else task.resolve(value);
    }

    function killSlot(slot) {
      if (slot.worker) { try { slot.worker.terminate(); } catch (e) { /* ignore */ } }
      slot.worker = null; slot.ready = false; slot.waiting = null;
    }

    function runInline(task) {
      // main-thread fallback (Node, no Worker support, or a worker that could not start)
      var o = Object.assign({}, task.opts, { signal: task.signal });
      analyze(task.input, o).then(function (r) { finish(task, null, r); }, function (e) { finish(task, publicError(e)); });
    }

    function spawn(slot) {
      var w;
      try { w = new Worker(workerUrl); } catch (e) { return null; }
      slot.worker = w; slot.ready = false;
      w.onmessage = function (ev) {
        var m = ev.data || {};
        if (m.type === 'ready') { slot.ready = true; if (slot.waiting) slot.waiting(); return; }
        var task = slot.task;
        if (!task || m.id !== task.id) return;
        if (m.ok) finish(task, null, m.result); else finish(task, publicError(m.error));
        pump();
      };
      w.onerror = function (ev) {
        if (ev && ev.preventDefault) ev.preventDefault();
        var task = slot.task, wasReady = slot.ready;
        killSlot(slot);
        if (task) {
          if (!wasReady && !task.done) { slot.failedBeforeReady = true; task.slot = null; slot.task = null; runInline(task); }   // worker never started: run on this thread
          else finish(task, publicError({ code: 'internal', message: 'worker crashed: ' + (ev && ev.message || 'unknown error') }));
        }
        pump();
      };
      w.onmessageerror = function () {
        var task = slot.task;
        killSlot(slot);
        if (task) finish(task, publicError({ code: 'internal', message: 'worker message could not be decoded' }));
        pump();
      };
      return w;
    }

    function transferList(input) {
      var list = [];
      ['dna', 'foci'].forEach(function (k) {
        var d = input[k].data;
        if (d.byteOffset === 0 && d.byteLength === d.buffer.byteLength && list.indexOf(d.buffer) < 0) list.push(d.buffer);
      });
      return list;
    }

    function start(task, slot) {
      task.slot = slot; slot.task = task;
      if (task.signal && task.signal.aborted) { finish(task, abortedErr()); return; }
      if (slot.failedBeforeReady && !slot.worker) { task.slot = null; slot.task = null; runInline(task); return; }
      var w = slot.worker || spawn(slot);
      if (!w) { slot.failedBeforeReady = true; task.slot = null; slot.task = null; runInline(task); return; }
      var input = task.input, transfer = [];
      if (task.transfer) transfer = transferList(input);
      else input = { dna: copyChannel(input.dna), foci: copyChannel(input.foci), params: input.params };
      if (timeoutMs > 0) {
        task.timer = setTimeout(function () {
          killSlot(slot);
          finish(task, abortedErr('analysis timed out after ' + timeoutMs + ' ms'));
          pump();
        }, timeoutMs);
      }
      // Post only once the worker has said 'ready': if it cannot start at all, the images have not been transferred
      // away yet and the task can still run on the calling thread.
      function post() {
        slot.waiting = null;
        try {
          w.postMessage({ type: 'analyze', id: task.id, input: input, opts: task.opts }, transfer);
        } catch (e) {
          killSlot(slot);
          finish(task, fail('bad_input', 'could not send the images to the worker: ' + (e && e.message)));
          pump();
        }
      }
      if (slot.ready) post(); else slot.waiting = post;
    }

    function pump() {
      if (dead) return;
      for (var s = 0; s < slots.length && queue.length; s++) {
        if (!slots[s].task) start(queue.shift(), slots[s]);
      }
    }

    function copyChannel(c) {
      return { data: c.data.slice(), width: c.width, height: c.height, bitDepth: c.bitDepth };
    }

    function poolAnalyze(input, opts) {
      opts = opts || {};
      return new Promise(function (resolve, reject) {
        if (dead) { reject(abortedErr('pool was terminated')); return; }
        var signal = opts.signal || null;
        if (signal && signal.aborted) { reject(abortedErr()); return; }
        // validate eagerly so bad input never reaches (or hangs) a worker
        try {
          var vo = validateOpts(opts);
          resolveParams(input && input.params, vo.pipeline);
          if (!input || typeof input !== 'object') throw fail('bad_input', 'input must be an object {dna, foci, params?}');
          var a = checkChannel(input.dna, 'dna', vo.maxPx), b = checkChannel(input.foci, 'foci', vo.maxPx);
          if (a.width !== b.width || a.height !== b.height) throw fail('bad_input', 'the two images differ in size');
        } catch (e) { reject(e); return; }
        var task = {
          id: nextId++, input: input, signal: signal, resolve: resolve, reject: reject, done: false, slot: null, timer: null,
          transfer: opts.transfer !== false,
          opts: { pipeline: opts.pipeline, mode: opts.mode, overlay: !!opts.overlay, maxImagePixels: opts.maxImagePixels, maxMemoryBytes: opts.maxMemoryBytes, batchSize: opts.batchSize, debug: !!opts.debug },
        };
        if (signal) {
          task.onAbort = function () {
            var qi = queue.indexOf(task);
            if (qi >= 0) queue.splice(qi, 1);
            var slot = task.slot;
            if (slot && slot.task === task) killSlot(slot);      // a running analysis cannot be interrupted: drop the worker
            finish(task, abortedErr());
            pump();
          };
          signal.addEventListener('abort', task.onAbort);
        }
        if (inline) {
          chain = chain.then(function () {
            if (dead) { finish(task, abortedErr('pool was terminated')); return; }
            if (task.done) return;
            return new Promise(function (done) {
              var o = Object.assign({}, task.opts, { signal: signal });
              analyze(task.input, o).then(function (r) { finish(task, null, r); done(); }, function (e) { finish(task, publicError(e)); done(); });
            });
          });
          return;
        }
        queue.push(task);
        pump();
      });
    }

    function terminate() {
      dead = true;
      queue.splice(0).forEach(function (t) { finish(t, abortedErr('pool was terminated')); });
      slots.forEach(function (s) { var t = s.task; killSlot(s); if (t) finish(t, abortedErr('pool was terminated')); });
    }

    return { analyze: poolAnalyze, terminate: terminate, size: size, inline: inline };
  }

  // ---------------------------------------------------------------------- export

  var E = {
    version: VERSION,
    pipelines: ['v1', 'v2'],
    capabilities: capabilities,
    defaultParams: defaultParams,
    analyze: analyze,
    createPool: createPool,
    parity: parity,
    _internals: {
      gaussKernel: gaussKernel, pairwiseSum: pairwiseSum, gaussian2d: gaussian2d, minmax2d: minmax2d, reflectIndex: reflectIndex,
      normalise: normalise, logOtsu: logOtsu, rint: rint, estimateNuclei: estimateNuclei, percentilesF32: percentilesF32,
      percentilesInt: percentilesInt, quantileLinear: quantileLinear, binaryOpening2: binaryOpening2, fillHoles: fillHoles,
      labelAndFilter: labelAndFilter, memoryEstimate: memoryEstimate, resolveParams: resolveParams, cpuBackend: cpuBackend,
      WGSL: WGSL, selfTestImages: selfTestImages, gpuState: gpuState, gpuBackend: gpuBackend, GpuSession: GpuSession, SPECS: SPECS,
      constants: { DEFAULT_MAX_PIXELS: DEFAULT_MAX_PIXELS, AUTO_GPU_MIN_PIXELS: AUTO_GPU_MIN_PIXELS, AUTO_GPU_MIN_BATCH_PIXELS: AUTO_GPU_MIN_BATCH_PIXELS, AUTO_GPU_BATCH: AUTO_GPU_BATCH },
    },
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = E;
  else root.FociEngine = E;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this));
