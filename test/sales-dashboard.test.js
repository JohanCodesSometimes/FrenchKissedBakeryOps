const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { buildSalesSummary } = require("../sales-analytics");
const { createStorage } = require("../storage");

function supabaseSalesClient(getRows) {
  return {
    from(table) {
      assert.equal(table, "sales");
      return {
        select(columns) {
          assert.equal(columns, "*");
          return {
            async order(column, options) {
              assert.equal(column, "created_at");
              assert.deepEqual(options, { ascending: false });
              return { data: getRows(), error: null };
            },
          };
        },
      };
    },
  };
}

test("dashboard sales values match live Supabase database totals", async () => {
  let databaseRows = [
    { id: "1", date: "2026-06-26", product: "Croissant", quantity_sold: "2", sale_amount: "20.00", gross_amount: "25.00", refunded_amount: "5.00", status: "partially_refunded", tax: "1.50", discount: "0", source: "square", created_at: "2026-06-26T14:00:00Z" },
    { id: "2", date: "2026-06-24", product: "Baguette", quantity_sold: "1", sale_amount: "15.00", tax: "0", discount: "2.00", source: "square", created_at: "2026-06-24T14:00:00Z" },
    { id: "3", date: "2026-06-01", product: "Cake", quantity_sold: "1", sale_amount: "20.00", tax: "0", discount: "0", source: "manual", created_at: "2026-06-01T14:00:00Z" },
    { id: "4", date: "2026-05-31", product: "Tart", quantity_sold: "4", sale_amount: "40.00", tax: "2.00", discount: "1.00", source: "square", created_at: "2026-05-31T14:00:00Z" },
  ];
  const storage = await createStorage({
    dataDir: ".",
    env: { SUPABASE_URL: "https://example.supabase.co", SUPABASE_ANON_KEY: "anon", SUPABASE_SERVICE_ROLE_KEY: "service" },
    logger: { log() {}, warn() {} },
    supabaseClient: supabaseSalesClient(() => databaseRows),
  });

  let sales = await storage.loadCollection("sales");
  assert.deepEqual(buildSalesSummary(sales, new Date(2026, 5, 26, 12)), {
    todaySales: 20,
    weekSales: 35,
    monthSales: 55,
    averageTicket: 23.75,
    totalTransactions: 4,
  });
  assert.deepEqual(
    sales.map(({ product, tax, discount, source }) => ({ product, tax, discount, source })),
    [
      { product: "Croissant", tax: 1.5, discount: 0, source: "square" },
      { product: "Baguette", tax: 0, discount: 2, source: "square" },
      { product: "Cake", tax: 0, discount: 0, source: "manual" },
      { product: "Tart", tax: 2, discount: 1, source: "square" },
    ],
  );
  assert.deepEqual(
    (({ grossAmount, refundedAmount, status }) => ({ grossAmount, refundedAmount, status }))(sales[0]),
    { grossAmount: 25, refundedAmount: 5, status: "partially_refunded" },
  );

  databaseRows = [...databaseRows, { id: "5", date: "2026-06-26", product: "Cookie", quantity_sold: "1", sale_amount: "5.00", tax: "0", discount: "0", source: "square", created_at: "2026-06-26T15:00:00Z" }];
  sales = await storage.loadCollection("sales");
  assert.deepEqual(buildSalesSummary(sales, new Date(2026, 5, 26, 12)), {
    todaySales: 25,
    weekSales: 40,
    monthSales: 60,
    averageTicket: 20,
    totalTransactions: 5,
  });
});

test("sales summaries exclude canceled and fully refunded transactions", () => {
  const date = "2026-06-26";
  const sales = [
    { date, saleAmount: 10, status: "completed" },
    { date, saleAmount: 5, grossAmount: 10, status: "partially_refunded" },
    { date, saleAmount: 0, grossAmount: 8, refundedAmount: 8, status: "refunded" },
    { date, saleAmount: 0, grossAmount: 7, status: "canceled" },
  ];
  assert.deepEqual(buildSalesSummary(sales, new Date(2026, 5, 26, 12)), {
    todaySales: 15,
    weekSales: 15,
    monthSales: 15,
    averageTicket: 7.5,
    totalTransactions: 2,
  });
});

test("sales summary and history provide a graceful empty state", () => {
  assert.deepEqual(buildSalesSummary([], new Date(2026, 5, 26, 12)), {
    todaySales: 0,
    weekSales: 0,
    monthSales: 0,
    averageTicket: 0,
    totalTransactions: 0,
  });

  const root = path.join(__dirname, "..");
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const script = fs.readFileSync(path.join(root, "script.js"), "utf8");
  assert.match(html, /id="dashboard-sales-history"/);
  assert.match(html, /<th>Refunded<\/th><th>Status<\/th><th>Tax<\/th><th>Discount<\/th><th>Source<\/th>/);
  assert.match(script, /BakeryLiveSales\.createPollController/);
  assert.match(script, /tableEmpty\(columns, "No sales recorded yet"/);
});
