const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { mergeSales } = require("../live-sales");
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

test("dashboard uses lightweight polling without page reloads or full-dashboard polling", () => {
  const root = path.join(__dirname, "..");
  const script = fs.readFileSync(path.join(root, "script.js"), "utf8");
  const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");

  assert.match(script, /const SALES_POLL_INTERVAL_MS = 12_000/);
  assert.match(script, /const SALES_POLL_OVERLAP_MS = 60_000/);
  assert.match(script, /setInterval\(pollSalesUpdates, SALES_POLL_INTERVAL_MS\)/);
  assert.match(script, /\/api\/sales\/updates\?since=/);
  assert.match(script, /salesPollingInFlight/);
  assert.match(script, /clearInterval\(salesPollingTimer\)/);
  assert.match(script, /renderSalesDependentViews\(\)/);
  assert.doesNotMatch(script, /setInterval\(refreshDashboard/);
  assert.doesNotMatch(script, /location\.reload/);
  assert.match(server, /storage\.loadSalesSince\(since\)/);
  const schema = fs.readFileSync(path.join(root, "supabase", "schema.sql"), "utf8");
  assert.match(schema, /sales_created_at_idx/);
  assert.match(schema, /sales_updated_at_idx/);
  assert.match(html, /live-sales\.js\?v=2026-06-27-live-sales/);
});
