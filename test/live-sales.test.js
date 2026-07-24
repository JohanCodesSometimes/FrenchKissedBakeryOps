const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  boundedBackoffDelay,
  buildDailyRevenue,
  createPollController,
  createSalesStateCoordinator,
  mergeSales,
  runRenderers,
} = require("../live-sales");
const { createStorage } = require("../storage");

test("live sales merge adds updates and prevents duplicate rows", () => {
  const original = [{ id: "sale-1", product: "Bread", saleAmount: 8, createdAt: "2026-06-27T10:00:00Z" }];
  const newSale = { id: "sale-2", product: "Cookie", saleAmount: 4, createdAt: "2026-06-27T10:01:00Z" };
  const first = mergeSales(original, [original[0], newSale]);
  assert.equal(first.changed, true);
  assert.deepEqual(first.sales.map((sale) => sale.id), ["sale-2", "sale-1"]);

  const duplicate = mergeSales(first.sales, [newSale]);
  assert.equal(duplicate.changed, false);
  assert.equal(duplicate.sales.length, 2);

  const corrected = mergeSales(first.sales, [{ ...newSale, saleAmount: 5, updatedAt: "2026-06-27T10:02:00Z" }]);
  assert.equal(corrected.changed, true);
  assert.equal(corrected.sales.find((sale) => sale.id === "sale-2").saleAmount, 5);

  const delimiterValue = { ...newSale, squarePaymentId: "payment|order", squareOrderId: "one" };
  const delimiterUpdate = { ...newSale, squarePaymentId: "payment", squareOrderId: "order|one" };
  assert.equal(mergeSales([delimiterValue], [delimiterUpdate]).changed, true);
});

test("sales polling uses bounded exponential backoff with jitter", () => {
  assert.equal(boundedBackoffDelay(1, { random: () => 0 }), 12_000);
  assert.equal(boundedBackoffDelay(2, { random: () => 0 }), 24_000);
  assert.equal(boundedBackoffDelay(3, { random: () => 0.5 }), 52_800);
  assert.equal(boundedBackoffDelay(8, { random: () => 1 }), 60_000);
});

test("poll controller prevents overlap, reports offline, and recovers", async () => {
  const statuses = [];
  const scheduled = [];
  let pollCalls = 0;
  let releaseFirstPoll;
  const firstPoll = new Promise((resolve) => { releaseFirstPoll = resolve; });
  const outcomes = [firstPoll, Promise.reject(new Error("network")), Promise.reject(new Error("database")), Promise.reject(new Error("restart")), Promise.resolve()];
  outcomes.slice(1, 4).forEach((promise) => promise.catch(() => {}));
  const controller = createPollController({
    poll: () => {
      pollCalls += 1;
      return outcomes.shift();
    },
    onStatus: (status) => statuses.push(status),
    random: () => 0,
    setTimer: (callback, delay) => {
      scheduled.push({ callback, delay });
      return scheduled.length;
    },
    clearTimer: () => {},
  });

  const initial = controller.start({ immediate: true });
  const overlapping = controller.retry();
  assert.equal(pollCalls, 1);
  assert.equal(controller.state().inFlight, true);
  releaseFirstPoll();
  assert.equal(await initial, true);
  assert.equal(await overlapping, true);

  assert.equal(await controller.retry(), false);
  assert.equal(await controller.retry(), false);
  assert.equal(await controller.retry(), false);
  assert.equal(statuses.at(-1).state, "offline");
  assert.deepEqual(statuses.filter((status) => status.error).map((status) => status.nextDelay), [12_000, 24_000, 48_000]);

  assert.equal(await controller.retry(), true);
  assert.equal(statuses.at(-1).state, "live");
  assert.equal(controller.state().failures, 0);
  assert.equal(pollCalls, 5);
});

test("sales polling queries only rows created or updated after its cursor", async () => {
  const since = "2026-06-27T10:00:00.000Z";
  const rows = [{ id: "sale-2", date: "2026-06-27", product: "Cookie", quantity_sold: 1, sale_amount: 4, created_at: "2026-06-27T10:01:00Z" }];
  const client = {
    from(table) {
      assert.equal(table, "sales");
      return {
        select(columns) {
          assert.equal(columns, "*");
          return {
            or(filter) {
              assert.equal(filter, `created_at.gte.${since},updated_at.gte.${since}`);
              return {
                async order(column, options) {
                  assert.equal(column, "created_at");
                  assert.deepEqual(options, { ascending: false });
                  return { data: rows, error: null };
                },
              };
            },
          };
        },
      };
    },
  };
  const storage = await createStorage({
    dataDir: ".",
    env: { SUPABASE_URL: "https://example.supabase.co", SUPABASE_ANON_KEY: "anon", SUPABASE_SERVICE_ROLE_KEY: "service" },
    logger: { log() {}, warn() {} },
    supabaseClient: client,
  });
  const updates = await storage.loadSalesSince(since);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].product, "Cookie");
});

test("dashboard polling exposes recovery controls and refreshes all sale-dependent views", () => {
  const root = path.join(__dirname, "..");
  const script = fs.readFileSync(path.join(root, "script.js"), "utf8");
  const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");

  assert.match(script, /const SALES_POLL_INTERVAL_MS = 12_000/);
  assert.match(script, /const SALES_POLL_OVERLAP_MS = 60_000/);
  assert.match(script, /createPollController/);
  assert.match(script, /\/api\/sales\/updates\?since=/);
  assert.match(script, /handlePageVisibility/);
  assert.match(script, /retryLiveSales\(\)/);
  assert.match(script, /renderLiveSalesStatus/);
  assert.match(script, /renderInventory\(\)/);
  assert.match(script, /renderCustomers\(\)/);
  assert.match(script, /renderShoppingList\(update\.purchasingIntelligence\)/);
  assert.doesNotMatch(script, /setInterval\(refreshDashboard/);
  assert.doesNotMatch(script, /location\.reload/);
  assert.match(server, /storage\.loadSalesSince\(since\)/);
  assert.match(server, /customerInsights: buildCustomerInsights/);
  assert.match(server, /purchasingIntelligence: buildPurchasingDashboard\(\)/);
  const schema = fs.readFileSync(path.join(root, "supabase", "schema.sql"), "utf8");
  assert.match(schema, /sales_created_at_idx/);
  assert.match(schema, /sales_updated_at_idx/);
  assert.match(html, /live-sales\.js\?v=2026-07-24-sales-sync-regression/);
  assert.match(html, /id="sales-connection-status"/);
  assert.match(html, /id="sales-retry"/);
});

test("canonical sales coordinator updates every sales-dependent model exactly once", () => {
  const now = new Date(2026, 6, 24, 12);
  const date = "2026-07-24";
  let state = {
    sales: [{
      id: "sale-1",
      date,
      product: "Croissant",
      quantitySold: 1,
      saleAmount: 8,
      status: "completed",
      createdAt: "2026-07-24T10:00:00.000Z",
    }],
    financials: { revenueToday: 8, revenueThisWeek: 8, revenueThisMonth: 8, expensesThisMonth: 3, estimatedProfit: 5 },
    salesSummary: { todaySales: 8, weekSales: 8, monthSales: 8, averageTicket: 8, totalTransactions: 1 },
    counts: { sales: 1 },
    productPerformance: [{ product: "Croissant", quantitySold: 1, revenue: 8 }],
    updatedAt: "2026-07-24T10:00:00.000Z",
  };
  const rendered = [];
  const coordinator = createSalesStateCoordinator({
    getState: () => state,
    setState: (next) => { state = next; },
    now: () => now,
    render: ({ state: renderedState }) => {
      rendered.push({
        revenue: renderedState.financials.revenueToday,
        todaySales: renderedState.salesSummary.todaySales,
        recentSales: renderedState.sales.map((sale) => sale.product),
        chart: buildDailyRevenue(renderedState.sales, now).at(-1).total,
        products: renderedState.productPerformance,
      });
    },
  });
  const requestId = coordinator.beginRequest();
  const canonicalSale = {
    id: "sale-2",
    date,
    product: "Baguette",
    quantitySold: 2,
    saleAmount: 12,
    status: "completed",
    createdAt: "2026-07-24T10:01:00.000Z",
  };

  const first = coordinator.commit({
    requestId,
    update: { sales: [canonicalSale], cursor: "2026-07-24T10:01:01.000Z" },
  });
  assert.equal(first.applied, true);
  assert.equal(state.sales.length, 2);
  assert.equal(state.financials.revenueToday, 20);
  assert.equal(state.salesSummary.todaySales, 20);
  assert.equal(state.salesSummary.totalTransactions, 2);
  assert.deepEqual(state.productPerformance, [
    { product: "Baguette", quantitySold: 2, revenue: 12 },
    { product: "Croissant", quantitySold: 1, revenue: 8 },
  ]);
  assert.deepEqual(rendered.at(-1), {
    revenue: 20,
    todaySales: 20,
    recentSales: ["Baguette", "Croissant"],
    chart: 20,
    products: [
      { product: "Baguette", quantitySold: 2, revenue: 12 },
      { product: "Croissant", quantitySold: 1, revenue: 8 },
    ],
  });

  const overlapRequest = coordinator.beginRequest();
  const repeated = coordinator.commit({
    requestId: overlapRequest,
    update: { sales: [canonicalSale], cursor: "2026-07-24T10:01:13.000Z" },
  });
  assert.equal(repeated.changed, false);
  assert.equal(state.sales.length, 2);
  assert.equal(state.financials.revenueToday, 20);
  assert.equal(rendered.length, 1);
});

test("a failed redesigned widget cannot roll back canonical sales or block later renderers", () => {
  const date = localDateKey(new Date());
  let state = {
    sales: [],
    financials: { expensesThisMonth: 0 },
    salesSummary: {},
    counts: { sales: 0 },
    productPerformance: [],
  };
  const rendered = [];
  const rendererErrors = [];
  const transactionErrors = [];
  const coordinator = createSalesStateCoordinator({
    getState: () => state,
    setState: (next) => { state = next; },
    render: () => runRenderers([
      ["summary", () => rendered.push("summary")],
      ["optional-chart", () => { throw new Error("chart target unavailable"); }],
      ["sales-history", () => rendered.push("sales-history")],
      ["product-performance", () => rendered.push("product-performance")],
    ], {
      onError: (name, error) => rendererErrors.push({ name, type: error.name }),
    }),
    onRenderError: (error) => transactionErrors.push(error),
  });
  const sales = [
    { id: "sale-one", date, product: "Croissant", quantitySold: 2, saleAmount: 17.5, status: "completed" },
    { id: "sale-two", date, product: "Baguette", quantitySold: 1, saleAmount: 8.25, status: "completed" },
  ];

  for (const sale of sales) {
    const committed = coordinator.commit({
      requestId: coordinator.beginRequest(),
      update: { sales: [sale], cursor: new Date().toISOString() },
      forceRender: true,
    });
    assert.equal(committed.applied, true);
    assert.equal(committed.renderError, null);
  }

  assert.deepEqual(state.sales.map((sale) => sale.id).sort(), ["sale-one", "sale-two"]);
  assert.equal(state.salesSummary.todaySales, 25.75);
  assert.equal(state.salesSummary.totalTransactions, 2);
  assert.deepEqual(state.productPerformance, [
    { product: "Croissant", quantitySold: 2, revenue: 17.5 },
    { product: "Baguette", quantitySold: 1, revenue: 8.25 },
  ]);
  assert.deepEqual(rendered, [
    "summary", "sales-history", "product-performance",
    "summary", "sales-history", "product-performance",
  ]);
  assert.deepEqual(rendererErrors, [
    { name: "optional-chart", type: "Error" },
    { name: "optional-chart", type: "Error" },
  ]);
  assert.deepEqual(transactionErrors, []);

  const throwingCoordinator = createSalesStateCoordinator({
    getState: () => state,
    setState: (next) => { state = next; },
    render: () => { throw new Error("unexpected outer renderer failure"); },
    onRenderError: (error) => transactionErrors.push(error.name),
  });
  const third = throwingCoordinator.commit({
    requestId: throwingCoordinator.beginRequest(),
    update: {
      sales: [{ id: "sale-three", date, product: "Tart", quantitySold: 1, saleAmount: 4, status: "completed" }],
      cursor: new Date().toISOString(),
    },
  });
  assert.equal(third.applied, true);
  assert.equal(third.renderError.message, "unexpected outer renderer failure");
  assert.equal(state.sales.length, 3);
  assert.equal(state.salesSummary.todaySales, 29.75);
  assert.deepEqual(transactionErrors, ["Error"]);
});

test("equal timestamps are retained and older responses cannot overwrite newer state", () => {
  const timestamp = "2026-07-24T12:00:00.000Z";
  const equalTimestampSales = mergeSales([], [
    { id: "sale-a", date: "2026-07-24", product: "A", saleAmount: 3, createdAt: timestamp },
    { id: "sale-b", date: "2026-07-24", product: "B", saleAmount: 4, createdAt: timestamp },
  ]);
  assert.equal(equalTimestampSales.sales.length, 2);

  let state = {
    sales: [],
    financials: { expensesThisMonth: 0 },
    salesSummary: {},
    counts: { sales: 0 },
    productPerformance: [],
  };
  const coordinator = createSalesStateCoordinator({
    getState: () => state,
    setState: (next) => { state = next; },
  });
  const olderRequest = coordinator.beginRequest();
  const newerRequest = coordinator.beginRequest();
  coordinator.commit({
    requestId: newerRequest,
    update: {
      sales: [{ id: "new-sale", date: localDateKey(new Date()), product: "New", quantitySold: 1, saleAmount: 9 }],
      cursor: "2026-07-24T12:00:02.000Z",
    },
  });
  const stale = coordinator.commit({
    requestId: olderRequest,
    update: {
      sales: [],
      financials: { revenueToday: 0, expensesThisMonth: 0 },
      salesSummary: { todaySales: 0 },
      counts: { sales: 0 },
      productPerformance: [],
    },
    authoritative: true,
  });
  assert.equal(stale.stale, true);
  assert.deepEqual(state.sales.map((sale) => sale.id), ["new-sale"]);
});

test("refund and cancellation updates replace the sale without duplicate revenue", () => {
  const date = localDateKey(new Date());
  const base = {
    sales: [],
    financials: { expensesThisMonth: 0 },
    salesSummary: {},
    counts: { sales: 0 },
    productPerformance: [],
  };
  let state = base;
  const coordinator = createSalesStateCoordinator({
    getState: () => state,
    setState: (next) => { state = next; },
  });
  const sale = {
    id: "square-sale",
    date,
    product: "Cake",
    quantitySold: 2,
    grossAmount: 20,
    saleAmount: 20,
    refundedAmount: 0,
    status: "completed",
    source: "square",
  };
  coordinator.commit({ requestId: coordinator.beginRequest(), update: { sales: [sale] } });
  coordinator.commit({
    requestId: coordinator.beginRequest(),
    update: { sales: [{ ...sale, saleAmount: 15, refundedAmount: 5, status: "partially_refunded", updatedAt: "2026-07-24T12:01:00Z" }] },
  });
  assert.equal(state.sales.length, 1);
  assert.equal(state.salesSummary.todaySales, 15);
  assert.deepEqual(state.productPerformance, [{ product: "Cake", quantitySold: 1.5, revenue: 15 }]);

  coordinator.commit({
    requestId: coordinator.beginRequest(),
    update: { sales: [{ ...sale, saleAmount: 0, refundedAmount: 20, status: "refunded", updatedAt: "2026-07-24T12:02:00Z" }] },
  });
  assert.equal(state.sales.length, 1);
  assert.equal(state.salesSummary.todaySales, 0);
  assert.deepEqual(state.productPerformance, []);

  coordinator.commit({
    requestId: coordinator.beginRequest(),
    update: { sales: [{ ...sale, saleAmount: 0, status: "canceled", updatedAt: "2026-07-24T12:03:00Z" }] },
  });
  assert.equal(state.sales.length, 1);
  assert.equal(state.salesSummary.totalTransactions, 0);
});

function localDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
