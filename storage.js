const fs = require("fs");
const path = require("path");
const { getSupabaseConfig, createServerSupabaseClient } = require("./supabase-client");

const collectionNames = ["expenses", "inventory", "recipes", "sales"];
const localFiles = {
  activity: "activity.json",
  priceHistory: "price-history.json",
  supplierPrices: "supplier-prices.json",
  trendReports: "trend-reports.json",
  settings: "settings.json",
};

async function createStorage({ dataDir, env = process.env, logger = console, supabaseClient = null }) {
  const config = getSupabaseConfig(env);
  if (config.partial) {
    logger.warn(
      "[storage] Supabase variables are incomplete; using local JSON. Set SUPABASE_URL, SUPABASE_ANON_KEY, and SUPABASE_SERVICE_ROLE_KEY together.",
    );
  }
  if (config.enabled) {
    logger.log("[storage] Using Supabase database storage.");
    return createSupabaseStorage(supabaseClient || createServerSupabaseClient(config));
  }
  logger.log(`[storage] Using local JSON storage at ${dataDir}.`);
  return createLocalStorage(dataDir);
}

function createLocalStorage(dataDir) {
  const resolvedDir = path.resolve(dataDir);
  fs.mkdirSync(resolvedDir, { recursive: true });

  return {
    mode: "json",
    async initialize() {
      const state = {
        collections: Object.fromEntries(
          collectionNames.map((name) => [name, loadArray(path.join(resolvedDir, `${name}.json`))]),
        ),
        settings: loadObject(path.join(resolvedDir, localFiles.settings)),
        activity: loadArray(path.join(resolvedDir, localFiles.activity)),
        priceHistory: loadArray(path.join(resolvedDir, localFiles.priceHistory)),
        supplierPrices: loadArray(path.join(resolvedDir, localFiles.supplierPrices)),
        trendReports: loadArray(path.join(resolvedDir, localFiles.trendReports)),
      };
      for (const name of collectionNames) {
        ensureJson(path.join(resolvedDir, `${name}.json`), state.collections[name]);
      }
      ensureJson(path.join(resolvedDir, localFiles.settings), state.settings);
      ensureJson(path.join(resolvedDir, localFiles.activity), state.activity);
      ensureJson(path.join(resolvedDir, localFiles.priceHistory), state.priceHistory);
      ensureJson(path.join(resolvedDir, localFiles.supplierPrices), state.supplierPrices);
      ensureJson(path.join(resolvedDir, localFiles.trendReports), state.trendReports);
      return state;
    },
    async saveCollection(name, value) {
      writeJsonAtomic(path.join(resolvedDir, `${name}.json`), value);
    },
    async saveSettings(value) {
      writeJsonAtomic(path.join(resolvedDir, localFiles.settings), value);
    },
    async saveActivity(value) {
      writeJsonAtomic(path.join(resolvedDir, localFiles.activity), value);
    },
    async savePriceHistory(value) {
      writeJsonAtomic(path.join(resolvedDir, localFiles.priceHistory), value);
    },
    async saveSupplierPrices(value) {
      writeJsonAtomic(path.join(resolvedDir, localFiles.supplierPrices), value);
    },
    async saveTrendReports(value) {
      writeJsonAtomic(path.join(resolvedDir, localFiles.trendReports), value);
    },
  };
}

function createSupabaseStorage(client) {
  return {
    mode: "supabase",
    async initialize() {
      const [expenses, inventory, recipes, sales, settings, activity, supplierPrices, trendReports] =
        await Promise.all([
          selectAll(client, "expenses"),
          selectAll(client, "inventory_items"),
          selectRecipes(client),
          selectAll(client, "sales"),
          selectSettings(client),
          selectAll(client, "activity_log", "timestamp", false),
          selectAll(client, "supplier_prices", "recorded_at", false),
          selectAll(client, "trend_reports", "created_at", false),
        ]);
      return {
        collections: {
          expenses: expenses.map(fromExpenseRow),
          inventory: inventory.map(fromInventoryRow),
          recipes,
          sales: sales.map(fromSaleRow),
        },
        settings,
        activity: activity.map(fromActivityRow),
        priceHistory: supplierPrices
          .filter((row) => row.source === "inventory_history")
          .map(fromSupplierPriceRow),
        supplierPrices: supplierPrices
          .filter((row) => row.source !== "inventory_history")
          .map(fromSupplierPriceRow),
        trendReports: trendReports.map(fromTrendReportRow),
      };
    },
    async saveCollection(name, value) {
      if (name === "recipes") return syncRecipes(client, value);
      const config = {
        expenses: ["expenses", toExpenseRow],
        inventory: ["inventory_items", toInventoryRow],
        sales: ["sales", toSaleRow],
      }[name];
      if (!config) throw new Error(`Unsupported Supabase collection: ${name}`);
      await syncTable(client, config[0], value.map(config[1]));
    },
    async saveSettings(value) {
      await assertQuery(
        client.from("settings").upsert(toSettingsRow(value), { onConflict: "id" }),
        "save settings",
      );
    },
    async saveActivity(value) {
      await syncTable(client, "activity_log", value.map(toActivityRow));
    },
    async savePriceHistory(value) {
      const rows = value.map((item) => toSupplierPriceRow(item, "inventory_history"));
      await syncSourceRows(client, "supplier_prices", "inventory_history", rows);
    },
    async saveSupplierPrices(value) {
      const rows = value.map((item) => toSupplierPriceRow(item, item.source || "manual"));
      await syncNonHistorySupplierRows(client, rows);
    },
    async saveTrendReports(value) {
      await syncTable(client, "trend_reports", value.map(toTrendReportRow));
    },
  };
}

async function selectAll(client, table, orderColumn = "created_at", ascending = false) {
  const query = client.from(table).select("*").order(orderColumn, { ascending });
  const { data, error } = await query;
  if (error) throw storageError(`load ${table}`, error);
  return data || [];
}

async function selectRecipes(client) {
  const { data, error } = await client
    .from("recipes")
    .select("*, recipe_ingredients(*)")
    .order("created_at", { ascending: false });
  if (error) throw storageError("load recipes", error);
  return (data || []).map(fromRecipeRow);
}

async function selectSettings(client) {
  const { data, error } = await client.from("settings").select("*").eq("id", "owner").maybeSingle();
  if (error) throw storageError("load settings", error);
  return data ? fromSettingsRow(data) : {};
}

async function syncTable(client, table, rows) {
  const existing = await selectIds(client, table);
  const nextIds = new Set(rows.map((row) => row.id));
  const removed = existing.filter((id) => !nextIds.has(id));
  if (rows.length) await assertQuery(client.from(table).upsert(rows, { onConflict: "id" }), `upsert ${table}`);
  if (removed.length) await assertQuery(client.from(table).delete().in("id", removed), `delete ${table}`);
}

async function syncRecipes(client, recipes) {
  const recipeRows = recipes.map(toRecipeRow);
  await syncTable(client, "recipes", recipeRows);
  for (const recipe of recipes) {
    await assertQuery(
      client.from("recipe_ingredients").delete().eq("recipe_id", recipe.id),
      "clear recipe ingredients",
    );
    const ingredients = recipe.ingredients.map((item) => toRecipeIngredientRow(recipe.id, item));
    if (ingredients.length) {
      await assertQuery(client.from("recipe_ingredients").insert(ingredients), "save recipe ingredients");
    }
  }
}

async function syncSourceRows(client, table, source, rows) {
  await assertQuery(client.from(table).delete().eq("source", source), `clear ${source}`);
  if (rows.length) await assertQuery(client.from(table).insert(rows), `save ${source}`);
}

async function syncNonHistorySupplierRows(client, rows) {
  await assertQuery(
    client.from("supplier_prices").delete().neq("source", "inventory_history"),
    "clear supplier prices",
  );
  if (rows.length) await assertQuery(client.from("supplier_prices").insert(rows), "save supplier prices");
}

async function selectIds(client, table) {
  const { data, error } = await client.from(table).select("id");
  if (error) throw storageError(`load ${table} ids`, error);
  return (data || []).map((row) => row.id);
}

async function assertQuery(query, action) {
  const { error } = await query;
  if (error) throw storageError(action, error);
}

function storageError(action, error) {
  return new Error(`[storage] Supabase could not ${action}: ${error.message}`);
}

function toMetadata(record) {
  return {
    id: record.id,
    created_at: record.createdAt || new Date().toISOString(),
    updated_at: record.updatedAt || null,
  };
}

function fromMetadata(row) {
  return { id: row.id, createdAt: row.created_at, updatedAt: row.updated_at || undefined };
}

function toExpenseRow(item) {
  return { ...toMetadata(item), date: item.date, vendor: item.vendor, category: item.category, amount: item.amount, notes: item.notes || "" };
}
function fromExpenseRow(row) {
  return { ...fromMetadata(row), date: row.date, vendor: row.vendor, category: row.category, amount: Number(row.amount), notes: row.notes || "" };
}
function toInventoryRow(item) {
  return { ...toMetadata(item), ingredient_name: item.ingredientName, quantity: item.quantity, unit: item.unit, minimum_threshold: item.minimumThreshold, supplier: item.supplier || "", cost_per_unit: item.costPerUnit };
}
function fromInventoryRow(row) {
  return { ...fromMetadata(row), ingredientName: row.ingredient_name, quantity: Number(row.quantity), unit: row.unit, minimumThreshold: Number(row.minimum_threshold), supplier: row.supplier || "", costPerUnit: Number(row.cost_per_unit) };
}
function toRecipeRow(item) {
  return { ...toMetadata(item), recipe_name: item.recipeName, category: item.category, yield_quantity: item.yieldQuantity, yield_unit: item.yieldUnit, selling_price: item.sellingPrice, preparation_notes: item.preparationNotes || "" };
}
function fromRecipeRow(row) {
  return { ...fromMetadata(row), recipeName: row.recipe_name, category: row.category, yieldQuantity: Number(row.yield_quantity), yieldUnit: row.yield_unit, sellingPrice: Number(row.selling_price), preparationNotes: row.preparation_notes || "", ingredients: (row.recipe_ingredients || []).map(fromRecipeIngredientRow) };
}
function toRecipeIngredientRow(recipeId, item) {
  return { recipe_id: recipeId, inventory_item_id: item.inventoryId || null, ingredient_name: item.ingredientName, quantity: item.quantity, unit: item.unit };
}
function fromRecipeIngredientRow(row) {
  return { inventoryId: row.inventory_item_id || "", ingredientName: row.ingredient_name, quantity: Number(row.quantity), unit: row.unit };
}
function toSaleRow(item) {
  return { ...toMetadata(item), date: item.date, product: item.product, quantity_sold: item.quantitySold, sale_amount: item.saleAmount, tax: item.tax || 0, discount: item.discount || 0, source: item.source || "manual", square_payment_id: item.squarePaymentId || null, square_order_id: item.squareOrderId || null, sold_at: item.soldAt || `${item.date}T12:00:00Z` };
}
function fromSaleRow(row) {
  return { ...fromMetadata(row), date: row.date, product: row.product, quantitySold: Number(row.quantity_sold), saleAmount: Number(row.sale_amount), tax: Number(row.tax || 0), discount: Number(row.discount || 0), source: row.source || "manual", squarePaymentId: row.square_payment_id || undefined, squareOrderId: row.square_order_id || undefined, soldAt: row.sold_at || undefined };
}
function toActivityRow(item) {
  return { id: item.id, action: item.action, description: item.description, timestamp: item.timestamp };
}
function fromActivityRow(row) {
  return { id: row.id, action: row.action, description: row.description, timestamp: row.timestamp };
}
function toSupplierPriceRow(item, source) {
  return { id: item.id, inventory_item_id: item.inventoryId || null, ingredient_name: item.ingredientName, supplier: item.supplier || "", cost_per_unit: item.costPerUnit, unit: item.unit, source, recorded_at: item.recordedAt || new Date().toISOString(), metadata: { reason: item.reason || "" } };
}
function fromSupplierPriceRow(row) {
  return { id: row.id, inventoryId: row.inventory_item_id || "", ingredientName: row.ingredient_name, supplier: row.supplier || "", costPerUnit: Number(row.cost_per_unit), unit: row.unit, source: row.source, recordedAt: row.recorded_at, reason: row.metadata?.reason || "" };
}
function toTrendReportRow(item) {
  return { id: item.id, trend_name: item.trendName, why_trending: item.whyTrending || "", product_ideas: item.productIdeas || [], difficulty: item.difficulty || "", price_range: item.priceRange || "", ingredients: item.ingredients || [], product_fit: item.productFit || [], seed_keywords: item.seedKeywords || [], source: item.source || "manual", created_at: item.createdAt || new Date().toISOString() };
}
function fromTrendReportRow(row) {
  return { id: row.id, trendName: row.trend_name, whyTrending: row.why_trending, productIdeas: row.product_ideas || [], difficulty: row.difficulty, priceRange: row.price_range, ingredients: row.ingredients || [], productFit: row.product_fit || [], seedKeywords: row.seed_keywords || [], source: row.source, createdAt: row.created_at };
}
function toSettingsRow(item) {
  return { id: "owner", business_name: item.businessName || "", owner_name: item.ownerName || "", currency: item.currency || "USD", shopping_target_multiplier: item.shoppingTargetMultiplier || 2, updated_at: new Date().toISOString() };
}
function fromSettingsRow(row) {
  return { businessName: row.business_name || "", ownerName: row.owner_name || "", currency: row.currency || "USD", shoppingTargetMultiplier: Number(row.shopping_target_multiplier || 2) };
}

function loadArray(filePath) {
  const value = loadJson(filePath, []);
  return Array.isArray(value) ? value : [];
}
function loadObject(filePath) {
  const value = loadJson(filePath, {});
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function loadJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); }
  catch (error) { console.error(`[storage] Could not load ${filePath}: ${error.message}`); return fallback; }
}
function ensureJson(filePath, value) {
  if (!fs.existsSync(filePath)) writeJsonAtomic(filePath, value);
}
function writeJsonAtomic(filePath, value) {
  const tempPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(tempPath, filePath);
}

module.exports = { createStorage };
