const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  buildPurchasingIntelligence,
  buildSupplierPriceHistory,
  calculateDailyUsage,
} = require("../purchasing-intelligence");

function fixture() {
  return {
    now: new Date(2026, 5, 26, 12),
    inventory: [
      { id: "flour", ingredientName: "Flour", quantity: 5, unit: "lb", minimumThreshold: 2, supplier: "Mill", costPerUnit: 2 },
      { id: "eggs", ingredientName: "Eggs", quantity: 1, unit: "dozen", minimumThreshold: 1, supplier: "Farm", costPerUnit: 3 },
      { id: "sugar", ingredientName: "Sugar", quantity: 0, unit: "lb", minimumThreshold: 1, supplier: "Mill", costPerUnit: 1 },
    ],
    recipes: [{
      recipeName: "Cookie Batch",
      yieldQuantity: 10,
      ingredients: [
        { inventoryId: "flour", ingredientName: "Flour", quantity: 1, unit: "lb" },
        { inventoryId: "eggs", ingredientName: "Eggs", quantity: 1, unit: "dozen" },
      ],
    }],
    sales: [
      { date: "2026-06-25", product: "Cookie Batch", quantitySold: 30, source: "square", status: "completed" },
      { date: "2026-06-25", product: "Cookie Batch", quantitySold: 100, source: "square", status: "refunded" },
      { date: "2026-06-25", product: "Cookie Batch", quantitySold: 100, source: "square", status: "canceled" },
      { date: "2026-06-25", product: "Cookie Batch", quantitySold: 100, source: "manual" },
      { date: "2026-05-01", product: "Cookie Batch", quantitySold: 100, source: "square" },
    ],
    priceHistory: [
      { ingredientName: "Flour", supplier: "Mill", unit: "lb", costPerUnit: 2, recordedAt: "2026-05-01T10:00:00Z" },
      { ingredientName: "Flour", supplier: "Mill", unit: "lb", costPerUnit: 2.5, recordedAt: "2026-06-20T10:00:00Z" },
      { ingredientName: "Eggs", supplier: "Farm", unit: "dozen", costPerUnit: 4, recordedAt: "2026-05-02T10:00:00Z" },
      { ingredientName: "Eggs", supplier: "Farm", unit: "dozen", costPerUnit: 3, recordedAt: "2026-06-21T10:00:00Z" },
    ],
    receiptItems: [
      { receiptDate: "2026-06-10", category: "Ingredients", totalPrice: 20 },
      { receiptDate: "2026-06-20", category: "Ingredients", totalPrice: 10 },
      { receiptDate: "2026-06-20", category: "Packaging", totalPrice: 7 },
    ],
    expenses: [{ date: "2026-06-05", category: "Ingredients", amount: 99 }],
  };
}

test("daily usage calculations use recent Square sales and recipe deductions", () => {
  const data = fixture();
  const usage = calculateDailyUsage(data);
  assert.deepEqual(usage.map((item) => [item.ingredientName, item.estimatedUsage, item.estimatedDailyUsage]), [
    ["Flour", 3, 0.1],
    ["Eggs", 3, 0.1],
    ["Sugar", 0, 0],
  ]);
});

test("reorder recommendations calculate quantity, days remaining, and urgency", () => {
  const data = buildPurchasingIntelligence(fixture());
  const flour = data.reorderRecommendations.find((item) => item.ingredientName === "Flour");
  const eggs = data.reorderRecommendations.find((item) => item.ingredientName === "Eggs");
  const sugar = data.reorderRecommendations.find((item) => item.ingredientName === "Sugar");
  assert.deepEqual(
    { days: flour.estimatedDaysRemaining, reorder: flour.recommendedReorderQuantity, urgency: flour.urgency },
    { days: 50, reorder: 0, urgency: "Good" },
  );
  assert.deepEqual(
    { days: eggs.estimatedDaysRemaining, reorder: eggs.recommendedReorderQuantity, urgency: eggs.urgency },
    { days: 10, reorder: 1.4, urgency: "Low" },
  );
  assert.deepEqual(
    { days: sugar.estimatedDaysRemaining, reorder: sugar.recommendedReorderQuantity, urgency: sugar.urgency },
    { days: null, reorder: 2, urgency: "Critical" },
  );
});

test("forecast calculations use inventory values and reorder projections", () => {
  const data = buildPurchasingIntelligence(fixture());
  assert.deepEqual(data.forecast, {
    inventoryValue: 13,
    ingredientsRunningOutThisWeek: 1,
    estimatedReorderCost: 6.2,
    projectedDaysUntilRestockRequired: 0,
  });
});

test("supplier history rendering receives previous, current, and percent changes", () => {
  const input = fixture();
  const history = buildSupplierPriceHistory(input.priceHistory);
  assert.deepEqual(history.map((item) => [item.ingredientName, item.previousPrice, item.currentPrice, item.percentChange]), [
    ["Eggs", 4, 3, -25],
    ["Flour", 2, 2.5, 25],
  ]);

  const root = path.join(__dirname, "..");
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const script = fs.readFileSync(path.join(root, "script.js"), "utf8");
  assert.match(html, /id="supplier-price-history-body"/);
  assert.match(html, /No supplier price history yet/);
  assert.match(script, /item.previousPrice/);
  assert.match(script, /formatPercentChange/);
});

test("cost trend calculations find biggest changes and monthly spending", () => {
  const data = buildPurchasingIntelligence(fixture());
  assert.equal(data.costTrends.biggestPriceIncrease.ingredientName, "Flour");
  assert.equal(data.costTrends.biggestPriceIncrease.percentChange, 25);
  assert.equal(data.costTrends.biggestPriceDecrease.ingredientName, "Eggs");
  assert.equal(data.costTrends.biggestPriceDecrease.percentChange, -25);
  assert.equal(data.costTrends.monthlyIngredientSpending, 129);
  assert.equal(data.costTrends.estimatedNextOrderCost, 6.2);
});
