const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const test = require("node:test");
const {
  buildCustomerInsights,
  sortCustomers,
  toSafeCustomer,
  upsertCustomerFromSale,
} = require("../customer-intelligence");
const { createSquareService } = require("../square");
const { createStorage } = require("../storage");

function sale(overrides = {}) {
  return {
    id: "sale-1",
    date: "2026-06-02",
    product: "Croissant",
    saleAmount: 12,
    squarePaymentId: "payment-1",
    squareOrderId: "order-1",
    ...overrides,
  };
}

test("customer storage persists contact rollups", async (context) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bakeryops-customers-"));
  context.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const storage = await createStorage({ dataDir, env: {}, logger: { log() {}, warn() {} } });
  await storage.initialize();
  await storage.saveCustomers([{ id: "customer-1", name: "Jordan", totalSpend: 18, visitCount: 2 }]);
  const customers = await storage.loadCustomers();
  assert.equal(customers.length, 1);
  assert.equal(customers[0].totalSpend, 18);
});
test("customer totals are created and updated idempotently without duplicates", () => {
  const customers = [];
  const options = { createId: () => "customer-1", now: new Date("2026-06-27T12:00:00Z") };
  upsertCustomerFromSale(customers, {
    squareCustomerId: "square-customer-1",
    name: "Avery Baker",
    email: "AVERY@example.test",
    phone: "(555) 010-1000",
  }, sale(), options);
  upsertCustomerFromSale(customers, {
    squareCustomerId: "square-customer-1",
    name: "Avery Baker",
  }, sale({ id: "sale-2", date: "2026-06-20", product: "Croissant, Coffee", saleAmount: 8, squarePaymentId: "payment-2", squareOrderId: "order-2" }), options);
  upsertCustomerFromSale(customers, { squareCustomerId: "square-customer-1" }, sale(), options);

  assert.equal(customers.length, 1);
  assert.equal(customers[0].email, "avery@example.test");
  assert.equal(customers[0].firstPurchaseDate, "2026-06-02");
  assert.equal(customers[0].latestPurchaseDate, "2026-06-20");
  assert.equal(customers[0].totalSpend, 20);
  assert.equal(customers[0].visitCount, 2);
  assert.equal(customers[0].favoriteProduct, "Croissant");
});

test("Square sales with customer data create and update one customer", async () => {
  const sales = [];
  const customers = [];
  const responses = {
    "/v2/payments/payment-1": { payment: { id: "payment-1", order_id: "order-1", customer_id: "square-customer-1", buyer_email_address: "owner@example.test", status: "COMPLETED", amount_money: { amount: 1000 }, updated_at: "2026-06-10T12:00:00Z" } },
    "/v2/orders/order-1": { order: { id: "order-1", line_items: [{ name: "Sourdough", quantity: "1" }], fulfillments: [{ pickup_details: { recipient: { display_name: "Morgan Lee", phone_number: "+15550102000" } } }] } },
    "/v2/payments/payment-2": { payment: { id: "payment-2", order_id: "order-2", customer_id: "square-customer-1", status: "COMPLETED", amount_money: { amount: 600 }, updated_at: "2026-06-21T12:00:00Z" } },
    "/v2/orders/order-2": { order: { id: "order-2", line_items: [{ name: "Sourdough", quantity: "1" }] } },
  };
  const service = createSquareService({
    env: { SQUARE_ENVIRONMENT: "sandbox", SQUARE_CLIENT_ID: "test-client", SQUARE_APPLICATION_SECRET: "test-secret", SQUARE_REDIRECT_URI: "https://example.test/api/square/oauth/callback" },
    storage: { async saveSquareConnection() {} },
    connection: { accessToken: "test-token", merchantId: "merchant-1" },
    getSales: () => sales,
    saveSales: async () => {},
    logActivity: async () => {},
    upsertCustomer: async (info, squareSale) => upsertCustomerFromSale(customers, info, squareSale, { createId: () => "customer-1" }),
    fetchImpl: async (url) => ({ ok: true, async json() { return responses[new URL(url).pathname]; } }),
  });

  assert.deepEqual(await service.processWebhook({ type: "payment.created", data: { id: "payment-1" } }), { accepted: true, synced: true });
  assert.deepEqual(await service.processWebhook({ type: "payment.created", data: { id: "payment-2" } }), { accepted: true, synced: true });
  assert.equal(sales.length, 2);
  assert.equal(customers.length, 1);
  assert.equal(customers[0].name, "Morgan Lee");
  assert.equal(customers[0].totalSpend, 16);
  assert.equal(customers[0].visitCount, 2);
  assert.equal(customers[0].favoriteProduct, "Sourdough");
});

test("Square sale ingestion succeeds when no customer data is present", async () => {
  const sales = [];
  let customerUpdates = 0;
  const service = createSquareService({
    env: { SQUARE_ENVIRONMENT: "sandbox", SQUARE_CLIENT_ID: "test-client", SQUARE_APPLICATION_SECRET: "test-secret", SQUARE_REDIRECT_URI: "https://example.test/api/square/oauth/callback" },
    storage: { async saveSquareConnection() {} },
    connection: { accessToken: "test-token", merchantId: "merchant-1" },
    getSales: () => sales,
    saveSales: async () => {},
    logActivity: async () => {},
    upsertCustomer: async () => { customerUpdates += 1; },
    fetchImpl: async (url) => {
      const pathname = new URL(url).pathname;
      const result = pathname.includes("payments")
        ? { payment: { id: "anonymous-payment", order_id: "anonymous-order", status: "COMPLETED", amount_money: { amount: 500 }, updated_at: "2026-06-22T12:00:00Z" } }
        : { order: { id: "anonymous-order", line_items: [{ name: "Cookie", quantity: "1" }] } };
      return { ok: true, async json() { return result; } };
    },
  });

  assert.deepEqual(await service.processWebhook({ type: "payment.created", data: { id: "anonymous-payment" } }), { accepted: true, synced: true });
  assert.equal(sales.length, 1);
  assert.equal(customerUpdates, 0);
});

test("customer API serialization returns safe fields and supports insight sorting", () => {
  const internal = {
    id: "customer-1",
    squareCustomerId: "square-private-id",
    name: "Taylor",
    email: "taylor@example.test",
    phone: "5550103000",
    firstPurchaseDate: "2026-06-01",
    latestPurchaseDate: "2026-06-20",
    totalSpend: 25,
    visitCount: 2,
    favoriteProduct: "Baguette",
    purchaseHistory: { private: { amount: 25 } },
    accessToken: "never-return-this",
  };
  assert.deepEqual(Object.keys(toSafeCustomer(internal)), [
    "id", "name", "email", "phone", "firstPurchaseDate", "latestPurchaseDate", "totalSpend", "visitCount", "favoriteProduct",
  ]);
  assert.equal(toSafeCustomer(internal).squareCustomerId, undefined);
  assert.equal(toSafeCustomer(internal).purchaseHistory, undefined);
  assert.equal(sortCustomers([{ ...internal, id: "a" }, { ...internal, id: "b", totalSpend: 50 }], "totalSpend")[0].id, "b");
  const insights = buildCustomerInsights([internal], new Date("2026-06-27T12:00:00Z"));
  assert.equal(insights.repeatCustomers, 1);
  assert.equal(insights.newCustomersThisMonth, 1);

  const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const route = server.slice(server.indexOf('if (url.pathname === "/api/customers"'), server.indexOf('if (url.pathname === "/api/customer-insights"'));
  assert.match(route, /sorted\.map\(toSafeCustomer\)/);
  assert.doesNotMatch(route, /squareCustomerId|purchaseHistory|accessToken|refreshToken/);
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  assert.match(html, /No customers yet/);
  assert.match(html, /data-view-target="customers-view"/);
});