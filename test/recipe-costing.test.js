const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { calculateRecipeProfitability, suggestedPrice } = require("../recipe-costing");

function fixture() {
  return {
    recipe: {
      id: "cookie",
      recipeName: "Cookie Batch",
      yieldQuantity: 5,
      yieldUnit: "cookies",
      sellingPrice: 2,
      createdAt: "2026-06-01T10:00:00Z",
      updatedAt: "2026-06-26T10:00:00Z",
      ingredients: [
        { inventoryId: "flour", ingredientName: "Flour", quantity: 8, unit: "oz" },
        { inventoryId: "eggs", ingredientName: "Eggs", quantity: 6, unit: "count" },
      ],
    },
    inventory: [
      { id: "flour", ingredientName: "Flour", unit: "lb", costPerUnit: 2 },
      { id: "eggs", ingredientName: "Eggs", unit: "dozen", costPerUnit: 3 },
    ],
  };
}

test("recipe cost totals calculate correctly", () => {
  const { recipe, inventory } = fixture();
  const result = calculateRecipeProfitability(recipe, inventory);
  assert.equal(result.costBreakdown[0].cost, 1);
  assert.equal(result.costBreakdown[1].cost, 1.5);
  assert.equal(result.totalRecipeCost, 2.5);
  assert.equal(result.allCostsAvailable, true);
});

test("cost per serving calculates correctly", () => {
  const { recipe, inventory } = fixture();
  const result = calculateRecipeProfitability(recipe, inventory);
  assert.equal(result.costPerUnit, 0.5);
  assert.equal(result.lastUpdated, "2026-06-26T10:00:00Z");
});

test("gross profit and profit margin calculate correctly", () => {
  const { recipe, inventory } = fixture();
  const result = calculateRecipeProfitability(recipe, inventory);
  assert.equal(result.profitPerUnit, 1.5);
  assert.equal(result.profitMargin, 75);
});

test("suggested prices calculate correctly for target margins", () => {
  assert.equal(suggestedPrice(0.5, 50), 1);
  assert.equal(suggestedPrice(0.5, 60), 1.25);
  assert.equal(suggestedPrice(0.5, 70), 1.67);

  const { recipe, inventory } = fixture();
  assert.deepEqual(calculateRecipeProfitability(recipe, inventory).suggestedPrices, {
    margin50: 1,
    margin60: 1.25,
    margin70: 1.67,
  });
});

test("recipes use current inventory unit costs", () => {
  const { recipe, inventory } = fixture();
  assert.equal(calculateRecipeProfitability(recipe, inventory).totalRecipeCost, 2.5);
  inventory.find((item) => item.id === "flour").costPerUnit = 4;
  const updated = calculateRecipeProfitability(recipe, inventory);
  assert.equal(updated.totalRecipeCost, 3.5);
  assert.equal(updated.costPerUnit, 0.7);
});

test("recipe calculator and profitability table render graceful empty states", () => {
  const root = path.join(__dirname, "..");
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const script = fs.readFileSync(path.join(root, "script.js"), "utf8");
  assert.match(html, /Recipe Cost Calculator/);
  assert.match(html, /id="recipe-profitability-body"/);
  assert.match(script, /50% Margin/);
  assert.equal(script.includes('tableEmpty(' + String.fromCharCode(10) + '      7,'), true);
  assert.match(script, /suggestedPrices.margin70/);
});
