import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// "Your files never leave your browser" is enforced twice: by the Content-Security-Policy in lab.html
// (connect-src 'none') and by this test, which fails if the page code contains any way to talk to a network.
const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "web");
const read = (p) => fs.readFileSync(path.join(WEB, p), "utf8");
const ioFiles = fs.readdirSync(path.join(WEB, "io")).filter((f) => f.endsWith(".js")).map((f) => "io/" + f);
const JS = ["lab.js", ...ioFiles];

const FORBIDDEN = [
  [/\bfetch\s*\(/, "fetch("],
  [/\bfetch\b\s*[,;)=]/, "fetch reference"],
  [/XMLHttpRequest/, "XMLHttpRequest"],
  [/WebSocket/, "WebSocket"],
  [/sendBeacon/, "sendBeacon"],
  [/EventSource/, "EventSource"],
  [/importScripts/, "importScripts"],
  [/\bimport\s*\(/, "dynamic import("],
  [/\bimport\s+[\w{*]/, "static import"],
  [/\bnew\s+Worker\b|\bSharedWorker\b/, "Worker creation (the engine owns workers)"],
  [/serviceWorker/, "service worker"],
  [/\beval\s*\(|new\s+Function\s*\(/, "eval / Function"],
  [/document\.write/, "document.write"],
  [/\binnerHTML\b|\binsertAdjacentHTML\b|\bouterHTML\b/, "HTML string injection"],
  [/\.(src|href|action)\s*=\s*["'`]https?:/, "assigning an external URL"],
  [/https?:\/\/(?!www\.w3\.org\/2000\/svg)/, "external URL literal"],
  [/WebTransport|RTCPeerConnection|BroadcastChannel/, "other network/side channel"]
];

for (const f of JS) {
  test("no network or injection primitives in " + f, () => {
    const src = read(f);
    for (const [re, label] of FORBIDDEN) {
      const m = re.exec(src);
      assert.equal(m, null, `${f} contains ${label}: ${m && src.slice(Math.max(0, m.index - 40), m.index + 60)}`);
    }
  });
}

test("the guard itself catches what it should", () => {
  const bad = ["fetch('/x')", "new XMLHttpRequest()", "new WebSocket('wss://x')", "navigator.sendBeacon(u)", "import('./x.js')", "el.innerHTML = s", "x = 'https://evil.example/a'"];
  for (const b of bad) assert.ok(FORBIDDEN.some(([re]) => re.test(b)), b);
});

test("lab.html: Content-Security-Policy forbids connections, framing, forms and inline code", () => {
  const html = read("lab.html");
  const m = /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html);
  assert.ok(m, "CSP meta tag");
  const dirs = Object.fromEntries(m[1].split(";").map((d) => d.trim()).filter(Boolean).map((d) => { const [k, ...v] = d.split(/\s+/); return [k, v]; }));
  assert.deepEqual(dirs["connect-src"], ["'none'"]);
  assert.deepEqual(dirs["default-src"], ["'none'"]);
  assert.deepEqual(dirs["base-uri"], ["'none'"]);
  assert.deepEqual(dirs["form-action"], ["'none'"]);
  assert.deepEqual(dirs["object-src"], ["'none'"]);
  assert.deepEqual(dirs["script-src"], ["'self'"]);
  assert.deepEqual(dirs["style-src"], ["'self'", "https://fonts.googleapis.com"]);
  assert.deepEqual(dirs["font-src"], ["https://fonts.gstatic.com"]);
  assert.deepEqual(dirs["img-src"], ["'self'", "data:", "blob:"]);
  assert.deepEqual(dirs["worker-src"], ["'self'", "blob:"]);
  assert.deepEqual(dirs["frame-src"], ["'none'"]);
  assert.ok(!/unsafe-inline|unsafe-eval|\*/.test(m[1]), "no unsafe-* or wildcard sources");
  // the CSP must come before any script or stylesheet
  assert.ok(html.indexOf("Content-Security-Policy") < html.indexOf("<link") && html.indexOf("Content-Security-Policy") < html.indexOf("<script"));
});

test("lab.html: only same-origin scripts, only Google Fonts externally, no inline code or forms", () => {
  const html = read("lab.html");
  assert.ok(!/<form\b|<iframe\b|<object\b|<embed\b|<base\b/i.test(html));
  assert.ok(!/\son[a-z]+\s*=/i.test(html.replace(/<meta[^>]*>/g, "")), "no inline event handlers");
  assert.ok(!/<[^>]+\sstyle\s*=/i.test(html), "no style attributes (blocked by the CSP)");
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  assert.ok(scripts.length >= 7);
  for (const [, attrs, body] of scripts) {
    const src = /src="([^"]+)"/.exec(attrs);
    assert.ok(src && !/^(https?:)?\/\//.test(src[1]), "script must be same-origin: " + attrs);
    assert.equal(body.trim(), "", "no inline script bodies");
    assert.ok(src[1] === "engine/engine.js" || fs.existsSync(path.join(WEB, src[1])), src[1] + " exists");
  }
  for (const [, href] of html.matchAll(/<link\b[^>]*href="([^"]+)"/gi)) {
    assert.ok(!/^https?:/.test(href) || /^https:\/\/fonts\.googleapis\.com\//.test(href), "external link: " + href);
  }
  assert.ok(!/<img\b[^>]*src="https?:/i.test(html));
  assert.ok(html.indexOf('src="engine/engine.js"') < html.indexOf('src="lab.js"'), "engine loads before lab.js");
});

test("every non-font external reference in lab.html is a plain hyperlink", () => {
  const html = read("lab.html");
  for (const m of html.matchAll(/https?:\/\/[^\s"'<>)]+/g)) {
    const before = html.slice(Math.max(0, m.index - 60), m.index);
    assert.ok(/href="$/.test(before) || /fonts\.(googleapis|gstatic)\.com/.test(m[0]) || /content="/.test(before), "unexpected URL use: " + before + m[0]);
  }
});

test("site navigation links to the Browser lab and IDR plate mode", () => {
  for (const f of ["index.html", "analyze.html", "lab.html"]) {
    const html = read(f);
    assert.match(html, /<a href="lab\.html"[^>]*>Browser lab<\/a>/, f);
    assert.match(html, /<a href="screen\.html"[^>]*>IDR plate mode<\/a>/, f);
  }
});

test("lab.js only reaches the engine through window.FociEngine", () => {
  const src = read("lab.js");
  assert.match(src, /window\.FociEngine/);
  assert.ok(!/localStorage\.setItem\([^)]*(sha|file|name)/i.test(src), "no file info in localStorage");
  const uses = [...src.matchAll(/localStorage\.(get|set)Item\(\s*"([^"]+)"/g)].map((m) => m[2]);
  assert.deepEqual([...new Set(uses)], ["foci-theme"]);
});
