const unitDefinitions = {
  g: { group: "mass", factor: 1 },
  kg: { group: "mass", factor: 1000 },
  oz: { group: "mass", factor: 28.349523125 },
  lb: { group: "mass", factor: 453.59237 },
  count: { group: "count", factor: 1 },
  dozen: { group: "count", factor: 12 },
  gallon: { group: "volume", factor: 1 },
};

function buildPurchasingIntelligence({
  inventory = [], sales = [], recipes = [], priceHistory = [], expenses = [], receiptItems = [],
  now = new Date(), lookbackDays = 30, targetDays = 14, targetMultiplier = 2,
} = {}) {
  const usage = calculateDailyUsage({ inventory, sales, recipes, now, lookbackDays });
  const usageById = new Map(usage.map((item) => [item.inventoryId, item]));
  const reorderRecommendations = inventory.map((item) => {
    const quantity = Number(item.quantity || 0);
    const minimumThreshold = Number(item.minimumThreshold || 0);
    const costPerUnit = Number(item.costPerUnit || 0);
    const dailyUsage = usageById.get(item.id)?.estimatedDailyUsage || 0;
    const daysRemaining = dailyUsage > 0 ? round(quantity / dailyUsage) : null;
    const thresholdTarget = minimumThreshold * Number(targetMultiplier || 2);
    const usageTarget = dailyUsage * Number(targetDays || 14) + minimumThreshold;
    const targetQuantity = Math.max(minimumThreshold, thresholdTarget, usageTarget);
    const recommendedReorderQuantity = round(Math.max(targetQuantity - quantity, 0));
    const urgency = quantity <= 0 || daysRemaining !== null && daysRemaining <= 3
      ? "Critical"
      : quantity <= minimumThreshold || daysRemaining !== null && daysRemaining <= 7
        ? "Low"
        : "Good";
    const daysUntilRestockRequired = quantity <= minimumThreshold
      ? 0
      : dailyUsage > 0 ? round((quantity - minimumThreshold) / dailyUsage) : null;
    return {
      inventoryId: item.id,
      ingredientName: item.ingredientName,
      currentQuantity: quantity,
      unit: item.unit,
      minimumThreshold,
      supplier: item.supplier || "",
      costPerUnit,
      estimatedDailyUsage: dailyUsage,
      estimatedDaysRemaining: daysRemaining,
      daysUntilRestockRequired,
      recommendedReorderQuantity,
      estimatedReorderCost: round(recommendedReorderQuantity * costPerUnit),
      urgency,
    };
  }).sort((a, b) => urgencyRank(a.urgency) - urgencyRank(b.urgency) ||
    (a.estimatedDaysRemaining ?? Number.POSITIVE_INFINITY) - (b.estimatedDaysRemaining ?? Number.POSITIVE_INFINITY));

  const supplierPriceHistory = buildSupplierPriceHistory(priceHistory);
  const estimatedReorderCost = round(reorderRecommendations.reduce(
    (total, item) => total + item.estimatedReorderCost, 0,
  ));
  const inventoryValue = round(inventory.reduce(
    (total, item) => total + Number(item.quantity || 0) * Number(item.costPerUnit || 0), 0,
  ));
  const restockDays = reorderRecommendations
    .map((item) => item.daysUntilRestockRequired)
    .filter((value) => value !== null && Number.isFinite(value));
  const monthlyIngredientSpending = calculateMonthlyIngredientSpending({ expenses, receiptItems, now });
  const changes = supplierPriceHistory.filter((item) => item.percentChange !== null);

  return {
    usageWindowDays: lookbackDays,
    reorderTargetDays: targetDays,
    reorderRecommendations,
    supplierPriceHistory,
    costTrends: {
      biggestPriceIncrease: changes.filter((item) => item.percentChange > 0)
        .sort((a, b) => b.percentChange - a.percentChange)[0] || null,
      biggestPriceDecrease: changes.filter((item) => item.percentChange < 0)
        .sort((a, b) => a.percentChange - b.percentChange)[0] || null,
      monthlyIngredientSpending,
      estimatedNextOrderCost: estimatedReorderCost,
    },
    forecast: {
      inventoryValue,
      ingredientsRunningOutThisWeek: reorderRecommendations.filter(
        (item) => item.currentQuantity <= 0 ||
          item.estimatedDaysRemaining !== null && item.estimatedDaysRemaining <= 7,
      ).length,
      estimatedReorderCost,
      projectedDaysUntilRestockRequired: restockDays.length ? Math.min(...restockDays) : null,
    },
  };
}

function calculateDailyUsage({ inventory = [], sales = [], recipes = [], now = new Date(), lookbackDays = 30 } = {}) {
  const usageById = new Map(inventory.map((item) => [item.id, 0]));
  const cutoff = new Date(now);
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - lookbackDays + 1);
  const recentSquareSales = sales.filter((sale) => {
    const saleDate = new Date(String(sale.date || "") + "T00:00:00");
    return (sale.source || "").toLowerCase() === "square" && saleDate >= cutoff && saleDate <= now;
  });

  for (const sale of recentSquareSales) {
    const productNames = String(sale.product || "").split(",").map(normalizeName).filter(Boolean);
    const matchingRecipes = recipes.filter((recipe) => productNames.includes(normalizeName(recipe.recipeName)));
    if (!matchingRecipes.length) continue;
    const soldPerRecipe = Number(sale.quantitySold || 0) / matchingRecipes.length;
    for (const recipe of matchingRecipes) {
      const yieldQuantity = Number(recipe.yieldQuantity || 0);
      if (!(yieldQuantity > 0)) continue;
      for (const ingredient of recipe.ingredients || []) {
        const inventoryItem = findInventoryItem(ingredient, inventory);
        if (!inventoryItem) continue;
        const usedPerBatch = convertQuantity(ingredient.quantity, ingredient.unit, inventoryItem.unit);
        if (usedPerBatch === null) continue;
        const estimatedDeduction = (usedPerBatch / yieldQuantity) * soldPerRecipe;
        usageById.set(inventoryItem.id, (usageById.get(inventoryItem.id) || 0) + estimatedDeduction);
      }
    }
  }

  return inventory.map((item) => ({
    inventoryId: item.id,
    ingredientName: item.ingredientName,
    unit: item.unit,
    estimatedUsage: round(usageById.get(item.id) || 0),
    estimatedDailyUsage: round((usageById.get(item.id) || 0) / lookbackDays),
  }));
}

function buildSupplierPriceHistory(priceHistory = []) {
  const groups = new Map();
  for (const entry of priceHistory) {
    const key = normalizeName(entry.ingredientName) + "|" + normalizeName(entry.supplier);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  return [...groups.values()].map((entries) => {
    const sorted = [...entries].sort((a, b) => String(a.recordedAt || "").localeCompare(String(b.recordedAt || "")));
    const current = sorted[sorted.length - 1];
    const previous = sorted.length > 1 ? sorted[sorted.length - 2] : null;
    const previousPrice = previous ? Number(previous.costPerUnit || 0) : null;
    const currentPrice = Number(current.costPerUnit || 0);
    const percentChange = previousPrice && previousPrice !== 0
      ? round(((currentPrice - previousPrice) / previousPrice) * 100)
      : null;
    return {
      ingredientName: current.ingredientName,
      supplier: current.supplier || "Not set",
      unit: current.unit,
      previousPrice,
      currentPrice,
      percentChange,
      recordedAt: current.recordedAt || "",
    };
  }).sort((a, b) => String(b.recordedAt).localeCompare(String(a.recordedAt)));
}

function calculateMonthlyIngredientSpending({ expenses = [], receiptItems = [], now = new Date() } = {}) {
  const month = localDateKey(now).slice(0, 7);
  const ingredientReceiptItems = receiptItems.filter((item) =>
    String(item.receiptDate || "").startsWith(month) &&
    item.category === "Ingredients" &&
    !item.isDiscount && !item.isFee && !item.isDeposit,
  );
  const receiptSpending = ingredientReceiptItems.reduce(
    (total, item) => total + Number(item.totalPrice || 0),
    0,
  );
  const manualExpenseSpending = expenses
    .filter((expense) =>
      expense.category === "Ingredients" &&
      String(expense.date || "").startsWith(month) &&
      !String(expense.notes || "").startsWith("Receipt upload."),
    )
    .reduce((total, expense) => total + Number(expense.amount || 0), 0);
  return round(receiptSpending + manualExpenseSpending);
}

function findInventoryItem(ingredient, inventory) {
  if (ingredient.inventoryId) {
    const byId = inventory.find((item) => item.id === ingredient.inventoryId);
    if (byId) return byId;
  }
  const name = normalizeName(ingredient.ingredientName);
  return inventory.find((item) => normalizeName(item.ingredientName) === name);
}

function convertQuantity(quantity, fromUnit, toUnit) {
  const from = unitDefinitions[fromUnit];
  const to = unitDefinitions[toUnit];
  if (!from || !to || from.group !== to.group) return null;
  return Number(quantity || 0) * from.factor / to.factor;
}

function urgencyRank(urgency) {
  return { Critical: 0, Low: 1, Good: 2 }[urgency] ?? 3;
}

function normalizeName(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function localDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return [year, month, day].join("-");
}

function round(value) {
  return Math.round(Number(value) * 100) / 100;
}

module.exports = {
  buildPurchasingIntelligence,
  buildSupplierPriceHistory,
  calculateDailyUsage,
  calculateMonthlyIngredientSpending,
  convertQuantity,
};
