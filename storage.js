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
  squareConnection: "square-connection.json",
  receiptItems: "receipt-items.json",
  receipts: "receipts.json",
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
        squareConnection: loadObject(path.join(resolvedDir, localFiles.squareConnection)),
        receiptItems: loadArray(path.join(resolvedDir, localFiles.receiptItems)),
        receipts: loadArray(path.join(resolvedDir, localFiles.receipts)),
      };
      for (const name of collectionNames) {
        ensureJson(path.join(resolvedDir, `${name}.json`), state.collections[name]);
      }
      ensureJson(path.join(resolvedDir, localFiles.settings), state.settings);
      ensureJson(path.join(resolvedDir, localFiles.activity), state.activity);
      ensureJson(path.join(resolvedDir, localFiles.priceHistory), state.priceHistory);
      ensureJson(path.join(resolvedDir, localFiles.supplierPrices), state.supplierPrices);
      ensureJson(path.join(resolvedDir, localFiles.trendReports), state.trendReports);
      ensureJson(path.join(resolvedDir, localFiles.squareConnection), state.squareConnection);
      ensureJson(path.join(resolvedDir, localFiles.receiptItems), state.receiptItems);
      ensureJson(path.join(resolvedDir, localFiles.receipts), state.receipts);
      return state;
    },
    async loadCollection(name) {
      if (!collectionNames.includes(name)) throw new Error(`Unsupported local collection: ${name}`);
      return loadArray(path.join(resolvedDir, `${name}.json`));
    },
    async loadPriceHistory() {
      return loadArray(path.join(resolvedDir, localFiles.priceHistory));
    },
    async loadReceiptItems() {
      return loadArray(path.join(resolvedDir, localFiles.receiptItems));
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
    async saveSquareConnection(value) {
      writeJsonAtomic(path.join(resolvedDir, localFiles.squareConnection), value);
    },
    async saveReceiptItems(value) {
      writeJsonAtomic(path.join(resolvedDir, localFiles.receiptItems), value);
    },
    async saveReceipts(value) {
      writeJsonAtomic(path.join(resolvedDir, localFiles.receipts), value);
    },
  };
}

function createSupabaseStorage(client) {
  return {
    mode: "supabase",
    async initialize() {
      const [expenses, inventory, recipes, sales, settings, activity, supplierPrices, trendReports, squareConnection, receiptItems, receipts] =
        await Promise.all([
          selectAll(client, "expenses"),
          selectAll(client, "inventory_items"),
          selectRecipes(client),
          selectAll(client, "sales"),
          selectSettings(client),
          selectAll(client, "activity_log", "timestamp", false),
          selectAll(client, "supplier_prices", "recorded_at", false),
          selectAll(client, "trend_reports", "created_at", false),
          selectSquareConnection(client),
          selectReceiptItems(client),
          selectReceipts(client),
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
        squareConnection,
        receiptItems: receiptItems.map(fromReceiptItemRow),
        receipts: receipts.map(fromReceiptRow),
      };
    },
    async loadCollection(name) {
      if (name === "recipes") return selectRecipes(client);
      const config = {
        expenses: ["expenses", fromExpenseRow],
        inventory: ["inventory_items", fromInventoryRow],
        sales: ["sales", fromSaleRow],
      }[name];
      if (!config) throw new Error(`Unsupported Supabase collection: ${name}`);
      const rows = await selectAll(client, config[0]);
      return rows.map(config[1]);
    },
    async loadPriceHistory() {
      const rows = await selectAll(client, "supplier_prices", "recorded_at", false);
      return rows.filter((row) => row.source === "inventory_history").map(fromSupplierPriceRow);
    },
    async loadReceiptItems() {
      return (await selectReceiptItems(client)).map(fromReceiptItemRow);
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
    async saveSquareConnection(value) {
      await assertQuery(
        client.from("square_connections").upsert(toSquareConnectionRow(value), { onConflict: "id" }),
        "save Square connection",
      );
    },
    async saveReceiptItems(value) {
      await syncTable(client, "receipt_items", value.map(toReceiptItemRow));
    },
    async saveReceipts(value) {
      await syncTable(client, "receipts", value.map(toReceiptRow));
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

async function selectSquareConnection(client) {
  const { data, error } = await client.from("square_connections").select("*").eq("id", "owner").maybeSingle();
  if (error && ["42P01", "PGRST205"].includes(error.code)) return {};
  if (error) throw storageError("load Square connection", error);
  return data ? fromSquareConnectionRow(data) : {};
}

async function selectReceiptItems(client) {
  try {
    return await selectAll(client, "receipt_items");
  } catch (error) {
    if (/receipt_items|schema cache|does not exist/i.test(error.message)) return [];
    throw error;
  }
}

async function selectReceipts(client) {
  try {
    return await selectAll(client, "receipts", "uploaded_at", false);
  } catch (error) {
    if (/receipts|schema cache|does not exist/i.test(error.message)) return [];
    throw error;
  }
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
  return { ...toMetadata(item), ingredient_name: item.ingredientName, category: item.category || "Ingredients", quantity: item.quantity, unit: item.unit, minimum_threshold: item.minimumThreshold, supplier: item.supplier || "", cost_per_unit: item.costPerUnit };
}
function fromInventoryRow(row) {
  return { ...fromMetadata(row), ingredientName: row.ingredient_name, category: row.category || "Ingredients", quantity: Number(row.quantity), unit: row.unit, minimumThreshold: Number(row.minimum_threshold), supplier: row.supplier || "", costPerUnit: Number(row.cost_per_unit) };
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
function toSquareConnectionRow(item) {
  return {
    id: "owner",
    merchant_id: item.merchantId || null,
    access_token: item.accessToken || null,
    refresh_token: item.refreshToken || null,
    token_expires_at: item.tokenExpiresAt || null,
    scopes: item.scopes || null,
    connected_at: item.connectedAt || null,
    last_sync_at: item.lastSyncAt || null,
    last_error: item.lastError || null,
    oauth_state: item.oauthState || null,
    oauth_state_expires_at: item.oauthStateExpiresAt || null,
    environment: item.environment || "sandbox",
    updated_at: new Date().toISOString(),
  };
}
function fromSquareConnectionRow(row) {
  return {
    merchantId: row.merchant_id || "",
    accessToken: row.access_token || "",
    refreshToken: row.refresh_token || "",
    tokenExpiresAt: row.token_expires_at || "",
    scopes: row.scopes || "",
    connectedAt: row.connected_at || "",
    lastSyncAt: row.last_sync_at || "",
    lastError: row.last_error || "",
    oauthState: row.oauth_state || "",
    oauthStateExpiresAt: row.oauth_state_expires_at || "",
    environment: row.environment || "sandbox",
  };
}
function toReceiptItemRow(item) {
  return {
    id: item.id,
    expense_id: item.expenseId,
    receipt_id: item.receiptId || null,
    inventory_item_id: item.inventoryItemId || null,
    store_name: item.storeName,
    receipt_date: item.receiptDate,
    item_name: item.itemName,
    raw_line: item.rawLine || "",
    quantity: item.quantity,
    unit: item.unit,
    unit_price: item.unitPrice,
    total_price: item.totalPrice,
    category: item.category,
    update_inventory: Boolean(item.updateInventory),
    is_discount: Boolean(item.isDiscount),
    is_fee: Boolean(item.isFee),
    is_deposit: Boolean(item.isDeposit),
    created_at: item.createdAt || new Date().toISOString(),
  };
}
function fromReceiptItemRow(row) {
  return {
    id: row.id,
    expenseId: row.expense_id,
    receiptId: row.receipt_id || "",
    inventoryItemId: row.inventory_item_id || "",
    storeName: row.store_name,
    receiptDate: row.receipt_date,
    itemName: row.item_name,
    rawLine: row.raw_line || "",
    quantity: Number(row.quantity),
    unit: row.unit,
    unitPrice: Number(row.unit_price),
    totalPrice: Number(row.total_price),
    category: row.category,
    updateInventory: Boolean(row.update_inventory),
    isDiscount: Boolean(row.is_discount),
    isFee: Boolean(row.is_fee),
    isDeposit: Boolean(row.is_deposit),
    createdAt: row.created_at,
  };
}
function toReceiptRow(item) {
  return {
    id: item.id,
    expense_id: item.expenseId || null,
    file_name: item.fileName,
    mime_type: item.mimeType || "application/octet-stream",
    file_size: item.fileSize || 0,
    extraction_source: item.extractionSource || "",
    store_name: item.storeName || "",
    receipt_date: item.receiptDate || null,
    subtotal: item.subtotal || 0,
    tax: item.tax || 0,
    total: item.total || 0,
    item_count: item.itemCount || 0,
    status: item.status,
    error_code: item.errorCode || "",
    uploaded_at: item.uploadedAt,
    approved_at: item.approvedAt || null,
  };
}
function fromReceiptRow(row) {
  return {
    id: row.id,
    expenseId: row.expense_id || "",
    fileName: row.file_name,
    mimeType: row.mime_type,
    fileSize: Number(row.file_size || 0),
    extractionSource: row.extraction_source || "",
    storeName: row.store_name || "",
    receiptDate: row.receipt_date || "",
    subtotal: Number(row.subtotal || 0),
    tax: Number(row.tax || 0),
    total: Number(row.total || 0),
    itemCount: Number(row.item_count || 0),
    status: row.status,
    errorCode: row.error_code || "",
    uploadedAt: row.uploaded_at,
    approvedAt: row.approved_at || "",
  };
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
