/*
 * Minimal greyscale PNG decoder for the engine's test fixtures and parity page (8- and 16-bit, colour type 0,
 * non-interlaced). Not used by the engine itself. Canvas cannot be used for 16-bit data (it truncates to 8 bits).
 * Node: zlib.inflateSync. Browser: DecompressionStream('deflate') (zlib format). No network access.
 */
(function (root) {
  'use strict';
  async function inflate(bytes) {
    if (typeof process !== 'undefined' && process.versions && process.versions.node) {
      var z = require('zlib');
      return new Uint8Array(z.inflateSync(bytes));
    }
    var ds = new DecompressionStream('deflate');
    var stream = new Blob([bytes]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  // -> { width, height, bitDepth: 8|16, data: Uint8Array | Uint16Array }
  async function decodePng(input) {
    var b = input instanceof Uint8Array ? input : new Uint8Array(input);
    var sig = [137, 80, 78, 71, 13, 10, 26, 10];
    for (var s = 0; s < 8; s++) if (b[s] !== sig[s]) throw new Error('not a PNG');
    var dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    var pos = 8, w = 0, h = 0, depth = 0, ctype = -1, interlace = 0, idat = [], total = 0;
    while (pos + 8 <= b.length) {
      var len = dv.getUint32(pos), type = String.fromCharCode(b[pos + 4], b[pos + 5], b[pos + 6], b[pos + 7]);
      var body = b.subarray(pos + 8, pos + 8 + len);
      if (type === 'IHDR') {
        w = dv.getUint32(pos + 8); h = dv.getUint32(pos + 12); depth = b[pos + 16]; ctype = b[pos + 17]; interlace = b[pos + 20];
      } else if (type === 'IDAT') { idat.push(body); total += len; }
      else if (type === 'IEND') break;
      pos += 12 + len;
    }
    if (ctype !== 0 || (depth !== 8 && depth !== 16) || interlace !== 0) throw new Error('unsupported PNG (need non-interlaced greyscale 8/16-bit)');
    var z = new Uint8Array(total), o = 0;
    idat.forEach(function (c) { z.set(c, o); o += c.length; });
    var raw = await inflate(z);
    var bpp = depth / 8, stride = w * bpp;
    if (raw.length !== h * (stride + 1)) throw new Error('unexpected PNG data length');
    var out = new Uint8Array(h * stride), y, x;
    for (y = 0; y < h; y++) {
      var f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride;
      for (x = 0; x < stride; x++) {
        var a = x >= bpp ? out[dst + x - bpp] : 0, up = y > 0 ? out[dst - stride + x] : 0, c = (x >= bpp && y > 0) ? out[dst - stride + x - bpp] : 0, v = raw[src + x];
        if (f === 1) v += a; else if (f === 2) v += up; else if (f === 3) v += (a + up) >> 1;
        else if (f === 4) { var p = a + up - c, pa = Math.abs(p - a), pb = Math.abs(p - up), pc = Math.abs(p - c); v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? up : c); }
        else if (f !== 0) throw new Error('bad PNG filter');
        out[dst + x] = v & 255;
      }
    }
    if (depth === 8) return { width: w, height: h, bitDepth: 8, data: out };
    var d16 = new Uint16Array(w * h);
    for (var i = 0; i < d16.length; i++) d16[i] = (out[2 * i] << 8) | out[2 * i + 1];   // PNG is big-endian
    return { width: w, height: h, bitDepth: 16, data: d16 };
  }
  var api = { decodePng: decodePng };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.FociPngDecode = api;
})(typeof self !== 'undefined' ? self : globalThis);
