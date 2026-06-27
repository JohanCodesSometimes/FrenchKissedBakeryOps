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

function applyReceiptItemsToInventory(inventory, items, { storeName, now, createId }) {
  return items.map((item) => {
    if (!item.updateInventory) return { item, inventoryItem: null };
    let inventoryItem = inventory.find(
      (record) => normalizeName(record.ingredientName) === normalizeName(item.itemName) && record.unit === item.unit,
    );
    if (inventoryItem) {
      inventoryItem.quantity = round(Number(inventoryItem.quantity || 0) + Number(item.quantity || 0));
      inventoryItem.costPerUnit = Number(item.unitPrice || 0);
      inventoryItem.supplier = storeName;
      inventoryItem.category = item.category || inventoryItem.category || "Ingredients";
      inventoryItem.updatedAt = now;
    } else {
      inventoryItem = {
        id: createId(),
        ingredientName: item.itemName,
        category: item.category || "Ingredients",
        quantity: Number(item.quantity || 0),
        unit: item.unit,
        minimumThreshold: 0,
        supplier: storeName,
        costPerUnit: Number(item.unitPrice || 0),
        createdAt: now,
      };
      inventory.unshift(inventoryItem);
    }
    return { item, inventoryItem };
  });
}

function normalizeName(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function round(value) {
  return Math.round(Number(value) * 100) / 100;
}

module.exports = { applyReceiptItemsToInventory, buildInventoryIntelligence };
