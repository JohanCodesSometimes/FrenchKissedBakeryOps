function buildInventoryIntelligence(items) {
  const all = items.map(enrichInventoryItem);
  const lowStock = all.filter((item) => item.status !== "In Stock");
  const recentlyUpdatedItems = [...all]
    .sort((a, b) => String(b.lastUpdated || "").localeCompare(String(a.lastUpdated || "")))
    .slice(0, 5);

  return {
    summary: {
      totalTrackedItems: all.length,
      lowStockCount: lowStock.length,
      estimatedInventoryValue: round(all.reduce((total, item) => total + item.estimatedTotalValue, 0)),
      recentlyUpdatedCount: recentlyUpdatedItems.length,
    },
    recentlyUpdatedItems,
    lowStock,
    all,
  };
}

function enrichInventoryItem(item) {
  const quantity = Number(item.quantity || 0);
  const minimumThreshold = Number(item.minimumThreshold || 0);
  const costPerUnit = Number(item.costPerUnit || 0);
  return {
    ...item,
    category: item.category || "Ingredients",
    quantity,
    minimumThreshold,
    costPerUnit,
    estimatedTotalValue: round(quantity * costPerUnit),
    lastUpdated: item.updatedAt || item.createdAt || "",
    status: quantity <= 0 ? "Out of Stock" : quantity <= minimumThreshold ? "Low Stock" : "In Stock",
  };
}

function round(value) {
  return Math.round(Number(value) * 100) / 100;
}

module.exports = { buildInventoryIntelligence };
