// FociTIFF -- TIFF / BigTIFF / OME-TIFF / ImageJ-TIFF decoder. Pure JS + DecompressionStream. No network.
//
// Supported:  little- and big-endian; classic TIFF and BigTIFF; strips and tiles; chunky and planar layouts;
//   compression none (1), LZW (5), Deflate (8, 32946), PackBits (32773); predictor 1 and 2 (horizontal);
//   unsigned 8/9-16 bit (packed depths such as 12 are unpacked), signed 8/16/32 and unsigned 32 bit
//   (converted to float32, flagged), float 32/64; BlackIsZero, WhiteIsZero (inverted), RGB; multi-page
//   files (every full-resolution page becomes one or more channels); OME-XML (channel names, pixel size,
//   dimension order); ImageJ description (unit); resolution tags.
// NOT supported (fails with a message): JPEG-in-TIFF, old JPEG, CCITT, ZSTD, WebP, LZMA, JPEG 2000,
//   floating-point predictor (3), palette / CMYK / YCbCr / Lab photometrics, 1-8 bit (non-8) depths,
//   float16, mixed bit depths per pixel, z/time stacks beyond the channel limit.
(function (root) {
  "use strict";
  var I = typeof require !== "undefined" ? require("./inflate.js") : root.FociInflate;
  var IOError = I.IOError;

  var HOST_LE = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
  var TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4, 16: 8, 17: 8, 18: 8 };
  var MAX_TAG_VALUES = 4e6;           // strip / tile offset arrays larger than this are rejected
  var MAX_IFDS = 4096;

  function clean(s, n) {
    return String(s).replace(/[\u0000-\u001f\u007f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, n || 120);
  }

  function isTIFF(u8) {
    if (u8.length < 8) return false;
    var a = u8[0], b = u8[1];
    if (!((a === 73 && b === 73) || (a === 77 && b === 77))) return false;
    var le = a === 73, m = le ? u8[2] | (u8[3] << 8) : (u8[2] << 8) | u8[3];
    return m === 42 || m === 43;
  }

  function unsupported(msg) {
    return IOError("unsupported", msg + " Export the image from your microscope software as an uncompressed, LZW or Deflate (ZIP) TIFF / OME-TIFF (or a 16-bit PNG) and try again.");
  }

  // ---------------------------------------------------------------- container reading
  function Rd(u8) {
    var dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    var le = u8[0] === 73, big = (le ? u8[2] | (u8[3] << 8) : (u8[2] << 8) | u8[3]) === 43;
    var len = u8.length;
    var self = {
      dv: dv, le: le, big: big, len: len,
      u16: function (o) { return dv.getUint16(o, le); },
      u32: function (o) { return dv.getUint32(o, le); },
      u64: function (o) {
        var lo = le ? dv.getUint32(o, true) : dv.getUint32(o + 4, false);
        var hi = le ? dv.getUint32(o + 4, true) : dv.getUint32(o, false);
        var v = hi * 4294967296 + lo;
        if (hi > 0x1fffff) throw IOError("corrupt", "TIFF offset is impossibly large (corrupt file).");
        return v;
      },
      off: function (o) { return big ? self.u64(o) : self.u32(o); }
    };
    return self;
  }

  // Reads one IFD into {entries: {tag: entry}, next}. entry = {tag,type,count,vpos}
  function readIFD(r, pos) {
    if (pos < 8 || pos + (r.big ? 8 : 2) > r.len) throw IOError("truncated", "TIFF directory lies outside the file (truncated or corrupt).");
    var n = r.big ? r.u64(pos) : r.u16(pos), esz = r.big ? 20 : 12, p0 = pos + (r.big ? 8 : 2);
    if (n > 65535 || p0 + n * esz + (r.big ? 8 : 4) > r.len) throw IOError("truncated", "TIFF directory is truncated or has an impossible entry count (" + n + ").");
    var entries = {};
    for (var i = 0; i < n; i++) {
      var p = p0 + i * esz;
      var e = { tag: r.u16(p), type: r.u16(p + 2), count: r.big ? r.u64(p + 4) : r.u32(p + 4), vpos: p + (r.big ? 12 : 8) };
      entries[e.tag] = e;
    }
    return { entries: entries, next: r.off(p0 + n * esz) };
  }

  // numeric array (Float64Array) or string for ASCII/UNDEFINED; null if the entry is absent
  function value(r, e, asText) {
    if (!e) return null;
    var sz = TYPE_SIZE[e.type];
    if (!sz) return null;
    var total = e.count * sz;
    if (!isFinite(total) || total > r.len) throw IOError("truncated", "TIFF tag " + e.tag + " is larger than the file (corrupt).");
    var inline = r.big ? 8 : 4;
    var at = total <= inline ? e.vpos : r.off(e.vpos);
    if (at < 0 || at + total > r.len) throw IOError("truncated", "TIFF tag " + e.tag + " points outside the file (truncated or corrupt).");
    if (e.type === 2 || e.type === 7 || asText) {
      var bytes = new Uint8Array(r.dv.buffer, r.dv.byteOffset + at, total);
      var end = bytes.length; while (end > 0 && bytes[end - 1] === 0) end--;
      return new TextDecoder("utf-8").decode(bytes.subarray(0, end));
    }
    if (e.count > MAX_TAG_VALUES) throw unsupported("TIFF tag " + e.tag + " has " + e.count + " values (too many strips or tiles).");
    var out = new Float64Array(e.count), k;
    for (k = 0; k < e.count; k++) {
      var o = at + k * sz, v;
      switch (e.type) {
        case 1: v = r.dv.getUint8(o); break;
        case 6: v = r.dv.getInt8(o); break;
        case 3: v = r.dv.getUint16(o, r.le); break;
        case 8: v = r.dv.getInt16(o, r.le); break;
        case 4: case 13: v = r.dv.getUint32(o, r.le); break;
        case 9: v = r.dv.getInt32(o, r.le); break;
        case 16: case 18: v = r.u64(o); break;
        case 17: v = r.u64(o); break;
        case 11: v = r.dv.getFloat32(o, r.le); break;
        case 12: v = r.dv.getFloat64(o, r.le); break;
        case 5: { var d = r.dv.getUint32(o + 4, r.le); v = d ? r.dv.getUint32(o, r.le) / d : NaN; break; }
        case 10: { var d2 = r.dv.getInt32(o + 4, r.le); v = d2 ? r.dv.getInt32(o, r.le) / d2 : NaN; break; }
        default: v = NaN;
      }
      out[k] = v;
    }
    return out;
  }
  function num(r, e, dflt) { var v = value(r, e); return v && v.length ? v[0] : dflt; }

  // ---------------------------------------------------------------- metadata (OME / ImageJ)
  function xmlUnescape(s) {
    return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, function (m, g) {
      g = g.toLowerCase();
      if (g === "amp") return "&"; if (g === "lt") return "<"; if (g === "gt") return ">"; if (g === "quot") return '"'; if (g === "apos") return "'";
      var cp = g[1] === "x" ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
      return cp > 31 && cp < 0x110000 ? String.fromCodePoint(cp) : " ";
    });
  }
  function attrs(s) {
    var o = {}, re = /([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g, m;
    while ((m = re.exec(s))) o[m[1]] = xmlUnescape(m[2] != null ? m[2] : m[3]);
    return o;
  }
  var UNIT_UM = { "µm": 1, "μm": 1, "um": 1, "micron": 1, "microns": 1, "micrometer": 1, "micrometre": 1, "nm": 1e-3, "mm": 1e3, "cm": 1e4, "m": 1e6, "å": 1e-4, "pm": 1e-6 };
  function unitToUm(u) {
    if (u == null || u === "") return 1;                    // OME default is micrometre
    var f = UNIT_UM[String(u).trim().toLowerCase()];
    return f === undefined ? null : f;
  }

  function parseOME(xml, warnings) {
    if (xml.length > 8e6) { warnings.push("OME-XML is very large and was not read."); return null; }
    var imgStarts = [], re = /<Image\b/g, m;
    while ((m = re.exec(xml))) { imgStarts.push(m.index); if (imgStarts.length > 10000) break; }
    if (!imgStarts.length) return null;
    var first = xml.slice(imgStarts[0], imgStarts[1] || xml.length);
    var pm = /<Pixels\b([^>]*)>/.exec(first);
    if (!pm) return null;
    var pa = attrs(pm[1]);
    var ome = { series: imgStarts.length, names: [], sizeC: +pa.SizeC || 1, sizeZ: +pa.SizeZ || 1, sizeT: +pa.SizeT || 1,
      order: /^XY[ZCT]{3}$/.test(pa.DimensionOrder || "") ? pa.DimensionOrder : "XYCZT", pixelSizeUm: null, multiFile: false };
    var cre = /<Channel\b([^>]*?)\/?>/g, cm;
    while ((cm = cre.exec(first))) {
      var ca = attrs(cm[1]);
      ome.names.push(clean(ca.Name || ca.ID || "", 80) || null);
      if (ome.names.length > 4096) break;
    }
    var px = pa.PhysicalSizeX != null ? parseFloat(pa.PhysicalSizeX) : NaN;
    if (px > 0 && isFinite(px)) {
      var f = unitToUm(pa.PhysicalSizeXUnit);
      if (f == null) warnings.push("OME pixel-size unit '" + clean(pa.PhysicalSizeXUnit, 20) + "' is not recognised; pixel size ignored.");
      else ome.pixelSizeUm = px * f;
    }
    if (/<UUID\b[^>]*FileName\s*=/.test(xml)) ome.multiFile = true;
    return ome;
  }

  function imageJInfo(desc) {
    if (!/^ImageJ=/.test(desc)) return null;
    var o = {}, lines = desc.split(/\r?\n/);
    for (var i = 0; i < lines.length && i < 200; i++) { var kv = /^([\w.]+)=(.*)$/.exec(lines[i]); if (kv) o[kv[1]] = kv[2]; }
    return o;
  }

  // ---------------------------------------------------------------- page description
  function describePage(r, ifd) {
    var E = ifd.entries, p = {};
    p.w = num(r, E[256], 0); p.h = num(r, E[257], 0);
    p.spp = num(r, E[277], 1);
    p.bits = value(r, E[258]) || new Float64Array([1]);
    p.fmt = value(r, E[339]) || new Float64Array([1]);
    p.comp = num(r, E[259], 1);
    p.photo = num(r, E[262], 1);
    p.planar = num(r, E[284], 1);
    p.pred = num(r, E[317], 1);
    p.subfile = num(r, E[254], 0);
    p.tw = num(r, E[322], 0); p.tl = num(r, E[323], 0);
    p.rps = num(r, E[278], 4294967295);
    p.extra = value(r, E[338]);
    p.tiled = !!(E[322] || E[324]);
    p.offsets = value(r, p.tiled ? E[324] : E[273]);
    p.counts = value(r, p.tiled ? E[325] : E[279]);
    p.xres = num(r, E[282], 0); p.resUnit = num(r, E[296], 2);
    p.desc = E[270] ? value(r, E[270], true) : null;
    return p;
  }

  var COMP_NAMES = { 6: "old-style JPEG", 7: "JPEG", 34712: "JPEG 2000", 50000: "ZSTD", 50001: "WebP", 34925: "LZMA", 3: "CCITT Group 3", 4: "CCITT Group 4", 2: "CCITT RLE", 32946: "Deflate", 34676: "SGILog" };

  function validatePage(p, idx, maxPixels) {
    var tag = "Page " + (idx + 1) + ": ";
    if (!(p.w >= 1) || !(p.h >= 1)) throw IOError("corrupt", tag + "missing or zero image size.");
    if (p.w * p.h > maxPixels) throw IOError("too_large", tag + "image is " + p.w + " x " + p.h + " (" + (p.w * p.h / 1e6).toFixed(1) + " megapixels); the limit is " + (maxPixels / 1e6) + " megapixels per channel. Crop or bin the image first.");
    if (!(p.spp >= 1) || p.spp > 64) throw unsupported(tag + "SamplesPerPixel = " + p.spp + " is not supported.");
    if ([1, 5, 8, 32946, 32773].indexOf(p.comp) < 0) throw unsupported(tag + "compression '" + (COMP_NAMES[p.comp] || "code " + p.comp) + "' is not supported.");
    if (p.pred !== 1 && p.pred !== 2) throw unsupported(tag + (p.pred === 3 ? "floating-point predictor (3)" : "predictor " + p.pred) + " is not supported.");
    if (p.planar !== 1 && p.planar !== 2) throw unsupported(tag + "PlanarConfiguration " + p.planar + " is not supported.");
    if (p.photo === 3) throw unsupported(tag + "palette-colour TIFF is not supported.");
    if (p.photo === 5 || p.photo === 6 || p.photo === 8 || p.photo === 9 || p.photo === 10 || p.photo === 32803) throw unsupported(tag + "colour model (PhotometricInterpretation " + p.photo + ": CMYK / YCbCr / Lab / raw) is not supported.");
    if (p.photo === 4) throw unsupported(tag + "transparency-mask pages are not supported.");
    var depth = p.bits[0], fmt = p.fmt[0] || 1;
    for (var s = 1; s < p.spp; s++) {
      var bs = p.bits.length > s ? p.bits[s] : depth, fs = p.fmt.length > s ? p.fmt[s] : fmt;
      if (bs !== depth || (fs || 1) !== fmt) throw unsupported(tag + "samples with different bit depths or number formats are not supported.");
    }
    p.depth = depth; p.sfmt = fmt === 4 ? 1 : fmt;
    if (p.sfmt < 1 || p.sfmt > 3) throw unsupported(tag + "sample format " + fmt + " is not supported.");
    var ok;
    if (p.sfmt === 1) ok = depth === 8 || depth === 16 || depth === 32 || (depth >= 9 && depth <= 15);
    else if (p.sfmt === 2) ok = depth === 8 || depth === 16 || depth === 32;
    else ok = depth === 32 || depth === 64;
    if (!ok) throw unsupported(tag + "" + depth + "-bit " + ["", "unsigned integer", "signed integer", "floating-point"][p.sfmt] + " samples are not supported.");
    if (p.pred === 2 && ((depth > 8 && depth < 16) || p.sfmt === 3)) throw unsupported(tag + "predictor 2 is only supported for 8-, 16- and 32-bit integer samples.");
    if (p.tiled) {
      if (!(p.tw >= 1 && p.tl >= 1) || p.tw > 65536 || p.tl > 65536) throw IOError("corrupt", tag + "invalid tile size.");
    }
    if (!p.offsets || !p.offsets.length) throw IOError("corrupt", tag + "image has no strip/tile offsets.");
  }

  function layout(p) {
    var spc = p.planar === 2 ? 1 : p.spp, planes = p.planar === 2 ? p.spp : 1, perPlane, across = 0, rps = 0;
    if (p.tiled) { across = Math.ceil(p.w / p.tw); perPlane = across * Math.ceil(p.h / p.tl); }
    else { rps = Math.max(1, Math.min(p.rps || p.h, p.h)); perPlane = Math.ceil(p.h / rps); }
    return { spc: spc, planes: planes, perPlane: perPlane, across: across, rps: rps, n: perPlane * planes };
  }

  // ---------------------------------------------------------------- pixel decoding
  function swapBytes(u8, size) {
    var n = u8.length, t, i;
    if (size === 2) for (i = 0; i + 1 < n; i += 2) { t = u8[i]; u8[i] = u8[i + 1]; u8[i + 1] = t; }
    else if (size === 4) for (i = 0; i + 3 < n; i += 4) { t = u8[i]; u8[i] = u8[i + 3]; u8[i + 3] = t; t = u8[i + 1]; u8[i + 1] = u8[i + 2]; u8[i + 2] = t; }
    else if (size === 8) for (i = 0; i + 7 < n; i += 8) { for (var k = 0; k < 4; k++) { t = u8[i + k]; u8[i + k] = u8[i + 7 - k]; u8[i + 7 - k] = t; } }
  }

  // bytes: exactly rows*rowBytes; returns a typed array of rows*rowSamples values in host byte order
  function toValues(bytes, p, rowSamples, rows, fileLE) {
    var depth = p.depth, n = rowSamples * rows, out, i;
    if (depth >= 9 && depth <= 15) {                      // packed, MSB first, rows byte-aligned
      var rowBytes = Math.ceil(rowSamples * depth / 8);
      out = new Uint16Array(n);
      for (var r = 0; r < rows; r++) {
        var bp = r * rowBytes * 8, o = r * rowSamples;
        for (i = 0; i < rowSamples; i++) {
          var v = 0, got = 0, bit = bp + i * depth;
          while (got < depth) {
            var byte = bytes[bit >> 3], avail = 8 - (bit & 7), take = Math.min(avail, depth - got);
            v = (v << take) | ((byte >> (avail - take)) & ((1 << take) - 1));
            got += take; bit += take;
          }
          out[o + i] = v;
        }
      }
      return out;
    }
    var size = depth >> 3;
    var own = bytes.byteOffset === 0 && bytes.buffer.byteLength === bytes.length && (bytes.byteOffset % size === 0) ? bytes : bytes.slice();
    if (size > 1 && fileLE !== HOST_LE) swapBytes(own, size);
    if (own.byteOffset !== 0 && own.byteOffset % size) own = own.slice();
    var buf = own.buffer, bo = own.byteOffset;
    if (p.sfmt === 1) out = size === 1 ? new Uint8Array(buf, bo, n) : size === 2 ? new Uint16Array(buf, bo, n) : new Uint32Array(buf, bo, n);
    else if (p.sfmt === 2) out = size === 1 ? new Int8Array(buf, bo, n) : size === 2 ? new Int16Array(buf, bo, n) : new Int32Array(buf, bo, n);
    else out = size === 4 ? new Float32Array(buf, bo, n) : new Float64Array(buf, bo, n);
    return out;
  }

  function undoPredictor(vals, rowSamples, rows, stride) {
    for (var r = 0; r < rows; r++) {
      var b = r * rowSamples;
      for (var i = stride; i < rowSamples; i++) vals[b + i] += vals[b + i - stride];   // typed array wraps per element width
    }
  }

  function outCtor(p) { return p.sfmt === 1 && p.depth === 8 ? Uint8Array : p.sfmt === 1 && p.depth <= 16 ? Uint16Array : Float32Array; }
  function outDepth(p) { return p.sfmt === 1 && p.depth <= 16 ? (p.depth === 8 ? 8 : p.depth) : 32; }

  async function decodePage(u8, r, p, wantSamples) {
    var L = layout(p), Out = outCtor(p), w = p.w, h = p.h, spp = p.spp;
    if (!p.counts && !(L.n === 1 && p.comp === 1)) throw IOError("corrupt", "TIFF has no strip/tile byte counts.");
    if (p.offsets.length < L.n || (p.counts && p.counts.length < L.n)) throw IOError("truncated", "TIFF lists fewer strips/tiles (" + p.offsets.length + ") than the image needs (" + L.n + ").");
    var out = new Array(spp);
    for (var s = 0; s < spp; s++) out[s] = wantSamples[s] ? new Out(w * h) : null;
    var bitsRow = function (cols, spc) { return Math.ceil(cols * spc * p.depth / 8); };
    for (var pl = 0; pl < L.planes; pl++) {
      if (L.planes > 1 && !wantSamples[pl]) continue;
      for (var k = 0; k < L.perPlane; k++) {
        var idx = pl * L.perPlane + k, x0, y0, cols, rowsBuf, cw, chh;
        if (p.tiled) {
          x0 = (k % L.across) * p.tw; y0 = Math.floor(k / L.across) * p.tl; cols = p.tw; rowsBuf = p.tl;
          cw = Math.min(p.tw, w - x0); chh = Math.min(p.tl, h - y0);
        } else {
          x0 = 0; y0 = k * L.rps; cols = w; rowsBuf = Math.min(L.rps, h - y0); cw = w; chh = rowsBuf;
        }
        var expected = rowsBuf * bitsRow(cols, L.spc);
        var off = p.offsets[idx], cnt = p.counts ? p.counts[idx] : expected;
        if (!(cnt > 0) || off + cnt > u8.length || off < 8) throw IOError("truncated", "A strip/tile lies outside the file (file is truncated or corrupt).");
        var src = u8.subarray(off, off + cnt), bytes;
        if (p.comp === 1) {
          if (cnt < expected) throw IOError("truncated", "A strip/tile is shorter than the image needs (file is truncated).");
          bytes = src.subarray(0, expected);
        } else if (p.comp === 8 || p.comp === 32946) bytes = await I.inflate(src, "deflate", expected, expected);
        else if (p.comp === 5) {
          if (src.length >= 2 && src[0] === 0 && (src[1] & 1)) throw unsupported("Old-style (pre-1988) LZW compression is not supported.");
          bytes = I.lzw(src, expected);
        } else bytes = I.packBits(src, expected);
        var vals = toValues(bytes, p, cols * L.spc, rowsBuf, r.le);
        if (p.pred === 2) {
          if (vals.buffer === u8.buffer) vals = vals.slice();
          undoPredictor(vals, cols * L.spc, rowsBuf, L.spc);
        }
        var rowSamples = cols * L.spc;
        if (L.spc === 1) {
          var dst = out[L.planes > 1 ? pl : 0];
          for (var rr = 0; rr < chh; rr++) {
            var sub = vals.subarray(rr * cols, rr * cols + cw), base = (y0 + rr) * w + x0;
            if (sub.constructor === dst.constructor) dst.set(sub, base);
            else for (var ii = 0; ii < cw; ii++) dst[base + ii] = sub[ii];
          }
        } else {
          for (var rr2 = 0; rr2 < chh; rr2++) {
            var vb = rr2 * rowSamples, db = (y0 + rr2) * w + x0;
            for (var s2 = 0; s2 < spp; s2++) {
              var d2 = out[s2]; if (!d2) continue;
              for (var i2 = 0; i2 < cw; i2++) d2[db + i2] = vals[vb + i2 * spp + s2];
            }
          }
        }
      }
    }
    if (p.photo === 0 && p.sfmt === 1) {                  // WhiteIsZero: invert integer data
      var maxv = p.depth === 32 ? 4294967295 : (Math.pow(2, p.depth) - 1);
      for (var s3 = 0; s3 < spp; s3++) { var a = out[s3]; if (a) for (var q = 0; q < a.length; q++) a[q] = maxv - a[q]; }
    }
    return out;
  }

  // ---------------------------------------------------------------- top level
  async function decode(input, opts) {
    opts = opts || {};
    var u8 = input instanceof Uint8Array ? input : new Uint8Array(input);
    if (!isTIFF(u8)) throw IOError("bad_format", "Not a TIFF file (byte-order mark / magic number mismatch).");
    var maxPixels = opts.maxPixels || 16e6, maxChannels = opts.maxChannels || 64, maxBytes = opts.maxDecodedBytes || 768 * 1024 * 1024;
    var warnings = [];
    try {
      var r = Rd(u8);
      if (r.big) {
        if (r.u16(4) !== 8 || r.u16(6) !== 0) throw IOError("corrupt", "Bad BigTIFF header.");
      }
      var pos = r.big ? r.u64(8) : r.u32(4), seen = {}, pages = [], reduced = 0, n = 0, desc0 = null;
      while (pos !== 0) {
        if (seen[pos]) { warnings.push("TIFF directory chain loops back on itself; reading stopped after " + n + " page(s)."); break; }
        if (++n > MAX_IFDS) throw unsupported("The file has more than " + MAX_IFDS + " pages.");
        seen[pos] = true;
        var ifd = readIFD(r, pos);
        var p = describePage(r, ifd);
        if (n === 1) desc0 = p.desc;
        if (p.subfile & 1) reduced++; else if (p.subfile & 4) reduced++; else pages.push(p);
        pos = ifd.next;
        if (pos >= u8.length && pos !== 0) { warnings.push("TIFF directory chain points outside the file; later pages ignored."); break; }
      }
      if (!pages.length) throw IOError("corrupt", "The TIFF contains no full-resolution image.");
      if (reduced) warnings.push(reduced + " reduced-resolution / mask page(s) were skipped.");
      var ome = desc0 && /<\?xml|<OME\b/.test(desc0.slice(0, 200)) ? parseOME(desc0, warnings) : null;
      var ij = desc0 ? imageJInfo(desc0) : null;
      if (ome && ome.series > 1) {
        var planes0 = ome.sizeC * ome.sizeZ * ome.sizeT;
        warnings.push("OME-TIFF contains " + ome.series + " image series; only the first is read.");
        if (planes0 > 0 && planes0 <= pages.length) pages = pages.slice(0, planes0);
      }
      if (ome && ome.multiFile) warnings.push("Multi-file OME-TIFF: only the planes stored in this file are read.");

      for (var i = 0; i < pages.length; i++) validatePage(pages[i], i, maxPixels);

      // channel list (metadata only)
      var chans = [];
      var omePlanes = ome ? ome.sizeC * ome.sizeZ * ome.sizeT : 0;
      var omeNamed = !!ome && pages.every(function (q) { return q.spp === 1; }) && omePlanes === pages.length;
      if (ome && !omeNamed && ome.names.length) warnings.push("OME metadata does not match the pages in the file; generic channel names are used.");
      for (var pi = 0; pi < pages.length; pi++) {
        var pg = pages[pi];
        for (var s = 0; s < pg.spp; s++) {
          var nm = null;
          if (omeNamed) {
            var rem = pi, order = ome.order.slice(2), sizes = { C: ome.sizeC, Z: ome.sizeZ, T: ome.sizeT }, ix = {};
            for (var d = 0; d < 3; d++) { var ch = order[d]; ix[ch] = rem % sizes[ch]; rem = Math.floor(rem / sizes[ch]); }
            nm = ome.names[ix.C] || "Channel " + (ix.C + 1);
            if (ome.sizeZ > 1) nm += " z" + (ix.Z + 1);
            if (ome.sizeT > 1) nm += " t" + (ix.T + 1);
          } else if (pg.photo === 2 && pg.spp >= 3) nm = ["Red", "Green", "Blue", "Alpha"][s] || "Sample " + (s + 1);
          else nm = "Channel " + (chans.length + 1);
          chans.push({ page: pg, sample: s, name: nm });
        }
      }
      if (chans.length > maxChannels) throw unsupported("The file has " + chans.length + " image planes/channels (limit " + maxChannels + "); it looks like a z-stack or time series.");
      if (omeNamed && (ome.sizeZ > 1 || ome.sizeT > 1)) warnings.push("This OME-TIFF is a z/time stack; every plane is listed as a channel. Use a single plane or a projection.");
      if (ij && +ij.images > pages.length && pages.length === 1) warnings.push("ImageJ stack with " + ij.images + " images stored as one contiguous block; only the first image can be read. Re-save with 'Save as > Tiff' in a standard multi-page form or as OME-TIFF.");
      var floatish = {};
      chans.forEach(function (c) {
        var q = c.page;
        if (q.sfmt === 2) floatish["signed"] = 1;
        else if (q.sfmt === 1 && q.depth === 32) floatish["u32"] = 1;
        else if (q.sfmt === 3 && q.depth === 64) floatish["f64"] = 1;
        if (q.photo === 0 && q.sfmt !== 1) floatish["wiz"] = 1;
      });
      if (floatish.signed) warnings.push("Signed-integer data were converted to floating point with their values unchanged (negative values are kept).");
      if (floatish.u32) warnings.push("32-bit unsigned data were converted to float32 (values above 16,777,216 lose precision).");
      if (floatish.f64) warnings.push("64-bit float data were converted to float32.");
      if (floatish.wiz) warnings.push("WhiteIsZero float/signed data were not inverted.");
      if (pages.some(function (q) { return q.photo === 0 && q.sfmt === 1; })) warnings.push("WhiteIsZero (inverted) TIFF: pixel values were inverted so that brighter means more signal.");
      if (pages.some(function (q) { return q.depth > 8 && q.depth < 16; })) warnings.push("Packed " + pages.filter(function (q) { return q.depth > 8 && q.depth < 16; })[0].depth + "-bit samples were unpacked to 16-bit containers (values keep their original range).");

      // which channels to decode
      var sel = opts.select ? opts.select.filter(function (x) { return x >= 0 && x < chans.length; }) : chans.map(function (_, i) { return i; });
      var bytesNeeded = 0;
      sel.forEach(function (ci) { var q = chans[ci].page; bytesNeeded += q.w * q.h * (outCtor(q).BYTES_PER_ELEMENT); });
      if (bytesNeeded > maxBytes) throw IOError("too_large", "Decoding the requested channels needs about " + Math.round(bytesNeeded / 1048576) + " MB of memory (limit " + Math.round(maxBytes / 1048576) + " MB). Select fewer channels or crop the image.");
      var decoded = new Map();
      for (var pj = 0; pj < pages.length; pj++) {
        var want = new Array(pages[pj].spp).fill(false), any = false;
        chans.forEach(function (c, ci) { if (c.page === pages[pj] && sel.indexOf(ci) >= 0) { want[c.sample] = true; any = true; } });
        if (any) decoded.set(pages[pj], await decodePage(u8, r, pages[pj], want));
      }
      var channels = chans.map(function (c, ci) {
        var arr = decoded.get(c.page);
        return { name: c.name, data: arr ? arr[c.sample] : null, width: c.page.w, height: c.page.h, bitDepth: outDepth(c.page) };
      });
      var sizes2 = {};
      channels.forEach(function (c) { sizes2[c.width + "x" + c.height] = 1; });
      if (Object.keys(sizes2).length > 1) warnings.push("Pages have different sizes (" + Object.keys(sizes2).join(", ") + "); a nuclei/foci pair must have the same size.");

      // pixel size
      var pixelSizeUm = null;
      if (ome && ome.pixelSizeUm) pixelSizeUm = ome.pixelSizeUm;
      else {
        var p0 = pages[0], unitName = ij && ij.unit ? ij.unit.replace(/\\u00b5/i, "\u00b5") : null;
        if (p0.xres > 0 && isFinite(p0.xres)) {
          var fac = unitName && unitName !== "pixel" ? unitToUm(unitName) : null;
          if (fac != null) pixelSizeUm = fac / p0.xres;
          else if (p0.resUnit === 3) pixelSizeUm = 10000 / p0.xres;
          else if (p0.resUnit === 2) {
            if (p0.xres === 72 || p0.xres === 96 || p0.xres === 300) warnings.push("Resolution tag (" + p0.xres + " dpi) looks like a print/screen default; pixel size ignored.");
            else pixelSizeUm = 25400 / p0.xres;
          }
        }
      }
      var f0 = channels[0];
      return { format: ome ? "ome-tiff" : (r.big ? "bigtiff" : "tiff"), width: f0.width, height: f0.height, channels: channels, pixelSizeUm: pixelSizeUm && isFinite(pixelSizeUm) ? pixelSizeUm : null, warnings: warnings };
    } catch (e) {
      if (e instanceof RangeError) throw IOError("truncated", "The TIFF file is truncated or corrupt (read past the end of the file).");
      throw e;
    }
  }

  var api = { decode: decode, isTIFF: isTIFF, _parseOME: parseOME, _unitToUm: unitToUm };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.FociTIFF = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
