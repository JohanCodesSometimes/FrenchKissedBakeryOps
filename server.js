const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { createStorage } = require("./storage");

const root = __dirname;
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || "0.0.0.0";
const username = process.env.BAKERYOPS_USER || "owner";
const password = process.env.BAKERYOPS_PASSWORD;
const dataDir = path.resolve(process.env.DATA_DIR || path.join(root, "data"));
const collectionNames = ["expenses", "inventory", "recipes", "sales"];

let storage;
let collections;
let settings;
let activity;
let priceHistory;
let supplierPrices;
let trendReports;

const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
};

async function bootstrap() {
  storage = await createStorage({ dataDir, env: process.env, logger: console });
  const state = await storage.initialize();
  collections = Object.fromEntries(
    collectionNames.map((name) => [name, (state.collections[name] || []).map((item) => migrateRecord(name, item))]),
  );
  settings = { ...defaultSettings(), ...(state.settings || {}) };
  activity = state.activity || [];
  priceHistory = state.priceHistory || [];
  supplierPrices = state.supplierPrices || [];
  trendReports = state.trendReports || [];
  startServer();
}

function startServer() {
  http
  .createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

      if (url.pathname === "/api/health") {
        return sendJson(res, 200, { ok: true, storageMode: storage.mode, dataDir: storage.mode === "json" ? dataDir : null });
      }

      if (password && !isAuthorized(req)) return requireLogin(res);

      if (url.pathname === "/api/dashboard" && req.method === "GET") {
        return sendJson(res, 200, buildDashboard());
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

      if (url.pathname === "/api/price-history" && req.method === "GET") {
        return sendJson(res, 200, priceHistory);
      }

      if (url.pathname === "/api/backup.json" && req.method === "GET") {
        return exportBackup(res);
      }

      if (url.pathname === "/api/reports/monthly" && req.method === "GET") {
        return sendJson(res, 200, buildMonthlyReport(url.searchParams.get("month")));
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
        return sendJson(res, 200, collections[collectionMatch[1]]);
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
      const status = error.statusCode || 500;
      sendJson(res, status, { error: status === 500 ? "Internal server error" : error.message });
    }
  })
  .listen(port, host, () => {
    console.log(`BakeryOps AI running on ${host}:${port}`);
    console.log(`Storage mode: ${storage.mode}`);
    if (storage.mode === "json") console.log(`Persistent data directory: ${dataDir}`);
    if (!password) console.log("Set BAKERYOPS_PASSWORD to require a login before sharing.");
  });
}

bootstrap().catch((error) => {
  console.error(`[startup] ${error.message}`);
  process.exitCode = 1;
});

async function createRecord(collectionName, req, res) {
  const input = await readJsonBody(req);
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

async function updateRecord(collectionName, id, req, res) {
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
  const index = collections[collectionName].findIndex((record) => record.id === id);
  if (index === -1) return sendJson(res, 404, { error: "Record not found" });
  const [deleted] = collections[collectionName].splice(index, 1);
  await saveCollection(collectionName);
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
    return {
      ...metadata,
      date: requiredDate(input.date, "Sale date"),
      product: requiredText(input.product ?? input.productName, "Product"),
      quantitySold: requiredPositiveNumber(input.quantitySold ?? input.quantity, "Quantity sold"),
      saleAmount: requiredMoney(input.saleAmount ?? input.total, "Sale amount"),
    };
  }

  if (collectionName === "inventory") {
    return {
      ...metadata,
      ingredientName: requiredText(input.ingredientName ?? input.name, "Ingredient name"),
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
  const sales = collections.sales.filter((sale) => sale.date.startsWith(month));
  const expenses = collections.expenses.filter((expense) => expense.date.startsWith(month));
  const revenue = sum(sales, "saleAmount");
  const expenseTotal = sum(expenses, "amount");
  const products = new Map();
  sales.forEach((sale) => {
    const item = products.get(sale.product) || { product: sale.product, quantitySold: 0, revenue: 0 };
    item.quantitySold = round(item.quantitySold + sale.quantitySold);
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
    schemaVersion: 2,
    exportedAt: new Date().toISOString(),
    settings,
    expenses: collections.expenses,
    inventory: collections.inventory,
    recipes: collections.recipes,
    sales: collections.sales,
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
  const weekStart = new Date(now);
  weekStart.setHours(0, 0, 0, 0);
  weekStart.setDate(now.getDate() - now.getDay());

  const todaySales = collections.sales.filter((sale) => sale.date === todayKey);
  const weekSales = collections.sales.filter((sale) => dateFromKey(sale.date) >= weekStart);
  const monthSales = collections.sales.filter((sale) => sale.date.startsWith(monthKey));
  const monthExpenses = collections.expenses.filter((expense) => expense.date.startsWith(monthKey));
  const monthRevenue = sum(monthSales, "saleAmount");
  const monthExpenseTotal = sum(monthExpenses, "amount");
  const lowStock = collections.inventory.filter(
    (item) => item.quantity <= item.minimumThreshold,
  );

  return {
    financials: {
      revenueToday: sum(todaySales, "saleAmount"),
      revenueThisWeek: sum(weekSales, "saleAmount"),
      revenueThisMonth: monthRevenue,
      expensesThisMonth: monthExpenseTotal,
      estimatedProfit: round(monthRevenue - monthExpenseTotal),
    },
    counts: {
      expenses: collections.expenses.length,
      sales: collections.sales.length,
      inventory: collections.inventory.length,
      recipes: collections.recipes.length,
    },
    expenses: collections.expenses,
    sales: collections.sales,
    inventory: { alerts: lowStock.length, lowStock, all: collections.inventory },
    recipes: collections.recipes.map((recipe) => enrichRecipe(recipe)),
    productPerformance: buildProductPerformance(),
    updatedAt: new Date().toISOString(),
  };
}

function buildProductPerformance() {
  const totals = new Map();
  for (const sale of collections.sales) {
    const current = totals.get(sale.product) || {
      product: sale.product,
      quantitySold: 0,
      revenue: 0,
    };
    current.quantitySold = round(current.quantitySold + sale.quantitySold);
    current.revenue = round(current.revenue + sale.saleAmount);
    totals.set(sale.product, current);
  }
  return [...totals.values()].sort((a, b) => b.revenue - a.revenue);
}

function enrichRecord(collectionName, record) {
  return collectionName === "recipes" ? enrichRecipe(record) : record;
}

function enrichRecipe(recipe) {
  const breakdown = recipe.ingredients.map((ingredient) => {
    const inventoryItem = findInventoryItem(ingredient);
    const cost = inventoryItem ? calculateIngredientCost(ingredient, inventoryItem) : null;
    return {
      ...ingredient,
      inventoryItemId: inventoryItem?.id || null,
      inventoryUnit: inventoryItem?.unit || null,
      costPerInventoryUnit: inventoryItem?.costPerUnit ?? null,
      cost,
      costAvailable: cost !== null,
    };
  });
  const pricedIngredients = breakdown.filter((item) => item.costAvailable);
  const pricedSubtotal = round(pricedIngredients.reduce((total, item) => total + item.cost, 0));
  const allCostsAvailable = pricedIngredients.length === breakdown.length;
  const totalRecipeCost = allCostsAvailable ? pricedSubtotal : null;
  const costPerUnit = allCostsAvailable && recipe.yieldQuantity
    ? round(totalRecipeCost / recipe.yieldQuantity)
    : null;
  const profitPerUnit = allCostsAvailable ? round(recipe.sellingPrice - costPerUnit) : null;
  const profitMargin = allCostsAvailable && recipe.sellingPrice
    ? round((profitPerUnit / recipe.sellingPrice) * 100)
    : allCostsAvailable ? 0 : null;

  return {
    ...recipe,
    costBreakdown: breakdown,
    totalRecipeCost,
    pricedSubtotal,
    costPerUnit,
    profitPerUnit,
    profitMargin,
    allCostsAvailable,
  };
}

function findInventoryItem(ingredient) {
  if (ingredient.inventoryId) {
    const byId = collections.inventory.find((item) => item.id === ingredient.inventoryId);
    if (byId) return byId;
  }
  return collections.inventory.find(
    (item) => item.ingredientName.toLowerCase() === ingredient.ingredientName.toLowerCase(),
  );
}

function calculateIngredientCost(ingredient, inventoryItem) {
  const ingredientUnit = unitDefinition(ingredient.unit);
  const inventoryUnit = unitDefinition(inventoryItem.unit);
  if (!ingredientUnit || !inventoryUnit || ingredientUnit.group !== inventoryUnit.group) return null;
  const inventoryUnitsUsed =
    (ingredient.quantity * ingredientUnit.factor) / inventoryUnit.factor;
  return round(inventoryUnitsUsed * inventoryItem.costPerUnit);
}

function unitDefinition(unit) {
  const units = {
    g: { group: "mass", factor: 1 },
    kg: { group: "mass", factor: 1000 },
    oz: { group: "mass", factor: 28.349523125 },
    lb: { group: "mass", factor: 453.59237 },
    count: { group: "count", factor: 1 },
    dozen: { group: "count", factor: 12 },
    gallon: { group: "volume", factor: 1 },
  };
  return units[unit] || null;
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
    return {
      ...record,
      product: record.product ?? record.productName ?? "",
      quantitySold: Number(record.quantitySold ?? record.quantity ?? 0),
      saleAmount: Number(record.saleAmount ?? record.total ?? 0),
    };
  }
  if (name === "inventory") {
    return {
      ...record,
      ingredientName: record.ingredientName ?? record.name ?? "",
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
  return Buffer.from(encoded, "base64").toString("utf8") === `${username}:${password}`;
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
