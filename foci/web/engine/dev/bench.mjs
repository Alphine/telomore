// CPU reference benchmark:  node foci/web/engine/dev/bench.mjs [runs]
// Uses the committed IDR fixtures (696x520 field; tiled to ~4.3 Mpx). Not part of the test suite.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const Engine = require("../engine.js");
const { decodePng } = require("./pngdecode.js");
const gold = path.join(here, "..", "..", "..", "tests", "fixtures", "engine_golden");
const runs = Number(process.argv[2] || 5);

const man = JSON.parse(fs.readFileSync(path.join(gold, "manifest.json"), "utf8"));
const c = man.cases.find((x) => x.id.startsWith("idr_") && !x.id.endsWith("_crop"));
const dna = await decodePng(fs.readFileSync(path.join(gold, c.files.dna)));
const foci = await decodePng(fs.readFileSync(path.join(gold, c.files.foci)));

function tile(src, nx, ny) {
  const W = src.width * nx, H = src.height * ny, out = new Uint8Array(W * H);
  for (let ty = 0; ty < ny; ty++) for (let y = 0; y < src.height; y++) {
    const row = src.data.subarray(y * src.width, (y + 1) * src.width);
    for (let tx = 0; tx < nx; tx++) out.set(row, (ty * src.height + y) * W + tx * src.width);
  }
  return { data: out, width: W, height: H, bitDepth: 8 };
}

function median(a) { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; }

async function bench(label, d, f, overlay) {
  const times = [];
  let last;
  await Engine.analyze({ dna: { ...d, data: d.data.slice() }, foci: { ...f, data: f.data.slice() } }, { mode: "reference" }); // warm-up (JIT)
  for (let i = 0; i < runs; i++) {
    last = await Engine.analyze({ dna: { ...d, data: d.data.slice() }, foci: { ...f, data: f.data.slice() } }, { mode: "reference", overlay });
    times.push(last.timing_ms.total);
  }
  const t = last.timing_ms;
  const parts = Object.entries(t).filter(([k]) => k !== "total").map(([k, v]) => `${k} ${v.toFixed(0)}`).join(", ");
  console.log(`${label}: ${d.width}x${d.height} (${(d.width * d.height / 1e6).toFixed(2)} Mpx)${overlay ? " +overlay" : ""}  median ${median(times).toFixed(0)} ms  min ${Math.min(...times).toFixed(0)}  max ${Math.max(...times).toFixed(0)}  [${runs} runs]  nuclei ${last.nuclei.count} foci ${last.foci.count}`);
  console.log(`   last run stages (ms): ${parts}`);
}

console.log(`node ${process.version}, ${os.cpus()[0].model.trim()}, ${os.cpus().length} threads, ${os.platform()} ${os.arch()}`);
await bench("field", dna, foci, false);
await bench("field", dna, foci, true);
const big = [tile(dna, 4, 3), tile(foci, 4, 3)];
await bench("tiled", big[0], big[1], false);
await bench("tiled", big[0], big[1], true);
