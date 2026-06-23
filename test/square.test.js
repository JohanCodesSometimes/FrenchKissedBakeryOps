const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { createSquareService } = require("../square");

test("Square webhook verification, completed sale sync, and deduplication", async () => {
  const sales = [];
  const savedConnections = [];
  let saveCount = 0;
  const env = {
    SQUARE_ENVIRONMENT: "sandbox",
    SQUARE_CLIENT_ID: "app-id",
    SQUARE_APPLICATION_SECRET: "app-secret",
    SQUARE_REDIRECT_URI: "https://example.test/api/square/oauth/callback",
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
    "/v2/orders/order-2": {
      order: {
        id: "order-2",
        state: "COMPLETED",
        closed_at: "2026-06-18T15:00:00Z",
        line_items: [{ name: "Cake Slice", quantity: "2" }],
        total_money: { amount: 1200 },
        total_tax_money: { amount: 80 },
        total_discount_money: { amount: 100 },
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
  assert.deepEqual(
    await service.processWebhook({ type: "order.updated", data: { id: "order-1" } }),
    { accepted: true, duplicate: true },
  );
  assert.deepEqual(
    await service.processWebhook({ type: "order.updated", data: { id: "order-2" } }),
    { accepted: true, synced: true },
  );
  assert.equal(sales[0].squareOrderId, "order-2");
  assert.equal(sales[0].source, "square");
  assert.equal(saveCount, 2);
});


test("manual recent Square sync imports completed payments and reports duplicates", async () => {
  const sales = [{ squarePaymentId: "payment-old", squareOrderId: "order-old" }];
  const connection = { accessToken: "test-token", merchantId: "merchant-1" };
  const env = {
    SQUARE_ENVIRONMENT: "sandbox",
    SQUARE_CLIENT_ID: "app-id",
    SQUARE_APPLICATION_SECRET: "app-secret",
    SQUARE_REDIRECT_URI: "https://example.test/api/square/oauth/callback",
    SQUARE_WEBHOOK_SIGNATURE_KEY: "signature-key",
    SQUARE_WEBHOOK_URL: "https://example.test/api/square/webhook",
    SQUARE_VERSION: "2026-05-20",
  };
  const service = createSquareService({
    env,
    storage: { async saveSquareConnection() {} },
    connection,
    getSales: () => sales,
    saveSales: async () => {},
    logActivity: async () => {},
    fetchImpl: async (url) => {
      const pathname = new URL(url).pathname;
      const body = pathname === "/v2/payments"
        ? {
          payments: [
            { id: "payment-new", order_id: "order-new", status: "COMPLETED", amount_money: { amount: 900 }, updated_at: "2026-06-20T12:00:00Z" },
            { id: "payment-old", order_id: "order-old", status: "COMPLETED", amount_money: { amount: 500 } },
            { id: "payment-pending", status: "PENDING", amount_money: { amount: 300 } },
          ],
        }
        : {
          order: {
            id: "order-new",
            line_items: [{ name: "Brownie", quantity: "3" }],
            total_tax_money: { amount: 50 },
            total_discount_money: { amount: 25 },
          },
        };
      return { ok: true, async json() { return body; } };
    },
  });

  const result = await service.syncRecentSales();
  assert.equal(result.synced, 1);
  assert.equal(result.duplicates, 1);
  assert.equal(result.ignored, 1);
  assert.equal(result.errors, 0);
  assert.equal(sales[0].product, "Brownie");
  assert.equal(sales[0].quantitySold, 3);
  assert.equal(sales[0].source, "square");
  assert.ok(connection.lastSyncAt);
});


test("Square OAuth uses fresh state and the correct sandbox and production authorization hosts", async () => {
  async function authorizationUrls(environment) {
    const env = {
      SQUARE_ENVIRONMENT: environment,
      SQUARE_CLIENT_ID: "app-id",
      SQUARE_APPLICATION_SECRET: "app-secret",
      SQUARE_REDIRECT_URI: "https://example.test/api/square/oauth/callback",
      SQUARE_WEBHOOK_SIGNATURE_KEY: "signature-key",
      SQUARE_WEBHOOK_URL: "https://example.test/api/square/webhook",
      SQUARE_VERSION: "2026-05-20",
    };
    const service = createSquareService({
      env,
      storage: { async saveSquareConnection() {} },
      connection: {},
      getSales: () => [],
      saveSales: async () => {},
      logActivity: async () => {},
    });
    return [new URL(await service.startOAuth()), new URL(await service.startOAuth())];
  }

  const [sandbox, secondSandbox] = await authorizationUrls("sandbox");
  assert.equal(sandbox.hostname, "connect.squareupsandbox.com");
  assert.equal(`${sandbox.origin}${sandbox.pathname}`, "https://connect.squareupsandbox.com/oauth2/authorize");
  assert.equal(sandbox.searchParams.get("client_id"), "app-id");
  assert.equal(sandbox.searchParams.get("redirect_uri"), "https://example.test/api/square/oauth/callback");
  assert.equal(sandbox.searchParams.get("scope"), "MERCHANT_PROFILE_READ PAYMENTS_READ ORDERS_READ");
  assert.notEqual(sandbox.searchParams.get("state"), secondSandbox.searchParams.get("state"));

  const mutableEnv = {
    SQUARE_ENVIRONMENT: "sandbox",
    SQUARE_CLIENT_ID: "app-id",
    SQUARE_APPLICATION_SECRET: "app-secret",
    SQUARE_REDIRECT_URI: "https://first.example.test/api/square/oauth/callback",
    SQUARE_VERSION: "2026-05-20",
  };
  const mutableService = createSquareService({
    env: mutableEnv,
    storage: { async saveSquareConnection() {} },
    connection: {},
    getSales: () => [],
    saveSales: async () => {},
    logActivity: async () => {},
  });
  const firstDynamic = new URL(await mutableService.startOAuth());
  mutableEnv.SQUARE_ENVIRONMENT = "production";
  mutableEnv.SQUARE_REDIRECT_URI = "https://second.example.test/api/square/oauth/callback";
  const secondDynamic = new URL(await mutableService.startOAuth());
  assert.equal(firstDynamic.hostname, "connect.squareupsandbox.com");
  assert.equal(firstDynamic.searchParams.get("redirect_uri"), "https://first.example.test/api/square/oauth/callback");
  assert.equal(secondDynamic.hostname, "connect.squareup.com");
  assert.equal(secondDynamic.searchParams.get("redirect_uri"), "https://second.example.test/api/square/oauth/callback");

  const [production] = await authorizationUrls("production");
  assert.equal(production.hostname, "connect.squareup.com");
  assert.equal(`${production.origin}${production.pathname}`, "https://connect.squareup.com/oauth2/authorize");
});


test("Settings Connect Square fetches a fresh backend OAuth URL and exposes the deployment marker", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  const script = fs.readFileSync(path.join(__dirname, "..", "script.js"), "utf8");
  assert.match(html, /id="square-connect" type="button"/);
  assert.match(html, /Square UI build 2026-06-23-oauth-fresh/);
  assert.match(html, /script\.js\?v=20260623-square-oauth-fresh/);
  assert.match(script, /fetch\("\/api\/square\/oauth-url"/);
  assert.doesNotMatch(html, /connect\.squareup(?:sandbox)?\.com\/oauth2\/authorize/);
  assert.doesNotMatch(script, /connect\.squareup(?:sandbox)?\.com\/oauth2\/authorize/);
});

test("repo has no stale Railway, localhost, or hardcoded frontend OAuth callback URLs", () => {
  const root = path.join(__dirname, "..");
  const files = ["index.html", "script.js", "styles.css", "README.md", "server.js"];
  const combined = files.map((file) => fs.readFileSync(path.join(root, file), "utf8")).join("\n");
  assert.doesNotMatch(combined, /https?:\/\/localhost[^\s"']*\/api\/square\/oauth\/callback/i);
  assert.doesNotMatch(combined, /https?:\/\/127\.0\.0\.1[^\s"']*\/api\/square\/oauth\/callback/i);
  assert.doesNotMatch(combined, /https?:\/\/[^\s"'<]*railway[^\s"'>]*\/api\/square\/oauth\/callback/i);
});
