const unitDefinitions = {
  g: { group: "mass", factor: 1 },
  kg: { group: "mass", factor: 1000 },
  oz: { group: "mass", factor: 28.349523125 },
  lb: { group: "mass", factor: 453.59237 },
  count: { group: "count", factor: 1 },
  dozen: { group: "count", factor: 12 },
  gallon: { group: "volume", factor: 1 },
};

function calculateRecipeProfitability(recipe, inventory) {
  const breakdown = (recipe.ingredients || []).map((ingredient) => {
    const inventoryItem = findInventoryItem(ingredient, inventory);
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
  const allCostsAvailable = breakdown.length > 0 && pricedIngredients.length === breakdown.length;
  const totalRecipeCost = allCostsAvailable ? pricedSubtotal : null;
  const yieldQuantity = Number(recipe.yieldQuantity || 0);
  const sellingPrice = Number(recipe.sellingPrice || 0);
  const costPerUnit = allCostsAvailable && yieldQuantity > 0 ? round(totalRecipeCost / yieldQuantity) : null;
  const profitPerUnit = costPerUnit !== null ? round(sellingPrice - costPerUnit) : null;
  const profitMargin = costPerUnit !== null && sellingPrice > 0
    ? round((profitPerUnit / sellingPrice) * 100)
    : costPerUnit !== null ? 0 : null;

  return {
    ...recipe,
    costBreakdown: breakdown,
    totalRecipeCost,
    pricedSubtotal,
    costPerUnit,
    profitPerUnit,
    profitMargin,
    suggestedPrices: costPerUnit === null ? null : {
      margin50: suggestedPrice(costPerUnit, 50),
      margin60: suggestedPrice(costPerUnit, 60),
      margin70: suggestedPrice(costPerUnit, 70),
    },
    allCostsAvailable,
    lastUpdated: recipe.updatedAt || recipe.createdAt || "",
  };
}

function findInventoryItem(ingredient, inventory) {
  if (ingredient.inventoryId) {
    const byId = inventory.find((item) => item.id === ingredient.inventoryId);
    if (byId) return byId;
  }
  const name = String(ingredient.ingredientName || "").trim().toLowerCase();
  return inventory.find((item) => String(item.ingredientName || "").trim().toLowerCase() === name);
}

function calculateIngredientCost(ingredient, inventoryItem) {
  const ingredientUnit = unitDefinitions[ingredient.unit];
  const inventoryUnit = unitDefinitions[inventoryItem.unit];
  if (!ingredientUnit || !inventoryUnit || ingredientUnit.group !== inventoryUnit.group) return null;
  const inventoryUnitsUsed =
    (Number(ingredient.quantity || 0) * ingredientUnit.factor) / inventoryUnit.factor;
  return round(inventoryUnitsUsed * Number(inventoryItem.costPerUnit || 0));
}

function suggestedPrice(costPerUnit, targetMargin) {
  return round(Number(costPerUnit) / (1 - Number(targetMargin) / 100));
}

function round(value) {
  return Math.round(Number(value) * 100) / 100;
}

module.exports = { calculateIngredientCost, calculateRecipeProfitability, suggestedPrice };
