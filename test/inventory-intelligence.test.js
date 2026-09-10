const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { buildInventoryIntelligence } = require("../inventory-analytics");
const { planInventoryAdjustments } = require("../receipt-inventory");
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

test("receipt stock planning targets existing inventory without creating duplicates", () => {
  const inventory = [
    { id: "flour", ingredientName: "Flour", category: "Ingredients", quantity: 2, unit: "lb", minimumThreshold: 1, supplier: "Old Store", costPerUnit: 3, createdAt: "2026-06-01T10:00:00Z" },
  ];
  const plan = planInventoryAdjustments(inventory, [
    { itemName: "Flour", category: "Ingredients", receivedQuantity: 3, receivedUnit: "lb", inventoryItemId: "flour", updateInventory: true },
    { itemName: "Cake Boxes", category: "Packaging", receivedQuantity: 1, receivedUnit: "count", inventoryItemId: "", updateInventory: false },
    { itemName: "Delivery Fee", category: "Other", receivedQuantity: 1, receivedUnit: "count", updateInventory: false },
  ]);

  assert.equal(plan.adjustments.length, 1);
  assert.equal(plan.adjustments[0].afterQuantity, 5);
  assert.equal(plan.unresolvedLines[0].itemName, "Cake Boxes");
  assert.equal(inventory.length, 1);
  assert.deepEqual(buildInventoryIntelligence(inventory).summary, {
    totalTrackedItems: 1,
    lowStockCount: 0,
    estimatedInventoryValue: 6,
    recentlyUpdatedCount: 1,
  });

  const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.equal(server.includes("planInventoryAdjustments(collections.inventory, reviewed.items"), true);
  assert.equal(server.includes("storage.applyReceiptApproval"), true);
});
