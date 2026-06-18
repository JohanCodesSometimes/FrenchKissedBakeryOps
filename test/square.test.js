const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const { createSquareService } = require("../square");

test("Square webhook verification, completed sale sync, and deduplication", async () => {
  const sales = [];
  const savedConnections = [];
  let saveCount = 0;
  const env = {
    SQUARE_ENVIRONMENT: "sandbox",
    SQUARE_APPLICATION_ID: "app-id",
    SQUARE_APPLICATION_SECRET: "app-secret",
    SQUARE_OAUTH_REDIRECT_URL: "https://example.test/api/square/oauth/callback",
    SQUARE_WEBHOOK_SIGNATURE_KEY: "signature-key",
    SQUARE_WEBHOOK_URL: "https://example.test/api/square/webhook",
    SQUARE_VERSION: "2026-05-20",
  };
  const responses = {
    "/v2/payments/payment-1": {
      payment: {
        id: "payment-1",
        order_id: "order-1",
        status: "COMPLETED",
        amount_money: { amount: 2650, currency: "USD" },
        updated_at: "2026-06-17T14:30:00Z",
      },
    },
    "/v2/orders/order-1": {
      order: {
        id: "order-1",
        line_items: [{ name: "Croissant", quantity: "2" }, { name: "Coffee", quantity: "1" }],
        total_tax_money: { amount: 150 },
        total_discount_money: { amount: 200 },
      },
    },
  };
  const service = createSquareService({
    env,
    storage: { async saveSquareConnection(value) { savedConnections.push({ ...value }); } },
    connection: { accessToken: "test-token", merchantId: "merchant-1" },
    getSales: () => sales,
    saveSales: async () => { saveCount += 1; },
    logActivity: async () => {},
    fetchImpl: async (url) => ({ ok: true, async json() { return responses[new URL(url).pathname]; } }),
  });
  const raw = JSON.stringify({ type: "payment.updated", data: { id: "payment-1" } });
  const signature = crypto.createHmac("sha256", env.SQUARE_WEBHOOK_SIGNATURE_KEY)
    .update(env.SQUARE_WEBHOOK_URL + raw).digest("base64");

  assert.equal(service.verifyWebhook(raw, signature), true);
  assert.equal(service.verifyWebhook(raw, "invalid"), false);
  assert.deepEqual(await service.processWebhook(JSON.parse(raw)), { accepted: true, synced: true });
  assert.equal(sales.length, 1);
  assert.equal(sales[0].product, "Croissant, Coffee");
  assert.equal(sales[0].quantitySold, 3);
  assert.equal(sales[0].saleAmount, 26.5);
  assert.equal(sales[0].tax, 1.5);
  assert.equal(sales[0].discount, 2);
  assert.equal(saveCount, 1);
  assert.ok(savedConnections.at(-1).lastSyncAt);
  assert.deepEqual(await service.processWebhook(JSON.parse(raw)), { accepted: true, duplicate: true });
  assert.equal(saveCount, 1);
});
