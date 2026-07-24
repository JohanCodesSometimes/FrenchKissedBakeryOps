(function exposeLiveSales(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.BakeryLiveSales = api;
}(typeof globalThis !== "undefined" ? globalThis : this, () => {
  function mergeSales(currentSales = [], updatedSales = []) {
    const byId = new Map(currentSales.filter(hasStableId).map((sale) => [sale.id, sale]));
    let changed = false;
    for (const sale of updatedSales) {
      if (!hasStableId(sale)) continue;
      const existing = byId.get(sale.id);
      if (!existing || fingerprint(existing) !== fingerprint(sale)) changed = true;
      byId.set(sale.id, sale);
    }
    return {
      changed,
      sales: [...byId.values()].sort((left, right) => saleTime(right).localeCompare(saleTime(left))),
    };
  }

  function hasStableId(sale) {
    return Boolean(sale && typeof sale.id === "string" && sale.id.trim());
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

  function applySalesUpdate(currentState, update = {}, { now = new Date() } = {}) {
    if (!currentState || !Array.isArray(currentState.sales)) {
      throw new TypeError("Current dashboard state with sales is required");
    }
    const merged = mergeSales(currentState.sales, Array.isArray(update.sales) ? update.sales : []);
    const state = recalculateSalesState(currentState, merged.sales, {
      now,
      updatedAt: update.cursor || currentState.updatedAt,
    });
    for (const key of ["inventory", "ownerStatus"]) {
      if (update[key] !== undefined) state[key] = update[key];
    }
    return {
      changed: merged.changed || hasChangedSalesMetadata(currentState, state),
      sales: merged.sales,
      state,
    };
  }

  function recalculateSalesState(currentState, sales, { now = new Date(), updatedAt = currentState.updatedAt } = {}) {
    const revenueSales = sales.filter(isRevenueSale);
    const todayKey = localDateKey(now);
    const monthKey = todayKey.slice(0, 7);
    const weekStart = new Date(now);
    weekStart.setHours(0, 0, 0, 0);
    weekStart.setDate(now.getDate() - now.getDay());
    const totalRevenue = sum(revenueSales, "saleAmount");
    const totalTransactions = revenueSales.length;
    const todaySales = sum(revenueSales.filter((sale) => sale.date === todayKey), "saleAmount");
    const weekSales = sum(
      revenueSales.filter((sale) => dateFromKey(sale.date) >= weekStart),
      "saleAmount",
    );
    const monthSales = sum(
      revenueSales.filter((sale) => String(sale.date || "").startsWith(monthKey)),
      "saleAmount",
    );
    const expensesThisMonth = Number(currentState.financials?.expensesThisMonth || 0);
    return {
      ...currentState,
      sales,
      salesSummary: {
        todaySales,
        weekSales,
        monthSales,
        averageTicket: totalTransactions ? round(totalRevenue / totalTransactions) : 0,
        totalTransactions,
      },
      financials: {
        ...(currentState.financials || {}),
        revenueToday: todaySales,
        revenueThisWeek: weekSales,
        revenueThisMonth: monthSales,
        estimatedProfit: round(monthSales - expensesThisMonth),
      },
      counts: {
        ...(currentState.counts || {}),
        sales: sales.length,
      },
      productPerformance: buildProductPerformance(sales),
      updatedAt,
    };
  }

  function buildProductPerformance(sales) {
    const totals = new Map();
    for (const sale of sales) {
      if (!isRevenueSale(sale)) continue;
      const current = totals.get(sale.product) || { product: sale.product, quantitySold: 0, revenue: 0 };
      current.quantitySold = round(current.quantitySold + effectiveQuantity(sale));
      current.revenue = round(current.revenue + Number(sale.saleAmount || 0));
      totals.set(sale.product, current);
    }
    return [...totals.values()].sort((left, right) => right.revenue - left.revenue);
  }

  function buildDailyRevenue(sales, now = new Date(), daysToShow = 7) {
    const days = [];
    for (let index = Math.max(1, daysToShow) - 1; index >= 0; index -= 1) {
      const date = new Date(now);
      date.setDate(date.getDate() - index);
      days.push({
        key: localDateKey(date),
        label: date.toLocaleDateString(undefined, { weekday: "short" }),
        total: 0,
      });
    }
    for (const sale of sales) {
      if (!isRevenueSale(sale)) continue;
      const day = days.find((item) => item.key === sale.date);
      if (day) day.total = round(day.total + Number(sale.saleAmount || 0));
    }
    return days;
  }

  function createSalesStateCoordinator({
    getState,
    setState,
    render = () => {},
    now = () => new Date(),
  }) {
    if (typeof getState !== "function" || typeof setState !== "function") {
      throw new TypeError("getState and setState must be functions");
    }
    let nextRequestId = 0;
    let latestCommittedRequestId = 0;

    function beginRequest() {
      nextRequestId += 1;
      return nextRequestId;
    }

    function commit({ requestId, update, authoritative = false, forceRender = false }) {
      if (!Number.isInteger(requestId) || requestId <= 0) throw new TypeError("A valid request ID is required");
      if (requestId < latestCommittedRequestId) {
        return { applied: false, changed: false, stale: true, requestId };
      }
      const previous = getState();
      const result = authoritative
        ? {
          changed: true,
          state: recalculateSalesState(update, update.sales || [], {
            now: now(),
            updatedAt: update.updatedAt,
          }),
        }
        : applySalesUpdate(previous, update, { now: now() });
      setState(result.state);
      try {
        if (result.changed || forceRender || authoritative) {
          render({ state: result.state, update, authoritative });
        }
      } catch (error) {
        setState(previous);
        throw error;
      }
      latestCommittedRequestId = requestId;
      return { applied: true, changed: result.changed, stale: false, requestId, state: result.state };
    }

    function supersede(requestId) {
      if (!Number.isInteger(requestId) || requestId <= 0) throw new TypeError("A valid request ID is required");
      latestCommittedRequestId = Math.max(latestCommittedRequestId, requestId);
    }

    function state() {
      return { latestCommittedRequestId, nextRequestId };
    }

    return { beginRequest, commit, state, supersede };
  }

  function isRevenueSale(sale) {
    return ["completed", "partially_refunded"].includes(String(sale?.status || "completed").toLowerCase());
  }

  function effectiveQuantity(sale) {
    if (!isRevenueSale(sale)) return 0;
    const quantity = Number(sale.quantitySold || 0);
    const gross = Number(sale.grossAmount ?? sale.saleAmount ?? 0);
    if (String(sale.status || "completed").toLowerCase() !== "partially_refunded" || !(gross > 0)) {
      return quantity;
    }
    return round(quantity * Math.max(0, Math.min(1, Number(sale.saleAmount || 0) / gross)));
  }

  function hasChangedSalesMetadata(previous, next) {
    return JSON.stringify([
      previous.salesSummary,
      previous.financials,
      previous.counts?.sales,
      previous.productPerformance,
    ]) !== JSON.stringify([
      next.salesSummary,
      next.financials,
      next.counts?.sales,
      next.productPerformance,
    ]);
  }

  function localDateKey(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function dateFromKey(key) {
    return new Date(`${key}T00:00:00`);
  }

  function sum(items, key) {
    return round(items.reduce((total, item) => total + Number(item[key] || 0), 0));
  }

  function round(value) {
    return Math.round(Number(value) * 100) / 100;
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

  return {
    applySalesUpdate,
    boundedBackoffDelay,
    buildDailyRevenue,
    buildProductPerformance,
    createPollController,
    createSalesStateCoordinator,
    mergeSales,
    recalculateSalesState,
  };
}));
