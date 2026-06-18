const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const root = __dirname;
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || "0.0.0.0";
const username = process.env.BAKERYOPS_USER || "owner";
const password = process.env.BAKERYOPS_PASSWORD;
const dataDir = path.resolve(process.env.DATA_DIR || path.join(root, "data"));

const collections = {
  expenses: loadCollection("expenses"),
  sales: loadCollection("sales"),
  inventory: loadCollection("inventory"),
  recipes: loadCollection("recipes"),
};

const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
};

http
  .createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

      if (url.pathname === "/api/health") {
        return sendJson(res, 200, { ok: true, dataDir });
      }

      if (password && !isAuthorized(req)) return requireLogin(res);

      if (url.pathname === "/api/dashboard" && req.method === "GET") {
        return sendJson(res, 200, buildDashboard());
      }

      const exportMatch = url.pathname.match(/^\/api\/export\/(expenses|sales)\.csv$/);
      if (exportMatch && req.method === "GET") {
        return exportCsv(res, exportMatch[1]);
      }

      const collectionMatch = url.pathname.match(/^\/api\/(expenses|sales|inventory|recipes)$/);
      if (collectionMatch && req.method === "POST") {
        return createRecord(collectionMatch[1], req, res);
      }

      const deleteMatch = url.pathname.match(/^\/api\/(expenses|sales|inventory|recipes)\/([^/]+)$/);
      if (deleteMatch && req.method === "DELETE") {
        return deleteRecord(deleteMatch[1], decodeURIComponent(deleteMatch[2]), res);
      }

      return serveStatic(url.pathname, res);
    } catch (error) {
      console.error(error);
      const status = error.statusCode || 500;
      sendJson(res, status, { error: status === 500 ? "Internal server error" : error.message });
    }
  })
  .listen(port, host, () => {
    console.log(`BakeryOps AI running on ${host}:${port}`);
    console.log(`Persistent data directory: ${dataDir}`);
    if (!password) console.log("Set BAKERYOPS_PASSWORD to require a login before sharing.");
  });

async function createRecord(collectionName, req, res) {
  const input = await readJsonBody(req);
  const record = normalizeRecord(collectionName, input);
  collections[collectionName].unshift(record);
  saveCollection(collectionName);
  sendJson(res, 201, record);
}

function deleteRecord(collectionName, id, res) {
  const index = collections[collectionName].findIndex((record) => record.id === id);
  if (index === -1) return sendJson(res, 404, { error: "Record not found" });

  collections[collectionName].splice(index, 1);
  saveCollection(collectionName);
  sendJson(res, 200, { ok: true });
}

function normalizeRecord(collectionName, input) {
  const common = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  };

  if (collectionName === "expenses") {
    return {
      ...common,
      date: requiredDate(input.date, "Expense date"),
      vendor: requiredText(input.vendor, "Vendor"),
      category: requiredText(input.category, "Category"),
      total: requiredMoney(input.total, "Total"),
      tax: optionalMoney(input.tax),
      notes: optionalText(input.notes),
      source: "manual",
    };
  }

  if (collectionName === "sales") {
    return {
      ...common,
      date: requiredDate(input.date, "Sale date"),
      productName: requiredText(input.productName, "Product name"),
      quantity: requiredPositiveNumber(input.quantity, "Quantity"),
      total: requiredMoney(input.total, "Total"),
      tax: optionalMoney(input.tax),
      discounts: optionalMoney(input.discounts),
      notes: optionalText(input.notes),
      source: "manual",
    };
  }

  if (collectionName === "inventory") {
    return {
      ...common,
      name: requiredText(input.name, "Ingredient name"),
      currentQuantity: requiredNonNegativeNumber(input.currentQuantity, "Current quantity"),
      unit: requiredText(input.unit, "Unit"),
      minimumThreshold: requiredNonNegativeNumber(input.minimumThreshold, "Minimum threshold"),
      averageWeeklyUsage: optionalNonNegativeNumber(input.averageWeeklyUsage),
    };
  }

  return {
    ...common,
    name: requiredText(input.name, "Recipe name"),
    category: optionalText(input.category),
    yieldQuantity: requiredPositiveNumber(input.yieldQuantity, "Yield quantity"),
    yieldUnit: requiredText(input.yieldUnit, "Yield unit"),
    sellingPrice: optionalMoney(input.sellingPrice),
    totalCost: optionalMoney(input.totalCost),
    ingredients: optionalText(input.ingredients),
    notes: optionalText(input.notes),
  };
}

function buildDashboard() {
  const now = new Date();
  const todayKey = localDateKey(now);
  const monthKey = todayKey.slice(0, 7);
  const weekStart = new Date(now);
  weekStart.setHours(0, 0, 0, 0);
  weekStart.setDate(now.getDate() - now.getDay());

  const todaySales = collections.sales.filter((sale) => sale.date === todayKey);
  const weekSales = collections.sales.filter((sale) => dateFromKey(sale.date) >= weekStart);
  const monthSales = collections.sales.filter((sale) => sale.date.startsWith(monthKey));
  const todayExpenses = collections.expenses.filter((expense) => expense.date === todayKey);
  const weekExpenses = collections.expenses.filter((expense) => dateFromKey(expense.date) >= weekStart);
  const monthExpenses = collections.expenses.filter((expense) => expense.date.startsWith(monthKey));
  const monthRevenue = sum(monthSales, "total");
  const monthExpenseTotal = sum(monthExpenses, "total");
  const inventoryById = Object.fromEntries(collections.inventory.map((item) => [item.id, item]));
  const lowStock = collections.inventory.filter(
    (item) => item.currentQuantity <= item.minimumThreshold,
  );

  return {
    financials: {
      revenueToday: sum(todaySales, "total"),
      revenueThisWeek: sum(weekSales, "total"),
      revenueThisMonth: monthRevenue,
      expensesToday: sum(todayExpenses, "total"),
      expensesThisWeek: sum(weekExpenses, "total"),
      expensesThisMonth: monthExpenseTotal,
      netProfit: round(monthRevenue - monthExpenseTotal),
      profitMargin: monthRevenue
        ? round(((monthRevenue - monthExpenseTotal) / monthRevenue) * 100)
        : 0,
    },
    expenses: collections.expenses,
    sales: collections.sales,
    inventory: { alerts: lowStock.length, lowStock, all: inventoryById },
    recipes: collections.recipes,
    productMetrics: buildProductMetrics(),
    updatedAt: new Date().toISOString(),
  };
}

function buildProductMetrics() {
  const totals = new Map();
  for (const sale of collections.sales) {
    const current = totals.get(sale.productName) || {
      name: sale.productName,
      revenue: 0,
      quantity: 0,
    };
    current.revenue = round(current.revenue + sale.total);
    current.quantity = round(current.quantity + sale.quantity);
    totals.set(sale.productName, current);
  }

  return {
    topSelling: [...totals.values()].sort((a, b) => b.revenue - a.revenue),
  };
}

function exportCsv(res, collectionName) {
  const isExpenses = collectionName === "expenses";
  const headers = isExpenses
    ? ["Date", "Vendor", "Category", "Total", "Tax", "Notes", "Source"]
    : ["Date", "Product", "Quantity", "Total", "Tax", "Discounts", "Notes", "Source"];
  const rows = collections[collectionName].map((record) =>
    isExpenses
      ? [record.date, record.vendor, record.category, record.total, record.tax, record.notes, record.source]
      : [
          record.date,
          record.productName,
          record.quantity,
          record.total,
          record.tax,
          record.discounts,
          record.notes,
          record.source,
        ],
  );
  const csv = [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");

  res.writeHead(200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="bakeryops-${collectionName}.csv"`,
  });
  res.end(`\uFEFF${csv}`);
}

function csvCell(value) {
  const text = String(value ?? "");
  return `"${text.replaceAll('"', '""')}"`;
}

function loadCollection(name) {
  fs.mkdirSync(dataDir, { recursive: true });
  const filePath = collectionPath(name);
  if (!fs.existsSync(filePath)) return [];

  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.error(`Could not load ${filePath}:`, error);
    return [];
  }
}

function saveCollection(name) {
  fs.mkdirSync(dataDir, { recursive: true });
  const filePath = collectionPath(name);
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(collections[name], null, 2), "utf8");
  fs.renameSync(tempPath, filePath);
}

function collectionPath(name) {
  return path.join(dataDir, `${name}.json`);
}

function serveStatic(pathname, res) {
  const requested = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.normalize(path.join(root, requested));
  const allowedFiles = new Set([
    path.join(root, "index.html"),
    path.join(root, "styles.css"),
    path.join(root, "script.js"),
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
    res.writeHead(200, { "Content-Type": types[path.extname(filePath)] });
    res.end(body);
  });
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

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1_000_000) {
        const error = new Error("Request body is too large");
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
        const error = new Error("Invalid JSON body");
        error.statusCode = 400;
        reject(error);
      }
    });
    req.on("error", reject);
  });
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

function requiredMoney(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw validationError(`${label} must be zero or more`);
  return round(number);
}

function optionalMoney(value) {
  if (value === "" || value == null) return 0;
  return requiredMoney(value, "Amount");
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

function optionalNonNegativeNumber(value) {
  if (value === "" || value == null) return 0;
  return requiredNonNegativeNumber(value, "Number");
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
