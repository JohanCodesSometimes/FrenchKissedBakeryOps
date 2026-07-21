const test = require("node:test");
const assert = require("node:assert/strict");

const { createController } = require("../system-status");

function trackedTimers() {
  const active = new Set();
  return {
    active,
    setTimer(callback, delay) {
      const timer = setTimeout(() => {
        active.delete(timer);
        callback();
      }, delay);
      active.add(timer);
      return timer;
    },
    clearTimer(timer) {
      active.delete(timer);
      clearTimeout(timer);
    },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("a never-resolving status request times out without disabling normal controls", async () => {
  const timers = trackedTimers();
  const normalControls = [{ disabled: false }, { disabled: false }, { disabled: false }];
  const results = [];
  let aborted = false;
  const controller = createController({
    timeoutMs: 20,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    checks: {
      health: ({ signal }) => new Promise(() => {
        signal?.addEventListener("abort", () => { aborted = true; }, { once: true });
      }),
    },
    onResult: (name, result) => results.push({ name, ...result }),
  });

  const pending = controller.run(["health"]);
  assert.deepEqual(normalControls.map((control) => control.disabled), [false, false, false]);
  assert.equal(controller.isRunning("health"), true);
  await pending;

  assert.equal(results[0].name, "health");
  assert.equal(results[0].status, "rejected");
  assert.equal(results[0].reason, "timeout");
  assert.equal(aborted, true);
  assert.equal(controller.isRunning(), false);
  assert.equal(timers.active.size, 0);
  assert.deepEqual(normalControls.map((control) => control.disabled), [false, false, false]);
});

test("successful status rows render before a separate slow or failed row", async () => {
  const slowSquare = deferred();
  const updates = [];
  const controller = createController({
    timeoutMs: 100,
    checks: {
      health: async () => ({ database: { ready: true } }),
      square: () => slowSquare.promise,
      owner: async () => { throw new Error("owner unavailable"); },
    },
    onResult: (name, result) => updates.push({ name, status: result.status }),
  });

  const pending = controller.run();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(updates, [
    { name: "health", status: "fulfilled" },
    { name: "owner", status: "rejected" },
  ]);

  slowSquare.resolve({ connected: true });
  await pending;
  assert.deepEqual(updates[2], { name: "square", status: "fulfilled" });
});

test("repeated retries reuse one request and leave no duplicate timeout timers", async () => {
  const timers = trackedTimers();
  const retryRequest = deferred();
  let calls = 0;
  const controller = createController({
    timeoutMs: 100,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    checks: {
      square: async () => {
        calls += 1;
        if (calls === 1) throw new Error("temporary failure");
        return retryRequest.promise;
      },
    },
  });

  await controller.run(["square"]);
  const firstRetry = controller.runCheck("square");
  const repeatedRetry = controller.runCheck("square");
  assert.equal(firstRetry, repeatedRetry);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 2);
  assert.equal(timers.active.size, 1);

  retryRequest.resolve({ connected: true });
  const result = await firstRetry;
  assert.equal(result.status, "fulfilled");
  assert.equal(calls, 2);
  assert.equal(timers.active.size, 0);
});

test("stopping pending checks aborts requests and clears their timers", async () => {
  const timers = trackedTimers();
  let aborted = false;
  const controller = createController({
    timeoutMs: 1_000,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    checks: {
      database: ({ signal }) => new Promise(() => {
        signal?.addEventListener("abort", () => { aborted = true; }, { once: true });
      }),
    },
  });

  const pending = controller.run(["database"]);
  await new Promise((resolve) => setImmediate(resolve));
  controller.stop();
  await pending;
  assert.equal(aborted, true);
  assert.equal(controller.isRunning(), false);
  assert.equal(timers.active.size, 0);
});
