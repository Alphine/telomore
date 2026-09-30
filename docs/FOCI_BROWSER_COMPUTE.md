# Foci Lab: in-browser (WebGPU) compute - verified design and benchmark plan

Author: RESEARCH agent, branch `feat/fb-research`. Evidence gathered 2026-09-30 / 2026-10-01 (UTC dates in server headers: 2026-09-30).
Tags: **VERIFIED** = I opened the page / ran the code / saw the header myself, date given. **UNVERIFIED** = not opened or not reproduced; treat as a lead.
All numbers below are measured or copied from a named source; nothing is from memory unless tagged UNVERIFIED.
Reusable artefacts: `foci/docs/research/` (dataset table, benchmark protocol, probe scripts).

---

## 0. Decision summary (one page)

**Goal.** Foci Lab reads and analyses user files in the user's browser; the server never receives pixels and never runs user compute; results are accurate and precise.

**Recommended architecture**

1. **One engine, two modes, same code path for everything except the filter kernels** (ES modules, no globals, runs in Node 22 for tests and in a dedicated Web Worker in the page):
   * `reference` - CPU, JavaScript, Float64 accumulation **with float32 stores at the same points scipy stores float32**. This is what makes it bit-exact with Python (section 2, VERIFIED on one image: 100 % of pixels bit-identical to `scipy.ndimage.gaussian_filter`). It is the default for any number that is exported, compared against the authors, or shown as a result.
   * `gpu` - WebGPU compute (f32) for the *filters only* (separable Gaussian, van Herk min/max for grey opening / top-hat / `maximum_filter`). Everything with data-dependent control flow or branchy integer logic (log + histogram + Otsu, binary opening, fill-holes, connected-component labelling, object statistics, peak selection) stays on the CPU for 696x520 fields. A boot-time self-test compares GPU output with the CPU reference on a built-in fixture and **falls back to `reference` automatically** if tolerances are exceeded, the adapter is a fallback/software adapter, or `device.lost` fires.
2. **Files are decoded on the CPU in a worker** (vendored, pinned libraries, section 4); decoded planes are transferred to the engine as `Uint16Array`/`Float32Array`. No network primitive exists in the engine or decoder bundles.
3. **Remote (IDR) plates are fetched directly by the browser** from the EBI BioImage Archive with HTTP Range (CORS and Range both VERIFIED from a real browser at origin `https://studylab.id`, section 5): 1.65 MB of zip central directory per plate, then about 0.9 MB per well (both channels). The PHP side serves only small static JSON (plate index, offsets) - **no pixel proxy by default**.
4. **Honesty rule unchanged:** the counter stays labelled *unvalidated* until section 9's benchmark is run and passes pre-registered thresholds. Speed and GPU do not make it more accurate; they only make the measurement cheap.

**GPU vs CPU split** (696x520, two channels, 384 wells per plate)

| Stage | Where | Why |
|---|---|---|
| Decode (PNG/TIFF/zip/blosc) | CPU worker | branchy, small; libraries exist |
| Gaussian (sigma 2 and 1) | GPU (reference: CPU) | separable, regular, f32 error ~2e-7 relative (measured) |
| Grey opening 41x41, white top-hat 7, maximum_filter 5 | GPU (reference: CPU) | min/max are **exact in f32**; bit-identical to CPU given identical input |
| log1p, 256-bin histogram, Otsu | CPU (read back `flat`, 1.4 MB) | GPU `log` has ULP error and bin flips; CPU f64 is cheap |
| binary_opening x2, fill holes, label, size filter, stats, peak pick | CPU | tiny at this size; must match scipy's raster-order labelling |
| Batching across a plate | GPU only if batched (<= 64 fields per dispatch group) | one field is latency-bound (4.5 ms round trip measured for a 1024^2 blur) |

**Out of scope (say so in the UI and docs):** vendor formats (CZI/ND2/LIF) - ask users to export OME-TIFF; 3-D stacks/time series beyond picking one plane; any claim that the counter reproduces the authors (it does not, section 6); mobile Firefox; cross-origin-isolated multithreaded WASM (not needed, not cheaply available on this host, section 1.4).

**Top 5 risks**

| # | Risk | Evidence | Mitigation |
|---|---|---|---|
| 1 | **Accuracy is unproven and the baseline is weak.** Repo pipeline with default parameters, run once on the BBBC039 test split: object F1@IoU0.5 = 0.50, F1@0.7 = 0.02, nuclei count bias -17 % (95 vs 114 per field). Foci vs authors: Spearman 0.30-0.47 at best (EXPERIMENT_PROTOCOL 15.4) and the image-to-annotation pairing is unresolved. | section 6 | Keep "unvalidated"; ship the benchmark harness first; report both pairings side by side; never present a GPU speed-up as an accuracy gain. |
| 2 | **Cross-device GPU variance / driver bugs / fallback adapters.** WGSL allows fusion, reassociation, flush-to-zero, unspecified rounding mode; division is 2.5 ULP. | WGSL spec 15.7 (VERIFIED) | Only +,-,* in kernels (correctly rounded by spec); fixed summation order; no float atomics (do not exist); self-test + CPU fallback; export always from `reference` unless the user opts in. |
| 3 | **Hostile or huge files crash the tab or lock the machine** (PNG/TIFF/zip bombs, 16-bit 100 Mpx, deep zip nesting). | section 7 | Header-first size checks before decode, hard caps on pixels/bytes/entries/ratio, worker + AbortController + time budget, `deviceMemory`-scaled caps. |
| 4 | **Privacy claim is only as strong as the page's supply chain.** The current analyser page allows Google Fonts and posts to Railway; a local-only page must not. | `.htaccess` + live headers (VERIFIED 2026-09-30) | Separate local-mode page with `connect-src 'none'`, self-hosted fonts, vendored pinned libs with sha256, network-silence test in CI. |
| 5 | **Remote plate access depends on undocumented behaviour.** EBI sends `Access-Control-Allow-Origin: *` and honours Range today, but neither is documented; `robots.txt` on `ftp.ebi.ac.uk` is `Disallow: /`; EMBL-EBI terms block use that prevents service to others, with no numeric limit; `Content-Range`/`ETag` are not readable cross-origin. One plate = about 356 MB at full resolution. | section 5 | One plate at a time, concurrency 2, user-initiated, cache in Cache Storage, fall back to "download the zip and open it locally"; contact EBI before advertising plate mode widely. |

---

## 1. Browser GPU compute availability

### 1.1 Support matrix (checked 2026-09-30 / 2026-10-01)

Primary sources: caniuse feature data `features-json/webgpu.json` from github.com/Fyrd/caniuse (fetched 2026-09-30; global usage 85.72 % full + 3.05 % partial) and MDN browser-compat-data `api/GPU.json` (fetched the same day). **VERIFIED.** (A summarising fetch of the caniuse HTML page said "Firefox: not yet" - that was wrong; the raw data says partial since 141. I used the raw JSON.)

| Browser / platform | WebGPU by default? | Source note |
|---|---|---|
| Chrome / Edge desktop, Windows, macOS, ChromeOS | Yes, since 113 (MDN BCD: "partial" 113-143, full from 144) | caniuse `y` from 113; MDN `version_added 144` for current full status |
| Chrome Linux | Hardware/driver dependent; MDN: from 144 "Linux (Intel Gen12+ GPUs only)"; caniuse note "not enabled on Linux by default" (Chrome/Opera 113+), note 9 "depends on hardware and drivers" | two notes differ; treat Linux as **not dependable** |
| Chrome Android | Yes (MDN 121; caniuse lists 154 as the tracked Android version) | |
| Samsung Internet | Yes, 24+ | caniuse |
| Safari macOS | **Partial**: default only on macOS 26 (Tahoe) or later | caniuse note 7; MDN `safari: 26` |
| Safari iOS / iPadOS | Yes, 26.0+ | caniuse `y` from 26.0 |
| Firefox desktop | **Partial**: on by default on Windows since 141 (not service workers); macOS Tahoe Apple silicon since 145; otherwise flag `dom.webgpu.enabled` | MDN notes, caniuse notes 1, 6, 8 |
| Firefox Android | No (flag only) | caniuse `and_ff` = `n d` |

Other facts used: WebGL2 96.44 % global, WebAssembly SIMD 95.69 %, OffscreenCanvas 95.52 %, SharedArrayBuffer 96.21 % (caniuse, same fetch; SAB still needs cross-origin isolation to be *usable*), File System Access API 30.54 % - so the file picker must be `<input type=file>` + drag and drop, not `showOpenFilePicker`.

**Recommendation.** WebGPU is an *accelerator*, not a requirement. Feature-detect `navigator.gpu` and `requestAdapter()` (may return `null`; check `adapter.isFallbackAdapter`), then run the self-test. Every user must be able to finish an analysis with the `reference` engine alone.

### 1.2 Limits: spec defaults vs this machine

Spec defaults (W3C WebGPU spec `#limits`, fetched 2026-09-30, **VERIFIED**): `maxStorageBufferBindingSize` 134217728 (128 MiB); `maxBufferSize` 268435456 (256 MiB); `maxComputeWorkgroupsPerDimension` 65535; `maxTextureDimension2D` 8192 (compat mode 4096); `maxComputeInvocationsPerWorkgroup` 256; `maxComputeWorkgroupStorageSize` 16384; `maxComputeWorkgroupSizeX` 256. Atomics exist only for 32-bit integers (WGSL `atomic<T>` wraps a concrete integer type; there are no float atomics).

**Important:** a device created with `requestDevice()` and no `requiredLimits` gets the *defaults*, not the adapter's maximum. Adapter-reported limits (below) are not usable unless requested. The engine should request nothing beyond defaults unless a large-image path needs it.

This environment (section 1.5) reported: `maxStorageBufferBindingSize` 2147483644, `maxBufferSize` 2147483648, `maxComputeWorkgroupsPerDimension` 65535, `maxTextureDimension2D` 16384, `maxComputeInvocationsPerWorkgroup` 1024, `maxComputeWorkgroupStorageSize` 32768, `maxStorageBuffersPerShaderStage` 16.

What the defaults mean (arithmetic, not measured):

| Case | Size | Fits default limits? |
|---|---|---|
| One IDR field 696x520 f32 | 361,920 px x 4 B = 1.45 MB | yes, trivially |
| Batch of fields in one storage binding | 128 MiB / 1.45 MB = 92 fields max; use **64** (92.7 MB) | yes |
| Whole plate (384 fields x 1 channel f32) | 556 MB | **no** as one binding; process in batches of 64 |
| 12 Mpx image (e.g. 4096x3072) f32 | 48 MB per buffer; opening needs in+tmp+out = 3 bindings of 48 MB | yes (each binding < 128 MiB) |
| Texture dimension | 4096x3072 < 8192 | yes (only matters if textures are used; storage buffers are simpler here) |
| > 33.5 Mpx f32 (128 MiB / 4 B) | | needs tiling with halos or `requiredLimits` |

Tiling halo for the nuclear branch: Gaussian radius 8 (sigma 2, scipy truncate 4.0 -> radius int(4*2+0.5) = 8) + opening radius 20 erosion + 20 dilation = **48 px**; foci branch (sigma 1 radius 4, top-hat 7: 3+3, maximum_filter 5: 2) = **12 px**. Reflect borders must be applied at the *image* border only, not at tile borders.

### 1.3 WebGL2 fallback

Viable for the same filters (fragment-shader separable passes into `R32F` render targets; `EXT_color_buffer_float` was present here) and 96 % available, but: no compute shaders, no storage buffers, no atomics -> histogram must be CPU; readback via `readPixels` is synchronous-ish; float precision in fragment shaders is `highp` = at least 32-bit range but is not guaranteed IEEE. **Recommendation: do not build a WebGL2 path.** The cost (a second kernel implementation and a second tolerance matrix) is not justified when the CPU `reference` engine covers devices without WebGPU, and 696x520 fields take about 150 ms of unoptimised JS (1.4).

### 1.4 WASM and pure JS

* Pure-JS Float64 is the reference path. Node 22 timing for one 696x520 field, **unoptimised** code (`probes/cpu_filters_timing.mjs`, VERIFIED on this machine): Gaussian sigma 2 separable: **61 ms**; 41x41 grey opening by van Herk (4 separable passes): **86 ms**; van Herk erosion matched brute force on 5 probe pixels. Whole nuclear branch ~ 0.2 s/field single thread, so a 384-well plate is about 75-150 s of pure compute on one core, less with a few workers. Foci branch adds smaller filters. These are rough, for planning only.
* WASM SIMD is available here (`WebAssembly.validate` of a v128 module returned true) and 95.69 % globally, but it needs `'wasm-unsafe-eval'` in CSP (VERIFIED, MDN script-src) and buys little for these sizes. **Not recommended for v1.** (Exception: if a vendored codec such as blosc/zstd ships as wasm only; a pure-JS blosc-lz4 decoder is about 25 lines and was verified, section 5.4.)
* WASM threads need `SharedArrayBuffer`, which needs cross-origin isolation (`Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp`). In this environment `crossOriginIsolated` was `false` and `SharedArrayBuffer` undefined. The host is LiteSpeed on Hostinger and already honours `Header set` (live headers show `X-Content-Type-Options`, custom CSP on `analyze.html`), so sending COOP/COEP is probably possible **(UNVERIFIED: not tried)**, but COEP `require-corp` would also block any cross-origin subresource without CORP/CORS headers - including the EBI/IDR fetches unless made with `mode:'cors'` (they allow `*`) and Google Fonts. **Not recommended**; use several Web Workers with transferable `ArrayBuffer`s instead.

### 1.5 This environment's in-app browser (VERIFIED 2026-10-01)

Probe page: `foci/docs/research/probes/webgpu-probe.html`, served over `http://127.0.0.1` (a `file://` page was not scriptable in the pane; I used a temporary local static server and stopped it afterwards).

* UA: `Claude/2.16120.0 Chrome/152.0.7977.130` (Electron/Chromium, Windows 11). `isSecureContext` true, `crossOriginIsolated` false, `hardwareConcurrency` 12, `deviceMemory` 16.
* **`navigator.gpu` is present; `requestAdapter()` succeeded.** `adapter.info` = `{vendor:"amd", architecture:"gcn-5", device:"", description:""}` (device and description are deliberately empty - reduced fingerprinting). `isFallbackAdapter` was `undefined` in this build (property absent; treat `undefined` as "not known to be fallback", do not rely on it). WebGL2 reports `ANGLE (AMD, AMD Radeon(TM) Graphics (0x00001638) Direct3D11 ...)` (an integrated AMD GPU), `MAX_TEXTURE_SIZE` 16384.
* Features included `shader-f16`, `subgroups`, `timestamp-query`, `float32-filterable`. Limits: see 1.2.
* **A compute shader ran**: 1-D 41-tap box blur (reflect borders) on a 1024x1024 f32 buffer, workgroup 16x16. GPU: **4.55 ms per run** (20 runs averaged, each including `submit` + `onSubmittedWorkDone`, i.e. latency-dominated) and 9.8 ms for one run including copy-to-staging + `mapAsync` readback of 4 MB. JS Float64 naive loop (no sliding window): **70.5 ms** -> about 15x faster than a naive loop. Honest caveat: a sliding-window CPU implementation would be several times faster than the naive loop; do not quote 15x as "GPU speed-up". Accuracy vs Float64 reference: max abs error 4.84e-4 on values up to about 1000 (relative ~5e-7 of the largest value; the 2.7e-4 "max relative" printed by the probe is at near-zero outputs, where relative error is meaningless).
* Timing is one run on one integrated GPU; do not generalise.

---

## 2. Precision: float32 GPU vs the Python reference

### 2.1 Finding that changes the plan: the Python "reference" is itself float32 in places

`segment.py` casts to `float32` before smoothing (`ndi.gaussian_filter(dna.astype(np.float32), ...)`). scipy computes each 1-D pass in double internally but **stores the intermediate and the result as float32**. `np.log1p` on a float32 array is a float32 operation, and `np.histogram` runs on those float32 values. So "exact parity with Python" means reproducing these store points, not computing everything in Float64. Verified experiment (`probes/gaussian_parity_probe.py`, BBBC039 image, sigma 2, numpy 2.3.4):

| Variant | Max abs diff vs scipy | Bit-identical pixels |
|---|---|---|
| Float64 accumulate, `fround` after **each axis pass**, scipy's summation order | 0 | **100 %** |
| Same, plain left-to-right summation | 0 | **100 %** |
| Float64 throughout, round to f32 only at the end | 1.2e-4 | 90.9 % |
| **float32 accumulate** (GPU-like, sequential) | 3.7e-4 (input max 1720) | not equal; max relative 4.0e-7 |

Kernel as scipy builds it: float64 weights, length `2*int(4*sigma+0.5)+1` = 17 for sigma 2, symmetric, normalised; borders `mode='reflect'` = half-sample symmetric (`d c b a | a b c d | d c b a`; NumPy `pad(mode='symmetric')`). One image only: confirm on the golden set (section 8).

### 2.2 Operation-by-operation

| Operation | CPU f64 / scipy | f32 GPU | Deterministic across GPUs? | Plan |
|---|---|---|---|---|
| Gaussian separable | f64 sum, f32 store per axis | f32 accumulate: abs err ~4e-4 at 1720 (rel 4e-7) | No (order/fusion/FTZ allowed by spec) | GPU within tolerance `abs <= 2e-3` per pixel (5x margin) for 12-bit input; reference = bit-exact |
| Grey opening 41x41, top-hat, `maximum_filter` (min/max) | exact compare | **exact** (compare/select are exact; no rounding) | **Yes**, bit-identical *given identical input* | Test bit-exact on integer-valued input; chain errors come only from the Gaussian |
| `flat = smooth - opening` | f32 subtract | correctly rounded (WGSL +,-,* are "Correctly rounded") | Yes given same operands | fine |
| `log1p`, histogram, Otsu | f32 `log1p`, 256 bins | `log` is approximate; bin flips near edges; integer atomics are exact but bin *index* is not | No | **CPU**: `Math.fround(Math.log1p(x))`; threshold equality measured 50/50 images (below) |
| threshold compare `flat > th` | | boundary pixels flip if `flat` differs by 1 ulp | | counted in tolerance (below) |
| binary opening (cross, 2 iterations, border 0), `binary_fill_holes` (4-conn background from border) | integer | integer logic exact | Yes | CPU, exact |
| `label` (4-conn) | labels numbered by **first pixel in raster order** (verified property) | parallel union-find gives arbitrary ids | ids No, partition Yes | relabel by min linear index -> identical ids; partition exact |
| `estimate_nuclei` | `np.median` (mean of two middles for even count), `np.rint` = **round half to even** | | | JS `Math.round` is wrong (half up); implement half-to-even explicitly |
| Sizes `bincount`, stats | exact ints | | | exact |

### 2.3 Measured effect of float32 vs float64 on the nuclear mask (BBBC039 test split, 50 images, default params)

`probes/bbbc039_baseline.py`: pipeline re-implemented four ways (repo as-is; Float64 end-to-end; numpy-emulated GPU with sequential f32 accumulation; same with reversed order).

* Foreground pixels differ from the repo result by 0.1 / 0.04 / 0.08 pixels per image on average (max 1-2 of about 112,800 foreground pixels).
* **Object count identical in 50/50 images for all variants**; F1 curves identical to 3 decimals.
* Otsu threshold identical in 50/50 images between numpy's float32 `log1p` and `fround(Math.log1p-equivalent float64)`; 0 pixels flipped. The 256-bin histogram (bin width about 0.028 in log units, about 2.9 % of intensity) makes the threshold robust to ulp-level noise.
* Limits of this evidence: numpy *emulates* f32 GPU arithmetic (sequential, no fusion, no FTZ); a real GPU can fuse and reorder, so the real tolerance must come from the boot self-test and from the parity benchmark on real adapters (section 9.4). Foci (sigma 1, top-hat, `th >= min_height`, `th == maximum_filter`) were **not** tested; ties in `th == max_filter` are the most fragile comparison in the pipeline (plateaus of equal float values). Test it.

### 2.4 Recommended tolerances (to be confirmed by the parity benchmark, not assumed)

* `reference` vs Python: **exact** - identical label arrays, identical counts, bit-identical float32 intermediates (Gaussian, opening, top-hat).
* `gpu` vs `reference`: Gaussian `max|d| <= 2e-3` (12-bit scale); opening/top-hat/max-filter bit-exact on integer input; after the full pipeline: per-field nuclear foreground mismatch `<= 0.01 %` of pixels and **object count equal** in >= 99 % of fields (measured emulated value: 100 %, 2e-5 pixels); foci count per well `|d| <= 1` focus in >= 99 % of fields. These are proposals based on one emulation, to be replaced by numbers from section 9.4.
* Boot self-test (runs once per session, about 10-30 ms): synthetic 256x256 integer-valued image with a known hash; run Gaussian + opening + tophat on GPU; compare to `reference`; require the tolerances above; require two consecutive GPU runs to be bit-identical (run-to-run determinism); on failure or `isFallbackAdapter === true` -> `reference`. Record adapter info and limits in the result provenance.

### 2.5 Engine design (two modes)

```
analyse(planes, params, { mode: 'reference' | 'gpu' | 'auto', signal, onProgress })
  -> { nuclei: Int32Array labels, foci: [...], counts, provenance: { mode, adapter, limits, selftest, engineVersion, paramsHash, scale } }
```

* `reference`: Float64 math with explicit `Math.fround` at the scipy store points; golden-fixture parity is a CI gate.
* `gpu`: same orchestration, kernel functions swapped; histogram/Otsu/labelling on CPU; per-stage timings in `provenance`.
* `auto`: `gpu` if self-test passed else `reference`. **Exports and comparisons against the authors always re-run or state the mode**; default export mode is `reference`.
* Input scale must be explicit. `backend/foci_upload.py` stretches 16-bit input to 0-255 by the 0.1-99.99th percentile, while `raw16.py`/the L2 experiment uses raw units (IDR data are 12-bit, max 4095). `min_height = 12` means 12 grey levels of the 0-255 scale. The engine takes `scale: 'as-is' | 'percentile-0255'` and records it; the two are not interchangeable.

---

## 3. GPU algorithms

**Separable Gaussian (sigma 2: 17 taps; sigma 1: 9 taps).** Two passes (rows then columns, same order as scipy: axis 0 first then axis 1 - confirm against scipy source/golden), 16x16 workgroups (256 invocations = default cap), weights in a small uniform/storage buffer computed on the CPU in Float64 then cast to f32, reflect index mapping in-shader. Stage the tile plus halo in `var<workgroup>` (16 KiB default: a 16x(16+16) f32 strip = 2 KiB is fine). Keep summation order fixed, use only `+` and `*` (avoid `fma`, `/`, `exp`, `pow` in the kernel).

**41x41 grey opening (erosion then dilation, each separable: 4 passes).** Use van Herk / Gil-Werman (Pattern Recognition Letters 13(7), 1992, 517-521; cited via search results only, **UNVERIFIED** paper text): per line, split into blocks of 41, prefix-min `g` and suffix-min `h`, then `out[i] = min(h[i], g[i+40])`: about 3 compares per pixel independent of window size. On GPU, one workgroup per line segment (or per tile column), 256 threads, scan in workgroup memory; a simple alternative is the direct 41-tap min per pixel (41 x 361,920 = 14.8 M compares per pass, trivial for a GPU and far simpler; the verified 1024^2 41-tap box blur took 4.5 ms round trip). **Recommendation: direct 41-tap separable min/max first; van Herk only if profiling on low-end integrated GPUs shows it matters.** On the CPU reference, van Herk was verified (Node, 86 ms for the whole opening). Mind scipy's border handling: `grey_opening` runs erosion with `mode='reflect'` and dilation with `mode='reflect'` separately - reflect inside each stage, not once at the end. Odd sizes only (41, 7, 5): even sizes shift the origin in scipy.

**Top-hat (7) and `maximum_filter` (5):** same kernels with radius 3 and 2. `peaks = (th == maxfilter(th)) & (th >= min_height) & (nuclei > 0)`: equality of identical f32 values is well defined when both sides come from the same kernel output on the same device; do not compare a GPU `th` with a CPU `maxfilter`.

**Connected-component labelling.** Options: (a) label propagation (iterate min over 4-neighbours until no change; simple, O(diameter) iterations - a nucleus about 25 px across needs about 30-60 iterations, merged clusters more); (b) union-find with path compression using `atomicMin` on `u32` (WGSL has only integer atomics, which is what is needed); (c) block-based algorithms from the GPU CCL literature (Playne and Hawick, "A New Algorithm for Parallel Connected-Component Labelling on GPUs", IEEE TPDS 29(6):1217-1230, 2018; Allegretti, Bolelli, Grana, "Optimized Block-Based Algorithms to Label Connected Components on GPUs", IEEE TPDS 31(2):423-438, 2020 - titles confirmed via search results, papers not read, **UNVERIFIED** for details). **Recommendation: CPU two-pass union-find for 696x520** (about 0.36 Mpx: a few ms in JS; run it in the worker while the GPU processes the next field) and only consider GPU label propagation/union-find for single images above about 12 Mpx. Whatever the algorithm, **canonicalise ids by minimum linear index** (verified property of scipy `label`), which also removes atomic-order nondeterminism.

**Fill holes.** scipy `binary_fill_holes` = flood-fill the *background* from the border with 4-connectivity, complement. CPU BFS with a typed-array queue is exact and fast. GPU variant (iterated dilation of the border-connected background masked by the inverse) needs O(image size) iterations worst case: not worth it.

**Local maxima.** Regular stencil -> GPU friendly; already covered by `maximum_filter`. The subsequent `nonzero`, `bincount` over nucleus ids, and numbering happen on the CPU from a bit mask (read back `peaks` as `u8`, 0.36 MB).

**Batches (plates).** Real speed comes from pipelining, not from a single field: (1) decode field N+1 in a worker while the GPU works on N; (2) upload 64 fields as one buffer with field index in `global_invocation_id.z`; (3) one readback of the `flat` and `th` planes per batch into a pre-allocated staging buffer; (4) CPU tail (Otsu, labelling, counting) in a second worker. For a remote plate the 356 MB download dominates: at 10 MB/s that is about 36 s against about 75-150 s of single-thread CPU reference compute, so even the CPU path is usable with 2-4 workers; the GPU mostly matters for local folders of hundreds of large images.

---

## 4. File formats in the browser

Registry data read from `registry.npmjs.org` on 2026-09-30 (version, licence, unpacked size, publish date) - **VERIFIED**. Capabilities come from each package's README fetched from jsDelivr the same day (so they are the maintainers' claims) - I did **not** run these decoders on real files except where stated. Always test against the fixtures in section 8 before adopting.

| Need | Library | Version (2026-09-30) | Licence | Unpacked size | Claimed capability | Known gaps / cautions |
|---|---|---|---|---|---|---|
| ZIP read | `fflate` | 0.8.3 | MIT | 797 kB (8 kB core) | sync/async inflate, unzip | no zip64 encryption; you must enforce your own size caps; README benchmarks are the author's |
| ZIP read, streaming, zip64 | `@zip.js/zip.js` | 2.21.0 | BSD-3-Clause | 8.7 MB (incl. variants) | Zip64, >4 GB, Web Streams, Deflate64 decompress, workers | larger; pick the minimal build |
| inflate | `pako` | 3.0.2 | MIT AND Zlib | 2.5 MB | zlib port | use only as dependency; `DecompressionStream('deflate-raw')` is an alternative (caniuse page for it was not found, **UNVERIFIED** support %) |
| ZIP | `jszip` | 3.10.2 | **MIT OR GPL-3.0-or-later** | 693 kB | classic | dual licence; choose MIT explicitly or avoid; slower; not recommended |
| PNG 8/16-bit | `fast-png` | 8.0.0 | MIT | 163 kB | decode/encode 8 and 16-bit, channels 1-4 | "only 8 and 16 supported" (no 1/2/4-bit); README silent on Adam7 interlace - test |
| PNG | `pngjs` | 7.0.0 | MIT | 650 kB | reads 1/2/4/16-bit and interlaced | README: "8 bit per sample is the only supported bit depth" **for writing/input to pack**; 16-bit output arrays are in system endianness; Node-stream oriented |
| PNG (legacy) | `upng-js` | 2.1.0 (2017) | MIT | - | | unmaintained; skip |
| TIFF (simple, 8/16-bit) | `tiff` | 7.1.3 | MIT | 136 kB | LZW, Zlib/deflate, alpha, `Uint8/Uint16Array`, multi-IFD | README lists no PackBits, no JPEG; tiled/BigTIFF/predictor support **not stated** -> UNVERIFIED; pulls `fflate`, `iobuffer` |
| TIFF (broad) | `geotiff` | 3.0.5 | MIT | 3.8 MB | tiled, none/PackBits/LZW/Deflate (+float and horizontal predictor)/JPEG/LERC/WebP, "limited BigTIFF", byte-range/remote sources | 3.0 has breaking API changes; geo-centric API, OME-XML not parsed (read `ImageDescription` yourself); "limited" BigTIFF; deps `lerc`, `zstddec`, `pako` (wasm?) - check CSP |
| TIFF (legacy) | `utif2` | 4.1.0 (2023) | MIT | 105 kB | LZW, PackBits, JPEG, Fax, inflate | photography-oriented; 16-bit/multi-page semantics need checks; README discourages TIFF |
| JPEG | `jpeg-js` | 0.4.4 (2022) | BSD-3-Clause | 76 kB | baseline/progressive 8-bit | 8-bit only; or use `createImageBitmap` (colour-managed, lossy path - avoid for quantitative work) |
| OME-Zarr / zarr v2-v3 | `zarrita` | 0.7.5 | MIT | 1.1 MB | v2/v3, C/F order, pluggable stores and codecs, fetch/Range via `@zarrita/storage` (+ `unzipit` for zip stores) | blosc needs a codec (`numcodecs` 0.3.2, MIT, ships wasm codecs -> CSP `'wasm-unsafe-eval'`); endianness `>u2` must be handled |
| OME-Zarr helper | `ome-zarr.js` | 0.0.21 | BSD | 489 kB | simple rendering utils | 0.0.x; not needed |
| Heavy, multi-format (ITK) | `@itk-wasm/image-io` | 1.6.1 | Apache-2.0 | 23 MB | many medical/scientific formats | wasm, large, axios dependency - out of proportion |

**What I verified myself for the real data path:** the S-BIAD885 chunks are zarr v2, `>u2`, chunks `[1,1,1,520,696]`, compressor **blosc, cname lz4, shuffle 1, clevel 5**, stored inside the zip with DEFLATE (method 8) or STORED (method 0). The blosc header has `typesize 1` (so byte-shuffle is a no-op here), `blocksize 131072`, 6 blocks per 723,840-byte chunk. A 35-line pure-JS LZ4 block decoder plus blosc header parsing (`probes/blosc_lz4_decode_check.mjs`) decoded one chunk to a plausible 12-bit image (min 49, max 1497, mean 167.6, DNA channel, plate 7-14 well A1). It was **not** cross-checked against a reference blosc implementation: add that to the fixture tests (decode the same chunk with Python `zarr`/`numcodecs`). This keeps the remote path free of wasm.

**Recommended decoder bundle (v1):** `fflate` (zip, inflate) + `fast-png` (8/16-bit PNG) + `geotiff` **or** a minimal in-house classic/BigTIFF reader limited to uncompressed / LZW / deflate(+predictor 2) strips and tiles, little and big endian, 8/12/16-bit (12-bit data are stored in 16-bit containers), multi-page via IFD chain, with OME-XML `ImageDescription` parsed only for `SizeC/Z/T`, `DimensionOrder`, `PhysicalSizeX`. Decide after running section 8's fixtures through `geotiff` and `tiff`: whichever passes all is the choice; if `geotiff` passes, its size (3.8 MB unpacked) is acceptable when tree-shaken; `tiff` (136 kB) is preferable if it handles the fixtures. Explicit non-goals: JPEG-compressed or JPEG2000 TIFF, planar RGB colour science, 32-bit float beyond reading values.

**Explicit "cannot do" list to show in the UI:** unknown compression -> "unsupported compression (code N); export as uncompressed or LZW/deflate OME-TIFF"; big-endian / tiled / BigTIFF support must be stated per the fixture results; 3-D stacks -> choose one plane (default: middle Z, first T) and say so.

**Vendor formats (CZI, ND2, LIF):** no credible lightweight browser decoder was found in this research (Bio-Formats is Java; the ITK-wasm route above does not list these in the description I read, **UNVERIFIED**). Recommend: users export OME-TIFF (Fiji/Bio-Formats, vendor software) and the page says so when it sniffs `ZISRAWFILE` (CZI), ND2 (`0xDA 0xCE 0xBE 0x0A` magic, **UNVERIFIED**) or LIF headers.

**Supply-chain hygiene (required):** vendor a pinned copy under `foci/web/vendor/<name>-<version>/` with the upstream LICENSE file, a `VENDOR.md` table (name, version, source URL, npm tarball integrity from the registry, sha256 of each shipped file, date), no runtime CDN loads, no `npm install` on the host. Build step (developer machine only): `npm pack <name>@<ver>`, verify the `dist.integrity` from the registry against the tarball, copy needed files, compute sha256. CI test: every file under `vendor/` matches `VENDOR.md`; CSP `script-src 'self'` only.

---

## 5. IDR / EBI access from a browser

### 5.1 CORS and Range - tested from a real browser

I ran `fetch()` from the page at origin `https://studylab.id` (the in-app browser tab already on the live site) on 2026-10-01, and the same URLs with `curl -H "Origin: https://studylab.id"` on 2026-09-30. **VERIFIED.**

| URL pattern | CORS (`Access-Control-Allow-Origin`) | Notes |
|---|---|---|
| `https://idr.openmicroscopy.org/api/v0/...` (JSON) | `*` | e.g. `/api/v0/m/plates/4503/wells/?limit=1` -> 200 from the browser |
| `https://idr.openmicroscopy.org/webgateway/imgData/{imageId}/` | `*` | size 696x520x2 channels; **`pixel_range` [0, 65535]** (declared; real data are 12-bit, L2) and `pixel_size` x/y **1.0** (the zarr/annotation say 0.465 um/px - the IDR metadata value here is not the physical one) |
| `https://idr.openmicroscopy.org/webgateway/render_image/{id}/0/0/?c=1\|0:4095$FFFFFF&m=g&format=png` | `*` | 200, `image/png`, 114,511 B, `Cache-Control: private, max-age=3600`. It is an **8-bit rendering with a user-chosen window**, not raw data. The same URL **without a window (`?` empty) or with `c=1\|255,0,0&m=g` returned 403 with an empty body** via curl; the working form has an explicit `lo:hi$colour` window. Preflight `OPTIONS` also returned `*` |
| `.../render_thumbnail/{id}/`, `.../render_birds_eye_view/{id}/` | `*` | JPEG thumbnails |
| `https://ftp.ebi.ac.uk/biostudies/fire/S-BIAD/885/S-BIAD885/Files/idr0010/7-14.ome.zarr.zip` | `*`, `Allow-Headers` includes `Range`, `Allow-Methods: GET,OPTIONS` | `HEAD` -> 200, `Content-Length` 475,572,589 readable. `Range: bytes=475572500-475572588` -> **206** with 89 bytes. **`Content-Range`, `Accept-Ranges`, `ETag` are NOT readable from JS** (no `Access-Control-Expose-Headers`): get the size from HEAD `Content-Length` and trust 206. `Last-Modified` 2023-09-06 (curl) |
| `https://www.ebi.ac.uk/biostudies/api/v1/studies/S-BIAD885` | `*` | study JSON; licence **CC BY 4.0** |
| `https://uk1s3.embassy.ebi.ac.uk/idr/zarr/v0.4/...` (IDR's own OME-Zarr S3) | `*` | listing prefix `zarr/v0.4/idr0010` was **empty**: idr0010 is not in that bucket (other IDR studies are; not checked) |
| `https://data.broadinstitute.org/bbbc/BBBC039/images.zip` | `*`, `Accept-Ranges: bytes` | Range works (curl) |

Undocumented caveat: none of these CORS/Range behaviours is promised in the pages I found; treat as "works today".

### 5.2 Reading one well from the remote zip (measured)

For plate 7-14 (zip64-free, 15,007 entries): tail 64 KiB -> end-of-central-directory (entries 15,007, central directory 1,647,852 B at offset 0x1c3f846b) -> one Range request of 1.65 MB gives the whole directory (8.5 s here) -> per well, the level-0 chunks for channels 0 and 1 are adjacent in the file (`A/1/0/0/0/0/0/0/0` at offset 4162, compressed 419,344 B; channel 1 follows). Level-0 totals across 384 wells x 2 channels: **768 chunks, 356.3 MB zip-compressed** (515.9 MB as blosc, 555.9 MB as raw uint16); level 1: 92.0 MB; level 2: 24.2 MB. Pyramids are averaged/subsampled, not the original pixels - **use level 0 for any quantitative claim.** Only 2 range requests were needed to get directory and first chunk; I did not download a whole plate this round (the earlier owner-approved download of 7-14 is in 15.4).

### 5.3 Policies (what the owners actually say)

* **IDR** `about/download.html` (fetched 2026-09-30): recommends Globus and anonymous FTP at `ftp.ebi.ac.uk/pub/databases/IDR/` for raw data; says single images from a plate are possible but hard to locate; **no statement on API rate limits, scraping, or fair use found.** `about/api.html`: describes the JSON API; also no limits. IDR website content is licensed CC BY 4.0 per its page footer (this is not the licence of individual datasets; idr0010 is CC BY 4.0 per S-BIAD885). `idr.openmicroscopy.org/robots.txt` returns 404 (no rules).
* **BioImage Archive** `help-download` (fetched 2026-09-30): lists browser, FTP, Aspera, Globus; "We recommend ftp or Aspera for large download sizes." No mention of Range, CORS, rate limits or OME-Zarr streaming.
* **EMBL-EBI terms of use** (fetched 2026-09-30): one relevant sentence - use "to a level that prevents, or is likely to prevent, EMBL-EBI providing services to others, will result in the user being blocked"; EBI says it will try to contact heavy users. **No numeric limit.**
* `https://ftp.ebi.ac.uk/robots.txt` = `User-agent: *` / `Disallow: /` (VERIFIED). This targets crawlers; a user-initiated fetch is not a crawl, but an automated loop over all 147 plates would look like one.
* Conclusion: there is **no published rate** to comply with. Use self-imposed limits, identify the app, and ask EBI (idr-support@openmicroscopy.org is the study contact in S-BIAD885; BioImage Archive contact not opened) before promoting whole-plate mode.

### 5.4 Polite design for "analyse an entire plate" (384 wells x 2 channels)

1. **User-initiated, one plate at a time**, behind a confirmation showing the size ("about 356 MB will be downloaded from EBI to your browser; nothing goes through our server").
2. Plate index: static JSON maintained offline (`plates.json`: plate name -> zip URL, size, well count). Per-plate well offsets are **not** precomputed on our server (that would need 147 x 1.65 MB = 243 MB of fetches): the browser reads the central directory itself (1.65 MB) and caches the parsed map in IndexedDB keyed by `url + Content-Length + Last-Modified` (HEAD).
3. Fetch strategy: at most **2 concurrent** Range requests, one per well (both channels in one contiguous range, about 0.9 MB), a small pause between batches, exponential back-off with jitter on 429/5xx/network error, abort on navigation/cancel (`AbortController`), `Retry-After` honoured (**no `Retry-After` observed**). Send no custom headers (keeps requests "simple"; a custom `User-Agent` cannot be set from browsers anyway).
4. Cache: Cache Storage per `url#range` for the session (user-clearable) so re-running a plate does not re-download; never write user's local files to it.
5. Memory: never hold the plate; stream well -> decode -> analyse -> keep only results (counts, per-nucleus table). 1.9 MB of raw pixels per well in flight.
6. **Proxy: off by default.** The PHP proxy is needed only if a user's network blocks cross-origin EBI requests. If built (SCREEN): exact host allow-list (`ftp.ebi.ac.uk`, `idr.openmicroscopy.org`), Range passthrough with a 2 MiB per-request cap, `Content-Length` cap, no redirects followed, per-IP token bucket (suggest 30 requests/minute, 100 MB/hour), cache responses for the IDR JSON/thumbnail endpoints only (not zip ranges), log only counters. Streaming 356 MB through shared-hosting PHP is expensive (CPU time and bandwidth of the owner's account) and makes the server a relay for third-party traffic; **recommend not offering plate-zip proxying at all**.
7. Pairing (image vs annotation): plate mode must show **both** pairings (by name and column-major) side by side, labelled unresolved (EXPERIMENT_PROTOCOL 15.4). Useful lead from S-BIAD885's own metadata (VERIFIED, 2026-09-30): the study's description says the screen was done on **siRNA microarrays in LabTek chambers** ("384 siRNA spots", spot first marked manually and re-found; "file names contain the word dapi but Hoechst was used"), i.e. "wells" are spots on an array and the scan order need not match plate-well order. This is a hypothesis about the pairing problem, **not a finding**.

---

## 6. Accuracy: how to measure it honestly

### 6.1 What exists (dataset table; also `foci/docs/research/datasets.md`)

| Dataset | Content and geometry | Ground truth | Licence | Size / URL | Fit |
|---|---|---|---|---|---|
| **BBBC039** (Caicedo et al. 2018) | 200 fields, **520x696, 16-bit TIFF, U2OS, Hoechst**; I opened an image: uint16, min 120, max **4095** (12-bit range, same as IDR) | instance masks for about 23,000 nuclei (PNG, **colour-coded so touching nuclei differ**: decode each value k>0 to connected components); official split **100 train / 50 validation / 50 test** (`metadata.zip`: `training.txt` etc.) | **CC0** (page text) | images.zip 77.9 MB, masks.zip 2.8 MB, metadata.zip 18 KB; `https://data.broadinstitute.org/bbbc/BBBC039/` | **Best fit for the nuclear branch**: same sensor geometry, cell line and stain as idr0010 |
| BBBC006 | 768 fields (384 wells x 2 sites) **x 32 focal planes**, 696x520, 16-bit LZW TIFF, U2OS Hoechst | nucleus counts (CSV), foreground masks, label images | CC0 | ~26.4 GB in 33 zips | out-of-focus robustness; too big to use casually (use only selected planes via Range) |
| Kromp et al. 2020, BioStudies **S-BSST265** | annotated fluorescence nuclear images, several cell/tissue types, DAPI | expert annotations | **not stated in the API fields I read -> UNVERIFIED** (check before use) | dataset.zip 76.3 MB | extra nuclear test of generalisation; not U2OS |
| Zenodo 4067741 / 5549971 (annotated gH2AX/53BP1 IRIF, confocal) | **3-D confocal**, head-and-neck primocultures, U-87, NHDF after irradiation | manual focus coordinates (CSV by two experts), nuclei masks, train/val/test splits | **CC BY 4.0** (Zenodo API) | **10-52 GB per archive** (e.g. `foci_detection_testing_subset.zip` 19.8 GB) | the only open point-annotated 53BP1/gH2AX foci data I found; different modality (3-D confocal, other cells) so it tests foci *logic*, not idr0010 performance; impractical to download here - UNVERIFIED internal structure |
| Doil et al. per-well table (`idr0010-screenA-annotation.csv` in the IDR repository; already in this repo's `foci/web/data`) | per-well Cell Count, foci count, foci/cell | authors' automated ImageJ routine, frames seen by two investigators, out-of-focus/aberrant/dead fields excluded manually | CC BY 4.0 | small | **not ground truth for a single image**: per-well aggregates of an unpublished procedure; pairing unresolved |

Method statement from the authors (S-BIAD885 `Image analysis overview`, VERIFIED): foci per nucleus from Alexa 488 inside Hoechst-detected nuclei via "an in-house developed" ImageJ routine ("standard features for noise reduction, segmentation, filtering and thresholding"); per-frame mean foci/nucleus normalised to the mean of non-targeting controls **within the same siRNA microarray**; out-of-focus images, nuclear aberrations and fields with excessive cell death removed manually. The definition of a focus is not given.

### 6.2 My baseline on BBBC039 (VERIFIED run, 2026-10-01; the only measured accuracy number in this document)

Protocol: repo `segment_nuclei` with **default** `FociParams`, raw 12-bit values, **test split only (50 images, 5,720 GT nuclei), run once, no tuning** (`probes/bbbc039_baseline.py`). Objects are connected components of the mask (touching nuclei are not split by design).

| Metric | Value |
|---|---|
| Object F1 @ IoU 0.5 / 0.6 / 0.7 / 0.8 / 0.9 (mean of per-image F1) | **0.501 / 0.212 / 0.015 / 0.000 / 0.000** |
| Objects per field vs GT nuclei per field | 67.3 vs 114.4 (merging of touching nuclei) |
| `estimate_nuclei` (area / median) per field vs GT | 94.9 vs 114.4: bias **-19.5 nuclei/field (-17 %)**, MAE 19.5 |

Interpretation and limits: the nuclear branch finds most isolated nuclei but merges clusters and its object boundaries are loose (IoU falls off quickly above 0.5). This does **not** measure foci accuracy and says nothing about the real idr0010 plates. One split, default parameters, mean of per-image F1 (not pooled). Do not tune on the test split: tune on train, choose on validation, report test once.

### 6.3 Metrics

Nuclei (BBBC039, BBBC006): object F1 at IoU 0.5, 0.6, 0.7, 0.8, 0.9 (+ average over thresholds), split/merge error counts, count error per field (MAE, signed bias, relative %), Bland-Altman of count (mean difference and 95 % limits), foreground Dice.
Foci (Zenodo, small manual set): precision/recall/F1 with a match radius of 3 px (about 1.4 um at 0.465 um/px; state the radius in advance), per-nucleus count MAE and Bland-Altman; per-nucleus exact-match rate.
GPU vs CPU: max abs/relative difference of intermediates; fraction of differing mask pixels; identical object count rate; identical foci count rate; run-to-run bit identity; per adapter.
Per-well vs authors (plate 7-14 and any other plate): Spearman and Pearson (+ bootstrap CI over wells, 2000 resamples, seed 0) of our foci/cell and nuclei vs authors' foci/cell and Cell Count, AUC for the 'increased DNA damage' wells, **under both pairings reported side by side in one table**, plus the paired difference between pairings; absolute level (median foci/cell) reported but not scored.

### 6.4 Protocol (pre-registered rules)

1. **Freeze before looking:** engine version, parameters (defaults), metrics, thresholds for "pass", and the split rule, written in `foci/docs/research/benchmark-protocol.md` and committed before any run.
2. **Splits:** BBBC039 official split (train 100 / validation 50 / test 50). For idr0010: split wells by **plate** (hash of plate name mod 10; plates with hash < 7 train, = 7 validation, >= 8 test), never by well, because plate and siRNA effects are shared within plates; plate 7-14 (already used in L2 for threshold fitting) is marked "seen" and excluded from the held-out set.
3. **What may be tuned:** `min_height`, `peak_window`, nucleus `min_nucleus_px`, and nothing else, on train only; validation picks among at most 10 pre-listed candidates; test is run **once**; every run (including failures) is logged in a results table with commit hash.
4. **Reporting:** all metrics with bootstrap 95 % CIs over images/wells; both pairings; GPU and CPU rows both shown; the authors' own foci/cell as the ceiling row.
5. **Pass thresholds are set before running** (proposals; owner to sign off): nuclei F1@0.5 >= 0.85 and count bias within +-5 % to call the nuclear branch "validated for isolated/clustered U2OS Hoechst nuclei at 20x"; foci: no claim without an independent point-annotated set; per-well: Spearman >= 0.6 under the pairing that agrees with cell counts **and** a pairing check against the curators before any biological claim.

### 6.5 What each result would and would not support

| Result | Supports | Does not support |
|---|---|---|
| Nuclei F1/count on BBBC039 test | "segmentation/counting works on widefield U2OS Hoechst of this geometry" | counting in other stains/cell types; foci counting; idr0010 fidelity |
| GPU-vs-CPU parity | "the fast path gives the same answer within tolerance on the adapters tested" | correctness (both could be wrong together) |
| Spearman with authors, one pairing | rank agreement of per-well aggregates | accuracy of single-field counts; causal biology; the other pairing |
| Same under both pairings | how much the conclusions depend on the unresolved pairing | which pairing is right |
| Foci vs Zenodo manual points | the foci logic can find manually marked foci in confocal data | performance on widefield 20x 53BP1 |
| Authors' numbers as ground truth | consistency check only (circular risk, the annotation row could be mismatched) | validation of our counter |

### 6.6 What the team can run offline in Node with the CPU engine

* **Yes (offline, after the one-time downloads):** golden-fixture parity vs Python (intermediates and labels); BBBC039 nuclei F1/count metrics on all 200 images (decode 16-bit TIFF with the vendored decoder; masks are RGBA PNG with values 0-3 in the red channel); per-stage timing on the CPU; fuzz/bomb tests of decoders; reading a well from a saved copy of the plate zip (`file://` or local `fs` Range reads) including the blosc decoder; per-well statistics vs the authors' table for any plate already downloaded (plate 7-14 if the owner still has it).
* **No (needs a browser with WebGPU):** GPU kernels and self-test, `device.lost` handling, adapter-specific parity, real network/CORS behaviour, the CSP and network-silence test (Playwright/Chromium could do these; Node cannot). Node has no WebGPU in the standard distribution (an experimental `webgpu` npm package exists; **UNVERIFIED**, not recommended as a dependency).

---

## 7. Safety model

### 7.1 Hardened page on static hosting

The host is LiteSpeed on Hostinger; `.htaccess` `Header set` works (VERIFIED: live responses carry the `.htaccess` headers; the platform also injects `Content-Security-Policy: upgrade-insecure-requests` on pages without their own CSP). The existing `analyze.html` CSP allows `connect-src https://telomore-production.up.railway.app` and Google Fonts: acceptable for the *server-upload* analyser, **not** for the local-only page. Proposed header for the new local page (`FilesMatch "^local\.html$"`, name illustrative):

```
Content-Security-Policy: default-src 'none'; script-src 'self'; worker-src 'self'; style-src 'self';
  font-src 'self'; img-src 'self' blob: data:; connect-src 'none'; base-uri 'none'; form-action 'none';
  frame-ancestors 'none'; object-src 'none'; manifest-src 'none'; media-src 'none'; frame-src 'none'
Referrer-Policy: no-referrer
Permissions-Policy: camera=(), microphone=(), geolocation=(), usb=(), serial=(), hid=(), bluetooth=(), payment=(), clipboard-read=()
Cross-Origin-Opener-Policy: same-origin
X-Content-Type-Options: nosniff
```

* `connect-src 'none'` blocks `fetch`, XHR, WebSocket, EventSource, `sendBeacon`, `<a ping>` (MDN, VERIFIED). **It does not cover WebRTC**, navigations or form posts: `form-action 'none'`, no `<form action>`, no links to external origins with query strings, and `frame-src 'none'` close the obvious holes; WebRTC data channels are a known exfiltration path for scripts but require script execution that `script-src 'self'` already limits to our vendored files (a CSP `webrtc` directive exists in drafts, **UNVERIFIED** browser support).
* `'wasm-unsafe-eval'` only if a wasm codec is shipped (VERIFIED requirement); prefer not to. WebGPU shaders (WGSL) need no `unsafe-eval`. If workers are created from `blob:` URLs add `worker-src blob:`; prefer `new Worker('engine/worker.js')` from 'self' so `worker-src 'self'` suffices.
* **Remote plate mode needs `connect-src https://ftp.ebi.ac.uk https://idr.openmicroscopy.org`.** Keep it on a **separate page** (`plate.html`) with its own CSP so the local-file page can truthfully advertise "no network at all", and so a file dropped into the local page can never meet a page that is allowed to talk to the internet. The remote page must never read local files.
* No third-party scripts, no analytics, no CDN, fonts self-hosted or system fonts (`font-src 'self'`). Subresource Integrity is not needed for same-origin vendored files but the sha256 table (section 4) is.
* Do not use `localStorage`/IndexedDB for user pixels; results may be stored only if the user asks ("Save results"), as counts/tables, not images. Clear any Cache Storage on a "Clear" button.

### 7.2 "Nothing leaves" must be testable

* CI/Playwright test (Chromium with WebGPU flag or software fallback): load the local page, drop a fixture, run analysis, assert via `page.on('request')` that **zero** requests occur after load other than the page's own static assets (ideally zero at all after first paint), and that CSP violations are not raised (`securitypolicyviolation` listener). Add a canary: inject `fetch('https://example.invalid/'+x)` from the test harness and assert it is blocked by CSP (proves the policy is live).
* Static test: grep the local page bundle for `fetch(`, `XMLHttpRequest`, `WebSocket`, `sendBeacon`, `EventSource`, `importScripts(http`, `import(`with remote URLs, `RTCPeerConnection`; allow-list empty.
* UI: show a "Network: disabled for this page (CSP)" line and a provenance block (engine mode, adapter, vendor versions with hashes). Do not claim more than the CSP enforces.

### 7.3 Guards against huge or malicious input

| Threat | Guard (numbers are proposals; `deviceMemory` is Chromium-only and capped at 8 by spec, treat as a hint) |
|---|---|
| Oversized file | Reject if `file.size` > 512 MiB (single image) / 2 GiB (zip, streamed) unless the user opts in; use `Blob.slice` to read headers first |
| Pixel bombs (PNG IHDR, TIFF dims, OME-XML) | Parse width/height/bit depth/samples **before** allocating; reject if `w*h > 100 Mpx` (default 50 Mpx; engine memory per pixel f32 x ~6 buffers = 24 B/px -> 50 Mpx = 1.2 GB, so scale the cap with `navigator.deviceMemory`) and if `w*h*bytesPerPixel*channels` exceeds the cap; reject dimensions above 65535 |
| Deflate bombs (PNG IDAT, TIFF Deflate/LZW strips, zip entries) | Stream-inflate with a hard output cap = declared uncompressed size (must equal `w*h*spp*bytes`), abort if actual output exceeds it; ratio cap (e.g. > 1000:1 after the first MiB); total decompressed cap per archive |
| Zip: entry count, nested zips, path tricks, zip64 sizes that lie | Max 10,000 entries; never extract to a filesystem (memory only, so path traversal is moot); do not recurse into nested archives; compare central-directory vs local-header sizes; ignore `__MACOSX` |
| Malformed TIFF (IFD loops, huge strip counts, offsets past EOF) | Visited-offset set for the IFD chain (max 1000 IFDs), bounds-check every offset against file size, cap tag counts, cap strips/tiles |
| Long-running / CPU denial | Decode + analysis in a dedicated Worker; per-image time budget (default 60 s) with `AbortController` signal checked between stages; UI "Cancel" terminates the worker (`worker.terminate()` is the real hard stop) |
| GPU hangs / OOM | Request only needed limits; allocate with `device.pushErrorScope('out-of-memory')`; cap per-dispatch work; handle `device.lost` (recreate once, then fall back to `reference` and mark the result's provenance); `uncapturederror` listener logs a counter |
| Memory | Plate loop releases buffers per well; `try/catch` around allocations (`RangeError`) -> friendly message; do not keep decoded planes after analysis |
| Endianness, NaN/Inf, all-zero images | Decoder returns typed arrays with a declared dtype; sanitise non-finite to 0 and report count (as `foci_upload.py` does); flat images -> "no signal range" message |
| Filename/metadata injection into the DOM | Always `textContent`, never `innerHTML`, for filenames, OME-XML strings, errors |

---

## 8. Implementation checklist per agent (testable requirements)

### ENGINE (`foci/web/engine/`)

1. ES modules only, no DOM/`window` use in `reference`; must run under `node --test` (Node 22). No imports of `fetch`/network APIs anywhere (a static test greps for them).
2. **Golden fixtures** (committed, small): generated by a documented Python script using the repo's `segment.py`: (a) 10 synthetic images (seeded), (b) 10 crops (e.g. 256x256) and 2 full fields from BBBC039 (CC0; mention licence in `fixtures/README`), (c) edge cases: all-zero, constant, single pixel, image with 1-pixel border objects, odd sizes (e.g. 255x257). For each: input `uint16`, and outputs of Gaussian (sigma 2 and 1, float32 bits), grey opening 41, top-hat 7, maximum filter 5, `flat`, threshold, nuclear label array, foci mask, counts. `reference` mode must match **exactly** (`Float32Array` bit equality via `Uint32Array` view; label arrays identical).
3. Implement exactly: reflect = half-sample symmetric (`d c b a | a b c d`); Gaussian radius `int(4.0*sigma + 0.5)`, weights from `exp(-0.5 (x/s)^2)` normalised in Float64; `Math.fround` after **each** axis pass (axis 0 first, verify order against fixtures); `grey_opening` = reflect-erode then reflect-dilate; `white_tophat(size)` = `x - opening(x)`; `binary_opening(iterations=2)` with the 4-connected cross structure and `border_value=0` (iterations mean erode twice then dilate twice); `binary_fill_holes` with 4-connectivity; `label` 4-connectivity numbered by first raster pixel; size filter `>= min_nucleus_px` renumbering in label order; `np.median` of sizes (even count = mean of the two middle); `np.rint` = round half to even; `otsu_threshold` with 256 bins, bin centres, `argmax` first maximum; `_log_otsu` = `fround(log1p(max(x,0)))`, positives only, `expm1` of the chosen centre.
4. `gpu` mode: request no more than default limits unless the image needs them; workgroup 16x16; fixed summation order; only `+ - *` and compares in kernels; no subgroup/f16 dependence; pipeline per field with ping-pong buffers; tiling with halos (48 px nuclear, 12 px foci) for images > 33 Mpx... or anything where a binding would exceed `maxStorageBufferBindingSize`; batch <= 64 fields per dispatch group; two runs on the same adapter give bit-identical output (test).
5. Boot self-test as in 2.4; `auto` falls back to `reference` on any failure, fallback adapter, `device.lost`, `uncapturederror`, or exceeded tolerance; the decision and reason go into `provenance`.
6. Parity test harness runnable in the browser (Playwright) that prints the matrix: adapter, each stage's max abs/relative error, mask mismatch fraction, count equality. Output committed as JSON per adapter run.
7. Provide `analyse()` with `AbortSignal` (checked between stages and every N rows in long CPU loops) and progress callbacks; results never contain the input pixels.
8. `scale` parameter explicit (`as-is` vs `percentile-0255`) and echoed in results. No silent normalisation.
9. Performance budget (measured, not promised): report per-stage ms for reference and gpu on the 696x520 fixture and on a 4096x3072 synthetic; target for `reference` <= 0.5 s/field in Node on a mid laptop (unoptimised baseline: Gaussian 61 ms + opening 86 ms).

### LAB (local-file page)

1. Separate `local.html` with the CSP in 7.1 (verified by the network-silence test); no Google Fonts; `<input type="file" multiple accept=...>` + drag and drop (no File System Access dependency).
2. Sniff by magic bytes, not extension: PNG `89 50 4E 47`, TIFF `II*\0`/`MM\0*` and BigTIFF `II+\0`/`MM\0+`, JPEG `FF D8 FF`, ZIP `PK\3\4`; everything else -> friendly "unsupported" message including the vendor-format export advice.
3. Enforce every guard in 7.3 (unit tests with crafted files: PNG claiming 60000x60000, TIFF with IFD loop, deflate bomb, zip with 50,000 entries, truncated file, big-endian 16-bit TIFF, tiled TIFF, LZW TIFF, TIFF with predictor 2, 12-bit-in-16, multi-page OME-TIFF with C=2). Each must either decode correctly or fail with the stated message, within the time budget, without freezing the UI thread.
4. Channel assignment UI for multi-channel files: user chooses DNA and 53BP1 channels (default from OME `Channel Name` labels such as "Dapi"/"Channel 1" only as a suggestion); show a preview; show bit depth, observed min/max, saturated fraction, and the scale used.
5. Show the engine mode and adapter; "Use GPU (faster; results within tolerance)" toggle default per self-test; results table exportable as CSV generated client-side (Blob + `download`), no upload.
6. Labels: always "unvalidated counter" + link to section 6 numbers; never show an "accuracy" figure without its dataset and date.
7. Workers: decode and engine in workers; cancel button terminates; progress per file; memory released between files.
8. Accessibility/i18n: out of scope here, but no `innerHTML` for user-derived strings.

### SCREEN (PHP endpoints + IDR plate mode)

1. Serve **only** small JSON: `plates.json` (plate name, zip URL, `size`, well layout 16x24, channel labels), cacheable (`Cache-Control: public, max-age=86400`), no per-request upstream calls. No PHP endpoint may stream zip bytes by default.
2. Plate mode page (`plate.html`) has its own CSP with `connect-src https://ftp.ebi.ac.uk https://idr.openmicroscopy.org` only; separate from the local-file page.
3. Client: HEAD for `Content-Length` (size check vs `plates.json`; refuse on mismatch), Range tail 64 KiB -> EOCD (+ zip64 locator if needed) -> central directory (expect about 1.65 MB, 15,007 entries for 7-14) -> well map; one Range request per well covering both channel chunks; inflate (method 8) then blosc-lz4 decode then big-endian uint16 -> engine. Limits: concurrency 2, back-off, AbortController, total-bytes counter shown to the user.
4. Show the pairing problem: table with image well address, by-name annotation row, column-major annotation row (`Well Number`), both authors' values side by side; label "unresolved".
5. Quota/rate rules if any proxy is ever added: allow-list, 2 MiB/request cap, token bucket 30 req/min and 100 MB/h per IP, no redirects, no cookies forwarded, log counters only; reject anything not matching `^https://(ftp\.ebi\.ac\.uk|idr\.openmicroscopy\.org)/`.
6. Tests: stub server (the repo already has PHP stub tests) must assert that no endpoint accepts a request body containing pixel data, and that the plates JSON schema is stable.
7. IDR `render_image` is an 8-bit windowed rendering: if used at all (thumbnails/preview), label it "8-bit display rendering, not raw"; do not feed it to the quantitative engine when the zarr route is available (L2: bit depth did not matter for agreement, but the rendering window is per-image and loses the raw scale).

---

## 9. Benchmark and validation protocol

(Detailed copy: `foci/docs/research/benchmark-protocol.md`.)

### 9.1 Datasets and one-time downloads (approve size before download)

| Item | Bytes | Command/URL |
|---|---|---|
| BBBC039 images | 77.9 MB | `curl -O https://data.broadinstitute.org/bbbc/BBBC039/images.zip` |
| BBBC039 masks | 2.8 MB | `.../masks.zip` |
| BBBC039 metadata (splits) | 18 KB | `.../metadata.zip` |
| idr0010 plate 7-14 (optional, already used in L2) | 475,572,589 B | `https://ftp.ebi.ac.uk/biostudies/fire/S-BIAD/885/S-BIAD885/Files/idr0010/7-14.ome.zarr.zip` |

Keep them outside the repo (`.gitignore`d data dir or temp); commit only hashes (sha256) in the protocol file.

### 9.2 Steps

1. **Golden parity (CI, Node):** regenerate fixtures with Python; run `reference`; require exact equality. Command sketch: `python scripts/make_engine_fixtures.py && node --test foci/web/engine/test/`.
2. **Nuclei benchmark (Node, CPU):** run `reference` on BBBC039 train (tune only if allowed), validation (choose), test once; output JSON with F1@0.5-0.9, count bias/MAE, per-image rows, commit hash. Reproduce my baseline first: F1@0.5 = 0.501 on test with defaults, else the harness is wrong (`python foci/docs/research/probes/bbbc039_baseline.py`).
3. **Precision benchmark (Node, CPU):** compare `reference` with a float32-accumulate emulation on the 50 test images (already done in numpy: 0 count changes); repeat for foci (not yet measured).
4. **GPU parity (browser, Playwright):** on each available adapter (integrated AMD here; ask volunteers for NVIDIA/Intel/Apple/Android), run the self-test and the BBBC039 test split in `gpu` vs `reference`; record the matrix; tolerances from 2.4 are provisional until this has real numbers from >= 3 vendors.
5. **Per-well vs authors:** for plate 7-14, run `reference` on both channels, aggregate per well, compare with the authors' table under both pairings; report Spearman/Pearson/AUC with bootstrap CIs in one table (L2 numbers to beat/compare: 0.30 default, 0.47 cross-fitted, n = 304, column-major pairing; by-name about 0.0). Plate-wise split rule as in 6.4.
6. **Timing:** Node `reference` per stage; browser `gpu` per stage with `timestamp-query` where available (this machine exposes it) and wall clock otherwise; plate of 384 wells end to end including decode (local copy) to separate network cost from compute.
7. **Safety tests:** section 7.2 and 7.3 fixtures.

### 9.3 Claims table (what may be written on the site after each step)

After step 1: "The browser engine reproduces our Python reference bit-for-bit on N test images." After step 2 passing: "Nuclei counts validated against BBBC039 manual annotations (F1, bias)". After step 4: "GPU results agree with CPU within X on adapters A, B, C." After step 5: only statements of rank agreement with the authors' table and the pairing caveat. No biological claim follows from any of these.

---

## 10. Open questions (owner or curators)

1. Which image-to-annotation pairing is right for idr0010? The S-BIAD885 text says the screen used siRNA microarrays with manual spot marking; ask the IDR team (idr-support@openmicroscopy.org) how `Well Number` was linked to array positions and whether the EBI OME-Zarr conversion preserved well addresses.
2. Is the owner willing to ask EBI whether browser-direct Range reads of the S-BIAD885 zips are acceptable, and at what rate, before plate mode is advertised?
3. Pass thresholds in 6.4 (nuclei F1 >= 0.85, bias +-5 %, Spearman >= 0.6) - confirm or replace.
4. Foci ground truth: the only open point-annotated set found is 3-D confocal (Zenodo 4067741/5549971). Is the owner willing to hand-annotate about 200 nuclei from ~10 idr0010 fields (CC BY 4.0 source images) as a small validation set? This is the only route to a true foci validation for this pipeline.
5. Should `reference` remain the default for exports even when GPU passes the self-test (recommended yes)?
6. Can COOP/COEP be set on this host without side effects (only needed if threads are ever wanted; currently not recommended)?
7. Physical pixel size: IDR `imgData` reports 1.0 while the authors/EBI say 0.465 um/px; which does the UI show for any size-based feature (none today: `min_nucleus_px` is in pixels)?
8. Linux WebGPU: MDN and caniuse disagree on default availability; decide whether to advertise GPU on Linux at all (recommend: attempt, rely on self-test).

---

## Appendix A. Sources opened

| Item | URL | Checked |
|---|---|---|
| caniuse WebGPU data | https://raw.githubusercontent.com/Fyrd/caniuse/main/features-json/webgpu.json (also webgl2, wasm-simd, sharedarraybuffer, offscreencanvas, native-filesystem-api) | 2026-09-30 |
| MDN browser-compat-data GPU | https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/GPU.json | 2026-09-30 |
| WebGPU spec limits | https://gpuweb.github.io/gpuweb/ (`#limits`) | 2026-09-30 |
| WGSL spec floating point | https://www.w3.org/TR/WGSL/ (15.7) | 2026-09-30 |
| MDN CSP connect-src, script-src | https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/connect-src (and `/script-src`) | 2026-10-01 |
| IDR API | https://idr.openmicroscopy.org/api/v0/ , `/webgateway/imgData/1922019/`, `/webgateway/render_image/1922019/0/0/`, `/about/api.html`, `/about/download.html`, `/about/` | 2026-09-30/10-01 |
| EBI zip and headers | https://ftp.ebi.ac.uk/biostudies/fire/S-BIAD/885/S-BIAD885/Files/idr0010/7-14.ome.zarr.zip ; https://ftp.ebi.ac.uk/robots.txt | 2026-09-30/10-01 |
| BioStudies S-BIAD885, S-BSST265 | https://www.ebi.ac.uk/biostudies/api/v1/studies/S-BIAD885 (and S-BSST265) | 2026-09-30 |
| BioImage Archive download help; EMBL-EBI terms | https://www.ebi.ac.uk/bioimage-archive/help-download/ ; https://www.ebi.ac.uk/about/terms-of-use/ | 2026-09-30 |
| IDR S3 zarr listing | https://uk1s3.embassy.ebi.ac.uk/idr/?prefix=zarr/v0.4/idr0010 (empty) | 2026-09-30 |
| BBBC039, BBBC006 | https://bbbc.broadinstitute.org/BBBC039 , /BBBC006 (+ data.broadinstitute.org downloads) | 2026-09-30/10-01 |
| Zenodo foci datasets | https://zenodo.org/records/4067741 , https://zenodo.org/records/5549971 (API JSON) | 2026-09-30 |
| npm registry | https://registry.npmjs.org/<pkg> for fflate, pako, @zip.js/zip.js, jszip, upng-js, pngjs, utif2, geotiff, tiff, fast-png, zarrita, jpeg-js, numcodecs, ome-zarr.js, @itk-wasm/image-io; READMEs via https://cdn.jsdelivr.net/npm/<pkg>@<ver>/README.md | 2026-09-30 |
| Local probes | `foci/docs/research/probes/*` | 2026-09-30/10-01 |

**Not opened / UNVERIFIED items:** papers on van Herk, Playne-Hawick, Allegretti (titles only from search results); ND2/LIF magic numbers; `DecompressionStream` support percentage; CSP `webrtc` directive support; `geotiff`/`tiff` behaviour on tiled, BigTIFF, big-endian, predictor files (not executed); COOP/COEP on this host; Kromp S-BSST265 licence; Zenodo archive contents; Node WebGPU packages; BioImage Archive contact address; Safari/iOS actual hardware behaviour; any adapter other than the integrated AMD GPU in this environment.
