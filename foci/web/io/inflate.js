// FociInflate -- bounded decompression, LZW/PackBits, SHA-256. No network, no dependencies.
// Inflate uses the platform DecompressionStream (zlib "deflate" or "deflate-raw"); the output
// is capped while streaming so a decompression bomb is cut off at the cap instead of filling memory.
(function (root) {
  "use strict";

  function IOError(code, message) {
    var e = new Error(message);
    e.name = "FociIOError";
    e.code = code;
    return e;
  }

  // format: "deflate" (zlib wrapper: PNG, TIFF) or "deflate-raw" (ZIP). maxOut: hard cap in bytes.
  // expected (optional): exact output length required; any other length is an error.
  async function inflate(bytes, format, maxOut, expected) {
    if (typeof DecompressionStream === "undefined") {
      throw IOError("unsupported", "This browser cannot decompress data (DecompressionStream is missing). Use a current Chrome, Edge, Firefox or Safari.");
    }
    var ds = new DecompressionStream(format);
    var writer = ds.writable.getWriter();
    var reader = ds.readable.getReader();
    var chunks = [], total = 0, failed = null;
    var feeding = (async function () {
      try { await writer.write(bytes); await writer.close(); }
      catch (e) { failed = failed || e; }
    })();
    try {
      for (;;) {
        var r = await reader.read();
        if (r.done) break;
        total += r.value.length;
        if (total > maxOut) {
          try { await reader.cancel(); } catch (e) { /* ignore */ }
          throw IOError("bomb", "Compressed data expands beyond its declared size (corrupt file or decompression bomb).");
        }
        chunks.push(r.value);
      }
    } catch (e) {
      if (e && e.code) throw e;
      throw IOError("corrupt", "The compressed image data is damaged or truncated.");
    }
    await feeding;
    if (failed) throw IOError("corrupt", "The compressed image data is damaged or truncated.");
    var out = new Uint8Array(total), o = 0;
    for (var i = 0; i < chunks.length; i++) { out.set(chunks[i], o); o += chunks[i].length; }
    if (expected != null && total !== expected) {
      throw IOError("corrupt", "Decompressed size (" + total + " bytes) differs from the size the file declares (" + expected + " bytes).");
    }
    return out;
  }

  // TIFF PackBits. Output must be exactly `expected` bytes.
  function packBits(src, expected) {
    var out = new Uint8Array(expected), o = 0, i = 0, n = src.length;
    while (i < n && o < expected) {
      var h = src[i++]; if (h > 127) h -= 256;
      if (h >= 0) {
        var c = h + 1;
        if (i + c > n) throw IOError("corrupt", "PackBits data is truncated.");
        if (o + c > expected) throw IOError("bomb", "PackBits data expands beyond its declared size.");
        out.set(src.subarray(i, i + c), o); o += c; i += c;
      } else if (h !== -128) {
        var r = 1 - h;
        if (i >= n) throw IOError("corrupt", "PackBits data is truncated.");
        if (o + r > expected) throw IOError("bomb", "PackBits data expands beyond its declared size.");
        out.fill(src[i++], o, o + r); o += r;
      }
    }
    if (o !== expected) throw IOError("corrupt", "PackBits data ends early (" + o + " of " + expected + " bytes).");
    return out;
  }

  // TIFF LZW (MSB-first codes, ClearCode 256, EOI 257, "early change"), as written by libtiff and tifffile.
  function lzw(src, expected) {
    var out = new Uint8Array(expected), o = 0;
    var prefix = new Int32Array(4096), suffix = new Uint8Array(4096), length = new Uint16Array(4096);
    for (var k = 0; k < 256; k++) { prefix[k] = -1; suffix[k] = k; length[k] = 1; }
    var next = 258, bits = 9, prev = -1;
    var acc = 0, nacc = 0, p = 0, n = src.length;
    for (;;) {
      while (nacc < bits && p < n) { acc = ((acc << 8) | src[p++]) >>> 0; nacc += 8; }
      if (nacc < bits) break;                        // out of data without an EOI code
      var code = (acc >>> (nacc - bits)) & ((1 << bits) - 1);
      nacc -= bits; acc &= (1 << nacc) - 1;
      if (code === 257) break;                       // end of information
      if (code === 256) { next = 258; bits = 9; prev = -1; continue; }
      var emit, kwk = false;
      if (prev === -1) {
        if (code > 255) throw IOError("corrupt", "LZW data is damaged (bad first code).");
        emit = code;
      } else if (code < next) {
        emit = code;
      } else if (code === next && next < 4096) {
        emit = prev; kwk = true;                     // the "KwKwK" case
      } else {
        throw IOError("corrupt", "LZW data is damaged (code out of range).");
      }
      var len = length[emit] + (kwk ? 1 : 0);
      if (o + len > expected) throw IOError("bomb", "LZW data expands beyond its declared size.");
      var pos = o + length[emit] - 1, c = emit;
      while (c !== -1) { out[pos--] = suffix[c]; c = prefix[c]; }
      var first = out[o];
      if (kwk) out[o + len - 1] = first;
      if (prev !== -1 && next < 4096) {
        prefix[next] = prev; suffix[next] = first; length[next] = length[prev] + 1; next++;
        if (next >= (1 << bits) - 1 && bits < 12) bits++;   // early change
      }
      o += len; prev = code;
    }
    if (o !== expected) throw IOError("corrupt", "LZW data ends early or is truncated (" + o + " of " + expected + " bytes).");
    return out;
  }

  // SHA-256 (hex). WebCrypto when present; otherwise a small pure-JS fallback
  // (crypto.subtle is unavailable on non-HTTPS origins).
  var K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);
  function sha256js(bytes) {
    var h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    var w = new Uint32Array(64);
    function block(b) {
      var i;
      for (i = 0; i < 16; i++) w[i] = ((b[4 * i] << 24) | (b[4 * i + 1] << 16) | (b[4 * i + 2] << 8) | b[4 * i + 3]) >>> 0;
      for (i = 16; i < 64; i++) {
        var a = w[i - 15], c = w[i - 2];
        var s0 = (((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3)) >>> 0;
        var s1 = (((c >>> 17) | (c << 15)) ^ ((c >>> 19) | (c << 13)) ^ (c >>> 10)) >>> 0;
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
      }
      var A = h[0], B = h[1], C = h[2], D = h[3], E = h[4], F = h[5], G = h[6], H = h[7];
      for (i = 0; i < 64; i++) {
        var S1 = (((E >>> 6) | (E << 26)) ^ ((E >>> 11) | (E << 21)) ^ ((E >>> 25) | (E << 7))) >>> 0;
        var ch = ((E & F) ^ (~E & G)) >>> 0;
        var t1 = (H + S1 + ch + K[i] + w[i]) >>> 0;
        var S0 = (((A >>> 2) | (A << 30)) ^ ((A >>> 13) | (A << 19)) ^ ((A >>> 22) | (A << 10))) >>> 0;
        var mj = ((A & B) ^ (A & C) ^ (B & C)) >>> 0;
        var t2 = (S0 + mj) >>> 0;
        H = G; G = F; F = E; E = (D + t1) >>> 0; D = C; C = B; B = A; A = (t1 + t2) >>> 0;
      }
      h[0] += A; h[1] += B; h[2] += C; h[3] += D; h[4] += E; h[5] += F; h[6] += G; h[7] += H;
    }
    var len = bytes.length, full = len - (len % 64), i;
    for (i = 0; i < full; i += 64) block(bytes.subarray(i, i + 64));
    var rest = len - full, padLen = rest + 9 <= 64 ? 64 : 128;
    var tail = new Uint8Array(padLen);
    tail.set(bytes.subarray(full)); tail[rest] = 0x80;
    var hi = Math.floor(len / 0x20000000), lo = (len << 3) >>> 0;
    tail[padLen - 8] = hi >>> 24; tail[padLen - 7] = hi >>> 16; tail[padLen - 6] = hi >>> 8; tail[padLen - 5] = hi;
    tail[padLen - 4] = lo >>> 24; tail[padLen - 3] = lo >>> 16; tail[padLen - 2] = lo >>> 8; tail[padLen - 1] = lo;
    for (i = 0; i < padLen; i += 64) block(tail.subarray(i, i + 64));
    var hex = "";
    for (i = 0; i < 8; i++) hex += ("00000000" + h[i].toString(16)).slice(-8);
    return hex;
  }
  async function sha256(buf) {
    var bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    var subtle = root.crypto && root.crypto.subtle;
    if (subtle) {
      try {
        var a = new Uint8Array(await subtle.digest("SHA-256", bytes)), s = "";
        for (var i = 0; i < a.length; i++) s += (a[i] < 16 ? "0" : "") + a[i].toString(16);
        return s;
      } catch (e) { /* fall through to the JS implementation */ }
    }
    return sha256js(bytes);
  }

  var api = { IOError: IOError, inflate: inflate, packBits: packBits, lzw: lzw, sha256: sha256, sha256js: sha256js };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.FociInflate = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
