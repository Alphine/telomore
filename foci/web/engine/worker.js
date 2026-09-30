/* Foci Lab engine worker: runs FociEngine.analyze() off the main thread.
 * Loaded by FociEngine.createPool(). Same-origin importScripts only; no network access. */
'use strict';
importScripts('engine.js');

self.onmessage = function (ev) {
  var m = ev.data || {};
  if (m.type !== 'analyze') return;
  self.FociEngine.analyze(m.input, m.opts).then(function (res) {
    var transfer = [];
    if (res.overlay && res.overlay.data && res.overlay.data.buffer) transfer.push(res.overlay.data.buffer);
    self.postMessage({ id: m.id, ok: true, result: res }, transfer);
  }, function (e) {
    self.postMessage({ id: m.id, ok: false, error: { code: e && e.code || 'internal', message: String(e && e.message || e) } });
  });
};
self.postMessage({ type: 'ready' });
