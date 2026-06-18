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
const collectionNames = ["expenses", "inventory", "recipes", "sales"];

fs.mkdirSync(dataDir, { recursive: true });

const collections = Object.fromEntries(
  collectionNames.map((name) => [name, loadCollection(name)]),
);
const settings = loadSettings();
ensureStorageFiles();

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

      if (url.pathname === "/api/settings" && req.method === "GET") {
        return sendJson(res, 200, settings);
      }

      if (url.pathname === "/api/settings" && req.method === "PUT") {
        const input = await readJsonBody(req);
        Object.assign(settings, sanitizeSettings(input));
        saveSettings();
        return sendJson(res, 200, settings);
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
    console.log(`Persistent data directory: ${dataDir}`);
    if (!password) console.log("Set BAKERYOPS_PASSWORD to require a login before sharing.");
  });

async function createRecord(collectionName, req, res) {
  const input = await readJsonBody(req);
  const record = normalizeRecord(collectionName, input, {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  });
  collections[collectionName].unshift(record);
  saveCollection(collectionName);
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
  saveCollection(collectionName);
  sendJson(res, 200, enrichRecord(collectionName, record));
}

function deleteRecord(collectionName, id, res) {
  const index = collections[collectionName].findIndex((record) => record.id === id);
  if (index === -1) return sendJson(res, 404, { error: "Record not found" });
  collections[collectionName].splice(index, 1);
  saveCollection(collectionName);
  sendJson(res, 200, { ok: true });
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

function loadCollection(name) {
  const filePath = collectionPath(name);
  if (!fs.existsSync(filePath)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.map((record) => migrateRecord(name, record));
  } catch (error) {
    console.error(`Could not load ${filePath}:`, error);
    return [];
  }
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

function loadSettings() {
  const filePath = path.join(dataDir, "settings.json");
  if (!fs.existsSync(filePath)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    console.error(`Could not load ${filePath}:`, error);
    return {};
  }
}

function sanitizeSettings(input) {
  return {
    businessName: optionalText(input.businessName),
    currency: input.currency === "USD" ? "USD" : "USD",
  };
}

function ensureStorageFiles() {
  for (const name of collectionNames) {
    if (!fs.existsSync(collectionPath(name))) saveCollection(name);
  }
  const settingsPath = path.join(dataDir, "settings.json");
  if (!fs.existsSync(settingsPath)) saveSettings();
}

function saveCollection(name) {
  writeJsonAtomic(collectionPath(name), collections[name]);
}

function saveSettings() {
  writeJsonAtomic(path.join(dataDir, "settings.json"), settings);
}

function writeJsonAtomic(filePath, value) {
  const tempPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(value, null, 2), "utf8");
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
