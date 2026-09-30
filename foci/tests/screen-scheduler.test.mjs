import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const S = require("../web/screen-core.js");

// ---- a virtual clock: sleep() never really waits; advance() fires timers in order ----
function makeClock() {
  let t = 1_000_000; const timers = [];
  const tick = () => new Promise((r) => setImmediate(r));
  const clock = {
    now: () => t,
    sleep(ms, signal) {
      return new Promise((resolve) => {
        if (signal && signal.aborted) return resolve();
        const e = { at: t + Math.max(0, ms), resolve };
        timers.push(e);
        if (signal) signal.addEventListener("abort", () => { const i = timers.indexOf(e); if (i >= 0) { timers.splice(i, 1); resolve(); } }, { once: true });
      });
    },
    async settle(p, limitMs = 10 * 3600 * 1000) {     // run the virtual clock until promise p settles
      let done = false, val, err; p.then((v) => { done = true; val = v; }, (e) => { done = true; err = e; });
      const start = t;
      for (let guard = 0; guard < 100000; guard++) {
        for (let i = 0; i < 5; i++) await tick();
        if (done) { if (err) throw err; return val; }
        if (!timers.length) continue;
        timers.sort((a, b) => a.at - b.at);
        const e = timers.shift(); t = Math.max(t, e.at); e.resolve();
        if (t - start > limitMs) throw new Error("virtual time limit");
      }
      throw new Error("did not settle");
    },
    tick,
    pending: () => timers.length,
  };
  return clock;
}
const mk = (n, run) => Array.from({ length: n }, (_, i) => ({ id: "t" + i, run: (ctx) => run(i, ctx) }));
const err = (status, extra) => Object.assign(new Error("http " + status), { status }, extra);

test("never more than 3 in flight, even if asked for more", async () => {
  const clock = makeClock(); let live = 0, peak = 0;
  const tasks = mk(20, async () => { live++; peak = Math.max(peak, live); await clock.sleep(100); live--; });
  const s = S.createScheduler({ concurrency: 10, tasks, sleep: clock.sleep, now: clock.now });
  const r = await clock.settle(s.start());
  assert.equal(r.status, "done"); assert.equal(r.done, 20); assert.equal(peak, 3);
});

test("429 with Retry-After stops ALL workers for that long, then the task is retried and succeeds", async () => {
  const clock = makeClock(), starts = []; let first = true; const events = [];
  const tasks = mk(6, async (i) => {
    starts.push([i, clock.now()]);
    if (i === 0 && first) { first = false; throw err(429, { retryAfter: 7 }); }
    await clock.sleep(50);
  });
  const s = S.createScheduler({ concurrency: 3, tasks, sleep: clock.sleep, now: clock.now, onEvent: (e) => events.push(e) });
  const t0 = clock.now();
  const r = await clock.settle(s.start());
  assert.equal(r.status, "done"); assert.equal(r.done, 6); assert.equal(r.failed, 0);
  const th = events.find((e) => e.type === "throttled");
  assert.equal(th.waitMs, 7000); assert.equal(th.status, 429);
  const afterBlock = starts.filter(([, at]) => at > t0).map(([, at]) => at);
  assert.ok(afterBlock.every((at) => at >= t0 + 7000), "no task started during the Retry-After window");
  assert.equal(starts.filter(([i]) => i === 0).length, 2);          // retried exactly once
});

test("Retry-After is clamped to [1 s, maxRetryAfterMs]; a missing header backs off exponentially", async () => {
  const clock = makeClock(), events = []; let n = 0;
  const tasks = mk(1, async () => { n++; if (n === 1) throw err(503, { retryAfter: 0 }); if (n === 2) throw err(503, { retryAfter: 99999 }); if (n === 3) throw err(503); if (n === 4) throw err(429); });
  const s = S.createScheduler({ concurrency: 1, tasks, sleep: clock.sleep, now: clock.now, maxRetryAfterMs: 60000, onEvent: (e) => events.push(e) });
  await clock.settle(s.start());
  const waits = events.filter((e) => e.type === "throttled").map((e) => e.waitMs);
  assert.deepEqual(waits, [1000, 60000, 20000, 40000]);             // 0 -> 1 s; huge -> cap; no header -> 5 s * 2^(streak-1), streak 3 and 4
});

test("a server that keeps refusing ends the run as 'busy' (never retries forever); pending work is kept and resumable", async () => {
  const clock = makeClock(); let calls = 0, refuse = true;
  const tasks = mk(5, async () => { calls++; if (refuse) throw err(503, { retryAfter: 2 }); });
  const s = S.createScheduler({ concurrency: 3, tasks, sleep: clock.sleep, now: clock.now, maxThrottleStreak: 5 });
  const r = await clock.settle(s.start());
  assert.equal(r.status, "busy"); assert.equal(r.done, 0); assert.equal(r.pending, 5); assert.ok(calls <= 7, "bounded attempts: " + calls);
  refuse = false;
  const r2 = await clock.settle(s.start());
  assert.equal(r2.status, "done"); assert.equal(r2.done, 5);
});

test("network/5xx errors: exponential backoff, at most maxAttempts, the rest of the plate goes on", async () => {
  const clock = makeClock(), events = []; const attemptsOf = {};
  const tasks = mk(4, async (i, ctx) => { attemptsOf[i] = ctx.attempt; if (i === 1) throw err(500); if (i === 2 && ctx.attempt < 3) throw new TypeError("network down"); });
  const s = S.createScheduler({ concurrency: 1, tasks, sleep: clock.sleep, now: clock.now, random: () => 0.5, baseBackoffMs: 1000, maxAttempts: 4, onEvent: (e) => events.push(e) });
  const r = await clock.settle(s.start());
  assert.equal(r.status, "done"); assert.equal(r.done, 3); assert.equal(r.failed, 1);
  assert.equal(attemptsOf[1], 4); assert.equal(attemptsOf[2], 3);
  assert.deepEqual(events.filter((e) => e.type === "retry" && e.id === "t1").map((e) => e.waitMs), [1000, 2000, 4000]);
  assert.equal(s.failedTasks()[0][0], "t1");
  s.requeueFailed();                                                // the user presses "retry failed": fresh attempts, still bounded
  const r2 = await clock.settle(s.start());
  assert.equal(r2.failed, 1); assert.equal(attemptsOf[1], 4);
});

test("4xx other than 429 and errors marked fatal fail at once, without retry", async () => {
  const clock = makeClock(); const calls = {};
  const tasks = mk(3, async (i) => { calls[i] = (calls[i] || 0) + 1; if (i === 0) throw err(404); if (i === 1) throw Object.assign(new Error("bad image"), { fatal: true }); });
  const s = S.createScheduler({ concurrency: 2, tasks, sleep: clock.sleep, now: clock.now });
  const r = await clock.settle(s.start());
  assert.deepEqual([r.done, r.failed, calls[0], calls[1]], [1, 2, 1, 1]);
});

test("pause lets running tasks finish and keeps the rest; start() resumes", async () => {
  const clock = makeClock(); const ran = []; let s;
  const tasks = mk(10, async (i) => { ran.push(i); if (i === 1) s.pause(); await clock.sleep(1000); });
  s = S.createScheduler({ concurrency: 2, tasks, sleep: clock.sleep, now: clock.now });
  const r = await clock.settle(s.start());
  assert.equal(r.status, "paused"); assert.ok(r.done >= 2 && r.done < 10); assert.equal(r.done + r.pending, 10);
  const before = ran.length;
  await clock.tick(); assert.equal(ran.length, before, "nothing starts while paused");
  const r2 = await clock.settle(s.start());
  assert.equal(r2.status, "done"); assert.equal(r2.done, 10);
  assert.equal(new Set(ran).size, 10);                                // no task ran twice
});

test("pause during a long Retry-After wait returns promptly", async () => {
  const clock = makeClock(); let n = 0, s;
  const tasks = mk(3, async () => { n++; if (n === 1) throw err(429, { retryAfter: 100 }); });
  s = S.createScheduler({ concurrency: 1, tasks, sleep: clock.sleep, now: clock.now });
  const p = s.start();
  for (let i = 0; i < 10; i++) await clock.tick();
  const t0 = clock.now(); s.pause();
  const r = await clock.settle(p);
  assert.equal(r.status, "paused"); assert.ok(clock.now() - t0 < 1000);
});

test("cancel aborts running tasks (their signal fires), nothing is lost, and the run can be resumed", async () => {
  const clock = makeClock(); let aborted = 0; let s; let hold = true;
  const tasks = mk(5, (i, ctx) => new Promise((resolve, reject) => {
    if (!hold) return resolve();
    ctx.signal.addEventListener("abort", () => { aborted++; reject(Object.assign(new Error("aborted"), { name: "AbortError" })); }, { once: true });
  }));
  s = S.createScheduler({ concurrency: 3, tasks, sleep: clock.sleep, now: clock.now });
  const p = s.start(); await clock.tick(); await clock.tick();
  s.cancel();
  const r = await clock.settle(p);
  assert.equal(r.status, "cancelled"); assert.equal(aborted, 3); assert.equal(r.done, 0); assert.equal(r.failed, 0); assert.equal(r.pending, 5);
  hold = false;
  const r2 = await clock.settle(s.start());
  assert.equal(r2.status, "done"); assert.equal(r2.done, 5);
});

test("minimum gap between task starts is honoured across workers", async () => {
  const clock = makeClock(), starts = [];
  const tasks = mk(6, async () => { starts.push(clock.now()); await clock.sleep(5); });
  const s = S.createScheduler({ concurrency: 3, tasks, sleep: clock.sleep, now: clock.now, minGapMs: 200 });
  await clock.settle(s.start());
  starts.sort((a, b) => a - b);
  for (let i = 1; i < starts.length; i++) assert.ok(starts[i] - starts[i - 1] >= 200, `${starts[i] - starts[i - 1]}`);
});

test("start() twice does not double-run; empty task list is done; a throwing observer cannot break the run", async () => {
  const clock = makeClock(); let runs = 0;
  const s = S.createScheduler({ concurrency: 3, tasks: mk(3, async () => { runs++; await clock.sleep(10); }), sleep: clock.sleep, now: clock.now, onEvent() { throw new Error("observer bug"); } });
  const p = s.start(); const q = await s.start();
  assert.equal(q.status, "already-running");
  assert.equal((await clock.settle(p)).status, "done"); assert.equal(runs, 3);
  assert.equal((await S.createScheduler({ tasks: [] }).start()).status, "done");
});
