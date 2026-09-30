// FociIO -- read microscopy image files entirely in the browser. No network access of any kind.
//
//   await FociIO.readFile(file, {maxPixels, maxFileBytes, select})
//     -> {format, width, height, channels:[{name, data, width, height, bitDepth}], pixelSizeUm, warnings:[]}
//   ZIP archives: readFile returns {format:"zip", entries:[...]} (listing only); use FociIO.readZipEntry.
//
// Formats: PNG, TIFF / BigTIFF / OME-TIFF, JPEG (lossy, flagged), ZIP of those. See foci/docs/LAB_MODE.md.
(function (root) {
  "use strict";
  var isNode = typeof require !== "undefined" && typeof module !== "undefined";
  var A = isNode ? require("./inflate.js") : root.FociInflate;
  var PNG = isNode ? require("./png.js") : root.FociPNG;
  var TIFF = isNode ? require("./tiff.js") : root.FociTIFF;
  var ZIP = isNode ? require("./zip.js") : root.FociZIP;
  var IOError = A.IOError;

  var DEFAULTS = { maxFileBytes: 200 * 1024 * 1024, maxPixels: 16e6 };

  function sniff(u8) {
    if (PNG.isPNG(u8)) return "png";
    if (TIFF.isTIFF(u8)) return "tiff";
    if (u8.length > 3 && u8[0] === 0xff && u8[1] === 0xd8 && u8[2] === 0xff) return "jpeg";
    if (ZIP.isZIP(u8)) return "zip";
    return null;
  }

  // Width/height from the first SOF marker, so the pixel cap is checked before the browser decodes.
  function jpegSize(u8) {
    var i = 2;
    while (i + 9 < u8.length) {
      if (u8[i] !== 0xff) { i++; continue; }
      var m = u8[i + 1];
      if (m === 0xff) { i++; continue; }
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        return { precision: u8[i + 4], height: (u8[i + 5] << 8) | u8[i + 6], width: (u8[i + 7] << 8) | u8[i + 8] };
      }
      if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) { i += 2; continue; }
      i += 2 + ((u8[i + 2] << 8) | u8[i + 3]);
    }
    return null;
  }

  async function browserJpegDecode(u8, size) {
    if (typeof createImageBitmap === "undefined") throw new IOError("unsupported", "This browser cannot decode JPEG files here.");
    var blob = new Blob([u8], { type: "image/jpeg" }), bmp;
    try { bmp = await createImageBitmap(blob, { imageOrientation: "none", colorSpaceConversion: "none", premultiplyAlpha: "none" }); }
    catch (e) { bmp = await createImageBitmap(blob); }
    var w = bmp.width, h = bmp.height, cv, ctx;
    if (typeof OffscreenCanvas !== "undefined") { cv = new OffscreenCanvas(w, h); }
    else { cv = document.createElement("canvas"); cv.width = w; cv.height = h; }
    ctx = cv.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0);
    if (bmp.close) bmp.close();
    return { width: w, height: h, rgba: ctx.getImageData(0, 0, w, h).data };
  }

  async function decodeJpeg(u8, opts) {
    var size = jpegSize(u8);
    if (!size || !size.width || !size.height) throw new IOError("corrupt", "The JPEG file is damaged (no frame header found).");
    if (size.width * size.height > opts.maxPixels) throw new IOError("too_large", "Image is " + size.width + " x " + size.height + "; the limit is " + (opts.maxPixels / 1e6) + " megapixels per channel. Crop or bin the image first.");
    var dec = opts.jpegDecoder || browserJpegDecode, img;
    try { img = await dec(u8, size); } catch (e) { if (e && e.code) throw e; throw new IOError("corrupt", "The JPEG file could not be decoded (damaged or unsupported)."); }
    var n = img.width * img.height, d = img.rgba, g = true, i;
    for (i = 0; i < n; i++) { var q = i * 4; if (d[q] !== d[q + 1] || d[q] !== d[q + 2]) { g = false; break; } }
    var chans = [];
    var names = g ? ["Gray"] : ["Red", "Green", "Blue"];
    for (var c = 0; c < names.length; c++) {
      var a = new Uint8Array(n);
      for (i = 0; i < n; i++) a[i] = d[i * 4 + c];
      chans.push({ name: names[c], data: a, width: img.width, height: img.height, bitDepth: 8 });
    }
    return { format: "jpeg", width: img.width, height: img.height, channels: chans, pixelSizeUm: null,
      warnings: ["JPEG is a lossy format: compression artefacts can create or hide small foci. Use the original PNG or TIFF for quantitative work."] };
  }

  function norm(opts) {
    opts = opts || {};
    return { maxPixels: opts.maxPixels || DEFAULTS.maxPixels, maxFileBytes: opts.maxFileBytes || DEFAULTS.maxFileBytes,
      select: opts.select, jpegDecoder: opts.jpegDecoder, maxChannels: opts.maxChannels, maxDecodedBytes: opts.maxDecodedBytes, zipLimits: opts.zipLimits };
  }

  function wrap(e) {
    if (e && e.name === "FociIOError") return e;
    if (e instanceof RangeError) return new IOError(/allocation|memory|array length/i.test(String(e.message)) ? "too_large" : "truncated",
      /allocation|memory|array length/i.test(String(e.message)) ? "The browser ran out of memory decoding this image. Close other tabs or use a smaller image." : "The file is truncated or corrupt.");
    return new IOError("corrupt", "The file could not be read (" + String((e && e.message) || e).slice(0, 120) + ").");
  }

  // bytes: Uint8Array. name is only used for messages.
  async function readBytes(bytes, name, opts) {
    var o = norm(opts), u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    try {
      if (u8.length > o.maxFileBytes) throw new IOError("too_large", "File is " + Math.round(u8.length / 1048576) + " MB; the limit is " + Math.round(o.maxFileBytes / 1048576) + " MB.");
      if (u8.length < 8) throw new IOError("corrupt", "The file is empty or too short to be an image.");
      var kind = sniff(u8);
      if (kind === "png") return await PNG.decode(u8, o);
      if (kind === "tiff") return await TIFF.decode(u8, o);
      if (kind === "jpeg") return await decodeJpeg(u8, o);
      if (kind === "zip") {
        var z = ZIP.list(u8, o.zipLimits);
        if (!z.entries.length) throw new IOError("unsupported", "The ZIP contains no PNG, TIFF or JPEG files.");
        return { format: "zip", width: 0, height: 0, channels: [], pixelSizeUm: null,
          warnings: z.skipped ? [z.skipped + " non-image entr" + (z.skipped === 1 ? "y was" : "ies were") + " in the ZIP and ignored."] : [],
          entries: z.entries.map(function (e) { return { name: e.name, size: e.usize, _entry: e }; }) };
      }
      throw new IOError("bad_format", "Unrecognised file type" + (name ? " ('" + String(name).replace(/[^\w.\- ]/g, "?").slice(0, 60) + "')" : "") + ". Foci Lab reads PNG, TIFF / OME-TIFF, JPEG and ZIP files.");
    } catch (e) { throw wrap(e); }
  }

  async function readFile(file, opts) {
    var o = norm(opts);
    if (!file || typeof file.arrayBuffer !== "function") throw new IOError("bad_input", "No file given.");
    if (file.size > o.maxFileBytes) throw new IOError("too_large", "File is " + Math.round(file.size / 1048576) + " MB; the limit is " + Math.round(o.maxFileBytes / 1048576) + " MB.");
    var buf;
    try { buf = await file.arrayBuffer(); } catch (e) { throw new IOError("unreadable", "The browser could not read this file (it may have moved or be locked)."); }
    return readBytes(new Uint8Array(buf), file.name, opts);
  }

  // Extract + decode one entry listed by readBytes/readFile on a ZIP. zipBytes: the archive bytes.
  async function readZipEntry(zipBytes, entry, opts) {
    var o = norm(opts), u8 = zipBytes instanceof Uint8Array ? zipBytes : new Uint8Array(zipBytes);
    try {
      var bytes = await ZIP.extract(u8, entry._entry || entry, o.zipLimits);
      var kind = sniff(bytes);
      if (kind === "zip" || !kind) throw new IOError("bad_format", "ZIP entry '" + entry.name + "' is not a PNG, TIFF or JPEG (nested archives are not opened).");
      return await readBytes(bytes, entry.name, opts);
    } catch (e) { throw wrap(e); }
  }

  var api = { readFile: readFile, readBytes: readBytes, readZipEntry: readZipEntry, sha256: A.sha256, IOError: IOError, DEFAULTS: DEFAULTS, version: "1.0.0" };
  if (isNode) module.exports = api; else root.FociIO = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
