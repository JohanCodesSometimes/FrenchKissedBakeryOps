const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { applyReceiptItemsToInventory, buildInventoryIntelligence } = require("../inventory-analytics");
const { createStorage } = require("../storage");

function supabaseInventoryClient(getRows) {
  return {
    from(table) {
      assert.equal(table, "inventory_items");
      return {
        select(columns) {
          assert.equal(columns, "*");
          return {
            async order(column, options) {
              assert.equal(column, "created_at");
              assert.deepEqual(options, { ascending: false });
              return { data: getRows(), error: null };
            },
          };
        },
      };
    },
  };
}

test("inventory summary uses live Supabase database values", async () => {
  let databaseRows = [
    { id: "flour", ingredient_name: "Flour", category: "Ingredients", quantity: "10", unit: "lb", minimum_threshold: "5", supplier: "Mill", cost_per_unit: "2.00", created_at: "2026-06-01T10:00:00Z", updated_at: "2026-06-20T10:00:00Z" },
    { id: "boxes", ingredient_name: "Cake Boxes", category: "Packaging", quantity: "2", unit: "count", minimum_threshold: "3", supplier: "Pack Co", cost_per_unit: "4.00", created_at: "2026-06-02T10:00:00Z", updated_at: "2026-06-25T10:00:00Z" },
    { id: "eggs", ingredient_name: "Eggs", category: "Ingredients", quantity: "0", unit: "dozen", minimum_threshold: "2", supplier: "Farm", cost_per_unit: "5.00", created_at: "2026-06-03T10:00:00Z", updated_at: null },
  ];
  const storage = await createStorage({
    dataDir: ".",
    env: { SUPABASE_URL: "https://example.supabase.co", SUPABASE_ANON_KEY: "anon", SUPABASE_SERVICE_ROLE_KEY: "service" },
    logger: { log() {}, warn() {} },
    supabaseClient: supabaseInventoryClient(() => databaseRows),
  });

  let inventory = await storage.loadCollection("inventory");
  let intelligence = buildInventoryIntelligence(inventory);
  assert.deepEqual(intelligence.summary, {
    totalTrackedItems: 3,
    lowStockCount: 2,
    estimatedInventoryValue: 28,
    recentlyUpdatedCount: 3,
  });
  assert.deepEqual(intelligence.lowStock.map((item) => [item.ingredientName, item.status]), [
    ["Cake Boxes", "Low Stock"],
    ["Eggs", "Out of Stock"],
  ]);
  assert.equal(intelligence.recentlyUpdatedItems[0].ingredientName, "Cake Boxes");
  assert.equal(intelligence.all[0].category, "Ingredients");

  databaseRows = [...databaseRows, { id: "sugar", ingredient_name: "Sugar", category: "Ingredients", quantity: "5", unit: "lb", minimum_threshold: "1", supplier: "", cost_per_unit: "3.00", created_at: "2026-06-26T10:00:00Z", updated_at: null }];
  inventory = await storage.loadCollection("inventory");
  intelligence = buildInventoryIntelligence(inventory);
  assert.equal(intelligence.summary.totalTrackedItems, 4);
  assert.equal(intelligence.summary.estimatedInventoryValue, 43);
});

test("low-stock detection assigns owner-friendly statuses", () => {
  const intelligence = buildInventoryIntelligence([
    { ingredientName: "Flour", quantity: 8, minimumThreshold: 2, costPerUnit: 1 },
    { ingredientName: "Butter", quantity: 1, minimumThreshold: 3, costPerUnit: 2 },
    { ingredientName: "Eggs", quantity: 0, minimumThreshold: 2, costPerUnit: 3 },
  ]);
  assert.deepEqual(intelligence.all.map((item) => item.status), ["In Stock", "Low Stock", "Out of Stock"]);
  assert.deepEqual(intelligence.lowStock.map((item) => item.ingredientName), ["Butter", "Eggs"]);
});

test("empty inventory state renders correctly", () => {
  assert.deepEqual(buildInventoryIntelligence([]), {
    summary: { totalTrackedItems: 0, lowStockCount: 0, estimatedInventoryValue: 0, recentlyUpdatedCount: 0 },
    recentlyUpdatedItems: [],
    lowStock: [],
    all: [],
  });

  const root = path.join(__dirname, "..");
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const script = fs.readFileSync(path.join(root, "script.js"), "utf8");
  assert.match(html, /id="inventory-alerts-body"/);
  assert.match(html, /id="inventory-body"/);
  assert.equal(script.includes('tableEmpty(4, "No inventory items added yet"'), true);
  assert.equal(script.includes('tableEmpty(10, "No inventory items added yet"'), true);
});

test("approved receipt items update inventory quantities and totals", () => {
  const inventory = [
    { id: "flour", ingredientName: "Flour", category: "Ingredients", quantity: 2, unit: "lb", minimumThreshold: 1, supplier: "Old Store", costPerUnit: 3, createdAt: "2026-06-01T10:00:00Z" },
  ];
  let id = 0;
  const results = applyReceiptItemsToInventory(inventory, [
    { itemName: "Flour", category: "Ingredients", quantity: 3, unit: "lb", unitPrice: 4, updateInventory: true },
    { itemName: "Cake Boxes", category: "Packaging", quantity: 1, unit: "count", unitPrice: 5, updateInventory: true },
    { itemName: "Delivery Fee", category: "Other", quantity: 1, unit: "count", unitPrice: 2, updateInventory: false },
  ], {
    storeName: "Bakery Supply",
    now: "2026-06-26T12:00:00Z",
    createId: () => "new-" + (++id),
  });

  assert.equal(results.filter((result) => result.inventoryItem).length, 2);
  assert.equal(inventory.find((item) => item.id === "flour").quantity, 5);
  assert.equal(inventory.find((item) => item.id === "flour").costPerUnit, 4);
  assert.equal(inventory.find((item) => item.ingredientName === "Cake Boxes").category, "Packaging");
  assert.deepEqual(buildInventoryIntelligence(inventory).summary, {
    totalTrackedItems: 2,
    lowStockCount: 0,
    estimatedInventoryValue: 25,
    recentlyUpdatedCount: 2,
  });

  const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.equal(server.includes("applyReceiptItemsToInventory(collections.inventory, reviewed.items"), true);
});
