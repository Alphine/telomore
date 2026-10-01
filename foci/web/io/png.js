// FociPNG -- PNG decoder (all colour types, 1-16 bit, Adam7 interlace). Bit-exact for 8/16-bit.
// Pure JS + DecompressionStream. No network.
(function (root) {
  "use strict";
  var I = typeof require !== "undefined" ? require("./inflate.js") : root.FociInflate;
  var IOError = I.IOError;

  var CRC = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  function crc32(u8, a, b) {
    var c = 0xffffffff;
    for (var i = a; i < b; i++) c = CRC[(c ^ u8[i]) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  var SIG = [137, 80, 78, 71, 13, 10, 26, 10];
  function isPNG(u8) {
    if (u8.length < 8) return false;
    for (var i = 0; i < 8; i++) if (u8[i] !== SIG[i]) return false;
    return true;
  }

  var PASSES = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]]; // x0,y0,dx,dy

  function paeth(a, b, c) {
    var p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  }

  // In-place reconstruction of h scanlines starting at `off`; each line = 1 filter byte + rb bytes.
  function unfilter(d, off, h, rb, bpp) {
    var stride = rb + 1;
    for (var y = 0; y < h; y++) {
      var f = d[off + y * stride], s = off + y * stride + 1, p = s - stride; // p: previous line data start
      var i;
      if (f > 4) throw IOError("corrupt", "PNG scanline uses an unknown filter type (corrupt file).");
      if (f === 0) continue;
      var first = y === 0;
      if (f === 1) { for (i = bpp; i < rb; i++) d[s + i] = (d[s + i] + d[s + i - bpp]) & 255; }
      else if (f === 2) { if (!first) for (i = 0; i < rb; i++) d[s + i] = (d[s + i] + d[p + i]) & 255; }
      else if (f === 3) {
        for (i = 0; i < rb; i++) {
          var l = i >= bpp ? d[s + i - bpp] : 0, u = first ? 0 : d[p + i];
          d[s + i] = (d[s + i] + ((l + u) >> 1)) & 255;
        }
      } else {
        for (i = 0; i < rb; i++) {
          var l2 = i >= bpp ? d[s + i - bpp] : 0, u2 = first ? 0 : d[p + i], ul = first || i < bpp ? 0 : d[p + i - bpp];
          d[s + i] = (d[s + i] + paeth(l2, u2, ul)) & 255;
        }
      }
    }
  }

  async function decode(u8, opts) {
    opts = opts || {};
    var maxPixels = opts.maxPixels || 16e6;
    if (!isPNG(u8)) throw IOError("bad_format", "Not a PNG file (signature mismatch).");
    var dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    var pos = 8, hdr = null, plte = null, trns = false, phys = null, idat = [], idatLen = 0, seenEnd = false, warnings = [];
    while (pos + 12 <= u8.length) {
      var len = dv.getUint32(pos);
      var type = String.fromCharCode(u8[pos + 4], u8[pos + 5], u8[pos + 6], u8[pos + 7]);
      var dstart = pos + 8, dend = dstart + len;
      if (len > 0x7fffffff || dend + 4 > u8.length) throw IOError("truncated", "The PNG file is truncated (chunk '" + type.replace(/[^A-Za-z]/g, "?") + "' runs past the end).");
      if (crc32(u8, pos + 4, dend) !== dv.getUint32(dend)) {
        throw IOError("corrupt", "The PNG file is damaged (checksum mismatch in chunk '" + type.replace(/[^A-Za-z]/g, "?") + "').");
      }
      if (type === "IHDR") {
        if (len !== 13 || hdr) throw IOError("corrupt", "Bad PNG header chunk.");
        hdr = { w: dv.getUint32(dstart), h: dv.getUint32(dstart + 4), depth: u8[dstart + 8], ct: u8[dstart + 9], comp: u8[dstart + 10], filt: u8[dstart + 11], il: u8[dstart + 12] };
      } else if (!hdr) {
        throw IOError("corrupt", "PNG header chunk missing.");
      } else if (type === "PLTE") {
        if (len % 3 || len > 768 || len === 0) throw IOError("corrupt", "Bad PNG palette.");
        plte = u8.subarray(dstart, dend);
      } else if (type === "tRNS") {
        trns = true;
      } else if (type === "pHYs" && len === 9) {
        phys = { x: dv.getUint32(dstart), y: dv.getUint32(dstart + 4), unit: u8[dstart + 8] };
      } else if (type === "IDAT") {
        idat.push(u8.subarray(dstart, dend)); idatLen += len;
      } else if (type === "IEND") { seenEnd = true; break; }
      else if ((u8[pos + 4] & 32) === 0 && type !== "IDAT") {
        throw IOError("unsupported", "The PNG uses a critical chunk ('" + type.replace(/[^A-Za-z]/g, "?") + "') this reader does not know.");
      }
      pos = dend + 4;
    }
    if (!hdr) throw IOError("corrupt", "PNG header chunk missing.");
    if (!idatLen) throw IOError("truncated", "The PNG file has no image data (truncated).");
    if (!seenEnd) warnings.push("PNG has no IEND chunk (file may be truncated); pixel data decoded anyway.");

    var w = hdr.w, h = hdr.h, depth = hdr.depth, ct = hdr.ct;
    var spp = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ct];
    var okDepth = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] }[ct];
    if (!spp || okDepth.indexOf(depth) < 0) throw IOError("corrupt", "Invalid PNG colour type / bit depth combination.");
    if (hdr.comp !== 0 || hdr.filt !== 0 || hdr.il > 1) throw IOError("corrupt", "Invalid PNG header (unknown method).");
    if (w < 1 || h < 1 || w > 0x7fffffff || h > 0x7fffffff) throw IOError("corrupt", "Invalid PNG dimensions.");
    if (w * h > maxPixels) throw IOError("too_large", "Image is " + w + " x " + h + " (" + (w * h / 1e6).toFixed(1) + " megapixels); the limit is " + (maxPixels / 1e6) + " megapixels per channel. Crop or bin the image first.");
    if (ct === 3 && !plte) throw IOError("corrupt", "Palette PNG without a palette.");

    var bitsPP = spp * depth, bpp = Math.max(1, bitsPP >> 3);
    var passes = hdr.il ? PASSES : [[0, 0, 1, 1]];
    var dims = [], expected = 0, pi;
    for (pi = 0; pi < passes.length; pi++) {
      var P = passes[pi];
      var pw = Math.floor((w - P[0] + P[2] - 1) / P[2]), ph = Math.floor((h - P[1] + P[3] - 1) / P[3]);
      if (pw <= 0 || ph <= 0) { dims.push(null); continue; }
      var rb = Math.ceil(pw * bitsPP / 8);
      dims.push({ pw: pw, ph: ph, rb: rb, off: expected });
      expected += ph * (rb + 1);
    }
    var zbuf = new Uint8Array(idatLen), zo = 0;
    for (var k = 0; k < idat.length; k++) { zbuf.set(idat[k], zo); zo += idat[k].length; }
    var raw = await I.inflate(zbuf, "deflate", expected, expected);

    // output channels
    var outSpp = ct === 3 ? 3 : (ct === 4 ? 1 : ct === 6 ? 3 : spp);
    var outDepth = depth === 16 ? 16 : 8;
    var scale = depth < 8 ? 255 / ((1 << depth) - 1) : 1;
    var chans = [];
    for (var c = 0; c < outSpp; c++) chans.push(outDepth === 16 ? new Uint16Array(w * h) : new Uint8Array(w * h));
    var alphaSeen = false;
    var maxA = depth === 16 ? 65535 : 255;

    for (pi = 0; pi < passes.length; pi++) {
      var D = dims[pi]; if (!D) continue;
      var Pp = passes[pi];
      unfilter(raw, D.off, D.ph, D.rb, bpp);
      for (var r = 0; r < D.ph; r++) {
        var s = D.off + r * (D.rb + 1) + 1, y = Pp[1] + r * Pp[3], base = y * w;
        for (var i = 0; i < D.pw; i++) {
          var di = base + Pp[0] + i * Pp[2];
          if (depth === 8) {
            var q = s + i * spp;
            if (ct === 3) { var pidx = raw[q]; if (pidx * 3 + 2 >= plte.length) throw IOError("corrupt", "PNG palette index out of range."); chans[0][di] = plte[pidx * 3]; chans[1][di] = plte[pidx * 3 + 1]; chans[2][di] = plte[pidx * 3 + 2]; }
            else if (ct === 0) chans[0][di] = raw[q];
            else if (ct === 4) { chans[0][di] = raw[q]; if (raw[q + 1] !== 255) alphaSeen = true; }
            else { chans[0][di] = raw[q]; chans[1][di] = raw[q + 1]; chans[2][di] = raw[q + 2]; if (ct === 6 && raw[q + 3] !== 255) alphaSeen = true; }
          } else if (depth === 16) {
            var q2 = s + i * spp * 2;
            if (ct === 0) chans[0][di] = (raw[q2] << 8) | raw[q2 + 1];
            else if (ct === 4) { chans[0][di] = (raw[q2] << 8) | raw[q2 + 1]; if (((raw[q2 + 2] << 8) | raw[q2 + 3]) !== maxA) alphaSeen = true; }
            else { chans[0][di] = (raw[q2] << 8) | raw[q2 + 1]; chans[1][di] = (raw[q2 + 2] << 8) | raw[q2 + 3]; chans[2][di] = (raw[q2 + 4] << 8) | raw[q2 + 5]; if (ct === 6 && ((raw[q2 + 6] << 8) | raw[q2 + 7]) !== maxA) alphaSeen = true; }
          } else {                                   // 1, 2, 4 bit gray or palette
            var bit = i * depth, v = (raw[s + (bit >> 3)] >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
            if (ct === 3) { if (v * 3 + 2 >= plte.length) throw IOError("corrupt", "PNG palette index out of range."); chans[0][di] = plte[v * 3]; chans[1][di] = plte[v * 3 + 1]; chans[2][di] = plte[v * 3 + 2]; }
            else chans[0][di] = Math.round(v * scale);
          }
        }
      }
    }

    var names, out = [];
    if (ct === 3) {
      // a grey palette is a grey image; a coloured one is three channels
      var grey = true;
      for (var e = 0; e + 2 < plte.length; e += 3) if (plte[e] !== plte[e + 1] || plte[e] !== plte[e + 2]) { grey = false; break; }
      if (grey) { chans = [chans[0]]; names = ["Gray"]; warnings.push("Palette PNG with a grey palette: palette entries were converted to grey levels."); }
      else { names = ["Red", "Green", "Blue"]; warnings.push("Palette PNG: palette entries were expanded to RGB channels."); }
    } else names = outSpp === 1 ? ["Gray"] : ["Red", "Green", "Blue"];
    if (depth < 8 && ct !== 3) warnings.push(depth + "-bit PNG values were scaled to 0-255.");
    if (alphaSeen) warnings.push("PNG has a transparency channel with non-opaque pixels; it was ignored.");
    if (trns && ct !== 3) { /* colour-key transparency: pixel values are untouched */ }
    for (var ci = 0; ci < chans.length; ci++) out.push({ name: names[ci], data: chans[ci], width: w, height: h, bitDepth: outDepth });

    var pixelSizeUm = null;
    if (phys && phys.unit === 1 && phys.x > 0) pixelSizeUm = 1e6 / phys.x;
    return { format: "png", width: w, height: h, channels: out, pixelSizeUm: pixelSizeUm, warnings: warnings };
  }

  var api = { decode: decode, isPNG: isPNG, crc32: crc32 };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.FociPNG = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
