// FociZIP -- read-only ZIP directory listing and extraction with bomb guards. No network.
// Supports stored (0) and deflate (8) entries. ZIP64, encryption and multi-disk archives are rejected.
(function (root) {
  "use strict";
  var I = typeof require !== "undefined" ? require("./inflate.js") : root.FociInflate;
  var P = typeof require !== "undefined" ? require("./png.js") : root.FociPNG;
  var IOError = I.IOError;

  var LIMITS = {
    maxDirEntries: 2000,          // entries in the archive directory (files + folders)
    maxImageEntries: 200,         // entries that look like images
    maxEntryBytes: 256 * 1024 * 1024,
    maxTotalBytes: 1024 * 1024 * 1024,   // sum of declared sizes of the image entries
    maxRatio: 500,                // uncompressed : compressed, enforced for entries above 1 MB
    ratioFloor: 1024 * 1024
  };
  var IMG_RE = /\.(png|tif|tiff|jpg|jpeg)$/i;

  function isZIP(u8) {
    return u8.length >= 22 && u8[0] === 0x50 && u8[1] === 0x4b && (u8[2] === 3 || u8[2] === 5) && (u8[3] === 4 || u8[3] === 6);
  }

  function cleanName(s) { return String(s).replace(/[\u0000-\u001f\u007f]/g, "?").slice(0, 240); }

  function list(u8, limits) {
    var L = Object.assign({}, LIMITS, limits || {});
    var dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), n = u8.length;
    var eocd = -1;
    for (var i = n - 22; i >= Math.max(0, n - 22 - 65535); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw IOError("corrupt", "Not a valid ZIP file (end-of-archive record not found; the file may be truncated).");
    var disk = dv.getUint16(eocd + 4, true), entries = dv.getUint16(eocd + 10, true), cdSize = dv.getUint32(eocd + 12, true), cdOff = dv.getUint32(eocd + 16, true);
    if (entries === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) throw IOError("unsupported", "ZIP64 archives are not supported. Re-zip the images into an archive below 4 GB, or choose the image files directly.");
    if (disk !== 0 || dv.getUint16(eocd + 6, true) !== 0) throw IOError("unsupported", "Multi-part ZIP archives are not supported.");
    if (entries > L.maxDirEntries) throw IOError("too_large", "The ZIP has " + entries + " entries (limit " + L.maxDirEntries + "). Select the images directly instead.");
    if (cdOff + cdSize > eocd) throw IOError("corrupt", "ZIP directory lies outside the file (corrupt or truncated).");
    var out = [], p = cdOff, total = 0, skipped = 0;
    for (var k = 0; k < entries; k++) {
      if (p + 46 > n || dv.getUint32(p, true) !== 0x02014b50) throw IOError("corrupt", "ZIP directory is damaged.");
      var flags = dv.getUint16(p + 8, true), method = dv.getUint16(p + 10, true), crc = dv.getUint32(p + 16, true);
      var csize = dv.getUint32(p + 20, true), usize = dv.getUint32(p + 24, true), nl = dv.getUint16(p + 28, true), xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true);
      var lho = dv.getUint32(p + 42, true);
      if (p + 46 + nl + xl + cl > n) throw IOError("corrupt", "ZIP directory is damaged.");
      var nameBytes = u8.subarray(p + 46, p + 46 + nl);
      var name = cleanName(new TextDecoder(flags & 0x800 ? "utf-8" : "latin1").decode(nameBytes));
      p += 46 + nl + xl + cl;
      if (name.slice(-1) === "/" || /(^|\/)(__MACOSX|\.DS_Store)(\/|$)|(^|\/)\._/.test(name) || !IMG_RE.test(name)) { skipped++; continue; }
      if (flags & 1) throw IOError("unsupported", "Entry '" + name + "' is password-protected; encrypted ZIPs are not supported.");
      if (method !== 0 && method !== 8) throw IOError("unsupported", "Entry '" + name + "' uses ZIP compression method " + method + "; only stored and deflate are supported.");
      if (csize === 0xffffffff || usize === 0xffffffff || lho === 0xffffffff) throw IOError("unsupported", "ZIP64 entries are not supported.");
      if (usize > L.maxEntryBytes) throw IOError("too_large", "Entry '" + name + "' is " + Math.round(usize / 1048576) + " MB uncompressed (limit " + Math.round(L.maxEntryBytes / 1048576) + " MB).");
      if (usize > L.ratioFloor && usize / Math.max(1, csize) > L.maxRatio) throw IOError("bomb", "Entry '" + name + "' has a compression ratio above " + L.maxRatio + ":1 (possible decompression bomb); it was refused.");
      total += usize;
      if (total > L.maxTotalBytes) throw IOError("too_large", "The images in the ZIP add up to more than " + Math.round(L.maxTotalBytes / 1048576) + " MB uncompressed.");
      out.push({ name: name, method: method, csize: csize, usize: usize, crc: crc, offset: lho });
      if (out.length > L.maxImageEntries) throw IOError("too_large", "The ZIP holds more than " + L.maxImageEntries + " images. Select fewer files.");
    }
    return { entries: out, skipped: skipped };
  }

  async function extract(u8, entry, limits) {
    var L = Object.assign({}, LIMITS, limits || {});
    var dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    var o = entry.offset;
    if (o + 30 > u8.length || dv.getUint32(o, true) !== 0x04034b50) throw IOError("corrupt", "ZIP entry '" + entry.name + "' has a damaged header.");
    var start = o + 30 + dv.getUint16(o + 26, true) + dv.getUint16(o + 28, true);
    if (start + entry.csize > u8.length) throw IOError("truncated", "ZIP entry '" + entry.name + "' is truncated.");
    var src = u8.subarray(start, start + entry.csize), bytes;
    if (entry.method === 0) {
      if (entry.csize !== entry.usize) throw IOError("corrupt", "ZIP entry '" + entry.name + "' declares inconsistent sizes.");
      bytes = src;
    } else {
      bytes = await I.inflate(src, "deflate-raw", Math.min(entry.usize, L.maxEntryBytes), entry.usize);
    }
    if (P.crc32(bytes, 0, bytes.length) !== entry.crc) throw IOError("corrupt", "ZIP entry '" + entry.name + "' failed its checksum (corrupt archive).");
    return bytes;
  }

  var api = { isZIP: isZIP, list: list, extract: extract, LIMITS: LIMITS, IMG_RE: IMG_RE };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.FociZIP = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
