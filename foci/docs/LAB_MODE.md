# Browser lab (`foci/web/lab.html`)

The Browser lab lets a scientist read and analyse their own two-channel microscopy images **entirely inside the
browser tab**. Nothing is uploaded. It is an exploratory, classical counter (Gaussian smoothing, background
opening, Otsu on log intensity, white top-hat, local maxima) and is **not validated against manual counts**
(Experiments L and L2, `docs/EXPERIMENT_PROTOCOL.md`). 53BP1 and gamma-H2AX foci mark DNA double-strand breaks
anywhere in the genome; they are not telomere-specific. Tune the parameters on your own positive and negative
controls before trusting a number.

This page is the **reader, page and UX** half. The analysis itself is `window.FociEngine`
(`foci/web/engine/`, documented in `foci/docs/ENGINE.md`); the design rationale for computing in the browser is in
`docs/FOCI_BROWSER_COMPUTE.md`; the plate-screen page is described in `foci/docs/SCREEN_MODE.md`.

## What you can do

1. **Add images**: drop files or a folder, or use the pickers. One multi-channel file per field, or two files
   (nuclei + foci) per field, or a whole batch (up to 500 files per session; ZIP archives are expanded).
2. **Pair and assign**: files are paired by naming words you can see and edit (presets: `DAPI / 53BP1, gH2AX`,
   `_c1 / _c2`, `_ch00 / _ch01`, `_w1 / _w2`, `C0 / C1`). A single multi-channel file becomes a set on its own. Every set
   shows both channels with a display-stretched preview and an intensity histogram, and two selectors let you
   choose the nuclei channel and the foci channel by hand. Condition (for example `control`, `treated`) and an
   optional replicate label can be set per set or in bulk.
2b. **Nucleus pipeline** selector (v1 / v2, default v2): v2 splits touching nuclei (CPU only; see ENGINE.md "Pipeline v2"). The choice is passed as `opts.pipeline`, switches the parameter set, and is recorded as `pipeline_version` in every result, both CSVs (last column) and the provenance JSON.
3. **Parameters**: the seven engine parameters with bounds, presets (engine defaults; minimum height x2 or x0.5
   relative to whatever the engine reports), reset, and **export / import as JSON**.
4. **Run**: per-set status, overall progress, **Cancel** (AbortController; the worker pool is terminated), a worker
   pool size control and a backend selector (automatic / GPU only / CPU reference). A **backend badge** shows
   GPU or CPU, the engine version and the GPU self-test status, as reported by `FociEngine.capabilities()`.
5. **Results**: a batch table (one row per image set), a per-condition summary, and for the selected set: counts,
   engine warnings, the engine's overlay image with toggles (engine overlay, foci points, nucleus IDs) and zoom
   (buttons, `+`/`-`/`0` keys, Ctrl+wheel), a histogram of foci per nuclear object and a per-nucleus table.
6. **Export**: per-nucleus CSV, per-image CSV, **provenance JSON**, parameters JSON. All are local downloads.

## Supported files

| Format | What is read | Notes |
|---|---|---|
| PNG | grey, grey+alpha, RGB, RGBA, palette; 1, 2, 4, 8, 16 bit; Adam7 interlace | 8- and 16-bit are bit-exact. 16-bit stays 16-bit. RGB becomes three channels (Red, Green, Blue); alpha is ignored (flagged if not opaque). A grey palette becomes one grey channel, a coloured palette three channels (flagged). 1-4 bit values are scaled to 0-255 (flagged). `pHYs` (metres) gives the pixel size. All chunk CRCs are checked. |
| TIFF, BigTIFF, OME-TIFF, ImageJ TIFF | little- and big-endian; strips and tiles; chunky and planar; compression none, LZW, Deflate (8 and 32946), PackBits; predictor 1 and 2; unsigned 8, 9-15 (packed, unpacked to 16-bit containers), 16, 32 bit; signed 8/16/32 bit; float 32/64; BlackIsZero, WhiteIsZero (inverted, flagged), RGB | Every full-resolution page, and every sample of a multi-sample page, becomes one channel. Reduced-resolution and mask pages are skipped (flagged). Signed, unsigned-32 and float64 data are converted to float32 (flagged; signed values are kept, not offset). |
| OME-XML inside TIFF | channel names, `DimensionOrder`, `SizeC/Z/T`, `PhysicalSizeX` with unit (um, nm, mm, cm, m, pm, Angstrom) | Names are cleaned (control characters and angle brackets removed, 80 characters). If the metadata does not match the number of pages, generic names are used (flagged). Only the first image series is read (flagged). A z/time stack is listed plane by plane (flagged). |
| Pixel size (other) | TIFF `XResolution` with unit centimetre or inch; ImageJ `unit=` in the description | Resolutions of exactly 72, 96 or 300 dpi are treated as print/screen defaults and ignored (flagged). |
| JPEG | decoded by the browser (8-bit) | **Lossy, flagged in every result.** Grey JPEGs become one channel, colour JPEGs three. The browser is asked not to colour-convert or rotate. |
| ZIP | stored or deflate entries that end in `.png/.tif/.tiff/.jpg/.jpeg` | Other entries, `__MACOSX` and dot-files are ignored. Entry CRCs are checked. Nested ZIPs are not opened. |

### Not supported (fails with a message that says what to do)

JPEG-in-TIFF and old-style JPEG, CCITT, ZSTD, WebP, LZMA, JPEG 2000 inside TIFF; the floating-point predictor (3);
palette-colour, CMYK, YCbCr, Lab and transparency-mask TIFFs; bit depths 1-8 other than 8 in TIFF; float16; samples
with different bit depths in one pixel; old-style (pre-1988) LZW; ZIP64 and encrypted or multi-part ZIPs; files with
more than 64 planes/channels (z-stacks, time series); more than 4,096 IFDs.
The message for a TIFF problem always ends with the remedy: *export the image as an uncompressed, LZW or Deflate
(ZIP) TIFF / OME-TIFF (or a 16-bit PNG) and try again*.

## Limits and guards

| Guard | Default | Why |
|---|---|---|
| File size | 200 MB | Memory |
| Pixels per channel | 16 megapixels, or the engine's `maxImagePixels` from `capabilities()` when it reports one | Aligned with the engine; checked from the header **before** any pixel memory is allocated |
| Channels per TIFF | 64 | z-stack / time-series guard |
| Decoded bytes per request | 768 MB | Channels are scanned and decoded one at a time |
| Strip / tile buffer | 256 MB | A tiny file declaring an enormous tile cannot force a huge allocation |
| Files per session | 500 | UI and memory |
| ZIP directory entries / images / per entry / total | 2,000 / 200 / 256 MB / 1 GB | Archive bombs |
| ZIP compression ratio | 500:1 for entries above 1 MB | Archive bombs |
| Decompression | Output is capped while streaming at the size the file declares; a longer stream is cut off (`bomb`) and a shorter one is an error | Decompression bombs |

Additional behaviour: every read is bounds-checked (a read past the end of the file becomes a "truncated or
corrupt" message, never an exception from the page); IFD chains are checked for cycles; strip/tile tables are read
only for pages that are actually decoded; corrupt, truncated or mis-labelled files produce a readable message in the
file table and do not stop other files. A fuzz test (seeded truncations and bit flips of every fixture) asserts
that only the library's own `FociIOError` is ever thrown. When a run starts, each file is re-read and its SHA-256 is
compared with the one taken when it was added; a file that changed on disk is refused.

## Privacy model and how it is enforced

The promise is "your files never leave your browser". It is enforced, not just stated:

1. `lab.html` carries a `<meta http-equiv="Content-Security-Policy">` that sets `default-src 'none'`,
   `connect-src 'none'` (no `fetch`, XHR, WebSocket, EventSource or `sendBeacon`), `script-src 'self'`,
   `style-src 'self' https://fonts.googleapis.com`, `font-src https://fonts.gstatic.com`,
   `img-src 'self' data: blob:`, `worker-src 'self' blob:`, `base-uri 'none'`, `form-action 'none'`,
   `object-src 'none'`, `frame-src 'none'`, with no `unsafe-inline` and no `unsafe-eval`. The page has no inline
   script, no inline style attributes and no form. Verified in a browser: `fetch`, `XMLHttpRequest`, `WebSocket`
   and `sendBeacon` are all refused with a CSP violation, and normal use (file reading, workers-free decoding, blob
   overlays, downloads) produces no violation.
2. `foci/tests/io-nonetwork.test.mjs` fails if `lab.js` or any file in `foci/web/io/` contains `fetch`,
   `XMLHttpRequest`, `WebSocket`, `sendBeacon`, `EventSource`, `importScripts`, dynamic or static `import`, worker
   creation, `eval` / `new Function`, `document.write`, HTML-string injection (`innerHTML` and friends) or an
   external URL literal; and if `lab.html` loses any CSP directive above, loads a cross-origin script, gains an
   inline handler or style, or references an external URL that is not a plain hyperlink or Google Fonts.
3. File names and OME-XML strings are only ever written with `textContent` / attributes, never as HTML, and CSV
   cells that begin with `= + - @` are prefixed with a quote so a spreadsheet cannot run them as formulas.
4. The only `localStorage` key is `foci-theme` (the same theme toggle as the other pages). No file name, hash or
   result is stored.

Engine files are loaded as same-origin scripts/workers (`engine/engine.js` and whatever it starts). A blob worker
inherits this page's policy, so it cannot connect either. If the engine ever ships WebAssembly, the policy would need
`'wasm-unsafe-eval'` added to `script-src` (this permits WebAssembly compilation only, not JavaScript `eval`).

Google Fonts are the one third-party request the page makes (as on every other Foci Lab page): the browser fetches
the font CSS and files; no image data is involved. Self-hosting the fonts would remove even that.

## How results are produced

1. The reader turns each file into channels `{name, data, width, height, bitDepth}` where `data` is `Uint8Array`
   (8-bit), `Uint16Array` (9-16 bit) or `Float32Array` (32-bit and converted types).
2. The chosen nuclei and foci channels (same width and height, otherwise the set is refused with the sizes shown) are
   passed unchanged to `FociEngine.analyze({dna, foci, params}, {mode, overlay: true, signal})`, through a pool of
   `n` workers (`FociEngine.createPool(n)`; one set is in flight per worker). The page does **no** intensity
   scaling of its own; normalisation (for example percentile stretching of 16-bit data) is the engine's, and each
   result's `normalisation` field is shown on screen and recorded in the provenance file. Previews and
   histograms on the page are display-only and are not what is analysed.
3. The result is summarised (`nuclei`, `foci`, foci per nucleus, median, percentage of nuclei with at least one
   focus) from the engine's per-object counts. The overlay is stored as a PNG blob and the points / IDs are drawn from
   the engine's coordinates.
4. **Conditions.** Mean foci per nucleus is reported pooled (total foci / total nuclei), as a mean +- SD of
   per-image means, and, if replicate labels are given, as a mean +- SD of per-replicate means. The page warns that
   fields of view from one well or dish are technical, not independent, replicates, and flags conditions with fewer
   than three labelled replicates. Nothing on the page computes a p-value.

## Reproducibility: the provenance file

`foci-lab-provenance-<timestamp>.json` (`schema: foci-lab-provenance/1`) records: page version and reader version;
the engine version, the requested mode, the backends actually used, the capability report and the pool size; the
parameters used and the engine defaults; for every image set the nuclei and foci file (name, size, **SHA-256 computed in
the browser**, format, ZIP container and its hash), channel index and name, bit depth, size, pixel size, backend,
engine version, timing, the engine's normalisation and parameters, counts, reader and engine warnings and any error;
the browser's user agent and core count; start and finish times; and the standing caveats. With the same files, the
same engine version, the same parameters and the same backend, the counts should repeat; CPU (reference) and GPU
backends are checked against each other by the engine's own tests (`ENGINE.md`), not by this page.

## Accessibility and layout

Every control has a label; the drop zone has real buttons; status messages are `role="status"`; the overlay viewer is
keyboard focusable (`+`, `-`, `0`, arrow keys); colours come from the shared theme tokens with a contrast of at least
4.5:1 in both themes (checked on every rendered text node); the page has no horizontal scroll at 390 px.

## Known limits

- The analysis quality is whatever the engine gives: a classical counter, unvalidated, tuned for roughly 20x widefield
  nuclei of 150+ pixels.
- Very large images still need hundreds of MB while they run; there is no tiling.
- JPEG is decoded by the browser, so its colour handling depends on the browser.
- Multi-file OME-TIFF (planes in other files) and OME series beyond the first are not read.
- Unsaved results are lost on reload; export what you need.
