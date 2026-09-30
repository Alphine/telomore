// Foci Lab -- well image viewer: channel toggles, zoom/pan, scale bar, side-by-side compare,
// PNG download with the attribution rendered into the image.
//
// Uses api/well.php?w=<well>&ch=dna|foci (8-bit greyscale PNG) and &info=1 (JSON). Both are optional:
// if the proxy does not support them (older deployment, IDR error) the plain coloured composite is
// shown instead and the controls that cannot work are hidden.
(function (root) {
  "use strict";
  var L = root.FociLib;
  var MAX_ZOOM = 16;

  function create(opts) {
    var host = opts.panesEl, api = opts.api || "api/well.php";
    var mode = "merged", zoom = 1, cx = 0.5, cy = 0.5, panes = [];
    var chBtns = opts.channelsEl ? Array.prototype.slice.call(opts.channelsEl.querySelectorAll("button[data-mode]")) : [];

    // ------------------------------------------------------------ loading
    function fetchOk(url, re) {
      return fetch(url).then(function (r) {
        if (!r.ok || !re.test(r.headers.get("content-type") || "")) throw new Error("unsupported");
        return r;
      });
    }
    function decode(blob) {
      return new Promise(function (resolve, reject) {
        var u = URL.createObjectURL(blob), img = new Image();
        img.onload = function () { URL.revokeObjectURL(u); resolve(img); };
        img.onerror = function () { URL.revokeObjectURL(u); reject(new Error("decode")); };
        img.src = u;
      });
    }
    function readGrey(img) {
      var c = document.createElement("canvas"); c.width = img.naturalWidth; c.height = img.naturalHeight;
      var x = c.getContext("2d", { willReadFrequently: true }); x.drawImage(img, 0, 0);
      return x.getImageData(0, 0, c.width, c.height);
    }
    function tinted(dna, foci, w, h, useD, useF) {
      var c = document.createElement("canvas"); c.width = w; c.height = h;
      var x = c.getContext("2d"), out = x.createImageData(w, h), o = out.data, d = dna && dna.data, f = foci && foci.data;
      for (var i = 0; i < o.length; i += 4) {
        o[i] = 0; o[i + 1] = useF ? f[i] : 0; o[i + 2] = useD ? d[i] : 0; o[i + 3] = 255;
      }
      x.putImageData(out, 0, 0);
      return c;
    }
    function channel(well, ch) {
      return fetchOk(api + "?w=" + encodeURIComponent(well) + "&ch=" + ch, /^image\/png/i).then(function (r) { return r.blob(); }).then(decode).then(readGrey);
    }
    function infoOf(well) {
      return fetchOk(api + "?w=" + encodeURIComponent(well) + "&info=1", /json/i).then(function (r) { return r.json(); }).then(function (j) {
        if (!j || typeof j !== "object") throw new Error("bad info");
        return j;
      });
    }
    function loadImg(src) {
      return new Promise(function (resolve, reject) { var i = new Image(); i.onload = function () { resolve(i); }; i.onerror = function () { reject(new Error("load")); }; i.src = src; });
    }

    function makePane(i) {
      var fig = document.createElement("figure"); fig.className = "vw-pane";
      var cap = document.createElement("figcaption"); cap.className = "vw-cap";
      var title = document.createElement("span"); title.className = "vw-title";
      var dl = document.createElement("button"); dl.type = "button"; dl.className = "vw-dl"; dl.textContent = "Download PNG"; dl.disabled = true;
      cap.appendChild(title); cap.appendChild(dl);
      var stage = document.createElement("div"); stage.className = "vw-stage"; stage.tabIndex = 0; stage.setAttribute("role", "group");
      var canvas = document.createElement("canvas"); canvas.setAttribute("role", "img");
      stage.appendChild(canvas);
      var st = document.createElement("p"); st.className = "note vw-status"; st.setAttribute("role", "status");
      fig.appendChild(cap); fig.appendChild(stage); fig.appendChild(st);
      host.appendChild(fig);
      var p = { i: i, fig: fig, title: title, dl: dl, stage: stage, canvas: canvas, ctx: canvas.getContext("2d"), status: st, token: 0, w: 0, h: 0, offs: null, comp: null, overlay: null, info: null, ch: false, well: null, label: "", cw: 0, ch_: 0 };
      wire(p);
      if (root.ResizeObserver) new ResizeObserver(function () { draw(p); }).observe(stage);
      dl.addEventListener("click", function () { download(p); });
      return p;
    }

    function load(i, well, label) {
      while (panes.length <= i) panes.push(makePane(panes.length));
      var p = panes[i], tok = ++p.token;
      p.well = well; p.label = label || ""; p.offs = null; p.comp = null; p.overlay = null; p.info = null; p.ch = false; p.w = p.h = 0;
      p.title.textContent = well + (label ? " · " + label : "");
      p.stage.setAttribute("aria-label", "Image viewer for well " + well + ". Plus and minus zoom, arrow keys pan, 0 resets.");
      p.canvas.setAttribute("aria-label", "Microscopy of well " + well + ": DNA in blue, 53BP1 in green");
      p.status.textContent = "Loading image from IDR…"; p.dl.disabled = true;
      draw(p);
      var info = infoOf(well).catch(function () { return null; });
      var both = Promise.all([channel(well, "dna"), channel(well, "foci")]).catch(function () { return null; });
      Promise.all([info, both]).then(function (r) {
        if (tok !== p.token) return null;
        p.info = r[0];
        if (opts.onInfo) opts.onInfo(i, p.info);
        var c = r[1];
        if (c && c[0].width === c[1].width && c[0].height === c[1].height) {
          p.w = c[0].width; p.h = c[0].height; p.ch = true;
          p.offs = { merged: tinted(c[0], c[1], p.w, p.h, true, true), dna: tinted(c[0], c[1], p.w, p.h, true, false), foci: tinted(c[0], c[1], p.w, p.h, false, true) };
          return null;
        }
        return loadImg(api + "?w=" + encodeURIComponent(well)).then(function (img) {
          if (tok !== p.token) return;
          p.comp = img; p.w = img.naturalWidth; p.h = img.naturalHeight;
        });
      }).then(function () {
        if (tok !== p.token) return;
        p.status.textContent = "";
        if (p.w) p.stage.style.aspectRatio = p.w + " / " + p.h;
        p.dl.disabled = !p.w;
        syncTools(); draw(p);
      }).catch(function () {
        if (tok !== p.token) return;
        p.status.textContent = "Image could not be loaded right now.";
      });
      syncTools();
      return p;
    }

    function remove(i) {
      while (panes.length > i) { var p = panes.pop(); p.token++; if (p.fig.parentNode) p.fig.parentNode.removeChild(p.fig); }
      host.classList.toggle("two-up", panes.length > 1);
      syncTools();
    }
    function clear() { remove(0); zoom = 1; cx = cy = 0.5; mode = "merged"; syncTools(); }

    function setOverlay(i, dataUrl, note) {
      var p = panes[i]; if (!p) return Promise.reject(new Error("no pane"));
      var tok = p.token;
      return loadImg(dataUrl).then(function (img) {
        if (tok !== p.token) return;
        p.overlay = img; p.overlayNote = note || "Our outline"; if (!p.w) { p.w = img.naturalWidth; p.h = img.naturalHeight; }
        draw(p); syncTools();
      });
    }
    function clearOverlay() { panes.forEach(function (p) { p.overlay = null; }); }

    // -------------------------------------------------------------- tools
    function syncTools() {
      host.classList.toggle("two-up", panes.length > 1);
      var loaded = panes.length > 0 && panes.every(function (p) { return p.w; });
      var can = loaded && panes.every(function (p) { return p.ch; });
      // hidden only once we know the channels cannot work; disabled while loading (no layout jump)
      if (opts.channelsEl) opts.channelsEl.hidden = loaded && !can;
      var overlayOn = panes.some(function (p) { return p.overlay; });
      chBtns.forEach(function (b) { b.disabled = !can; b.setAttribute("aria-pressed", String(!overlayOn && b.dataset.mode === mode)); });
      if (opts.onTools) opts.onTools({ channels: can, panes: panes.length });
      root.FociViewer._state = state();
    }
    function state() {
      return { mode: mode, zoom: zoom, cx: cx, cy: cy, panes: panes.map(function (p) { return { well: p.well, channels: p.ch, w: p.w, h: p.h, info: p.info, overlay: !!p.overlay, status: p.status.textContent }; }) };
    }
    function setMode(m) { mode = m; clearOverlay(); panes.forEach(draw); syncTools(); }
    chBtns.forEach(function (b) { b.addEventListener("click", function () { setMode(b.dataset.mode); }); });

    function clampView() {
      zoom = Math.max(1, Math.min(MAX_ZOOM, zoom));
      if (zoom === 1) { cx = cy = 0.5; } else { cx = Math.max(0, Math.min(1, cx)); cy = Math.max(0, Math.min(1, cy)); }
      panes.forEach(function (p) { p.stage.style.touchAction = zoom > 1 ? "none" : "pan-y"; });
    }
    function redrawAll() { clampView(); panes.forEach(draw); root.FociViewer._state = state(); }
    function scaleOf(p) { var cw = p.stage.clientWidth, ch = p.stage.clientHeight; return p.w ? Math.min(cw / p.w, ch / p.h) * zoom : 1; }
    // zoom by factor keeping the image point under (px, py) (stage-relative CSS px) fixed
    function zoomAt(p, factor, px, py) {
      var cw = p.stage.clientWidth, ch = p.stage.clientHeight, before = scaleOf(p);
      if (!p.w || !before) return;
      var ix = cx + (px - cw / 2) / (p.w * before), iy = cy + (py - ch / 2) / (p.h * before);
      zoom = Math.max(1, Math.min(MAX_ZOOM, zoom * factor));
      var after = scaleOf(p);
      cx = ix - (px - cw / 2) / (p.w * after); cy = iy - (py - ch / 2) / (p.h * after);
      redrawAll();
    }
    function zoomCentre(f) { if (panes[0]) zoomAt(panes[0], f, panes[0].stage.clientWidth / 2, panes[0].stage.clientHeight / 2); }
    function pan(p, dx, dy) { var s = scaleOf(p); if (!p.w || !s) return; cx -= dx / (p.w * s); cy -= dy / (p.h * s); redrawAll(); }
    function reset() { zoom = 1; cx = cy = 0.5; redrawAll(); }
    if (opts.zoomInEl) opts.zoomInEl.addEventListener("click", function () { zoomCentre(1.4); });
    if (opts.zoomOutEl) opts.zoomOutEl.addEventListener("click", function () { zoomCentre(1 / 1.4); });
    if (opts.resetEl) opts.resetEl.addEventListener("click", reset);

    function wire(p) {
      var ptrs = new Map(), last = null;
      p.stage.addEventListener("wheel", function (e) {
        e.preventDefault();
        var r = p.stage.getBoundingClientRect(), dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
        zoomAt(p, Math.exp(-dy * 0.0016), e.clientX - r.left, e.clientY - r.top);
      }, { passive: false });
      p.stage.addEventListener("pointerdown", function (e) {
        if (e.pointerType === "mouse" && e.button !== 0) return;
        try { p.stage.setPointerCapture(e.pointerId); } catch (x) { /* ignore */ }
        ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
        last = null;
      });
      p.stage.addEventListener("pointermove", function (e) {
        if (!ptrs.has(e.pointerId)) return;
        var prev = ptrs.get(e.pointerId), cur = { x: e.clientX, y: e.clientY };
        if (ptrs.size === 1) {
          if (zoom > 1) pan(p, cur.x - prev.x, cur.y - prev.y);
          ptrs.set(e.pointerId, cur);
        } else if (ptrs.size === 2) {
          var other = null;
          ptrs.forEach(function (v, k) { if (k !== e.pointerId) other = v; });
          var d0 = Math.hypot(prev.x - other.x, prev.y - other.y), d1 = Math.hypot(cur.x - other.x, cur.y - other.y);
          ptrs.set(e.pointerId, cur);
          if (d0 > 0 && d1 > 0) {
            var r = p.stage.getBoundingClientRect();
            zoomAt(p, d1 / d0, (cur.x + other.x) / 2 - r.left, (cur.y + other.y) / 2 - r.top);
          }
        }
      });
      function up(e) { ptrs.delete(e.pointerId); }
      p.stage.addEventListener("pointerup", up); p.stage.addEventListener("pointercancel", up);
      p.stage.addEventListener("dblclick", function (e) {
        var r = p.stage.getBoundingClientRect();
        if (zoom > 1) reset(); else zoomAt(p, 3, e.clientX - r.left, e.clientY - r.top);
      });
      p.stage.addEventListener("keydown", function (e) {
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        var step = 60, k = e.key, used = true;
        if (k === "+" || k === "=") zoomCentre(1.4);
        else if (k === "-" || k === "_") zoomCentre(1 / 1.4);
        else if (k === "0") reset();
        else if (k === "ArrowLeft") pan(p, step, 0);
        else if (k === "ArrowRight") pan(p, -step, 0);
        else if (k === "ArrowUp") pan(p, 0, step);
        else if (k === "ArrowDown") pan(p, 0, -step);
        else used = false;
        if (used) e.preventDefault();
      });
    }

    // ------------------------------------------------------------ drawing
    function sourceOf(p) { return p.overlay || (p.ch && p.offs ? p.offs[mode] : p.comp); }
    function drawBar(ctx, p, screenPerImagePx, W, H, margin, fontPx) {
      var um = p.info && p.info.pixel_size_um;
      if (!(um > 0) || !(screenPerImagePx > 0) || p.overlay) return;
      var bar = L.niceScaleBar(um / screenPerImagePx, W * 0.22);
      if (!bar) return;
      var x = margin, y = H - margin - 6;
      ctx.save();
      ctx.fillStyle = "rgba(0,0,0,.55)"; ctx.fillRect(x - 4, y - fontPx - 8, bar.px + 8, fontPx + 18);
      ctx.fillStyle = "#fff"; ctx.fillRect(x, y, bar.px, 4);
      ctx.font = "600 " + fontPx + "px system-ui, sans-serif"; ctx.textBaseline = "bottom"; ctx.fillText(bar.label, x, y - 3);
      ctx.restore();
    }
    function draw(p) {
      var cw = p.stage.clientWidth, chh = p.stage.clientHeight;
      if (!cw || !chh) return;
      var dpr = root.devicePixelRatio || 1, W = Math.round(cw * dpr), H = Math.round(chh * dpr);
      if (p.canvas.width !== W || p.canvas.height !== H) { p.canvas.width = W; p.canvas.height = H; p.canvas.style.width = cw + "px"; p.canvas.style.height = chh + "px"; }
      var ctx = p.ctx; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = "#05080f"; ctx.fillRect(0, 0, cw, chh);
      var src = sourceOf(p);
      if (!src || !p.w) return;
      var sc = scaleOf(p), dx = cw / 2 - cx * p.w * sc, dy = chh / 2 - cy * p.h * sc;
      ctx.imageSmoothingEnabled = sc < 2;
      ctx.drawImage(src, dx, dy, p.w * sc, p.h * sc);
      drawBar(ctx, p, sc, cw, chh, 12, 12);
    }

    // ----------------------------------------------------------- download
    function wrapLines(ctx, text, maxW) {
      var words = String(text).split(/\s+/), lines = [], line = "";
      words.forEach(function (w) {
        var t = line ? line + " " + w : w;
        if (ctx.measureText(t).width > maxW && line) { lines.push(line); line = w; } else line = t;
      });
      if (line) lines.push(line);
      return lines;
    }
    function download(p) {
      var src = sourceOf(p); if (!src || !p.w) return;
      var W = p.w, H = p.h, fp = Math.max(12, Math.round(W / 56)), pad = Math.round(fp * 0.8);
      var probe = document.createElement("canvas").getContext("2d"); probe.font = fp + "px system-ui, sans-serif";
      var modeName = p.overlay ? (p.overlayNote + " (our classical counter, unvalidated)") : !p.ch ? "composite (DNA blue, 53BP1 green)" : mode === "merged" ? "merged: DNA blue, 53BP1 green" : mode === "dna" ? "DNA channel (blue)" : "53BP1 channel (green)";
      var lines = ["Well " + p.well + (p.label ? " (" + p.label + ")" : "") + " · " + modeName].concat(
        wrapLines(probe, (opts.attribution ? opts.attribution() : "") + " Rendered by Foci Lab, studylab.id/foci.", W - 2 * pad));
      var strip = pad * 2 + lines.length * Math.round(fp * 1.35);
      var c = document.createElement("canvas"); c.width = W; c.height = H + strip;
      var ctx = c.getContext("2d");
      ctx.fillStyle = "#05080f"; ctx.fillRect(0, 0, W, H + strip);
      ctx.imageSmoothingEnabled = false; ctx.drawImage(src, 0, 0, W, H);
      drawBar(ctx, p, 1, W, H, Math.round(fp), Math.round(fp * 1.1));
      ctx.fillStyle = "#e8eef6"; ctx.font = "600 " + fp + "px system-ui, sans-serif"; ctx.textBaseline = "top";
      var y = H + pad;
      lines.forEach(function (ln, k) { if (k === 1) ctx.font = fp + "px system-ui, sans-serif"; ctx.fillText(ln, pad, y); y += Math.round(fp * 1.35); });
      c.toBlob(function (b) {
        if (!b) return;
        var a = document.createElement("a"), u = URL.createObjectURL(b);
        a.href = u; a.download = "foci_" + p.well + "_" + (p.overlay ? "outline" : p.ch ? mode : "composite") + ".png";
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(u); }, 2000);
      }, "image/png");
    }

    return {
      load: load, remove: remove, clear: clear, setOverlay: setOverlay, reset: reset, count: function () { return panes.length; },
      info: function (i) { return panes[i] ? panes[i].info : null; }, redraw: function () { panes.forEach(draw); }, state: state,
      status: function (i, msg) { if (panes[i]) panes[i].status.textContent = msg; }
    };
  }

  root.FociViewer = { create: create };
})(typeof self !== "undefined" ? self : this);
