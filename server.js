const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { createAuthPolicy } = require("./authentication");
const { createStorage } = require("./storage");
const { createSquareService } = require("./square");
const { createReceiptParser } = require("./receipt-parser");
const { buildSalesSummary, effectiveQuantity, isRevenueSale } = require("./sales-analytics");
const { applyReceiptItemsToInventory, buildInventoryIntelligence } = require("./inventory-analytics");
const { calculateRecipeProfitability } = require("./recipe-costing");
const { buildPurchasingIntelligence } = require("./purchasing-intelligence");
const { mergeSales } = require("./live-sales");
const { createRecoveryManager } = require("./resilience");
const {
  analyzeTrend,
  buildTrendSummary,
  filterAndSortTrends,
  findDuplicate,
  normalizeTrendInput,
  normalizeTrendPatch,
  parseTrendQuery,
} = require("./trend-finder");
const {
  buildCustomerInsights,
  sortCustomers,
  toSafeCustomer,
  upsertCustomerFromSale,
} = require("./customer-intelligence");

const root = __dirname;
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || "0.0.0.0";
const authPolicy = createAuthPolicy(process.env);
const dataDir = path.resolve(process.env.DATA_DIR || path.join(root, "data"));
const collectionNames = ["expenses", "inventory", "recipes", "sales"];
const requestTimeoutMs = 30_000;
const gracefulShutdownMs = 10_000;

let storage;
let collections;
let settings;
let activity;
let priceHistory;
let supplierPrices;
let trendReports;
let squareConnection;
let squareService;
let receiptItems;
let receipts;
let customers;
let receiptParser;
let httpServer;
let recoveryManager;
let applicationReady = false;
let shuttingDown = false;
const receiptDrafts = new Map();
const squareDiagnostics = {
  latestWebhookReceivedAt: "",
  latestSquarePaymentId: "",
  latestSaleId: "",
};

const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
};

function bootstrap() {
  receiptParser = createReceiptParser({ env: process.env, logger: console });
  console.log(`[receipts] OpenAI Vision ${receiptParser.configured ? "configured" : "not configured"}.`);
  recoveryManager = createRecoveryManager({
    connect: initializeApplicationState,
    onReady: () => { applicationReady = true; },
    onUnavailable: () => { applicationReady = false; },
    logger: console,
  });
  startServer();
  void recoveryManager.start();
  process.once("SIGTERM", () => gracefulShutdown("SIGTERM"));
  process.once("SIGINT", () => gracefulShutdown("SIGINT"));
}

async function initializeApplicationState() {
  const nextStorage = await createStorage({ dataDir, env: process.env, logger: console });
  const state = await nextStorage.initialize();
  storage = nextStorage;
  collections = Object.fromEntries(
    collectionNames.map((name) => [name, (state.collections[name] || []).map((item) => migrateRecord(name, item))]),
  );
  settings = { ...defaultSettings(), ...(state.settings || {}) };
  activity = state.activity || [];
  priceHistory = state.priceHistory || [];
  supplierPrices = state.supplierPrices || [];
  trendReports = state.trendReports || [];
  squareConnection = state.squareConnection || {};
  receiptItems = state.receiptItems || [];
  receipts = state.receipts || [];
  customers = state.customers || [];
  squareService = createSquareService({
    env: process.env,
    storage,
    connection: squareConnection,
    getSales: () => collections.sales,
    saveSales: () => saveCollection("sales"),
    logActivity,
    upsertCustomer: upsertSquareCustomer,
  });
  const squareStatus = squareService.status();
  console.log(`[square] ${squareStatus.configured ? "Configured" : "Not configured"}; ${squareStatus.connected ? "connected" : "disconnected"}.`);
  console.log(`[square] merchant stored: ${squareStatus.merchantId || "none"}`);
  console.log(`[square] token expiration: ${squareStatus.tokenExpiresAt || "none"}`);
  console.log(`[square] refresh token present: ${squareStatus.refreshTokenPresent}`);
  console.log(`Storage mode: ${storage.mode}`);
  if (storage.mode === "json") console.log(`Persistent data directory: ${dataDir}`);
  return { storageMode: storage.mode };
}

function startServer() {
  httpServer = http.createServer(async (req, res) => {
    const requestTimer = setTimeout(() => {
      if (!res.writableEnded) {
        sendJson(res, 504, {
          error: { code: "REQUEST_TIMEOUT", message: "The request timed out.", retryable: true },
        });
      }
    }, requestTimeoutMs);
    requestTimer.unref?.();
    res.once("finish", () => clearTimeout(requestTimer));
    res.once("close", () => clearTimeout(requestTimer));
    try {
      const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

      if (url.pathname === "/api/health") {
        const recovery = recoveryManager.status();
        return sendJson(res, 200, {
          ok: true,
          service: "bakeryops-ai",
          database: {
            ready: applicationReady,
            state: recovery.state,
            storageMode: applicationReady ? storage.mode : null,
            attempts: recovery.attempts,
            retryAt: recovery.retryAt || null,
          },
          authentication: {
            required: authPolicy.required,
            configured: authPolicy.configured,
          },
        }, noStoreHeaders());
      }

      if (authPolicy.required && !authPolicy.configured) {
        return sendAuthenticationUnavailable(res);
      }

      const independentlyAuthenticatedSquareRoute =
        url.pathname === "/api/square/webhook" || url.pathname === "/api/square/oauth/callback";
      if (!independentlyAuthenticatedSquareRoute && !authPolicy.isAuthorized(req)) {
        return requireLogin(res);
      }

      if (url.pathname.startsWith("/api/") && !applicationReady) {
        return sendDatabaseUnavailable(res);
      }

      if (url.pathname === "/api/square/oauth/callback" && req.method === "GET") {
        await squareService.completeOAuth({
          code: url.searchParams.get("code"),
          state: url.searchParams.get("state"),
          error: url.searchParams.get("error"),
          errorDescription: url.searchParams.get("error_description"),
        });
        res.writeHead(302, { Location: "/?square=connected" });
        return res.end();
      }

      if (url.pathname === "/api/square/webhook" && req.method === "POST") {
        console.log("[square] webhook received");
        console.log("[square-test] webhook received");
        squareDiagnostics.latestWebhookReceivedAt = new Date().toISOString();
        const rawBody = await readRawBody(req);
        const signature = req.headers["x-square-hmacsha256-signature"];
        if (!squareService.verifyWebhook(rawBody, signature)) {
          return sendJson(res, 401, { error: "Invalid Square webhook signature" });
        }
        let event;
        try { event = JSON.parse(rawBody); }
        catch { return sendJson(res, 400, { error: "Invalid JSON body" }); }
        console.log(`[square] event type: ${event?.type || "unknown"}`);
        const squarePaymentId = squarePaymentIdFromWebhook(event);
        if (event?.type === "payment.created") console.log("[square-test] payment created");
        if (squarePaymentId) squareDiagnostics.latestSquarePaymentId = squarePaymentId;
        const result = await squareService.processWebhook(event);
        if (result.synced) {
          const sale = latestSquareSale(squarePaymentId, squareOrderIdFromWebhook(event));
          if (sale) {
            squareDiagnostics.latestSaleId = sale.id;
            console.log("[square-test] sale inserted");
          }
        }
        return sendJson(res, 200, result);
      }

      if (url.pathname === "/api/square/status" && req.method === "GET") {
        return sendJson(res, 200, squareService.status());
      }

      if (url.pathname === "/api/square/diagnostics" && req.method === "GET") {
        const squareStatus = squareService.status();
        return sendJson(res, 200, {
          squareConnected: Boolean(squareStatus.connected),
          webhookConfigured: squareWebhookConfigured(),
          latestWebhookReceivedAt: squareDiagnostics.latestWebhookReceivedAt,
          latestSquarePaymentId: squareDiagnostics.latestSquarePaymentId,
          latestSaleId: squareDiagnostics.latestSaleId,
          salesCount: collections.sales.length,
        });
      }

      if (url.pathname === "/api/square/oauth-url" && req.method === "GET") {
        const destination = await squareService.startOAuth();
        return sendJson(res, 200, { url: destination }, noStoreHeaders());
      }

      if (url.pathname === "/api/square/connect" && req.method === "GET") {
        const destination = await squareService.startOAuth();
        res.writeHead(302, { Location: destination, ...noStoreHeaders() });
        return res.end();
      }

      if (url.pathname === "/api/square/disconnect" && req.method === "POST") {
        await squareService.disconnect();
        return sendJson(res, 200, squareService.status());
      }

      if (url.pathname === "/api/square/sync" && req.method === "POST") {
        const result = await squareService.syncRecentSales();
        return sendJson(res, 200, result);
      }

      if (url.pathname === "/api/receipts/parse" && req.method === "POST") {
        return parseReceiptUpload(req, res);
      }

      if (url.pathname === "/api/receipts" && req.method === "GET") {
        return sendJson(res, 200, receipts);
      }

      if (url.pathname === "/api/receipts/approve" && req.method === "POST") {
        return approveReceipt(req, res);
      }

      if (url.pathname === "/api/dashboard" && req.method === "GET") {
        const salesCursor = new Date().toISOString();
        const [liveSales, liveInventory] = await Promise.all([
          storage.loadCollection("sales"),
          storage.loadCollection("inventory"),
        ]);
        collections.sales = liveSales.map((item) => migrateRecord("sales", item));
        collections.inventory = liveInventory.map((item) => migrateRecord("inventory", item));
        console.log(`[square-test] dashboard sale count: ${collections.sales.length}`);
        return sendJson(res, 200, { ...buildDashboard(), salesCursor }, noStoreHeaders());
      }

      if (url.pathname === "/api/sales/updates" && req.method === "GET") {
        const since = normalizeSalesCursor(url.searchParams.get("since"));
        const cursor = new Date().toISOString();
        const updates = (await storage.loadSalesSince(since)).map((item) => migrateRecord("sales", item));
        collections.sales = mergeSales(collections.sales, updates).sales;
        return sendJson(res, 200, buildSalesUpdatePayload(updates, cursor), noStoreHeaders());
      }

      if (url.pathname === "/api/settings" && req.method === "GET") {
        return sendJson(res, 200, settings);
      }

      if (url.pathname === "/api/settings" && req.method === "PUT") {
        const input = await readJsonBody(req);
        Object.assign(settings, sanitizeSettings(input));
        await saveSettings();
        await logActivity("settings.updated", "Owner settings updated");
        return sendJson(res, 200, settings);
      }

      if (url.pathname === "/api/activity" && req.method === "GET") {
        return sendJson(res, 200, activity);
      }

      if (url.pathname === "/api/customers" && req.method === "GET") {
        customers = await storage.loadCustomers();
        const sorted = sortCustomers(customers, url.searchParams.get("sort") || "latestPurchase");
        return sendJson(res, 200, sorted.map(toSafeCustomer), noStoreHeaders());
      }

      if (url.pathname === "/api/customer-insights" && req.method === "GET") {
        customers = await storage.loadCustomers();
        return sendJson(res, 200, buildCustomerInsights(customers), noStoreHeaders());
      }

      if (url.pathname === "/api/trends" && req.method === "GET") {
        return await listFoodTrends(url, res);
      }

      if (url.pathname === "/api/trends" && req.method === "POST") {
        return await createFoodTrend(req, res);
      }

      const trendAnalyzeMatch = url.pathname.match(/^\/api\/trends\/([^/]+)\/analyze$/);
      if (trendAnalyzeMatch && req.method === "POST") {
        return await analyzeFoodTrend(decodeURIComponent(trendAnalyzeMatch[1]), res);
      }

      const trendMatch = url.pathname.match(/^\/api\/trends\/([^/]+)$/);
      if (trendMatch && req.method === "PATCH") {
        return await updateFoodTrend(decodeURIComponent(trendMatch[1]), req, res);
      }

      if (url.pathname === "/api/price-history" && req.method === "GET") {
        return sendJson(res, 200, priceHistory);
      }

      if (url.pathname === "/api/backup.json" && req.method === "GET") {
        return exportBackup(res);
      }

      if (url.pathname === "/api/reports/monthly" && req.method === "GET") {
        return sendJson(res, 200, buildMonthlyReport(url.searchParams.get("month")));
      }

      if (url.pathname === "/api/purchasing-intelligence" && req.method === "GET") {
        const [liveInventory, liveSales, liveRecipes, liveExpenses, livePrices, liveReceiptItems] = await Promise.all([
          storage.loadCollection("inventory"),
          storage.loadCollection("sales"),
          storage.loadCollection("recipes"),
          storage.loadCollection("expenses"),
          storage.loadPriceHistory(),
          storage.loadReceiptItems(),
        ]);
        collections.inventory = liveInventory.map((item) => migrateRecord("inventory", item));
        collections.sales = liveSales.map((item) => migrateRecord("sales", item));
        collections.recipes = liveRecipes.map((item) => migrateRecord("recipes", item));
        collections.expenses = liveExpenses.map((item) => migrateRecord("expenses", item));
        priceHistory = livePrices;
        receiptItems = liveReceiptItems;
        return sendJson(res, 200, buildPurchasingDashboard(), noStoreHeaders());
      }

      if (url.pathname === "/api/shopping-list" && req.method === "GET") {
        return sendJson(res, 200, buildShoppingList());
      }

      const importMatch = url.pathname.match(/^\/api\/import\/(expenses|sales|inventory)$/);
      if (importMatch && req.method === "POST") {
        return importRecords(importMatch[1], req, res);
      }

      const exportMatch = url.pathname.match(/^\/api\/export\/(expenses|sales)\.csv$/);
      if (exportMatch && req.method === "GET") {
        return exportCsv(res, exportMatch[1]);
      }

      const collectionMatch = url.pathname.match(/^\/api\/(expenses|sales|inventory|recipes)$/);
      if (collectionMatch && req.method === "GET") {
        const collectionName = collectionMatch[1];
        if (collectionName === "inventory") {
          collections.inventory = (await storage.loadCollection("inventory")).map((item) => migrateRecord("inventory", item));
        }
        return sendJson(res, 200, collections[collectionName]);
      }
      if (collectionMatch && req.method === "POST") {
        return createRecord(collectionMatch[1], req, res);
      }

      const recordMatch = url.pathname.match(/^\/api\/(expenses|sales|inventory|recipes)\/([^/]+)$/);
      const duplicateMatch = url.pathname.match(/^\/api\/recipes\/([^/]+)\/duplicate$/);
      if (duplicateMatch && req.method === "POST") {
        return duplicateRecipe(decodeURIComponent(duplicateMatch[1]), res);
      }
      if (recordMatch && req.method === "PUT") {
        return updateRecord(recordMatch[1], decodeURIComponent(recordMatch[2]), req, res);
      }
      if (recordMatch && req.method === "DELETE") {
        return deleteRecord(recordMatch[1], decodeURIComponent(recordMatch[2]), res);
      }

      return serveStatic(url.pathname, res);
    } catch (error) {
      console.error(error);
      if (isDatabaseFailure(error)) {
        applicationReady = false;
        recoveryManager.reportFailure(error);
        return sendDatabaseUnavailable(res);
      }
      const status = error.statusCode || 500;
      sendJson(res, status, { error: status === 500 ? "Internal server error" : error.message });
    }
  });
  httpServer.requestTimeout = requestTimeoutMs;
  httpServer.headersTimeout = Math.min(requestTimeoutMs, 15_000);
  httpServer.keepAliveTimeout = 5_000;
  httpServer.listen(port, host, () => {
    const address = httpServer.address();
    console.log(`BakeryOps AI running on ${host}:${address?.port || port}`);
    if (authPolicy.production && !authPolicy.configured) {
      console.error("[auth] Production access is disabled until BAKERYOPS_PASSWORD is configured.");
    } else if (!authPolicy.required) {
      console.log("[auth] Local development authentication is disabled.");
    }
  });
}

bootstrap();

function sendDatabaseUnavailable(res) {
  const recovery = recoveryManager.status();
  const retrySeconds = recovery.retryAt
    ? Math.max(1, Math.ceil((Date.parse(recovery.retryAt) - Date.now()) / 1000))
    : 2;
  return sendJson(res, 503, {
    error: {
      code: "DATABASE_UNAVAILABLE",
      message: "BakeryOps data is temporarily unavailable. Recovery is running in the background.",
      retryable: true,
    },
    database: {
      state: recovery.state,
      attempts: recovery.attempts,
      retryAt: recovery.retryAt || null,
    },
  }, { ...noStoreHeaders(), "Retry-After": String(retrySeconds) });
}

function sendAuthenticationUnavailable(res) {
  return sendJson(res, 503, {
    error: {
      code: "AUTH_CONFIGURATION_REQUIRED",
      message: "Production authentication is not configured.",
      retryable: false,
    },
  }, noStoreHeaders());
}

function isDatabaseFailure(error) {
  return /^\[storage\]/i.test(String(error?.message || "")) ||
    /Supabase|PostgREST|PGRST\d+/i.test(String(error?.message || ""));
}

function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal} received; closing HTTP server.`);
  recoveryManager.stop();
  const forceTimer = setTimeout(() => {
    console.error("[shutdown] graceful shutdown timed out");
    process.exitCode = 1;
    httpServer.closeAllConnections?.();
  }, gracefulShutdownMs);
  forceTimer.unref?.();
  httpServer.close(() => {
    clearTimeout(forceTimer);
    console.log("[shutdown] complete");
  });
}

function squareWebhookConfigured() {
  return Boolean(process.env.SQUARE_WEBHOOK_SIGNATURE_KEY && process.env.SQUARE_WEBHOOK_URL);
}

function squarePaymentIdFromWebhook(event) {
  return event?.data?.id || event?.data?.object?.payment?.id || event?.data?.object?.payment_updated?.payment_id || "";
}

function squareOrderIdFromWebhook(event) {
  return event?.data?.object?.payment?.order_id || event?.data?.object?.order?.id ||
    event?.data?.object?.order_updated?.order_id || event?.data?.object?.order_created?.order_id || "";
}

function latestSquareSale(paymentId, orderId) {
  return collections.sales.find((sale) =>
    (paymentId && sale.squarePaymentId === paymentId) ||
    (orderId && sale.squareOrderId === orderId),
  );
}

async function listFoodTrends(url, res) {
  const query = parseTrendQuery(url.searchParams);
  const allTrends = await storage.loadFoodTrends();
  return sendJson(res, 200, {
    trends: filterAndSortTrends(allTrends, query),
    summary: buildTrendSummary(allTrends),
    sourceDisclosure: "Trends are manually collected or added through configured providers; they are not live TikTok data.",
  }, noStoreHeaders());
}

async function createFoodTrend(req, res) {
  const input = await readJsonBody(req);
  const now = new Date().toISOString();
  const trend = normalizeTrendInput(input, { id: crypto.randomUUID(), now, dataOrigin: "manual" });
  const trends = await storage.loadFoodTrends();
  if (findDuplicate(trends, trend)) {
    const error = new Error("A trend with this title or source URL already exists");
    error.statusCode = 409;
    throw error;
  }
  await storage.upsertFoodTrend(trend);
  await logActivity("food_trends.created", "A manually curated food trend was added");
  return sendJson(res, 201, trend, noStoreHeaders());
}

async function updateFoodTrend(id, req, res) {
  validateUuid(id);
  const input = await readJsonBody(req);
  const trends = await storage.loadFoodTrends();
  const existing = trends.find((trend) => trend.id === id);
  if (!existing) return sendJson(res, 404, { error: "Trend not found" });
  const updated = normalizeTrendPatch(input, existing);
  await storage.upsertFoodTrend(updated);
  await logActivity("food_trends.updated", "A food trend was updated");
  return sendJson(res, 200, updated, noStoreHeaders());
}

async function analyzeFoodTrend(id, res) {
  validateUuid(id);
  const trends = await storage.loadFoodTrends();
  const existing = trends.find((trend) => trend.id === id);
  if (!existing) return sendJson(res, 404, { error: "Trend not found" });
  const inventory = await storage.loadCollection("inventory");
  const analyzed = analyzeTrend(existing, { inventory });
  await storage.upsertFoodTrend(analyzed);
  await logActivity("food_trends.analyzed", "A food trend recommendation was refreshed");
  return sendJson(res, 200, analyzed, noStoreHeaders());
}

function validateUuid(value) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw validationError("Trend ID is invalid");
  }
  return value;
}

async function createRecord(collectionName, req, res) {
  const input = await readJsonBody(req);
  if (collectionName === "inventory" || collectionName === "recipes") {
    collections.inventory = (await storage.loadCollection("inventory")).map((item) => migrateRecord("inventory", item));
  }
  const record = normalizeRecord(collectionName, input, {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  });
  collections[collectionName].unshift(record);
  await saveCollection(collectionName);
  if (collectionName === "inventory") await recordIngredientPrice(record, "created");
  await logActivity(`${collectionName}.created`, `${recordLabel(collectionName, record)} created`);
  sendJson(res, 201, enrichRecord(collectionName, record));
}

async function parseReceiptUpload(req, res) {
  purgeReceiptDrafts();
  const fileName = safeUploadName(req.headers["x-file-name"]);
  const mimeType = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
  const configuredLimit = Number(process.env.MAX_RECEIPT_UPLOAD_MB || 15);
  const maxMegabytes = Number.isFinite(configuredLimit) ? Math.max(1, Math.min(25, configuredLimit)) : 15;
  const fileBuffer = await readBufferBody(req, maxMegabytes * 1024 * 1024);
  if (!fileBuffer.length) throw validationError("Choose a receipt image to upload");

  const receiptId = crypto.randomUUID();
  const receipt = {
    id: receiptId, expenseId: "", fileName, mimeType, fileSize: fileBuffer.length,
    extractionSource: "openai_vision", storeName: "", receiptDate: "",
    subtotal: 0, tax: 0, total: 0, itemCount: 0, status: "processing",
    errorCode: "", uploadedAt: new Date().toISOString(), approvedAt: "",
  };
  receipts.unshift(receipt);
  await storage.saveReceipts(receipts);

  try {
    const parsed = await receiptParser.parse({ fileName, mimeType, fileBuffer });
    Object.assign(receipt, {
      storeName: parsed.storeName,
      receiptDate: parsed.receiptDate,
      subtotal: parsed.subtotal,
      tax: parsed.tax,
      total: parsed.total,
      itemCount: parsed.items.length,
      status: "review",
    });
    await storage.saveReceipts(receipts);
    const draftId = crypto.randomUUID();
    receiptDrafts.set(draftId, {
      receiptId,
      parsed,
      expiresAt: Date.now() + 30 * 60 * 1000,
      approving: false,
    });
    return sendJson(res, 200, { draftId, receiptId, ...parsed });
  } catch (error) {
    receipt.status = "failed";
    receipt.errorCode = error.code || "ai_failed";
    await storage.saveReceipts(receipts).catch((saveError) => {
      console.error(`[receipts] Could not save failure metadata (${saveError.name}).`);
    });
    throw error;
  }
}

async function approveReceipt(req, res) {
  purgeReceiptDrafts();
  const input = await readJsonBody(req);
  const draft = receiptDrafts.get(String(input.draftId || ""));
  if (!draft) {
    const error = validationError("Receipt review expired. Upload the receipt again.");
    error.statusCode = 404;
    throw error;
  }
  if (draft.approving) {
    const error = validationError("Receipt approval is already in progress.");
    error.statusCode = 409;
    throw error;
  }
  const reviewed = normalizeReceiptReview(input);
  draft.approving = true;
  const now = new Date().toISOString();
  const expenseId = crypto.randomUUID();
  const expense = {
    id: expenseId,
    date: reviewed.receiptDate,
    vendor: reviewed.storeName,
    category: receiptExpenseCategory(reviewed.items),
    amount: reviewed.total,
    notes: `Receipt upload. Subtotal: $${reviewed.subtotal.toFixed(2)}; tax: $${reviewed.tax.toFixed(2)}.`,
    createdAt: now,
  };
  collections.inventory = (await storage.loadCollection("inventory")).map((item) => migrateRecord("inventory", item));
  const snapshot = {
    expenses: structuredClone(collections.expenses),
    inventory: structuredClone(collections.inventory),
    receiptItems: structuredClone(receiptItems),
    receipts: structuredClone(receipts),
    priceHistory: structuredClone(priceHistory),
  };

  collections.expenses.unshift(expense);
  const inventoryResults = applyReceiptItemsToInventory(collections.inventory, reviewed.items, {
    storeName: reviewed.storeName,
    now,
    createId: () => crypto.randomUUID(),
  });
  const createdItems = inventoryResults.map(({ item, inventoryItem }) => {
    if (inventoryItem) {
      priceHistory.unshift({
        id: crypto.randomUUID(),
        inventoryId: inventoryItem.id,
        ingredientName: inventoryItem.ingredientName,
        supplier: reviewed.storeName,
        costPerUnit: item.unitPrice,
        unit: item.unit,
        recordedAt: now,
        reason: "receipt",
      });
    }
    return {
      id: crypto.randomUUID(),
      expenseId,
      receiptId: draft.receiptId,
      inventoryItemId: inventoryItem?.id || "",
      storeName: reviewed.storeName,
      receiptDate: reviewed.receiptDate,
      ...item,
      createdAt: now,
    };
  });
  receiptItems.unshift(...createdItems);
  const receipt = receipts.find((item) => item.id === draft.receiptId);
  if (receipt) {
    Object.assign(receipt, {
      expenseId,
      storeName: reviewed.storeName,
      receiptDate: reviewed.receiptDate,
      subtotal: reviewed.subtotal,
      tax: reviewed.tax,
      total: reviewed.total,
      itemCount: createdItems.length,
      status: "approved",
      errorCode: "",
      approvedAt: now,
    });
  }

  try {
    await saveReceiptApproval();
  } catch (error) {
    collections.expenses = snapshot.expenses;
    collections.inventory = snapshot.inventory;
    receiptItems = snapshot.receiptItems;
    receipts = snapshot.receipts;
    priceHistory = snapshot.priceHistory;
    await saveReceiptApproval().catch((rollbackError) => console.error(`[receipts] Rollback persistence failed (${rollbackError.name}).`));
    draft.approving = false;
    throw error;
  }
  receiptDrafts.delete(String(input.draftId));
  await logActivity("receipt.approved", `Receipt from ${reviewed.storeName} approved with ${createdItems.length} items`)
    .catch((error) => console.error(`[receipts] Activity logging failed (${error.name}).`));
  return sendJson(res, 201, {
    expense,
    receiptItemCount: createdItems.length,
    inventoryUpdatedCount: createdItems.filter((item) => item.updateInventory).length,
  });
}

async function saveReceiptApproval() {
  await storage.saveCollection("expenses", collections.expenses);
  await storage.saveCollection("inventory", collections.inventory);
  await storage.saveReceipts(receipts);
  await storage.saveReceiptItems(receiptItems);
  await storage.savePriceHistory(priceHistory);
}

function normalizeReceiptReview(input) {
  const items = Array.isArray(input.items) ? input.items.map((item) => {
    const unit = allowedValue(item.unit, ["lb", "oz", "g", "kg", "count", "dozen", "gallon", "unknown"], "Item unit");
    const isDiscount = Boolean(item.isDiscount);
    const isFee = Boolean(item.isFee);
    const isDeposit = Boolean(item.isDeposit);
    return {
      itemName: requiredText(item.itemName, "Item name"),
      rawLine: optionalText(item.rawLine).slice(0, 300),
      quantity: requiredPositiveNumber(item.quantity, "Item quantity"),
      unit,
      unitPrice: requiredMoney(item.unitPrice, "Unit price"),
      totalPrice: requiredSignedMoney(item.totalPrice, "Total price"),
      category: allowedValue(item.category, ["Ingredients", "Packaging", "Equipment", "Utilities", "Other"], "Item category"),
      updateInventory: Boolean(item.updateInventory) && unit !== "unknown" && !isDiscount && !isFee && !isDeposit,
      isDiscount,
      isFee,
      isDeposit,
    };
  }) : [];
  if (!items.length) throw validationError("No readable items found");
  return {
    storeName: requiredText(input.storeName, "Store name"),
    receiptDate: requiredDate(input.receiptDate, "Receipt date"),
    subtotal: requiredMoney(input.subtotal, "Subtotal"),
    tax: requiredMoney(input.tax, "Tax"),
    total: requiredMoney(input.total, "Total"),
    items,
  };
}

function receiptExpenseCategory(items) {
  const counts = new Map();
  for (const item of items) counts.set(item.category, (counts.get(item.category) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "Other";
}


function purgeReceiptDrafts() {
  const now = Date.now();
  for (const [id, draft] of receiptDrafts) if (draft.expiresAt <= now) receiptDrafts.delete(id);
}

async function updateRecord(collectionName, id, req, res) {
  if (collectionName === "inventory" || collectionName === "recipes") {
    collections.inventory = (await storage.loadCollection("inventory")).map((item) => migrateRecord("inventory", item));
  }
  const index = collections[collectionName].findIndex((record) => record.id === id);
  if (index === -1) return sendJson(res, 404, { error: "Record not found" });

  const input = await readJsonBody(req);
  const existing = collections[collectionName][index];
  const record = normalizeRecord(collectionName, input, {
    id: existing.id,
    createdAt: existing.createdAt,
    updatedAt: new Date().toISOString(),
  });
  collections[collectionName][index] = record;
  await saveCollection(collectionName);
  if (
    collectionName === "inventory" &&
    (existing.costPerUnit !== record.costPerUnit || existing.supplier !== record.supplier)
  ) {
    await recordIngredientPrice(record, "updated");
  }
  await logActivity(`${collectionName}.updated`, `${recordLabel(collectionName, record)} updated`);
  sendJson(res, 200, enrichRecord(collectionName, record));
}

async function deleteRecord(collectionName, id, res) {
  if (collectionName === "inventory") {
    collections.inventory = (await storage.loadCollection("inventory")).map((item) => migrateRecord("inventory", item));
  }
  const index = collections[collectionName].findIndex((record) => record.id === id);
  if (index === -1) return sendJson(res, 404, { error: "Record not found" });
  const [deleted] = collections[collectionName].splice(index, 1);
  await saveCollection(collectionName);
  if (collectionName === "expenses") {
    receiptItems = receiptItems.filter((item) => item.expenseId !== id);
    await storage.saveReceiptItems(receiptItems);
    receipts.forEach((receipt) => {
      if (receipt.expenseId === id) receipt.expenseId = "";
    });
    await storage.saveReceipts(receipts);
  }
  if (collectionName === "inventory") {
    receiptItems.forEach((item) => {
      if (item.inventoryItemId === id) item.inventoryItemId = "";
    });
    await storage.saveReceiptItems(receiptItems);
  }
  await logActivity(`${collectionName}.deleted`, `${recordLabel(collectionName, deleted)} deleted`);
  sendJson(res, 200, { ok: true });
}

async function duplicateRecipe(id, res) {
  const source = collections.recipes.find((recipe) => recipe.id === id);
  if (!source) return sendJson(res, 404, { error: "Recipe not found" });
  const copy = {
    ...source,
    id: crypto.randomUUID(),
    recipeName: `${source.recipeName} Copy`,
    ingredients: source.ingredients.map((ingredient) => ({ ...ingredient })),
    createdAt: new Date().toISOString(),
    updatedAt: undefined,
  };
  collections.recipes.unshift(copy);
  await saveCollection("recipes");
  await logActivity("recipes.duplicated", `${source.recipeName} duplicated`);
  sendJson(res, 201, enrichRecipe(copy));
}

function normalizeRecord(collectionName, input, metadata) {
  if (collectionName === "expenses") {
    return {
      ...metadata,
      date: requiredDate(input.date, "Expense date"),
      vendor: requiredText(input.vendor, "Vendor"),
      category: allowedValue(
        input.category,
        ["Ingredients", "Packaging", "Equipment", "Utilities", "Other"],
        "Category",
      ),
      amount: requiredMoney(input.amount ?? input.total, "Amount"),
      notes: optionalText(input.notes),
    };
  }

  if (collectionName === "sales") {
    const saleAmount = requiredMoney(input.saleAmount ?? input.total, "Sale amount");
    return {
      ...metadata,
      date: requiredDate(input.date, "Sale date"),
      product: requiredText(input.product ?? input.productName, "Product"),
      quantitySold: requiredPositiveNumber(input.quantitySold ?? input.quantity, "Quantity sold"),
      saleAmount,
      grossAmount: saleAmount,
      refundedAmount: 0,
      status: "completed",
    };
  }

  if (collectionName === "inventory") {
    return {
      ...metadata,
      ingredientName: requiredText(input.ingredientName ?? input.name, "Ingredient name"),
      category: allowedValue(
        input.category || "Ingredients",
        ["Ingredients", "Packaging", "Equipment", "Utilities", "Other"],
        "Inventory category",
      ),
      quantity: requiredNonNegativeNumber(input.quantity ?? input.currentQuantity, "Quantity"),
      unit: allowedValue(
        input.unit,
        ["lb", "oz", "g", "kg", "count", "dozen", "gallon"],
        "Unit",
      ),
      minimumThreshold: requiredNonNegativeNumber(input.minimumThreshold, "Minimum threshold"),
      supplier: optionalText(input.supplier),
      costPerUnit: requiredNonNegativeNumber(input.costPerUnit ?? 0, "Cost per unit"),
    };
  }

  const ingredients = normalizeIngredients(input.ingredients);
  return {
    ...metadata,
    recipeName: requiredText(input.recipeName ?? input.name, "Recipe name"),
    category: allowedValue(
      input.category,
      ["Cookies", "Cakes", "Cupcakes", "Brownies", "Pastries", "Custom"],
      "Category",
    ),
    yieldQuantity: requiredPositiveNumber(input.yieldQuantity, "Yield quantity"),
    yieldUnit: requiredText(input.yieldUnit, "Yield unit"),
    sellingPrice: requiredNonNegativeNumber(input.sellingPrice ?? 0, "Selling price"),
    preparationNotes: optionalText(input.preparationNotes ?? input.notes),
    ingredients,
  };
}

function normalizeIngredients(value) {
  let ingredients = value;
  if (typeof value === "string") {
    try {
      ingredients = JSON.parse(value);
    } catch {
      ingredients = [];
    }
  }
  if (!Array.isArray(ingredients) || !ingredients.length) {
    throw validationError("Add at least one recipe ingredient");
  }

  return ingredients.map((ingredient) => ({
    inventoryId: optionalText(ingredient.inventoryId),
    ingredientName: requiredText(
      ingredient.ingredientName ?? ingredient.name,
      "Ingredient name",
    ),
    quantity: requiredPositiveNumber(ingredient.quantity, "Ingredient quantity"),
    unit: allowedValue(
      ingredient.unit,
      ["lb", "oz", "g", "kg", "count", "dozen", "gallon"],
      "Ingredient unit",
    ),
  }));
}

async function importRecords(collectionName, req, res) {
  const input = await readJsonBody(req);
  if (!Array.isArray(input.records) || !input.records.length) {
    throw validationError("Import contains no records");
  }
  if (input.records.length > 1000) throw validationError("Import is limited to 1,000 rows");

  const imported = [];
  const errors = [];
  for (const [index, row] of input.records.entries()) {
    try {
      const record = normalizeRecord(collectionName, row, {
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
      });
      collections[collectionName].push(record);
      imported.push(record);
      if (collectionName === "inventory") await recordIngredientPrice(record, "imported");
    } catch (error) {
      errors.push({ row: index + 2, error: error.message });
    }
  }

  if (imported.length) {
    collections[collectionName].sort((a, b) => String(b.date || b.createdAt).localeCompare(String(a.date || a.createdAt)));
    await saveCollection(collectionName);
    await logActivity(
      `${collectionName}.imported`,
      `${imported.length} ${collectionName} record${imported.length === 1 ? "" : "s"} imported`,
    );
  }
  sendJson(res, imported.length ? 200 : 400, {
    imported: imported.length,
    rejected: errors.length,
    errors: errors.slice(0, 25),
  });
}

function buildMonthlyReport(requestedMonth) {
  const currentMonth = localDateKey(new Date()).slice(0, 7);
  const month = /^\d{4}-\d{2}$/.test(requestedMonth || "") ? requestedMonth : currentMonth;
  const sales = collections.sales.filter((sale) => isRevenueSale(sale) && sale.date.startsWith(month));
  const expenses = collections.expenses.filter((expense) => expense.date.startsWith(month));
  const revenue = sum(sales, "saleAmount");
  const expenseTotal = sum(expenses, "amount");
  const products = new Map();
  sales.forEach((sale) => {
    const item = products.get(sale.product) || { product: sale.product, quantitySold: 0, revenue: 0 };
    item.quantitySold = round(item.quantitySold + effectiveQuantity(sale));
    item.revenue = round(item.revenue + sale.saleAmount);
    products.set(sale.product, item);
  });
  const categories = new Map();
  expenses.forEach((expense) => {
    categories.set(expense.category, round((categories.get(expense.category) || 0) + expense.amount));
  });
  return {
    month,
    revenue,
    expenses: expenseTotal,
    estimatedProfit: round(revenue - expenseTotal),
    salesCount: sales.length,
    expenseCount: expenses.length,
    topProducts: [...products.values()].sort((a, b) => b.revenue - a.revenue),
    expenseCategories: [...categories.entries()]
      .map(([category, amount]) => ({ category, amount }))
      .sort((a, b) => b.amount - a.amount),
  };
}

function buildPurchasingDashboard() {
  return buildPurchasingIntelligence({
    inventory: collections.inventory,
    sales: collections.sales,
    recipes: collections.recipes,
    priceHistory,
    expenses: collections.expenses,
    receiptItems,
    now: new Date(),
    targetMultiplier: Number(settings.shoppingTargetMultiplier || 2),
  });
}

function buildShoppingList() {
  const multiplier = Number(settings.shoppingTargetMultiplier || 2);
  const items = collections.inventory
    .filter((item) => item.quantity <= item.minimumThreshold)
    .map((item) => {
      const targetQuantity = round(item.minimumThreshold * multiplier);
      const quantityToBuy = round(Math.max(targetQuantity - item.quantity, 0));
      return {
        inventoryId: item.id,
        ingredientName: item.ingredientName,
        currentQuantity: item.quantity,
        minimumThreshold: item.minimumThreshold,
        targetQuantity,
        quantityToBuy,
        unit: item.unit,
        supplier: item.supplier,
        costPerUnit: item.costPerUnit,
        estimatedCost: round(quantityToBuy * item.costPerUnit),
      };
    });
  return {
    targetMultiplier: multiplier,
    items,
    estimatedTotal: round(items.reduce((total, item) => total + item.estimatedCost, 0)),
  };
}

function exportBackup(res) {
  const backup = {
    application: "BakeryOps AI",
    schemaVersion: 5,
    exportedAt: new Date().toISOString(),
    settings,
    expenses: collections.expenses,
    inventory: collections.inventory,
    recipes: collections.recipes,
    sales: collections.sales,
    customers,
    receiptItems,
    receipts,
    priceHistory,
    supplierPrices,
    trendReports,
    activity,
  };
  const stamp = localDateKey(new Date());
  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Disposition": `attachment; filename="bakeryops-backup-${stamp}.json"`,
  });
  res.end(JSON.stringify(backup, null, 2));
}

async function recordIngredientPrice(item, reason) {
  if (!(item.costPerUnit > 0)) return;
  priceHistory.unshift({
    id: crypto.randomUUID(),
    inventoryId: item.id,
    ingredientName: item.ingredientName,
    supplier: item.supplier,
    costPerUnit: item.costPerUnit,
    unit: item.unit,
    recordedAt: new Date().toISOString(),
    reason,
  });
  await storage.savePriceHistory(priceHistory);
}

async function logActivity(action, description) {
  activity.unshift({
    id: crypto.randomUUID(),
    action,
    description,
    timestamp: new Date().toISOString(),
  });
  if (activity.length > 500) activity.length = 500;
  await storage.saveActivity(activity);
}

function recordLabel(collectionName, record) {
  if (collectionName === "expenses") return `Expense from ${record.vendor}`;
  if (collectionName === "sales") return `Sale for ${record.product}`;
  if (collectionName === "inventory") return `Inventory item ${record.ingredientName}`;
  return `Recipe ${record.recipeName}`;
}

function buildDashboard() {
  const now = new Date();
  const todayKey = localDateKey(now);
  const monthKey = todayKey.slice(0, 7);
  const salesSummary = buildSalesSummary(collections.sales, now);
  const monthExpenses = collections.expenses.filter((expense) => expense.date.startsWith(monthKey));
  const monthRevenue = salesSummary.monthSales;
  const monthExpenseTotal = sum(monthExpenses, "amount");
  const inventory = buildInventoryIntelligence(collections.inventory);


  return {
    financials: {
      revenueToday: salesSummary.todaySales,
      revenueThisWeek: salesSummary.weekSales,
      revenueThisMonth: salesSummary.monthSales,
      expensesThisMonth: monthExpenseTotal,
      estimatedProfit: round(monthRevenue - monthExpenseTotal),
    },
    salesSummary,
    counts: {
      expenses: collections.expenses.length,
      sales: collections.sales.length,
      inventory: collections.inventory.length,
      recipes: collections.recipes.length,
    },
    expenses: collections.expenses,
    sales: collections.sales,
    inventory: { ...inventory, alerts: inventory.summary.lowStockCount },
    recipes: collections.recipes.map((recipe) => enrichRecipe(recipe)),
    productPerformance: buildProductPerformance(),
    ownerStatus: buildOwnerStatus(),
    updatedAt: new Date().toISOString(),
  };
}

function buildOwnerStatus() {
  const latestSale = collections.sales
    .filter((sale) => sale.source === "square" || sale.squarePaymentId || sale.squareOrderId)
    .sort((left, right) => (latestRecordTimestamp(right) || right.date || "").localeCompare(latestRecordTimestamp(left) || left.date || ""))[0];
  return {
    receiptAiAvailable: Boolean(receiptParser?.configured),
    inventoryConfigured: collections.inventory.length > 0,
    lastSquareSale: latestSale ? {
      id: latestSale.id,
      product: latestSale.product,
      date: latestSale.date,
      receivedAt: latestRecordTimestamp(latestSale) || latestSale.date,
    } : null,
  };
}

function buildSalesUpdatePayload(sales, cursor) {
  const payload = { sales, cursor };
  if (!sales.length) return payload;
  const now = new Date();
  const summary = buildSalesSummary(collections.sales, now);
  const monthKey = localDateKey(now).slice(0, 7);
  const monthExpenses = collections.expenses.filter((expense) => expense.date.startsWith(monthKey));
  const inventory = buildInventoryIntelligence(collections.inventory);
  return {
    ...payload,
    salesSummary: summary,
    financials: {
      revenueToday: summary.todaySales,
      revenueThisWeek: summary.weekSales,
      revenueThisMonth: summary.monthSales,
      estimatedProfit: round(summary.monthSales - sum(monthExpenses, "amount")),
    },
    salesCount: collections.sales.length,
    productPerformance: buildProductPerformance(),
    inventory: { ...inventory, alerts: inventory.summary.lowStockCount },
    customers: customers.map(toSafeCustomer),
    customerInsights: buildCustomerInsights(customers, now),
    purchasingIntelligence: buildPurchasingDashboard(),
    ownerStatus: buildOwnerStatus(),
  };
}

function normalizeSalesCursor(value) {
  const timestamp = Date.parse(value || "");
  if (!Number.isFinite(timestamp)) throw validationError("A valid sales cursor is required");
  return new Date(timestamp).toISOString();
}
function buildProductPerformance() {
  const totals = new Map();
  for (const sale of collections.sales) {
    if (!isRevenueSale(sale)) continue;
    const current = totals.get(sale.product) || {
      product: sale.product,
      quantitySold: 0,
      revenue: 0,
    };
    current.quantitySold = round(current.quantitySold + effectiveQuantity(sale));
    current.revenue = round(current.revenue + sale.saleAmount);
    totals.set(sale.product, current);
  }
  return [...totals.values()].sort((a, b) => b.revenue - a.revenue);
}

function enrichRecord(collectionName, record) {
  return collectionName === "recipes" ? enrichRecipe(record) : record;
}

function enrichRecipe(recipe) {
  return calculateRecipeProfitability(recipe, collections.inventory);
}

function exportCsv(res, collectionName) {
  const isExpenses = collectionName === "expenses";
  const headers = isExpenses
    ? ["Date", "Vendor", "Category", "Amount", "Notes"]
    : ["Date", "Product", "Quantity Sold", "Sale Amount"];
  const rows = collections[collectionName].map((record) =>
    isExpenses
      ? [record.date, record.vendor, record.category, record.amount, record.notes]
      : [record.date, record.product, record.quantitySold, record.saleAmount],
  );
  const csv = [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
  res.writeHead(200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="bakeryops-${collectionName}.csv"`,
  });
  res.end(`\uFEFF${csv}`);
}

function csvCell(value) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

function migrateRecord(name, record) {
  if (name === "expenses") {
    return { ...record, amount: Number(record.amount ?? record.total ?? 0) };
  }
  if (name === "sales") {
    const saleAmount = Number(record.saleAmount ?? record.total ?? 0);
    return {
      ...record,
      product: record.product ?? record.productName ?? "",
      quantitySold: Number(record.quantitySold ?? record.quantity ?? 0),
      saleAmount,
      grossAmount: Number(record.grossAmount ?? saleAmount),
      refundedAmount: Number(record.refundedAmount || 0),
      status: record.status || "completed",
    };
  }
  if (name === "inventory") {
    return {
      ...record,
      ingredientName: record.ingredientName ?? record.name ?? "",
      category: record.category || "Ingredients",
      quantity: Number(record.quantity ?? record.currentQuantity ?? 0),
      costPerUnit: Number(record.costPerUnit ?? 0),
    };
  }
  return {
    ...record,
    recipeName: record.recipeName ?? record.name ?? "",
    preparationNotes: record.preparationNotes ?? record.notes ?? "",
    ingredients: Array.isArray(record.ingredients)
      ? record.ingredients.map((ingredient) => ({
          ...ingredient,
          ingredientName: ingredient.ingredientName ?? ingredient.name ?? "",
          inventoryId: ingredient.inventoryId ?? "",
        }))
      : [],
  };
}

function sanitizeSettings(input) {
  const multiplier = Number(input.shoppingTargetMultiplier);
  return {
    businessName: optionalText(input.businessName),
    ownerName: optionalText(input.ownerName),
    currency: input.currency === "USD" ? "USD" : "USD",
    shoppingTargetMultiplier:
      Number.isFinite(multiplier) && multiplier >= 1 && multiplier <= 10 ? multiplier : 2,
  };
}

function defaultSettings() {
  return {
    businessName: "",
    ownerName: "",
    currency: "USD",
    shoppingTargetMultiplier: 2,
  };
}

async function saveCollection(name) {
  await storage.saveCollection(name, collections[name]);
}

async function saveSettings() {
  await storage.saveSettings(settings);
}

async function upsertSquareCustomer(customerInfo, sale) {
  customers = await storage.loadCustomers();
  const result = upsertCustomerFromSale(customers, customerInfo, sale, {
    createId: () => crypto.randomUUID(),
  });
  if (!result.skipped) await storage.saveCustomers(customers);
}

function serveStatic(pathname, res) {
  const requested = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.normalize(path.join(root, requested));
  const allowedFiles = new Set([
    path.join(root, "index.html"),
    path.join(root, "styles.css"),
    path.join(root, "app-shell.js"),
    path.join(root, "script.js"),
    path.join(root, "system-status.js"),
    path.join(root, "live-sales.js"),
    path.join(root, "contacts-polling.js"),
    path.join(root, "trend-finder-ui.js"),
    path.join(root, "square-connect-fix.js"),
  ]);
  if (!allowedFiles.has(filePath)) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  fs.readFile(filePath, (error, body) => {
    if (error) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    res.writeHead(200, { "Content-Type": types[path.extname(filePath)], ...noStoreHeaders() });
    res.end(body);
  });
}

function requireLogin(res) {
  res.writeHead(401, {
    "WWW-Authenticate": 'Basic realm="BakeryOps AI"',
    "Content-Type": "text/plain; charset=utf-8",
    ...noStoreHeaders(),
  });
  res.end("Authentication required");
}

function sendJson(res, status, body, headers = {}) {
  if (res.writableEnded) return;
  if (res.headersSent) return res.end();
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...headers });
  res.end(JSON.stringify(body));
}

function noStoreHeaders() {
  return {
    "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
    Pragma: "no-cache",
    Expires: "0",
    "Surrogate-Control": "no-store",
  };
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1_000_000) {
        const error = validationError("Request body is too large");
        error.statusCode = 413;
        reject(error);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text ? JSON.parse(text) : {});
      } catch {
        reject(validationError("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1_000_000) {
        const error = validationError("Request body is too large");
        error.statusCode = 413;
        reject(error);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function readBufferBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes && !settled) {
        settled = true;
        const error = validationError(`Receipt image must be ${Math.floor(maxBytes / 1024 / 1024)} MB or smaller`);
        error.statusCode = 413;
        reject(error);
        return;
      }
      if (!settled) chunks.push(chunk);
    });
    req.on("end", () => {
      if (!settled) resolve(Buffer.concat(chunks));
    });
    req.on("error", (error) => {
      if (!settled) reject(error);
    });
  });
}

function safeUploadName(value) {
  let decoded = "receipt";
  try { decoded = decodeURIComponent(String(value || "receipt")); }
  catch { decoded = String(value || "receipt"); }
  return path.basename(decoded).replace(/[^a-zA-Z0-9._ -]/g, "_").slice(0, 180) || "receipt";
}

function requiredText(value, label) {
  const text = String(value || "").trim();
  if (!text) throw validationError(`${label} is required`);
  return text.slice(0, 500);
}

function optionalText(value) {
  return String(value || "").trim().slice(0, 5000);
}

function requiredDate(value, label) {
  const text = String(value || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw validationError(`${label} is required`);
  return text;
}

function allowedValue(value, allowed, label) {
  if (!allowed.includes(value)) throw validationError(`${label} is invalid`);
  return value;
}

function requiredMoney(value, label) {
  return requiredNonNegativeNumber(value, label);
}

function requiredSignedMoney(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw validationError(`${label} must be a number`);
  return round(number);
}

function requiredPositiveNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw validationError(`${label} must be greater than zero`);
  return round(number);
}

function requiredNonNegativeNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw validationError(`${label} must be zero or more`);
  return round(number);
}

function validationError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function dateFromKey(key) {
  return new Date(`${key}T00:00:00`);
}

function localDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function sum(items, key) {
  return round(items.reduce((total, item) => total + Number(item[key] || 0), 0));
}

function round(value) {
  return Math.round(Number(value) * 100) / 100;
}
