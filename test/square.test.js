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
  assert.deepEqual(await service.processWebhook({ type: "payment.created", data: { id: "payment-1" } }), { accepted: true, duplicate: true });
  assert.deepEqual(await service.processWebhook(JSON.parse(raw)), { accepted: true, updated: true });
  assert.deepEqual(
    await service.processWebhook({ type: "order.updated", data: { id: "order-1" } }),
    { accepted: true, ignored: true },
  );
  assert.deepEqual(
    await service.processWebhook({ type: "order.updated", data: { id: "order-2" } }),
    { accepted: true, synced: true },
  );
  assert.equal(sales[0].squareOrderId, "order-2");
  assert.equal(sales[0].source, "square");
  assert.equal(saveCount, 3);
});


test("Square OAuth callback persists merchant, tokens, scopes, environment, and diagnostic status", async () => {
  const savedConnections = [];
  const connection = {
    oauthState: "state-1",
    oauthStateExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  const env = {
    SQUARE_ENVIRONMENT: "sandbox",
    SQUARE_CLIENT_ID: "app-id",
    SQUARE_APPLICATION_SECRET: "app-secret",
    SQUARE_REDIRECT_URI: "https://example.test/api/square/oauth/callback",
    SQUARE_VERSION: "2026-05-20",
  };
  const service = createSquareService({
    env,
    storage: { async saveSquareConnection(value) { savedConnections.push({ ...value }); } },
    connection,
    getSales: () => [],
    saveSales: async () => {},
    logActivity: async () => {},
    fetchImpl: async (url) => {
      assert.equal(new URL(url).pathname, "/oauth2/token");
      return { ok: true, async json() { return {
        access_token: "access-token",
        refresh_token: "refresh-token",
        expires_at: "2026-06-24T00:00:00Z",
        merchant_id: "merchant-123",
        scopes: "MERCHANT_PROFILE_READ PAYMENTS_READ ORDERS_READ CUSTOMERS_READ",
      }; } };
    },
  });

  await service.completeOAuth({ code: "code-1", state: "state-1" });

  assert.equal(connection.merchantId, "merchant-123");
  assert.equal(connection.tokenExpiresAt, "2026-06-24T00:00:00Z");
  assert.equal(connection.scopes, "MERCHANT_PROFILE_READ PAYMENTS_READ ORDERS_READ CUSTOMERS_READ");
  assert.equal(connection.environment, "sandbox");
  assert.ok(connection.accessToken.startsWith("v1."));
  assert.ok(connection.refreshToken.startsWith("v1."));
  assert.equal(savedConnections.at(-1).merchantId, "merchant-123");
  assert.equal(savedConnections.at(-1).refreshToken, connection.refreshToken);
  const status = service.status();
  assert.equal(status.connected, true);
  assert.equal(status.customerReadEnabled, true);
  assert.equal(status.merchantId, "merchant-123");
  assert.equal(status.environment, "sandbox");
  assert.equal(status.tokenExpiresAt, "2026-06-24T00:00:00Z");
  assert.equal(status.refreshTokenPresent, true);
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


test("Square refreshes expired access tokens before API calls", async () => {
  const sales = [];
  let tokenRefreshes = 0;
  const savedConnections = [];
  const connection = {
    accessToken: "old-access-token",
    refreshToken: "old-refresh-token",
    tokenExpiresAt: "2020-01-01T00:00:00Z",
    merchantId: "merchant-1",
  };
  const env = {
    SQUARE_ENVIRONMENT: "sandbox",
    SQUARE_CLIENT_ID: "app-id",
    SQUARE_APPLICATION_SECRET: "app-secret",
    SQUARE_REDIRECT_URI: "https://example.test/api/square/oauth/callback",
    SQUARE_VERSION: "2026-05-20",
  };
  const service = createSquareService({
    env,
    storage: { async saveSquareConnection(value) { savedConnections.push({ ...value }); } },
    connection,
    getSales: () => sales,
    saveSales: async () => {},
    logActivity: async () => {},
    fetchImpl: async (url, options) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/oauth2/token") {
        tokenRefreshes += 1;
        assert.equal(JSON.parse(options.body).grant_type, "refresh_token");
        return { ok: true, async json() { return {
          access_token: "new-access-token",
          refresh_token: "new-refresh-token",
          expires_at: "2026-06-24T01:00:00Z",
          merchant_id: "merchant-1",
        }; } };
      }
      if (parsed.pathname === "/v2/payments") return { ok: true, async json() { return { payments: [] }; } };
      return { ok: false, status: 404, async json() { return {}; } };
    },
  });

  const result = await service.syncRecentSales();
  assert.equal(result.synced, 0);
  assert.equal(tokenRefreshes, 1);
  assert.equal(connection.tokenExpiresAt, "2026-06-24T01:00:00Z");
  assert.ok(connection.accessToken.startsWith("v1."));
  assert.ok(connection.refreshToken.startsWith("v1."));
  assert.equal(savedConnections.length >= 1, true);
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
  assert.equal(sandbox.searchParams.get("scope"), "MERCHANT_PROFILE_READ PAYMENTS_READ ORDERS_READ CUSTOMERS_READ");
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





test("Square connect final handler is isolated from cached script.js", () => {
  const root = path.join(__dirname, "..");
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const script = fs.readFileSync(path.join(root, "script.js"), "utf8");
  const fix = fs.readFileSync(path.join(root, "square-connect-fix.js"), "utf8");
  assert.match(html, /id="square-connect" type="button"/);
  assert.match(html, /Square UI build final-square-oauth-2026-06-23-1/);
  const scriptIndex = html.indexOf('<script src="script.js?v=2026-06-27-customer-details"></script>');
  const fixIndex = html.indexOf('<script src="/square-connect-fix.js?v=final-square-oauth-2026-06-23-1"></script>');
  assert.ok(scriptIndex >= 0, "script.js must be loaded");
  assert.ok(fixIndex > scriptIndex, "square-connect-fix.js must load after script.js");
  assert.equal(script.includes('document.querySelector("#square-connect").addEventListener("click"'), false);
  assert.equal(script.includes("async function connectSquare"), false);
  assert.equal(script.includes("/api/square/oauth-url"), false);
  assert.doesNotMatch(script, /window\.location\.(?:assign|replace|href)/);
  assert.equal(fix.includes("cloneNode(true)"), true);
  assert.equal(fix.includes("replaceWith(cleanButton)"), true);
  assert.equal(fix.includes('addEventListener("click", connectSquare'), true);
  assert.equal(fix.includes("event.preventDefault()"), true);
  assert.equal(fix.includes("event.stopImmediatePropagation()"), true);
  assert.equal(fix.includes('fetch("/api/square/oauth-url", { cache: "no-store" })'), true);
  assert.equal(fix.includes("const parsed = new URL(data.url)"), true);
  assert.equal(fix.includes('parsed.hostname !== "connect.squareupsandbox.com"'), true);
  assert.equal(fix.includes('parsed.hostname !== "connect.squareup.com"'), true);
  assert.equal(fix.includes('console.error("[square-connect-fix] failed", error)'), true);
  assert.equal(fix.includes("window.location.href = data.url"), true);
});

test("frontend has no stale Square OAuth fallback path", () => {
  const root = path.join(__dirname, "..");
  const files = ["index.html", "script.js", "square-connect-fix.js", "test/square.test.js"];
  const combined = files.map((file) => fs.readFileSync(path.join(root, file), "utf8")).join("\n");
  assert.doesNotMatch(combined, new RegExp("https://" + "squareupsandbox\\.com", "i"));
  assert.doesNotMatch(combined, new RegExp("(^|[^.])" + "squareupsandbox\\.com/oauth2/authorize", "i"));
  const script = fs.readFileSync(path.join(root, "script.js"), "utf8");
  assert.equal(script.includes("/api/square/connect"), false);
  assert.equal(script.includes("/api/square/oauth-url"), false);
  assert.doesNotMatch(script, /window\.location\.(?:assign|replace|href)/);
  const fix = fs.readFileSync(path.join(root, "square-connect-fix.js"), "utf8");
  const validationIndex = fix.indexOf("parsed.hostname !==");
  const redirectIndex = fix.indexOf("window.location.href = data.url");
  assert.ok(validationIndex >= 0, "Square OAuth hostname must be validated");
  assert.ok(redirectIndex > validationIndex, "Square OAuth redirect must happen after hostname validation");
});

test("frontend static assets are not globally served without browser caching", () => {
  const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.match(server, /path\.join\(root, "square-connect-fix\.js"\)/);
  assert.doesNotMatch(server, /staticNoCacheHeaders/);
  assert.doesNotMatch(server, /"index\.html", "script\.js", "square-connect-fix\.js"/);
  assert.doesNotMatch(server, /"Cache-Control": "no-store, no-cache, must-revalidate"/);
});


test("Square production validation diagnostics are backend-only and token-safe", () => {
  const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.match(server, /\/api\/square\/diagnostics/);
  assert.match(server, /\[square-test\] webhook received/);
  assert.match(server, /\[square-test\] payment created/);
  assert.match(server, /\[square-test\] sale inserted/);
  assert.match(server, /\[square-test\] dashboard sale count/);
  assert.match(server, /squareConnected: Boolean\(squareStatus\.connected\)/);
  assert.match(server, /webhookConfigured: squareWebhookConfigured\(\)/);
  assert.match(server, /latestWebhookReceivedAt: squareDiagnostics\.latestWebhookReceivedAt/);
  assert.match(server, /latestSquarePaymentId: squareDiagnostics\.latestSquarePaymentId/);
  assert.match(server, /latestSaleId: squareDiagnostics\.latestSaleId/);
  assert.match(server, /salesCount: collections\.sales\.length/);
  const diagnosticsBlock = server.slice(server.indexOf('if (url.pathname === "/api/square/diagnostics"'), server.indexOf('if (url.pathname === "/api/square/oauth-url"'));
  assert.doesNotMatch(diagnosticsBlock, /accessToken|refreshToken|token/i);
});
