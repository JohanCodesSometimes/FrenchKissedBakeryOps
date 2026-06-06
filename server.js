const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const root = __dirname;
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || "0.0.0.0";
const username = process.env.BAKERYOPS_USER || "owner";
const password = process.env.BAKERYOPS_PASSWORD;
const squareAccessToken = process.env.SQUARE_ACCESS_TOKEN;
const squareApplicationId = process.env.SQUARE_APPLICATION_ID;
const squareApplicationSecret = process.env.SQUARE_APPLICATION_SECRET;
const squareEnvironment = process.env.SQUARE_ENVIRONMENT || "sandbox";
const squareWebhookSignatureKey = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY;
const squareWebhookUrl = process.env.SQUARE_WEBHOOK_URL;
const squareOAuthRedirectUrl = process.env.SQUARE_OAUTH_REDIRECT_URL;
const squareVersion = process.env.SQUARE_VERSION || "2026-05-20";
const dataDir = process.env.DATA_DIR || path.join(root, "data");
const dataPath = path.join(dataDir, "bakeryops.json");

const squareApiBase =
  squareEnvironment === "production"
    ? "https://connect.squareup.com"
    : "https://connect.squareupsandbox.com";
const squareAuthorizeBase =
  squareEnvironment === "production"
    ? "https://connect.squareup.com/oauth2/authorize"
    : "https://connect.squareupsandbox.com/oauth2/authorize";

const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

const state = loadState();

http
  .createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);

      if (url.pathname === "/api/health") {
        return sendJson(res, 200, {
          ok: true,
          squareConfigured: Boolean(getSquareAccessToken() && squareWebhookSignatureKey),
        });
      }

      if (url.pathname === "/api/dashboard") {
        if (password && !isAuthorized(req)) return requireLogin(res);
        return sendJson(res, 200, buildDashboard());
      }

      if (url.pathname === "/api/square/status") {
        if (password && !isAuthorized(req)) return requireLogin(res);
        return sendJson(res, 200, {
          connected: Boolean(getSquareAccessToken()),
          merchantId: state.square?.merchantId || null,
          environment: squareEnvironment,
          webhookConfigured: Boolean(squareWebhookSignatureKey && squareWebhookUrl),
        });
      }

      if (url.pathname === "/api/square/connect") {
        if (password && !isAuthorized(req)) return requireLogin(res);
        return redirectToSquareOAuth(res);
      }

      if (url.pathname === "/api/square/oauth/callback") {
        return handleSquareOAuthCallback(url, res);
      }

      if (url.pathname === "/api/square/webhook" && req.method === "POST") {
        return handleSquareWebhook(req, res);
      }

      if (password && !isAuthorized(req)) return requireLogin(res);
      return serveStatic(url.pathname, res);
    } catch (error) {
      console.error(error);
      sendJson(res, 500, { error: "Internal server error" });
    }
  })
  .listen(port, host, () => {
    console.log(`BakeryOps AI running on ${host}:${port}`);
    if (!password) console.log("Set BAKERYOPS_PASSWORD to require a login before sharing.");
  });

async function handleSquareWebhook(req, res) {
  const rawBody = await readRawBody(req);

  if (!squareWebhookSignatureKey || !squareWebhookUrl) {
    return sendJson(res, 500, {
      error: "Square webhook verification is not configured",
    });
  }

  if (!isValidSquareSignature(req, rawBody)) {
    return sendJson(res, 403, { error: "Invalid Square signature" });
  }

  const event = JSON.parse(rawBody.toString("utf8"));
  const paymentId = event?.data?.id || event?.data?.object?.payment?.id;
  const eventType = event?.type;

  if (!eventType?.startsWith("payment.") || !paymentId) {
    return sendJson(res, 200, { ignored: true, reason: "Not a payment event" });
  }

  const payment = await retrieveSquarePayment(paymentId);
  if (payment.status !== "COMPLETED") {
    return sendJson(res, 200, {
      ignored: true,
      reason: `Payment status is ${payment.status || "unknown"}`,
    });
  }

  if (!payment.order_id) {
    return sendJson(res, 200, { ignored: true, reason: "Payment has no order_id" });
  }

  const order = await retrieveSquareOrder(payment.order_id);
  const result = ingestOrder({
    paymentId: payment.id,
    orderId: payment.order_id,
    status: payment.status,
    order,
  });

  saveState();
  return sendJson(res, 200, result);
}

async function retrieveSquarePayment(paymentId) {
  const result = await squareRequest(`/v2/payments/${paymentId}`);
  return result.payment;
}

async function retrieveSquareOrder(orderId) {
  const result = await squareRequest(`/v2/orders/${orderId}`);
  return result.order;
}

async function squareRequest(endpoint) {
  const accessToken = getSquareAccessToken();
  if (!accessToken) throw new Error("Square is not connected");

  const response = await fetch(`${squareApiBase}${endpoint}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Square-Version": squareVersion,
      "Content-Type": "application/json",
    },
  });

  const body = await response.json();
  if (!response.ok) {
    throw new Error(`Square API ${response.status}: ${JSON.stringify(body)}`);
  }

  return body;
}

function getSquareAccessToken() {
  return state.square?.accessToken || squareAccessToken;
}

function redirectToSquareOAuth(res) {
  if (!squareApplicationId || !squareOAuthRedirectUrl) {
    return sendHtml(
      res,
      500,
      "<h1>Square OAuth is not configured</h1><p>Set SQUARE_APPLICATION_ID and SQUARE_OAUTH_REDIRECT_URL in Railway.</p>",
    );
  }

  const stateToken = crypto.randomBytes(24).toString("hex");
  state.oauthStates[stateToken] = Date.now();
  saveState();

  const params = new URLSearchParams({
    client_id: squareApplicationId,
    scope: "PAYMENTS_READ ORDERS_READ MERCHANT_PROFILE_READ",
    state: stateToken,
    redirect_uri: squareOAuthRedirectUrl,
  });

  res.writeHead(302, { Location: `${squareAuthorizeBase}?${params}` });
  res.end();
}

async function handleSquareOAuthCallback(url, res) {
  const code = url.searchParams.get("code");
  const returnedState = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) {
    return sendHtml(res, 400, `<h1>Square connection failed</h1><p>${escapeHtml(error)}</p>`);
  }

  if (!code || !returnedState || !state.oauthStates[returnedState]) {
    return sendHtml(res, 400, "<h1>Invalid Square OAuth callback</h1>");
  }

  delete state.oauthStates[returnedState];

  if (!squareApplicationId || !squareApplicationSecret || !squareOAuthRedirectUrl) {
    return sendHtml(res, 500, "<h1>Square OAuth secrets are not configured</h1>");
  }

  const response = await fetch(`${squareApiBase}/oauth2/token`, {
    method: "POST",
    headers: {
      "Square-Version": squareVersion,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: squareApplicationId,
      client_secret: squareApplicationSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: squareOAuthRedirectUrl,
    }),
  });

  const token = await response.json();
  if (!response.ok) {
    return sendHtml(
      res,
      500,
      `<h1>Could not connect Square</h1><pre>${escapeHtml(JSON.stringify(token, null, 2))}</pre>`,
    );
  }

  state.square = {
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    merchantId: token.merchant_id,
    expiresAt: token.expires_at,
    connectedAt: new Date().toISOString(),
  };
  saveState();

  sendHtml(
    res,
    200,
    "<h1>Square connected</h1><p>You can close this tab and return to BakeryOps AI.</p>",
  );
}

function ingestOrder({ paymentId, orderId, status, order }) {
  if (state.processedPayments[paymentId]) {
    return { ok: true, duplicate: true, dashboard: buildDashboard() };
  }

  const sale = normalizeSquareOrder({ paymentId, orderId, status, order });
  state.sales.unshift(sale);
  state.processedPayments[paymentId] = true;

  deductIngredients(sale.products);
  addSupplierInsights(sale);

  return { ok: true, sale, dashboard: buildDashboard() };
}

function normalizeSquareOrder({ paymentId, orderId, status, order }) {
  const products = (order.line_items || []).map((item) => ({
    id: item.catalog_object_id || item.uid,
    name: item.name,
    quantity: Number(item.quantity || 0),
    total: centsToDollars(item.total_money?.amount),
    tax: centsToDollars(item.total_tax_money?.amount),
    discounts: centsToDollars(item.total_discount_money?.amount),
  }));

  return {
    paymentId,
    orderId,
    status,
    timestamp: order.closed_at || order.created_at || new Date().toISOString(),
    total: centsToDollars(order.total_money?.amount),
    tax: centsToDollars(order.total_tax_money?.amount),
    discounts: centsToDollars(order.total_discount_money?.amount),
    products,
  };
}

function deductIngredients(products) {
  for (const product of products) {
    const recipe = state.recipes[product.name];
    if (!recipe) continue;

    for (const ingredient of recipe.ingredients) {
      const inventoryItem = state.inventory[ingredient.name];
      if (!inventoryItem) continue;
      inventoryItem.currentQuantity = round(
        inventoryItem.currentQuantity - ingredient.quantity * product.quantity,
      );
    }
  }
}

function addSupplierInsights(sale) {
  const itemCount = sale.products.reduce((total, product) => total + product.quantity, 0);

  state.insights.unshift({
    type: "sales",
    title: `${itemCount} item${itemCount === 1 ? "" : "s"} sold from Square POS`,
    body: "Sales analytics were updated. Inventory was deducted where matching recipes exist.",
  });

  state.insights = state.insights.slice(0, 6);
}

function buildDashboard() {
  const now = new Date();
  const todayKey = now.toISOString().slice(0, 10);
  const monthKey = now.toISOString().slice(0, 7);
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - now.getDay());
  weekStart.setHours(0, 0, 0, 0);

  const todaySales = state.sales.filter((sale) => sale.timestamp.slice(0, 10) === todayKey);
  const weekSales = state.sales.filter((sale) => new Date(sale.timestamp) >= weekStart);
  const monthSales = state.sales.filter((sale) => sale.timestamp.slice(0, 7) === monthKey);
  const todayExpenses = state.expenses.filter((expense) => expense.timestamp.slice(0, 10) === todayKey);
  const weekExpenses = state.expenses.filter((expense) => new Date(expense.timestamp) >= weekStart);
  const monthExpensesList = state.expenses.filter((expense) => expense.timestamp.slice(0, 7) === monthKey);
  const monthRevenue = sum(monthSales, "total");
  const monthExpenses = sum(monthExpensesList, "total");
  const lowStock = Object.values(state.inventory).filter(
    (item) => item.currentQuantity <= item.minimumThreshold,
  );

  return {
    financials: {
      revenueToday: sum(todaySales, "total"),
      revenueThisWeek: sum(weekSales, "total"),
      revenueThisMonth: monthRevenue,
      expensesToday: sum(todayExpenses, "total"),
      expensesThisWeek: sum(weekExpenses, "total"),
      expensesThisMonth: monthExpenses,
      netProfit: round(monthRevenue - monthExpenses),
      profitMargin: monthRevenue ? round(((monthRevenue - monthExpenses) / monthRevenue) * 100) : 0,
    },
    inventory: {
      alerts: lowStock.length,
      lowStock,
      all: state.inventory,
    },
    sales: state.sales.slice(0, 20),
    expenses: state.expenses.slice(0, 20),
    recipes: state.recipes,
    supplierPrices: state.supplierPrices,
    trendReports: state.trendReports,
    productMetrics: buildProductMetrics(),
    insights: state.insights,
    updatedAt: new Date().toISOString(),
  };
}

function buildProductMetrics() {
  const totals = new Map();
  for (const sale of state.sales) {
    for (const product of sale.products) {
      const existing = totals.get(product.name) || { name: product.name, revenue: 0, quantity: 0 };
      existing.revenue = round(existing.revenue + product.total);
      existing.quantity = round(existing.quantity + product.quantity);
      totals.set(product.name, existing);
    }
  }

  return {
    topSelling: [...totals.values()].sort((a, b) => b.revenue - a.revenue),
    highestMargin: [],
    lowestMargin: [],
  };
}

function serveStatic(pathname, res) {
  if (pathname === "/") pathname = "/index.html";

  const filePath = path.normalize(path.join(root, pathname));
  const allowedFiles = new Set([
    path.join(root, "index.html"),
    path.join(root, "styles.css"),
    path.join(root, "script.js"),
  ]);

  if (!filePath.startsWith(root) || !allowedFiles.has(filePath)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, body) => {
    if (error) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    res.writeHead(200, {
      "Content-Type": types[path.extname(filePath)] || "application/octet-stream",
    });
    res.end(body);
  });
}

function isValidSquareSignature(req, rawBody) {
  const squareSignature = req.headers["x-square-hmacsha256-signature"];
  if (!squareSignature) return false;

  const signature = crypto
    .createHmac("sha256", squareWebhookSignatureKey)
    .update(squareWebhookUrl + rawBody.toString("utf8"))
    .digest("base64");

  if (signature.length !== squareSignature.length) return false;
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(squareSignature));
}

function isAuthorized(req) {
  const header = req.headers.authorization || "";
  const [scheme, encoded] = header.split(" ");
  if (scheme !== "Basic" || !encoded) return false;

  const credentials = Buffer.from(encoded, "base64").toString("utf8");
  return credentials === `${username}:${password}`;
}

function requireLogin(res) {
  res.writeHead(401, {
    "WWW-Authenticate": 'Basic realm="BakeryOps AI"',
    "Content-Type": "text/plain; charset=utf-8",
  });
  res.end("Authentication required");
}

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function sendHtml(res, status, body) {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><html><body>${body}</body></html>`);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readJsonBody(req) {
  const body = await readRawBody(req);
  return body.length ? JSON.parse(body.toString("utf8")) : {};
}

function loadState() {
  try {
    return withStateDefaults(JSON.parse(fs.readFileSync(dataPath, "utf8")));
  } catch {
    return withStateDefaults({
      processedPayments: {},
      sales: [],
      expenses: [],
      insights: [],
      inventory: {},
      recipes: {},
      supplierPrices: [],
      trendReports: [],
    });
  }
}

function withStateDefaults(savedState) {
  return {
    ...savedState,
    processedPayments: savedState.processedPayments || {},
    sales: savedState.sales || [],
    expenses: savedState.expenses || [],
    insights: savedState.insights || [],
    inventory: savedState.inventory || {},
    recipes: savedState.recipes || {},
    supplierPrices: savedState.supplierPrices || [],
    trendReports: savedState.trendReports || [],
    square: savedState.square || null,
    oauthStates: savedState.oauthStates || {},
  };
}

function saveState() {
  fs.mkdirSync(path.dirname(dataPath), { recursive: true });
  fs.writeFileSync(dataPath, JSON.stringify(state, null, 2));
}

function sum(items, key) {
  return round(items.reduce((total, item) => total + Number(item[key] || 0), 0));
}

function centsToDollars(cents = 0) {
  return round(Number(cents) / 100);
}

function round(value) {
  return Math.round(Number(value) * 100) / 100;
}
