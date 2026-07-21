(function contactsPollingModule(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.BakeryContactsPolling = api;
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
  "use strict";

  function createPollController({ poll, interval = 30_000, setTimer = setTimeout, clearTimer = clearTimeout }) {
    if (typeof poll !== "function") throw new TypeError("Contacts poll must be a function");
    let active = false;
    let visible = true;
    let timer = null;
    let inFlight = false;
    let stopped = false;

    function clearScheduled() {
      if (timer !== null) clearTimer(timer);
      timer = null;
    }

    function schedule() {
      clearScheduled();
      if (stopped || !active || !visible) return;
      timer = setTimer(run, interval);
    }

    async function run() {
      timer = null;
      if (stopped || !active || !visible || inFlight) return schedule();
      inFlight = true;
      try { await poll({ background: true }); }
      finally {
        inFlight = false;
        schedule();
      }
    }

    function update(next = {}) {
      const wasEligible = active && visible;
      if ("active" in next) active = Boolean(next.active);
      if ("visible" in next) visible = Boolean(next.visible);
      stopped = false;
      const isEligible = active && visible;
      clearScheduled();
      if (isEligible && (!wasEligible || next.refresh)) void run();
      else if (isEligible) schedule();
    }

    function stop() {
      stopped = true;
      clearScheduled();
    }

    return { update, stop, run };
  }

  return { createPollController };
});
