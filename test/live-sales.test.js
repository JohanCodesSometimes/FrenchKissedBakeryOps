const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { boundedBackoffDelay, createPollController, mergeSales } = require("../live-sales");
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
              assert.equal(filter, `created_at.gt.${since},updated_at.gt.${since}`);
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
  assert.match(html, /live-sales\.js\?v=2026-07-18-live-sales-recovery/);
  assert.match(html, /id="sales-connection-status"/);
  assert.match(html, /id="sales-retry"/);
});
