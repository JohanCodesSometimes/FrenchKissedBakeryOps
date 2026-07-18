(function exposeLiveSales(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.BakeryLiveSales = api;
}(typeof globalThis !== "undefined" ? globalThis : this, () => {
  function mergeSales(currentSales = [], updatedSales = []) {
    const byId = new Map(currentSales.map((sale) => [sale.id, sale]));
    let changed = false;
    for (const sale of updatedSales) {
      const existing = byId.get(sale.id);
      if (!existing || fingerprint(existing) !== fingerprint(sale)) changed = true;
      byId.set(sale.id, sale);
    }
    return {
      changed,
      sales: [...byId.values()].sort((left, right) => saleTime(right).localeCompare(saleTime(left))),
    };
  }

  function fingerprint(sale) {
    return JSON.stringify([
      sale.id,
      sale.date,
      sale.product,
      sale.quantitySold,
      sale.saleAmount,
      sale.grossAmount,
      sale.refundedAmount,
      sale.status,
      sale.tax,
      sale.discount,
      sale.soldAt,
      sale.source,
      sale.squarePaymentId,
      sale.squareOrderId,
      sale.createdAt,
      sale.updatedAt,
      sale.lifecycleUpdatedAt,
    ]);
  }

  function saleTime(sale) {
    return String(sale.soldAt || sale.updatedAt || sale.createdAt || sale.date || "");
  }

  function boundedBackoffDelay(failureCount, {
    baseDelay = 12_000,
    maxDelay = 60_000,
    jitterRatio = 0.2,
    random = Math.random,
  } = {}) {
    const exponent = Math.max(0, Number(failureCount || 1) - 1);
    const exponential = Math.min(maxDelay, baseDelay * 2 ** exponent);
    const jitter = exponential * Math.max(0, jitterRatio) * Math.max(0, Math.min(1, random()));
    return Math.min(maxDelay, Math.round(exponential + jitter));
  }

  function createPollController({
    poll,
    onStatus = () => {},
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    random = Math.random,
    baseDelay = 12_000,
    maxDelay = 60_000,
    offlineThreshold = 3,
  }) {
    if (typeof poll !== "function") throw new TypeError("poll must be a function");
    let timer = null;
    let currentPoll = null;
    let stopped = true;
    let failures = 0;

    function clearScheduledPoll() {
      if (timer === null) return;
      clearTimer(timer);
      timer = null;
    }

    function schedule(delay) {
      if (stopped) return;
      clearScheduledPoll();
      timer = setTimer(() => {
        timer = null;
        void run();
      }, delay);
    }

    function run() {
      if (stopped) return Promise.resolve(false);
      if (currentPoll) return currentPoll;
      currentPoll = (async () => {
        try {
          await poll();
          failures = 0;
          onStatus({ state: "live", failures, nextDelay: baseDelay });
          schedule(baseDelay);
          return true;
        } catch (error) {
          failures += 1;
          const nextDelay = boundedBackoffDelay(failures, { baseDelay, maxDelay, random });
          onStatus({
            state: failures >= offlineThreshold ? "offline" : "reconnecting",
            failures,
            nextDelay,
            error,
          });
          schedule(nextDelay);
          return false;
        } finally {
          currentPoll = null;
        }
      })();
      return currentPoll;
    }

    function start({ immediate = false } = {}) {
      stopped = false;
      if (timer !== null || currentPoll) return currentPoll || Promise.resolve(false);
      if (immediate) return run();
      schedule(baseDelay);
      return Promise.resolve(true);
    }

    function stop() {
      stopped = true;
      clearScheduledPoll();
    }

    function retry() {
      stopped = false;
      clearScheduledPoll();
      onStatus({ state: "reconnecting", failures, nextDelay: 0 });
      return run();
    }

    function state() {
      return { failures, inFlight: Boolean(currentPoll), scheduled: timer !== null, stopped };
    }

    return { retry, run, start, state, stop };
  }

  return { boundedBackoffDelay, createPollController, mergeSales };
}));
