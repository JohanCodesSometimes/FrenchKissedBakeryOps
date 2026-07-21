(function systemStatusModule(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.BakerySystemStatus = api;
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
  "use strict";

  function createController({
    checks,
    timeoutMs = 4_000,
    onStart = () => {},
    onResult = () => {},
    onStateChange = () => {},
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    AbortControllerClass = typeof AbortController === "function" ? AbortController : null,
  }) {
    if (!checks || typeof checks !== "object") throw new TypeError("System status checks are required");
    const checkNames = Object.keys(checks);
    const running = new Map();

    function state() {
      return { running: [...running.keys()] };
    }

    function notifyState() {
      onStateChange(state());
    }

    function runCheck(name) {
      if (!checkNames.includes(name)) throw new TypeError(`Unknown system status check: ${name}`);
      if (running.has(name)) return running.get(name).task;

      const abortController = AbortControllerClass ? new AbortControllerClass() : null;
      let timeoutTimer = null;
      let cancelRequest = null;
      onStart(name);

      const timeout = new Promise((resolve, reject) => {
        timeoutTimer = setTimer(() => {
          const error = new Error(`System status check timed out after ${timeoutMs}ms`);
          error.code = "STATUS_TIMEOUT";
          reject(error);
          abortController?.abort();
        }, timeoutMs);
      });
      const cancelled = new Promise((resolve, reject) => {
        cancelRequest = () => {
          const error = new Error("System status check was cancelled");
          error.code = "STATUS_CANCELLED";
          reject(error);
        };
      });
      const request = Promise.resolve().then(() => checks[name]({ signal: abortController?.signal }));
      const task = Promise.race([request, timeout, cancelled])
        .then(
          (value) => {
            const result = { status: "fulfilled", value };
            onResult(name, result);
            return result;
          },
          (error) => {
            const result = {
              status: "rejected",
              reason: error?.code === "STATUS_TIMEOUT" ? "timeout" : "error",
              error,
            };
            onResult(name, result);
            return result;
          },
        )
        .finally(() => {
          if (timeoutTimer !== null) clearTimer(timeoutTimer);
          if (running.get(name)?.task === task) running.delete(name);
          notifyState();
        });

      running.set(name, { task, abortController, cancelRequest });
      notifyState();
      return task;
    }

    function run(names = checkNames) {
      const selected = [...new Set(names)].filter((name) => checkNames.includes(name));
      return Promise.allSettled(selected.map(runCheck));
    }

    function stop() {
      for (const entry of running.values()) {
        entry.cancelRequest();
        entry.abortController?.abort();
      }
    }

    return {
      isRunning: (name) => name ? running.has(name) : running.size > 0,
      run,
      runCheck,
      state,
      stop,
    };
  }

  return { createController };
});
