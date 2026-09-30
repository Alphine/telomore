// Foci Lab -- IDR plate mode: pure logic (no DOM, no network). UMD: window.FociScreenCore in the browser,
// module.exports in Node (tests: node --test foci/tests/screen-*.test.mjs). Everything the plate page computes
// or decides lives here so that it can be unit-tested: CSV parsing, Spearman, well addressing and the two
// image<->annotation pairings, the per-well table, the heatmap model, the polite fetch scheduler, exports.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.FociScreenCore = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ------------------------------------------------------------------------------------------- validation
  var PLATE_RE = /^[0-9]{1,4}(?:-[0-9]{1,4})?$/;
  var WELL_RE = /^([A-P])([1-9][0-9]?)$/;
  function validPlateName(p) { return typeof p === "string" && PLATE_RE.test(p); }

  /** Validate the JSON of api/plate.php; returns a clean copy or throws Error with a readable message. */
  function checkPlateInfo(j, plate) {
    function bad(m) { throw new Error("unexpected plate data: " + m); }
    if (!j || typeof j !== "object" || j.plate !== plate || !Array.isArray(j.wells)) bad("shape");
    if (j.wells.length < 1 || j.wells.length > 1536) bad("well count");
    var rows = j.rows | 0, cols = j.cols | 0;
    if (rows < 1 || rows > 16 || cols < 1 || cols > 48) bad("plate size");
    var seen = Object.create(null), wells = [];
    for (var i = 0; i < j.wells.length; i++) {
      var w = j.wells[i], m = w && typeof w.well === "string" ? WELL_RE.exec(w.well) : null;
      if (!m || w.plate_well !== plate + "_" + w.well || !Number.isInteger(w.image_id) || w.image_id <= 0 || seen[w.well]) bad("well " + i);
      var r = m[1].charCodeAt(0) - 65, c = +m[2] - 1;
      if (r >= rows || c < 0 || c >= cols) bad("well outside the plate");
      seen[w.well] = 1;
      wells.push({ well: w.well, plate_well: w.plate_well, image_id: w.image_id, r: r, c: c });
    }
    var q = j.quota && typeof j.quota === "object" ? j.quota : {};
    function num(x, d) { return typeof x === "number" && isFinite(x) && x > 0 ? x : d; }
    return {
      plate: plate, rows: rows, cols: cols, wells: wells,
      quota: { perPlate: num(q.requests_per_plate, 2 * wells.length), hitPerMin: num(q.cached_responses_per_min, 1200), missPerMin: num(q.uncached_responses_per_min, 60), missPerDay: num(q.uncached_responses_per_day, 2000) },
    };
  }

  // ------------------------------------------------------------------------------------------------- CSV
  /** RFC 4180 parser: BOM, CRLF/LF/CR, quoted fields with commas, doubled quotes and newlines. Returns array of string arrays. */
  function parseCsv(text) {
    var s = String(text == null ? "" : text);
    if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
    var rows = [], row = [], i = 0, n = s.length, f = "", inQ = false, any = false;
    while (i < n) {
      var ch = s[i];
      if (inQ) {
        if (ch === '"') { if (s[i + 1] === '"') { f += '"'; i += 2; continue; } inQ = false; i++; continue; }
        f += ch; i++; continue;
      }
      if (ch === '"' && f === "") { inQ = true; any = true; i++; continue; }
      if (ch === ",") { row.push(f); f = ""; any = true; i++; continue; }
      if (ch === "\r" || ch === "\n") {
        if (ch === "\r" && s[i + 1] === "\n") i++;
        i++;
        if (any || f !== "" || row.length) { row.push(f); rows.push(row); }
        row = []; f = ""; any = false; continue;
      }
      f += ch; any = true; i++;
    }
    if (any || f !== "" || row.length) { row.push(f); rows.push(row); }
    return rows;
  }

  function csvCell(v) {
    if (v == null) return "";
    if (typeof v === "boolean") return v ? "true" : "false";
    if (typeof v === "number") return isFinite(v) ? String(v) : "";
    var s = String(v);
    if (/^[=+\-@\t\r]/.test(s) && !/^[+-]?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(s)) s = "'" + s;   // spreadsheet formula guard
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function toCsvText(header, rows) {
    var out = [header.map(csvCell).join(",")];
    for (var i = 0; i < rows.length; i++) out.push(rows[i].map(csvCell).join(","));
    return out.join("\r\n") + "\r\n";
  }

  // --------------------------------------------------------------------------------------------- statistics
  /** Average ranks (1-based; ties share the mean of their positions). */
  function rankAverage(a) {
    var n = a.length, idx = new Array(n), r = new Array(n), i, j;
    for (i = 0; i < n; i++) idx[i] = i;
    idx.sort(function (p, q) { return a[p] - a[q] || p - q; });
    i = 0;
    while (i < n) {
      j = i;
      while (j + 1 < n && a[idx[j + 1]] === a[idx[i]]) j++;
      var avg = (i + j) / 2 + 1;
      for (var k = i; k <= j; k++) r[idx[k]] = avg;
      i = j + 1;
    }
    return r;
  }
  function pearson(x, y) {
    var n = x.length, sx = 0, sy = 0, i;
    for (i = 0; i < n; i++) { sx += x[i]; sy += y[i]; }
    var mx = sx / n, my = sy / n, sxx = 0, syy = 0, sxy = 0;
    for (i = 0; i < n; i++) { var dx = x[i] - mx, dy = y[i] - my; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; }
    if (!(sxx > 0) || !(syy > 0)) return null;
    return Math.max(-1, Math.min(1, sxy / Math.sqrt(sxx * syy)));
  }
  /** Spearman rho = Pearson on average ranks (tie-correct). Pairs with a non-finite member are dropped. rho is null when n < 3 or an input is constant. */
  function spearman(x, y) {
    var xs = [], ys = [];
    for (var i = 0; i < Math.min(x.length, y.length); i++) {
      if (typeof x[i] === "number" && typeof y[i] === "number" && isFinite(x[i]) && isFinite(y[i])) { xs.push(x[i]); ys.push(y[i]); }
    }
    var n = xs.length;
    if (n < 3) return { rho: null, n: n, reason: "fewer than 3 pairs" };
    var rho = pearson(rankAverage(xs), rankAverage(ys));
    return rho == null ? { rho: null, n: n, reason: "one variable is constant" } : { rho: rho, n: n, reason: null };
  }

  // --------------------------------------------------------------------------------- well addressing, pairings
  function wellToRC(name) {
    var m = typeof name === "string" ? WELL_RE.exec(name) : null;
    return m ? { r: m[1].charCodeAt(0) - 65, c: +m[2] - 1 } : null;
  }
  function rcToWell(r, c) { return String.fromCharCode(65 + r) + (c + 1); }   // "A1", never "A01"

  /**
   * The two candidate rules for which annotation row belongs to the IMAGE at grid position (r, c), zero-based:
   *   "name"     -- the annotation row whose Well name is the image's well name (Experiment L's rule).
   *   "colmajor" -- the annotation row whose Well Number is c * nRows + r + 1 (the image grid numbered column by
   *                 column: A1, B1, ..., L1, A2, ...). The annotation's Well Number itself is row-major over nCols
   *                 columns (A1 = 1, A2 = 2, ..., A32 = 32, B1 = 33): docs/EXPERIMENT_PROTOCOL.md 15.4.
   * Which rule is right is UNRESOLVED; this function just implements each.
   */
  var PAIRINGS = ["name", "colmajor"];
  function annotationWellNumber(pairing, r, c, nRows, nCols) {
    if (pairing === "name") return r * nCols + c + 1;
    if (pairing === "colmajor") return c * nRows + r + 1;
    throw new Error("unknown pairing " + pairing);
  }
  function annotationWellName(pairing, r, c, nRows, nCols) {
    if (pairing === "name") return rcToWell(r, c);
    var n = annotationWellNumber(pairing, r, c, nRows, nCols) - 1;   // 0-based row-major index in the annotation's layout
    return rcToWell(Math.floor(n / nCols), n % nCols);
  }

  // ---------------------------------------------------------------------------------- the authors' numbers
  function toNum(s) { if (s == null || s === "") return null; var v = +s; return isFinite(v) ? v : null; }
  /** Index foci_wells.csv rows of one plate: well name -> {cells, fpc, normFpc, qc, gene}. */
  function indexAuthors(csvRows, plate) {
    var out = Object.create(null);
    if (!csvRows.length) return out;
    var h = csvRows[0], ci = {};
    for (var i = 0; i < h.length; i++) ci[h[i]] = i;
    ["plate_well", "cells", "fpc", "qc"].forEach(function (k) { if (!(k in ci)) throw new Error("foci_wells.csv: missing column " + k); });
    var pre = plate + "_";
    for (var r = 1; r < csvRows.length; r++) {
      var row = csvRows[r], pw = row[ci.plate_well];
      if (typeof pw !== "string" || pw.slice(0, pre.length) !== pre) continue;
      var well = pw.slice(pre.length);
      if (!WELL_RE.test(well)) continue;
      out[well] = { cells: toNum(row[ci.cells]), fpc: toNum(row[ci.fpc]), normFpc: "norm_fpc" in ci ? toNum(row[ci.norm_fpc]) : null, qc: row[ci.qc] || "", gene: "gene" in ci ? row[ci.gene] || "" : "" };
    }
    return out;
  }
  /** controls = data/screen_controls.json "plates[plate]": {well: [kind, cells, fpc, qcRemoved]}. */
  function authorFor(well, authors, controls) {
    if (authors && authors[well]) return { well: well, kind: "sample", cells: authors[well].cells, fpc: authors[well].fpc, qc: authors[well].qc, gene: authors[well].gene };
    var c = controls && Object.prototype.hasOwnProperty.call(controls, well) ? controls[well] : null;
    if (c) return { well: well, kind: c[0] === "p" ? "positive control" : "negative control", cells: c[1], fpc: c[2], qc: c[3] ? "remove" : "pass", gene: "" };
    return { well: well, kind: "none", cells: null, fpc: null, qc: "", gene: "" };
  }

  // ---------------------------------------------------------------------------------------- per-well table
  /** Compact per-well record from an engine result. Foci per cell is foci.count / nuclei.count (NaN when no nucleus). */
  function summariseResult(res, extra) {
    var nuc = res && res.nuclei && Number.isFinite(res.nuclei.count) ? res.nuclei.count : NaN;
    var foc = res && res.foci && Number.isFinite(res.foci.count) ? res.foci.count : NaN;
    return Object.assign({
      nuclei: nuc, foci: foc, fpc: nuc > 0 && isFinite(foc) ? foc / nuc : NaN,
      backend: res && typeof res.backend === "string" ? res.backend.slice(0, 20) : "",
      ms: res && res.timing_ms != null ? (typeof res.timing_ms === "number" ? res.timing_ms : Number(res.timing_ms.total) || null) : null,
      warnings: res && Array.isArray(res.warnings) ? res.warnings.length : 0,
    }, extra || {});
  }

  /**
   * One row per plate well. results: {well: summary|{error}}. Each row carries BOTH pairings.
   * status: "pending" | "ok" | "failed".
   */
  function buildTable(plateInfo, results, authors, controls) {
    var rows = [];
    for (var i = 0; i < plateInfo.wells.length; i++) {
      var w = plateInfo.wells[i], res = results[w.well] || null;
      var row = { well: w.well, r: w.r, c: w.c, image_id: w.image_id, status: !res ? "pending" : res.error ? "failed" : "ok",
        error: res && res.error ? String(res.error) : "", nuclei: NaN, foci: NaN, fpc: NaN, backend: "", pair: {} };
      if (res && !res.error) { row.nuclei = res.nuclei; row.foci = res.foci; row.fpc = res.fpc; row.backend = res.backend || ""; }
      PAIRINGS.forEach(function (p) {
        var name = annotationWellName(p, w.r, w.c, plateInfo.rows, plateInfo.cols);
        row.pair[p] = authorFor(name, authors, controls);
      });
      rows.push(row);
    }
    return rows;
  }

  /**
   * Agreement with the authors' numbers under one pairing. Only wells that are analysed, have a nucleus (for foci/cell),
   * are sample wells and passed the authors' QC are compared. Returns Spearman + n for both endpoints and the data for scatter plots.
   */
  function comparePairing(table, pairing) {
    var f = { x: [], y: [], labels: [] }, nu = { x: [], y: [], labels: [] }, skipped = { notAnalysed: 0, control: 0, qcRemoved: 0, noAuthorValue: 0 };
    for (var i = 0; i < table.length; i++) {
      var t = table[i], a = t.pair[pairing];
      if (t.status !== "ok") { skipped.notAnalysed++; continue; }
      if (a.kind !== "sample") { if (a.kind === "none") skipped.noAuthorValue++; else skipped.control++; continue; }
      if (a.qc !== "pass") { skipped.qcRemoved++; continue; }
      if (isFinite(t.fpc) && a.fpc != null) { f.x.push(a.fpc); f.y.push(t.fpc); f.labels.push(t.well); }
      if (isFinite(t.nuclei) && a.cells != null) { nu.x.push(a.cells); nu.y.push(t.nuclei); nu.labels.push(t.well); }
    }
    return { pairing: pairing, foci: Object.assign(spearman(f.y, f.x), { points: f }), nuclei: Object.assign(spearman(nu.y, nu.x), { points: nu }), skipped: skipped };
  }

  // -------------------------------------------------------------------------------------------------- heatmap
  var VIRIDIS = ["#440154", "#472d7b", "#3b528b", "#2c728e", "#21918c", "#28ae80", "#5ec962", "#addc30", "#fde725"];   // colour-blind-safe sequential
  function hexToRgb(h) { return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]; }
  function colorFor(v, lo, hi) {
    if (!isFinite(v)) return null;
    var t = hi > lo ? (v - lo) / (hi - lo) : 0.5;
    t = Math.max(0, Math.min(1, t));
    var p = t * (VIRIDIS.length - 1), i = Math.min(VIRIDIS.length - 2, Math.floor(p)), f = p - i, a = hexToRgb(VIRIDIS[i]), b = hexToRgb(VIRIDIS[i + 1]);
    return "#" + [0, 1, 2].map(function (k) { var x = Math.round(a[k] + (b[k] - a[k]) * f); return (x < 16 ? "0" : "") + x.toString(16); }).join("");
  }
  function quantile(sorted, q) {
    if (!sorted.length) return NaN;
    var p = (sorted.length - 1) * q, i = Math.floor(p), f = p - i;
    return i + 1 < sorted.length ? sorted[i] * (1 - f) + sorted[i + 1] * f : sorted[i];
  }
  var METRICS = {
    fpc: { label: "Our foci per cell", get: function (t) { return t.status === "ok" ? t.fpc : NaN; } },
    nuclei: { label: "Our nucleus count", get: function (t) { return t.status === "ok" ? t.nuclei : NaN; } },
    author_fpc: { label: "Authors' foci per cell", get: function (t, p) { return t.pair[p].fpc == null ? NaN : t.pair[p].fpc; } },
    author_cells: { label: "Authors' cell count", get: function (t, p) { return t.pair[p].cells == null ? NaN : t.pair[p].cells; } },
  };
  /** Heatmap cells with colour (robust 2nd-98th percentile range), status and marks for the chosen pairing. */
  function heatmapModel(table, plateInfo, metric, pairing) {
    var m = METRICS[metric] || METRICS.fpc, vals = [], i;
    for (i = 0; i < table.length; i++) { var v = m.get(table[i], pairing); if (isFinite(v)) vals.push(v); }
    vals.sort(function (a, b) { return a - b; });
    var lo = vals.length ? quantile(vals, 0.02) : 0, hi = vals.length ? quantile(vals, 0.98) : 1;
    if (!(hi > lo)) { lo = vals.length ? vals[0] : 0; hi = vals.length ? vals[vals.length - 1] : 1; }
    var byPos = Object.create(null);
    table.forEach(function (t) { byPos[t.r + "," + t.c] = t; });
    var cells = [];
    for (var r = 0; r < plateInfo.rows; r++) for (var c = 0; c < plateInfo.cols; c++) {
      var t = byPos[r + "," + c];
      if (!t) { cells.push({ r: r, c: c, well: rcToWell(r, c), exists: false, value: NaN, color: null, status: "absent", qcRemoved: false, control: "" }); continue; }
      var a = t.pair[pairing], val = m.get(t, pairing), isAuthor = metric.indexOf("author") === 0;
      cells.push({
        r: r, c: c, well: t.well, exists: true, value: val, color: colorFor(val, lo, hi),
        status: isAuthor ? (isFinite(val) ? "ok" : "absent") : t.status,
        qcRemoved: a.qc === "remove", control: a.kind === "positive control" ? "p" : a.kind === "negative control" ? "n" : "", annotWell: a.well,
      });
    }
    return { cells: cells, lo: lo, hi: hi, label: m.label, n: vals.length };
  }

  // -------------------------------------------------------------------------------------- polite scheduler
  function realSleep(ms, signal) {
    return new Promise(function (resolve) {
      if (signal && signal.aborted) return resolve();
      var t = setTimeout(done, ms);
      function done() { if (signal) signal.removeEventListener("abort", done); clearTimeout(t); resolve(); }
      if (signal) signal.addEventListener("abort", done, { once: true });
    });
  }
  /** Retry-After header value -> seconds (delta-seconds or HTTP-date), or null. */
  function parseRetryAfter(v, nowMs) {
    if (v == null) return null;
    var s = String(v).trim();
    if (/^[0-9]{1,7}$/.test(s)) return +s;
    var d = /^[A-Za-z]{3},\s/.test(s) ? Date.parse(s) : NaN;   // HTTP-date only ("Wed, 21 Oct 2026 07:28:00 GMT")
    return isFinite(d) ? Math.max(0, Math.ceil((d - (nowMs == null ? Date.now() : nowMs)) / 1000)) : null;
  }

  /**
   * Runs tasks {id, run({signal, attempt})} with at most `concurrency` in flight.
   *  - an error with status 429/503 is "throttled": ALL workers wait for Retry-After (capped), the task goes back to the
   *    queue; after `maxThrottleStreak` throttles in a row with no success the run stops with status "busy";
   *  - other 5xx / network errors (no status) retry with exponential backoff up to `maxAttempts`, then the task fails;
   *  - other 4xx, and errors with .fatal, fail the task at once; .name === "AbortError" puts it back (stop/cancel);
   *  - pause() stops taking new tasks and lets running ones finish; cancel() also aborts running ones;
   *  - start() may be called again to resume with what is still pending. Nothing ever retries forever.
   */
  function createScheduler(opts) {
    var o = Object.assign({ concurrency: 3, maxAttempts: 4, baseBackoffMs: 1000, maxBackoffMs: 30000, maxRetryAfterMs: 120000, defaultRetryAfterMs: 5000,
      maxThrottleStreak: 8, minGapMs: 0, sleep: realSleep, now: function () { return Date.now(); }, random: Math.random, onEvent: function () {} }, opts || {});
    var conc = Math.max(1, Math.min(3, o.concurrency | 0 || 1));   // never more than 3, whatever the caller asks
    var tasks = o.tasks || [], byId = new Map(), queue = [], done = new Set(), failed = new Map(), attempts = new Map();
    tasks.forEach(function (t) { byId.set(t.id, t); queue.push(t.id); });
    var active = 0, runState = "idle", ctrl = null, napCtrl = null, blockedUntil = 0, streak = 0, lastStart = -Infinity, stopReason = null, finishers = [];

    function emit(type, data) { try { o.onEvent(Object.assign({ type: type }, data || {})); } catch (e) { /* observers must not break the run */ } }
    function snapshot(status) { return { status: status, done: done.size, failed: failed.size, pending: tasks.length - done.size - failed.size, total: tasks.length }; }
    function settle() {
      if (active > 0) return;
      var status = stopReason || (queue.length ? "stopped" : "done");
      runState = "idle";
      var fs = finishers; finishers = [];
      fs.forEach(function (f) { f(snapshot(status)); });
    }
    async function gate(signal) {   // global politeness: Retry-After block, minimum gap between task starts
      while (runState === "running") {
        var t = o.now();
        if (t < blockedUntil) { await o.sleep(blockedUntil - t, signal); continue; }
        var startAt = Math.max(t, lastStart + o.minGapMs);   // reserve a start slot so concurrent workers are spaced out
        lastStart = startAt;
        if (startAt > t) { await o.sleep(startAt - t, signal); if (o.now() < blockedUntil) continue; }
        return runState === "running";
      }
      return false;
    }
    async function worker() {
      active++;
      try {
        while (runState === "running" && queue.length) {
          if (!(await gate(napCtrl.signal)) || runState !== "running") break;
          var id = queue.shift();
          if (id === undefined) break;
          var task = byId.get(id), attempt = (attempts.get(id) || 0) + 1;
          attempts.set(id, attempt);
          try {
            await task.run({ signal: ctrl.signal, attempt: attempt });
            done.add(id); streak = 0;
            emit("done", { id: id });
          } catch (e) {
            if (e && e.name === "AbortError") { queue.unshift(id); attempts.set(id, attempt - 1); break; }
            var st = e && typeof e.status === "number" ? e.status : 0;
            if (st === 429 || st === 503) {
              streak++;
              var ra = e.retryAfter != null && isFinite(e.retryAfter) ? e.retryAfter * 1000 : Math.min(o.maxRetryAfterMs, o.defaultRetryAfterMs * Math.pow(2, Math.min(streak - 1, 5)));
              var ms = Math.max(1000, Math.min(o.maxRetryAfterMs, ra));
              blockedUntil = Math.max(blockedUntil, o.now() + ms);
              attempts.set(id, attempt - 1);       // throttling is not the task's fault; the streak limit bounds the total
              queue.unshift(id);
              emit("throttled", { id: id, status: st, waitMs: ms, streak: streak });
              if (streak >= o.maxThrottleStreak) { stopReason = "busy"; runState = "stopping"; napCtrl.abort(); emit("busy", { streak: streak }); break; }
            } else if (e && !e.fatal && (st === 0 || st >= 500) && attempt < o.maxAttempts) {
              var back = Math.min(o.maxBackoffMs, o.baseBackoffMs * Math.pow(2, attempt - 1)) * (0.75 + 0.5 * o.random());
              emit("retry", { id: id, attempt: attempt, waitMs: back, error: e });
              queue.push(id);                        // behind the others, so one bad well cannot stall the rest
              await o.sleep(back, napCtrl.signal);
            } else {
              failed.set(id, e);
              emit("failed", { id: id, error: e, attempts: attempt });
            }
          }
        }
      } finally {
        active--;
        settle();
      }
    }
    return {
      /** Start or resume. Resolves with {status: done|paused|cancelled|busy|stopped, done, failed, pending, total}. */
      start: function () {
        return new Promise(function (resolve) {
          if (runState !== "idle") return resolve(snapshot("already-running"));
          if (!queue.length) return resolve(snapshot("done"));
          runState = "running"; stopReason = null; streak = 0; ctrl = new AbortController(); napCtrl = new AbortController(); finishers.push(resolve);
          for (var i = 0; i < conc && i < queue.length; i++) worker();
        });
      },
      pause: function () { if (runState === "running") { stopReason = "paused"; runState = "stopping"; napCtrl.abort(); } },   // running requests finish; sleeping workers wake up
      cancel: function () { if (runState === "running" || runState === "stopping") { stopReason = "cancelled"; runState = "stopping"; napCtrl.abort(); ctrl.abort(); } },
      state: function () { return runState; },
      snapshot: function () { return snapshot(runState); },
      failedTasks: function () { return Array.from(failed.entries()); },
      isDone: function (id) { return done.has(id); },
      /** Put failed tasks back in the queue (user pressed "retry failed"). */
      requeueFailed: function () { failed.forEach(function (_, id) { attempts.set(id, 0); queue.push(id); }); failed.clear(); },
    };
  }

  // ------------------------------------------------------------------------------------ session budget
  /** Hard cap on image requests per browser session. store = {get():number, set(n)} (sessionStorage-backed in the page). */
  function createBudget(cap, store) {
    var mem = 0;
    function get() { try { var v = store && store.get(); return Number.isFinite(v) && v >= 0 ? v : mem; } catch (e) { return mem; } }
    function set(n) { mem = n; try { store && store.set(n); } catch (e) { /* storage may be blocked */ } }
    return {
      cap: cap,
      used: get,
      remaining: function () { return Math.max(0, cap - get()); },
      spend: function (n) { if (get() + n > cap) return false; set(get() + n); return true; },
      canStart: function (need) { return get() + need <= cap; },
    };
  }

  /** Rough time for a whole plate, from the server's published limits. */
  function estimate(info, nUncached) {
    var images = info.quota.perPlate, miss = Math.min(images, nUncached == null ? images : nUncached);
    return {
      images: images,
      firstTimeMinutes: Math.ceil(miss / info.quota.missPerMin),                 // limited by the uncached-per-minute allowance
      cachedMinutes: Math.max(1, Math.ceil(images / 400)),                        // ~400 cached images per minute through 3 connections: a conservative guess
      dayShare: miss / info.quota.missPerDay,
    };
  }

  // ---------------------------------------------------------------------------------------------- exports
  var CSV_HEADER = ["plate", "well", "row", "column", "image_id", "status", "nuclei", "foci", "foci_per_cell", "backend",
    "name_pairing_annot_well", "name_pairing_kind", "name_pairing_qc", "name_pairing_cells", "name_pairing_foci_per_cell",
    "colmajor_pairing_annot_well", "colmajor_pairing_kind", "colmajor_pairing_qc", "colmajor_pairing_cells", "colmajor_pairing_foci_per_cell"];
  function exportCsv(plate, table) {
    var rows = table.map(function (t) {
      var a = t.pair.name, b = t.pair.colmajor;
      return [plate, t.well, t.r + 1, t.c + 1, t.image_id, t.status, t.nuclei, t.foci, t.fpc, t.backend,
        a.well, a.kind, a.qc, a.cells, a.fpc, b.well, b.kind, b.qc, b.cells, b.fpc];
    });
    return toCsvText(CSV_HEADER, rows);
  }
  function buildProvenance(p) {
    function sp(c) { return { spearman: c.rho, n: c.n, note: c.reason }; }
    var cmp = {};
    (p.comparisons || []).forEach(function (c) { cmp[c.pairing] = { foci_per_cell_vs_authors_fpc: sp(c.foci), nuclei_vs_authors_cell_count: sp(c.nuclei), skipped: c.skipped }; });
    return {
      tool: "Foci Lab IDR plate mode",
      generated_utc: p.generatedUtc,
      started_utc: p.startedUtc || null,
      plate: p.plate,
      plate_geometry: { rows: p.rows, columns: p.cols, wells: p.nWells },
      wells: { analysed: p.analysed, failed: p.failed, pending: p.pending },
      engine: { version: p.engineVersion || null, backends_used: p.backends || [], requested_mode: p.mode || null, capabilities: p.capabilities || null },
      params: p.params == null ? null : p.params,
      pairing_status: "UNRESOLVED: which annotation row belongs to which image is an open question (docs/EXPERIMENT_PROTOCOL.md 15.4); both rules are reported and neither is asserted.",
      pairings: cmp,
      sources: {
        images: "IDR idr0010 screen 1351 via the Foci Lab cache proxy (api/well.php), 8-bit display rendering, dna and 53BP1 channels",
        authors_table: "data/downloads/foci_wells.csv and data/screen_controls.json (authors' per-well numbers, idr0010-screenA-annotation.csv)",
      },
      attribution: p.attribution || "Doil C, et al. Cell 2009;136:435-446 (doi:10.1016/j.cell.2008.12.041), via the Image Data Resource idr0010, CC BY 4.0.",
    };
  }

  return {
    validPlateName: validPlateName, checkPlateInfo: checkPlateInfo, parseCsv: parseCsv, csvCell: csvCell, toCsvText: toCsvText,
    rankAverage: rankAverage, spearman: spearman, wellToRC: wellToRC, rcToWell: rcToWell, PAIRINGS: PAIRINGS,
    annotationWellNumber: annotationWellNumber, annotationWellName: annotationWellName, indexAuthors: indexAuthors, authorFor: authorFor,
    summariseResult: summariseResult, buildTable: buildTable, comparePairing: comparePairing, METRICS: METRICS, heatmapModel: heatmapModel,
    colorFor: colorFor, VIRIDIS: VIRIDIS, createScheduler: createScheduler, parseRetryAfter: parseRetryAfter, createBudget: createBudget,
    estimate: estimate, exportCsv: exportCsv, buildProvenance: buildProvenance, CSV_HEADER: CSV_HEADER,
  };
});
